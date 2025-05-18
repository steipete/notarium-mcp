import type { Database as DB } from 'better-sqlite3';
import logger from '../logging.js';
import { BackendSyncService } from '../sync/sync-service.js';
import { NotariumError, NotariumValidationError, NotariumInternalError } from '../errors.js';
import { ListInputSchema, GetInputSchema, SaveInputSchema, ManageInputSchema } from '../schemas.js';
import { config } from '../config.js';

// Placeholder for actual tool implementations
import { handleList } from '../tools/list.js';
import { handleGet } from '../tools/get.js';
import { handleSave } from '../tools/save.js';
import { handleManage } from '../tools/manage.js';

// MCP protocol version supported by this server
const SUPPORTED_PROTOCOL_VERSION = "2025-03-26";

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

// Helper function to call the appropriate method handler
async function callToolMethod(methodName: string, params: any, db: DB, syncService: BackendSyncService) {
  switch (methodName) {
    case 'list':
      return await handleList(params, db);
    case 'get':
      return await handleGet(params, db);
    case 'save':
      return await handleSave(params, db);
    case 'manage':
      return await handleManage(params, db, syncService, config);
    default:
      throw new Error(`Method not found: ${methodName}`);
  }
}

export async function handleMcpRequest(
  request: McpRequest,
  db: DB,
  syncService: BackendSyncService,
): Promise<McpResponse> {
  logger.debug({ mcpRequest: request }, 'Handling MCP request in core handler');

  const { method, params, id } = request;

  // Handle initialize request (required for MCP protocol negotiation)
  if (method === 'initialize') {
    logger.info({ 
      method, 
      clientProtocolVersion: params?.protocolVersion,
      clientInfo: params?.clientInfo
    }, 'Received initialize request');
    
    // Protocol version validation
    if (params?.protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
      logger.warn({
        clientVersion: params?.protocolVersion,
        serverVersion: SUPPORTED_PROTOCOL_VERSION
      }, 'Protocol version mismatch');
      
      // Still respond - many clients will work even with version mismatch
    }
    
    return {
      jsonrpc: '2.0',
      id,
      result: {
        serverInfo: {
          name: 'Notarium MCP Server',
          version: config.MCP_NOTARIUM_VERSION
        },
        capabilities: {
          // Define what this server can do
          tools: {
            list: true,
            get: true,
            save: true,
            manage: true
          }
        },
        protocolVersion: SUPPORTED_PROTOCOL_VERSION
      }
    };
  }
  
  // Handle shutdown request (graceful termination)
  if (method === 'shutdown') {
    logger.info('Received shutdown request');
    // Return success but don't exit immediately - wait for exit notification
    return {
      jsonrpc: '2.0',
      id,
      result: null
    };
  }
  
  // Handle exit notification (immediate termination)
  if (method === 'exit') {
    logger.info('Received exit notification');
    // This would be processed by the server.ts listener, we'll just acknowledge
    return {
      jsonrpc: '2.0',
      id,
      result: null
    };
  }

  // Handle the 'tools/list' method from Inspector
  if (method === 'tools/list') {
    logger.info({ method, params }, 'Received tools/list request from Inspector');
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'mcp_notarium.list',
            title: 'List notes',
            description: 'Lists notes from Simplenote',
            inputSchema: {
              type: 'object',
              properties: {
                ids: { type: 'array', items: { type: 'string' }, description: 'Optional list of note IDs to filter by' },
                limit: { type: 'integer', description: 'Maximum number of notes to return' },
                since: { type: 'number', description: 'Timestamp to filter notes modified since' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Tags to filter by' }
              }
            },
            schema: {
              params: {
                type: 'object',
                properties: {
                  ids: { type: 'array', items: { type: 'string' }, description: 'Optional list of note IDs to filter by' },
                  limit: { type: 'integer', description: 'Maximum number of notes to return' },
                  since: { type: 'number', description: 'Timestamp to filter notes modified since' },
                  tags: { type: 'array', items: { type: 'string' }, description: 'Tags to filter by' }
                }
              }
            }
          },
          {
            name: 'mcp_notarium.get',
            title: 'Get note',
            description: 'Gets a specific note by ID',
            inputSchema: {
              type: 'object',
              required: ['id'],
              properties: {
                id: { type: 'string', description: 'Note ID to retrieve' }
              }
            },
            schema: {
              params: {
                type: 'object',
                required: ['id'],
                properties: {
                  id: { type: 'string', description: 'Note ID to retrieve' }
                }
              }
            }
          },
          {
            name: 'mcp_notarium.save',
            title: 'Save note',
            description: 'Saves a note to Simplenote',
            inputSchema: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Optional note ID for updates' },
                txt: { type: 'string', description: 'Note content' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Note tags' }
              }
            },
            schema: {
              params: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Optional note ID for updates' },
                  txt: { type: 'string', description: 'Note content' },
                  tags: { type: 'array', items: { type: 'string' }, description: 'Note tags' }
                }
              }
            }
          },
          {
            name: 'mcp_notarium.manage',
            title: 'Manage notes',
            description: 'Trash, untrash, delete notes or manage the server',
            inputSchema: {
              type: 'object',
              required: ['act'],
              properties: {
                act: { 
                  type: 'string', 
                  enum: ['trash', 'untrash', 'delete_permanently', 'get_stats', 'reset_cache'],
                  description: 'Action to perform'
                },
                id: { type: 'string', description: 'Note ID for note actions' }
              }
            },
            schema: {
              params: {
                type: 'object',
                required: ['act'],
                properties: {
                  act: { 
                    type: 'string', 
                    enum: ['trash', 'untrash', 'delete_permanently', 'get_stats', 'reset_cache'],
                    description: 'Action to perform'
                  },
                  id: { type: 'string', description: 'Note ID for note actions' }
                }
              }
            }
          }
        ]
      }
    };
  }

  // Map method from tools/call to the corresponding method name
  if (method === 'tools/call') {
    logger.info({ method, params }, 'Received tools/call request');
    
    // Check if params has a name property that specifies which tool to call
    if (params && params.name) {
      const toolName = params.name;
      
      // Map the full tool name to the method part (e.g., mcp_notarium.list -> list)
      const methodPart = toolName.split('.')[1];
      
      if (!methodPart) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Invalid tool name format: ${toolName}. Expected format: 'mcp_notarium.method'`,
          },
        };
      }
      
      // Extract the arguments from the params
      let paramArgs = params.arguments || {};
      
      // Handle the parameters specific to different tools
      // Specially for 'manage' actions where we need to unwrap the 'act' property from arguments
      if (methodPart === 'manage' && paramArgs) {
        // Now we just pass the entire arguments object to the handler
        try {
          const result = await callToolMethod(methodPart, paramArgs, db, syncService);
          return {
            jsonrpc: '2.0',
            id,
            result,
          };
        } catch (error) {
          if (error instanceof NotariumError) {
            return {
              jsonrpc: '2.0',
              id,
              error: {
                code: error instanceof NotariumValidationError ? -32602 : -32000,
                message: error.message,
                data: { category: error.category, originalError: error },
              },
            };
          }
          
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : String(error),
              data: { originalError: error },
            },
          };
        }
      }
      
      // Handle normal tool calls
      try {
        const result = await callToolMethod(methodPart, paramArgs, db, syncService);
        return {
          jsonrpc: '2.0',
          id,
          result,
        };
      } catch (error) {
        if (error instanceof NotariumError) {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: error instanceof NotariumValidationError ? -32602 : -32000,
              message: error.message,
              data: { category: error.category, originalError: error },
            },
          };
        }
        
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
            data: { originalError: error },
          },
        };
      }
    }
    
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32602,
        message: 'Invalid params: Missing "name" property in tools/call request',
      },
    };
  }

  // Handle service specific methods (old style with dot notation)
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
        result = await handleManage(manageParams, db, syncService, config);
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
    logger.error({ err: error, method, params }, 'Error in MCP request handler');

    // Convert various error types to appropriate JSON-RPC error responses
    if (error instanceof NotariumValidationError) {
      return {
        jsonrpc: '2.0',
        id: id || 0, // Ensure id is never null (use 0 as fallback)
        error: {
          code: -32602, // Invalid params
          message: error.message,
          data: { category: error.category, details: error.toString() },
        },
      };
    } else if (error instanceof NotariumError) {
      return {
        jsonrpc: '2.0',
        id: id || 0, // Ensure id is never null (use 0 as fallback)
        error: {
          code: -32000, // Server error (application defined)
          message: error.message,
          data: { category: error.category, details: error.toString() },
        },
      };
    } else {
      // Generic error handling for unexpected errors
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error }, `Unhandled error during MCP request: ${errorMessage}`);
      
      return {
        jsonrpc: '2.0',
        id: id || 0, // Ensure id is never null (use 0 as fallback)
        error: {
          code: -32603, // Internal JSON-RPC error
          message: 'Internal server error',
          data: { message: errorMessage },
        },
      };
    }
  }
}

// Removed global-like instantiation of apiClient and config
// Dependencies will be resolved within handleMcpRequest or passed to tool handlers.

// import { getSimperiumApiClient } from '../backend/simperium-api.js'; // No longer needed here
logger.info('MCP Core Handler refined: apiClientInstance passing and pre-fetch removed.');
