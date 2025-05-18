import type { Database as DB } from 'better-sqlite3';
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

  const delOps = patches.filter((p) => p.op === 'del').sort((a, b) => b.ln - a.ln);
  const modOps = patches.filter((p) => p.op === 'mod');
  const addOps = patches.filter((p) => p.op === 'add').sort((a, b) => a.ln - b.ln);

  for (const op of delOps) {
    const lineIndex = op.ln - 1;
    if (lineIndex >= 0 && lineIndex < lines.length) {
      lines.splice(lineIndex, 1);
    }
  }

  for (const op of modOps) {
    const lineIndex = op.ln - 1;
    if (lineIndex >= 0 && lineIndex < lines.length) {
      lines[lineIndex] = op.val || '';
    }
  }

  // Refined add operations logic
  // The key is that `op.ln` refers to the line number in the state of the document *before any add operations in this batch began*,
  // but *after* all deletes and mods for this patch run are complete.
  // However, the spec says "add (low to high ln)", implying subsequent adds see the effect of prior adds.
  // The `offset` variable correctly handles the shifting indices due to prior `add` operations within the same batch.
  let addOffset = 0;
  for (const op of addOps) {
    // op.ln is 1-indexed. targetLineIndex is 0-indexed.
    // The target line for insertion is relative to the current state of `lines` array,
    // considering previous additions in this loop.
    const targetLineIndex = op.ln - 1 + addOffset;

    if (targetLineIndex <= 0) {
      // Add to the beginning (or if ln=0, also beginning)
      lines.unshift(op.val || '');
      addOffset++;
    } else if (targetLineIndex > lines.length) {
      // Add to the very end if ln is far beyond current length
      lines.push(op.val || '');
      // No offset increment here, as we are appending. Next op.ln will be relative to new length effectively.
      // Correction: offset *should* increment as the conceptual list has grown by one line for subsequent patches in this addOp batch.
      addOffset++;
    } else {
      // Insert before the line at targetLineIndex (which was op.ln originally)
      lines.splice(targetLineIndex, 0, op.val || '');
      addOffset++;
    }
  }
  return lines.join('\n');
}

/**
 * Handles the 'save' tool invocation.
 * As per Spec 10.3.
 */
export async function handleSave(params: SaveInput, db: DB): Promise<SaveOutput> {
  logger.debug({ params }, 'Handling save tool request');

  // Destructure params. Some will be reassigned (id, l_ver, s_ver), others are read-only for this initial block.
  let { id, l_ver, s_ver } = params;
  const { txt, txt_patch, tags, trash } = params; // These are effectively const in this scope

  const isNewNote = !id;
  const now = Math.floor(Date.now() / 1000);

  let currentNote: any = null;
  let currentText = '';

  if (!isNewNote && id) {
    if (l_ver === undefined) {
      throw new NotariumValidationError(
        'l_ver is required when updating an existing note (id is present).',
        'Local version (l_ver) is missing for an existing note.',
      );
    }
    try {
      currentNote = db.prepare('SELECT * FROM notes WHERE id = ? AND l_ver = ?').get(id, l_ver);
    } catch (dbErr) {
      logger.error({ err: dbErr, id, l_ver }, 'DB error fetching note for update.');
      throw new NotariumDbError(
        'Failed to retrieve note for update.',
        'Database error preparing to save note.',
        undefined,
        dbErr as Error,
      );
    }
    if (!currentNote) {
      throw new NotariumResourceNotFoundError(
        `Note with id '${id}' and local version ${l_ver} not found for update.`,
        'The note version you are trying to update does not exist.',
      );
    }
    currentText = currentNote.txt;
    s_ver = s_ver ?? (currentNote.s_ver === null ? undefined : currentNote.s_ver);
  } else if (isNewNote) {
    id = uuidv4();
    l_ver = 0;
    // s_ver remains undefined for new notes, simperiumSaveNote handles this by omitting baseVersion
  }

  if (txt_patch && txt_patch.length > 0) {
    currentText = applyTextPatch(currentText, txt_patch);
  } else if (txt !== undefined) {
    currentText = txt;
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
      s_ver,
    );

    const newServerVersion = savedSimperiumNote.version;
    const newLocalVersion = (currentNote?.l_ver || 0) + 1; // Increment local version

    db.prepare(
      `INSERT OR REPLACE INTO notes (id, l_ver, s_ver, txt, tags, mod_at, crt_at, trash, sync_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      newLocalVersion,
      newServerVersion,
      currentText, // Use the locally determined currentText (after patch/txt)
      JSON.stringify(finalTags),
      savedSimperiumNote.data.modificationDate || now, // Prefer server mod date if available
      isNewNote
        ? savedSimperiumNote.data.creationDate || now
        : currentNote?.crt_at === null
          ? undefined
          : currentNote?.crt_at,
      savedSimperiumNote.data.deleted ? 1 : 0, // Use server state for trash
      0,
    );

    const resultNoteData = {
      id: id!,
      l_ver: newLocalVersion,
      s_ver: newServerVersion,
      txt: currentText, // Reflect the content that was saved
      tags: savedSimperiumNote.data.tags || [],
      mod_at: savedSimperiumNote.data.modificationDate || now,
      crt_at: isNewNote
        ? savedSimperiumNote.data.creationDate || now
        : currentNote?.crt_at === null
          ? undefined
          : currentNote?.crt_at,
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
