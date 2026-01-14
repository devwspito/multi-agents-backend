/**
 * GitHistoryLearner
 *
 * Learn from git commit history to understand patterns, authorship, and change frequency.
 * Helps agents make better decisions based on historical context.
 *
 * Key behaviors:
 * 1. Analyze commit patterns (what changes together)
 * 2. Identify file hotspots (frequently changed)
 * 3. Learn from commit messages (common patterns)
 * 4. Track authorship and expertise areas
 */

import { execSync } from 'child_process';
import * as path from 'path';

export interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: Date;
  message: string;
  files: string[];
  insertions: number;
  deletions: number;
}

export interface FileHistory {
  file: string;
  totalCommits: number;
  totalChanges: number; // insertions + deletions
  lastModified: Date;
  authors: { name: string; commits: number }[];
  changeFrequency: 'high' | 'medium' | 'low' | 'stable';
  riskLevel: 'low' | 'medium' | 'high';
}

export interface ChangePattern {
  files: string[];
  frequency: number;
  confidence: number; // 0-100%
  description: string;
  suggestedReason: string;
}

export interface AuthorExpertise {
  author: string;
  email: string;
  totalCommits: number;
  areas: { path: string; commits: number; percentage: number }[];
  recentActivity: Date;
  expertise: string[];
}

export interface CommitMessagePattern {
  type: string;
  count: number;
  examples: string[];
  format: string;
}

export interface HistoryAnalysis {
  totalCommits: number;
  dateRange: { first: Date; last: Date };
  topFiles: FileHistory[];
  changePatterns: ChangePattern[];
  authors: AuthorExpertise[];
  messagePatterns: CommitMessagePattern[];
  hotspots: string[];
  stableFiles: string[];
  recommendations: string[];
  timestamp: number;
}

export class GitHistoryLearner {
  private static cache: Map<string, HistoryAnalysis> = new Map();

  /**
   * Analyze git history for a workspace
   */
  static async analyze(workspacePath: string, options?: {
    maxCommits?: number;
    since?: string;
    path?: string;
  }): Promise<HistoryAnalysis> {
    console.log(`\n📜 [GitHistoryLearner] Analyzing git history...`);

    const maxCommits = options?.maxCommits || 500;
    const since = options?.since || '6 months ago';
    const pathFilter = options?.path || '';

    try {
      // Get commits
      const commits = await this.getCommits(workspacePath, maxCommits, since, pathFilter);

      if (commits.length === 0) {
        return this.emptyAnalysis();
      }

      console.log(`   Found ${commits.length} commits`);

      // Analyze file history
      const fileHistories = this.analyzeFileHistory(commits);

      // Find change patterns
      const changePatterns = this.findChangePatterns(commits);

      // Analyze authors
      const authors = this.analyzeAuthors(commits);

      // Analyze commit messages
      const messagePatterns = this.analyzeMessagePatterns(commits);

      // Identify hotspots (high churn files)
      const hotspots = fileHistories
        .filter(f => f.changeFrequency === 'high')
        .map(f => f.file);

      // Identify stable files
      const stableFiles = fileHistories
        .filter(f => f.changeFrequency === 'stable')
        .map(f => f.file);

      // Generate recommendations
      const recommendations = this.generateRecommendations(
        fileHistories,
        changePatterns,
        hotspots
      );

      const analysis: HistoryAnalysis = {
        totalCommits: commits.length,
        dateRange: {
          first: commits[commits.length - 1].date,
          last: commits[0].date,
        },
        topFiles: fileHistories.slice(0, 20),
        changePatterns: changePatterns.slice(0, 10),
        authors,
        messagePatterns,
        hotspots: hotspots.slice(0, 10),
        stableFiles: stableFiles.slice(0, 10),
        recommendations,
        timestamp: Date.now(),
      };

      // Cache the analysis
      this.cache.set(workspacePath, analysis);

      console.log(`   Analyzed ${fileHistories.length} files`);
      console.log(`   Found ${changePatterns.length} change patterns`);
      console.log(`   Identified ${hotspots.length} hotspots`);

      return analysis;

    } catch (error) {
      console.warn(`   ⚠️ Git history analysis failed: ${error}`);
      return this.emptyAnalysis();
    }
  }

