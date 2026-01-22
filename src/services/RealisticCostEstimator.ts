/**
 * 💰 REALISTIC COST ESTIMATOR
 *
 * Analiza el repositorio REAL para estimar costos precisos:
 * 1. Cuenta líneas de código en el repo (wc -l)
 * 2. Estima tokens de contexto basado en tamaño real
 * 3. Multiplica por número de stories (no developers)
 * 4. Usa costos reales históricos de la BD
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execAsync = promisify(exec);

interface RepositoryAnalysis {
  path: string;
  name: string;
  totalLines: number;
  totalFiles: number;
  codeLines: number; // Sin comentarios ni blancos
  estimatedTokens: number;
  primaryLanguages: { language: string; lines: number }[];
}

interface HistoricalCosts {
  avgCostPerStory: number;
  avgDeveloperCost: number;
  avgTotalCost: number;
  avgDuration: number;
  sampleSize: number;
}

interface RealisticCostEstimate {
  totalEstimated: number;
  totalMinimum: number;
  totalMaximum: number;
  breakdown: {
    planning: number;
    techLead: number;
    developers: number;
    judge: number;
    autoMerge: number;
  };
  perStoryEstimate: number;
  storiesCount: number;
  repositoryAnalysis: RepositoryAnalysis[];
  historicalData: HistoricalCosts | null;
  estimatedDuration: number;
  confidence: number;
  warnings: string[];
  methodology: string;
}

export class RealisticCostEstimator {
  // Claude 3.5 Sonnet pricing
  private readonly COST_PER_1K_INPUT = 0.003;
  private readonly COST_PER_1K_OUTPUT = 0.015;

  // Estimaciones basadas en observaciones reales
  private readonly TOKENS_PER_LINE_OF_CODE = 4; // Promedio: 1 línea = 4 tokens
  private readonly CONTEXT_MULTIPLIER = 1.5; // Agents leen más contexto del necesario

  /**
   * Estima costos de manera realista analizando el repositorio y usando datos históricos
   */
  async estimateRealistic(
    epics: any[],
    repositories: any[],
    workspacePath: string | null
  ): Promise<RealisticCostEstimate> {
    console.log('\n💰 [RealisticCostEstimator] Analyzing repositories for accurate cost estimation...\n');

    // 1. Analizar tamaño real de cada repositorio
    const repoAnalysis = await this.analyzeRepositories(repositories, workspacePath);

    // 2. Obtener costos históricos reales de la base de datos
    const historicalCosts = await this.getHistoricalCosts();

    // 3. Contar stories totales
    const totalStories = epics.reduce((sum, epic) => sum + (epic.stories?.length || 0), 0);

    // 4. Calcular tokens estimados basados en análisis real
    const totalCodeLines = repoAnalysis.reduce((sum, r) => sum + r.codeLines, 0);
    const estimatedContextTokens = totalCodeLines * this.TOKENS_PER_LINE_OF_CODE * this.CONTEXT_MULTIPLIER;

    console.log(`📊 Repository Analysis:`);
    console.log(`   Total lines of code: ${totalCodeLines.toLocaleString()}`);
    console.log(`   Estimated context tokens: ${estimatedContextTokens.toLocaleString()}`);
    console.log(`   Total stories: ${totalStories}`);

    // 5. Calcular costos por agente basados en tokens reales
    const breakdown = this.calculateRealisticBreakdown(
      totalStories,
      estimatedContextTokens,
      historicalCosts
    );

    // 6. Calcular costo total
    const totalEstimated = Object.values(breakdown).reduce((sum, cost) => sum + cost, 0);
    const totalMinimum = totalEstimated * 0.8; // ±20% más realista que ±30%
    const totalMaximum = totalEstimated * 1.2;

    // 7. Estimar duración basada en stories y tamaño
    const estimatedDuration = this.estimateDuration(totalStories, totalCodeLines);

    // 8. Calcular confianza basada en datos disponibles
    const confidence = this.calculateRealisticConfidence(
      historicalCosts,
      repoAnalysis,
      totalStories
    );

    // 9. Generar advertencias
    const warnings = this.generateRealisticWarnings(
      totalEstimated,
      totalStories,
      totalCodeLines,
      estimatedDuration
    );

    // 10. Costo por story
    const perStoryEstimate = totalStories > 0 ? totalEstimated / totalStories : 0;

    return {
      totalEstimated: Math.round(totalEstimated * 100) / 100,
      totalMinimum: Math.round(totalMinimum * 100) / 100,
      totalMaximum: Math.round(totalMaximum * 100) / 100,
      breakdown,
      perStoryEstimate: Math.round(perStoryEstimate * 100) / 100,
      storiesCount: totalStories,
      repositoryAnalysis: repoAnalysis,
      historicalData: historicalCosts,
      estimatedDuration: Math.round(estimatedDuration),
      confidence,
      warnings,
      methodology: 'Real repository analysis + historical data from completed tasks'
    };
  }

  /**
   * Analiza repositorios para obtener métricas reales
   */
  private async analyzeRepositories(
    repositories: any[],
    workspacePath: string | null
  ): Promise<RepositoryAnalysis[]> {
    const analyses: RepositoryAnalysis[] = [];

    for (const repo of repositories) {
      const repoPath = workspacePath ? path.join(workspacePath, repo.name) : repo.path;

      if (!repoPath || !fs.existsSync(repoPath)) {
        console.warn(`⚠️ Repository path not found: ${repoPath}`);
        continue;
      }

      try {
        // Contar líneas totales (excluyendo node_modules, .git, dist, build)
        const { stdout: totalLinesOutput } = await execAsync(
          `find . -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.py" -o -name "*.java" -o -name "*.go" -o -name "*.rb" -o -name "*.php" \\) ! -path "*/node_modules/*" ! -path "*/.git/*" ! -path "*/dist/*" ! -path "*/build/*" -exec wc -l {} + 2>/dev/null | tail -1 || echo "0 total"`,
          { cwd: repoPath, timeout: 10000 }
        );

        const totalLines = parseInt(totalLinesOutput.trim().split(' ')[0]) || 0;

        // Contar archivos
        const { stdout: filesOutput } = await execAsync(
          `find . -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.py" -o -name "*.java" \\) ! -path "*/node_modules/*" ! -path "*/.git/*" ! -path "*/dist/*" ! -path "*/build/*" | wc -l`,
          { cwd: repoPath, timeout: 10000 }
        );

        const totalFiles = parseInt(filesOutput.trim()) || 0;

        // Estimar líneas de código sin comentarios (aprox. 80% de las líneas totales)
        const codeLines = Math.round(totalLines * 0.8);

        // Estimar tokens basados en líneas de código
        const estimatedTokens = codeLines * this.TOKENS_PER_LINE_OF_CODE;

        console.log(`📁 ${repo.name}:`);
        console.log(`   Files: ${totalFiles}`);
        console.log(`   Total lines: ${totalLines.toLocaleString()}`);
        console.log(`   Code lines (est): ${codeLines.toLocaleString()}`);
        console.log(`   Estimated tokens: ${estimatedTokens.toLocaleString()}\n`);

        analyses.push({
          path: repoPath,
          name: repo.name,
          totalLines,
          totalFiles,
          codeLines,
          estimatedTokens,
          primaryLanguages: [] // Opcional: detectar lenguajes principales
        });
      } catch (error: any) {
        console.error(`❌ Failed to analyze repository ${repo.name}:`, error.message);
      }
    }

    return analyses;
  }

  /**
   * Obtiene costos históricos reales de la base de datos
   */
  private async getHistoricalCosts(): Promise<HistoricalCosts | null> {
    try {
      const { TaskRepository } = await import('../database/repositories/TaskRepository');

      // Obtener últimas tareas completadas y filtrar las que tienen costos
      const allCompleted = TaskRepository.findAll({
        status: 'completed',
        limit: 50, // Fetch more to filter in memory
        orderBy: 'updated_at',
        orderDir: 'DESC'
      });

      // Filter tasks with totalCost > 0
      const completedTasks = allCompleted
        .filter(t => t.orchestration?.totalCost && t.orchestration.totalCost > 0)
        .slice(0, 20);

      if (completedTasks.length === 0) {
        console.log('ℹ️ No historical cost data available yet');
        return null;
      }

      // Calcular promedios
      let totalCost = 0;
      let totalStories = 0;
      let totalDuration = 0;
      let developerCosts = 0;

      for (const task of completedTasks) {
        totalCost += task.orchestration.totalCost;

        // Contar stories implementadas
        const stories = task.orchestration.team?.reduce((sum: number, member: any) => {
          return sum + (member.assignedStories?.length || 0);
        }, 0) || 0;
        totalStories += stories;

        // Sumar costos de developers
        const devCost = task.orchestration.team?.reduce((sum: number, member: any) => {
          return sum + (member.cost_usd || 0);
        }, 0) || 0;
        developerCosts += devCost;

        // Calcular duración
        if (task.completedAt && task.createdAt) {
          const duration = (new Date(task.completedAt).getTime() - new Date(task.createdAt).getTime()) / 1000 / 60;
          totalDuration += duration;
        }
      }

      const avgCostPerStory = totalStories > 0 ? totalCost / totalStories : 0;
      const avgDeveloperCost = completedTasks.length > 0 ? developerCosts / completedTasks.length : 0;
      const avgTotalCost = totalCost / completedTasks.length;
      const avgDuration = totalDuration / completedTasks.length;

      console.log(`📈 Historical Data (${completedTasks.length} completed tasks):`);
      console.log(`   Avg cost per story: $${avgCostPerStory.toFixed(2)}`);
      console.log(`   Avg developer cost: $${avgDeveloperCost.toFixed(2)}`);
      console.log(`   Avg total cost: $${avgTotalCost.toFixed(2)}`);
      console.log(`   Avg duration: ${Math.round(avgDuration)} minutes\n`);

      return {
        avgCostPerStory,
        avgDeveloperCost,
        avgTotalCost,
        avgDuration,
        sampleSize: completedTasks.length
      };
    } catch (error: any) {
      console.error('❌ Failed to fetch historical costs:', error.message);
      return null;
    }
  }

  /**
   * Calcula breakdown realista de costos
   */
  private calculateRealisticBreakdown(
    totalStories: number,
    estimatedContextTokens: number,
    historicalCosts: HistoricalCosts | null
  ): RealisticCostEstimate['breakdown'] {
    // Si tenemos datos históricos, usarlos como base
    if (historicalCosts && historicalCosts.sampleSize >= 5) {
      // Usar promedios históricos ajustados por número de stories
      return {
        planning: 0.10, // Unified planning phase
        techLead: 0.15,
        developers: historicalCosts.avgCostPerStory * totalStories,
        judge: (historicalCosts.avgCostPerStory * 0.3) * totalStories, // Judge ≈ 30% del developer
        autoMerge: 0.10
      };
    }

    // Sin datos históricos, usar análisis de tokens
    // Estimación conservadora basada en lectura de contexto
    const avgInputTokensPerStory = Math.min(estimatedContextTokens / totalStories, 15000); // Max 15k por story
    const avgOutputTokensPerStory = 8000; // Código generado

    const costPerStoryDeveloper = (
      (avgInputTokensPerStory / 1000) * this.COST_PER_1K_INPUT +
      (avgOutputTokensPerStory / 1000) * this.COST_PER_1K_OUTPUT
    );

    return {
      planning: 0.10, // Unified planning phase
      techLead: 0.15,
      developers: costPerStoryDeveloper * totalStories,
      judge: (costPerStoryDeveloper * 0.3) * totalStories, // Judge revisa código
      autoMerge: totalStories > 3 ? 0.10 : 0
    };
  }

  /**
   * Estima duración basada en stories y tamaño del repo
   */
  private estimateDuration(totalStories: number, totalCodeLines: number): number {
    // Base: 10 minutos por story
    let duration = totalStories * 10;

    // Ajustar por tamaño del repo (más código = más tiempo de lectura/análisis)
    if (totalCodeLines > 50000) {
      duration *= 1.5; // Repos grandes toman más tiempo
    } else if (totalCodeLines > 20000) {
      duration *= 1.2;
    }

    // Agregar overhead fijo
    duration += 15; // Planning + Tech Lead + Judge + Verification

    return duration;
  }

  /**
   * Calcula confianza basada en datos disponibles
   */
  private calculateRealisticConfidence(
    historicalCosts: HistoricalCosts | null,
    repoAnalysis: RepositoryAnalysis[],
    totalStories: number
  ): number {
    let confidence = 60; // Base conservadora

    // Datos históricos aumentan confianza
    if (historicalCosts) {
      if (historicalCosts.sampleSize >= 10) confidence += 20;
      else if (historicalCosts.sampleSize >= 5) confidence += 10;
      else confidence += 5;
    }

    // Análisis de repo exitoso aumenta confianza
    if (repoAnalysis.length > 0) {
      confidence += 10;
    }

    // Stories bien definidas aumentan confianza
    if (totalStories > 0 && totalStories <= 10) {
      confidence += 10;
    }

    return Math.min(95, confidence);
  }

  /**
   * Genera advertencias realistas
   */
  private generateRealisticWarnings(
    totalCost: number,
    totalStories: number,
    totalCodeLines: number,
    duration: number
  ): string[] {
    const warnings: string[] = [];

    if (totalCost > 10.0) {
      warnings.push(`🚨 HIGH COST: $${totalCost.toFixed(2)} - Consider breaking into multiple tasks`);
    }

    if (totalStories > 15) {
      warnings.push(`📦 MANY STORIES: ${totalStories} stories may take several hours`);
    }

    if (totalCodeLines > 100000) {
      warnings.push(`📚 LARGE CODEBASE: ${(totalCodeLines / 1000).toFixed(0)}k lines - context may be truncated`);
    }

    if (duration > 120) {
      warnings.push(`⏱️ LONG DURATION: Estimated ${Math.round(duration / 60)} hours`);
    }

    if (totalCodeLines < 1000) {
      warnings.push(`⚠️ SMALL CODEBASE: Limited context may reduce estimation accuracy`);
    }

    return warnings;
  }
}

// Singleton instance
const realisticCostEstimator = new RealisticCostEstimator();
export default realisticCostEstimator;
