/**
 * 💰 COST ESTIMATOR
 * Estima el costo de una tarea ANTES de ejecutarla
 * Previene sorpresas y permite decidir si proceder
 */

interface AgentCostProfile {
  name: string;
  avgTokensIn: number;
  avgTokensOut: number;
  costPer1kTokensIn: number;
  costPer1kTokensOut: number;
  avgExecutionTime: number; // minutes
}

interface TaskComplexity {
  level: 'simple' | 'moderate' | 'complex' | 'epic';
  multiplier: number;
}

interface CostEstimate {
  totalEstimated: number;
  totalMinimum: number;
  totalMaximum: number;
  byAgent: {
    agent: string;
    estimated: number;
    minimum: number;
    maximum: number;
    tokens: {
      input: number;
      output: number;
    };
  }[];
  estimatedDuration: number; // minutes
  confidence: number; // 0-100%
  warnings: string[];
}

export class CostEstimator {
  // Perfiles de costo basados en datos históricos (Claude 3.5 Sonnet)
  private readonly AGENT_PROFILES: Record<string, AgentCostProfile> = {
    'product-manager': {
      name: 'Product Manager',
      avgTokensIn: 800,
      avgTokensOut: 1500,
      costPer1kTokensIn: 0.003,
      costPer1kTokensOut: 0.015,
      avgExecutionTime: 2
    },
    'project-manager': {
      name: 'Project Manager',
      avgTokensIn: 1000,
      avgTokensOut: 2000,
      costPer1kTokensIn: 0.003,
      costPer1kTokensOut: 0.015,
      avgExecutionTime: 2
    },
    'tech-lead': {
      name: 'Tech Lead',
      avgTokensIn: 1500,
      avgTokensOut: 3000,
      costPer1kTokensIn: 0.003,
      costPer1kTokensOut: 0.015,
      avgExecutionTime: 3
    },
    'developer': {
      name: 'Developer',
      avgTokensIn: 2000,
      avgTokensOut: 8000, // Mucho código generado
      costPer1kTokensIn: 0.003,
      costPer1kTokensOut: 0.015,
      avgExecutionTime: 5
    },
    'qa-engineer': {
      name: 'QA Engineer',
      avgTokensIn: 1200,
      avgTokensOut: 2500,
      costPer1kTokensIn: 0.003,
      costPer1kTokensOut: 0.015,
      avgExecutionTime: 3
    },
    'merge-coordinator': {
      name: 'Merge Coordinator',
      avgTokensIn: 1000,
      avgTokensOut: 2000,
      costPer1kTokensIn: 0.003,
      costPer1kTokensOut: 0.015,
      avgExecutionTime: 2
    },
    'judge': {
      name: 'Judge',
      avgTokensIn: 3000, // Revisa mucho código
      avgTokensOut: 1000,
      costPer1kTokensIn: 0.003,
      costPer1kTokensOut: 0.015,
      avgExecutionTime: 2
    }
  };

