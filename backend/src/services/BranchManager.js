/**
 * Intelligent Branch Manager - Prevents conflicts based on task context and file dependencies
 */
class BranchManager {
  constructor() {
    // Track active branches per repository
    this.activeBranches = new Map(); // repoId -> Set of branch names
    this.branchLocks = new Map(); // branchName -> { agentType, taskId, timestamp, task }
    this.agentQueues = new Map(); // repoId -> Map(agentType -> queue)
    
    // Task context tracking
    this.activeTasksByRepo = new Map(); // repoId -> Map(taskId -> task)
    this.fileConflictMap = new Map(); // repoId -> Map(filePath -> Set of taskIds)
    this.taskDependencies = new Map(); // taskId -> Set of dependent taskIds
    
    // Enhanced conflict resolution
    this.conflictResolutionStrategies = new Map(); // conflictType -> resolution function
    this.taskPriorityMatrix = new Map(); // taskId -> priority score
    this.dependencyGraph = new Map(); // repoId -> dependency graph
    this.resolutionHistory = new Map(); // repoId -> Array of past resolutions
    
    this.initializeConflictResolutionStrategies();
  }

  /**
   * Initialize conflict resolution strategies
   */
  initializeConflictResolutionStrategies() {
    // File conflict resolution strategies
    this.conflictResolutionStrategies.set('file_overlap', this.resolveFileOverlapConflict.bind(this));
    this.conflictResolutionStrategies.set('module_overlap', this.resolveModuleOverlapConflict.bind(this));
    this.conflictResolutionStrategies.set('dependency_conflict', this.resolveDependencyConflict.bind(this));
    this.conflictResolutionStrategies.set('agent_busy', this.resolveAgentBusyConflict.bind(this));
    this.conflictResolutionStrategies.set('conceptual_conflict', this.resolveConceptualConflict.bind(this));
  }

  /**
   * Intelligent conflict resolution - main entry point
   */
  async resolveTaskConflicts(task, repoOwner, repoName, options = {}) {
    const repoId = `${repoOwner}/${repoName}`;
    const compatibility = await this.checkTaskCompatibility(task, repoOwner, repoName);
    
    if (compatibility.compatible) {
      return { resolved: true, strategy: 'no_conflict', task };
    }

    console.log(`🔧 Attempting to resolve conflict: ${compatibility.reason} for task "${task.title}"`);

    // Try to resolve the conflict using appropriate strategy
    const strategy = this.conflictResolutionStrategies.get(compatibility.reason);
    if (strategy) {
      try {
        const resolution = await strategy(task, compatibility.conflicts, repoOwner, repoName, options);
        
        // Log the resolution
        this.logResolution(repoId, {
          taskId: task._id,
          conflictType: compatibility.reason,
          resolution: resolution,
          timestamp: Date.now()
        });

        return resolution;
      } catch (error) {
        console.error(`❌ Failed to resolve conflict: ${error.message}`);
        return { 
          resolved: false, 
          strategy: compatibility.reason, 
          error: error.message,
          fallback: this.suggestFallbackStrategy(task, compatibility)
        };
      }
    }

    return { 
      resolved: false, 
      strategy: compatibility.reason,
      suggestion: compatibility.suggestion,
      fallback: this.suggestFallbackStrategy(task, compatibility)
    };
  }

  /**
   * Resolve file overlap conflicts through intelligent sequencing
   */
  async resolveFileOverlapConflict(task, conflicts, repoOwner, repoName, options = {}) {
    const repoId = `${repoOwner}/${repoName}`;
    
    // Strategy 1: Check if conflicts can be sequenced (tasks work on different parts of same files)
    const sequenceable = this.analyzeFileSequenceability(task, conflicts);
    if (sequenceable.canSequence) {
      // Create dependency to run after conflicting tasks
      return {
        resolved: true,
        strategy: 'sequence_after_conflicts',
        action: 'create_dependency',
        waitFor: sequenceable.waitForTasks,
        estimatedDelay: sequenceable.estimatedDelay,
        task: this.addDependencies(task, sequenceable.waitForTasks)
      };
    }

    // Strategy 2: Check if task can be split to avoid conflicts
    const splittable = this.analyzeTaskSplitability(task, conflicts);
    if (splittable.canSplit && options.allowSplit !== false) {
      return {
        resolved: true,
        strategy: 'split_task',
        action: 'create_subtasks',
        subtasks: splittable.subtasks,
        nonConflictingPart: splittable.nonConflictingPart
      };
    }

    // Strategy 3: Intelligent queuing with priority
    const priority = this.calculateTaskPriority(task);
    const conflictingTasksPriority = conflicts.map(c => ({
      ...c,
      priority: this.getTaskPriority(c.conflictingTasks?.[0])
    }));

    if (priority > Math.max(...conflictingTasksPriority.map(c => c.priority))) {
      return {
        resolved: true,
        strategy: 'preempt_lower_priority',
        action: 'queue_conflicting_tasks',
        preemptedTasks: conflictingTasksPriority.filter(c => c.priority < priority)
      };
    }

    // Fallback: Queue with estimated wait time
    return {
      resolved: true,
      strategy: 'intelligent_queue',
      action: 'queue_with_notification',
      estimatedWaitTime: this.calculateConflictWaitTime(conflicts),
      queuePosition: this.calculateQueuePosition(task, repoId)
    };
  }

  /**
   * Resolve module overlap conflicts through architectural coordination
   */
  async resolveModuleOverlapConflict(task, conflicts, repoOwner, repoName, options = {}) {
    // Strategy 1: Check if tasks can work on different layers of same module
    const layerSeparation = this.analyzeModuleLayerSeparation(task, conflicts);
    if (layerSeparation.canSeparate) {
      return {
        resolved: true,
        strategy: 'layer_separation',
        action: 'coordinate_module_layers',
        taskLayer: layerSeparation.taskLayer,
        conflictLayers: layerSeparation.conflictLayers,
        coordination: layerSeparation.coordinationPlan
      };
    }

    // Strategy 2: Merge tasks if they're working on same feature
    const mergeable = this.analyzeTaskMergeability(task, conflicts);
    if (mergeable.canMerge && options.allowMerge !== false) {
      return {
        resolved: true,
        strategy: 'merge_related_tasks',
        action: 'create_combined_task',
        combinedTask: mergeable.combinedTask,
        originalTasks: mergeable.originalTasks
      };
    }

    // Strategy 3: Sequential execution with interface coordination
    return {
      resolved: true,
      strategy: 'sequential_with_interface',
      action: 'define_module_interfaces',
      executionOrder: this.calculateOptimalSequence(task, conflicts),
      interfaceDefinitions: this.generateModuleInterfaces(task, conflicts)
    };
  }

