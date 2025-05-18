import axios, { AxiosInstance, AxiosError, AxiosRequestConfig } from 'axios';
import { config } from '../config.js';
import logger from '../logging.js';
import {
  NotariumAuthError,
  NotariumBackendError,
  NotariumTimeoutError,
  NotariumInternalError,
  NotariumResourceNotFoundError,
  NotariumValidationError,
} from '../errors.js';

// Simperium Application Constants (as per spec 5)
const SIMPERIUM_APP_ID = 'chalk-bump-f49';
const SIMPERIUM_API_KEY = 'e2f0978acfea407aa23fdf557478d3f2';

const AUTH_BASE_URL = 'https://auth.simperium.com/1/';
const API_BASE_URL = `https://api.simperium.com/1/${SIMPERIUM_APP_ID}/`;

interface SimperiumAuthResponse {
  username: string;
  access_token: string;
  userid: string; // User ID, often a hex string
}

// ---- Simperium Data Structures (as per typical Simperium responses) ----
export interface SimperiumObjectVersion {
  id: string; // Object ID
  v: number; // Version number
  d?: any; // Data payload (present if not a delete marker)
  // Simperium might use '-' as a value for a key to indicate field deletion, or a top-level "-": true for object deletion in some contexts.
}

export interface SimperiumIndexResponse {
  index: SimperiumObjectVersion[];
  current: string; // Cursor for the next page / current state of the index
  mark?: string; // Older cursor mechanism, prefer "current"
  // count?: number;  // Sometimes present
}

// For fetching a specific note's content at a version
// This is a more generic Simperium object structure. Simplenote content is inside 'content' field.
export interface SimperiumNoteResponseData {
  id: string; // Not part of Simperium object data model, but useful contextually
  version: number; // Not part of Simperium object data model, but useful contextually
  data: {
    // This is the 'd' from SimperiumIndexEntry if data was inlined, or the response from /i/ID/v/VERSION
    content?: string;
    tags?: string[];
    creationDate?: number;
    modificationDate?: number;
    deleted?: boolean;
    publishURL?: string;
    shareURL?: string;
    systemTags?: string[];
    // ... other Simplenote fields
  };
}
// ---- End Simperium Data Structures ----

let accessToken: string | null = null;
let apiClient: AxiosInstance;

