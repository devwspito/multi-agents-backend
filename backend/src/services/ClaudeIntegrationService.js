const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const AgentConversation = require('../models/AgentConversation');
const socketService = require('./SocketService');
const notificationService = require('./NotificationService');

/**
 * Claude Code Integration Service
 * Handles automatic synchronization and execution with Claude Code agents
 */
class ClaudeIntegrationService {
  constructor() {
    this.executionQueue = new Map(); // Track ongoing executions
    this.claudeWorkspaces = new Map(); // Track workspace paths per project
    this.executionHistory = new Map(); // Track execution history
    this.autoTriggers = new Map(); // Auto-execution triggers
    
    console.log('🤖 Claude Integration Service initialized');
  }

  /**
   * Execute Claude Code agent with conversation context
   */
  async executeAgent({
    conversationId,
    agentType,
    instructions,
    workspacePath,
    userId,
    autoExecute = false,
    context = {}
  }) {
    const executionId = `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      // Check if already executing for this conversation
      if (this.executionQueue.has(conversationId)) {
        throw new Error('Agent execution already in progress for this conversation');
      }

      console.log(`🚀 Starting Claude agent execution: ${agentType} for conversation ${conversationId}`);

      // Mark execution as started
      this.executionQueue.set(conversationId, {
        executionId,
        agentType,
        startTime: Date.now(),
        status: 'running',
        userId
      });

      // Notify via socket
      socketService.emitToConversation(conversationId, 'agent_execution_started', {
        executionId,
        agentType,
        startTime: new Date().toISOString(),
        autoExecute
      });

      // Send notifications
      if (!autoExecute) {
        await notificationService.notifyAgentExecutionStart(conversationId, agentType, userId);
      }

      // Prepare Claude Code execution
      const claudeResult = await this.executeClaude({
        agentType,
        instructions,
        workspacePath,
        context: {
          ...context,
          conversationId,
          executionId
        }
      });

      // Update conversation with result
      await this.updateConversationWithResult(conversationId, claudeResult, executionId);

      // Mark execution as completed
      this.executionQueue.delete(conversationId);

      // Store in execution history
      this.storeExecutionHistory(executionId, conversationId, agentType, claudeResult);

      // Notify completion
      socketService.emitToConversation(conversationId, 'agent_execution_completed', {
        executionId,
        agentType,
        result: claudeResult,
        executionTime: Date.now() - this.executionQueue.get(conversationId)?.startTime,
        success: claudeResult.success
      });

      // Send notifications
      await notificationService.notifyAgentExecutionComplete(
        conversationId,
        agentType,
        claudeResult.success,
        claudeResult,
        userId
      );

      // Check for auto-triggers
      await this.checkAutoTriggers(conversationId, claudeResult);

      console.log(`✅ Claude agent execution completed: ${agentType} - Success: ${claudeResult.success}`);

      return {
        executionId,
        success: claudeResult.success,
        result: claudeResult,
        executionTime: claudeResult.executionTime
      };

    } catch (error) {
      console.error(`❌ Claude agent execution failed: ${agentType}`, error);

      // Mark execution as failed
      this.executionQueue.delete(conversationId);

      // Notify failure
      socketService.emitToConversation(conversationId, 'agent_execution_failed', {
        executionId,
        agentType,
        error: error.message,
        timestamp: new Date().toISOString()
      });

      // Send failure notifications
      await notificationService.notifyAgentExecutionComplete(
        conversationId,
        agentType,
        false,
        { error: error.message },
        userId
      );

      throw error;
    }
  }

  /**
   * Execute Claude Code command
   */
  async executeClaude({ agentType, instructions, workspacePath, context }) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      
      // Prepare Claude Code command based on agent type
      const command = this.buildClaudeCommand(agentType, instructions, workspacePath, context);
      
      console.log(`🔧 Executing Claude command: ${command.cmd} ${command.args.join(' ')}`);

      const claudeProcess = spawn(command.cmd, command.args, {
        cwd: workspacePath,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CLAUDE_API_KEY: process.env.ANTHROPIC_API_KEY
        }
      });

      let stdout = '';
      let stderr = '';
      let files = [];
      let metrics = {};

      // Handle stdout
      claudeProcess.stdout.on('data', (data) => {
        const output = data.toString();
        stdout += output;
        
        // Parse real-time progress if available
        this.parseClaudeProgress(output, context.conversationId);
      });

      // Handle stderr
      claudeProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      // Handle process completion
      claudeProcess.on('close', async (code) => {
        const executionTime = Date.now() - startTime;
        
        try {
          // Parse Claude output
          const result = await this.parseClaudeOutput({
            stdout,
            stderr,
            exitCode: code,
            executionTime,
            workspacePath,
            agentType
          });

          resolve(result);
        } catch (parseError) {
          reject(new Error(`Failed to parse Claude output: ${parseError.message}`));
        }
      });

      // Handle process error
      claudeProcess.on('error', (error) => {
        reject(new Error(`Claude process failed: ${error.message}`));
      });

      // Send instructions to Claude
      if (instructions) {
        claudeProcess.stdin.write(instructions);
        claudeProcess.stdin.end();
      }
    });
  }

  /**
   * Build Claude Code command based on agent type
   */
  buildClaudeCommand(agentType, instructions, workspacePath, context) {
    const baseArgs = [
      'code',
      '--agent', agentType,
      '--workspace', workspacePath
    ];

    // Add conversation context
    if (context.conversationId) {
      baseArgs.push('--context', `conversation:${context.conversationId}`);
    }

    // Add project context
    if (context.projectId) {
      baseArgs.push('--project', context.projectId);
    }

    // Add task context
    if (context.taskId) {
      baseArgs.push('--task', context.taskId);
    }

    // Add repository context
    if (context.repositoryId) {
      baseArgs.push('--repository', context.repositoryId);
    }

    // Agent-specific arguments
    const agentSpecificArgs = this.getAgentSpecificArgs(agentType);
    
    return {
      cmd: 'claude',
      args: [...baseArgs, ...agentSpecificArgs]
    };
  }

  /**
   * Get agent-specific Claude Code arguments
   */
  getAgentSpecificArgs(agentType) {
    const agentArgs = {
      'product-manager': ['--analyze', '--requirements'],
      'project-manager': ['--breakdown', '--planning'],
      'tech-lead': ['--architecture', '--design'],
      'senior-developer': ['--implement', '--review', '--complex'],
      'junior-developer': ['--implement', '--simple', '--guided'],
      'qa-engineer': ['--test', '--validate', '--quality']
    };

    return agentArgs[agentType] || [];
  }

  /**
   * Parse real-time progress from Claude output
   */
  parseClaudeProgress(output, conversationId) {
    try {
      // Look for progress indicators in Claude output
      const progressRegex = /Progress: (\d+)%/g;
      const stepRegex = /Current step: (.+)/g;
      
      const progressMatch = progressRegex.exec(output);
      const stepMatch = stepRegex.exec(output);
      
      if (progressMatch || stepMatch) {
        const progressData = {
          progress: progressMatch ? parseInt(progressMatch[1]) : undefined,
          currentStep: stepMatch ? stepMatch[1] : undefined,
          timestamp: new Date().toISOString()
        };

        // Emit progress update via socket
        socketService.emitToConversation(conversationId, 'agent_execution_progress', progressData);
      }
    } catch (error) {
      // Silent fail for progress parsing
    }
  }

  /**
   * Parse Claude Code output
   */
  async parseClaudeOutput({ stdout, stderr, exitCode, executionTime, workspacePath, agentType }) {
    const success = exitCode === 0;
    
    try {
      // Parse structured output if available
      const structuredOutput = this.extractStructuredOutput(stdout);
      
      // Get file changes
      const fileChanges = await this.getFileChanges(workspacePath);
      
      // Extract metrics
      const metrics = this.extractMetrics(stdout, stderr);
      
      // Parse agent-specific results
      const agentResult = this.parseAgentSpecificResult(agentType, stdout, structuredOutput);

      return {
        success,
        executionTime,
        output: stdout,
        error: stderr,
        files: fileChanges,
        metrics,
        agentResult,
        model: 'claude-sonnet-4',
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        success: false,
        executionTime,
        output: stdout,
        error: `Parse error: ${error.message}\n${stderr}`,
        files: [],
        metrics: {},
        agentResult: null,
        model: 'claude-sonnet-4',
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Extract structured output from Claude response
   */
  extractStructuredOutput(output) {
    try {
      // Look for JSON blocks in Claude output
      const jsonRegex = /```json\n([\s\S]*?)\n```/g;
      const matches = [...output.matchAll(jsonRegex)];
      
      if (matches.length > 0) {
        return JSON.parse(matches[matches.length - 1][1]);
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get file changes in workspace
   */
  async getFileChanges(workspacePath) {
    try {
      // In a real implementation, you'd use git or file watching
      // For now, return mock data
      return {
        created: [],
        modified: [],
        deleted: [],
        totalChanges: 0
      };
    } catch (error) {
      return { created: [], modified: [], deleted: [], totalChanges: 0 };
    }
  }

  /**
   * Extract metrics from Claude output
   */
  extractMetrics(stdout, stderr) {
    const metrics = {
      linesOfCode: 0,
      testsRun: 0,
      testsPassed: 0,
      testsFailed: 0,
      coverage: 0,
      complexity: 0
    };

    try {
      // Extract test results
      const testRegex = /Tests: (\d+) passed, (\d+) failed, (\d+) total/g;
      const testMatch = testRegex.exec(stdout);
      if (testMatch) {
        metrics.testsPassed = parseInt(testMatch[1]);
        metrics.testsFailed = parseInt(testMatch[2]);
        metrics.testsRun = parseInt(testMatch[3]);
      }

      // Extract coverage
      const coverageRegex = /Coverage: ([\d.]+)%/g;
      const coverageMatch = coverageRegex.exec(stdout);
      if (coverageMatch) {
        metrics.coverage = parseFloat(coverageMatch[1]);
      }

      return metrics;
    } catch (error) {
      return metrics;
    }
  }

  /**
   * Parse agent-specific results
   */
  parseAgentSpecificResult(agentType, output, structuredOutput) {
    const parsers = {
      'product-manager': () => this.parseProductManagerResult(output, structuredOutput),
      'project-manager': () => this.parseProjectManagerResult(output, structuredOutput),
      'tech-lead': () => this.parseTechLeadResult(output, structuredOutput),
      'senior-developer': () => this.parseSeniorDeveloperResult(output, structuredOutput),
      'junior-developer': () => this.parseJuniorDeveloperResult(output, structuredOutput),
      'qa-engineer': () => this.parseQAEngineerResult(output, structuredOutput)
    };

    const parser = parsers[agentType];
    return parser ? parser() : { type: 'generic', content: output };
  }

  /**
   * Parse Product Manager results
   */
  parseProductManagerResult(output, structuredOutput) {
    return {
      type: 'requirements_analysis',
      requirements: structuredOutput?.requirements || [],
      stakeholders: structuredOutput?.stakeholders || [],
      priorities: structuredOutput?.priorities || [],
      recommendations: structuredOutput?.recommendations || []
    };
  }

  /**
   * Parse Project Manager results
   */
  parseProjectManagerResult(output, structuredOutput) {
    return {
      type: 'task_breakdown',
      tasks: structuredOutput?.tasks || [],
      timeline: structuredOutput?.timeline || {},
      dependencies: structuredOutput?.dependencies || [],
      sprints: structuredOutput?.sprints || []
    };
  }

  /**
   * Parse Tech Lead results
   */
  parseTechLeadResult(output, structuredOutput) {
    return {
      type: 'architecture_design',
      architecture: structuredOutput?.architecture || {},
      technologies: structuredOutput?.technologies || [],
      patterns: structuredOutput?.patterns || [],
      guidelines: structuredOutput?.guidelines || []
    };
  }

  /**
   * Parse Senior Developer results
   */
  parseSeniorDeveloperResult(output, structuredOutput) {
    return {
      type: 'implementation',
      features: structuredOutput?.features || [],
      codeReview: structuredOutput?.codeReview || {},
      refactoring: structuredOutput?.refactoring || [],
      optimizations: structuredOutput?.optimizations || []
    };
  }

  /**
   * Parse Junior Developer results
   */
  parseJuniorDeveloperResult(output, structuredOutput) {
    return {
      type: 'component_implementation',
      components: structuredOutput?.components || [],
      tests: structuredOutput?.tests || [],
      documentation: structuredOutput?.documentation || [],
      learningPoints: structuredOutput?.learningPoints || []
    };
  }

  /**
   * Parse QA Engineer results
   */
  parseQAEngineerResult(output, structuredOutput) {
    return {
      type: 'quality_validation',
      testResults: structuredOutput?.testResults || {},
      issues: structuredOutput?.issues || [],
      coverage: structuredOutput?.coverage || {},
      recommendations: structuredOutput?.recommendations || []
    };
  }

  /**
   * Update conversation with execution result
   */
  async updateConversationWithResult(conversationId, claudeResult, executionId) {
    try {
      const conversation = await AgentConversation.findById(conversationId);
      if (!conversation) {
        throw new Error('Conversation not found');
      }

      // Add agent response message
      const agentMessage = conversation.addMessage(
        'agent',
        claudeResult.output,
        [],
        {
          type: 'execution_result',
          data: {
            executionId,
            success: claudeResult.success,
            metrics: claudeResult.metrics,
            agentResult: claudeResult.agentResult
          }
        }
      );

      // Update execution context
      conversation.updateExecutionResult({
        model: claudeResult.model,
        executionTime: claudeResult.executionTime,
        success: claudeResult.success,
        error: claudeResult.error
      });

      // Update result data
      if (claudeResult.files?.totalChanges > 0) {
        conversation.result.generatedFiles = claudeResult.files.created || [];
        conversation.result.modifiedFiles = claudeResult.files.modified || [];
      }

      if (claudeResult.metrics?.testsRun > 0) {
        conversation.result.testResults = {
          framework: 'jest', // or detect from output
          passed: claudeResult.metrics.testsPassed,
          failed: claudeResult.metrics.testsFailed,
          coverage: claudeResult.metrics.coverage
        };
      }

      await conversation.save();

      console.log(`💾 Updated conversation ${conversationId} with execution result`);
    } catch (error) {
      console.error('Error updating conversation with result:', error);
    }
  }

  /**
   * Store execution history
   */
  storeExecutionHistory(executionId, conversationId, agentType, result) {
    this.executionHistory.set(executionId, {
      conversationId,
      agentType,
      result,
      timestamp: new Date().toISOString()
    });

    // Keep only last 1000 executions
    if (this.executionHistory.size > 1000) {
      const firstKey = this.executionHistory.keys().next().value;
      this.executionHistory.delete(firstKey);
    }
  }

  /**
   * Check and execute auto-triggers
   */
  async checkAutoTriggers(conversationId, previousResult) {
    try {
      const triggers = this.autoTriggers.get(conversationId) || [];
      
      for (const trigger of triggers) {
        if (this.shouldExecuteTrigger(trigger, previousResult)) {
          console.log(`🔄 Auto-executing trigger: ${trigger.agentType}`);
          
          await this.executeAgent({
            conversationId,
            agentType: trigger.agentType,
            instructions: trigger.instructions,
            workspacePath: trigger.workspacePath,
            userId: trigger.userId,
            autoExecute: true,
            context: trigger.context
          });
        }
      }
    } catch (error) {
      console.error('Error checking auto-triggers:', error);
    }
  }

  /**
   * Check if trigger should execute
   */
  shouldExecuteTrigger(trigger, previousResult) {
    switch (trigger.condition) {
      case 'on_success':
        return previousResult.success;
      case 'on_failure':
        return !previousResult.success;
      case 'on_tests_pass':
        return previousResult.success && previousResult.metrics?.testsPassed > 0;
      case 'on_tests_fail':
        return previousResult.metrics?.testsFailed > 0;
      default:
        return false;
    }
  }

  /**
   * Set up auto-trigger
   */
  setAutoTrigger(conversationId, trigger) {
    if (!this.autoTriggers.has(conversationId)) {
      this.autoTriggers.set(conversationId, []);
    }
    
    this.autoTriggers.get(conversationId).push(trigger);
    console.log(`🎯 Auto-trigger set for conversation ${conversationId}: ${trigger.agentType} on ${trigger.condition}`);
  }

  /**
   * Get execution status
   */
  getExecutionStatus(conversationId) {
    return this.executionQueue.get(conversationId) || null;
  }

  /**
   * Get execution history
   */
  getExecutionHistory(conversationId = null) {
    if (conversationId) {
      return Array.from(this.executionHistory.entries())
        .filter(([, execution]) => execution.conversationId === conversationId)
        .map(([id, execution]) => ({ id, ...execution }));
    }
    
    return Array.from(this.executionHistory.entries())
      .map(([id, execution]) => ({ id, ...execution }));
  }

  /**
   * Cancel execution
   */
  async cancelExecution(conversationId, userId) {
    const execution = this.executionQueue.get(conversationId);
    if (!execution) {
      throw new Error('No active execution found for this conversation');
    }

    // In a real implementation, you'd kill the Claude process
    this.executionQueue.delete(conversationId);

    // Notify cancellation
    socketService.emitToConversation(conversationId, 'agent_execution_cancelled', {
      executionId: execution.executionId,
      agentType: execution.agentType,
      cancelledBy: userId,
      timestamp: new Date().toISOString()
    });

    console.log(`❌ Execution cancelled for conversation ${conversationId}`);
  }
}

// Export singleton instance
const claudeIntegrationService = new ClaudeIntegrationService();
module.exports = claudeIntegrationService;