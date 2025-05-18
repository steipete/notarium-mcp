import type { DB } from '../cache/sqlite.js';
// import type { AxiosInstance, AxiosError } from 'axios'; // Removed as unused directly
import {
  ManageInput,
  ManageOutput,
  ServerStatsSchema,
  ManageGetStatsOutputSchema,
  ManageResetCacheOutputSchema,
  ManageNoteActionOutputSchema,
} from '../schemas.js';
import logger from '../logging.js';
import { config as appConfig, AppConfig } from '../config.js';
import { BackendSyncService } from '../sync/sync-service.js';
import {
  NotariumValidationError,
  NotariumDbError,
  NotariumResourceNotFoundError,
  NotariumBackendError,
  NotariumInternalError,
} from '../errors.js';
import fs from 'fs';
// import path from 'path'; // path might become unused, will check
import { z } from 'zod';
import {
  // getSimperiumApiClient, // This was commented out in original snippet
  saveNote as simperiumSaveNote,
  SimperiumNotePayload,
} from '../backend/simperium-api.js';
import { cacheFilePath } from '../cache/sqlite.js'; // Import the correct path function

// Helper function to get DB file path - REMOVED
// function getDbFilePathInternal(): string {
//   const dbFileName = appConfig.DB_ENCRYPTION_KEY
//     ? 'notarium_cache.sqlite.encrypted'
//     : 'notarium_cache.sqlite';
//   return path.resolve(process.cwd(), dbFileName);
// }

function deleteDatabaseFilesInternal(dbFilePath: string): void {
  logger.info(`MANAGE TOOL: Deleting database files associated with ${dbFilePath}`);
  const filesToDelete = [dbFilePath, `${dbFilePath}-wal`, `${dbFilePath}-shm`];
  for (const file of filesToDelete) {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        logger.debug(`MANAGE TOOL: Deleted ${file}`);
      }
    } catch (err) {
      logger.warn({ err, file }, `MANAGE TOOL: Failed to delete database file ${file}.`);
    }
  }
}

const SIMPERIUM_NOTE_BUCKET = 'note'; // Add bucket name

/**
 * Handles the 'manage' tool invocation.
 * As per Spec 10.4.
 */
