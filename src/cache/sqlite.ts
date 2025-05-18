// console.error('[SQLite Path Debug] TOP OF sqlite.ts EXECUTING'); // Use Pino logger now

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import logger from '../logging.js';
import { config } from '../config.js';

export type DB = SqlJsDatabase;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let currentDir = __dirname;
let projectRoot = currentDir;
while (!fs.existsSync(path.join(projectRoot, 'package.json'))) {
  const parentDir = path.dirname(projectRoot);
  if (parentDir === projectRoot) {
    throw new Error('Could not find project root (package.json). Current path: ' + currentDir);
  }
  projectRoot = parentDir;
}

const assetsDir = path.join(projectRoot, 'assets');
const wasmPath = path.join(assetsDir, 'custom-sql-wasm.wasm');
const customSqlJsGluePath = path.join(assetsDir, 'custom-sql-wasm.js');

let SQL: SqlJsStatic | null = null;
let dbInstance: SqlJsDatabase | null = null;

async function loadSqlJs(): Promise<SqlJsStatic> {
  if (SQL) return SQL!;

  logger.debug('[SQLite Load] Attempting to load SQL.js');
  if (!fs.existsSync(customSqlJsGluePath) || !fs.existsSync(wasmPath)) {
    logger.fatal({ customSqlJsGluePath, wasmPath }, '[SQLite Load] Custom sql.js assets (glue or wasm) not found');
    throw new Error('Missing sql.js assets (glue or wasm)');
  }

  const ownRequire = createRequire(import.meta.url);
  const relativePathToGlueFromHere = path.relative(__dirname, customSqlJsGluePath);
  const requirePath = path.isAbsolute(relativePathToGlueFromHere)
    ? relativePathToGlueFromHere
    : (relativePathToGlueFromHere.startsWith('.') ? relativePathToGlueFromHere : './' + relativePathToGlueFromHere);
  
  logger.debug({ requirePath }, '[SQLite Load] Attempting to require custom SQL.js glue');
  const loadedModule = ownRequire(requirePath);
  let initSqlJsFunction: any;

  if (typeof loadedModule === 'function') {
    initSqlJsFunction = loadedModule;
    logger.debug('[SQLite Load] Found initSqlJs directly from module exports.');
  } else if (loadedModule && typeof loadedModule.default === 'function') {
    initSqlJsFunction = loadedModule.default;
    logger.debug('[SQLite Load] Found initSqlJs from module.exports.default.');
  // @ts-ignore
  } else if (typeof global !== 'undefined' && global.Module?.initSqlJs) {
    // @ts-ignore
    initSqlJsFunction = global.Module.initSqlJs;
    logger.debug('[SQLite Load] Found initSqlJs from global.Module.initSqlJs.');
  } else {
    logger.warn({ loadedModuleType: typeof loadedModule, loadedModuleKeys: loadedModule ? Object.keys(loadedModule) : null }, '[SQLite Load] Failed to find initSqlJs in loaded module via direct/default/global. Attempting VM fallback.');
    try {
      const vm = await import('vm');
      const glueSource = fs.readFileSync(customSqlJsGluePath, 'utf8');
      const vmContext = {
        require: ownRequire,
        console, // Provide console for the script if it uses it
        process, // Provide process for the script if it uses it
        __dirname: assetsDir, 
        module: {}, // Provide a dummy module object
        exports: {}, // Provide dummy exports
      } as Record<string, any>;
      vm.createContext(vmContext);
      const script = new vm.Script(`
        ${glueSource};
        // Ensure initSqlJs is the last expression to be returned
        initSqlJs;
      `);
      const potentialInit = script.runInContext(vmContext);
      if (typeof potentialInit === 'function') {
        initSqlJsFunction = potentialInit;
        logger.debug('[SQLite Load] Obtained initSqlJs via VM fallback.');
      }
    } catch (vmErr) {
      logger.error({ error: String(vmErr) }, '[SQLite Load] VM fallback failed.');
    }

    if (!initSqlJsFunction) {
      logger.fatal({
          loadedModuleType: typeof loadedModule,
          loadedModuleKeys: loadedModule ? Object.keys(loadedModule) : 'null or undefined',
        },
        '[SQLite Load] Still failed to find initSqlJs after all fallbacks.'
      );
      throw new Error('Could not load initSqlJs function from custom-sql-wasm.js after all fallbacks.');
    }
  }

  try {
    const wasmBinary = fs.readFileSync(wasmPath);
    logger.debug('[SQLite Load] WASM binary read, calling initSqlJsFunction.');
    SQL = await initSqlJsFunction({ wasmBinary });
    logger.info({
        SQL_keys: SQL ? Object.keys(SQL) : 'SQL is null',
        SQL_Database_type: SQL ? typeof SQL.Database : 'SQL is null'
      },
      '[SQLite Load] Custom sql.js (FTS5) initialised successfully.'
    );
    if (!SQL || typeof SQL.Database !== 'function') {
        throw new Error('initSqlJs did not return a valid SQL.js module with a Database constructor.');
    }
    return SQL;
  } catch (initError) {
    logger.fatal({ error: String(initError) }, '[SQLite Load] Error during initSqlJsFunction call.');
    throw initError;
  }
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    logger.debug({ directory: dir }, '[SQLite Cache] Creating directory for cache file.');
    fs.mkdirSync(dir, { recursive: true });
  }
}

