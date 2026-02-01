import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { RepositoryRepository, IRepository } from '../database/repositories/RepositoryRepository.js';
import { ProjectRepository } from '../database/repositories/ProjectRepository.js';
import { UserRepository } from '../database/repositories/UserRepository.js';
import { GitHubService } from '../services/GitHubService';
import { EnvService } from '../services/EnvService';
import { z } from 'zod';
import crypto from 'crypto';
import { AppConfig } from '../config/AppConfig';
import { ApiResponse } from '../utils/ApiResponse';

const router = Router();
const githubService = new GitHubService(AppConfig.workspace.dir);

/**
 * GET /api/repositories/github
 * Obtener repositorios de GitHub del usuario autenticado
 */
router.get('/github', authenticate, async (req: AuthRequest, res): Promise<any> => {
  try {
    const accessToken = UserRepository.getAccessToken(req.user!.id);

    if (!accessToken) {
      return ApiResponse.unauthorized(res, 'GitHub access token not found. Please reconnect your GitHub account.');
    }

    const user = { accessToken };

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
    const { projectId } = req.query;

    // If projectId is provided, verify user owns the project
    if (projectId) {
      const project = ProjectRepository.findById(projectId as string);

      if (!project || project.userId !== req.user!.id) {
        res.status(404).json({
          success: false,
          message: 'Project not found',
        });
        return;
      }
    }

    let repositories: IRepository[] | any[];

    if (projectId) {
      // Get repositories for specific project
      repositories = RepositoryRepository.findByProjectId(projectId as string);
    } else {
      // Get all repositories from user's projects
      const userProjects = ProjectRepository.findByUserId(req.user!.id);
      const allRepos: any[] = [];
      for (const project of userProjects) {
        const projectRepos = RepositoryRepository.findByProjectId(project.id);
        // Add project info to each repo
        projectRepos.forEach(repo => {
          allRepos.push({
            ...repo,
            _id: repo.id,
            projectId: {
              _id: project.id,
              name: project.name,
              description: project.description,
            },
          });
        });
      }
      repositories = allRepos;
    }

    // Format response
    const formattedRepos = projectId
      ? repositories.map((r: any) => ({
          _id: r.id,
          ...r,
        }))
      : repositories;

    res.json({
      success: true,
      data: formattedRepos,
      count: formattedRepos.length,
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
    const repository = RepositoryRepository.findById(req.params.id);

    if (!repository) {
      res.status(404).json({
        success: false,
        message: 'Repository not found',
      });
      return;
    }

    // Verify user owns the project
    const project = ProjectRepository.findById(repository.projectId);
    if (!project || project.userId !== req.user!.id) {
      res.status(403).json({
        success: false,
        message: 'Access denied',
      });
      return;
    }

    res.json({
      success: true,
      data: {
        _id: repository.id,
        ...repository,
        projectId: {
          _id: project.id,
          name: project.name,
          description: project.description,
        },
      },
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

    // Verify user owns the project
    const project = ProjectRepository.findById(validatedData.projectId);

    if (!project || project.userId !== req.user!.id) {
      res.status(404).json({
        success: false,
        message: 'Project not found or access denied',
      });
      return;
    }

    // Extract owner/repo from URL
    const repoMatch = validatedData.githubRepoUrl.match(/github\.com\/([^\/]+\/[^\/]+)/);
    if (!repoMatch) {
      res.status(400).json({
        success: false,
        message: 'Invalid GitHub repository URL format',
      });
      return;
    }

    const githubRepoName = repoMatch[1].replace(/\.git$/, '');

    // Generate unique workspaceId
    const workspaceId = `ws-${crypto.randomBytes(16).toString('hex')}`;

    const repository = RepositoryRepository.create({
      name: validatedData.name,
      description: validatedData.description,
      projectId: validatedData.projectId,
      githubRepoUrl: validatedData.githubRepoUrl,
      githubRepoName,
      githubBranch: validatedData.githubBranch,
      workspaceId,
      type: 'backend', // Default type when created via API
    });

    res.status(201).json({
      success: true,
      data: {
        _id: repository.id,
        ...repository,
      },
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

    // Find repo and verify permissions
    const repository = RepositoryRepository.findById(req.params.id);
    if (!repository) {
      res.status(404).json({
        success: false,
        message: 'Repository not found',
      });
      return;
    }

    const project = ProjectRepository.findById(repository.projectId);
    if (!project || project.userId !== req.user!.id) {
      res.status(403).json({
        success: false,
        message: 'Access denied',
      });
      return;
    }

    // Update
    const updatedRepo = RepositoryRepository.update(req.params.id, validatedData);

    res.json({
      success: true,
      data: {
        _id: updatedRepo?.id,
        ...updatedRepo,
      },
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
    const repository = RepositoryRepository.findById(req.params.id);
    if (!repository) {
      res.status(404).json({
        success: false,
        message: 'Repository not found',
      });
      return;
    }

    const project = ProjectRepository.findById(repository.projectId);
    if (!project || project.userId !== req.user!.id) {
      res.status(403).json({
        success: false,
        message: 'Access denied',
      });
      return;
    }

    // Sync workspace
    await githubService.syncWorkspace(repository.workspaceId);

    // Update timestamp
    const updatedRepo = RepositoryRepository.update(req.params.id, {
      lastSyncedAt: new Date(),
    });

    res.json({
      success: true,
      message: 'Repository synchronized successfully',
      data: {
        lastSyncedAt: updatedRepo?.lastSyncedAt,
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
    const repository = RepositoryRepository.findById(req.params.id);
    if (!repository) {
      res.status(404).json({
        success: false,
        message: 'Repository not found',
      });
      return;
    }

    const project = ProjectRepository.findById(repository.projectId);
    if (!project || project.userId !== req.user!.id) {
      res.status(403).json({
        success: false,
        message: 'Access denied',
      });
      return;
    }

    // Cleanup workspace
    await githubService.cleanupWorkspace(repository.workspaceId);

    // Delete repository
    RepositoryRepository.delete(req.params.id);

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
    const repository = RepositoryRepository.findById(req.params.id);
    if (!repository) {
      return res.status(404).json({
        success: false,
        message: 'Repository not found',
      });
    }

    const project = ProjectRepository.findById(repository.projectId);
    if (!project || project.userId !== req.user!.id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied',
      });
    }

    // Get decrypted env variables
    const envVariables = RepositoryRepository.getDecryptedEnvVariables(req.params.id);

    res.json({
      success: true,
      data: {
        envVariables: envVariables || [],
        count: envVariables?.length || 0,
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
    const repository = RepositoryRepository.findById(req.params.id);
    if (!repository) {
      return res.status(404).json({
        success: false,
        message: 'Repository not found',
      });
    }

    const project = ProjectRepository.findById(repository.projectId);
    if (!project || project.userId !== req.user!.id) {
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

    // Update repository (encryption is handled in the repository)
    RepositoryRepository.update(req.params.id, {
      envVariables: preparedEnvVars,
    });

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
    const repository = RepositoryRepository.findById(req.params.id);
    if (!repository) {
      return res.status(404).json({
        success: false,
        message: 'Repository not found',
      });
    }

    const project = ProjectRepository.findById(repository.projectId);
    if (!project || project.userId !== req.user!.id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied',
      });
    }

    // Clear env variables
    RepositoryRepository.update(req.params.id, {
      envVariables: [],
    });

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
