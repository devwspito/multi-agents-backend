/**
 * ConservativeDependencyPolicy - Injects conservative dependencies for multi-repo safety
 *
 * Philosophy:
 * "Better safe than sorry" - If epics target different repositories, add dependencies
 * to ensure cross-repo changes happen sequentially by default.
 *
 * This prevents:
 * - Frontend starting before backend API is ready
 * - Database migrations running after code deploy
 * - Cross-cutting concerns causing race conditions
 *
 * Future enhancement: Replace with SmartDependencyAnalyzer that uses AI to detect
 * actual code dependencies and only adds necessary constraints.
 */

// @ts-ignore - IEpic is deprecated, file needs refactoring to use IStory
import { IEpic } from '../../models/Task';

export interface PolicyApplicationResult {
  originalEpics: IEpic[];
  modifiedEpics: IEpic[];
  addedDependencies: {
    epicId: string;
    epicName: string;
    addedDeps: string[];
    reason: string;
  }[];
  policyApplied: boolean;
}

export class ConservativeDependencyPolicy {
  /**
   * Applies conservative dependency policy to epics
   *
   * Rules:
   * 1. If epics target different repositories → add sequential dependencies
   * 2. Preserve existing explicit dependencies
   * 3. Use repository order as default sequence (repositories[0] first)
   *
   * @param epics Array of epics to analyze
   * @param repositories Array of repository objects (order matters)
   * @returns Result with modified epics and explanation
   */
  apply(epics: IEpic[], repositories: any[]): PolicyApplicationResult {
    if (epics.length === 0) {
      return {
        originalEpics: [],
        modifiedEpics: [],
        addedDependencies: [],
        policyApplied: false,
      };
    }

    // Clone epics to avoid mutation
    const modifiedEpics = epics.map((epic) => ({ ...epic }));
    const addedDependencies: PolicyApplicationResult['addedDependencies'] = [];

    // Group epics by target repository
    const epicsByRepo = this.groupEpicsByRepository(modifiedEpics, repositories);

    // Get repository order
    const repoOrder = this.getRepositoryOrder(repositories);

    // Apply conservative policy: each repo waits for previous repos
    for (let i = 1; i < repoOrder.length; i++) {
      const currentRepo = repoOrder[i];
      const currentRepoEpics = epicsByRepo.get(currentRepo) || [];

      // Get all epics from previous repos
      const previousReposEpics: IEpic[] = [];
      for (let j = 0; j < i; j++) {
        const prevRepo = repoOrder[j];
        const prevEpics = epicsByRepo.get(prevRepo) || [];
        previousReposEpics.push(...prevEpics);
      }

      // Add dependencies from current repo epics to previous repo epics
      for (const currentEpic of currentRepoEpics) {
        const addedDeps: string[] = [];

        for (const prevEpic of previousReposEpics) {
          // Don't add self-dependencies
          if (currentEpic.id === prevEpic.id) {
            continue;
          }

          // Check if dependency already exists
          if (!currentEpic.dependencies) {
            currentEpic.dependencies = [];
          }

          if (!currentEpic.dependencies.includes(prevEpic.id)) {
            currentEpic.dependencies.push(prevEpic.id);
            addedDeps.push(prevEpic.id);
          }
        }

        if (addedDeps.length > 0) {
          addedDependencies.push({
            epicId: currentEpic.id,
            epicName: currentEpic.name,
            addedDeps,
            reason: `Conservative policy: ${currentEpic.targetRepository || 'default repo'} waits for ${this.getRepoDisplayName(previousReposEpics[0]?.targetRepository, repositories)}`,
          });
        }
      }
    }

    return {
      originalEpics: epics,
      modifiedEpics,
      addedDependencies,
      policyApplied: addedDependencies.length > 0,
    };
  }

