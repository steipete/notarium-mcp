// MCP Notarium Main Entry Point
import { config, printConfigVars, validateConfig } from './config.js';
import logger from './logging.js';
import type { Database as DB } from 'better-sqlite3'; // Added DB type import
import { initializeCache, closeCache } from './cache/sqlite.js';
import { BackendSyncService } from './sync/sync-service.js';
import { startMcpServer } from './mcp-core/server.js';

let db: DB | undefined;
let syncService: BackendSyncService | undefined;

async function main() {
  if (process.argv.includes('--version')) {
    try {
      const { createRequire } = await import('module');
      const require = createRequire(import.meta.url);
      const packageJson = require('../package.json');
      // eslint-disable-next-line no-console
      console.log(packageJson.version);
      process.exit(0);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to read package.json for version.', error);
      process.exit(1);
    }
  }

  validateConfig();

  if (process.argv.includes('--help')) {
    // eslint-disable-next-line no-console
    console.log(`
MCP Notarium - A bridge between LLMs and Simplenote.

Usage: mcp-notarium [options]

Options:
  --version             Show version number
  --help                Show help
  --print-config-vars   Print current configuration variables and exit
    `);
    process.exit(0);
  }

  if (process.argv.includes('--print-config-vars')) {
    await printConfigVars();
    process.exit(0);
  }

  const { createRequire: createRequireMain } = await import('module');
  const requireMain = createRequireMain(import.meta.url);
  const packageJsonMain = requireMain('../package.json');
  logger.info({ version: packageJsonMain.version }, 'MCP Notarium starting...');
  logger.info(`Log level set to: ${config.LOG_LEVEL}`);

  try {
    // 1. Initialize Cache
    db = await initializeCache();
    logger.info('Local cache initialized successfully.');

    // 2. Initialize Backend API Client (done implicitly by its first use or a dedicated init if needed)
    //    getSimperiumApiClient() in simperium-api.ts handles this.
    logger.info('Backend API client will be initialized on first use.');

    // 3. Start Backend Sync Service
    syncService = new BackendSyncService();
    syncService.start();
    logger.info('Backend sync service started.');

    // 4. Start MCP Server
    if (!db || !syncService) {
      // Type guard, though db should be defined after initializeCache
      throw new Error('DB or SyncService not initialized before starting MCP Server');
    }
    await startMcpServer(db, syncService);

    // The process will be kept alive by the MCP server or sync service intervals.
    // No explicit keep-alive setInterval needed here.
    logger.info('MCP Notarium main components initialized and started.');
  } catch (error) {
    logger.fatal({ err: error }, 'Critical error during MCP Notarium startup.');
    // Attempt graceful shutdown even on startup error
    await handleShutdown('STARTUP_ERROR').catch((shutdownErr) => {
      logger.error({ err: shutdownErr }, 'Error during shutdown attempt after startup failure.');
    });
    process.exit(1);
  }
}

async function handleShutdown(signal: string) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);
  try {
    if (syncService) {
      logger.info('Stopping backend sync service...');
      await syncService.stop();
      logger.info('Backend sync service stopped.');
    }
    // MCP Server shutdown would be handled here if it had an explicit stop method
    // For stdio-based servers, closing stdin or the process itself might be enough.

    if (db) {
      // db might not be initialized if startup failed very early
      logger.info('Closing database connection...');
      await closeCache(); // closeCache is defined in sqlite.ts
      logger.info('Database connection closed.');
    }
    logger.info('MCP Notarium shut down complete.');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Error during graceful shutdown.');
    process.exit(1); // Exit with error if shutdown fails
  }
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

main().catch((err) => {
  // This catch is for unhandled errors specifically from the main() promise chain itself,
  // not errors handled within main()'s try/catch which already attempts shutdown.
  logger.fatal({ err }, 'Unhandled critical error in main function execution.');
  process.exit(1);
});
