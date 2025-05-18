import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config.js';
import logger from '../logging.js';
import { NotariumDbError, NotariumInternalError } from '../errors.js';

const CURRENT_APP_SCHEMA_VERSION = 1;
let db: DB;
let newDbGeneratedSaltHex: string | null = null; // To pass salt from keying to createTables

// As per spec: A hard-coded, unique, long, random string constant
// const OWNER_IDENTITY_SALT = "MCPNotarium_SimplenoteUserSalt_v1_a7b3c9d8e2f1"; // This is already in config.ts

function getDbFilePath(): string {
  const dbFileName = config.DB_ENCRYPTION_KEY
    ? 'notarium_cache.sqlite.encrypted'
    : 'notarium_cache.sqlite';
  return path.resolve(process.cwd(), dbFileName);
}

function deleteDatabaseFiles(dbFilePath: string): void {
  logger.info(`Deleting database files associated with ${dbFilePath}`);
  const filesToDelete = [dbFilePath, `${dbFilePath}-wal`, `${dbFilePath}-shm`];
  for (const file of filesToDelete) {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        logger.debug(`Deleted ${file}`);
      }
    } catch (err) {
      logger.warn(
        { err, file },
        `Failed to delete database file ${file}. It might be locked or already removed.`,
      );
    }
  }
}

async function generateOwnerIdentityHash(): Promise<string> {
  if (!config.SIMPLENOTE_USERNAME) {
    throw new NotariumInternalError(
      'SIMPLENOTE_USERNAME is not configured for owner identity hash generation.',
    );
  }
  const sha256 = crypto.createHash('sha256');
  sha256.update(config.SIMPLENOTE_USERNAME + config.OWNER_IDENTITY_SALT);
  return sha256.digest('hex');
}