export async function handleManage(
  params: ManageInput,
  db: DB,
  syncService: BackendSyncService,
  currentConfig: AppConfig, // Pass current config for version info etc.
): Promise<ManageOutput> {
  logger.debug({ params }, 'Handling manage tool request');

  switch (params.action) {
    case 'get_stats': {
      try {
        const dbFilePathResolved = cacheFilePath(); // Use the correct path function
        const dbFileSize = fs.statSync(dbFilePathResolved).size;
        
        let dbTotalNotes = 0;
        const countStmt = db.prepare('SELECT COUNT(*) as count FROM notes');
        if (countStmt.step()) {
          const row = countStmt.getAsObject() as { count: number };
          dbTotalNotes = row.count;
        }
        countStmt.free();

        const getMetaValue = (key: string): string | undefined => {
          const stmt = db.prepare("SELECT value FROM sync_metadata WHERE key = :key");
          stmt.bind({ ':key': key });
          let value: string | undefined;
          if (stmt.step()) {
            const row = stmt.getAsObject() as { value: string };
            value = row.value;
          }
          stmt.free();
          return value;
        };

        const lastSuccessfulSyncAtRow = getMetaValue('last_successful_sync_at');
        const lastSyncDurationMsRow = getMetaValue('last_sync_duration_ms');
        const lastSyncStatusRow = getMetaValue('last_sync_status');
        const syncErrorCountRow = getMetaValue('sync_error_count');
        const backendCursorRow = getMetaValue('backend_cursor');
        
        let db_schema_version_val = 0;
        const versionQueryRes = db.exec("PRAGMA user_version");
        if (versionQueryRes.length > 0 && versionQueryRes[0].values.length > 0) {
            db_schema_version_val = versionQueryRes[0].values[0][0] as number;
        }

        const stats: z.infer<typeof ServerStatsSchema> = {
          mcp_notarium_version: currentConfig.MCP_NOTARIUM_VERSION,
          node_version: currentConfig.NODE_VERSION,
          memory_rss_mb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
          db_encryption: currentConfig.DB_ENCRYPTION_KEY ? 'enabled' : 'disabled',
          db_file_size_mb: Math.round((dbFileSize / (1024 * 1024)) * 100) / 100, // MB with 2 decimal places
          db_total_notes: dbTotalNotes,
          db_last_sync_at: lastSuccessfulSyncAtRow
            ? parseInt(lastSuccessfulSyncAtRow, 10)
            : null,
          db_sync_duration_ms: lastSyncDurationMsRow
            ? parseInt(lastSyncDurationMsRow, 10)
            : undefined,
          db_sync_status: lastSyncStatusRow || syncService.getSyncStats().lastSyncStatus, // Fallback to live service status
          db_sync_error_count: syncErrorCountRow
            ? parseInt(syncErrorCountRow, 10)
            : syncService.getSyncStats().consecutiveErrorCount,
          db_schema_version: db_schema_version_val,
          backend_cursor: backendCursorRow || null,
        };
        return ManageGetStatsOutputSchema.parse(stats);
      } catch (err) {
        logger.error({ err }, 'Error gathering server stats for manage tool');
        throw new NotariumInternalError(
          'Failed to gather server statistics.',
          'Internal error while getting stats.',
          undefined,
          err as Error,
        );
      }
    }

    case 'reset_cache': {
      logger.warn('Manage tool: reset_cache action invoked. This will delete the local database.');
      try {
        // For sql.js, db.close() makes the instance unusable. We don't check db.open.
        // The main cache module is responsible for re-initializing if needed.
        db.close(); 
        logger.info('MANAGE TOOL: Closed DB connection before reset.');
        
        deleteDatabaseFilesInternal(cacheFilePath()); // Use the correct path function
        // 3. Set global.fullResyncRequiredByReset = true (as per spec 10.4)
        (global as any).fullResyncRequiredByReset = true;
        logger.info(
          'MANAGE TOOL: Cache reset successfully. Full resync will be required on next start/sync.',
        );

        // Note: The application will likely need to re-initialize the cache (which creates a new DB)
        // on the next operation or restart. This handler doesn't restart the DB itself.
        return ManageResetCacheOutputSchema.parse({
          status: 'success',
          message: 'Local cache has been reset. A full resynchronization will occur.',
          full_resync_triggered: true,
        });
      } catch (err) {
        logger.error({ err }, 'Error resetting local cache');
        throw new NotariumInternalError(
          'Failed to reset local cache.',
          'Internal error during cache reset.',
          undefined,
          err as Error,
        );
      }
    }

    // Note actions: trash, untrash, delete_permanently
    case 'trash':
    case 'untrash': {
      const { id: noteIdToToggleTrash, local_version: noteLverToToggle } = params as ManageInput & {
        action: 'trash' | 'untrash';
      };
      if (!noteIdToToggleTrash || noteLverToToggle === undefined) {
        throw new NotariumValidationError(
          'Note ID and local_version are required for trash/untrash actions.',
          'Note ID or version missing for trash/untrash.',
        );
      }

      let noteToToggle: any;
      const stmtGetNote = db.prepare('SELECT * FROM notes WHERE id = :id AND local_version = :l_ver');
      stmtGetNote.bind({ ':id': noteIdToToggleTrash, ':l_ver': noteLverToToggle });
      if (stmtGetNote.step()) {
        noteToToggle = stmtGetNote.getAsObject();
      }
      stmtGetNote.free();

      if (!noteToToggle) {
        throw new NotariumResourceNotFoundError(
          `Note with id '${noteIdToToggleTrash}' and version ${noteLverToToggle} not found for action '${params.action}'.`,
          'Note not found.',
        );
      }

      const newTrashStatusFlag = params.action === 'trash';
      const now = Math.floor(Date.now() / 1000);

      const simperiumPayload: SimperiumNotePayload = {
        content: noteToToggle.txt,
        tags: JSON.parse(noteToToggle.tags || '[]'), 
        deleted: newTrashStatusFlag,
        modificationDate: now,
      };

      try {
        const savedSimperiumNote = await simperiumSaveNote(
          SIMPERIUM_NOTE_BUCKET,
          noteIdToToggleTrash,
          simperiumPayload,
          noteToToggle.server_version === null ? undefined : noteToToggle.server_version, // Use existing server_version as baseVersion
        );

        const newLocalVersionToggle = noteToToggle.local_version + 1;
        const newServerVersionToggle = savedSimperiumNote.version;

        const stmtUpdate = db.prepare('UPDATE notes SET trash = :trash, server_version = :s_ver, local_version = :l_ver WHERE id = :id');
        stmtUpdate.run({ ':trash': newTrashStatusFlag ? 1 : 0, ':s_ver': newServerVersionToggle, ':l_ver': newLocalVersionToggle, ':id': noteIdToToggleTrash });
        stmtUpdate.free();

        logger.info(
          `Note ${noteIdToToggleTrash} '${params.action}' processed. New server_version: ${newServerVersionToggle}, new local_version: ${newLocalVersionToggle}`,
        );
        return ManageNoteActionOutputSchema.parse({
          id: noteIdToToggleTrash,
          status: params.action === 'trash' ? 'trashed' : 'untrashed',
          new_local_version: newLocalVersionToggle,
          new_server_version: newServerVersionToggle,
        });
      } catch (error) {
        // Error handling similar to handleSave, specific to this action
        logger.error(
          { err: error, noteId: noteIdToToggleTrash, action: params.action },
          `Error during '${params.action}' action for note.`,
        );
        if (
          error instanceof NotariumBackendError ||
          error instanceof NotariumInternalError ||
          error instanceof NotariumResourceNotFoundError ||
          error instanceof NotariumValidationError
        ) {
          throw error;
        }
        throw new NotariumInternalError(
          `Unexpected error during '${params.action}' for note ${noteIdToToggleTrash}.`,
          'Internal server error processing note action.',
          undefined,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }

    case 'delete_permanently': {
      const { id: noteIdToDelete, local_version: noteLverToDelete } = params as ManageInput & {
        action: 'delete_permanently';
      };
      // V1: Local delete only, as per spec.
      // Future: Could call a Simperium DELETE endpoint: await apiClient.delete(`i/${noteIdToDelete}/v/${noteToModify.server_version}`)
      //         This would require careful handling of the response and ensuring the server actually hard deletes.
      logger.info(
        `Manage tool: delete_permanently action for note ${noteIdToDelete} (local delete only in V1).`,
      );
      let noteToDelete: any;
      const stmtGetDelNote = db.prepare('SELECT id FROM notes WHERE id = :id AND local_version = :l_ver');
      stmtGetDelNote.bind({ ':id': noteIdToDelete, ':l_ver': noteLverToDelete });
      if (stmtGetDelNote.step()) {
        noteToDelete = stmtGetDelNote.getAsObject();
      }
      stmtGetDelNote.free();
      
      if (!noteToDelete) {
        throw new NotariumResourceNotFoundError(
          `Note with id '${noteIdToDelete}' and version ${noteLverToDelete} not found for permanent deletion.`,
          'Note not found.',
        );
      }
      try {
        // For sql.js, transactions are managed by exec or multiple run statements if needed.
        // Here we just run them sequentially.
        const stmtDelNotes = db.prepare('DELETE FROM notes WHERE id = :id');
        stmtDelNotes.run({ ':id': noteIdToDelete });
        stmtDelNotes.free();

        const stmtDelFts = db.prepare('DELETE FROM notes_fts WHERE id = :id');
        stmtDelFts.run({ ':id': noteIdToDelete}); // Assuming notes_fts also uses 'id' as its link to notes.id
        stmtDelFts.free();
        
        logger.info(`Note ${noteIdToDelete} deleted permanently from local cache.`);
        return ManageNoteActionOutputSchema.parse({
          id: noteIdToDelete,
          status: 'deleted',
          // No new_local_version or new_server_version as it's gone locally
        });
      } catch (dbErr) {
        logger.error({ err: dbErr, id: noteIdToDelete }, 'DB error during permanent delete.');
        throw new NotariumDbError(
          'Failed to permanently delete note from local cache.',
          'Database error during permanent delete.',
          undefined,
          dbErr as Error,
        );
      }
    }

    default:
      // This should be caught by Zod union parsing if params.action is invalid.
      // But as a fallback:
      // const exhaustiveCheck: never = params; // Removed for now
      throw new NotariumValidationError(
        `Invalid manage action: ${(params as any).action}`,
        'Unknown management action specified.',
      );
  }
}

logger.info('Tool handler: manage defined, trash/untrash use saveNote logic.');
