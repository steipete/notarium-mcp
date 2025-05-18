import type { Database as DB } from 'better-sqlite3';
import logger from '../logging.js';
import { BackendSyncService } from '../sync/sync-service.js';
import { NotariumError, NotariumValidationError, NotariumInternalError } from '../errors.js';
import { ListInputSchema, GetInputSchema, SaveInputSchema, ManageInputSchema } from '../schemas.js';

// Placeholder for actual tool implementations
import { handleList } from '../tools/list.js';
import { handleGet } from '../tools/get.js';
import { handleSave } from '../tools/save.js';
import { handleManage } from '../tools/manage.js';

// This is a conceptual MCP request structure. The actual structure depends on the chosen MCP library.
interface McpRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string; // e.g., "mcp_notarium.list", "mcp_notarium.get"
  params?: any; // This would be one of the Zod Input Schemas after parsing
  context?: Record<string, any>;
}

interface McpResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

const MCP_SERVICE_NAME = 'mcp_notarium'; // As per spec 10.

export async function handleMcpRequest(
  request: McpRequest,
  db: DB,
  syncService: BackendSyncService,
): Promise<McpResponse> {
  logger.debug({ mcpRequest: request }, 'Handling MCP request in core handler');

  const { method, params, id } = request;

  if (!method.startsWith(MCP_SERVICE_NAME + '.')) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601, // Method not found
        message: `Method not found. Service should be '${MCP_SERVICE_NAME}'.`,
      },
    };
  }

  const toolName = method.substring(MCP_SERVICE_NAME.length + 1);

  try {
    let result: any;

    switch (toolName) {
      case 'list': {
        const listParams = ListInputSchema.parse(params);
        result = await handleList(listParams, db);
        break;
      }
      case 'get': {
        const getParams = GetInputSchema.parse(params);
        result = await handleGet(getParams, db);
        break;
      }
      case 'save': {
        const saveParams = SaveInputSchema.parse(params);
        result = await handleSave(saveParams, db);
        break;
      }
      case 'manage': {
        const manageParams = ManageInputSchema.parse(params);
        result = await handleManage(manageParams, db, syncService, appConfig);
        break;
      }
      default:
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Tool '${toolName}' not found within ${MCP_SERVICE_NAME}.`,
          },
        };
    }
    return { jsonrpc: '2.0', id, result };
  } catch (error) {
    logger.warn({ err: error, toolName, methodParams: params }, 'Error executing MCP tool');
    if (error instanceof NotariumError) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: error.httpStatusCode, // Or a custom MCP error code mapping
          message: error.user_message, // User-friendly message
          data: error.toDict(), // Detailed error information
        },
      };
    } else if (error instanceof Error && (error as any).name === 'ZodError') {
      // ZodError
      const validationError = new NotariumValidationError(
        `Input validation failed for tool ${toolName}: ${error.message}`,
        'Invalid parameters provided for the tool.',
        (error as any).issues, // Zod issues array
      );
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: validationError.httpStatusCode,
          message: validationError.user_message,
          data: validationError.toDict(),
        },
      };
    } else {
      const internalError = new NotariumInternalError(
        `Unexpected error in tool ${toolName}: ${(error as Error).message}`,
        'An unexpected internal server error occurred.',
        undefined,
        error instanceof Error ? error : new Error(String(error)),
      );
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: internalError.httpStatusCode,
          message: internalError.user_message,
          data: internalError.toDict(),
        },
      };
    }
  }
}

// Removed global-like instantiation of apiClient and config
// Dependencies will be resolved within handleMcpRequest or passed to tool handlers.

// import { getSimperiumApiClient } from '../backend/simperium-api.js'; // No longer needed here
import { config as appConfig } from '../config.js'; // Still needed for handleManage

logger.info('MCP Core Handler refined: apiClientInstance passing and pre-fetch removed.');
