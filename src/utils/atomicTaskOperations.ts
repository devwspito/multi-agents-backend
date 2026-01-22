/**
 * Atomic Task Operations
 *
 * Provides safe atomic operations for updating task.orchestration fields
 * to prevent race conditions when multiple phases write simultaneously.
 *
 * PROBLEM: Multiple phases (DevelopersPhase, JudgePhase) can create/update
 * task.orchestration.judge at the same time, causing overwrites.
 *
 * SOLUTION: Use TaskRepository.modifyOrchestration which provides atomic
 * read-modify-write operations via SQLite.
 */

import { TaskRepository } from '../database/repositories/TaskRepository.js';

/**
 * Atomically initialize judge orchestration data if it doesn't exist
 */
export async function initializeJudgeOrchestration(taskId: string): Promise<void> {
  TaskRepository.modifyOrchestration(taskId, (orch) => {
    if (!orch.judge) {
      orch.judge = {
        agent: 'judge',
        status: 'in_progress',
        evaluations: [],
        startedAt: new Date(),
      } as any;
    }
    return orch;
  });
}

/**
 * Atomically add or update a judge evaluation
 */
export async function addOrUpdateJudgeEvaluation(
  taskId: string,
  evaluation: {
    storyId: string;
    developerId: string;
    status: 'approved' | 'changes_requested';
    feedback: string;
    iteration: number;
    timestamp?: Date;
  }
): Promise<void> {
  const timestamp = evaluation.timestamp || new Date();

  TaskRepository.modifyOrchestration(taskId, (orch) => {
    if (!orch.judge) {
      orch.judge = {
        agent: 'judge',
        status: 'in_progress',
        evaluations: [],
        startedAt: new Date(),
      } as any;
    }

    const judge = orch.judge!;
    const evaluations = judge.evaluations || [];

    // Try to find existing evaluation
    const existingIdx = evaluations.findIndex(
      (e: any) => e.storyId === evaluation.storyId && e.developerId === evaluation.developerId
    );

    if (existingIdx >= 0) {
      // Update existing
      evaluations[existingIdx] = {
        ...evaluations[existingIdx],
        status: evaluation.status,
        feedback: evaluation.feedback,
        iteration: evaluation.iteration,
        timestamp,
      };
    } else {
      // Add new
      evaluations.push({
        ...evaluation,
        timestamp,
      });
    }

    judge.evaluations = evaluations;
    return orch;
  });
}

/**
 * Atomically update judge status
 */
export async function updateJudgeStatus(
  taskId: string,
  status: 'in_progress' | 'completed' | 'failed',
  completedAt?: Date
): Promise<void> {
  TaskRepository.modifyOrchestration(taskId, (orch) => {
    if (!orch.judge) {
      orch.judge = {
        agent: 'judge',
        status,
        evaluations: [],
      } as any;
    } else {
      orch.judge.status = status;
    }

    const judge = orch.judge!;
    if (completedAt) {
      judge.completedAt = completedAt;
    }

    return orch;
  });
}

/**
 * Atomically initialize developers orchestration data if it doesn't exist
 */
export async function initializeDevelopersOrchestration(taskId: string): Promise<void> {
  TaskRepository.modifyOrchestration(taskId, (orch) => {
    if (!(orch as any).developers) {
      (orch as any).developers = {
        status: 'in_progress',
        startedAt: new Date(),
      };
    }
    return orch;
  });
}

/**
 * Atomically update developers status
 */
export async function updateDevelopersStatus(
  taskId: string,
  status: 'in_progress' | 'completed' | 'failed',
  error?: string,
  metadata?: any
): Promise<void> {
  TaskRepository.modifyOrchestration(taskId, (orch) => {
    if (!(orch as any).developers) {
      (orch as any).developers = { status };
    } else {
      (orch as any).developers.status = status;
    }

    if (error) {
      (orch as any).developers.error = error;
    }

    if (status === 'completed' || status === 'failed') {
      (orch as any).developers.completedAt = new Date();
    }

    if (metadata) {
      (orch as any).developers.metadata = metadata;
    }

    return orch;
  });
}

/**
 * Get judge evaluations
 */
export async function getJudgeEvaluations(
  taskId: string
): Promise<Array<{
  storyId: string;
  developerId: string;
  status: string;
  feedback: string;
  iteration: number;
  timestamp?: Date;
}>> {
  const task = TaskRepository.findById(taskId);
  return task?.orchestration?.judge?.evaluations || [];
}

/**
 * Check if judge evaluation exists for story+developer
 */
export async function hasJudgeEvaluation(
  taskId: string,
  storyId: string,
  developerId: string
): Promise<boolean> {
  const task = TaskRepository.findById(taskId);
  const evaluations = task?.orchestration?.judge?.evaluations || [];
  return evaluations.some(
    (e: any) => e.storyId === storyId && e.developerId === developerId
  );
}
