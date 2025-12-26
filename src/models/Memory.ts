import mongoose, { Document, Schema } from 'mongoose';

/**
 * Memory Types - Categories of things agents can remember
 */
export type MemoryType =
  | 'codebase_pattern'      // Patterns discovered in the codebase
  | 'error_resolution'      // How an error was resolved
  | 'user_preference'       // User/project preferences
  | 'architecture_decision' // Architectural decisions made
  | 'api_contract'          // API contracts discovered
  | 'test_pattern'          // Testing patterns
  | 'dependency_info'       // Dependency information
  | 'workflow_learned'      // Workflows learned from past tasks
  | 'agent_insight';        // General insights from agents

/**
 * Memory Importance - How important is this memory
 */
export type MemoryImportance = 'low' | 'medium' | 'high' | 'critical';

/**
 * Memory Interface
 */
export interface IMemory extends Document {
  // Core fields
  projectId: mongoose.Types.ObjectId;
  type: MemoryType;
  importance: MemoryImportance;

  // Content
  title: string;           // Short summary (for display)
  content: string;         // Full content of the memory
  context?: string;        // Additional context (file paths, error messages, etc.)

  // Vector embedding for semantic search
  embedding?: number[];    // Vector embedding (1536 dimensions for OpenAI, 1024 for Voyage)
  embeddingModel?: string; // Model used to generate embedding

  // Metadata
  source: {
    taskId?: mongoose.Types.ObjectId;
    phase?: string;
    agentType?: string;
  };

  // Usage tracking
  accessCount: number;     // How many times this memory was retrieved
  lastAccessedAt?: Date;   // Last time this memory was useful
  usefulness: number;      // Score from 0-1 based on agent feedback

  // Lifecycle
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;        // Optional expiration (for temporary memories)
  archived: boolean;       // Soft delete
}

/**
 * Memory Schema
 */
const MemorySchema = new Schema<IMemory>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: [
        'codebase_pattern',
        'error_resolution',
        'user_preference',
        'architecture_decision',
        'api_contract',
        'test_pattern',
        'dependency_info',
        'workflow_learned',
        'agent_insight',
      ],
      required: true,
      index: true,
    },
    importance: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium',
    },

    // Content
    title: {
      type: String,
      required: true,
      maxlength: 200,
    },
    content: {
      type: String,
      required: true,
      maxlength: 10000, // 10KB max per memory
    },
    context: {
      type: String,
      maxlength: 5000,
    },

    // Vector embedding for semantic search
    // MongoDB Atlas Vector Search requires this format
    embedding: {
      type: [Number],
      index: false, // We'll create a vector index separately
    },
    embeddingModel: {
      type: String,
    },

    // Source tracking
    source: {
      taskId: { type: Schema.Types.ObjectId, ref: 'Task' },
      phase: String,
      agentType: String,
    },

    // Usage tracking
    accessCount: {
      type: Number,
      default: 0,
    },
    lastAccessedAt: Date,
    usefulness: {
      type: Number,
      default: 0.5, // Start neutral
      min: 0,
      max: 1,
    },

    // Lifecycle
    expiresAt: Date,
    archived: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for common queries
MemorySchema.index({ projectId: 1, type: 1, archived: 1 });
MemorySchema.index({ projectId: 1, importance: 1, archived: 1 });
MemorySchema.index({ projectId: 1, createdAt: -1 });

// Text index for fallback text search (when embeddings aren't available)
MemorySchema.index({ title: 'text', content: 'text' });

/**
 * NOTE: For MongoDB Atlas Vector Search, you need to create a vector index
 * in the Atlas UI or via the Atlas API. The index definition should be:
 *
 * {
 *   "name": "memory_vector_index",
 *   "type": "vectorSearch",
 *   "definition": {
 *     "fields": [
 *       {
 *         "type": "vector",
 *         "path": "embedding",
 *         "numDimensions": 1536,  // or 1024 for Voyage
 *         "similarity": "cosine"
 *       },
 *       {
 *         "type": "filter",
 *         "path": "projectId"
 *       },
 *       {
 *         "type": "filter",
 *         "path": "archived"
 *       }
 *     ]
 *   }
 * }
 */

export const Memory = mongoose.model<IMemory>('Memory', MemorySchema);