  /**
   * Estima el costo total de una tarea
   */
  estimateTaskCost(
    taskDescription: string,
    numberOfDevelopers: number = 2,
    includeJudge: boolean = true,
    complexity?: TaskComplexity
  ): CostEstimate {
    console.log(`\n💰 [CostEstimator] Calculating estimated costs...`);

    // Determinar complejidad si no se proporciona
    const taskComplexity = complexity || this.analyzeComplexity(taskDescription);

    // Lista de agentes que se ejecutarán
    const agentSequence = [
      'product-manager',
      'project-manager',
      'tech-lead',
      ...Array(numberOfDevelopers).fill('developer'),
      'qa-engineer'
    ];

    // Agregar Merge Coordinator si hay múltiples developers
    if (numberOfDevelopers > 1) {
      agentSequence.push('merge-coordinator');
    }

    // Agregar Judge si está habilitado
    if (includeJudge) {
      // Judge revisa cada developer
      for (let i = 0; i < numberOfDevelopers; i++) {
        agentSequence.push('judge');
      }
    }

    // Calcular costos por agente
    const byAgent = agentSequence.map(agentType => {
      const profile = this.AGENT_PROFILES[agentType];
      if (!profile) {
        console.warn(`⚠️ No cost profile for agent: ${agentType}`);
        return {
          agent: agentType,
          estimated: 0.10,
          minimum: 0.05,
          maximum: 0.20,
          tokens: { input: 1000, output: 2000 }
        };
      }

      // Aplicar multiplicador de complejidad
      const adjustedTokensIn = Math.round(profile.avgTokensIn * taskComplexity.multiplier);
      const adjustedTokensOut = Math.round(profile.avgTokensOut * taskComplexity.multiplier);

      // Calcular costos
      const costIn = (adjustedTokensIn / 1000) * profile.costPer1kTokensIn;
      const costOut = (adjustedTokensOut / 1000) * profile.costPer1kTokensOut;
      const estimated = costIn + costOut;

      // Rangos (±30%)
      const minimum = estimated * 0.7;
      const maximum = estimated * 1.3;

      return {
        agent: profile.name,
        estimated: Math.round(estimated * 1000) / 1000,
        minimum: Math.round(minimum * 1000) / 1000,
        maximum: Math.round(maximum * 1000) / 1000,
        tokens: {
          input: adjustedTokensIn,
          output: adjustedTokensOut
        }
      };
    });

    // Calcular totales
    const totalEstimated = byAgent.reduce((sum, a) => sum + a.estimated, 0);
    const totalMinimum = byAgent.reduce((sum, a) => sum + a.minimum, 0);
    const totalMaximum = byAgent.reduce((sum, a) => sum + a.maximum, 0);

    // Estimar duración
    const estimatedDuration = agentSequence.reduce((sum, agentType) => {
      const profile = this.AGENT_PROFILES[agentType];
      return sum + (profile?.avgExecutionTime || 3) * taskComplexity.multiplier;
    }, 0);

    // Calcular confianza (basada en claridad de requisitos)
    const confidence = this.calculateConfidence(taskDescription);

    // Generar advertencias
    const warnings = this.generateWarnings(
      totalEstimated,
      estimatedDuration,
      taskComplexity,
      numberOfDevelopers
    );

    return {
      totalEstimated: Math.round(totalEstimated * 100) / 100,
      totalMinimum: Math.round(totalMinimum * 100) / 100,
      totalMaximum: Math.round(totalMaximum * 100) / 100,
      byAgent,
      estimatedDuration: Math.round(estimatedDuration),
      confidence,
      warnings
    };
  }

  /**
   * Analiza la complejidad de la tarea
   */
  private analyzeComplexity(description: string): TaskComplexity {
    const lower = description.toLowerCase();

    // Palabras clave de complejidad
    const simpleKeywords = ['fix', 'update', 'change', 'rename', 'add button', 'typo', 'style'];
    const complexKeywords = ['implement', 'create system', 'architecture', 'refactor', 'migrate', 'integration'];
    const epicKeywords = ['full', 'complete', 'entire', 'all', 'everything', 'production-ready'];

    // Contar coincidencias
    const simpleCount = simpleKeywords.filter(k => lower.includes(k)).length;
    const complexCount = complexKeywords.filter(k => lower.includes(k)).length;
    const epicCount = epicKeywords.filter(k => lower.includes(k)).length;

    // Determinar nivel
    if (epicCount > 0 || description.length > 500) {
      return { level: 'epic', multiplier: 2.0 };
    } else if (complexCount > simpleCount) {
      return { level: 'complex', multiplier: 1.5 };
    } else if (simpleCount > 0) {
      return { level: 'simple', multiplier: 0.7 };
    } else {
      return { level: 'moderate', multiplier: 1.0 };
    }
  }

  /**
   * Calcula la confianza de la estimación
   */
  private calculateConfidence(description: string): number {
    let confidence = 70; // Base

    // Más detalles = más confianza
    if (description.length > 200) confidence += 10;
    if (description.includes('endpoint') || description.includes('component')) confidence += 10;
    if (description.includes('example') || description.includes('like')) confidence += 5;

    // Ambigüedad reduce confianza
    if (description.includes('something') || description.includes('somehow')) confidence -= 15;
    if (description.includes('maybe') || description.includes('probably')) confidence -= 10;
    if (description.length < 50) confidence -= 20;

    return Math.max(20, Math.min(95, confidence));
  }

