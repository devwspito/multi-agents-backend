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
  TaskRepository,
  RepositoryRepository,
  IRepository,
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
    console.log('[START] Received body:', JSON.stringify(req.body, null, 2));
    console.log('[START] Task ID:', req.params.id);
    const validatedData = startTaskSchema.parse(req.body);

    let task = TaskRepository.findByIdAndUser(req.params.id, req.user!.id);

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
      console.log(`Task has projectId but no repositories, auto-populating...`);

      const repositories = RepositoryRepository.findByProjectId(task.projectId).filter(
        (repo: IRepository) => repo.isActive
      );

      if (repositories.length > 0) {
        const repoIds = repositories.map((repo: IRepository) => repo.id);
        TaskRepository.update(task.id, { repositoryIds: repoIds });
        task = TaskRepository.findById(task.id)!;
        console.log(`Auto-populated ${repositories.length} repositories`);
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
    const description = validatedData.description || validatedData.content || '';
    let attachments = task.attachments || [];

    // Process images - upload to Firebase Storage
    if ((req as any).files && (req as any).files.length > 0) {
      const uploadedFiles = (req as any).files as Express.Multer.File[];
      console.log(`[START] ${uploadedFiles.length} image(s) to upload`);

      for (const uploadedFile of uploadedFiles) {
        console.log(`Uploading: ${uploadedFile.originalname}`);

        try {
          const storageFile = await storageService.saveUpload(
            req.user!.id,
            uploadedFile.buffer,
            uploadedFile.originalname,
            uploadedFile.mimetype
          );

          attachments.push(storageFile.path);
          console.log(`Uploaded to: ${storageFile.path}`);
        } catch (uploadError: any) {
          console.error(`Upload failed: ${uploadError.message}`);
        }
      }
    }

    TaskRepository.update(task.id, {
      description,
      status: 'in_progress',
      attachments,
    });

    console.log(`Starting orchestration for task: ${task.id}`);
    console.log(`Description: ${description}`);

    // Start orchestration (fire-and-forget)
    orchestrationCoordinator.orchestrateTask(task.id).catch((error) => {
      console.error('Orchestration error:', error);
    });

    res.json({
      success: true,
      message: 'Orchestration started',
      data: {
        taskId: task.id,
        status: 'in_progress',
        description: description,
        info: 'Orchestration: Planning > TechLead > Developers > Judge > Verification > AutoMerge',
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('[START] Validation error:', error.errors);
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

    let task = TaskRepository.findByIdAndUser(req.params.id, req.user!.id);

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

    console.log(`[Continue] From status: ${task.status}`);

    if (!task.repositoryIds || task.repositoryIds.length === 0) {
      res.status(400).json({
        success: false,
        message: 'Cannot continue: No repositories configured',
      });
      return;
    }

    // Append additional requirements
    const previousDescription = task.description || '';
    const newDescription = `${previousDescription}\n\n--- CONTINUATION ---\n${validatedData.additionalRequirements}`;
    const previousStatus = task.status;

    let attachments = task.attachments || [];

    // Process images
    if ((req as any).files && (req as any).files.length > 0) {
      const uploadedFiles = (req as any).files as Express.Multer.File[];
      console.log(`[CONTINUE] ${uploadedFiles.length} image(s) to upload`);

      for (const uploadedFile of uploadedFiles) {
        try {
          const storageFile = await storageService.saveUpload(
            req.user!.id,
            uploadedFile.buffer,
            uploadedFile.originalname,
            uploadedFile.mimetype
          );

          attachments.push(storageFile.path);
          console.log(`Uploaded: ${storageFile.path}`);
        } catch (uploadError: any) {
          console.error(`Upload failed: ${uploadError.message}`);
        }
      }
    }

    TaskRepository.update(task.id, {
      description: newDescription,
      status: 'in_progress',
      attachments,
    });

    // Track continuation history in orchestration
    TaskRepository.modifyOrchestration(task.id, (orch) => {
      const continuations = orch.continuations || [];
      continuations.push({
        timestamp: new Date(),
        additionalRequirements: validatedData.additionalRequirements,
        previousStatus,
      });
      return {
        ...orch,
        continuations,
        paused: false,
        cancelRequested: false,
      };
    });

    console.log(`Continuing task: ${task.id}`);

    // Start orchestration continuation
    orchestrationCoordinator.orchestrateTask(task.id).catch((error) => {
      console.error('Continuation error:', error);
    });

    res.json({
      success: true,
      message: 'Task continuation started',
      data: {
        taskId: task.id,
        status: 'in_progress',
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
