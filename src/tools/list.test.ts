import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleList } from './list.js';
import { ListInputSchema } from '../schemas.js'; // For constructing valid inputs
import type { Database as DB } from 'better-sqlite3';

// Mock the logger to prevent console output during tests
vi.mock('../logging.js', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock the database interactions
const mockDbRun = vi.fn();
const mockDbGet = vi.fn();
const mockDbAll = vi.fn();
const mockDbPrepare = vi.fn(() => ({
  run: mockDbRun,
  get: mockDbGet,
  all: mockDbAll,
}));

// Cast the mock to the DB type to satisfy handleList's parameter type
const mockDb = { prepare: mockDbPrepare } as unknown as DB;

const placeholderValidUuid = 'a1b2c3d4-e5f6-7890-1234-567890abcdef'; // Reusable valid UUID

describe('handleList Tool', () => {
  beforeEach(() => {
    // Reset mocks before each test
    mockDbRun.mockReset();
    mockDbGet.mockReset();
    mockDbAll.mockReset();
    mockDbPrepare.mockClear(); // Clear call counts for prepare itself
  });

  it('should return an empty list if DB queries return no results', async () => {
    // Setup mocks to return empty results
    mockDbGet.mockReturnValueOnce({ total: 0 }); // For the COUNT(*) query
    mockDbAll.mockReturnValueOnce([]); // For the data SELECT query

    const params = ListInputSchema.parse({}); // Minimal valid params
    const result = await handleList(params, mockDb);

    expect(mockDbPrepare).toHaveBeenCalledTimes(2); // Once for count, once for data
    expect(mockDbGet).toHaveBeenCalledOnce();
    expect(mockDbAll).toHaveBeenCalledOnce();

    expect(result.items).toEqual([]);
    expect(result.total_items).toBe(0);
    expect(result.current_page).toBe(1);
    expect(result.total_pages).toBe(0);
    expect(result.next_page).toBeUndefined();
  });

  it('should correctly query for non-trashed items by default', async () => {
    mockDbGet.mockReturnValueOnce({ total: 0 });
    mockDbAll.mockReturnValueOnce([]);

    const params = ListInputSchema.parse({});
    await handleList(params, mockDb);

    // Check the SQL for the count query (first call to prepare)
    expect(mockDbPrepare.mock.calls[0][0]).toContain('WHERE notes.trash = 0');
    // Check the SQL for the data query (second call to prepare)
    expect(mockDbPrepare.mock.calls[1][0]).toContain('WHERE notes.trash = 0');
  });

  it('should correctly query for trashed items when trash_s = 1', async () => {
    mockDbGet.mockReturnValueOnce({ total: 0 });
    mockDbAll.mockReturnValueOnce([]);

    const params = ListInputSchema.parse({ trash_s: 1 });
    await handleList(params, mockDb);

    expect(mockDbPrepare.mock.calls[0][0]).toContain('WHERE notes.trash = 1');
    expect(mockDbPrepare.mock.calls[1][0]).toContain('WHERE notes.trash = 1');
  });

  it('should correctly query for all items (including trash) when trash_s = 2', async () => {
    mockDbGet.mockReturnValueOnce({ total: 0 });
    mockDbAll.mockReturnValueOnce([]);

    const params = ListInputSchema.parse({ trash_s: 2 });
    await handleList(params, mockDb);

    // Check that no specific trash filter (like 'notes.trash = 0' or 'notes.trash = 1') is added to the WHERE clause.
    // The column notes.trash itself WILL be in the SELECT part.
    const countQuerySql = mockDbPrepare.mock.calls[0][0] as string;
    const dataQuerySql = mockDbPrepare.mock.calls[1][0] as string;

    // Extract WHERE clause or check for absence of specific filters
    // A simple check: ensure known trash filters are absent.
    expect(countQuerySql).not.toContain('notes.trash = 0');
    expect(countQuerySql).not.toContain('notes.trash = 1');
    expect(dataQuerySql).not.toContain('notes.trash = 0');
    expect(dataQuerySql).not.toContain('notes.trash = 1');

    // If no other filters, the WHERE clause might be simple (e.g., WHERE 1=1)
    // This depends on other params being default/empty for this specific test.
    // For a more robust check if this test is *only* about trash_s=2:
    if (!params.q && !params.tags && !params.dt_before && !params.dt_after) {
      expect(countQuerySql).toMatch(/WHERE\s+1=1/);
      expect(dataQuerySql).toMatch(/WHERE\s+1=1/);
    }
  });

  it('should apply tag filters correctly', async () => {
    mockDbGet.mockReturnValueOnce({ total: 0 });
    mockDbAll.mockReturnValueOnce([]);
    const params = ListInputSchema.parse({ tags: ['work', 'urgent'] });
    await handleList(params, mockDb);

    const expectedTagClause = 'EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ?)';
    // For COUNT query
    expect(mockDbPrepare.mock.calls[0][0]).toContain(expectedTagClause);
    expect(mockDbPrepare.mock.calls[0][0]).toContain(expectedTagClause); // Called twice for two tags
    // For data query
    expect(mockDbPrepare.mock.calls[1][0]).toContain(expectedTagClause);
    expect(mockDbPrepare.mock.calls[1][0]).toContain(expectedTagClause);

    // Check parameters for count query (get)
    expect(mockDbGet.mock.calls[0]).toEqual(expect.arrayContaining(['work', 'urgent']));
    // Check parameters for data query (all)
    // The actual params will be ['work', 'urgent', limit, offset]
    expect(mockDbAll.mock.calls[0][0]).toBe('work');
    expect(mockDbAll.mock.calls[0][1]).toBe('urgent');
  });

  it('should parse q for tags, before, and after dates', async () => {
    mockDbGet.mockReturnValueOnce({ total: 0 });
    mockDbAll.mockReturnValueOnce([]);
    const params = ListInputSchema.parse({
      q: 'search text tag:fromq before:2023-01-15 after:2023-01-01',
      tags: ['initialtag'], 
    });
    await handleList(params, mockDb);

    const countSql = mockDbPrepare.mock.calls[0][0] as string;
    const sqlParamsForCount = mockDbGet.mock.calls[0];

    // Assertions using countSql and sqlParamsForCount
    expect(countSql).toContain('EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ?)');
    expect(sqlParamsForCount).toEqual(expect.arrayContaining(['initialtag', 'fromq']));
    expect(countSql).toContain('notes.mod_at < ?');
    expect(sqlParamsForCount).toEqual(expect.arrayContaining([expect.closeTo(1673827199.999)]));
    expect(countSql).toContain('notes.mod_at > ?');
    expect(sqlParamsForCount).toEqual(expect.arrayContaining([1672531200]));
    expect(countSql).toContain('notes_fts.txt MATCH ?');
    expect(sqlParamsForCount).toEqual(expect.arrayContaining(['search text']));
  });

  it('should handle pagination correctly and calculate next_page', async () => {
    mockDbGet.mockReturnValueOnce({ total: 25 });
    mockDbAll.mockReturnValueOnce(
      new Array(5).fill({
        id: placeholderValidUuid, // Use valid UUID
        l_ver: 1,
        txt: 'note content', // Add txt field
        tags: '[]',
        mod_at: Math.floor(Date.now() / 1000),
        trash: 0,
      }),
    );

    const params = ListInputSchema.parse({ page: 2, lim: 5 });
    const result = await handleList(params, mockDb);

    const dataSql = mockDbPrepare.mock.calls[1][0] as string;
    const sqlParamsForData = mockDbAll.mock.calls[0] as any[];

    expect(dataSql).toContain('LIMIT ? OFFSET ?');
    expect(sqlParamsForData[sqlParamsForData.length - 2]).toBe(5);
    expect(sqlParamsForData[sqlParamsForData.length - 1]).toBe(5);

    expect(result.items.length).toBe(5);
    expect(result.total_items).toBe(25);
    expect(result.current_page).toBe(2);
    expect(result.total_pages).toBe(5);
    expect(result.next_page).toBe(3);
  });

  it('should not have next_page if on the last page', async () => {
    mockDbGet.mockReturnValueOnce({ total: 9 });
    // Provide complete mock objects for each item
    mockDbAll.mockReturnValueOnce(
      new Array(4).fill(0).map((_, i) => ({
        id: `00000000-0000-0000-0000-00000000000${i}`, // Use valid UUIDs
        l_ver: 1,
        txt: `note content ${i}`,
        tags: '[]',
        mod_at: Math.floor(Date.now() / 1000) + i,
        trash: 0,
      })),
    );

    const params = ListInputSchema.parse({ page: 2, lim: 5 });
    const result = await handleList(params, mockDb);

    const sqlParamsForData = mockDbAll.mock.calls[0] as any[];
    expect(sqlParamsForData[sqlParamsForData.length - 1]).toBe(5);

    expect(result.total_items).toBe(9);
    expect(result.current_page).toBe(2);
    expect(result.total_pages).toBe(2);
    expect(result.next_page).toBeUndefined();
  });

  it('should correctly parse and transform items', async () => {
    const mockNoteRows = [
      {
        id: placeholderValidUuid,
        l_ver: 1,
        txt: 'Title 1\nContent1',
        tags: '["tagA","tagB"]',
        mod_at: 1700000000,
        trash: 0,
      },
      {
        id: 'b2c3d4e5-f6a7-8901-2345-67890abcdef1',
        l_ver: 2,
        txt: '',
        tags: '[]',
        mod_at: 1700000001,
        trash: 1,
      },
      {
        id: 'c3d4e5f6-a7b8-9012-3456-7890abcdef23',
        l_ver: 3,
        txt: '  Spaced Title  \nContent3',
        tags: 'invalid-json',
        mod_at: 1700000002,
        trash: 0,
      },
    ];
    mockDbGet.mockReturnValueOnce({ total: mockNoteRows.length });
    mockDbAll.mockReturnValueOnce(mockNoteRows);

    const params = ListInputSchema.parse({});
    const result = await handleList(params, mockDb);

    expect(result.items.length).toBe(3);
    expect(result.items[0].id).toBe(placeholderValidUuid);
    expect(result.items[0].title_prev).toBe('Title 1');
    expect(result.items[0].tags).toEqual(['tagA', 'tagB']);
    expect(result.items[0].trash).toBe(false);
    expect(result.items[1].id).toBe('b2c3d4e5-f6a7-8901-2345-67890abcdef1');
    expect(result.items[1].title_prev).toBe('');
    expect(result.items[1].tags).toEqual([]);
    expect(result.items[1].trash).toBe(true);
    expect(result.items[2].id).toBe('c3d4e5f6-a7b8-9012-3456-7890abcdef23');
    expect(result.items[2].title_prev).toBe('Spaced Title');
    expect(result.items[2].tags).toEqual([]);
  });

  // Add more tests for query parsing (q, tag:, before:, after:), FTS, pagination, data transformation etc.
});
