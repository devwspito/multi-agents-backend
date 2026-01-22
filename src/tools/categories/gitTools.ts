/**
 * Git Tools - Git operations and history tools
 * Extracted from extraTools.ts for better organization
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const gitCommitRetrievalTool = tool(
  'git_commit_retrieval',
  `Search git commit history to find how similar changes were made in the past.
Very useful for:
- Understanding how similar features were implemented
- Finding patterns for consistent code style
- Learning from past decisions
- Making better plans based on historical changes`,
  {
    query: z.string().describe('What to search for in commit history'),
    repoPath: z.string().describe('Path to the git repository'),
    limit: z.number().default(10).describe('Maximum commits to return'),
    author: z.string().optional().describe('Filter by author'),
    since: z.string().optional().describe('Only commits after this date (YYYY-MM-DD)'),
    pathFilter: z.string().optional().describe('Only commits touching this path'),
  },
  async (args) => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Build git log command
      let cmd = `git log --oneline --all -n ${args.limit}`;

      if (args.author) {
        cmd += ` --author="${args.author}"`;
      }
      if (args.since) {
        cmd += ` --since="${args.since}"`;
      }
      if (args.pathFilter) {
        cmd += ` -- "${args.pathFilter}"`;
      }

      // Search with grep for the query
      cmd += ` --grep="${args.query}" --regexp-ignore-case`;

      const { stdout: grepResults } = await execAsync(cmd, {
        cwd: args.repoPath,
        maxBuffer: 1024 * 1024,
      });

      // If no grep results, try searching in diff content
      let commits = grepResults.trim().split('\n').filter(Boolean);

      if (commits.length === 0) {
        // Search in actual code changes
        const { stdout: diffResults } = await execAsync(
          `git log --oneline --all -n ${args.limit} -S "${args.query}"`,
          { cwd: args.repoPath, maxBuffer: 1024 * 1024 }
        );
        commits = diffResults.trim().split('\n').filter(Boolean);
      }

      // Get details for each commit
      const detailedCommits = [];
      for (const commit of commits.slice(0, 5)) {
        const hash = commit.split(' ')[0];
        try {
          const { stdout: details } = await execAsync(
            `git show --stat --format="%H|%an|%ae|%s|%ad" --date=short ${hash}`,
            { cwd: args.repoPath, maxBuffer: 1024 * 1024 }
          );

          const lines = details.trim().split('\n');
          const [fullHash, author, _email, subject, date] = lines[0].split('|');
          const files = lines.slice(1, -1).map(l => l.trim()).filter(Boolean);

          detailedCommits.push({
            hash: fullHash?.substring(0, 8),
            author,
            date,
            subject,
            filesChanged: files.length,
            files: files.slice(0, 5),
          });
        } catch {
          // Skip commits we can't get details for
        }
      }

      console.log(`\n📜 [Git History] Found ${detailedCommits.length} relevant commits for "${args.query}"`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              query: args.query,
              totalFound: commits.length,
              commits: detailedCommits,
              tip: 'Use `git show <hash>` to see full commit details',
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              query: args.query,
              error: error.message,
            }, null, 2),
          },
        ],
      };
    }
  }
);
