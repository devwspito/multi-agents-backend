/**
 * 🎮 INTERACTIVE CONTROLLER
 * Provides manual control and review points between agents
 * Allows users to pause, review, modify, and approve agent outputs
 */

import { Task, AgentType } from '../models/Task';
import { NotificationService } from './NotificationService';
import readline from 'readline';

interface ReviewPoint {
  taskId: string;
  agentName: string;
  agentOutput: string;
  nextAgent: string;
  timestamp: Date;
  status: 'pending_review' | 'approved' | 'rejected' | 'modified';
}

interface ControlOptions {
  enableManualReview?: boolean;
  autoApproveAgents?: AgentType[];
  reviewAfterAgents?: AgentType[];
  enableInteractiveMode?: boolean;
  notificationChannel?: 'console' | 'websocket' | 'both';
}

export class InteractiveController {
  private reviewPoints: Map<string, ReviewPoint[]> = new Map();
  private options: ControlOptions;
  private rl?: readline.Interface;

  constructor(options: ControlOptions = {}) {
    this.options = {
      enableManualReview: process.env.ENABLE_MANUAL_REVIEW === 'true',
      autoApproveAgents: [],
      reviewAfterAgents: ['tech-lead', 'developer', 'qa-engineer'],
      enableInteractiveMode: process.env.INTERACTIVE_MODE === 'true',
      notificationChannel: 'both',
      ...options
    };

    // Initialize readline interface if in interactive mode
    if (this.options.enableInteractiveMode) {
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
    }
  }

  /**
   * Create a review point after an agent completes
   */
  async createReviewPoint(
    taskId: string,
    agentName: string,
    agentOutput: string,
    nextAgent?: string
  ): Promise<boolean> {
    // Skip if manual review is disabled
    if (!this.options.enableManualReview) {
      return true; // Auto-approve
    }

    // Check if this agent should be auto-approved
    if (this.options.autoApproveAgents?.includes(agentName as AgentType)) {
      console.log(`✅ [AutoApprove] ${agentName} output auto-approved`);
      return true;
    }

    // Check if we should review after this agent
    if (!this.options.reviewAfterAgents?.includes(agentName as AgentType)) {
      return true; // Skip review for this agent
    }

    const reviewPoint: ReviewPoint = {
      taskId,
      agentName,
      agentOutput,
      nextAgent: nextAgent || 'completion',
      timestamp: new Date(),
      status: 'pending_review'
    };

    // Store review point
    if (!this.reviewPoints.has(taskId)) {
      this.reviewPoints.set(taskId, []);
    }
    this.reviewPoints.get(taskId)!.push(reviewPoint);

    // Display review interface
    this.displayReviewInterface(reviewPoint);

    // Wait for user decision
    const approved = await this.waitForUserDecision(reviewPoint);

    // Update review point status
    reviewPoint.status = approved ? 'approved' : 'rejected';

    return approved;
  }

  /**
   * Display review interface to user
   */
  private displayReviewInterface(reviewPoint: ReviewPoint): void {
    const separator = '═'.repeat(60);

    console.log(`\n${separator}`);
    console.log(`🎮 MANUAL REVIEW CHECKPOINT`);
    console.log(`${separator}`);
    console.log(`📌 Task ID: ${reviewPoint.taskId}`);
    console.log(`🤖 Agent: ${reviewPoint.agentName}`);
    console.log(`⏭️  Next: ${reviewPoint.nextAgent}`);
    console.log(`🕐 Time: ${reviewPoint.timestamp.toLocaleTimeString()}`);
    console.log(`${separator}`);
    console.log(`📝 Agent Output Summary:`);
    console.log('─'.repeat(60));

    // Display truncated output (first 1000 chars)
    const truncatedOutput = reviewPoint.agentOutput.substring(0, 1000);
    console.log(truncatedOutput);

    if (reviewPoint.agentOutput.length > 1000) {
      console.log(`\n... (${reviewPoint.agentOutput.length - 1000} more characters)`);
    }

    console.log('─'.repeat(60));
    console.log(`\n🎯 Review Options:`);
    console.log(`  [A] Approve and continue to ${reviewPoint.nextAgent}`);
    console.log(`  [R] Reject and stop execution`);
    console.log(`  [M] Modify instructions and retry`);
    console.log(`  [S] Skip to next agent without approval`);
    console.log(`  [V] View full output`);
    console.log(`${separator}\n`);

    // Send WebSocket notification if enabled
    if (this.options.notificationChannel === 'websocket' || this.options.notificationChannel === 'both') {
      NotificationService.emitManualReviewRequired(reviewPoint.taskId, {
        agentName: reviewPoint.agentName,
        nextAgent: reviewPoint.nextAgent,
        outputPreview: truncatedOutput,
        options: ['approve', 'reject', 'modify', 'skip', 'view']
      });
    }
  }

