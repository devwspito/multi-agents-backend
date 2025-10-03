const BranchManager = require('./BranchManager');

/**
 * Task Planner - Helps Product Manager and Project Manager avoid task overlaps
 */
class TaskPlanner {
  constructor() {
    this.branchManager = new BranchManager();
  }

  /**
   * Analyze proposed tasks for potential conflicts BEFORE creating them
   */
  async validateTaskSet(proposedTasks, repoOwner, repoName) {
    const conflicts = [];
    const taskContexts = proposedTasks.map(task => 
      this.branchManager.analyzeTaskContext(task)
    );

    // Check for internal conflicts between proposed tasks
    for (let i = 0; i < taskContexts.length; i++) {
      for (let j = i + 1; j < taskContexts.length; j++) {
        const conflict = this.checkTaskPairConflict(taskContexts[i], taskContexts[j]);
        if (conflict) {
          conflicts.push({
            type: 'internal_conflict',
            task1: taskContexts[i].title,
            task2: taskContexts[j].title,
            conflict: conflict,
            severity: this.calculateConflictSeverity(conflict)
          });
        }
      }
    }

    // Check for conflicts with currently active tasks
    const repoId = `${repoOwner}/${repoName}`;
    const activeTasks = this.branchManager.activeTasksByRepo.get(repoId) || new Map();
    
    for (const taskContext of taskContexts) {
      for (const [activeTaskId, activeTask] of activeTasks) {
        const activeContext = this.branchManager.analyzeTaskContext(activeTask);
        const conflict = this.checkTaskPairConflict(taskContext, activeContext);
        if (conflict) {
          conflicts.push({
            type: 'active_conflict',
            proposedTask: taskContext.title,
            activeTask: activeContext.title,
            conflict: conflict,
            severity: this.calculateConflictSeverity(conflict)
          });
        }
      }
    }

    return {
      valid: conflicts.length === 0,
      conflicts: conflicts,
      recommendations: this.generateRecommendations(conflicts, taskContexts)
    };
  }

  /**
   * Check if two tasks conflict with each other
   */
  checkTaskPairConflict(task1Context, task2Context) {
    // File-level conflicts
    const fileOverlap = task1Context.affectedFiles.filter(file => 
      task2Context.affectedFiles.includes(file)
    );
    if (fileOverlap.length > 0) {
      return {
        type: 'file_overlap',
        details: fileOverlap,
        description: `Both tasks modify: ${fileOverlap.join(', ')}`
      };
    }

    // Module-level conflicts
    const moduleOverlap = task1Context.affectedModules.filter(module => 
      task2Context.affectedModules.includes(module)
    );
    if (moduleOverlap.length > 0) {
      return {
        type: 'module_overlap',
        details: moduleOverlap,
        description: `Both tasks affect: ${moduleOverlap.join(', ')}`
      };
    }

    // Dependency conflicts
    if (task1Context.dependencies.includes(task2Context.taskId) ||
        task2Context.dependencies.includes(task1Context.taskId)) {
      return {
        type: 'dependency_conflict',
        description: 'Tasks have circular or conflicting dependencies'
      };
    }

    // Conceptual conflicts (same feature area)
    if (this.checkConceptualConflict(task1Context, task2Context)) {
      return {
        type: 'conceptual_conflict',
        description: 'Tasks work on the same feature area and may interfere'
      };
    }

    return null;
  }

  /**
   * Check for conceptual conflicts (same business area)
   */
  checkConceptualConflict(task1Context, task2Context) {
    const extractKeywords = (title) => {
      return title.toLowerCase()
        .split(/\s+/)
        .filter(word => word.length > 3)
        .filter(word => !['task', 'feature', 'implement', 'create', 'update', 'fix'].includes(word));
    };

    const keywords1 = extractKeywords(task1Context.title);
    const keywords2 = extractKeywords(task2Context.title);

    // If tasks share significant keywords, they might conflict conceptually
    const sharedKeywords = keywords1.filter(keyword => keywords2.includes(keyword));
    
    return sharedKeywords.length >= 2; // At least 2 shared meaningful keywords
  }

  /**
   * Calculate conflict severity
   */
  calculateConflictSeverity(conflict) {
    switch (conflict.type) {
      case 'file_overlap':
        return conflict.details.length > 3 ? 'high' : 'medium';
      case 'module_overlap':
        return 'high';
      case 'dependency_conflict':
        return 'critical';
      case 'conceptual_conflict':
        return 'low';
      default:
        return 'medium';
    }
  }

