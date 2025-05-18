Okay, this is the definitive, ultra-detailed "one-shot" specification for MCP Notarium, incorporating all our discussions, decisions, and aiming for maximum clarity for an implementing LLM. This document will be extensive.

## Technical Specification: MCP Notarium (Definitive Implementation Blueprint)

**Version:** 4.0 (Ultra-Detailed, Final for Implementation)
**Date:** May 17, 2025

**Table of Contents:**
1.  Project Overview, Goals, and Philosophy
2.  Core Architecture & Component Responsibilities
3.  Project Definition & Deployment (npx, CLI, Node.js, ESM, npm)
4.  Environment Variables & Configuration Management
5.  Security: Credentials, Database Encryption, API Keys
6.  Local Cache Module: SQLite with Optional SQLCipher
    *   6.1. Database File & Encryption Mode
    *   6.2. SQLCipher Key Derivation Details
    *   6.3. Startup Checks (Integrity, Encryption, Owner, Schema)
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
9.  `zod` Schemas for Tool I/O Validation (Complete Definitions)
10. MCP Tool Definitions (Service: MCP Notarium)
    *   10.1. General Tool Behavior (Validation, Sync Writes, Errors)
    *   10.2. Tool: `list` (Detailed Logic)
    *   10.3. Tool: `get` (Detailed Logic)
    *   10.4. Tool: `save` (Detailed Logic, including `text_patch`)
    *   10.5. Tool: `manage` (Detailed Logic for all actions)
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
*   **Variables List (from Version 3.2):**
    *   `SIMPLENOTE_USERNAME` (**Required**)
    *   `SIMPLENOTE_PASSWORD` (**Required**)
    *   `DB_ENCRYPTION_KEY` (**Currently NOT USED** with `sql.js` implementation. Default: undefined. Originally for SQLCipher.)
    *   `DB_ENCRYPTION_KDF_ITERATIONS` (**Currently NOT USED**. Optional, Default: `310000`. Originally for SQLCipher.)
    *   `SYNC_INTERVAL_SECONDS` (Optional, Default: `300`, Min: `60`)
    *   `API_TIMEOUT_SECONDS` (Optional, Default: `30`, Min: `5`)
    *   `LOG_LEVEL` (Optional, Default: `INFO`. Valid: `trace`, `debug`, `info`, `warn`, `error`, `fatal`)
    *   `LOG_FILE_PATH` (Optional. Default: undefined - no file logging)
*   The `--print-config-vars` CLI flag will list these, their purpose, and current effective values (masking secrets).
*   The `src/config.ts` module will be responsible for reading, parsing, validating (e.g., min/max for numbers), and providing these values. If required variables are missing, the server MUST log a CRITICAL error and EXIT 1.

**5. Security: Credentials, Database Encryption, API Keys**

*   **Simplenote User Credentials (`SIMPLENOTE_USERNAME`, `SIMPLENOTE_PASSWORD`):** Provided via environment variables. Handled by `Backend API Client` for Simperium authentication. Must not be logged directly.
*   **Simperium Application Constants (Hard-coded in `BackendApiClient.ts`):**
    *   `SIMPERIUM_APP_ID = 'chalk-bump-f49'`
    *   `SIMPERIUM_API_KEY = 'e2f0978acfea407aa23fdf557478d3f2'`
*   **`DB_ENCRYPTION_KEY` Environment Variable:**
    *   This variable is currently **NOT USED** for database file encryption in the `sql.js`-based implementation. If set, it is noted but does not encrypt the persisted SQLite file.
*   **Salt for Owner Identity Hash (`OWNER_IDENTITY_SALT`):**
    *   A hard-coded, unique, long, random string constant within MCP Notarium. Used to derive a hash from `SIMPLENOTE_USERNAME` for the database filename, providing user-specific cache files.

**6. Local Cache Module: SQLite with Optional SQLCipher**

*   **Local Cache Module: SQLite via `sql.js` (WASM)**

