/**
 * ServiceIntegrationHub
 *
 * Central hub that integrates all Claude Code-level services.
 * Provides a unified interface for the orchestration system.
 *
 * Services integrated:
 * - ContextWindowOptimizer
 * - IncrementalVerifier
 * - DependencyGraphAnalyzer
 * - SmartFileRanker
 * - ConversationMemory
 * - AgentPerformanceTracker
 * - LearningMemory
 * - ProactiveIssueDetector
 * - QualityGates
 * - AutoTestGenerator
 */

import { ContextWindowOptimizer } from './ContextWindowOptimizer';
import { IncrementalVerifier } from './IncrementalVerifier';
import { DependencyGraphAnalyzer } from './DependencyGraphAnalyzer';
import { SmartFileRanker } from './SmartFileRanker';
import { ConversationMemory } from './ConversationMemory';
import { AgentPerformanceTracker } from './AgentPerformanceTracker';
import { LearningMemory } from './LearningMemory';
import { ProactiveIssueDetector } from './ProactiveIssueDetector';
import { QualityGates } from './QualityGates';
import { AutoTestGenerator } from './AutoTestGenerator';

export interface HubConfig {
  workspacePath: string;
  projectId: string;
  enableMetrics: boolean;
  enableLearning: boolean;
  enableMemory: boolean;
}

export interface PreExecutionContext {
  fileRanking: Awaited<ReturnType<typeof SmartFileRanker.rankFiles>> | null;
  preflightCheck: Awaited<ReturnType<typeof ProactiveIssueDetector.runPreflightChecks>> | null;
  learningContext: Awaited<ReturnType<typeof LearningMemory.getLearningContext>> | null;
  conversationMemory: string;
  dependencyWarnings: string[];
  recommendations: string[];
}

export interface PostExecutionContext {
  qualityGates: Awaited<ReturnType<typeof QualityGates.runAllGates>> | null;
  verificationResult: Awaited<ReturnType<typeof IncrementalVerifier.verify>> | null;
  testSpec: Awaited<ReturnType<typeof AutoTestGenerator.generateTestSpec>> | null;
}

export class ServiceIntegrationHub {
  private config: HubConfig;
  private contextOptimizer: ContextWindowOptimizer;
  private _initialized: boolean = false;

  get isInitialized(): boolean {
    return this._initialized;
  }

  constructor(config: HubConfig) {
    this.config = config;
    this.contextOptimizer = new ContextWindowOptimizer({
      maxTokens: 200000,
      warningThreshold: 0.7,
      criticalThreshold: 0.85,
    });
  }

  /**
   * Initialize all services
   */
  async initialize(): Promise<void> {
    console.log(`\n🚀 [ServiceHub] Initializing all services...`);

    // Initialize services in parallel
    await Promise.all([
      IncrementalVerifier.initialize(this.config.workspacePath),
      this.config.enableMemory ? ConversationMemory.initialize(this.config.workspacePath) : Promise.resolve(),
      this.config.enableMetrics ? AgentPerformanceTracker.initialize(this.config.workspacePath) : Promise.resolve(),
      this.config.enableLearning ? LearningMemory.initialize(this.config.workspacePath) : Promise.resolve(),
    ]);

    // Build dependency graph (can be slow, so do it separately)
    try {
      await DependencyGraphAnalyzer.buildGraph(this.config.workspacePath);
    } catch (error) {
      console.warn(`   ⚠️ Could not build dependency graph: ${error}`);
    }

    this._initialized = true;
    console.log(`   ✅ All services initialized`);
  }