  /**
   * Resolve dependency conflicts through graph analysis
   */
  async resolveDependencyConflict(task, conflicts, repoOwner, repoName, options = {}) {
    const repoId = `${repoOwner}/${repoName}`;
    
    // Build dependency graph for this repository
    const dependencyGraph = this.buildDependencyGraph(repoId);
    
    // Strategy 1: Check for circular dependencies and resolve
    const circular = this.detectCircularDependencies(task, conflicts, dependencyGraph);
    if (circular.hasCircular) {
      const resolution = this.resolveCircularDependencies(circular.cycles);
      return {
        resolved: true,
        strategy: 'resolve_circular_dependencies',
        action: 'restructure_dependencies',
        cycles: circular.cycles,
        restructuredTasks: resolution.restructuredTasks,
        newExecutionOrder: resolution.executionOrder
      };
    }

    // Strategy 2: Wait for dependencies to complete
    const incompleteDeps = conflicts.filter(c => c.status !== 'completed');
    if (incompleteDeps.length > 0) {
      return {
        resolved: true,
        strategy: 'wait_for_dependencies',
        action: 'queue_until_dependencies_complete',
        waitingFor: incompleteDeps.map(dep => ({
          taskId: dep.dependsOn,
          title: dep.dependsOnTitle,
          estimatedCompletion: this.estimateTaskCompletion(dep.dependsOn)
        })),
        estimatedDelay: Math.max(...incompleteDeps.map(dep => 
          this.estimateTaskCompletion(dep.dependsOn)
        ))
      };
    }

    // Strategy 3: Parallel execution if dependencies allow
    const parallelizable = this.analyzeParallelizability(task, conflicts, dependencyGraph);
    if (parallelizable.canRunInParallel) {
      return {
        resolved: true,
        strategy: 'parallel_execution',
        action: 'coordinate_parallel_work',
        parallelTasks: parallelizable.parallelTasks,
        coordinationPoints: parallelizable.coordinationPoints
      };
    }

    return {
      resolved: false,
      strategy: 'dependency_conflict',
      suggestion: 'Manual dependency resolution required'
    };
  }

  /**
   * Resolve agent busy conflicts through workload management
   */
  async resolveAgentBusyConflict(task, conflicts, repoOwner, repoName, options = {}) {
    const conflict = conflicts[0]; // Agent busy conflicts have single conflict
    
    // Strategy 1: Check if other agents can handle the task
    const alternativeAgents = this.findAlternativeAgents(task, conflict.agentType);
    if (alternativeAgents.length > 0) {
      return {
        resolved: true,
        strategy: 'reassign_to_available_agent',
        action: 'change_task_assignment',
        originalAgent: conflict.agentType,
        newAgent: alternativeAgents[0],
        taskModifications: this.adjustTaskForAgent(task, alternativeAgents[0])
      };
    }

    // Strategy 2: Split task if agent can handle part of it
    if (task.complexity === 'complex' || task.complexity === 'expert') {
      const splittable = this.analyzeAgentWorkloadSplit(task, conflict.agentType);
      if (splittable.canSplit) {
        return {
          resolved: true,
          strategy: 'split_for_agent_capacity',
          action: 'create_agent_specific_subtasks',
          subtasks: splittable.subtasks,
          agentAssignments: splittable.agentAssignments
        };
      }
    }

    // Strategy 3: Intelligent queuing with workload balancing
    return {
      resolved: true,
      strategy: 'workload_balanced_queue',
      action: 'queue_with_workload_management',
      estimatedWaitTime: conflict.estimatedWaitTime,
      queuePosition: this.calculateAgentQueuePosition(task, conflict.agentType),
      workloadOptimization: this.suggestWorkloadOptimization(conflict.agentType)
    };
  }

  /**
   * Resolve conceptual conflicts through feature coordination
   */
  async resolveConceptualConflict(task, conflicts, repoOwner, repoName, options = {}) {
    // Strategy 1: Merge conceptually similar tasks
    const similar = this.analyzeConceptualSimilarity(task, conflicts);
    if (similar.highSimilarity && options.allowMerge !== false) {
      return {
        resolved: true,
        strategy: 'merge_conceptual_tasks',
        action: 'create_unified_feature_task',
        unifiedTask: similar.unifiedTask,
        originalTasks: similar.originalTasks,
        featureScope: similar.featureScope
      };
    }

    // Strategy 2: Coordinate as related features
    return {
      resolved: true,
      strategy: 'coordinate_related_features',
      action: 'create_feature_coordination_plan',
      coordinationPlan: {
        leadTask: this.selectLeadTask(task, conflicts),
        relatedTasks: conflicts,
        sharedComponents: similar.sharedComponents,
        integrationPoints: similar.integrationPoints
      }
    };
  }

  /**
   * Generate unique branch name for agent task
   */
  generateAgentBranchName(task, agentType, repoOwner, repoName) {
    const timestamp = Date.now();
    const taskId = task._id.toString().slice(-6);
    const sanitizedTitle = task.title
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .substring(0, 30);

    return `agents/${agentType}/${taskId}/${sanitizedTitle}-${timestamp}`;
  }

  /**
   * Analyze task for potential conflicts
   */
  analyzeTaskContext(task) {
    const context = {
      taskId: task._id,
      title: task.title,
      type: task.type,
      complexity: task.complexity,
      affectedFiles: this.extractAffectedFiles(task),
      affectedModules: this.extractAffectedModules(task),
      dependencies: task.dependencies || [],
      blocking: task.blocking || [],
      estimatedDuration: this.estimateTaskDuration(task)
    };

    return context;
  }

  /**
   * Extract files that task will likely modify
   */
  extractAffectedFiles(task) {
    const files = new Set();
    
    // Based on task type and description, predict files
    if (task.type === 'feature') {
      if (task.title.toLowerCase().includes('auth')) {
        files.add('src/auth/');
        files.add('src/middleware/auth.js');
      }
      if (task.title.toLowerCase().includes('api')) {
        files.add('src/routes/');
        files.add('src/controllers/');
      }
      if (task.title.toLowerCase().includes('ui') || task.title.toLowerCase().includes('component')) {
        files.add('src/components/');
        files.add('src/views/');
      }
      if (task.title.toLowerCase().includes('database') || task.title.toLowerCase().includes('model')) {
        files.add('src/models/');
        files.add('src/migrations/');
      }
    }

    // If task has specific file paths mentioned
    if (task.technicalDetails?.files) {
      task.technicalDetails.files.forEach(file => files.add(file));
    }

    return Array.from(files);
  }

  /**
   * Extract modules/services that task will affect
   */
  extractAffectedModules(task) {
    const modules = new Set();
    
    if (task.title.toLowerCase().includes('user')) modules.add('user-service');
    if (task.title.toLowerCase().includes('auth')) modules.add('auth-service');
    if (task.title.toLowerCase().includes('payment')) modules.add('payment-service');
    if (task.title.toLowerCase().includes('notification')) modules.add('notification-service');
    if (task.title.toLowerCase().includes('api')) modules.add('api-layer');
    if (task.title.toLowerCase().includes('database')) modules.add('data-layer');

    return Array.from(modules);
  }