export async function getAccessToken(username?: string, password?: string): Promise<string> {
  if (process.env.TEST_MODE === '1') {
    logger.info('TEST_MODE enabled, returning mock access token');
    return 'mock-access-token-for-testing-purposes-only';
  }

  // Ensure username and password are provided
  const user = username || config.SIMPLENOTE_USERNAME || '';
  const pass = password || config.SIMPLENOTE_PASSWORD || '';
  
  if (!user || !pass) {
    throw new NotariumValidationError(
      'Missing Simplenote credentials',
      'Please provide Simplenote username and password in the configuration.'
    );
  }

  const authUrl = `${AUTH_BASE_URL}${SIMPERIUM_APP_ID}/authorize/`;
  logger.info({ authUrl }, 'Simperium authUrl being used');
  logger.info({ user }, 'Attempting to authenticate with Simperium');

  try {
    const response = await axios.post<SimperiumAuthResponse>(
      authUrl,
      {
        username: user,
        password: pass,
      },
      {
        headers: {
          'X-Simperium-API-Key': SIMPERIUM_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 30000, // 30 second timeout
      },
    );

    if (response.data && response.data.access_token) {
      const newAccessToken = response.data.access_token;
      logger.info(`Successfully authenticated with Simperium. UserID: ${response.data.userid}`);
      initializeApiClient(newAccessToken);
      accessToken = newAccessToken;
      return newAccessToken;
    } else {
      throw new NotariumAuthError(
        'Simperium authentication failed: No access token received.',
        'Authentication with Simplenote backend failed.',
        response.data,
      );
    }
  } catch (error) {
    const axiosError = error as AxiosError;
    if (axiosError.response) {
      logger.error(
        { err: axiosError, status: axiosError.response.status, data: axiosError.response.data },
        'Simperium authentication HTTP error',
      );
      if (axiosError.response.status === 401) {
        throw new NotariumAuthError(
          `Simperium authentication failed (401): Invalid credentials. Status: ${axiosError.response.status}`,
          'Invalid Simplenote username or password.',
          axiosError.response.data as Record<string, any>,
          axiosError,
        );
      }
      throw new NotariumBackendError(
        `Simperium authentication failed with HTTP status: ${axiosError.response.status}`,
        'Could not authenticate with Simplenote backend.',
        axiosError.response.status,
        'unknown',
        axiosError.response.data as Record<string, any>,
        undefined,
        axiosError,
      );
    } else if (axiosError.request) {
      logger.error({ err: axiosError }, 'Simperium authentication request error (no response)');
      throw new NotariumTimeoutError(
        'Simperium authentication request timed out or network error.',
        'Could not reach Simplenote authentication server.',
        undefined,
        axiosError,
      );
    } else {
      logger.error({ err: axiosError }, 'Simperium authentication setup error');
      throw new NotariumInternalError(
        `Simperium authentication request setup error: ${axiosError.message}`,
        'An internal error occurred during authentication setup.',
        undefined,
        axiosError,
      );
    }
  }
}

function initializeApiClient(token: string): void {
  apiClient = axios.create({
    baseURL: API_BASE_URL,
    headers: {
      'X-Simperium-API-Key': SIMPERIUM_API_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: config.API_TIMEOUT_SECONDS * 1000,
  });

  // Interceptor to handle 401 errors by trying to re-authenticate
  apiClient.interceptors.response.use(
    (response: import('axios').AxiosResponse) => response,
    async (error: AxiosError) => {
      const originalRequest = error.config as AxiosRequestConfig & {
        _retry?: boolean;
        _retry_429?: number;
      };
      if (error.response?.status === 401 && originalRequest && !originalRequest._retry) {
        logger.warn('Received 401 from Simperium API. Attempting to re-authenticate...');
        originalRequest._retry = true;
        accessToken = null;
        try {
          const newToken = await getAccessToken(config.SIMPLENOTE_USERNAME, config.SIMPLENOTE_PASSWORD);
          if (originalRequest.headers) {
            originalRequest.headers['Authorization'] = `Bearer ${newToken}`;
          }
          // Ensure future requests use the fresh token
          if (apiClient && apiClient.defaults && apiClient.defaults.headers) {
            (apiClient.defaults.headers as any)['Authorization'] = `Bearer ${newToken}`;
          }
          return apiClient(originalRequest);
        } catch (authError) {
          logger.error({ err: authError }, 'Re-authentication failed after 401.');
          throw authError;
        }
      }
      // Handle other errors (e.g., 429 Rate Limit as per spec 7.4)
      if (error.response?.status === 429 && originalRequest) {
        const retryAfterSeconds = parseInt(error.response.headers['retry-after'], 10) || 5;
        logger.warn(
          `Received 429 (Rate Limit) from Simperium API. Retrying after ${retryAfterSeconds} seconds.`,
        );
        await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds * 1000));
        originalRequest._retry_429 = (originalRequest._retry_429 || 0) + 1;
        if (originalRequest._retry_429 > 3) {
          logger.error('Max retries for 429 rate limit reached.');
          throw new NotariumBackendError(
            'Simperium API rate limit exceeded after multiple retries.',
            'Simplenote server is busy. Please try again later.',
            429,
            'rate_limit',
            undefined,
            undefined,
            error,
          );
        }
        return apiClient(originalRequest);
      }
      return Promise.reject(error);
    },
  );
}

// Ensure API client is initialized on first import or first call.
// Call getAccessToken once to either load existing or fetch new one.
// This also initializes apiClient.
if (process.env.TEST_MODE === '1') {
  logger.info('TEST_MODE enabled, skipping initial authentication');
  // Initialize with mock client in test mode
  initializeApiClient('mock-access-token-for-testing-purposes-only');
} else {
  getAccessToken(config.SIMPLENOTE_USERNAME, config.SIMPLENOTE_PASSWORD).catch((err) => {
    // Log initial auth errors but don't prevent module loading if auth is deferred to first API call.
    // However, most operations will fail if this initial auth fails.
    // The design implies auth happens early.
    logger.error({ err }, 'Initial Simperium authentication attempt failed during module load.');
    // Depending on strictness, could throw here or let subsequent calls fail.
    // For now, allow module to load; subsequent API calls will trigger auth if accessToken is still null.
  });
}

