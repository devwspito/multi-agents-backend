/**
 * StringUtils
 *
 * Centralized utility for string manipulation operations.
 * Replaces duplicated patterns like truncation, formatting, etc.
 *
 * Usage:
 *   StringUtils.truncate(longText, 100);
 *   StringUtils.shortCommitSha(sha);
 *   StringUtils.formatDuration(ms);
 */

export class StringUtils {
  /**
   * Truncate a string to a maximum length with ellipsis
   *
   * @param str - String to truncate
   * @param maxLength - Maximum length (default: 100)
   * @param suffix - Suffix to append (default: '...')
   * @returns Truncated string
   */
  static truncate(
    str: string | undefined | null,
    maxLength: number = 100,
    suffix: string = '...'
  ): string {
    if (!str) return '';
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength - suffix.length) + suffix;
  }

  /**
   * Truncate from the middle, keeping start and end
   *
   * @param str - String to truncate
   * @param maxLength - Maximum length
   * @param separator - Separator in the middle (default: '...')
   */
  static truncateMiddle(
    str: string | undefined | null,
    maxLength: number = 50,
    separator: string = '...'
  ): string {
    if (!str) return '';
    if (str.length <= maxLength) return str;

    const charsToShow = maxLength - separator.length;
    const frontChars = Math.ceil(charsToShow / 2);
    const backChars = Math.floor(charsToShow / 2);

    return str.substring(0, frontChars) + separator + str.substring(str.length - backChars);
  }

  /**
   * Shorten a git commit SHA to 7 characters
   *
   * @param sha - Full SHA
   * @returns Short SHA (7 chars)
   */
  static shortCommitSha(sha: string | undefined | null): string {
    if (!sha) return 'unknown';
    return sha.substring(0, 7);
  }

  /**
   * Shorten a Docker container ID to 12 characters
   *
   * @param containerId - Full container ID
   * @returns Short container ID (12 chars)
   */
  static shortContainerId(containerId: string | undefined | null): string {
    if (!containerId) return 'unknown';
    return containerId.substring(0, 12);
  }

  /**
   * Format a duration in milliseconds to human readable format
   *
   * @param ms - Duration in milliseconds
   * @param options - Formatting options
   * @returns Formatted duration string
   */
  static formatDuration(
    ms: number,
    options: {
      shortFormat?: boolean;
      maxUnits?: number;
    } = {}
  ): string {
    if (ms < 0) return '0ms';

    const { shortFormat = false, maxUnits = 2 } = options;

    const units = [
      { name: 'hour', short: 'h', ms: 3600000 },
      { name: 'minute', short: 'm', ms: 60000 },
      { name: 'second', short: 's', ms: 1000 },
      { name: 'millisecond', short: 'ms', ms: 1 },
    ];

    const parts: string[] = [];

    for (const unit of units) {
      if (parts.length >= maxUnits) break;

      const value = Math.floor(ms / unit.ms);
      if (value > 0 || (parts.length === 0 && unit.name === 'millisecond')) {
        if (shortFormat) {
          parts.push(`${value}${unit.short}`);
        } else {
          parts.push(`${value} ${unit.name}${value !== 1 ? 's' : ''}`);
        }
        ms %= unit.ms;
      }
    }

    return parts.join(' ') || '0ms';
  }

  /**
   * Format a file size in bytes to human readable format
   *
   * @param bytes - Size in bytes
   * @returns Formatted size string
   */
  static formatFileSize(bytes: number): string {
    if (bytes < 0) return '0 B';

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unitIndex = 0;
    let size = bytes;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(unitIndex > 0 ? 1 : 0)} ${units[unitIndex]}`;
  }

  /**
   * Format a number with thousands separators
   *
   * @param num - Number to format
   * @returns Formatted number string
   */
  static formatNumber(num: number): string {
    return num.toLocaleString('en-US');
  }

  /**
   * Format cost in USD
   *
   * @param cost - Cost in dollars
   * @param precision - Decimal places (default: 4)
   * @returns Formatted cost string
   */
  static formatCost(cost: number, precision: number = 4): string {
    return `$${cost.toFixed(precision)}`;
  }

  /**
   * Mask sensitive data (API keys, tokens, etc.)
   *
   * @param str - String to mask
   * @param visibleChars - Number of visible characters at start and end
   * @param maskChar - Character to use for masking (default: '*')
   */
  static mask(
    str: string | undefined | null,
    visibleChars: number = 4,
    maskChar: string = '*'
  ): string {
    if (!str) return '';
    if (str.length <= visibleChars * 2) return maskChar.repeat(str.length);

    const start = str.substring(0, visibleChars);
    const end = str.substring(str.length - visibleChars);
    const masked = maskChar.repeat(Math.min(8, str.length - visibleChars * 2));

    return `${start}${masked}${end}`;
  }

  /**
   * Mask a URL's embedded credentials
   *
   * @param url - URL string
   * @returns URL with masked credentials
   */
  static maskUrlCredentials(url: string | undefined | null): string {
    if (!url) return '';
    return url.replace(/\/\/[^:]+:[^@]+@/, '//*****:*****@');
  }

  /**
   * Convert a string to slug format (kebab-case, lowercase)
   *
   * @param str - String to convert
   * @returns Slug string
   */
  static toSlug(str: string | undefined | null): string {
    if (!str) return '';
    return str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Convert a string to camelCase
   *
   * @param str - String to convert
   * @returns camelCase string
   */
  static toCamelCase(str: string | undefined | null): string {
    if (!str) return '';
    return str
      .replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
      .replace(/^./, (c) => c.toLowerCase());
  }

  /**
   * Convert a string to PascalCase
   *
   * @param str - String to convert
   * @returns PascalCase string
   */
  static toPascalCase(str: string | undefined | null): string {
    if (!str) return '';
    const camel = this.toCamelCase(str);
    return camel.charAt(0).toUpperCase() + camel.slice(1);
  }

  /**
   * Safely get the first N lines of a string
   *
   * @param str - String to process
   * @param n - Number of lines
   * @returns First N lines
   */
  static firstLines(str: string | undefined | null, n: number): string {
    if (!str) return '';
    const lines = str.split('\n');
    return lines.slice(0, n).join('\n');
  }

  /**
   * Safely get the last N lines of a string
   *
   * @param str - String to process
   * @param n - Number of lines
   * @returns Last N lines
   */
  static lastLines(str: string | undefined | null, n: number): string {
    if (!str) return '';
    const lines = str.split('\n');
    return lines.slice(-n).join('\n');
  }

  /**
   * Indent all lines of a string
   *
   * @param str - String to indent
   * @param spaces - Number of spaces (default: 2)
   * @returns Indented string
   */
  static indent(str: string | undefined | null, spaces: number = 2): string {
    if (!str) return '';
    const padding = ' '.repeat(spaces);
    return str.split('\n').map(line => padding + line).join('\n');
  }

  /**
   * Strip ANSI color codes from a string
   *
   * @param str - String with ANSI codes
   * @returns Clean string
   */
  static stripAnsi(str: string | undefined | null): string {
    if (!str) return '';
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1B[[(?);]{0,2}(;?\d)*./g, '');
  }

  /**
   * Check if a string contains any of the given substrings
   *
   * @param str - String to check
   * @param substrings - Substrings to search for
   * @param caseInsensitive - Whether to ignore case
   */
  static containsAny(
    str: string | undefined | null,
    substrings: string[],
    caseInsensitive: boolean = false
  ): boolean {
    if (!str) return false;
    const searchStr = caseInsensitive ? str.toLowerCase() : str;
    return substrings.some(sub =>
      searchStr.includes(caseInsensitive ? sub.toLowerCase() : sub)
    );
  }

  /**
   * Extract file extension from a path or filename
   *
   * @param filename - File path or name
   * @returns Extension without dot, or empty string
   */
  static getExtension(filename: string | undefined | null): string {
    if (!filename) return '';
    const match = filename.match(/\.([^.]+)$/);
    return match ? match[1].toLowerCase() : '';
  }

  /**
   * Pluralize a word based on count
   *
   * @param count - The count
   * @param singular - Singular form
   * @param plural - Plural form (default: singular + 's')
   */
  static pluralize(
    count: number,
    singular: string,
    plural?: string
  ): string {
    return count === 1 ? singular : (plural || `${singular}s`);
  }

  /**
   * Format a count with its unit
   *
   * @param count - The count
   * @param singular - Singular form
   * @param plural - Plural form (default: singular + 's')
   */
  static formatCount(
    count: number,
    singular: string,
    plural?: string
  ): string {
    return `${count} ${this.pluralize(count, singular, plural)}`;
  }
}

// Export convenience functions
export const truncate = StringUtils.truncate.bind(StringUtils);
export const shortCommitSha = StringUtils.shortCommitSha.bind(StringUtils);
export const shortContainerId = StringUtils.shortContainerId.bind(StringUtils);
export const formatDuration = StringUtils.formatDuration.bind(StringUtils);
export const formatFileSize = StringUtils.formatFileSize.bind(StringUtils);
export const formatCost = StringUtils.formatCost.bind(StringUtils);
export const mask = StringUtils.mask.bind(StringUtils);

export default StringUtils;
