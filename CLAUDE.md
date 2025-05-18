# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP Notarium is a Model Context Protocol (MCP) server application that bridges Large Language Models (LLMs) with the Simplenote note-taking service. It exposes MCP-compliant tools (`list`, `get`, `save`, `manage`) for comprehensive note interaction.

## Common Development Commands

```bash
# Install dependencies
npm install

# Build the TypeScript project to dist/
npm run build

# Start the compiled server
npm run start

# Run in development mode with hot reloading
npm run dev

# Lint the codebase
npm run lint

# Fix linting issues
npm run lint:fix

# Check code formatting
npm run lint:check-format

# Format the codebase
npm run format

# Run tests
npm run test

# Run tests in watch mode
npm run test:watch

# Print configuration variables and exit
npm run print-config-vars
```

## Architecture Overview

### Component Organization

- **MCP Server Core** (`src/mcp-core/`): Handles JSON-RPC 2.0 message parsing and routing
- **Tool Handlers** (`src/tools/`): Implement `list`, `get`, `save`, and `manage` operations
- **Local Cache Module** (`src/cache/sqlite.ts`): Manages SQLite/SQLCipher database connection
- **Backend API Client** (`src/backend/simperium-api.ts`): Handles HTTP/S communication with Simplenote's Simperium backend
- **Backend Sync Service** (`src/sync/sync-service.ts`): Background service for periodic synchronization
- **Configuration** (`src/config.ts`): Loads and validates environment variables
- **Logging** (`src/logging.ts`): Pino-based logging configuration
- **Error Handling** (`src/errors.ts`): Custom error hierarchy for structured error reporting

### Tool Functionality

- **`mcp_notarium.list`**: Lists notes with filtering (tags, date ranges, text search) and pagination
- **`mcp_notarium.get`**: Retrieves specific notes by ID, supports version and line range selection
- **`mcp_notarium.save`**: Creates/updates notes, supports full text or line-based patches
- **`mcp_notarium.manage`**: Handles server stats, cache reset, trash/untrash, and deletion

### Database Schema

The local SQLite cache uses three tables:
- `notes`: Stores note content, tags, and metadata
- `notes_fts`: Full-text search index for note content
- `sync_metadata`: Tracks backend cursor and sync metrics

## Environment Configuration

Required environment variables:
- `SIMPLENOTE_USERNAME`: Your Simplenote email
- `SIMPLENOTE_PASSWORD`: Your Simplenote password

Optional variables:
- `DB_ENCRYPTION_KEY`: Passphrase for local cache encryption
- `DB_ENCRYPTION_KDF_ITERATIONS`: PBKDF2 iterations (default: 310000)
- `SYNC_INTERVAL_SECONDS`: Backend sync frequency (default: 300, min: 60)
- `API_TIMEOUT_SECONDS`: API call timeout (default: 30, min: 5)
- `LOG_LEVEL`: Logging verbosity (trace/debug/info/warn/error/fatal)
- `LOG_FILE_PATH`: File path for log output

## Testing Tools with MCP Inspector

1. Delete the `dist/` directory to force TypeScript execution via `tsx`
2. Start MCP Inspector: `npx @modelcontextprotocol/inspector`
3. Connect using `[WORKSPACE_PATH]/start.sh` as the command
4. Service appears as `mcp_notarium` in the Inspector

## Critical Implementation Details

### Backend-First Write Operations
All write operations (`save`, `manage` actions on notes) are synchronous with the backend. The server waits for Simperium API confirmation before reporting success to ensure data integrity.

### Local Cache Management
- Automatically resets when credentials change or database is corrupted
- Uses SQLite with optional SQLCipher encryption
- FTS5 tokenizer: `porter unicode61 remove_diacritics 1`

### Error Handling
Custom `NotariumError` hierarchy maps to appropriate JSON-RPC error codes:
- `AUTH`: Authentication failures
- `VALIDATION`: Input validation errors
- `NOT_FOUND`: Resource not found
- `BACKEND_API`: Backend API errors (timeout, rate limit, conflict)
- `INTERNAL`: Internal server errors

### Line-Based Patching
The `save` tool supports efficient updates using line-based patches:
```
{
  "id": "note_id",
  "txt_patch": [
    {"op": "mod", "ln": 5, "val": "Updated line content"},
    {"op": "add", "ln": 10, "val": "New line"},
    {"op": "del", "ln": 3}
  ]
}
```

## Security Considerations

- Simplenote credentials are handled via environment variables
- Simperium App ID and API Key are hardcoded client identifiers
- Optional database encryption uses PBKDF2 key derivation
- Never log sensitive credentials directly

## Deployment Notes

- Designed for `npx` execution: `npx mcp-notarium`
- Runs as stdio-based MCP server (no network port)
- Self-rescheduling sync loop prevents overlapping operations
- Graceful shutdown on SIGINT/SIGTERM