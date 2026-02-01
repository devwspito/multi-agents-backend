/**
 * ValidationUtils
 *
 * Centralized validation utilities for common patterns across the codebase.
 * Replaces duplicated validation logic like taskId checks, path validations, etc.
 *
 * Usage:
 *   // Validate required string
 *   ValidationUtils.requireString(taskId, 'taskId');
 *
 *   // Validate with custom error
 *   ValidationUtils.requirePath(workspacePath, 'workspacePath', { mustExist: true });
 *
 *   // Validate object has required fields
 *   ValidationUtils.requireFields(repo, ['name', 'localPath']);
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ValidationError extends Error {
  code: string;
  field?: string;
  value?: any;
}

/**
 * Create a ValidationError with consistent format
 */
function createValidationError(
  message: string,
  code: string,
  field?: string,
  value?: any
): ValidationError {
  const error = new Error(message) as ValidationError;
  error.code = code;
  error.field = field;
  error.value = value;
  error.name = 'ValidationError';
  return error;
}

export class ValidationUtils {
  /**
   * Validate that a value is a non-empty string
   *
   * @param value - Value to validate
   * @param fieldName - Name of the field for error messages
   * @throws ValidationError if value is not a valid string
   */
  static requireString(value: unknown, fieldName: string): string {
    if (value === undefined || value === null) {
      throw createValidationError(
        `${fieldName} is required`,
        'REQUIRED_FIELD',
        fieldName,
        value
      );
    }

    if (typeof value !== 'string') {
      throw createValidationError(
        `${fieldName} must be a string, got ${typeof value}`,
        'INVALID_TYPE',
        fieldName,
        value
      );
    }

    if (value.trim().length === 0) {
      throw createValidationError(
        `${fieldName} cannot be empty`,
        'EMPTY_STRING',
        fieldName,
        value
      );
    }

    // Check for common invalid values
    if (value === 'undefined' || value === 'null') {
      throw createValidationError(
        `${fieldName} has invalid value "${value}"`,
        'INVALID_VALUE',
        fieldName,
        value
      );
    }

    return value;
  }

  /**
   * Validate that a value is a valid task ID
   *
   * @param value - Value to validate
   * @param fieldName - Name of the field for error messages (default: 'taskId')
   * @throws ValidationError if value is not a valid task ID
   */
  static requireTaskId(value: unknown, fieldName: string = 'taskId'): string {
    const taskId = this.requireString(value, fieldName);

    // Additional task ID validation (e.g., format, length)
    // Task IDs are typically UUIDs or MongoDB ObjectIds
    if (taskId.length < 10) {
      throw createValidationError(
        `${fieldName} "${taskId}" appears to be invalid (too short)`,
        'INVALID_TASK_ID',
        fieldName,
        value
      );
    }

    return taskId;
  }

  /**
   * Validate that a path is valid and optionally exists
   *
   * @param value - Value to validate
   * @param fieldName - Name of the field for error messages
   * @param options - Validation options
   * @throws ValidationError if path is invalid
   */
  static requirePath(
    value: unknown,
    fieldName: string,
    options: {
      mustExist?: boolean;
      mustBeDirectory?: boolean;
      mustBeFile?: boolean;
      mustBeAbsolute?: boolean;
    } = {}
  ): string {
    const pathStr = this.requireString(value, fieldName);

    // Check if path is absolute
    if (options.mustBeAbsolute !== false && !path.isAbsolute(pathStr)) {
      throw createValidationError(
        `${fieldName} must be an absolute path, got "${pathStr}"`,
        'RELATIVE_PATH',
        fieldName,
        value
      );
    }

    // Check if path exists
    if (options.mustExist) {
      if (!fs.existsSync(pathStr)) {
        throw createValidationError(
          `${fieldName} does not exist: "${pathStr}"`,
          'PATH_NOT_FOUND',
          fieldName,
          value
        );
      }

      // Check if it's a directory
      if (options.mustBeDirectory) {
        const stats = fs.statSync(pathStr);
        if (!stats.isDirectory()) {
          throw createValidationError(
            `${fieldName} is not a directory: "${pathStr}"`,
            'NOT_A_DIRECTORY',
            fieldName,
            value
          );
        }
      }

      // Check if it's a file
      if (options.mustBeFile) {
        const stats = fs.statSync(pathStr);
        if (!stats.isFile()) {
          throw createValidationError(
            `${fieldName} is not a file: "${pathStr}"`,
            'NOT_A_FILE',
            fieldName,
            value
          );
        }
      }
    }

    return pathStr;
  }

