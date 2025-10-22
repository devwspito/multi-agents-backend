/**
 * Repository Detection Utilities
 *
 * Detects which repository a file belongs to based on project configuration.
 * Supports flexible, user-defined repository patterns.
 */

import { IRepository } from '../models/Repository';
import { minimatch } from 'minimatch';

export interface RepositoryAffinity {
  primaryRepository: string;
  affectedRepositories: string[];
  filesByRepository: Map<string, string[]>;
  isMultiRepo: boolean;
}

/**
 * Detects which repository a file path belongs to based on project configuration
 */
export function detectRepository(
  filePath: string,
  repositories: IRepository[]
): string | null {
  // Normalize path
  const normalizedPath = filePath.replace(/\\/g, '/');

  // Check each repository's patterns
  for (const repo of repositories) {
    for (const pattern of repo.pathPatterns) {
      if (minimatch(normalizedPath, pattern, { matchBase: true, dot: true })) {
        return repo.name;
      }
    }
  }

  // No match found
  return null;
}

/**
 * Analyzes repository affinity for a list of file paths
 */
export function analyzeRepositoryAffinity(
  filePaths: string[],
  repositories: IRepository[]
): RepositoryAffinity {
  const filesByRepository = new Map<string, string[]>();

  // Categorize each file by repository
  for (const filePath of filePaths) {
    const repo = detectRepository(filePath, repositories);

    if (repo) {
      if (!filesByRepository.has(repo)) {
        filesByRepository.set(repo, []);
      }
      filesByRepository.get(repo)!.push(filePath);
    }
  }

  const affectedRepositories = Array.from(filesByRepository.keys());

  // Primary repository is the one with most files
  const primaryRepository = affectedRepositories.reduce((primary, current) => {
    const primaryCount = filesByRepository.get(primary)?.length || 0;
    const currentCount = filesByRepository.get(current)?.length || 0;
    return currentCount > primaryCount ? current : primary;
  }, affectedRepositories[0] || '');

  return {
    primaryRepository,
    affectedRepositories,
    filesByRepository,
    isMultiRepo: affectedRepositories.length > 1,
  };
}

/**
 * Filters file paths by repository
 */
export function filterFilesByRepository(
  filePaths: string[],
  repository: string,
  repositories: IRepository[]
): string[] {
  return filePaths.filter(path => detectRepository(path, repositories) === repository);
}

/**
 * Groups file paths by repository
 */
export function groupFilesByRepository(
  filePaths: string[],
  repositories: IRepository[]
): Map<string, string[]> {
  const groups = new Map<string, string[]>();

  for (const filePath of filePaths) {
    const repo = detectRepository(filePath, repositories);

    if (repo) {
      if (!groups.has(repo)) {
        groups.set(repo, []);
      }
      groups.get(repo)!.push(filePath);
    }
  }

  return groups;
}

/**
 * Validates that all files belong to a single repository
 */
export function validateSingleRepository(
  filePaths: string[],
  repositories: IRepository[]
): {
  valid: boolean;
  repository?: string;
  violations?: { file: string; detectedRepo: string | null }[];
} {
  if (filePaths.length === 0) {
    return { valid: true };
  }

  const firstRepo = detectRepository(filePaths[0], repositories);
  const violations: { file: string; detectedRepo: string | null }[] = [];

  for (const filePath of filePaths) {
    const repo = detectRepository(filePath, repositories);
    if (repo !== firstRepo) {
      violations.push({ file: filePath, detectedRepo: repo });
    }
  }

  return {
    valid: violations.length === 0,
    repository: violations.length === 0 && firstRepo ? firstRepo : undefined,
    violations: violations.length > 0 ? violations : undefined,
  };
}

/**
 * Get execution order for repositories based on configuration
 * Returns repositories sorted by executionOrder (1 = first) and dependencies
 */
export function getRepositoryExecutionOrder(
  repositories: IRepository[]
): string[] {
  // Sort by executionOrder if defined, otherwise by dependencies
  const sorted = [...repositories].sort((a, b) => {
    // If both have executionOrder, use that
    if (a.executionOrder !== undefined && b.executionOrder !== undefined) {
      return a.executionOrder - b.executionOrder;
    }

    // If only one has executionOrder, prioritize it
    if (a.executionOrder !== undefined) return -1;
    if (b.executionOrder !== undefined) return 1;

    // Otherwise, backend comes first, frontend second, rest after
    const typeOrder: Record<string, number> = {
      backend: 1,
      frontend: 2,
      mobile: 3,
      shared: 4,
    };

    return (typeOrder[a.type] || 99) - (typeOrder[b.type] || 99);
  });

  return sorted.map(r => r.name);
}

/**
 * Get repository type by name
 */
export function getRepositoryType(
  repositoryName: string,
  repositories: IRepository[]
): 'backend' | 'frontend' | 'mobile' | 'shared' | null {
  const repo = repositories.find(r => r.name === repositoryName);
  return repo?.type || null;
}

/**
 * Get repositories by type
 */
export function getRepositoriesByType(
  type: 'backend' | 'frontend' | 'mobile' | 'shared',
  repositories: IRepository[]
): IRepository[] {
  return repositories.filter(r => r.type === type);
}