  /**
   * Check if task can run without conflicts
   */
  async checkTaskCompatibility(task, repoOwner, repoName) {
    const repoId = `${repoOwner}/${repoName}`;
    const taskContext = this.analyzeTaskContext(task);
    const activeTasks = this.activeTasksByRepo.get(repoId) || new Map();

    // Check for file conflicts
    const fileConflicts = this.checkFileConflicts(taskContext, repoId);
    if (fileConflicts.length > 0) {
      return {
        compatible: false,
        reason: 'file_conflict',
        conflicts: fileConflicts,
        suggestion: 'Tasks modify overlapping files'
      };
    }

    // Check for dependency conflicts
    const dependencyConflicts = this.checkDependencyConflicts(taskContext, activeTasks);
    if (dependencyConflicts.length > 0) {
      return {
        compatible: false,
        reason: 'dependency_conflict',
        conflicts: dependencyConflicts,
        suggestion: 'Task depends on incomplete tasks'
      };
    }

    // Check for module conflicts (different logic than files)
    const moduleConflicts = this.checkModuleConflicts(taskContext, activeTasks);
    if (moduleConflicts.length > 0) {
      return {
        compatible: false,
        reason: 'module_conflict',
        conflicts: moduleConflicts,
        suggestion: 'Tasks affect same business modules'
      };
    }

    // Check agent capacity
    const agentConflict = this.checkAgentCapacity(task.assignedAgent, repoId);
    if (!agentConflict.available) {
      return {
        compatible: false,
        reason: 'agent_busy',
        conflicts: [agentConflict],
        suggestion: `Agent ${task.assignedAgent} already working`
      };
    }

    return { compatible: true };
  }

  /**
   * Check for file-level conflicts
   */
  checkFileConflicts(taskContext, repoId) {
    const conflicts = [];
    const fileMap = this.fileConflictMap.get(repoId) || new Map();
    
    for (const file of taskContext.affectedFiles) {
      if (fileMap.has(file)) {
        const conflictingTasks = fileMap.get(file);
        conflicts.push({
          file,
          conflictingTasks: Array.from(conflictingTasks)
        });
      }
    }
    
    return conflicts;
  }

  /**
   * Check for dependency conflicts
   */
  checkDependencyConflicts(taskContext, activeTasks) {
    const conflicts = [];
    
    for (const depTaskId of taskContext.dependencies) {
      if (activeTasks.has(depTaskId)) {
        const depTask = activeTasks.get(depTaskId);
        if (depTask.status !== 'completed') {
          conflicts.push({
            type: 'dependency',
            dependsOn: depTaskId,
            dependsOnTitle: depTask.title,
            status: depTask.status
          });
        }
      }
    }
    
    return conflicts;
  }

  /**
   * Check for module-level conflicts
   */
  checkModuleConflicts(taskContext, activeTasks) {
    const conflicts = [];
    
    for (const [activeTaskId, activeTask] of activeTasks) {
      const activeContext = this.analyzeTaskContext(activeTask);
      
      // Check if tasks affect same modules
      const overlappingModules = taskContext.affectedModules.filter(
        module => activeContext.affectedModules.includes(module)
      );
      
      if (overlappingModules.length > 0) {
        conflicts.push({
          type: 'module',
          conflictingTask: activeTaskId,
          conflictingTitle: activeTask.title,
          overlappingModules
        });
      }
    }
    
    return conflicts;
  }

  /**
   * Check agent capacity
   */
  checkAgentCapacity(agentType, repoId) {
    const activeBranches = this.activeBranches.get(repoId) || new Set();
    
    for (const branchName of activeBranches) {
      const lock = this.branchLocks.get(branchName);
      if (lock && lock.agentType === agentType) {
        return {
          available: false,
          reason: `Agent ${agentType} already working on: ${lock.task.title}`,
          estimatedWaitTime: this.estimateWaitTime(lock)
        };
      }
    }

    return { available: true };
  }

  /**
   * Reserve a branch for agent work with intelligent conflict detection
   */
  async reserveBranch(task, agentType, repoOwner, repoName) {
    const repoId = `${repoOwner}/${repoName}`;
    const branchName = this.generateAgentBranchName(task, agentType, repoOwner, repoName);
    
    // INTELLIGENT COMPATIBILITY CHECK
    const compatibility = await this.checkTaskCompatibility(task, repoOwner, repoName);
    if (!compatibility.compatible) {
      throw new Error(`Task conflict detected: ${compatibility.reason} - ${compatibility.suggestion}`);
    }

    // Reserve the branch
    const taskContext = this.analyzeTaskContext(task);
    const lock = {
      agentType,
      taskId: task._id,
      timestamp: Date.now(),
      repoOwner,
      repoName,
      branchName,
      task: task,
      taskContext: taskContext
    };

    // Add to active branches
    if (!this.activeBranches.has(repoId)) {
      this.activeBranches.set(repoId, new Set());
    }
    this.activeBranches.get(repoId).add(branchName);
    
    // Add to active tasks
    if (!this.activeTasksByRepo.has(repoId)) {
      this.activeTasksByRepo.set(repoId, new Map());
    }
    this.activeTasksByRepo.get(repoId).set(task._id, task);
    
    // Track file conflicts
    this.trackFileUsage(taskContext, repoId);
    
    // Add lock
    this.branchLocks.set(branchName, lock);

    console.log(`🔒 Branch reserved: ${branchName} for ${agentType} (Task: ${task.title})`);
    console.log(`📁 Files affected: ${taskContext.affectedFiles.join(', ')}`);
    console.log(`🧩 Modules affected: ${taskContext.affectedModules.join(', ')}`);
    
    return { branchName, lock };
  }

  /**
   * Track file usage to prevent conflicts
   */
  trackFileUsage(taskContext, repoId) {
    if (!this.fileConflictMap.has(repoId)) {
      this.fileConflictMap.set(repoId, new Map());
    }
    
    const fileMap = this.fileConflictMap.get(repoId);
    
    for (const file of taskContext.affectedFiles) {
      if (!fileMap.has(file)) {
        fileMap.set(file, new Set());
      }
      fileMap.get(file).add(taskContext.taskId);
    }
  }

  /**
   * Remove file usage tracking
   */
  untrackFileUsage(taskContext, repoId) {
    const fileMap = this.fileConflictMap.get(repoId);
    if (!fileMap) return;
    
    for (const file of taskContext.affectedFiles) {
      if (fileMap.has(file)) {
        fileMap.get(file).delete(taskContext.taskId);
        if (fileMap.get(file).size === 0) {
          fileMap.delete(file);
        }
      }
    }
  }

  /**
   * Estimate task duration based on complexity and type
   */
  estimateTaskDuration(task) {
    const baseMinutes = {
      'simple': 30,
      'moderate': 60,
      'complex': 120,
      'expert': 180
    };

    const typeMultiplier = {
      'feature': 1.0,
      'bug': 0.7,
      'enhancement': 0.8,
      'testing': 0.5,
      'documentation': 0.3
    };

    const base = baseMinutes[task.complexity] || 60;
    const multiplier = typeMultiplier[task.type] || 1.0;
    
    return Math.round(base * multiplier);
  }