  /**
   * Validate that a value is a positive number
   *
   * @param value - Value to validate
   * @param fieldName - Name of the field for error messages
   * @param options - Validation options
   * @throws ValidationError if value is not a valid number
   */
  static requireNumber(
    value: unknown,
    fieldName: string,
    options: {
      min?: number;
      max?: number;
      allowZero?: boolean;
    } = {}
  ): number {
    if (value === undefined || value === null) {
      throw createValidationError(
        `${fieldName} is required`,
        'REQUIRED_FIELD',
        fieldName,
        value
      );
    }

    const num = typeof value === 'string' ? parseFloat(value) : value;

    if (typeof num !== 'number' || isNaN(num)) {
      throw createValidationError(
        `${fieldName} must be a number, got ${typeof value}`,
        'INVALID_TYPE',
        fieldName,
        value
      );
    }

    if (!options.allowZero && num === 0) {
      throw createValidationError(
        `${fieldName} cannot be zero`,
        'ZERO_NOT_ALLOWED',
        fieldName,
        value
      );
    }

    if (options.min !== undefined && num < options.min) {
      throw createValidationError(
        `${fieldName} must be at least ${options.min}, got ${num}`,
        'BELOW_MINIMUM',
        fieldName,
        value
      );
    }

    if (options.max !== undefined && num > options.max) {
      throw createValidationError(
        `${fieldName} must be at most ${options.max}, got ${num}`,
        'ABOVE_MAXIMUM',
        fieldName,
        value
      );
    }

    return num;
  }

  /**
   * Validate that an array is not empty
   *
   * @param value - Value to validate
   * @param fieldName - Name of the field for error messages
   * @throws ValidationError if value is not a non-empty array
   */
  static requireArray<T>(
    value: unknown,
    fieldName: string,
    options: {
      minLength?: number;
      maxLength?: number;
    } = {}
  ): T[] {
    if (value === undefined || value === null) {
      throw createValidationError(
        `${fieldName} is required`,
        'REQUIRED_FIELD',
        fieldName,
        value
      );
    }

    if (!Array.isArray(value)) {
      throw createValidationError(
        `${fieldName} must be an array, got ${typeof value}`,
        'INVALID_TYPE',
        fieldName,
        value
      );
    }

    const minLength = options.minLength ?? 1;
    if (value.length < minLength) {
      throw createValidationError(
        `${fieldName} must have at least ${minLength} item(s), got ${value.length}`,
        'ARRAY_TOO_SHORT',
        fieldName,
        value
      );
    }

    if (options.maxLength !== undefined && value.length > options.maxLength) {
      throw createValidationError(
        `${fieldName} must have at most ${options.maxLength} item(s), got ${value.length}`,
        'ARRAY_TOO_LONG',
        fieldName,
        value
      );
    }

    return value as T[];
  }

  /**
   * Validate that an object has required fields
   *
   * @param obj - Object to validate
   * @param requiredFields - Array of required field names
   * @param objectName - Name of the object for error messages
   * @throws ValidationError if any required field is missing
   */
  static requireFields<T extends object>(
    obj: T | null | undefined,
    requiredFields: (keyof T)[],
    objectName: string = 'object'
  ): T {
    if (obj === undefined || obj === null) {
      throw createValidationError(
        `${objectName} is required`,
        'REQUIRED_FIELD',
        objectName
      );
    }

    if (typeof obj !== 'object') {
      throw createValidationError(
        `${objectName} must be an object, got ${typeof obj}`,
        'INVALID_TYPE',
        objectName,
        obj
      );
    }

    const missingFields: string[] = [];

    for (const field of requiredFields) {
      const value = obj[field];
      if (value === undefined || value === null) {
        missingFields.push(String(field));
      } else if (typeof value === 'string' && value.trim().length === 0) {
        missingFields.push(`${String(field)} (empty)`);
      }
    }

    if (missingFields.length > 0) {
      throw createValidationError(
        `${objectName} is missing required fields: ${missingFields.join(', ')}`,
        'MISSING_FIELDS',
        objectName,
        obj
      );
    }

    return obj;
  }

