import type { DB } from '../cache/sqlite.js';
import type { Statement } from 'sql.js';
// import type { AxiosInstance, AxiosError, AxiosRequestConfig } from 'axios'; // AxiosInstance no longer needed directly
// import type { AxiosError, AxiosRequestConfig } from 'axios'; // Removed as errors are now NotariumError subtypes
// For this file, if only simperiumSaveNote is used, AxiosError/Config might also not be needed here.
// Let's remove AxiosInstance for now as per plan.
import { SaveNotesInput, SaveNotesOutput, NoteDataSchema, PatchOperationSchema, SingleSaveNoteObjectSchema, ListItemSchema } from '../schemas.js';
import logger from '../logging.js';
import {
  NotariumError,
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

// Helper function to process a single note save operation
// This encapsulates the core logic previously in handleSave
async function saveSingleNoteInternally(
  noteParams: z.infer<typeof SingleSaveNoteObjectSchema>,
  db: DB
): Promise<z.infer<typeof ListItemSchema> | { error: NotariumError, originalId?: string }> { // Return ListItem or an error object
  let { id, local_version, server_version } = noteParams;
  const { text, text_patch, tags, trash } = noteParams;
  const originalInputId = noteParams.id; // Keep for error reporting if ID generation fails early

  const isNewNote = !id;
  const now = Math.floor(Date.now() / 1000);
  let currentNote: any = null;
  let currentText = '';

  try {
    if (!isNewNote && id) {
      if (local_version === undefined) {
        throw new NotariumValidationError(
          'local_version is required when updating an existing note (id is present).',
          'Local version (local_version) is missing for an existing note.',
        );
      }
      currentNote = queryFirstRow(
        db,
        'SELECT * FROM notes WHERE id = ? AND local_version = ?',
        [id, local_version],
      );
      if (!currentNote) {
        logger.info({ id, local_version }, '[save_notes helper] Primary id/version lookup failed for update, attempting FTS fallback on id.');
        const stmtFallback = db.prepare(
          `SELECT * FROM notes WHERE rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts.text MATCH ?) ORDER BY modified_at DESC LIMIT 1`);
        stmtFallback.bind([id]); // Match against the ID string which might be a title
        if (stmtFallback.step()) {
          currentNote = stmtFallback.getAsObject();
          logger.info({ foundId: currentNote.id, originalId: id }, '[save_notes helper] FTS fallback found a note. Will use this note for update, ignoring original local_version.');
          // IMPORTANT: If fallback is used, the original local_version might not match. We proceed with the found note's latest version.
          // The client-provided local_version was for the ID it thought it had.
          // We should use the local_version of the `currentNote` we just found via FTS.
          local_version = currentNote.local_version; 
        }
        stmtFallback.free();
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
    }

    if (text_patch && text_patch.length > 0) {
      currentText = applyTextPatch(currentText, text_patch);
    } else if (text !== undefined) {
      currentText = text;
    }

    const finalTags = tags !== undefined ? tags : currentNote?.tags ? JSON.parse(currentNote.tags) : [];
    const finalTrash = trash !== undefined ? trash : currentNote?.trash ? !!currentNote.trash : false;

    const simperiumPayload: SimperiumNotePayload = {
      content: currentText,
      tags: finalTags,
      deleted: finalTrash,
      modificationDate: now,
    };
    if (isNewNote) simperiumPayload.creationDate = now;

    const savedSimperiumNote = await simperiumSaveNote(
      SIMPERIUM_NOTE_BUCKET,
      id!,
      simperiumPayload,
      server_version,
    );

    const newServerVersion = savedSimperiumNote.version;
    const newLocalVersion = (currentNote?.local_version || local_version || 0) + 1;

    db.prepare(
      `INSERT OR REPLACE INTO notes (id, local_version, server_version, text, tags, modified_at, created_at, trash, sync_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run([
      id!,
      newLocalVersion,
      newServerVersion,
      currentText,
      JSON.stringify(finalTags),
      savedSimperiumNote.data.modificationDate || now,
      isNewNote ? (savedSimperiumNote.data.creationDate || now) : (currentNote?.created_at === null ? undefined : currentNote?.created_at),
      savedSimperiumNote.data.deleted ? 1 : 0,
      0,
    ]);

    const firstLinesArr = currentText.split('\n');
    const previewText = firstLinesArr.slice(0, 100).join('\n').trim() || '(empty note)';
    
    return ListItemSchema.parse({
        type: 'text',
        id: id!,
        text: previewText,
        local_version: newLocalVersion,
        tags: savedSimperiumNote.data.tags || [],
        modified_at: Math.floor(savedSimperiumNote.data.modificationDate || now),
        trash: savedSimperiumNote.data.deleted || false,
        number_of_lines: firstLinesArr.length,
    });

  } catch (error: any) {
    logger.warn(
      { err: error, noteParams, failingId: id || originalInputId }, 
      `Error saving single note (id: ${id || originalInputId || 'new_note'}) within batch.`
    );
    if (error instanceof NotariumError) {
      return { error, originalId: id || originalInputId };
    }
    return { 
      error: new NotariumInternalError(
        `Unexpected error processing note ${id || originalInputId || 'new_note'}: ${error.message}`,
        'An internal error occurred while processing one of the notes in the batch.',
        undefined,
        error
      ),
      originalId: id || originalInputId 
    };
  }
}

/**
 * Handles the 'save' tool invocation.
 * Now accepts an array of notes.
 */
export async function handleSave(params: SaveNotesInput, db: DB): Promise<SaveNotesOutput> {
  logger.debug({ params }, 'Handling batched save tool request');
  const { notes } = params;
  const savedItems: Array<z.infer<typeof ListItemSchema>> = [];
  const errors: Array<{ error: NotariumError, forNoteId?: string, inputIndex: number }> = [];

  for (let i = 0; i < notes.length; i++) {
    const noteInput = notes[i];
    const result = await saveSingleNoteInternally(noteInput, db);
    if ('error' in result) {
      errors.push({ error: result.error, forNoteId: result.originalId, inputIndex: i });
    } else if (result) { // Ensure result is not null
      savedItems.push(result);
    }
  }

  if (errors.length > 0) {
    // If all failed, or a significant portion, we might want to throw a more general error.
    // For now, returning successfully saved ones and logging errors.
    // Consider if partial success should be a top-level error or include errors in response.
    logger.error({ errors }, `Encountered ${errors.length} errors during batched save operation.`);
    // If all notes failed, throw the error of the first one as a representative error for the batch.
    if (savedItems.length === 0 && errors.length > 0) {
       const firstError = errors[0];
       throw new NotariumInternalError(
         `All ${notes.length} note save operations failed. First error: ${firstError.error.message} (for note ID: ${firstError.forNoteId || 'new_note'} at index ${firstError.inputIndex})`,
         'None of the notes in the batch could be saved.',
         { allErrors: errors.map(e => ({...e.error.toDict(), forNoteId: e.forNoteId, inputIndex: e.inputIndex})) },
         firstError.error
       );
    }
    // If some succeeded, we still return them but log that some failed.
    // Client might need a more structured way to know which ones failed if it needs to retry.
  }

  return {
    content: savedItems,
    total_items: savedItems.length,
    current_page: 1,
    total_pages: 1,
  };
}

logger.info('Tool handler: save defined, now uses simperiumSaveNote and handles batches.');
