import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { uploadMultipleImages } from '../middleware/upload';
import { TaskRepository, ITask } from '../database/repositories/TaskRepository.js';
import { RepositoryRepository } from '../database/repositories/RepositoryRepository.js';
// v1 OrchestrationCoordinator - battle-tested with full prompts
import { OrchestrationCoordinator } from '../services/orchestration/OrchestrationCoordinator';
import { storageService } from '../services/storage/StorageService';
import { z } from 'zod';

// 🎯 UNIFIED MEMORY - THE SINGLE SOURCE OF TRUTH
import { unifiedMemoryService } from '../services/UnifiedMemoryService';
// 🔥 REMOVED: granularMemoryService - SQLite (UnifiedMemoryService) is the single source of truth

// 🔥 EventStore - For persisting approval events (critical for resume)
import { eventStore } from '../services/EventStore';

const router = Router();
// Shared orchestration coordinator instance
const orchestrationCoordinator = new OrchestrationCoordinator();

// Validación schemas con Zod
const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(), // Opcional - se define en el chat
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  projectId: z.string().optional(),
  repositoryIds: z.array(z.string()).optional(), // Array de repository IDs
  tags: z.array(z.string()).optional(),
  modelConfig: z.enum(['standard', 'premium', 'recommended', 'balanced', 'economy', 'max']).optional(), // Model preset configuration
});

const startTaskSchema = z.object({
  description: z.string().optional(), // Descripción de la tarea desde el chat (puede estar vacía)
  content: z.string().optional(), // Compatibilidad con mensajes
  instructions: z.string().optional(),
});

const approvePhaseSchema = z.object({
  approved: z.boolean(),
  comments: z.string().optional(),
});

const continueTaskSchema = z.object({
  additionalRequirements: z.string().min(1, 'Additional requirements are required'),
});

const autoApprovalConfigSchema = z.object({
  enabled: z.boolean(),
  phases: z.array(
    // Active phases from PHASE_ORDER: Planning → Approval → TeamOrchestration → Recovery → Integration → AutoMerge
    z.enum([
      'planning',           // Main phase
      'team-orchestration', // Main phase (contains TechLead → Developers → Judge)
      'recovery',           // Main phase (verify work, complete pending)
      'integration',        // Main phase (merge branches, resolve conflicts)
      'verification',       // Main phase
      'auto-merge',         // Main phase
      // Sub-phases (for granular control)
      'tech-lead',
      'development',
      'judge',
      'verification-fixer',
    ])
  ).optional(),
  // 🤖 Supervisor auto-approval threshold (0-100)
  // When Supervisor score >= threshold, auto-approve without human intervention
  supervisorThreshold: z.number().min(0).max(100).optional(),
});

const modelConfigSchema = z.object({
  preset: z.enum(['max', 'premium', 'recommended', 'standard', 'custom']).optional(),
  customConfig: z.object({
    planning: z.string().optional(),
    techLead: z.string().optional(),
    developer: z.string().optional(),
    judge: z.string().optional(),
    verification: z.string().optional(),
    autoMerge: z.string().optional(),
  }).optional(),
});

const approveStorySchema = z.object({
  approved: z.boolean(),
  comments: z.string().optional(),
});

/**
 * GET /api/tasks
 * Obtener todas las tareas del usuario con paginación
 * Query params: page (default 1), limit (default 5), status, priority, projectId
 */
router.get('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const { status, priority, projectId, repositoryId, page, limit } = req.query;

    // Check if user exists in the request
    if (!req.user || !req.user.id) {
      console.error('No user found in request after authentication');
      return res.status(401).json({
        success: false,
        message: 'User not authenticated properly'
      });
    }

    // Pagination params - default 5 per page
    const pageNum = Math.max(1, parseInt(page as string) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string) || 5));
    const offset = (pageNum - 1) * limitNum;

    console.log('Tasks filter:', { userId: req.user.id, status, priority, projectId, page: pageNum, limit: limitNum });

    // Execute query - SQLite is synchronous, no timeout needed
    let tasks: ITask[] = [];
    let total = 0;
    try {
      // Get total count for pagination
      total = TaskRepository.count({
        userId: req.user.id,
        status: status as any,
      });

      // Get paginated tasks
      tasks = TaskRepository.findAll({
        userId: req.user.id,
        status: status as any,
        priority: priority as string,
        projectId: projectId as string,
        repositoryId: repositoryId as string,
        limit: limitNum,
        offset: offset,
        orderBy: 'updated_at',
        orderDir: 'DESC',
      });
      console.log(`Tasks query successful: Found ${tasks.length} tasks (page ${pageNum}, total ${total})`);
    } catch (dbError: any) {
      console.error('Tasks database error:', dbError);
      tasks = [];
    }

    const totalPages = Math.ceil(total / limitNum);

    // Ensure response is always sent
    return res.json({
      success: true,
      data: {
        tasks: tasks,
        pagination: {
          total: total,
          page: pageNum,
          limit: limitNum,
          totalPages: totalPages,
          hasNext: pageNum < totalPages,
          hasPrev: pageNum > 1
        }
      },
      count: tasks.length,
    });
  } catch (error) {
    console.error('Error fetching tasks:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch tasks',
    });
  }
});

/**
 * GET /api/tasks/:id
 * Obtener una tarea específica
 */
router.get('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const task = TaskRepository.findByIdAndUser(req.params.id, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    res.json({
      success: true,
      data: task,
    });
  } catch (error) {
    console.error('Error fetching task:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch task',
    });
  }
});

/**
 * POST /api/tasks
 * Crear una nueva tarea
 */
router.post('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const validatedData = createTaskSchema.parse(req.body);

    // 🔧 USE ONLY SELECTED REPOSITORIES
    // The frontend sends specific repositoryIds selected by the user
    // We should NEVER auto-populate all repositories from the project
    let repositoryIds: string[] = validatedData.repositoryIds || [];

    // Validate that repositories were selected
    if (repositoryIds.length === 0) {
      console.log(`⚠️ Task created without repository selection`);
      // This is valid - some tasks might not need repositories
      // But log it for debugging
    } else {
      console.log(`✅ Task created with ${repositoryIds.length} selected repositories:`, repositoryIds);

      // Verify the selected repositories exist and are active
      const validRepos = RepositoryRepository.findByIds(repositoryIds);

      if (validRepos.length !== repositoryIds.length) {
        console.warn(`⚠️ Some selected repositories not found or inactive`);
        console.warn(`   Requested: ${repositoryIds.length}, Found: ${validRepos.length}`);
      }

      // Log which repositories were selected for debugging
      validRepos.forEach(repo => {
        console.log(`   - ${repo.name} (${repo.githubRepoName})`);
      });
    }

    const task = TaskRepository.create({
      title: validatedData.title,
      description: validatedData.description,
      projectId: validatedData.projectId,
      repositoryIds,
      userId: req.user!.id,
      priority: validatedData.priority,
      tags: validatedData.tags,
      orchestration: {
        totalCost: 0,
        totalTokens: 0,
        modelConfig: {
          preset: validatedData.modelConfig || 'standard',
        },
      },
    });

    res.status(201).json({
      success: true,
      data: {
        task: task,
      },
      message: 'Task created successfully',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        message: 'Invalid task data',
        errors: error.errors,
      });
      return;
    }

    console.error('Error creating task:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create task',
    });
  }
});

/**
 * POST /api/tasks/:id/start
 * Iniciar la orquestación de agentes para una tarea
 * Recibe la descripción desde el primer mensaje del chat + opcional imagen
 * Soporta tanto JSON como multipart/form-data (con imagen)
 */
