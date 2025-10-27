import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { Project } from '../models/Project';
import { Repository } from '../models/Repository';
import { WebhookApiKey } from '../models/WebhookApiKey';
import { GitHubService } from '../services/GitHubService';
import { z } from 'zod';
import path from 'path';
import os from 'os';

const router = Router();
const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
const githubService = new GitHubService(workspaceDir);

// Validación schemas con Zod
const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  type: z.string().optional(),
  repositories: z.array(z.object({
    id: z.number(),
    name: z.string(),
    full_name: z.string(),
    clone_url: z.string(),
    ssh_url: z.string().optional(),
    default_branch: z.string().optional(),
    language: z.string().optional(),
    html_url: z.string().optional(),
    owner: z.any().optional(),
    type: z.enum(['backend', 'frontend']), // Repository type (required)
  })).optional(),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
});

/**
 * Generate default pathPatterns and executionOrder based on repository type
 */
function getRepositoryConfig(type: 'backend' | 'frontend' | 'mobile' | 'shared', repoName: string) {
  const config = {
    backend: {
      pathPatterns: [
        'backend/**/*',
        'src/models/**/*',
        'src/routes/**/*',
        'src/services/**/*',
        'src/middleware/**/*',
        'src/utils/**/*',
        'src/app.js',
        'src/app.ts',
        'server.js',
        'server.ts',
      ],
      executionOrder: 1,
    },
    frontend: {
      pathPatterns: [
        `${repoName}/**/*`,
        'src/components/**/*',
        'src/views/**/*',
        'src/pages/**/*',
        'src/hooks/**/*',
        'src/contexts/**/*',
        'src/services/**/*',
        'src/styles/**/*',
        'public/**/*',
      ],
      executionOrder: 2,
    },
    mobile: {
      pathPatterns: [
        `${repoName}/**/*`,
        'src/**/*',
        'ios/**/*',
        'android/**/*',
      ],
      executionOrder: 3,
    },
    shared: {
      pathPatterns: [
        'shared/**/*',
        'lib/**/*',
        'types/**/*',
        'common/**/*',
      ],
      executionOrder: 0,
    },
  };

  return config[type] || config.backend;
}

/**
 * GET /api/projects
 * Obtener todos los proyectos del usuario con sus repositorios
 */
router.get('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const { isActive } = req.query;

    const filter: any = { userId: req.user!.id };
    if (isActive !== undefined) {
      filter.isActive = isActive === 'true';
    }

    const projects = await Project.find(filter)
      .sort({ createdAt: -1 })
      .select('-__v')
      .lean();

    // Agregar repositorios a cada proyecto
    const projectsWithRepos = await Promise.all(
      projects.map(async (project) => {
        const repositories = await Repository.find({ projectId: project._id })
          .select('-__v')
          .lean();
        return {
          ...project,
          repositories,
        };
      })
    );

    res.json({
      success: true,
      data: projectsWithRepos,
      count: projectsWithRepos.length,
    });
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch projects',
    });
  }
});

/**
 * GET /api/projects/:id
 * Obtener un proyecto específico con sus repositorios
 */
router.get('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const project = await Project.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    }).lean();

    if (!project) {
      res.status(404).json({
        success: false,
        message: 'Project not found',
      });
      return;
    }

    // Obtener repositorios del proyecto
    const repositories = await Repository.find({ projectId: project._id })
      .select('-__v')
      .lean();

    res.json({
      success: true,
      data: {
        ...project,
        repositories,
      },
    });
  } catch (error) {
    console.error('Error fetching project:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch project',
    });
  }
});

/**
 * POST /api/projects
 * Crear un nuevo proyecto con sus repositorios
 */
