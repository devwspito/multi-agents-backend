/**
 * Memory Tools - MCP tools for agent memory/recall functionality
 * Extracted from extraTools.ts for better organization
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * Memory Recall Tool (Windsurf-style)
 * Retrieve relevant memories from past sessions
 */
export const memoryRecallTool = tool(
  'memory_recall',
  `Retrieve relevant memories from past sessions using semantic search.
ALWAYS call this at the START of every task to check for:
- Codebase patterns that were discovered before
- How similar errors were resolved
- Architectural decisions and their rationale
- Workflows that worked well

This helps avoid repeating mistakes and leverages past learnings.`,
  {
    projectId: z.string().describe('Project ID to search memories for'),
    query: z.string().describe('What you want to recall (semantic description)'),
    types: z.array(z.enum([
      'codebase_pattern',
      'error_resolution',
      'workflow_learned',
      'architecture_decision',
      'api_contract',
      'user_preference',
      'decision_rationale'
    ])).optional().describe('Filter by memory types'),
    limit: z.number().default(5).describe('Max memories to return'),
  },
  async (args) => {
    try {
      const { memoryService } = await import('../../services/MemoryService');

      const results = await memoryService.recall({
        projectId: args.projectId,
        query: args.query,
        types: args.types as any,
        limit: args.limit,
      });

      console.log(`\n🧠 [Memory Recall] Found ${results.length} relevant memories for "${args.query}"`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            query: args.query,
            memoriesFound: results.length,
            memories: results.map(r => ({
              id: r.memory._id,
              title: r.memory.title,
              type: r.memory.type,
              content: r.memory.content,
              importance: r.memory.importance,
              score: r.score,
              createdAt: r.memory.createdAt,
            })),
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message,
            suggestion: 'Memory service may not be initialized. Check MongoDB connection.',
          }, null, 2),
        }],
      };
    }
  }
);

/**
 * Memory Remember Tool (Windsurf-style)
 * Store learnings, patterns, and insights for future sessions
 */
export const memoryRememberTool = tool(
  'memory_remember',
  `Store a learning, pattern, or insight for future sessions.
Call this LIBERALLY when you discover:
- A codebase pattern that wasn't obvious
- How you resolved a tricky error
- A workflow that worked well
- An architectural decision and WHY
- User preferences for this project

Don't ask permission - just store valuable learnings!`,
  {
    projectId: z.string().describe('Project ID to store memory for'),
    type: z.enum([
      'codebase_pattern',
      'error_resolution',
      'workflow_learned',
      'architecture_decision',
      'api_contract',
      'user_preference',
      'decision_rationale'
    ]).describe('Type of memory'),
    title: z.string().describe('Short descriptive title'),
    content: z.string().describe('Detailed explanation of what you learned'),
    importance: z.enum(['low', 'medium', 'high', 'critical']).default('medium').describe('How important is this memory'),
    taskId: z.string().optional().describe('Current task ID for context'),
    agentType: z.string().optional().describe('Agent type storing this memory'),
  },
  async (args) => {
    try {
      const { memoryService } = await import('../../services/MemoryService');

      const memory = await memoryService.remember({
        projectId: args.projectId,
        type: args.type as any,
        title: args.title,
        content: args.content,
        importance: args.importance as any,
        source: {
          taskId: args.taskId,
          agentType: args.agentType,
        },
      });

      console.log(`\n🧠 [Memory Remember] Stored: "${args.title}" (${args.type}, ${args.importance})`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            memoryId: memory._id,
            title: args.title,
            type: args.type,
            importance: args.importance,
            message: 'Memory stored successfully. It will be available for future sessions.',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message,
          }, null, 2),
        }],
      };
    }
  }
);

/**
 * Memory Feedback Tool (Windsurf-style)
 * Mark a memory as useful or not useful
 */
export const memoryFeedbackTool = tool(
  'memory_feedback',
  'Provide feedback on a retrieved memory to improve future relevance.',
  {
    memoryId: z.string().describe('ID of the memory to provide feedback on'),
    wasUseful: z.boolean().describe('Whether the memory was useful'),
  },
  async (args) => {
    try {
      const { memoryService } = await import('../../services/MemoryService');

      await memoryService.feedback(args.memoryId, args.wasUseful);

      console.log(`\n🧠 [Memory Feedback] ${args.wasUseful ? '👍' : '👎'} for memory ${args.memoryId}`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            memoryId: args.memoryId,
            wasUseful: args.wasUseful,
            message: 'Feedback recorded. This helps improve future memory relevance.',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2),
        }],
      };
    }
  }
);
