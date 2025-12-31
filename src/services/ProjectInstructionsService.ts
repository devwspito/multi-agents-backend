/**
 * ProjectInstructionsService - CLAUDE.md Project Instructions Loader
 *
 * Loads project-specific instructions from CLAUDE.md files
 * following Claude Code's hierarchy:
 * 1. Project: .claude/CLAUDE.md or ./CLAUDE.md
 * 2. Rules: .claude/rules/*.md (path-specific)
 * 3. Local: .CLAUDE.local.md (personal, gitignored)
 *
 * These instructions are injected into agent system prompts.
 */

import fs from 'fs';
import path from 'path';

export interface ProjectInstructions {
  content: string;
  sources: string[];
  rules: Array<{
    name: string;
    globs: string[];
    content: string;
  }>;
}

class ProjectInstructionsServiceClass {
  /**
   * Load all project instructions for a workspace
   */
  load(workspacePath: string): ProjectInstructions {
    const sources: string[] = [];
    const contents: string[] = [];
    const rules: ProjectInstructions['rules'] = [];

    // 1. Load main CLAUDE.md
    const mainPaths = [
      path.join(workspacePath, '.claude', 'CLAUDE.md'),
      path.join(workspacePath, 'CLAUDE.md'),
    ];

    for (const mainPath of mainPaths) {
      if (fs.existsSync(mainPath)) {
        const content = this.loadWithImports(mainPath);
        contents.push(content);
        sources.push(mainPath);
        break;
      }
    }

    // 2. Load rules from .claude/rules/
    const rulesDir = path.join(workspacePath, '.claude', 'rules');
    if (fs.existsSync(rulesDir)) {
      const ruleFiles = this.findMarkdownFiles(rulesDir);
      for (const ruleFile of ruleFiles) {
        const { content, globs } = this.loadRule(ruleFile);
        const name = path.relative(rulesDir, ruleFile).replace('.md', '');
        rules.push({ name, globs, content });
        sources.push(ruleFile);
      }
    }

    // 3. Load local (personal) instructions
    const localPath = path.join(workspacePath, '.CLAUDE.local.md');
    if (fs.existsSync(localPath)) {
      const content = fs.readFileSync(localPath, 'utf-8');
      contents.push(`\n<!-- Local Instructions -->\n${content}`);
      sources.push(localPath);
    }

    return {
      content: contents.join('\n\n---\n\n'),
      sources,
      rules,
    };
  }

  /**
   * Load file with @import support
   */
  private loadWithImports(filePath: string): string {
    let content = fs.readFileSync(filePath, 'utf-8');
    const basePath = path.dirname(filePath);

    // Process @path/to/file imports
    const importRegex = /@([^\s]+\.(md|txt))/g;
    let match: RegExpExecArray | null;

    while ((match = importRegex.exec(content)) !== null) {
      const importPath = path.join(basePath, match[1]);
      if (fs.existsSync(importPath)) {
        const importContent = fs.readFileSync(importPath, 'utf-8');
        content = content.replace(match[0], importContent);
      }
    }

    return content;
  }

  /**
   * Load a rule file with frontmatter parsing
   */
  private loadRule(filePath: string): { content: string; globs: string[] } {
    const raw = fs.readFileSync(filePath, 'utf-8');

    // Parse YAML frontmatter
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) {
      return { content: raw, globs: [] };
    }

    const frontmatter = match[1];
    const body = match[2];

    // Extract globs from frontmatter
    const globMatch = frontmatter.match(/globs:\s*\[([^\]]+)\]/);
    const globs = globMatch
      ? globMatch[1].split(',').map(g => g.trim().replace(/['"]/g, ''))
      : [];

    return { content: body, globs };
  }

  /**
   * Find all markdown files recursively
   */
  private findMarkdownFiles(dir: string): string[] {
    const files: string[] = [];
    if (!fs.existsSync(dir)) return files;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.findMarkdownFiles(fullPath));
      } else if (entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }
    return files;
  }

  /**
   * Get rules applicable to a specific file path
   */
  getApplicableRules(instructions: ProjectInstructions, filePath: string): string[] {
    const applicable: string[] = [];

    for (const rule of instructions.rules) {
      if (rule.globs.length === 0) {
        // No globs = applies to all
        applicable.push(rule.content);
      } else {
        // Check if file matches any glob
        for (const glob of rule.globs) {
          if (this.matchGlob(filePath, glob)) {
            applicable.push(rule.content);
            break;
          }
        }
      }
    }

    return applicable;
  }

  /**
   * Simple glob matching
   */
  private matchGlob(filePath: string, pattern: string): boolean {
    const regexPattern = pattern
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '.')
      .replace(/\./g, '\\.');

    return new RegExp(`^${regexPattern}$`).test(filePath);
  }

  /**
   * Check if project has CLAUDE.md
   */
  hasInstructions(workspacePath: string): boolean {
    return fs.existsSync(path.join(workspacePath, '.claude', 'CLAUDE.md')) ||
           fs.existsSync(path.join(workspacePath, 'CLAUDE.md'));
  }

  /**
   * Initialize CLAUDE.md for a project
   */
  init(workspacePath: string): string {
    const claudeDir = path.join(workspacePath, '.claude');
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    const filePath = path.join(claudeDir, 'CLAUDE.md');
    const template = `# Project Instructions

## Overview
[Describe your project here]

## Code Conventions
- Use TypeScript strict mode
- Follow existing patterns in the codebase

## Important Files
- \`src/index.ts\` - Main entry point

## Testing
- Run \`npm test\` before committing
`;

    fs.writeFileSync(filePath, template);
    return filePath;
  }
}

export const ProjectInstructionsService = new ProjectInstructionsServiceClass();
