/**
 * Shared dependencies for task routes
 *
 * Common imports, schemas, and utilities used across all task route modules.
 */

import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { authenticate, AuthRequest } from '../../middleware/auth';
import { uploadMultipleImages } from '../../middleware/upload';
import { Task } from '../../models/Task';
import { Repository } from '../../models/Repository';
import { OrchestrationCoordinator } from '../../services/orchestration/OrchestrationCoordinator';
import { storageService } from '../../services/storage/StorageService';
import { unifiedMemoryService } from '../../services/UnifiedMemoryService';
import { granularMemoryService } from '../../services/GranularMemoryService';

// Re-export commonly used items
export {
  Router,
  z,
  mongoose,
  authenticate,
  AuthRequest,
  uploadMultipleImages,
  Task,
  Repository,
  storageService,
  unifiedMemoryService,
  granularMemoryService,
};

// Shared orchestration coordinator instance
export const orchestrationCoordinator = new OrchestrationCoordinator();

// ═══════════════════════════════════════════════════════════════════════════════
// Validation Schemas
// ═══════════════════════════════════════════════════════════════════════════════

export const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  projectId: z.string().optional(),
  repositoryIds: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  modelConfig: z.enum(['standard', 'premium', 'recommended', 'balanced', 'economy', 'max']).optional(),
});

export const startTaskSchema = z.object({
  description: z.string().optional(),
  content: z.string().optional(),
  instructions: z.string().optional(),
});

export const approvePhaseSchema = z.object({
  approved: z.boolean(),
  comments: z.string().optional(),
});

export const continueTaskSchema = z.object({
  additionalRequirements: z.string().min(1, 'Additional requirements are required'),
});

export const autoApprovalConfigSchema = z.object({
  enabled: z.boolean(),
  phases: z.array(
    z.enum([
      'planning',
      'team-orchestration',
      'recovery',
      'integration',
      'verification',
      'auto-merge',
      'tech-lead',
      'development',
      'judge',
      'verification-fixer',
    ])
  ).optional(),
  supervisorThreshold: z.number().min(0).max(100).optional(),
});

export const modelConfigSchema = z.object({
  preset: z.enum(['max', 'premium', 'recommended', 'standard', 'custom']).optional(),
  customConfig: z.object({
    planning: z.string().optional(),
    techLead: z.string().optional(),
    developer: z.string().optional(),
    judge: z.string().optional(),
    verification: z.string().optional(),
    autoMerge: z.string().optional(),
  }).optional(),
});

export const approveStorySchema = z.object({
  approved: z.boolean(),
  comments: z.string().optional(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate MongoDB ObjectId
 */
export function isValidObjectId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
}

/**
 * Get task by ID with user validation
 */
export async function getTaskByIdForUser(taskId: string, userId: string) {
  if (!isValidObjectId(taskId)) {
    return null;
  }
  return Task.findOne({ _id: taskId, userId });
}
