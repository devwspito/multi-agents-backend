/**
 * Database Utilities
 *
 * Helper functions for SQLite operations
 */

import crypto from 'crypto';

/**
 * Generate a unique ID (replaces MongoDB ObjectId)
 * Format: 24 character hex string (same length as MongoDB ObjectId)
 */
export function generateId(): string {
  return crypto.randomBytes(12).toString('hex');
}

/**
 * Get current ISO timestamp
 */
export function now(): string {
  return new Date().toISOString();
}

/**
 * Parse JSON safely, returning default value on error
 */
export function parseJSON<T>(json: string | null | undefined, defaultValue: T): T {
  if (!json) return defaultValue;
  try {
    return JSON.parse(json) as T;
  } catch {
    return defaultValue;
  }
}

/**
 * Stringify value to JSON, handling undefined
 */
export function toJSON(value: any): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

/**
 * Convert boolean to SQLite integer (0 or 1)
 */
export function boolToInt(value: boolean | undefined): number {
  return value ? 1 : 0;
}

/**
 * Convert SQLite integer to boolean
 */
export function intToBool(value: number | null | undefined): boolean {
  return value === 1;
}

/**
 * Convert Date to ISO string
 */
export function dateToString(date: Date | undefined | null): string | null {
  if (!date) return null;
  return date instanceof Date ? date.toISOString() : date;
}

/**
 * Convert ISO string to Date
 */
export function stringToDate(str: string | null | undefined): Date | undefined {
  if (!str) return undefined;
  return new Date(str);
}

/**
 * Convert array to JSON string
 */
export function arrayToJSON(arr: any[] | undefined): string | null {
  if (!arr || arr.length === 0) return null;
  return JSON.stringify(arr);
}

/**
 * Parse JSON array
 */
export function parseArray<T>(json: string | null | undefined): T[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as T[];
  } catch {
    return [];
  }
}

/**
 * Validate that an ID is in valid format
 */
export function isValidId(id: string | undefined | null): boolean {
  if (!id) return false;
  // Accept 24-char hex (like MongoDB) or any non-empty string
  return typeof id === 'string' && id.length > 0;
}
