/**
 * DashboardService - Consolidated Dashboard Data for Frontend
 *
 * Provides a single endpoint with all necessary data for the frontend dashboard:
 * - Task overview and status
 * - Orchestration progress (PM, TL, Devs, QA)
 * - Activity timeline with recent events
 * - Anomalies and alerts
 * - Progress metrics and statistics
 * - Code changes summary
 * - Stories breakdown by epic
 * - Cost and token usage
 */

import { Task } from '../../models/Task';
import { LogService } from '../logging/LogService';
import { ActivityMonitorService } from '../activity/ActivityMonitorService';
import { CodeSnapshotService } from '../code-tracking/CodeSnapshotService';

export interface DashboardData {
  // Task overview
  task: {
    id: string;
    title: string;
    description?: string;
    status: string;
    priority: string;
    createdAt: Date;
    updatedAt: Date;
    startedAt?: Date;
    completedAt?: Date;
  };

  // Orchestration status
  orchestration: {
    currentPhase: string;
    productManager: {
      status: string;
      complexity?: string;
      epicsIdentified?: string[];
      startedAt?: Date;
      completedAt?: Date;
    };
    techLead: {
      status: string;
      epicsCount: number;
      storiesCount: number;
      developersCount: number;
      architectureDesign?: string;
      startedAt?: Date;
      completedAt?: Date;
    };
    developers: {
      totalDevelopers: number;
      activeStories: number;
      completedStories: number;
      failedStories: number;
      teamMembers: Array<{
        instanceId: string;
        assignedStories: string[];
        completedStories: string[];
      }>;
    };
    qaEngineer: {
      status: string;
      prsCreated: number;
      startedAt?: Date;
      completedAt?: Date;
    };
    costs: {
      totalCostUSD: number;
      totalTokens: number;
      pmCost: number;
      tlCost: number;
      devsCost: number;
      qaCost: number;
    };
  };

  // Progress and metrics
  progress: {
    currentPhase: string;
    overallProgress: number;
    phasesCompleted: string[];
    phasesRemaining: string[];
    storiesCompleted: number;
    storiesTotal: number;
    blockers: string[];
    warnings: string[];
    estimatedTimeRemaining?: string;
  };

  // Recent activity timeline (last 20 events)
  timeline: Array<{
    timestamp: Date;
    type: string;
    emoji: string;
    title: string;
    description: string;
    severity?: string;
    agent?: string;
    phase?: string;
  }>;

  // Anomalies and alerts
  anomalies: Array<{
    type: string;
    severity: string;
    title: string;
    description: string;
    timestamp: Date;
    affectedAgent?: string;
    affectedStory?: string;
  }>;

  // Code activity
  code: {
    snapshotsCount: number;
    uniqueFilesChanged: number;
    totalLinesAdded: number;
    totalLinesDeleted: number;
    recentSnapshots: Array<{
      timestamp: Date;
      agentInstanceId: string;
      storyTitle?: string;
      filesChanged: number;
      linesAdded: number;
      linesDeleted: number;
    }>;
    topFiles: Array<{
      path: string;
      totalLinesAdded: number;
      totalLinesDeleted: number;
      modifiedBy: string[];
    }>;
  };

  // Stories breakdown by epic
  epics: Array<{
    id: string;
    name: string;
    description: string;
    branchName: string;
    targetRepository?: string;
    status: string;
    stories: Array<{
      id: string;
      title: string;
      status: string;
      priority: number;
      estimatedComplexity: string;
      assignedTo?: string;
      dependencies: string[];
    }>;
  }>;

  // Metadata
  generatedAt: Date;
}

