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
import type { Database as SqlJsDB, Statement } from 'sql.js'; // Use SqlJsDB type
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

// Mock the database interactions for sql.js style
const mockDbRun = vi.fn();
const mockDbGet = vi.fn(); // This will be for the .get on the prepared statement for fetching existing note
const mockDbPrepare = vi.fn(() => ({
  run: mockDbRun,
  get: mockDbGet, 
  free: vi.fn(), 
  bind: vi.fn(), 
  step: vi.fn(), 
  getAsObject: vi.fn()
}));
const mockDb = { prepare: mockDbPrepare } as unknown as SqlJsDB;

const placeholderValidUuid = 'a1b2c3d4-e5f6-7890-1234-567890abcdef';

// Define an interface for the DB row structure
interface NoteDbRow {
  id: string;
  local_version: number;
  server_version?: number | null;
  text: string;
  tags: string; // JSON string in DB
  modified_at: number;
  created_at?: number | null;
  trash: number; // 0 or 1 in DB
}

const sampleExistingNote: NoteDbRow = {
  id: placeholderValidUuid,
  local_version: 1, // DB column name
  server_version: 10, // DB column name
  text: 'Original content',
  tags: JSON.stringify(['original']),
  modified_at: Math.floor(Date.now() / 1000) - 100, // DB uses modified_at
  created_at: Math.floor(Date.now() / 1000) - 200, // DB uses created_at
  trash: 0,
};

