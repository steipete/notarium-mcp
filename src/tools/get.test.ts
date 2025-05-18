import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleGet } from './get.js';
import { GetInputSchema, NoteDataSchema } from '../schemas.js';
import { NotariumResourceNotFoundError, NotariumDbError } from '../errors.js';
import type { Database as SqlJsDB, Statement } from 'sql.js';

vi.mock('../logging.js', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockStmtGet = vi.fn();
const mockDbPrepare = vi.fn(() => ({ get: mockStmtGet, free: vi.fn(), bind: vi.fn(), step: vi.fn(), getAsObject: vi.fn() }));
const mockDb = { prepare: mockDbPrepare } as unknown as SqlJsDB;

const sampleNoteId = 'a1b2c3d4-e5f6-7890-1234-567890abcdef';
const sampleNote = {
  id: sampleNoteId,
  local_version: 2,
  server_version: 5,
  text: 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5',
  tags: JSON.stringify(['sample', 'test']),
  modified_at: Math.floor(Date.now() / 1000),
  created_at: Math.floor(Date.now() / 1000) - 3600,
  trash: 0,
};

describe('handleGet Tool', () => {
  beforeEach(() => {
    mockStmtGet.mockReset();
    mockDbPrepare.mockClear();
  });

  it('should retrieve a note by ID if local_version is not specified', async () => {
    mockStmtGet.mockReturnValueOnce(sampleNote);
    const params = GetInputSchema.parse({ id: sampleNoteId });
    const result = await handleGet(params, mockDb);

    expect(mockDbPrepare).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY l_ver DESC LIMIT 1'),
    );
    expect(mockStmtGet).toHaveBeenCalledWith([sampleNoteId]);
    expect(result.id).toBe(sampleNoteId);
    expect(result.text).toBe(sampleNote.text);
    expect(result.local_version).toBe(sampleNote.local_version);
  });

  it('should retrieve a note by ID and local_version if specified', async () => {
    mockStmtGet.mockReturnValueOnce(sampleNote);
    const params = GetInputSchema.parse({ id: sampleNoteId, local_version: 2 });
    await handleGet(params, mockDb);

    expect(mockDbPrepare).toHaveBeenCalledWith(expect.stringContaining('AND l_ver = ?'));
    expect(mockStmtGet).toHaveBeenCalledWith([sampleNoteId, 2]);
  });

  it('should throw NotariumResourceNotFoundError if note is not found', async () => {
    mockStmtGet.mockReturnValueOnce(undefined);
    const params = GetInputSchema.parse({ id: '123e4567-e89b-12d3-a456-426614174000' });
    await expect(handleGet(params, mockDb)).rejects.toThrow(NotariumResourceNotFoundError);
  });

  it('should throw NotariumResourceNotFoundError if specific local_version is not found', async () => {
    mockStmtGet.mockReturnValueOnce(undefined);
    const params = GetInputSchema.parse({ id: sampleNoteId, local_version: 99 });
    await expect(handleGet(params, mockDb)).rejects.toThrow(NotariumResourceNotFoundError);
  });

  it('should throw NotariumDbError on database error', async () => {
    mockStmtGet.mockImplementationOnce(() => {
      throw new Error('DB query failed');
    });
    const params = GetInputSchema.parse({ id: sampleNoteId });
    await expect(handleGet(params, mockDb)).rejects.toThrow(NotariumDbError);
  });

  describe('Line Ranging', () => {
    it('should return full text if no range is specified', async () => {
      mockStmtGet.mockReturnValueOnce(sampleNote);
      const params = GetInputSchema.parse({ id: sampleNoteId });
      const result = await handleGet(params, mockDb);
      expect(result.text).toBe(sampleNote.text);
      expect(result.text_is_partial).toBe(false);
      expect(result.text_total_lines).toBe(5);
      expect(result.range_line_start).toBeUndefined();
      expect(result.range_line_count).toBeUndefined();
    });

    it('should return specified line range (range_line_start, range_line_count)', async () => {
      mockStmtGet.mockReturnValueOnce(sampleNote);
      const params = GetInputSchema.parse({ id: sampleNoteId, range_line_start: 2, range_line_count: 2 });
      const result = await handleGet(params, mockDb);
      expect(result.text).toBe('Line 2\nLine 3');
      expect(result.text_is_partial).toBe(true);
      expect(result.text_total_lines).toBe(5);
      expect(result.range_line_start).toBe(2);
      expect(result.range_line_count).toBe(2);
    });

    it('should handle range count (range_line_count = 0) meaning to end of note', async () => {
      mockStmtGet.mockReturnValueOnce(sampleNote);
      const params = GetInputSchema.parse({ id: sampleNoteId, range_line_start: 3, range_line_count: 0 });
      const result = await handleGet(params, mockDb);
      expect(result.text).toBe('Line 3\nLine 4\nLine 5');
      expect(result.text_is_partial).toBe(true);
      expect(result.text_total_lines).toBe(5);
      expect(result.range_line_start).toBe(3);
      expect(result.range_line_count).toBe(3);
    });

    it('should handle range count exceeding available lines (clips to end)', async () => {
      mockStmtGet.mockReturnValueOnce(sampleNote);
      const params = GetInputSchema.parse({ id: sampleNoteId, range_line_start: 4, range_line_count: 5 });
      const result = await handleGet(params, mockDb);
      expect(result.text).toBe('Line 4\nLine 5');
      expect(result.text_is_partial).toBe(true);
      expect(result.range_line_count).toBe(2);
    });

    it('should handle range start out of bounds (returns empty text)', async () => {
      mockStmtGet.mockReturnValueOnce(sampleNote);
      const params = GetInputSchema.parse({ id: sampleNoteId, range_line_start: 10, range_line_count: 2 });
      const result = await handleGet(params, mockDb);
      expect(result.text).toBe('');
      expect(result.text_is_partial).toBe(true);
      expect(result.range_line_start).toBe(10);
      expect(result.range_line_count).toBe(0);
    });

    it('should be rejected by schema for range start <= 0', () => {
      expect(() => GetInputSchema.parse({ id: sampleNoteId, local_version: 1, range_line_start: 0, range_line_count: 2 })).toThrow();
      expect(() => GetInputSchema.parse({ id: sampleNoteId, local_version: 1, range_line_start: -1, range_line_count: 2 })).toThrow();
    });

    it('should handle ranging on an empty note', async () => {
      const emptyNote = { ...sampleNote, text: '' };
      mockStmtGet.mockReturnValueOnce(emptyNote);
      const params = GetInputSchema.parse({ id: sampleNoteId, range_line_start: 1, range_line_count: 1 });
      const result = await handleGet(params, mockDb);
      expect(result.text).toBe('');
      expect(result.text_is_partial).toBe(true);
      expect(result.text_total_lines).toBe(1);
      expect(result.range_line_start).toBe(1);
      expect(result.range_line_count).toBe(1);
    });

    it('should handle ranging on a single line note', async () => {
      const singleLineNote = { ...sampleNote, text: 'Single line content' };
      mockStmtGet.mockReturnValueOnce(singleLineNote);
      const params = GetInputSchema.parse({ id: sampleNoteId, range_line_start: 1, range_line_count: 1 });
      const result = await handleGet(params, mockDb);
      expect(result.text).toBe('Single line content');
      expect(result.text_is_partial).toBe(true);
      expect(result.text_total_lines).toBe(1);
      expect(result.range_line_start).toBe(1);
      expect(result.range_line_count).toBe(1);
    });
  });

  it('should correctly parse all fields into NoteDataSchema', async () => {
    mockStmtGet.mockReturnValueOnce(sampleNote);
    const params = GetInputSchema.parse({ id: sampleNoteId });
    const result = await handleGet(params, mockDb);
    expect(() => NoteDataSchema.parse(result)).not.toThrow();
    expect(result.tags).toEqual(JSON.parse(sampleNote.tags));
    expect(result.trash).toBe(false);
    expect(result.server_version).toBe(sampleNote.server_version);
    expect(result.modified_at).toBe(sampleNote.modified_at);
    expect(result.created_at).toBe(sampleNote.created_at);
  });
});