router.post('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const validatedData = createProjectSchema.parse(req.body);
    const { repositories, ...projectData } = validatedData;

    // Crear el proyecto
    const project = await Project.create({
      ...projectData,
      userId: req.user!.id,
      isActive: true,
    });

    // Crear los repositorios si vienen
    const createdRepositories = [];
    if (repositories && repositories.length > 0) {
      // Obtener usuario con GitHub access token
      const { User } = await import('../models/User');
      const userWithToken = await User.findById(req.user!.id).select('accessToken username');

      if (!userWithToken || !userWithToken.accessToken) {
        // Si no tiene token, crear repos con la info que viene
        for (const repo of repositories) {
          const repoConfig = getRepositoryConfig(repo.type, repo.name);
          const repository = await Repository.create({
            name: repo.name,
            description: `Repository ${repo.name}`,
            projectId: project._id,
            githubRepoUrl: repo.clone_url || repo.html_url || `https://github.com/${repo.full_name}`,
            githubRepoName: repo.full_name,
            githubBranch: repo.default_branch || 'main',
            workspaceId: `ws-${Math.random().toString(36).substring(7)}`,
            type: repo.type, // Save repository type (backend/frontend)
            pathPatterns: repoConfig.pathPatterns, // Auto-generated patterns
            executionOrder: repoConfig.executionOrder, // Auto-generated order
            isActive: true,
          });
          createdRepositories.push(repository);
        }
      } else {
        // Si tiene token, obtener info completa de GitHub si es necesario
        const { Octokit } = await import('@octokit/rest');
        const octokit = new Octokit({ auth: userWithToken.accessToken });

        for (const repo of repositories) {
          let fullRepoData: any = repo;

          // Si falta clone_url, obtenerlo de GitHub
          if (!repo.clone_url && repo.name) {
            try {
              console.log(`📦 Fetching full repository data for: ${repo.name}`);
              const owner = repo.full_name?.split('/')[0] || userWithToken.username || 'unknown';
              const { data: repoInfo } = await octokit.rest.repos.get({
                owner,
                repo: repo.name,
              });
              fullRepoData = repoInfo;
            } catch (error) {
              console.warn(`Warning: Could not fetch repo ${repo.name} from GitHub:`, error);
              // Continuar con los datos que tenemos
            }
          }

          const repoConfig = getRepositoryConfig(repo.type, fullRepoData.name);
          const repository = await Repository.create({
            name: fullRepoData.name,
            description: fullRepoData.description || `Repository ${fullRepoData.name}`,
            projectId: project._id,
            githubRepoUrl: fullRepoData.clone_url || fullRepoData.html_url || `https://github.com/${fullRepoData.full_name}`,
            githubRepoName: fullRepoData.full_name || fullRepoData.name,
            githubBranch: fullRepoData.default_branch || 'main',
            workspaceId: `ws-${Math.random().toString(36).substring(7)}`,
            type: repo.type, // Save repository type (backend/frontend)
            pathPatterns: repoConfig.pathPatterns, // Auto-generated patterns
            executionOrder: repoConfig.executionOrder, // Auto-generated order
            isActive: true,
          });
          createdRepositories.push(repository);
        }
      }
    }

    res.status(201).json({
      success: true,
      data: {
        project: {
          ...project.toObject(),
          repositories: createdRepositories,
        },
      },
      message: `Project created successfully with ${createdRepositories.length} repositories!`,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        message: 'Invalid project data',
        errors: error.errors,
      });
      return;
    }

    console.error('Error creating project:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create project',
    });
  }
});

/**
 * PUT /api/projects/:id
 * Actualizar un proyecto
 */
router.put('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const validatedData = updateProjectSchema.parse(req.body);

    const project = await Project.findOneAndUpdate(
      {
        _id: req.params.id,
        userId: req.user!.id,
      },
      { $set: validatedData },
      { new: true, runValidators: true }
    );

    if (!project) {
      res.status(404).json({
        success: false,
        message: 'Project not found',
      });
      return;
    }

    res.json({
      success: true,
      data: project,
      message: 'Project updated successfully',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        message: 'Invalid project data',
        errors: error.errors,
      });
      return;
    }

    console.error('Error updating project:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update project',
    });
  }
});

/**
 * DELETE /api/projects/:id
 * Eliminar un proyecto y todos sus repositorios
 */
router.delete('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const project = await Project.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    });

    if (!project) {
      res.status(404).json({
        success: false,
        message: 'Project not found',
      });
      return;
    }

    // Obtener todos los repositorios del proyecto
    const repositories = await Repository.find({ projectId: project._id });

    // Limpiar workspaces de todos los repositorios
    for (const repo of repositories) {
      await githubService.cleanupWorkspace(repo.workspaceId);
    }

    // Eliminar todos los repositorios
    await Repository.deleteMany({ projectId: project._id });

    // Eliminar proyecto
    await project.deleteOne();

    res.json({
      success: true,
      message: 'Project and all its repositories deleted successfully',
      deletedRepositories: repositories.length,
    });
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete project',
    });
  }
});

/**
 * GET /api/projects/:id/api-key
 * Get project's Anthropic API key (or user's default)
 */
router.get('/:id/api-key', authenticate, async (req: AuthRequest, res) => {
  try {
    const project = await Project.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    }).select('+apiKey');

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    // If project has its own API key, return it (masked)
    if (project.apiKey) {
      return res.json({
        success: true,
        data: {
          hasApiKey: true,
          maskedKey: `sk-ant-...${project.apiKey.slice(-4)}`,
          source: 'project',
        },
      });
    }

    // Otherwise, check if user has a default API key
    const { User } = await import('../models/User');
    const user = await User.findById(req.user!.id).select('+defaultApiKey');

    if (user?.defaultApiKey) {
      return res.json({
        success: true,
        data: {
          hasApiKey: true,
          maskedKey: `sk-ant-...${user.defaultApiKey.slice(-4)}`,
          source: 'user_default',
        },
      });
    }

    // No API key configured
    res.json({
      success: true,
      data: {
        hasApiKey: false,
        maskedKey: null,
        source: 'environment',
      },
    });
  } catch (error: any) {
    console.error('Error getting project API key:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get API key',
    });
  }
});