router.post('/:id/start', authenticate, uploadMultipleImages, async (req: AuthRequest, res) => {
  try {
    console.log('🔍 [START] Received body:', JSON.stringify(req.body, null, 2));
    console.log('🔍 [START] Task ID:', req.params.id);
    console.log('🔍 [START] description field:', req.body.description);
    console.log('🔍 [START] content field:', req.body.content);
    const validatedData = startTaskSchema.parse(req.body);

    const task = TaskRepository.findByIdAndUser(req.params.id, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    if (task.status === 'in_progress') {
      res.status(400).json({
        success: false,
        message: 'Task is already in progress',
      });
      return;
    }

    // 🔧 AUTO-POPULATE REPOSITORIES IF MISSING (for tasks created before auto-population fix)
    if (task.projectId && (!task.repositoryIds || task.repositoryIds.length === 0)) {
      console.log(`📦 Task has projectId but no repositories, auto-populating from project...`);

      const repositories = RepositoryRepository.findByProjectId(task.projectId);

      if (repositories.length > 0) {
        const repoIds = repositories.map((repo) => repo.id);
        TaskRepository.updateRepositoryIds(task.id, repoIds);
        task.repositoryIds = repoIds;
        console.log(`✅ Auto-populated ${repositories.length} repositories for task ${task.id}`);
      } else {
        console.warn(`⚠️  No active repositories found for project ${task.projectId}`);
      }
    }

    // ⚠️ CRITICAL: Verificar que el task tenga repositorios configurados
    if (!task.repositoryIds || task.repositoryIds.length === 0) {
      res.status(400).json({
        success: false,
        message: 'Cannot start orchestration: No repositories configured for this task',
        error: 'MISSING_REPOSITORIES',
        hint: 'Please configure at least one repository in the task settings before starting orchestration',
      });
      return;
    }

    // Actualizar descripción desde el chat y estado
    const description = validatedData.description || validatedData.content || '';
    const attachments: string[] = task.attachments || [];

    // 🔥 PROCESS IMAGES - Upload to Firebase Storage (not local disk)
    if ((req as any).files && (req as any).files.length > 0) {
      const uploadedFiles = (req as any).files as Express.Multer.File[];
      console.log(`📎 [START] ${uploadedFiles.length} image(s) to upload to Firebase`);

      // Upload each file to Firebase Storage
      for (const uploadedFile of uploadedFiles) {
        console.log(`📎 [START] Uploading to Firebase: ${uploadedFile.originalname} (${(uploadedFile.size / 1024).toFixed(1)} KB)`);

        try {
          const storageFile = await storageService.saveUpload(
            req.user!.id,
            uploadedFile.buffer,
            uploadedFile.originalname,
            uploadedFile.mimetype
          );

          attachments.push(storageFile.path);
          console.log(`📎 [START] Image uploaded to Firebase: ${storageFile.path}`);
        } catch (uploadError: any) {
          console.error(`❌ [START] Failed to upload ${uploadedFile.originalname}:`, uploadError.message);
        }
      }

      console.log(`📎 [START] Total ${attachments.length} attachments for this task`);
    }

    // Update task with description, status, and attachments
    TaskRepository.update(task.id, {
      description,
      status: 'in_progress',
      attachments,
    });

    console.log(`🚀 Starting orchestration for task: ${task.id}`);
    console.log(`📝 Task description: ${description}`);
    console.log(`📎 Task attachments: ${attachments.length}`);

    // v1 OrchestrationCoordinator - battle-tested with full intelligent prompts
    orchestrationCoordinator.orchestrateTask(task.id).catch((error) => {
      console.error('❌ Orchestration error:', error);
    });

    res.json({
      success: true,
      message: 'Orchestration started',
      data: {
        taskId: task.id,
        status: 'in_progress',
        description,
        info: 'Orchestration: Planning → TechLead → Developers → Judge → Verification → AutoMerge',
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('🔍 [START] Validation error:', error.errors);
      res.status(400).json({
        success: false,
        message: 'Invalid start data - either description or content is required',
        errors: error.errors,
      });
      return;
    }

    console.error('Error starting task:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to start task',
    });
  }
});

/**
 * POST /api/tasks/:id/continue
 * Continue working on a completed task with additional requirements
 * Preserves context: same repositories, branches, and previous work
 */
router.post('/:id/continue', authenticate, uploadMultipleImages, async (req: AuthRequest, res) => {
  try {
    const validatedData = continueTaskSchema.parse(req.body);

    const task = TaskRepository.findByIdAndUser(req.params.id, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    // Validate task can be continued
    // Only block if actively running - allow continuation from any other state
    if (task.status === 'in_progress') {
      res.status(400).json({
        success: false,
        message: 'Task is currently in progress. Wait for it to complete before continuing.',
      });
      return;
    }

    // Allow continuation from: completed, failed, cancelled, paused, interrupted, pending
    console.log(`🔄 [Continue] Allowing continuation from status: ${task.status}`);

    // Verify repositories are still configured
    if (!task.repositoryIds || task.repositoryIds.length === 0) {
      res.status(400).json({
        success: false,
        message: 'Cannot continue: No repositories configured for this task',
      });
      return;
    }

    // Append additional requirements to description
    const previousDescription = task.description || '';
    const newDescription = `${previousDescription}\n\n--- CONTINUATION ---\n${validatedData.additionalRequirements}`;
    const attachments: string[] = task.attachments || [];

    // 🔥 PROCESS IMAGES - Upload to Firebase Storage (not local disk)
    if ((req as any).files && (req as any).files.length > 0) {
      const uploadedFiles = (req as any).files as Express.Multer.File[];
      console.log(`📎 [CONTINUE] ${uploadedFiles.length} image(s) to upload to Firebase`);

      for (const uploadedFile of uploadedFiles) {
        console.log(`📎 [CONTINUE] Uploading to Firebase: ${uploadedFile.originalname} (${(uploadedFile.size / 1024).toFixed(1)} KB)`);

        try {
          const storageFile = await storageService.saveUpload(
            req.user!.id,
            uploadedFile.buffer,
            uploadedFile.originalname,
            uploadedFile.mimetype
          );

          attachments.push(storageFile.path);
          console.log(`📎 [CONTINUE] Image uploaded to Firebase: ${storageFile.path}`);
        } catch (uploadError: any) {
          console.error(`❌ [CONTINUE] Failed to upload ${uploadedFile.originalname}:`, uploadError.message);
        }
      }

      console.log(`📎 [CONTINUE] Total ${attachments.length} attachments for this task`);
    }

    // Update task
    TaskRepository.update(task.id, {
      description: newDescription,
      status: 'in_progress',
      attachments,
    });

    // Add continuation record and clear paused state
    TaskRepository.addContinuation(task.id, validatedData.additionalRequirements, task.status);
    TaskRepository.setPaused(task.id, false);
    TaskRepository.setCancelRequested(task.id, false);

    console.log(`🔄 Continuing orchestration for task: ${task.id}`);
    console.log(`📝 Additional requirements: ${validatedData.additionalRequirements}`);
    console.log(`📦 Preserving ${task.repositoryIds.length} repositories`);
    console.log(`🌿 Preserving existing epic branches`);

    // v1 OrchestrationCoordinator - battle-tested with full intelligent prompts
    orchestrationCoordinator.orchestrateTask(task.id).catch((error) => {
      console.error('❌ Orchestration continuation error:', error);
    });

    res.json({
      success: true,
      message: 'Task continuation started - preserving repositories, branches, and previous work',
      data: {
        taskId: task.id,
        status: 'in_progress',
        additionalRequirements: validatedData.additionalRequirements,
        preservedContext: {
          repositories: task.repositoryIds.length,
          previousWork: 'Epic branches and commits will be preserved',
        },
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        message: 'Invalid continuation data',
        errors: error.errors,
      });
      return;
    }

    console.error('Error continuing task:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to continue task',
    });
  }
});

/**
 * GET /api/tasks/:id/status
 * Obtener el estado de la orquestación
 */
router.get('/:id/status', authenticate, async (req: AuthRequest, res) => {
  try {
    const task = TaskRepository.findByIdAndUser(req.params.id, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    res.json({
      success: true,
      data: {
        status: task.status,
        currentPhase: task.orchestration.currentPhase,

        // Phase statuses (active phases)
        planning: task.orchestration.planning?.status || 'pending',
        techLead: task.orchestration.techLead?.status || 'pending',
        judge: task.orchestration.judge?.status || 'pending',
        autoMerge: task.orchestration.autoMerge?.status || 'pending',

        // Team info
        teamSize: task.orchestration.team?.length || 0,
        epicsCount: task.orchestration.planning?.epics?.length || 0,

        // Metrics
        totalCost: task.orchestration.totalCost,
        totalTokens: task.orchestration.totalTokens,
      },
    });
  } catch (error) {
    console.error('Error fetching task status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch task status',
    });
  }
});

/**
 * GET /api/tasks/:id/logs
 * Obtener logs históricos de la tarea
 * Para que ConsoleViewer pueda recuperar logs al refrescar
 */
router.get('/:id/logs', authenticate, async (req: AuthRequest, res) => {
  try {
    const task = TaskRepository.findByIdAndUser(req.params.id, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    res.json({
      success: true,
      data: {
        logs: task.logs || [],
      },
    });
  } catch (error) {
    console.error('Error fetching task logs:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch task logs',
    });
  }
});

/**
 * GET /api/tasks/:id/orchestration
 * Obtener detalles completos de la orquestación
 */
router.get('/:id/orchestration', authenticate, async (req: AuthRequest, res) => {
  try {
    const task = TaskRepository.findByIdAndUser(req.params.id, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    res.json({
      success: true,
      data: task.orchestration,
    });
  } catch (error) {
    console.error('Error fetching orchestration:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch orchestration details',
    });
  }
});

/**
 * DELETE /api/tasks/:id
 * Eliminar una tarea
 */
router.delete('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const deleted = TaskRepository.deleteByIdAndUser(req.params.id, req.user!.id);

    if (!deleted) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    res.json({
      success: true,
      message: 'Task deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting task:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete task',
    });
  }
});

/**
 * POST /api/tasks/:id/approve/:phase
 * Aprobar o rechazar una fase de la orquestación
 * Phases: planning, tech-lead, development, team-orchestration, judge, verification, auto-merge
 */
