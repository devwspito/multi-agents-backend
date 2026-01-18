/**
 * SmartContextInjector - Intelligent Pre-Execution Context for Agents
 *
 * THIS IS A KEY DIFFERENTIATOR vs Claude Code.
 *
 * Before an agent executes, we inject intelligent context that includes:
 * - Codebase overview (from pre-computed index)
 * - Relevant files for the current task
 * - Previous agent findings (from shared memory)
 * - Phase-specific hints and best practices
 * - Related tests to consider
 * - Dependency information
 *
 * This makes agents immediately more effective without exploration time.
 */

import { CodebaseIndexer } from './CodebaseIndexer';

// ==================== TYPES ====================

export type AgentPhase =
  | 'planning-agent'
  | 'tech-lead'
  | 'developer'
  | 'judge'
  | 'verification-fixer'
  | 'recovery-analyst'
  | 'auto-merge';

export interface ContextRequest {
  phase: AgentPhase;
  taskDescription: string;
  workspacePath: string;
  previousPhaseResults?: Map<string, any>;
  focusAreas?: string[];
  userDirectives?: string[];
}

export interface InjectedContext {
  // Codebase awareness
  codebaseOverview: CodebaseOverview;
  relevantFiles: RelevantFile[];
  relatedTests: string[];

  // Phase-specific
  phaseGuidelines: string[];
  recommendedTools: string[];
  qualityChecklist: string[];

  // Shared knowledge
  previousFindings: PreviousFinding[];
  warningsAndPitfalls: string[];

  // Formatted for injection
  formattedContext: string;
}

export interface CodebaseOverview {
  totalFiles: number;
  totalSymbols: number;
  primaryLanguages: string[];
  keyDirectories: string[];
  entryPoints: string[];
  testCoverage: number;
}

export interface RelevantFile {
  path: string;
  relevance: number;
  reason: string;
  symbols?: string[];
}

export interface PreviousFinding {
  phase: string;
  finding: string;
  severity: 'info' | 'warning' | 'critical';
}

// ==================== PHASE CONFIGURATIONS ====================

const PHASE_GUIDELINES: Record<AgentPhase, string[]> = {
  'planning-agent': [
    'Focus on understanding the ROOT CAUSE, not just symptoms',
    'Break down features into ATOMIC user stories',
    'Each story must have clear acceptance criteria',
    'Consider MVP vs full feature scope',
    'Identify dependencies between stories',
    'Prioritize by value and dependencies',
    'Document assumptions and risks clearly'
  ],
  'tech-lead': [
    'Favor composition over inheritance',
    'Keep interfaces small and focused',
    'Consider testability in all designs',
    'Document architectural decisions (ADRs)',
    'Think about error handling strategy'
  ],
  'developer': [
    'Read existing code BEFORE writing new code',
    'Follow existing patterns in the codebase',
    'Write tests for new functionality',
    'Keep functions small and focused',
    'Handle errors gracefully',
    'Use the codebase index for fast lookups'
  ],
  'judge': [
    'Check for SECURITY vulnerabilities first',
    'Verify error handling is comprehensive',
    'Look for missing test coverage',
    'Check for code duplication',
    'Ensure consistency with existing patterns'
  ],
  'verification-fixer': [
    'Understand the issue BEFORE attempting fix',
    'Make minimal changes to fix the issue',
    'Verify fix doesn\'t break other tests',
    'Consider root cause vs symptom fix',
    'Document what was changed and why'
  ],
  'recovery-analyst': [
    'Analyze error patterns systematically',
    'Determine if errors are automatable',
    'Provide actionable recovery strategies',
    'Consider similar past failures'
  ],
  'auto-merge': [
    'Verify all tests pass',
    'Check PR description is complete',
    'Ensure commit messages are descriptive',
    'Verify no merge conflicts',
    'Check CI/CD pipeline status'
  ]
};