  /**
   * Generate recommendations to resolve conflicts
   */
  generateRecommendations(conflicts, taskContexts) {
    const recommendations = [];

    // Group conflicts by type
    const conflictsByType = conflicts.reduce((acc, conflict) => {
      if (!acc[conflict.type]) acc[conflict.type] = [];
      acc[conflict.type].push(conflict);
      return acc;
    }, {});

    // File overlap recommendations
    if (conflictsByType.file_overlap) {
      recommendations.push({
        type: 'task_sequencing',
        description: 'Sequence tasks that modify the same files to run one after another',
        action: 'Add dependencies between conflicting tasks'
      });
    }

    // Module overlap recommendations
    if (conflictsByType.module_overlap) {
      recommendations.push({
        type: 'task_redesign',
        description: 'Consider splitting tasks that affect the same business modules',
        action: 'Break down tasks into smaller, non-overlapping pieces'
      });
    }

    // Dependency conflict recommendations
    if (conflictsByType.dependency_conflict) {
      recommendations.push({
        type: 'dependency_resolution',
        description: 'Resolve circular dependencies by reordering or merging tasks',
        action: 'Review task dependencies and restructure workflow'
      });
    }

    // Conceptual conflict recommendations
    if (conflictsByType.conceptual_conflict) {
      recommendations.push({
        type: 'coordination',
        description: 'Tasks work on related features - ensure consistent approach',
        action: 'Consider assigning to same agent or adding review checkpoints'
      });
    }

    return recommendations;
  }

  /**
   * Suggest optimal task execution order
   */
  suggestExecutionOrder(tasks) {
    // Create dependency graph
    const dependencyGraph = new Map();
    const inDegree = new Map();
    
    tasks.forEach(task => {
      dependencyGraph.set(task._id, task.dependencies || []);
      inDegree.set(task._id, 0);
    });

    // Calculate in-degrees
    tasks.forEach(task => {
      (task.dependencies || []).forEach(depId => {
        if (inDegree.has(depId)) {
          inDegree.set(depId, inDegree.get(depId) + 1);
        }
      });
    });

    // Topological sort
    const queue = [];
    const result = [];

    // Start with tasks that have no dependencies
    for (const [taskId, degree] of inDegree) {
      if (degree === 0) {
        queue.push(taskId);
      }
    }

    while (queue.length > 0) {
      const currentTaskId = queue.shift();
      result.push(currentTaskId);

      // Reduce in-degree for dependent tasks
      const dependencies = dependencyGraph.get(currentTaskId) || [];
      dependencies.forEach(depId => {
        if (inDegree.has(depId)) {
          const newDegree = inDegree.get(depId) - 1;
          inDegree.set(depId, newDegree);
          if (newDegree === 0) {
            queue.push(depId);
          }
        }
      });
    }

    return {
      executionOrder: result,
      parallelizable: this.identifyParallelizableTasks(tasks, result),
      estimatedDuration: this.calculateTotalDuration(tasks, result)
    };
  }

  /**
   * Identify tasks that can run in parallel
   */
  identifyParallelizableTasks(tasks, executionOrder) {
    const parallelGroups = [];
    const taskMap = new Map(tasks.map(task => [task._id, task]));
    
    let currentGroup = [];
    let currentGroupDependencies = new Set();

    for (const taskId of executionOrder) {
      const task = taskMap.get(taskId);
      if (!task) continue;

      const taskDependencies = new Set(task.dependencies || []);
      
      // Check if this task can run with current group
      const canRunInParallel = Array.from(taskDependencies).every(depId => 
        !currentGroupDependencies.has(depId)
      );

      if (canRunInParallel && currentGroup.length < 3) { // Max 3 parallel tasks
        currentGroup.push(taskId);
        taskDependencies.forEach(dep => currentGroupDependencies.add(dep));
      } else {
        if (currentGroup.length > 1) {
          parallelGroups.push([...currentGroup]);
        }
        currentGroup = [taskId];
        currentGroupDependencies = new Set(taskDependencies);
      }
    }

    if (currentGroup.length > 1) {
      parallelGroups.push(currentGroup);
    }

    return parallelGroups;
  }

  /**
   * Calculate total estimated duration
   */
  calculateTotalDuration(tasks, executionOrder) {
    // This is a simplified calculation
    const taskMap = new Map(tasks.map(task => [task._id, task]));
    
    let totalDuration = 0;
    for (const taskId of executionOrder) {
      const task = taskMap.get(taskId);
      if (task) {
        totalDuration += this.branchManager.estimateTaskDuration(task);
      }
    }

    return totalDuration;
  }
}

module.exports = TaskPlanner;