/**
 * Array helper functions for cleaner conditional checks
 *
 * Replaces verbose patterns like:
 *   if (!arr || arr.length === 0) { ... }
 *   if (arr && arr.length > 0) { ... }
 *
 * With cleaner:
 *   if (isEmpty(arr)) { ... }
 *   if (isNotEmpty(arr)) { ... }
 */

/**
 * Check if array is empty, null, or undefined
 */
export function isEmpty<T>(arr: T[] | undefined | null): arr is undefined | null | [] {
  return !arr || arr.length === 0;
}

/**
 * Check if array has at least one element
 */
export function isNotEmpty<T>(arr: T[] | undefined | null): arr is T[] {
  return !!arr && arr.length > 0;
}

/**
 * Get first element or undefined
 */
export function first<T>(arr: T[] | undefined | null): T | undefined {
  return arr?.[0];
}

/**
 * Get last element or undefined
 */
export function last<T>(arr: T[] | undefined | null): T | undefined {
  return arr && arr.length > 0 ? arr[arr.length - 1] : undefined;
}

/**
 * Safely get array length (0 for null/undefined)
 */
export function safeLength<T>(arr: T[] | undefined | null): number {
  return arr?.length ?? 0;
}

/**
 * Filter out null/undefined values (with proper typing)
 */
export function compact<T>(arr: (T | null | undefined)[]): T[] {
  return arr.filter((item): item is T => item != null);
}

/**
 * Deduplicate array items
 */
export function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/**
 * Deduplicate by a key function
 */
export function uniqueBy<T, K>(arr: T[], keyFn: (item: T) => K): T[] {
  const seen = new Set<K>();
  return arr.filter(item => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Group array items by a key
 */
export function groupBy<T, K extends string | number>(
  arr: T[],
  keyFn: (item: T) => K
): Record<K, T[]> {
  return arr.reduce((acc, item) => {
    const key = keyFn(item);
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {} as Record<K, T[]>);
}

/**
 * Chunk array into smaller arrays
 */
export function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
