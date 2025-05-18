import type { DB } from '../cache/sqlite.js';
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
import * as toolImplementations from '../tools/index.js';

// MCP protocol version supported by this server
const SUPPORTED_PROTOCOL_VERSION = "2024-11-05";

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

const MCP_SERVICE_NAME = 'mcp_notarium'; // Define the expected service name

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
): Promise<McpResponse | null> {
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
    // Actual shutdown is typically handled by process signal handlers (SIGINT, SIGTERM)
    // or the host environment closing stdin. This is an acknowledgement.
    // For MCP, 'exit' is a notification, so no response should be sent.
    return null; // Signal no response
  }

  // Handle notifications/initialized (client confirms initialization)
  if (method === 'notifications/initialized') {
    logger.info({ method, params }, 'Received notifications/initialized. Client ready.');
    return null; // This is a notification, no response needed
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
            name: 'list_notes',
            title: 'List notes',
            description: 'Lists notes, allowing for filtering by IDs, modification date, and tags. Supports pagination to handle large sets of notes.',
            inputSchema: {
              type: 'object',
              properties: {
                ids: { type: 'array', items: { type: 'string' }, description: 'Optional list of note IDs to filter by' },
                limit: { type: 'integer', description: 'Maximum number of notes to return' },
                since: { type: 'number', description: 'Timestamp to filter notes modified since' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Tags to filter by' },
                date_before: { type: 'string', format: 'date', description: 'Filter notes modified before this date (YYYY-MM-DD)' },
                date_after: { type: 'string', format: 'date', description: 'Filter notes modified after this date (YYYY-MM-DD)' }
              }
            },
            schema: {
              params: {
                type: 'object',
                properties: {
                  ids: { type: 'array', items: { type: 'string' }, description: 'Optional list of note IDs to filter by' },
                  limit: { type: 'integer', description: 'Maximum number of notes to return' },
                  since: { type: 'number', description: 'Timestamp to filter notes modified since' },
                  tags: { type: 'array', items: { type: 'string' }, description: 'Tags to filter by' },
                  date_before: { type: 'string', format: 'date', description: 'Filter notes modified before this date (YYYY-MM-DD)' },
                  date_after: { type: 'string', format: 'date', description: 'Filter notes modified after this date (YYYY-MM-DD)' }
                }
              },
              result: {
                type: 'object',
                properties: {
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        local_version: { type: 'integer' },
                        title_prev: { type: 'string' },
                        tags: { type: 'array', items: { type: 'string' } },
                        modified_at: { type: 'integer' },
                        trash: { type: 'boolean' }
                      },
                      required: ['id','local_version','title_prev','tags','modified_at','trash']
                    }
                  },
                  total_items: { type: 'integer' },
                  current_page: { type: 'integer' },
                  total_pages: { type: 'integer' },
                  next_page: { type: 'integer' }
                },
                required: ['items','total_items','current_page','total_pages']
              }
            }
          },
          {
            name: 'get_note',
            title: 'Get note',
            description: 'Retrieves a specific note by its unique ID. Can also fetch a particular version of the note or a specific range of lines within the note.',
            inputSchema: {
              type: 'object',
              required: ['id'],
              properties: {
                id: { type: 'string', description: 'Note ID to retrieve (must be a non-empty string).' },
                local_version: { type: 'integer', description: 'Optional: specific local version of the note to retrieve.' },
                range_line_start: { type: 'integer', minimum: 1, description: 'Optional: 1-indexed start line for partial content retrieval.' },
                range_line_count: { type: 'integer', minimum: 0, description: 'Optional: Number of lines to retrieve from start line (0 means to end of note).' }
              }
            },
            schema: {
              params: {
                type: 'object',
                required: ['id'],
                properties: {
                  id: { type: 'string', description: 'Note ID to retrieve (must be a non-empty string).' },
                  local_version: { type: 'integer', description: 'Optional: specific local version of the note to retrieve.' },
                  range_line_start: { type: 'integer', minimum: 1, description: 'Optional: 1-indexed start line for partial content retrieval.' },
                  range_line_count: { type: 'integer', minimum: 0, description: 'Optional: Number of lines to retrieve from start line (0 means to end of note).' }
                }
              }
            }
          },
          {
            name: 'save_note',
            title: 'Save note',
            description: 'Saves a note. This can be used to create a new note or update an existing one. Supports providing full text content or line-based patches for efficient updates.',
            inputSchema: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Optional note ID for updates' },
                local_version: { type: 'integer', description: 'Local version, required for updates' },
                server_version: { type: 'integer', description: 'Server version, for conflict detection' },
                text: { type: 'string', description: 'Note content' },
                text_patch: { type: 'array', items: { $ref: '#/definitions/patchOperation' }, description: 'Line-based patch for note content' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Note tags' }
              }
            },
            schema: {
              definitions: {
                patchOperation: {
                  type: 'object',
                  required: ['op', 'ln'],
                  properties: {
                    op: { type: 'string', enum: ['add', 'mod', 'del'] },
                    ln: { type: 'integer', minimum: 1 },
                    val: { type: 'string' }
                  }
                }
              },
              params: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Optional note ID for updates' },
                  local_version: { type: 'integer', description: 'Local version, required for updates' },
                  server_version: { type: 'integer', description: 'Server version, for conflict detection' },
                  text: { type: 'string', description: 'Note content' },
                  text_patch: { type: 'array', items: { $ref: '#/definitions/patchOperation' }, description: 'Line-based patch for note content' },
                  tags: { type: 'array', items: { type: 'string' }, description: 'Note tags' }
                }
              }
            }
          },
          {
            name: 'manage_notes',
            title: 'Manage notes',
            description: 'Performs various management actions on notes or the server. This includes moving notes to trash, restoring them from trash, permanently deleting notes, retrieving server statistics, or resetting the local cache.',
            inputSchema: {
              type: 'object',
              required: ['action'],
              properties: {
                action: { 
                  type: 'string', 
                  enum: ['trash', 'untrash', 'delete_permanently', 'get_stats', 'reset_cache'],
                  description: 'Action to perform'
                },
                id: { type: 'string', description: 'Note ID for note actions' },
                local_version: { type: 'integer', description: 'Local version, required for note actions' }
              }
            },
            schema: {
              params: {
                type: 'object',
                required: ['action'],
                properties: {
                  action: { 
                    type: 'string', 
                    enum: ['trash', 'untrash', 'delete_permanently', 'get_stats', 'reset_cache'],
                    description: 'Action to perform'
                  },
                  id: { type: 'string', description: 'Note ID for note actions' },
                  local_version: { type: 'integer', description: 'Local version, required for note actions' }
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

    if (!params || typeof params.name !== 'string') {
      logger.warn('Invalid tools/call: Missing or invalid params.name');
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'Invalid method parameters: Missing or invalid tool name (params.name).' },
      };
    }

    const actualMethodKey = params.name; // e.g., "list_notes", "get_note"
    const toolImplementation = (toolImplementations as any)[actualMethodKey];

    if (typeof toolImplementation === 'function') {
      try {
        logger.info({ toolName: actualMethodKey, params: params.arguments }, 'Dispatching to tool');
        // Pass params.arguments as the arguments to the actual tool function
        // Different tools have different signatures, handle accordingly
        let result;
        if (actualMethodKey === 'manage_notes') {
          result = await toolImplementation(params.arguments || {}, db, syncService, config);
        } else {
          result = await toolImplementation(params.arguments || {}, db);
        } 
        logger.info({ 
          toolName: actualMethodKey, 
          responseId: id,
          hasResult: !!result
        }, 'Sending tools/call response');
        return {
          jsonrpc: '2.0',
          id,
          result,
        };
      } catch (error: any) {
        logger.error({ err: error, toolName: actualMethodKey }, 'Error executing tool');
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: `Server error: ${error.message || 'Unknown error during tool execution'}` },
        };
      }
    } else {
      logger.warn({ toolNameFromMcp: actualMethodKey, available: Object.keys(toolImplementations) }, 'Method not found in toolImplementations');
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${actualMethodKey}. Available methods: ${Object.keys(toolImplementations).join(', ')}` },
      };
    }
  } else {
    logger.warn({ method }, 'Unsupported method');
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }
}

// Removed global-like instantiation of apiClient and config
// Dependencies will be resolved within handleMcpRequest or passed to tool handlers.

// import { getSimperiumApiClient } from '../backend/simperium-api.js'; // No longer needed here
logger.info('MCP Core Handler refined: apiClientInstance passing and pre-fetch removed.');