  /**
   * Release branch after agent work is complete with intelligent cleanup
   */
  async releaseBranch(branchName) {
    const lock = this.branchLocks.get(branchName);
    if (!lock) {
      console.warn(`⚠️ Attempted to release non-existent branch: ${branchName}`);
      return;
    }

    const repoId = `${lock.repoOwner}/${lock.repoName}`;
    const taskContext = lock.taskContext;
    
    // Remove from active branches
    if (this.activeBranches.has(repoId)) {
      this.activeBranches.get(repoId).delete(branchName);
      if (this.activeBranches.get(repoId).size === 0) {
        this.activeBranches.delete(repoId);
      }
    }

    // Remove from active tasks
    if (this.activeTasksByRepo.has(repoId)) {
      this.activeTasksByRepo.get(repoId).delete(lock.taskId);
      if (this.activeTasksByRepo.get(repoId).size === 0) {
        this.activeTasksByRepo.delete(repoId);
      }
    }

    // Clean up file tracking
    if (taskContext) {
      this.untrackFileUsage(taskContext, repoId);
    }

    // Remove lock
    this.branchLocks.delete(branchName);

    console.log(`🔓 Branch released: ${branchName} from ${lock.agentType}`);
    console.log(`📁 Files freed: ${taskContext?.affectedFiles?.join(', ') || 'none'}`);
    
    // Process any queued work for this repository
    await this.processIntelligentQueue(repoId);
  }

  /**
   * Add agent task to queue if repository is busy
   */
  async queueAgentTask(task, agentType, repoOwner, repoName, callback) {
    const repoId = `${repoOwner}/${repoName}`;
    
    if (!this.agentQueues.has(repoId)) {
      this.agentQueues.set(repoId, new Map());
    }
    
    if (!this.agentQueues.get(repoId).has(agentType)) {
      this.agentQueues.get(repoId).set(agentType, []);
    }

    const queueItem = {
      task,
      agentType,
      repoOwner,
      repoName,
      callback,
      queuedAt: Date.now()
    };

    this.agentQueues.get(repoId).get(agentType).push(queueItem);
    
    console.log(`📋 Task queued: ${task.title} for ${agentType} on ${repoId}`);
    return queueItem;
  }

  /**
   * Process queued tasks intelligently based on compatibility
   */
  async processIntelligentQueue(repoId) {
    const repoQueues = this.agentQueues.get(repoId);
    if (!repoQueues) return;

    const [repoOwner, repoName] = repoId.split('/');
    const processedTasks = [];

    // Try to process as many compatible tasks as possible
    for (const [agentType, queue] of repoQueues) {
      if (queue.length === 0) continue;

      // Find the first compatible task in the queue
      let processedIndex = -1;
      
      for (let i = 0; i < queue.length; i++) {
        const queueItem = queue[i];
        
        try {
          // Check if this task can run now
          const compatibility = await this.checkTaskCompatibility(queueItem.task, repoOwner, repoName);
          
          if (compatibility.compatible) {
            console.log(`🚀 Processing compatible queued task: ${queueItem.task.title} for ${agentType}`);
            console.log(`✅ Compatible because: No conflicts with active tasks`);
            
            // Execute the callback (agent work)
            await queueItem.callback();
            processedIndex = i;
            processedTasks.push(queueItem.task.title);
            break; // Only process one task per agent type per cycle
          } else {
            console.log(`⏳ Task still incompatible: ${queueItem.task.title} - ${compatibility.reason}`);
          }
        } catch (error) {
          console.error(`❌ Failed to process queued task: ${error.message}`);
          processedIndex = i; // Remove failed task from queue
          break;
        }
      }

      // Remove processed task from queue
      if (processedIndex >= 0) {
        queue.splice(processedIndex, 1);
      }
    }

    // Clean up empty queues
    for (const [agentType, queue] of repoQueues) {
      if (queue.length === 0) {
        repoQueues.delete(agentType);
      }
    }
    
    if (repoQueues.size === 0) {
      this.agentQueues.delete(repoId);
    }

    if (processedTasks.length > 0) {
      console.log(`📋 Processed ${processedTasks.length} queued tasks: ${processedTasks.join(', ')}`);
    }
  }

  /**
   * Get repository status for monitoring
   */
  getRepositoryStatus(repoOwner, repoName) {
    const repoId = `${repoOwner}/${repoName}`;
    const activeBranches = this.activeBranches.get(repoId) || new Set();
    const queues = this.agentQueues.get(repoId) || new Map();
    
    const status = {
      repoId,
      activeBranches: Array.from(activeBranches),
      activeAgents: [],
      queuedTasks: 0
    };

    // Get active agents info
    for (const branchName of activeBranches) {
      const lock = this.branchLocks.get(branchName);
      if (lock) {
        status.activeAgents.push({
          agentType: lock.agentType,
          taskId: lock.taskId,
          branchName: lock.branchName,
          workingFor: Date.now() - lock.timestamp
        });
      }
    }

    // Count queued tasks
    for (const queue of queues.values()) {
      status.queuedTasks += queue.length;
    }

    return status;
  }

  /**
   * Get all repositories status for dashboard
   */
  getAllRepositoriesStatus() {
    const allRepos = new Set([
      ...this.activeBranches.keys(),
      ...this.agentQueues.keys()
    ]);

    const status = [];
    for (const repoId of allRepos) {
      const [repoOwner, repoName] = repoId.split('/');
      status.push(this.getRepositoryStatus(repoOwner, repoName));
    }

    return status;
  }

  /**
   * Emergency cleanup - release all locks older than threshold
   */
  async emergencyCleanup(olderThanMinutes = 30) {
    const threshold = Date.now() - (olderThanMinutes * 60 * 1000);
    const staleLocks = [];

    for (const [branchName, lock] of this.branchLocks) {
      if (lock.timestamp < threshold) {
        staleLocks.push(branchName);
      }
    }

    console.log(`🧹 Emergency cleanup: releasing ${staleLocks.length} stale locks`);
    
    for (const branchName of staleLocks) {
      await this.releaseBranch(branchName);
    }

    return staleLocks.length;
  }

  /**
   * Estimate wait time for repository availability
   */
  estimateWaitTime(lock) {
    // Simple estimation based on agent type and task complexity
    const baseMinutes = {
      'junior-developer': 15,
      'senior-developer': 30,
      'qa-engineer': 20,
      'tech-lead': 10,
      'project-manager': 5,
      'product-manager': 5
    };

    const base = baseMinutes[lock.agentType] || 20;
    const elapsed = (Date.now() - lock.timestamp) / (1000 * 60); // minutes
    const estimated = Math.max(0, base - elapsed);

    return Math.ceil(estimated);
  }

  /**
   * Force release a specific branch (admin function)
   */
  async forceReleaseBranch(branchName, reason = 'Manual release') {
    console.log(`⚠️ Force releasing branch: ${branchName} - ${reason}`);
    await this.releaseBranch(branchName);
  }

  // ===== INTELLIGENT CONFLICT RESOLUTION HELPERS =====

