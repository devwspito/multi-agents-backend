/**
 * Core Entity Types
 *
 * Centralized type definitions for main domain entities.
 * These replace scattered 'any' types throughout the codebase.
 */

import { StoryStatus, TaskStatus as TaskStatusType } from './status';
import { StoryComplexity } from './fields';

// ============================================================================
// Story
// ============================================================================

export interface Story {
  id: string;
  title: string;
  description?: string;
  status: StoryStatus;
  branchName?: string;
  targetRepository?: string;
  complexity?: StoryComplexity;
  assignedTo?: string;
  epicId?: string;
  mergedToEpic?: boolean;
  pullRequestUrl?: string;
  commitHash?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// ============================================================================
// Epic
// ============================================================================

export interface Epic {
  id: string;
  name: string;
  description?: string;
  status?: string;
  branchName?: string;
  targetRepository?: string;
  stories?: Story[] | string[];
  dependencies?: string[];
  priority?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

// ============================================================================
// Repository
// ============================================================================

export interface Repository {
  id?: string;
  name: string;
  full_name?: string;
  githubRepoName?: string;
  url?: string;
  clone_url?: string;
  default_branch?: string;
  owner?: string;
  private?: boolean;
}

// ============================================================================
// Developer / Team Member
// ============================================================================

export interface Developer {
  instanceId: string;
  agentType: string;
  assignedStories: string[];
  status: 'idle' | 'working' | 'completed' | 'failed';
  pullRequests?: string[];
}

// ============================================================================
// Task (Orchestration)
// ============================================================================

export interface Task {
  id: string;
  projectId?: string;
  title?: string;
  description?: string;
  status: TaskStatusType;
  orchestration?: TaskOrchestration;
  repositories?: Repository[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface TaskOrchestration {
  epics?: Epic[];
  stories?: Story[];
  team?: Developer[];
  developers?: PhaseExecutionStatus;
  judge?: PhaseExecutionStatus;
  merge?: PhaseExecutionStatus;
}

export interface PhaseExecutionStatus {
  status: string;
  error?: string;
  humanRequired?: boolean;
}

// ============================================================================
// Agent Execution
// ============================================================================

export interface AgentResult {
  success: boolean;
  output?: string;
  error?: string;
  data?: Record<string, unknown>;
  metadata?: AgentMetadata;
  metrics?: AgentMetrics;
}

export interface AgentMetadata {
  cost?: number;
  input_tokens?: number;
  output_tokens?: number;
  model?: string;
  duration_ms?: number;
}

export interface AgentMetrics {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

// ============================================================================
// Usage / Cost Tracking
// ============================================================================

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface CostResult {
  cost: number;
  tokens: {
    input: number;
    output: number;
  };
}

// ============================================================================
// Git Operations
// ============================================================================

export interface GitVerificationResult {
  hasCommits: boolean;
  commitCount: number;
  commitSHA: string | null;
  commitMessage?: string;
}

// ============================================================================
// Event Store State
// ============================================================================

export interface TaskState {
  epics: Epic[];
  stories: Story[];
  currentPhase?: string;
  team?: Developer[];
}
