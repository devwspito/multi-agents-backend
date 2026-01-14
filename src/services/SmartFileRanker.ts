/**
 * SmartFileRanker
 *
 * Ranks files by relevance to the current task.
 * Helps agents focus on important files first.
 *
 * Key behaviors:
 * 1. Score files based on task keywords
 * 2. Consider file type and location
 * 3. Prioritize recently modified files
 * 4. Account for file importance (entry points, configs)
 */

import * as fs from 'fs';
import * as path from 'path';

export interface FileScore {
  file: string;
  score: number;
  reasons: string[];
  category: 'primary' | 'secondary' | 'reference' | 'unlikely';
}

export interface RankingResult {
  query: string;
  totalFiles: number;
  rankedFiles: FileScore[];
  recommendedReads: string[];
  skipSuggestions: string[];
}

export interface RankingConfig {
  workspacePath: string;
  taskDescription: string;
  filesToModify?: string[];
  filesToCreate?: string[];
  keywords?: string[];
  maxResults?: number;
}

export class SmartFileRanker {
  /**
   * Rank files by relevance to task
   */
  static async rankFiles(config: RankingConfig): Promise<RankingResult> {
    console.log(`\n🎯 [SmartFileRanker] Ranking files for task relevance...`);

    const keywords = this.extractKeywords(config.taskDescription, config.keywords);
    console.log(`   Keywords: ${keywords.slice(0, 10).join(', ')}`);

    // Find all source files
    const allFiles = await this.findSourceFiles(config.workspacePath);
    console.log(`   Found ${allFiles.length} source files`);

    // Score each file
    const scoredFiles: FileScore[] = [];
    for (const file of allFiles) {
      const score = await this.scoreFile(config.workspacePath, file, keywords, config);
      scoredFiles.push(score);
    }

    // Sort by score descending
    scoredFiles.sort((a, b) => b.score - a.score);

    // Categorize files
    for (const file of scoredFiles) {
      if (file.score >= 80) {
        file.category = 'primary';
      } else if (file.score >= 50) {
        file.category = 'secondary';
      } else if (file.score >= 20) {
        file.category = 'reference';
      } else {
        file.category = 'unlikely';
      }
    }

    // Get top results
    const maxResults = config.maxResults || 20;
    const rankedFiles = scoredFiles.slice(0, maxResults);

    // Generate recommendations
    const recommendedReads = rankedFiles
      .filter(f => f.category === 'primary' || f.category === 'secondary')
      .map(f => f.file);

    const skipSuggestions = scoredFiles
      .filter(f => f.category === 'unlikely')
      .slice(0, 5)
      .map(f => f.file);

    console.log(`   Primary files: ${rankedFiles.filter(f => f.category === 'primary').length}`);
    console.log(`   Secondary files: ${rankedFiles.filter(f => f.category === 'secondary').length}`);

    return {
      query: config.taskDescription,
      totalFiles: allFiles.length,
      rankedFiles,
      recommendedReads,
      skipSuggestions,
    };
  }

  /**
   * Extract keywords from task description
   */
  private static extractKeywords(description: string, additionalKeywords?: string[]): string[] {
    const keywords = new Set<string>();

    // Add additional keywords
    if (additionalKeywords) {
      for (const kw of additionalKeywords) {
        keywords.add(kw.toLowerCase());
      }
    }

    // Extract words from description
    const words = description.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);

    // Filter out common words
    const stopWords = new Set([
      'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was',
      'will', 'can', 'should', 'would', 'could', 'have', 'has', 'had',
      'not', 'but', 'all', 'any', 'some', 'when', 'what', 'how', 'why',
      'implement', 'create', 'add', 'make', 'build', 'fix', 'update',
    ]);

    for (const word of words) {
      if (!stopWords.has(word)) {
        keywords.add(word);
      }
    }

    // Extract technical terms (camelCase, PascalCase)
    const camelCaseMatches = description.match(/[a-z][a-zA-Z0-9]*/g) || [];
    for (const match of camelCaseMatches) {
      if (match.length > 3) {
        keywords.add(match.toLowerCase());
      }
    }