  /**
   * Calculate task priority based on multiple factors
   */
  calculateTaskPriority(task) {
    let priority = 50; // Base priority
    
    // Priority modifiers
    const priorityModifiers = {
      'critical': 40,
      'high': 20,
      'medium': 0,
      'low': -20
    };

    const complexityModifiers = {
      'simple': -10,
      'moderate': 0,
      'complex': 10,
      'expert': 20
    };

    const typeModifiers = {
      'bug': 30,
      'security': 40,
      'feature': 0,
      'enhancement': -10,
      'documentation': -20
    };

    priority += priorityModifiers[task.priority] || 0;
    priority += complexityModifiers[task.complexity] || 0;
    priority += typeModifiers[task.type] || 0;

    // Deadline urgency
    if (task.deadline) {
      const timeToDeadline = new Date(task.deadline) - new Date();
      const daysToDeadline = timeToDeadline / (1000 * 60 * 60 * 24);
      if (daysToDeadline < 1) priority += 30;
      else if (daysToDeadline < 3) priority += 20;
      else if (daysToDeadline < 7) priority += 10;
    }

    // Dependency impact
    if (task.blocking && task.blocking.length > 0) {
      priority += task.blocking.length * 5;
    }

    return Math.max(0, Math.min(100, priority));
  }

  /**
   * Get cached task priority
   */
  getTaskPriority(taskId) {
    return this.taskPriorityMatrix.get(taskId) || 50;
  }

  /**
   * Analyze if file conflicts can be sequenced
   */
  analyzeFileSequenceability(task, conflicts) {
    const taskFiles = this.extractAffectedFiles(task);
    const canSequence = conflicts.every(conflict => {
      // Check if files don't actually overlap in functionality
      const conflictFiles = conflict.details || [];
      const overlap = taskFiles.filter(file => conflictFiles.includes(file));
      
      // If overlap is minimal or in different areas, can sequence
      return overlap.length <= 1 || this.areFileAreasDistinct(task, conflict, overlap);
    });

    if (canSequence) {
      return {
        canSequence: true,
        waitForTasks: conflicts.map(c => c.conflictingTasks?.[0]).filter(Boolean),
        estimatedDelay: this.calculateConflictWaitTime(conflicts)
      };
    }

    return { canSequence: false };
  }

  /**
   * Analyze if task can be split to avoid conflicts
   */
  analyzeTaskSplitability(task, conflicts) {
    // Simple heuristic: if task affects multiple files/modules, might be splittable
    const affectedFiles = this.extractAffectedFiles(task);
    const affectedModules = this.extractAffectedModules(task);
    
    const canSplit = (affectedFiles.length > 2 || affectedModules.length > 1) && 
                     task.complexity !== 'simple';

    if (canSplit) {
      const nonConflictingFiles = affectedFiles.filter(file => 
        !conflicts.some(c => c.details?.includes(file))
      );

      if (nonConflictingFiles.length > 0) {
        return {
          canSplit: true,
          subtasks: this.generateSubtasks(task, conflicts),
          nonConflictingPart: {
            files: nonConflictingFiles,
            estimatedDuration: Math.round(this.estimateTaskDuration(task) * 0.4)
          }
        };
      }
    }

    return { canSplit: false };
  }

  /**
   * Generate subtasks for splitting strategy
   */
  generateSubtasks(task, conflicts) {
    const affectedFiles = this.extractAffectedFiles(task);
    const conflictingFiles = conflicts.flatMap(c => c.details || []);
    const nonConflictingFiles = affectedFiles.filter(file => !conflictingFiles.includes(file));

    return [
      {
        title: `${task.title} - Phase 1 (Non-conflicting)`,
        files: nonConflictingFiles,
        dependencies: [],
        canRunImmediately: true
      },
      {
        title: `${task.title} - Phase 2 (Integration)`,
        files: conflictingFiles,
        dependencies: conflicts.map(c => c.conflictingTasks?.[0]).filter(Boolean),
        canRunImmediately: false
      }
    ];
  }

  /**
   * Calculate wait time based on conflicts
   */
  calculateConflictWaitTime(conflicts) {
    return conflicts.reduce((maxWait, conflict) => {
      const taskEstimate = this.getTaskEstimatedCompletion(conflict.conflictingTasks?.[0]);
      return Math.max(maxWait, taskEstimate);
    }, 0);
  }

  /**
   * Calculate queue position for task
   */
  calculateQueuePosition(task, repoId) {
    const queues = this.agentQueues.get(repoId);
    if (!queues) return 1;

    const agentQueue = queues.get(task.assignedAgent) || [];
    return agentQueue.length + 1;
  }

  /**
   * Build dependency graph for repository
   */
  buildDependencyGraph(repoId) {
    const activeTasks = this.activeTasksByRepo.get(repoId) || new Map();
    const graph = new Map();

    for (const [taskId, task] of activeTasks) {
      graph.set(taskId, {
        task: task,
        dependencies: task.dependencies || [],
        dependents: []
      });
    }

    // Build reverse dependencies
    for (const [taskId, node] of graph) {
      for (const depId of node.dependencies) {
        if (graph.has(depId)) {
          graph.get(depId).dependents.push(taskId);
        }
      }
    }

    return graph;
  }

  /**
   * Find alternative agents for task
   */
  findAlternativeAgents(task, currentAgent) {
    const agentCapabilities = {
      'product-manager': ['requirements', 'analysis'],
      'project-manager': ['planning', 'coordination'],
      'tech-lead': ['architecture', 'design', 'complex-features'],
      'senior-developer': ['complex-features', 'review', 'integration'],
      'junior-developer': ['simple-features', 'ui', 'testing'],
      'qa-engineer': ['testing', 'validation', 'quality-assurance']
    };

    const taskRequirements = this.analyzeTaskRequirements(task);
    const alternatives = [];

    for (const [agent, capabilities] of Object.entries(agentCapabilities)) {
      if (agent !== currentAgent && 
          capabilities.some(cap => taskRequirements.includes(cap))) {
        alternatives.push(agent);
      }
    }

    return alternatives;
  }

  /**
   * Analyze task requirements for agent matching
   */
  analyzeTaskRequirements(task) {
    const requirements = [];
    const title = task.title.toLowerCase();
    const description = (task.description || '').toLowerCase();
    const combined = `${title} ${description}`;

    if (combined.includes('requirement') || combined.includes('analysis')) {
      requirements.push('requirements', 'analysis');
    }
    if (combined.includes('plan') || combined.includes('coordinate')) {
      requirements.push('planning', 'coordination');
    }
    if (combined.includes('architect') || combined.includes('design')) {
      requirements.push('architecture', 'design');
    }
    if (combined.includes('complex') || task.complexity === 'complex' || task.complexity === 'expert') {
      requirements.push('complex-features');
    }
    if (combined.includes('ui') || combined.includes('component') || task.complexity === 'simple') {
      requirements.push('simple-features', 'ui');
    }
    if (combined.includes('test') || combined.includes('quality')) {
      requirements.push('testing', 'validation', 'quality-assurance');
    }

    return requirements;
  }

