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
    *   10.4. Tool: `save` (Detailed Logic, including `txt_patch`)
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
*   **Database Encryption Key (`DB_ENCRYPTION_KEY`):**
    *   Provided via environment variable. **Currently NOT USED for database file encryption as `sql.js` is used instead of SQLCipher.** The `sql.js` library loads the database into memory; persistence is handled by reading/writing the entire DB image.
    *   (Original SQLCipher Spec: Documentation MUST emphasize choosing a strong, unique passphrase. The key itself is never stored in the database. The derived key (after PBKDF2) is used by SQLCipher in memory.)
*   **Salt for DB Key Derivation (`db_key_salt_hex`):**
    *   **NOT CURRENTLY USED** as SQLCipher is not implemented.
    *   (Original SQLCipher Spec: A 16-byte cryptographically secure random salt, generated using `crypto.randomBytes(16).toString('hex')`. Generated *once* when an encrypted database is first created by MCP Notarium. Stored in plaintext in the `sync_metadata` table (key: `db_key_salt_hex`) *inside the encrypted database*. SQLCipher needs this salt to be available *after* the database is opened with the main derived key if it were to re-derive or verify keys, but primarily it's for us to re-derive the key correctly on subsequent starts if we only have the user's passphrase. For SQLCipher's `PRAGMA cipher_kdf_salt`, it's set on DB creation and SQLCipher handles it internally.)