*   **6.1. Database File & Encryption Mode**
    *   **Database Implementation:** Uses `sql.js`, which loads the SQLite database as a WebAssembly module. The database is primarily managed in memory during runtime.
    *   **Persistence:** The database is loaded from a file at startup and saved back to a file on graceful shutdown (or potentially at intervals if implemented).
    *   **Filename:** Typically `notarium-cache-${ownerHash}.sqlite3`, where `${ownerHash}` is derived from `SIMPLENOTE_USERNAME`. Stored in a `.cache` directory within the project workspace or an OS-specific cache directory.
    *   **Encryption:** **NOT IMPLEMENTED in the current `sql.js`-based version.** The `DB_ENCRYPTION_KEY` environment variable is not used to encrypt the database file. The database file is stored unencrypted.
    *   (Original SQLCipher Spec: Encrypted: `notarium_cache.sqlite.encrypted` (if `DB_ENCRYPTION_KEY` set). Unencrypted: `notarium_cache.sqlite` (if `DB_ENCRYPTION_KEY` not set). Also manage associated `-wal` and `-shm` files during deletion.)
*   **NPM Packages:** Uses `sql.js`. Requires providing the `.wasm` file for `sql.js` (e.g., by packaging it in an `assets` directory).
    *   (Original SQLCipher Spec: Dynamically require `better-sqlite3-sqlcipher` if `DB_ENCRYPTION_KEY` is set; otherwise, require `better-sqlite3`. If `better-sqlite3-sqlcipher` is required but fails to load (e.g., native addon issue), log CRITICAL and EXIT 1.)

*   **6.2. SQLCipher Key Derivation Details**
    *   **NOT APPLICABLE.** This section is specific to SQLCipher, which is not currently used. The `sql.js` implementation does not use this key derivation strategy.
*   **Startup Checks (Order is important - As per v3.2, adapted for `sql.js`):**
    1.  Load Env Vars.
    2.  Determine target DB file based on `owner_identity_hash`.
    3.  Locate and load `sql.js` WASM binary. If loading fails, CRITICAL EXIT.
    4.  Attempt to load DB from file into `sql.js` instance.
        *   If file doesn't exist (`ENOENT`): Log INFO, set `new_db_required = true`.
        *   On other load failures (e.g., corrupt file): Log INFO "DB corrupt?", delete DB file, set `new_db_required = true`.
    5.  **If DB loaded successfully and not `new_db_required`:**
        *   `db_schema_version = db.pragma('user_version', {simple: true});`. `CURRENT_APP_SCHEMA_VERSION = 1;` (or current version).
        *   If `db_schema_version < CURRENT_APP_SCHEMA_VERSION` or (`db_schema_version == 0` and DB is not empty): Log INFO "Schema too old", delete DB file, set `new_db_required = true`.
        *   If `db_schema_version > CURRENT_APP_SCHEMA_VERSION`: Log INFO "Schema too new", delete DB file, set `new_db_required = true`.
        *   (Original SQLCipher spec for `owner_identity_hash` check *inside* the DB is not implemented. The filename provides some level of owner separation).
*   **SQLite PRAGMAs (after successful open/keying):**
    *   `PRAGMA journal_mode=WAL;`
    *   `PRAGMA synchronous=NORMAL;`
    *   `PRAGMA foreign_keys=ON;`
