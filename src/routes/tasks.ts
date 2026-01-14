import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { uploadMultipleImages } from '../middleware/upload';
import { Task } from '../models/Task';
import { Repository } from '../models/Repository';
// v1 OrchestrationCoordinator - battle-tested with full prompts
import { OrchestrationCoordinator } from '../services/orchestration/OrchestrationCoordinator';
import { storageService } from '../services/storage/StorageService';
import { z } from 'zod';
import mongoose from 'mongoose';

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
    // Active phases from PHASE_ORDER: Planning → Approval → TeamOrchestration → Verification → AutoMerge
    z.enum([
      'planning',           // Main phase
      'team-orchestration', // Main phase (contains TechLead → Developers → Judge)
      'verification',       // Main phase
      'auto-merge',         // Main phase
      // Sub-phases (for granular control)
      'tech-lead',
      'development',
      'judge',
      'fixer',
    ])
  ).optional(),
});

const modelConfigSchema = z.object({
  preset: z.enum(['max', 'premium', 'recommended', 'standard', 'custom']).optional(),
  customConfig: z.object({
    problemAnalyst: z.string().optional(),
    productManager: z.string().optional(),
    projectManager: z.string().optional(),
    techLead: z.string().optional(),
    developer: z.string().optional(),
    judge: z.string().optional(),
    qaEngineer: z.string().optional(),
    fixer: z.string().optional(),
    mergeCoordinator: z.string().optional(),
    autoMerge: z.string().optional(),
    e2eTester: z.string().optional(),
    contractFixer: z.string().optional(),
  }).optional(),
});

const approveStorySchema = z.object({
  approved: z.boolean(),
  comments: z.string().optional(),
});

/**
 * GET /api/tasks
 * Obtener todas las tareas del usuario
 */
