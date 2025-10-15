import { Task } from '../models/Task';
import { NotificationService } from './NotificationService';

/**
 * ❓ Clarifications Helper
 *
 * Permite a los agentes PAUSAR ejecución y preguntar al usuario
 *
 * Uso en agentes:
 * ```
 * const answer = await ClarificationsHelper.askUser(
 *   taskId,
 *   'Developer',
 *   '¿Prefieres REST API o GraphQL?',
 *   {
 *     context: 'Building authentication service',
 *     suggestions: ['REST API', 'GraphQL', 'Both']
 *   }
 * );
 * ```
 */
export class ClarificationsHelper {
  /**
   * Agent asks user a question and PAUSES execution
   * Returns user's answer when they respond via /api/tasks/:id/clarify
   *
   * Si Auto Pilot Mode está activado, retorna respuesta default sin pausar
   */
  static async askUser(
    taskId: string,
    agentName: string,
    question: string,
    options?: {
      context?: string;
      suggestions?: string[];
      timeout?: number; // milliseconds (default: 10 minutes)
    }
  ): Promise<string> {
    const task = await Task.findById(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    // 🚁 Check if auto-pilot mode is enabled
    if (task.orchestration.autoPilotMode) {
      console.log(`🚁 [Auto Pilot] Skipping clarification from ${agentName}`);
      console.log(`   Question: ${question}`);
      console.log(`   Auto-answer: Continue with best judgment`);
      return 'Continue with best judgment and use industry best practices';
    }

    // Create unique clarification ID
    const clarificationId = `clarif-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    // Save to task
    task.orchestration.pendingClarification = {
      id: clarificationId,
      agent: agentName,
      question,
      context: options?.context,
      suggestions: options?.suggestions,
      askedAt: new Date(),
      answered: false
    };
    task.orchestration.status = 'awaiting_clarification';
    await task.save();

    console.log(`❓ [${agentName}] Asking user for clarification...`);
    console.log(`   Question: ${question}`);
    if (options?.context) {
      console.log(`   Context: ${options.context}`);
    }
    if (options?.suggestions && options.suggestions.length > 0) {
      console.log(`   Suggestions: ${options.suggestions.join(', ')}`);
    }

    // Emit WebSocket event to frontend
    NotificationService.emitClarificationRequired(taskId, {
      id: clarificationId,
      agent: agentName,
      question,
      context: options?.context,
      suggestions: options?.suggestions
    });

    // Also emit as general notification for Chat.jsx
    NotificationService.notifyTaskUpdate(taskId, {
      type: 'clarification_required',
      data: {
        id: clarificationId,
        agent: agentName,
        question,
        context: options?.context,
        suggestions: options?.suggestions
      }
    });

    // WAIT for user response (poll database)
    const timeout = options?.timeout || 10 * 60 * 1000; // 10 minutes default
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        try {
          // Check timeout
          if (Date.now() - startTime > timeout) {
            clearInterval(interval);
            console.log(`⏱️  [${agentName}] Clarification timed out - using default answer`);
            reject(new Error('CLARIFICATION_TIMEOUT'));
            return;
          }

          // Check if answered
          const updatedTask = await Task.findById(taskId);
          const clarif = updatedTask?.orchestration.pendingClarification;

          if (clarif && clarif.id === clarificationId && clarif.answered) {
            clearInterval(interval);
            console.log(`✅ [${agentName}] User responded: "${clarif.userResponse}"`);

            // Clear pending clarification from task
            updatedTask.orchestration.pendingClarification = undefined;
            updatedTask.orchestration.status = 'in_progress';
            await updatedTask.save();

            resolve(clarif.userResponse!);
          }
        } catch (error) {
          clearInterval(interval);
          console.error(`❌ Error polling for clarification:`, error);
          reject(error);
        }
      }, 2000); // Poll every 2 seconds
    });
  }

  /**
   * Cancel pending clarification (if user closes/rejects)
   */
  static async cancelClarification(taskId: string): Promise<void> {
    const task = await Task.findById(taskId);
    if (!task) return;

    if (task.orchestration.pendingClarification) {
      console.log(`🚫 [Clarification] Cancelled for task ${taskId}`);
      task.orchestration.pendingClarification = undefined;
      task.orchestration.status = 'in_progress';
      await task.save();
    }
  }
}

export default ClarificationsHelper;
