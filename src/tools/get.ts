import type { Database as DB } from 'better-sqlite3';
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
  const { id, l_ver, rng_ln_s, rng_ln_c } = params;

  let noteRow: any; // Type any for now, will be validated by schema parse
  try {
    if (l_ver !== undefined) {
      noteRow = db.prepare('SELECT * FROM notes WHERE id = ? AND l_ver = ?').get(id, l_ver);
    } else {
      noteRow = db.prepare('SELECT * FROM notes WHERE id = ? ORDER BY l_ver DESC LIMIT 1').get(id);
    }
  } catch (err) {
    logger.error({ err, id, l_ver }, 'Error fetching note from DB in get tool');
    throw new NotariumDbError(
      'Failed to retrieve note.',
      'Database error while getting note.',
      undefined,
      err as Error,
    );
  }

  if (!noteRow) {
    const message =
      l_ver !== undefined
        ? `Note with id '${id}' and local version ${l_ver} not found.`
        : `Note with id '${id}' not found.`;
    throw new NotariumResourceNotFoundError(message, 'The requested note could not be found.');
  }

  const fullNoteData: any = {
    id: noteRow.id,
    l_ver: noteRow.l_ver,
    s_ver: noteRow.s_ver === null ? undefined : noteRow.s_ver, // Handle null s_ver from DB
    txt: noteRow.txt,
    tags: JSON.parse(noteRow.tags || '[]'),
    mod_at: noteRow.mod_at,
    crt_at: noteRow.crt_at === null ? undefined : noteRow.crt_at, // Handle null crt_at
    trash: !!noteRow.trash,
  };

  if (rng_ln_s !== undefined && rng_ln_c !== undefined) {
    const lines = (noteRow.txt as string).split('\n');
    const totalLines = lines.length;
    fullNoteData.txt_tot_ln = totalLines;
    fullNoteData.txt_partial = true;

    const startLineZeroIndexed = rng_ln_s - 1;

    if (startLineZeroIndexed < 0 || startLineZeroIndexed >= totalLines || rng_ln_s <= 0) {
      fullNoteData.txt = '';
      fullNoteData.rng_ln_s = rng_ln_s; // Report back requested start
      fullNoteData.rng_ln_c = 0; // Report zero lines returned
    } else {
      const lineCountToRetrieve = rng_ln_c === 0 ? totalLines - startLineZeroIndexed : rng_ln_c;
      const endLineActualZeroIndexed = Math.min(
        startLineZeroIndexed + lineCountToRetrieve,
        totalLines,
      );

      fullNoteData.txt = lines.slice(startLineZeroIndexed, endLineActualZeroIndexed).join('\n');
      fullNoteData.rng_ln_s = rng_ln_s;
      fullNoteData.rng_ln_c = endLineActualZeroIndexed - startLineZeroIndexed;
    }
  } else {
    fullNoteData.txt_partial = false;
    fullNoteData.txt_tot_ln = (noteRow.txt as string).split('\n').length;
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
