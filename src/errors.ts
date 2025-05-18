/**
 * Custom error hierarchy for MCP Notarium.
 * As per Section 13 of the specification.
 */

export type NotariumErrorCategory =
  | 'AUTH'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'BACKEND_API'
  | 'INTERNAL'
  | 'TIMEOUT'
  | 'DB_OPERATION';

export interface NotariumErrorParams {
  message: string;
  category: NotariumErrorCategory;
  httpStatusCode: number; // For mapping to MCP if applicable, or for internal HTTP client errors
  user_message: string; // User-friendly message for the LLM client
  details?: Record<string, any>;
  resolution_hint?: string;
  originalError?: Error;
  subcategory?: string; // e.g., 'conflict', 'rate_limit' for BACKEND_API
}

export class NotariumError extends Error implements NotariumErrorParams {
  public readonly category: NotariumErrorCategory;
  public readonly httpStatusCode: number;
  public readonly user_message: string;
  public readonly details?: Record<string, any>;
  public readonly resolution_hint?: string;
  public readonly originalError?: Error;
  public readonly subcategory?: string;

  constructor(params: NotariumErrorParams) {
    super(params.message);
    this.name = this.constructor.name;
    this.category = params.category;
    this.httpStatusCode = params.httpStatusCode;
    this.user_message = params.user_message;
    this.details = params.details;
    this.resolution_hint = params.resolution_hint;
    this.originalError = params.originalError;
    this.subcategory = params.subcategory;

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  public toDict(): Record<string, any> {
    return {
      name: this.name,
      message: this.message, // Internal message
      category: this.category,
      httpStatusCode: this.httpStatusCode,
      user_message: this.user_message, // Message for the LLM
      details: this.details,
      resolution_hint: this.resolution_hint,
      subcategory: this.subcategory,
      stack: this.stack, // Optional: include stack for debugging if needed by MCP framework
      // originalError: this.originalError ? { message: this.originalError.message, name: this.originalError.name, stack: this.originalError.stack } : undefined,
    };
  }
}

// --- Specific Error Subclasses ---

export class NotariumAuthError extends NotariumError {
  constructor(
    message: string,
    user_message: string,
    details?: Record<string, any>,
    originalError?: Error,
  ) {
    super({
      message,
      category: 'AUTH',
      httpStatusCode: 401, // Typically Unauthorized
      user_message,
      details,
      originalError,
    });
  }
}

export class NotariumValidationError extends NotariumError {
  constructor(
    message: string,
    user_message: string,
    details?: Record<string, any>,
    originalError?: Error,
  ) {
    super({
      message,
      category: 'VALIDATION',
      httpStatusCode: 400, // Typically Bad Request
      user_message,
      details, // Often Zod error details
      originalError,
    });
  }
}

export class NotariumResourceNotFoundError extends NotariumError {
  constructor(
    message: string,
    user_message: string,
    details?: Record<string, any>,
    originalError?: Error,
  ) {
    super({
      message,
      category: 'NOT_FOUND',
      httpStatusCode: 404, // Typically Not Found
      user_message,
      details,
      originalError,
    });
  }
}

export class NotariumBackendError extends NotariumError {
  constructor(
    message: string,
    user_message: string,
    backendStatusCode: number,
    subcategory?:
      | 'conflict'
      | 'timeout'
      | 'rate_limit'
      | 'unavailable'
      | 'validation_error'
      | 'unknown',
    details?: Record<string, any>,
    resolution_hint?: string,
    originalError?: Error,
  ) {
    super({
      message,
      category: 'BACKEND_API',
      httpStatusCode: backendStatusCode, // Reflect backend's status code
      user_message,
      details,
      resolution_hint,
      originalError,
      subcategory,
    });
  }
}

export class NotariumInternalError extends NotariumError {
  constructor(
    message: string,
    user_message = 'An unexpected internal error occurred.',
    details?: Record<string, any>,
    originalError?: Error,
  ) {
    super({
      message,
      category: 'INTERNAL',
      httpStatusCode: 500, // Typically Internal Server Error
      user_message,
      details,
      originalError,
    });
  }
}

export class NotariumTimeoutError extends NotariumError {
  constructor(
    message: string,
    user_message: string,
    details?: Record<string, any>,
    originalError?: Error,
  ) {
    super({
      message,
      category: 'TIMEOUT',
      httpStatusCode: 504, // Gateway Timeout, or 408 Request Timeout depending on context
      user_message,
      details,
      originalError,
    });
  }
}

export class NotariumDbError extends NotariumError {
  constructor(
    message: string,
    user_message = 'A database operation failed.',
    details?: Record<string, any>,
    originalError?: Error,
  ) {
    super({
      message,
      category: 'DB_OPERATION',
      httpStatusCode: 500, // Internal error related to DB
      user_message,
      details,
      originalError,
    });
  }
}