/**
 * Gets the initialized Axios client for Simperium API calls.
 * Ensures authentication has been attempted.
 */
export async function getSimperiumApiClient(): Promise<AxiosInstance> {
  if (process.env.TEST_MODE === '1') {
    logger.info('TEST_MODE enabled, returning mock API client');
    
    // Create a mock API client that returns empty data for all methods
    const mockClient = axios.create({
      baseURL: 'https://example.com',
    });
    
    // Mock interceptor for all requests
    mockClient.interceptors.request.use((config) => {
      logger.info(`Mock API client intercepted request to: ${config.url}`);
      return config;
    });
    
    // Mock interceptor for all responses
    mockClient.interceptors.response.use((response) => {
      logger.info('Mock API client returning successful mock response');
      return response;
    });
    
    return mockClient;
  }

  if (!accessToken || !apiClient) {
    // This ensures that if initial auth failed or token expired, we try again.
    await getAccessToken(config.SIMPLENOTE_USERNAME, config.SIMPLENOTE_PASSWORD);
  }
  if (!apiClient) {
    throw new NotariumInternalError(
      'Failed to initialize Simperium API client',
      'Could not connect to Simplenote service.'
    );
  }
  return apiClient;
}

// ---- New function: getIndex ----
interface GetIndexParams {
  bucketName: string;
  since?: string;
  limit?: number;
  data?: boolean;
  mark?: string;
}

/**
 * Fetches the index of notes from Simperium.
 * @param params Parameters for the index request
 * @returns SimperiumIndexResponse containing notes and pagination mark
 */
export async function getIndex(params: GetIndexParams): Promise<SimperiumIndexResponse> {
  if (process.env.TEST_MODE === '1') {
    logger.info('TEST_MODE enabled, returning mock index data');
    
    // Create mock notes with realistic data
    const mockNotes = [
      {
        id: 'note1',
        v: 1,
        d: {
          content: 'This is a mock note for testing purposes',
          creationDate: Date.now(),
          modificationDate: Date.now(),
          deleted: false,
          systemTags: [],
          tags: ['test', 'mock'],
          shareURL: '',
          publishURL: '',
        }
      },
      {
        id: 'note2',
        v: 1,
        d: {
          content: 'Another mock note with different content',
          creationDate: Date.now() - 86400000, // yesterday
          modificationDate: Date.now() - 3600000, // 1 hour ago
          deleted: false,
          systemTags: [],
          tags: ['important', 'test'],
          shareURL: '',
          publishURL: '',
        }
      },
      {
        id: 'note3',
        v: 1,
        d: {
          content: 'A third mock note that is deleted',
          creationDate: Date.now() - 172800000, // 2 days ago
          modificationDate: Date.now() - 86400000, // yesterday
          deleted: true,
          systemTags: [],
          tags: [],
          shareURL: '',
          publishURL: '',
        }
      }
    ];
    
    return {
      index: mockNotes,
      current: 'mock-cursor-token'
    };
  }

  try {
    const client = await getSimperiumApiClient();
    const path = `${params.bucketName}/index`;
    const queryParams: Record<string, string | number | boolean> = {};

    if (params.since) {
      queryParams.since = params.since;
    }
    if (params.limit) {
      queryParams.limit = params.limit.toString();
    }
    if (params.data !== undefined) {
      // Simperium expects '0' or '1' (stringified ints) for boolean query params
      queryParams.data = params.data ? '1' : '0';
    }
    if (params.mark) {
      queryParams.mark = params.mark;
    }
    
    logger.debug({ path, queryParams }, 'Fetching Simperium index');
    const res = await client.get<SimperiumIndexResponse>(path, { params: queryParams });
    return res.data;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      if (err.response?.status === 404) {
        throw new NotariumResourceNotFoundError(
          'Simperium index not found',
          'Could not find notes on Simplenote server.',
          { error: err.message },
          err
        );
      } else if (err.response?.status === 401) {
        throw new NotariumAuthError(
          'Unauthorized access to Simperium index',
          'Authentication with Simplenote failed.',
          { error: err.message },
          err
        );
      } else if (err.code === 'ECONNABORTED') {
        throw new NotariumTimeoutError(
          'Simperium index request timed out',
          'Request to Simplenote server timed out.',
          { error: err.message },
          err
        );
      }
    }
    
    throw new NotariumBackendError(
      `Failed to fetch Simperium index for bucket ${params.bucketName}: ${err instanceof Error ? err.message : 'Unknown error'}`,
      'Could not retrieve notes from Simplenote server.',
      500,
      'unavailable',
      { bucketName: params.bucketName, error: err instanceof Error ? err.message : 'Unknown error' },
      'Please try again later or check your network connection.',
      err instanceof Error ? err : undefined
    );
  }
}

