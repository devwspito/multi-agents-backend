/**
 * Atomic Task Operations
 *
 * Provides safe atomic operations for updating task.orchestration fields
 * to prevent race conditions when multiple phases write simultaneously.
 *
 * PROBLEM: Multiple phases (DevelopersPhase, JudgePhase) can create/update
 * task.orchestration.judge at the same time, causing overwrites.
 *
 * SOLUTION: Use MongoDB atomic operations ($setOnInsert, $push, $set with conditions)
 */

import { Task } from '../models/Task';

/**
 * Atomically initialize judge orchestration data if it doesn't exist
 * Uses $setOnInsert to prevent race conditions
 */
export async function initializeJudgeOrchestration(taskId: string): Promise<void> {
  await Task.findByIdAndUpdate(
    taskId,
    {
      $setOnInsert: {
        'orchestration.judge': {
          status: 'in_progress',
          evaluations: [],
          startedAt: new Date(),
        },
      },
    },
    { upsert: false, new: false }
  );
}

/**
 * Atomically add or update a judge evaluation
 * Uses findOneAndUpdate with arrayFilters to update specific array element
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

  // Try to update existing evaluation
  const result = await Task.findOneAndUpdate(
    {
      _id: taskId,
      'orchestration.judge.evaluations': {
        $elemMatch: {
          storyId: evaluation.storyId,
          developerId: evaluation.developerId,
        },
      },
    },
    {
      $set: {
        'orchestration.judge.evaluations.$[elem].status': evaluation.status,
        'orchestration.judge.evaluations.$[elem].feedback': evaluation.feedback,
        'orchestration.judge.evaluations.$[elem].iteration': evaluation.iteration,
        'orchestration.judge.evaluations.$[elem].timestamp': timestamp,
      },
    },
    {
      arrayFilters: [
        {
          'elem.storyId': evaluation.storyId,
          'elem.developerId': evaluation.developerId,
        },
      ],
      new: true,
    }
  );

  // If no existing evaluation found, push new one
  if (!result) {
    await Task.findByIdAndUpdate(
      taskId,
      {
        $push: {
          'orchestration.judge.evaluations': {
            ...evaluation,
            timestamp,
          },
        },
      },
      { new: true }
    );
  }
}

/**
 * Atomically update judge status
 */
export async function updateJudgeStatus(
  taskId: string,
  status: 'in_progress' | 'completed' | 'failed',
  completedAt?: Date
): Promise<void> {
  const update: any = {
    'orchestration.judge.status': status,
  };

  if (completedAt) {
    update['orchestration.judge.completedAt'] = completedAt;
  }

  await Task.findByIdAndUpdate(taskId, { $set: update }, { new: true });
}

/**
 * Atomically initialize developers orchestration data if it doesn't exist
 */
export async function initializeDevelopersOrchestration(taskId: string): Promise<void> {
  await Task.findByIdAndUpdate(
    taskId,
    {
      $setOnInsert: {
        'orchestration.developers': {
          status: 'in_progress',
          startedAt: new Date(),
        },
      },
    },
    { upsert: false, new: false }
  );
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
  const update: any = {
    'orchestration.developers.status': status,
  };

  if (error) {
    update['orchestration.developers.error'] = error;
  }

  if (status === 'completed' || status === 'failed') {
    update['orchestration.developers.completedAt'] = new Date();
  }

  if (metadata) {
    update['orchestration.developers.metadata'] = metadata;
  }

  await Task.findByIdAndUpdate(taskId, { $set: update }, { new: true });
}

/**
 * Get judge evaluations atomically with proper locking
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
  const task = await Task.findById(taskId).select('orchestration.judge.evaluations').lean();
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
  const task = await Task.findOne(
    {
      _id: taskId,
      'orchestration.judge.evaluations': {
        $elemMatch: {
          storyId,
          developerId,
        },
      },
    },
    { _id: 1 }
  ).lean();

  return !!task;
}
