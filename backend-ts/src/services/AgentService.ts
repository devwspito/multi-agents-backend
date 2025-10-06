import { query, type SDKMessage, type Options, type AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { env } from '../config/env';
import { Task, ITask, AgentType, IAgentStep } from '../models/Task';
import path from 'path';
import os from 'os';

/**
 * AgentService - Orquestación de agentes usando Claude Agent SDK oficial
 *
 * Sigue el patrón oficial del SDK:
 * 1. Gather context (search, read files, analyze)
 * 2. Take action (bash, file operations, code generation)
 * 3. Verify work (tests, validation, checks)
 * 4. Repeat
 */
export class AgentService {
  private readonly workspaceDir: string;

  constructor() {
    // Directorio de trabajo para los agentes
    this.workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
  }

  /**
   * Definiciones de los 6 agentes especializados
   */
  private getAgentDefinitions(): Record<string, AgentDefinition> {
    return {
      'product-manager': {
        description: 'Analyzes business requirements and defines product specifications. Use for requirements analysis and stakeholder communication.',
        tools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
        prompt: `You are a Product Manager analyzing requirements and defining product specifications.

Your responsibilities:
- Analyze business stakeholder requirements
- Define product specifications and objectives
- Prioritize features based on business impact
- Communicate with executive leadership

Always provide:
1. Clear requirements documentation
2. Acceptance criteria with business context
3. Priority justification
4. Stakeholder communication plan`,
        model: 'sonnet',
      },

      'project-manager': {
        description: 'Breaks down business epics into implementable stories. Use for task breakdown and sprint planning.',
        tools: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'TodoWrite'],
        prompt: `You are a Project Manager breaking down epics into implementable stories.

Your responsibilities:
- Break down business epics into stories
- Manage sprint planning and development cycles
- Coordinate with business calendar and milestones
- Report progress to business stakeholders

Always provide:
1. Story breakdown with clear tasks
2. Sprint planning with estimates
3. Dependencies and risks
4. Progress tracking`,
        model: 'sonnet',
      },

      'tech-lead': {
        description: 'Designs technical architecture and mentors development team. Use for architecture decisions and technical guidance.',
        tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
        prompt: `You are a Tech Lead designing architecture and mentoring the team.

Your responsibilities:
- Design technical architecture for software systems
- Assign stories to Senior Developers
- Ensure security and performance compliance
- Mentor Senior Developers on best practices

Always provide:
1. Architecture design documents
2. Security and performance guidelines
3. Technical standards
4. Mentorship feedback`,
        model: 'sonnet',
      },

      'senior-developer': {
        description: 'Implements complex features and reviews all junior code. Use for complex implementation and code review.',
        tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebFetch'],
        prompt: `You are a Senior Developer implementing complex features and reviewing code.

Your responsibilities:
- Implement complex software features (API, data processing)
- Review ALL Junior Developer code before merge
- Ensure GDPR/security compliance
- Mentor Junior Developers with technical context

Always provide:
1. Production-ready code
2. Comprehensive code reviews
3. Security compliance checks
4. Mentorship guidance`,
        model: 'sonnet',
      },

      'junior-developer': {
        description: 'Implements UI components and simple features under senior supervision. Use for frontend and simple features.',
        tools: ['Read', 'Write', 'Edit', 'Bash'],
        prompt: `You are a Junior Developer implementing UI and simple features under senior supervision.

Your responsibilities:
- Implement UI components and simple features
- Follow senior guidance and coding standards
- Write unit tests with business context
- Learn technical domain knowledge

Code MUST be reviewed by Senior before merge.

Always provide:
1. Clean, readable code
2. Unit tests
3. Documentation
4. Questions for senior review`,
        model: 'sonnet',
      },

      'qa-engineer': {
        description: 'Final quality gate with comprehensive testing. NOTHING goes to production without QA approval.',
        tools: ['Read', 'Bash', 'Grep', 'Glob'],
        prompt: `You are a QA Engineer - the FINAL GATE before production.

Your responsibilities:
- Test software workflows and user journeys
- Validate WCAG 2.1 AA accessibility compliance
- Perform security and performance testing
- Validate system integration functionality
- Sign off on quality metrics

NOTHING deploys without your approval.

Always provide:
1. Complete test results
2. Accessibility validation
3. Security audit
4. Performance metrics
5. GO/NO-GO decision`,
        model: 'sonnet',
      },
    };
  }

  /**
   * Ejecuta un agente específico con Claude Agent SDK
   */
  async executeAgent(
    agentType: AgentType,
    prompt: string,
    taskId: string,
    options?: Partial<Options>
  ): Promise<{ output: string; usage: any; cost: number; sessionId: string }> {
    console.log(`🤖 Executing ${agentType} agent for task ${taskId}...`);

    const agentDefinitions = this.getAgentDefinitions();
    const workDir = path.join(this.workspaceDir, taskId);

    try {
      // Configuración del SDK
      const sdkOptions: Options = {
        cwd: workDir,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: agentDefinitions[agentType].prompt,
        },
        agents: agentDefinitions,
        allowedTools: agentDefinitions[agentType].tools,
        permissionMode: 'bypassPermissions', // En producción: 'default'
        settingSources: ['project'], // Cargar CLAUDE.md si existe
        maxTurns: 50,
        ...options,
      };

      let output = '';
      let usage: any = null;
      let sessionId = '';

      // Ejecutar agente con SDK
      const queryResult = query({
        prompt,
        options: sdkOptions,
      });

      // Procesar mensajes del agente
      for await (const message of queryResult) {
        this.handleAgentMessage(message, taskId, agentType);

        if (message.type === 'assistant') {
          const textContent = message.message.content.find((c: any) => c.type === 'text');
          if (textContent) {
            output += textContent.text + '\n';
          }
          sessionId = message.session_id;
        }

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

      // Calcular costo (aproximado)
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
   * Orquesta todos los 6 agentes en secuencia
   */
  async orchestrateTask(taskId: string): Promise<void> {
    const task = await Task.findById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    console.log(`🚀 Starting orchestration for task: ${task.title}`);

    const agents: AgentType[] = [
      'product-manager',
      'project-manager',
      'tech-lead',
      'senior-developer',
      'junior-developer',
      'qa-engineer',
    ];

    // Inicializar pipeline si no existe
    if (!task.orchestration.pipeline || task.orchestration.pipeline.length === 0) {
      task.orchestration.pipeline = agents.map((agent) => ({
        agent,
        status: 'pending' as const,
      }));
      await task.save();
    }

    // Ejecutar cada agente en secuencia
    for (const agentType of agents) {
      await this.executeAgentStep(task, agentType);
    }

    // Marcar tarea como completada
    task.status = 'completed';
    await task.save();

    console.log(`✅ Orchestration completed for task: ${task.title}`);
  }

  /**
   * Ejecuta un paso del pipeline de agentes
   */
  private async executeAgentStep(task: ITask, agentType: AgentType): Promise<void> {
    const step = task.orchestration.pipeline.find((s) => s.agent === agentType);
    if (!step) return;

    if (step.status !== 'pending') {
      console.log(`⏭️ Skipping ${agentType} (already ${step.status})`);
      return;
    }

    try {
      // Actualizar estado
      step.status = 'in_progress';
      step.startedAt = new Date();
      task.orchestration.currentAgent = agentType;
      await task.save();

      // Preparar prompt para el agente
      const prompt = this.buildAgentPrompt(task, agentType);

      // Ejecutar agente
      const result = await this.executeAgent(agentType, prompt, task._id.toString());

      // Actualizar resultado
      step.status = 'completed';
      step.completedAt = new Date();
      step.output = result.output;
      step.sessionId = result.sessionId;
      step.usage = result.usage;
      step.cost_usd = result.cost;

      task.orchestration.totalCost += result.cost;
      task.orchestration.totalTokens += (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);

      await task.save();

      console.log(`✅ ${agentType} completed successfully`);
    } catch (error: any) {
      console.error(`❌ ${agentType} failed:`, error);

      step.status = 'failed';
      step.completedAt = new Date();
      step.error = error.message;

      task.status = 'failed';
      await task.save();

      throw error;
    }
  }

  /**
   * Construye el prompt para cada agente basado en el contexto de la tarea
   */
  private buildAgentPrompt(task: ITask, agentType: AgentType): string {
    const previousOutputs = task.orchestration.pipeline
      .filter((s) => s.status === 'completed' && s.output)
      .map((s) => `## ${s.agent} Output:\n${s.output}`)
      .join('\n\n');

    return `# Task: ${task.title}

## Description:
${task.description}

## Previous Agent Outputs:
${previousOutputs || 'No previous outputs yet.'}

## Your Mission as ${agentType}:
Please complete your part of this task following your role's responsibilities.

${agentType === 'qa-engineer' ? '**IMPORTANT**: This is the FINAL GATE. Provide comprehensive testing and a clear GO/NO-GO decision.' : ''}
`;
  }

  /**
   * Maneja mensajes del agente para logging y debugging
   */
  private handleAgentMessage(message: SDKMessage, taskId: string, agentType: AgentType): void {
    if (message.type === 'system' && message.subtype === 'init') {
      console.log(`📊 [${agentType}] Initialized with tools:`, message.tools.join(', '));
    }

    if (message.type === 'assistant') {
      const toolUses = message.message.content.filter((c: any) => c.type === 'tool_use');
      if (toolUses.length > 0) {
        console.log(`🔧 [${agentType}] Using tools:`, toolUses.map((t: any) => t.name).join(', '));
      }
    }
  }

  /**
   * Calcula el costo aproximado basado en el uso de tokens
   */
  private calculateCost(usage: any): number {
    if (!usage) return 0;

    // Precios de Claude 3.5 Sonnet (aproximados)
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
