import { z } from 'zod';

// --- Shared Schemas ---

// From Spec: "shared types like ListItemSchema, NoteDataSchema, ServerStatsSchema"

export const ISO8601DateTimeStringSchema = z.string().datetime({
  message: 'Invalid ISO8601 datetime string',
  offset: true,
});
// Unix epoch seconds (number)
export const UnixTimestampSchema = z.number().int().positive();

export const NoteTagSchema = z.string().min(1, 'Tag cannot be empty').max(100, 'Tag too long');
export const NoteTagsSchema = z.array(NoteTagSchema).max(100, 'Too many tags'); // Max 100 tags per note as a guess

export const ListItemSchema = z.object({
  type: z.literal('text').default('text'),
  uuid: z.string().min(1), // Maps to note ID
  text: z.string().min(1).max(80, 'Preview text must be 1-80 characters'),
  local_version: z.number().int(),
  tags: NoteTagsSchema,
  modified_at: UnixTimestampSchema,
  trash: z.boolean(),
});
export type ListItem = z.infer<typeof ListItemSchema>;

export const NoteDataSchema = z.object({
  id: z.string().min(1),
  local_version: z.number().int(), // Local cache version of the note
  server_version: z.number().int().optional(), // Server version of the note (from Simperium)
  text: z.string(),
  tags: NoteTagsSchema,
  modified_at: UnixTimestampSchema, // Last modified timestamp (epoch seconds)
  created_at: UnixTimestampSchema.optional(), // Created timestamp (epoch seconds), might not always be available
  trash: z.boolean(),
  // For 'get' tool with ranges:
  text_is_partial: z.boolean().optional(),
  text_total_lines: z.number().int().optional(),
  range_line_start: z.number().int().positive().optional(), // 1-indexed start line of returned range
  range_line_count: z.number().int().nonnegative().optional(), // count of lines in returned range
});
export type NoteData = z.infer<typeof NoteDataSchema>;

// --- Tool: list ---
// Spec 10.1. Tool `list`
export const ListInputSchema = z.object({
  query: z.string().optional(), // Full-text search query. Filters like `tag:`, `before:`, `after:` are extracted from this.
  tags: z.array(NoteTagSchema).optional(), // Filter by notes containing ALL of these tags. Applied in addition to tags from `query_string`.
  trash_status: z
    .union([
      z.literal(0), // Not in trash
      z.literal(1), // In trash
      z.literal(2), // Either (include trash)
    ])
    .default(0), // Default to not in trash. `0` for active, `1` for trashed, `2` for any.
  date_before: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format, use YYYY-MM-DD')
    .optional(), // Filter for notes modified before this UTC date. Applied in addition to `before:` from `query_string`.
  date_after: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format, use YYYY-MM-DD')
    .optional(), // Filter for notes modified after this UTC date. Applied in addition to `after:` from `query_string`.
  sort_by: z.enum(['modified_at', 'created_at']).optional(), // Field to sort by. Defaults to `modified_at`.
  sort_order: z.enum(['ASC', 'DESC']).optional(), // Sort order. Defaults to `DESC`.
  limit: z.number().int().min(1).max(100).default(20).optional(),
  page: z.number().int().min(1).default(1).optional(),
});
export type ListInput = z.infer<typeof ListInputSchema>;

export const ListOutputSchema = z.object({
  content: z.array(ListItemSchema),
  total_items: z.number().int(),
  current_page: z.number().int(),
  total_pages: z.number().int(),
  next_page: z.number().int().optional(),
});
export type ListOutput = z.infer<typeof ListOutputSchema>;

// --- Tool: get ---
// Spec 10.2. Tool `get`
export const GetInputSchema = z.object({
  id: z.string().min(1),
  local_version: z.number().int().optional(), // Optional: request specific local version
  range_line_start: z.number().int().min(1).optional(), // 1-indexed start line
  range_line_count: z.number().int().min(0).optional(), // Number of lines to retrieve from start line (0 means to end of note)
});
export type GetInput = z.infer<typeof GetInputSchema>;

export const GetOutputSchema = NoteDataSchema; // Output is the full note data
export type GetOutput = z.infer<typeof GetOutputSchema>;

// --- Tool: save ---
// Spec 10.3. Tool `save`

const PatchOperationObjectSchema = z.object({
  operation: z.enum(['addition', 'modification', 'deletion']),
  line_number: z.number().int().min(1), // 1-indexed line number
  value: z.string().optional(), // Required for 'addition' and 'modification', ignored for 'deletion'
});

export const PatchOperationSchema = PatchOperationObjectSchema.refine(
  (data: z.infer<typeof PatchOperationObjectSchema>) => {
    if ((data.operation === 'addition' || data.operation === 'modification') && typeof data.value !== 'string') {
      return false;
    } // value is required for addition/modification
    return true;
  },
  { message: "'value' is required for 'addition' and 'modification' operations" },
);