/**
 * PUT /api/projects/:id/api-key
 * Update project's Anthropic API key
 */
router.put('/:id/api-key', authenticate, async (req: AuthRequest, res) => {
  try {
    const { apiKey } = req.body;

    // Validate API key format if provided
    if (apiKey && !apiKey.startsWith('sk-ant-')) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Anthropic API key format',
      });
    }

    const project = await Project.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    project.apiKey = apiKey || undefined;
    await project.save();

    res.json({
      success: true,
      message: 'Project API key updated successfully',
      data: {
        hasApiKey: !!apiKey,
      },
    });
  } catch (error: any) {
    console.error('Error updating project API key:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update API key',
    });
  }
});

/**
 * ===================================================================
 * WEBHOOK API KEY MANAGEMENT ENDPOINTS
 * ===================================================================
 */

// Validation schemas
const createWebhookKeySchema = z.object({
  name: z.string().min(1).max(100),
  rateLimit: z.number().min(1).max(1000).optional().default(60),
});

const updateWebhookKeySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  rateLimit: z.number().min(1).max(1000).optional(),
  isActive: z.boolean().optional(),
});

/**
 * POST /api/projects/:id/webhook-keys
 * Create a new webhook API key for external integrations
 */
router.post('/:id/webhook-keys', authenticate, async (req: AuthRequest, res) => {
  try {
    const projectId = req.params.id;
    const userId = req.user!.id;

    // Validate request body
    const body = createWebhookKeySchema.parse(req.body);

    // Verify project ownership
    const project = await Project.findOne({
      _id: projectId,
      userId,
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    // Generate secure API key
    const apiKey = WebhookApiKey.generateApiKey();

    // Create webhook key document
    const webhookKey = await WebhookApiKey.create({
      apiKey,
      projectId,
      name: body.name,
      rateLimit: body.rateLimit,
      isActive: true,
      requestCount: 0,
    });

    console.log(`✅ Created webhook key: ${body.name} for project ${projectId}`);

    res.status(201).json({
      success: true,
      message: 'Webhook API key created successfully',
      data: {
        keyId: webhookKey._id,
        apiKey: apiKey, // ⚠️ ONLY returned on creation
        name: webhookKey.name,
        rateLimit: webhookKey.rateLimit,
        isActive: webhookKey.isActive,
        createdAt: webhookKey.createdAt,
        warning: 'Save this API key securely. It will not be shown again.',
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request data',
        errors: error.errors,
      });
    }

    console.error('Error creating webhook key:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create webhook API key',
    });
  }
});

/**
 * GET /api/projects/:id/webhook-keys
 * List all webhook API keys for a project
 */
router.get('/:id/webhook-keys', authenticate, async (req: AuthRequest, res) => {
  try {
    const projectId = req.params.id;
    const userId = req.user!.id;

    // Verify project ownership
    const project = await Project.findOne({
      _id: projectId,
      userId,
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    // Get all webhook keys (hide full API key)
    const webhookKeys = await WebhookApiKey.find({ projectId })
      .select('-apiKey') // Don't return full API key
      .sort({ createdAt: -1 });

    // Add masked key preview
    const keysWithMasked = await Promise.all(
      webhookKeys.map(async (key) => {
        const fullKey = await WebhookApiKey.findById(key._id).select('apiKey');
        return {
          ...key.toObject(),
          maskedKey: fullKey?.apiKey
            ? `${fullKey.apiKey.substring(0, 10)}...${fullKey.apiKey.slice(-4)}`
            : 'whk_...',
        };
      })
    );

    res.json({
      success: true,
      data: {
        webhookKeys: keysWithMasked,
        total: keysWithMasked.length,
      },
    });
  } catch (error: any) {
    console.error('Error fetching webhook keys:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch webhook keys',
    });
  }
});

/**
 * GET /api/projects/:id/webhook-keys/:keyId
 * Get details of a specific webhook API key
 */
router.get('/:id/webhook-keys/:keyId', authenticate, async (req: AuthRequest, res) => {
  try {
    const { id: projectId, keyId } = req.params;
    const userId = req.user!.id;

    // Verify project ownership
    const project = await Project.findOne({
      _id: projectId,
      userId,
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    // Get webhook key (hide full API key)
    const webhookKey = await WebhookApiKey.findOne({
      _id: keyId,
      projectId,
    });

    if (!webhookKey) {
      return res.status(404).json({
        success: false,
        message: 'Webhook API key not found',
      });
    }

    // Return with masked key
    const maskedKey = `${webhookKey.apiKey.substring(0, 10)}...${webhookKey.apiKey.slice(-4)}`;

    res.json({
      success: true,
      data: {
        keyId: webhookKey._id,
        name: webhookKey.name,
        maskedKey,
        rateLimit: webhookKey.rateLimit,
        isActive: webhookKey.isActive,
        requestCount: webhookKey.requestCount,
        lastUsedAt: webhookKey.lastUsedAt,
        createdAt: webhookKey.createdAt,
        updatedAt: webhookKey.updatedAt,
      },
    });
  } catch (error: any) {
    console.error('Error fetching webhook key:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch webhook key',
    });
  }
});

/**
 * PATCH /api/projects/:id/webhook-keys/:keyId
 * Update webhook API key (name, rate limit, active status)
 */
router.patch('/:id/webhook-keys/:keyId', authenticate, async (req: AuthRequest, res) => {
  try {
    const { id: projectId, keyId } = req.params;
    const userId = req.user!.id;

    // Validate request body
    const body = updateWebhookKeySchema.parse(req.body);

    // Verify project ownership
    const project = await Project.findOne({
      _id: projectId,
      userId,
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    // Update webhook key
    const webhookKey = await WebhookApiKey.findOneAndUpdate(
      { _id: keyId, projectId },
      { $set: body },
      { new: true, runValidators: true }
    );

    if (!webhookKey) {
      return res.status(404).json({
        success: false,
        message: 'Webhook API key not found',
      });
    }

    console.log(`✅ Updated webhook key: ${keyId} for project ${projectId}`);

    res.json({
      success: true,
      message: 'Webhook API key updated successfully',
      data: {
        keyId: webhookKey._id,
        name: webhookKey.name,
        rateLimit: webhookKey.rateLimit,
        isActive: webhookKey.isActive,
        updatedAt: webhookKey.updatedAt,
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request data',
        errors: error.errors,
      });
    }

    console.error('Error updating webhook key:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update webhook key',
    });
  }
});

/**
 * DELETE /api/projects/:id/webhook-keys/:keyId
 * Deactivate a webhook API key (soft delete)
 */
router.delete('/:id/webhook-keys/:keyId', authenticate, async (req: AuthRequest, res) => {
  try {
    const { id: projectId, keyId } = req.params;
    const userId = req.user!.id;

    // Verify project ownership
    const project = await Project.findOne({
      _id: projectId,
      userId,
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    // Soft delete: Set isActive = false
    const webhookKey = await WebhookApiKey.findOneAndUpdate(
      { _id: keyId, projectId },
      { $set: { isActive: false } },
      { new: true }
    );

    if (!webhookKey) {
      return res.status(404).json({
        success: false,
        message: 'Webhook API key not found',
      });
    }

    console.log(`🗑️  Deactivated webhook key: ${keyId} for project ${projectId}`);

    res.json({
      success: true,
      message: 'Webhook API key deactivated successfully',
      data: {
        keyId: webhookKey._id,
        isActive: false,
      },
    });
  } catch (error: any) {
    console.error('Error deleting webhook key:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to deactivate webhook key',
    });
  }
});

/**
 * POST /api/projects/:id/webhook-keys/:keyId/regenerate
 * Regenerate a webhook API key (creates new key, invalidates old one)
 */
router.post('/:id/webhook-keys/:keyId/regenerate', authenticate, async (req: AuthRequest, res) => {
  try {
    const { id: projectId, keyId } = req.params;
    const userId = req.user!.id;

    // Verify project ownership
    const project = await Project.findOne({
      _id: projectId,
      userId,
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    // Find existing key
    const oldKey = await WebhookApiKey.findOne({
      _id: keyId,
      projectId,
    });

    if (!oldKey) {
      return res.status(404).json({
        success: false,
        message: 'Webhook API key not found',
      });
    }

    // Generate new API key
    const newApiKey = WebhookApiKey.generateApiKey();

    // Update with new key and reset request count
    oldKey.apiKey = newApiKey;
    oldKey.requestCount = 0;
    oldKey.lastUsedAt = undefined;
    await oldKey.save();

    console.log(`🔄 Regenerated webhook key: ${keyId} for project ${projectId}`);

    res.json({
      success: true,
      message: 'Webhook API key regenerated successfully',
      data: {
        keyId: oldKey._id,
        apiKey: newApiKey, // ⚠️ ONLY returned on regeneration
        name: oldKey.name,
        rateLimit: oldKey.rateLimit,
        isActive: oldKey.isActive,
        warning: 'Save this new API key securely. The old key is now invalid.',
      },
    });
  } catch (error: any) {
    console.error('Error regenerating webhook key:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to regenerate webhook key',
    });
  }
});

export default router;
