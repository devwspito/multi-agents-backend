/**
 * Prompts Module
 *
 * Centralized exports for all prompt components.
 * Prompts are organized into:
 * - shared/: Reusable components (MCP tools docs, markers)
 * - Individual agent prompts (planned for future extraction)
 */

// Shared components
export * from './shared';

// Individual agent prompts
export { PLANNING_AGENT_PROMPT, PLANNING_AGENT_CONFIG } from './planning-agent';
