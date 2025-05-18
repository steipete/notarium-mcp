import { describe, it, expect } from 'vitest';
import {
  NotariumError,
  NotariumAuthError,
  NotariumValidationError,
  NotariumResourceNotFoundError,
  NotariumBackendError,
  NotariumInternalError,
  NotariumTimeoutError,
  NotariumDbError,
  type NotariumErrorParams,
  type NotariumErrorCategory,
} from './errors.js';

describe('Custom Error Classes (errors.ts)', () => {
  describe('NotariumError (Base Class)', () => {
    const baseParams: NotariumErrorParams = {
      message: 'Base internal message',
      category: 'INTERNAL',
      httpStatusCode: 500,
      user_message: 'Base user message',
      details: { key: 'value' },
      resolution_hint: 'Try base hint',
      originalError: new Error('Original base error'),
      subcategory: 'base_sub',
    };

    it('should correctly instantiate with all parameters', () => {
      const err = new NotariumError(baseParams);
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(NotariumError);
      expect(err.name).toBe('NotariumError');
      expect(err.message).toBe(baseParams.message);
      expect(err.category).toBe(baseParams.category);
      expect(err.httpStatusCode).toBe(baseParams.httpStatusCode);
      expect(err.user_message).toBe(baseParams.user_message);
      expect(err.details).toEqual(baseParams.details);
      expect(err.resolution_hint).toBe(baseParams.resolution_hint);
      expect(err.originalError).toBe(baseParams.originalError);
      expect(err.subcategory).toBe(baseParams.subcategory);
    });

    it('toDict() should return a correctly structured object', () => {
      const err = new NotariumError(baseParams);
      const dict = err.toDict();
      expect(dict.name).toBe('NotariumError');
      expect(dict.message).toBe(baseParams.message);
      expect(dict.category).toBe(baseParams.category);
      expect(dict.httpStatusCode).toBe(baseParams.httpStatusCode);
      expect(dict.user_message).toBe(baseParams.user_message);
      expect(dict.details).toEqual(baseParams.details);
      expect(dict.resolution_hint).toBe(baseParams.resolution_hint);
      expect(dict.subcategory).toBe(baseParams.subcategory);
      expect(dict.stack).toBeDefined();
    });

    it('should handle optional parameters gracefully', () => {
      const minimalParams: NotariumErrorParams = {
        message: 'Minimal message',
        category: 'INTERNAL',
        httpStatusCode: 500,
        user_message: 'Minimal user message',
      };
      const err = new NotariumError(minimalParams);
      expect(err.details).toBeUndefined();
      expect(err.resolution_hint).toBeUndefined();
      expect(err.originalError).toBeUndefined();
      expect(err.subcategory).toBeUndefined();
      const dict = err.toDict();
      expect(dict.details).toBeUndefined();
    });
  });

  describe('NotariumAuthError', () => {
    it('should set correct category and httpStatusCode', () => {
      const err = new NotariumAuthError('Auth failed', 'User auth failed');
      expect(err.category).toBe('AUTH');
      expect(err.httpStatusCode).toBe(401);
      expect(err.user_message).toBe('User auth failed');
      expect(err.name).toBe('NotariumAuthError');
    });
  });

  describe('NotariumValidationError', () => {
    it('should set correct category and httpStatusCode', () => {
      const err = new NotariumValidationError('Validation failed', 'Input invalid', {
        field: 'name',
      });
      expect(err.category).toBe('VALIDATION');
      expect(err.httpStatusCode).toBe(400);
      expect(err.user_message).toBe('Input invalid');
      expect(err.details).toEqual({ field: 'name' });
      expect(err.name).toBe('NotariumValidationError');
    });
  });

  describe('NotariumResourceNotFoundError', () => {
    it('should set correct category and httpStatusCode', () => {
      const err = new NotariumResourceNotFoundError('Not found', 'Resource X not found');
      expect(err.category).toBe('NOT_FOUND');
      expect(err.httpStatusCode).toBe(404);
      expect(err.name).toBe('NotariumResourceNotFoundError');
    });
  });

  describe('NotariumBackendError', () => {
    it('should set correct category, httpStatusCode and subcategory', () => {
      const err = new NotariumBackendError(
        'Backend issue',
        'Server communication error',
        502,
        'conflict',
      );
      expect(err.category).toBe('BACKEND_API');
      expect(err.httpStatusCode).toBe(502);
      expect(err.subcategory).toBe('conflict');
      expect(err.name).toBe('NotariumBackendError');
    });
  });

  describe('NotariumInternalError', () => {
    it('should set correct category and httpStatusCode with default user_message', () => {
      const err = new NotariumInternalError('Internal issue');
      expect(err.category).toBe('INTERNAL');
      expect(err.httpStatusCode).toBe(500);
      expect(err.user_message).toBe('An unexpected internal error occurred.');
      expect(err.name).toBe('NotariumInternalError');
    });
    it('should allow overriding user_message', () => {
      const err = new NotariumInternalError('Internal issue', 'Custom internal message');
      expect(err.user_message).toBe('Custom internal message');
    });
  });

  describe('NotariumTimeoutError', () => {
    it('should set correct category and httpStatusCode', () => {
      const err = new NotariumTimeoutError('Request timed out', 'Operation timed out');
      expect(err.category).toBe('TIMEOUT');
      expect(err.httpStatusCode).toBe(504);
      expect(err.name).toBe('NotariumTimeoutError');
    });
  });

  describe('NotariumDbError', () => {
    it('should set correct category and httpStatusCode with default user_message', () => {
      const err = new NotariumDbError('DB query failed');
      expect(err.category).toBe('DB_OPERATION');
      expect(err.httpStatusCode).toBe(500);
      expect(err.user_message).toBe('A database operation failed.');
      expect(err.name).toBe('NotariumDbError');
    });
  });
});
