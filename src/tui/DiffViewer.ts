/**
 * DiffViewer - Advanced Code Diff Visualization
 *
 * Features:
 * - Side-by-side diff view
 * - Unified diff view
 * - Syntax highlighting
 * - Line numbers
 * - Context lines
 */

import chalk from 'chalk';
import { diffLines, diffWords, Change } from 'diff';

// ==================== TYPES ====================

export interface DiffOptions {
  mode: 'unified' | 'split';
  context: number;  // Lines of context around changes
  syntaxHighlight: boolean;
  showLineNumbers: boolean;
  maxWidth?: number;
}

export interface DiffResult {
  formatted: string;
  additions: number;
  deletions: number;
  changes: number;
}

// ==================== SYNTAX HIGHLIGHTING ====================

const SYNTAX_RULES: Record<string, Array<{ pattern: RegExp; color: string }>> = {
  typescript: [
    { pattern: /\b(import|export|from|const|let|var|function|class|interface|type|enum|async|await|return|if|else|for|while|try|catch|throw|new|this|super|extends|implements)\b/g, color: '#c678dd' },
    { pattern: /\b(true|false|null|undefined|void)\b/g, color: '#d19a66' },
    { pattern: /(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, color: '#98c379' },
    { pattern: /\/\/.*$/gm, color: '#5c6370' },
    { pattern: /\/\*[\s\S]*?\*\//g, color: '#5c6370' },
    { pattern: /\b\d+\.?\d*\b/g, color: '#d19a66' },
    { pattern: /[{}[\]()]/g, color: '#abb2bf' },
    { pattern: /[@#]/g, color: '#e5c07b' },
    { pattern: /\b([A-Z][a-zA-Z0-9]*)\b/g, color: '#e5c07b' },
  ],
  javascript: [], // Same as TypeScript
  python: [
    { pattern: /\b(import|from|def|class|if|elif|else|for|while|try|except|finally|with|as|return|yield|lambda|pass|break|continue|raise|assert|global|nonlocal)\b/g, color: '#c678dd' },
    { pattern: /\b(True|False|None)\b/g, color: '#d19a66' },
    { pattern: /(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, color: '#98c379' },
    { pattern: /#.*$/gm, color: '#5c6370' },
    { pattern: /\b\d+\.?\d*\b/g, color: '#d19a66' },
    { pattern: /self\b/g, color: '#e06c75' },
  ],
  go: [
    { pattern: /\b(package|import|func|type|struct|interface|var|const|if|else|for|range|switch|case|default|return|go|defer|select|chan|map|make|new)\b/g, color: '#c678dd' },
    { pattern: /\b(true|false|nil|iota)\b/g, color: '#d19a66' },
    { pattern: /(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, color: '#98c379' },
    { pattern: /\/\/.*$/gm, color: '#5c6370' },
  ],
  rust: [
    { pattern: /\b(fn|let|mut|const|static|struct|enum|impl|trait|use|mod|pub|self|super|crate|where|as|if|else|match|loop|while|for|in|return|break|continue|move|ref|type|unsafe|async|await)\b/g, color: '#c678dd' },
    { pattern: /\b(true|false|Some|None|Ok|Err)\b/g, color: '#d19a66' },
    { pattern: /(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, color: '#98c379' },
    { pattern: /\/\/.*$/gm, color: '#5c6370' },
  ]
};

SYNTAX_RULES.javascript = SYNTAX_RULES.typescript;

// ==================== DIFF VIEWER ====================

export class DiffViewer {
  private options: DiffOptions;

  constructor(options: Partial<DiffOptions> = {}) {
    this.options = {
      mode: 'unified',
      context: 3,
      syntaxHighlight: true,
      showLineNumbers: true,
      maxWidth: 120,
      ...options
    };
  }

  /**
   * Generate a formatted diff
   */
  generate(
    oldContent: string,
    newContent: string,
    filePath?: string
  ): DiffResult {
    const changes = diffLines(oldContent, newContent);
    const language = this.detectLanguage(filePath);

    let additions = 0;
    let deletions = 0;

    for (const change of changes) {
      const lines = change.value.split('\n').filter(l => l !== '');
      if (change.added) {
        additions += lines.length;
      } else if (change.removed) {
        deletions += lines.length;
      }
    }

    const formatted = this.options.mode === 'unified'
      ? this.formatUnified(changes, language, filePath)
      : this.formatSplit(changes, language);

    return {
      formatted,
      additions,
      deletions,
      changes: additions + deletions
    };
  }

  /**
   * Generate inline word diff
   */
  generateInline(oldText: string, newText: string): string {
    const changes = diffWords(oldText, newText);
    let result = '';

    for (const change of changes) {
      if (change.added) {
        result += chalk.bgGreen.black(change.value);
      } else if (change.removed) {
        result += chalk.bgRed.black(change.value);
      } else {
        result += change.value;
      }
    }

    return result;
  }

  // ==================== PRIVATE METHODS ====================

  private formatUnified(changes: Change[], language: string, filePath?: string): string {
    const lines: string[] = [];

    // Header
    if (filePath) {
      lines.push(chalk.bold(`--- a/${filePath}`));
      lines.push(chalk.bold(`+++ b/${filePath}`));
    }

    let oldLine = 1;
    let newLine = 1;
    let contextBuffer: string[] = [];
    let inChange = false;

    for (let i = 0; i < changes.length; i++) {
      const change = changes[i];
      const changeLines = change.value.split('\n');

      // Remove empty last element from split
      if (changeLines[changeLines.length - 1] === '') {
        changeLines.pop();
      }

      if (change.added || change.removed) {
        // Flush context buffer before changes
        if (!inChange && contextBuffer.length > 0) {
          const contextStart = Math.max(0, contextBuffer.length - this.options.context);
          for (let j = contextStart; j < contextBuffer.length; j++) {
            const line = contextBuffer[j];
            const lineNum = oldLine - (contextBuffer.length - j);
            lines.push(this.formatLine(' ', line, lineNum, lineNum, language));
          }
        }
        inChange = true;
        contextBuffer = [];

        for (const line of changeLines) {
          if (change.added) {
            lines.push(this.formatLine('+', line, null, newLine, language));
            newLine++;
          } else {
            lines.push(this.formatLine('-', line, oldLine, null, language));
            oldLine++;
          }
        }
      } else {
        // Context lines
        if (inChange) {
          // Show context after changes
          const contextEnd = Math.min(changeLines.length, this.options.context);
          for (let j = 0; j < contextEnd; j++) {
            const line = changeLines[j];
            lines.push(this.formatLine(' ', line, oldLine, newLine, language));
            oldLine++;
            newLine++;
          }

          // Check if we need to show "..." for skipped lines
          if (changeLines.length > contextEnd * 2) {
            lines.push(chalk.cyan('  ...'));

            // Prepare for next change context
            oldLine += changeLines.length - contextEnd * 2;
            newLine += changeLines.length - contextEnd * 2;
          }

          inChange = false;
        }

        // Buffer context for potential next change
        for (const line of changeLines) {
          contextBuffer.push(line);
          if (contextBuffer.length > this.options.context * 2) {
            contextBuffer.shift();
          }
        }

        if (!inChange) {
          oldLine += changeLines.length;
          newLine += changeLines.length;
        }
      }
    }

    return lines.join('\n');
  }

  private formatSplit(changes: Change[], language: string): string {
    const leftLines: string[] = [];
    const rightLines: string[] = [];

    let oldLine = 1;
    let newLine = 1;

    for (const change of changes) {
      const changeLines = change.value.split('\n');
      if (changeLines[changeLines.length - 1] === '') {
        changeLines.pop();
      }

      for (const line of changeLines) {
        if (change.added) {
          leftLines.push('');
          rightLines.push(this.formatLine('+', line, null, newLine, language));
          newLine++;
        } else if (change.removed) {
          leftLines.push(this.formatLine('-', line, oldLine, null, language));
          rightLines.push('');
          oldLine++;
        } else {
          leftLines.push(this.formatLine(' ', line, oldLine, null, language));
          rightLines.push(this.formatLine(' ', line, null, newLine, language));
          oldLine++;
          newLine++;
        }
      }
    }

    // Combine side by side
    const width = Math.floor((this.options.maxWidth || 120) / 2) - 2;
    const result: string[] = [];

    for (let i = 0; i < Math.max(leftLines.length, rightLines.length); i++) {
      const left = (leftLines[i] || '').substring(0, width).padEnd(width);
      const right = (rightLines[i] || '').substring(0, width);
      result.push(`${left} │ ${right}`);
    }

    return result.join('\n');
  }

  private formatLine(
    prefix: string,
    content: string,
    oldLineNum: number | null,
    newLineNum: number | null,
    language: string
  ): string {
    let lineNumStr = '';

    if (this.options.showLineNumbers) {
      const old = oldLineNum?.toString().padStart(4) || '    ';
      const new_ = newLineNum?.toString().padStart(4) || '    ';
      lineNumStr = chalk.gray(`${old} ${new_} `);
    }

    let prefixColored: string;
    let contentColored: string;

    switch (prefix) {
      case '+':
        prefixColored = chalk.green('+');
        contentColored = this.options.syntaxHighlight
          ? chalk.green(this.highlight(content, language))
          : chalk.green(content);
        break;
      case '-':
        prefixColored = chalk.red('-');
        contentColored = this.options.syntaxHighlight
          ? chalk.red(this.highlight(content, language))
          : chalk.red(content);
        break;
      default:
        prefixColored = chalk.gray(' ');
        contentColored = this.options.syntaxHighlight
          ? this.highlight(content, language)
          : content;
    }

    return `${lineNumStr}${prefixColored} ${contentColored}`;
  }

  private highlight(content: string, language: string): string {
    const rules = SYNTAX_RULES[language] || [];

    if (rules.length === 0) {
      return content;
    }

    // Apply syntax highlighting rules
    let result = content;

    for (const rule of rules) {
      result = result.replace(rule.pattern, (match) => {
        return chalk.hex(rule.color)(match);
      });
    }

    return result;
  }

  private detectLanguage(filePath?: string): string {
    if (!filePath) return 'text';

    const ext = filePath.split('.').pop()?.toLowerCase();
    const mapping: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      py: 'python',
      go: 'go',
      rs: 'rust',
      java: 'java'
    };

    return mapping[ext || ''] || 'text';
  }
}

/**
 * Quick diff generation helper
 */
export function createDiff(
  oldContent: string,
  newContent: string,
  filePath?: string,
  options?: Partial<DiffOptions>
): string {
  const viewer = new DiffViewer(options);
  return viewer.generate(oldContent, newContent, filePath).formatted;
}

/**
 * Quick inline diff helper
 */
export function createInlineDiff(oldText: string, newText: string): string {
  const viewer = new DiffViewer();
  return viewer.generateInline(oldText, newText);
}