async function createTables(): Promise<void> {
  logger.info('Creating new database tables and metadata...');
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const saltToStore = newDbGeneratedSaltHex;
      newDbGeneratedSaltHex = null;
      const ownerHash = await generateOwnerIdentityHash();
      
      // First create sync_metadata table and commit it immediately to ensure it exists
      db.exec('BEGIN;');
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_metadata (
          key TEXT PRIMARY KEY,
          value TEXT
        );
      `);
      db.exec('COMMIT;');
      
      // Now insert into sync_metadata in a separate transaction
      db.exec('BEGIN;');
      db.prepare("INSERT OR REPLACE INTO sync_metadata (key, value) VALUES ('owner_identity_hash', ?)").run(ownerHash);
      if (saltToStore && config.DB_ENCRYPTION_KEY) {
        db.prepare("INSERT OR REPLACE INTO sync_metadata (key, value) VALUES ('db_key_salt_hex', ?)").run(saltToStore);
        logger.info({ salt: saltToStore }, 'Stored new db_key_salt_hex for encrypted database.');
      }
      db.exec('COMMIT;');
      
      // Create other tables
      db.exec('BEGIN;');
      db.exec(`
        CREATE TABLE IF NOT EXISTS notes (
          id TEXT PRIMARY KEY,
          l_ver INTEGER NOT NULL DEFAULT 0, 
          s_ver INTEGER,                    
          txt TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '[]',  
          mod_at INTEGER NOT NULL,          
          crt_at INTEGER,                   
          trash INTEGER NOT NULL DEFAULT 0, 
          sync_deleted INTEGER NOT NULL DEFAULT 0 
        );
        CREATE INDEX IF NOT EXISTS idx_notes_mod_at ON notes (mod_at);
        CREATE INDEX IF NOT EXISTS idx_notes_trash ON notes (trash);
      `);
      db.exec('COMMIT;');
      
      // Create FTS table in a separate transaction
      db.exec('BEGIN;');
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
          id UNINDEXED, 
          txt,          
          tokenize = 'porter unicode61 remove_diacritics 1'
        );
      `);
      db.exec('COMMIT;');
      
      // Finally create the triggers in a separate transaction
      db.exec('BEGIN;');
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
          INSERT INTO notes_fts (rowid, id, txt) VALUES (new.rowid, new.id, new.txt);
        END;
        CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
          INSERT INTO notes_fts (notes_fts, rowid, id, txt) VALUES ('delete', old.rowid, old.id, old.txt);
        END;
        CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
          INSERT INTO notes_fts (notes_fts, rowid, id, txt) VALUES ('delete', old.rowid, old.id, old.txt);
          INSERT INTO notes_fts (rowid, id, txt) VALUES (new.rowid, new.id, new.txt);
        END;
      `);
      
      // Set schema version
      db.pragma(`user_version = ${CURRENT_APP_SCHEMA_VERSION}`);
      db.exec('COMMIT;');
      
      logger.info('Database tables created and metadata initialized.');
      break;
    } catch (error) {
      logger.warn({ err: error, attempt }, 'Error creating database tables. Purging DB and retrying.');
      if (db.inTransaction) {
        try {
          db.exec('ROLLBACK;');
        } catch (rollbackError) {
          logger.error({ err: rollbackError }, 'Error during rollback after table creation failure');
        }
      }
      deleteDatabaseFiles(db.name);
      db.close();
      db = new (db.constructor as any)(db.name, {
        verbose: config.LOG_LEVEL === 'trace' ? logger.trace.bind(logger) : undefined,
      });
      // If encrypted, reapply keying
      if (config.DB_ENCRYPTION_KEY) {
        applyEncryptionKeyPragmas(db, true);
      }
    }
  }
}

// Function to apply encryption keying PRAGMAs
function applyEncryptionKeyPragmas(dbInstance: DB, isNewDb: boolean) {
  if (!config.DB_ENCRYPTION_KEY) return; // Should not happen if encryptionEnabled is true

  const passphrase = config.DB_ENCRYPTION_KEY.replace(/"/g, '""'); // Escape quotes for PRAGMA
  dbInstance.pragma(`kdf_iter = ${config.DB_ENCRYPTION_KDF_ITERATIONS}`);

  if (isNewDb) {
    const saltHex = crypto.randomBytes(16).toString('hex');
    newDbGeneratedSaltHex = saltHex; // Store for createTables to persist
    // SQLCipher's cipher_kdf_salt pragma expects the salt as a hex string prefixed with '0x'
    dbInstance.pragma(`cipher_kdf_salt = '0x${saltHex}'`);
    logger.info('Applied KDF iterations and new KDF salt for new encrypted DB.');
  } else {
    // For existing DBs, SQLCipher uses the KDF salt that was set at its creation.
    // We set kdf_iter to ensure our configured iteration count is attempted if it matches creation.
    // We don't set cipher_kdf_salt here as we can't read it before keying.
    logger.debug('Applied KDF iterations for existing encrypted DB.');
  }
  dbInstance.pragma(`key = "${passphrase}"`);
  dbInstance.pragma('cipher_compatibility = 4');
}

export async function initializeCache(): Promise<DB> {
  if (db && db.open) return db;
  const dbFilePath = getDbFilePath();
  const dbDir = path.dirname(dbFilePath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  const encryptionEnabled = !!config.DB_ENCRYPTION_KEY;
  logger.info(
    `Initializing local cache. Path: ${dbFilePath}, Encryption: ${encryptionEnabled ? 'Enabled' : 'Disabled'}`,
  );
  let SQLCipherDB;
  if (encryptionEnabled) {
    try {
      SQLCipherDB = (await import('better-sqlite3-sqlcipher')).default;
      logger.info('better-sqlite3-sqlcipher loaded successfully.');
    } catch (e) {
      logger.fatal(
        { err: e },
        'Failed to load better-sqlite3-sqlcipher. DB_ENCRYPTION_KEY is set but package unavailable. Install it or disable DB encryption.',
      );
      process.exit(1);
    }
  }
  const DBConstructor = encryptionEnabled && SQLCipherDB ? SQLCipherDB : Database;
  let attempt = 0;
  while (true) {
    attempt++;
    let newDbRequired = false;
    try {
      db = new DBConstructor(dbFilePath, {
        verbose: config.LOG_LEVEL === 'trace' ? logger.trace.bind(logger) : undefined,
      });
      if (encryptionEnabled) {
        applyEncryptionKeyPragmas(db, false);
        try {
          db.pragma('cipher_version');
          logger.info('SQLCipher key applied and database accessed successfully (existing DB).');
        } catch (keyError) {
          logger.warn({ err: keyError }, 'Failed to apply SQLCipher key or verify (existing DB).');
          const err = keyError as Error;
          if (
            err.message.includes('file is not a database') ||
            err.message.toLowerCase().includes('sqliteerror: file is not a database')
          ) {
            logger.info('Decryption failed. Assuming new/corrupt DB. Deleting and recreating.');
            db.close();
            deleteDatabaseFiles(dbFilePath);
            newDbRequired = true;
            db = new DBConstructor(dbFilePath, {
              verbose: config.LOG_LEVEL === 'trace' ? logger.trace.bind(logger) : undefined,
            });
            applyEncryptionKeyPragmas(db, true);
            db.pragma('user_version = 0');
            logger.info('New encrypted database initialized after decryption failure.');
          } else {
            throw keyError;
          }
        }
      }
      if (!newDbRequired) {
        db.pragma('integrity_check');
        logger.info('Database integrity check passed.');
      }
    } catch (err) {
      logger.warn(
        { err, dbFilePath, attempt },
        'Initial DB open/integrity check failed. Deleting and recreating.',
      );
      if (db && db.open) db.close();
      deleteDatabaseFiles(dbFilePath);
      newDbRequired = true;
      db = new DBConstructor(dbFilePath, {
        verbose: config.LOG_LEVEL === 'trace' ? logger.trace.bind(logger) : undefined,
      });
      if (encryptionEnabled) {
        applyEncryptionKeyPragmas(db, true);
        db.pragma('user_version = 0');
        logger.info('New encrypted database initialized after open failure.');
      } else {
        logger.info('New unencrypted database initialized after open failure.');
      }
    }
    // --- Startup Checks (as per spec, refined) ---
    const actualEncryptedFilePath = encryptionEnabled
      ? dbFilePath
      : path.resolve(process.cwd(), 'notarium_cache.sqlite.encrypted');
    if (
      !encryptionEnabled &&
      fs.existsSync(actualEncryptedFilePath) &&
      dbFilePath !== actualEncryptedFilePath
    ) {
      logger.fatal(
        `Unencrypted mode active, but an encrypted DB file '${actualEncryptedFilePath}' exists. Remove or set DB_ENCRYPTION_KEY.`,
      );
      process.exit(1);
    }
    if (!encryptionEnabled && !newDbRequired && fs.existsSync(dbFilePath)) {
      logger.warn('DB is unencrypted. Set DB_ENCRYPTION_KEY for enhanced security.');
    }
    let ownerIdentityHashInDb: string | undefined;
    let dbSchemaVersion = 0;
    if (!newDbRequired && fs.existsSync(dbFilePath) && fs.statSync(dbFilePath).size > 0) {
      try {
        dbSchemaVersion = db.pragma('user_version', { simple: true }) as number;
        const tableCheck = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_metadata'")
          .get();
        if (tableCheck) {
          const ownerRow = db
            .prepare("SELECT value FROM sync_metadata WHERE key = 'owner_identity_hash'")
            .get() as { value: string } | undefined;
          ownerIdentityHashInDb = ownerRow?.value;
        } else if (dbSchemaVersion > 0) {
          logger.warn('DB has schema version but sync_metadata table is missing. Resetting.');
          newDbRequired = true;
        }
      } catch (metaError) {
        logger.warn(
          { err: metaError, attempt },
          'Failed to read metadata from existing DB. Assuming new DB required if not already flagged.',
        );
        newDbRequired = true;
      }
    }
    if (newDbRequired && db && db.open) db.close();
    if (newDbRequired && fs.existsSync(dbFilePath)) deleteDatabaseFiles(dbFilePath);
    if (newDbRequired && (!db || !db.open)) {
      db = new DBConstructor(dbFilePath, {
        verbose: config.LOG_LEVEL === 'trace' ? logger.trace.bind(logger) : undefined,
      });
      if (encryptionEnabled) {
        applyEncryptionKeyPragmas(db, true);
      }
    }
    if (!newDbRequired) {
      logger.info(
        `Existing DB schema version: ${dbSchemaVersion}, App schema version: ${CURRENT_APP_SCHEMA_VERSION}`,
      );
      const notesTableExists =
        (
          db
            .prepare(
              "SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name = 'notes'",
            )
            .get() as { count: number }
        ).count > 0;
      if (dbSchemaVersion === 0 && notesTableExists) {
        logger.warn('DB schema version is 0 but tables exist. Reset required.');
        newDbRequired = true;
      } else if (dbSchemaVersion < CURRENT_APP_SCHEMA_VERSION && dbSchemaVersion !== 0) {
        logger.warn(
          `DB schema (${dbSchemaVersion}) is older than app schema (${CURRENT_APP_SCHEMA_VERSION}). Resetting cache.`,
        );
        newDbRequired = true;
      } else if (dbSchemaVersion > CURRENT_APP_SCHEMA_VERSION) {
        logger.warn(
          `DB schema (${dbSchemaVersion}) is newer than app schema (${CURRENT_APP_SCHEMA_VERSION}). Resetting cache.`,
        );
        newDbRequired = true;
      }
      const currentOwnerIdentityHash = await generateOwnerIdentityHash();
      if (ownerIdentityHashInDb && ownerIdentityHashInDb !== currentOwnerIdentityHash) {
        logger.info('DB owner mismatch. Resetting cache.');
        newDbRequired = true;
      }
      if (!ownerIdentityHashInDb && dbSchemaVersion > 0 && notesTableExists) {
        logger.warn('Existing DB has schema but no owner hash. Resetting.');
        newDbRequired = true;
      }
    }
    if (newDbRequired) {
      logger.info({ attempt }, 'New database creation or full reset required.');
      if (db && db.open && path.basename(db.name) !== path.basename(dbFilePath)) {
        db.close();
        db = new DBConstructor(dbFilePath, {
          verbose: config.LOG_LEVEL === 'trace' ? logger.trace.bind(logger) : undefined,
        });
      } else if (!db || !db.open) {
        db = new DBConstructor(dbFilePath, {
          verbose: config.LOG_LEVEL === 'trace' ? logger.trace.bind(logger) : undefined,
        });
      }
      if (encryptionEnabled && !db.pragma('cipher_version', { simple: true })) {
        applyEncryptionKeyPragmas(db, true);
      }
      await createTables();
      (global as any).fullResyncRequiredByReset = true;
      logger.info({ attempt }, 'New database created and initialized.');
    } else {
      logger.info('Existing database passes startup checks.');
      
      // Ensure essential tables exist even for existing databases
      // This ensures we don't get "no such table" errors in TEST_MODE or with empty databases
      const notesTableExists =
        (
          db
            .prepare(
              "SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name = 'notes'",
            )
            .get() as { count: number }
        ).count > 0;
      
      if (!notesTableExists) {
        logger.info('Required tables missing. Creating essential schema...');
        await createTables();
        logger.info('Schema created for existing database.');
      }
    }
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('foreign_keys = ON');
      logger.debug('Standard PRAGMAs applied.');
    } catch (pragmaErr) {
      logger.error({ err: pragmaErr }, 'Failed to apply standard PRAGMAs.');
    }
    logger.info('Local cache initialization complete.');
    return db;
  }
}

export function getDB(): DB {
  if (!db || !db.open) {
    throw new NotariumInternalError(
      'Database not initialized or closed. Call initializeCache first.',
    );
  }
  return db;
}

export async function closeCache(): Promise<void> {
  if (db && db.open) {
    logger.info('Closing database connection...');
    db.close();
    logger.info('Database connection closed.');
  }
  newDbGeneratedSaltHex = null; // Clear on close too
}

// Example usage (not for direct execution here, but for testing or reference)
// async function test() {
//   config.SIMPLENOTE_USERNAME = 'test@example.com'; // Mock config
//   // config.DB_ENCRYPTION_KEY = 'testkey'; // Uncomment to test encryption
//   await initializeCache();
//   const notes = getDB().prepare("SELECT * FROM notes").all();
//   logger.info({ notes }, "Current notes");
//   await closeCache();
// }
// test().catch(console.error);