const SaveInputObjectSchema = z.object({
  id: z.string().min(1).optional(), // Changed from .uuid(). If undefined, create new note
  local_version: z.number().int().optional(), // Required if id is present (updating existing note)
  server_version: z.number().int().optional(), // Expected server version (for conflict detection on server side)
  text: z.string().optional(),
  text_patch: z.array(PatchOperationSchema).optional(),
  tags: NoteTagsSchema.optional(), // If provided, replaces all existing tags
  trash: z.boolean().optional(), // Set trash status
});

export const SaveInputSchema = SaveInputObjectSchema.refine(
  (data: z.infer<typeof SaveInputObjectSchema>) => !!data.text || !!data.text_patch,
  {
    message: "Either 'text' or 'text_patch' must be provided",
    path: ['text'],
  },
)
  .refine((data: z.infer<typeof SaveInputObjectSchema>) => !(data.text && data.text_patch), {
    message: "Cannot provide both 'text' and 'text_patch''",
    path: ['text'],
  })
  .refine(
    (data: z.infer<typeof SaveInputObjectSchema>) =>
      data.id ? typeof data.local_version === 'number' : true,
    {
      message: "'local_version' is required when 'id' is provided (updating an existing note)",
      path: ['local_version'],
    },
  );
export type SaveInput = z.infer<typeof SaveInputSchema>;

export const SaveOutputSchema = NoteDataSchema; // Returns the saved note data
export type SaveOutput = z.infer<typeof SaveOutputSchema>;

// --- Tool: manage ---
// Spec 10.4. Tool `manage`

export const ServerStatsSchema = z.object({
  mcp_notarium_version: z.string(),
  node_version: z.string(),
  memory_rss_mb: z.number(),
  db_encryption: z.enum(['enabled', 'disabled', 'unavailable']),
  db_file_size_mb: z.number().optional(),
  db_total_notes: z.number().int(),
  db_last_sync_at: UnixTimestampSchema.nullable().optional(), // Nullable if never synced
  db_sync_duration_ms: z.number().int().optional(),
  db_sync_status: z.string().optional(), // e.g., 'idle', 'syncing', 'error'
  db_sync_error_count: z.number().int().optional(),
  db_schema_version: z.number().int().optional(),
  backend_cursor: z.string().nullable().optional(),
});
export type ServerStats = z.infer<typeof ServerStatsSchema>;

export const ManageGetStatsActionSchema = z.object({ action: z.literal('get_stats') });
export const ManageResetCacheActionSchema = z.object({ action: z.literal('reset_cache') });

export const ManageNoteActionSchema = z.object({
  action: z.enum(['trash', 'untrash', 'delete_permanently']),
  id: z.string().min(1),
  local_version: z.number().int(), // Mandatory for note actions
});

export const ManageInputSchema = z.union([
  ManageGetStatsActionSchema,
  ManageResetCacheActionSchema,
  ManageNoteActionSchema,
]);
export type ManageInput = z.infer<typeof ManageInputSchema>;

export const ManageGetStatsOutputSchema = ServerStatsSchema;
export const ManageResetCacheOutputSchema = z.object({
  status: z.literal('success'),
  message: z.string(),
  full_resync_triggered: z.boolean(),
});
export const ManageNoteActionOutputSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['trashed', 'untrashed', 'deleted']),
  new_local_version: z.number().int().optional(), // if applicable, e.g. after a trash/untrash that Simperium confirms with new version
  new_server_version: z.number().int().optional(),
});

export const ManageOutputSchema = z.union([
  ManageGetStatsOutputSchema,
  ManageResetCacheOutputSchema,
  ManageNoteActionOutputSchema,
  // For actions that might not have a specific output beyond success/failure handled by error
  z.object({ status: z.literal('success'), message: z.string().optional() }),
]);
export type ManageOutput = z.infer<typeof ManageOutputSchema>;

// --- General MCP Schemas (Placeholder - depends on chosen MCP framework) ---

// This would define the overall structure of an MCP request and response
// if not handled by an external library directly.

// Example MCP Request (conceptual)
// export const McpRequestSchema = z.object({
//   jsonrpc: z.literal('2.0'),
//   id: z.union([z.string(), z.number(), z.null()]),
//   method: z.string(), // e.g., "mcp_notarium.list", "mcp_notarium.get"
//   params: z.any(), // This would be one of the Input Schemas above
//   context: z.object({ /* ... MCP context fields ... */ }).optional(),
// });

// Example MCP Error (conceptual)
// export const McpErrorObjectSchema = z.object({
//   code: z.number().int(),
//   message: z.string(),
//   data: z.record(z.any()).optional(), // This could hold a NotariumError.toDict() output
// });

// export const McpErrorResponseSchema = z.object({
//   jsonrpc: z.literal('2.0'),
//   id: z.union([z.string(), z.number(), z.null()]),
//   error: McpErrorObjectSchema,
// });

// export const McpSuccessResponseSchema = z.object({
//   jsonrpc: z.literal('2.0'),
//   id: z.union([z.string(), z.number(), z.null()]),
//   result: z.any(), // This would be one of the Output Schemas above
// });

// export const McpResponseSchema = z.union([
//   McpErrorResponseSchema,
//   McpSuccessResponseSchema,
// ]);

// console.log('MCP Notarium Zod schemas defined.'); // For build-time check. Removed as it can cause issues with linters/compilers in certain setups.
