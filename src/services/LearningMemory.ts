/**
 * LearningMemory
 *
 * Learns from previous task executions to improve future performance.
 * Stores patterns, common errors, successful solutions, and project-specific knowledge.
 *
 * Key behaviors:
 * 1. Track successful patterns that worked
 * 2. Remember errors and their fixes
 * 3. Learn project-specific conventions
 * 4. Provide context from similar past tasks
 */

import * as fs from 'fs';
import * as path from 'path';

export interface LearningEntry {
  id: string;
  timestamp: Date;
  projectId: string;
  taskType: 'feature' | 'bugfix' | 'refactor' | 'test' | 'documentation';
  context: {
    filesModified: string[];
    patternsUsed: string[];
    toolsUsed: string[];
    duration: number;
  };
  outcome: 'success' | 'partial' | 'failure';
  lessons: LessonLearned[];
  errorPatterns?: ErrorLesson[];
  successPatterns?: SuccessPattern[];
}

export interface LessonLearned {
  category: 'pattern' | 'error' | 'optimization' | 'convention';
  description: string;
  example?: string;
  applicableTo: string[]; // File patterns or contexts
  importance: 'critical' | 'important' | 'helpful';
}

export interface ErrorLesson {
  errorType: string;
  errorMessage: string;
  rootCause: string;
  solution: string;
  preventionTip: string;
  occurrences: number;
}

export interface SuccessPattern {
  patternName: string;
  description: string;
  codeExample: string;
  applicableWhen: string[];
  usageCount: number;
}

export interface ProjectKnowledge {
  projectId: string;
  conventions: {
    naming: string[];
    fileStructure: string[];
    importOrder: string[];
    codeStyle: string[];
  };
  helperFunctions: {
    name: string;
    purpose: string;
    location: string;
    usage: string;
  }[];
  commonPatterns: SuccessPattern[];
  avoidPatterns: {
    pattern: string;
    reason: string;
    alternative: string;
  }[];
  dependencies: {
    name: string;
    version: string;
    commonUsage: string;
  }[];
}

export interface LearningContext {
  relevantLessons: LessonLearned[];
  similarTasks: LearningEntry[];
  projectKnowledge: ProjectKnowledge | null;
  recommendations: string[];
}

export class LearningMemory {
  private static memoryPath: string;
  private static entries: LearningEntry[] = [];
  private static projectKnowledge: Map<string, ProjectKnowledge> = new Map();

  /**
   * Initialize learning memory from disk
   */
  static async initialize(workspacePath: string): Promise<void> {
    this.memoryPath = path.join(workspacePath, '.agent-memory');

    if (!fs.existsSync(this.memoryPath)) {
      fs.mkdirSync(this.memoryPath, { recursive: true });
    }

    await this.loadMemory();
  }

  /**
   * Load memory from disk
   */
  private static async loadMemory(): Promise<void> {
    const entriesPath = path.join(this.memoryPath, 'entries.json');
    const knowledgePath = path.join(this.memoryPath, 'knowledge.json');

    if (fs.existsSync(entriesPath)) {
      try {
        this.entries = JSON.parse(fs.readFileSync(entriesPath, 'utf8'));
      } catch {
        this.entries = [];
      }
    }

    if (fs.existsSync(knowledgePath)) {
      try {
        const knowledge = JSON.parse(fs.readFileSync(knowledgePath, 'utf8'));
        this.projectKnowledge = new Map(Object.entries(knowledge));
      } catch {
        this.projectKnowledge = new Map();
      }
    }
  }

  /**
   * Save memory to disk
   */
  private static async saveMemory(): Promise<void> {
    const entriesPath = path.join(this.memoryPath, 'entries.json');
    const knowledgePath = path.join(this.memoryPath, 'knowledge.json');

    fs.writeFileSync(entriesPath, JSON.stringify(this.entries, null, 2));
    fs.writeFileSync(
      knowledgePath,
      JSON.stringify(Object.fromEntries(this.projectKnowledge), null, 2)
    );
  }