router.post('/:id/approve/:phase', authenticate, async (req: AuthRequest, res) => {
  try {
    const validatedData = approvePhaseSchema.parse(req.body);
    const { phase } = req.params;

    let task = TaskRepository.findByIdAndUser(req.params.id, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    // Work with a mutable copy of orchestration
    const orchestration = { ...task.orchestration };

    // Mapear phase URL param a field en orchestration
    let agentStep: any = null;
    let phaseName = '';

    // 🔥 DEBUG: Log orchestration state to understand why planning might be null
    console.log(`📋 [Approve] Phase: ${phase}, TaskId: ${req.params.id}`);
    console.log(`📋 [Approve] orchestration.planning exists: ${!!orchestration?.planning}`);
    console.log(`📋 [Approve] orchestration.planning.status: ${orchestration?.planning?.status}`);
    console.log(`📋 [Approve] orchestration keys: ${Object.keys(orchestration || {}).join(', ')}`);

    switch (phase) {
      case 'planning':
        // 🔥 FIX: If planning phase data doesn't exist, create it to allow approval
        if (!orchestration.planning) {
          console.log(`🔧 [Approve] planning field missing in orchestration - creating synthetic step`);
          const timestamp = orchestration.pendingApproval?.timestamp || new Date();
          orchestration.planning = {
            agent: 'planning-agent',
            status: 'completed',
            startedAt: timestamp,
            completedAt: new Date(),
          } as any;
                    console.log(`✅ [Approve] Created synthetic planning step`);
        } else if (orchestration.planning.status === 'in_progress') {
          console.log(`🔧 [Approve] planning exists with status in_progress - marking as completed for approval`);
          orchestration.planning.status = 'completed';
          orchestration.planning.completedAt = new Date();
                    console.log(`✅ [Approve] Marked planning as completed for approval`);
        }
        agentStep = orchestration.planning;
        phaseName = 'Planning (Unified)';
        break;
      case 'tech-lead':
        if (!orchestration.techLead) {
          console.log(`🔧 [Approve] tech-lead field missing in orchestration - creating synthetic step`);
          const timestamp = orchestration.pendingApproval?.timestamp || new Date();
          orchestration.techLead = {
            agent: 'tech-lead',
            status: 'completed',
            startedAt: timestamp,
            completedAt: new Date(),
          } as any;
                    console.log(`✅ [Approve] Created synthetic tech-lead step`);
        } else if (orchestration.techLead.status === 'in_progress') {
          console.log(`🔧 [Approve] tech-lead exists with status in_progress - marking as completed for approval`);
          orchestration.techLead.status = 'completed';
          orchestration.techLead.completedAt = new Date();
                    console.log(`✅ [Approve] Marked tech-lead as completed for approval`);
        }
        agentStep = orchestration.techLead;
        phaseName = 'Tech Lead';
        break;
      case 'development':
        // Development phase no tiene un agentStep único, es el team completo
        const team = orchestration.team || [];
        const allCompleted = team.every((m: any) => m.status === 'completed');

        if (!allCompleted) {
          res.status(400).json({
            success: false,
            message: 'Development phase is not ready for approval - some developers are still working',
          });
          return;
        }

        // Crear aprobación sintética para el team
        if (!orchestration.judge) {
          orchestration.judge = {
            agent: 'judge',
            status: 'pending',
          } as any;
                  }

        const judgeStep = orchestration.judge;
        if (judgeStep && !judgeStep.approval) {
          judgeStep.approval = {
            status: 'pending',
            requestedAt: new Date(),
          };
                  }

        agentStep = judgeStep;
        phaseName = 'Development Team';
        break;
      case 'judge':
        if (!orchestration.judge) {
          console.log(`⚠️  [Approval] Judge phase not found for task ${req.params.id}`);
          res.status(400).json({
            success: false,
            message: 'Judge phase not found - it may not have started yet',
          });
          return;
        }

        console.log(`🔍 [Approval] Judge status: ${orchestration.judge.status}, evaluations: ${orchestration.judge.evaluations?.length || 0}`);

        const judgeEvaluations = orchestration.judge.evaluations || [];
        if (judgeEvaluations.length === 0) {
          res.status(400).json({
            success: false,
            message: 'Judge has not evaluated any stories yet',
          });
          return;
        }

        agentStep = orchestration.judge;
        phaseName = 'Judge Evaluation';
        break;
      case 'auto-merge':
        agentStep = (orchestration as any).autoMerge;
        phaseName = 'Auto-Merge';
        break;
      case 'verification':
        agentStep = task.orchestration.phases?.find((p: any) => p.name === 'Verification');
        phaseName = 'Verification';
        break;
      case 'team-orchestration':
        // Team orchestration phase - approval to START multi-team execution
        // This approval happens BEFORE teams are created, not after

        // Find or create the TeamOrchestration phase in phases array
        let teamOrchestrationStep = task.orchestration.phases?.find((p: any) =>
          p.name === 'TeamOrchestration'
        );

        if (!teamOrchestrationStep) {
          // Create the phase step if it doesn't exist
          teamOrchestrationStep = {
            name: 'TeamOrchestration',
            status: 'pending',
            startedAt: new Date(),
            approval: {
              status: 'pending',
              requestedAt: new Date(),
            }
          };

          if (!task.orchestration.phases) {
            task.orchestration.phases = [];
          }
          task.orchestration.phases.push(teamOrchestrationStep);
        }

        // For team-orchestration, we treat it like other phases
        // Allow approval even if status is 'pending' (waiting to start)
        if (!teamOrchestrationStep.approval) {
          teamOrchestrationStep.approval = {
            status: 'pending',
            requestedAt: new Date(),
          };
        }

        // Override the status check for team-orchestration
        // It can be approved while 'pending' to allow it to start
        teamOrchestrationStep.status = 'completed'; // Mark as completed to pass validation

        agentStep = teamOrchestrationStep;
        phaseName = 'Team Orchestration';
        break;
      default:
        res.status(400).json({
          success: false,
          message: `Invalid phase: ${phase}. Valid phases: planning, tech-lead, development, team-orchestration, judge, verification, auto-merge`,
        });
        return;
    }

    if (!agentStep) {
      res.status(400).json({
        success: false,
        message: `Phase ${phase} not found or not started yet`,
      });
      return;
    }

    // Verificar que la fase esté completada y esperando aprobación
    if (agentStep.status !== 'completed' && phase !== 'development') {
      res.status(400).json({
        success: false,
        message: `Phase ${phase} is not completed yet (status: ${agentStep.status})`,
      });
      return;
    }

    // Crear approval object si no existe
    if (!agentStep.approval) {
      agentStep.approval = {
        status: 'pending',
        requestedAt: new Date(),
      };
    }

    // Phases that support re-execution with feedback (don't fail task)
    const reExecutablePhases = ['tech-lead', 'planning'];
    let newTaskStatus = task.status;

    // Actualizar estado de aprobación
    if (validatedData.approved) {
      agentStep.approval.status = 'approved';
      agentStep.approval.approvedBy = req.user!.id;
      agentStep.approval.approvedAt = new Date();
      agentStep.approved = true;

      console.log(`✅ [Approval] ${phaseName} approved by user ${req.user!.id}`);
    } else {
      agentStep.approval.status = 'rejected';
      agentStep.approved = false;

      if (!reExecutablePhases.includes(phase)) {
        newTaskStatus = 'failed';
        console.log(`❌ [Approval] ${phaseName} rejected by user ${req.user!.id} - task marked as failed`);
      } else {
        console.log(`🔄 [Approval] ${phaseName} rejected by user ${req.user!.id} - will re-execute with feedback`);
      }
    }

    // Guardar comentarios si existen
    if (validatedData.comments) {
      if (!agentStep.approval.comments) {
        agentStep.approval.comments = validatedData.comments;
      }
    }

    // Update task status if changed
    if (newTaskStatus !== task.status) {
      TaskRepository.update(task.id, { status: newTaskStatus });
    }

    // Update orchestration and add approval history
    TaskRepository.updateOrchestration(task.id, orchestration);
    TaskRepository.addApprovalHistory(task.id, {
      phase,
      phaseName,
      approved: validatedData.approved,
      approvedBy: req.user!.id,
      approvedAt: new Date(),
      comments: validatedData.comments,
      autoApproved: false,
    });

    // 📡 Emit approval event to notify waiting orchestrator (event-based, no polling)
    const { approvalEvents } = await import('../services/ApprovalEvents');
    const taskId = task.id;
    approvalEvents.emitApproval(taskId, phase, validatedData.approved, validatedData.comments);

    // 🎯 UNIFIED MEMORY: Mark phase as approved (THE SOURCE OF TRUTH)
    if (validatedData.approved) {
      await unifiedMemoryService.markPhaseApproved(taskId, phase, req.user?.id);
    } else {
      await unifiedMemoryService.markPhaseFailed(taskId, phase, validatedData.comments || 'Rejected by user');
    }

    // 🔥 CRITICAL: Emit EventStore events for resume/recovery
    // Without these events, phases will re-execute after resume!
    const phaseToEventType: Record<string, { approved: string; rejected: string }> = {
      'planning': { approved: 'PlanningApproved', rejected: 'PlanningRejected' },
      'tech-lead': { approved: 'TechLeadApproved', rejected: 'TechLeadRejected' },
      'judge': { approved: 'PRApproved', rejected: 'PRRejected' },
      'auto-merge': { approved: 'PRApproved', rejected: 'PRRejected' },
    };

    const eventTypes = phaseToEventType[phase];
    if (eventTypes) {
      const eventType = validatedData.approved ? eventTypes.approved : eventTypes.rejected;
      await eventStore.safeAppend({
        taskId,
        eventType: eventType as any,
        payload: {
          phase,
          approvedBy: req.user?.id,
          approvedAt: new Date(),
          comments: validatedData.comments,
        },
        userId: req.user?.id,
        agentName: 'ApprovalAPI',
      });
      console.log(`💾 [Approval] Emitted EventStore event: ${eventType} for task ${taskId}`);
    }

    // Emitir notificación WebSocket
    const { NotificationService } = await import('../services/NotificationService');

    if (validatedData.approved) {
      NotificationService.emitApprovalGranted(taskId, {
        phase,
        approved: true,
      });

      NotificationService.emitAgentMessage(
        taskId,
        'System',
        `✅ **${phaseName}** has been approved by user. Continuing orchestration...`
      );
    } else {
      NotificationService.emitApprovalGranted(taskId, {
        phase,
        approved: false,
        feedback: validatedData.comments,
        willRetry: reExecutablePhases.includes(phase) && !!validatedData.comments,
      });

      const message = reExecutablePhases.includes(phase) && validatedData.comments
        ? `🔄 **${phaseName}** was rejected with feedback. Re-executing phase...${validatedData.comments ? `\n\n**Feedback**: ${validatedData.comments}` : ''}`
        : `❌ **${phaseName}** was rejected by user. Task marked as failed.${validatedData.comments ? `\n\n**Comments**: ${validatedData.comments}` : ''}`;

      NotificationService.emitAgentMessage(
        taskId,
        'System',
        message
      );
    }

    res.json({
      success: true,
      message: validatedData.approved
        ? `${phaseName} approved successfully`
        : `${phaseName} rejected`,
      data: {
        phase: phaseName,
        approved: validatedData.approved,
        approvalStatus: agentStep.approval.status,
        taskStatus: newTaskStatus,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        message: 'Invalid approval data',
        errors: error.errors,
      });
      return;
    }

    console.error('Error approving phase:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to approve phase',
    });
  }
});

/**
 * PUT /api/tasks/:id/auto-approval
 * Configurar auto-aprobación para una tarea
 */
