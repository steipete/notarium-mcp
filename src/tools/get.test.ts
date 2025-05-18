import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleGet } from './get.js';
import { GetInputSchema, NoteDataSchema } from '../schemas.js';
import { NotariumResourceNotFoundError, NotariumDbError } from '../errors.js';
import type { Database as DB } from 'better-sqlite3';

vi.mock('../logging.js', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockDbGet = vi.fn();
const mockDbPrepare = vi.fn(() => ({ get: mockDbGet }));
const mockDb = { prepare: mockDbPrepare } as unknown as DB;

const sampleNoteId = 'a1b2c3d4-e5f6-7890-1234-567890abcdef';
const sampleNote = {
  id: sampleNoteId,
  l_ver: 2,
  s_ver: 5,
  txt: 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5',
  tags: JSON.stringify(['sample', 'test']),
  mod_at: Math.floor(Date.now() / 1000),
  crt_at: Math.floor(Date.now() / 1000) - 3600,
  trash: 0,
};

describe('handleGet Tool', () => {
  beforeEach(() => {
    mockDbGet.mockReset();
    mockDbPrepare.mockClear();
  });

  it('should retrieve a note by ID if l_ver is not specified', async () => {
    mockDbGet.mockReturnValueOnce(sampleNote);
    const params = GetInputSchema.parse({ id: sampleNoteId });
    const result = await handleGet(params, mockDb);

    expect(mockDbPrepare).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY l_ver DESC LIMIT 1'),
    );
    expect(mockDbGet).toHaveBeenCalledWith(sampleNoteId);
    expect(result.id).toBe(sampleNoteId);
    expect(result.txt).toBe(sampleNote.txt);
    expect(result.l_ver).toBe(sampleNote.l_ver);
  });

  it('should retrieve a note by ID and l_ver if specified', async () => {
    mockDbGet.mockReturnValueOnce(sampleNote);
    const params = GetInputSchema.parse({ id: sampleNoteId, l_ver: 2 });
    await handleGet(params, mockDb);

    expect(mockDbPrepare).toHaveBeenCalledWith(expect.stringContaining('AND l_ver = ?'));
    expect(mockDbGet).toHaveBeenCalledWith(sampleNoteId, 2);
  });

  it('should throw NotariumResourceNotFoundError if note is not found', async () => {
    mockDbGet.mockReturnValueOnce(undefined);
    const params = GetInputSchema.parse({ id: '123e4567-e89b-12d3-a456-426614174000' });
    await expect(handleGet(params, mockDb)).rejects.toThrow(NotariumResourceNotFoundError);
  });

  it('should throw NotariumResourceNotFoundError if specific l_ver is not found', async () => {
    mockDbGet.mockReturnValueOnce(undefined);
    const params = GetInputSchema.parse({ id: sampleNoteId, l_ver: 99 });
    await expect(handleGet(params, mockDb)).rejects.toThrow(NotariumResourceNotFoundError);
  });

  it('should throw NotariumDbError on database error', async () => {
    mockDbGet.mockImplementationOnce(() => {
      throw new Error('DB query failed');
    });
    const params = GetInputSchema.parse({ id: sampleNoteId });
    await expect(handleGet(params, mockDb)).rejects.toThrow(NotariumDbError);
  });

  describe('Line Ranging', () => {
    it('should return full text if no range is specified', async () => {
      mockDbGet.mockReturnValueOnce(sampleNote);
      const params = GetInputSchema.parse({ id: sampleNoteId });
      const result = await handleGet(params, mockDb);
      expect(result.txt).toBe(sampleNote.txt);
      expect(result.txt_partial).toBe(false);
      expect(result.txt_tot_ln).toBe(5);
    });

    it('should return specified line range (rng_ln_s, rng_ln_c)', async () => {
      mockDbGet.mockReturnValueOnce(sampleNote);
      const params = GetInputSchema.parse({ id: sampleNoteId, rng_ln_s: 2, rng_ln_c: 2 });
      const result = await handleGet(params, mockDb);
      expect(result.txt).toBe('Line 2\nLine 3');
      expect(result.txt_partial).toBe(true);
      expect(result.txt_tot_ln).toBe(5);
      expect(result.rng_ln_s).toBe(2);
      expect(result.rng_ln_c).toBe(2);
    });

    it('should handle range count (rng_ln_c = 0) meaning to end of note', async () => {
      mockDbGet.mockReturnValueOnce(sampleNote);
      const params = GetInputSchema.parse({ id: sampleNoteId, rng_ln_s: 3, rng_ln_c: 0 });
      const result = await handleGet(params, mockDb);
      expect(result.txt).toBe('Line 3\nLine 4\nLine 5');
      expect(result.txt_partial).toBe(true);
      expect(result.txt_tot_ln).toBe(5);
      expect(result.rng_ln_s).toBe(3);
      expect(result.rng_ln_c).toBe(3); // 3 lines returned (3, 4, 5)
    });

    it('should handle range count exceeding available lines (clips to end)', async () => {
      mockDbGet.mockReturnValueOnce(sampleNote);
      const params = GetInputSchema.parse({ id: sampleNoteId, rng_ln_s: 4, rng_ln_c: 5 });
      const result = await handleGet(params, mockDb);
      expect(result.txt).toBe('Line 4\nLine 5');
      expect(result.txt_partial).toBe(true);
      expect(result.rng_ln_c).toBe(2); // Only 2 lines actually returned
    });

    it('should handle range start out of bounds (returns empty text)', async () => {
      mockDbGet.mockReturnValueOnce(sampleNote);
      const params = GetInputSchema.parse({ id: sampleNoteId, rng_ln_s: 10, rng_ln_c: 2 });
      const result = await handleGet(params, mockDb);
      expect(result.txt).toBe('');
      expect(result.txt_partial).toBe(true);
      expect(result.rng_ln_s).toBe(10);
      expect(result.rng_ln_c).toBe(0);
    });

    it('should be rejected by schema for range start <= 0', () => {
      expect(() => GetInputSchema.parse({ id: sampleNoteId, rng_ln_s: 0, rng_ln_c: 2 })).toThrow();
      expect(() => GetInputSchema.parse({ id: sampleNoteId, rng_ln_s: -1, rng_ln_c: 2 })).toThrow();
    });

    it('should handle ranging on an empty note', async () => {
      const emptyNote = { ...sampleNote, txt: '' };
      mockDbGet.mockReturnValueOnce(emptyNote);
      const params = GetInputSchema.parse({ id: sampleNoteId, rng_ln_s: 1, rng_ln_c: 1 });
      const result = await handleGet(params, mockDb);
      expect(result.txt).toBe('');
      expect(result.txt_partial).toBe(true);
      expect(result.txt_tot_ln).toBe(1);
      expect(result.rng_ln_s).toBe(1);
      expect(result.rng_ln_c).toBe(1);
    });

    it('should handle ranging on a single line note', async () => {
      const singleLineNote = { ...sampleNote, txt: 'Single line content' };
      mockDbGet.mockReturnValueOnce(singleLineNote);
      const params = GetInputSchema.parse({ id: sampleNoteId, rng_ln_s: 1, rng_ln_c: 1 });
      const result = await handleGet(params, mockDb);
      expect(result.txt).toBe('Single line content');
      expect(result.txt_partial).toBe(true);
      expect(result.txt_tot_ln).toBe(1);
      expect(result.rng_ln_s).toBe(1);
      expect(result.rng_ln_c).toBe(1);
    });
  });

  it('should correctly parse all fields into NoteDataSchema', async () => {
    mockDbGet.mockReturnValueOnce(sampleNote);
    const params = GetInputSchema.parse({ id: sampleNoteId });
    const result = await handleGet(params, mockDb);
    expect(() => NoteDataSchema.parse(result)).not.toThrow();
    expect(result.tags).toEqual(JSON.parse(sampleNote.tags));
    expect(result.trash).toBe(false);
    expect(result.s_ver).toBe(sampleNote.s_ver);
  });
});