*   **Salt for Owner Identity Hash (`OWNER_IDENTITY_SALT`):**
    *   A hard-coded, unique, long, random string constant within MCP Notarium (e.g., `const OWNER_IDENTITY_SALT = "MCPNotarium_SimplenoteUserSalt_v1_a7b3c9d8e2f1";` - generate a new real one). Used as `sha256(SIMPLENOTE_USERNAME + OWNER_IDENTITY_SALT)`. The hash is used in the database filename to provide user-specific cache files.

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
    5.  (Original SQLCipher checks for encrypted/unencrypted mode mismatch are NOT APPLICABLE).
    6.  (Original SQLCipher warning for unencrypted mode is NOT APPLICABLE as it's always unencrypted with current `sql.js` setup).
    7.  **If DB loaded successfully and not `new_db_required`:**
        *   `db_schema_ver = db.pragma('user_version', {simple: true});`. `CURRENT_APP_SCHEMA_VERSION = 1;` (or current version).
        *   If `db_schema_ver < CURRENT_APP_SCHEMA_VERSION` or (`db_schema_ver == 0` and DB is not empty): Log INFO "Schema too old", delete DB file, set `new_db_required = true`.
        *   If `db_schema_ver > CURRENT_APP_SCHEMA_VERSION`: Log INFO "Schema too new", delete DB file, set `new_db_required = true`.
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

**7. Backend API Client (Simperium)**
(As per v3.2 - `axios`, hardcoded Simperium App ID/Key, handles token obtaining/caching and 401 re-auth, applies `API_TIMEOUT_SECONDS`, handles 429 with `Retry-After` or exponential backoff for specific request retries).

**8. Backend Sync Service (Simperium)**
(As per v3.2 - self-rescheduling `setTimeout` loop, initial full sync if `new_db_required` or no `backend_cursor`, periodic delta sync, server-wins conflict for external changes, updates `sync_metadata` with metrics, uses `API_TIMEOUT_SECONDS`, exponential backoff for *full sync cycle* failures).
*   **Initial Full Sync `PAGE_SIZE` for `/index` calls:** `100`.
*   **Delta Sync `PAGE_SIZE` for `/index?since=` calls:** `500`.

**9. `zod` Schemas for Tool I/O Validation**
(Schemas as fully defined in Version 3.2 specification, with **Note ID fields updated from `z.string().uuid()` to `z.string().min(1)`** to reflect that Simplenote IDs are not always UUIDs.)

**10. MCP Tool Definitions (Service: MCP Notarium)**

*   **General Tool Behavior:**
    *   All tool handlers MUST be `async`.
    *   First step: Validate `params` object against the tool's Zod input schema. On failure, throw `NotariumValidationError` which gets converted to JSON-RPC error.
    *   Write operations (`save`, `manage` note actions) are **backend-first synchronous**.
    *   Backend API calls use `API_TIMEOUT_SECONDS`.
*   **10.1. Tool: `list`**
    *   **Input**: `ListInputSchema`.
    *   **Server Logic (Detailed):**
        1.  `trash_s_value = input.trash_s === 1 ? 1 : (input.trash_s === 2 ? : 0);` (for SQL IN clause if any)
        2.  Initialize `SQL_WHERE_CLAUSES = []`, `SQL_PARAMS = []`. If `trash_s_value` is `0` or `1`, add `notes.trash = ?` and param. If ``, no trash clause initially.
        3.  `effective_tags = new Set(input.tags || [])`.
        4.  `fts_query_terms = []`.
        5.  `effective_dt_before = input.dt_before ? new Date(input.dt_before + "T23:59:59.999Z").getTime()/1000 : null;`
        6.  `effective_dt_after = input.dt_after ? new Date(input.dt_after + "T00:00:00.000Z").getTime()/1000 : null;`
        7.  **Parse `input.q` (if present):**
            *   Regex `tag_regex = /tag:(\S+)/g`. For each match, add tag to `effective_tags`. Remove matches from `q`.
            *   Regex `before_regex = /before:(\d{4}-\d{2}-\d{2})/g`. For each match, parse date. If valid, `effective_dt_before = Math.min(effective_dt_before || Infinity, end_of_day_utc_ts(match_date))`. Remove.
            *   Regex `after_regex = /after:(\d{4}-\d{2}-\d{2})/g`. For each match, parse date. If valid, `effective_dt_after = Math.max(effective_dt_after || 0, start_of_day_utc_ts(match_date))`. Remove.
            *   `remaining_q_text = input.q.trim()`. If not empty, this is for FTS.
        8.  **Build SQL `WHERE` clauses:**
            *   For each tag in `effective_tags`: `SQL_WHERE_CLAUSES.push("EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ?)")`, `SQL_PARAMS.push(tag)`.
            *   If `effective_dt_before`: `SQL_WHERE_CLAUSES.push("notes.mod_at < ?")`, `SQL_PARAMS.push(effective_dt_before)`.
            *   If `effective_dt_after`: `SQL_WHERE_CLAUSES.push("notes.mod_at > ?")`, `SQL_PARAMS.push(effective_dt_after)`.
        9.  **FTS5 Query Part:**
            *   If `remaining_q_text`: `fts_match_clause = "notes.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts.txt MATCH ?)"`. `SQL_WHERE_CLAUSES.push(fts_match_clause)`. `SQL_PARAMS.push(format_for_fts(remaining_q_text))`. (Format might involve joining terms with AND, escaping).
            *   `ORDER_BY = remaining_q_text ? "rank, notes.mod_at DESC" : "notes.mod_at DESC"`. (SQLite FTS returns `rank` implicitly).
        10. **Count Query:** `SELECT COUNT(*) as total FROM notes WHERE ${SQL_WHERE_CLAUSES.join(" AND ") || '1=1'};` (Execute with `SQL_PARAMS` excluding FTS term if no FTS query). Get `total_items`.
        11. **Data Query:** `SELECT notes.id, notes.l_ver, notes.txt, notes.tags, notes.mod_at, notes.trash FROM notes WHERE ${SQL_WHERE_CLAUSES.join(" AND ") || '1=1'} ORDER BY ${ORDER_BY} LIMIT ? OFFSET ?;`. (Execute with all `SQL_PARAMS`, plus `input.lim`, `(input.page - 1) * input.lim`).
        12. **Process Rows:** For each row, generate `title_prev` (first non-empty trimmed line of `txt`, max 80 chars; `""` if note empty/whitespace). Map to `ListItemSchema`.
            *   **Note:** Use `ListItemSchema.safeParse()` to handle potential data inconsistencies. Log and skip invalid items.
    *   **Output**: `ListOutputSchema` (`items: ListItem[]`, `next_page?: number`). Calculate `next_page`.
*   **10.2. Tool: `get`**
    *   (As per v3.2. Handles `rng_ln_s`, `rng_ln_c`. If range end exceeds lines, returns to actual end. Sets `txt_partial`, `txt_tot_ln`).
*   **10.3. Tool: `save`**
    *   (As per v3.2. `l_ver` required for updates. Handles `txt` OR `txt_patch`. `txt_patch` line numbers 1-indexed, relative to `l_ver`'s content state. Server processes `del` (high to low ln), `mod`, `add` (low to high ln). Synchronous backend write using `s_ver` from local DB. Updates local cache only on Simperium success with Simperium's response object, prioritizing `response_note.version` for new `s_ver`. Handles Simperium 409/412 version conflict with specific `NotariumError` and resolution hint).
    *   **Note ID:** Generates a new string ID (e.g. `uuidv4()`) if not provided (for new notes). Client-provided IDs for new notes are also acceptable if they are non-empty strings.
*   **10.4. Tool: `manage`**
    *   (As per v3.2. Note actions are sync backend-first. `l_ver` mandatory for note actions. `get_stats` populates full `ServerStatsSchema`, including `mcp_notarium_version` from `package.json`, `node_version` from `process.version`, `memory_rss_mb` from `process.memoryUsage().rss`. `db_encryption` status will be 'disabled' or 'unavailable' with `sql.js`. `reset_cache` deletes DB files, sets `global.fullResyncRequiredByReset = true`).

**11. NPM Dependencies & Project Setup**
*   **Production:** `axios` (or `node-fetch`), `sql.js` (and its `.wasm` file), `zod`, `pino`, `uuid`, `dotenv`.
*   **Development:** `@types/...` for all used packages, `typescript`, `tsup` or `esbuild` (for compilation/bundling), `pino-pretty`, testing libraries (`jest` or `vitest`, `@types/jest` or `@types/vitest`), `eslint`, `prettier`.
*   `package.json` scripts: `build`, `start`, `dev` (with `ts-node-dev` or similar), `lint`, `test`.

**12. Logging (`pino`)**
*   **Initialization (`src/logging.ts`):**
    ```typescript
    import pino from 'pino';
    import pretty from 'pino-pretty'; // Only if textual logs are desired for TTY

    const isTTY = process.stdout.isTTY;
    const logLevel = process.env.LOG_LEVEL || 'info';
    const logFilePath = process.env.LOG_FILE_PATH;

    const streams = [];
    if (isTTY && process.env.LOG_FORMAT !== 'json') {
      streams.push({ stream: pretty({ colorize: true, sync: true }), level: logLevel });
    } else {
      streams.push({ stream: process.stdout, level: logLevel }); // Default to structured (JSON or text) on stdout
    }

    if (logFilePath) {
      streams.push({ stream: pino.destination(logFilePath), level: logLevel });
    }

    const logger = pino({
      level: logLevel,
      base: { pid: process.pid, hostname: require('os').hostname() }, // Add standard base fields
      timestamp: pino.stdTimeFunctions.isoTime, // ISO8601 timestamps
    }, pino.multistream(streams));

    export default logger;
    ```
*   **Usage:** Import logger instance. Use `logger.info({ trace_id, tool_name, ... }, "Message")`.
*   **Redaction:** Redact `SIMPLENOTE_PASSWORD` and `DB_ENCRYPTION_KEY` if they ever appear in log context (they shouldn't with proper handling).

**13. Error Handling (`NotariumError` Hierarchy)**
*   **Base Class (`src/errors.ts`):**
    ```typescript
    export class NotariumError extends Error {
      public readonly category: 'AUTH' | 'VALIDATION' | 'NOT_FOUND' | 'BACKEND_API' | 'INTERNAL' | 'TIMEOUT';
      public readonly httpStatusCode: number;
      public readonly user_message: string;
      public readonly details?: Record<string, any>;
      public readonly resolution_hint?: string;
      public readonly originalError?: Error;
      public readonly subcategory?: string;

      constructor(params: { /* as defined in v3.2 */ message: string; /* ... */ }) {
        super(params.message);
        this.name = this.constructor.name;
        // ... assign other properties
      }
      public toDict(): object { /* ... returns structured error for MCP error.data */ }
    }
    ```
*   **Subclasses:** `NotariumAuthError`, `NotariumValidationError`, `NotariumResourceNotFoundError`, `NotariumBackendError` (with specific subcategories like `conflict`, `timeout`, `rate_limit`), `NotariumInternalError`. Each pre-sets category and `httpStatusCode`.
*   Tool handlers `try...catch` specific errors and general `Error`, convert to appropriate `NotariumError`, and throw that. The MCP Server Core is assumed to catch these and format the JSON-RPC error response.

**14. Performance Metrics Collection & Exposure**
(As per v3.2: `Backend Sync Service` updates metrics in `sync_metadata`. `manage` tool with `act: 'get_stats'` reads from this and adds runtime stats like versions and memory).

**15. Internationalization & Time Handling**
*   **FTS Tokenizer:** `porter unicode61 remove_diacritics 1`.
*   **Timestamps:** All internal and API-exposed are UNIX epoch seconds (number), UTC. Query filter dates (`before:/after: YYYY-MM-DD`) are interpreted as start/end of UTC day (e.g., `YYYY-MM-DDT00:00:00.000Z` and `YYYY-MM-DDT23:59:59.999Z`).

**16. Concurrency Assumptions**
*   MCP Server Core framework MUST process incoming MCP requests serially for a single MCP Notarium instance.

**17. Graceful Shutdown & Exit Codes**
*   (As per v3.2: `SIGINT`/`SIGTERM` handlers, set global shutdown flag, allow in-progress tool calls to finish, close DB, flush logs. Exit 0 for normal, Exit 1 for critical startup errors).

**18. Design Decisions & Rationale**
    *   **Synchronous Backend Writes for Tools:** Chosen over optimistic local writes to provide immediate and reliable success/failure feedback to the LLM, crucial for agent workflows. Assumes LLM client and MCP Notarium are online. Mitigates complex disconnected error reporting and data divergence issues. Increases write latency but prioritizes data integrity from LLM's perspective.
    *   **SQLite as Pure Cache with Auto-Reset:** If credentials (`SIMPLENOTE_USERNAME`) change, or if the DB is corrupt or schema mismatches, the local SQLite cache is automatically deleted and rebuilt. This is acceptable because the cache is not the source of truth and Simplenote is. This simplifies recovery for the user in an `npx` environment.
    *   **Environment Variables for Credentials:** Selected over interactive setup (like `keytar`) due to the `npx` execution model and declarative configuration via a host app's JSON file. User is responsible for securing their config file / environment. `SIMPLENOTE_` prefix for backend-specific creds, no prefix or `DB_` for Notarium-specific ones.
    *   **Limited Toolset & Overloaded `manage` Tool:** To adhere to constraints on the number of exposed MCP tools, functionality like server stats and cache reset is consolidated under the `manage` tool, despite minor semantic impurity. This prioritizes token efficiency and limits for host applications.
    *   **FTS5 for Search (V1):** SQLite's FTS5 (provided by `sql.js`) is used as the primary search mechanism for text in notes. Advanced application-level fuzzy matching (e.g., `fuse.js` for typo tolerance) is deferred beyond V1 to keep initial complexity low. Keyword filters (`tag:`, `before:`, `after:`) are extracted from the query string by the server.
    *   **Line-Based Patching for `save`:** Chosen as a compromise between sending full note content (inefficient for LLMs with large notes) and complex character-level diffs. The `{op, ln, val}` format is deemed reasonably understandable and implementable for LLMs and the server.
    *   **No Database Encryption (Current `sql.js` Setup):** The current implementation with `sql.js` does not encrypt the persisted database file. This simplifies setup by avoiding native dependencies required for SQLCipher, but offers less local data protection.
    *   **Use of `sql.js` (SQLite WASM):** Chosen for potentially broader platform compatibility (e.g., environments where native Node.js addons for `better-sqlite3` might be difficult to build or deploy) and to avoid native dependencies. The trade-off includes differences in direct file I/O patterns and lack of built-in SQLCipher support in the typical `sql.js` package.
    *   **Textual Logging by Default for `stdio`:** Prioritizes human readability for typical MCP client interaction, with JSON as an option for advanced users or different logging transports.
    *   **No Server Port by Default:** Assumes `stdio` communication typical for MCP desktop integrations, simplifying configuration.
    *   **Hardcoded Simplenote App ID/API Key:** These are specific to client applications interfacing with Simperium for Simplenote and are not user-specific secrets.
    *   **Self-Rescheduling `setTimeout` for Sync Loop:** Preferred over `setInterval` to prevent overlapping sync operations if one cycle takes longer than the interval.

**19. Known Limitations (V1)**
    *   **Hard Delete Detection:** Notes hard-deleted from Simperium by *other* clients will not be automatically removed from the local cache by the periodic delta sync. They will persist until a manual cache reset or an automatic reset due to credential/key changes.
    *   **Search Typo-Tolerance:** Search via `q` relies on FTS5, which has some prefix matching but not advanced typo correction like Levenshtein distance.
    *   **Schema Migrations:** No automated, non-destructive schema migrations for the SQLite database. Schema changes will require deleting the old cache.
    *   **Single User Focus:** Designed for a single Simplenote account per MCP Notarium instance.
    *   **Tag Search via FTS:** Tags are filtered via SQL `WHERE` clauses on the JSON `tags` column, not directly integrated into the main FTS5 index of note content. This means combined FTS content search + tag search relies on SQLite's query optimizer.
    *   **Database Unencrypted:** The local SQLite cache file is not encrypted in the current `sql.js`-based implementation.

**20. Future Considerations (Post-V1)**
    *   Advanced fuzzy search integration (`fuse.js`).
    *   Periodic full cache reconciliation to detect hard deletes.
    *   Automated, non-destructive SQLite schema migrations.
    *   Support for other note-taking backends (would require abstracting the `Backend API Client` and `Backend Sync Service`).
    *   Exposing metrics via a Prometheus-compatible HTTP endpoint.
    *   More sophisticated conflict resolution for the background sync service.
    *   Implementing MCP "Resources" and "Prompts" more fully if beneficial.

This ultra-detailed specification should provide a very solid blueprint for implementation.