router.put('/:id/auto-approval', authenticate, async (req: AuthRequest, res) => {
  try {
    const validatedData = autoApprovalConfigSchema.parse(req.body);

    const task = TaskRepository.findByIdAndUser(req.params.id, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    // Determine phases to use
    let phases = validatedData.phases as string[] | undefined;
    if (phases === undefined && validatedData.enabled) {
      phases = ['planning', 'team-orchestration', 'verification', 'auto-merge'];
    }

    // Update auto-approval configuration
    TaskRepository.updateAutoApproval(
      task.id,
      validatedData.enabled,
      phases,
      validatedData.supervisorThreshold
    );

    // Refresh task to get updated values
    const updatedTask = TaskRepository.findById(task.id)!;
    const threshold = updatedTask.orchestration.supervisorThreshold ?? 80;
    console.log(`🚁 [Auto-Approval] Configuration updated for task ${req.params.id}: enabled=${validatedData.enabled}, phases=${updatedTask.orchestration.autoApprovalPhases?.join(', ')}, supervisorThreshold=${threshold}%`);

    res.json({
      success: true,
      message: `Auto-approval ${validatedData.enabled ? 'enabled' : 'disabled'}`,
      data: {
        enabled: updatedTask.orchestration.autoApprovalEnabled,
        phases: updatedTask.orchestration.autoApprovalPhases || [],
        supervisorThreshold: threshold,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        message: 'Invalid auto-approval configuration',
        errors: error.errors,
      });
      return;
    }

    console.error('Error updating auto-approval config:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update auto-approval configuration',
    });
  }
});

/**
 * GET /api/tasks/:id/auto-approval
 * Obtener configuración de auto-aprobación
 */
router.get('/:id/auto-approval', authenticate, async (req: AuthRequest, res) => {
  try {
    const task = TaskRepository.findByIdAndUser(req.params.id, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    res.json({
      success: true,
      data: {
        enabled: task.orchestration.autoApprovalEnabled || false,
        phases: task.orchestration.autoApprovalPhases || [],
        supervisorThreshold: task.orchestration.supervisorThreshold ?? 80,
      },
    });
  } catch (error) {
    console.error('Error fetching auto-approval config:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch auto-approval configuration',
    });
  }
});

/**
 * POST /api/tasks/:id/bypass-approval
 * 🔥 BYPASS: Force-approve the current pending approval phase
 *
 * This allows the user to skip manual approval AFTER the orchestration has already started waiting.
 * Useful if you forgot to enable auto-approval before starting the task.
 *
 * Optionally enables auto-approval for future phases of the same type.
 */
router.post('/:id/bypass-approval', authenticate, async (req: AuthRequest, res) => {
  try {
    const { enableAutoApproval = false, enableForAllPhases = false } = req.body;

    const task = TaskRepository.findByIdAndUser(req.params.id, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    // Get the pending approval phase from persisted data
    const pendingApproval = task.orchestration?.pendingApproval;
    const taskId = task.id;

    // 🔥 SMART PHASE DETECTION: Try to determine phase even if not persisted
    let phase: string;
    let phaseName: string;

    if (pendingApproval && pendingApproval.phase) {
      // Use persisted pending approval
      phase = pendingApproval.phase;
      phaseName = pendingApproval.phaseName || phase;
      console.log(`🔥 [Bypass] Found persisted pendingApproval: ${phase}`);
    } else {
      // Try to infer current phase from task state
      console.log(`⚠️ [Bypass] No persisted pendingApproval, inferring from task state...`);

      // Check what phase we're likely waiting on
      const planning = task.orchestration?.planning;
      const techLead = task.orchestration?.techLead;

      if (planning?.status === 'completed' && (!techLead || techLead?.status !== 'completed')) {
        // Planning done but TechLead not complete = likely waiting on TechLead approval
        phase = 'tech-lead';
        phaseName = 'Tech Lead Architecture';
        console.log(`🔍 [Bypass] Inferred phase: ${phase} (Planning done, TechLead not complete)`);
      } else if (planning?.status === 'in_progress' || planning?.status === 'pending') {
        // Planning in progress = might be waiting on Planning approval
        phase = 'planning';
        phaseName = 'Planning';
        console.log(`🔍 [Bypass] Inferred phase: ${phase} (Planning in progress)`);
      } else {
        // Default to trying common approval phases
        phase = 'tech-lead'; // Most common waiting point
        phaseName = 'Tech Lead';
        console.log(`🔍 [Bypass] Using default phase: ${phase}`);
      }
    }

    console.log(`🔥 [Bypass] Force-approving pending phase: ${phase} (${phaseName})`);

    // Clear the pending approval from DB
    TaskRepository.clearPendingApproval(taskId);

    // Log to approval history
    TaskRepository.addApprovalHistory(taskId, {
      phase: phase,
      phaseName: phaseName,
      approved: true,
      approvedBy: req.user!.id,
      approvedAt: new Date(),
      comments: 'Bypassed by user (forced approval)',
      autoApproved: false,
    });

    // Optionally enable auto-approval for future phases
    if (enableAutoApproval) {
      if (enableForAllPhases) {
        // Enable for all main phases
        TaskRepository.updateAutoApproval(taskId, true, [
          'planning',
          'team-orchestration',
          'verification',
          'auto-merge',
          'tech-lead',
          'development',
          'judge',
          'verification-fixer',
        ] as any[]);
        console.log(`✅ [Bypass] Auto-approval enabled for ALL phases`);
      } else {
        // Enable just for this phase type
        const currentPhases = task.orchestration.autoApprovalPhases || [];
        if (!currentPhases.includes(phase as any)) {
          currentPhases.push(phase as any);
        }
        TaskRepository.updateAutoApproval(taskId, true, currentPhases);
        console.log(`✅ [Bypass] Auto-approval enabled for phase: ${phase}`);
      }
    }

    // 📡 Emit approval event to release the waiting orchestrator
    const { approvalEvents } = await import('../services/ApprovalEvents');

    // 🔥 SHOTGUN APPROACH: If we don't have a persisted pendingApproval,
    // emit approval for ALL common phases to ensure we release any waiting orchestrator
    if (!pendingApproval || !pendingApproval.phase) {
      console.log(`🔫 [Bypass] No persisted approval - emitting for common phases...`);
      const commonPhases = ['planning', 'tech-lead', 'team-orchestration', 'verification'];
      for (const p of commonPhases) {
        console.log(`   📡 Emitting approval for: ${p}`);
        approvalEvents.emitApproval(taskId, p, true, 'Bypassed by user (shotgun)');
      }
    } else {
      // Normal case: emit for the specific phase
      approvalEvents.emitApproval(taskId, phase, true, 'Bypassed by user');
    }

    // Emit WebSocket notification
    const { NotificationService } = await import('../services/NotificationService');
    NotificationService.emitApprovalGranted(taskId, {
      phase,
      approved: true,
    });

    NotificationService.emitAgentMessage(
      taskId,
      'System',
      `🔥 **${phaseName}** was bypassed (force-approved) by user. Continuing orchestration...${enableAutoApproval ? `\n\n✅ Auto-approval ${enableForAllPhases ? 'enabled for all phases' : `enabled for ${phase}`}` : ''}`
    );

    res.json({
      success: true,
      message: `Successfully bypassed ${phaseName}`,
      data: {
        phase: phase,
        phaseName: phaseName,
        autoApprovalEnabled: task.orchestration.autoApprovalEnabled || false,
        autoApprovalPhases: task.orchestration.autoApprovalPhases || [],
      },
    });
  } catch (error) {
    console.error('Error bypassing approval:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to bypass approval',
    });
  }
});

/**
 * GET /api/tasks/:id/approval-history
 * Obtener historial de aprobaciones
 */
router.get('/:id/approval-history', authenticate, async (req: AuthRequest, res) => {
  try {
    const task = TaskRepository.findByIdAndUser(req.params.id, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    res.json({
      success: true,
      data: task.orchestration.approvalHistory || [],
    });
  } catch (error) {
    console.error('Error fetching approval history:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch approval history',
    });
  }
});

/**
 * POST /api/tasks/:id/approve/story/:storyId
 * Aprobar o rechazar una story individual (aprobación parcial)
 */
router.post('/:id/approve/story/:storyId', authenticate, async (req: AuthRequest, res) => {
  try {
    const validatedData = approveStorySchema.parse(req.body);
    const { storyId } = req.params;
    const taskId = req.params.id;

    const task = TaskRepository.findByIdAndUser(taskId, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    // Find story in planning.stories or techLead.stories
    const stories = task.orchestration.planning?.stories || task.orchestration.techLead?.stories || [];
    const story = stories.find((s: any) => s.id === storyId);

    if (!story) {
      res.status(404).json({
        success: false,
        message: `Story ${storyId} not found`,
      });
      return;
    }

    // Update story status based on approval
    if (validatedData.approved) {
      // If approved, mark as ready to continue (if it was blocked)
      if (story.status === 'pending' || story.status === 'failed') {
        story.status = 'pending'; // Ready to be picked up by developer
      }
      story.judgeStatus = 'approved';
      story.judgeComments = validatedData.comments || 'Approved by user';

      console.log(`✅ [Story Approval] Story "${story.title}" (${storyId}) approved by user ${req.user!.id}`);
    } else {
      // If rejected, mark as failed and add comments
      story.status = 'failed';
      story.judgeStatus = 'changes_requested';
      story.judgeComments = validatedData.comments || 'Changes requested by user';

      console.log(`❌ [Story Approval] Story "${story.title}" (${storyId}) rejected by user ${req.user!.id}`);
    }

    // Update orchestration with story changes and approval history
    TaskRepository.modifyOrchestration(taskId, (orch) => {
      // Update stories in planning or techLead
      if (orch.planning?.stories) {
        const idx = orch.planning.stories.findIndex((s: any) => s.id === storyId);
        if (idx >= 0) orch.planning.stories[idx] = story;
      }
      if (orch.techLead?.stories) {
        const idx = orch.techLead.stories.findIndex((s: any) => s.id === storyId);
        if (idx >= 0) orch.techLead.stories[idx] = story;
      }

      // Add to approval history
      if (!orch.approvalHistory) orch.approvalHistory = [];
      orch.approvalHistory.push({
        phase: `story-${storyId}`,
        phaseName: `Story: ${story.title}`,
        approved: validatedData.approved,
        approvedBy: req.user!.id,
        approvedAt: new Date(),
        comments: validatedData.comments,
        autoApproved: false,
      });

      return orch;
    });

    // 📡 Emit approval event for story (event-based)
    const { approvalEvents } = await import('../services/ApprovalEvents');
    approvalEvents.emitApproval(taskId, `story-${storyId}`, validatedData.approved);

    // Emit WebSocket notification
    const { NotificationService } = await import('../services/NotificationService');

    if (validatedData.approved) {
      NotificationService.emitAgentMessage(
        taskId,
        'System',
        `✅ **Story "${story.title}"** approved by user. Story can continue.`
      );
    } else {
      NotificationService.emitAgentMessage(
        taskId,
        'System',
        `❌ **Story "${story.title}"** rejected by user. Story marked as failed.${validatedData.comments ? `\n\n**Comments**: ${validatedData.comments}` : ''}`
      );
    }

    res.json({
      success: true,
      message: validatedData.approved
        ? `Story "${story.title}" approved successfully`
        : `Story "${story.title}" rejected`,
      data: {
        storyId: storyId,
        storyTitle: story.title,
        approved: validatedData.approved,
        status: story.status,
        judgeStatus: story.judgeStatus,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        message: 'Invalid story approval data',
        errors: error.errors,
      });
      return;
    }

    console.error('Error approving story:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to approve story',
    });
  }
});