  /**
   * Get commits from git log
   */
  private static async getCommits(
    workspacePath: string,
    maxCommits: number,
    since: string,
    pathFilter: string
  ): Promise<CommitInfo[]> {
    const commits: CommitInfo[] = [];

    try {
      // Get commit log with stats
      const logFormat = '%H|%h|%an|%ae|%aI|%s';
      const cmd = `git log --format="${logFormat}" --numstat --since="${since}" -n ${maxCommits} ${pathFilter}`;

      const output = execSync(cmd, {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      });

      const lines = output.trim().split('\n');
      let currentCommit: Partial<CommitInfo> | null = null;
      let files: string[] = [];
      let insertions = 0;
      let deletions = 0;

      for (const line of lines) {
        if (line.includes('|')) {
          // Save previous commit
          if (currentCommit && currentCommit.hash) {
            commits.push({
              ...currentCommit as CommitInfo,
              files,
              insertions,
              deletions,
            });
          }

          // Parse new commit
          const [hash, shortHash, author, email, date, message] = line.split('|');
          currentCommit = {
            hash,
            shortHash,
            author,
            email,
            date: new Date(date),
            message,
          };
          files = [];
          insertions = 0;
          deletions = 0;
        } else if (line.trim()) {
          // Parse file stats
          const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
          if (match) {
            const ins = match[1] === '-' ? 0 : parseInt(match[1]);
            const del = match[2] === '-' ? 0 : parseInt(match[2]);
            const file = match[3];

            files.push(file);
            insertions += ins;
            deletions += del;
          }
        }
      }

      // Don't forget the last commit
      if (currentCommit && currentCommit.hash) {
        commits.push({
          ...currentCommit as CommitInfo,
          files,
          insertions,
          deletions,
        });
      }

    } catch {
      // Return empty if git fails
    }

    return commits;
  }

  /**
   * Analyze file history from commits
   */
  private static analyzeFileHistory(commits: CommitInfo[]): FileHistory[] {
    const fileStats = new Map<string, {
      commits: number;
      changes: number;
      lastModified: Date;
      authors: Map<string, number>;
    }>();

    for (const commit of commits) {
      for (const file of commit.files) {
        if (!fileStats.has(file)) {
          fileStats.set(file, {
            commits: 0,
            changes: 0,
            lastModified: commit.date,
            authors: new Map(),
          });
        }

        const stats = fileStats.get(file)!;
        stats.commits++;
        stats.changes += commit.insertions + commit.deletions;

        if (commit.date > stats.lastModified) {
          stats.lastModified = commit.date;
        }

        const authorCount = stats.authors.get(commit.author) || 0;
        stats.authors.set(commit.author, authorCount + 1);
      }
    }

    // Convert to FileHistory array
    const histories: FileHistory[] = [];
    const avgCommits = commits.length > 0
      ? Array.from(fileStats.values()).reduce((sum, s) => sum + s.commits, 0) / fileStats.size
      : 0;

    for (const [file, stats] of fileStats) {
      const authors = Array.from(stats.authors.entries())
        .map(([name, count]) => ({ name, commits: count }))
        .sort((a, b) => b.commits - a.commits);

      // Determine change frequency
      let changeFrequency: FileHistory['changeFrequency'];
      if (stats.commits > avgCommits * 2) {
        changeFrequency = 'high';
      } else if (stats.commits > avgCommits) {
        changeFrequency = 'medium';
      } else if (stats.commits > avgCommits * 0.5) {
        changeFrequency = 'low';
      } else {
        changeFrequency = 'stable';
      }

      // Determine risk level
      let riskLevel: FileHistory['riskLevel'] = 'low';
      if (changeFrequency === 'high' && authors.length > 3) {
        riskLevel = 'high';
      } else if (changeFrequency === 'high' || authors.length > 5) {
        riskLevel = 'medium';
      }

      histories.push({
        file,
        totalCommits: stats.commits,
        totalChanges: stats.changes,
        lastModified: stats.lastModified,
        authors: authors.slice(0, 5),
        changeFrequency,
        riskLevel,
      });
    }

    // Sort by commit count
    histories.sort((a, b) => b.totalCommits - a.totalCommits);

    return histories;
  }

