import type { Database as DB } from 'better-sqlite3';
import { config } from '../config.js';
import logger from '../logging.js';
// Types are used for inference and instanceof checks, linter might warn if not directly instantiated.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import {
  getIndex,
  getNoteContent,
  SimperiumIndexResponse,
  SimperiumNoteResponseData,
} from '../backend/simperium-api.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
// The above comment is for the import line itself if SimperiumIndexResponse/SimperiumNoteResponseData are flagged.
// For NotariumBackendError and NotariumResourceNotFoundError specifically:
// NotariumResourceNotFoundError is used with instanceof.
// NotariumBackendError is used for typing re-thrown errors from API calls or in instanceof checks.
import { NotariumBackendError, NotariumResourceNotFoundError } from '../errors.js';
import { getDB } from '../cache/sqlite.js';

const FULL_SYNC_PAGE_SIZE = 100; // As per spec 8. Initial Full Sync PAGE_SIZE
const DELTA_SYNC_PAGE_SIZE = 500; // As per spec 8. Delta Sync PAGE_SIZE
const SIMPERIUM_NOTE_BUCKET = 'note'; // Simplenote uses 'note' bucket

export class BackendSyncService {
  private db: DB;
  private syncTimeoutId: NodeJS.Timeout | null = null;
  private isSyncing = false;
  private consecutiveErrorCount = 0;
  private static readonly MAX_CONSECUTIVE_ERRORS = 5; // Stop after 5 full cycle errors
  private lastSyncAttemptAt: number | null = null;
  private lastSuccessfulSyncAt: number | null = null;
  private lastSyncDurationMs: number | null = null;
  private lastSyncStatus = 'idle';

  constructor() {
    this.db = getDB(); // Get initialized DB instance
    logger.info('BackendSyncService instantiated.');
  }

  public start(): void {
    if (this.syncTimeoutId) {
      logger.warn('BackendSyncService already started or start called multiple times.');
      return;
    }
    logger.info('BackendSyncService starting periodic synchronization...');
    this.scheduleNextSync(0); // Start immediately
  }