function generateOwnerIdentityHash(currentConfig: typeof config): string {
  // Spec: OWNER_IDENTITY_SALT = sha256(SIMPLENOTE_USERNAME + OWNER_IDENTITY_SALT_CONSTANT)
  // For this simple version, just using username, but a hash is better for privacy if DB is shared/leaked.
  // The actual hashing (e.g., with crypto module) can be added later if needed.
  // For now, this ensures a unique DB per user.
  if (!currentConfig.SIMPLENOTE_USERNAME) {
    logger.warn('[SQLite Cache] SIMPLENOTE_USERNAME is undefined for generating cache file path. Using default "user".');
    return 'user'; // Fallback, though config validation should prevent this.
  }
  // A simple pseudo-hash for now. Replace with actual crypto.createHash('sha256')... if needed.
  return currentConfig.SIMPLENOTE_USERNAME.replace(/[^a-zA-Z0-9]/g, '_');
}

function cacheFilePath(): string {
  const cacheDir = path.join(projectRoot, '.cache');
  ensureDir(cacheDir);
  // Use the imported config object directly
  const ownerHash = generateOwnerIdentityHash(config); 
  const name = `notarium-cache-${ownerHash}.sqlite3`;
  const fullPath = path.join(cacheDir, name);
  logger.debug({ cacheFilePath: fullPath }, '[SQLite Cache] Determined cache file path.');
  return fullPath;
}

export async function initializeCache(): Promise<SqlJsDatabase> {
  logger.debug('[SQLite Cache] Initializing cache DB...');
  if (dbInstance) {
    logger.debug('[SQLite Cache] DB instance already exists, returning.');
    return dbInstance;
  }

  const SQLjs = await loadSqlJs();
  const dbFilePath = cacheFilePath();

  try {
    const data = fs.readFileSync(dbFilePath);
    dbInstance = new SQLjs.Database(new Uint8Array(data));
    logger.info({ file: dbFilePath }, '[SQLite Cache] Opened existing cache DB.');
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      logger.info({ file: dbFilePath }, '[SQLite Cache] No existing database file found. Creating new sql.js database.');
    } else {
      logger.error({ err: String(err), dbFilePath }, '[SQLite Cache] Failed to read existing database file. Creating new one.');
    }
    dbInstance = new SQLjs.Database(); // Create new DB
    try {
      createSchema(dbInstance);
      logger.info('[SQLite Cache] New database schema created.');
      // Persist the newly created DB immediately so it exists on disk
      const data = dbInstance.export();
      fs.writeFileSync(dbFilePath, data);
      logger.info({ file: dbFilePath }, '[SQLite Cache] New empty database saved to disk.');
    } catch(schemaErr) {
      logger.fatal({err: schemaErr}, '[SQLite Cache] Failed to create schema for new database.');
      throw schemaErr;
    }
  }

  // Ensure PRAGMAs are set after DB is initialized or created
  try {
    dbInstance.run('PRAGMA journal_mode=WAL;'); // Recommended for sql.js if saving to file
    dbInstance.run('PRAGMA synchronous=NORMAL;'); // Good balance for file-based sql.js
    dbInstance.run('PRAGMA foreign_keys=ON;');
    logger.info('[SQLite Cache] Essential PRAGMAs (journal_mode, synchronous, foreign_keys) executed.');
  } catch (pragmaErr: any) {
    logger.error({ err: String(pragmaErr) }, '[SQLite Cache] Failed to execute PRAGMAs.');
    // Not throwing here, as DB might still be usable for some operations
  }
  
  // TODO: Add startup checks from spec (integrity, encryption, owner, schema version)

  return dbInstance;
}