router.get('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const { status, priority, projectId, repositoryId } = req.query;

    // Check if user exists in the request
    if (!req.user || !req.user.id) {
      console.error('No user found in request after authentication');
      return res.status(401).json({
        success: false,
        message: 'User not authenticated properly'
      });
    }

    const filter: any = { userId: req.user.id };

    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    if (projectId) filter.projectId = projectId;
    // Soporte para filtro por repositorio (singular o dentro del array)
    if (repositoryId) {
      filter.repositoryIds = repositoryId; // Mongoose busca automáticamente en el array
    }

    console.log('Tasks filter:', filter);

    // Execute query with timeout to prevent hanging
    let tasks = [];
    try {
      const query = Task.find(filter)
        .select('_id title description status priority projectId repositoryIds tags createdAt updatedAt')
        .sort({ updatedAt: -1 })
        .limit(50)
        .lean();

      // Use Promise.race to implement timeout (increased to 10s for large datasets)
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Query timeout')), 10000)
      );

      tasks = await Promise.race([query.exec(), timeoutPromise]) as any[];
      console.log(`Tasks query successful: Found ${tasks?.length || 0} tasks`);
    } catch (dbError: any) {
      console.error('Tasks database error:', dbError);
      // Return empty array on error to not block frontend
      tasks = [];
    }

    // Ensure response is always sent
    return res.json({
      success: true,
      data: {
        tasks: tasks || [],
        pagination: {
          total: tasks?.length || 0,
          page: 1,
          limit: 50
        }
      },
      count: tasks?.length || 0,
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
    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    }).lean();

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
    let repositoryIds: any[] = validatedData.repositoryIds || [];

    // Validate that repositories were selected
    if (repositoryIds.length === 0) {
      console.log(`⚠️ Task created without repository selection`);
      // This is valid - some tasks might not need repositories
      // But log it for debugging
    } else {
      console.log(`✅ Task created with ${repositoryIds.length} selected repositories:`, repositoryIds);

      // Verify the selected repositories exist and are active
      const validRepos = await Repository.find({
        _id: { $in: repositoryIds },
        isActive: true,
      }).select('_id name githubRepoName');

      if (validRepos.length !== repositoryIds.length) {
        console.warn(`⚠️ Some selected repositories not found or inactive`);
        console.warn(`   Requested: ${repositoryIds.length}, Found: ${validRepos.length}`);
      }

      // Log which repositories were selected for debugging
      validRepos.forEach(repo => {
        console.log(`   - ${repo.name} (${repo.githubRepoName})`);
      });
    }

    const task = await Task.create({
      ...validatedData,
      repositoryIds, // ← Auto-populated from project if needed
      userId: req.user!.id,
      status: 'pending',
      orchestration: {
        pipeline: [],
        totalCost: 0,
        totalTokens: 0,
        modelConfig: {
          preset: validatedData.modelConfig || 'standard', // Use provided config or default to standard
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

    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    });

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

      const repositories = await Repository.find({
        projectId: task.projectId,
        isActive: true,
      }).select('_id');

      if (repositories.length > 0) {
        // Keep as ObjectIds (NOT strings) for Mongoose compatibility
        task.repositoryIds = repositories.map((repo) => repo._id) as any;
        await task.save();
        console.log(`✅ Auto-populated ${repositories.length} repositories for task ${task._id}`);
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
    // Usar description si existe, si no usar content (compatibilidad)
    task.description = validatedData.description || validatedData.content || '';
    task.status = 'in_progress';

    // 🔥 PROCESS IMAGES - Upload to Firebase Storage (not local disk)
    // req.files is populated by multer middleware with memoryStorage (buffer in memory)
    if ((req as any).files && (req as any).files.length > 0) {
      const uploadedFiles = (req as any).files as Express.Multer.File[];
      console.log(`📎 [START] ${uploadedFiles.length} image(s) to upload to Firebase`);

      if (!task.attachments) {
        task.attachments = [];
      }

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

          // Store Firebase path (e.g., "uploads/userId/timestamp-hash-filename.png")
          task.attachments.push(storageFile.path);
          console.log(`📎 [START] Image uploaded to Firebase: ${storageFile.path}`);
        } catch (uploadError: any) {
          console.error(`❌ [START] Failed to upload ${uploadedFile.originalname}:`, uploadError.message);
          // Continue with other files, don't fail the whole request
        }
      }

      console.log(`📎 [START] Total ${task.attachments.length} attachments for this task`);
    }

    await task.save();

    console.log(`🚀 Starting orchestration for task: ${task._id}`);
    console.log(`📝 Task description: ${task.description}`);
    console.log(`📎 Task attachments: ${task.attachments?.length || 0}`);

    // v1 OrchestrationCoordinator - battle-tested with full intelligent prompts
    orchestrationCoordinator.orchestrateTask((task._id as any).toString()).catch((error) => {
      console.error('❌ Orchestration error:', error);
    });

    res.json({
      success: true,
      message: 'Orchestration started',
      data: {
        taskId: (task._id as any).toString(),
        status: task.status,
        description: task.description,
        info: 'Orchestration: ProblemAnalysis → ProductManagement → ProjectManagement → TechLead → Development → CodeReview → QATesting → AutoMerge',
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

    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    });

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
    task.description = `${previousDescription}\n\n--- CONTINUATION ---\n${validatedData.additionalRequirements}`;

    // Reset orchestration status to restart
    task.status = 'in_progress';

    // Keep orchestration history but mark as continuation
    if (!task.orchestration.continuations) {
      task.orchestration.continuations = [];
    }
    task.orchestration.continuations.push({
      timestamp: new Date(),
      additionalRequirements: validatedData.additionalRequirements,
      previousStatus: task.status,
    });

    // Clear paused state if any (DO NOT touch currentPhase - v2 OrchestrationEngine handles it)
    task.orchestration.paused = false;
    task.orchestration.cancelRequested = false;

    // 🔥 PROCESS IMAGES - Upload to Firebase Storage (not local disk)
    if ((req as any).files && (req as any).files.length > 0) {
      const uploadedFiles = (req as any).files as Express.Multer.File[];
      console.log(`📎 [CONTINUE] ${uploadedFiles.length} image(s) to upload to Firebase`);

      if (!task.attachments) {
        task.attachments = [];
      }

      // Upload each file to Firebase Storage
      for (const uploadedFile of uploadedFiles) {
        console.log(`📎 [CONTINUE] Uploading to Firebase: ${uploadedFile.originalname} (${(uploadedFile.size / 1024).toFixed(1)} KB)`);

        try {
          const storageFile = await storageService.saveUpload(
            req.user!.id,
            uploadedFile.buffer,
            uploadedFile.originalname,
            uploadedFile.mimetype
          );

          task.attachments.push(storageFile.path);
          console.log(`📎 [CONTINUE] Image uploaded to Firebase: ${storageFile.path}`);
        } catch (uploadError: any) {
          console.error(`❌ [CONTINUE] Failed to upload ${uploadedFile.originalname}:`, uploadError.message);
        }
      }

      console.log(`📎 [CONTINUE] Total ${task.attachments.length} attachments for this task`);
    }

    await task.save();

    console.log(`🔄 Continuing orchestration for task: ${task._id}`);
    console.log(`📝 Additional requirements: ${validatedData.additionalRequirements}`);
    console.log(`📦 Preserving ${task.repositoryIds.length} repositories`);
    console.log(`🌿 Preserving existing epic branches`);

    // v1 OrchestrationCoordinator - battle-tested with full intelligent prompts
    orchestrationCoordinator.orchestrateTask((task._id as any).toString()).catch((error) => {
      console.error('❌ Orchestration continuation error:', error);
    });

    res.json({
      success: true,
      message: 'Task continuation started - preserving repositories, branches, and previous work',
      data: {
        taskId: (task._id as any).toString(),
        status: task.status,
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
    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    })
      .select('status orchestration')
      .lean();

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

        // Phase statuses
        productManager: task.orchestration.productManager?.status || 'pending',
        projectManager: task.orchestration.projectManager?.status || 'pending',
        techLead: task.orchestration.techLead?.status || 'pending',
        qaEngineer: task.orchestration.qaEngineer?.status || 'pending',
        mergeCoordinator: task.orchestration.mergeCoordinator?.status || 'pending',

        // Team info
        teamSize: task.orchestration.team?.length || 0,
        storiesCount: task.orchestration.projectManager?.totalStories || 0,

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
    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    }).select('logs');

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
    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    })
      .select('orchestration')
      .lean();

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
    const task = await Task.findOneAndDelete({
      _id: req.params.id,
      userId: req.user!.id,
    });

    if (!task) {
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
 * Phases: product-manager, project-manager, tech-lead, development, team-orchestration, judge, test-creator, qa-engineer, merge-coordinator, auto-merge, contract-testing, contract-fixer
 */
router.post('/:id/approve/:phase', authenticate, async (req: AuthRequest, res) => {
  try {
    const validatedData = approvePhaseSchema.parse(req.body);
    const { phase } = req.params;

    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    });

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    // Mapear phase URL param a field en orchestration
    let agentStep: any = null;
    let phaseName = '';

    switch (phase) {
      case 'planning':
        agentStep = task.orchestration.planning;
        phaseName = 'Planning (Unified)';
        break;
      case 'product-manager':
        agentStep = task.orchestration.productManager;
        phaseName = 'Product Manager';
        break;
      case 'project-manager':
        agentStep = task.orchestration.projectManager;
        phaseName = 'Project Manager';
        break;
      case 'tech-lead':
        agentStep = task.orchestration.techLead;
        phaseName = 'Tech Lead';
        break;
      case 'development':
        // Development phase no tiene un agentStep único, es el team completo
        // Validar que todos los developers hayan completado
        const team = task.orchestration.team || [];
        const allCompleted = team.every(m => m.status === 'completed');

        if (!allCompleted) {
          res.status(400).json({
            success: false,
            message: 'Development phase is not ready for approval - some developers are still working',
          });
          return;
        }

        // Crear aprobación sintética para el team
        if (!task.orchestration.judge) {
          task.orchestration.judge = {
            agent: 'judge',
            status: 'pending',
          } as any;
        }

        const judgeStep = task.orchestration.judge;
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
        // Judge phase validation
        if (!task.orchestration.judge) {
          console.log(`⚠️  [Approval] Judge phase not found for task ${req.params.id}`);
          res.status(400).json({
            success: false,
            message: 'Judge phase not found - it may not have started yet',
          });
          return;
        }

        console.log(`🔍 [Approval] Judge status: ${task.orchestration.judge.status}, evaluations: ${task.orchestration.judge.evaluations?.length || 0}`);

        // Check if Judge has evaluations (completed at least one evaluation)
        const judgeEvaluations = task.orchestration.judge.evaluations || [];
        if (judgeEvaluations.length === 0) {
          res.status(400).json({
            success: false,
            message: 'Judge has not evaluated any stories yet',
          });
          return;
        }

        agentStep = task.orchestration.judge;
        phaseName = 'Judge Evaluation';
        break;
      case 'qa-engineer':
        agentStep = task.orchestration.qaEngineer;
        phaseName = 'QA Engineer';
        break;
      case 'merge-coordinator':
        agentStep = task.orchestration.mergeCoordinator;
        phaseName = 'Merge Coordinator';
        break;
      case 'auto-merge':
        agentStep = (task.orchestration as any).autoMerge;
        phaseName = 'Auto-Merge';
        break;
      case 'verification':
        agentStep = task.orchestration.phases?.find((p: any) => p.name === 'Verification');
        phaseName = 'Verification';
        break;
      case 'test-creator':
        agentStep = (task.orchestration as any).testCreator;
        phaseName = 'Test Creator';
        break;
      case 'contract-testing':
        agentStep = (task.orchestration as any).contractTesting;
        phaseName = 'Contract Testing';
        break;
      case 'contract-fixer':
        agentStep = (task.orchestration as any).contractFixer;
        phaseName = 'Contract Fixer';
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
          message: `Invalid phase: ${phase}. Valid phases: planning, product-manager, project-manager, tech-lead, development, team-orchestration, judge, test-creator, qa-engineer, merge-coordinator, auto-merge, contract-testing, contract-fixer`,
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

      // Si se rechaza, marcar la tarea como fallida
      task.status = 'failed';

      console.log(`❌ [Approval] ${phaseName} rejected by user ${req.user!.id}`);
    }

    // Guardar comentarios si existen
    if (validatedData.comments) {
      if (!agentStep.approval.comments) {
        agentStep.approval.comments = validatedData.comments;
      }
    }

    // 📝 Log to approval history
    if (!task.orchestration.approvalHistory) {
      task.orchestration.approvalHistory = [];
    }
    task.orchestration.approvalHistory.push({
      phase: phase,
      phaseName: phaseName,
      approved: validatedData.approved,
      approvedBy: new mongoose.Types.ObjectId(req.user!.id),
      approvedAt: new Date(),
      comments: validatedData.comments,
      autoApproved: false, // Manual approval
    });

    await task.save();

    // 📡 Emit approval event to notify waiting orchestrator (event-based, no polling)
    const { approvalEvents } = await import('../services/ApprovalEvents');
    const taskId = (task._id as any).toString();
    approvalEvents.emitApproval(taskId, phase, validatedData.approved);

    // Emitir notificación WebSocket
    const { NotificationService } = await import('../services/NotificationService');

    if (validatedData.approved) {
      // Emitir evento de aprobación concedida (limpia el prompt en el frontend)
      NotificationService.emitApprovalGranted(taskId, phase, phaseName);

      NotificationService.emitAgentMessage(
        taskId,
        'System',
        `✅ **${phaseName}** has been approved by user. Continuing orchestration...`
      );
    } else {
      // También emitir approval_granted para limpiar el prompt (aunque fue rechazado)
      NotificationService.emitApprovalGranted(taskId, phase, phaseName);

      NotificationService.emitAgentMessage(
        taskId,
        'System',
        `❌ **${phaseName}** was rejected by user. Task marked as failed.${validatedData.comments ? `\n\n**Comments**: ${validatedData.comments}` : ''}`
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
        taskStatus: task.status,
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

    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    });

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    // Update auto-approval configuration
    task.orchestration.autoApprovalEnabled = validatedData.enabled;

    if (validatedData.phases !== undefined) {
      task.orchestration.autoApprovalPhases = validatedData.phases as any[];
    } else if (validatedData.enabled) {
      // If enabling auto-approval without specifying phases, default to all main phases
      // Active phases from PHASE_ORDER: Planning → Approval → TeamOrchestration → Verification → AutoMerge
      task.orchestration.autoApprovalPhases = [
        'planning',
        'team-orchestration',
        'verification',
        'auto-merge',
      ] as any[];
    }

    await task.save();

    console.log(`🚁 [Auto-Approval] Configuration updated for task ${req.params.id}: enabled=${validatedData.enabled}, phases=${task.orchestration.autoApprovalPhases?.join(', ')}`);

    res.json({
      success: true,
      message: `Auto-approval ${validatedData.enabled ? 'enabled' : 'disabled'}`,
      data: {
        enabled: task.orchestration.autoApprovalEnabled,
        phases: task.orchestration.autoApprovalPhases || [],
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
    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    })
      .select('orchestration.autoApprovalEnabled orchestration.autoApprovalPhases')
      .lean();

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
 * GET /api/tasks/:id/approval-history
 * Obtener historial de aprobaciones
 */
router.get('/:id/approval-history', authenticate, async (req: AuthRequest, res) => {
  try {
    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    })
      .select('orchestration.approvalHistory')
      .populate('orchestration.approvalHistory.approvedBy', 'name email')
      .lean();

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

    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    });

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    // Find story in projectManager.stories
    const stories = task.orchestration.projectManager?.stories || [];
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

    // Mark modified for Mongoose
    task.markModified('orchestration.projectManager.stories');

    // 📝 Log to approval history
    if (!task.orchestration.approvalHistory) {
      task.orchestration.approvalHistory = [];
    }
    task.orchestration.approvalHistory.push({
      phase: `story-${storyId}`,
      phaseName: `Story: ${story.title}`,
      approved: validatedData.approved,
      approvedBy: new mongoose.Types.ObjectId(req.user!.id),
      approvedAt: new Date(),
      comments: validatedData.comments,
      autoApproved: false,
    });

    await task.save();

    // 📡 Emit approval event for story (event-based)
    const { approvalEvents } = await import('../services/ApprovalEvents');
    const taskId = (task._id as any).toString();
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
    if (!mongoose.Types.ObjectId.isValid(taskId)) {
      res.status(400).json({
        success: false,
        message: 'Invalid task ID',
      });
      return;
    }

    // Obtener task
    const task = await Task.findById(taskId);
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
    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    });

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
    task.orchestration.paused = true;
    task.orchestration.pausedAt = new Date();
    task.orchestration.pausedBy = new mongoose.Types.ObjectId(req.user!.id);
    await task.save();

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
    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    }).populate('userId');

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    // Check if task is paused (either manually or due to billing error) or failed
    const isManuallyPaused = task.orchestration.paused === true;
    const isBillingPaused = task.status === 'paused';
    const isFailed = task.status === 'failed';
    const teamOrch = (task.orchestration as any).teamOrchestration;
    const isBillingError = teamOrch?.pauseReason === 'billing_error';

    if (!isManuallyPaused && !isBillingPaused && !isFailed) {
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

    // Log resume type (for paused tasks)
    if (isBillingPaused && isBillingError) {
      console.log(`\n💰 [Resume] BILLING RECOVERY for task ${req.params.id}`);
      console.log(`   Completed teams: ${teamOrch?.completedTeams || 0}`);
      console.log(`   Pending epics: ${teamOrch?.pendingEpicIds?.join(', ') || 'none'}`);
      console.log(`   User recharged credits and is resuming...`);
    } else {
      console.log(`▶️  [Resume] Task ${req.params.id} resumed by user ${req.user!.id}`);
    }

    // Clear pause flags
    task.orchestration.paused = false;
    task.orchestration.pausedAt = undefined;
    task.orchestration.pausedBy = undefined;

    // If it was a billing error pause, reset status to in_progress
    if (isBillingPaused) {
      task.status = 'in_progress';

      // Clear billing pause metadata but keep pending epics for retry
      if (teamOrch) {
        teamOrch.status = 'in_progress'; // Resume from paused_billing
        teamOrch.pauseReason = undefined;
        teamOrch.pausedAt = undefined;
        // Keep pendingEpicIds so orchestration knows what to resume
      }
    }

    await task.save();

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
    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    });

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
    task.orchestration.cancelRequested = true;
    task.orchestration.cancelRequestedAt = new Date();
    task.orchestration.cancelRequestedBy = new mongoose.Types.ObjectId(req.user!.id);
    task.status = 'cancelled';
    task.orchestration.currentPhase = 'completed';
    await task.save();

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
    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    });

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
      createdBy: new mongoose.Types.ObjectId(req.user!.id),
    };

    // Initialize pendingDirectives array if it doesn't exist
    if (!task.orchestration.pendingDirectives) {
      task.orchestration.pendingDirectives = [];
    }

    // Add directive to the pending queue
    task.orchestration.pendingDirectives.push(directive as any);
    task.markModified('orchestration.pendingDirectives');
    await task.save();

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
    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    });

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
    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    });

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
    pendingDirectives.splice(directiveIndex, 1);
    task.orchestration.pendingDirectives = pendingDirectives;
    task.markModified('orchestration.pendingDirectives');
    await task.save();

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
    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    });

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

    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    });

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    // Update model configuration
    if (!task.orchestration.modelConfig) {
      task.orchestration.modelConfig = {
        preset: 'standard',
      };
    }

    if (validatedData.preset) {
      task.orchestration.modelConfig.preset = validatedData.preset;

      // Clear custom config if not using custom preset
      if (validatedData.preset !== 'custom') {
        task.orchestration.modelConfig.customConfig = undefined;
      }
    }

    if (validatedData.preset === 'custom' && validatedData.customConfig) {
      task.orchestration.modelConfig.customConfig = validatedData.customConfig;
    }

    await task.save();

    console.log(
      `✅ [Model Config] Updated for task ${task._id}:`,
      `Preset: ${task.orchestration.modelConfig.preset}`,
      validatedData.customConfig ? 'with custom config' : ''
    );

    res.json({
      success: true,
      message: 'Model configuration updated successfully',
      data: {
        modelConfig: task.orchestration.modelConfig,
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

    if (!mongoose.Types.ObjectId.isValid(taskId)) {
      res.status(400).json({ success: false, message: 'Invalid task ID' });
      return;
    }

    const task = await Task.findById(taskId);
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

    if (!mongoose.Types.ObjectId.isValid(taskId)) {
      res.status(400).json({ success: false, message: 'Invalid task ID' });
      return;
    }

    const task = await Task.findById(taskId);
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

    // Update intervention status
    task.orchestration.humanIntervention = {
      ...intervention,
      resolved: true,
      resolvedAt: new Date(),
      resolution: validatedData.resolution,
      humanGuidance: validatedData.guidance,
      resolvedBy: req.user?.id ? new mongoose.Types.ObjectId(req.user.id) : undefined,
    };

    // Handle different resolutions
    switch (validatedData.resolution) {
      case 'abort_task':
        task.status = 'cancelled';
        task.orchestration.cancelRequested = true;
        task.orchestration.cancelRequestedAt = new Date();
        task.orchestration.paused = false;
        break;

      case 'skip_story':
        // Mark the story as skipped and unpause
        // Note: The story status will be handled when orchestration resumes
        // We just need to mark the intervention as resolved and unpause
        task.orchestration.paused = false;
        task.orchestration.humanIntervention!.required = false;
        console.log(`⏭️  [Human Intervention] Story ${intervention.storyId} will be skipped`);
        break;

      case 'fixed_manually':
      case 'retry_with_guidance':
        // Unpause and let orchestration continue
        task.orchestration.paused = false;
        task.orchestration.humanIntervention!.required = false;
        break;
    }

    await task.save();

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
        taskStatus: task.status,
        paused: task.orchestration.paused,
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

export default router;
