import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleManage } from './manage.js';
import {
  ManageInputSchema,
  ServerStatsSchema,
  ManageGetStatsOutputSchema,
  ManageNoteActionOutputSchema,
  ManageResetCacheOutputSchema,
} from '../schemas.js';
import { z } from 'zod';
import {
  NotariumResourceNotFoundError,
  NotariumValidationError,
  NotariumInternalError,
} from '../errors.js';
import type { Database as DB } from 'better-sqlite3';
import type { BackendSyncService } from '../sync/sync-service.js';
import type { AppConfig } from '../config.js';
import type { SimperiumNotePayload, SimperiumSaveResponse } from '../backend/simperium-api.js';

// --- Mocks ---
vi.mock('../logging.js', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockDbRun = vi.fn();
const mockDbGet = vi.fn();
const mockDbExec = vi.fn();
const mockDbTransaction = vi.fn((cb) => cb()); // Immediately execute the transaction callback
const mockDbClose = vi.fn();
let mockDbOpen = true; // To simulate db.open state for reset_cache
const mockDbPragma = vi.fn();
const mockDbPrepare = vi.fn(() => ({
  run: mockDbRun,
  get: mockDbGet,
  exec: mockDbExec,
}));
const mockDb = {
  prepare: mockDbPrepare,
  transaction: mockDbTransaction,
  close: mockDbClose,
  get open() {
    return mockDbOpen;
  }, // Getter for .open property
  pragma: mockDbPragma,
} as unknown as DB;

const mockSyncServiceGetSyncStats = vi.fn();
const mockSyncService = {
  getSyncStats: mockSyncServiceGetSyncStats,
} as unknown as BackendSyncService;

// Mock simperiumSaveNote from backend API
// const mockSimperiumSaveNote = vi.fn(); // Define it separately if needed elsewhere, but for direct mock, can be inline.
vi.mock('../backend/simperium-api.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../backend/simperium-api.js')>();
  return {
    ...original,
    saveNote: vi.fn(), // Assign vi.fn() directly here for the mock module
    // Ensure getSimperiumApiClient is also mocked if its real implementation is problematic in tests
    getSimperiumApiClient: vi.fn().mockResolvedValue({
      post: vi.fn().mockResolvedValue({ data: {}, headers: {} }), // Mock post further if its call results matter
      get: vi.fn().mockResolvedValue({ data: {} }), // Mock get further
    }),
  };
});

// To use the mocked saveNote in tests, we need to import it *after* the mock setup.
// This can be tricky with static imports. One way is to re-import or get it from the mocked module.
// For simplicity, if tests need to assert calls on mockSimperiumSaveNote, we might need to export the mock itself from the factory.

// A common pattern for accessing the mock function from the test file:
import { saveNote } from '../backend/simperium-api.js';
let mockSimperiumSaveNoteFn = saveNote as ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.clearAllMocks();
  // Reset the saveNote mock since it's imported statically
  mockSimperiumSaveNoteFn = saveNote as ReturnType<typeof vi.fn>; // Assign the mocked function

  (global as any).fullResyncRequiredByReset = false;
  mockDbOpen = true;
  mockSyncServiceGetSyncStats.mockReturnValue({
    lastSyncStatus: 'idle',
    consecutiveErrorCount: 0,
  });
  mockDbGet.mockImplementation((query, ...args) => {
    if (query.includes('SELECT COUNT(*) as count FROM notes')) return { count: 10 };
    if (query.includes('sync_metadata')) return { value: 'dummy_meta_value' };
    if (query.includes('FROM notes WHERE id = ? AND l_ver = ?')) return sampleExistingNote;
    return undefined;
  });
  mockDbPragma.mockReturnValue(1);
});

vi.mock('fs', () => ({
  default: {
    statSync: vi.fn(() => ({ size: 1024 * 1024 * 5 })), // 5MB
    existsSync: vi.fn(() => true),
    unlinkSync: vi.fn(),
  },
}));
vi.mock('path', () => ({
  default: {
    resolve: vi.fn((...args) => args.join('/')), // Simple mock for path.resolve
    dirname: vi.fn(() => '/mock/path'),
  },
}));

const mockProcess = {
  cwd: vi.fn(() => '/mock/cwd'),
  memoryUsage: vi.fn(() => ({ rss: 50 * 1024 * 1024 })), // 50MB RSS
  version: 'v20.0.0',
};
vi.stubGlobal('process', mockProcess);
vi.stubGlobal('global', { fullResyncRequiredByReset: false }); // Mock global for reset_cache

const sampleAppConfig: AppConfig = {
  MCP_NOTARIUM_VERSION: '1.0.0-test',
  NODE_VERSION: 'v20.0.0-test',
  DB_ENCRYPTION_KEY: 'test-key',
  SIMPLENOTE_USERNAME: 'test@example.com',
  SIMPLENOTE_PASSWORD: 'password',
  DB_ENCRYPTION_KDF_ITERATIONS: 310000,
  SYNC_INTERVAL_SECONDS: 300,
  API_TIMEOUT_SECONDS: 30,
  LOG_LEVEL: 'info',
  OWNER_IDENTITY_SALT: 'test-salt',
};