export function getDB(): SqlJsDatabase {
  if (!dbInstance) {
    logger.error('[SQLite Cache] getDB called before cache was initialized.');
    throw new Error('Cache not initialised; call initializeCache() first');
  }
  return dbInstance;
}

export function closeCache(): void {
  if (!dbInstance) {
    logger.debug('[SQLite Cache] closeCache called but no DB instance exists.');
    return;
  }
  try {
    const data = dbInstance.export();
    const filePath = cacheFilePath(); // Get path again in case it could change (though unlikely here)
    fs.writeFileSync(filePath, data);
    logger.info({ file: filePath }, '[SQLite Cache] Cache DB saved to disk.');
  } catch (writeError) {
    logger.error({ err: writeError, file: cacheFilePath() }, '[SQLite Cache] Failed to save cache DB to disk on close.');
  }
  
  dbInstance.close();
  dbInstance = null; // Clear the instance
  logger.info('[SQLite Cache] Cache DB closed and instance cleared.');
}

function createSchema(db: SqlJsDatabase): void {
  logger.debug('[SQLite Cache] Creating database schema...');
  db.run(`
    CREATE TABLE IF NOT EXISTS notes (
      id   TEXT PRIMARY KEY NOT NULL,
      txt  TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]', -- Stored as JSON string array
      crt_at INTEGER NOT NULL, -- Unix epoch seconds
      mod_at INTEGER NOT NULL, -- Unix epoch seconds
      l_ver INTEGER NOT NULL DEFAULT 1, -- Local version, starts at 1, increments on local change
      s_ver INTEGER, -- Simperium version (optional, from backend)
      trash INTEGER NOT NULL DEFAULT 0, -- Boolean (0 or 1)
      sync_deleted INTEGER NOT NULL DEFAULT 0 -- Added: To track if delete was confirmed by sync
    );

    CREATE INDEX IF NOT EXISTS idx_notes_mod_at ON notes(mod_at);
    CREATE INDEX IF NOT EXISTS idx_notes_trash ON notes(trash);

    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      txt, tags, -- Columns to be indexed from 'notes' table
      content='notes', -- Source table for content
      content_rowid='rowid', -- Links FTS table rowid to 'notes' table rowid
      tokenize='porter unicode61 remove_diacritics 1' -- Porter stemmer, Unicode 6.1 support, remove diacritics
    );

    -- Triggers to keep FTS table synchronized with notes table
    CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts(rowid, txt, tags) VALUES (new.rowid, new.txt, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, txt, tags) VALUES ('delete', old.rowid, old.txt, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, txt, tags) VALUES ('delete', old.rowid, old.txt, old.tags);
      INSERT INTO notes_fts(rowid, txt, tags) VALUES (new.rowid, new.txt, new.tags);
    END;

    CREATE TABLE IF NOT EXISTS sync_metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT
    );

    -- Initialize some default metadata values if they don't exist
    -- This helps in having a consistent state for the UI or metrics later
    INSERT OR IGNORE INTO sync_metadata (key, value) VALUES ('last_sync_start_ts', '0');
    INSERT OR IGNORE INTO sync_metadata (key, value) VALUES ('last_sync_end_ts', '0');
    INSERT OR IGNORE INTO sync_metadata (key, value) VALUES ('last_sync_error', '');
    INSERT OR IGNORE INTO sync_metadata (key, value) VALUES ('total_notes_synced', '0');
    INSERT OR IGNORE INTO sync_metadata (key, value) VALUES ('notes_added_last_sync', '0');
    INSERT OR IGNORE INTO sync_metadata (key, value) VALUES ('notes_updated_last_sync', '0');
    INSERT OR IGNORE INTO sync_metadata (key, value) VALUES ('notes_deleted_locally_last_sync', '0');
  `);
  logger.info('[SQLite Cache] Database schema created/verified with default metadata.');
}



