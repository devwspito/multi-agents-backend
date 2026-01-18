/**
 * Formatting helpers for consistent output across phases
 */

/**
 * Get emoji for repository type
 * Replaces repeated ternary chains like:
 *   type === 'backend' ? '🔧' : type === 'frontend' ? '🎨' : '📦'
 */
export function getRepoTypeEmoji(type: string | undefined): string {
  const emojiMap: Record<string, string> = {
    backend: '🔧',
    frontend: '🎨',
    mobile: '📱',
    shared: '📦',
    library: '📚',
    api: '🌐',
    database: '🗄️',
    infrastructure: '☁️',
  };
  return emojiMap[type || ''] || '📦';
}

/**
 * Get emoji for phase status
 */
export function getStatusEmoji(status: string): string {
  const emojiMap: Record<string, string> = {
    pending: '⏳',
    'in-progress': '🔄',
    running: '🔄',
    completed: '✅',
    success: '✅',
    failed: '❌',
    error: '❌',
    skipped: '⏭️',
    cancelled: '🛑',
    waiting: '⏸️',
  };
  return emojiMap[status] || '❓';
}

/**
 * Get emoji for agent type
 */
export function getAgentEmoji(agentType: string): string {
  const emojiMap: Record<string, string> = {
    planning: '📋',
    'tech-lead': '👨‍💻',
    developer: '⌨️',
    judge: '⚖️',
    qa: '🧪',
    fixer: '🔧',
    orchestrator: '🎭',
  };
  return emojiMap[agentType] || '🤖';
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Format duration in milliseconds to human readable
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3600_000)}h ${Math.floor((ms % 3600_000) / 60_000)}m`;
}

/**
 * Truncate string with ellipsis
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}
