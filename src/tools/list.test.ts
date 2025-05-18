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

const mockDbPrepare = vi.fn(() => ({
  bind: mockStmtBind,
  step: mockStmtStep,
  getAsObject: mockStmtGetAsObject,
  free: mockStmtFree,
}));

const mockDb = { prepare: mockDbPrepare } as unknown as SqlJsDB;

const placeholderValidUuid = 'a1b2c3d4-e5f6-7890-1234-567890abcdef'; // Reusable valid UUID

describe('handleList Tool', () => {
  beforeEach(() => {
    // Reset mocks before each test
    mockStmtBind.mockReset();
    mockStmtStep.mockReset();
    mockStmtGetAsObject.mockReset();
    mockStmtFree.mockReset();
    mockDbPrepare.mockClear(); // Clear call counts for prepare itself
  });

  it('should return an empty list if DB queries return no results', async () => {
    // Setup mocks to return empty results
    // For the COUNT(*) query
    mockDbPrepare.mockImplementationOnce(() => ({
      bind: vi.fn(),
      step: vi.fn().mockReturnValueOnce(true), // Simulate one row for count
      getAsObject: vi.fn().mockReturnValueOnce({ total: 0 }),
      free: vi.fn(),
    }));
    // For the data SELECT query
    mockDbPrepare.mockImplementationOnce(() => ({
      bind: vi.fn(),
      step: vi.fn().mockReturnValueOnce(false), // Simulate no rows for data
      getAsObject: vi.fn(), // Not called if step is false
      free: vi.fn(),
    }));

    const params = ListInputSchema.parse({}); // Minimal valid params
    const result = await handleList(params, mockDb);

    expect(mockDbPrepare).toHaveBeenCalledTimes(2); // Once for count, once for data

    expect(result.items).toEqual([]);
    expect(result.total_items).toBe(0);
    expect(result.current_page).toBe(1);
    expect(result.total_pages).toBe(0);
    expect(result.next_page).toBeUndefined();
  });

  it('should correctly query for non-trashed items by default', async () => {
    mockDbPrepare.mockImplementation(() => ({ // General mock for both calls
      bind: mockStmtBind, // Use the shared mock for bind to check params
      step: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false), // Count has a row, data has none
      getAsObject: vi.fn().mockReturnValueOnce({ total: 0 }),
      free: vi.fn(),
    }));

    const params = ListInputSchema.parse({});
    await handleList(params, mockDb);

    // Check the SQL for the count query (first call to prepare)
    expect(mockDbPrepare.mock.calls[0][0]).toContain('WHERE notes.trash = 0');
    // Check the SQL for the data query (second call to prepare)
    expect(mockDbPrepare.mock.calls[1][0]).toContain('WHERE notes.trash = 0');
  });

  it('should correctly query for trashed items when trash_s = 1', async () => {
    mockDbPrepare.mockImplementation(() => ({
      bind: mockStmtBind,
      step: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false),
      getAsObject: vi.fn().mockReturnValueOnce({ total: 0 }),
      free: vi.fn(),
    }));
    const params = ListInputSchema.parse({ trash_s: 1 });
    await handleList(params, mockDb);

    expect(mockDbPrepare.mock.calls[0][0]).toContain('WHERE notes.trash = 1');
    expect(mockDbPrepare.mock.calls[1][0]).toContain('WHERE notes.trash = 1');
  });

  it('should correctly query for all items (including trash) when trash_s = 2', async () => {
    mockDbPrepare.mockImplementation(() => ({
      bind: mockStmtBind,
      step: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false),
      getAsObject: vi.fn().mockReturnValueOnce({ total: 0 }),
      free: vi.fn(),
    }));
    const params = ListInputSchema.parse({ trash_s: 2 });
    await handleList(params, mockDb);

    const countQuerySql = mockDbPrepare.mock.calls[0][0] as string;
    const dataQuerySql = mockDbPrepare.mock.calls[1][0] as string;

    expect(countQuerySql).not.toContain('notes.trash = 0');
    expect(countQuerySql).not.toContain('notes.trash = 1');
    expect(dataQuerySql).not.toContain('notes.trash = 0');
    expect(dataQuerySql).not.toContain('notes.trash = 1');

    if (!params.q && !params.tags && !params.date_before && !params.date_after) {
      expect(countQuerySql).toMatch(/WHERE\s+1=1/);
      expect(dataQuerySql).toMatch(/WHERE\s+1=1/);
    }
  });

  it('should apply tag filters correctly', async () => {
    mockDbPrepare.mockImplementation(() => ({
      bind: mockStmtBind, // Check calls to this mock
      step: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false), // Count row, then no data rows
      getAsObject: vi.fn().mockReturnValueOnce({ total: 0 }),
      free: vi.fn(),
    }));
    const params = ListInputSchema.parse({ tags: ['work', 'urgent'] });
    await handleList(params, mockDb);

    const expectedTagClause = 'EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ?)';
    // For COUNT query
    expect(mockDbPrepare.mock.calls[0][0]).toContain(expectedTagClause);
    expect(mockDbPrepare.mock.calls[0][0]).toContain(expectedTagClause); // Called twice for two tags
    // For data query
    expect(mockDbPrepare.mock.calls[1][0]).toContain(expectedTagClause);
    expect(mockDbPrepare.mock.calls[1][0]).toContain(expectedTagClause);

    // Check parameters passed to bind for the count query (first prepare call)
    // bind is called on the statement returned by prepare
    expect(mockStmtBind.mock.calls[0][0]).toEqual(expect.arrayContaining(['work', 'urgent']));
    // Check parameters passed to bind for the data query (second prepare call)
    // This will be called after the first one, so check call [1]
    expect(mockStmtBind.mock.calls[1][0]).toEqual(expect.arrayContaining(['work', 'urgent', params.limit, 0]));
  });

  it('should parse q for tags, before, and after dates', async () => {
    mockDbPrepare.mockImplementation(() => ({
      bind: mockStmtBind,
      step: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false),
      getAsObject: vi.fn().mockReturnValueOnce({ total: 0 }),
      free: vi.fn(),
    }));
    const params = ListInputSchema.parse({
      q: 'search text tag:fromq before:2023-01-15 after:2023-01-01',
      tags: ['initialtag'],
      date_before: '2023-01-30',
      date_after: '2022-12-01',
    });
    await handleList(params, mockDb);

    const countSql = mockDbPrepare.mock.calls[0][0] as string;
    const sqlParamsForCountBind = mockStmtBind.mock.calls[0][0];

    expect(countSql).toContain('EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ?)');
    expect(sqlParamsForCountBind).toEqual(expect.arrayContaining(['initialtag', 'fromq']));
    expect(countSql).toContain('notes.modified_at < ?');
    expect(sqlParamsForCountBind).toEqual(expect.arrayContaining([expect.closeTo(1673827199.999)]));
    expect(countSql).toContain('notes.modified_at > ?');
    expect(sqlParamsForCountBind).toEqual(expect.arrayContaining([1672531200]));
    expect(countSql).toContain('notes_fts.text MATCH ?');
    expect(sqlParamsForCountBind).toEqual(expect.arrayContaining(['search text']));
  });

  it('should handle pagination correctly and calculate next_page', async () => {
    const limit = 5;
    const page = 2;
    const offset = (page - 1) * limit; // 5

    mockDbPrepare.mockImplementationOnce(() => ({ // Count query
      bind: vi.fn(),
      step: vi.fn().mockReturnValueOnce(true),
      getAsObject: vi.fn().mockReturnValueOnce({ total: 25 }),
      free: vi.fn(),
    }));
    mockDbPrepare.mockImplementationOnce(() => ({ // Data query
      bind: mockStmtBind,
      step: vi.fn() // This will be chained: .mockReturnValueOnce(true) for each row
        .mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(true)
        .mockReturnValueOnce(false), // End of rows
      getAsObject: vi.fn().mockImplementation(() => ({
        id: placeholderValidUuid,
        local_version: 1,
        text: 'note content',
        tags: '[]',
        modified_at: Math.floor(Date.now() / 1000),
        trash: 0,
      })),
      free: vi.fn(),
    }));

    const params = ListInputSchema.parse({ page, limit });
    const result = await handleList(params, mockDb);

    const dataQuerySql = mockDbPrepare.mock.calls[1][0] as string;
    expect(dataQuerySql).toContain('LIMIT ? OFFSET ?');
    
    // Check the parameters passed to bind for the data query
    expect(mockStmtBind.mock.calls[0][0]).toEqual(expect.arrayContaining([limit, offset]));

    expect(result.items.length).toBe(5);
    expect(result.total_items).toBe(25);
    expect(result.current_page).toBe(2);
    expect(result.total_pages).toBe(5);
    expect(result.next_page).toBe(3);
  });

  it('should not have next_page if on the last page', async () => {
    const limit = 5;
    const page = 2;
    mockDbPrepare.mockImplementationOnce(() => ({ // Count query
        bind: vi.fn(),
        step: vi.fn().mockReturnValueOnce(true),
        getAsObject: vi.fn().mockReturnValueOnce({ total: 9 }),
        free: vi.fn(),
    }));
    mockDbPrepare.mockImplementationOnce(() => ({ // Data query
        bind: mockStmtBind,
        step: vi.fn()
            .mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(true) // 4 rows for page 2
            .mockReturnValueOnce(false),
        getAsObject: vi.fn().mockImplementation((idx: number) => ({
            id: `00000000-0000-0000-0000-00000000000${idx}`,
            local_version: 1,
            text: `note content ${idx}`,
            tags: '[]',
            modified_at: Math.floor(Date.now() / 1000) + idx,
            trash: 0,
        })),
        free: vi.fn(),
    }));

    const params = ListInputSchema.parse({ page, limit });
    const result = await handleList(params, mockDb);

    expect(mockStmtBind.mock.calls[0][0]).toEqual(expect.arrayContaining([limit, (page - 1) * limit]));

    expect(result.total_items).toBe(9);
    expect(result.current_page).toBe(2);
    expect(result.total_pages).toBe(2);
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
    mockDbPrepare.mockImplementationOnce(() => ({ // Count
        bind: vi.fn(),
        step: vi.fn().mockReturnValueOnce(true),
        getAsObject: vi.fn().mockReturnValueOnce({ total: mockNoteRowsDb.length }),
        free: vi.fn(),
    }));
    mockDbPrepare.mockImplementationOnce(() => ({ // Data
        bind: vi.fn(),
        step: vi.fn()
            .mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(true) // 3 rows
            .mockReturnValueOnce(false),
        getAsObject: vi.fn()
            .mockReturnValueOnce(mockNoteRowsDb[0])
            .mockReturnValueOnce(mockNoteRowsDb[1])
            .mockReturnValueOnce(mockNoteRowsDb[2]),
        free: vi.fn(),
    }));

    const params = ListInputSchema.parse({});
    const result = await handleList(params, mockDb);

    expect(result.items.length).toBe(3);
    expect(result.items[0].id).toBe(placeholderValidUuid);
    expect(result.items[0].title_prev).toBe('Title 1');
    expect(result.items[0].tags).toEqual(['tagA', 'tagB']);
    expect(result.items[0].modified_at).toBe(1700000000);
    expect(result.items[0].trash).toBe(false);
    expect(result.items[1].id).toBe('b2c3d4e5-f6a7-8901-2345-67890abcdef1');
    expect(result.items[1].title_prev).toBe('');
    expect(result.items[1].tags).toEqual([]);
    expect(result.items[1].modified_at).toBe(1700000001);
    expect(result.items[1].trash).toBe(true);
    expect(result.items[2].id).toBe('c3d4e5f6-a7b8-9012-3456-7890abcdef23');
    expect(result.items[2].title_prev).toBe('Spaced Title');
    expect(result.items[2].tags).toEqual([]);
    expect(result.items[2].modified_at).toBe(1700000002);
  });
});
