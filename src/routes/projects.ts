import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { Project } from '../models/Project';
import { Repository } from '../models/Repository';
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
  })).optional(),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
});

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
          const repository = await Repository.create({
            name: repo.name,
            description: `Repository ${repo.name}`,
            projectId: project._id,
            githubRepoUrl: repo.clone_url || repo.html_url || `https://github.com/${repo.full_name}`,
            githubRepoName: repo.full_name,
            githubBranch: repo.default_branch || 'main',
            workspaceId: `ws-${Math.random().toString(36).substring(7)}`,
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

          const repository = await Repository.create({
            name: fullRepoData.name,
            description: fullRepoData.description || `Repository ${fullRepoData.name}`,
            projectId: project._id,
            githubRepoUrl: fullRepoData.clone_url || fullRepoData.html_url || `https://github.com/${fullRepoData.full_name}`,
            githubRepoName: fullRepoData.full_name || fullRepoData.name,
            githubBranch: fullRepoData.default_branch || 'main',
            workspaceId: `ws-${Math.random().toString(36).substring(7)}`,
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

export default router;
