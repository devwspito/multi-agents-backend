/**
 * DependencyResolver - Resolves epic execution order based on dependencies
 *
 * Features:
 * - Topological sort algorithm (DFS-based)
 * - Circular dependency detection
 * - Groups epics into execution levels for potential parallel execution
 * - Clear error messages for invalid dependency graphs
 */

import { IEpic } from '../../models/Task';

export interface DependencyLevel {
  level: number; // 0-indexed execution level
  epics: IEpic[]; // Epics that can potentially execute in parallel
}

export interface DependencyResolutionResult {
  success: boolean;
  executionOrder: IEpic[]; // Flattened sequential order
  executionLevels: DependencyLevel[]; // Grouped by level for parallelism
  error?: string;
  circularDependencies?: string[][]; // Array of circular dependency chains
}

export class DependencyResolver {
  /**
   * Resolves epic execution order using topological sort
   * @param epics Array of epics with potential dependencies
   * @returns Resolution result with execution order and levels
   */
  resolve(epics: IEpic[]): DependencyResolutionResult {
    // 1. Build dependency graph
    const epicMap = new Map<string, IEpic>();
    for (const epic of epics) {
      epicMap.set(epic.id, epic);
    }

    // 2. Validate dependencies exist
    const validationError = this.validateDependencies(epics, epicMap);
    if (validationError) {
      return {
        success: false,
        executionOrder: [],
        executionLevels: [],
        error: validationError,
      };
    }

    // 3. Detect circular dependencies
    const circularDeps = this.detectCircularDependencies(epics, epicMap);
    if (circularDeps.length > 0) {
      return {
        success: false,
        executionOrder: [],
        executionLevels: [],
        error: `Circular dependencies detected: ${this.formatCircularDependencies(circularDeps)}`,
        circularDependencies: circularDeps,
      };
    }

    // 4. Perform topological sort
    const sorted = this.topologicalSort(epics, epicMap);

    // 5. Group into execution levels
    const levels = this.groupIntoLevels(sorted, epicMap);

    return {
      success: true,
      executionOrder: sorted,
      executionLevels: levels,
    };
  }

  /**
   * Validates that all dependencies reference existing epics
   */
  private validateDependencies(epics: IEpic[], epicMap: Map<string, IEpic>): string | null {
    for (const epic of epics) {
      if (!epic.dependencies || epic.dependencies.length === 0) {
        continue;
      }

      for (const depId of epic.dependencies) {
        if (!epicMap.has(depId)) {
          return `Epic "${epic.name}" (${epic.id}) has invalid dependency: "${depId}" does not exist`;
        }
      }
    }
    return null;
  }

  /**
   * Detects circular dependencies using DFS
   */
  private detectCircularDependencies(
    epics: IEpic[],
    epicMap: Map<string, IEpic>
  ): string[][] {
    const visiting = new Set<string>(); // Currently visiting in DFS
    const visited = new Set<string>(); // Completely processed
    const cycles: string[][] = [];

    const dfs = (epicId: string, path: string[]): void => {
      if (visiting.has(epicId)) {
        // Found a cycle - extract the cycle from path
        const cycleStart = path.indexOf(epicId);
        const cycle = path.slice(cycleStart).concat(epicId);
        cycles.push(cycle);
        return;
      }

      if (visited.has(epicId)) {
        return; // Already processed
      }

      visiting.add(epicId);
      path.push(epicId);

      const epic = epicMap.get(epicId);
      if (epic && epic.dependencies) {
        for (const depId of epic.dependencies) {
          dfs(depId, [...path]);
        }
      }

      visiting.delete(epicId);
      visited.add(epicId);
    };

    // Check from each epic
    for (const epic of epics) {
      if (!visited.has(epic.id)) {
        dfs(epic.id, []);
      }
    }

    return cycles;
  }

  /**
   * Performs topological sort using DFS
   */
  private topologicalSort(epics: IEpic[], epicMap: Map<string, IEpic>): IEpic[] {
    const visited = new Set<string>();
    const result: IEpic[] = [];

    const dfs = (epicId: string): void => {
      if (visited.has(epicId)) {
        return;
      }

      visited.add(epicId);

      const epic = epicMap.get(epicId);
      if (epic && epic.dependencies) {
        // Visit dependencies first
        for (const depId of epic.dependencies) {
          dfs(depId);
        }
      }

      // Add current epic after all dependencies
      if (epic) {
        result.push(epic);
      }
    };

    // Process all epics
    for (const epic of epics) {
      if (!visited.has(epic.id)) {
        dfs(epic.id);
      }
    }

    return result;
  }

  /**
   * Groups epics into execution levels
   * Epics in the same level have no dependencies on each other
   */
  private groupIntoLevels(
    sortedEpics: IEpic[],
    _epicMap: Map<string, IEpic>
  ): DependencyLevel[] {
    const epicLevels = new Map<string, number>();
    const levels: DependencyLevel[] = [];

    // Calculate level for each epic
    for (const epic of sortedEpics) {
      let maxDepLevel = -1;

      // Find maximum level of dependencies
      if (epic.dependencies && epic.dependencies.length > 0) {
        for (const depId of epic.dependencies) {
          const depLevel = epicLevels.get(depId) ?? -1;
          maxDepLevel = Math.max(maxDepLevel, depLevel);
        }
      }

      // This epic goes to maxDepLevel + 1
      const level = maxDepLevel + 1;
      epicLevels.set(epic.id, level);

      // Add to level array
      if (!levels[level]) {
        levels[level] = { level, epics: [] };
      }
      levels[level].epics.push(epic);
    }

    return levels;
  }

  /**
   * Formats circular dependencies for error messages
   */
  private formatCircularDependencies(cycles: string[][]): string {
    return cycles
      .map((cycle) => cycle.join(' → '))
      .join('; ');
  }

  /**
   * Utility: Get epics with no dependencies (can start immediately)
   */
  getReadyEpics(epics: IEpic[]): IEpic[] {
    return epics.filter((epic) => !epic.dependencies || epic.dependencies.length === 0);
  }

  /**
   * Utility: Get epics that depend on a specific epic
   */
  getDependentEpics(epicId: string, epics: IEpic[]): IEpic[] {
    return epics.filter(
      (epic) => epic.dependencies && epic.dependencies.includes(epicId)
    );
  }

  /**
   * Utility: Check if epic can execute (all dependencies completed)
   */
  canExecute(epic: IEpic, completedEpicIds: Set<string>): boolean {
    if (!epic.dependencies || epic.dependencies.length === 0) {
      return true;
    }

    return epic.dependencies.every((depId: string) => completedEpicIds.has(depId));
  }
}
