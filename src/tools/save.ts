import type { DB } from '../cache/sqlite.js';
import type { Statement } from 'sql.js';
// import type { AxiosInstance, AxiosError, AxiosRequestConfig } from 'axios'; // AxiosInstance no longer needed directly
// import type { AxiosError, AxiosRequestConfig } from 'axios'; // Removed as errors are now NotariumError subtypes
// For this file, if only simperiumSaveNote is used, AxiosError/Config might also not be needed here.
// Let's remove AxiosInstance for now as per plan.
import { SaveInput, SaveOutput, NoteDataSchema, PatchOperationSchema } from '../schemas.js';
import logger from '../logging.js';
import {
  NotariumValidationError,
  NotariumDbError,
  NotariumResourceNotFoundError,
  NotariumBackendError,
  NotariumInternalError,
} from '../errors.js';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod'; // For z.infer
import { saveNote as simperiumSaveNote, SimperiumNotePayload } from '../backend/simperium-api.js'; // Import the new saveNote

const SIMPERIUM_NOTE_BUCKET = 'note'; // Simplenote uses 'note' bucket

/**
 * Applies a text patch to a string.
 * Line numbers in patches are 1-indexed.
 * Operations: 'add', 'mod', 'del'
 * Spec 10.3: Server processes del (high to low ln), mod, add (low to high ln).
 */
// Export the function for testing and potential reuse
export function applyTextPatch(
  originalText: string,
  patches: z.infer<typeof PatchOperationSchema>[],
): string {
  if (!patches || patches.length === 0) return originalText;

  const lines = originalText === '' ? [] : originalText.split('\n');

  const delOps = patches.filter((p) => p.operation === 'deletion').sort((a, b) => b.line_number - a.line_number);
  const modOps = patches.filter((p) => p.operation === 'modification');
  const addOps = patches.filter((p) => p.operation === 'addition').sort((a, b) => a.line_number - b.line_number);

  for (const patch of delOps) {
    const lineIndex = patch.line_number - 1;
    if (lineIndex >= 0 && lineIndex < lines.length) {
      lines.splice(lineIndex, 1);
    }
  }

  for (const patch of modOps) {
    const lineIndex = patch.line_number - 1;
    if (lineIndex >= 0 && lineIndex < lines.length) {
      lines[lineIndex] = patch.value || '';
    }
  }

  // Refined add operations logic
  // The key is that `patch.line_number` refers to the desired line number in the *final* state *after this add op*,
  // but before subsequent add ops. Sorting add ops by line_number ensures this behavior.
  // We iterate and insert, adjusting indices for subsequent adds is implicitly handled by splice.
  let addOffset = 0;
  for (const patch of addOps) {
    const targetLineIndex = patch.line_number - 1 + addOffset;

    if (targetLineIndex < 0) {
      lines.unshift(patch.value || '');
      addOffset++;
    } else if (targetLineIndex > lines.length) {
      lines.push(patch.value || '');
      addOffset++;
    } else {
      lines.splice(targetLineIndex, 0, patch.value || '');
      addOffset++;
    }
  }
  return lines.join('\n');
}

// Helper to get single row as object using sql.js Statement API
function queryFirstRow<T = Record<string, unknown>>(db: DB, sql: string, params: any[] = []): T | undefined {
  const stmt: Statement = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const row = stmt.step() ? (stmt.getAsObject() as T) : undefined;
  stmt.free();
  return row;
}

/**
 * Handles the 'save' tool invocation.
 * As per Spec 10.3.
 */