/**
 * POST /api/tasks/:id/compact
 * Compact conversation history using SDK native /compact command
 *
 * SDK provides native compaction: https://docs.claude.com/en/api/agent-sdk/slash-commands
 */
router.post('/:id/compact', authenticate, async (req: AuthRequest, res) => {
  try {
    const taskId = req.params.id;

    // Validar task ID
    if (!TaskRepository.isValidId(taskId)) {
      res.status(400).json({
        success: false,
        message: 'Invalid task ID',
      });
      return;
    }

    // Obtener task
    const task = TaskRepository.findById(taskId);
    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    console.log(`🗜️  [Compact] Using SDK native /compact for task ${taskId}`);

    // Use SDK native /compact command
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    let compacted = false;
    for await (const message of query({
      prompt: '/compact',
      options: { maxTurns: 1 }
    })) {
      if (message.type === 'system' && (message as any).subtype === 'compact_boundary') {
        compacted = true;
        console.log('✅ [Compact] SDK compaction completed');
      }
    }

    res.json({
      success: true,
      message: 'Conversation history compacted using SDK native /compact',
      data: {
        compacted,
        method: 'SDK native /compact command'
      },
    });
  } catch (error) {
    console.error('Error compacting conversation history:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to compact conversation history',
    });
  }
});

/**
 * POST /api/tasks/:id/pause
 * Pausar una orquestación en ejecución (graceful - espera que termine la fase actual)
 */
router.post('/:id/pause', authenticate, async (req: AuthRequest, res) => {
  try {
    const taskId = req.params.id;
    const task = TaskRepository.findByIdAndUser(taskId, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    if (task.status !== 'in_progress') {
      res.status(400).json({
        success: false,
        message: `Cannot pause task with status: ${task.status}`,
      });
      return;
    }

    if (task.orchestration.paused) {
      res.status(400).json({
        success: false,
        message: 'Task is already paused',
      });
      return;
    }

    // Marcar como pausada
    const pausedAt = new Date();
    TaskRepository.modifyOrchestration(taskId, (orch) => ({
      ...orch,
      paused: true,
      pausedAt,
      pausedBy: req.user!.id,
    }));
    // Update task reference for response
    task.orchestration.pausedAt = pausedAt;

    console.log(`⏸️  [Pause] Task ${req.params.id} paused by user ${req.user!.id}`);

    // Notificar via WebSocket
    const { NotificationService } = await import('../services/NotificationService');
    NotificationService.emitConsoleLog(
      req.params.id,
      'warn',
      '⏸️  Orchestration will pause after current phase completes'
    );

    res.json({
      success: true,
      message: 'Task will pause after current phase completes',
      data: {
        taskId: req.params.id,
        pausedAt: task.orchestration.pausedAt,
        currentPhase: task.orchestration.currentPhase,
      },
    });
  } catch (error) {
    console.error('Error pausing task:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to pause task',
    });
  }
});

/**
 * POST /api/tasks/:id/resume
 * Reanudar una orquestación pausada o fallida
 *
 * Handles multiple resume scenarios:
 * 1. Manual pause: task.orchestration.paused = true
 * 2. Billing error pause: task.status = 'paused' (can be resumed after credits recharged)
 * 3. Failed task: task.status = 'failed' (retry from last phase)
 */
router.post('/:id/resume', authenticate, async (req: AuthRequest, res) => {
  try {
    const taskId = req.params.id;
    const task = TaskRepository.findByIdAndUser(taskId, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    // Check if task is paused (either manually or due to billing error), failed, or interrupted
    const isManuallyPaused = task.orchestration.paused === true;
    const isBillingPaused = task.status === 'paused';
    const isFailed = task.status === 'failed';
    const isInterrupted = task.status === 'interrupted'; // Server restart interrupted the task
    const teamOrch = (task.orchestration as any).teamOrchestration;
    const isBillingError = teamOrch?.pauseReason === 'billing_error';

    if (!isManuallyPaused && !isBillingPaused && !isFailed && !isInterrupted) {
      res.status(400).json({
        success: false,
        message: `Task cannot be resumed (status: ${task.status})`,
      });
      return;
    }

    // Handle failed task resume - use OrchestrationRecoveryService
    if (isFailed) {
      console.log(`\n🔄 [Resume] Resuming FAILED task ${req.params.id}`);
      console.log(`   Current phase: ${task.orchestration.currentPhase}`);

      const { OrchestrationRecoveryService } = await import('../services/orchestration/OrchestrationRecoveryService');
      const recoveryService = new OrchestrationRecoveryService();

      const result = await recoveryService.resumeFailedTask(req.params.id);

      if (!result.success) {
        res.status(400).json({
          success: false,
          message: result.message,
        });
        return;
      }

      res.json({
        success: true,
        message: result.message,
        data: {
          taskId: req.params.id,
          currentPhase: task.orchestration.currentPhase,
          resumeType: 'failed_task_recovery',
        },
      });
      return;
    }

    // Handle interrupted task resume (server restart) - use same recovery service
    if (isInterrupted) {
      console.log(`\n🔄 [Resume] Resuming INTERRUPTED task ${req.params.id}`);
      console.log(`   Current phase: ${task.orchestration.currentPhase}`);
      console.log(`   Interrupted at: ${(task.orchestration as any).interruptedAt}`);

      const { OrchestrationRecoveryService } = await import('../services/orchestration/OrchestrationRecoveryService');
      const recoveryService = new OrchestrationRecoveryService();

      const result = await recoveryService.resumeFailedTask(req.params.id);

      if (!result.success) {
        res.status(400).json({
          success: false,
          message: result.message,
        });
        return;
      }

      res.json({
        success: true,
        message: result.message,
        data: {
          taskId: req.params.id,
          currentPhase: task.orchestration.currentPhase,
          resumeType: 'interrupted_task_recovery',
        },
      });
      return;
    }

    // Log resume type (for paused tasks)
    if (isBillingPaused && isBillingError) {
      console.log(`\n💰 [Resume] BILLING RECOVERY for task ${req.params.id}`);
      console.log(`   Completed teams: ${teamOrch?.completedTeams || 0}`);
      console.log(`   Pending epics: ${teamOrch?.pendingEpicIds?.join(', ') || 'none'}`);
      console.log(`   User recharged credits and is resuming...`);
    } else {
      console.log(`▶️  [Resume] Task ${req.params.id} resumed by user ${req.user!.id}`);
    }

    // Clear pause flags and update status if needed
    if (isBillingPaused) {
      TaskRepository.update(taskId, { status: 'in_progress' });
    }

    TaskRepository.modifyOrchestration(taskId, (orch) => {
      orch.paused = false;
      orch.pausedAt = undefined;
      orch.pausedBy = undefined;

      // Clear billing pause metadata but keep pending epics for retry
      if (isBillingPaused && (orch as any).teamOrchestration) {
        (orch as any).teamOrchestration.status = 'in_progress';
        (orch as any).teamOrchestration.pauseReason = undefined;
        (orch as any).teamOrchestration.pausedAt = undefined;
      }

      return orch;
    });

    // Notificar via WebSocket
    const { NotificationService } = await import('../services/NotificationService');

    if (isBillingError) {
      NotificationService.emitConsoleLog(
        req.params.id,
        'info',
        '💰 Credits recharged! Resuming orchestration with pending epics...'
      );
      NotificationService.emitNotification(req.params.id, 'billing_recovery', {
        message: 'Orchestration resumed after billing recovery',
        pendingEpics: teamOrch?.pendingEpicIds?.length || 0,
      });
    } else {
      NotificationService.emitConsoleLog(
        req.params.id,
        'info',
        '▶️  Orchestration resuming...'
      );
    }

    // v1 OrchestrationCoordinator - battle-tested with full intelligent prompts
    orchestrationCoordinator.orchestrateTask(req.params.id).catch((error) => {
      console.error(`❌ Error resuming task ${req.params.id}:`, error);
    });

    res.json({
      success: true,
      message: isBillingError
        ? 'Task resumed after billing recovery - pending epics will be retried'
        : 'Task resumed successfully',
      data: {
        taskId: req.params.id,
        currentPhase: task.orchestration.currentPhase,
        billingRecovery: isBillingError,
        pendingEpics: teamOrch?.pendingEpicIds || [],
      },
    });
  } catch (error) {
    console.error('Error resuming task:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to resume task',
    });
  }
});

/**
 * POST /api/tasks/:id/cancel
 * Cancelar una orquestación inmediatamente (force stop)
 */
