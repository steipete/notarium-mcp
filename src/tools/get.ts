import type { DB } from '../cache/sqlite.js';
import { GetInput, GetOutput, NoteDataSchema } from '../schemas.js';
import logger from '../logging.js';
import {
  NotariumResourceNotFoundError,
  NotariumDbError,
  NotariumInternalError,
} from '../errors.js';

/**
 * Handles the 'get' tool invocation.
 * As per Spec 10.2.
 */
export async function handleGet(params: GetInput, db: DB): Promise<GetOutput> {
  logger.debug({ params }, 'Handling get tool request');
  const { id, local_version, range_line_start, range_line_count } = params;
  const preview_lines = 3;

  let noteRow: any; // Will be validated later by schema
  try {
    let stmt;
    if (local_version !== undefined) {
      stmt = db.prepare('SELECT * FROM notes WHERE id = ? AND local_version = ?');
      stmt.bind([id, local_version]);
    } else {
      stmt = db.prepare('SELECT * FROM notes WHERE id = ? ORDER BY local_version DESC LIMIT 1');
      stmt.bind([id]);
    }

    if (stmt.step()) {
      noteRow = stmt.getAsObject();
    }
    stmt.free();
  } catch (err) {
    logger.error({ err, id, local_version }, 'Error fetching note from DB in get tool');
    throw new NotariumDbError(
      'Failed to retrieve note.',
      'Database error while getting note.',
      undefined,
      err as Error,
    );
  }

  if (!noteRow) {
    logger.info({ id }, 'Primary id lookup failed, attempting forgiving FTS fallback search');
    try {
      const stmtFallback = db.prepare(
        `SELECT * FROM notes WHERE rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts.text MATCH ?) ORDER BY modified_at DESC LIMIT 1`);
      stmtFallback.bind([id]);
      if (stmtFallback.step()) {
        noteRow = stmtFallback.getAsObject();
      }
      stmtFallback.free();
    } catch (ftsErr) {
      logger.warn({ err: ftsErr, id }, 'FTS fallback lookup in get tool failed');
    }

    if (!noteRow) {
      const message =
        local_version !== undefined
          ? `Note with id '${id}' and local version ${local_version} not found.`
          : `Note with id '${id}' not found.`;
      throw new NotariumResourceNotFoundError(message, 'The requested note could not be found.');
    }
  }

  // Safely construct fullNoteData now that we know noteRow exists.
  const noteTextForProcessing = noteRow.text === null || noteRow.text === undefined ? '' : String(noteRow.text);

  const fullNoteData: any = {
    id: noteRow.id, // Safe: noteRow is defined
    local_version: noteRow.local_version, // Safe
    server_version: noteRow.server_version === null ? undefined : noteRow.server_version,
    text: noteTextForProcessing, // Use the processed text for the main 'text' field
    tags: JSON.parse(noteRow.tags || '[]'),
    modified_at: Math.floor(noteRow.modified_at), // Map from DB column mod_at
    created_at: noteRow.created_at === null ? undefined : Math.floor(noteRow.created_at), // Map from DB crt_at
    trash: !!noteRow.trash,
  };

  if (range_line_start !== undefined && range_line_count !== undefined) {
    const lines = noteTextForProcessing.split('\n');
    const totalLines = lines.length;
    fullNoteData.text_total_lines = totalLines;
    fullNoteData.text_is_partial = true;

    const startLineZeroIndexed = range_line_start - 1;

    if (startLineZeroIndexed < 0 || startLineZeroIndexed >= totalLines || range_line_start <= 0) {
      fullNoteData.text = '';
      fullNoteData.range_line_start = range_line_start; // Report back requested start
      fullNoteData.range_line_count = 0; // Report zero lines returned
    } else {
      const lineCountToRetrieve = range_line_count === 0 ? totalLines - startLineZeroIndexed : range_line_count;
      const endLineActualZeroIndexed = Math.min(
        startLineZeroIndexed + lineCountToRetrieve,
        totalLines,
      );

      fullNoteData.text = lines.slice(startLineZeroIndexed, endLineActualZeroIndexed).join('\n');
      fullNoteData.range_line_start = range_line_start;
      fullNoteData.range_line_count = endLineActualZeroIndexed - startLineZeroIndexed;
    }
  } else {
    fullNoteData.text_is_partial = false;
    fullNoteData.text_total_lines = noteTextForProcessing.split('\n').length;
  }

  try {
    // Convert to list-style item for compatibility with some clients
    const firstLinesArr = fullNoteData.text.split('\n');
    const previewLinesCount = Math.min(preview_lines, firstLinesArr.length);
    const previewText = firstLinesArr.slice(0, previewLinesCount).join('\n').trim() || '(empty note)';

    const listStyleItem = {
      type: 'text',
      uuid: fullNoteData.id,
      text: previewText,
      local_version: fullNoteData.local_version,
      tags: fullNoteData.tags,
      modified_at: fullNoteData.modified_at,
      trash: fullNoteData.trash,
    };

    return {
      content: [listStyleItem],
      total_items: 1,
      current_page: 1,
      total_pages: 1,
    } as any;
  } catch (err) {
    logger.error(
      { err, noteData: fullNoteData, issues: (err as any).issues },
      'Failed to parse note data into schema for get tool output.',
    );
    throw new NotariumInternalError(
      'Failed to prepare note data for output.',
      'Internal server error.',
      { zodIssues: (err as any).issues },
      err as Error,
    );
  }
}

logger.info('Tool handler: get defined.');
