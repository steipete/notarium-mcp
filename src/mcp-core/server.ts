import type { DB } from '../cache/sqlite.js';
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
    let request;
    try {
      request = JSON.parse(line);
    } catch (error) {
      logger.error({ err: error, rawLine: line }, 'Error parsing JSON-RPC message from stdin');
      const errorResponse = {
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error' },
        id: null, // No ID can be determined from a parse error
      };
      process.stdout.write(JSON.stringify(errorResponse) + '\n');
      return;
    }

    const isNotification = request.id === undefined || request.id === null;

    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      logger.warn({ invalidRequest: request }, 'Received malformed JSON-RPC message (missing jsonrpc or method)');
      if (!isNotification) {
        const errorResponse = {
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Invalid Request (malformed structure)' },
          id: request.id,
        };
        process.stdout.write(JSON.stringify(errorResponse) + '\n');
      }
      // For malformed notifications, do not send a response.
      return;
    }

    try {
      const response = await handleMcpRequest(request, db, syncService);
      if (!isNotification && response) {
        process.stdout.write(JSON.stringify(response) + '\n');
        logger.info({
          method: request.method,
          responseId: response.id,
          hasResult: 'result' in response,
          hasError: 'error' in response,
        }, 'Sent MCP response to stdout');
      } else if (isNotification && response) {
        // This case should ideally not happen if handleMcpRequest correctly returns null/void for notifications.
        logger.warn({ method: request.method }, "Handler returned a response object for a notification. This response was not sent.");
      } else if (isNotification && !response) {
        // This is the expected path for notifications: handler processed it and returned nothing sendable.
        logger.debug({ method: request.method }, "Notification processed. No response sent.");
      }
    } catch (error: any) {
      logger.error({ err: error, request }, 'Unhandled error during MCP request processing in server.ts');
      if (!isNotification) {
        const errorResponse = {
          jsonrpc: '2.0',
          error: { code: -32000, message: `Server error: ${error.message || 'Internal server error'}` },
          id: request.id,
        };
        process.stdout.write(JSON.stringify(errorResponse) + '\n');
      }
      // No response for errors during notification processing if it reaches here.
    }
  });

  rl.on('close', () => {
    logger.info('MCP Server input stream (stdin) closed. Shutting down if not already handled.');
    // This might signal a need for graceful shutdown if not initiated by SIGINT/SIGTERM
    // The main index.ts handleShutdown should cover most cases.
  });

  logger.info('MCP Server is listening on stdio for JSON-RPC 2.0 messages.');
}