  /**
   * Validate that a value is one of the allowed values
   *
   * @param value - Value to validate
   * @param allowedValues - Array of allowed values
   * @param fieldName - Name of the field for error messages
   * @throws ValidationError if value is not allowed
   */
  static requireOneOf<T>(
    value: unknown,
    allowedValues: readonly T[],
    fieldName: string
  ): T {
    if (!allowedValues.includes(value as T)) {
      throw createValidationError(
        `${fieldName} must be one of: ${allowedValues.join(', ')}. Got: ${value}`,
        'INVALID_VALUE',
        fieldName,
        value
      );
    }

    return value as T;
  }

  /**
   * Validate that a value matches a regex pattern
   *
   * @param value - Value to validate
   * @param pattern - Regex pattern
   * @param fieldName - Name of the field for error messages
   * @throws ValidationError if value doesn't match
   */
  static requirePattern(
    value: unknown,
    pattern: RegExp,
    fieldName: string,
    patternDescription?: string
  ): string {
    const str = this.requireString(value, fieldName);

    if (!pattern.test(str)) {
      throw createValidationError(
        `${fieldName} has invalid format${patternDescription ? `: ${patternDescription}` : ''}. Got: "${str}"`,
        'INVALID_FORMAT',
        fieldName,
        value
      );
    }

    return str;
  }

  /**
   * Validate optionally - returns undefined if value is null/undefined
   *
   * @param value - Value to validate
   * @param validator - Validation function
   * @returns Validated value or undefined
   */
  static optional<T>(
    value: unknown,
    validator: (v: unknown) => T
  ): T | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    return validator(value);
  }

  /**
   * Validate with default value - returns default if value is null/undefined
   *
   * @param value - Value to validate
   * @param defaultValue - Default value
   * @param validator - Validation function
   * @returns Validated value or default
   */
  static withDefault<T>(
    value: unknown,
    defaultValue: T,
    validator: (v: unknown) => T
  ): T {
    if (value === undefined || value === null) {
      return defaultValue;
    }
    return validator(value);
  }

  /**
   * Check if value is valid without throwing
   *
   * @param value - Value to validate
   * @param validator - Validation function
   * @returns true if valid, false otherwise
   */
  static isValid<T>(
    value: unknown,
    validator: (v: unknown) => T
  ): boolean {
    try {
      validator(value);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a custom validator function
   *
   * @param validate - Validation function
   * @param errorMessage - Error message if validation fails
   * @param errorCode - Error code for the validation error
   */
  static createValidator<T>(
    validate: (value: unknown) => boolean,
    errorMessage: string,
    errorCode: string = 'CUSTOM_VALIDATION'
  ): (value: unknown, fieldName: string) => T {
    return (value: unknown, fieldName: string): T => {
      if (!validate(value)) {
        throw createValidationError(
          `${fieldName}: ${errorMessage}`,
          errorCode,
          fieldName,
          value
        );
      }
      return value as T;
    };
  }
}

// Export convenience functions
export const requireString = ValidationUtils.requireString.bind(ValidationUtils);
export const requireTaskId = ValidationUtils.requireTaskId.bind(ValidationUtils);
export const requirePath = ValidationUtils.requirePath.bind(ValidationUtils);
export const requireNumber = ValidationUtils.requireNumber.bind(ValidationUtils);
export const requireArray = ValidationUtils.requireArray.bind(ValidationUtils);
export const requireFields = ValidationUtils.requireFields.bind(ValidationUtils);
export const requireOneOf = ValidationUtils.requireOneOf.bind(ValidationUtils);
export const requirePattern = ValidationUtils.requirePattern.bind(ValidationUtils);

export default ValidationUtils;
