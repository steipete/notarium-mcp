# MCP Notarium

**MCP Notarium** is a server application that acts as a bridge between Large Language Models (LLMs) and the [Simplenote](https://simplenote.com/) note-taking service. It exposes a set of tools compliant with the Model Context Protocol (MCP), enabling LLMs to read, write, search, and manage a user's Simplenote notes.

This project is designed to be run by individual users for their own Simplenote account, providing secure and controlled access to their notes via an AI agent or similar MCP-compatible client.

## Features

- **MCP-Compliant Tools:** Exposes `list`, `get`, `save`, and `manage` tools for comprehensive note interaction.
- **Simplenote Integration:** Connects directly to your Simplenote account using your credentials.
- **Local Caching:** Utilizes a local SQLite database to cache notes for fast read access and offline capabilities (syncs when online).
- **Optional Database Encryption:** Secure your local note cache with an encryption key using SQLCipher.
- **Text Patching:** Efficiently update notes using line-based text patches for the `save` tool, minimizing data transfer.
- **Configuration via Environment Variables:** Easy setup using standard environment variables or a `.env` file.
- **Background Sync:** Periodically syncs with the Simperium backend (Simplenote's sync provider) to keep the local cache up-to-date.

## Core Architecture

MCP Notarium consists of several key components:

- **MCP Server Core:** Listens for JSON-RPC 2.0 requests over `stdio` and dispatches them to the appropriate tool handlers.
- **Tool Handlers:** Implement the logic for `list`, `get`, `save`, and `manage` operations.
- **Local Cache Module:** Manages an SQLite database (optionally encrypted with SQLCipher) for storing notes locally.
- **Backend API Client:** Interacts with the Simperium API for authentication and direct note operations.
- **Backend Sync Service:** Runs in the background to synchronize local notes with the Simperium backend.

## Prerequisites

- **Node.js:** Version 18.x LTS or later is recommended (as specified in `package.json` engines).
- **Simplenote Account:** You need an active Simplenote account.

## Installation and Usage

### Using `npx` (Recommended for Quick Use)

The easiest way to run MCP Notarium is using `npx`. This ensures you are running the latest version without needing a local installation.

```bash
npx mcp-notarium
```

When run via `npx`, MCP Notarium will start, attempt to authenticate with Simplenote (using configured environment variables), and then listen for MCP requests on `stdio`.

### Local Installation (for Development or Persistent Use)

1.  **Clone the repository (if not already done for development):**

    ```bash
    git clone <repository-url>
    cd mcp-notarium
    ```

2.  **Install dependencies:**

    ```bash
    npm install
    ```

    If you plan to use database encryption, ensure that `better-sqlite3-sqlcipher` can be built on your system. This might require build tools like `python`, `make`, and a C++ compiler.

3.  **Build the project:**

    ```bash
    npm run build
    ```

4.  **Run the server:**
    ```bash
    npm start
    ```

## Configuration

MCP Notarium is configured primarily through environment variables. You can set these in your shell, or create a `.env` file in the root of the project directory (if running from a local clone) or in the directory where you execute `npx mcp-notarium`.

**Example `.env` file:**

```env
SIMPLENOTE_USERNAME="your_simplenote_email@example.com"
SIMPLENOTE_PASSWORD="your_simplenote_password"

# Optional: For local cache encryption (highly recommended)
# DB_ENCRYPTION_KEY="your-strong-unique-passphrase-for-db-encryption"

# Optional: Adjust sync interval (seconds)
# SYNC_INTERVAL_SECONDS=300

# Optional: API timeout (seconds)
# API_TIMEOUT_SECONDS=30

# Optional: Log level (trace, debug, info, warn, error, fatal)
# LOG_LEVEL="info"

# Optional: Log to a file
# LOG_FILE_PATH="./notarium.log"
```

### Key Environment Variables:

- `SIMPLENOTE_USERNAME` (**Required**): Your Simplenote email address.
- `SIMPLENOTE_PASSWORD` (**Required**): Your Simplenote password.
- `DB_ENCRYPTION_KEY` (Optional, Recommended): A strong passphrase to encrypt the local SQLite cache. If not provided, the cache will be unencrypted.
- `DB_ENCRYPTION_KDF_ITERATIONS` (Optional, Default: `310000`): Number of PBKDF2 iterations for deriving the database encryption key. Higher is more secure but slower to open.
- `SYNC_INTERVAL_SECONDS` (Optional, Default: `300`): How often (in seconds) the background sync service will attempt to pull changes from Simplenote. Minimum: `60`.
- `API_TIMEOUT_SECONDS` (Optional, Default: `30`): Timeout in seconds for API calls to the Simplenote (Simperium) backend. Minimum: `5`.
- `LOG_LEVEL` (Optional, Default: `INFO`): Sets the logging verbosity. Valid levels: `trace`, `debug`, `info`, `warn`, `error`, `fatal`.
- `LOG_FILE_PATH` (Optional): If set, logs will also be written to this file path in addition to `stdout`.

### Printing Configuration

To see a list of all configuration variables, their purpose, and their current effective values (with secrets masked), you can run:

```bash
# If using npx
npx mcp-notarium --print-config-vars

# If installed locally
npm start -- --print-config-vars
# or if linked globally/via bin
mcp-notarium --print-config-vars
```

## Usage with MCP Clients

MCP Notarium communicates over `stdio` using JSON-RPC 2.0. An MCP client (like an AI agent environment) can start MCP Notarium as a child process and communicate with it by writing JSON-RPC requests to its `stdin` and reading JSON-RPC responses from its `stdout`.

The service name is `mcp_notarium`.

### Available Tools:

- **`mcp_notarium.list`**: Lists notes with filtering and pagination options.
- **`mcp_notarium.get`**: Retrieves a specific note by its ID, optionally a specific version or a range of lines.
- **`mcp_notarium.save`**: Creates a new note or updates an existing one. Supports full text content or line-based patches (`txt_patch`).
- **`mcp_notarium.manage`**: Performs management actions:
  - `get_stats`: Retrieves server and sync statistics.
  - `reset_cache`: Deletes the local cache, forcing a full resync.
  - `trash`: Moves a note to the trash.
  - `untrash`: Restores a note from the trash.
  - `delete_permanently`: Deletes a note permanently from the local cache (V1: does not hard-delete from server).

(Refer to `docs/spec.md` for detailed tool schemas and parameters.)

## Security Considerations

- **Credentials**: Your `SIMPLENOTE_USERNAME` and `SIMPLENOTE_PASSWORD` are sensitive. Ensure they are protected, especially if you use a `.env` file (e.g., by adding `.env` to your global `.gitignore`).
- **Database Encryption Key**: If you use `DB_ENCRYPTION_KEY`, choose a strong, unique passphrase. This key encrypts your notes stored locally. If you lose this key, you will lose access to the local cache (though your notes remain on Simplenote's servers).
- **API Key**: The Simperium App ID and API Key used by this application are typically considered public client identifiers for the Simplenote application on Simperium and are hardcoded as per common client practices.

## Known Limitations (V1)

- **Hard Delete Detection:** Notes hard-deleted from Simplenote by _other_ clients might not be immediately removed from the local cache (they will be marked as `sync_deleted` if a fetch for their specific version fails, or on full resync if the index no longer contains them). The `delete_permanently` manage action is local-only in V1.
- **Search Typo-Tolerance:** Search via the `q` parameter relies on SQLite FTS5, which has good prefix matching but not advanced typo correction (e.g., Levenshtein distance).
- **Schema Migrations:** No automated, non-destructive schema migrations for the local SQLite database are implemented. Significant schema changes would require a cache reset.

## Future Considerations

- Advanced fuzzy search integration.
- Periodic full cache reconciliation for robust hard delete detection.
- Automated, non-destructive SQLite schema migrations.
- Support for other note-taking backends.

## License

[MIT](./LICENSE)
