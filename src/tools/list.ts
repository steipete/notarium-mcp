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

  const { query, tags, limit = 20, page = 1, trash_status = 'active', date_before, date_after, sort_by, sort_order, preview_lines = 3 } =
    params;

  const sqlWhereClauses: string[] = [];
  const sqlParams: (string | number)[] = [];

  // 1. trash_status value (Spec 10.1.Server Logic.1)
  if (trash_status === 'active') {
    sqlWhereClauses.push('notes.trash = 0');
  } else if (trash_status === 'trashed') {
    sqlWhereClauses.push('notes.trash = 1');
  } // if trash_status is 'any', no clause is added.

  // 3. effective_tags (Spec 10.1.Server Logic.3)
  const effectiveTags = new Set<string>(tags || []);

  // 5. & 6. effective_date_before / effective_date_after (Spec 10.1.Server Logic.5 & 6)
  // Dates are YYYY-MM-DD, convert to epoch seconds for comparison with modified_at
  // date_before means modified_at < end of that day
  // date_after means modified_at > start of that day
  let effective_date_before: number | null = date_before
    ? new Date(`${date_before}T23:59:59.999Z`).getTime() / 1000
    : null;
  let effective_date_after: number | null = date_after
    ? new Date(`${date_after}T00:00:00.000Z`).getTime() / 1000
    : null;

  // 7. Parse input.query (Spec 10.1.Server Logic.7)
  let remaining_query_text = query || '';
  if (query) {
    // tag: extraction
    const tagRegex = /tag:(\S+)/g;
    let match;
    while ((match = tagRegex.exec(remaining_query_text)) !== null) {
      effectiveTags.add(match[1]);
    }
    remaining_query_text = remaining_query_text.replace(tagRegex, '').trim();

    // before: extraction
    const beforeRegex = /before:(\d{4}-\d{2}-\d{2})/g;
    while ((match = beforeRegex.exec(remaining_query_text)) !== null) {
      const dateVal = new Date(`${match[1]}T23:59:59.999Z`).getTime() / 1000;
      effective_date_before = Math.min(effective_date_before || Infinity, dateVal);
    }
    remaining_query_text = remaining_query_text.replace(beforeRegex, '').trim();

    // after: extraction
    const afterRegex = /after:(\d{4}-\d{2}-\d{2})/g;
    while ((match = afterRegex.exec(remaining_query_text)) !== null) {
      const dateVal = new Date(`${match[1]}T00:00:00.000Z`).getTime() / 1000;
      effective_date_after = Math.max(effective_date_after || 0, dateVal);
    }
    remaining_query_text = remaining_query_text.replace(afterRegex, '').trim();
  }
  remaining_query_text = remaining_query_text.trim();

  // 8. Build SQL WHERE clauses (Spec 10.1.Server Logic.8)
  effectiveTags.forEach((tag) => {
    sqlWhereClauses.push('EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ?)');
    sqlParams.push(tag);
  });

  if (effective_date_before !== null) {
    sqlWhereClauses.push('notes.modified_at < ?');
    sqlParams.push(effective_date_before);
  }
  if (effective_date_after !== null) {
    sqlWhereClauses.push('notes.modified_at > ?');
    sqlParams.push(effective_date_after);
  }

  // 9. FTS5 Query Part (Spec 10.1.Server Logic.9)
  let ftsMatchClause = '';
  if (remaining_query_text) {
    // TODO: Future enhancement - Sanitize/format remaining_query_text for FTS5 to handle special characters
    // or structure multi-word queries (e.g., join with AND, escape quotes/operators).
    // For V1, pass as is, relying on FTS5's default parsing and 'porter unicode61' tokenizer.
    const ftsQuery = remaining_query_text;
    ftsMatchClause = 'notes.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts.text MATCH ?)';
    sqlWhereClauses.push(ftsMatchClause);
    sqlParams.push(ftsQuery);
  }

  const whereClause = sqlWhereClauses.length > 0 ? sqlWhereClauses.join(' AND ') : '1=1';

  // Determine ORDER_BY clause (Spec 10.1.Server Logic.9)
  let orderBySQL = "";
  const defaultSortField = "notes.modified_at";
  const defaultSortOrder = "DESC";
  
  let resolvedSortField = defaultSortField;
  if (sort_by === 'created_at') {
    resolvedSortField = 'notes.created_at';
  } else if (sort_by === 'modified_at') {
    // This case is explicitly handled as it's a valid sort_by option, 
    // even if it's the default field.
    resolvedSortField = 'notes.modified_at';
  }
  // If sort_by is undefined, resolvedSortField remains defaultSortField ('notes.modified_at')

  const resolvedSortOrder = sort_order || defaultSortOrder;

  if (remaining_query_text) {
    // For FTS queries, rank is primary. User-defined sort is secondary.
    // Ensure correct table alias for sort fields if notes table is aliased as 'n' in FTS path.
    const cteSortField = resolvedSortField.replace(/^notes\./, 'n.');
    orderBySQL = `ranked.rank, ${cteSortField} ${resolvedSortOrder}`;
  } else {
    // For non-FTS queries, user-defined sort is primary.
    orderBySQL = `${resolvedSortField} ${resolvedSortOrder}`;
  }
  // END Determine ORDER_BY clause

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
  const offset = (page - 1) * limit;
  let dataSql;
  let finalSqlParamsForData;

  if (remaining_query_text) {
    // FTS Query using CTE for ranking
    // 1. Original sqlParams are for the clauses in sqlWhereClauses. The last one is the ftsQuery if FTS is active.
    // The FTS condition notes.rowid IN (...) needs to be removed from sqlWhereClauses for this CTE approach.
    
    const nonFtsWhereClauses = sqlWhereClauses.filter(clause => !clause.startsWith('notes.rowid IN (SELECT rowid FROM notes_fts'));
    // When using 'n' as alias for notes table, update column references in these clauses
    const updatedNonFtsWhereClauses = nonFtsWhereClauses.map(clause => clause.replace(/notes\./g, 'n.'));
    const nonFtsWhereClauseString = updatedNonFtsWhereClauses.length > 0 ? updatedNonFtsWhereClauses.join(' AND ') : '1=1';
    
    // Params for non-FTS clauses (all except the last one, which is ftsQuery)
    const nonFtsParams = sqlParams.slice(0, -1);
    const ftsQueryParam = sqlParams[sqlParams.length - 1]; // This is the ftsQuery

    const cteSortField2 = resolvedSortField.replace(/^notes\./, 'n.');
    orderBySQL = `ranked.rank, ${cteSortField2} ${resolvedSortOrder}`; // Order by rank from CTE

    dataSql = `WITH ranked_notes AS (
                 SELECT rowid, rank
                 FROM notes_fts
                 WHERE notes_fts.text MATCH ?
               )
               SELECT n.id, n.local_version, n.text, n.tags, n.modified_at, n.trash
               FROM notes AS n
               JOIN ranked_notes AS ranked ON n.rowid = ranked.rowid
               WHERE ${nonFtsWhereClauseString} 
               ORDER BY ${orderBySQL} 
               LIMIT ? OFFSET ?;`;
    finalSqlParamsForData = [ftsQueryParam, ...nonFtsParams, limit, offset];

  } else {
    // Non-FTS Query
    dataSql = `SELECT notes.id, notes.local_version, notes.text, notes.tags, notes.modified_at, notes.trash 
               FROM notes 
               WHERE ${whereClause} ORDER BY ${orderBySQL} LIMIT ? OFFSET ?;`;
    finalSqlParamsForData = [...sqlParams, limit, offset];
  }

  let rows: any[];
  try {
    // sql.js compatible data query
    const stmtData = db.prepare(dataSql);
    stmtData.bind(finalSqlParamsForData);
    rows = [];
    while (stmtData.step()) {
      rows.push(stmtData.getAsObject());
    }
    stmtData.free();
  } catch (err) {
    logger.error(
      { err, sql: dataSql, params: finalSqlParamsForData },
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
    const linesArr = row.text.split('\n');
    const previewLinesCount = Math.min(preview_lines, linesArr.length);
    let titlePreviewString = linesArr.slice(0, previewLinesCount).join('\n').trim();
    if (titlePreviewString.length === 0) {
      titlePreviewString = '(empty note)';
    }
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
      type: 'text',
      id: row.id,
      text: titlePreviewString,
      local_version: row.local_version,
      tags: parsedTags,
      modified_at: Math.floor(row.modified_at),
      trash: !!row.trash,
      number_of_lines: linesArr.length,
    });
  });

  const totalPages = Math.ceil(totalItems / limit);
  const nextPage = page * limit < totalItems ? page + 1 : undefined;

  const resultPayload = {
    content: items,
    total_items: totalItems,
    current_page: page,
    total_pages: totalPages,
    next_page: nextPage,
  };

  logger.debug({ resultPayload }, 'list_notes → outgoing payload');

  return resultPayload;
}

logger.info('Tool handler: list defined and operational.');
