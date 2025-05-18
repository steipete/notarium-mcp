Okay, this is the definitive, ultra-detailed "one-shot" specification for MCP Notarium, incorporating all our discussions, decisions, and aiming for maximum clarity for an implementing LLM. This document will be extensive.

## Technical Specification: MCP Notarium (Definitive Implementation Blueprint)

**Version:** 4.2 (Incorporates all recent refactoring)
**Date:** May 18, 2025

**Table of Contents:**
1.  Project Overview, Goals, and Philosophy
2.  Core Architecture & Component Responsibilities
3.  Project Definition & Deployment (npx, CLI, Node.js, ESM, npm)
4.  Environment Variables & Configuration Management
5.  Security: Credentials, API Keys (Database Encryption Removed)
6.  Local Cache Module: SQLite via `sql.js`
    *   6.1. Database File (Encryption Details Removed)
    *   6.2. SQLCipher Key Derivation Details (Marked N/A)
    *   6.3. Startup Checks (Integrity, Owner, Schema)
    *   6.4. SQLite PRAGMAs
    *   6.5. Table Schemas (`notes`, `notes_fts`, `sync_metadata`)
    *   6.6. FTS5 Setup and Triggers
7.  Backend API Client (Simperium)
    *   7.1. Authentication & Token Management
    *   7.2. Data Operations
    *   7.3. Timeout Handling
    *   7.4. Rate Limit Handling
8.  Backend Sync Service (Simperium)
    *   8.1. Role and Loop Mechanism
    *   8.2. Initial Full Synchronization
    *   8.3. Periodic Delta Synchronization
    *   8.4. Conflict Handling (External Changes)
    *   8.5. Hard Delete Detection (V1 Limitation)
    *   8.6. Retry & Backoff Strategy
    *   8.7. Metrics & Status Logging
9.  `zod` Schemas for Tool I/O Validation (Complete Definitions - Reflecting renames and batch operations)
10. MCP Tool Definitions (Service: MCP Notarium)
    *   10.1. General Tool Behavior (Validation, Sync Writes, Errors)
    *   10.2. Tool: `list_notes` (Detailed Logic - String trash_status, preview_lines, number_of_lines output)
    *   10.3. Tool: `get_notes` (Detailed Logic - Formerly get_note, handles single/multiple IDs)
    *   10.4. Tool: `save_notes` (Detailed Logic - Formerly save_note, handles array of notes)
    *   10.5. Tool: `manage_notes` (Detailed Logic for all actions - Output wrapped)
11. NPM Dependencies & Project Setup
12. Logging (`pino`)
13. Error Handling (`NotariumError` Hierarchy & MCP Mapping)
14. Performance Metrics Collection & Exposure
15. Internationalization & Time Handling
16. Concurrency Assumptions
17. Graceful Shutdown & Exit Codes
18. Design Decisions & Rationale (Addressing past Q&A)
19. Known Limitations (V1)
20. Future Considerations (Post-V1)

---

**1. Project Overview, Goals, and Philosophy**

*   **Name:** MCP Notarium
*   **Purpose:** MCP Notarium is a server application that acts as a bridge between Large Language Models (LLMs) and the Simplenote note-taking service. It exposes a set of tools compliant with the Model Context Protocol (MCP), enabling LLMs to read, write, search, and manage a user's Simplenote notes.
*   **Core Philosophy:**
    *   **User Control & Self-Hosting:** Designed to be run by individual users for their own Simplenote account, typically via `npx`.
    *   **Reliability over Speed for Writes:** Write operations (creating/modifying notes) are confirmed with the backend (Simperium) before success is reported to the LLM, ensuring data integrity.
    *   **Performance for Reads:** Utilizes a local SQLite cache to provide fast read access (listing, getting notes) for the LLM.
    *   **Security:** Prioritizes secure handling of user credentials and local data through optional database encryption.
    *   **Simplicity of Setup:** Configuration is primarily through environment variables, fitting common deployment patterns for tools run via `npx` or configured by a host application (e.g., Cloud Desktop).
    *   **Clear Error Reporting:** Provides structured and actionable error messages to the LLM client.
    *   **Extensibility (Future):** While initially targeting Simplenote, the architecture should allow for potential adaptation to other note-taking backends in the future by isolating backend-specific logic.
    *   **Portability:** Utilizes `sql.js` (SQLite compiled to WebAssembly) for the local cache, enhancing portability across environments where native Node.js addons might be problematic.