  /**
   * Record a completed task
   */
  static async recordTask(entry: Omit<LearningEntry, 'id' | 'timestamp'>): Promise<void> {
    const newEntry: LearningEntry = {
      ...entry,
      id: `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
    };

    this.entries.push(newEntry);

    // Keep only last 100 entries per project
    const projectEntries = this.entries.filter(e => e.projectId === entry.projectId);
    if (projectEntries.length > 100) {
      const toRemove = projectEntries.slice(0, projectEntries.length - 100);
      this.entries = this.entries.filter(e => !toRemove.includes(e));
    }

    await this.saveMemory();
  }

  /**
   * Record an error and its solution
   */
  static async recordError(
    projectId: string,
    error: ErrorLesson
  ): Promise<void> {
    const knowledge = this.projectKnowledge.get(projectId) || this.createEmptyKnowledge(projectId);

    // Check if error already exists
    const existingIndex = this.findSimilarError(knowledge, error);

    if (existingIndex >= 0) {
      // Update existing error lesson - update the alternative with latest solution
      knowledge.avoidPatterns[existingIndex].alternative = error.solution;
    } else {
      // Add new avoid pattern
      knowledge.avoidPatterns.push({
        pattern: error.errorMessage,
        reason: error.rootCause,
        alternative: error.solution,
      });
    }

    this.projectKnowledge.set(projectId, knowledge);
    await this.saveMemory();
  }

  /**
   * Record a successful pattern
   */
  static async recordSuccessPattern(
    projectId: string,
    pattern: SuccessPattern
  ): Promise<void> {
    const knowledge = this.projectKnowledge.get(projectId) || this.createEmptyKnowledge(projectId);

    const existing = knowledge.commonPatterns.find(p => p.patternName === pattern.patternName);

    if (existing) {
      existing.usageCount++;
    } else {
      knowledge.commonPatterns.push(pattern);
    }

    this.projectKnowledge.set(projectId, knowledge);
    await this.saveMemory();
  }

  /**
   * Get learning context for a new task
   */
  static async getLearningContext(
    projectId: string,
    taskDescription: string,
    filesToModify: string[]
  ): Promise<LearningContext> {
    const knowledge = this.projectKnowledge.get(projectId);

    // Find similar past tasks
    const similarTasks = this.findSimilarTasks(projectId, taskDescription, filesToModify);

    // Extract relevant lessons
    const relevantLessons = this.extractRelevantLessons(similarTasks, filesToModify);

    // Generate recommendations
    const recommendations = this.generateRecommendations(
      knowledge,
      similarTasks,
      relevantLessons
    );

    return {
      relevantLessons,
      similarTasks: similarTasks.slice(0, 5), // Top 5 most similar
      projectKnowledge: knowledge || null,
      recommendations,
    };
  }

  /**
   * Find similar past tasks
   */
  private static findSimilarTasks(
    projectId: string,
    description: string,
    files: string[]
  ): LearningEntry[] {
    const projectTasks = this.entries.filter(e => e.projectId === projectId);

    // Score each task by similarity
    const scored = projectTasks.map(task => {
      let score = 0;

      // File overlap
      const fileOverlap = task.context.filesModified.filter(f =>
        files.some(target => target.includes(f) || f.includes(target))
      ).length;
      score += fileOverlap * 10;

      // Pattern overlap (simple keyword matching)
      const descWords = description.toLowerCase().split(/\s+/);
      for (const pattern of task.context.patternsUsed) {
        if (descWords.some(w => pattern.toLowerCase().includes(w))) {
          score += 5;
        }
      }

      // Recency bonus
      const daysSince = (Date.now() - new Date(task.timestamp).getTime()) / (1000 * 60 * 60 * 24);
      score += Math.max(0, 30 - daysSince); // Bonus for recent tasks

      // Success bonus
      if (task.outcome === 'success') score += 20;

      return { task, score };
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .map(s => s.task);
  }

  /**
   * Extract relevant lessons from similar tasks
   */
  private static extractRelevantLessons(
    tasks: LearningEntry[],
    targetFiles: string[]
  ): LessonLearned[] {
    const lessons: LessonLearned[] = [];
    const seen = new Set<string>();

    for (const task of tasks) {
      for (const lesson of task.lessons) {
        // Check if lesson applies to target files
        const applies = lesson.applicableTo.some(pattern =>
          targetFiles.some(file => file.includes(pattern) || pattern.includes('*'))
        );

        if (applies || lesson.importance === 'critical') {
          const key = `${lesson.category}-${lesson.description}`;
          if (!seen.has(key)) {
            lessons.push(lesson);
            seen.add(key);
          }
        }
      }
    }

    // Sort by importance
    const importanceOrder = { critical: 0, important: 1, helpful: 2 };
    return lessons.sort((a, b) => importanceOrder[a.importance] - importanceOrder[b.importance]);
  }

  /**
   * Generate recommendations based on learning
   */
  private static generateRecommendations(
    knowledge: ProjectKnowledge | undefined,
    similarTasks: LearningEntry[],
    lessons: LessonLearned[]
  ): string[] {
    const recommendations: string[] = [];

    // From project knowledge
    if (knowledge) {
      if (knowledge.helperFunctions.length > 0) {
        recommendations.push(
          `📚 Use existing helpers: ${knowledge.helperFunctions.map(h => h.name).join(', ')}`
        );
      }

      if (knowledge.avoidPatterns.length > 0) {
        const topAvoid = knowledge.avoidPatterns.slice(0, 3);
        for (const avoid of topAvoid) {
          recommendations.push(`⚠️ Avoid: ${avoid.pattern} - ${avoid.reason}`);
        }
      }

      if (knowledge.conventions.naming.length > 0) {
        recommendations.push(
          `📝 Naming: ${knowledge.conventions.naming[0]}`
        );
      }
    }

    // From similar tasks
    const failedTasks = similarTasks.filter(t => t.outcome === 'failure');
    if (failedTasks.length > 0) {
      const commonErrors = failedTasks
        .flatMap(t => t.errorPatterns || [])
        .slice(0, 2);

      for (const error of commonErrors) {
        recommendations.push(
          `🔴 Past error: ${error.errorType} - Prevention: ${error.preventionTip}`
        );
      }
    }

    // From lessons
    const criticalLessons = lessons.filter(l => l.importance === 'critical');
    for (const lesson of criticalLessons.slice(0, 3)) {
      recommendations.push(`💡 ${lesson.description}`);
    }

    return recommendations;
  }

  /**
   * Create empty knowledge structure
   */
  private static createEmptyKnowledge(projectId: string): ProjectKnowledge {
    return {
      projectId,
      conventions: {
        naming: [],
        fileStructure: [],
        importOrder: [],
        codeStyle: [],
      },
      helperFunctions: [],
      commonPatterns: [],
      avoidPatterns: [],
      dependencies: [],
    };
  }

  /**
   * Find similar error in knowledge
   */
  private static findSimilarError(
    knowledge: ProjectKnowledge,
    error: ErrorLesson
  ): number {
    return knowledge.avoidPatterns.findIndex(p =>
      p.pattern.includes(error.errorType) || error.errorMessage.includes(p.pattern)
    );
  }

  /**
   * Update project knowledge from codebase analysis
   */
  static async updateProjectKnowledge(
    projectId: string,
    analysis: Partial<ProjectKnowledge>
  ): Promise<void> {
    const existing = this.projectKnowledge.get(projectId) || this.createEmptyKnowledge(projectId);

    // Merge analysis into existing knowledge
    if (analysis.conventions) {
      existing.conventions = {
        ...existing.conventions,
        ...analysis.conventions,
      };
    }

    if (analysis.helperFunctions) {
      const newHelpers = analysis.helperFunctions.filter(h =>
        !existing.helperFunctions.some(e => e.name === h.name)
      );
      existing.helperFunctions.push(...newHelpers);
    }

    if (analysis.dependencies) {
      const newDeps = analysis.dependencies.filter(d =>
        !existing.dependencies.some(e => e.name === d.name)
      );
      existing.dependencies.push(...newDeps);
    }

    this.projectKnowledge.set(projectId, existing);
    await this.saveMemory();
  }

  /**
   * Generate learning context for prompt injection
   */
  static formatForPrompt(context: LearningContext): string {
    if (!context.projectKnowledge && context.relevantLessons.length === 0) {
      return '';
    }

    let output = `
## 📚 LEARNING FROM PAST TASKS

`;

    // Recommendations (most important)
    if (context.recommendations.length > 0) {
      output += `### Key Recommendations:\n`;
      for (const rec of context.recommendations) {
        output += `- ${rec}\n`;
      }
      output += '\n';
    }

    // Project conventions
    if (context.projectKnowledge) {
      const pk = context.projectKnowledge;

      if (pk.helperFunctions.length > 0) {
        output += `### Available Helper Functions:\n`;
        for (const helper of pk.helperFunctions.slice(0, 5)) {
          output += `- **${helper.name}** (${helper.location}): ${helper.purpose}\n`;
          output += `  Usage: \`${helper.usage}\`\n`;
        }
        output += '\n';
      }

      if (pk.avoidPatterns.length > 0) {
        output += `### ⚠️ Patterns to Avoid:\n`;
        for (const avoid of pk.avoidPatterns.slice(0, 3)) {
          output += `- ❌ ${avoid.pattern}\n`;
          output += `  Reason: ${avoid.reason}\n`;
          output += `  ✅ Instead: ${avoid.alternative}\n`;
        }
        output += '\n';
      }

      if (pk.commonPatterns.length > 0) {
        output += `### ✅ Successful Patterns:\n`;
        for (const pattern of pk.commonPatterns.slice(0, 3)) {
          output += `- **${pattern.patternName}** (used ${pattern.usageCount}x)\n`;
          output += `  ${pattern.description}\n`;
        }
        output += '\n';
      }
    }

    // Critical lessons
    const criticalLessons = context.relevantLessons.filter(l => l.importance === 'critical');
    if (criticalLessons.length > 0) {
      output += `### 🚨 Critical Lessons:\n`;
      for (const lesson of criticalLessons) {
        output += `- ${lesson.description}\n`;
        if (lesson.example) {
          output += `  Example: ${lesson.example}\n`;
        }
      }
      output += '\n';
    }

    // Similar successful tasks
    const successfulTasks = context.similarTasks.filter(t => t.outcome === 'success');
    if (successfulTasks.length > 0) {
      output += `### 📋 Similar Past Tasks (Successful):\n`;
      for (const task of successfulTasks.slice(0, 3)) {
        output += `- Modified: ${task.context.filesModified.slice(0, 3).join(', ')}\n`;
        output += `  Patterns: ${task.context.patternsUsed.join(', ')}\n`;
      }
    }

    return output;
  }

  /**
   * Generate instructions for agents
   */
  static generateInstructions(): string {
    return `
## 📚 LEARNING FROM EXPERIENCE

This system learns from every task to improve future performance.

### What Gets Recorded:

1. **Successful Patterns**
   - Code patterns that worked well
   - Helper functions that were used
   - Conventions followed

2. **Errors and Fixes**
   - Compilation errors encountered
   - How they were fixed
   - Prevention tips for future

3. **Project Knowledge**
   - File structure patterns
   - Naming conventions
   - Available utilities

### How to Use Learning:

1. **Check recommendations before coding**
   - Look for helper functions to use
   - Avoid patterns that failed before
   - Follow proven conventions

2. **Learn from similar tasks**
   - What files were modified?
   - What patterns worked?
   - What errors occurred?

3. **Contribute to learning**
   - When you find a good pattern, it gets recorded
   - When you fix an error, the solution is saved
   - Future tasks benefit from your experience

### 🧠 Remember:
- Past errors teach us what NOT to do
- Successful patterns should be reused
- Project conventions exist for good reasons
`;
  }
}
