/**
 * Agent Permission Service
 *
 * Implements Skywork AI best practice:
 * "Start from deny-all; allowlist only the commands and directories a subagent needs"
 * "Require explicit confirmations for sensitive actions"
 * "Block dangerous commands"
 *
 * https://skywork.ai/blog/claude-agent-sdk-best-practices-ai-agents-2025/
 */

export interface AgentPermissions {
  allowedTools: string[];
  deniedCommands: string[];
  requiresApproval?: string[];
  allowedPaths?: string[]; // Optional: Restrict to specific directories
}

/**
 * Permission definitions per agent type
 *
 * Following "deny-all, allowlist" principle:
 * - Each agent gets ONLY the tools it needs
 * - Dangerous commands are explicitly blocked
 * - Sensitive operations require approval
 */
export const AGENT_PERMISSIONS: Record<string, AgentPermissions> = {
  /**
   * Problem Analyst
   * Needs: Research and analysis (read-only)
   */
  'problem-analyst': {
    allowedTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Bash'],
    deniedCommands: [
      'rm -rf',
      'sudo',
      'git push',
      'git merge',
      'npm publish',
      'docker rm',
      'kubectl delete',
    ],
    requiresApproval: [],
  },

  /**
   * Product Manager
   * Needs: Requirements analysis (read-only + light bash for project structure)
   */
  'product-manager': {
    allowedTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Bash'],
    deniedCommands: [
      'rm -rf',
      'sudo',
      'git push',
      'git merge',
      'npm publish',
      'docker rm',
      'kubectl delete',
    ],
    requiresApproval: [],
  },

  /**
   * Project Manager
   * Needs: Story planning (read-only + analysis)
   */
  'project-manager': {
    allowedTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Bash'],
    deniedCommands: [
      'rm -rf',
      'sudo',
      'git push',
      'git merge',
      'npm publish',
      'docker rm',
      'kubectl delete',
    ],
    requiresApproval: [],
  },

  /**
   * Tech Lead
   * Needs: Architecture design (read + light file creation for diagrams)
   */
  'tech-lead': {
    allowedTools: ['Read', 'Write', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Bash'],
    deniedCommands: [
      'rm -rf',
      'sudo',
      'git push',
      'git merge',
      'npm publish',
      'docker rm',
      'kubectl delete',
    ],
    requiresApproval: [],
  },

  /**
   * Developer
   * Needs: Full file operations, git, testing
   * APPROVAL: Phase-level (not command-level)
   * Once Phase approved → ALL commands execute automatically
   */
  'developer': {
    allowedTools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'],
    deniedCommands: [
      'rm -rf',
      'sudo',
      'npm publish',
      'docker rm',
      'kubectl delete',
      'git push --force',
      'git push -f',
      'git reset --hard',
    ],
    requiresApproval: [], // Phase-level approval, not command-level
  },

  /**
   * Judge
   * Needs: Code analysis (read-only)
   */
  'judge': {
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    deniedCommands: [
      'rm -rf',
      'sudo',
      'git push',
      'git merge',
      'npm publish',
      'docker rm',
      'kubectl delete',
    ],
    requiresApproval: [],
  },

  /**
   * QA Tester
   * Needs: Read code, run tests, analyze results
   */
  'qa': {
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    deniedCommands: [
      'rm -rf',
      'sudo',
      'git push',
      'git merge',
      'npm publish',
      'docker rm',
      'kubectl delete',
    ],
    requiresApproval: [],
  },

  /**
   * Fixer
   * Needs: Full file operations to fix issues
   * APPROVAL: Phase-level (not command-level)
   */
  'fixer': {
    allowedTools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'],
    deniedCommands: [
      'rm -rf',
      'sudo',
      'npm publish',
      'docker rm',
      'kubectl delete',
      'git push --force',
      'git reset --hard',
    ],
    requiresApproval: [], // Phase-level approval, not command-level
  },

  /**
   * E2E Tester
   * Needs: Read code, run e2e tests
   */
  'e2e': {
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    deniedCommands: [
      'rm -rf',
      'sudo',
      'git push',
      'git merge',
      'npm publish',
      'docker rm',
      'kubectl delete',
    ],
    requiresApproval: [],
  },

  /**
   * Contract Fixer
   * Needs: Full file operations to fix contract issues
   */
  'contract-fixer': {
    allowedTools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'],
    deniedCommands: [
      'rm -rf',
      'sudo',
      'npm publish',
      'docker rm',
      'kubectl delete',
      'git push --force',
      'git reset --hard',
    ],
    requiresApproval: [
      'git push',
      'git merge',
    ],
  },
};

/**
 * Permission Violation Error
 */
export class PermissionViolationError extends Error {
  constructor(
    public agentType: string,
    public violation: 'tool_denied' | 'command_blocked' | 'approval_required',
    public details: string
  ) {
    super(`Permission violation for ${agentType}: ${details}`);
    this.name = 'PermissionViolationError';
  }
}

/**
 * Agent Permission Service
 */
export class AgentPermissionService {
  /**
   * Check if an agent is allowed to use a tool
   */
  static isToolAllowed(agentType: string, tool: string): boolean {
    const permissions = AGENT_PERMISSIONS[agentType];
    if (!permissions) {
      console.warn(`⚠️  [Permissions] No permissions defined for agent type: ${agentType}, allowing all tools`);
      return true; // Fallback: allow if no permissions defined
    }

    return permissions.allowedTools.includes(tool);
  }

  /**
   * Check if a bash command is allowed (not blocked)
   */
  static isCommandAllowed(agentType: string, command: string): boolean {
    const permissions = AGENT_PERMISSIONS[agentType];
    if (!permissions) {
      return true; // Fallback: allow if no permissions defined
    }

    // Check if command contains any denied patterns
    for (const denied of permissions.deniedCommands) {
      if (command.includes(denied)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if a command requires approval
   */
  static requiresApproval(agentType: string, command: string): boolean {
    const permissions = AGENT_PERMISSIONS[agentType];
    if (!permissions || !permissions.requiresApproval) {
      return false;
    }

    // Check if command contains any approval-required patterns
    for (const pattern of permissions.requiresApproval) {
      if (command.includes(pattern)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Validate tool use (throws if not allowed)
   */
  static validateToolUse(agentType: string, tool: string, input?: any): void {
    // Check tool permission
    if (!this.isToolAllowed(agentType, tool)) {
      throw new PermissionViolationError(
        agentType,
        'tool_denied',
        `Agent ${agentType} is not allowed to use tool ${tool}. Allowed tools: ${AGENT_PERMISSIONS[agentType]?.allowedTools.join(', ')}`
      );
    }

    // Check bash command permission
    if (tool === 'Bash' && input?.command) {
      const command = input.command;

      // Check if command is blocked
      if (!this.isCommandAllowed(agentType, command)) {
        throw new PermissionViolationError(
          agentType,
          'command_blocked',
          `Command blocked for security: ${command}`
        );
      }

      // Check if command requires approval
      if (this.requiresApproval(agentType, command)) {
        throw new PermissionViolationError(
          agentType,
          'approval_required',
          `Command requires explicit approval: ${command}`
        );
      }
    }
  }

  /**
   * Get permissions for an agent type
   */
  static getPermissions(agentType: string): AgentPermissions | null {
    return AGENT_PERMISSIONS[agentType] || null;
  }

  /**
   * Get allowed tools for SDK configuration
   */
  static getAllowedTools(agentType: string): string[] | undefined {
    const permissions = AGENT_PERMISSIONS[agentType];
    return permissions?.allowedTools;
  }

  /**
   * Log permission check for debugging
   */
  static logPermissionCheck(
    agentType: string,
    tool: string,
    allowed: boolean,
    input?: any
  ): void {
    if (!allowed) {
      console.error(`🚫 [Permissions] DENIED - ${agentType} attempted to use ${tool}`);
      if (input) {
        console.error(`   Input:`, JSON.stringify(input, null, 2));
      }
    }
  }
}

/**
 * Approval Queue for sensitive operations
 *
 * When an agent attempts a sensitive operation, it's queued for approval.
 * The orchestrator can approve/reject these operations.
 */
export interface ApprovalRequest {
  id: string;
  agentType: string;
  taskId: string;
  command: string;
  timestamp: Date;
  status: 'pending' | 'approved' | 'rejected';
  approvedBy?: string;
  reason?: string;
}

export class ApprovalQueue {
  private queue: Map<string, ApprovalRequest> = new Map();
  private nextId: number = 1;

  /**
   * Add approval request
   */
  addRequest(agentType: string, taskId: string, command: string): ApprovalRequest {
    const id = `approval-${this.nextId++}`;
    const request: ApprovalRequest = {
      id,
      agentType,
      taskId,
      command,
      timestamp: new Date(),
      status: 'pending',
    };

    this.queue.set(id, request);
    console.log(`⏸️  [Approvals] New approval request:`, {
      id,
      agentType,
      command: command.substring(0, 100),
    });

    return request;
  }

  /**
   * Approve a request
   */
  approve(id: string, approvedBy: string): boolean {
    const request = this.queue.get(id);
    if (!request) return false;

    request.status = 'approved';
    request.approvedBy = approvedBy;

    console.log(`✅ [Approvals] Request approved:`, { id, approvedBy });
    return true;
  }

  /**
   * Reject a request
   */
  reject(id: string, reason: string): boolean {
    const request = this.queue.get(id);
    if (!request) return false;

    request.status = 'rejected';
    request.reason = reason;

    console.log(`❌ [Approvals] Request rejected:`, { id, reason });
    return true;
  }

  /**
   * Get pending requests
   */
  getPendingRequests(): ApprovalRequest[] {
    return Array.from(this.queue.values()).filter((r) => r.status === 'pending');
  }

  /**
   * Check request status
   */
  getRequestStatus(id: string): 'pending' | 'approved' | 'rejected' | 'not_found' {
    const request = this.queue.get(id);
    return request ? request.status : 'not_found';
  }

  /**
   * Clear old requests
   */
  clearOldRequests(olderThanMinutes: number = 60): void {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
    for (const [id, request] of this.queue.entries()) {
      if (request.timestamp < cutoff && request.status !== 'pending') {
        this.queue.delete(id);
      }
    }
  }
}

// Singleton approval queue
export const approvalQueue = new ApprovalQueue();
