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

  let noteRow: any; // Type any for now, will be validated by schema parse
  try {
    if (local_version !== undefined) {
      noteRow = db.prepare('SELECT * FROM notes WHERE id = ? AND local_version = ?').get([id, local_version]);
    } else {
      noteRow = db.prepare('SELECT * FROM notes WHERE id = ? ORDER BY local_version DESC LIMIT 1').get([id]);
    }
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
    const message =
      local_version !== undefined
        ? `Note with id '${id}' and local version ${local_version} not found.`
        : `Note with id '${id}' not found.`;
    throw new NotariumResourceNotFoundError(message, 'The requested note could not be found.');
  }

  const fullNoteData: any = {
    id: noteRow.id,
    local_version: noteRow.local_version,
    server_version: noteRow.server_version === null ? undefined : noteRow.server_version,
    text: noteRow.text,
    tags: JSON.parse(noteRow.tags || '[]'),
    modified_at: Math.floor(noteRow.modified_at), // Map from DB column mod_at
    created_at: noteRow.created_at === null ? undefined : Math.floor(noteRow.created_at), // Map from DB crt_at
    trash: !!noteRow.trash,
  };

  if (range_line_start !== undefined && range_line_count !== undefined) {
    const lines = (noteRow.text as string).split('\n');
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
    fullNoteData.text_total_lines = (noteRow.text as string).split('\n').length;
  }

  try {
    return NoteDataSchema.parse(fullNoteData);
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
