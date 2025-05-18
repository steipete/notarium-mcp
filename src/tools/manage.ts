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
import path from 'path';
import { z } from 'zod';
import {
  getSimperiumApiClient,
  saveNote as simperiumSaveNote,
  SimperiumNotePayload,
} from '../backend/simperium-api.js';

// Helper function to get DB file path (similar to one in cache/sqlite.ts, consider centralizing)
function getDbFilePathInternal(): string {
  const dbFileName = appConfig.DB_ENCRYPTION_KEY
    ? 'notarium_cache.sqlite.encrypted'
    : 'notarium_cache.sqlite';
  return path.resolve(process.cwd(), dbFileName);
}

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

  switch (params.act) {
    case 'get_stats': {
      try {
        const dbFileSize = fs.statSync(getDbFilePathInternal()).size;
        const dbTotalNotes = (
          db.prepare('SELECT COUNT(*) as count FROM notes').get() as { count: number }
        ).count;
        const lastSuccessfulSyncAtRow = db
          .prepare("SELECT value FROM sync_metadata WHERE key = 'last_successful_sync_at'")
          .get() as { value: string } | undefined;
        const lastSyncDurationMsRow = db
          .prepare("SELECT value FROM sync_metadata WHERE key = 'last_sync_duration_ms'")
          .get() as { value: string } | undefined;
        const lastSyncStatusRow = db
          .prepare("SELECT value FROM sync_metadata WHERE key = 'last_sync_status'")
          .get() as { value: string } | undefined;
        const syncErrorCountRow = db
          .prepare("SELECT value FROM sync_metadata WHERE key = 'sync_error_count'")
          .get() as { value: string } | undefined;
        const backendCursorRow = db
          .prepare("SELECT value FROM sync_metadata WHERE key = 'backend_cursor'")
          .get() as { value: string } | undefined;
        const dbSchemaVersion = db.pragma('user_version', { simple: true }) as number;

        const stats: z.infer<typeof ServerStatsSchema> = {
          mcp_notarium_version: currentConfig.MCP_NOTARIUM_VERSION,
          node_version: currentConfig.NODE_VERSION,
          memory_rss_mb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
          db_encryption: currentConfig.DB_ENCRYPTION_KEY ? 'enabled' : 'disabled',
          db_file_size_mb: Math.round((dbFileSize / (1024 * 1024)) * 100) / 100, // MB with 2 decimal places
          db_total_notes: dbTotalNotes,
          db_last_sync_at: lastSuccessfulSyncAtRow
            ? parseFloat(lastSuccessfulSyncAtRow.value)
            : null,
          db_sync_duration_ms: lastSyncDurationMsRow
            ? parseInt(lastSyncDurationMsRow.value, 10)
            : undefined,
          db_sync_status: lastSyncStatusRow?.value || syncService.getSyncStats().lastSyncStatus, // Fallback to live service status
          db_sync_error_count: syncErrorCountRow
            ? parseInt(syncErrorCountRow.value, 10)
            : syncService.getSyncStats().consecutiveErrorCount,
          db_schema_version: dbSchemaVersion,
          backend_cursor: backendCursorRow?.value || null,
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
        // 1. Close the database connection if open (from the main cache module perspective)
        //    This is tricky as this tool handler receives the DB instance.
        //    The ideal way is to signal the main cache module to close and delete.
        //    For now, we close the passed instance and delete files directly.
        if (db.open) {
          db.close();
          logger.info('MANAGE TOOL: Closed DB connection before reset.');
        }
        // 2. Delete database files
        deleteDatabaseFilesInternal(getDbFilePathInternal());
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
      const { id: noteIdToToggleTrash, l_ver: noteLverToToggle } = params as ManageInput & {
        act: 'trash' | 'untrash';
      }; // Type assertion
      if (!noteIdToToggleTrash || noteLverToToggle === undefined) {
        throw new NotariumValidationError(
          'Note ID and l_ver are required for trash/untrash actions.',
          'Note ID or version missing for trash/untrash.',
        );
      }

      const noteToToggle = db
        .prepare('SELECT * FROM notes WHERE id = ? AND l_ver = ?')
        .get(noteIdToToggleTrash, noteLverToToggle) as any;
      if (!noteToToggle) {
        throw new NotariumResourceNotFoundError(
          `Note with id '${noteIdToToggleTrash}' and version ${noteLverToToggle} not found for action '${params.act}'.`,
          'Note not found.',
        );
      }

      const newTrashStatusFlag = params.act === 'trash';
      const now = Math.floor(Date.now() / 1000);

      const simperiumPayload: SimperiumNotePayload = {
        // We must send the full content when updating via Simperium POST to /v/ endpoint, even if only changing metadata.
        // If content is not sent, Simperium might interpret it as clearing the content.
        content: noteToToggle.txt,
        tags: JSON.parse(noteToToggle.tags || '[]'), // Send existing tags
        deleted: newTrashStatusFlag,
        modificationDate: now,
        // creationDate should not be resent for updates typically
      };

      try {
        const savedSimperiumNote = await simperiumSaveNote(
          SIMPERIUM_NOTE_BUCKET,
          noteIdToToggleTrash,
          simperiumPayload,
          noteToToggle.s_ver === null ? undefined : noteToToggle.s_ver, // Use existing s_ver as baseVersion
        );

        const newLocalVersionToggle = noteToToggle.l_ver + 1;
        const newServerVersionToggle = savedSimperiumNote.version;

        db.prepare('UPDATE notes SET trash = ?, s_ver = ?, l_ver = ? WHERE id = ?').run(
          newTrashStatusFlag ? 1 : 0,
          newServerVersionToggle,
          newLocalVersionToggle,
          noteIdToToggleTrash,
        );

        logger.info(
          `Note ${noteIdToToggleTrash} '${params.act}' processed. New s_ver: ${newServerVersionToggle}, new l_ver: ${newLocalVersionToggle}`,
        );
        return ManageNoteActionOutputSchema.parse({
          id: noteIdToToggleTrash,
          status: params.act === 'trash' ? 'trashed' : 'untrashed',
          new_l_ver: newLocalVersionToggle,
          new_s_ver: newServerVersionToggle,
        });
      } catch (error) {
        // Error handling similar to handleSave, specific to this action
        logger.error(
          { err: error, noteId: noteIdToToggleTrash, action: params.act },
          `Error during '${params.act}' action for note.`,
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
          `Unexpected error during '${params.act}' for note ${noteIdToToggleTrash}.`,
          'Internal server error processing note action.',
          undefined,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }

    case 'delete_permanently': {
      const { id: noteIdToDelete, l_ver: noteLverToDelete } = params as ManageInput & {
        act: 'delete_permanently';
      }; // Type assertion
      // V1: Local delete only, as per spec.
      // Future: Could call a Simperium DELETE endpoint: await apiClient.delete(`i/${noteIdToDelete}/v/${noteToModify.s_ver}`)
      //         This would require careful handling of the response and ensuring the server actually hard deletes.
      logger.info(
        `Manage tool: delete_permanently action for note ${noteIdToDelete} (local delete only in V1).`,
      );
      const noteToDelete = db
        .prepare('SELECT id FROM notes WHERE id = ? AND l_ver = ?')
        .get(noteIdToDelete, noteLverToDelete);
      if (!noteToDelete) {
        throw new NotariumResourceNotFoundError(
          `Note with id '${noteIdToDelete}' and version ${noteLverToDelete} not found for permanent deletion.`,
          'Note not found.',
        );
      }
      try {
        db.transaction(() => {
          db.prepare('DELETE FROM notes WHERE id = ?').run(noteIdToDelete);
          db.prepare('DELETE FROM notes_fts WHERE id = ?').run(noteIdToDelete);
        });
        logger.info(`Note ${noteIdToDelete} deleted permanently from local cache.`);
        return ManageNoteActionOutputSchema.parse({
          id: noteIdToDelete,
          status: 'deleted',
          // No new_l_ver or new_s_ver as it\'s gone locally
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
      // This should be caught by Zod union parsing if params.act is invalid.
      // But as a fallback:
      // const exhaustiveCheck: never = params; // Removed for now
      throw new NotariumValidationError(
        `Invalid manage action: ${(params as any).act}`,
        'Unknown management action specified.',
      );
  }
}

logger.info('Tool handler: manage defined, trash/untrash use saveNote logic.');