**2. Core Architecture & Component Responsibilities**

*   **Conceptual Diagram:**
    ```
    MCP Client (LLM Env, e.g., Cloud Desktop via stdio)
        |
        v
    +-------------------------------------------+
    | MCP Notarium Server (Node.js/TypeScript)  |
    | +---------------------------------------+ |
    | | MCP Server Core (Handles MCP Framing) | |
    | +---------------------------------------+ |
    |     | (Dispatch to Tool Handlers)         |
    |     v                                     |
    | +---------------------------------------+ |
    | | Tool Handlers (`list`,`get`,`save`,`manage`)| |  <-- Uses Zod for I/O validation
    | |  - Read from Local Cache              | |
    | |  - Write to Backend API (sync)        | |
    | |  - Update Local Cache on write success| |
    | +---------------------------------------+ |
    |     ^             | (DB Read/Write)     |
    |     | (API Calls) |                     |
    |     v             v                     |
    | +---------------------+ +---------------------+
    | | Backend API Client  | | Local Cache Module  |
    | | (Simperium HTTP/S)  | | (SQLite via sql.js) |
    | +---------------------+ +---------------------+
    |     ^                                     |
    |     | (Sync Operations)                   | (Updates Cache)
    |     v                                     |
    | +---------------------------------------+ |
    | | Backend Sync Service (Periodic Pull)  | |
    | +---------------------------------------+ |
    | +---------------------------------------+ |
    | | Configuration Module (Env Vars)       | |
    | +---------------------------------------+ |
    | +---------------------------------------+ |
    | | Logging Module (Pino)                 | |
    | +---------------------------------------+ |
    | +---------------------------------------+ |
    | | Error Handling Module                 | |
    | +---------------------------------------+ |
    +-------------------------------------------+
        ^
        | (HTTP/S to Simperium)
        v
    Simperium Backend (auth.simperium.com, api.simperium.com)
    ```
*   **Component Breakdown:**
    *   **MCP Server Core:** An external Node.js MCP framework/library chosen by the implementer. Responsible for `stdio` JSON-RPC 2.0 message parsing, routing `method` calls to registered tool handlers, and formatting/sending responses/errors.
    *   **Tool Handlers (`src/tools/`):** Modules for `list.ts`, `get.ts`, `save.ts`, `manage.ts`. Each exports an `async` function that takes validated parameters (after Zod parsing) and returns a result or throws a `NotariumError`.
    *   **Local Cache Module (`src/cache/sqlite.ts`):** Manages the `sql.js` (SQLite WASM) database instance. Executes SQL queries. Handles schema creation and startup checks (owner, schema version).
    *   **Backend API Client (`src/backend/simperium-api.ts`):** Handles all HTTP/S communication with Simperium. Manages authentication token, retries on 401/429, applies timeouts.
    *   **Backend Sync Service (`src/sync/sync-service.ts`):** Background async loop to pull external changes from Simperium and update the local cache. Manages `backend_cursor`.
    *   **Configuration (`src/config.ts`):** Loads and validates environment variables. Provides typed configuration values.
    *   **Logging (`src/logging.ts`):** Initializes and exports a configured `pino` logger instance.
    *   **Error Handling (`src/errors.ts`):** Defines `NotariumError` and its subclasses.

**3. Project Definition & Deployment**
(As per Version 3.2) - `npx mcp-notarium`, CLI flags (`--version`, `--help`, `--print-config-vars`), Node LTS, ESM, npm package, MIT License, `NOTICES.MD`.