    // Extract words in quotes
    const quotedMatches = description.match(/['"]([^'"]+)['"]/g) || [];
    for (const match of quotedMatches) {
      keywords.add(match.replace(/['"]/g, '').toLowerCase());
    }

    return Array.from(keywords);
  }

  /**
   * Score a file based on relevance
   */
  private static async scoreFile(
    workspacePath: string,
    file: string,
    keywords: string[],
    config: RankingConfig
  ): Promise<FileScore> {
    let score = 0;
    const reasons: string[] = [];

    const fileName = path.basename(file, path.extname(file)).toLowerCase();
    const filePath = file.toLowerCase();

    // 1. File name matches keywords (high weight)
    for (const keyword of keywords) {
      if (fileName.includes(keyword)) {
        score += 30;
        reasons.push(`Filename contains "${keyword}"`);
      }
      if (filePath.includes(keyword)) {
        score += 15;
        reasons.push(`Path contains "${keyword}"`);
      }
    }

    // 2. File is in filesToModify list (very high weight)
    if (config.filesToModify?.some(f => file.includes(f) || f.includes(file))) {
      score += 50;
      reasons.push('In filesToModify list');
    }

    // 3. File type relevance
    if (file.match(/\.(ts|tsx)$/)) {
      score += 5; // TypeScript preferred
    }
    if (file.includes('.test.') || file.includes('.spec.')) {
      score -= 10; // Test files lower priority unless testing task
      if (keywords.some(k => k.includes('test'))) {
        score += 20; // Unless it's a testing task
        reasons.push('Testing-related task');
      }
    }

    // 4. Directory relevance
    if (filePath.includes('/services/')) {
      score += 10;
      reasons.push('In services directory');
    }
    if (filePath.includes('/components/')) {
      if (keywords.some(k => ['ui', 'component', 'view', 'page', 'frontend'].includes(k))) {
        score += 20;
        reasons.push('Frontend task, component directory');
      }
    }
    if (filePath.includes('/routes/') || filePath.includes('/api/')) {
      if (keywords.some(k => ['api', 'route', 'endpoint', 'backend'].includes(k))) {
        score += 20;
        reasons.push('API task, routes directory');
      }
    }
    if (filePath.includes('/models/')) {
      if (keywords.some(k => ['model', 'database', 'schema', 'entity'].includes(k))) {
        score += 20;
        reasons.push('Model task, models directory');
      }
    }

    // 5. Important file types
    if (fileName === 'index') {
      score += 5;
      reasons.push('Index file (barrel export)');
    }
    if (fileName.includes('config') || fileName.includes('constants')) {
      if (keywords.some(k => ['config', 'setting', 'constant'].includes(k))) {
        score += 15;
      }
    }

    // 6. Read file content for deeper matching (if score is promising)
    if (score > 20) {
      try {
        const content = fs.readFileSync(path.join(workspacePath, file), 'utf8');
        const contentLower = content.toLowerCase();

        for (const keyword of keywords.slice(0, 5)) {
          const matches = (contentLower.match(new RegExp(keyword, 'g')) || []).length;
          if (matches > 0) {
            score += Math.min(matches * 2, 15);
            if (matches > 3) {
              reasons.push(`Contains "${keyword}" ${matches}x`);
            }
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    // 7. Penalize unlikely directories
    if (filePath.includes('/node_modules/') || filePath.includes('/dist/') || filePath.includes('/build/')) {
      score = 0;
    }
    if (filePath.includes('__tests__') && !keywords.some(k => k.includes('test'))) {
      score -= 20;
    }

    return {
      file,
      score: Math.max(0, Math.min(100, score)),
      reasons: reasons.slice(0, 3),
      category: 'unlikely', // Will be set later
    };
  }

  /**
   * Find all source files in workspace
   */
  private static async findSourceFiles(workspacePath: string): Promise<string[]> {
    const files: string[] = [];

    const walk = (dir: string, prefix: string = ''): void => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') {
            continue;
          }

          const fullPath = path.join(dir, entry.name);
          const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

          if (entry.isDirectory()) {
            walk(fullPath, relativePath);
          } else if (entry.name.match(/\.(ts|tsx|js|jsx|json|md|yaml|yml)$/)) {
            files.push(relativePath);
          }
        }
      } catch {
        // Ignore permission errors
      }
    };

    walk(workspacePath);
    return files;
  }

  /**
   * Format ranking results for prompt
   */
  static formatForPrompt(result: RankingResult): string {
    const primary = result.rankedFiles.filter(f => f.category === 'primary');
    const secondary = result.rankedFiles.filter(f => f.category === 'secondary');

    let output = `
## 🎯 File Relevance Ranking

**Task**: ${result.query.substring(0, 100)}...

### 📌 Primary Files (Read These First):
${primary.slice(0, 5).map(f => `- **${f.file}** (${f.score}%) - ${f.reasons[0] || 'Relevant'}`).join('\n')}

### 📋 Secondary Files (Read If Needed):
${secondary.slice(0, 5).map(f => `- ${f.file} (${f.score}%)`).join('\n')}
`;

    if (result.skipSuggestions.length > 0) {
      output += `
### ⏭️ Skip These (Low Relevance):
${result.skipSuggestions.map(f => `- ${f}`).join('\n')}
`;
    }

    return output;
  }

  /**
   * Generate instructions for agents
   */
  static generateInstructions(): string {
    return `
## 🎯 SMART FILE SELECTION

Don't read every file - focus on what matters!

### Relevance Hierarchy:

1. **Primary** (80%+ score) - Read these first
   - Files mentioned in the task
   - Files with matching names
   - Files in relevant directories

2. **Secondary** (50-80% score) - Read if needed
   - Related files
   - Supporting utilities
   - Type definitions

3. **Reference** (20-50% score) - Check if stuck
   - Examples
   - Tests (for behavior)
   - Documentation

4. **Unlikely** (<20% score) - Skip unless necessary
   - Unrelated modules
   - Build artifacts
   - Generated files

### Quick Search Strategy:

**For "implement user login":**
\`\`\`
1. Glob("**/auth*.ts")     → Auth files first
2. Glob("**/login*.ts")    → Login files
3. Glob("**/user*.ts")     → User-related
4. Skip: utils/, helpers/, tests/ (unless needed)
\`\`\`

### Time Savers:

| Instead of... | Do this... |
|--------------|------------|
| Reading all services | Grep for function name |
| Reading entire file | Read with offset/limit |
| Exploring randomly | Search by keyword first |
`;
  }
}
