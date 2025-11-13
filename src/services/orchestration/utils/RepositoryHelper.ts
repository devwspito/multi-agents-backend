/**
 * Shared utility for repository information and context building
 * Reduces duplication across phases
 */

import path from 'path';

export interface RepoInfo {
  name: string;
  fullName: string;
  type: string;
  path: string;
  branch?: string;
  hasPackageJson?: boolean;
  hasTsConfig?: boolean;
}

export class RepositoryHelper {
  /**
   * Build minimal repository context for prompts
   */
  static buildRepoContext(repositories: any[], workspacePath?: string): RepoInfo[] {
    const { normalizeRepoName } = require('../../../utils/safeGitExecution');
    return repositories.map(repo => ({
      name: normalizeRepoName(repo.name || repo.githubRepoName?.split('/').pop() || 'unknown'),
      fullName: repo.githubRepoName || repo.name,
      type: repo.type || this.detectRepoType(repo),
      path: workspacePath
        ? path.join(workspacePath, normalizeRepoName(repo.name || repo.githubRepoName?.split('/').pop() || ''))
        : repo.localPath || '',
      branch: repo.githubBranch || repo.branch || 'main'
    }));
  }

  /**
   * Detect repository type from structure
   */
  private static detectRepoType(repo: any): string {
    if (repo.hasPackageJson) return 'node';
    if (repo.hasPomXml) return 'java';
    if (repo.hasRequirementsTxt) return 'python';
    if (repo.hasGoMod) return 'go';
    return 'unknown';
  }

  /**
   * Build minimal repo summary for prompts
   */
  static buildRepoSummary(repositories: RepoInfo[]): string {
    if (repositories.length === 0) return 'No repositories configured';

    if (repositories.length === 1) {
      const repo = repositories[0];
      return `${repo.name} (${repo.type})`;
    }

    // Group by type
    const byType = repositories.reduce((acc, repo) => {
      if (!acc[repo.type]) acc[repo.type] = [];
      acc[repo.type].push(repo.name);
      return acc;
    }, {} as Record<string, string[]>);

    return Object.entries(byType)
      .map(([type, names]) => `${type}: ${names.join(', ')}`)
      .join(' | ');
  }

  /**
   * Get primary repository (first or marked as primary)
   */
  static getPrimaryRepo(repositories: any[]): any | null {
    if (repositories.length === 0) return null;
    return repositories.find(r => r.isPrimary) || repositories[0];
  }

  /**
   * Build workspace structure summary
   */
  static buildWorkspaceStructure(workspacePath: string, repositories: RepoInfo[]): string[] {
    const structure: string[] = [];
    structure.push(`workspace/`);

    for (const repo of repositories) {
      structure.push(`  ${repo.name}/`);
      if (repo.hasPackageJson) {
        structure.push(`    package.json`);
        structure.push(`    src/`);
        structure.push(`    node_modules/`);
      }
      if (repo.hasTsConfig) {
        structure.push(`    tsconfig.json`);
      }
    }

    return structure;
  }

  /**
   * Extract branch names from epic/story data
   */
  static extractBranchNames(epics: any[]): string[] {
    const branches: string[] = [];

    for (const epic of epics) {
      if (epic.branchName) {
        branches.push(epic.branchName);
      } else if (epic.id) {
        branches.push(`epic/${epic.id}`);
      }

      if (epic.stories && Array.isArray(epic.stories)) {
        for (const story of epic.stories) {
          if (story.branchName) {
            branches.push(story.branchName);
          }
        }
      }
    }

    return [...new Set(branches)]; // Remove duplicates
  }

  /**
   * Generate git commands for branch operations
   */
  static generateGitCommands(operation: 'create' | 'checkout' | 'merge', branch: string): string[] {
    switch (operation) {
      case 'create':
        return [
          `git checkout -b ${branch}`,
          `git push -u origin ${branch}`
        ];
      case 'checkout':
        return [
          `git fetch origin`,
          `git checkout ${branch}`
        ];
      case 'merge':
        return [
          `git merge ${branch} --no-ff`,
          `git push origin HEAD`
        ];
      default:
        return [];
    }
  }

  /**
   * Build dependency context for prompts
   */
  static buildDependencyContext(packageJson: any): string[] {
    const deps: string[] = [];

    if (packageJson.dependencies) {
      const mainDeps = Object.keys(packageJson.dependencies).slice(0, 5);
      deps.push(`Main deps: ${mainDeps.join(', ')}`);
    }

    if (packageJson.devDependencies) {
      const devDeps = Object.keys(packageJson.devDependencies)
        .filter(d => d.includes('test') || d.includes('lint') || d.includes('build'))
        .slice(0, 3);
      if (devDeps.length > 0) {
        deps.push(`Dev tools: ${devDeps.join(', ')}`);
      }
    }

    if (packageJson.scripts) {
      const scripts = Object.keys(packageJson.scripts).slice(0, 5);
      deps.push(`Scripts: ${scripts.join(', ')}`);
    }

    return deps;
  }
}