  /**
   * Log resolution for learning and analytics
   */
  logResolution(repoId, resolution) {
    if (!this.resolutionHistory.has(repoId)) {
      this.resolutionHistory.set(repoId, []);
    }
    
    this.resolutionHistory.get(repoId).push(resolution);
    
    // Keep only last 50 resolutions per repo
    const history = this.resolutionHistory.get(repoId);
    if (history.length > 50) {
      history.splice(0, history.length - 50);
    }

    console.log(`📊 Logged resolution: ${resolution.conflictType} -> ${resolution.resolution.strategy}`);
  }

  /**
   * Suggest fallback strategy when resolution fails
   */
  suggestFallbackStrategy(task, compatibility) {
    const strategies = {
      'file_overlap': 'Consider manual coordination or task postponement',
      'module_overlap': 'Recommend splitting task or sequential execution',
      'dependency_conflict': 'Review and restructure task dependencies',
      'agent_busy': 'Queue task or consider alternative agent assignment',
      'conceptual_conflict': 'Coordinate related tasks or merge into single task'
    };

    return {
      strategy: 'manual_intervention',
      suggestion: strategies[compatibility.reason] || 'Manual review required',
      options: [
        'Queue task for later execution',
        'Split task into smaller components',
        'Reassign to different agent',
        'Manual coordination between agents'
      ]
    };
  }

  /**
   * Helper methods for conflict analysis
   */
  areFileAreasDistinct(task1, task2, overlappingFiles) {
    // Simple heuristic: if tasks have different types, likely distinct areas
    return task1.type !== task2.type;
  }

  getTaskEstimatedCompletion(taskId) {
    // Return estimated minutes until task completion
    return this.estimateTaskDuration({ complexity: 'moderate', type: 'feature' });
  }

  estimateTaskCompletion(taskId) {
    return this.getTaskEstimatedCompletion(taskId);
  }

  addDependencies(task, dependencies) {
    return {
      ...task,
      dependencies: [...(task.dependencies || []), ...dependencies]
    };
  }

  // ===== TASK OVERLAP DETECTION AND PREVENTION =====

  /**
   * Comprehensive task overlap detection
   */
  async detectTaskOverlaps(tasks, repoOwner, repoName) {
    const overlaps = [];
    const repoId = `${repoOwner}/${repoName}`;

    // Create task contexts for analysis
    const taskContexts = tasks.map(task => ({
      ...task,
      context: this.analyzeTaskContext(task)
    }));

    // Check each pair of tasks for overlaps
    for (let i = 0; i < taskContexts.length; i++) {
      for (let j = i + 1; j < taskContexts.length; j++) {
        const task1 = taskContexts[i];
        const task2 = taskContexts[j];
        
        const overlap = this.analyzeTaskPairOverlap(task1, task2);
        if (overlap.hasOverlap) {
          overlaps.push({
            task1: task1._id,
            task2: task2._id,
            overlapType: overlap.type,
            severity: overlap.severity,
            details: overlap.details,
            resolution: overlap.suggestedResolution
          });
        }
      }
    }

    return {
      totalTasks: tasks.length,
      overlapsDetected: overlaps.length,
      overlaps: overlaps,
      riskLevel: this.calculateOverlapRiskLevel(overlaps),
      recommendations: this.generateOverlapRecommendations(overlaps)
    };
  }

  /**
   * Analyze overlap between two specific tasks
   */
  analyzeTaskPairOverlap(task1, task2) {
    const overlap = {
      hasOverlap: false,
      type: null,
      severity: 'low',
      details: {},
      suggestedResolution: null
    };

    // File-level overlap detection
    const fileOverlap = this.detectFileOverlap(task1.context, task2.context);
    if (fileOverlap.hasOverlap) {
      overlap.hasOverlap = true;
      overlap.type = 'file_overlap';
      overlap.severity = fileOverlap.severity;
      overlap.details.files = fileOverlap.files;
      overlap.suggestedResolution = 'sequence_tasks';
    }

    // Module-level overlap detection
    const moduleOverlap = this.detectModuleOverlap(task1.context, task2.context);
    if (moduleOverlap.hasOverlap) {
      overlap.hasOverlap = true;
      overlap.type = overlap.type === 'file_overlap' ? 'file_and_module_overlap' : 'module_overlap';
      overlap.severity = this.escalateSeverity(overlap.severity, moduleOverlap.severity);
      overlap.details.modules = moduleOverlap.modules;
      overlap.suggestedResolution = 'coordinate_or_merge';
    }

    // Conceptual overlap detection
    const conceptualOverlap = this.detectConceptualOverlap(task1, task2);
    if (conceptualOverlap.hasOverlap) {
      overlap.hasOverlap = true;
      overlap.type = overlap.type ? `${overlap.type}_and_conceptual` : 'conceptual_overlap';
      overlap.severity = this.escalateSeverity(overlap.severity, conceptualOverlap.severity);
      overlap.details.conceptual = conceptualOverlap.details;
      overlap.suggestedResolution = 'merge_or_coordinate';
    }

    // Dependency overlap detection
    const dependencyOverlap = this.detectDependencyOverlap(task1.context, task2.context);
    if (dependencyOverlap.hasOverlap) {
      overlap.hasOverlap = true;
      overlap.type = overlap.type ? `${overlap.type}_and_dependency` : 'dependency_overlap';
      overlap.severity = this.escalateSeverity(overlap.severity, dependencyOverlap.severity);
      overlap.details.dependencies = dependencyOverlap.details;
      overlap.suggestedResolution = 'resolve_dependencies';
    }

    return overlap;
  }

  /**
   * Detect file-level overlaps
   */
  detectFileOverlap(context1, context2) {
    const commonFiles = context1.affectedFiles.filter(file => 
      context2.affectedFiles.includes(file)
    );

    if (commonFiles.length === 0) {
      return { hasOverlap: false };
    }

    const severity = commonFiles.length > 3 ? 'high' : 
                    commonFiles.length > 1 ? 'medium' : 'low';

    return {
      hasOverlap: true,
      files: commonFiles,
      severity: severity,
      impact: `${commonFiles.length} shared files: ${commonFiles.join(', ')}`
    };
  }

  /**
   * Detect module-level overlaps
   */
  detectModuleOverlap(context1, context2) {
    const commonModules = context1.affectedModules.filter(module => 
      context2.affectedModules.includes(module)
    );

    if (commonModules.length === 0) {
      return { hasOverlap: false };
    }

    return {
      hasOverlap: true,
      modules: commonModules,
      severity: 'high', // Module overlaps are always serious
      impact: `Shared business modules: ${commonModules.join(', ')}`
    };
  }

  /**
   * Detect conceptual overlaps using NLP-like analysis
   */
  detectConceptualOverlap(task1, task2) {
    const title1 = task1.title.toLowerCase();
    const title2 = task2.title.toLowerCase();
    const desc1 = (task1.description || '').toLowerCase();
    const desc2 = (task2.description || '').toLowerCase();

    // Extract meaningful keywords
    const keywords1 = this.extractMeaningfulKeywords(`${title1} ${desc1}`);
    const keywords2 = this.extractMeaningfulKeywords(`${title2} ${desc2}`);

    // Calculate semantic similarity
    const commonKeywords = keywords1.filter(keyword => keywords2.includes(keyword));
    const totalKeywords = new Set([...keywords1, ...keywords2]).size;
    const similarity = commonKeywords.length / Math.max(totalKeywords, 1);

    // Check for specific conceptual patterns
    const patterns = this.detectConceptualPatterns(task1, task2);

    if (similarity > 0.4 || patterns.length > 0) {
      return {
        hasOverlap: true,
        severity: similarity > 0.7 ? 'high' : similarity > 0.5 ? 'medium' : 'low',
        details: {
          similarity: similarity,
          commonKeywords: commonKeywords,
          patterns: patterns
        }
      };
    }

    return { hasOverlap: false };
  }