export class DashboardService {
  /**
   * Get comprehensive dashboard data for a task
   */
  static async getDashboardData(taskId: string): Promise<DashboardData> {
    const task = await Task.findById(taskId).lean();
    if (!task) {
      throw new Error('Task not found');
    }

    // Fetch all data in parallel for performance
    const [progress, timeline, anomalies, codeSummary, topFiles] = await Promise.all([
      ActivityMonitorService.analyzeProgress(taskId),
      ActivityMonitorService.getActivityTimeline(taskId),
      ActivityMonitorService.detectAnomalies(taskId),
      CodeSnapshotService.getTaskCodeSummary(taskId),
      CodeSnapshotService.getTaskFileChanges(taskId),
    ]);

    // Build epics with stories
    const epics = (task.orchestration.techLead?.epics || []).map((epic: any) => ({
      id: epic.id,
      name: epic.name,
      description: epic.description,
      branchName: epic.branchName,
      targetRepository: epic.targetRepository,
      status: epic.status,
      stories: epic.stories.map((storyId: string) => {
        const story = task.orchestration.techLead?.storiesMap?.[storyId];
        const assignment = task.orchestration.techLead?.storyAssignments?.find(
          (a: any) => a.storyId === storyId
        );
        return {
          id: story?.id || storyId,
          title: story?.title || 'Unknown',
          status: story?.status || 'pending',
          priority: story?.priority || 0,
          estimatedComplexity: story?.estimatedComplexity || 'unknown',
          assignedTo: assignment?.assignedTo,
          dependencies: story?.dependencies || [],
        };
      }),
    }));

    // Count developers stats
    const team = task.orchestration.team || [];
    const storiesMap = task.orchestration.techLead?.storiesMap || {};
    const allStories = Object.values(storiesMap) as any[];
    const completedStories = allStories.filter((s) => s.status === 'completed').length;
    const failedStories = allStories.filter((s) => s.status === 'failed').length;
    const activeStories = allStories.filter((s) => s.status === 'in_progress').length;

    // Calculate costs
    const pmCost = task.orchestration.productManager?.cost_usd || 0;
    const tlCost = task.orchestration.techLead?.cost_usd || 0;
    const devsCost = team.reduce((sum: number, m: any) => sum + (m.cost_usd || 0), 0);
    const qaCost = task.orchestration.qaEngineer?.cost_usd || 0;

    // Calculate overall start and completion times
    const orchestrationStartedAt = task.orchestration.productManager?.startedAt;
    const orchestrationCompletedAt =
      task.status === 'completed'
        ? task.orchestration.mergeCoordinator?.completedAt || task.orchestration.qaEngineer?.completedAt
        : undefined;

    return {
      task: {
        id: (task._id as any).toString(),
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        startedAt: orchestrationStartedAt,
        completedAt: orchestrationCompletedAt,
      },

      orchestration: {
        currentPhase: task.orchestration.currentPhase || 'pending',
        productManager: {
          status: task.orchestration.productManager?.status || 'pending',
          complexity: task.orchestration.productManager?.taskComplexity,
          epicsIdentified: task.orchestration.productManager?.epicsIdentified,
          startedAt: task.orchestration.productManager?.startedAt,
          completedAt: task.orchestration.productManager?.completedAt,
        },
        techLead: {
          status: task.orchestration.techLead?.status || 'pending',
          epicsCount: task.orchestration.techLead?.epics?.length || 0,
          storiesCount: Object.keys(storiesMap).length,
          developersCount: task.orchestration.techLead?.teamComposition?.developers || 0,
          architectureDesign: task.orchestration.techLead?.architectureDesign,
          startedAt: task.orchestration.techLead?.startedAt,
          completedAt: task.orchestration.techLead?.completedAt,
        },
        developers: {
          totalDevelopers: team.length,
          activeStories,
          completedStories,
          failedStories,
          teamMembers: team.map((member: any) => ({
            instanceId: member.instanceId,
            assignedStories: member.assignedStories || [],
            completedStories: member.completedStories || [],
          })),
        },
        qaEngineer: {
          status: task.orchestration.qaEngineer?.status || 'pending',
          prsCreated: task.orchestration.techLead?.epics?.filter((e: any) => e.pullRequestNumber).length || 0,
          startedAt: task.orchestration.qaEngineer?.startedAt,
          completedAt: task.orchestration.qaEngineer?.completedAt,
        },
        costs: {
          totalCostUSD: task.orchestration.totalCost || 0,
          totalTokens: task.orchestration.totalTokens || 0,
          pmCost,
          tlCost,
          devsCost,
          qaCost,
        },
      },

      progress,

      timeline: timeline.slice(-20).map((event) => ({
        timestamp: event.timestamp,
        type: event.type,
        emoji: event.emoji,
        title: event.title,
        description: event.description,
        severity: event.severity,
        agent: event.agent,
        phase: event.phase,
      })),

      anomalies: anomalies.map((anomaly) => ({
        type: anomaly.type,
        severity: anomaly.severity,
        title: anomaly.title,
        description: anomaly.description,
        timestamp: anomaly.timestamp,
        affectedAgent: anomaly.affectedAgent,
        affectedStory: anomaly.affectedStory,
      })),

      code: {
        snapshotsCount: codeSummary.snapshotsCount,
        uniqueFilesChanged: codeSummary.uniqueFilesChanged,
        totalLinesAdded: codeSummary.totalLinesAdded,
        totalLinesDeleted: codeSummary.totalLinesDeleted,
        recentSnapshots: codeSummary.snapshots.slice(-10),
        topFiles: topFiles.slice(0, 20),
      },

      epics,

      generatedAt: new Date(),
    };
  }

  /**
   * Get real-time status summary (lightweight endpoint for polling)
   */
  static async getStatusSummary(taskId: string) {
    const task = await Task.findById(taskId)
      .select('status orchestration.currentPhase orchestration.totalCost orchestration.totalTokens')
      .lean();

    if (!task) {
      throw new Error('Task not found');
    }

    const recentLogs = await LogService.getTaskLogs(taskId, { limit: 5 });
    const anomalies = await ActivityMonitorService.detectAnomalies(taskId);
    const criticalAnomalies = anomalies.filter(
      (a) => a.severity === 'critical' || a.severity === 'high'
    );

    return {
      status: task.status,
      currentPhase: task.orchestration.currentPhase || 'pending',
      totalCost: task.orchestration.totalCost || 0,
      totalTokens: task.orchestration.totalTokens || 0,
      recentActivity: recentLogs.map((log) => ({
        timestamp: log.timestamp,
        level: log.level,
        category: log.category,
        message: log.message,
      })),
      alerts: criticalAnomalies.length,
      lastUpdate: new Date(),
    };
  }

  /**
   * Get stories with detailed status
   */
  static async getStoriesStatus(taskId: string) {
    const task = await Task.findById(taskId)
      .select('orchestration.techLead.storiesMap orchestration.techLead.storyAssignments')
      .lean();

    if (!task) {
      throw new Error('Task not found');
    }

    const storiesMap = task.orchestration.techLead?.storiesMap || {};
    const assignments = task.orchestration.techLead?.storyAssignments || [];

    return Object.entries(storiesMap).map(([storyId, story]: [string, any]) => {
      const assignment = assignments.find((a: any) => a.storyId === storyId);
      return {
        id: storyId,
        title: story.title,
        description: story.description,
        status: story.status,
        epicId: story.epicId,
        priority: story.priority,
        estimatedComplexity: story.estimatedComplexity,
        assignedTo: assignment?.assignedTo,
        dependencies: story.dependencies || [],
      };
    });
  }
}