  public async stop(): Promise<void> {
    if (this.syncTimeoutId) {
      clearTimeout(this.syncTimeoutId);
      this.syncTimeoutId = null;
      logger.info('BackendSyncService stopped. Pending sync cancelled.');
    }
    if (this.isSyncing) {
      logger.info(
        'BackendSyncService waiting for ongoing sync to complete before fully stopping...',
      );
      // Simple wait, could be more sophisticated with a promise
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  private scheduleNextSync(delayMs?: number): void {
    if (this.syncTimeoutId) {
      clearTimeout(this.syncTimeoutId);
    }
    const intervalSeconds = config.SYNC_INTERVAL_SECONDS;
    const delay = delayMs !== undefined ? delayMs : intervalSeconds * 1000;

    logger.info(`Scheduling next sync in ${delay / 1000} seconds.`);
    this.syncTimeoutId = setTimeout(async () => {
      await this.performSyncCycle();
      // Reschedule after completion, unless stopped by max errors
      if (this.consecutiveErrorCount < BackendSyncService.MAX_CONSECUTIVE_ERRORS) {
        this.scheduleNextSync();
      } else {
        logger.error('BackendSyncService stopped due to maximum consecutive errors.');
        this.lastSyncStatus = 'stopped (max errors)';
        this.updateSyncMetadata();
      }
    }, delay);
  }

  private async performSyncCycle(): Promise<void> {
    if (this.isSyncing) {
      logger.warn('Sync cycle already in progress. Skipping this scheduled run.');
      return;
    }
    this.isSyncing = true;
    this.lastSyncAttemptAt = Date.now() / 1000;
    this.lastSyncStatus = 'syncing';
    this.updateSyncMetadata();
    logger.info('Starting backend synchronization cycle...');

    const startTime = Date.now();
    try {
      const backendCursorRow = this.db
        .prepare("SELECT value FROM sync_metadata WHERE key = 'backend_cursor'")
        .get() as { value: string } | undefined;
      let backendCursor: string | null = backendCursorRow?.value || null;

      if ((global as any).fullResyncRequiredByReset) {
        logger.info('Full resync triggered by cache reset.');
        backendCursor = null; // Force full sync
        (global as any).fullResyncRequiredByReset = false; // Reset flag
      }

      if (!backendCursor) {
        logger.info('No backend cursor found. Performing initial full synchronization.');
        await this.performFullSync();
      } else {
        logger.info(`Performing delta synchronization from cursor: ${backendCursor}`);
        await this.performDeltaSync(backendCursor);
      }

      this.lastSuccessfulSyncAt = Date.now() / 1000;
      this.consecutiveErrorCount = 0;
      this.lastSyncStatus = 'idle (success)';
      logger.info('Backend synchronization cycle completed successfully.');
    } catch (error) {
      this.consecutiveErrorCount++;
      this.lastSyncStatus = `error (attempt ${this.consecutiveErrorCount})`;
      logger.error(
        { err: error, consecutiveErrors: this.consecutiveErrorCount },
        'Error during backend synchronization cycle.',
      );
      // Exponential backoff for *full sync cycle* failures (as per spec 8.6)
      if (this.consecutiveErrorCount < BackendSyncService.MAX_CONSECUTIVE_ERRORS) {
        const backoffDelaySeconds = Math.pow(2, this.consecutiveErrorCount) * 60; // e.g., 60s, 120s, 240s...
        logger.info(`Scheduling retry with exponential backoff: ${backoffDelaySeconds} seconds.`);
        this.scheduleNextSync(backoffDelaySeconds * 1000);
        // This return prevents the default rescheduling in the calling setTimeout block
        this.isSyncing = false;
        this.lastSyncDurationMs = Date.now() - startTime;
        this.updateSyncMetadata();
        return;
      }
    } finally {
      this.isSyncing = false;
      this.lastSyncDurationMs = Date.now() - startTime;
      this.updateSyncMetadata();
    }
  }

  private async performFullSync(): Promise<void> {
    logger.info('Starting full sync...');
    let currentMark: string | undefined = undefined;
    let notesProcessedTotal = 0;
    let finalCursor: string | null = null;
    let indexResponse: SimperiumIndexResponse | undefined = undefined; // Declare here for loop condition

    do {
      logger.debug({ mark: currentMark }, 'Full sync: Fetching index page.');
      indexResponse = await getIndex({
        bucketName: SIMPERIUM_NOTE_BUCKET,
        mark: currentMark,
        limit: FULL_SYNC_PAGE_SIZE,
        data: false,
      });

      finalCursor = indexResponse.current;

      if (!indexResponse.index || indexResponse.index.length === 0) {
        logger.info('Full sync: No more items in index to process for this page.');
        if (!currentMark) {
          logger.info('Full sync: Index is empty.');
        }
        break;
      }

      let notesProcessedThisPage = 0;
      for (const entry of indexResponse.index) {
        await this.fetchAndProcessSimperiumEntry(entry.id, entry.v);
        notesProcessedThisPage++;
      }
      notesProcessedTotal += notesProcessedThisPage;
      logger.info(
        `Full sync: Processed page with ${notesProcessedThisPage} notes. Total so far: ${notesProcessedTotal}. Next cursor: ${finalCursor}`,
      );

      currentMark = finalCursor;
    } while (currentMark); // Loop as long as Simperium provides a next cursor/mark

    if (finalCursor) {
      this.db
        .prepare("INSERT OR REPLACE INTO sync_metadata (key, value) VALUES ('backend_cursor', ?)")
        .run(finalCursor);
      logger.info(`Full sync completed. Stored final backend cursor: ${finalCursor}`);
    } else {
      // This case (no final cursor after processing items) would be unusual if indexResponse.index had items.
      // If the index was empty from the start, finalCursor would be the initial (null/undefined) current from first empty response.
      logger.info('Full sync completed. No new backend cursor, or index was empty.');
    }
  }

  private async performDeltaSync(sinceCursor: string): Promise<void> {
    logger.info(`Starting delta sync since cursor: ${sinceCursor}`);
    let notesProcessed = 0;

    // For delta sync, we usually get all changes since the cursor in one go, but Simperium might still paginate if many changes.
    // The `getIndex` will handle one page. The loop here is more conceptual unless `getIndex` itself handles pagination internally.
    // Simperium's `since` typically returns all changes and a new `current` cursor.

    const indexResponse = await getIndex({
      bucketName: SIMPERIUM_NOTE_BUCKET,
      since: sinceCursor,
      limit: DELTA_SYNC_PAGE_SIZE,
      data: false,
    });

    if (!indexResponse.index || indexResponse.index.length === 0) {
      logger.info('Delta sync: No changes since last cursor.');
      if (indexResponse.current) {
        this.db
          .prepare("INSERT OR REPLACE INTO sync_metadata (key, value) VALUES ('backend_cursor', ?)")
          .run(indexResponse.current);
        logger.info(`Delta sync: No new data, updated cursor to ${indexResponse.current}`);
      } else {
        logger.warn(
          'Delta sync: No new data and no next cursor received. Keeping existing cursor.',
        );
      }
      return;
    }

    for (const entry of indexResponse.index) {
      if (entry.d) {
        await this.processSimperiumEntryData(entry.id, entry.v, entry.d);
      } else {
        await this.fetchAndProcessSimperiumEntry(entry.id, entry.v);
      }
      notesProcessed++;
    }
    logger.info(`Delta sync: Processed ${notesProcessed} changes.`);

    if (indexResponse.current) {
      this.db
        .prepare("INSERT OR REPLACE INTO sync_metadata (key, value) VALUES ('backend_cursor', ?)")
        .run(indexResponse.current);
      logger.info(`Delta sync completed. Stored new backend cursor: ${indexResponse.current}`);
    } else {
      logger.warn(
        'Delta sync: Processed changes but no new cursor received from Simperium. This is unusual.',
      );
    }
  }

  // Renamed from processSimperiumEntry to clarify it fetches then processes
  private async fetchAndProcessSimperiumEntry(
    noteId: string,
    serverVersion: number,
  ): Promise<void> {
    logger.debug(`Fetching content for note ID: ${noteId}, server version: ${serverVersion}`);
    try {
      const noteData = await getNoteContent(SIMPERIUM_NOTE_BUCKET, noteId, serverVersion);
      await this.processSimperiumEntryData(noteId, serverVersion, noteData);
    } catch (error) {
      if (error instanceof NotariumResourceNotFoundError) {
        // This means the specific version was not found (e.g., note hard deleted or version compacted)
        logger.warn(
          `Note ${noteId} version ${serverVersion} not found on server (404 via getNoteContent). Marking as potentially hard deleted.`,
        );
        const localNote = this.db.prepare('SELECT l_ver FROM notes WHERE id = ?').get(noteId) as
          | { l_ver: number }
          | undefined;
        if (localNote) {
          this.db
            .prepare('UPDATE notes SET trash = 1, sync_deleted = 1, l_ver = l_ver + 1 WHERE id = ?')
            .run(noteId);
        }
      } else {
        logger.error(
          { err: error, noteId, serverVersion },
          'Failed to fetch note content via getNoteContent.',
        );
        // Re-throw to let performSyncCycle handle retries for the whole cycle
        throw error; // Propagates NotariumBackendError or NotariumTimeoutError from getNoteContent
      }
    }
  }

  // New method to process the actual note data (whether inlined in index or fetched separately)
  private async processSimperiumEntryData(
    noteId: string,
    serverVersion: number,
    simperiumNoteData: SimperiumNoteResponseData['data'],
  ): Promise<void> {
    logger.debug(`Processing data for note ID: ${noteId}, server version: ${serverVersion}`);
    const localNoteRow = this.db
      .prepare('SELECT l_ver, s_ver, trash FROM notes WHERE id = ?')
      .get(noteId) as { l_ver: number; s_ver?: number | null; trash: number } | undefined;
    const localNote = localNoteRow
      ? { ...localNoteRow, s_ver: localNoteRow.s_ver === null ? undefined : localNoteRow.s_ver }
      : undefined;

    // Server-wins conflict resolution (Spec 8.4)
    // Compare with local s_ver if note exists locally
    if (
      !localNote ||
      (localNote.s_ver !== undefined && localNote.s_ver < serverVersion) ||
      localNote.s_ver === undefined
    ) {
      // Note is new, or server version is newer
      if (simperiumNoteData.deleted) {
        logger.info(`Note ${noteId} version ${serverVersion} is marked as deleted on server.`);
        if (localNote) {
          this.db
            .prepare(
              'UPDATE notes SET trash = 1, s_ver = ?, l_ver = l_ver + 1, sync_deleted = 1 WHERE id = ?',
            )
            .run(serverVersion, noteId);
          logger.info(`Marked local note ${noteId} as trashed due to server delete flag.`);
        } else {
          logger.info(
            `Note ${noteId} is deleted on server and not present locally. Skipping cache add.`,
          );
        }
      } else {
        const noteContent = simperiumNoteData.content || '';
        const tags = JSON.stringify(simperiumNoteData.tags || []);
        const mod_at = simperiumNoteData.modificationDate || Date.now() / 1000;
        const crt_at = simperiumNoteData.creationDate || mod_at;

        this.db
          .prepare(
            `INSERT OR REPLACE INTO notes (id, l_ver, s_ver, txt, tags, mod_at, crt_at, trash, sync_deleted)
           VALUES (?, COALESCE((SELECT l_ver FROM notes WHERE id = ?), 0) + 1, ?, ?, ?, ?, ?, ?, 0)`,
          )
          .run(
            noteId,
            noteId,
            serverVersion,
            noteContent,
            tags,
            mod_at,
            crt_at,
            simperiumNoteData.deleted ? 1 : 0,
          );
        logger.info(`Upserted note ${noteId} (server version ${serverVersion}) into local cache.`);
      }
    } else if (localNote.s_ver && localNote.s_ver > serverVersion) {
      logger.warn(
        `Local note ${noteId} has a newer server version (s_ver ${localNote.s_ver}) than received from server (s_ver ${serverVersion}). This is unusual. Local cache preserved.`,
      );
    } else {
      logger.debug(
        `Note ${noteId} is already up-to-date (s_ver ${serverVersion}). No action needed.`,
      );
    }
  }

  private updateSyncMetadata(): void {
    try {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO sync_metadata (key, value) VALUES ('last_sync_attempt_at', ?)",
        )
        .run(this.lastSyncAttemptAt);
      if (this.lastSuccessfulSyncAt) {
        this.db
          .prepare(
            "INSERT OR REPLACE INTO sync_metadata (key, value) VALUES ('last_successful_sync_at', ?)",
          )
          .run(this.lastSuccessfulSyncAt);
      }
      if (this.lastSyncDurationMs !== null) {
        this.db
          .prepare(
            "INSERT OR REPLACE INTO sync_metadata (key, value) VALUES ('last_sync_duration_ms', ?)",
          )
          .run(this.lastSyncDurationMs);
      }
      this.db
        .prepare("INSERT OR REPLACE INTO sync_metadata (key, value) VALUES ('last_sync_status', ?)")
        .run(this.lastSyncStatus);
      this.db
        .prepare("INSERT OR REPLACE INTO sync_metadata (key, value) VALUES ('sync_error_count', ?)")
        .run(this.consecutiveErrorCount);
    } catch (dbErr) {
      logger.error({ err: dbErr }, 'Failed to update sync metadata in DB.');
      // Non-fatal for the sync service itself, but metrics will be stale.
    }
  }

  // Methods to expose metrics (as per spec 8.7 and 14)
  public getSyncStats() {
    return {
      lastSyncAttemptAt: this.lastSyncAttemptAt,
      lastSuccessfulSyncAt: this.lastSuccessfulSyncAt,
      lastSyncDurationMs: this.lastSyncDurationMs,
      lastSyncStatus: this.lastSyncStatus,
      consecutiveErrorCount: this.consecutiveErrorCount,
      isSyncing: this.isSyncing,
    };
  }
}

logger.info('Backend Sync Service defined and operational.');
