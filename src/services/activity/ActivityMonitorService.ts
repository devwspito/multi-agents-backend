/**
 * ActivityMonitorService - Human-Readable Activity Timeline & Anomaly Detection
 *
 * Provides:
 * - Human-readable activity timeline
 * - Anomaly detection (slow agents, low scores, excessive retries)
 * - Progress analysis
 * - Proactive alerts
 */

import { LogService } from '../logging/LogService';
import { CodeSnapshotService } from '../code-tracking/CodeSnapshotService';
import { Task } from '../../models/Task';

export interface TimelineEvent {
  timestamp: Date;
  type: 'agent_started' | 'agent_completed' | 'agent_failed' | 'story_started' | 'story_completed' | 'story_failed' | 'code_snapshot' | 'judge_evaluation' | 'pr_created' | 'phase_started' | 'phase_completed';
  emoji: string;
  title: string;
  description: string;
  agent?: string;
  phase?: string;
  metadata?: Record<string, any>;
  severity?: 'info' | 'success' | 'warning' | 'error';
}

export interface Anomaly {
  type: 'slow_agent' | 'low_judge_score' | 'excessive_retries' | 'no_progress' | 'verification_failures' | 'missing_files';
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  affectedAgent?: string;
  affectedStory?: string;
  metadata?: Record<string, any>;
  timestamp: Date;
}

export interface ProgressAnalysis {
  taskId: string;
  currentPhase: string;
  overallProgress: number; // 0-100
  phasesCompleted: string[];
  phasesRemaining: string[];
  storiesCompleted: number;
  storiesTotal: number;
  estimatedTimeRemaining?: string;
  blockers: string[];
  warnings: string[];
}

export class ActivityMonitorService {
  /**
   * Get human-readable activity timeline for a task
   */
  static async getActivityTimeline(taskId: string): Promise<TimelineEvent[]> {
    const logs = await LogService.getTaskLogs(taskId, {
      limit: 500,
    });

    const timeline: TimelineEvent[] = [];

    for (const log of logs.reverse()) {
      let event: TimelineEvent | null = null;

      switch (log.category) {
        case 'agent':
          if (log.message.includes('started')) {
            event = {
              timestamp: log.timestamp,
              type: 'agent_started',
              emoji: this.getAgentEmoji(log.agentType),
              title: `${log.agentType?.replace('-', ' ').toUpperCase()} Started`,
              description: log.message,
              agent: log.agentType,
              phase: log.phase,
              severity: 'info',
            };
          } else if (log.message.includes('completed')) {
            event = {
              timestamp: log.timestamp,
              type: 'agent_completed',
              emoji: '✅',
              title: `${log.agentType?.replace('-', ' ').toUpperCase()} Completed`,
              description: log.message,
              agent: log.agentType,
              phase: log.phase,
              metadata: log.metadata,
              severity: 'success',
            };
          } else if (log.message.includes('failed')) {
            event = {
              timestamp: log.timestamp,
              type: 'agent_failed',
              emoji: '❌',
              title: `${log.agentType?.replace('-', ' ').toUpperCase()} Failed`,
              description: log.message,
              agent: log.agentType,
              phase: log.phase,
              severity: 'error',
            };
          }
          break;

        case 'story':
          if (log.message.includes('started')) {
            event = {
              timestamp: log.timestamp,
              type: 'story_started',
              emoji: '📝',
              title: `Story: ${log.storyTitle || 'Unknown'}`,
              description: `Started working on story`,
              metadata: { storyId: log.storyId },
              severity: 'info',
            };
          } else if (log.message.includes('completed')) {
            event = {
              timestamp: log.timestamp,
              type: 'story_completed',
              emoji: '✅',
              title: `Story: ${log.storyTitle || 'Unknown'}`,
              description: `Story completed successfully`,
              metadata: { storyId: log.storyId },
              severity: 'success',
            };
          } else if (log.message.includes('failed')) {
            event = {
              timestamp: log.timestamp,
              type: 'story_failed',
              emoji: '❌',
              title: `Story: ${log.storyTitle || 'Unknown'}`,
              description: log.message,
              metadata: { storyId: log.storyId },
              severity: 'error',
            };
          }
          break;

        case 'judge':
          event = {
            timestamp: log.timestamp,
            type: 'judge_evaluation',
            emoji: '⚖️',
            title: 'Judge Evaluation',
            description: log.message,
            metadata: log.metadata,
            severity: log.metadata?.approved ? 'success' : (log.metadata?.score !== undefined && log.metadata.score < 50) ? 'error' : 'warning',
          };
          break;

        case 'pr':
          if (log.message.includes('created')) {
            event = {
              timestamp: log.timestamp,
              type: 'pr_created',
              emoji: '🔀',
              title: 'Pull Request Created',
              description: log.message,
              metadata: log.metadata,
              severity: 'success',
            };
          }
          break;

        case 'orchestration':
          if (log.message.includes('phase') || log.message.includes('Phase')) {
            event = {
              timestamp: log.timestamp,
              type: log.message.includes('started') ? 'phase_started' : 'phase_completed',
              emoji: log.message.includes('started') ? '🚀' : '✅',
              title: log.message,
              description: log.phase ? `Phase: ${log.phase}` : '',
              phase: log.phase,
              metadata: log.metadata,
              severity: 'info',
            };
          }
          break;

        case 'developer':
          if (log.message.includes('snapshot')) {
            event = {
              timestamp: log.timestamp,
              type: 'code_snapshot',
              emoji: '📸',
              title: 'Code Changes Captured',
              description: log.message,
              agent: log.agentInstanceId,
              metadata: log.metadata,
              severity: 'info',
            };
          }
          break;
      }

      if (event) {
        timeline.push(event);
      }
    }

    return timeline;
  }

