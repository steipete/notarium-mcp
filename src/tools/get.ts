import type { DB } from '../cache/sqlite.js';
import { GetInput, GetOutput, ListItemSchema } from '../schemas.js';
import { z } from 'zod';
import logger from '../logging.js';
import {
  NotariumResourceNotFoundError,
  NotariumDbError,
} from '../errors.js';

// Helper to fetch a single note and format it as a ListItem
// Includes forgiving FTS fallback
async function fetchAndFormatSingleNote(idInput: string, db: DB, local_version_param?: number, range_line_start_param?: number, range_line_count_param?: number): Promise<z.infer<typeof ListItemSchema> | null> {
  let noteRow: any;
  try {
    let stmt;
    if (local_version_param !== undefined) {
      stmt = db.prepare('SELECT * FROM notes WHERE id = ? AND local_version = ?');
      stmt.bind([idInput, local_version_param]);
    } else {
      stmt = db.prepare('SELECT * FROM notes WHERE id = ? ORDER BY local_version DESC LIMIT 1');
      stmt.bind([idInput]);
    }

    if (stmt.step()) {
      noteRow = stmt.getAsObject();
    }
    stmt.free();

    if (!noteRow) {
      logger.info({ id: idInput }, '[get_note helper] Primary id lookup failed, attempting FTS fallback.');
      stmt = db.prepare(
        `SELECT * FROM notes WHERE rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts.text MATCH ?) ORDER BY modified_at DESC LIMIT 1`);
      stmt.bind([idInput]); // Use the original id string for FTS match
      if (stmt.step()) {
        noteRow = stmt.getAsObject();
      }
      stmt.free();
    }
  } catch (err) {
    logger.error({ err, id: idInput }, '[get_note helper] DB error fetching single note.');
    return null; // Continue with other IDs if in a batch
  }

  if (!noteRow) {
    logger.warn({ id: idInput }, '[get_note helper] Note not found after fallback.');
    return null;
  }

  let noteTextForProcessing = noteRow.text === null || noteRow.text === undefined ? '' : String(noteRow.text);
  const totalLines = noteTextForProcessing.split('\n').length;

  // Apply ranging if specified (only really makes sense if a single ID was effectively requested by the user initially)
  if (range_line_start_param !== undefined && range_line_count_param !== undefined) {
    const lines = noteTextForProcessing.split('\n');
    const startLineZeroIndexed = range_line_start_param - 1;
    if (startLineZeroIndexed < 0 || startLineZeroIndexed >= totalLines || range_line_start_param <= 0) {
      noteTextForProcessing = ''; // Range invalid, return empty text for this part
    } else {
      const lineCountToRetrieve = range_line_count_param === 0 ? totalLines - startLineZeroIndexed : range_line_count_param;
      const endLineActualZeroIndexed = Math.min(startLineZeroIndexed + lineCountToRetrieve, totalLines);
      noteTextForProcessing = lines.slice(startLineZeroIndexed, endLineActualZeroIndexed).join('\n');
    }
  }

  const linesArr = noteTextForProcessing.split('\n');
  const preview_lines_default = 100;
  const previewLinesCount = Math.min(preview_lines_default, linesArr.length);
  const previewText = linesArr.slice(0, previewLinesCount).join('\n').trim() || '(empty note)';

  try {
    return ListItemSchema.parse({
      type: 'text',
      uuid: noteRow.id,
      text: previewText, // This is now potentially ranged AND/OR preview-limited
      local_version: noteRow.local_version,
      tags: JSON.parse(noteRow.tags || '[]'),
      modified_at: Math.floor(noteRow.modified_at),
      trash: !!noteRow.trash,
      number_of_lines: totalLines, // Always report total lines of the original note
    });
  } catch (parseErr) {
    logger.error({ err: parseErr, noteId: noteRow.id }, '[get_note helper] Failed to parse note data into ListItemSchema.');
    return null;
  }
}

/**
 * Handles the 'get' tool invocation.
 * As per Spec 10.2.
 */
export async function handleGet(params: GetInput, db: DB): Promise<GetOutput> {
  logger.debug({ params }, 'Handling get tool request');
  // After schema validation and transform, params.id is always string[] (named ids_internal for clarity)
  const { id: ids_internal, local_version, range_line_start, range_line_count } = params;
  const fetchedItems: Array<z.infer<typeof ListItemSchema>> = [];

  // Ranging and specific local_version only apply if a single ID was effectively passed.
  // If multiple IDs are given, these params are ignored for simplicity, and latest version is fetched.
  const applyRangeAndVersion = ids_internal.length === 1;

  for (const current_id of ids_internal) {
    const item = await fetchAndFormatSingleNote(
      current_id,
      db,
      applyRangeAndVersion ? local_version : undefined,
      applyRangeAndVersion ? range_line_start : undefined,
      applyRangeAndVersion ? range_line_count : undefined,
    );
    if (item) {
      fetchedItems.push(item);
    }
  }

  return {
    content: fetchedItems,
    total_items: fetchedItems.length,
    current_page: 1, // Not paginated for this specific call
    total_pages: 1,
  };
}

logger.info('Tool handler: get defined.');