const PHASE_TOOLS: Record<AgentPhase, string[]> = {
  'planning-agent': [
    'generate_exploration_script (pattern-discovery)',
    'get_codebase_overview',
    'search_codebase_index',
    'parallel_explore (breadth-first)',
    'analyze_dependencies'
  ],
  'tech-lead': [
    'analyze_dependencies',
    'generate_exploration_script (architecture-map)',
    'parallel_explore (cross-reference)',
    'analyze_change_impact'
  ],
  'developer': [
    'search_codebase_index (symbol)',
    'find_related_tests',
    'analyze_dependencies',
    'generate_exploration_script (code-flow)',
    'analyze_change_impact'
  ],
  'judge': [
    'generate_exploration_script (security-scan)',
    'find_related_tests',
    'analyze_code_quality',
    'search_codebase_index'
  ],
  'verification-fixer': [
    'find_related_tests',
    'analyze_dependencies',
    'search_codebase_index',
    'analyze_change_impact'
  ],
  'recovery-analyst': [
    'analyze_error_patterns',
    'search_codebase_index',
    'get_codebase_overview'
  ],
  'auto-merge': [
    'run_integration_tests',
    'type_check',
    'analyze_code_quality'
  ]
};

const QUALITY_CHECKLISTS: Record<AgentPhase, string[]> = {
  'planning-agent': [
    '[ ] Problem clearly defined',
    '[ ] Root cause identified',
    '[ ] Stories follow INVEST criteria',
    '[ ] Acceptance criteria are testable',
    '[ ] Dependencies identified',
    '[ ] MVP scope defined',
    '[ ] Risks documented'
  ],
  'tech-lead': [
    '[ ] Design is testable',
    '[ ] Error handling defined',
    '[ ] Performance considered',
    '[ ] Security reviewed'
  ],
  'developer': [
    '[ ] Code follows existing patterns',
    '[ ] Tests written and passing',
    '[ ] Error handling implemented',
    '[ ] No security vulnerabilities',
    '[ ] Code is self-documenting'
  ],
  'judge': [
    '[ ] Security vulnerabilities checked',
    '[ ] Test coverage adequate',
    '[ ] Error handling reviewed',
    '[ ] Performance considered',
    '[ ] Code style consistent'
  ],
  'verification-fixer': [
    '[ ] Root cause addressed',
    '[ ] Fix is minimal',
    '[ ] Tests updated/added',
    '[ ] No regressions'
  ],
  'recovery-analyst': [
    '[ ] Error pattern identified',
    '[ ] Automation feasibility assessed',
    '[ ] Recovery strategy defined'
  ],
  'auto-merge': [
    '[ ] All tests pass',
    '[ ] No merge conflicts',
    '[ ] PR description complete',
    '[ ] Reviewers approved'
  ]
};

// ==================== IMPLEMENTATION ====================

export class SmartContextInjector {
  private static instance: SmartContextInjector;
  private indexer: CodebaseIndexer | null = null;
  private sharedFindings: Map<string, PreviousFinding[]> = new Map();

  private constructor() {}

  static getInstance(): SmartContextInjector {
    if (!SmartContextInjector.instance) {
      SmartContextInjector.instance = new SmartContextInjector();
    }
    return SmartContextInjector.instance;
  }

  /**
   * Initialize with workspace
   */
  async initialize(workspacePath: string): Promise<void> {
    this.indexer = CodebaseIndexer.getInstance(workspacePath);

    // Initialize indexer if not already done
    const stats = this.indexer.getStats();
    if (!stats) {
      await this.indexer.initialize();
    }
  }