router.post('/:id/cancel', authenticate, async (req: AuthRequest, res) => {
  try {
    const taskId = req.params.id;
    const task = TaskRepository.findByIdAndUser(taskId, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    if (task.status !== 'in_progress' && !task.orchestration.paused) {
      res.status(400).json({
        success: false,
        message: `Cannot cancel task with status: ${task.status}`,
      });
      return;
    }

    // Marcar como cancelada
    const cancelRequestedAt = new Date();
    TaskRepository.update(taskId, { status: 'cancelled' });
    TaskRepository.modifyOrchestration(taskId, (orch) => ({
      ...orch,
      cancelRequested: true,
      cancelRequestedAt,
      cancelRequestedBy: req.user!.id,
      currentPhase: 'completed',
    }));
    // Update task reference for response
    task.orchestration.cancelRequestedAt = cancelRequestedAt;

    console.log(`🛑 [Cancel] Task ${req.params.id} cancelled by user ${req.user!.id}`);

    // Notificar via WebSocket
    const { NotificationService } = await import('../services/NotificationService');
    NotificationService.emitTaskFailed(req.params.id, {
      error: 'Task cancelled by user',
    });

    res.json({
      success: true,
      message: 'Task cancelled successfully',
      data: {
        taskId: req.params.id,
        cancelledAt: task.orchestration.cancelRequestedAt,
      },
    });
  } catch (error) {
    console.error('Error cancelling task:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel task',
    });
  }
});

/**
 * POST /api/tasks/:id/inject-directive
 * Inject a directive into a running orchestration
 *
 * Allows users to send real-time instructions to agents while the task is in progress.
 * Directives are picked up between phases and injected into the next agent's context.
 *
 * Body:
 * - content (required): The directive text
 * - priority: 'critical' | 'high' | 'normal' | 'suggestion' (default: 'normal')
 * - targetPhase: Optional phase name to target (e.g., 'TeamOrchestration')
 * - targetAgent: Optional agent type to target (e.g., 'developer')
 */
