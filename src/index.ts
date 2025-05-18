// MCP Notarium Main Entry Point
import { config, printConfigVars, validateConfig } from './config.js';
import logger from './logging.js';
// import { runSqliteLoadTest } from './cache/sqlite.js';
import { initializeCache, closeCache, getDB } from './cache/sqlite.js'; // Comment out for test
import type { DB } from './cache/sqlite.js'; // Keep type import if used elsewhere - NOW COMMENTED FOR TEST
import { BackendSyncService } from './sync/sync-service.js'; // Keep commented for now
import { startMcpServer } from './mcp-core/server.js'; // Keep commented for now

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
    db = await initializeCache(); // Initialize cache, get DB instance
    logger.info('Database cache initialized successfully.');

    // Initialize and start the sync service after DB is ready
    syncService = new BackendSyncService(); // Relies on getDB() being callable
    syncService.start(); // Start background sync
    logger.info('Backend sync service started.');

    // Start the MCP server, passing the DB instance
    startMcpServer(getDB(), syncService); // Relies on getDB()

  } catch (error) {
    logger.fatal({ err: error }, 'Failed to initialize database or start services. Exiting.');
    process.exit(1);
  }
}

function gracefulShutdown(signal: string) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);
  if (db) {
    try {
      closeCache();
      logger.info('Database cache closed.');
    } catch (err) {
      logger.error({ err }, 'Error closing database cache during shutdown.');
    }
  }

  logger.info('MCP Notarium server shut down complete.');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

main().catch((err) => {
  // This catch is for unhandled errors specifically from the main() promise chain itself,
  // not errors handled within main()'s try/catch which already attempts shutdown.
  logger.fatal({ err }, 'Unhandled critical error in main function execution.');
  process.exit(1);
});