  /**
   * Extract meaningful keywords from text
   */
  extractMeaningfulKeywords(text) {
    const stopWords = new Set([
      'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
      'by', 'from', 'up', 'about', 'into', 'through', 'during', 'before',
      'after', 'above', 'below', 'between', 'among', 'task', 'feature',
      'implement', 'create', 'update', 'add', 'remove', 'fix', 'improve'
    ]);

    return text
      .split(/\s+/)
      .map(word => word.replace(/[^a-z0-9]/g, ''))
      .filter(word => word.length > 2 && !stopWords.has(word))
      .filter(word => !word.match(/^\d+$/)); // Remove pure numbers
  }

  /**
   * Detect specific conceptual patterns
   */
  detectConceptualPatterns(task1, task2) {
    const patterns = [];
    const combined1 = `${task1.title} ${task1.description || ''}`.toLowerCase();
    const combined2 = `${task2.title} ${task2.description || ''}`.toLowerCase();

    // Same feature area patterns
    const featureAreas = ['auth', 'payment', 'user', 'profile', 'dashboard', 'api', 'database'];
    for (const area of featureAreas) {
      if (combined1.includes(area) && combined2.includes(area)) {
        patterns.push({
          type: 'same_feature_area',
          area: area,
          confidence: 0.8
        });
      }
    }

    // UI/Component patterns
    if ((combined1.includes('ui') || combined1.includes('component')) &&
        (combined2.includes('ui') || combined2.includes('component'))) {
      patterns.push({
        type: 'ui_component_overlap',
        confidence: 0.7
      });
    }

    // API endpoint patterns
    const apiPattern = /api|endpoint|route/;
    if (apiPattern.test(combined1) && apiPattern.test(combined2)) {
      patterns.push({
        type: 'api_endpoint_overlap',
        confidence: 0.6
      });
    }

    return patterns;
  }

  /**
   * Detect dependency overlaps
   */
  detectDependencyOverlap(context1, context2) {
    const overlap = {
      hasOverlap: false,
      details: {}
    };

    // Check if tasks have circular dependencies
    if (context1.dependencies.includes(context2.taskId) && 
        context2.dependencies.includes(context1.taskId)) {
      overlap.hasOverlap = true;
      overlap.details.circular = true;
      overlap.severity = 'critical';
    }

    // Check if tasks block each other
    if (context1.blocking.includes(context2.taskId) || 
        context2.blocking.includes(context1.taskId)) {
      overlap.hasOverlap = true;
      overlap.details.blocking = true;
      overlap.severity = 'high';
    }

    // Check for shared dependencies
    const sharedDeps = context1.dependencies.filter(dep => 
      context2.dependencies.includes(dep)
    );
    if (sharedDeps.length > 0) {
      overlap.hasOverlap = true;
      overlap.details.sharedDependencies = sharedDeps;
      overlap.severity = overlap.severity || 'medium';
    }

    return overlap;
  }

  /**
   * Escalate severity level
   */
  escalateSeverity(current, new_severity) {
    const levels = { 'low': 1, 'medium': 2, 'high': 3, 'critical': 4 };
    const currentLevel = levels[current] || 0;
    const newLevel = levels[new_severity] || 0;
    const maxLevel = Math.max(currentLevel, newLevel);
    
    return Object.keys(levels).find(key => levels[key] === maxLevel) || 'low';
  }

  /**
   * Calculate overall risk level from overlaps
   */
  calculateOverlapRiskLevel(overlaps) {
    if (overlaps.length === 0) return 'none';
    
    const criticalCount = overlaps.filter(o => o.severity === 'critical').length;
    const highCount = overlaps.filter(o => o.severity === 'high').length;
    const mediumCount = overlaps.filter(o => o.severity === 'medium').length;

    if (criticalCount > 0) return 'critical';
    if (highCount > 2) return 'high';
    if (highCount > 0 || mediumCount > 3) return 'medium';
    return 'low';
  }

  /**
   * Generate recommendations for resolving overlaps
   */
  generateOverlapRecommendations(overlaps) {
    const recommendations = [];
    
    // Group overlaps by type
    const overlapsByType = overlaps.reduce((acc, overlap) => {
      if (!acc[overlap.overlapType]) acc[overlap.overlapType] = [];
      acc[overlap.overlapType].push(overlap);
      return acc;
    }, {});

    // Generate type-specific recommendations
    for (const [type, typeOverlaps] of Object.entries(overlapsByType)) {
      if (type.includes('file_overlap')) {
        recommendations.push({
          type: 'task_sequencing',
          priority: 'high',
          action: 'Sequence tasks that modify the same files',
          affectedTasks: typeOverlaps.flatMap(o => [o.task1, o.task2]),
          implementation: 'Add dependencies between overlapping tasks'
        });
      }

      if (type.includes('module_overlap')) {
        recommendations.push({
          type: 'architectural_coordination',
          priority: 'critical',
          action: 'Coordinate tasks affecting the same business modules',
          affectedTasks: typeOverlaps.flatMap(o => [o.task1, o.task2]),
          implementation: 'Consider merging tasks or defining clear interfaces'
        });
      }

      if (type.includes('conceptual_overlap')) {
        recommendations.push({
          type: 'feature_coordination',
          priority: 'medium',
          action: 'Coordinate conceptually related tasks',
          affectedTasks: typeOverlaps.flatMap(o => [o.task1, o.task2]),
          implementation: 'Assign to same agent or create feature epic'
        });
      }

      if (type.includes('dependency_overlap')) {
        recommendations.push({
          type: 'dependency_restructuring',
          priority: 'critical',
          action: 'Resolve dependency conflicts',
          affectedTasks: typeOverlaps.flatMap(o => [o.task1, o.task2]),
          implementation: 'Restructure task dependencies to eliminate cycles'
        });
      }
    }

    return recommendations;
  }

  /**
   * Prevent overlaps by analyzing task set before execution
   */
  async preventTaskOverlaps(tasks, repoOwner, repoName, options = {}) {
    console.log(`🔍 Analyzing ${tasks.length} tasks for potential overlaps...`);
    
    const overlapAnalysis = await this.detectTaskOverlaps(tasks, repoOwner, repoName);
    
    if (overlapAnalysis.overlapsDetected === 0) {
      console.log(`✅ No overlaps detected. Tasks can proceed safely.`);
      return {
        safe: true,
        tasks: tasks,
        analysis: overlapAnalysis
      };
    }

    console.log(`⚠️ Detected ${overlapAnalysis.overlapsDetected} potential overlaps (Risk: ${overlapAnalysis.riskLevel})`);

    // Apply automatic resolution if enabled
    if (options.autoResolve !== false) {
      const resolvedTasks = await this.autoResolveOverlaps(tasks, overlapAnalysis, options);
      return {
        safe: true,
        tasks: resolvedTasks.tasks,
        analysis: overlapAnalysis,
        resolutions: resolvedTasks.resolutions,
        modified: resolvedTasks.modified
      };
    }

    // Return analysis for manual review
    return {
      safe: false,
      tasks: tasks,
      analysis: overlapAnalysis,
      requiresReview: true
    };
  }