**4. Environment Variables & Configuration Management**

*   MCP Notarium reads configuration from environment variables at startup. A `.env` file in the working directory can be used to set these variables (loaded using the `dotenv` package).
*   **Variables List:**
    *   `SIMPLENOTE_USERNAME` (**Required**)
    *   `SIMPLENOTE_PASSWORD` (**Required**)
    *   `SYNC_INTERVAL_SECONDS` (Optional, Default: `300`, Min: `60`)
    *   `API_TIMEOUT_SECONDS` (Optional, Default: `30`, Min: `5`)
    *   `LOG_LEVEL` (Optional, Default: `INFO`. Valid: `trace`, `debug`, `info`, `warn`, `error`, `fatal`)
    *   `LOG_FILE_PATH` (Optional. Default: undefined - no file logging)
*   The `--print-config-vars` CLI flag will list these, their purpose, and current effective values (masking secrets).
*   The `src/config.ts` module will be responsible for reading, parsing, validating (e.g., min/max for numbers), and providing these values. If required variables are missing, the server MUST log a CRITICAL error and EXIT 1.

**5. Security: Credentials, API Keys**

*   **Simplenote User Credentials (`SIMPLENOTE_USERNAME`, `SIMPLENOTE_PASSWORD`):** Provided via environment variables. Handled by `Backend API Client` for Simperium authentication. Must not be logged directly.
*   **Simperium Application Constants (Hard-coded in `BackendApiClient.ts`):**
    *   `SIMPERIUM_APP_ID = 'chalk-bump-f49'`
    *   `SIMPERIUM_API_KEY = 'e2f0978acfea407aa23fdf557478d3f2'`
*   **Salt for Owner Identity Hash (`OWNER_IDENTITY_SALT`):**
    *   A hard-coded, unique, long, random string constant within MCP Notarium. Used to derive a hash from `SIMPLENOTE_USERNAME` for the database filename, providing user-specific cache files.

**6. Local Cache Module: SQLite via `sql.js`**

*   **6.1. Database File**
    *   **Database Implementation:** Uses `sql.js`, which loads the SQLite database as a WebAssembly module. The database is primarily managed in memory during runtime.
    *   **Persistence:** The database is loaded from a file at startup and saved back to a file on graceful shutdown.
    *   **Filename:** Typically `notarium-cache-${ownerHash}.sqlite3`, where `${ownerHash}` is derived from `SIMPLENOTE_USERNAME`. Stored in a `.cache` directory within the project workspace or an OS-specific cache directory.
    *   **Encryption:** **NOT IMPLEMENTED.** The database file is stored unencrypted.
*   **NPM Packages:** Uses `sql.js`. Requires providing the `.wasm` file for `sql.js` (e.g., by packaging it in an `assets` directory).
*   **6.2. SQLCipher Key Derivation Details**
    *   **NOT APPLICABLE.**
*   **6.3. Startup Checks (Order is important):**
    *   1.  Load Env Vars.
    *   2.  Determine target DB file based on `owner_identity_hash`.
    *   3.  Locate and load `sql.js` WASM binary. If loading fails, CRITICAL EXIT.
    *   4.  Attempt to load DB from file into `sql.js` instance.
        *   If file doesn't exist (`ENOENT`): Log INFO, set `new_db_required = true`.
        *   On other load failures (e.g., corrupt file): Log INFO "DB corrupt?", delete DB file, set `new_db_required = true`.
    *   5.  **If DB loaded successfully and not `new_db_required`:**
        *   `db_schema_version = db.pragma('user_version', {simple: true});`. `CURRENT_APP_SCHEMA_VERSION = 1;`
        *   If `db_schema_version < CURRENT_APP_SCHEMA_VERSION` or (`db_schema_version == 0` and DB is not empty): Log INFO "Schema too old", delete DB file, set `new_db_required = true`.
        *   If `db_schema_version > CURRENT_APP_SCHEMA_VERSION`: Log INFO "Schema too new", delete DB file, set `new_db_required = true`.
