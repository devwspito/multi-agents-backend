/**
 * ApiResponse
 *
 * Centralized API response utilities for consistent response formatting.
 * Replaces scattered response patterns across route files.
 *
 * Usage:
 *   import { ApiResponse } from '../utils/ApiResponse';
 *
 *   // Success response
 *   ApiResponse.success(res, data, 'Operation completed');
 *
 *   // Error response
 *   ApiResponse.error(res, 'Resource not found', 404);
 *
 *   // Validation error
 *   ApiResponse.validationError(res, errors);
 *
 * Standard Response Format:
 *   Success: { success: true, data: T, message?: string }
 *   Error:   { success: false, error: string, code?: string, details?: any }
 */

import { Response } from 'express';

/**
 * Standard success response structure
 */
export interface SuccessResponse<T = any> {
  success: true;
  data: T;
  message?: string;
  meta?: {
    total?: number;
    page?: number;
    pageSize?: number;
    timestamp?: string;
  };
}

/**
 * Standard error response structure
 */
export interface ErrorResponse {
  success: false;
  error: string;
  code?: string;
  details?: any;
  hint?: string;
  timestamp?: string;
}

/**
 * Validation error details
 */
export interface ValidationErrorDetail {
  field: string;
  message: string;
  code?: string;
}

/**
 * Common HTTP status codes
 */
export const HttpStatus = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
} as const;

/**
 * Error codes for categorization
 */