describe('applyTextPatch', () => {
  const initialText = 'line one\nline two\nline three\nline four';

  it('should return original text if no patches are provided', () => {
    expect(applyTextPatch(initialText, [])).toBe(initialText);
  });

  it('should handle add operations correctly', () => {
    const patches: z.infer<typeof PatchOperationSchema>[] = [
      { operation: 'add', line_number: 2, value: 'new line 1.5' },
      { operation: 'add', line_number: 1, value: 'new line 0.5' },
      { operation: 'add', line_number: 5, value: 'new line 4.5' },
      { operation: 'addition', line_number: 2, value: 'new line 1.5' },
      { operation: 'addition', line_number: 1, value: 'new line 0.5' },
      { operation: 'addition', line_number: 5, value: 'new line 4.5' },
    ];
    const expectedText =
      'new line 0.5\nline one\nnew line 1.5\nline two\nline three\nline four\nnew line 4.5';
    expect(applyTextPatch(initialText, patches)).toBe(expectedText);
  });

  it('should handle add operation at the end of the file (line_number > lines.length)', () => {
    const patches: z.infer<typeof PatchOperationSchema>[] = [
      { operation: 'add', line_number: 10, value: 'new last line' },
      { operation: 'addition', line_number: 10, value: 'new last line' },
    ];
    const expectedText = `${initialText}\nnew last line`;
    expect(applyTextPatch(initialText, patches)).toBe(expectedText);
  });

  it('should handle delete operations correctly (sorted by line_number desc)', () => {
    const patches: z.infer<typeof PatchOperationSchema>[] = [
      { operation: 'del', line_number: 1 }, // Delete first
      { operation: 'del', line_number: 3 }, // Delete (original) third
      { operation: 'deletion', line_number: 1 }, // Delete first
      { operation: 'deletion', line_number: 3 }, // Delete (original) third
    ];
    const expectedText = 'line two\nline four';
    expect(applyTextPatch(initialText, patches)).toBe(expectedText);
  });

  it('should handle delete out of bounds silently', () => {
    const patches: z.infer<typeof PatchOperationSchema>[] = [
      { operation: 'del', line_number: 10 },
      { operation: 'del', line_number: 0 },
      { operation: 'deletion', line_number: 10 },
      { operation: 'deletion', line_number: 0 },
    ];
    expect(applyTextPatch(initialText, patches)).toBe(initialText);
  });

  it('should handle modify operations correctly', () => {
    const patches: z.infer<typeof PatchOperationSchema>[] = [
      { operation: 'mod', line_number: 2, value: 'modified line two' },
      { operation: 'mod', line_number: 4, value: 'MODIFIED LINE FOUR' },
      { operation: 'modification', line_number: 2, value: 'modified line two' },
      { operation: 'modification', line_number: 4, value: 'MODIFIED LINE FOUR' },
    ];
    const expectedText =
      'line one\nmodified line two\nline three\nMODIFIED LINE FOUR';
    expect(applyTextPatch(initialText, patches)).toBe(expectedText);
  });

  it('should handle modify operation on a non-existent line (no change)', () => {
    const patches: z.infer<typeof PatchOperationSchema>[] = [
      { operation: 'mod', line_number: 10, value: 'should not appear' },
      { operation: 'modification', line_number: 10, value: 'should not appear' },
    ];
    expect(applyTextPatch(initialText, patches)).toBe(initialText);
  });

  it('should handle a mix of operations in the correct order (del, mod, add)', () => {
    const patches: z.infer<typeof PatchOperationSchema>[] = [
      { operation: 'add', line_number: 1, value: 'ADDED AT VERY BEGINNING' }, // Add first
      { operation: 'del', line_number: 2 }, // Delete original 'line two'
      { operation: 'mod', line_number: 3, value: 'MODIFIED original line three' }, // Modify original 'line three'
      { operation: 'add', line_number: 6, value: 'ADDED AT VERY END' }, // Add last
      { operation: 'addition', line_number: 1, value: 'ADDED AT VERY BEGINNING' }, // Add first
      { operation: 'deletion', line_number: 2 }, // Delete original 'line two'
      { operation: 'modification', line_number: 3, value: 'MODIFIED original line three' }, // Modify original 'line three'
      { operation: 'addition', line_number: 6, value: 'ADDED AT VERY END' }, // Add last
    ];
    const expectedTextAfterDelMod = 'ADDED AT VERY BEGINNING\nMODIFIED original line three\nline one\nline three\nline four\nADDED AT VERY END';
    expect(applyTextPatch(initialText, patches)).toBe(expectedTextAfterDelMod);
  });

  it('should handle multiple operations on the same line number appropriately', () => {
    const text = 'a\nb\nc';
    const patches: z.infer<typeof PatchOperationSchema>[] = [
      { operation: 'del', line_number: 2 },
      { operation: 'add', line_number: 2, value: 'new b' },
      { operation: 'mod', line_number: 2, value: 'cannot mod deleted' },
      { operation: 'deletion', line_number: 2 },
      { operation: 'addition', line_number: 2, value: 'new b' },
      { operation: 'modification', line_number: 2, value: 'cannot mod deleted' },
    ];
    const expectedText = 'a\nnew b\ncannot mod deleted';
    expect(applyTextPatch(text, patches)).toBe(expectedText);
  });

  it('should handle empty string input', () => {
    const patches: z.infer<typeof PatchOperationSchema>[] = [
      { operation: 'add', line_number: 1, value: 'first line' },
      { operation: 'add', line_number: 2, value: 'second line' },
      { operation: 'addition', line_number: 1, value: 'first line' },
      { operation: 'addition', line_number: 2, value: 'second line' },
    ];
    expect(applyTextPatch('', patches)).toBe('first line\nsecond line');
  });

  it('should handle patches on single line text', () => {
    const text = 'only one line';
    const patches: z.infer<typeof PatchOperationSchema>[] = [
      { operation: 'mod', line_number: 1, value: 'the only modified line' },
      { operation: 'add', line_number: 2, value: 'a new second line' },
      { operation: 'add', line_number: 1, value: 'a new first line' },
      { operation: 'modification', line_number: 1, value: 'the only modified line' },
      { operation: 'addition', line_number: 2, value: 'a new second line' },
      { operation: 'addition', line_number: 1, value: 'a new first line' },
    ];
    const expectedText = 'a new first line\nthe only modified line\na new second line';
    expect(applyTextPatch(text, patches)).toBe(expectedText);
  });
});

