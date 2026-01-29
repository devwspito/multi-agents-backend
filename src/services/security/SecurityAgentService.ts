/**
 * Security Agent Service
 *
 * Passive observer that analyzes all agent activity in real-time
 * to detect security vulnerabilities. NEVER blocks execution.
 *
 * Tracks:
 * - Code written/modified by agents (Write, Edit tools)
 * - Bash commands executed
 * - Configuration files created
 * - Dependencies installed
 *
 * Outputs:
 * - Security observations stored in SQLite
 * - Vulnerability report with recommendations
 */

import {
  SecurityObservationRepository,
  ObservationType,
  Severity,
} from '../../database/repositories/SecurityObservationRepository';
import {
  SecurityPattern,
  SecurityCategory,
  CODE_PATTERNS,
  BASH_PATTERNS,
  DEPENDENCY_PATTERNS,
  getPatternsForFile,
} from './SecurityPatterns';
import {
  AgentSecurityPattern,
  AgentThreatCategory,
  detectThreats,
  analyzeToolSequence,
} from './AgentSecurityPatterns';

export interface SecurityFinding {
  pattern: SecurityPattern;
  match: string;
  lineNumber?: number;
  context?: string; // Surrounding code
}

export interface AnalysisResult {
  findings: SecurityFinding[];
  scannedAt: Date;
  filePath?: string;
  toolName?: string;
}

// AI Agent-specific threat finding
export interface AgentThreatFinding {
  pattern: AgentSecurityPattern;
  matchedIndicator: string;
  context: 'prompt' | 'turn_content' | 'tool_input' | 'tool_output' | 'bash_command';
  detectedIn?: string; // The actual text where it was found (truncated)
}

export interface SecurityReport {
  taskId: string;
  generatedAt: Date;
  summary: {
    total: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  vulnerabilities: Array<{
    id: string;
    category: SecurityCategory;
    severity: Severity;
    description: string;
    location?: {
      filePath?: string;
      lineNumber?: number;
      codeSnippet?: string;
    };
    recommendation: string;
    owaspCategory?: string;
    cweId?: string;
  }>;
  recommendations: string[];
}

class SecurityAgentServiceClass {
  private pendingAnalysis: Map<string, Promise<void>> = new Map();

  /**
   * Analyze code content for security vulnerabilities
   * Called when Write or Edit tool completes
   */
  async analyzeCode(params: {
    taskId: string;
    executionId?: string;
    toolCallId?: string;
    filePath: string;
    content: string;
    agentType?: string;
    phaseName?: string;
  }): Promise<AnalysisResult> {
    const findings: SecurityFinding[] = [];
    const patterns = getPatternsForFile(params.filePath);

    const lines = params.content.split('\n');

    for (const pattern of patterns) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        for (const regex of pattern.patterns) {
          const match = line.match(regex);
          if (match) {
            // Check exclude patterns
            let isExcluded = false;
            if (pattern.excludePatterns) {
              for (const excludeRegex of pattern.excludePatterns) {
                if (excludeRegex.test(line)) {
                  isExcluded = true;
                  break;
                }
              }
            }

            if (!isExcluded) {
              findings.push({
                pattern,
                match: match[0],
                lineNumber: i + 1,
                context: this.getContext(lines, i, 2),
              });
            }
          }
        }
      }
    }

    // Store findings in database (async, non-blocking)
    this.storeFindingsAsync(params, findings);