  /**
   * Get pre-execution context for Developer agent
   */
  async getPreExecutionContext(
    taskDescription: string,
    filesToModify: string[],
    filesToCreate: string[],
    filesToRead: string[]
  ): Promise<PreExecutionContext> {
    console.log(`\n📋 [ServiceHub] Gathering pre-execution context...`);

    const context: PreExecutionContext = {
      fileRanking: null,
      preflightCheck: null,
      learningContext: null,
      conversationMemory: '',
      dependencyWarnings: [],
      recommendations: [],
    };

    // Run services in parallel for speed
    const [ranking, preflight, learning] = await Promise.all([
      // File ranking
      SmartFileRanker.rankFiles({
        workspacePath: this.config.workspacePath,
        taskDescription,
        filesToModify,
        filesToCreate,
      }).catch(() => null),

      // Preflight checks
      ProactiveIssueDetector.runPreflightChecks({
        workspacePath: this.config.workspacePath,
        filesToModify,
        filesToCreate,
        filesToRead,
      }).catch(() => null),

      // Learning context
      this.config.enableLearning
        ? LearningMemory.getLearningContext(
            this.config.projectId,
            taskDescription,
            filesToModify
          ).catch(() => null)
        : Promise.resolve(null),
    ]);

    context.fileRanking = ranking;
    context.preflightCheck = preflight;
    context.learningContext = learning;

    // Get conversation memory
    if (this.config.enableMemory) {
      context.conversationMemory = ConversationMemory.formatForPrompt();
    }

    // Get dependency warnings for files to modify
    for (const file of filesToModify.slice(0, 5)) {
      const impact = DependencyGraphAnalyzer.analyzeImpact(file);
      if (impact.riskLevel === 'high' || impact.riskLevel === 'critical') {
        context.dependencyWarnings.push(
          `⚠️ ${file}: ${impact.totalAffected} files depend on this (${impact.riskLevel} risk)`
        );
      }
    }

    // Compile recommendations
    if (preflight && !preflight.canProceed) {
      context.recommendations.push(...preflight.recommendations);
    }
    if (learning) {
      context.recommendations.push(...learning.recommendations);
    }
    if (ranking) {
      context.recommendations.push(
        `📁 Primary files to read: ${ranking.recommendedReads.slice(0, 3).join(', ')}`
      );
    }

    console.log(`   ✅ Context gathered: ${context.recommendations.length} recommendations`);
    return context;
  }

  /**
   * Get post-execution context (verification, quality gates)
   */
  async getPostExecutionContext(
    modifiedFiles: string[],
    createdFiles: string[]
  ): Promise<PostExecutionContext> {
    console.log(`\n🔍 [ServiceHub] Running post-execution checks...`);

    const allFiles = [...modifiedFiles, ...createdFiles];

    const context: PostExecutionContext = {
      qualityGates: null,
      verificationResult: null,
      testSpec: null,
    };

    // Run quality gates
    try {
      context.qualityGates = await QualityGates.runAllGates({
        workspacePath: this.config.workspacePath,
        modifiedFiles: allFiles,
        minCoverage: 70,
        strictMode: false,
      });
    } catch (error) {
      console.warn(`   ⚠️ Quality gates error: ${error}`);
    }

    // Run incremental verification
    try {
      context.verificationResult = await IncrementalVerifier.verify({
        workspacePath: this.config.workspacePath,
        modifiedFiles: allFiles,
        cacheEnabled: true,
        cacheTTL: 3600000, // 1 hour
        includeImporters: true,
      });
    } catch (error) {
      console.warn(`   ⚠️ Verification error: ${error}`);
    }

    // Generate test specs for new files
    if (createdFiles.length > 0) {
      try {
        const firstNewFile = createdFiles[0];
        context.testSpec = await AutoTestGenerator.generateTestSpec(
          `${this.config.workspacePath}/${firstNewFile}`,
          this.config.workspacePath
        );
      } catch (error) {
        console.warn(`   ⚠️ Test spec error: ${error}`);
      }
    }

    console.log(`   ✅ Post-execution checks complete`);
    return context;
  }