// Placeholder for getNoteContent - to fetch specific version of a note
export async function getNoteContent(
  bucketName: string,
  noteId: string,
  version: number,
): Promise<SimperiumNoteResponseData['data']> {
  const client = await getSimperiumApiClient();
  const url = `${bucketName}/i/${noteId}/v/${version}`;
  logger.debug({ url, bucketName, noteId, version }, 'Fetching note content from Simperium');
  try {
    const response = await client.get<SimperiumNoteResponseData['data']>(url); // Simperium returns the object data directly
    return response.data;
  } catch (error) {
    const axiosError = error as AxiosError;
    logger.error(
      {
        err: axiosError,
        url,
        bucket: bucketName,
        noteId,
        version,
        response: axiosError.response?.data,
      },
      'Error fetching Simperium note content.',
    );
    if (axiosError.response) {
      if (axiosError.response.status === 404) {
        throw new NotariumResourceNotFoundError(
          `Note content for ${noteId} version ${version} not found.`,
          'The specific version of the note could not be found on the server.',
          {
            bucket: bucketName,
            noteId,
            version,
          },
        );
      }
      throw new NotariumBackendError(
        `Failed to fetch note content for ${bucketName}/i/${noteId}/v/${version}. HTTP Status: ${axiosError.response.status}`,
        'Error communicating with Simplenote server while fetching note content.',
        axiosError.response.status,
        'unknown',
        axiosError.response.data as Record<string, any>,
        undefined,
        axiosError,
      );
    } else if (axiosError.request) {
      throw new NotariumTimeoutError(
        `Request to fetch note content for ${bucketName}/i/${noteId}/v/${version} failed (no response).`,
        'Could not reach Simplenote server to fetch note content.',
        undefined,
        axiosError,
      );
    } else {
      throw new NotariumInternalError(
        `Error setting up request to fetch Simperium note content: ${axiosError.message}`,
        'Internal error preparing to fetch note content.',
        undefined,
        axiosError,
      );
    }
  }
}

// Interface for the payload to save/update a note
export interface SimperiumNotePayload {
  content?: string;
  tags?: string[];
  deleted?: boolean;
  creationDate?: number; // Optional: Simperium usually sets this on creation
  modificationDate?: number; // Optional: Simperium usually sets this
  // Other Simplenote-specific fields might be applicable if supported by API
}

// Expected response structure from a successful save/update operation.
// Simperium usually returns the full object with its new version in headers.
// The data part here matches SimperiumNoteResponseData['data']
export interface SimperiumSaveResponse {
  id: string; // The ID of the note saved
  version: number; // The new server version of the note
  data: SimperiumNoteResponseData['data']; // The full state of the note as returned by server
}

/**
 * Creates or updates a note in Simperium.
 * If `noteId` is provided and `baseVersion` is provided, it attempts an update.
 * Otherwise, it attempts to create a new note (Simperium requires ID to be client-generated for POST to /i/ID/).
 */
