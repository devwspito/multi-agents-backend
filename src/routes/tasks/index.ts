/**
 * Tasks Router - Main entry point
 *
 * Mounts all task-related sub-routers for better modularity.
 *
 * Route structure:
 * - CRUD operations: taskCrud.ts
 * - Execution (start/continue): taskExecution.ts
 * - Status/Logs: taskStatus.ts
 * - Control (pause/resume/cancel): taskControl.ts
 *
 * Note: Remaining routes (approval, directives, intervention, etc.)
 * are still in the original tasks.ts and will be migrated incrementally.
 */

import { Router } from 'express';
import taskCrudRouter from './taskCrud';
import taskStatusRouter from './taskStatus';
import taskExecutionRouter from './taskExecution';
import taskControlRouter from './taskControl';

const router = Router();

// Mount sub-routers
router.use('/', taskCrudRouter);
router.use('/', taskStatusRouter);
router.use('/', taskExecutionRouter);
router.use('/', taskControlRouter);

// Note: The following routes are still in the original tasks.ts file
// and will be migrated incrementally:
// - Approval routes (/:id/approve/*, auto-approval, bypass)
// - Directive routes (/:id/inject-directive, /:id/directives)
// - Model config routes (/:id/model-config)
// - Intervention routes (/:id/intervention/*)
// - Code edit routes (/:id/user-code-edit, /:id/code-directive)
// - Sync routes (sync-local-to-mongodb, granular/*)

export default router;