export const ErrorCodes = {
  // Validation errors
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',
  MISSING_FIELD: 'MISSING_FIELD',

  // Auth errors
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',

  // Resource errors
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  CONFLICT: 'CONFLICT',

  // Operation errors
  OPERATION_FAILED: 'OPERATION_FAILED',
  TIMEOUT: 'TIMEOUT',
  RATE_LIMITED: 'RATE_LIMITED',

  // External service errors
  EXTERNAL_SERVICE_ERROR: 'EXTERNAL_SERVICE_ERROR',
  GITHUB_ERROR: 'GITHUB_ERROR',
  ANTHROPIC_ERROR: 'ANTHROPIC_ERROR',

  // Internal errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  DATABASE_ERROR: 'DATABASE_ERROR',
  CONFIG_ERROR: 'CONFIG_ERROR',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

export class ApiResponse {
  /**
   * Send a success response
   *
   * @param res - Express response object
   * @param data - Response data
   * @param message - Optional success message
   * @param status - HTTP status code (default: 200)
   */
  static success<T>(
    res: Response,
    data: T,
    message?: string,
    status: number = HttpStatus.OK
  ): Response {
    const response: SuccessResponse<T> = {
      success: true,
      data,
    };

    if (message) {
      response.message = message;
    }

    return res.status(status).json(response);
  }

  /**
   * Send a paginated success response
   *
   * @param res - Express response object
   * @param data - Response data array
   * @param total - Total count of items
   * @param page - Current page number
   * @param pageSize - Items per page
   */
  static paginated<T>(
    res: Response,
    data: T[],
    total: number,
    page: number = 1,
    pageSize: number = 20
  ): Response {
    const response: SuccessResponse<T[]> = {
      success: true,
      data,
      meta: {
        total,
        page,
        pageSize,
        timestamp: new Date().toISOString(),
      },
    };

    return res.status(HttpStatus.OK).json(response);
  }

  /**
   * Send a created response (201)
   *
   * @param res - Express response object
   * @param data - Created resource data
   * @param message - Optional success message
   */
  static created<T>(
    res: Response,
    data: T,
    message?: string
  ): Response {
    return this.success(res, data, message, HttpStatus.CREATED);
  }

  /**
   * Send a no content response (204)
   *
   * @param res - Express response object
   */
  static noContent(res: Response): Response {
    return res.status(HttpStatus.NO_CONTENT).send();
  }

  /**
   * Send an error response
   *
   * @param res - Express response object
   * @param error - Error message or Error object
   * @param status - HTTP status code (default: 500)
   * @param code - Error code for categorization
   * @param details - Additional error details
   */
  static error(
    res: Response,
    error: string | Error,
    status: number = HttpStatus.INTERNAL_SERVER_ERROR,
    code?: ErrorCode,
    details?: any
  ): Response {
    const message = error instanceof Error ? error.message : error;

    const response: ErrorResponse = {
      success: false,
      error: message,
      timestamp: new Date().toISOString(),
    };

    if (code) {
      response.code = code;
    }

    if (details) {
      response.details = details;
    }

    return res.status(status).json(response);
  }

  /**
   * Send a bad request error (400)
   *
   * @param res - Express response object
   * @param message - Error message
   * @param details - Additional details
   */
  static badRequest(
    res: Response,
    message: string = 'Bad request',
    details?: any
  ): Response {
    return this.error(res, message, HttpStatus.BAD_REQUEST, ErrorCodes.INVALID_INPUT, details);
  }

  /**
   * Send a validation error (422)
   *
   * @param res - Express response object
   * @param errors - Validation errors
   * @param message - Optional custom message
   */
  static validationError(
    res: Response,
    errors: ValidationErrorDetail[] | string[],
    message: string = 'Validation failed'
  ): Response {
    return this.error(
      res,
      message,
      HttpStatus.UNPROCESSABLE_ENTITY,
      ErrorCodes.VALIDATION_ERROR,
      { errors }
    );
  }

  /**
   * Send a Zod validation error
   *
   * @param res - Express response object
   * @param zodError - Zod error object
   */
  static zodError(res: Response, zodError: any): Response {
    const errors = zodError.errors?.map((e: any) => ({
      field: e.path?.join('.') || 'unknown',
      message: e.message,
      code: e.code,
    })) || [];

    return this.validationError(res, errors);
  }

  /**
   * Send an unauthorized error (401)
   *
   * @param res - Express response object
   * @param message - Error message
   */
  static unauthorized(
    res: Response,
    message: string = 'Authentication required'
  ): Response {
    return this.error(res, message, HttpStatus.UNAUTHORIZED, ErrorCodes.UNAUTHORIZED);
  }

  /**
   * Send a forbidden error (403)
   *
   * @param res - Express response object
   * @param message - Error message
   */
  static forbidden(
    res: Response,
    message: string = 'Access denied'
  ): Response {
    return this.error(res, message, HttpStatus.FORBIDDEN, ErrorCodes.FORBIDDEN);
  }

  /**
   * Send a not found error (404)
   *
   * @param res - Express response object
   * @param resource - Name of the resource that wasn't found
   */
  static notFound(
    res: Response,
    resource: string = 'Resource'
  ): Response {
    return this.error(
      res,
      `${resource} not found`,
      HttpStatus.NOT_FOUND,
      ErrorCodes.NOT_FOUND
    );
  }

  /**
   * Send a conflict error (409)
   *
   * @param res - Express response object
   * @param message - Error message
   */
  static conflict(
    res: Response,
    message: string = 'Resource conflict'
  ): Response {
    return this.error(res, message, HttpStatus.CONFLICT, ErrorCodes.CONFLICT);
  }

  /**
   * Send a rate limit error (429)
   *
   * @param res - Express response object
   * @param retryAfter - Seconds until retry is allowed
   */
  static rateLimited(
    res: Response,
    retryAfter?: number
  ): Response {
    if (retryAfter) {
      res.setHeader('Retry-After', retryAfter.toString());
    }
    return this.error(
      res,
      'Too many requests',
      HttpStatus.TOO_MANY_REQUESTS,
      ErrorCodes.RATE_LIMITED
    );
  }

  /**
   * Send an internal server error (500)
   *
   * @param res - Express response object
   * @param error - Error object or message
   * @param hint - Optional hint for troubleshooting
   */
  static internalError(
    res: Response,
    error: string | Error = 'Internal server error',
    hint?: string
  ): Response {
    const message = error instanceof Error ? error.message : error;

    const response: ErrorResponse = {
      success: false,
      error: message,
      code: ErrorCodes.INTERNAL_ERROR,
      timestamp: new Date().toISOString(),
    };

    if (hint) {
      response.hint = hint;
    }

    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json(response);
  }

  /**
   * Send an external service error (502)
   *
   * @param res - Express response object
   * @param service - Name of the external service
   * @param error - Error message
   */
  static externalError(
    res: Response,
    service: string,
    error: string | Error
  ): Response {
    const message = error instanceof Error ? error.message : error;
    return this.error(
      res,
      `${service} error: ${message}`,
      HttpStatus.BAD_GATEWAY,
      ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  /**
   * Send a timeout error (504)
   *
   * @param res - Express response object
   * @param operation - Name of the operation that timed out
   */
  static timeout(
    res: Response,
    operation: string = 'Operation'
  ): Response {
    return this.error(
      res,
      `${operation} timed out`,
      HttpStatus.GATEWAY_TIMEOUT,
      ErrorCodes.TIMEOUT
    );
  }

  /**
   * Handle an exception and send appropriate response
   *
   * @param res - Express response object
   * @param error - Error object
   * @param operation - Name of the operation that failed
   */
  static handleException(
    res: Response,
    error: any,
    operation: string = 'Operation'
  ): Response {
    // Log the error
    console.error(`❌ [ApiResponse] ${operation} failed:`, error.message);

    // Check for specific error types
    if (error.name === 'ZodError') {
      return this.zodError(res, error);
    }

    if (error.code === 'ENOENT') {
      return this.notFound(res, 'File');
    }

    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return this.forbidden(res, 'Permission denied');
    }

    if (error.name === 'ValidationError') {
      return this.validationError(res, [error.message]);
    }

    // Default to internal error
    return this.internalError(res, error);
  }
}

// Export convenience functions
export const success = ApiResponse.success.bind(ApiResponse);
export const error = ApiResponse.error.bind(ApiResponse);
export const notFound = ApiResponse.notFound.bind(ApiResponse);
export const badRequest = ApiResponse.badRequest.bind(ApiResponse);
export const validationError = ApiResponse.validationError.bind(ApiResponse);
export const internalError = ApiResponse.internalError.bind(ApiResponse);

export default ApiResponse;
