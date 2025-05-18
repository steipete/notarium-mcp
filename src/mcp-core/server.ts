import type { Database as DB } from 'better-sqlite3';
import readline from 'readline';
import logger from '../logging.js';
import { BackendSyncService } from '../sync/sync-service.js';
import { handleMcpRequest } from './handler.js';
// import { handleMcpRequest } from './handler.js'; // Assuming a handler function
// Placeholder for actual MCP server implementation (e.g., using a stdio JSON-RPC library)

// Implements basic stdio JSON-RPC 2.0 server using readline module.
export async function startMcpServer(db: DB, syncService: BackendSyncService): Promise<void> {
  logger.info('Starting MCP Server...');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false, // Essential for non-TTY stdio communication
  });

  rl.on('line', async (line: string) => {
    logger.debug({ mcpRequestLine: line }, 'Received line from stdin');
    try {
      const request = JSON.parse(line);
      // Basic validation of JSON-RPC structure (can be enhanced by a dedicated library)
      if (request.jsonrpc !== '2.0' || typeof request.method !== 'string' || !('id' in request)) {
        logger.warn({ invalidRequest: request }, 'Received invalid JSON-RPC request structure');
        const errorResponse = {
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Invalid Request' },
          id: request.id !== undefined ? request.id : 0, // Use 0 instead of null
        };
        process.stdout.write(JSON.stringify(errorResponse) + '\n');
        return;
      }

      // Assuming handleMcpRequest is now imported and used
      const response = await handleMcpRequest(request, db, syncService);
      process.stdout.write(JSON.stringify(response) + '\n');
      logger.debug({ mcpResponse: response }, 'Sent MCP response to stdout');
    } catch (error) {
      logger.error({ err: error, rawLine: line }, 'Error processing MCP message from stdin');
      // Attempt to respond with a parse error if possible, otherwise log is the best we can do.
      let errorId: string | number | null = null;
      try {
        // Try to parse for ID even if full message failed, to respond correctly.
        const partialRequest = JSON.parse(line);
        if (partialRequest && 'id' in partialRequest) {
          errorId = partialRequest.id;
        }
      } catch (parseForIdError) {
        /* Ignore if even this fails */
      }

      const errorResponse = {
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error' }, // Or -32603 for Internal error if parse was ok but handler failed generically
        id: errorId || 0, // Always provide a value, never null
      };
      process.stdout.write(JSON.stringify(errorResponse) + '\n');
    }
  });

  rl.on('close', () => {
    logger.info('MCP Server input stream (stdin) closed. Shutting down if not already handled.');
    // This might signal a need for graceful shutdown if not initiated by SIGINT/SIGTERM
    // The main index.ts handleShutdown should cover most cases.
  });

  logger.info('MCP Server is listening on stdio for JSON-RPC 2.0 messages.');
}
