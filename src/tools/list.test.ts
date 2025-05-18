import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleList } from './list.js';
import { ListInputSchema } from '../schemas.js'; // For constructing valid inputs
import type { Database as SqlJsDB, Statement } from 'sql.js';

// Mock the logger to prevent console output during tests
vi.mock('../logging.js', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock the database interactions for sql.js
const mockStmtGetAsObject = vi.fn();
const mockStmtStep = vi.fn();
const mockStmtBind = vi.fn();
const mockStmtFree = vi.fn();

// Each call to prepare should return a new mock statement object
const createMockStatement = () => ({
  bind: vi.fn(), // Each statement gets its own bind mock
  step: vi.fn(), // Each statement gets its own step mock
  getAsObject: vi.fn(), // Each statement gets its own getAsObject mock
  free: vi.fn(), // Each statement gets its own free mock
});

// mockDbPrepare will be configured per test or with a default flexible implementation
const mockDbPrepare = vi.fn();
const mockDb = { prepare: mockDbPrepare } as unknown as SqlJsDB;

const placeholderValidUuid = 'a1b2c3d4-e5f6-7890-1234-567890abcdef'; // Reusable valid UUID

describe('handleList Tool', () => {
  beforeEach(() => {
    // Reset mocks before each test
    mockDbPrepare.mockReset(); // Resets implementations and calls

    // Default implementation for mockDbPrepare for tests that don't override it fully
    // This default will be used if a test doesn't call mockDbPrepare.mockImplementation(Once)
    mockDbPrepare.mockImplementation(() => {
        const stmt = createMockStatement();
        // Default behavior for count query
        stmt.getAsObject.mockReturnValueOnce({ total: 0 });
        stmt.step.mockReturnValueOnce(true).mockReturnValueOnce(false); // step for count, then step for data (no data)
        return stmt;
    });
  });

  it('should return an empty list if DB queries return no results', async () => {
    const mockCountStatement = createMockStatement();
    mockCountStatement.step.mockReturnValueOnce(true); // Has a row for count
    mockCountStatement.getAsObject.mockReturnValueOnce({ total: 0 });

    const mockDataStatement = createMockStatement();
    mockDataStatement.step.mockReturnValueOnce(false); // No data rows

    mockDbPrepare
      .mockImplementationOnce(() => mockCountStatement)
      .mockImplementationOnce(() => mockDataStatement);

    const params = ListInputSchema.parse({}); // Minimal valid params
    const result = await handleList(params, mockDb);

    expect(mockDbPrepare).toHaveBeenCalledTimes(2);
    expect(result.content).toEqual([]);
    expect(result.total_items).toBe(0);
  });

  it('should correctly query for non-trashed items by default', async () => {
    const mockCountStatement = createMockStatement();
    mockCountStatement.step.mockReturnValueOnce(true).mockReturnValueOnce(false);
    mockCountStatement.getAsObject.mockReturnValueOnce({ total: 0 });
    const mockDataStatement = createMockStatement();
     mockDataStatement.step.mockReturnValueOnce(false);


    mockDbPrepare
      .mockImplementationOnce(() => mockCountStatement)
      .mockImplementationOnce(() => mockDataStatement);

    const params = ListInputSchema.parse({});
    await handleList(params, mockDb);

    expect(mockDbPrepare).toHaveBeenCalledTimes(2);
    // Check the SQL for the count query (first call to prepare)
    expect(mockDbPrepare.mock.calls[0][0]).toContain('WHERE notes.trash = 0');
    // Check the SQL for the data query (second call to prepare)
    expect(mockDbPrepare.mock.calls[1][0]).toContain('WHERE notes.trash = 0');
  });

  it('should correctly query for trashed items when trash_status = 1', async () => {
    const mockCountStatement = createMockStatement();
    mockCountStatement.step.mockReturnValueOnce(true).mockReturnValueOnce(false);
    mockCountStatement.getAsObject.mockReturnValueOnce({ total: 0 });
    const mockDataStatement = createMockStatement();
    mockDataStatement.step.mockReturnValueOnce(false);

    mockDbPrepare
        .mockImplementationOnce(() => mockCountStatement)
        .mockImplementationOnce(() => mockDataStatement);

    const params = ListInputSchema.parse({ trash_status: 1 });
    await handleList(params, mockDb);

    expect(mockDbPrepare).toHaveBeenCalledTimes(2);
    expect(mockDbPrepare.mock.calls[0][0]).toContain('WHERE notes.trash = 1');
    expect(mockDbPrepare.mock.calls[1][0]).toContain('WHERE notes.trash = 1');
  });

  it('should correctly query for all items (including trash) when trash_status = 2', async () => {
    const mockCountStatement = createMockStatement();
    mockCountStatement.step.mockReturnValueOnce(true).mockReturnValueOnce(false);
    mockCountStatement.getAsObject.mockReturnValueOnce({ total: 0 });
    const mockDataStatement = createMockStatement();
    mockDataStatement.step.mockReturnValueOnce(false);

    mockDbPrepare
        .mockImplementationOnce(() => mockCountStatement)
        .mockImplementationOnce(() => mockDataStatement);
        
    const params = ListInputSchema.parse({ trash_status: 2 });
    await handleList(params, mockDb);

    expect(mockDbPrepare).toHaveBeenCalledTimes(2);
    const countQuerySql = mockDbPrepare.mock.calls[0][0] as string;
    const dataQuerySql = mockDbPrepare.mock.calls[1][0] as string;

    expect(countQuerySql).not.toContain('notes.trash = 0');
    expect(countQuerySql).not.toContain('notes.trash = 1');
    expect(dataQuerySql).not.toContain('notes.trash = 0');
    expect(dataQuerySql).not.toContain('notes.trash = 1');

    if (!params.query && !params.tags && !params.date_before && !params.date_after) {
      expect(countQuerySql).toMatch(/WHERE\s+1=1/);
      expect(dataQuerySql).toMatch(/WHERE\s+1=1/);
    }
  });

  it('should apply tag filters correctly', async () => {
    const mockCountStatement = createMockStatement();
    mockCountStatement.step.mockReturnValueOnce(true).mockReturnValueOnce(false);
    mockCountStatement.getAsObject.mockReturnValueOnce({ total: 0 });
    const mockDataStatement = createMockStatement();
    mockDataStatement.step.mockReturnValueOnce(false);

    mockDbPrepare
        .mockImplementationOnce(() => mockCountStatement)
        .mockImplementationOnce(() => mockDataStatement);

    const params = ListInputSchema.parse({ tags: ['work', 'urgent'] });
    await handleList(params, mockDb);
    expect(mockDbPrepare).toHaveBeenCalledTimes(2);

    const expectedTagClause = 'EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ?)';
    expect(mockDbPrepare.mock.calls[0][0]).toContain(expectedTagClause);
    expect(mockDbPrepare.mock.calls[0][0]).toContain(expectedTagClause); 
    expect(mockDbPrepare.mock.calls[1][0]).toContain(expectedTagClause);
    expect(mockDbPrepare.mock.calls[1][0]).toContain(expectedTagClause);

    // Check parameters passed to bind for the count query (first prepare call's statement)
    expect(mockCountStatement.bind).toHaveBeenCalledWith(expect.arrayContaining(['work', 'urgent']));
    // Check parameters passed to bind for the data query (second prepare call's statement)
    expect(mockDataStatement.bind).toHaveBeenCalledWith(expect.arrayContaining(['work', 'urgent', params.limit, 0]));
  });

  it('should parse query for tags, before, and after dates', async () => {
    const mockCountStatement = createMockStatement();
    mockCountStatement.step.mockReturnValueOnce(true).mockReturnValueOnce(false);
    mockCountStatement.getAsObject.mockReturnValueOnce({ total: 0 });
    const mockDataStatement = createMockStatement();
    mockDataStatement.step.mockReturnValueOnce(false);

    mockDbPrepare
        .mockImplementationOnce(() => mockCountStatement)
        .mockImplementationOnce(() => mockDataStatement);

    const params = ListInputSchema.parse({
      query: 'search text tag:fromq before:2023-01-15 after:2023-01-01',
      tags: ['initialtag'],
      date_before: '2023-01-30', // This will be overridden by query's before:
      date_after: '2022-12-01',   // This will be overridden by query's after:
    });
    await handleList(params, mockDb);
    expect(mockDbPrepare).toHaveBeenCalledTimes(2);

    const countSql = mockDbPrepare.mock.calls[0][0] as string;
    const sqlParamsForCountBind = mockCountStatement.bind.mock.calls[0][0];

    expect(countSql).toContain('EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ?)');
    expect(sqlParamsForCountBind).toEqual(expect.arrayContaining(['initialtag', 'fromq']));
    expect(countSql).toContain('notes.modified_at < ?');
    // Effective date for 'before:2023-01-15' (end of day)
    expect(sqlParamsForCountBind).toEqual(expect.arrayContaining([expect.closeTo(new Date('2023-01-15T23:59:59.999Z').getTime() / 1000)]));
    expect(countSql).toContain('notes.modified_at > ?');
    // Effective date for 'after:2023-01-01' (start of day)
    expect(sqlParamsForCountBind).toEqual(expect.arrayContaining([expect.closeTo(new Date('2023-01-01T00:00:00.000Z').getTime() / 1000)]));
    expect(countSql).toContain('notes_fts.text MATCH ?');
    expect(sqlParamsForCountBind).toEqual(expect.arrayContaining(['search text']));
  });

  it('should handle pagination correctly and calculate next_page', async () => {
    const limit = 5;
    const page = 2;
    const offset = (page - 1) * limit; // 5

    const mockCountStatement = createMockStatement();
    mockCountStatement.step.mockReturnValueOnce(true);
    mockCountStatement.getAsObject.mockReturnValueOnce({ total: 25 });

    const mockDataStatement = createMockStatement();
    // Simulate 5 rows for the data query
    mockDataStatement.step
        .mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(true)
        .mockReturnValueOnce(true).mockReturnValueOnce(true)
        .mockReturnValueOnce(false); // End of rows
    mockDataStatement.getAsObject.mockReturnValue({ // Generic row data
        id: placeholderValidUuid,
        local_version: 1,
        text: 'note content',
        tags: '[]',
        modified_at: Math.floor(Date.now() / 1000),
        trash: 0,
    });
    
    mockDbPrepare
        .mockImplementationOnce(() => mockCountStatement)
        .mockImplementationOnce(() => mockDataStatement);

    const params = ListInputSchema.parse({ page, limit });
    const result = await handleList(params, mockDb);
    expect(mockDbPrepare).toHaveBeenCalledTimes(2);

    const dataQuerySql = mockDbPrepare.mock.calls[1][0] as string;
    expect(dataQuerySql).toContain('LIMIT ? OFFSET ?');
    
    expect(mockDataStatement.bind).toHaveBeenCalledWith(expect.arrayContaining([limit, offset]));

    expect(result.content.length).toBe(5);
    expect(result.total_items).toBe(25);
    expect(result.current_page).toBe(2);
    expect(result.total_pages).toBe(5);
    expect(result.next_page).toBe(3);
  });

  it('should not have next_page if on the last page', async () => {
    const limit = 5;
    const page = 2;

    const mockCountStatement = createMockStatement();
    mockCountStatement.step.mockReturnValueOnce(true);
    mockCountStatement.getAsObject.mockReturnValueOnce({ total: 9 });

    const mockDataStatement = createMockStatement();
    mockDataStatement.step // 4 rows for page 2
        .mockReturnValueOnce(true).mockReturnValueOnce(true)
        .mockReturnValueOnce(true).mockReturnValueOnce(true)
        .mockReturnValueOnce(false);
    mockDataStatement.getAsObject.mockImplementation((idx: number) => ({ // Use idx if needed, or just generic
        id: `00000000-0000-0000-0000-00000000000${idx || 0}`,
        local_version: 1,
        text: `note content ${idx || 0}`,
        tags: '[]',
        modified_at: Math.floor(Date.now() / 1000) + (idx || 0),
        trash: 0,
    }));

    mockDbPrepare
        .mockImplementationOnce(() => mockCountStatement)
        .mockImplementationOnce(() => mockDataStatement);

    const params = ListInputSchema.parse({ page, limit });
    const result = await handleList(params, mockDb);
    expect(mockDbPrepare).toHaveBeenCalledTimes(2);

    expect(mockDataStatement.bind).toHaveBeenCalledWith(expect.arrayContaining([limit, (page - 1) * limit]));

    expect(result.total_items).toBe(9);
    expect(result.current_page).toBe(2);
    expect(result.total_pages).toBe(2); // 9 items, limit 5. Page 1 has 5, Page 2 has 4. So 2 total pages.
    expect(result.next_page).toBeUndefined();
  });

  it('should correctly parse and transform items', async () => {
    const mockNoteRowsDb = [
      {
        id: placeholderValidUuid,
        local_version: 1,
        text: 'Title 1\nContent1',
        tags: '["tagA","tagB"]',
        modified_at: 1700000000,
        trash: 0,
      },
      {
        id: 'b2c3d4e5-f6a7-8901-2345-67890abcdef1',
        local_version: 2,
        text: '',
        tags: '[]',
        modified_at: 1700000001,
        trash: 1,
      },
      {
        id: 'c3d4e5f6-a7b8-9012-3456-7890abcdef23',
        local_version: 3,
        text: '  Spaced Title  \nContent3',
        tags: 'invalid-json',
        modified_at: 1700000002,
        trash: 0,
      },
    ];
    const mockCountStatement = createMockStatement();
    mockCountStatement.step.mockReturnValueOnce(true);
    mockCountStatement.getAsObject.mockReturnValueOnce({ total: mockNoteRowsDb.length });

    const mockDataStatement = createMockStatement();
    mockDataStatement.step
        .mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(true)
        .mockReturnValueOnce(false);
    mockDataStatement.getAsObject
        .mockReturnValueOnce(mockNoteRowsDb[0])
        .mockReturnValueOnce(mockNoteRowsDb[1])
        .mockReturnValueOnce(mockNoteRowsDb[2]);
        
    mockDbPrepare
        .mockImplementationOnce(() => mockCountStatement)
        .mockImplementationOnce(() => mockDataStatement);

    const params = ListInputSchema.parse({});
    const result = await handleList(params, mockDb);
    expect(mockDbPrepare).toHaveBeenCalledTimes(2);

    expect(result.content.length).toBe(3);
    expect(result.content[0].uuid).toBe(placeholderValidUuid);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toBe('Title 1');
    expect(result.content[0].tags).toEqual(['tagA', 'tagB']);
    
    expect(result.content[1].type).toBe('text');
    expect(result.content[1].text).toBe('(empty note)');
    expect(result.content[1].tags).toEqual([]);
    expect(result.content[1].trash).toBe(true);

    expect(result.content[2].type).toBe('text');
    expect(result.content[2].text).toBe('Spaced Title');
    expect(result.content[2].tags).toEqual([]); // Due to invalid JSON
  });

  // New tests for sort_by and sort_order
  it('should sort by created_at ASC if specified', async () => {
    const mockCountStatement = createMockStatement();
    mockCountStatement.getAsObject.mockReturnValueOnce({ total: 0 });
    mockCountStatement.step.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const mockDataStatement = createMockStatement();
    mockDataStatement.step.mockReturnValueOnce(false);


    mockDbPrepare.mockImplementationOnce(() => mockCountStatement)
                 .mockImplementationOnce(() => mockDataStatement);

    const params = ListInputSchema.parse({ sort_by: 'created_at', sort_order: 'ASC' });
    await handleList(params, mockDb);

    expect(mockDbPrepare).toHaveBeenCalledTimes(2);
    const dataSql = mockDbPrepare.mock.calls[1][0] as string;
    expect(dataSql).toContain('ORDER BY notes.created_at ASC');
  });

  it('should sort by modified_at DESC by default (no FTS query)', async () => {
    const mockCountStatement = createMockStatement();
    mockCountStatement.getAsObject.mockReturnValueOnce({ total: 0 });
    mockCountStatement.step.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const mockDataStatement = createMockStatement();
    mockDataStatement.step.mockReturnValueOnce(false);

    mockDbPrepare.mockImplementationOnce(() => mockCountStatement)
                 .mockImplementationOnce(() => mockDataStatement);

    const params = ListInputSchema.parse({}); // No sort params
    await handleList(params, mockDb);

    expect(mockDbPrepare).toHaveBeenCalledTimes(2);
    const dataSql = mockDbPrepare.mock.calls[1][0] as string;
    expect(dataSql).toContain('ORDER BY notes.modified_at DESC');
  });

  it('should sort by rank, then specified field/order for FTS queries', async () => {
    const mockCountStatement = createMockStatement();
    mockCountStatement.getAsObject.mockReturnValueOnce({ total: 0 });
    mockCountStatement.step.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const mockDataStatement = createMockStatement();
    mockDataStatement.step.mockReturnValueOnce(false);
    
    mockDbPrepare.mockImplementationOnce(() => mockCountStatement)
                 .mockImplementationOnce(() => mockDataStatement);

    const params = ListInputSchema.parse({ query: 'searchterm', sort_by: 'created_at', sort_order: 'ASC' });
    await handleList(params, mockDb);
    
    expect(mockDbPrepare).toHaveBeenCalledTimes(2);
    const dataSql = mockDbPrepare.mock.calls[1][0] as string;
    expect(dataSql).toContain('ORDER BY rank, notes.created_at ASC');
  });

  it('should default FTS query sort to rank, notes.modified_at DESC', async () => {
    const mockCountStatement = createMockStatement();
    mockCountStatement.getAsObject.mockReturnValueOnce({ total: 0 });
    mockCountStatement.step.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const mockDataStatement = createMockStatement();
    mockDataStatement.step.mockReturnValueOnce(false);

    mockDbPrepare.mockImplementationOnce(() => mockCountStatement)
                 .mockImplementationOnce(() => mockDataStatement);

    const params = ListInputSchema.parse({ query: 'searchterm' }); // No sort params, but FTS active
    await handleList(params, mockDb);

    expect(mockDbPrepare).toHaveBeenCalledTimes(2);
    const dataSql = mockDbPrepare.mock.calls[1][0] as string;
    expect(dataSql).toContain('ORDER BY rank, notes.modified_at DESC');
  });

  it('should construct correct SQL for FTS query with user-defined sort (created_at ASC)', async () => {
    const mockDb = createMockDb({ total: 0 }, []);
    const params = ListInputSchema.parse({ query: 'searchterm', sort_by: 'created_at', sort_order: 'ASC' });

    let capturedSql = '';
    mockDb.prepare.mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT COUNT(*)')) {
        // Expected where: notes.trash = ? AND EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ?) AND EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ?) AND notes.modified_at < ? AND notes.modified_at > ? AND notes.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts.text MATCH ?)
        // Expected params: [0, 'tag1', 'fromq', 1673737199.999, 1672531200, 'search text']
        expect(sql).toContain('notes.trash = ?');
        expect(sql).toContain(
          'EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ?)',
        );
        expect(sql).toContain('notes.modified_at < ?');
        expect(sql).toContain('notes.modified_at > ?');
        expect(sql).toContain(
          'notes.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts.text MATCH ?)',
        );
        mockStatement.bind = vi.fn().mockImplementation((p) => {
          expect(p).toEqual([0, 'tag1', 'fromq', 1673737199.999, 1672531200, 'search text']);
        });
        return mockStatement;
      } else if (sql.startsWith('SELECT notes.id')) {
        // Expected order by: rank, notes.modified_at DESC
        expect(sql).toContain('ORDER BY rank, notes.modified_at DESC LIMIT ? OFFSET ?');
        mockStatement.bind = vi.fn().mockImplementation((p) => {
          expect(p).toEqual([0, 'tag1', 'fromq', 1673737199.999, 1672531200, 'search text', 10, 0]);
        });
        return mockStatement;
      }
      return mockStatement; // Should not happen
    });

    const result = await handleList(
      {
        query: 'search text tag:fromq before:2023-01-15 after:2023-01-01',
        tags: ['tag1'],
        limit: 10,
        page: 1,
      },
      mockDb
    );

    expect(mockDb.prepare).toHaveBeenCalledTimes(2);
    expect(result.content.length).toBe(10);
    expect(result.total_items).toBe(0);
    expect(result.current_page).toBe(1);
    expect(result.total_pages).toBe(1);
    expect(result.next_page).toBeUndefined();
  });

  it('should construct correct SQL for FTS query with default FTS sort (rank, modified_at DESC)', async () => {
    const mockDb = createMockDb({ total: 0 }, []);
    const params = ListInputSchema.parse({ query: 'searchterm' }); // No sort params, but FTS active

    let capturedSql = '';
    mockDb.prepare.mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT COUNT(*)')) {
        // Expected where: notes.trash = ? AND EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ?) AND EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ?) AND notes.modified_at < ? AND notes.modified_at > ? AND notes.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts.text MATCH ?)
        // Expected params: [0, 'tag1', 'fromq', 1673737199.999, 1672531200, 'search text']
        expect(sql).toContain('notes.trash = ?');
        expect(sql).toContain(
          'EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ?)',
        );
        expect(sql).toContain('notes.modified_at < ?');
        expect(sql).toContain('notes.modified_at > ?');
        expect(sql).toContain(
          'notes.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts.text MATCH ?)',
        );
        mockStatement.bind = vi.fn().mockImplementation((p) => {
          expect(p).toEqual([0, 'tag1', 'fromq', 1673737199.999, 1672531200, 'search text']);
        });
        return mockStatement;
      } else if (sql.startsWith('SELECT notes.id')) {
        // Expected order by: rank, notes.modified_at DESC
        expect(sql).toContain('ORDER BY rank, notes.modified_at DESC LIMIT ? OFFSET ?');
        mockStatement.bind = vi.fn().mockImplementation((p) => {
          expect(p).toEqual([0, 'tag1', 'fromq', 1673737199.999, 1672531200, 'search text', 10, 0]);
        });
        return mockStatement;
      }
      return mockStatement; // Should not happen
    });

    const result = await handleList(
      {
        query: 'search text tag:fromq before:2023-01-15 after:2023-01-01',
        tags: ['tag1'],
        limit: 10,
        page: 1,
      },
      mockDb
    );

    expect(mockDb.prepare).toHaveBeenCalledTimes(2);
    expect(result.content.length).toBe(10);
    expect(result.total_items).toBe(0);
    expect(result.current_page).toBe(1);
    expect(result.total_pages).toBe(1);
    expect(result.next_page).toBeUndefined();
  });
});
