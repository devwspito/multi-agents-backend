import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { Repository } from '../models/Repository';
import { Project } from '../models/Project';
import { GitHubService } from '../services/GitHubService';
import { EnvService } from '../services/EnvService';
import { z } from 'zod';
import crypto from 'crypto';
import path from 'path';
import os from 'os';

const router = Router();
const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
const githubService = new GitHubService(workspaceDir);

/**
 * GET /api/repositories/github
 * Obtener repositorios de GitHub del usuario autenticado
 */
router.get('/github', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const { User } = await import('../models/User');
    const user = await User.findById(req.user!.id).select('accessToken');

    if (!user || !user.accessToken) {
      res.status(401).json({
        success: false,
        message: 'GitHub access token not found. Please reconnect your GitHub account.',
      });
      return;
    }

    // Obtener TODOS los repositorios del usuario con paginación
    let allRepos: any[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await fetch(`https://api.github.com/user/repos?per_page=100&page=${page}&sort=updated`, {
        headers: {
          'Authorization': `Bearer ${user.accessToken}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'Multi-Agent-Platform',
        },
      });

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      const repos = (await response.json()) as any[];
      allRepos = allRepos.concat(repos);

      // Si recibimos menos de 100, no hay más páginas
      hasMore = repos.length === 100;
      page++;
    }

    const repos = allRepos;

    // Formatear respuesta
    const formattedRepos = repos.map((repo: any) => ({
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      description: repo.description,
      url: repo.html_url,
      cloneUrl: repo.clone_url,
      defaultBranch: repo.default_branch,
      private: repo.private,
      language: repo.language,
      stargazersCount: repo.stargazers_count,
      forksCount: repo.forks_count,
      updatedAt: repo.updated_at,
    }));

    res.json({
      success: true,
      data: formattedRepos,
      count: formattedRepos.length,
    });
  } catch (error: any) {
    console.error('Error fetching GitHub repositories:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch GitHub repositories',
    });
  }
});

// Validación schemas con Zod
const createRepositorySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  projectId: z.string().min(1),
  githubRepoUrl: z.string().url().refine(
    (url) => url.includes('github.com'),
    { message: 'Must be a valid GitHub repository URL' }
  ),
  githubBranch: z.string().min(1).default('main'),
});

const updateRepositorySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
  githubBranch: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});

/**
 * GET /api/repositories
 * Obtener todos los repositorios del usuario (opcionalmente filtrados por proyecto)
 */
router.get('/', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const { projectId, isActive } = req.query;

    // Si hay projectId, verificar que el usuario es dueño del proyecto
    if (projectId) {
      const project = await Project.findOne({
        _id: projectId,
        userId: req.user!.id,
      });

      if (!project) {
        res.status(404).json({
          success: false,
          message: 'Project not found',
        });
        return;
      }
    }

    const filter: any = {};

    // Filtrar por projectId si se proporciona
    if (projectId) {
      filter.projectId = projectId;
    } else {
      // Si no hay projectId, obtener todos los repos de proyectos del usuario
      const userProjects = await Project.find({ userId: req.user!.id }).select('_id');
      filter.projectId = { $in: userProjects.map(p => p._id) };
    }

    if (isActive !== undefined) {
      filter.isActive = isActive === 'true';
    }

    const repositories = await Repository.find(filter)
      .populate('projectId', 'name description')
      .sort({ createdAt: -1 })
      .select('-__v')
      .lean();

    res.json({
      success: true,
      data: repositories,
      count: repositories.length,
    });
  } catch (error) {
    console.error('Error fetching repositories:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch repositories',
    });
  }
});

/**
 * GET /api/repositories/:id
 * Obtener un repositorio específico
 */
router.get('/:id', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const repository = await Repository.findById(req.params.id)
      .populate('projectId', 'name description userId')
      .lean();

    if (!repository) {
      res.status(404).json({
        success: false,
        message: 'Repository not found',
      });
      return;
    }

    // Verificar que el usuario es dueño del proyecto
    const project: any = repository.projectId;
    if (project.userId.toString() !== req.user!.id) {
      res.status(403).json({
        success: false,
        message: 'Access denied',
      });
      return;
    }

    res.json({
      success: true,
      data: repository,
    });
  } catch (error) {
    console.error('Error fetching repository:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch repository',
    });
  }
});

/**
 * POST /api/repositories
 * Crear un nuevo repositorio (agregar repo a un proyecto)
 */
router.post('/', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const validatedData = createRepositorySchema.parse(req.body);

    // Verificar que el usuario es dueño del proyecto
    const project = await Project.findOne({
      _id: validatedData.projectId,
      userId: req.user!.id,
    });

    if (!project) {
      res.status(404).json({
        success: false,
        message: 'Project not found or access denied',
      });
      return;
    }

    // Extraer owner/repo de la URL
    const repoMatch = validatedData.githubRepoUrl.match(/github\.com\/([^\/]+\/[^\/]+)/);
    if (!repoMatch) {
      res.status(400).json({
        success: false,
        message: 'Invalid GitHub repository URL format',
      });
      return;
    }

    const githubRepoName = repoMatch[1].replace(/\.git$/, '');

    // Generar workspaceId único
    const workspaceId = `ws-${crypto.randomBytes(16).toString('hex')}`;

    const repository = await Repository.create({
      ...validatedData,
      githubRepoName,
      workspaceId,
      isActive: true,
    });

    res.status(201).json({
      success: true,
      data: repository,
      message: 'Repository added successfully',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        message: 'Invalid repository data',
        errors: error.errors,
      });
      return;
    }

    console.error('Error creating repository:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create repository',
    });
  }
});

/**
 * PUT /api/repositories/:id
 * Actualizar un repositorio
 */
router.put('/:id', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const validatedData = updateRepositorySchema.parse(req.body);

    // Buscar repo y verificar permisos
    const repository = await Repository.findById(req.params.id).populate('projectId');
    if (!repository) {
      res.status(404).json({
        success: false,
        message: 'Repository not found',
      });
      return;
    }

    const project: any = repository.projectId;
    if (project.userId.toString() !== req.user!.id) {
      res.status(403).json({
        success: false,
        message: 'Access denied',
      });
      return;
    }

    // Actualizar
    Object.assign(repository, validatedData);
    await repository.save();

    res.json({
      success: true,
      data: repository,
      message: 'Repository updated successfully',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        message: 'Invalid repository data',
        errors: error.errors,
      });
      return;
    }

    console.error('Error updating repository:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update repository',
    });
  }
});

/**
 * POST /api/repositories/:id/sync
 * Sincronizar workspace con el repo remoto
 */
router.post('/:id/sync', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const repository = await Repository.findById(req.params.id).populate('projectId');
    if (!repository) {
      res.status(404).json({
        success: false,
        message: 'Repository not found',
      });
      return;
    }

    const project: any = repository.projectId;
    if (project.userId.toString() !== req.user!.id) {
      res.status(403).json({
        success: false,
        message: 'Access denied',
      });
      return;
    }

    // Sincronizar workspace
    await githubService.syncWorkspace(repository.workspaceId);

    // Actualizar timestamp
    repository.lastSyncedAt = new Date();
    await repository.save();

    res.json({
      success: true,
      message: 'Repository synchronized successfully',
      data: {
        lastSyncedAt: repository.lastSyncedAt,
      },
    });
  } catch (error: any) {
    console.error('Error syncing repository:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to sync repository',
    });
  }
});

/**
 * DELETE /api/repositories/:id
 * Eliminar un repositorio y limpiar su workspace
 */
router.delete('/:id', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const repository = await Repository.findById(req.params.id).populate('projectId');
    if (!repository) {
      res.status(404).json({
        success: false,
        message: 'Repository not found',
      });
      return;
    }

    const project: any = repository.projectId;
    if (project.userId.toString() !== req.user!.id) {
      res.status(403).json({
        success: false,
        message: 'Access denied',
      });
      return;
    }

    // Limpiar workspace
    await githubService.cleanupWorkspace(repository.workspaceId);

    // Eliminar repository
    await repository.deleteOne();

    res.json({
      success: true,
      message: 'Repository deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting repository:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete repository',
    });
  }
});

/**
 * 🔐 ENVIRONMENT VARIABLES MANAGEMENT
 */

/**
 * GET /api/repositories/:id/env
 * Get environment variables for a repository
 */
router.get('/:id/env', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const repository = await Repository.findById(req.params.id).populate('projectId');
    if (!repository) {
      return res.status(404).json({
        success: false,
        message: 'Repository not found',
      });
    }

    const project: any = repository.projectId;
    if (project.userId.toString() !== req.user!.id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied',
      });
    }

    // Return env variables (secrets are decrypted on frontend request)
    res.json({
      success: true,
      data: {
        envVariables: repository.envVariables || [],
        count: repository.envVariables?.length || 0,
      },
    });
  } catch (error: any) {
    console.error('Error getting env variables:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get environment variables',
    });
  }
});

/**
 * PUT /api/repositories/:id/env
 * Update environment variables for a repository
 */
const envVariableSchema = z.object({
  envVariables: z.array(z.object({
    key: z.string().min(1),
    value: z.string(),
    isSecret: z.boolean().optional().default(false),
    description: z.string().optional(),
  })),
});

router.put('/:id/env', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const repository = await Repository.findById(req.params.id).populate('projectId');
    if (!repository) {
      return res.status(404).json({
        success: false,
        message: 'Repository not found',
      });
    }

    const project: any = repository.projectId;
    if (project.userId.toString() !== req.user!.id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied',
      });
    }

    // Validate request body
    const body = envVariableSchema.parse(req.body);

    // Validate env variables format
    const validation = EnvService.validateEnvVariables(body.envVariables);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        message: 'Invalid environment variables',
        errors: validation.errors,
      });
    }

    // Encrypt secret values before saving
    const preparedEnvVars = EnvService.prepareForStorage(body.envVariables);

    // Update repository
    repository.envVariables = preparedEnvVars;
    await repository.save();

    console.log(`✅ Updated ${preparedEnvVars.length} environment variables for repository: ${repository.name}`);

    res.json({
      success: true,
      message: 'Environment variables updated successfully',
      data: {
        count: preparedEnvVars.length,
      },
    });
  } catch (error: any) {
    console.error('Error updating env variables:', error);

    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request body',
        errors: error.errors,
      });
    }

    res.status(500).json({
      success: false,
      message: error.message || 'Failed to update environment variables',
    });
  }
});

/**
 * DELETE /api/repositories/:id/env
 * Delete all environment variables for a repository
 */
router.delete('/:id/env', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const repository = await Repository.findById(req.params.id).populate('projectId');
    if (!repository) {
      return res.status(404).json({
        success: false,
        message: 'Repository not found',
      });
    }

    const project: any = repository.projectId;
    if (project.userId.toString() !== req.user!.id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied',
      });
    }

    // Clear env variables
    repository.envVariables = [];
    await repository.save();

    console.log(`✅ Cleared environment variables for repository: ${repository.name}`);

    res.json({
      success: true,
      message: 'Environment variables cleared successfully',
    });
  } catch (error: any) {
    console.error('Error clearing env variables:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to clear environment variables',
    });
  }
});

export default router;