  /**
   * Detect anomalies in task execution
   */
  static async detectAnomalies(taskId: string): Promise<Anomaly[]> {
    const anomalies: Anomaly[] = [];
    const logs = await LogService.getTaskLogs(taskId, { limit: 1000 });

    // Group logs by agent
    const agentLogs = new Map<string, typeof logs>();
    for (const log of logs) {
      if (log.agentType) {
        const key = `${log.agentType}-${log.agentInstanceId || 'default'}`;
        if (!agentLogs.has(key)) {
          agentLogs.set(key, []);
        }
        agentLogs.get(key)!.push(log);
      }
    }

    // 1. Detect slow agents (agents taking too long)
    for (const [agentKey, agentLogList] of agentLogs) {
      const started = agentLogList.find(l => l.message.includes('started'));
      const completed = agentLogList.find(l => l.message.includes('completed'));

      if (started && completed) {
        const duration = completed.timestamp.getTime() - started.timestamp.getTime();
        const durationMinutes = duration / (1000 * 60);

        if (durationMinutes > 30) {
          anomalies.push({
            type: 'slow_agent',
            severity: durationMinutes > 60 ? 'high' : 'medium',
            title: 'Slow Agent Detected',
            description: `${agentKey} took ${durationMinutes.toFixed(1)} minutes (expected < 30 min)`,
            affectedAgent: agentKey,
            timestamp: completed.timestamp,
            metadata: { duration: durationMinutes },
          });
        }
      }
    }

    // 2. Detect low judge scores
    const judgeLogs = logs.filter(l => l.category === 'judge' && l.metadata?.score !== undefined);
    for (const judgeLog of judgeLogs) {
      const score = judgeLog.metadata!.score as number;
      if (score < 50) {
        anomalies.push({
          type: 'low_judge_score',
          severity: score < 30 ? 'critical' : 'high',
          title: 'Low Judge Score',
          description: `Judge scored implementation at ${score}/100 (verdict: ${judgeLog.metadata!.verdict})`,
          affectedStory: judgeLog.storyTitle,
          timestamp: judgeLog.timestamp,
          metadata: { score, verdict: judgeLog.metadata!.verdict },
        });
      }
    }

    // 3. Detect excessive retries
    const retryLogs = logs.filter(l => l.message.toLowerCase().includes('retry') || l.message.toLowerCase().includes('attempt'));
    const retryByStory = new Map<string, number>();

    for (const retryLog of retryLogs) {
      const key = retryLog.storyId || retryLog.epicId || 'unknown';
      retryByStory.set(key, (retryByStory.get(key) || 0) + 1);
    }

    for (const [storyKey, retryCount] of retryByStory) {
      if (retryCount > 3) {
        anomalies.push({
          type: 'excessive_retries',
          severity: retryCount > 5 ? 'high' : 'medium',
          title: 'Excessive Retries',
          description: `Story has been retried ${retryCount} times`,
          affectedStory: storyKey,
          timestamp: new Date(),
          metadata: { retryCount },
        });
      }
    }

    // 4. Detect verification failures
    const verificationFailures = logs.filter(l =>
      l.category === 'quality' &&
      (l.message.toLowerCase().includes('verification failed') || l.message.toLowerCase().includes('failed'))
    );

    if (verificationFailures.length > 5) {
      anomalies.push({
        type: 'verification_failures',
        severity: 'medium',
        title: 'Multiple Verification Failures',
        description: `${verificationFailures.length} verification failures detected`,
        timestamp: new Date(),
        metadata: { count: verificationFailures.length },
      });
    }

    // 5. Detect no progress (no logs in last 10 minutes for in-progress task)
    const latestLog = logs.length > 0 ? logs[logs.length - 1] : null;
    if (latestLog) {
      const timeSinceLastLog = Date.now() - latestLog.timestamp.getTime();
      const minutesSinceLastLog = timeSinceLastLog / (1000 * 60);

      if (minutesSinceLastLog > 10) {
        const task = await Task.findById(taskId);
        if (task && task.status === 'in_progress') {
          anomalies.push({
            type: 'no_progress',
            severity: minutesSinceLastLog > 30 ? 'high' : 'medium',
            title: 'No Recent Progress',
            description: `No activity logged in the last ${minutesSinceLastLog.toFixed(0)} minutes`,
            timestamp: new Date(),
            metadata: { minutesSinceLastLog },
          });
        }
      }
    }

    return anomalies.sort((a, b) => {
      const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
      return severityOrder[b.severity] - severityOrder[a.severity];
    });
  }