router.post('/:id/inject-directive', authenticate, async (req: AuthRequest, res) => {
  try {
    const taskId = req.params.id;
    const task = TaskRepository.findByIdAndUser(taskId, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    // Task must be in_progress or paused to inject directives
    if (task.status !== 'in_progress' && !task.orchestration.paused) {
      res.status(400).json({
        success: false,
        message: `Cannot inject directive into task with status: ${task.status}. Task must be in_progress or paused.`,
      });
      return;
    }

    // Validate request body
    const { content, priority = 'normal', targetPhase, targetAgent } = req.body;

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      res.status(400).json({
        success: false,
        message: 'Directive content is required and must be a non-empty string',
      });
      return;
    }

    // Validate priority
    const validPriorities = ['critical', 'high', 'normal', 'suggestion'];
    if (!validPriorities.includes(priority)) {
      res.status(400).json({
        success: false,
        message: `Invalid priority. Must be one of: ${validPriorities.join(', ')}`,
      });
      return;
    }

    // Create the directive
    const directiveId = `dir-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const directive = {
      id: directiveId,
      content: content.trim(),
      priority,
      targetPhase: targetPhase || undefined,
      targetAgent: targetAgent || undefined,
      consumed: false,
      createdAt: new Date(),
      createdBy: req.user!.id,
    };

    // Add directive to the pending queue
    TaskRepository.modifyOrchestration(taskId, (orch) => {
      if (!orch.pendingDirectives) orch.pendingDirectives = [];
      orch.pendingDirectives.push(directive as any);
      return orch;
    });
    // Update task reference for response
    if (!task.orchestration.pendingDirectives) task.orchestration.pendingDirectives = [];
    task.orchestration.pendingDirectives.push(directive as any);

    console.log(`💡 [Directive] Injected directive "${directiveId}" into task ${req.params.id}`);
    console.log(`   Priority: ${priority}`);
    console.log(`   Target Phase: ${targetPhase || 'any'}`);
    console.log(`   Target Agent: ${targetAgent || 'any'}`);
    console.log(`   Content: ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`);

    // Notify via WebSocket
    const { NotificationService } = await import('../services/NotificationService');
    NotificationService.emitConsoleLog(
      req.params.id,
      'info',
      `💡 Directive received (${priority}): "${content.substring(0, 50)}${content.length > 50 ? '...' : ''}"`
    );
    NotificationService.emitDirectiveInjected(req.params.id, {
      directiveId,
      priority,
      targetPhase: targetPhase || null,
      targetAgent: targetAgent || null,
      contentPreview: content.substring(0, 100),
    });

    res.json({
      success: true,
      message: 'Directive injected successfully. It will be picked up by the next matching phase/agent.',
      data: {
        directiveId,
        taskId: req.params.id,
        priority,
        targetPhase: targetPhase || null,
        targetAgent: targetAgent || null,
        currentPhase: task.orchestration.currentPhase,
        pendingDirectivesCount: task.orchestration.pendingDirectives.length,
      },
    });
  } catch (error) {
    console.error('Error injecting directive:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to inject directive',
    });
  }
});

/**
 * GET /api/tasks/:id/directives
 * Get all pending and historical directives for a task
 */
router.get('/:id/directives', authenticate, async (req: AuthRequest, res) => {
  try {
    const task = TaskRepository.findByIdAndUser(req.params.id, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    res.json({
      success: true,
      data: {
        pending: task.orchestration.pendingDirectives || [],
        history: task.orchestration.directiveHistory || [],
        currentPhase: task.orchestration.currentPhase,
      },
    });
  } catch (error) {
    console.error('Error fetching directives:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch directives',
    });
  }
});

/**
 * DELETE /api/tasks/:id/directives/:directiveId
 * Remove a pending directive before it's consumed
 */
router.delete('/:id/directives/:directiveId', authenticate, async (req: AuthRequest, res) => {
  try {
    const taskId = req.params.id;
    const task = TaskRepository.findByIdAndUser(taskId, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    const directiveId = req.params.directiveId;
    const pendingDirectives = task.orchestration.pendingDirectives || [];

    const directiveIndex = pendingDirectives.findIndex(d => d.id === directiveId);

    if (directiveIndex === -1) {
      res.status(404).json({
        success: false,
        message: 'Directive not found or already consumed',
      });
      return;
    }

    // Remove the directive
    TaskRepository.modifyOrchestration(taskId, (orch) => {
      const directives = orch.pendingDirectives || [];
      const idx = directives.findIndex(d => d.id === directiveId);
      if (idx >= 0) directives.splice(idx, 1);
      orch.pendingDirectives = directives;
      return orch;
    });
    // Update local reference
    pendingDirectives.splice(directiveIndex, 1);

    console.log(`🗑️  [Directive] Removed directive "${directiveId}" from task ${req.params.id}`);

    // Notify via WebSocket
    const { NotificationService } = await import('../services/NotificationService');
    NotificationService.emitConsoleLog(
      req.params.id,
      'info',
      `🗑️  Directive "${directiveId}" removed`
    );

    res.json({
      success: true,
      message: 'Directive removed successfully',
      data: {
        directiveId,
        remainingPendingCount: pendingDirectives.length,
      },
    });
  } catch (error) {
    console.error('Error removing directive:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove directive',
    });
  }
});

/**
 * GET /api/tasks/:id/model-config
 * Get model configuration for a task
 */
router.get('/:id/model-config', authenticate, async (req: AuthRequest, res) => {
  try {
    const task = TaskRepository.findByIdAndUser(req.params.id, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    // Import model configurations
    const { MAX_CONFIG, PREMIUM_CONFIG, RECOMMENDED_CONFIG, STANDARD_CONFIG } = await import('../config/ModelConfigurations');

    // Get current configuration
    const modelConfig = task.orchestration.modelConfig || {
      preset: 'recommended', // Default to recommended for optimal quality/cost
      customConfig: undefined,
    };

    // Get preset configurations for reference
    const presets = {
      max: MAX_CONFIG,
      premium: PREMIUM_CONFIG,
      recommended: RECOMMENDED_CONFIG, // 🌟 Best balance of quality and cost
      standard: STANDARD_CONFIG,
    };

    res.json({
      success: true,
      data: {
        current: modelConfig,
        presets,
      },
    });
  } catch (error: any) {
    console.error('Error getting model config:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get model configuration',
    });
  }
});

/**
 * PUT /api/tasks/:id/model-config
 * Update model configuration for a task
 */
router.put('/:id/model-config', authenticate, async (req: AuthRequest, res) => {
  try {
    const validatedData = modelConfigSchema.parse(req.body);
    const taskId = req.params.id;

    const task = TaskRepository.findByIdAndUser(taskId, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    // Build new model config
    const newModelConfig: any = task.orchestration.modelConfig || { preset: 'standard' };

    if (validatedData.preset) {
      newModelConfig.preset = validatedData.preset;
      if (validatedData.preset !== 'custom') {
        newModelConfig.customConfig = undefined;
      }
    }

    if (validatedData.preset === 'custom' && validatedData.customConfig) {
      newModelConfig.customConfig = validatedData.customConfig;
    }

    // Update orchestration
    TaskRepository.modifyOrchestration(taskId, (orch) => ({
      ...orch,
      modelConfig: newModelConfig,
    }));

    console.log(
      `✅ [Model Config] Updated for task ${taskId}:`,
      `Preset: ${newModelConfig.preset}`,
      validatedData.customConfig ? 'with custom config' : ''
    );

    res.json({
      success: true,
      message: 'Model configuration updated successfully',
      data: {
        modelConfig: newModelConfig,
      },
    });
  } catch (error: any) {
    console.error('Error updating model config:', error);

    if (error.name === 'ZodError') {
      res.status(400).json({
        success: false,
        message: 'Invalid model configuration',
        errors: error.errors,
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: 'Failed to update model configuration',
    });
  }
});

// Schema for human intervention response
const humanInterventionSchema = z.object({
  resolution: z.enum(['fixed_manually', 'skip_story', 'abort_task', 'retry_with_guidance']),
  guidance: z.string().optional(), // Required if resolution is 'retry_with_guidance'
});

/**
 * GET /api/tasks/:id/intervention
 * Get current human intervention status for a task
 */
router.get('/:id/intervention', authenticate, async (req: AuthRequest, res) => {
  try {
    const taskId = req.params.id;

    if (!TaskRepository.isValidId(taskId)) {
      res.status(400).json({ success: false, message: 'Invalid task ID' });
      return;
    }

    const task = TaskRepository.findById(taskId);
    if (!task) {
      res.status(404).json({ success: false, message: 'Task not found' });
      return;
    }

    const intervention = task.orchestration.humanIntervention;

    res.json({
      success: true,
      data: {
        interventionRequired: intervention?.required || false,
        intervention: intervention || null,
      },
    });
  } catch (error) {
    console.error('Error getting intervention status:', error);
    res.status(500).json({ success: false, message: 'Failed to get intervention status' });
  }
});

/**
 * POST /api/tasks/:id/intervention/resolve
 * Resolve a human intervention request
 *
 * Resolutions:
 * - fixed_manually: User fixed the code manually, continue from where we left off
 * - skip_story: Skip this story and continue with the rest
 * - abort_task: Cancel the entire task
 * - retry_with_guidance: Retry with additional guidance from the user
 */
router.post('/:id/intervention/resolve', authenticate, async (req: AuthRequest, res) => {
  try {
    const taskId = req.params.id;
    const validatedData = humanInterventionSchema.parse(req.body);

    if (!TaskRepository.isValidId(taskId)) {
      res.status(400).json({ success: false, message: 'Invalid task ID' });
      return;
    }

    const task = TaskRepository.findById(taskId);
    if (!task) {
      res.status(404).json({ success: false, message: 'Task not found' });
      return;
    }

    const intervention = task.orchestration.humanIntervention;
    if (!intervention?.required) {
      res.status(400).json({
        success: false,
        message: 'No human intervention is currently required for this task',
      });
      return;
    }

    // Validate that guidance is provided for retry_with_guidance
    if (validatedData.resolution === 'retry_with_guidance' && !validatedData.guidance) {
      res.status(400).json({
        success: false,
        message: 'Guidance is required when resolution is "retry_with_guidance"',
      });
      return;
    }

    console.log(`\n${'✅'.repeat(20)}`);
    console.log(`✅ [Human Intervention] Resolution received for task ${taskId}`);
    console.log(`✅ Resolution: ${validatedData.resolution}`);
    if (validatedData.guidance) {
      console.log(`✅ Guidance: ${validatedData.guidance.substring(0, 100)}...`);
    }
    console.log(`${'✅'.repeat(20)}\n`);

    // Update task status if aborting
    if (validatedData.resolution === 'abort_task') {
      TaskRepository.update(taskId, { status: 'cancelled' });
    }

    // Update orchestration with intervention resolution
    TaskRepository.modifyOrchestration(taskId, (orch) => {
      // Update intervention status
      orch.humanIntervention = {
        ...intervention,
        resolved: true,
        resolvedAt: new Date(),
        resolution: validatedData.resolution,
        humanGuidance: validatedData.guidance,
        resolvedBy: req.user?.id,
      };

      // Handle different resolutions
      switch (validatedData.resolution) {
        case 'abort_task':
          orch.cancelRequested = true;
          orch.cancelRequestedAt = new Date();
          orch.paused = false;
          break;

        case 'skip_story':
          orch.paused = false;
          orch.humanIntervention!.required = false;
          console.log(`⏭️  [Human Intervention] Story ${intervention.storyId} will be skipped`);
          break;

        case 'fixed_manually':
        case 'retry_with_guidance':
          orch.paused = false;
          orch.humanIntervention!.required = false;
          break;
      }

      return orch;
    });

    // Get updated task for response
    const updatedTask = TaskRepository.findById(taskId)!;

    // Emit notification
    const { NotificationService } = await import('../services/NotificationService');
    NotificationService.emitConsoleLog(
      taskId,
      'info',
      `✅ Human intervention resolved: ${validatedData.resolution}`
    );

    // If retry_with_guidance or fixed_manually, trigger orchestration to continue
    if (validatedData.resolution === 'retry_with_guidance' || validatedData.resolution === 'fixed_manually') {
      // Trigger continuation in background
      orchestrationCoordinator.orchestrateTask(taskId).catch((error) => {
        console.error(`❌ [Human Intervention] Failed to resume orchestration:`, error);
      });
      console.log(`🔄 [Human Intervention] Resuming orchestration for task ${taskId}`);
    }

    res.json({
      success: true,
      message: `Human intervention resolved with: ${validatedData.resolution}`,
      data: {
        resolution: validatedData.resolution,
        taskStatus: updatedTask.status,
        paused: updatedTask.orchestration.paused,
      },
    });
  } catch (error: any) {
    console.error('Error resolving intervention:', error);

    if (error.name === 'ZodError') {
      res.status(400).json({
        success: false,
        message: 'Invalid intervention resolution data',
        errors: error.errors,
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: 'Failed to resolve human intervention',
    });
  }
});

// =============================================================================
// 🎮 MID-EXECUTION INTERVENTION ENDPOINTS
// Claude Code / OpenCode level feature
// =============================================================================

/**
 * POST /api/tasks/:id/intervention/pause
 * Pause execution immediately (mid-turn, not just between phases)
 */
router.post('/:id/intervention/pause', authenticate, async (req: AuthRequest, res) => {
  try {
    const { ExecutionControlService } = await import('../services/ExecutionControlService');
    const { reason = 'User requested pause' } = req.body;

    const success = ExecutionControlService.requestPause(req.params.id, reason, 'user');

    if (!success) {
      res.status(400).json({
        success: false,
        message: 'No active execution to pause for this task',
      });
      return;
    }

    res.json({
      success: true,
      message: 'Execution paused mid-turn',
      data: {
        taskId: req.params.id,
        reason,
        state: ExecutionControlService.getState(req.params.id),
      },
    });
  } catch (error: any) {
    console.error('Error pausing execution:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to pause execution',
    });
  }
});

/**
 * POST /api/tasks/:id/intervention/resume
 * Resume paused mid-turn execution
 */
router.post('/:id/intervention/resume', authenticate, async (req: AuthRequest, res) => {
  try {
    const { ExecutionControlService } = await import('../services/ExecutionControlService');

    const success = ExecutionControlService.resume(req.params.id);

    if (!success) {
      res.status(400).json({
        success: false,
        message: 'No paused execution to resume for this task',
      });
      return;
    }

    res.json({
      success: true,
      message: 'Execution resumed',
      data: {
        taskId: req.params.id,
        state: ExecutionControlService.getState(req.params.id),
      },
    });
  } catch (error: any) {
    console.error('Error resuming execution:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to resume execution',
    });
  }
});

/**
 * POST /api/tasks/:id/intervention/abort
 * Abort execution immediately
 */
router.post('/:id/intervention/abort', authenticate, async (req: AuthRequest, res) => {
  try {
    const { ExecutionControlService } = await import('../services/ExecutionControlService');
    const { reason = 'User requested abort' } = req.body;

    const success = ExecutionControlService.requestAbort(req.params.id, reason, 'user');

    if (!success) {
      res.status(400).json({
        success: false,
        message: 'No active execution to abort for this task',
      });
      return;
    }

    res.json({
      success: true,
      message: 'Execution aborted',
      data: {
        taskId: req.params.id,
        reason,
      },
    });
  } catch (error: any) {
    console.error('Error aborting execution:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to abort execution',
    });
  }
});

/**
 * POST /api/tasks/:id/intervention/directive
 * Inject a directive mid-execution (will be applied at next opportunity)
 */
router.post('/:id/intervention/directive', authenticate, async (req: AuthRequest, res) => {
  try {
    const { ExecutionControlService } = await import('../services/ExecutionControlService');
    const { directive, urgency = 'after_tool' } = req.body;

    if (!directive) {
      res.status(400).json({
        success: false,
        message: 'Directive content is required',
      });
      return;
    }

    const success = ExecutionControlService.injectDirective(
      req.params.id,
      directive,
      urgency,
      'user'
    );

    if (!success) {
      res.status(400).json({
        success: false,
        message: 'No active execution to inject directive into',
      });
      return;
    }

    res.json({
      success: true,
      message: 'Directive injected mid-execution',
      data: {
        taskId: req.params.id,
        directive: directive.substring(0, 100) + (directive.length > 100 ? '...' : ''),
        urgency,
      },
    });
  } catch (error: any) {
    console.error('Error injecting directive:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to inject directive',
    });
  }
});

/**
 * POST /api/tasks/:id/intervention/warning
 * Send a warning to the agent (non-blocking)
 */
router.post('/:id/intervention/warning', authenticate, async (req: AuthRequest, res) => {
  try {
    const { ExecutionControlService } = await import('../services/ExecutionControlService');
    const { warning } = req.body;

    if (!warning) {
      res.status(400).json({
        success: false,
        message: 'Warning message is required',
      });
      return;
    }

    const success = ExecutionControlService.sendWarning(req.params.id, warning, 'user');

    if (!success) {
      res.status(400).json({
        success: false,
        message: 'No active execution to send warning to',
      });
      return;
    }

    res.json({
      success: true,
      message: 'Warning sent to agent',
      data: {
        taskId: req.params.id,
        warning: warning.substring(0, 100) + (warning.length > 100 ? '...' : ''),
      },
    });
  } catch (error: any) {
    console.error('Error sending warning:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send warning',
    });
  }
});

/**
 * GET /api/tasks/:id/intervention/state
 * Get current execution state for a task
 */
router.get('/:id/intervention/state', authenticate, async (req: AuthRequest, res) => {
  try {
    const { ExecutionControlService } = await import('../services/ExecutionControlService');

    const state = ExecutionControlService.getState(req.params.id);

    res.json({
      success: true,
      data: {
        taskId: req.params.id,
        hasActiveExecution: !!state,
        state: state || null,
      },
    });
  } catch (error: any) {
    console.error('Error getting execution state:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get execution state',
    });
  }
});

/**
 * GET /api/tasks/intervention/active
 * Get all active executions across all tasks
 */
router.get('/intervention/active', authenticate, async (_req: AuthRequest, res) => {
  try {
    const { ExecutionControlService } = await import('../services/ExecutionControlService');

    const activeExecutions = ExecutionControlService.getActiveExecutions();

    res.json({
      success: true,
      data: {
        count: activeExecutions.length,
        executions: activeExecutions,
      },
    });
  } catch (error: any) {
    console.error('Error getting active executions:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get active executions',
    });
  }
});

// =============================================================================
// 🎨 HUMAN-IN-THE-LOOP CODE EDITING
// User can edit agent's code before accepting
// =============================================================================

const userCodeEditSchema = z.object({
  file: z.string().min(1),
  content: z.string(),
  originalAgentContent: z.string(),
  wasEdited: z.boolean(),
  agentName: z.string().optional(),
});

const codeDirectiveSchema = z.object({
  file: z.string().min(1),
  directive: z.string().min(1),
  currentContent: z.string().optional(),
  agentName: z.string().optional(),
});

/**
 * POST /api/tasks/:id/user-code-edit
 * Save user's manual code edit
 *
 * This allows users to modify agent's code before accepting it.
 * The change is saved to the agent's workspace and a note is injected
 * into the agent's context for future reference.
 */
router.post('/:id/user-code-edit', authenticate, async (req: AuthRequest, res) => {
  try {
    const validatedData = userCodeEditSchema.parse(req.body);
    const taskId = req.params.id;

    const task = TaskRepository.findByIdAndUser(taskId, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    console.log(`\n✏️  [User Code Edit] Task ${taskId}`);
    console.log(`   File: ${validatedData.file}`);
    console.log(`   Was edited by user: ${validatedData.wasEdited}`);
    console.log(`   Agent: ${validatedData.agentName || 'unknown'}`);

    // Record the user edit
    const editRecord = {
      id: `edit-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      file: validatedData.file,
      userContent: validatedData.content,
      originalAgentContent: validatedData.originalAgentContent,
      wasEdited: validatedData.wasEdited,
      agentName: validatedData.agentName,
      editedAt: new Date(),
      editedBy: req.user!.id,
    };

    // Build user edit note if edited
    const userEditNote = validatedData.wasEdited ? {
      id: `user-edit-note-${Date.now()}`,
      content: `IMPORTANT: User manually edited "${validatedData.file}". The user's version should be respected. Key differences from agent's version may indicate user preferences.`,
      priority: 'high' as const,
      consumed: false,
      createdAt: new Date(),
      createdBy: req.user!.id,
      metadata: {
        type: 'user_code_edit',
        file: validatedData.file,
      },
    } : null;

    // Update orchestration with edit and optional directive
    TaskRepository.modifyOrchestration(taskId, (orch) => {
      // Add user code edit
      if (!(orch as any).userCodeEdits) (orch as any).userCodeEdits = [];
      (orch as any).userCodeEdits.push(editRecord);

      // Add directive note if user made changes
      if (userEditNote) {
        if (!orch.pendingDirectives) orch.pendingDirectives = [];
        orch.pendingDirectives.push(userEditNote as any);
        console.log(`   📝 Added user edit note to agent context`);
      }

      return orch;
    });

    // Emit notification via WebSocket
    const { NotificationService } = await import('../services/NotificationService');

    if (validatedData.wasEdited) {
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `✏️  User edited "${validatedData.file}" before accepting. Agent will be notified of user preferences.`
      );
      NotificationService.emitAgentMessage(
        taskId,
        'System',
        `User manually edited **${validatedData.file}**. Changes saved.`
      );
    } else {
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `✅ User accepted "${validatedData.file}" as-is`
      );
    }

    res.json({
      success: true,
      message: validatedData.wasEdited
        ? 'Code saved with your edits. Agent will be notified.'
        : 'Code accepted as-is.',
      data: {
        editId: editRecord.id,
        file: validatedData.file,
        wasEdited: validatedData.wasEdited,
      },
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      res.status(400).json({
        success: false,
        message: 'Invalid code edit data',
        errors: error.errors,
      });
      return;
    }

    console.error('Error saving user code edit:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to save code edit',
    });
  }
});