*   **6.4. SQLite PRAGMAs (after successful open/keying):**
    *   `PRAGMA journal_mode=WAL;`
    *   `PRAGMA synchronous=NORMAL;`
    *   `PRAGMA foreign_keys=ON;`
*   **6.5. Table Schema Creation (if `new_db_required` or tables don't exist):**
    *   Create `notes`, `notes_fts` (with triggers), and `sync_metadata` tables.
    *   The `sync_metadata` table will store `backend_cursor` and other sync-related metrics.
    *   Set `PRAGMA user_version = ${CURRENT_APP_SCHEMA_VERSION};` after creating tables.
*   **6.6. FTS5 Tokenizer:** `porter unicode61 remove_diacritics 1`.

**6.5. Table Schemas (`notes`, `notes_fts`, `sync_metadata`)**
*   `notes` table:
    *   `id TEXT PRIMARY KEY NOT NULL`
    *   `text TEXT NOT NULL`
    *   `tags TEXT NOT NULL DEFAULT '[]'` (JSON string array)
    *   `created_at INTEGER NOT NULL` (Unix epoch seconds)
    *   `modified_at INTEGER NOT NULL` (Unix epoch seconds)
    *   `local_version INTEGER NOT NULL DEFAULT 1`
    *   `server_version INTEGER` (Optional, from Simperium)
    *   `trash INTEGER NOT NULL DEFAULT 0` (Boolean 0 or 1)
    *   `sync_deleted INTEGER NOT NULL DEFAULT 0`
*   `notes_fts` table: (FTS5 table for `text` and `tags` from `notes`)
    *   `text`
    *   `tags`

**7. Backend API Client (Simperium)**
(As per v3.2 - `axios`, hardcoded Simperium App ID/Key, handles token obtaining/caching and 401 re-auth, applies `API_TIMEOUT_SECONDS`, handles 429 with `Retry-After` or exponential backoff for specific request retries).

**8. Backend Sync Service (Simperium)**
(As per v3.2 - self-rescheduling `setTimeout` loop, initial full sync if `new_db_required` or no `backend_cursor`, periodic delta sync, server-wins conflict for external changes, updates `sync_metadata` with metrics, uses `API_TIMEOUT_SECONDS`, exponential backoff for *full sync cycle* failures).
*   **Initial Full Sync `PAGE_SIZE` for `/index` calls:** `100`.
*   **Delta Sync `PAGE_SIZE` for `/index?since=` calls:** `500`.

**9. `zod` Schemas for Tool I/O Validation**
(Schemas as fully defined in Version 3.2 specification, with **Note ID fields updated from `z.string().uuid()` to `z.string().min(1)`** to reflect that Simplenote IDs are not always UUIDs. `l_ver` becomes `local_version`, `s_ver` becomes `server_version`, `mod_at` becomes `modified_at`, `crt_at` becomes `created_at`, `rng_ln_s` becomes `range_line_start`, `rng_ln_c` becomes `range_line_count`.)

*   **`ListInputSchema`**:
    *   `query: z.string().optional()` (Default: no query)
    *   `tags: z.array(z.string()).optional()` (Default: no tag filter)
    *   `trash_status: z.enum(['active', 'trashed', 'any']).default('active')` (Filter by trash status. Default: `'active'`)
    *   `date_before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()` (Default: no date filter)
    *   `date_after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()` (Default: no date filter)
    *   `sort_by: z.enum(['modified_at', 'created_at']).optional()` (Default: `modified_at`)
    *   `sort_order: z.enum(['ASC', 'DESC']).optional()` (Default: `DESC`)
    *   `limit: z.number().int().min(1).max(100).default(20).optional()`
    *   `page: z.number().int().min(1).default(1).optional()`
    *   `preview_lines: z.number().int().min(1).max(20).default(3).optional()` (Number of leading lines in preview. Default: 3)

*   **`ListItemSchema`**:
    *   `type: z.literal('text')`
    *   `uuid: z.string().min(1)`
    *   `text: z.string().min(1)` (Preview text: `list_notes` uses `preview_lines` (default 3), `get_notes`/`save_notes` use up to 100 lines, `manage_notes` uses short JSON string.)
    *   `local_version: z.number().int()`
    *   `tags: NoteTagsSchema`
    *   `modified_at: UnixTimestampSchema`
    *   `trash: z.boolean()`
    *   `number_of_lines: z.number().int().optional()` (Total lines in the actual note)

*   **`GetNotesInputSchema`**:
    *   `id: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(20)]).transform(...)` (A single Note ID string or an array of 1-20 Note ID strings. Required.)
    *   `local_version: z.number().int().optional()` (Default: latest. Applies if `id` is a single string.)
    *   `range_line_start: z.number().int().min(1).optional()` (Default: 1. Applies if `id` is a single string.)
    *   `range_line_count: z.number().int().min(0).optional()` (Default: all lines from start. Applies if `id` is a single string.)

*   **`GetNotesOutputSchema`**:
    *   `content: z.array(ListItemSchema)`
    *   `total_items: z.number().int()`
    *   `current_page: z.number().int().default(1)`
    *   `total_pages: z.number().int().default(1)`

*   **`SingleSaveNoteObjectSchema`**:
    *   `id: z.string().min(1).optional()` (Default: new note created)
    *   `local_version: z.number().int().optional()` (Required if `id` is present)
    *   `server_version: z.number().int().optional()` (Optional. Default: not used for new notes, latest for updates if omitted)
    *   `text: z.string().optional()` (Required if `text_patch` not used)
    *   `text_patch: z.array(PatchOperationSchema).optional()` (Required if `text` not used)
    *   `tags: NoteTagsSchema.optional()` (Optional. Default: empty for new notes, existing preserved for updates if omitted)
    *   `trash: z.boolean().optional()` (Optional. Default: false)

*   **`SaveNotesInputSchema`**:
    *   `notes: z.array(SingleSaveNoteObjectSchema).min(1).max(20)` (Array of 1-20 note objects to save. Required.)

*   **`SaveNotesOutputSchema`**:
    *   `content: z.array(ListItemSchema)` (For successfully saved notes)
    *   `total_items: z.number().int()`
    *   `current_page: z.number().int().default(1)`
    *   `total_pages: z.number().int().default(1)`

*   **`PatchOperationSchema`**:
    *   `operation: z.enum(['addition', 'modification', 'deletion'])`
    *   `line_number: z.number().int().min(1)`
    *   `value: z.string().optional()` (Required for `addition`/`modification`)

*   **`ManageInputSchema`**:
    *   `action: z.enum(['trash', 'untrash', 'delete_permanently', 'get_stats', 'reset_cache'])`
    *   `id: z.string().min(1).optional()` (Optional, not used for `get_stats`/`reset_cache`)
    *   `local_version: z.number().int().optional()` (Optional, not used for `get_stats`/`reset_cache`)

*   **`ServerStatsSchema`**: (From `src/schemas.ts`, `db_encryption` removed)
    *   `mcp_notarium_version: z.string()`
    *   `node_version: z.string()`
    *   `memory_rss_mb: z.number()`
    *   `db_file_size_mb: z.number().optional()`
    *   `db_total_notes: z.number().int()`
    *   `db_last_sync_at: UnixTimestampSchema.nullable().optional()`
    *   `db_sync_duration_ms: z.number().int().optional()`
    *   `db_sync_status: z.string().optional()`
    *   `db_sync_error_count: z.number().int().optional()`
    *   `db_schema_version: z.number().int().optional()`
    *   `backend_cursor: z.string().nullable().optional()`

*   **`ManageNoteActionOutputSchema`**:
    *   `id: z.string().min(1)`
    *   `status: z.enum(['trashed', 'untrashed', 'deleted'])`
    *   `new_local_version: z.number().int().optional()`
    *   `new_server_version: z.number().int().optional()` (if applicable)

**10. MCP Tool Definitions (Service: MCP Notarium)**

*   **General Tool Behavior:**
    *   All tool handlers MUST be `async`.
    *   First step: Validate `params` object against the tool's Zod input schema. On failure, throw `NotariumValidationError` which gets converted to JSON-RPC error.
    *   Write operations (`save_notes`, `manage_notes` note actions) are **backend-first synchronous**.
    *   Backend API calls use `API_TIMEOUT_SECONDS`.
*   **10.1. Tool: `list_notes`**
    *   **Input**: `ListInputSchema`.
    *   **Server Logic (Detailed Summary):**
        *   Handles string `trash_status` (`'active'`, `'trashed'`, `'any'`) for SQL conditions. (Default: `'active'`)
        *   `preview_lines` input (Default: 3, Min: 1, Max: 20) controls number of lines in `ListItemSchema.text`.
        *   Calculates and includes `number_of_lines` (total lines of original note) in each `ListItemSchema`.
    *   **Output**: `ListOutputSchema`.
*   **10.2. Tool: `get_notes`**
    *   **Input**: `GetNotesInputSchema`. Accepts single `id` string or an array of up to 20 `id` strings.
    *   **Server Logic (Detailed Summary):**
        *   If multiple IDs, `local_version`, `range_line_start`, `range_line_count` are ignored. Latest version of each note is fetched.
        *   If single ID, `local_version`, `range_line_start`, `range_line_count` are respected.
        *   Includes forgiving FTS fallback if exact ID match fails (searches text field for the ID string).
        *   Preview text in output `ListItemSchema.text` defaults to 100 lines (if not ranged for a single ID request).
        *   Always includes `number_of_lines` (total lines of the original note) in each output `ListItemSchema`.
    *   **Output**: `GetNotesOutputSchema` (List-style wrapper).
*   **10.3. Tool: `save_notes`**
    *   **Input**: `SaveNotesInputSchema`. Expects `notes: [SingleSaveNoteObjectSchema, ...]`. Max 20 notes per call.
    *   **Server Logic (Detailed Summary):**
        *   Iterates through the `notes` array, processing each `SingleSaveNoteObjectSchema`.
        *   Includes forgiving FTS fallback for updates if exact ID/version match fails.
        *   Handles `text` OR `text_patch` for each note.
        *   Backend-first synchronous writes.
        *   If any individual save fails, it's logged; if ALL fail, a top-level error is thrown.
        *   Preview text in output `ListItemSchema.text` defaults to 100 lines.
        *   Includes `number_of_lines` (total lines of original note) in each successfully saved output `ListItemSchema`.
    *   **Output**: `SaveNotesOutputSchema` (List-style wrapper containing successfully saved notes).
*   **10.4. Tool: `manage_notes`**
    *   **Input**: `ManageInputSchema`.
    *   **Server Logic (Detailed Summary):**
        *   `get_stats`: `db_encryption` field removed from stats.
        *   All actions now return their results wrapped in the standard list-style output format (one item in `content`, where `text` is a short (max 200 char) JSON preview of the actual action result, and `number_of_lines` is 1).
    *   **Output**: List-style wrapper (see `GetNotesOutputSchema` for general structure, content varies by action).

**11. NPM Dependencies & Project Setup**

**12. Logging (`pino`)**

**13. Error Handling (`NotariumError` Hierarchy & MCP Mapping)**

**14. Performance Metrics Collection & Exposure**

**15. Internationalization & Time Handling**

**16. Concurrency Assumptions**

**17. Graceful Shutdown & Exit Codes**

**18. Design Decisions & Rationale (Addressing past Q&A)**

**19. Known Limitations (V1)**

*   Database file (`.sqlite3`) stored unencrypted due to `sql.js` usage.
*   Simperium API 404 errors on new note creation with client-generated UUIDs require external investigation (potential account/app config issue on Simperium's side).

**20. Future Considerations (Post-V1)**