  /**
   * Groups epics by their target repository
   */
  private groupEpicsByRepository(
    epics: IEpic[],
    repositories: any[]
  ): Map<string, IEpic[]> {
    const grouped = new Map<string, IEpic[]>();

    for (const epic of epics) {
      // Default to first repository if not specified
      const targetRepo = epic.targetRepository || this.getDefaultRepository(repositories);

      if (!grouped.has(targetRepo)) {
        grouped.set(targetRepo, []);
      }
      grouped.get(targetRepo)!.push(epic);
    }

    return grouped;
  }

  /**
   * Gets repository execution order (based on array position)
   */
  private getRepositoryOrder(repositories: any[]): string[] {
    return repositories.map((repo) => this.getRepositoryIdentifier(repo));
  }

  /**
   * Gets repository identifier (name or full_name or url)
   */
  private getRepositoryIdentifier(repo: any): string {
    return repo.full_name || repo.name || repo.url || 'unknown';
  }

  /**
   * Gets default repository (first one)
   */
  private getDefaultRepository(repositories: any[]): string {
    if (repositories.length === 0) {
      return 'default';
    }
    return this.getRepositoryIdentifier(repositories[0]);
  }

  /**
   * Gets display name for repository
   */
  private getRepoDisplayName(targetRepo: string | undefined, repositories: any[]): string {
    if (!targetRepo) {
      return this.getDefaultRepository(repositories);
    }
    return targetRepo;
  }

  /**
   * Validates that targetRepository references valid repositories
   */
  validateTargetRepositories(epics: IEpic[], repositories: any[]): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];
    const validRepoIds = new Set(
      repositories.map((repo) => this.getRepositoryIdentifier(repo))
    );

    for (const epic of epics) {
      if (epic.targetRepository && !validRepoIds.has(epic.targetRepository)) {
        errors.push(
          `Epic "${epic.name}" (${epic.id}) targets invalid repository: "${epic.targetRepository}"`
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Detects cross-repository dependencies (for logging/monitoring)
   */
  detectCrossRepoDependencies(epics: IEpic[], repositories: any[]): {
    hasCrossRepoDeps: boolean;
    crossRepoPairs: { from: string; to: string; count: number }[];
  } {
    const epicRepoMap = new Map<string, string>();

    // Build epic → repo mapping
    for (const epic of epics) {
      epicRepoMap.set(
        epic.id,
        epic.targetRepository || this.getDefaultRepository(repositories)
      );
    }

    // Detect cross-repo dependencies
    const crossRepoPairs = new Map<string, number>();

    for (const epic of epics) {
      if (!epic.dependencies) continue;

      const epicRepo = epicRepoMap.get(epic.id);

      for (const depId of epic.dependencies) {
        const depRepo = epicRepoMap.get(depId);

        if (epicRepo && depRepo && epicRepo !== depRepo) {
          const key = `${depRepo}→${epicRepo}`;
          crossRepoPairs.set(key, (crossRepoPairs.get(key) || 0) + 1);
        }
      }
    }

    return {
      hasCrossRepoDeps: crossRepoPairs.size > 0,
      crossRepoPairs: Array.from(crossRepoPairs.entries()).map(([key, count]) => {
        const [from, to] = key.split('→');
        return { from, to, count };
      }),
    };
  }

  /**
   * Checks if policy would add dependencies (dry run)
   */
  wouldApplyPolicy(epics: IEpic[], repositories: any[]): boolean {
    const epicsByRepo = this.groupEpicsByRepository(epics, repositories);
    return epicsByRepo.size > 1; // Policy applies if multiple repos involved
  }

  /**
   * Gets summary statistics
   */
  getSummary(result: PolicyApplicationResult): string {
    if (!result.policyApplied) {
      return 'Conservative policy not applied (single repository or no epics)';
    }

    const totalAdded = result.addedDependencies.reduce(
      (sum, dep) => sum + dep.addedDeps.length,
      0
    );

    return `Conservative policy applied: ${totalAdded} dependencies added across ${result.addedDependencies.length} epics to ensure cross-repository safety`;
  }
}
