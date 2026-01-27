import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { ProjectRepository, IDevAuth } from '../database/repositories/ProjectRepository.js';
import { RepositoryRepository } from '../database/repositories/RepositoryRepository.js';
import { WebhookApiKeyRepository } from '../database/repositories/WebhookApiKeyRepository.js';
import { UserRepository } from '../database/repositories/UserRepository.js';
import { GitHubService } from '../services/GitHubService';
import { sandboxPoolService } from '../services/SandboxPoolService.js';
import { z } from 'zod';
import path from 'path';
import os from 'os';
import fs from 'fs';

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

// DevAuth validation schema - simplified 2-method system
const devAuthSchema = z.object({
  method: z.enum(['none', 'token', 'credentials']),

  // For 'token' method - user provides a pre-generated token
  token: z.string().optional(),
  tokenType: z.enum(['bearer', 'api-key', 'basic', 'custom']).optional(),
  tokenHeader: z.string().optional(),
  tokenPrefix: z.string().optional(),

  // For 'credentials' method - system curls login endpoint
  loginEndpoint: z.string().url().optional(),
  loginMethod: z.enum(['POST', 'GET']).optional(),
  credentials: z.object({
    username: z.string().optional(),
    password: z.string().optional(),
  }).optional(),
  loginContentType: z.string().optional(),
  tokenResponsePath: z.string().optional(),
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
router.get('/', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    // Check if user exists in the request
    if (!req.user || !req.user.id) {
      console.error('No user found in request after authentication');
      return res.status(401).json({
        success: false,
        message: 'User not authenticated properly'
      });
    }

    console.log('Fetching projects for user:', req.user.id);

    // SQLite: Get projects for user (findByUserId already filters by isActive=1)
    const projects = ProjectRepository.findByUserId(req.user.id);
    console.log(`Projects query successful: Found ${projects.length} projects`);

    // Get repositories for each project
    const projectsWithRepos = projects.map((project) => {
      const repositories = RepositoryRepository.findByProjectId(project.id);

      return {
        _id: project.id,
        name: project.name,
        description: project.description,
        userId: project.userId,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        repositories: repositories.map(r => ({
          _id: r.id,
          name: r.name,
          description: r.description,
          githubRepoUrl: r.githubRepoUrl,
          githubRepoName: r.githubRepoName,
          githubBranch: r.githubBranch,
          type: r.type,
        })),
      };
    });

    console.log('Returning projects:', projectsWithRepos.map(p => ({ id: p._id, name: p.name, repoCount: p.repositories?.length || 0 })));

    res.json({
      success: true,
      data: {
        projects: projectsWithRepos,
        pagination: {
          total: projectsWithRepos.length,
          page: 1,
          limit: 50
        }
      },
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
router.get('/:id', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const project = ProjectRepository.findById(req.params.id);

    if (!project || project.userId !== req.user!.id) {
      res.status(404).json({
        success: false,
        message: 'Project not found',
      });
      return;
    }

    // Get repositories for project
    const repositories = RepositoryRepository.findByProjectId(project.id);

    res.json({
      success: true,
      data: {
        _id: project.id,
        name: project.name,
        description: project.description,
        type: project.type,
        status: project.status,
        userId: project.userId,
        settings: project.settings,
        stats: project.stats,
        tokenStats: project.tokenStats,
        isActive: project.isActive,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        repositories: repositories.map(r => ({
          _id: r.id,
          name: r.name,
          description: r.description,
          githubRepoUrl: r.githubRepoUrl,
          githubRepoName: r.githubRepoName,
          githubBranch: r.githubBranch,
          workspaceId: r.workspaceId,
          type: r.type,
          pathPatterns: r.pathPatterns,
          executionOrder: r.executionOrder,
          isActive: r.isActive,
        })),
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
router.post('/', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const validatedData = createProjectSchema.parse(req.body);
    const { repositories, ...projectData } = validatedData;

    // Create project
    const project = ProjectRepository.create({
      ...projectData,
      userId: req.user!.id,
    });

    // Create repositories if provided
    const createdRepositories = [];
    if (repositories && repositories.length > 0) {
      // Get user with GitHub access token
      const userWithToken = UserRepository.findById(req.user!.id, true);

      if (!userWithToken || !userWithToken.accessToken) {
        // No token, create repos with provided info
        for (const repo of repositories) {
          const repoConfig = getRepositoryConfig(repo.type, repo.name);
          const repository = RepositoryRepository.create({
            name: repo.name,
            description: `Repository ${repo.name}`,
            projectId: project.id,
            githubRepoUrl: repo.clone_url || repo.html_url || `https://github.com/${repo.full_name}`,
            githubRepoName: repo.full_name,
            githubBranch: repo.default_branch || 'main',
            workspaceId: `ws-${Math.random().toString(36).substring(7)}`,
            type: repo.type,
            pathPatterns: repoConfig.pathPatterns,
            executionOrder: repoConfig.executionOrder,
          });
          createdRepositories.push(repository);
        }
      } else {
        // Has token, fetch full info from GitHub if needed
        const { Octokit } = await import('@octokit/rest');
        const octokit = new Octokit({ auth: userWithToken.accessToken });

        for (const repo of repositories) {
          let fullRepoData: any = repo;

          // If clone_url is missing, get it from GitHub
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
            }
          }

          const repoConfig = getRepositoryConfig(repo.type, fullRepoData.name);
          const repository = RepositoryRepository.create({
            name: fullRepoData.name,
            description: fullRepoData.description || `Repository ${fullRepoData.name}`,
            projectId: project.id,
            githubRepoUrl: fullRepoData.clone_url || fullRepoData.html_url || `https://github.com/${fullRepoData.full_name}`,
            githubRepoName: fullRepoData.full_name || fullRepoData.name,
            githubBranch: fullRepoData.default_branch || 'main',
            workspaceId: `ws-${Math.random().toString(36).substring(7)}`,
            type: repo.type,
            pathPatterns: repoConfig.pathPatterns,
            executionOrder: repoConfig.executionOrder,
          });
          createdRepositories.push(repository);
        }
      }
    }

    res.status(201).json({
      success: true,
      data: {
        project: {
          _id: project.id,
          name: project.name,
          description: project.description,
          type: project.type,
          status: project.status,
          userId: project.userId,
          isActive: project.isActive,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          repositories: createdRepositories.map(r => ({
            _id: r.id,
            name: r.name,
            description: r.description,
            githubRepoUrl: r.githubRepoUrl,
            githubRepoName: r.githubRepoName,
            githubBranch: r.githubBranch,
            type: r.type,
          })),
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
router.put('/:id', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const validatedData = updateProjectSchema.parse(req.body);

    // Verify ownership first
    const existing = ProjectRepository.findById(req.params.id);
    if (!existing || existing.userId !== req.user!.id) {
      res.status(404).json({
        success: false,
        message: 'Project not found',
      });
      return;
    }

    const project = ProjectRepository.update(req.params.id, validatedData);

    if (!project) {
      res.status(404).json({
        success: false,
        message: 'Project not found',
      });
      return;
    }

    res.json({
      success: true,
      data: {
        _id: project.id,
        name: project.name,
        description: project.description,
        type: project.type,
        status: project.status,
        isActive: project.isActive,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      },
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
router.delete('/:id', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const project = ProjectRepository.findById(req.params.id);

    if (!project || project.userId !== req.user!.id) {
      res.status(404).json({
        success: false,
        message: 'Project not found',
      });
      return;
    }

    // Get all repositories for the project
    const repositories = RepositoryRepository.findByProjectId(project.id);

    // Cleanup workspaces for all repositories
    for (const repo of repositories) {
      await githubService.cleanupWorkspace(repo.workspaceId);
      // Delete repository
      RepositoryRepository.delete(repo.id);
    }

    // Soft delete project (sets is_active = 0)
    ProjectRepository.delete(project.id);

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
router.get('/:id/api-key', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const project = ProjectRepository.findById(req.params.id, true);

    if (!project || project.userId !== req.user!.id) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    // If project has its own API key, return it (masked)
    const projectApiKey = ProjectRepository.getDecryptedApiKey(req.params.id);
    if (projectApiKey) {
      return res.json({
        success: true,
        data: {
          hasApiKey: true,
          maskedKey: `sk-ant-...${projectApiKey.slice(-4)}`,
          source: 'project',
        },
      });
    }

    // Otherwise, check if user has a default API key
    const userApiKey = UserRepository.getDecryptedApiKey(req.user!.id);

    if (userApiKey) {
      return res.json({
        success: true,
        data: {
          hasApiKey: true,
          maskedKey: `sk-ant-...${userApiKey.slice(-4)}`,
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
router.put('/:id/api-key', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const { apiKey } = req.body;

    // Validate API key format if provided
    if (apiKey && !apiKey.startsWith('sk-ant-')) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Anthropic API key format',
      });
    }

    // Verify ownership first
    const existing = ProjectRepository.findById(req.params.id);
    if (!existing || existing.userId !== req.user!.id) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    ProjectRepository.update(req.params.id, { apiKey: apiKey || undefined });

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
 * PUT /api/projects/:id/dev-auth
 * Update project's developer authentication configuration
 * SIMPLIFIED: 2 methods only (token OR credentials)
 */
router.put('/:id/dev-auth', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const validatedData = devAuthSchema.parse(req.body);

    // Verify ownership first
    const existing = ProjectRepository.findById(req.params.id);
    if (!existing || existing.userId !== req.user!.id) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    // Update devAuth configuration
    const devAuth: IDevAuth = {
      method: validatedData.method,
      // Token method fields
      token: validatedData.token,
      tokenType: validatedData.tokenType || 'bearer',
      tokenHeader: validatedData.tokenHeader || 'Authorization',
      tokenPrefix: validatedData.tokenPrefix || 'Bearer ',
      // Credentials method fields
      loginEndpoint: validatedData.loginEndpoint,
      loginMethod: validatedData.loginMethod || 'POST',
      credentials: validatedData.credentials,
      loginContentType: validatedData.loginContentType || 'application/json',
      tokenResponsePath: validatedData.tokenResponsePath || 'token',
    };

    ProjectRepository.update(req.params.id, { devAuth });

    console.log(`✅ Updated devAuth for project ${existing.name}: method=${validatedData.method}`);

    res.json({
      success: true,
      message: 'Developer authentication updated successfully',
      data: {
        method: validatedData.method,
        // Don't return sensitive data
        hasToken: !!validatedData.token,
        hasCredentials: !!(validatedData.credentials?.username && validatedData.credentials?.password),
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Invalid devAuth configuration',
        errors: error.errors,
      });
    }

    console.error('Error updating project devAuth:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update developer authentication',
    });
  }
});

/**
 * GET /api/projects/:id/dev-auth
 * Get project's developer authentication configuration (without sensitive data)
 */
router.get('/:id/dev-auth', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const project = ProjectRepository.findById(req.params.id);

    if (!project || project.userId !== req.user!.id) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    // Get decrypted devAuth (with sensitive fields decrypted)
    const devAuth = ProjectRepository.getDecryptedDevAuth(req.params.id) || { method: 'none' as const };

    res.json({
      success: true,
      data: {
        method: devAuth.method,
        // Token method - mask the token
        hasToken: !!devAuth.token,
        tokenType: devAuth.tokenType,
        tokenHeader: devAuth.tokenHeader,
        tokenPrefix: devAuth.tokenPrefix,
        // Credentials method - show username, mask password
        loginEndpoint: devAuth.loginEndpoint,
        loginMethod: devAuth.loginMethod,
        hasCredentials: !!(devAuth.credentials?.username && devAuth.credentials?.password),
        credentialsUsername: devAuth.credentials?.username,
        loginContentType: devAuth.loginContentType,
        tokenResponsePath: devAuth.tokenResponsePath,
      },
    });
  } catch (error: any) {
    console.error('Error getting project devAuth:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get developer authentication',
    });
  }
});

/**
 * ===================================================================
 * PROJECT SETTINGS ENDPOINTS
 * ===================================================================
 */

// Project settings validation schema
const updateSettingsSchema = z.object({
  defaultBranch: z.string().optional(),
  autoDeployment: z.boolean().optional(),
  autoRecoveryEnabled: z.boolean().optional(),
  autoMergeEnabled: z.boolean().optional(), // 🔥 Toggle auto-merge PRs to main
  requiredReviews: z.number().min(0).max(10).optional(),
  educationalContext: z.string().optional(),
  complianceLevel: z.string().optional(),
});

/**
 * GET /api/projects/:id/settings
 * Get project settings
 */
router.get('/:id/settings', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const project = ProjectRepository.findById(req.params.id);

    if (!project || project.userId !== req.user!.id) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    res.json({
      success: true,
      data: {
        settings: project.settings || {
          defaultBranch: 'main',
          autoDeployment: false,
          autoRecoveryEnabled: true,
          autoMergeEnabled: false, // 🔥 Default: PRs require human review
          requiredReviews: 0,
        },
      },
    });
  } catch (error: any) {
    console.error('Error getting project settings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get project settings',
    });
  }
});

/**
 * PATCH /api/projects/:id/settings
 * Update project settings (partial update)
 */
router.patch('/:id/settings', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const validatedData = updateSettingsSchema.parse(req.body);

    // Verify ownership first
    const existing = ProjectRepository.findById(req.params.id);
    if (!existing || existing.userId !== req.user!.id) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    // Merge with existing settings
    const currentSettings = existing.settings || {};
    const newSettings = {
      ...currentSettings,
      ...validatedData,
    };

    const project = ProjectRepository.update(req.params.id, { settings: newSettings });

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    console.log(`✅ Updated settings for project ${existing.name}:`, validatedData);

    res.json({
      success: true,
      message: 'Project settings updated successfully',
      data: {
        settings: project.settings,
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Invalid settings data',
        errors: error.errors,
      });
    }

    console.error('Error updating project settings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update project settings',
    });
  }
});

/**
 * PUT /api/projects/:id/settings/auto-merge
 * Toggle auto-merge setting (convenience endpoint)
 */
router.put('/:id/settings/auto-merge', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'Invalid request: "enabled" must be a boolean',
      });
    }

    // Verify ownership first
    const existing = ProjectRepository.findById(req.params.id);
    if (!existing || existing.userId !== req.user!.id) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    // Update autoMergeEnabled setting
    const currentSettings = existing.settings || {};
    const newSettings = {
      ...currentSettings,
      autoMergeEnabled: enabled,
    };

    ProjectRepository.update(req.params.id, { settings: newSettings });

    console.log(`🔀 [AutoMerge] ${enabled ? 'Enabled' : 'Disabled'} for project: ${existing.name}`);

    res.json({
      success: true,
      message: `Auto-merge ${enabled ? 'enabled' : 'disabled'} successfully`,
      data: {
        autoMergeEnabled: enabled,
      },
    });
  } catch (error: any) {
    console.error('Error toggling auto-merge:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to toggle auto-merge',
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
router.post('/:id/webhook-keys', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const projectId = req.params.id;
    const userId = req.user!.id;

    // Validate request body
    const body = createWebhookKeySchema.parse(req.body);

    // Verify project ownership
    const project = ProjectRepository.findById(projectId);

    if (!project || project.userId !== userId) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    // Create webhook key with auto-generated API key
    const webhookKey = WebhookApiKeyRepository.create({
      projectId,
      name: body.name,
      rateLimit: body.rateLimit,
    });

    console.log(`✅ Created webhook key: ${body.name} for project ${projectId}`);

    res.status(201).json({
      success: true,
      message: 'Webhook API key created successfully',
      data: {
        keyId: webhookKey.id,
        apiKey: webhookKey.apiKey, // ⚠️ ONLY returned on creation
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
router.get('/:id/webhook-keys', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const projectId = req.params.id;
    const userId = req.user!.id;

    // Verify project ownership
    const project = ProjectRepository.findById(projectId);

    if (!project || project.userId !== userId) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    // Get all webhook keys for project
    const webhookKeys = WebhookApiKeyRepository.findByProjectId(projectId);

    // Add masked key preview
    const keysWithMasked = webhookKeys.map((key) => ({
      _id: key.id,
      name: key.name,
      rateLimit: key.rateLimit,
      isActive: key.isActive,
      requestCount: key.requestCount,
      lastUsedAt: key.lastUsedAt,
      createdAt: key.createdAt,
      updatedAt: key.updatedAt,
      maskedKey: key.apiKey
        ? `${key.apiKey.substring(0, 10)}...${key.apiKey.slice(-4)}`
        : 'whk_...',
    }));

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
router.get('/:id/webhook-keys/:keyId', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const { id: projectId, keyId } = req.params;
    const userId = req.user!.id;

    // Verify project ownership
    const project = ProjectRepository.findById(projectId);

    if (!project || project.userId !== userId) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    // Get webhook key
    const webhookKey = WebhookApiKeyRepository.findById(keyId);

    if (!webhookKey || webhookKey.projectId !== projectId) {
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
        keyId: webhookKey.id,
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
router.patch('/:id/webhook-keys/:keyId', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const { id: projectId, keyId } = req.params;
    const userId = req.user!.id;

    // Validate request body
    const body = updateWebhookKeySchema.parse(req.body);

    // Verify project ownership
    const project = ProjectRepository.findById(projectId);

    if (!project || project.userId !== userId) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    // Verify webhook key belongs to project
    const existing = WebhookApiKeyRepository.findById(keyId);
    if (!existing || existing.projectId !== projectId) {
      return res.status(404).json({
        success: false,
        message: 'Webhook API key not found',
      });
    }

    // Update webhook key
    const webhookKey = WebhookApiKeyRepository.update(keyId, body);

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
        keyId: webhookKey.id,
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
router.delete('/:id/webhook-keys/:keyId', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const { id: projectId, keyId } = req.params;
    const userId = req.user!.id;

    // Verify project ownership
    const project = ProjectRepository.findById(projectId);

    if (!project || project.userId !== userId) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    // Verify webhook key belongs to project
    const existing = WebhookApiKeyRepository.findById(keyId);
    if (!existing || existing.projectId !== projectId) {
      return res.status(404).json({
        success: false,
        message: 'Webhook API key not found',
      });
    }

    // Soft delete: Set isActive = false
    WebhookApiKeyRepository.deactivate(keyId);

    console.log(`🗑️  Deactivated webhook key: ${keyId} for project ${projectId}`);

    res.json({
      success: true,
      message: 'Webhook API key deactivated successfully',
      data: {
        keyId: keyId,
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
router.post('/:id/webhook-keys/:keyId/regenerate', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const { id: projectId, keyId } = req.params;
    const userId = req.user!.id;

    // Verify project ownership
    const project = ProjectRepository.findById(projectId);

    if (!project || project.userId !== userId) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    // Find existing key
    const oldKey = WebhookApiKeyRepository.findById(keyId);

    if (!oldKey || oldKey.projectId !== projectId) {
      return res.status(404).json({
        success: false,
        message: 'Webhook API key not found',
      });
    }

    // Generate new API key
    const newApiKey = WebhookApiKeyRepository.generateApiKey();

    // Update with new key and reset request count
    WebhookApiKeyRepository.update(keyId, {
      apiKey: newApiKey,
      requestCount: 0,
      lastUsedAt: undefined,
    });

    console.log(`🔄 Regenerated webhook key: ${keyId} for project ${projectId}`);

    res.json({
      success: true,
      message: 'Webhook API key regenerated successfully',
      data: {
        keyId: keyId,
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

/**
 * ===================================================================
 * ENVIRONMENT CLEANUP ENDPOINTS
 * ===================================================================
 */

/**
 * POST /api/projects/:id/clean-environment
 * Clean sandbox containers and workspace files for a project
 */
router.post('/:id/clean-environment', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const projectId = req.params.id;
    const userId = req.user!.id;

    // Verify project ownership
    const project = ProjectRepository.findById(projectId);

    if (!project || project.userId !== userId) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    console.log(`🧹 [CleanEnvironment] Starting cleanup for project: ${project.name} (${projectId})`);

    const results = {
      sandboxes: { destroyed: 0, errors: [] as string[] },
      workspaces: { cleaned: 0, errors: [] as string[], freedBytes: 0 },
    };

    // 1. Destroy all sandbox pools for this project
    try {
      const destroyedCount = await sandboxPoolService.destroyProjectPools(projectId);
      results.sandboxes.destroyed = destroyedCount;
      console.log(`   🐳 Destroyed ${destroyedCount} sandbox pools`);
    } catch (sandboxError: any) {
      console.error(`   ❌ Sandbox cleanup error:`, sandboxError.message);
      results.sandboxes.errors.push(sandboxError.message);
    }

    // 2. Clean workspace directories
    const agentWorkspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.homedir(), 'agent-workspace-prod');
    const projectWorkspacePattern = `project-${projectId}`;

    try {
      if (fs.existsSync(agentWorkspaceDir)) {
        const entries = fs.readdirSync(agentWorkspaceDir);

        for (const entry of entries) {
          const fullPath = path.join(agentWorkspaceDir, entry);

          // Clean project-specific workspace
          if (entry === projectWorkspacePattern || entry.includes(projectId)) {
            try {
              const stats = await getDirectorySize(fullPath);
              fs.rmSync(fullPath, { recursive: true, force: true });
              results.workspaces.cleaned++;
              results.workspaces.freedBytes += stats;
              console.log(`   📁 Cleaned workspace: ${entry} (${formatBytes(stats)})`);
            } catch (err: any) {
              results.workspaces.errors.push(`${entry}: ${err.message}`);
            }
          }
        }
      }
    } catch (workspaceError: any) {
      console.error(`   ❌ Workspace cleanup error:`, workspaceError.message);
      results.workspaces.errors.push(workspaceError.message);
    }

    // 3. Sandbox state cleanup (no-op in simplified architecture)
    // Sandboxes are ephemeral per task - cleaned up when tasks complete
    // No persistent state to clean

    const totalErrors = results.sandboxes.errors.length + results.workspaces.errors.length;
    const success = totalErrors === 0;

    console.log(`✅ [CleanEnvironment] Completed for project ${project.name}:`);
    console.log(`   Sandboxes destroyed: ${results.sandboxes.destroyed}`);
    console.log(`   Workspaces cleaned: ${results.workspaces.cleaned}`);
    console.log(`   Space freed: ${formatBytes(results.workspaces.freedBytes)}`);

    res.json({
      success,
      message: success
        ? 'Environment cleaned successfully'
        : 'Environment cleanup completed with some errors',
      data: {
        sandboxesDestroyed: results.sandboxes.destroyed,
        workspacesCleaned: results.workspaces.cleaned,
        spaceFreed: formatBytes(results.workspaces.freedBytes),
        spaceFreedBytes: results.workspaces.freedBytes,
        errors: totalErrors > 0 ? [...results.sandboxes.errors, ...results.workspaces.errors] : undefined,
      },
    });
  } catch (error: any) {
    console.error('Error cleaning environment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to clean environment',
      error: error.message,
    });
  }
});

/**
 * Helper: Get directory size recursively
 */
async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0;

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        totalSize += await getDirectorySize(fullPath);
      } else if (entry.isFile()) {
        try {
          const stats = fs.statSync(fullPath);
          totalSize += stats.size;
        } catch {
          // Skip files we can't stat
        }
      }
    }
  } catch {
    // Skip directories we can't read
  }

  return totalSize;
}

/**
 * Helper: Format bytes to human readable
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export default router;