const sampleNoteId = '550e8400-e29b-41d4-a716-446655440001'; // Valid UUID format
const sampleExistingNote = {
  id: sampleNoteId,
  l_ver: 3,
  s_ver: 15,
  txt: 'Manage me',
  tags: JSON.stringify(['manageable']),
  trash: 0,
};

describe('handleManage Tool', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-assign the mock function reference for saveNote from the mocked module
    const { saveNote: importedSaveNoteMock } = await import('../backend/simperium-api.js');
    mockSimperiumSaveNoteFn = importedSaveNoteMock as ReturnType<typeof vi.fn>;

    (global as any).fullResyncRequiredByReset = false;
    mockDbOpen = true;
    mockSyncServiceGetSyncStats.mockReturnValue({
      lastSyncStatus: 'idle',
      consecutiveErrorCount: 0,
    });
    mockDbGet.mockImplementation((query?: string, ..._args: any[]) => {
      if (query && query.includes('SELECT COUNT(*) as count FROM notes')) return { count: 10 };
      if (query && query.includes('sync_metadata')) return { value: 'dummy_meta_value' };
      if (query && query.includes('FROM notes WHERE id = ? AND l_ver = ?'))
        return sampleExistingNote;
      return undefined;
    });
    mockDbPragma.mockReturnValue(1);
    mockDbTransaction.mockImplementation((callback: () => any) => callback());
  });

  describe('Action: get_stats', () => {
    it('should return server statistics successfully', async () => {
      mockDbPrepare.mockImplementation((query?: string) => ({
        run: mockDbRun,
        get: vi.fn(() => {
          if (query && query.includes('COUNT(*)')) return { count: 123 };
          if (query && query.includes("key = 'last_successful_sync_at'"))
            return { value: '1670000000' };
          if (query && query.includes("key = 'backend_cursor'")) return { value: 'cursor123' };
          if (query && query.includes("key = 'last_sync_duration_ms'")) return { value: '500' };
          if (query && query.includes("key = 'sync_error_count'")) return { value: '0' };
          if (query && query.includes('sync_metadata')) return { value: 'default_stat_meta' };
          return { value: 'other_value' };
        }),
        exec: mockDbExec,
      }));
      mockDbPragma.mockReturnValue(2);
      const params = ManageInputSchema.parse({ act: 'get_stats' });
      const result = (await handleManage(
        params,
        mockDb,
        mockSyncService,
        sampleAppConfig,
      )) as z.infer<typeof ManageGetStatsOutputSchema>;

      expect(result.mcp_notarium_version).toBe('1.0.0-test');
      expect(result.node_version).toBe('v20.0.0-test');
      expect(result.memory_rss_mb).toBe(50);
      expect(result.db_encryption).toBe('enabled');
      expect(result.db_file_size_mb).toBe(5);
      expect(result.db_total_notes).toBe(123);
      expect(result.db_last_sync_at).toBe(1670000000);
      expect(result.db_schema_version).toBe(2);
      expect(result.backend_cursor).toBe('cursor123');
      expect(ServerStatsSchema.safeParse(result).success).toBe(true);
    });
  });

  describe('Action: reset_cache', () => {
    it('should close DB, delete files, and set fullResyncRequiredByReset flag', async () => {
      const params = ManageInputSchema.parse({ act: 'reset_cache' });
      const result = (await handleManage(
        params,
        mockDb,
        mockSyncService,
        sampleAppConfig,
      )) as z.infer<typeof ManageResetCacheOutputSchema>;

      expect(mockDbClose).toHaveBeenCalled();
      const fsMock = await import('fs');
      expect(fsMock.default.unlinkSync).toHaveBeenCalledTimes(3); // .db, -wal, -shm
      expect((global as any).fullResyncRequiredByReset).toBe(true);
      expect(result.status).toBe('success');
      expect(result.full_resync_triggered).toBe(true);
    });
    it('should handle DB already closed during reset_cache', async () => {
      mockDbOpen = false; // Simulate DB already closed
      const params = ManageInputSchema.parse({ act: 'reset_cache' });
      await handleManage(params, mockDb, mockSyncService, sampleAppConfig);
      expect(mockDbClose).not.toHaveBeenCalled(); // Should not attempt to close an already closed DB
      const fsMock = await import('fs');
      expect(fsMock.default.unlinkSync).toHaveBeenCalledTimes(3);
    });
  });

  describe('Note Actions (trash, untrash, delete_permanently)', () => {
    it('should trash a note successfully', async () => {
      mockDbPrepare.mockImplementationOnce(() => ({
        run: mockDbRun,
        get: vi.fn(() => sampleExistingNote),
        exec: mockDbExec,
      }));
      const mockServerResponse: SimperiumSaveResponse = {
        id: sampleNoteId,
        version: sampleExistingNote.s_ver + 1,
        data: {
          content: sampleExistingNote.txt,
          tags: JSON.parse(sampleExistingNote.tags),
          deleted: true,
          modificationDate: Math.floor(Date.now() / 1000),
          creationDate: undefined,
          publishURL: undefined,
          shareURL: undefined,
          systemTags: undefined,
        },
      };
      mockSimperiumSaveNoteFn.mockResolvedValueOnce(mockServerResponse);
      const params = ManageInputSchema.parse({
        act: 'trash',
        id: sampleNoteId,
        l_ver: sampleExistingNote.l_ver,
      });
      const result = (await handleManage(
        params,
        mockDb,
        mockSyncService,
        sampleAppConfig,
      )) as z.infer<typeof ManageNoteActionOutputSchema>;
      expect(mockSimperiumSaveNoteFn).toHaveBeenCalledWith(
        'note',
        sampleNoteId,
        expect.objectContaining({
          deleted: true,
          content: sampleExistingNote.txt,
          tags: JSON.parse(sampleExistingNote.tags),
        }),
        sampleExistingNote.s_ver,
      );
      expect(mockDbRun).toHaveBeenCalledWith(
        1,
        mockServerResponse.version,
        sampleExistingNote.l_ver + 1,
        sampleNoteId,
      );
      expect(result.status).toBe('trashed');
      expect(result.new_s_ver).toBe(mockServerResponse.version);
    });

    it('should untrash a note successfully', async () => {
      const trashedNote = { ...sampleExistingNote, trash: 1 };
      mockDbPrepare.mockImplementationOnce(() => ({
        run: mockDbRun,
        get: vi.fn(() => trashedNote),
        exec: mockDbExec,
      }));
      const mockServerResponse: SimperiumSaveResponse = {
        id: sampleNoteId,
        version: trashedNote.s_ver + 1,
        data: {
          content: trashedNote.txt,
          tags: JSON.parse(trashedNote.tags),
          deleted: false,
          modificationDate: Math.floor(Date.now() / 1000),
          creationDate: undefined,
          publishURL: undefined,
          shareURL: undefined,
          systemTags: undefined,
        },
      };
      mockSimperiumSaveNoteFn.mockResolvedValueOnce(mockServerResponse);
      const params = ManageInputSchema.parse({
        act: 'untrash',
        id: sampleNoteId,
        l_ver: trashedNote.l_ver,
      });
      const result = (await handleManage(
        params,
        mockDb,
        mockSyncService,
        sampleAppConfig,
      )) as z.infer<typeof ManageNoteActionOutputSchema>;
      expect(mockSimperiumSaveNoteFn).toHaveBeenCalledWith(
        'note',
        sampleNoteId,
        expect.objectContaining({
          deleted: false,
          content: trashedNote.txt,
          tags: JSON.parse(trashedNote.tags),
        }),
        trashedNote.s_ver,
      );
      expect(mockDbRun).toHaveBeenCalledWith(
        0,
        mockServerResponse.version,
        trashedNote.l_ver + 1,
        sampleNoteId,
      );
      expect(result.status).toBe('untrashed');
    });

    it('should delete a note permanently (locally)', async () => {
      mockDbPrepare.mockImplementationOnce(() => ({
        run: mockDbRun,
        get: vi.fn(() => sampleExistingNote),
        exec: mockDbExec,
      }));
      const params = ManageInputSchema.parse({
        act: 'delete_permanently',
        id: sampleNoteId,
        l_ver: sampleExistingNote.l_ver,
      });
      const result = (await handleManage(
        params,
        mockDb,
        mockSyncService,
        sampleAppConfig,
      )) as z.infer<typeof ManageNoteActionOutputSchema>;

      expect(mockDbPrepare).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM notes WHERE id = ?'),
      );
      expect(mockDbPrepare).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM notes_fts WHERE id = ?'),
      );
      expect(mockDbRun).toHaveBeenCalledWith(sampleNoteId); // Called twice, once for notes, once for fts
      expect(mockDbTransaction).toHaveBeenCalled();
      expect(result.status).toBe('deleted');
    });

    it('should throw NotariumResourceNotFoundError if note not found for action', async () => {
      mockDbPrepare.mockImplementation(() => ({
        run: mockDbRun,
        get: vi.fn(() => undefined),
        exec: mockDbExec,
      }));
      const params = ManageInputSchema.parse({
        act: 'trash',
        id: '550e8400-e29b-41d4-a716-446655440000',
        l_ver: 1,
      });
      await expect(handleManage(params, mockDb, mockSyncService, sampleAppConfig)).rejects.toThrow(
        NotariumResourceNotFoundError,
      );
    });
  });
});