export async function handleSave(params: SaveInput, db: DB): Promise<SaveOutput> {
  logger.debug({ params }, 'Handling save tool request');

  let { id, local_version, server_version } = params;
  const { text, text_patch, tags, trash } = params;

  const isNewNote = !id;
  const now = Math.floor(Date.now() / 1000);

  let currentNote: any = null;
  let currentText = '';

  if (!isNewNote && id) {
    if (local_version === undefined) {
      throw new NotariumValidationError(
        'local_version is required when updating an existing note (id is present).',
        'Local version (local_version) is missing for an existing note.',
      );
    }
    try {
      currentNote = queryFirstRow(
        db,
        'SELECT * FROM notes WHERE id = ? AND local_version = ?',
        [id, local_version],
      );
    } catch (dbErr) {
      logger.error({ err: dbErr, id, local_version }, 'DB error fetching note for update.');
      throw new NotariumDbError(
        'Failed to retrieve note for update.',
        'Database error preparing to save note.',
        undefined,
        dbErr as Error,
      );
    }
    if (!currentNote) {
      throw new NotariumResourceNotFoundError(
        `Note with id '${id}' and local version ${local_version} not found for update.`,
        'The note version you are trying to update does not exist.',
      );
    }
    currentText = currentNote.text;
    server_version = server_version ?? (currentNote.server_version === null ? undefined : currentNote.server_version);
  } else if (isNewNote) {
    id = uuidv4();
    local_version = 0; 
    // server_version remains undefined for new notes for simperiumSaveNote
  }

  if (text_patch && text_patch.length > 0) {
    currentText = applyTextPatch(currentText, text_patch);
  } else if (text !== undefined) {
    currentText = text;
  }

  const finalTags =
    tags !== undefined ? tags : currentNote?.tags ? JSON.parse(currentNote.tags) : [];
  const finalTrash = trash !== undefined ? trash : currentNote?.trash ? !!currentNote.trash : false;

  const simperiumPayload: SimperiumNotePayload = {
    content: currentText,
    tags: finalTags,
    deleted: finalTrash,
    modificationDate: now, // We set this, Simperium might override or use its own server-side timestamp
  };
  if (isNewNote) {
    simperiumPayload.creationDate = now; // Only for new notes
  }

  try {
    // Use the imported simperiumSaveNote function
    // s_ver (baseVersion for updates) is correctly passed from earlier logic
    const savedSimperiumNote = await simperiumSaveNote(
      SIMPERIUM_NOTE_BUCKET,
      id!,
      simperiumPayload,
      server_version, // Pass server_version (which could be undefined for new notes)
    );

    const newServerVersion = savedSimperiumNote.version;
    const newLocalVersion = (currentNote?.local_version || local_version || 0) + 1; 

    db.prepare(
      `INSERT OR REPLACE INTO notes (id, local_version, server_version, text, tags, modified_at, created_at, trash, sync_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run([
      id,
      newLocalVersion,
      newServerVersion,
      currentText, 
      JSON.stringify(finalTags),
      savedSimperiumNote.data.modificationDate || now,
      isNewNote
        ? savedSimperiumNote.data.creationDate || now
        : currentNote?.created_at === null // Use DB created_at for existing notes
          ? undefined
          : currentNote?.created_at,
      savedSimperiumNote.data.deleted ? 1 : 0,
      0,
    ]);

    const resultNoteData = {
      id: id!,
      local_version: newLocalVersion,
      server_version: newServerVersion,
      text: currentText,
      tags: savedSimperiumNote.data.tags || [],
      modified_at: Math.floor(savedSimperiumNote.data.modificationDate || now), // Map from Simperium field
      created_at: isNewNote
        ? Math.floor(savedSimperiumNote.data.creationDate || now) 
        : currentNote?.created_at === null
          ? undefined
          : Math.floor(currentNote?.created_at), 
      trash: savedSimperiumNote.data.deleted || false,
    };
    return NoteDataSchema.parse(resultNoteData);
  } catch (error) {
    // This block now primarily expects NotariumError subtypes or falls back to generic Error
    if (
      error instanceof NotariumBackendError ||
      error instanceof NotariumInternalError ||
      error instanceof NotariumResourceNotFoundError ||
      error instanceof NotariumValidationError
    ) {
      logger.warn(
        { err: error, noteId: id },
        `Notarium error during save operation for note ${id}`,
      );
      throw error; // Re-throw known Notarium errors
    }

    logger.error(
      { err: error, noteId: id },
      `Unexpected error during save operation for note ${id}`,
    );
    throw new NotariumInternalError(
      'An unexpected error occurred while saving the note.',
      'Failed to save note due to an internal server error.',
      undefined,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

logger.info('Tool handler: save defined, now uses simperiumSaveNote.');