  /**
   * Find change patterns (files that change together)
   */
  private static findChangePatterns(commits: CommitInfo[]): ChangePattern[] {
    const patterns: ChangePattern[] = [];
    const pairCount = new Map<string, number>();

    // Count file pairs that change together
    for (const commit of commits) {
      const files = commit.files.filter(f =>
        !f.includes('.lock') &&
        !f.includes('package-lock') &&
        !f.includes('.generated')
      );

      for (let i = 0; i < files.length; i++) {
        for (let j = i + 1; j < files.length; j++) {
          const pair = [files[i], files[j]].sort().join('|||');
          pairCount.set(pair, (pairCount.get(pair) || 0) + 1);
        }
      }
    }

    // Find significant patterns
    for (const [pair, count] of pairCount) {
      if (count >= 3) { // At least 3 co-occurrences
        const [file1, file2] = pair.split('|||');
        const confidence = Math.min(100, Math.round(count * 10));

        // Determine pattern type
        let description: string;
        let reason: string;

        if (file1.includes('.test') || file2.includes('.test')) {
          description = 'Test and implementation pair';
          reason = 'Implementation and its test change together';
        } else if (path.dirname(file1) === path.dirname(file2)) {
          description = 'Same-directory coupling';
          reason = 'Related files in same module';
        } else if (file1.includes('interface') || file2.includes('interface') ||
                   file1.includes('types') || file2.includes('types')) {
          description = 'Type definition coupling';
          reason = 'Type changes affect implementations';
        } else {
          description = 'Cross-module dependency';
          reason = 'These files have implicit coupling';
        }

        patterns.push({
          files: [file1, file2],
          frequency: count,
          confidence,
          description,
          suggestedReason: reason,
        });
      }
    }

    // Sort by frequency
    patterns.sort((a, b) => b.frequency - a.frequency);

    return patterns;
  }

  /**
   * Analyze author expertise
   */
  private static analyzeAuthors(commits: CommitInfo[]): AuthorExpertise[] {
    const authorStats = new Map<string, {
      email: string;
      commits: number;
      areas: Map<string, number>;
      lastActivity: Date;
    }>();

    for (const commit of commits) {
      if (!authorStats.has(commit.author)) {
        authorStats.set(commit.author, {
          email: commit.email,
          commits: 0,
          areas: new Map(),
          lastActivity: commit.date,
        });
      }

      const stats = authorStats.get(commit.author)!;
      stats.commits++;

      if (commit.date > stats.lastActivity) {
        stats.lastActivity = commit.date;
      }

      for (const file of commit.files) {
        const dir = path.dirname(file);
        const area = dir.split('/').slice(0, 2).join('/') || file;
        stats.areas.set(area, (stats.areas.get(area) || 0) + 1);
      }
    }

    // Convert to AuthorExpertise array
    const authors: AuthorExpertise[] = [];

    for (const [name, stats] of authorStats) {
      const totalAreaCommits = Array.from(stats.areas.values()).reduce((a, b) => a + b, 0);

      const areas = Array.from(stats.areas.entries())
        .map(([path, commits]) => ({
          path,
          commits,
          percentage: Math.round((commits / totalAreaCommits) * 100),
        }))
        .sort((a, b) => b.commits - a.commits)
        .slice(0, 5);

      // Determine expertise labels
      const expertise: string[] = [];
      for (const area of areas.slice(0, 3)) {
        if (area.percentage > 30) {
          if (area.path.includes('test')) expertise.push('Testing');
          else if (area.path.includes('service')) expertise.push('Backend Services');
          else if (area.path.includes('component') || area.path.includes('ui')) expertise.push('Frontend');
          else if (area.path.includes('api') || area.path.includes('route')) expertise.push('API');
          else if (area.path.includes('config') || area.path.includes('setup')) expertise.push('Configuration');
          else expertise.push(area.path);
        }
      }

      authors.push({
        author: name,
        email: stats.email,
        totalCommits: stats.commits,
        areas,
        recentActivity: stats.lastActivity,
        expertise: [...new Set(expertise)],
      });
    }

    // Sort by commit count
    authors.sort((a, b) => b.totalCommits - a.totalCommits);

    return authors;
  }