  /**
   * Wait for user decision (interactive or API-based)
   */
  private async waitForUserDecision(reviewPoint: ReviewPoint): Promise<boolean> {
    // If in interactive mode, use console input
    if (this.options.enableInteractiveMode && this.rl) {
      return this.getInteractiveDecision(reviewPoint);
    }

    // Otherwise, wait for API decision
    return this.waitForAPIDecision(reviewPoint);
  }

  /**
   * Get decision from interactive console
   */
  private async getInteractiveDecision(reviewPoint: ReviewPoint): Promise<boolean> {
    return new Promise((resolve) => {
      const askForDecision = () => {
        this.rl!.question('👉 Your decision (A/R/M/S/V): ', async (answer) => {
          const choice = answer.toUpperCase();

          switch (choice) {
            case 'A':
              console.log('✅ Approved - continuing to next agent...\n');
              resolve(true);
              break;

            case 'R':
              console.log('❌ Rejected - stopping execution...\n');
              resolve(false);
              break;

            case 'M':
              console.log('✏️ Modification mode (not yet implemented)');
              console.log('📝 This would allow editing the agent instructions');
              askForDecision(); // Ask again
              break;

            case 'S':
              console.log('⏭️ Skipping - moving to next agent without approval...\n');
              resolve(true);
              break;

            case 'V':
              console.log('\n📄 Full Output:');
              console.log('─'.repeat(60));
              console.log(reviewPoint.agentOutput);
              console.log('─'.repeat(60));
              askForDecision(); // Ask again after showing
              break;

            default:
              console.log('❓ Invalid choice. Please enter A, R, M, S, or V.');
              askForDecision(); // Ask again
              break;
          }
        });
      };

      askForDecision();
    });
  }

  /**
   * Wait for decision via API
   */
  private async waitForAPIDecision(reviewPoint: ReviewPoint): Promise<boolean> {
    console.log(`⏳ Waiting for manual review decision...`);
    console.log(`💡 To approve: POST /api/tasks/${reviewPoint.taskId}/review/approve`);
    console.log(`💡 To reject: POST /api/tasks/${reviewPoint.taskId}/review/reject`);

    // Poll for decision (in real implementation, this would use WebSocket or SSE)
    const maxWaitTime = 300000; // 5 minutes
    const pollInterval = 5000; // Check every 5 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      // Check if task has been updated with decision
      const task = await Task.findById(reviewPoint.taskId);

      if (task) {
        const reviewStatus = (task as any).orchestration?.manualReview?.status;

        if (reviewStatus === 'approved') {
          console.log('✅ Review approved via API');
          return true;
        } else if (reviewStatus === 'rejected') {
          console.log('❌ Review rejected via API');
          return false;
        }
      }

      // Wait before next check
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    // Timeout - auto-approve or reject based on configuration
    const autoApproveOnTimeout = process.env.AUTO_APPROVE_ON_TIMEOUT === 'true';

    if (autoApproveOnTimeout) {
      console.log('⏱️ Review timeout - auto-approving...');
      return true;
    } else {
      console.log('⏱️ Review timeout - auto-rejecting...');
      return false;
    }
  }

  /**
   * Get review history for a task
   */
  getReviewHistory(taskId: string): ReviewPoint[] {
    return this.reviewPoints.get(taskId) || [];
  }

  /**
   * Clear review points for a task
   */
  clearReviewPoints(taskId: string): void {
    this.reviewPoints.delete(taskId);
  }

  /**
   * Check if manual review is enabled
   */
  isManualReviewEnabled(): boolean {
    return this.options.enableManualReview || false;
  }

  /**
   * Update control options dynamically
   */
  updateOptions(newOptions: Partial<ControlOptions>): void {
    this.options = { ...this.options, ...newOptions };
  }

  /**
   * Close interactive interface
   */
  close(): void {
    if (this.rl) {
      this.rl.close();
    }
  }
}

// Note: emitManualReviewRequired method is defined in NotificationService.ts

// Singleton instance
const interactiveController = new InteractiveController();
export default interactiveController;