  /**
   * Automatically resolve overlaps where possible
   */
  async autoResolveOverlaps(tasks, overlapAnalysis, options = {}) {
    const resolutions = [];
    let modifiedTasks = [...tasks];
    let modified = false;

    for (const overlap of overlapAnalysis.overlaps) {
      const task1 = modifiedTasks.find(t => t._id === overlap.task1);
      const task2 = modifiedTasks.find(t => t._id === overlap.task2);

      if (!task1 || !task2) continue;

      try {
        const resolution = await this.resolveSpecificOverlap(task1, task2, overlap, options);
        if (resolution.applied) {
          resolutions.push(resolution);
          
          // Apply the resolution to the task set
          if (resolution.type === 'add_dependency') {
            const targetTask = modifiedTasks.find(t => t._id === resolution.targetTask);
            if (targetTask) {
              targetTask.dependencies = [...(targetTask.dependencies || []), resolution.dependency];
              modified = true;
            }
          } else if (resolution.type === 'merge_tasks') {
            // Remove individual tasks and add merged task
            modifiedTasks = modifiedTasks.filter(t => 
              t._id !== resolution.task1 && t._id !== resolution.task2
            );
            modifiedTasks.push(resolution.mergedTask);
            modified = true;
          }
        }
      } catch (error) {
        console.error(`❌ Failed to resolve overlap between ${task1.title} and ${task2.title}: ${error.message}`);
      }
    }

    console.log(`🔧 Applied ${resolutions.length} automatic overlap resolutions`);

    return {
      tasks: modifiedTasks,
      resolutions: resolutions,
      modified: modified
    };
  }

  /**
   * Resolve a specific overlap between two tasks
   */
  async resolveSpecificOverlap(task1, task2, overlap, options = {}) {
    const resolution = {
      applied: false,
      type: null,
      task1: task1._id,
      task2: task2._id,
      overlapType: overlap.overlapType
    };

    // Strategy 1: Add dependency for file overlaps
    if (overlap.overlapType.includes('file_overlap') && overlap.severity !== 'critical') {
      const priority1 = this.calculateTaskPriority(task1);
      const priority2 = this.calculateTaskPriority(task2);
      
      if (priority1 !== priority2) {
        const dependentTask = priority1 > priority2 ? task1 : task2;
        const prerequisiteTask = priority1 > priority2 ? task2 : task1;
        
        resolution.applied = true;
        resolution.type = 'add_dependency';
        resolution.targetTask = dependentTask._id;
        resolution.dependency = prerequisiteTask._id;
        resolution.reason = `Added dependency: ${dependentTask.title} waits for ${prerequisiteTask.title}`;
        
        return resolution;
      }
    }

    // Strategy 2: Merge conceptually similar tasks
    if (overlap.overlapType.includes('conceptual_overlap') && 
        overlap.severity === 'high' && 
        options.allowMerge !== false) {
      
      const mergedTask = this.createMergedTask(task1, task2);
      resolution.applied = true;
      resolution.type = 'merge_tasks';
      resolution.mergedTask = mergedTask;
      resolution.reason = `Merged conceptually similar tasks: ${task1.title} + ${task2.title}`;
      
      return resolution;
    }

    // Strategy 3: Coordinate module overlaps
    if (overlap.overlapType.includes('module_overlap')) {
      resolution.applied = true;
      resolution.type = 'coordinate_modules';
      resolution.coordinationPlan = this.createModuleCoordinationPlan(task1, task2, overlap);
      resolution.reason = `Created coordination plan for module overlap`;
      
      return resolution;
    }

    return resolution;
  }

  /**
   * Create a merged task from two overlapping tasks
   */
  createMergedTask(task1, task2) {
    return {
      _id: `merged_${task1._id}_${task2._id}`,
      title: `Combined: ${task1.title} & ${task2.title}`,
      description: `Merged task combining:\n1. ${task1.title}: ${task1.description || ''}\n2. ${task2.title}: ${task2.description || ''}`,
      type: task1.type === task2.type ? task1.type : 'feature',
      complexity: this.escalateComplexity(task1.complexity, task2.complexity),
      priority: this.escalatePriority(task1.priority, task2.priority),
      assignedAgent: this.selectBestAgentForMergedTask(task1, task2),
      dependencies: [...new Set([...(task1.dependencies || []), ...(task2.dependencies || [])])],
      originalTasks: [task1._id, task2._id],
      estimatedDuration: this.estimateTaskDuration(task1) + this.estimateTaskDuration(task2),
      merged: true
    };
  }

  /**
   * Helper methods for task merging
   */
  escalateComplexity(complexity1, complexity2) {
    const levels = { 'simple': 1, 'moderate': 2, 'complex': 3, 'expert': 4 };
    const level1 = levels[complexity1] || 2;
    const level2 = levels[complexity2] || 2;
    const maxLevel = Math.max(level1, level2);
    
    return Object.keys(levels).find(key => levels[key] === maxLevel) || 'moderate';
  }

  escalatePriority(priority1, priority2) {
    const levels = { 'low': 1, 'medium': 2, 'high': 3, 'critical': 4 };
    const level1 = levels[priority1] || 2;
    const level2 = levels[priority2] || 2;
    const maxLevel = Math.max(level1, level2);
    
    return Object.keys(levels).find(key => levels[key] === maxLevel) || 'medium';
  }

  selectBestAgentForMergedTask(task1, task2) {
    // Simple logic: prefer higher-capability agent
    const agentHierarchy = {
      'product-manager': 6,
      'tech-lead': 5,
      'senior-developer': 4,
      'project-manager': 3,
      'qa-engineer': 2,
      'junior-developer': 1
    };

    const level1 = agentHierarchy[task1.assignedAgent] || 1;
    const level2 = agentHierarchy[task2.assignedAgent] || 1;
    
    return level1 >= level2 ? task1.assignedAgent : task2.assignedAgent;
  }

  createModuleCoordinationPlan(task1, task2, overlap) {
    return {
      coordinationType: 'module_overlap',
      affectedModules: overlap.details.modules,
      tasks: [task1._id, task2._id],
      strategy: 'interface_definition',
      interfaces: overlap.details.modules.map(module => ({
        module: module,
        task1Interface: `${module}_${task1._id}_interface`,
        task2Interface: `${module}_${task2._id}_interface`,
        coordinationPoints: ['data_flow', 'api_contracts', 'shared_components']
      }))
    };
  }
}

module.exports = BranchManager;