/**
 * POST /api/tasks/:id/code-directive
 * Send a directive for a specific file
 *
 * User can ask the agent to make specific changes to a file
 * without accepting or rejecting the current version.
 */
router.post('/:id/code-directive', authenticate, async (req: AuthRequest, res) => {
  try {
    const validatedData = codeDirectiveSchema.parse(req.body);
    const taskId = req.params.id;

    const task = TaskRepository.findByIdAndUser(taskId, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    console.log(`\n💡 [Code Directive] Task ${taskId}`);
    console.log(`   File: ${validatedData.file}`);
    console.log(`   Directive: ${validatedData.directive.substring(0, 100)}...`);
    console.log(`   Agent: ${validatedData.agentName || 'any'}`);

    // Create a file-specific directive
    const directiveId = `code-dir-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const directive = {
      id: directiveId,
      content: `FILE-SPECIFIC DIRECTIVE for "${validatedData.file}": ${validatedData.directive}`,
      priority: 'high' as const,
      targetAgent: validatedData.agentName || undefined,
      consumed: false,
      createdAt: new Date(),
      createdBy: req.user!.id,
      metadata: {
        type: 'code_directive',
        file: validatedData.file,
        originalDirective: validatedData.directive,
      },
    };

    // Add directive to pending queue
    TaskRepository.modifyOrchestration(taskId, (orch) => {
      if (!orch.pendingDirectives) orch.pendingDirectives = [];
      orch.pendingDirectives.push(directive as any);
      return orch;
    });

    // Emit notification via WebSocket
    const { NotificationService } = await import('../services/NotificationService');
    NotificationService.emitConsoleLog(
      taskId,
      'info',
      `💡 User directive for "${validatedData.file}": "${validatedData.directive.substring(0, 50)}..."`
    );
    NotificationService.emitAgentMessage(
      taskId,
      'System',
      `User requested changes to **${validatedData.file}**: ${validatedData.directive}`
    );
    NotificationService.emitDirectiveInjected(taskId, {
      directiveId,
      priority: 'high',
      targetPhase: null,
      targetAgent: validatedData.agentName || null,
      contentPreview: `File: ${validatedData.file} - ${validatedData.directive.substring(0, 50)}`,
    });

    res.json({
      success: true,
      message: 'Directive sent. The agent will make the requested changes.',
      data: {
        directiveId,
        file: validatedData.file,
        directive: validatedData.directive,
      },
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      res.status(400).json({
        success: false,
        message: 'Invalid directive data',
        errors: error.errors,
      });
      return;
    }

    console.error('Error sending code directive:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send directive',
    });
  }
});

// =============================================================================
// 🔄 RECOVERY & SYNC ENDPOINTS
// Sync local workspace data to MongoDB for disaster recovery
// =============================================================================

/**
 * POST /api/tasks/sync-local-to-mongodb
 *
 * 🔥 RECOVERY ENDPOINT: Sync ALL local execution maps to MongoDB
 * Use this when MongoDB has been reset/cleared but local files still have data
 *
 * This is critical for disaster recovery - local files serve as backup
 * and can be restored to MongoDB using this endpoint.
 */
router.post('/sync-local-to-mongodb', authenticate, async (req: AuthRequest, res) => {
  try {
    console.log(`🔄 [API] User ${req.user?.id} triggered local-to-MongoDB sync`);

    const result = await unifiedMemoryService.syncAllLocalToMongoDB();

    res.json({
      success: true,
      message: `Synced ${result.synced} execution maps to MongoDB (${result.errors} errors)`,
      data: result,
    });
  } catch (error: any) {
    console.error('Error syncing local to MongoDB:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to sync local data to MongoDB',
      error: error.message,
    });
  }
});

/**
 * POST /api/tasks/:id/sync-to-mongodb
 *
 * Sync a SPECIFIC task's local execution map to MongoDB
 * Use this when a single task's MongoDB data is missing
 */
router.post('/:id/sync-to-mongodb', authenticate, async (req: AuthRequest, res) => {
  try {
    const taskId = req.params.id;
    console.log(`🔄 [API] User ${req.user?.id} triggered sync for task ${taskId}`);

    // Try to get from local (this will auto-sync to MongoDB if found)
    const map = await unifiedMemoryService.getExecutionMap(taskId);

    if (!map) {
      res.status(404).json({
        success: false,
        message: `No execution map found for task ${taskId} (checked both MongoDB and local files)`,
      });
      return;
    }

    // Convert Maps to arrays for response
    const phasesArray = map.phases ? Array.from(map.phases.keys()) : [];
    const planningPhase = map.phases?.get('Planning');
    const epicsInPhases = (planningPhase?.output as any)?.epics?.length || 0;
    const epicsInTracking = map.epics ? map.epics.size : 0;

    res.json({
      success: true,
      message: `Execution map for task ${taskId} is now synced`,
      data: {
        taskId: map.taskId,
        status: map.status,
        currentPhase: map.currentPhase,
        phases: phasesArray,
        epicsInPhases,
        epicsInTracking,
      },
    });
  } catch (error: any) {
    console.error('Error syncing task to MongoDB:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to sync task to MongoDB',
      error: error.message,
    });
  }
});

/**
 * 🔥 GRANULAR MEMORY SYNC ENDPOINTS
 *
 * These endpoints allow syncing granular memories between local and MongoDB
 */

// 🔥 REMOVED: Granular memory endpoints - SQLite (UnifiedMemoryService) is the single source of truth
// The following endpoints have been deprecated:
// - POST /granular/sync-all
// - POST /:id/granular/sync
// - GET /:id/granular/local
// - POST /:id/git/commit
// - POST /:id/git/push
// All state is now stored in SQLite via task.orchestration field

export default router;
