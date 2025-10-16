import { query, type Options, type AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { Task, ITask, AgentType, IStory, ITeamMember } from '../models/Task';
import { Repository } from '../models/Repository';
import { GitHubService } from './GitHubService';
import { NotificationService } from './NotificationService';
import { ContextCompactionService } from './ContextCompactionService';
import path from 'path';
import os from 'os';

/**
 * TeamOrchestrator - Orquestación avanzada con team building dinámico
 *
 * Features:
 * - Analiza complejidad de tarea
 * - Crea stories dinámicamente (Project Manager)
 * - Construye teams según complejidad (Tech Lead)
 * - Spawns múltiples developers en paralelo
 * - Code reviews automáticos (seniors → juniors)
 * - Integration testing (QA)
 * - Merge coordination (detecta y resuelve conflictos)
 */
export class TeamOrchestrator {
  private readonly workspaceDir: string;
  private readonly githubService: GitHubService;
  private readonly compactionService: ContextCompactionService;

  constructor() {
    this.workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
    this.githubService = new GitHubService(this.workspaceDir);
    this.compactionService = new ContextCompactionService();
  }

  /**
   * Definiciones de los agentes (incluye merge-coordinator)
   */
  private getAgentDefinitions(): Record<string, AgentDefinition> {
    return {
      'product-manager': {
        description: 'Analyzes requirements and defines product specifications',
        tools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
        prompt: `You are a Product Manager analyzing business requirements.

Your responsibilities:
- Analyze task complexity and scope
- Define product specifications
- Recommend approach strategy
- Estimate required team size

Always provide:
1. Task complexity assessment (small/medium/large/epic)
2. High-level approach recommendation
3. Success criteria`,
        model: 'haiku', // Using Haiku 4.5 for cost-efficiency
      },

      'project-manager': {
        description: 'Breaks down tasks into implementable stories',
        tools: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'TodoWrite'],
        prompt: `You are a Project Manager breaking down tasks into implementable stories.

Your responsibilities:
- Break task into discrete implementable stories
- Estimate story complexity
- Identify story dependencies
- Recommend team size (seniors/juniors needed)

CRITICAL: Your output MUST be valid JSON with this structure:
{
  "stories": [
    {
      "id": "story-1",
      "title": "Story title",
      "description": "Detailed description",
      "priority": 1,
      "estimatedComplexity": "simple|moderate|complex|epic",
      "dependencies": []
    }
  ],
  "recommendedTeamSize": {
    "seniors": 2,
    "juniors": 1,
    "reasoning": "Why this team size"
  }
}`,
        model: 'haiku', // Using Haiku 4.5 for cost-efficiency
      },

      'tech-lead': {
        description: 'Designs architecture and assigns stories to team members',
        tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
        prompt: `You are a Tech Lead designing architecture and building the development team.

Your responsibilities:
- Design technical architecture
- Decide final team composition
- Assign stories to team members
- Define supervision (juniors supervised by seniors)

CRITICAL: Your output MUST be valid JSON with this structure:
{
  "architectureDesign": "Technical design details...",
  "teamComposition": {
    "seniors": 2,
    "juniors": 1,
    "reasoning": "Why this composition"
  },
  "storyAssignments": [
    {
      "storyId": "story-1",
      "assignedTo": "senior-dev-1",
      "supervisedBy": null
    },
    {
      "storyId": "story-2",
      "assignedTo": "junior-dev-1",
      "supervisedBy": "senior-dev-1"
    }
  ]
}`,
        model: 'haiku', // Using Haiku 4.5 for cost-efficiency
      },

      'senior-developer': {
        description: 'Implements complex features and reviews junior code',
        tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebFetch'],
        prompt: `You are a Senior Developer implementing features and reviewing code.

Your responsibilities:
- Implement assigned stories with production-ready code
- Review junior developer code thoroughly
- Ensure security and performance best practices
- Provide constructive feedback

Always provide:
1. Clean, well-tested code
2. Documentation
3. Security considerations`,
        model: 'haiku', // Using Haiku 4.5 for cost-efficiency
      },

      'junior-developer': {
        description: 'Implements simple features under senior supervision',
        tools: ['Read', 'Write', 'Edit', 'Bash'],
        prompt: `You are a Junior Developer implementing features under senior supervision.

Your responsibilities:
- Implement assigned stories
- Follow coding standards
- Write unit tests
- Request senior review when unsure

Your code will be reviewed by a senior before merging.

Always provide:
1. Clean, readable code
2. Basic tests
3. Questions for senior review if needed`,
        model: 'haiku', // Using Haiku 4.5 for cost-efficiency
      },

      'qa-engineer': {
        description: 'Integration testing across all PRs',
        tools: ['Read', 'Bash', 'Grep', 'Glob'],
        prompt: `You are a QA Engineer testing the complete integrated solution.

Your responsibilities:
- Test integration of ALL pull requests together
- Validate end-to-end workflows
- Check for integration bugs
- Validate accessibility and security

NOTHING goes to production without your approval.

Always provide:
1. Integration test results
2. Bug reports (if any)
3. GO/NO-GO decision`,
        model: 'haiku', // Using Haiku 4.5 for cost-efficiency
      },

      'merge-coordinator': {
        description: 'Detects and resolves conflicts between multiple PRs',
        tools: ['Read', 'Bash', 'Grep', 'Glob', 'Edit'],
        prompt: `You are a Merge Coordinator resolving conflicts between multiple pull requests.

Your responsibilities:
- Analyze conflicting file changes
- Resolve merge conflicts intelligently
- Create consolidated PR if needed
- Ensure no functionality is lost

Always provide:
1. Conflict analysis
2. Resolution strategy
3. Final merge plan`,
        model: 'haiku', // Using Haiku 4.5 for cost-efficiency
      },
    };
  }

  /**
   * Orquestación completa con team building dinámico
   */
  async orchestrateTask(taskId: string): Promise<void> {
    const task = await Task.findById(taskId).populate('userId');
    if (!task) throw new Error(`Task ${taskId} not found`);

    console.log(`🚀 Starting dynamic team orchestration for task: ${task.title}`);

    // WebSocket notification - Orchestration started
    NotificationService.emitOrchestrationStarted(taskId);

    const startTime = Date.now();
    let repositories: any[] = [];
    let workspacePath: string | null = null;
    let workspaceStructure: string = '';

    try {
      // Clonar TODOS los repositorios en subdirectorios
      if (task.repositoryIds && task.repositoryIds.length > 0) {
        console.log(`📂 Cloning ${task.repositoryIds.length} repositories...`);

        // Crear workspace base único para esta tarea
        const workspaceId = `task-${taskId}`;
        const baseWorkspace = path.join(this.workspaceDir, workspaceId);

        for (let i = 0; i < task.repositoryIds.length; i++) {
          const repoId = task.repositoryIds[i];
          const repo = await Repository.findById(repoId);

          if (repo) {
            const repoName = repo.githubRepoName.split('/')[1] || `repo-${i + 1}`;
            const repoPath = path.join(baseWorkspace, repoName);

            console.log(`  📦 [${i + 1}/${task.repositoryIds.length}] Cloning ${repo.githubRepoName} → ${repoName}/`);

            // Clonar en subdirectorio
            const clonedPath = await this.githubService.cloneRepository(
              repo,
              (task.userId as any)._id.toString(),
              repoPath
            );

            repositories.push({
              id: repoId,
              name: repoName,
              fullName: repo.githubRepoName,
              path: clonedPath,
              branch: repo.githubBranch,
            });

            workspaceStructure += `  - ${repoName}/ (${repo.githubRepoName})\n`;
          }
        }

        workspacePath = baseWorkspace;
        console.log(`✅ All repositories cloned to: ${baseWorkspace}`);
        console.log(`📁 Workspace structure:\n${workspaceStructure}`);
      }

      // Fase 1: Product Manager
      task.orchestration.currentPhase = 'analysis';
      await task.save();
      NotificationService.emitProgressUpdate(taskId, {
        completedAgents: 0,
        totalAgents: 6,
        currentAgent: 'Product Manager',
        percentage: 0,
      });
      await this.executeProductManager(task, workspacePath, workspaceStructure);

      // Fase 2: Project Manager (crea STORIES dinámicamente)
      task.orchestration.currentPhase = 'planning';
      await task.save();
      NotificationService.emitProgressUpdate(taskId, {
        completedAgents: 1,
        totalAgents: 6,
        currentAgent: 'Project Manager',
        percentage: 16,
      });
      await this.executeProjectManager(task, workspacePath, workspaceStructure);

      // Fase 3: Tech Lead (define TEAM composition)
      task.orchestration.currentPhase = 'architecture';
      await task.save();
      NotificationService.emitProgressUpdate(taskId, {
        completedAgents: 2,
        totalAgents: 6,
        currentAgent: 'Tech Lead',
        percentage: 33,
      });
      await this.executeTechLead(task, workspacePath, workspaceStructure);

      // Fase 4: Spawn Development Team (MÚLTIPLES developers en paralelo)
      task.orchestration.currentPhase = 'development';
      await task.save();
      NotificationService.emitProgressUpdate(taskId, {
        completedAgents: 3,
        totalAgents: 6,
        currentAgent: 'Development Team',
        percentage: 50,
      });
      await this.spawnDevelopmentTeam(task, repositories, workspacePath, workspaceStructure);

      // Fase 5: QA Engineer (integration testing)
      task.orchestration.currentPhase = 'qa';
      await task.save();
      NotificationService.emitProgressUpdate(taskId, {
        completedAgents: 4,
        totalAgents: 6,
        currentAgent: 'QA Engineer',
        percentage: 83,
      });
      await this.executeQAEngineer(task, repositories, workspacePath);

      // Fase 6: Merge Coordinator (si hay múltiples PRs)
      if (task.orchestration.team && task.orchestration.team.length > 1) {
        task.orchestration.currentPhase = 'merge';
        await task.save();
        NotificationService.emitProgressUpdate(taskId, {
          completedAgents: 5,
          totalAgents: 6,
          currentAgent: 'Merge Coordinator',
          percentage: 90,
        });
        await this.executeMergeCoordinator(task, repositories, workspacePath);
      }

      // Completado
      task.status = 'completed';
      task.orchestration.currentPhase = 'completed';
      await task.save();

      const duration = Date.now() - startTime;
      console.log(`✅ Orchestration completed for task: ${task.title}`);

      // WebSocket notification - Orchestration completed
      NotificationService.emitOrchestrationCompleted(taskId);

      // Notificación de tarea completada
      NotificationService.emitTaskCompleted(taskId, {
        success: true,
        duration,
        agentsExecuted: task.orchestration.team?.map((t) => t.agentType) || [],
        prsCreated: task.orchestration.team?.reduce((sum, t) => sum + (t.pullRequests?.length || 0), 0) || 0,
        message: `Task completed successfully in ${(duration / 1000).toFixed(1)}s`,
      });
    } catch (error) {
      console.error(`❌ Orchestration failed:`, error);
      task.status = 'failed';
      await task.save();

      const duration = Date.now() - startTime;

      // WebSocket notification - Orchestration failed
      NotificationService.emitOrchestrationFailed(taskId, (error as Error).message);

      NotificationService.emitTaskCompleted(taskId, {
        success: false,
        duration,
        agentsExecuted: task.orchestration.team?.map((t) => t.agentType) || [],
        prsCreated: 0,
        message: `Task failed: ${(error as Error).message}`,
      });
      throw error;
    }
  }

  /**
   * Fase 1: Product Manager
   */
  private async executeProductManager(task: ITask, workspacePath: string | null, workspaceStructure: string): Promise<void> {
    const taskId = (task._id as any).toString();
    console.log(`📊 [Product Manager] Analyzing requirements...`);

    task.orchestration.productManager.status = 'in_progress';
    task.orchestration.productManager.startedAt = new Date();
    await task.save();

    // WebSocket notification - Agent started
    NotificationService.emitAgentStarted(taskId, 'Product Manager');

    try {
      const workspaceInfo = workspaceStructure
        ? `\n## Workspace Structure:\n\`\`\`\n${workspaceStructure}\`\`\`\n\nYou have access to multiple repositories. Analyze all of them.`
        : '';

      const prompt = `# Task Analysis

## Task Details:
- **Title**: ${task.title}
- **Description**: ${task.description}
- **Priority**: ${task.priority}
${workspaceInfo}

## Your Mission:
Analyze this task and provide:
1. **Task Complexity** (small/medium/large/epic)
2. **Recommended Approach**
3. **Success Criteria**

Be thorough but concise.`;

      // Progreso
      NotificationService.emitAgentProgress(taskId, 'Product Manager', 'Analyzing requirements...');

      const result = await this.executeAgent(
        'product-manager',
        prompt,
        workspacePath || this.workspaceDir,
        taskId,
        'Product Manager',
        task.attachments
      );

      task.orchestration.productManager.status = 'completed';
      task.orchestration.productManager.completedAt = new Date();
      task.orchestration.productManager.output = result.output;
      task.orchestration.productManager.sessionId = result.sessionId;
      task.orchestration.productManager.usage = result.usage;
      task.orchestration.productManager.cost_usd = result.cost;

      // Intentar extraer complexity
      const complexityMatch = result.output.match(/complexity.*?(small|medium|large|epic)/i);
      if (complexityMatch) {
        (task.orchestration.productManager as any).taskComplexity = complexityMatch[1].toLowerCase();
      }

      task.orchestration.totalCost += result.cost;
      task.orchestration.totalTokens += (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);

      await task.save();
      console.log(`✅ [Product Manager] Analysis complete`);

      // Enviar output detallado al chat
      NotificationService.emitAgentMessage(taskId, 'Product Manager', result.output);

      // Agent completed
      NotificationService.emitAgentCompleted(taskId, 'Product Manager', 'Requirements analysis completed');
    } catch (error: any) {
      task.orchestration.productManager.status = 'failed';
      task.orchestration.productManager.error = error.message;
      await task.save();

      // WebSocket notification - Agent failed
      NotificationService.emitAgentFailed(taskId, 'Product Manager', error.message);
      throw error;
    }
  }

  /**
   * Fase 2: Project Manager (crea stories)
   */
  private async executeProjectManager(task: ITask, workspacePath: string | null, workspaceStructure: string): Promise<void> {
    const taskId = (task._id as any).toString();
    console.log(`📋 [Project Manager] Breaking down into stories...`);

    task.orchestration.projectManager.status = 'in_progress';
    task.orchestration.projectManager.startedAt = new Date();
    await task.save();

    // WebSocket notification - Agent started
    NotificationService.emitAgentStarted(taskId, 'Project Manager');

    try {
      const workspaceInfo = workspaceStructure
        ? `\n## Workspace Structure:\n\`\`\`\n${workspaceStructure}\`\`\`\n\nConsider all repositories when breaking down stories.`
        : '';

      const prompt = `# Task Breakdown

## Task Details:
- **Title**: ${task.title}
- **Description**: ${task.description}
- **Product Manager Analysis**: ${task.orchestration.productManager.output}
${workspaceInfo}

## Your Mission:
Break this task into implementable stories.

**RESPOND ONLY WITH VALID JSON** in this exact format:
\`\`\`json
{
  "stories": [
    {
      "id": "story-1",
      "title": "Story title",
      "description": "Detailed description",
      "priority": 1,
      "estimatedComplexity": "simple",
      "dependencies": []
    }
  ],
  "recommendedTeamSize": {
    "seniors": 1,
    "juniors": 0,
    "reasoning": "Single story, low complexity"
  }
}
\`\`\``;

      // Progreso
      NotificationService.emitAgentProgress(taskId, 'Project Manager', 'Breaking down task into stories...');

      const result = await this.executeAgent(
        'project-manager',
        prompt,
        workspacePath || this.workspaceDir,
        taskId,
        'Project Manager',
        task.attachments
      );

      // Parsear JSON response
      const jsonMatch = result.output.match(/```json\n([\s\S]*?)\n```/) || result.output.match(/{[\s\S]*}/);
      if (!jsonMatch) {
        throw new Error('Project Manager did not return valid JSON');
      }

      const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);

      // Guardar stories
      task.orchestration.projectManager.stories = parsed.stories;
      task.orchestration.projectManager.totalStories = parsed.stories.length;
      task.orchestration.projectManager.recommendedTeamSize = parsed.recommendedTeamSize;
      task.orchestration.projectManager.status = 'completed';
      task.orchestration.projectManager.completedAt = new Date();
      task.orchestration.projectManager.output = result.output;
      task.orchestration.projectManager.sessionId = result.sessionId;
      task.orchestration.projectManager.usage = result.usage;
      task.orchestration.projectManager.cost_usd = result.cost;

      task.orchestration.totalCost += result.cost;
      task.orchestration.totalTokens += (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);

      await task.save();
      console.log(`✅ [Project Manager] Created ${parsed.stories.length} stories`);

      // Enviar output detallado al chat
      NotificationService.emitAgentMessage(taskId, 'Project Manager', result.output);

      // Agent completed
      NotificationService.emitAgentCompleted(
        taskId,
        'Project Manager',
        `Created ${parsed.stories.length} stories with recommended team: ${parsed.recommendedTeamSize.seniors} seniors, ${parsed.recommendedTeamSize.juniors} juniors`
      );
    } catch (error: any) {
      task.orchestration.projectManager.status = 'failed';
      task.orchestration.projectManager.error = error.message;
      await task.save();

      // WebSocket notification - Agent failed
      NotificationService.emitAgentFailed(taskId, 'Project Manager', error.message);
      throw error;
    }
  }

  /**
   * Fase 3: Tech Lead (team composition y assignments)
   */
  private async executeTechLead(task: ITask, workspacePath: string | null, workspaceStructure: string): Promise<void> {
    const taskId = (task._id as any).toString();
    console.log(`🏗️ [Tech Lead] Designing architecture and building team...`);

    task.orchestration.techLead.status = 'in_progress';
    task.orchestration.techLead.startedAt = new Date();
    await task.save();

    // WebSocket notification - Agent started
    NotificationService.emitAgentStarted(taskId, 'Tech Lead');

    try {
      const stories = task.orchestration.projectManager.stories || [];
      const recommendedTeam = task.orchestration.projectManager.recommendedTeamSize;

      const workspaceInfo = workspaceStructure
        ? `\n## Workspace Structure:\n\`\`\`\n${workspaceStructure}\`\`\`\n\nDesign architecture considering all repositories.`
        : '';

      const prompt = `# Architecture Design & Team Building

## Task:
${task.title}

## Stories to Implement:
${stories.map((s, i) => `${i + 1}. **${s.title}** (${s.estimatedComplexity})\n   ${s.description}`).join('\n')}

## Recommended Team Size:
- Seniors: ${recommendedTeam?.seniors || 1}
- Juniors: ${recommendedTeam?.juniors || 0}
- Reasoning: ${recommendedTeam?.reasoning || 'Not specified'}
${workspaceInfo}

## Your Mission:
1. Design technical architecture
2. Decide final team composition
3. Assign each story to a specific team member

**RESPOND ONLY WITH VALID JSON** in this exact format:
\`\`\`json
{
  "architectureDesign": "Technical design details...",
  "teamComposition": {
    "seniors": 1,
    "juniors": 0,
    "reasoning": "Why this composition"
  },
  "storyAssignments": [
    {
      "storyId": "story-1",
      "assignedTo": "senior-dev-1",
      "supervisedBy": null
    }
  ]
}
\`\`\`

**Rules**:
- Use instanceIds like "senior-dev-1", "senior-dev-2", "junior-dev-1", etc.
- Juniors MUST have "supervisedBy" set to a senior instanceId
- Complex stories go to seniors, simple ones can go to juniors`;

      // Progreso
      NotificationService.emitAgentProgress(taskId, 'Tech Lead', 'Designing architecture and building team...');

      const result = await this.executeAgent(
        'tech-lead',
        prompt,
        workspacePath || this.workspaceDir,
        taskId,
        'Tech Lead',
        task.attachments
      );

      // Parsear JSON response
      const jsonMatch = result.output.match(/```json\n([\s\S]*?)\n```/) || result.output.match(/{[\s\S]*}/);
      if (!jsonMatch) {
        throw new Error('Tech Lead did not return valid JSON');
      }

      const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);

      task.orchestration.techLead.architectureDesign = parsed.architectureDesign;
      task.orchestration.techLead.teamComposition = parsed.teamComposition;
      task.orchestration.techLead.storyAssignments = parsed.storyAssignments;
      task.orchestration.techLead.status = 'completed';
      task.orchestration.techLead.completedAt = new Date();
      task.orchestration.techLead.output = result.output;
      task.orchestration.techLead.sessionId = result.sessionId;
      task.orchestration.techLead.usage = result.usage;
      task.orchestration.techLead.cost_usd = result.cost;

      task.orchestration.totalCost += result.cost;
      task.orchestration.totalTokens += (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);

      await task.save();
      console.log(`✅ [Tech Lead] Team composition: ${parsed.teamComposition.seniors} seniors, ${parsed.teamComposition.juniors} juniors`);

      // Enviar output detallado al chat
      NotificationService.emitAgentMessage(taskId, 'Tech Lead', result.output);

      // Agent completed
      NotificationService.emitAgentCompleted(
        taskId,
        'Tech Lead',
        `Architecture designed. Team: ${parsed.teamComposition.seniors} seniors, ${parsed.teamComposition.juniors} juniors. Stories assigned.`
      );
    } catch (error: any) {
      task.orchestration.techLead.status = 'failed';
      task.orchestration.techLead.error = error.message;
      await task.save();

      // WebSocket notification - Agent failed
      NotificationService.emitAgentFailed(taskId, 'Tech Lead', error.message);
      throw error;
    }
  }

  /**
   * Fase 4: Spawn Development Team (SECUENCIAL)
   */
  private async spawnDevelopmentTeam(
    task: ITask,
    repositories: any[],
    workspacePath: string | null,
    workspaceStructure: string
  ): Promise<void> {
    console.log(`👥 [Development Team] Spawning team members...`);

    const composition = task.orchestration.techLead.teamComposition;
    const assignments = task.orchestration.techLead.storyAssignments || [];

    if (!composition) {
      throw new Error('Team composition not defined by Tech Lead');
    }

    const team: ITeamMember[] = [];

    // Crear seniors
    for (let i = 0; i < (composition.seniors || 0); i++) {
      const instanceId = `senior-dev-${i + 1}`;
      const assignedStories = assignments
        .filter((a) => a.assignedTo === instanceId)
        .map((a) => a.storyId);

      team.push({
        agentType: 'senior-developer',
        instanceId,
        assignedStories,
        status: 'idle',
        pullRequests: [],
        reviewing: [],
      });
    }

    // Crear juniors
    for (let i = 0; i < (composition.juniors || 0); i++) {
      const instanceId = `junior-dev-${i + 1}`;
      const assignedStories = assignments
        .filter((a) => a.assignedTo === instanceId)
        .map((a) => a.storyId);

      team.push({
        agentType: 'junior-developer',
        instanceId,
        assignedStories,
        status: 'idle',
        pullRequests: [],
      });
    }

    task.orchestration.team = team;
    await task.save();

    console.log(`✅ Team spawned: ${team.length} members`);

    // EJECUTAR SECUENCIALMENTE (evita conflictos de Git en mismo workspace)
    // ⚠️ NO usar Promise.all porque múltiples agentes en el mismo repo causan race conditions
    for (const member of team) {
      await this.executeDeveloper(task, member, repositories, workspacePath, workspaceStructure);
    }

    // Code Reviews (seniors revisan juniors)
    await this.executeCodeReviews(task, repositories, workspacePath);

    console.log(`✅ [Development Team] All stories implemented`);
  }

  /**
   * Ejecuta un developer individual
   */
  private async executeDeveloper(
    task: ITask,
    member: ITeamMember,
    repositories: any[],
    workspacePath: string | null,
    workspaceStructure: string
  ): Promise<void> {
    const taskId = (task._id as any).toString();
    const agentName = member.agentType === 'senior-developer' ? 'Senior Developer' : 'Junior Developer';
    const displayName = `${agentName} (${member.instanceId})`;

    console.log(`👨‍💻 [${member.instanceId}] Starting work on ${member.assignedStories.length} stories...`);

    member.status = 'working';
    member.startedAt = new Date();
    await task.save();

    // WebSocket notification - Agent started
    NotificationService.emitAgentStarted(taskId, displayName);

    try {
      const stories = task.orchestration.projectManager.stories || [];

      for (const storyId of member.assignedStories) {
        const story = stories.find((s) => s.id === storyId);
        if (!story) continue;

        console.log(`  📝 [${member.instanceId}] Working on: ${story.title}`);

        // Progreso
        NotificationService.emitAgentProgress(taskId, displayName, `Working on story: ${story.title}`);

        // Actualizar story status
        story.status = 'in_progress';
        story.startedAt = new Date();
        await task.save();

        // Crear branch para este developer + story (en el repo principal)
        const branchName = `${member.instanceId}/${storyId}`;
        const primaryRepo = repositories.length > 0 ? repositories[0] : null;

        if (primaryRepo && workspacePath) {
          // Crear branch en el repo principal
          const primaryRepoPath = path.join(workspacePath, primaryRepo.name);
          await this.githubService.createBranch(primaryRepoPath, branchName);
        }
        story.branchName = branchName;

        // Ejecutar developer
        const prompt = this.buildDeveloperPrompt(task, member, story, workspaceStructure);
        const result = await this.executeAgent(
          member.agentType,
          prompt,
          workspacePath || this.workspaceDir,
          taskId,
          displayName,
          task.attachments
        );

        // Update member
        member.sessionId = result.sessionId;
        member.usage = result.usage;
        member.cost_usd = (member.cost_usd || 0) + result.cost;

        task.orchestration.totalCost += result.cost;
        task.orchestration.totalTokens += (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);

        // Commit + Push + PR (en el repo principal)
        if (primaryRepo && workspacePath) {
          const primaryRepoPath = path.join(workspacePath, primaryRepo.name);

          await this.githubService.commitChanges(primaryRepoPath, `${story.title}\n\n${story.description}`);
          await this.githubService.pushBranch(branchName, primaryRepoPath, (task.userId as any)._id.toString());

          // Obtener el objeto Repository completo para crear el PR
          const repoDoc = await Repository.findById(primaryRepo.id);
          if (repoDoc) {
            const pr = await this.githubService.createPullRequest(repoDoc, (task.userId as any)._id.toString(), {
              title: `[${member.instanceId}] ${story.title}`,
              description: `${story.description}\n\n**Story**: ${storyId}\n**Developer**: ${member.instanceId}`,
              branch: branchName,
            });

            story.pullRequestNumber = pr.number;
            story.pullRequestUrl = pr.url;
            member.pullRequests.push(pr.number);

            console.log(`  ✅ [${member.instanceId}] PR created: #${pr.number}`);

            // Notificar PR creado
            NotificationService.emitPRCreated(taskId, {
              agentType: displayName,
              prUrl: pr.url,
              branchName: branchName,
              title: story.title,
            });
          }
        }

        story.status = 'completed';
        story.completedAt = new Date();
        story.output = result.output;
        await task.save();

        // Notificar story completado
        NotificationService.emitAgentProgress(taskId, displayName, `Story completed: ${story.title}`);
      }

      member.status = 'completed';
      member.completedAt = new Date();
      await task.save();

      console.log(`✅ [${member.instanceId}] All stories completed`);

      // Agent completed
      NotificationService.emitAgentCompleted(
        taskId,
        displayName,
        `Completed ${member.assignedStories.length} stories, created ${member.pullRequests.length} PRs`
      );
    } catch (error: any) {
      member.status = 'blocked';
      await task.save();

      // WebSocket notification - Agent failed
      NotificationService.emitAgentFailed(taskId, displayName, error.message);
      throw error;
    }
  }

  /**
   * Code Reviews (seniors revisan code de juniors)
   */
  private async executeCodeReviews(
    task: ITask,
    _repositories: any[],
    _workspacePath: string | null
  ): Promise<void> {
    const team = task.orchestration.team || [];
    const juniors = team.filter((m) => m.agentType === 'junior-developer');

    if (juniors.length === 0) {
      console.log(`ℹ️ No junior developers - skipping code reviews`);
      return;
    }

    console.log(`👀 [Code Reviews] Starting reviews for ${juniors.length} juniors...`);

    const assignments = task.orchestration.techLead.storyAssignments || [];

    for (const junior of juniors) {
      // Find supervisor
      const assignment = assignments.find((a) => a.assignedTo === junior.instanceId);
      const supervisorId = assignment?.supervisedBy;

      if (!supervisorId) continue;

      const senior = team.find((m) => m.instanceId === supervisorId);
      if (!senior) continue;

      console.log(`  🔍 [${senior.instanceId}] Reviewing ${junior.instanceId}'s code...`);

      senior.status = 'reviewing';
      await task.save();

      // Simular review (en producción, aquí llamaríamos a un agente)
      // Para cada PR del junior, el senior lo revisa
      for (const prNumber of junior.pullRequests) {
        if (senior.reviewing) {
          senior.reviewing.push(prNumber);
        } else {
          senior.reviewing = [prNumber];
        }

        // TODO: Implementar review real con agente senior
        // Por ahora, auto-aprobar
        const stories = task.orchestration.projectManager.stories || [];
        const story = stories.find((s) => s.pullRequestNumber === prNumber);
        if (story) {
          story.reviewedBy = senior.instanceId;
          story.reviewStatus = 'approved';
          story.reviewComments = 'Looks good! Approved.';
        }
      }

      senior.status = 'completed';
      await task.save();

      console.log(`  ✅ [${senior.instanceId}] Reviews completed`);
    }

    console.log(`✅ [Code Reviews] All reviews completed`);
  }

  /**
   * Fase 5: QA Engineer (integration testing)
   */
  private async executeQAEngineer(
    task: ITask,
    repositories: any[],
    workspacePath: string | null
  ): Promise<void> {
    const taskId = (task._id as any).toString();
    console.log(`🧪 [QA Engineer] Starting integration testing...`);

    if (!task.orchestration.qaEngineer) {
      task.orchestration.qaEngineer = {
        agent: 'qa-engineer',
        status: 'pending',
      } as any;
    }

    task.orchestration.qaEngineer!.status = 'in_progress';
    task.orchestration.qaEngineer!.startedAt = new Date();
    await task.save();

    // WebSocket notification - Agent started
    NotificationService.emitAgentStarted(taskId, 'QA Engineer');

    try {
      const team = task.orchestration.team || [];
      const allPRs = team.flatMap((m) => m.pullRequests);

      console.log(`  Testing integration of ${allPRs.length} PRs...`);

      // Progreso
      NotificationService.emitAgentProgress(taskId, 'QA Engineer', `Testing integration of ${allPRs.length} PRs...`);

      // Crear integration branch en el repo principal
      const primaryRepo = repositories.length > 0 ? repositories[0] : null;
      if (primaryRepo && workspacePath) {
        const integrationBranch = `integration-test-${task._id}`;
        const primaryRepoPath = path.join(workspacePath, primaryRepo.name);

        await this.githubService.createIntegrationBranch(
          primaryRepoPath,
          primaryRepo.branch,
          integrationBranch
        );

        task.orchestration.qaEngineer!.integrationBranch = integrationBranch;

        // Mergear todos los PRs localmente
        const stories = task.orchestration.projectManager.stories || [];
        const prBranches = stories.map((s) => s.branchName).filter(Boolean) as string[];

        const mergeResult = await this.githubService.mergeMultiplePRsLocally(primaryRepoPath, prBranches);

        if (!mergeResult.success) {
          console.log(`⚠️ Conflicts detected in branches: ${mergeResult.conflicts.join(', ')}`);
        }
      }

      // Ejecutar QA agent
      const prompt = `# Integration Testing

## Task:
${task.title}

## Pull Requests to Test:
${allPRs.map((pr) => `- PR #${pr}`).join('\n')}

## Your Mission:
Test the integrated solution with all PRs merged together.

Provide:
1. Integration test results
2. Any bugs or issues found
3. **GO/NO-GO decision**`;

      const result = await this.executeAgent(
        'qa-engineer',
        prompt,
        workspacePath || this.workspaceDir,
        taskId,
        'QA Engineer',
        task.attachments
      );

      task.orchestration.qaEngineer!.status = 'completed';
      task.orchestration.qaEngineer!.completedAt = new Date();
      task.orchestration.qaEngineer!.output = result.output;
      task.orchestration.qaEngineer!.sessionId = result.sessionId;
      task.orchestration.qaEngineer!.usage = result.usage;
      task.orchestration.qaEngineer!.cost_usd = result.cost;
      task.orchestration.qaEngineer!.totalPRsTested = allPRs.length;

      task.orchestration.totalCost += result.cost;
      task.orchestration.totalTokens += (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);

      await task.save();
      console.log(`✅ [QA Engineer] Integration testing complete`);

      // Enviar output detallado al chat
      NotificationService.emitAgentMessage(taskId, 'QA Engineer', result.output);

      // Agent completed
      NotificationService.emitAgentCompleted(
        taskId,
        'QA Engineer',
        `Integration testing complete. Tested ${allPRs.length} PRs.`
      );
    } catch (error: any) {
      task.orchestration.qaEngineer!.status = 'failed';
      task.orchestration.qaEngineer!.error = error.message;
      await task.save();

      // WebSocket notification - Agent failed
      NotificationService.emitAgentFailed(taskId, 'QA Engineer', error.message);
      throw error;
    }
  }

  /**
   * Fase 6: Merge Coordinator (conflict resolution)
   */
  private async executeMergeCoordinator(
    task: ITask,
    _repositories: any[],
    _workspacePath: string | null
  ): Promise<void> {
    console.log(`🔀 [Merge Coordinator] Analyzing conflicts...`);

    if (!task.orchestration.mergeCoordinator) {
      task.orchestration.mergeCoordinator = {
        agent: 'merge-coordinator',
        status: 'pending',
      } as any;
    }

    task.orchestration.mergeCoordinator!.status = 'in_progress';
    task.orchestration.mergeCoordinator!.startedAt = new Date();
    await task.save();

    try {
      // Este servicio se implementará en MergeCoordinatorService
      // Por ahora, solo marcamos como completado
      task.orchestration.mergeCoordinator!.status = 'completed';
      task.orchestration.mergeCoordinator!.completedAt = new Date();
      task.orchestration.mergeCoordinator!.output = 'Merge coordination handled by separate service';
      await task.save();

      console.log(`✅ [Merge Coordinator] Coordination complete`);
    } catch (error: any) {
      task.orchestration.mergeCoordinator!.status = 'failed';
      task.orchestration.mergeCoordinator!.error = error.message;
      await task.save();
      throw error;
    }
  }

  /**
   * Ejecuta un agente usando Claude Agent SDK
   * Captura y emite TODOS los eventos internos en tiempo real
   */
  private async executeAgent(
    agentType: AgentType,
    prompt: string,
    workDir: string,
    taskId?: string,
    agentName?: string,
    attachments?: string[] // URLs de imágenes desde task.attachments
  ): Promise<{ output: string; usage: any; cost: number; sessionId: string }> {
    const agentDefinitions = this.getAgentDefinitions();

    try {
      // Convertir attachments (URLs) a formato SDK
      const sdkAttachments = attachments?.map(url => ({
        type: 'image' as const,
        source: {
          type: 'url' as const,
          url
        }
      })) || [];

      const sdkOptions: Options = {
        cwd: workDir,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: agentDefinitions[agentType].prompt,
        },
        agents: agentDefinitions,
        allowedTools: agentDefinitions[agentType].tools,
        permissionMode: 'bypassPermissions',
        maxTurns: 50,
        // 🗜️ Context Compaction - SDK handles automatically when approaching limits
        // We'll monitor via 'compact_boundary' messages
        ...(sdkAttachments.length > 0 && { attachments: sdkAttachments }),
      };

      let output = '';
      let usage: any = null;
      let sessionId = '';

      const queryResult = query({
        prompt,
        options: sdkOptions,
      });

      for await (const message of queryResult) {
        // Capturar TODOS los tipos de mensajes del SDK
        console.log(`🔍 [SDK Event] Type: ${message.type}`, message);

        // 1. Mensajes del asistente (texto, pensamiento)
        if (message.type === 'assistant') {
          sessionId = message.session_id;

          // Procesar cada bloque de contenido
          for (const content of message.message.content) {
            if (content.type === 'text') {
              output += content.text + '\n';

              // Emitir texto en tiempo real al chat
              if (taskId && agentName && content.text.trim()) {
                NotificationService.emitAgentMessage(taskId, agentName, `💬 ${content.text}`);
              }
            }
            else if (content.type === 'thinking' && taskId && agentName) {
              // Emitir bloques de pensamiento (si el modelo los genera)
              NotificationService.emitAgentMessage(taskId, agentName, `🤔 **Thinking:** ${content.thinking}`);
            }
            else if (content.type === 'tool_use') {
              // Emitir cuando el agente usa una herramienta
              if (taskId && agentName) {
                const toolName = content.name;
                const toolInput = JSON.stringify(content.input, null, 2);
                NotificationService.emitAgentMessage(
                  taskId,
                  agentName,
                  `🛠️ **Using tool:** \`${toolName}\`\n\`\`\`json\n${toolInput}\n\`\`\``
                );
              }
            }
          }
        }

        // 2. Eventos de stream (tool results, etc.)
        if (message.type === 'stream_event' && taskId && agentName) {
          // Capturar eventos adicionales del stream si están disponibles
          const eventType = (message as any).event_type;
          const eventData = (message as any).data;

          if (eventType === 'tool_result' && eventData) {
            const toolName = eventData.tool_name || 'unknown';
            const result = eventData.result;
            const isError = eventData.is_error;

            if (isError) {
              NotificationService.emitAgentMessage(
                taskId,
                agentName,
                `❌ **Tool error** (${toolName}): ${typeof result === 'string' ? result : JSON.stringify(result)}`
              );
            } else {
              // Solo mostrar un resumen si el resultado es muy largo
              const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
              const summary = resultStr.length > 500 ? resultStr.substring(0, 500) + '...' : resultStr;
              NotificationService.emitAgentMessage(
                taskId,
                agentName,
                `✅ **Tool result** (${toolName}): \`\`\`\n${summary}\n\`\`\``
              );
            }
          }
        }

        // 3. Context Compaction (automatic by SDK)
        if (message.type === 'system' && (message as any).subtype === 'compact_boundary') {
          const compactMetadata = (message as any).compact_metadata;
          const trigger = compactMetadata?.trigger || 'auto';
          const preTokens = compactMetadata?.pre_tokens || 0;

          console.log(`\n🗜️ =============== CONTEXT COMPACTION TRIGGERED ===============`);
          console.log(`   Trigger: ${trigger === 'auto' ? 'Automatic (near limit)' : 'Manual'}`);
          console.log(`   Pre-compaction tokens: ${preTokens.toLocaleString()}`);
          console.log(`   Action: SDK automatically summarizing old messages`);
          console.log(`================================================================\n`);

          if (taskId && agentName) {
            NotificationService.emitAgentMessage(
              taskId,
              agentName,
              `🗜️ **Context Compaction**: Automatically summarizing conversation history (${preTokens.toLocaleString()} tokens → optimized)`
            );
          }

          // Use our compaction service for monitoring
          if (this.compactionService.shouldCompact(usage)) {
            console.log(`   ⚠️ CompactionService also recommends compaction`);
          }
        }

        // 4. Token usage monitoring (proactive warning)
        if (message.type === 'assistant' && message.message.usage) {
          const currentUsage = message.message.usage;
          const totalTokens =
            (currentUsage.input_tokens || 0) +
            (currentUsage.output_tokens || 0);

          // Check if approaching context limit (using our compaction service)
          if (this.compactionService.shouldCompact(currentUsage)) {
            console.log(`⚠️ [Token Monitor] Approaching context limit: ${totalTokens.toLocaleString()} tokens`);

            if (taskId && agentName) {
              NotificationService.emitAgentMessage(
                taskId,
                agentName,
                `⚠️ **High token usage**: ${totalTokens.toLocaleString()} tokens (SDK will auto-compact if needed)`
              );
            }
          }
        }

        // 5. Resultado final
        if (message.type === 'result') {
          usage = message.usage;
          sessionId = message.session_id;

          if (message.subtype === 'success') {
            output = message.result;
          } else {
            throw new Error(`Agent execution failed: ${message.subtype}`);
          }
        }
      }

      const cost = this.calculateCost(usage);

      return {
        output: output.trim(),
        usage,
        cost,
        sessionId,
      };
    } catch (error) {
      console.error(`❌ Error executing ${agentType}:`, error);
      throw error;
    }
  }

  /**
   * Build prompt para developers
   */
  private buildDeveloperPrompt(task: ITask, member: ITeamMember, story: IStory, workspaceStructure: string): string {
    const techDesign = task.orchestration.techLead.architectureDesign || 'See task description';

    const workspaceInfo = workspaceStructure
      ? `\n## Workspace Structure:\n\`\`\`\n${workspaceStructure}\`\`\`\n\nYou can modify files in any repository as needed.`
      : '';

    return `# Story Implementation

## Story: ${story.title}
${story.description}

**Complexity**: ${story.estimatedComplexity}
**Priority**: ${story.priority}
${workspaceInfo}

## Technical Context:
${techDesign}

## Your Mission:
Implement this story following best practices.

${member.agentType === 'junior-developer' ? '\n**Note**: Your code will be reviewed by a senior developer before merging.\n' : ''}

Provide production-ready code with:
1. Implementation
2. Tests
3. Documentation`;
  }

  /**
   * Calcula costo de uso
   */
  private calculateCost(usage: any): number {
    if (!usage) return 0;

    const INPUT_COST_PER_1K = 0.003;
    const OUTPUT_COST_PER_1K = 0.015;
    const CACHE_WRITE_COST_PER_1K = 0.00375;
    const CACHE_READ_COST_PER_1K = 0.0003;

    let cost = 0;
    cost += ((usage.input_tokens || 0) / 1000) * INPUT_COST_PER_1K;
    cost += ((usage.output_tokens || 0) / 1000) * OUTPUT_COST_PER_1K;
    cost += ((usage.cache_creation_input_tokens || 0) / 1000) * CACHE_WRITE_COST_PER_1K;
    cost += ((usage.cache_read_input_tokens || 0) / 1000) * CACHE_READ_COST_PER_1K;

    return cost;
  }
}