  /**
   * Generate context for an agent
   */
  async generateContext(request: ContextRequest): Promise<InjectedContext> {
    // Ensure initialized
    if (!this.indexer) {
      await this.initialize(request.workspacePath);
    }

    // Get codebase overview
    const codebaseOverview = await this.getCodebaseOverview();

    // Find relevant files for the task
    const relevantFiles = await this.findRelevantFiles(
      request.taskDescription,
      request.focusAreas || []
    );

    // Get related tests
    const relatedTests = await this.findRelatedTests(relevantFiles);

    // Get previous findings from other phases
    const previousFindings = this.getPreviousFindings(request.previousPhaseResults);

    // Get phase-specific guidelines
    const phaseGuidelines = PHASE_GUIDELINES[request.phase] || [];
    const recommendedTools = PHASE_TOOLS[request.phase] || [];
    const qualityChecklist = QUALITY_CHECKLISTS[request.phase] || [];

    // Generate warnings based on codebase analysis
    const warningsAndPitfalls = await this.generateWarnings(
      request.taskDescription,
      relevantFiles
    );

    // Add user directives if provided
    if (request.userDirectives && request.userDirectives.length > 0) {
      phaseGuidelines.unshift('⚠️ USER DIRECTIVES (HIGH PRIORITY):');
      phaseGuidelines.push(...request.userDirectives.map(d => `  → ${d}`));
    }

    const context: InjectedContext = {
      codebaseOverview,
      relevantFiles,
      relatedTests,
      phaseGuidelines,
      recommendedTools,
      qualityChecklist,
      previousFindings,
      warningsAndPitfalls,
      formattedContext: '' // Will be set below
    };

    // Format for injection into prompt
    context.formattedContext = this.formatContextForPrompt(context, request.phase);

    return context;
  }

  /**
   * Get codebase overview from index
   */
  private async getCodebaseOverview(): Promise<CodebaseOverview> {
    if (!this.indexer) {
      return {
        totalFiles: 0,
        totalSymbols: 0,
        primaryLanguages: [],
        keyDirectories: [],
        entryPoints: [],
        testCoverage: 0
      };
    }

    const stats = this.indexer.getStats();
    if (!stats) {
      return {
        totalFiles: 0,
        totalSymbols: 0,
        primaryLanguages: [],
        keyDirectories: [],
        entryPoints: [],
        testCoverage: 0
      };
    }

    // Find entry points (index.ts, main.ts, app.ts)
    const entryPointResults = this.indexer.searchFiles('index');
    const entryPoints = entryPointResults
      .slice(0, 5)
      .map(r => r.file?.relativePath || '');

    return {
      totalFiles: stats.totalFiles,
      totalSymbols: stats.totalSymbols,
      primaryLanguages: Object.keys(stats.byLanguage).slice(0, 3),
      keyDirectories: ['src', 'lib', 'tests', 'config'].filter(d =>
        this.indexer!.searchFiles(d).length > 0
      ),
      entryPoints,
      testCoverage: this.estimateTestCoverage()
    };
  }

