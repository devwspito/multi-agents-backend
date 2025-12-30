/**
 * Agent Permission Service
 *
 * Implements Skywork AI best practice:
 * "Start from deny-all; allowlist only the commands and directories a subagent needs"
 * "Require explicit confirmations for sensitive actions"
 * "Block dangerous commands"
 *
 * https://skywork.ai/blog/claude-agent-sdk-best-practices-ai-agents-2025/
 *
 * NOTE: SDK has its own permission model via bypassPermissions/permissionMode.
 * This service provides additional domain-specific validation.
 */

export interface AgentPermissions {
  allowedTools: string[];
  deniedCommands: string[];
  allowedCommands?: string[]; // Whitelist of specific commands (curl, wget, etc.)
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
   * Planning Agent (Unified)
   * Combines: Problem Analyst + Product Manager + Project Manager
   * Needs: Read-only exploration (permissionMode: 'plan')
   */
  'planning-agent': {
    allowedTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Bash', 'execute_command'],
    allowedCommands: ['curl', 'wget', 'npm', 'node', 'git', 'cat', 'ls', 'grep', 'find', 'tree'],
    deniedCommands: [
      'rm -rf',
      'sudo',
      'git push',
      'git merge',
      'git commit',
      'npm publish',
      'docker rm',
      'kubectl delete',
    ],
    requiresApproval: [],
  },

  /**
   * Problem Analyst (Legacy)
   * Needs: Research and analysis (read-only)
   */
  'problem-analyst': {
    allowedTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Bash', 'execute_command'],
    allowedCommands: ['curl', 'wget', 'npm', 'node', 'git', 'cat', 'ls', 'grep', 'find'],
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
    allowedTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Bash', 'execute_command'],
    allowedCommands: ['curl', 'wget', 'npm', 'node', 'git', 'cat', 'ls', 'grep', 'find'],
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
   * Needs: Full file operations, git, testing, external commands
   * APPROVAL: Phase-level (not command-level)
   * Once Phase approved → ALL commands execute automatically
   */
  'developer': {
    allowedTools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash', 'WebFetch'],
    allowedCommands: ['curl', 'wget', 'npm', 'node', 'git', 'python', 'python3', 'tsc', 'jest', 'eslint', 'docker', 'cat', 'ls', 'grep', 'find', 'mkdir', 'cp', 'mv'],
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
    allowedCommands: ['npm', 'node', 'jest', 'curl', 'wget', 'git', 'cat', 'ls', 'grep', 'find'],
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
    allowedCommands: ['curl', 'wget', 'npm', 'node', 'git', 'python', 'python3', 'tsc', 'jest', 'eslint', 'cat', 'ls', 'grep', 'find', 'mkdir', 'cp', 'mv'],
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
   * Verification Fixer
   * Needs: Full file operations to fix verification issues (completeness/coherence)
   * Enhanced with WebFetch for documentation lookup and validation commands
   * APPROVAL: Phase-level (not command-level)
   */
  'verification-fixer': {
    allowedTools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch'],
    allowedCommands: [
      // File operations
      'curl', 'wget', 'cat', 'ls', 'grep', 'find', 'mkdir', 'cp', 'mv',
      // Package managers
      'npm', 'npx', 'yarn', 'pnpm', 'pip', 'pip3',
      // Build & test
      'node', 'python', 'python3', 'tsc', 'jest', 'vitest', 'mocha',
      'eslint', 'prettier', 'webpack', 'vite', 'esbuild',
      // Git (for commits)
      'git',
      // Validation
      'npm run build', 'npm run lint', 'npm run test', 'npm run typecheck',
      'npm install', 'npm ci',
    ],
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
   * Recovery Analyst (Opus)
   * Needs: Analysis capabilities to determine if errors are automatable
   * Read-only + light analysis
   */
  'recovery-analyst': {
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    allowedCommands: ['npm', 'node', 'cat', 'ls', 'grep', 'find', 'git'],
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

// Simple whitelist of allowed commands
const ALLOWED_COMMANDS = [
  'git', 'npm', 'npx', 'node', 'curl', 'wget', 'cat', 'ls', 'pwd', 'echo',
  'grep', 'find', 'mkdir', 'touch', 'cp', 'mv', 'rm', 'head', 'tail',
  'tsc', 'eslint', 'prettier', 'jest', 'vitest', 'mocha', 'pytest',
];

/**
 * Agent Permission Service
 */
export class AgentPermissionService {
  /**
   * Check if a command is in the global whitelist
   */
  private static isGloballyAllowed(command: string): boolean {
    const baseCommand = command.trim().split(/\s+/)[0].replace(/^.*\//, '');
    return ALLOWED_COMMANDS.includes(baseCommand);
  }

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
   * Check if an agent is allowed to execute a specific command (curl, wget, etc.)
   */
  static isSpecificCommandAllowed(agentType: string, command: string): boolean {
    const permissions = AGENT_PERMISSIONS[agentType];
    if (!permissions) {
      return true;
    }

    // If no allowedCommands specified, check against global whitelist
    if (!permissions.allowedCommands) {
      return this.isGloballyAllowed(command);
    }

    // Extract base command (first word)
    const baseCommand = command.trim().split(/\s+/)[0].replace(/^.*\//, '');

    // Check agent's specific allowed commands
    return permissions.allowedCommands.includes(baseCommand);
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

    // Check execute_command tool permission
    if ((tool === 'execute_command' || tool === 'execute_streaming_command') && input?.command) {
      const command = input.command;

      // Check if specific command is allowed for this agent
      if (!this.isSpecificCommandAllowed(agentType, command)) {
        throw new PermissionViolationError(
          agentType,
          'command_blocked',
          `Command not in allowed list for ${agentType}: ${command}`
        );
      }

      // Check if command is globally blocked
      if (!this.isCommandAllowed(agentType, command)) {
        throw new PermissionViolationError(
          agentType,
          'command_blocked',
          `Command blocked for security: ${command}`
        );
      }

      // Additional global whitelist validation
      if (!this.isGloballyAllowed(command)) {
        throw new PermissionViolationError(
          agentType,
          'command_blocked',
          `Command not in global whitelist: ${command}`
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
