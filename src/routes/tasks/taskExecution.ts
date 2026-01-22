/**
 * Task Execution Router
 *
 * Task execution endpoints:
 * - POST /:id/start    - Start orchestration
 * - POST /:id/continue - Continue with additional requirements
 */

import {
  Router,
  z,
  authenticate,
  AuthRequest,
  uploadMultipleImages,
  Task,
  Repository,
  storageService,
  orchestrationCoordinator,
  startTaskSchema,
  continueTaskSchema,
} from './shared';

const router = Router();

/**
 * POST /api/tasks/:id/start
 * Start agent orchestration for a task
 * Receives description from first chat message + optional images
 * Supports both JSON and multipart/form-data (with images)
 */
router.post('/:id/start', authenticate, uploadMultipleImages, async (req: AuthRequest, res) => {
  try {
    console.log('🔍 [START] Received body:', JSON.stringify(req.body, null, 2));
    console.log('🔍 [START] Task ID:', req.params.id);
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

    // Auto-populate repositories if missing
    if (task.projectId && (!task.repositoryIds || task.repositoryIds.length === 0)) {
      console.log(`📦 Task has projectId but no repositories, auto-populating...`);

      const repositories = await Repository.find({
        projectId: task.projectId,
        isActive: true,
      }).select('_id');

      if (repositories.length > 0) {
        task.repositoryIds = repositories.map((repo) => repo._id) as any;
        await task.save();
        console.log(`✅ Auto-populated ${repositories.length} repositories`);
      }
    }

    // Verify repositories exist
    if (!task.repositoryIds || task.repositoryIds.length === 0) {
      res.status(400).json({
        success: false,
        message: 'Cannot start orchestration: No repositories configured for this task',
        error: 'MISSING_REPOSITORIES',
        hint: 'Please configure at least one repository before starting',
      });
      return;
    }

    // Update description and status
    task.description = validatedData.description || validatedData.content || '';
    task.status = 'in_progress';

    // Process images - upload to Firebase Storage
    if ((req as any).files && (req as any).files.length > 0) {
      const uploadedFiles = (req as any).files as Express.Multer.File[];
      console.log(`📎 [START] ${uploadedFiles.length} image(s) to upload`);

      if (!task.attachments) {
        task.attachments = [];
      }

      for (const uploadedFile of uploadedFiles) {
        console.log(`📎 Uploading: ${uploadedFile.originalname}`);

        try {
          const storageFile = await storageService.saveUpload(
            req.user!.id,
            uploadedFile.buffer,
            uploadedFile.originalname,
            uploadedFile.mimetype
          );

          task.attachments.push(storageFile.path);
          console.log(`📎 Uploaded to: ${storageFile.path}`);
        } catch (uploadError: any) {
          console.error(`❌ Upload failed: ${uploadError.message}`);
        }
      }
    }

    await task.save();

    console.log(`🚀 Starting orchestration for task: ${task._id}`);
    console.log(`📝 Description: ${task.description}`);

    // Start orchestration (fire-and-forget)
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
        info: 'Orchestration: Planning → TechLead → Developers → Judge → Verification → AutoMerge',
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('🔍 [START] Validation error:', error.errors);
      res.status(400).json({
        success: false,
        message: 'Invalid start data',
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

    if (task.status === 'in_progress') {
      res.status(400).json({
        success: false,
        message: 'Task is currently in progress. Wait for it to complete.',
      });
      return;
    }

    console.log(`🔄 [Continue] From status: ${task.status}`);

    if (!task.repositoryIds || task.repositoryIds.length === 0) {
      res.status(400).json({
        success: false,
        message: 'Cannot continue: No repositories configured',
      });
      return;
    }

    // Append additional requirements
    const previousDescription = task.description || '';
    task.description = `${previousDescription}\n\n--- CONTINUATION ---\n${validatedData.additionalRequirements}`;

    task.status = 'in_progress';

    // Track continuation history
    if (!task.orchestration.continuations) {
      task.orchestration.continuations = [];
    }
    task.orchestration.continuations.push({
      timestamp: new Date(),
      additionalRequirements: validatedData.additionalRequirements,
      previousStatus: task.status,
    });

    task.orchestration.paused = false;
    task.orchestration.cancelRequested = false;

    // Process images
    if ((req as any).files && (req as any).files.length > 0) {
      const uploadedFiles = (req as any).files as Express.Multer.File[];
      console.log(`📎 [CONTINUE] ${uploadedFiles.length} image(s) to upload`);

      if (!task.attachments) {
        task.attachments = [];
      }

      for (const uploadedFile of uploadedFiles) {
        try {
          const storageFile = await storageService.saveUpload(
            req.user!.id,
            uploadedFile.buffer,
            uploadedFile.originalname,
            uploadedFile.mimetype
          );

          task.attachments.push(storageFile.path);
          console.log(`📎 Uploaded: ${storageFile.path}`);
        } catch (uploadError: any) {
          console.error(`❌ Upload failed: ${uploadError.message}`);
        }
      }
    }

    await task.save();

    console.log(`🔄 Continuing task: ${task._id}`);

    // Start orchestration continuation
    orchestrationCoordinator.orchestrateTask((task._id as any).toString()).catch((error) => {
      console.error('❌ Continuation error:', error);
    });

    res.json({
      success: true,
      message: 'Task continuation started',
      data: {
        taskId: (task._id as any).toString(),
        status: task.status,
        additionalRequirements: validatedData.additionalRequirements,
        preservedContext: {
          repositories: task.repositoryIds.length,
          previousWork: 'Epic branches and commits preserved',
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

export default router;
