import { Task } from '../models/Task';

/**
 * ⏱️ TIME ESTIMATION SERVICE (Low Priority Improvement)
 *
 * Servicio para estimar tiempos de ejecución basándose en historia.
 * Beneficios:
 * - Usuario sabe cuánto falta
 * - Mejor UX con estimaciones realistas
 * - Detectar si task está atorada
 */

interface StoryComplexityStats {
  count: number;
  totalTime: number; // milliseconds
  avgTime: number; // minutes
}

interface AgentStats {
  count: number;
  totalTime: number; // milliseconds
  avgTime: number; // minutes
}

export class TimeEstimationService {
  private static instance: TimeEstimationService;

  // Cache de estadísticas (renovar cada hora)
  private cachedStats: {
    storyComplexity: Record<string, StoryComplexityStats>;
    agents: Record<string, AgentStats>;
    lastUpdated: Date;
  } | null = null;

  private readonly CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora

  private constructor() {}

  static getInstance(): TimeEstimationService {
    if (!TimeEstimationService.instance) {
      TimeEstimationService.instance = new TimeEstimationService();
    }
    return TimeEstimationService.instance;
  }

  /**
   * Obtiene estadísticas históricas de tiempos de ejecución
   */
  private async getHistoricalStats(): Promise<typeof this.cachedStats> {
    // Usar cache si es reciente
    if (
      this.cachedStats &&
      Date.now() - this.cachedStats.lastUpdated.getTime() < this.CACHE_TTL_MS
    ) {
      return this.cachedStats;
    }

    console.log('📊 [Time Estimation] Calculating historical stats from completed tasks...');

    // Obtener tasks completadas recientes (últimas 50)
    const completedTasks = await Task.find({
      status: 'completed',
      'orchestration.currentPhase': 'completed',
    })
      .sort({ completedAt: -1 })
      .limit(50)
      .select('orchestration');

    // Calcular stats por complejidad de story
    const storyComplexity: Record<string, StoryComplexityStats> = {
      trivial: { count: 0, totalTime: 0, avgTime: 0 },
      simple: { count: 0, totalTime: 0, avgTime: 0 },
      moderate: { count: 0, totalTime: 0, avgTime: 0 },
      complex: { count: 0, totalTime: 0, avgTime: 0 },
      epic: { count: 0, totalTime: 0, avgTime: 0 },
    };

    // Calcular stats por agente
    const agents: Record<string, AgentStats> = {};

    for (const task of completedTasks) {
      // Stories from epics
      const epics = task.orchestration.techLead.epics || [];
      for (const epic of epics) {
        // Note: Individual stories don't have timestamps anymore since we work on epic branches
        // We can estimate based on epic completion time if needed
        if (epic.status === 'completed') {
          // Epic-level tracking instead of story-level
        }
      }

      // Agents (IAgentStep)
      const agentSteps = [
        task.orchestration.productManager,
        task.orchestration.techLead,
        task.orchestration.qaEngineer,
        task.orchestration.mergeCoordinator,
      ].filter(Boolean);

      for (const agent of agentSteps) {
        if (agent?.startedAt && agent?.completedAt) {
          const time = new Date(agent.completedAt).getTime() - new Date(agent.startedAt).getTime();
          const agentType = agent.agent || 'unknown';

          if (!agents[agentType]) {
            agents[agentType] = { count: 0, totalTime: 0, avgTime: 0 };
          }

          agents[agentType].count++;
          agents[agentType].totalTime += time;
        }
      }

      // Team members (ITeamMember - has different structure)
      const teamMembers = task.orchestration.team || [];
      for (const member of teamMembers) {
        if (member.startedAt && member.completedAt) {
          const time = new Date(member.completedAt).getTime() - new Date(member.startedAt).getTime();
          const agentType = member.agentType || 'unknown';

          if (!agents[agentType]) {
            agents[agentType] = { count: 0, totalTime: 0, avgTime: 0 };
          }

          agents[agentType].count++;
          agents[agentType].totalTime += time;
        }
      }
    }

    // Calcular promedios
    for (const complexity in storyComplexity) {
      const stats = storyComplexity[complexity];
      if (stats.count > 0) {
        stats.avgTime = stats.totalTime / stats.count / 1000 / 60; // Convert to minutes
      }
    }

    for (const agentType in agents) {
      const stats = agents[agentType];
      if (stats.count > 0) {
        stats.avgTime = stats.totalTime / stats.count / 1000 / 60; // Convert to minutes
      }
    }

    // Cache results
    this.cachedStats = {
      storyComplexity,
      agents,
      lastUpdated: new Date(),
    };

    console.log('✅ [Time Estimation] Historical stats calculated:', {
      storiesAnalyzed: Object.values(storyComplexity).reduce((sum, s) => sum + s.count, 0),
      agentsAnalyzed: Object.values(agents).reduce((sum, a) => sum + a.count, 0),
      tasksAnalyzed: completedTasks.length,
    });

    return this.cachedStats;
  }

  /**
   * Estima tiempo de una story basado en complejidad
   */
  async estimateStoryTime(complexity: string): Promise<number> {
    const stats = await this.getHistoricalStats();

    if (!stats || !stats.storyComplexity[complexity] || stats.storyComplexity[complexity].count === 0) {
      // Fallback a tiempos predeterminados si no hay data histórica
      const defaultTimes: Record<string, number> = {
        trivial: 2, // 2 min
        simple: 3, // 3 min
        moderate: 5, // 5 min
        complex: 8, // 8 min
        epic: 15, // 15 min
      };
      return defaultTimes[complexity] || 5;
    }

    return Math.round(stats.storyComplexity[complexity].avgTime);
  }

  /**
   * Estima tiempo restante de una task basado en stories pendientes
   */
  async estimateRemainingTime(
    stories: any[],
    completedStories: any[]
  ): Promise<{ minutes: number; formatted: string }> {
    const pendingStories = stories.filter(s => !completedStories.includes(s.id));

    let totalMinutes = 0;

    for (const story of pendingStories) {
      const estimatedTime = await this.estimateStoryTime(story.estimatedComplexity || 'moderate');
      totalMinutes += estimatedTime;
    }

    // Agregar buffer de 20% para overhead (git operations, QA, etc.)
    totalMinutes = Math.round(totalMinutes * 1.2);

    const formatted = this.formatTime(totalMinutes);

    return {
      minutes: totalMinutes,
      formatted,
    };
  }

  /**
   * Formatea minutos a string legible (ej: "5 min", "1h 30min", "2h")
   */
  formatTime(minutes: number): string {
    if (minutes < 60) {
      return `~${minutes} min`;
    }

    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;

    if (remainingMinutes === 0) {
      return `~${hours}h`;
    }

    return `~${hours}h ${remainingMinutes}min`;
  }

  /**
   * Estima ETA (hora estimada de completación)
   */
  estimateCompletionTime(remainingMinutes: number): Date {
    const now = new Date();
    return new Date(now.getTime() + remainingMinutes * 60 * 1000);
  }

  /**
   * Calcula progreso porcentual de un epic
   */
  calculateEpicProgress(
    totalStories: number,
    completedStories: number
  ): { percentage: number; isComplete: boolean } {
    if (totalStories === 0) {
      return { percentage: 0, isComplete: false };
    }

    const percentage = Math.round((completedStories / totalStories) * 100);

    return {
      percentage,
      isComplete: percentage === 100,
    };
  }
}

export default TimeEstimationService.getInstance();
