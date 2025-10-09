import mongoose, { Document, Schema } from 'mongoose';

export interface IRepository extends Document {
  name: string;
  description?: string;
  projectId: mongoose.Types.ObjectId;

  // GitHub integration
  githubRepoUrl: string;
  githubRepoName: string; // e.g., "user/repo"
  githubBranch: string; // default branch to work on

  // Workspace
  workspaceId: string; // unique ID for this repository's workspace

  // Metadata
  isActive: boolean;
  lastSyncedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const repositorySchema = new Schema<IRepository>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
      index: true,
    },
    githubRepoUrl: {
      type: String,
      required: true,
      validate: {
        validator: (url: string) => {
          return /^https:\/\/github\.com\/[\w-]+\/[\w-]+/.test(url);
        },
        message: 'Invalid GitHub repository URL',
      },
    },
    githubRepoName: {
      type: String,
      required: true,
      // Format: "owner/repo"
      validate: {
        validator: (name: string) => {
          return /^[\w-]+\/[\w-]+$/.test(name);
        },
        message: 'Invalid GitHub repository name format (should be owner/repo).',
      },
    },
    githubBranch: {
      type: String,
      default: 'main',
    },
    workspaceId: {
      type: String,
      required: true,
      unique: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    lastSyncedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient queries
repositorySchema.index({ projectId: 1, isActive: 1 });

export const Repository = mongoose.model<IRepository>('Repository', repositorySchema);