  /**
   * Genera advertencias basadas en la estimación
   */
  private generateWarnings(
    cost: number,
    duration: number,
    complexity: TaskComplexity,
    developers: number
  ): string[] {
    const warnings: string[] = [];

    // Advertencias de costo
    if (cost > 5.0) {
      warnings.push(`⚠️ HIGH COST: Estimated $${cost.toFixed(2)} exceeds typical task cost`);
    }
    if (cost > 10.0) {
      warnings.push(`🚨 VERY HIGH COST: Consider breaking this into smaller tasks`);
    }

    // Advertencias de tiempo
    if (duration > 30) {
      warnings.push(`⏱️ LONG DURATION: Estimated ${duration} minutes may timeout`);
    }

    // Advertencias de complejidad
    if (complexity.level === 'epic') {
      warnings.push(`📦 EPIC TASK: Consider splitting into multiple smaller tasks`);
    }

    // Advertencias de recursos
    if (developers > 3) {
      warnings.push(`👥 MANY DEVELOPERS: ${developers} devs may cause merge conflicts`);
    }

    // Advertencia de Judge
    if (developers > 2) {
      warnings.push(`⚖️ JUDGE OVERHEAD: Each developer adds Judge review cost`);
    }

    return warnings;
  }

  /**
   * Formatea la estimación para mostrar al usuario
   */
  formatEstimate(estimate: CostEstimate): string {
    const lines: string[] = [];

    lines.push(`\n💰 =============== COST ESTIMATE ===============`);
    lines.push(`📊 Complexity Analysis: ${estimate.confidence}% confidence`);
    lines.push(``);
    lines.push(`💵 TOTAL ESTIMATED COST:`);
    lines.push(`   Estimated: $${estimate.totalEstimated.toFixed(2)}`);
    lines.push(`   Range: $${estimate.totalMinimum.toFixed(2)} - $${estimate.totalMaximum.toFixed(2)}`);
    lines.push(``);
    lines.push(`⏱️ ESTIMATED DURATION: ${estimate.estimatedDuration} minutes`);
    lines.push(``);
    lines.push(`👥 COST BY AGENT:`);

    // Agrupar developers y judges
    const grouped = estimate.byAgent.reduce((acc, agent) => {
      const key = agent.agent;
      if (!acc[key]) {
        acc[key] = { ...agent, count: 1 };
      } else {
        acc[key].count++;
        acc[key].estimated += agent.estimated;
        acc[key].minimum += agent.minimum;
        acc[key].maximum += agent.maximum;
      }
      return acc;
    }, {} as Record<string, any>);

    Object.values(grouped).forEach((agent: any) => {
      const countStr = agent.count > 1 ? ` (x${agent.count})` : '';
      lines.push(`   ${agent.agent}${countStr}: $${agent.estimated.toFixed(3)}`);
      lines.push(`      Tokens: ~${agent.tokens.input} in, ~${agent.tokens.output} out`);
    });

    if (estimate.warnings.length > 0) {
      lines.push(``);
      lines.push(`⚠️ WARNINGS:`);
      estimate.warnings.forEach(w => lines.push(`   ${w}`));
    }

    lines.push(`\n🤔 Proceed with task? (yes/no/adjust)`);
    lines.push(`===============================================`);

    return lines.join('\n');
  }

  /**
   * Compara estimación con ejecución real
   */
  compareWithActual(
    estimated: CostEstimate,
    actualCost: number,
    actualDuration: number
  ): {
    costAccuracy: number;
    durationAccuracy: number;
    analysis: string;
  } {
    const costDiff = actualCost - estimated.totalEstimated;
    const costAccuracy = 100 - Math.abs(costDiff / estimated.totalEstimated) * 100;

    const durationDiff = actualDuration - estimated.estimatedDuration;
    const durationAccuracy = 100 - Math.abs(durationDiff / estimated.estimatedDuration) * 100;

    let analysis = '';
    if (costAccuracy > 80) {
      analysis += '✅ Cost estimate was accurate. ';
    } else if (actualCost > estimated.totalMaximum) {
      analysis += '❌ Cost exceeded maximum estimate. ';
    } else if (actualCost < estimated.totalMinimum) {
      analysis += '✅ Cost was lower than expected! ';
    }

    if (durationAccuracy > 80) {
      analysis += '✅ Duration estimate was accurate.';
    } else if (actualDuration > estimated.estimatedDuration * 1.5) {
      analysis += '❌ Task took much longer than expected.';
    }

    return {
      costAccuracy: Math.round(costAccuracy),
      durationAccuracy: Math.round(durationAccuracy),
      analysis
    };
  }
}

// Singleton instance
const costEstimator = new CostEstimator();
export default costEstimator;