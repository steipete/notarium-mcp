import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { PatchOperationSchema, SaveInputSchema, NoteDataSchema } from '../schemas.js';
import { applyTextPatch, handleSave } from './save.js'; // Import the function and handleSave
import {
  NotariumValidationError,
  NotariumResourceNotFoundError,
  NotariumDbError,
  NotariumBackendError,
} from '../errors.js';
import type { Database as DB } from 'better-sqlite3';
import type { SimperiumNotePayload, SimperiumSaveResponse } from '../backend/simperium-api.js'; // For mocking

// Mock logger
vi.mock('../logging.js', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock uuidv4 to return predictable UUIDs for new notes
let mockUuidCounter = 0;
vi.mock('uuid', () => ({
  v4: vi.fn(() => {
    mockUuidCounter++;
    // Generate a valid UUID format for testing
    return `a1b2c3d4-e5f6-7890-${String(mockUuidCounter).padStart(4, '0')}-567890abcdef`;
  }),
}));

// Mock simperiumSaveNote from backend API
vi.mock('../backend/simperium-api.js', () => ({
  saveNote: vi.fn(),
}));

// Get the mock after vi.mock
import { saveNote } from '../backend/simperium-api.js';
const mockSimperiumSaveNote = saveNote as any;

// Mock the database interactions
const mockDbRun = vi.fn();
const mockDbGet = vi.fn();
const mockDbPrepare = vi.fn(() => ({
  run: mockDbRun,
  get: mockDbGet,
}));
const mockDb = { prepare: mockDbPrepare } as unknown as DB;

describe('applyTextPatch', () => {
  const initialText = 'line one\nline two\nline three\nline four';

  it('should return original text if no patches are provided', () => {
    expect(applyTextPatch(initialText, [])).toBe(initialText);
  });

  it('should handle add operations correctly', () => {
    const patches: z.infer<typeof PatchOperationSchema>[] = [
      { op: 'add', ln: 2, val: 'new line 1.5' },
      { op: 'add', ln: 1, val: 'new line 0.5' },
      { op: 'add', ln: 5, val: 'new line 4.5' },
    ];
    const expectedText =
      'new line 0.5\nline one\nnew line 1.5\nline two\nline three\nline four\nnew line 4.5';
    expect(applyTextPatch(initialText, patches)).toBe(expectedText);
  });

  it('should handle add operation at the end of the file (ln > lines.length)', () => {
    const patches: z.infer<typeof PatchOperationSchema>[] = [
      { op: 'add', ln: 10, val: 'new last line' },
    ];
    const expectedText = 'line one\nline two\nline three\nline four\nnew last line';
    expect(applyTextPatch(initialText, patches)).toBe(expectedText);
  });

  it('should handle delete operations correctly (high to low line numbers)', () => {
    const patches: z.infer<typeof PatchOperationSchema>[] = [
      { op: 'del', ln: 3 },
      { op: 'del', ln: 1 },
    ];
    const expectedText = 'line two\nline four';
    expect(applyTextPatch(initialText, patches)).toBe(expectedText);
  });

  it('should handle delete out of bounds silently', () => {
    const patches: z.infer<typeof PatchOperationSchema>[] = [
      { op: 'del', ln: 10 },
      { op: 'del', ln: 0 },
    ];
    expect(applyTextPatch(initialText, patches)).toBe(initialText);
  });

  it('should handle modify operations correctly', () => {
    const patches: z.infer<typeof PatchOperationSchema>[] = [
      { op: 'mod', ln: 2, val: 'modified line two' },
      { op: 'mod', ln: 4, val: 'MODIFIED LINE FOUR' },
    ];
    const expectedText = 'line one\nmodified line two\nline three\nMODIFIED LINE FOUR';
    expect(applyTextPatch(initialText, patches)).toBe(expectedText);
  });

  it('should handle modify out of bounds silently', () => {
    const patches: z.infer<typeof PatchOperationSchema>[] = [
      { op: 'mod', ln: 10, val: 'this should not appear' },
    ];
    expect(applyTextPatch(initialText, patches)).toBe(initialText);
  });

  it('should handle a mix of operations in the correct order (del, mod, add)', () => {
    const patches: z.infer<typeof PatchOperationSchema>[] = [
      { op: 'add', ln: 2, val: 'added before two' },
      { op: 'del', ln: 3 },
      { op: 'mod', ln: 1, val: 'MODIFIED line one' },
      { op: 'del', ln: 4 },
      { op: 'add', ln: 1, val: 'PREPENDED' },
    ];
    const expectedText = 'PREPENDED\nMODIFIED line one\nadded before two\nline two';
    expect(applyTextPatch(initialText, patches)).toBe(expectedText);
  });

  it('should handle multiple operations on the same line number appropriately', () => {
    const text = 'a\nb\nc';
    const patches: z.infer<typeof PatchOperationSchema>[] = [
      { op: 'del', ln: 2 },
      { op: 'add', ln: 2, val: 'new b' },
      { op: 'mod', ln: 2, val: 'cannot mod deleted' },
    ];
    const expectedText = 'a\nnew b\ncannot mod deleted';
    expect(applyTextPatch(text, patches)).toBe(expectedText);
  });

  it('should handle empty string input', () => {
    const patches: z.infer<typeof PatchOperationSchema>[] = [
      { op: 'add', ln: 1, val: 'first line' },
      { op: 'add', ln: 2, val: 'second line' },
    ];
    expect(applyTextPatch('', patches)).toBe('first line\nsecond line');
  });

  it('should handle patches on single line text', () => {
    const text = 'only one line';
    const patches: z.infer<typeof PatchOperationSchema>[] = [
      { op: 'mod', ln: 1, val: 'the only modified line' },
      { op: 'add', ln: 2, val: 'a new second line' },
      { op: 'add', ln: 1, val: 'a new first line' },
    ];
    const expectedText = 'a new first line\nthe only modified line\na new second line';
    expect(applyTextPatch(text, patches)).toBe(expectedText);
  });
});

describe('handleSave Tool', () => {
  const placeholderValidUuid = 'a1b2c3d4-e5f6-7890-1234-567890abcdef';
  const sampleExistingNote = {
    id: placeholderValidUuid,
    l_ver: 1,
    s_ver: 10,
    txt: 'Original content',
    tags: JSON.stringify(['original']),
    mod_at: Math.floor(Date.now() / 1000) - 100,
    crt_at: Math.floor(Date.now() / 1000) - 200,
    trash: 0,
  };

  beforeEach(() => {
    mockDbRun.mockReset();
    mockDbGet.mockReset();
    mockDbPrepare.mockClear();
    mockSimperiumSaveNote.mockReset();
    mockUuidCounter = 0; // Reset UUID counter for predictable new IDs
  });

  it('should create a new note if no id is provided', async () => {
    const params = SaveInputSchema.parse({
      txt: 'New note content',
      tags: ['new', 'test'],
    });

    const expectedUuid = 'a1b2c3d4-e5f6-7890-0001-567890abcdef';
    const mockServerResponse: SimperiumSaveResponse = {
      id: expectedUuid,
      version: 1,
      data: {
        content: 'New note content',
        tags: ['new', 'test'],
        modificationDate: Math.floor(Date.now() / 1000),
        creationDate: Math.floor(Date.now() / 1000),
        deleted: false,
      },
    };
    mockSimperiumSaveNote.mockResolvedValueOnce(mockServerResponse);

    const result = await handleSave(params, mockDb);

    expect(mockSimperiumSaveNote).toHaveBeenCalledWith(
      'note', // bucketName
      expectedUuid, // generated ID
      expect.objectContaining({
        content: 'New note content',
        tags: ['new', 'test'],
        deleted: false,
      }),
      undefined, // baseVersion for new note
    );
    expect(mockDbPrepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR REPLACE INTO notes'),
    );
    expect(mockDbRun).toHaveBeenCalledWith(
      expectedUuid, // id
      1, // l_ver (0 initial + 1)
      1, // s_ver from response
      'New note content',
      JSON.stringify(['new', 'test']),
      expect.any(Number), // mod_at
      expect.any(Number), // crt_at
      0, // trash
      0, // sync_deleted
    );
    expect(result.id).toBe(expectedUuid);
    expect(result.l_ver).toBe(1);
    expect(result.s_ver).toBe(1);
    expect(result.txt).toBe('New note content');
  });

  it('should update an existing note if id and l_ver are provided', async () => {
    mockDbGet.mockReturnValueOnce(sampleExistingNote); // Return the note to be updated
    const params = SaveInputSchema.parse({
      id: sampleExistingNote.id,
      l_ver: sampleExistingNote.l_ver,
      s_ver: sampleExistingNote.s_ver, // Client thinks this is the server version
      txt: 'Updated content',
    });

    const mockServerResponse: SimperiumSaveResponse = {
      id: sampleExistingNote.id,
      version: sampleExistingNote.s_ver + 1,
      data: {
        content: 'Updated content',
        modificationDate: Math.floor(Date.now() / 1000),
        deleted: false,
        tags: JSON.parse(sampleExistingNote.tags),
      },
    };
    mockSimperiumSaveNote.mockResolvedValueOnce(mockServerResponse);

    const result = await handleSave(params, mockDb);

    expect(mockSimperiumSaveNote).toHaveBeenCalledWith(
      'note',
      sampleExistingNote.id,
      expect.objectContaining({ content: 'Updated content' }),
      sampleExistingNote.s_ver, // baseVersion for update
    );
    expect(mockDbRun).toHaveBeenCalledWith(
      sampleExistingNote.id,
      sampleExistingNote.l_ver + 1,
      sampleExistingNote.s_ver + 1,
      'Updated content',
      sampleExistingNote.tags, // Unchanged tags
      expect.any(Number),
      sampleExistingNote.crt_at,
      0,
      0,
    );
    expect(result.s_ver).toBe(sampleExistingNote.s_ver + 1);
  });

  it('should apply txt_patch to existing note content before saving', async () => {
    mockDbGet.mockReturnValueOnce(sampleExistingNote); // txt: 'Original content'
    const params = SaveInputSchema.parse({
      id: sampleExistingNote.id,
      l_ver: sampleExistingNote.l_ver,
      s_ver: sampleExistingNote.s_ver,
      txt_patch: [{ op: 'mod', ln: 1, val: 'Patched original content' }],
    });

    const mockServerResponse: SimperiumSaveResponse = {
      id: sampleExistingNote.id,
      version: sampleExistingNote.s_ver + 1,
      data: {
        content: 'Patched original content',
        modificationDate: Math.floor(Date.now() / 1000),
        deleted: false,
        tags: JSON.parse(sampleExistingNote.tags),
      },
    };
    mockSimperiumSaveNote.mockResolvedValueOnce(mockServerResponse);

    await handleSave(params, mockDb);
    expect(mockSimperiumSaveNote).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ content: 'Patched original content' }),
      expect.anything(),
    );
    expect(mockDbRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'Patched original content',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('should throw NotariumValidationError if l_ver is missing for an update', async () => {
    const params = { id: placeholderValidUuid, txt: 'some text' }; // Missing l_ver
    // Not using SaveInputSchema.parse here as it would throw before handleSave is called
    await expect(handleSave(params as any, mockDb)).rejects.toThrow(NotariumValidationError);
  });

  it('should throw NotariumResourceNotFoundError if note for update not found in DB', async () => {
    mockDbGet.mockReturnValueOnce(undefined); // Note not found
    const params = SaveInputSchema.parse({
      id: placeholderValidUuid,
      l_ver: 1,
      txt: 'update text',
    });
    await expect(handleSave(params, mockDb)).rejects.toThrow(NotariumResourceNotFoundError);
  });

  it('should propagate NotariumBackendError on Simperium conflict', async () => {
    mockDbGet.mockReturnValueOnce(sampleExistingNote);
    const params = SaveInputSchema.parse({
      id: sampleExistingNote.id,
      l_ver: sampleExistingNote.l_ver,
      s_ver: sampleExistingNote.s_ver,
      txt: 'update text',
    });
    mockSimperiumSaveNote.mockRejectedValueOnce(
      new NotariumBackendError('Conflict', 'Conflict user msg', 412, 'conflict'),
    );
    await expect(handleSave(params, mockDb)).rejects.toThrow(NotariumBackendError);
  });

  // Add more tests: s_ver from params vs db, tag updates, trash updates, error propagation
});
