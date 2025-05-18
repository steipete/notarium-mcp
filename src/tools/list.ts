import type { DB } from '../cache/sqlite.js';
import { ListInput, ListOutput, ListItemSchema } from '../schemas.js';
import logger from '../logging.js';
import { NotariumDbError } from '../errors.js';

/**
 * Handles the 'list' tool invocation.
 * As per Spec 10.1.
 */
export async function handleList(params: ListInput, db: DB): Promise<ListOutput> {
  logger.debug({ params }, 'Handling list tool request');

  const { q, tags, lim = 20, page = 1, trash_s = 0, dt_before, dt_after } = params;

  const sqlWhereClauses: string[] = [];
  const sqlParams: (string | number)[] = [];

  // 1. trash_s value (Spec 10.1.Server Logic.1)
  // trash_s: 0 = not in trash, 1 = in trash, 2 = either
  if (trash_s === 0) {
    sqlWhereClauses.push('notes.trash = 0');
  } else if (trash_s === 1) {
    sqlWhereClauses.push('notes.trash = 1');
  } // if trash_s is 2, no clause is added for trash status.

  // 3. effective_tags (Spec 10.1.Server Logic.3)
  const effectiveTags = new Set<string>(tags || []);

  // 5. & 6. effective_dt_before / effective_dt_after (Spec 10.1.Server Logic.5 & 6)
  // Dates are YYYY-MM-DD, convert to epoch seconds for comparison with mod_at
  // dt_before means mod_at < end of that day
  // dt_after means mod_at > start of that day
  let effectiveDtBefore: number | null = dt_before
    ? new Date(`${dt_before}T23:59:59.999Z`).getTime() / 1000
    : null;
  let effectiveDtAfter: number | null = dt_after
    ? new Date(`${dt_after}T00:00:00.000Z`).getTime() / 1000
    : null;

  // 7. Parse input.q (Spec 10.1.Server Logic.7)
  let remainingQText = q || '';
  if (q) {
    // tag: extraction
    const tagRegex = /tag:(\S+)/g;
    let match;
    while ((match = tagRegex.exec(remainingQText)) !== null) {
      effectiveTags.add(match[1]);
    }
    remainingQText = remainingQText.replace(tagRegex, '').trim();

    // before: extraction
    const beforeRegex = /before:(\d{4}-\d{2}-\d{2})/g;
    while ((match = beforeRegex.exec(remainingQText)) !== null) {
      const dateVal = new Date(`${match[1]}T23:59:59.999Z`).getTime() / 1000;
      effectiveDtBefore = Math.min(effectiveDtBefore || Infinity, dateVal);
    }
    remainingQText = remainingQText.replace(beforeRegex, '').trim();

    // after: extraction
    const afterRegex = /after:(\d{4}-\d{2}-\d{2})/g;
    while ((match = afterRegex.exec(remainingQText)) !== null) {
      const dateVal = new Date(`${match[1]}T00:00:00.000Z`).getTime() / 1000;
      effectiveDtAfter = Math.max(effectiveDtAfter || 0, dateVal);
    }
    remainingQText = remainingQText.replace(afterRegex, '').trim();
  }
  remainingQText = remainingQText.trim();

  // 8. Build SQL WHERE clauses (Spec 10.1.Server Logic.8)
  effectiveTags.forEach((tag) => {
    sqlWhereClauses.push('EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ?)');
    sqlParams.push(tag);
  });

  if (effectiveDtBefore !== null) {
    sqlWhereClauses.push('notes.mod_at < ?');
    sqlParams.push(effectiveDtBefore);
  }
  if (effectiveDtAfter !== null) {
    sqlWhereClauses.push('notes.mod_at > ?');
    sqlParams.push(effectiveDtAfter);
  }

  // 9. FTS5 Query Part (Spec 10.1.Server Logic.9)
  let ftsMatchClause = '';
  if (remainingQText) {
    // TODO: Future enhancement - Sanitize/format remainingQText for FTS5 to handle special characters
    // or structure multi-word queries (e.g., join with AND, escape quotes/operators).
    // For V1, pass as is, relying on FTS5's default parsing and 'porter unicode61' tokenizer.
    const ftsQuery = remainingQText;
    ftsMatchClause = 'notes.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts.txt MATCH ?)';
    sqlWhereClauses.push(ftsMatchClause);
    sqlParams.push(ftsQuery);
  }

  const whereClause = sqlWhereClauses.length > 0 ? sqlWhereClauses.join(' AND ') : '1=1';
  const orderBy = remainingQText ? 'rank, notes.mod_at DESC' : 'notes.mod_at DESC'; // SQLite FTS provides `rank` implicitly

  // 10. Count Query (Spec 10.1.Server Logic.10)
  const countSql = `SELECT COUNT(*) as total FROM notes WHERE ${whereClause};`;
  let totalItems = 0;
  try {
    // sql.js compatible count query
    const stmtCount = db.prepare(countSql);
    stmtCount.bind(sqlParams);
    if (stmtCount.step()) {
      const countRow = stmtCount.getAsObject() as { total: number };
      totalItems = countRow.total;
    }
    stmtCount.free();
  } catch (err) {
    logger.error(
      { err, sql: countSql, params: sqlParams },
      'Error executing count query in list tool',
    );
    throw new NotariumDbError(
      'Failed to count notes for list.',
      'Database error while listing notes.',
      undefined,
      err as Error,
    );
  }

  // 11. Data Query (Spec 10.1.Server Logic.11)
  const offset = (page - 1) * lim;
  const dataSql = `SELECT notes.id, notes.l_ver, notes.txt, notes.tags, notes.mod_at, notes.trash FROM notes WHERE ${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?;`;
  const finalSqlParams = [...sqlParams, lim, offset];

  let rows: any[];
  try {
    // sql.js compatible data query
    const stmtData = db.prepare(dataSql);
    stmtData.bind(finalSqlParams);
    rows = [];
    while (stmtData.step()) {
      rows.push(stmtData.getAsObject());
    }
    stmtData.free();
  } catch (err) {
    logger.error(
      { err, sql: dataSql, params: finalSqlParams },
      'Error executing data query in list tool',
    );
    throw new NotariumDbError(
      'Failed to retrieve notes for list.',
      'Database error while listing notes.',
      undefined,
      err as Error,
    );
  }

  // 12. Process Rows (Spec 10.1.Server Logic.12)
  const items = rows.map((row) => {
    const titlePrev = (row.txt.split('\n')[0] || '').trim().substring(0, 80);
    let parsedTags: string[];
    try {
      parsedTags = JSON.parse(row.tags);
    } catch {
      parsedTags = [];
      logger.warn(
        { noteId: row.id, tags: row.tags },
        'Failed to parse tags for note, defaulting to empty array.',
      );
    }
    return ListItemSchema.parse({
      id: row.id,
      l_ver: row.l_ver,
      title_prev: titlePrev,
      tags: parsedTags,
      mod_at: Math.floor(row.mod_at),
      trash: !!row.trash,
    });
  });

  const totalPages = Math.ceil(totalItems / lim);
  const nextPage = page * lim < totalItems ? page + 1 : undefined;

  return {
    items,
    total_items: totalItems,
    current_page: page,
    total_pages: totalPages,
    next_page: nextPage,
  };
}

logger.info('Tool handler: list defined and operational.');