  /**
   * Analyze task progress
   */
  static async analyzeProgress(taskId: string): Promise<ProgressAnalysis> {
    const task = await Task.findById(taskId);
    if (!task) {
      throw new Error('Task not found');
    }

    const phases = ['analysis', 'planning', 'architecture', 'development', 'qa', 'merge'];
    const phasesCompleted: string[] = [];
    const phasesRemaining: string[] = [];
    let currentPhase = 'analysis';

    // Determine completed phases
    if (task.orchestration.productManager?.status === 'completed') {
      phasesCompleted.push('analysis');
      currentPhase = 'planning';
    }
    if (task.orchestration.techLead?.status === 'completed') {
      phasesCompleted.push('planning', 'architecture');
      currentPhase = 'development';
    }
    if (task.orchestration.team && task.orchestration.team.every(m => m.status === 'completed')) {
      phasesCompleted.push('development');
      currentPhase = 'qa';
    }
    if (task.orchestration.qaEngineer?.status === 'completed') {
      phasesCompleted.push('qa');
      currentPhase = 'merge';
    }
    if (task.status === 'completed') {
      phasesCompleted.push('merge');
      currentPhase = 'completed';
    }

    // Calculate remaining phases
    for (const phase of phases) {
      if (!phasesCompleted.includes(phase)) {
        phasesRemaining.push(phase);
      }
    }

    // Count stories
    const storiesMap = task.orchestration.techLead?.storiesMap || {};
    const allStories = Object.values(storiesMap);
    const storiesCompleted = allStories.filter((s: any) => s.status === 'completed').length;
    const storiesTotal = allStories.length;

    // Calculate overall progress
    const phaseProgress = (phasesCompleted.length / phases.length) * 100;
    const storyProgress = storiesTotal > 0 ? (storiesCompleted / storiesTotal) * 100 : 0;
    const overallProgress = Math.round((phaseProgress + storyProgress) / 2);

    // Detect blockers
    const blockers: string[] = [];
    const anomalies = await this.detectAnomalies(taskId);

    for (const anomaly of anomalies) {
      if (anomaly.severity === 'critical' || anomaly.severity === 'high') {
        blockers.push(anomaly.description);
      }
    }

    // Detect warnings
    const warnings: string[] = [];
    for (const anomaly of anomalies) {
      if (anomaly.severity === 'medium') {
        warnings.push(anomaly.description);
      }
    }

    return {
      taskId,
      currentPhase,
      overallProgress,
      phasesCompleted,
      phasesRemaining,
      storiesCompleted,
      storiesTotal,
      blockers,
      warnings,
    };
  }

  /**
   * Get comprehensive activity report
   */
  static async getActivityReport(taskId: string) {
    const [timeline, anomalies, progress, codeSnapshots] = await Promise.all([
      this.getActivityTimeline(taskId),
      this.detectAnomalies(taskId),
      this.analyzeProgress(taskId),
      CodeSnapshotService.getTaskCodeSummary(taskId),
    ]);

    return {
      timeline,
      anomalies,
      progress,
      codeActivity: codeSnapshots,
      generatedAt: new Date(),
    };
  }

  /**
   * Helper: Get emoji for agent type
   */
  private static getAgentEmoji(agentType?: string): string {
    const emojiMap: Record<string, string> = {
      'product-manager': '🎯',
      'tech-lead': '🏗️',
      'developer': '👨‍💻',
      'qa-engineer': '🧪',
      'merge-coordinator': '🔀',
      'judge': '⚖️',
    };
    return emojiMap[agentType || ''] || '🤖';
  }
}
