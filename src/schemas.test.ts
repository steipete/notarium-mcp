import { describe, it, expect } from 'vitest';
import {
  ISO8601DateTimeStringSchema,
  UnixTimestampSchema,
  NoteTagSchema,
  NoteTagsSchema,
  ListItemSchema,
  NoteDataSchema,
  ListInputSchema,
  SaveInputSchema,
  PatchOperationSchema,
  ManageInputSchema,
  ServerStatsSchema,
} from './schemas.js'; // Adjust path as necessary

describe('Shared Zod Schemas', () => {
  describe('ISO8601DateTimeStringSchema', () => {
    it('should validate correct ISO8601 datetime strings', () => {
      expect(() => ISO8601DateTimeStringSchema.parse('2023-10-26T10:00:00Z')).not.toThrow();
      expect(() => ISO8601DateTimeStringSchema.parse('2023-10-26T10:00:00.123Z')).not.toThrow();
      expect(() => ISO8601DateTimeStringSchema.parse('2023-10-26T10:00:00+05:30')).not.toThrow();
      expect(() => ISO8601DateTimeStringSchema.parse('2023-10-26T10:00:00-00:00')).not.toThrow();
    });
    it('should invalidate incorrect datetime strings', () => {
      expect(() => ISO8601DateTimeStringSchema.parse('2023-10-26')).toThrow();
      expect(() => ISO8601DateTimeStringSchema.parse('not-a-date')).toThrow();
    });
  });

  describe('UnixTimestampSchema', () => {
    it('should validate positive integer timestamps', () => {
      expect(() => UnixTimestampSchema.parse(1666778400)).not.toThrow();
    });
    it('should invalidate non-positive or non-integer timestamps', () => {
      expect(() => UnixTimestampSchema.parse(0)).toThrow();
      expect(() => UnixTimestampSchema.parse(-100)).toThrow();
      expect(() => UnixTimestampSchema.parse(1666778400.5)).toThrow();
      expect(() => UnixTimestampSchema.parse('1666778400')).toThrow(); // Should be number
    });
  });

  describe('NoteTagSchema', () => {
    it('should validate valid tags', () => {
      expect(() => NoteTagSchema.parse('work')).not.toThrow();
      expect(() =>
        NoteTagSchema.parse(
          'very-long-tag-but-within-limits-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        ),
      ).not.toThrow(); // Approx 100 chars
    });
    it('should invalidate empty or too long tags', () => {
      expect(() => NoteTagSchema.parse('')).toThrow();
      expect(() => NoteTagSchema.parse('a'.repeat(101))).toThrow();
    });
  });

  describe('NoteTagsSchema', () => {
    it('should validate an array of valid tags', () => {
      expect(() => NoteTagsSchema.parse(['work', 'project'])).not.toThrow();
      expect(() => NoteTagsSchema.parse([])).not.toThrow(); // Empty array is valid
    });
    it('should invalidate if array contains invalid tags or too many tags', () => {
      expect(() => NoteTagsSchema.parse(['work', ''])).toThrow(); // Contains empty tag
      const tooManyTags = Array(101).fill('tag');
      expect(() => NoteTagsSchema.parse(tooManyTags)).toThrow();
    });
  });
});

describe('ListItemSchema', () => {
  it('should validate a correct ListItem object', () => {
    const listItem = {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      l_ver: 1,
      title_prev: 'Test Note Title',
      tags: ['test', 'example'],
      mod_at: Date.now(), // Should be epoch seconds, so Date.now()/1000
      trash: false,
    };
    // Correcting mod_at for the schema
    listItem.mod_at = Math.floor(Date.now() / 1000);
    expect(() => ListItemSchema.parse(listItem)).not.toThrow();
  });

  it('should invalidate if required fields are missing or incorrect type', () => {
    expect(() =>
      ListItemSchema.parse({
        id: 'uuid',
        l_ver: 1,
        title_prev: 'title' /* missing tags, mod_at, trash */,
      }),
    ).toThrow();
    expect(() =>
      ListItemSchema.parse({
        id: 'not-a-uuid',
        l_ver: 1,
        title_prev: 'title',
        tags: [],
        mod_at: 123,
        trash: false,
      }),
    ).toThrow(); // Invalid UUID
  });
});

describe('SaveInputSchema', () => {
  it('should validate with txt', () => {
    const data = { txt: 'hello' };
    expect(() => SaveInputSchema.parse(data)).not.toThrow();
  });
  it('should validate with txt_patch', () => {
    const data = { txt_patch: [{ operation: 'addition', line_number: 1, value: 'hello' }] };
    expect(() => SaveInputSchema.parse(data)).not.toThrow();
  });
  it('should invalidate if both txt and txt_patch are provided', () => {
    const data = { txt: 'hello', txt_patch: [{ operation: 'addition', line_number: 1, value: 'world' }] };
    expect(() => SaveInputSchema.parse(data)).toThrow();
  });
  it('should invalidate if neither txt nor txt_patch is provided', () => {
    const data = { tags: ['test'] };
    expect(() => SaveInputSchema.parse(data)).toThrow();
  });
  it('should require l_ver if id is provided', () => {
    const data = { id: 'uuid', txt: 'hello' }; // Missing l_ver
    expect(() => SaveInputSchema.parse(data)).toThrow();
  });
  it('should allow no l_ver if id is not provided (new note)', () => {
    const data = { txt: 'new note' };
    expect(() => SaveInputSchema.parse(data)).not.toThrow();
  });
  it('should validate a full valid save input for new note', () => {
    const data = {
      txt: 'This is the content of the new note.',
      tags: ['new', 'draft'],
      trash: false,
    };
    expect(() => SaveInputSchema.parse(data)).not.toThrow();
  });
  it('should validate a full valid save input for existing note', () => {
    const data = {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      l_ver: 5,
      s_ver: 10,
      txt_patch: [{ operation: 'modification', line_number: 1, value: 'Updated first line.' }],
      tags: ['updated', 'final'],
      trash: false,
    };
    expect(() => SaveInputSchema.parse(data)).not.toThrow();
  });
  it('should parse valid SaveInput (new note with text)', () => {
    const input = { text: 'New note content' };
    expect(() => SaveInputSchema.parse(input)).not.toThrow();
  });
  it('should parse valid SaveInput (new note with patch)', () => {
    const input = {
      text_patch: [{ operation: 'addition', line_number: 1, value: 'hello' }],
    };
    expect(() => SaveInputSchema.parse(input)).not.toThrow();
  });
  it('should fail if both text and text_patch are provided', () => {
    const input = {
      text: 'hello',
      text_patch: [{ operation: 'addition', line_number: 1, value: 'world' }],
    };
    expect(() => SaveInputSchema.parse(input)).toThrow();
  });
  it('should validate a full valid save input for existing note with text_patch', () => {
    const input = {
      id: 'some-uuid',
      // local_version is required for updates
      local_version: 1,
      text_patch: [{ operation: 'modification', line_number: 1, value: 'new content' }],
    };
    expect(() => SaveInputSchema.parse(input)).not.toThrow();
  });
});

describe('NoteDataSchema', () => {
  const baseValidNoteData = {
    id: 'a1b2c3d4-e5f6-7890-1234-567890abcdef',
    l_ver: 1,
    s_ver: 1,
    txt: 'Note content here.',
    tags: ['sample', 'test'],
    mod_at: Math.floor(Date.now() / 1000),
    crt_at: Math.floor(Date.now() / 1000) - 3600,
    trash: false,
  };

  it('should validate a correct NoteData object', () => {
    expect(() => NoteDataSchema.parse(baseValidNoteData)).not.toThrow();
  });

  it('should allow optional s_ver and crt_at', () => {
    const data = { ...baseValidNoteData };
    delete (data as any).s_ver;
    delete (data as any).crt_at;
    expect(() => NoteDataSchema.parse(data)).not.toThrow();
  });

  it('should validate partial text fields correctly', () => {
    const partialData = {
      ...baseValidNoteData,
      txt_partial: true,
      txt_tot_ln: 100,
      rng_ln_s: 10,
      rng_ln_c: 20,
    };
    expect(() => NoteDataSchema.parse(partialData)).not.toThrow();
  });

  it('should invalidate if required fields are missing (e.g., txt)', () => {
    const data = { ...baseValidNoteData };
    delete (data as any).txt;
    expect(() => NoteDataSchema.parse(data)).toThrow();
  });

  it('should invalidate on incorrect types (e.g., mod_at as string)', () => {
    const data = { ...baseValidNoteData, mod_at: 'not-a-timestamp' };
    expect(() => NoteDataSchema.parse(data)).toThrow();
  });
});

describe('ListInputSchema', () => {
  it('should validate a minimal valid ListInput (empty query)', () => {
    expect(() => ListInputSchema.parse({})).not.toThrow(); // All fields optional with defaults
  });

  it('should validate with all valid fields provided', () => {
    const validInput = {
      q: 'search query tag:urgent before:2023-01-01 after:2022-01-01',
      tags: ['work', 'important'],
      limit: 50,
      page: 2,
      trash_status: 1,
      date_before: '2023-12-31',
      date_after: '2023-01-01',
    };
    expect(() => ListInputSchema.parse(validInput)).not.toThrow();
  });

  it('should apply default values for limit and page', () => {
    const parsed = ListInputSchema.parse({});
    expect(parsed.limit).toBe(20);
    expect(parsed.page).toBe(1);
    expect(parsed.trash_status).toBe(0);
    expect(parsed.date_before).toBeUndefined();
    expect(parsed.date_after).toBeUndefined();
  });

  it('should invalidate incorrect limit or page types/values', () => {
    expect(() => ListInputSchema.parse({ limit: 0 })).toThrow(); // Min 1
    expect(() => ListInputSchema.parse({ limit: 101 })).toThrow(); // Max 100
    expect(() => ListInputSchema.parse({ page: 0 })).toThrow(); // Min 1
    expect(() => ListInputSchema.parse({ limit: 'not-a-number' })).toThrow();
  });

  it('should invalidate incorrect trash_status values', () => {
    expect(() => ListInputSchema.parse({ trash_status: 3 })).toThrow();
    expect(() => ListInputSchema.parse({ trash_status: '0' })).toThrow();
  });

  it('should invalidate incorrect date formats for date_before/date_after', () => {
    expect(() => ListInputSchema.parse({ date_before: '2023/12/31' })).toThrow();
    expect(() => ListInputSchema.parse({ date_after: '31-12-2023' })).toThrow();
    expect(() => ListInputSchema.parse({ date_before: 'not-a-date' })).toThrow();
  });

  it('should parse valid ListInput with all fields', () => {
    const input = {
      q: 'search text',
      tags: ['tag1', 'tag2'],
      limit: 10,
      page: 2,
      trash_status: 1,
      date_before: '2023-01-01',
      date_after: '2022-01-01',
    };
    const parsed = ListInputSchema.parse(input);
    // Note: The default values are applied if the fields are NOT in the input object.
    // If they are in the input object (like limit:10, page:2), those values are used.
    // The previous expectation that parsed.limit would be 20 was incorrect for this specific test case.
    expect(parsed.q).toBe('search text');
    expect(parsed.tags).toEqual(['tag1', 'tag2']);
    expect(parsed.limit).toBe(10);
    expect(parsed.page).toBe(2);
    expect(parsed.trash_status).toBe(1);
    expect(parsed.date_before).toBe('2023-01-01');
    expect(parsed.date_after).toBe('2022-01-01');

    // Test default tag behavior
    expect(ListInputSchema.parse({ q: 'test' }).tags).toBeUndefined();
  });
});

describe('ManageInputSchema', () => {
  it('should validate get_stats action', () => {
    const data = { action: 'get_stats' };
    expect(() => ManageInputSchema.parse(data)).not.toThrow();
  });

  it('should validate reset_cache action', () => {
    const data = { action: 'reset_cache' };
    expect(() => ManageInputSchema.parse(data)).not.toThrow();
  });

  it('should validate trash note action', () => {
    const data = {
      action: 'trash',
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      local_version: 1,
    };
    expect(() => ManageInputSchema.parse(data)).not.toThrow();
  });

  it('should validate untrash note action', () => {
    const data = {
      action: 'untrash',
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      local_version: 2,
    };
    expect(() => ManageInputSchema.parse(data)).not.toThrow();
  });

  it('should validate delete_permanently note action', () => {
    const data = {
      action: 'delete_permanently',
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      local_version: 3,
    };
    expect(() => ManageInputSchema.parse(data)).not.toThrow();
  });

  it('should invalidate note action if id is missing', () => {
    const data = { action: 'trash', local_version: 1 }; // Missing id
    expect(() => ManageInputSchema.parse(data)).toThrow();
  });

  it('should invalidate note action if local_version is missing', () => {
    const data = { action: 'trash', id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' }; // Missing local_version
    expect(() => ManageInputSchema.parse(data)).toThrow();
  });

  it('should invalidate an unknown action', () => {
    const data = { action: 'unknown_action' };
    expect(() => ManageInputSchema.parse(data)).toThrow();
  });
});

describe('ServerStatsSchema', () => {
  const validServerStats = {
    mcp_notarium_version: '1.0.0',
    node_version: 'v18.17.0',
    memory_rss_mb: 123.45,
    db_encryption: 'enabled',
    db_file_size_mb: 10.5,
    db_total_notes: 100,
    db_last_sync_at: Math.floor(Date.now() / 1000),
    db_sync_duration_ms: 5000,
    db_sync_status: 'idle (success)',
    db_sync_error_count: 0,
    db_schema_version: 1,
    backend_cursor: 'some-cursor-string',
  };

  it('should validate a correct ServerStats object', () => {
    expect(() => ServerStatsSchema.parse(validServerStats)).not.toThrow();
  });

  it('should allow optional fields to be missing and db_last_sync_at to be null', () => {
    const data = {
       mcp_notarium_version: '1.0.0',
       node_version: 'v18.0.0',
       memory_rss_mb: 100,
       db_encryption: 'disabled',
       db_total_notes: 50,
       db_last_sync_at: null,
    };
    expect(() => ServerStatsSchema.parse(data)).not.toThrow();
    const parsed = ServerStatsSchema.parse(data);
    expect(parsed.db_last_sync_at).toBeNull();
  });

  it('should invalidate if required fields are missing (e.g., mcp_notarium_version)', () => {
    const data = { ...validServerStats };
    delete (data as any).mcp_notarium_version;
    expect(() => ServerStatsSchema.parse(data)).toThrow();
  });

  it('should invalidate on incorrect type for db_encryption', () => {
    const data = { ...validServerStats, db_encryption: 'maybe' };
    expect(() => ServerStatsSchema.parse(data)).toThrow();
  });

  it('should invalidate on incorrect type for memory_rss_mb (e.g., string)', () => {
    const data = { ...validServerStats, memory_rss_mb: '100MB' };
    expect(() => ServerStatsSchema.parse(data)).toThrow();
  });
});

// End of src/schemas.test.ts
