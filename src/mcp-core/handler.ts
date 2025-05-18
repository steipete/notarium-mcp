import type { DB } from '../cache/sqlite.js';
import logger from '../logging.js';
import { BackendSyncService } from '../sync/sync-service.js';
import { NotariumError, NotariumValidationError, NotariumInternalError } from '../errors.js';
import { ListInputSchema, GetNotesInputSchema, SaveNotesInputSchema, ManageInputSchema } from '../schemas.js';
import { config } from '../config.js';

// Placeholder for actual tool implementations
import { handleList } from '../tools/list.js';
import { handleGet as handleGetNotes } from '../tools/get.js';
import { handleSave as handleSaveNotes } from '../tools/save.js';
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
    case 'get_notes':
      return await handleGetNotes(params, db);
    case 'save_notes':
      return await handleSaveNotes(params, db);
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
            description: 'Lists notes, allowing for filtering by text query, tags, modification date, and trash status. Supports pagination and sorting. Each returned note item includes a number_of_lines field indicating its total line count. Note text content can be Markdown.',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Full-text search query. Can include filters like tag:yourtag, before:YYYY-MM-DD, after:YYYY-MM-DD. (Optional, Default: no query)' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Filter by notes containing ALL of these tags. (Optional, Default: no tag filter)' },
                trash_status: { type: 'string', enum: ['active', 'trashed', 'any'], description: "Filter by trash status. Default: 'active'." },
                date_before: { type: 'string', format: 'date', description: 'Filter notes modified before this UTC date (YYYY-MM-DD). (Optional, Default: no date filter)' },
                date_after: { type: 'string', format: 'date', description: 'Filter notes modified after this UTC date (YYYY-MM-DD). (Optional, Default: no date filter)' },
                sort_by: { type: 'string', enum: ['modified_at', 'created_at'], description: 'Field to sort by. Default: modified_at.' },
                sort_order: { type: 'string', enum: ['ASC', 'DESC'], description: 'Sort order. Default: DESC.' },
                limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum number of notes to return. Default: 20.' },
                page: { type: 'integer', minimum: 1, description: 'Page number for pagination. Default: 1.' },
                preview_lines: { type: 'integer', minimum: 1, maximum: 20, description: 'Number of leading lines to include in preview text. Default: 3, Max: 20.' }
              }
            },
          },
          {
            name: 'get_notes',
            title: 'Get Note(s)',
            description: 'Retrieves one or more notes by their unique ID(s). Can also fetch a particular version or a specific range of lines if a single ID is provided. Note text content can be Markdown.',
            inputSchema: {
              type: 'object',
              required: ['id'],
              properties: {
                id: { type: 'string | string[]', description: 'A single Note ID or an array of up to 20 Note IDs to retrieve. (Required)' },
                local_version: { type: 'integer', description: 'Optional: specific local version of the note to retrieve. Default: latest. (Applies if a single ID is provided).' },
                range_line_start: { type: 'integer', minimum: 1, description: 'Optional: 1-indexed start line for partial content retrieval. Default: 1. (Applies if a single ID is provided).' },
                range_line_count: { type: 'integer', minimum: 0, description: 'Optional: Number of lines to retrieve from start line (0 means to end of note). Default: all lines from start. (Applies if a single ID is provided).' }
              }
            },
          },
          {
            name: 'save_notes',
            title: 'Save Note(s)',
            description: 'Saves one or more notes. Can be used to create new notes or update an existing one. Supports providing full text content (Markdown is common) or line-based patches for efficient updates. Returns a list of successfully saved notes.',
            inputSchema: {
              type: 'object',
              required: ['notes'],
              properties: {
                notes: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 20,
                  description: 'An array of note objects to save (1-20 notes per call).',
                  items: {
                    type: 'object',
                    // required: [], // Individual note requirements are handled by SingleSaveObjectSchema internal refinements
                    properties: {
                      id: { type: 'string', description: 'Optional note ID for updates. Default: a new note is created.' },
                      local_version: { type: 'integer', description: 'Local version, required for updates to an existing note.' },
                      server_version: { type: 'integer', description: 'Server version for conflict detection. (Optional)' },
                      text: { type: 'string', description: 'Full note content. (Required if text_patch not used)' },
                      text_patch: { type: 'array', items: { $ref: '#/definitions/patchOperation' }, description: 'Line-based patch. (Required if text not used)' },
                      tags: { type: 'array', items: { type: 'string' }, description: 'Note tags. (Optional)' },
                      trash: { type: 'boolean', description: 'Set trash status. (Optional, Default: false)' }
                    }
                  }
                }
              }
            },
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
                id: { type: 'string', description: 'Note ID for note actions. (Optional, not used for get_stats/reset_cache)' },
                local_version: { type: 'integer', description: 'Local version, required for note actions. (Optional, not used for get_stats/reset_cache)' }
              }
            },
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

    const actualMethodKey = params.name; // e.g., "list_notes", "get_notes", "save_notes"
    const toolImplementation = (toolImplementations as any)[actualMethodKey];

    if (typeof toolImplementation === 'function') {
      try {
        logger.info({ toolName: actualMethodKey, params: params.arguments }, `Dispatching to tool: ${actualMethodKey}`);
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
        }, `Sending tools/call response for ${actualMethodKey}`);
        return {
          jsonrpc: '2.0',
          id,
          result,
        };
      } catch (error: any) {
        logger.error({ err: error, toolName: actualMethodKey }, `Error executing tool: ${actualMethodKey}`);
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: `Server error: ${error.message || 'Unknown error during tool execution'}` },
        };
      }
    } else {
      logger.warn({ toolNameFromMcp: actualMethodKey, available: Object.keys(toolImplementations) }, `Method ${actualMethodKey} not found in toolImplementations`);
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${actualMethodKey}. Available: ${Object.keys(toolImplementations).join(', ')}` },
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