  /**
   * Analyze commit message patterns
   */
  private static analyzeMessagePatterns(commits: CommitInfo[]): CommitMessagePattern[] {
    const patterns: Record<string, { count: number; examples: string[] }> = {
      feat: { count: 0, examples: [] },
      fix: { count: 0, examples: [] },
      refactor: { count: 0, examples: [] },
      docs: { count: 0, examples: [] },
      test: { count: 0, examples: [] },
      chore: { count: 0, examples: [] },
      style: { count: 0, examples: [] },
      perf: { count: 0, examples: [] },
      other: { count: 0, examples: [] },
    };

    const conventionalRegex = /^(feat|fix|docs|style|refactor|perf|test|chore)(\(.+\))?:\s*/i;

    for (const commit of commits) {
      const match = commit.message.match(conventionalRegex);
      const type = match ? match[1].toLowerCase() : 'other';

      if (patterns[type]) {
        patterns[type].count++;
        if (patterns[type].examples.length < 3) {
          patterns[type].examples.push(commit.message.substring(0, 80));
        }
      }
    }

    // Determine dominant format
    const conventionalCount = Object.values(patterns)
      .filter((_, i) => i < 8) // Exclude 'other'
      .reduce((sum, p) => sum + p.count, 0);
    const format = conventionalCount > commits.length * 0.5
      ? 'Conventional Commits'
      : 'Free-form';

    return Object.entries(patterns)
      .filter(([_, p]) => p.count > 0)
      .map(([type, p]) => ({
        type,
        count: p.count,
        examples: p.examples,
        format,
      }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Generate recommendations from analysis
   */
  private static generateRecommendations(
    fileHistories: FileHistory[],
    changePatterns: ChangePattern[],
    hotspots: string[]
  ): string[] {
    const recommendations: string[] = [];

    // High-risk hotspots
    const highRisk = fileHistories.filter(f => f.riskLevel === 'high');
    if (highRisk.length > 0) {
      recommendations.push(
        `⚠️ ${highRisk.length} high-risk files with frequent changes - add extra review`
      );
    }

    // Hotspot warning
    if (hotspots.length > 5) {
      recommendations.push(
        `🔥 ${hotspots.length} hotspot files - consider refactoring to reduce churn`
      );
    }

    // Strong coupling patterns
    const strongCouplings = changePatterns.filter(p => p.confidence > 70);
    if (strongCouplings.length > 0) {
      recommendations.push(
        `🔗 ${strongCouplings.length} strong file couplings detected - consider consolidating`
      );
    }

    // Single-author files
    const singleAuthor = fileHistories.filter(f =>
      f.authors.length === 1 && f.totalCommits > 10
    );
    if (singleAuthor.length > 3) {
      recommendations.push(
        `👤 ${singleAuthor.length} files have single authors - spread knowledge`
      );
    }

    // Test coverage inference
    const testedFiles = changePatterns.filter(p =>
      p.files.some(f => f.includes('.test'))
    );
    if (testedFiles.length < hotspots.length * 0.5) {
      recommendations.push(
        `🧪 Some hotspot files may lack test coverage - verify testing`
      );
    }

    return recommendations;
  }

  /**
   * Empty analysis result
   */
  private static emptyAnalysis(): HistoryAnalysis {
    return {
      totalCommits: 0,
      dateRange: { first: new Date(), last: new Date() },
      topFiles: [],
      changePatterns: [],
      authors: [],
      messagePatterns: [],
      hotspots: [],
      stableFiles: [],
      recommendations: ['No git history available'],
      timestamp: Date.now(),
    };
  }

  /**
   * Get cached analysis
   */
  static getCachedAnalysis(workspacePath: string): HistoryAnalysis | null {
    return this.cache.get(workspacePath) || null;
  }

  /**
   * Get file history
   */
  static async getFileHistory(workspacePath: string, file: string): Promise<CommitInfo[]> {
    try {
      const logFormat = '%H|%h|%an|%ae|%aI|%s';
      const cmd = `git log --format="${logFormat}" --follow -n 50 -- "${file}"`;

      const output = execSync(cmd, {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 10000,
      });

      return output.trim().split('\n')
        .filter(line => line.includes('|'))
        .map(line => {
          const [hash, shortHash, author, email, date, message] = line.split('|');
          return {
            hash,
            shortHash,
            author,
            email,
            date: new Date(date),
            message,
            files: [file],
            insertions: 0,
            deletions: 0,
          };
        });
    } catch {
      return [];
    }
  }

  /**
   * Format analysis for prompt
   */
  static formatAnalysisForPrompt(analysis: HistoryAnalysis): string {
    let output = `
## 📜 Git History Analysis

**Period**: ${analysis.dateRange.first.toLocaleDateString()} - ${analysis.dateRange.last.toLocaleDateString()}
**Total Commits**: ${analysis.totalCommits}
**Contributors**: ${analysis.authors.length}

### 🔥 Hotspot Files (High Churn):
${analysis.hotspots.slice(0, 5).map(f => `- \`${f}\``).join('\n') || 'None identified'}

### 🔗 Change Patterns (Files That Change Together):
${analysis.changePatterns.slice(0, 3).map(p =>
  `- \`${p.files[0]}\` ↔ \`${p.files[1]}\` (${p.frequency} times, ${p.confidence}% confidence)`
).join('\n') || 'No strong patterns'}

### 👥 Top Contributors:
${analysis.authors.slice(0, 3).map(a =>
  `- **${a.author}**: ${a.totalCommits} commits (${a.expertise.join(', ') || 'General'})`
).join('\n')}

### 💡 Recommendations:
${analysis.recommendations.map(r => `- ${r}`).join('\n')}
`;

    return output;
  }

  /**
   * Generate instructions for agents
   */
  static generateInstructions(): string {
    return `
## 📜 GIT HISTORY LEARNING

The system learns from git history to help you make better decisions:

### Information Available:

1. **Hotspots**: Files that change frequently (high risk)
2. **Patterns**: Files that often change together
3. **Authors**: Who knows what parts of the codebase
4. **Stability**: Files that rarely change (low risk)

### How to Use This Information:

| Situation | Action |
|-----------|--------|
| Editing a hotspot | Extra careful, add tests |
| Files change together | Update both or break coupling |
| Single author file | Get review from that person |
| Stable file | Consider impact carefully |

### Change Frequency Levels:

- **High**: Changes almost every sprint - volatile
- **Medium**: Changes monthly - active development
- **Low**: Changes occasionally - maintenance mode
- **Stable**: Rarely changes - foundational code

### Risk Assessment:

- **High Risk**: High churn + many authors + no tests
- **Medium Risk**: Moderate churn or shared ownership
- **Low Risk**: Stable + single author + well tested

### Commit Message Patterns:

Use the project's established format:
- Conventional: \`feat(scope): message\`
- Free-form: \`Descriptive message\`
`;
  }
}