  /**
   * Format pre-execution context for Developer prompt
   */
  formatPreExecutionForPrompt(context: PreExecutionContext): string {
    let output = '';

    // Conversation memory (decisions from past sessions)
    if (context.conversationMemory) {
      output += context.conversationMemory + '\n';
    }

    // Learning context
    if (context.learningContext) {
      output += LearningMemory.formatForPrompt(context.learningContext) + '\n';
    }

    // File ranking
    if (context.fileRanking && context.fileRanking.rankedFiles.length > 0) {
      output += SmartFileRanker.formatForPrompt(context.fileRanking) + '\n';
    }

    // Preflight warnings
    if (context.preflightCheck && !context.preflightCheck.canProceed) {
      output += `
## ⚠️ PREFLIGHT WARNINGS

${context.preflightCheck.issues.map(i => `- **${i.category}**: ${i.message}`).join('\n')}

**Fix these before coding!**
`;
    }

    // Dependency warnings
    if (context.dependencyWarnings.length > 0) {
      output += `
## 🔗 DEPENDENCY WARNINGS

${context.dependencyWarnings.join('\n')}

**Be careful when modifying these high-impact files!**
`;
    }

    // Recommendations
    if (context.recommendations.length > 0) {
      output += `
## 💡 RECOMMENDATIONS

${context.recommendations.slice(0, 5).map(r => `- ${r}`).join('\n')}
`;
    }

    return output;
  }

  /**
   * Format post-execution context for Judge/verification
   */
  formatPostExecutionForPrompt(context: PostExecutionContext): string {
    let output = '';

    // Quality gates
    if (context.qualityGates) {
      output += QualityGates.formatForPrompt(context.qualityGates) + '\n';
    }

    // Verification results
    if (context.verificationResult) {
      output += IncrementalVerifier.formatResults(context.verificationResult) + '\n';
    }

    // Test specification
    if (context.testSpec) {
      output += AutoTestGenerator.formatTestSpecForPrompt(context.testSpec) + '\n';
    }

    return output;
  }

  /**
   * Start tracking agent execution
   */
  startAgentExecution(agentType: string, phase: string, model: string): string {
    if (this.config.enableMetrics) {
      return AgentPerformanceTracker.startExecution(agentType, phase, model);
    }
    return '';
  }

  /**
   * End agent execution tracking
   */
  endAgentExecution(executionId: string, cost: number, success: boolean, error?: string): void {
    if (this.config.enableMetrics && executionId) {
      if (success) {
        AgentPerformanceTracker.endExecution(executionId, cost);
      } else {
        AgentPerformanceTracker.failExecution(executionId, error || 'Unknown error', cost);
      }
    }
  }

  /**
   * Record a decision for memory
   */
  recordDecision(topic: string, decision: string, category: 'architecture' | 'technology' | 'pattern'): void {
    if (this.config.enableMemory) {
      ConversationMemory.recordDecision(topic, decision, category);
    }
  }

  /**
   * Record an error lesson
   */
  async recordErrorLesson(
    errorType: string,
    errorMessage: string,
    solution: string,
    rootCause: string
  ): Promise<void> {
    if (this.config.enableLearning) {
      await LearningMemory.recordError(this.config.projectId, {
        errorType,
        errorMessage,
        rootCause,
        solution,
        preventionTip: `Avoid ${rootCause}`,
        occurrences: 1,
      });
    }
  }

  /**
   * Get context window status
   */
  getContextStatus(): string {
    return this.contextOptimizer.formatStatus();
  }

  /**
   * Add content to context tracking
   */
  trackContextUsage(content: string, type: 'code' | 'output' | 'instruction', priority: 'high' | 'medium' | 'low'): void {
    this.contextOptimizer.addContent(content, type, priority);
  }

  /**
   * Get performance report
   */
  getPerformanceReport(days: number = 7): string {
    if (this.config.enableMetrics) {
      const report = AgentPerformanceTracker.generateReport(days);
      return AgentPerformanceTracker.formatReport(report);
    }
    return 'Metrics not enabled';
  }

  /**
   * Generate all instructions for Developer prompt
   */
  static generateAllInstructions(): string {
    return `
${ContextWindowOptimizer.generateInstructions()}

${IncrementalVerifier.generateInstructions()}

${DependencyGraphAnalyzer.generateInstructions()}

${SmartFileRanker.generateInstructions()}

${ConversationMemory.generateInstructions()}

${AutoTestGenerator.generateInstructions()}
`;
  }
}