*   **Table Schema Creation (if `new_db_required` or tables don't exist):**
    *   Create `notes`, `notes_fts` (with triggers), and `sync_metadata` tables as per spec v3.2.
    *   The `sync_metadata` table will store `backend_cursor` and other sync-related metrics. It will NOT store `db_key_salt_hex` or `owner_identity_hash` (as SQLCipher is not used, and owner hash is in filename).
    *   Set `PRAGMA user_version = ${CURRENT_APP_SCHEMA_VERSION};` after creating tables.
*   **FTS5 Tokenizer:** `porter unicode61 remove_diacritics 1` (Enable diacritics removal for broader matching).

**6.5. Table Schemas (`notes`, `notes_fts`, `sync_metadata`)**
*   `notes` table:
    *   `id TEXT PRIMARY KEY NOT NULL`
    *   `text TEXT NOT NULL` (Main content of the note)
    *   `tags TEXT NOT NULL DEFAULT '[]'` (JSON string array)
    *   `created_at INTEGER NOT NULL` (Unix epoch seconds)
    *   `modified_at INTEGER NOT NULL` (Unix epoch seconds)
    *   `local_version INTEGER NOT NULL DEFAULT 1`
    *   `server_version INTEGER` (Optional, from Simperium)
    *   `trash INTEGER NOT NULL DEFAULT 0` (Boolean 0 or 1)
    *   `sync_deleted INTEGER NOT NULL DEFAULT 0` (Boolean 0 or 1, tracks if delete was synced)
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

*   **`ListInputSchema`**: (Input for the `list` tool)
    *   `query: z.string().optional()` (Full-text search query. Filters like `tag:`, `before:`, `after:` are extracted from this.)
    *   `tags: z.array(z.string()).optional()` (Filter by notes containing ALL of these tags. Applied in addition to tags from `query_string`.)
    *   `trash_status: z.number().int().min(0).max(2).optional()` (Filter by trash status: `0` for not trashed (active), `1` for trashed, `2` for any. Defaults to `0` if not specified by `trash:` filter in `query_string`.)
    *   `date_before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()` (Filter for notes modified before this UTC date. Applied in addition to `before:` from `query_string`.)
    *   `date_after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()` (Filter for notes modified after this UTC date. Applied in addition to `after:` from `query_string`.)
    *   `sort_by: z.enum(['modified_at', 'created_at']).optional()` (Field to sort by. Defaults to `modified_at` if not an FTS query, or as secondary sort after `rank` for FTS. FTS queries primarily sort by `rank`.)
    *   `sort_order: z.enum(['ASC', 'DESC']).optional()` (Sort order. Defaults to `DESC`.)
    *   `limit: z.number().int().min(1).max(100).default(20).optional()`
    *   `page: z.number().int().min(1).default(1).optional()`

*   **`ListItemSchema`**:
    *   `type: z.literal('text')` (Indicates item is plain text)
    *   `uuid: z.string().min(1)` (The unique ID of the note, maps to `notes.id`)
    *   `text: z.string().min(1).max(80)` (Preview of the note content, first line, max 80 chars. Non-empty.)
    *   `local_version: z.number().int()`
    *   `tags: NoteTagsSchema`
    *   `modified_at: UnixTimestampSchema` (Last modified timestamp (epoch seconds))
    *   `trash: z.boolean()`
*   **`NoteDataSchema`**:
    *   `id: z.string().min(1)`
    *   `local_version: z.number().int()`
    *   `server_version: z.number().int().optional()` (Server version of the note from Simperium)
    *   `text: z.string()` (Main content of the note)
    *   `tags: NoteTagsSchema`
    *   `modified_at: UnixTimestampSchema`
    *   `created_at: UnixTimestampSchema.optional()`
    *   `trash: z.boolean()`
    *   `text_is_partial: z.boolean().optional()`
    *   `text_total_lines: z.number().int().optional()`
    *   `range_line_start: z.number().int().positive().optional()`
    *   `range_line_count: z.number().int().nonnegative().optional()`
*   **`GetInputSchema`**:
    *   `id: z.string().min(1)`
    *   `local_version: z.number().int().optional()`
    *   `range_line_start: z.number().int().min(1).optional()`
    *   `range_line_count: z.number().int().min(0).optional()`
*   **`SaveInputSchema`**: (Refinement logic for `local_version` dependency on `id`)
    *   `id: z.string().min(1).optional()`
    *   `local_version: z.number().int().optional()` (Required if `id` is present)
    *   `server_version: z.number().int().optional()` (Expected server version for conflict detection)
    *   `text: z.string().optional()` (Full text content of the note)
    *   `text_patch: z.array(PatchOperationSchema).optional()` (Line-based patch for the note content)
    *   `tags: NoteTagsSchema.optional()`
    *   `trash: z.boolean().optional()`
*   **`PatchOperationSchema`**:
    *   `operation: z.enum(['addition', 'modification', 'deletion'])`
    *   `line_number: z.number().int().min(1)`
    *   `value: z.string().optional()` (Required for `addition`/`modification`)
*   **`ManageInputSchema`**: (For note actions like trash, untrash, delete_permanently)
    *   `action: z.enum(['trash', 'untrash', 'delete_permanently', 'get_stats', 'reset_cache'])`
    *   `id: z.string().min(1).optional()` (Required for note actions)
    *   `local_version: z.number().int().optional()` (Required for note actions)
*   **`ManageNoteActionOutputSchema`**:
    *   `id: z.string().min(1)`
    *   `status: z.enum(['trashed', 'untrashed', 'deleted'])`
    *   `new_local_version: z.number().int().optional()`
    *   `new_server_version: z.number().int().optional()` (if applicable)

**10. MCP Tool Definitions (Service: MCP Notarium)**

*   **General Tool Behavior:**
    *   All tool handlers MUST be `async`.
    *   First step: Validate `params` object against the tool's Zod input schema. On failure, throw `NotariumValidationError` which gets converted to JSON-RPC error.
    *   Write operations (`save`, `manage` note actions) are **backend-first synchronous**.
    *   Backend API calls use `API_TIMEOUT_SECONDS`.
*   **10.1. Tool: `list`**
    *   **Input**: `ListInputSchema`.
    *   **Server Logic (Detailed):**
        1.  `trash_s_value = input.trash_status === 1 ? 1 : (input.trash_status === 2 ? undefined : 0);` (Handle `trash_status`: 0 for active, 1 for trashed. If 2 or undefined, initially no trash filter for SQL, but `trash_status` default is 0 if not specified in `query_string` by `trash:` filter. The effective default from Zod is 0. Logic should be: if `input.trash_status` is 0, active; if 1, trashed; if 2, no clause.)
        2.  Initialize `SQL_WHERE_CLAUSES = []`, `SQL_PARAMS = []`. If `input.trash_status` is `0` or `1`, add `notes.trash = ?` and param. (If `trash_status` is 2, no trash clause is added).
        3.  `effective_tags = new Set(input.tags || [])`.
        4.  `fts_query_terms = []`. (This line seems unused, can be removed or clarified if it was for a previous FTS formatting idea)
        5.  `effective_dt_before = input.modified_before_date ? new Date(input.modified_before_date + "T23:59:59.999Z").getTime()/1000 : null;`
        6.  `effective_dt_after = input.modified_after_date ? new Date(input.modified_after_date + "T00:00:00.000Z").getTime()/1000 : null;`
        7.  **Parse `input.query_string` (if present):**
            *   Regex `tag_regex = /tag:(\S+)/g`. For each match, add tag to `effective_tags`. Remove matches from `query_string`.
            *   Regex `before_regex = /before:(\d{4}-\d{2}-\d{2})/g`. For each match, parse date. If valid, `effective_dt_before = Math.min(effective_dt_before || Infinity, end_of_day_utc_ts(match_date))`. Remove from `query_string`.
            *   Regex `after_regex = /after:(\d{4}-\d{2}-\d{2})/g`. For each match, parse date. If valid, `effective_dt_after = Math.max(effective_dt_after || 0, start_of_day_utc_ts(match_date))`. Remove from `query_string`.
            *   `remaining_query_text = input.query_string.trim()`. If not empty, this is for FTS.
        8.  **Build SQL `WHERE` clauses:**
            *   For each tag in `effective_tags`: `SQL_WHERE_CLAUSES.push("EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ?)")`, `SQL_PARAMS.push(tag)`.
            *   If `effective_dt_before`: `SQL_WHERE_CLAUSES.push("notes.modified_at < ?")`, `SQL_PARAMS.push(effective_dt_before)`.
            *   If `effective_dt_after`: `SQL_WHERE_CLAUSES.push("notes.modified_at > ?")`, `SQL_PARAMS.push(effective_dt_after)`.
        9.  **FTS5 Query Part:**
            *   If `remaining_query_text`: `fts_match_clause = "notes.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts.text MATCH ?)"`. `SQL_WHERE_CLAUSES.push(fts_match_clause)`. `SQL_PARAMS.push(format_for_fts(remaining_query_text))`. (Format might involve joining terms with AND, escaping).
            *   Determine `ORDER_BY` clause:
                *   `let orderBySQL = "";`
                *   `const defaultSortField = "notes.modified_at";`
                *   `const defaultSortOrder = "DESC";`
                *   `let sortFieldInput = input.sort_by;`
                *   `let sortOrderInput = input.sort_order;`

                *   `let resolvedSortField = defaultSortField;`
                *   `if (sortFieldInput === 'created_at') resolvedSortField = 'notes.created_at';`
                *   `// If sortFieldInput is 'modified_at' or undefined, it defaults to notes.modified_at`

                *   `let resolvedSortOrder = sortOrderInput || defaultSortOrder;`

                *   `if (remaining_query_text) {`
                *   `  // For FTS queries, rank is primary. User-defined sort is secondary, or modified_at DESC by default.`
                *   `  orderBySQL = \`rank, \${resolvedSortField} \${resolvedSortOrder}\`;`
                *   `} else {`
                *   `  // For non-FTS queries, user-defined sort is primary, or modified_at DESC by default.`
                *   `  orderBySQL = \`\${resolvedSortField} \${resolvedSortOrder}\`;`
                *   `}`
                *   `ORDER_BY = orderBySQL;` (SQLite FTS returns `rank` implicitly when matching).
        10. **Count Query:** `SELECT COUNT(*) as total FROM notes WHERE ${SQL_WHERE_CLAUSES.join(" AND ") || '1=1'};` (Execute with `SQL_PARAMS` excluding FTS term if no FTS query). Get `total_items`.
        11. **Data Query:** `SELECT notes.id, notes.local_version, notes.text, notes.tags, notes.modified_at, notes.trash FROM notes WHERE ${SQL_WHERE_CLAUSES.join(" AND ") || '1=1'} ORDER BY ${ORDER_BY} LIMIT ? OFFSET ?;`. (Execute with all `SQL_PARAMS`, plus `input.limit`, `(input.page - 1) * input.limit`).
        12. **Process Rows:** For each row, generate `titlePreviewString` (first non-empty trimmed line of `notes.text`, max 80 chars; `"(empty note)"` if note empty/whitespace). Map to `ListItemSchema` by populating `type` with `'text'`, `uuid` with `notes.id`, and `text` directly with `titlePreviewString`.
            *   **Note:** Use `ListItemSchema.safeParse()` to handle potential data inconsistencies. Log and skip invalid items.
    *   **Output**: `ListOutputSchema` (`content: ListItem[]`, `next_page?: number`). Calculate `next_page`.
*   **10.2. Tool: `get`**
    *   (As per v3.2. Handles `range_line_start`, `range_line_count`. If range end exceeds lines, returns to actual end. Sets `txt_partial`, `txt_tot_ln`). Input uses `local_version`. Output maps DB `local_version` to API `local_version`.
*   **10.3. Tool: `save`**
    *   (As per v3.2. `local_version` required for updates. Handles `text` OR `text_patch`. `text_patch` line numbers (field: `line_number`) 1-indexed, relative to `local_version`'s content state of `text`. Server processes `deletion` (high to low `line_number`), `modification`, `addition` (low to high `line_number`). Synchronous backend write using `server_version` from local DB or input. Updates local cache only on Simperium success with Simperium's response object, prioritizing `response_note.version` for new `server_version`. Handles Simperium 409/412 version conflict with specific `NotariumError` and resolution hint). Input uses `local_version`, `server_version`, `text` or `text_patch`. Output maps to `local_version`, `server_version`, `text`.
*   **10.4. Tool: `manage`**
    *   **FTS5 for Search (V1):** SQLite's FTS5 (provided by `sql.js`) is used as the primary search mechanism for text in notes. Advanced application-level fuzzy matching (e.g., `fuse.js` for typo tolerance) is deferred beyond V1 to keep initial complexity low. Keyword filters (`tag:`, `before:`, `after:`) are extracted from the query string by the server.
    *   **Line-Based Patching for `save`:** Chosen as a compromise between sending full note content (inefficient for LLMs with large notes) and complex character-level diffs. The `text_patch` with `{operation: 'addition' | 'modification' | 'deletion', line_number, value}` format is deemed reasonably understandable and implementable for LLMs and the server.
    *   **No Database Encryption (Current `sql.js` Setup):** The current implementation with `sql.js` does not encrypt the persisted database file. This simplifies setup by avoiding native dependencies required for SQLCipher, but offers less local data protection.

**11. NPM Dependencies & Project Setup**

**12. Logging (`pino`)**

**13. Error Handling (`NotariumError` Hierarchy & MCP Mapping)**

**14. Performance Metrics Collection & Exposure**

**15. Internationalization & Time Handling**

**16. Concurrency Assumptions**

**17. Graceful Shutdown & Exit Codes**

**18. Design Decisions & Rationale (Addressing past Q&A)**

**19. Known Limitations (V1)**

**20. Future Considerations (Post-V1)**