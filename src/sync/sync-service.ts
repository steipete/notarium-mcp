import type { DB } from '../cache/sqlite.js';
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
import type { Statement } from 'sql.js';

const FULL_SYNC_PAGE_SIZE = 100; // As per spec 8. Initial Full Sync PAGE_SIZE
const DELTA_SYNC_PAGE_SIZE = 500; // As per spec 8. Delta Sync PAGE_SIZE
const SIMPERIUM_NOTE_BUCKET = 'note'; // Simplenote uses 'note' bucket

// Helper to fetch first row as object using sql.js Statement API
function queryFirstRowObject<T = Record<string, unknown>>(db: DB, sql: string, params: any[] = []): T | undefined {
  const stmt: Statement = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const row = stmt.step() ? (stmt.getAsObject() as T) : undefined;
  stmt.free();
  return row;
}

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
      const didRescheduleOnError: boolean = await this.performSyncCycle();
      // Reschedule after completion, unless stopped by max errors or self-rescheduled
      if (!didRescheduleOnError && this.consecutiveErrorCount < BackendSyncService.MAX_CONSECUTIVE_ERRORS) {
        this.scheduleNextSync();
      } else if (didRescheduleOnError) {
        logger.debug('Sync cycle error handling led to self-reschedule via backoff. No further reschedule needed here.');
      } else {
        logger.error('BackendSyncService stopped due to maximum consecutive errors.');
        this.lastSyncStatus = 'stopped (max errors)';
        this.updateSyncMetadata();
      }
    }, delay);
  }

  private async performSyncCycle(): Promise<boolean> {
    if (this.isSyncing) {
      logger.warn('Sync cycle already in progress. Skipping this scheduled run.');
      return false; // Not an error, but didn't run, so no self-reschedule
    }
    this.isSyncing = true;
    this.lastSyncAttemptAt = Date.now() / 1000;
    this.lastSyncStatus = 'syncing';
    this.updateSyncMetadata();
    logger.info('Starting backend synchronization cycle...');

    const startTime = Date.now();
    try {
      // Ensure sync_metadata table exists before first query
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS sync_metadata (
            key TEXT PRIMARY KEY,
            value TEXT
          );
        `);
      } catch (tableErr) {
        logger.warn({ err: tableErr }, 'Error ensuring sync_metadata table exists');
      }
      
      // Now safe to query sync_metadata
      const cursorRow = queryFirstRowObject<{ value: string }>(
        this.db,
        "SELECT value FROM sync_metadata WHERE key = 'backend_cursor'",
      );
      let backendCursor: string | null = cursorRow?.value ?? null;

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
      return false; // Successful, no self-reschedule
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
        return true; // Self-rescheduled due to error
      }
      // If max errors reached, do not reschedule via backoff here.
      // The caller (scheduleNextSync's setTimeout) will see didRescheduleOnError as false
      // and then check consecutiveErrorCount to log the MAX_ERRORS stop.
      return false; // Max errors reached, did not self-reschedule via backoff
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
    let finalCursorToStore: string | null = null; // This will hold the actual cursor to save
    let indexResponse: SimperiumIndexResponse | undefined = undefined; // Declare here for loop condition

    do {
      logger.debug({ mark: currentMark }, 'Full sync: Fetching index page.');
      indexResponse = await getIndex({
        bucketName: SIMPERIUM_NOTE_BUCKET,
        mark: currentMark,
        limit: FULL_SYNC_PAGE_SIZE,
        data: false,
      });

      finalCursorToStore = indexResponse.current; // Always update with the latest cursor from API

      if (!indexResponse.index || indexResponse.index.length === 0) {
        logger.info('Full sync: Page was empty, no more items. Loop will terminate.');
        currentMark = undefined; // Ensure loop termination
        break;
      }

      let notesProcessedThisPage = 0;
      for (const entry of indexResponse.index) {
        await this.fetchAndProcessSimperiumEntry(entry.id, entry.v);
        notesProcessedThisPage++;
      }
      notesProcessedTotal += notesProcessedThisPage;
      logger.info(
        `Full sync: Processed page with ${notesProcessedThisPage} notes. Limit: ${FULL_SYNC_PAGE_SIZE}. Total so far: ${notesProcessedTotal}. Cursor from this page: ${finalCursorToStore}`
      );

      if (notesProcessedThisPage < FULL_SYNC_PAGE_SIZE) {
        logger.info(`Full sync: Fetched page was not full (${notesProcessedThisPage} < ${FULL_SYNC_PAGE_SIZE}), indicating the end of data. Loop will terminate.`);
        currentMark = undefined; // Ensure loop termination
      } else {
        currentMark = finalCursorToStore; // Use the cursor from this page for the next mark
        if (!currentMark) { // If API returned null/undefined cursor even with a full page (defensive)
             logger.warn("Full sync: API returned a full page but a falsy cursor. Terminating sync to prevent issues.");
             break; // Terminate if the cursor to continue with is falsy
        }
      }
    } while (currentMark); // Loop as long as currentMark suggests more pages

    if (finalCursorToStore) {
      this.db
        .prepare("INSERT OR REPLACE INTO sync_metadata (key, value) VALUES ('backend_cursor', ?)")
        .run([finalCursorToStore]);
      logger.info(`Full sync completed. Stored final backend cursor: ${finalCursorToStore}`);
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
          .run([indexResponse.current]);
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
        .run([indexResponse.current]);
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
        const localNoteObj = queryFirstRowObject<{ l_ver: number }>(
          this.db,
          'SELECT l_ver FROM notes WHERE id = ?',
          [noteId],
        );
        const localNote = localNoteObj ?? undefined;
        if (localNote) {
          this.db
            .prepare('UPDATE notes SET trash = 1, sync_deleted = 1, l_ver = l_ver + 1 WHERE id = ?')
            .run([noteId]);
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
    const localNoteRow = queryFirstRowObject<{ l_ver: number; s_ver?: number | null; trash: number }>(
      this.db,
      'SELECT l_ver, s_ver, trash FROM notes WHERE id = ?',
      [noteId],
    );
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
            .run([serverVersion, noteId]);
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

        // UNCONDITIONAL SIMPLIFIED LOGGING (Pino - keep for comparison if console.error works)
        logger.info({
          message: 'DEBUG: Values for notes upsert (Pino)',
          noteId_Debug: noteId,
          noteContent_Debug: noteContent,
          originalContent_Debug: simperiumNoteData.content, // Keep original content for comparison
          typeOfOriginalContent_Debug: typeof simperiumNoteData.content,
          typeOfCoalescedNoteContent_Debug: typeof noteContent,
        }, 'Debug before upsert (Pino)');

        this.db
          .prepare(
            `INSERT OR REPLACE INTO notes (id, l_ver, s_ver, txt, tags, mod_at, crt_at, trash, sync_deleted)
           VALUES (?, COALESCE((SELECT l_ver FROM notes WHERE id = ?), 0) + 1, ?, ?, ?, ?, ?, ?, 0)`,
          )
          .run([
            noteId,
            noteId,
            serverVersion,
            noteContent,
            tags,
            mod_at,
            crt_at,
            simperiumNoteData.deleted ? 1 : 0,
          ]);
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
      // First ensure the table exists
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sync_metadata (
          key TEXT PRIMARY KEY,
          value TEXT
        );
      `);
      
      this.db
        .prepare(
          "INSERT OR REPLACE INTO sync_metadata (key, value) VALUES ('last_sync_attempt_at', ?)",
        )
        .run([this.lastSyncAttemptAt ?? null]);
      if (this.lastSuccessfulSyncAt) {
        this.db
          .prepare(
            "INSERT OR REPLACE INTO sync_metadata (key, value) VALUES ('last_successful_sync_at', ?)",
          )
          .run([this.lastSuccessfulSyncAt]);
      }
      if (this.lastSyncDurationMs !== null) {
        this.db
          .prepare(
            "INSERT OR REPLACE INTO sync_metadata (key, value) VALUES ('last_sync_duration_ms', ?)",
          )
          .run([this.lastSyncDurationMs]);
      }
      this.db
        .prepare("INSERT OR REPLACE INTO sync_metadata (key, value) VALUES ('last_sync_status', ?)")
        .run([this.lastSyncStatus]);
      this.db
        .prepare("INSERT OR REPLACE INTO sync_metadata (key, value) VALUES ('sync_error_count', ?)")
        .run([this.consecutiveErrorCount]);
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