export async function saveNote(
  bucketName: string,
  noteId: string, // Must be provided even for new notes, client-generated UUID
  payload: SimperiumNotePayload,
  baseVersion?: number, // Provide for updates to enable conflict detection (If-Match header)
): Promise<SimperiumSaveResponse> {
  const client = await getSimperiumApiClient();
  let urlPath: string; // Changed from full URL to path relative to apiClient.baseURL
  const requestConfig: AxiosRequestConfig = {};

  if (baseVersion !== undefined) {
    // Update existing note: POST to /<bucket_name>/i/<note_id>/v/<base_version>
    urlPath = `${bucketName}/i/${noteId}/v/${baseVersion}`;
    requestConfig.headers = { 'If-Match': String(baseVersion) }; // If-Match must be a string
    logger.info({ path: urlPath, bucketName, noteId, baseVersion, payload }, 'Updating note in Simperium');
  } else {
    // Create new note: POST to /<bucket_name>/i/<note_id>/
    urlPath = `${bucketName}/i/${noteId}/`;
    logger.info({ path: urlPath, bucketName, noteId, payload }, 'Creating new note in Simperium');
  }

  try {
    // apiClient has baseURL, so urlPath should be relative
    const response = await client.post<SimperiumNoteResponseData['data']>(
      urlPath,
      payload,
      requestConfig,
    );

    const responseVersionHeader = response.headers['x-simperium-version'];
    if (!responseVersionHeader) {
      logger.warn(
        { headers: response.headers, noteId },
        'Simperium save response missing x-simperium-version header.',
      );
      // Fallback or throw, depending on strictness. For now, attempt to use provided baseVersion or assume 0 if new.
    }

    let newServerVersion: number;
    if (Array.isArray(responseVersionHeader)) {
      // Axios may return an array if multiple headers of same name are present
      newServerVersion = parseInt(responseVersionHeader[0], 10);
    } else if (typeof responseVersionHeader === 'string') {
      newServerVersion = parseInt(responseVersionHeader, 10);
    } else if (baseVersion !== undefined) {
      newServerVersion = baseVersion + 1; // Fallback
    } else {
      newServerVersion = 0; // Creation fallback
    }

    if (isNaN(newServerVersion)) {
      throw new NotariumBackendError(
        `Invalid x-simperium-version header received: ${responseVersionHeader}`,
        'Received an invalid version from Simplenote server after saving.',
        500,
        'unknown',
        { headerValue: responseVersionHeader },
      );
    }

    return {
      id: noteId, // ID remains the same
      version: newServerVersion,
      data: response.data, // Simperium returns the object data directly on POST for create/update
    };
  } catch (error) {
    const axiosError = error as AxiosError;
    logger.error(
      { err: axiosError, url: urlPath, bucket: bucketName, noteId, response: axiosError.response?.data },
      'Error saving note to Simperium.',
    );
    if (axiosError.response) {
      if (axiosError.response.status === 409 || axiosError.response.status === 412) {
        // Conflict or Precondition Failed
        throw new NotariumBackendError(
          `Simperium save conflict for note ${noteId}. HTTP Status: ${axiosError.response.status}`,
          'Could not save note due to a version conflict. Please try getting the latest version.',
          axiosError.response.status,
          'conflict',
          axiosError.response.data as Record<string, any>,
          'Try fetching the note again to get latest server version (s_ver) and re-apply changes.',
          axiosError,
        );
      } else if (axiosError.response.status === 400) {
        // Bad Request (e.g. validation error on payload)
        throw new NotariumBackendError(
          `Simperium save bad request for note ${noteId}. HTTP Status: 400. Data: ${JSON.stringify(axiosError.response.data)}`,
          'The note data was invalid or not accepted by the Simplenote server.',
          400,
          'validation_error', // Custom subcategory
          axiosError.response.data as Record<string, any>,
          'Please check the note content and metadata.',
          axiosError,
        );
      }
      throw new NotariumBackendError(
        `Failed to save note ${noteId}. HTTP Status: ${axiosError.response.status}`,
        'Error communicating with Simplenote server while saving note.',
        axiosError.response.status,
        'unknown',
        axiosError.response.data as Record<string, any>,
        undefined,
        axiosError,
      );
    } else if (axiosError.request) {
      throw new NotariumTimeoutError(
        `Request to save note ${noteId} failed (no response).`,
        'Could not reach Simplenote server to save note.',
        undefined,
        axiosError,
      );
    } else {
      throw new NotariumInternalError(
        `Error setting up request to save Simperium note: ${axiosError.message}`,
        'Internal error preparing to save note.',
        undefined,
        axiosError,
      );
    }
  }
}

logger.info('Simperium API Client updated with saveNote function.');