  /**
   * Find relevant files for the task
   */
  private async findRelevantFiles(
    taskDescription: string,
    focusAreas: string[]
  ): Promise<RelevantFile[]> {
    if (!this.indexer) return [];

    const relevantFiles: RelevantFile[] = [];
    const keywords = this.extractKeywords(taskDescription);

    // Search by keywords
    for (const keyword of keywords.slice(0, 5)) {
      const symbolResults = this.indexer.searchSymbol(keyword);
      const fileResults = this.indexer.searchFiles(keyword);

      for (const result of symbolResults.slice(0, 3)) {
        relevantFiles.push({
          path: result.file?.relativePath || '',
          relevance: result.score,
          reason: `Contains symbol matching "${keyword}"`,
          symbols: [result.match]
        });
      }

      for (const result of fileResults.slice(0, 2)) {
        relevantFiles.push({
          path: result.file?.relativePath || '',
          relevance: result.score * 0.8,
          reason: `File name matches "${keyword}"`
        });
      }
    }

    // Search focus areas
    for (const area of focusAreas) {
      const results = this.indexer.searchFiles(area);
      for (const result of results.slice(0, 3)) {
        relevantFiles.push({
          path: result.file?.relativePath || '',
          relevance: 0.9,
          reason: `In focus area: ${area}`
        });
      }
    }

    // Deduplicate and sort by relevance
    const uniqueFiles = new Map<string, RelevantFile>();
    for (const file of relevantFiles) {
      const existing = uniqueFiles.get(file.path);
      if (!existing || existing.relevance < file.relevance) {
        uniqueFiles.set(file.path, file);
      }
    }

    return Array.from(uniqueFiles.values())
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 15);
  }

  /**
   * Find related tests for relevant files
   */
  private async findRelatedTests(relevantFiles: RelevantFile[]): Promise<string[]> {
    if (!this.indexer) return [];

    const tests: Set<string> = new Set();

    for (const file of relevantFiles.slice(0, 5)) {
      const baseName = file.path.replace(/\.(ts|js|tsx|jsx)$/, '');

      // Look for test files
      const testPatterns = [
        `${baseName}.test`,
        `${baseName}.spec`,
        `${baseName}_test`
      ];

      for (const pattern of testPatterns) {
        const results = this.indexer.searchFiles(pattern);
        for (const result of results.slice(0, 2)) {
          tests.add(result.file?.relativePath || '');
        }
      }
    }

    return Array.from(tests).slice(0, 10);
  }

  /**
   * Get previous findings from other phases
   */
  private getPreviousFindings(
    previousPhaseResults?: Map<string, any>
  ): PreviousFinding[] {
    const findings: PreviousFinding[] = [];

    if (!previousPhaseResults) return findings;

    for (const [phase, result] of previousPhaseResults) {
      if (result.warnings) {
        for (const warning of result.warnings) {
          findings.push({
            phase,
            finding: warning,
            severity: 'warning'
          });
        }
      }
      if (result.errors) {
        for (const error of result.errors) {
          findings.push({
            phase,
            finding: error,
            severity: 'critical'
          });
        }
      }
      if (result.notes) {
        for (const note of result.notes) {
          findings.push({
            phase,
            finding: note,
            severity: 'info'
          });
        }
      }
    }

    // Add findings from shared state
    for (const [_phase, phaseFindings] of this.sharedFindings) {
      findings.push(...phaseFindings);
    }

    return findings.slice(0, 10);
  }

  /**
   * Generate warnings based on codebase analysis
   */
  private async generateWarnings(
    taskDescription: string,
    relevantFiles: RelevantFile[]
  ): Promise<string[]> {
    const warnings: string[] = [];

    // Check for common patterns that need attention
    if (taskDescription.toLowerCase().includes('auth')) {
      warnings.push('⚠️ Authentication changes require extra security review');
    }
    if (taskDescription.toLowerCase().includes('database') ||
        taskDescription.toLowerCase().includes('db')) {
      warnings.push('⚠️ Database changes may require migrations');
    }
    if (taskDescription.toLowerCase().includes('api')) {
      warnings.push('⚠️ API changes may require backwards compatibility');
    }

    // Check for high-complexity files
    for (const file of relevantFiles) {
      if (file.relevance > 0.8) {
        warnings.push(`📝 High relevance file: ${file.path} - ${file.reason}`);
      }
    }

    return warnings;
  }

  /**
   * Extract keywords from task description
   */
  private extractKeywords(text: string): string[] {
    // Remove common words and extract meaningful keywords
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
      'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
      'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need',
      'that', 'this', 'these', 'those', 'it', 'its'
    ]);

    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));

    // Return unique keywords
    return [...new Set(words)];
  }

  /**
   * Estimate test coverage
   */
  private estimateTestCoverage(): number {
    if (!this.indexer) return 0;

    const allFiles = this.indexer.searchFiles('');
    const testFiles = allFiles.filter(f =>
      f.file?.relativePath?.includes('.test.') ||
      f.file?.relativePath?.includes('.spec.')
    );

    const sourceFiles = allFiles.filter(f =>
      !f.file?.relativePath?.includes('.test.') &&
      !f.file?.relativePath?.includes('.spec.') &&
      !f.file?.relativePath?.includes('node_modules')
    );

    if (sourceFiles.length === 0) return 0;
    return Math.round((testFiles.length / sourceFiles.length) * 100);
  }

  /**
   * Format context for injection into agent prompt
   */
  private formatContextForPrompt(context: InjectedContext, phase: AgentPhase): string {
    const lines: string[] = [];

    lines.push('═══════════════════════════════════════════════════════');
    lines.push('🧠 SMART CONTEXT INJECTION - Pre-computed Intelligence');
    lines.push('═══════════════════════════════════════════════════════');
    lines.push('');

    // Codebase Overview
    lines.push('📊 CODEBASE OVERVIEW:');
    lines.push(`   Files: ${context.codebaseOverview.totalFiles}`);
    lines.push(`   Symbols: ${context.codebaseOverview.totalSymbols}`);
    lines.push(`   Languages: ${context.codebaseOverview.primaryLanguages.join(', ')}`);
    lines.push(`   Test Coverage: ~${context.codebaseOverview.testCoverage}%`);
    lines.push('');

    // Relevant Files
    if (context.relevantFiles.length > 0) {
      lines.push('📁 RELEVANT FILES (pre-identified for this task):');
      for (const file of context.relevantFiles.slice(0, 8)) {
        lines.push(`   • ${file.path} (${Math.round(file.relevance * 100)}% match)`);
        lines.push(`     → ${file.reason}`);
      }
      lines.push('');
    }

    // Related Tests
    if (context.relatedTests.length > 0) {
      lines.push('🧪 RELATED TESTS (run these after changes):');
      for (const test of context.relatedTests.slice(0, 5)) {
        lines.push(`   • ${test}`);
      }
      lines.push('');
    }

    // Phase Guidelines
    lines.push(`📋 GUIDELINES FOR ${phase.toUpperCase()}:`);
    for (const guideline of context.phaseGuidelines) {
      lines.push(`   ${guideline}`);
    }
    lines.push('');

    // Recommended Tools
    lines.push('🔧 RECOMMENDED TOOLS (use these for faster results):');
    for (const tool of context.recommendedTools) {
      lines.push(`   • ${tool}`);
    }
    lines.push('');

    // Quality Checklist
    lines.push('✅ QUALITY CHECKLIST:');
    for (const item of context.qualityChecklist) {
      lines.push(`   ${item}`);
    }
    lines.push('');

    // Previous Findings
    if (context.previousFindings.length > 0) {
      lines.push('📝 FINDINGS FROM PREVIOUS PHASES:');
      for (const finding of context.previousFindings) {
        const icon = finding.severity === 'critical' ? '🔴' :
                    finding.severity === 'warning' ? '🟡' : 'ℹ️';
        lines.push(`   ${icon} [${finding.phase}] ${finding.finding}`);
      }
      lines.push('');
    }

    // Warnings
    if (context.warningsAndPitfalls.length > 0) {
      lines.push('⚠️ WARNINGS AND PITFALLS:');
      for (const warning of context.warningsAndPitfalls) {
        lines.push(`   ${warning}`);
      }
      lines.push('');
    }

    lines.push('═══════════════════════════════════════════════════════');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Store findings from a phase for future reference
   */
  storeFinding(phase: string, finding: string, severity: 'info' | 'warning' | 'critical'): void {
    if (!this.sharedFindings.has(phase)) {
      this.sharedFindings.set(phase, []);
    }
    this.sharedFindings.get(phase)!.push({ phase, finding, severity });
  }

  /**
   * Clear all stored findings
   */
  clearFindings(): void {
    this.sharedFindings.clear();
  }
}

// Export singleton getter
export function getSmartContextInjector(): SmartContextInjector {
  return SmartContextInjector.getInstance();
}