    return {
      findings,
      scannedAt: new Date(),
      filePath: params.filePath,
      toolName: 'code_analysis',
    };
  }

  /**
   * Analyze Bash command for security issues
   * Called when Bash tool completes
   */
  async analyzeBashCommand(params: {
    taskId: string;
    executionId?: string;
    toolCallId?: string;
    command: string;
    output?: string;
    exitCode?: number;
    agentType?: string;
    phaseName?: string;
  }): Promise<AnalysisResult> {
    const findings: SecurityFinding[] = [];
    const allPatterns = [...BASH_PATTERNS, ...DEPENDENCY_PATTERNS];

    for (const pattern of allPatterns) {
      for (const regex of pattern.patterns) {
        const match = params.command.match(regex);
        if (match) {
          // Check exclude patterns
          let isExcluded = false;
          if (pattern.excludePatterns) {
            for (const excludeRegex of pattern.excludePatterns) {
              if (excludeRegex.test(params.command)) {
                isExcluded = true;
                break;
              }
            }
          }

          if (!isExcluded) {
            findings.push({
              pattern,
              match: match[0],
              context: params.command,
            });
          }
        }
      }
    }

    // Also check command output for secrets that might have been exposed
    if (params.output) {
      const secretPatterns = CODE_PATTERNS.filter(p => p.category === 'secrets');
      for (const pattern of secretPatterns) {
        for (const regex of pattern.patterns) {
          const match = params.output.match(regex);
          if (match) {
            findings.push({
              pattern: {
                ...pattern,
                id: `output-${pattern.id}`,
                name: `${pattern.name} (in output)`,
                description: `${pattern.description} - Found in command output`,
              },
              match: match[0].substring(0, 50) + '...', // Truncate for safety
              context: 'Command output contained potential secret',
            });
          }
        }
      }
    }

    // Store findings in database (async, non-blocking)
    this.storeFindingsAsync(params, findings);

    return {
      findings,
      scannedAt: new Date(),
      toolName: 'bash_analysis',
    };
  }

  /**
   * Analyze a tool call result
   * Entry point called by ExecutionTracker or AgentExecutorService
   */
  async analyzeToolResult(params: {
    taskId: string;
    executionId?: string;
    toolCallId?: string;
    toolName: string;
    toolInput: any;
    toolOutput: string;
    toolSuccess: boolean;
    agentType?: string;
    phaseName?: string;
  }): Promise<void> {
    // Non-blocking: wrap in promise and don't await
    const analysisPromise = this.performToolAnalysis(params);
    this.pendingAnalysis.set(params.toolCallId || params.taskId, analysisPromise);

    // Clean up after completion
    analysisPromise.finally(() => {
      this.pendingAnalysis.delete(params.toolCallId || params.taskId);
    });
  }

  private async performToolAnalysis(params: {
    taskId: string;
    executionId?: string;
    toolCallId?: string;
    toolName: string;
    toolInput: any;
    toolOutput: string;
    toolSuccess: boolean;
    agentType?: string;
    phaseName?: string;
  }): Promise<void> {
    try {
      const { toolName, toolInput, toolOutput } = params;

      // 1. Traditional code analysis based on tool type
      if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
        const filePath = toolInput?.file_path || toolInput?.path || toolInput?.notebook_path;
        const content = toolInput?.content || toolInput?.new_string || '';

        if (filePath && content) {
          await this.analyzeCode({
            taskId: params.taskId,
            executionId: params.executionId,
            toolCallId: params.toolCallId,
            filePath,
            content,
            agentType: params.agentType,
            phaseName: params.phaseName,
          });
        }
      } else if (toolName === 'Bash' || toolName === 'sandbox_bash') {
        const command = toolInput?.command || '';

        await this.analyzeBashCommand({
          taskId: params.taskId,
          executionId: params.executionId,
          toolCallId: params.toolCallId,
          command,
          output: toolOutput,
          agentType: params.agentType,
          phaseName: params.phaseName,
        });
      }

      // 2. AI Agent-specific threat detection
      await this.analyzeForAgentThreats(params);

    } catch (error: any) {
      console.warn(`[SecurityAgent] Analysis error (non-blocking): ${error.message}`);
    }
  }

  /**
   * Analyze for AI Agent-specific threats
   * Detects prompt injection, jailbreak, tool abuse, etc.
   */
  private async analyzeForAgentThreats(params: {
    taskId: string;
    executionId?: string;
    toolCallId?: string;
    toolName: string;
    toolInput: any;
    toolOutput: string;
    agentType?: string;
    phaseName?: string;
  }): Promise<void> {
    const threats: AgentThreatFinding[] = [];

    // Analyze tool input for threats
    const inputStr = typeof params.toolInput === 'string'
      ? params.toolInput
      : JSON.stringify(params.toolInput || {});

    // Determine context based on tool type
    const inputContext: 'tool_input' | 'bash_command' =
      (params.toolName === 'Bash' || params.toolName === 'sandbox_bash')
        ? 'bash_command'
        : 'tool_input';

    const inputThreats = detectThreats(inputStr, inputContext);
    for (const threat of inputThreats) {
      threats.push({
        pattern: threat.pattern,
        matchedIndicator: threat.matchedIndicator,
        context: inputContext,
        detectedIn: inputStr.substring(0, 200),
      });
    }

    // Analyze tool output for data exfiltration
    if (params.toolOutput) {
      const outputThreats = detectThreats(params.toolOutput, 'tool_output');
      for (const threat of outputThreats) {
        threats.push({
          pattern: threat.pattern,
          matchedIndicator: threat.matchedIndicator,
          context: 'tool_output',
          detectedIn: params.toolOutput.substring(0, 200),
        });
      }
    }

    // Store agent threats
    if (threats.length > 0) {
      await this.storeAgentThreatsAsync(params, threats);
    }
  }

  /**
   * Store agent-specific threats in database
   */
  private async storeAgentThreatsAsync(
    params: {
      taskId: string;
      executionId?: string;
      toolCallId?: string;
      agentType?: string;
      phaseName?: string;
    },
    threats: AgentThreatFinding[]
  ): Promise<void> {
    setImmediate(async () => {
      try {
        for (const threat of threats) {
          // Map agent threat category to security observation category
          const category = this.mapAgentCategoryToSecurityCategory(threat.pattern.category);

          SecurityObservationRepository.create({
            taskId: params.taskId,
            executionId: params.executionId,
            toolCallId: params.toolCallId,
            observationType: threat.pattern.severity === 'critical' || threat.pattern.severity === 'high'
              ? 'vulnerability'
              : 'warning',
            category,
            severity: threat.pattern.severity,
            codeSnippet: threat.detectedIn,
            description: `[AI Agent Threat] ${threat.pattern.name}: ${threat.pattern.description}. Matched: "${threat.matchedIndicator}" in ${threat.context}`,
            recommendation: threat.pattern.recommendation,
            agentType: params.agentType,
            phaseName: params.phaseName,
          });
        }

        console.log(`[SecurityAgent] Found ${threats.length} AI agent threats for task ${params.taskId}`);
      } catch (error: any) {
        console.warn(`[SecurityAgent] Failed to store agent threats: ${error.message}`);
      }
    });
  }

  /**
   * Map agent threat category to existing security category
   */
  private mapAgentCategoryToSecurityCategory(agentCategory: AgentThreatCategory): SecurityCategory {
    const mapping: Record<AgentThreatCategory, SecurityCategory> = {
      'prompt_injection': 'injection',
      'jailbreak': 'auth_bypass',
      'role_manipulation': 'auth_bypass',
      'instruction_override': 'injection',
      'data_exfiltration': 'sensitive_data',
      'tool_abuse': 'command_injection',
      'execution_anomaly': 'other',
      'context_manipulation': 'injection',
      'output_manipulation': 'sensitive_data',
      'resource_abuse': 'other',
    };
    return mapping[agentCategory] || 'other';
  }

  /**
   * Store findings in database asynchronously
   */
  private async storeFindingsAsync(
    params: {
      taskId: string;
      executionId?: string;
      toolCallId?: string;
      filePath?: string;
      agentType?: string;
      phaseName?: string;
    },
    findings: SecurityFinding[]
  ): Promise<void> {
    // Run in background - don't block
    setImmediate(async () => {
      try {
        for (const finding of findings) {
          SecurityObservationRepository.create({
            taskId: params.taskId,
            executionId: params.executionId,
            toolCallId: params.toolCallId,
            observationType: this.severityToObservationType(finding.pattern.severity),
            category: finding.pattern.category,
            severity: finding.pattern.severity,
            filePath: params.filePath,
            lineNumber: finding.lineNumber,
            codeSnippet: finding.context,
            description: `${finding.pattern.name}: ${finding.pattern.description}`,
            recommendation: finding.pattern.recommendation,
            owaspCategory: finding.pattern.owaspCategory,
            cweId: finding.pattern.cweId,
            agentType: params.agentType,
            phaseName: params.phaseName,
          });
        }

        if (findings.length > 0) {
          console.log(`[SecurityAgent] Found ${findings.length} security issues for task ${params.taskId}`);
        }
      } catch (error: any) {
        console.warn(`[SecurityAgent] Failed to store findings: ${error.message}`);
      }
    });
  }

  private severityToObservationType(severity: Severity): ObservationType {
    switch (severity) {
      case 'critical':
      case 'high':
        return 'vulnerability';
      case 'medium':
        return 'warning';
      case 'low':
        return 'info';
      default:
        return 'info';
    }
  }

  private getContext(lines: string[], lineIndex: number, contextLines: number): string {
    const start = Math.max(0, lineIndex - contextLines);
    const end = Math.min(lines.length, lineIndex + contextLines + 1);
    return lines.slice(start, end).join('\n');
  }

  /**
   * Generate security report for a task
   * Called at the end of task execution or on demand
   */
  async generateReport(taskId: string): Promise<SecurityReport> {
    const observations = SecurityObservationRepository.findByTaskId(taskId);
    const summary = SecurityObservationRepository.getSummary(taskId);

    // Group findings by category for recommendations
    const categoryGroups = new Map<SecurityCategory, number>();
    for (const obs of observations) {
      const count = categoryGroups.get(obs.category) || 0;
      categoryGroups.set(obs.category, count + 1);
    }

    // Generate prioritized recommendations
    const recommendations: string[] = [];

    if (summary.critical > 0) {
      recommendations.push('URGENT: Address all critical vulnerabilities before deployment');
    }

    if (categoryGroups.has('secrets')) {
      recommendations.push('Remove all hardcoded secrets and use environment variables or a secrets manager');
    }

    if (categoryGroups.has('injection') || categoryGroups.has('command_injection')) {
      recommendations.push('Implement input validation and use parameterized queries/safe APIs');
    }

    if (categoryGroups.has('xss')) {
      recommendations.push('Sanitize all user input before rendering and use Content Security Policy');
    }

    if (categoryGroups.has('eval')) {
      recommendations.push('Replace eval() and dynamic code execution with safer alternatives');
    }

    if (categoryGroups.has('insecure_config')) {
      recommendations.push('Review and harden security configurations (CORS, cookies, SSL)');
    }

    if (categoryGroups.has('path_traversal')) {
      recommendations.push('Validate and sanitize file paths to prevent directory traversal');
    }

    return {
      taskId,
      generatedAt: new Date(),
      summary: {
        total: summary.total,
        critical: summary.critical,
        high: summary.high,
        medium: summary.medium,
        low: summary.low,
      },
      vulnerabilities: observations
        .filter(obs => !obs.falsePositive)
        .map(obs => ({
          id: obs.id,
          category: obs.category,
          severity: obs.severity,
          description: obs.description,
          location: obs.filePath ? {
            filePath: obs.filePath,
            lineNumber: obs.lineNumber,
            codeSnippet: obs.codeSnippet,
          } : undefined,
          recommendation: obs.recommendation || '',
          owaspCategory: obs.owaspCategory,
          cweId: obs.cweId,
        })),
      recommendations,
    };
  }

  /**
   * Wait for all pending analyses to complete
   * Called at task completion to ensure all findings are stored
   */
  async waitForPendingAnalyses(): Promise<void> {
    const pending = Array.from(this.pendingAnalysis.values());
    if (pending.length > 0) {
      await Promise.all(pending);
    }
  }

  /**
   * Quick check if a task has critical/high findings
   * Used by pipeline to decide if security review is needed
   */
  hasCriticalFindings(taskId: string): boolean {
    const summary = SecurityObservationRepository.getSummary(taskId);
    return summary.critical > 0 || summary.high > 0;
  }

  /**
   * Get findings count by severity
   */
  getFindingsCount(taskId: string): { critical: number; high: number; medium: number; low: number } {
    const summary = SecurityObservationRepository.getSummary(taskId);
    return {
      critical: summary.critical,
      high: summary.high,
      medium: summary.medium,
      low: summary.low,
    };
  }

  // ============================================
  // AI AGENT-SPECIFIC ANALYSIS METHODS
  // ============================================

  /**
   * Analyze a prompt for injection attempts
   * Called at the start of agent execution
   */
  async analyzePrompt(params: {
    taskId: string;
    executionId?: string;
    prompt: string;
    agentType?: string;
    phaseName?: string;
  }): Promise<AgentThreatFinding[]> {
    const threats: AgentThreatFinding[] = [];

    // Detect prompt injection patterns
    const detectedThreats = detectThreats(params.prompt, 'prompt');

    for (const threat of detectedThreats) {
      threats.push({
        pattern: threat.pattern,
        matchedIndicator: threat.matchedIndicator,
        context: 'prompt',
        detectedIn: params.prompt.substring(0, 500),
      });
    }

    // Store threats asynchronously
    if (threats.length > 0) {
      await this.storeAgentThreatsAsync({
        taskId: params.taskId,
        executionId: params.executionId,
        agentType: params.agentType,
        phaseName: params.phaseName,
      }, threats);

      console.log(`[SecurityAgent] Detected ${threats.length} prompt injection attempts in task ${params.taskId}`);
    }

    return threats;
  }

  /**
   * Analyze turn content for manipulation attempts
   * Called after each turn completes
   */
  async analyzeTurnContent(params: {
    taskId: string;
    executionId?: string;
    turnId?: string;
    content: string;
    turnNumber: number;
    agentType?: string;
    phaseName?: string;
  }): Promise<AgentThreatFinding[]> {
    const threats: AgentThreatFinding[] = [];

    // Detect context manipulation and other patterns in turn content
    const detectedThreats = detectThreats(params.content, 'turn_content');

    for (const threat of detectedThreats) {
      threats.push({
        pattern: threat.pattern,
        matchedIndicator: threat.matchedIndicator,
        context: 'turn_content',
        detectedIn: `Turn ${params.turnNumber}: ${params.content.substring(0, 300)}`,
      });
    }

    // Store threats asynchronously
    if (threats.length > 0) {
      await this.storeAgentThreatsAsync({
        taskId: params.taskId,
        executionId: params.executionId,
        toolCallId: params.turnId, // Use turnId as toolCallId for reference
        agentType: params.agentType,
        phaseName: params.phaseName,
      }, threats);
    }

    return threats;
  }

  /**
   * Analyze full execution for sequence anomalies
   * Called at the end of execution to detect suspicious patterns
   */
  async analyzeExecutionSequence(params: {
    taskId: string;
    executionId?: string;
    toolCalls: Array<{ toolName: string; toolInput: any; toolOutput?: string }>;
    agentType?: string;
    phaseName?: string;
  }): Promise<Array<{ pattern: AgentSecurityPattern; description: string }>> {
    // Use the sequence analyzer
    const anomalies = analyzeToolSequence(params.toolCalls);

    // Store anomalies as security observations
    if (anomalies.length > 0) {
      setImmediate(async () => {
        try {
          for (const anomaly of anomalies) {
            const category = this.mapAgentCategoryToSecurityCategory(anomaly.pattern.category);

            SecurityObservationRepository.create({
              taskId: params.taskId,
              executionId: params.executionId,
              observationType: 'vulnerability',
              category,
              severity: anomaly.pattern.severity,
              description: `[Execution Anomaly] ${anomaly.pattern.name}: ${anomaly.description}`,
              recommendation: anomaly.pattern.recommendation,
              agentType: params.agentType,
              phaseName: params.phaseName,
            });
          }

          console.log(`[SecurityAgent] Found ${anomalies.length} execution anomalies in task ${params.taskId}`);
        } catch (error: any) {
          console.warn(`[SecurityAgent] Failed to store anomalies: ${error.message}`);
        }
      });
    }

    return anomalies;
  }

  /**
   * Get all agent-specific threats for a task
   * Filters to only show AI agent threats (not traditional code vulnerabilities)
   */
  getAgentThreats(taskId: string): Array<{
    id: string;
    category: string;
    severity: Severity;
    description: string;
    detectedAt: Date;
  }> {
    const observations = SecurityObservationRepository.findByTaskId(taskId);

    // Filter for AI agent threats (description starts with [AI Agent Threat] or [Execution Anomaly])
    return observations
      .filter(obs =>
        obs.description.startsWith('[AI Agent Threat]') ||
        obs.description.startsWith('[Execution Anomaly]')
      )
      .map(obs => ({
        id: obs.id,
        category: obs.category,
        severity: obs.severity,
        description: obs.description,
        detectedAt: obs.detectedAt,
      }));
  }
}

// Export singleton
export const securityAgentService = new SecurityAgentServiceClass();
export default securityAgentService;
