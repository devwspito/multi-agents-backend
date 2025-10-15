/**
 * CodeSnapshotService - Code Visibility & Tracking
 *
 * Captures and stores code changes made by developers during story implementation
 * Provides visibility into what code is being generated (fixes "voy ciego" problem)
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import mongoose from 'mongoose';
import { CodeSnapshot, IFileChange, ChangeType } from '../../models/CodeSnapshot';
import { LogService } from '../logging/LogService';

const execAsync = promisify(exec);

export interface SnapshotContext {
  taskId: string | mongoose.Types.ObjectId;
  phase: 'development' | 'qa' | 'merge';
  agentType: 'developer' | 'qa-engineer' | 'merge-coordinator';
  agentInstanceId: string;
  epicId?: string;
  epicName?: string;
  storyId?: string;
  storyTitle?: string;
  sessionId?: string;
}

export class CodeSnapshotService {
  /**
   * Capture code changes from a git repository
   */
  static async captureSnapshot(
    repositoryPath: string,
    repositoryName: string,
    branchName: string,
    context: SnapshotContext
  ): Promise<void> {
    try {
      // Get current branch
      const { stdout: currentBranch } = await execAsync('git branch --show-current', {
        cwd: repositoryPath,
      });

      // Get list of changed files
      const { stdout: statusOutput } = await execAsync('git status --porcelain', {
        cwd: repositoryPath,
      });

      if (!statusOutput.trim()) {
        // No changes detected
        await LogService.debug('No code changes detected for snapshot', {
          taskId: context.taskId.toString(),
          category: 'developer',
          phase: context.phase,
          agentInstanceId: context.agentInstanceId,
          metadata: {
            repositoryName,
            branchName: currentBranch.trim(),
          },
        });
        return;
      }

      // Parse file changes
      const fileChanges = await this.parseGitStatus(repositoryPath, statusOutput);

      // Calculate statistics
      const totalFilesChanged = fileChanges.length;
      const totalLinesAdded = fileChanges.reduce((sum, f) => sum + f.linesAdded, 0);
      const totalLinesDeleted = fileChanges.reduce((sum, f) => sum + f.linesDeleted, 0);

      // Get latest commit info (if any commits exist)
      let commitHash: string | undefined;
      let commitMessage: string | undefined;

      try {
        const { stdout: hashOutput } = await execAsync('git rev-parse HEAD', {
          cwd: repositoryPath,
        });
        commitHash = hashOutput.trim();

        const { stdout: messageOutput } = await execAsync('git log -1 --pretty=%B', {
          cwd: repositoryPath,
        });
        commitMessage = messageOutput.trim();
      } catch {
        // No commits yet, that's ok
      }

      // Store snapshot in MongoDB
      await CodeSnapshot.create({
        taskId: context.taskId,
        timestamp: new Date(),
        phase: context.phase,
        agentType: context.agentType,
        agentInstanceId: context.agentInstanceId,
        epicId: context.epicId,
        epicName: context.epicName,
        storyId: context.storyId,
        storyTitle: context.storyTitle,
        repositoryName,
        branchName: currentBranch.trim() || branchName,
        commitHash,
        commitMessage,
        fileChanges,
        totalFilesChanged,
        totalLinesAdded,
        totalLinesDeleted,
        sessionId: context.sessionId,
      });

      await LogService.success('Code snapshot captured', {
        taskId: context.taskId.toString(),
        category: 'developer',
        phase: context.phase,
        agentInstanceId: context.agentInstanceId,
        storyId: context.storyId,
        storyTitle: context.storyTitle,
        metadata: {
          repositoryName,
          branchName: currentBranch.trim(),
          filesChanged: totalFilesChanged,
          linesAdded: totalLinesAdded,
          linesDeleted: totalLinesDeleted,
        },
      });
    } catch (error: any) {
      await LogService.error('Failed to capture code snapshot', {
        taskId: context.taskId.toString(),
        category: 'developer',
        phase: context.phase,
        agentInstanceId: context.agentInstanceId,
        error: {
          message: error.message,
          stack: error.stack,
        },
      });
    }
  }

  /**
   * Parse git status output to extract file changes
   */
  private static async parseGitStatus(
    repositoryPath: string,
    statusOutput: string
  ): Promise<IFileChange[]> {
    const fileChanges: IFileChange[] = [];
    const lines = statusOutput.trim().split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;

      const status = line.substring(0, 2);
      const filePath = line.substring(3).trim();

      // Determine change type
      let changeType: ChangeType;
      if (status.includes('A') || status.includes('?')) {
        changeType = 'created';
      } else if (status.includes('D')) {
        changeType = 'deleted';
      } else if (status.includes('R')) {
        changeType = 'renamed';
      } else {
        changeType = 'modified';
      }

      // Get diff stats for this file
      let linesAdded = 0;
      let linesDeleted = 0;
      let diff: string | undefined;

      if (changeType !== 'deleted') {
        try {
          // Get diff with stats
          const { stdout: diffOutput } = await execAsync(
            `git diff HEAD -- "${filePath}" 2>/dev/null || git diff -- "${filePath}"`,
            { cwd: repositoryPath }
          );

          if (diffOutput) {
            diff = diffOutput;

            // Count added/deleted lines
            const diffLines = diffOutput.split('\n');
            for (const diffLine of diffLines) {
              if (diffLine.startsWith('+') && !diffLine.startsWith('+++')) {
                linesAdded++;
              } else if (diffLine.startsWith('-') && !diffLine.startsWith('---')) {
                linesDeleted++;
              }
            }
          }
        } catch {
          // Diff not available for new files, that's ok
        }
      }

      fileChanges.push({
        path: filePath,
        changeType,
        linesAdded,
        linesDeleted,
        diff: diff ? diff.substring(0, 10000) : undefined, // Limit diff size to 10KB
      });
    }

    return fileChanges;
  }

  /**
   * Get all snapshots for a task
   */
  static async getTaskSnapshots(
    taskId: string,
    filters?: {
      agentInstanceId?: string;
      epicId?: string;
      storyId?: string;
      limit?: number;
    }
  ) {
    const query: any = { taskId: new mongoose.Types.ObjectId(taskId) };

    if (filters?.agentInstanceId) query.agentInstanceId = filters.agentInstanceId;
    if (filters?.epicId) query.epicId = filters.epicId;
    if (filters?.storyId) query.storyId = filters.storyId;

    return await CodeSnapshot.find(query)
      .sort({ timestamp: -1 })
      .limit(filters?.limit || 100)
      .lean();
  }

  /**
   * Get snapshot for a specific story
   */
  static async getStorySnapshot(taskId: string, storyId: string) {
    return await CodeSnapshot.findOne({
      taskId: new mongoose.Types.ObjectId(taskId),
      storyId,
    })
      .sort({ timestamp: -1 })
      .lean();
  }

  /**
   * Get code changes summary for a task
   */
  static async getTaskCodeSummary(taskId: string) {
    const snapshots = await CodeSnapshot.find({
      taskId: new mongoose.Types.ObjectId(taskId),
    }).lean();

    const totalFiles = new Set<string>();
    let totalLinesAdded = 0;
    let totalLinesDeleted = 0;

    for (const snapshot of snapshots) {
      snapshot.fileChanges.forEach((fc) => totalFiles.add(fc.path));
      totalLinesAdded += snapshot.totalLinesAdded;
      totalLinesDeleted += snapshot.totalLinesDeleted;
    }

    return {
      snapshotsCount: snapshots.length,
      uniqueFilesChanged: totalFiles.size,
      totalLinesAdded,
      totalLinesDeleted,
      snapshots: snapshots.map((s) => ({
        timestamp: s.timestamp,
        agentInstanceId: s.agentInstanceId,
        storyTitle: s.storyTitle,
        filesChanged: s.totalFilesChanged,
        linesAdded: s.totalLinesAdded,
        linesDeleted: s.totalLinesDeleted,
      })),
    };
  }

  /**
   * Get file-level changes for a task
   */
  static async getTaskFileChanges(taskId: string) {
    const snapshots = await CodeSnapshot.find({
      taskId: new mongoose.Types.ObjectId(taskId),
    })
      .select('fileChanges agentInstanceId storyTitle timestamp')
      .lean();

    const fileMap = new Map<string, any>();

    for (const snapshot of snapshots) {
      for (const fileChange of snapshot.fileChanges) {
        const existing = fileMap.get(fileChange.path);
        if (!existing) {
          fileMap.set(fileChange.path, {
            path: fileChange.path,
            changeType: fileChange.changeType,
            totalLinesAdded: fileChange.linesAdded,
            totalLinesDeleted: fileChange.linesDeleted,
            modifiedBy: [snapshot.agentInstanceId],
            lastModified: snapshot.timestamp,
          });
        } else {
          existing.totalLinesAdded += fileChange.linesAdded;
          existing.totalLinesDeleted += fileChange.linesDeleted;
          if (!existing.modifiedBy.includes(snapshot.agentInstanceId)) {
            existing.modifiedBy.push(snapshot.agentInstanceId);
          }
          if (snapshot.timestamp > existing.lastModified) {
            existing.lastModified = snapshot.timestamp;
          }
        }
      }
    }

    return Array.from(fileMap.values()).sort((a, b) => {
      const aTotal = a.totalLinesAdded + a.totalLinesDeleted;
      const bTotal = b.totalLinesAdded + b.totalLinesDeleted;
      return bTotal - aTotal; // Most changed files first
    });
  }
}