describe('handleSave Tool', () => {
  beforeEach(() => {
    mockDbRun.mockReset();
    mockDbGet.mockReset();
    mockDbPrepare.mockClear();
    mockSimperiumSaveNote.mockReset();
    mockUuidCounter = 0; // Reset UUID counter for predictable new IDs
  });

  it('should create a new note if no id is provided', async () => {
    const params = SaveInputSchema.parse({
      text: 'New note content',
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
    expect(mockDbRun).toHaveBeenCalledWith([
      expectedUuid, // id
      1, // local_version (0 initial + 1)
      1, // server_version from response
      'New note content',
      JSON.stringify(['new', 'test']),
      expect.any(Number), // modified_at (this corresponds to modified_at in DB insert)
      expect.any(Number), // created_at (this corresponds to created_at in DB insert)
      0, // trash
      0, // sync_deleted
    ]);
    expect(result.id).toBe(expectedUuid);
    expect(result.local_version).toBe(1);
    expect(result.server_version).toBe(1);
    expect(result.text).toBe('New note content');
    expect(result.modified_at).toEqual(expect.any(Number)); 
    expect(result.created_at).toEqual(expect.any(Number)); // Result uses created_at
  });

  it('should update an existing note if id and local_version are provided', async () => {
    mockDbGet.mockReturnValueOnce(sampleExistingNote); // Return the note to be updated
    const params = SaveInputSchema.parse({
      id: sampleExistingNote.id,
      local_version: sampleExistingNote.local_version, // Map DB local_version to schema local_version
      server_version: sampleExistingNote.server_version!, 
      text: 'Updated content',
    });

    const mockServerResponse: SimperiumSaveResponse = {
      id: sampleExistingNote.id,
      version: sampleExistingNote.server_version! + 1, // Simperium returns new server version
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
      'note', // bucketName
      sampleExistingNote.id,
      expect.objectContaining({ content: 'Updated content' }),
      sampleExistingNote.server_version!, // baseVersion for update should be the server_version of the current note
    );
    expect(mockDbRun).toHaveBeenCalledWith([
      sampleExistingNote.id,
      sampleExistingNote.local_version + 1,
      sampleExistingNote.server_version! + 1, // This is new_server_version from Simperium, maps to DB server_version
      'Updated content',
      sampleExistingNote.tags, // Unchanged tags
      expect.any(Number),
      sampleExistingNote.created_at, // DB uses created_at
      0,
      0,
    ]);
    expect(result.server_version).toBe(sampleExistingNote.server_version! + 1);
    expect(result.modified_at).toEqual(expect.any(Number)); 
    expect(result.created_at).toEqual(sampleExistingNote.created_at); // Result uses created_at
  });

  it('should apply txt_patch to existing note content before saving', async () => {
    mockDbGet.mockReturnValueOnce(sampleExistingNote); 
    const params = SaveInputSchema.parse({
      id: sampleExistingNote.id,
      local_version: sampleExistingNote.local_version, 
      server_version: sampleExistingNote.server_version!,
      text_patch: [{ operation: 'mod', line_number: 1, value: 'Patched original content' }],
      text_patch: [{ operation: 'modification', line_number: 1, value: 'Patched original content' }],
    });

    const mockServerResponse: SimperiumSaveResponse = {
      id: sampleExistingNote.id,
      version: sampleExistingNote.server_version! + 1,
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
    expect(mockDbRun).toHaveBeenCalledWith([
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'Patched original content',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    ]);
  });

  it('should throw NotariumValidationError if local_version is missing for an update', async () => {
    const params = { id: placeholderValidUuid, text: 'some text' }; // Use text
    // Not using SaveInputSchema.parse here as it would throw before handleSave is called
    await expect(handleSave(params as any, mockDb)).rejects.toThrow(NotariumValidationError);
  });

  it('should throw NotariumResourceNotFoundError if note for update not found in DB', async () => {
    mockDbGet.mockReturnValueOnce(undefined); // Note not found
    const params = SaveInputSchema.parse({
      id: placeholderValidUuid,
      local_version: 1, // Use schema field name
      text: 'update text',
    });
    await expect(handleSave(params, mockDb)).rejects.toThrow(NotariumResourceNotFoundError);
  });

  it('should propagate NotariumBackendError on Simperium conflict', async () => {
    mockDbGet.mockReturnValueOnce(sampleExistingNote);
    const params = SaveInputSchema.parse({
      id: sampleExistingNote.id,
      local_version: sampleExistingNote.local_version, // Map DB local_version to schema local_version
      server_version: sampleExistingNote.server_version!,
      text: 'update text',
    });
    mockSimperiumSaveNote.mockRejectedValueOnce(
      new NotariumBackendError('Conflict', 'Conflict user msg', 412, 'conflict'),
    );
    await expect(handleSave(params, mockDb)).rejects.toThrow(NotariumBackendError);
  });

  // Add more tests: server_version from params vs db, tag updates, trash updates, error propagation
});
