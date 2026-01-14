/**
 * IntentPredictor - User intent prediction service
 *
 * Predicts user intent from messages to enable proactive assistance,
 * smart tool selection, and context-aware responses.
 */

interface PredictedIntent {
  intent: IntentType;
  confidence: number;
  subIntent?: string;
  entities: ExtractedEntity[];
  suggestedActions: SuggestedAction[];
  contextRequired: string[];
  estimatedComplexity: 'simple' | 'moderate' | 'complex';
}

type IntentType =
  | 'code-generation'
  | 'code-modification'
  | 'bug-fix'
  | 'refactoring'
  | 'explanation'
  | 'documentation'
  | 'testing'
  | 'debugging'
  | 'performance'
  | 'security'
  | 'deployment'
  | 'configuration'
  | 'search'
  | 'navigation'
  | 'review'
  | 'learning'
  | 'planning'
  | 'unknown';

interface ExtractedEntity {
  type: EntityType;
  value: string;
  position: { start: number; end: number };
  confidence: number;
}

type EntityType =
  | 'file-path'
  | 'function-name'
  | 'class-name'
  | 'variable-name'
  | 'package-name'
  | 'error-message'
  | 'line-number'
  | 'technology'
  | 'feature-description'
  | 'code-snippet';

interface SuggestedAction {
  action: string;
  tool: string;
  priority: 'immediate' | 'follow-up' | 'optional';
  parameters?: Record<string, any>;
}

interface ConversationContext {
  recentIntents: IntentType[];
  mentionedFiles: string[];
  mentionedFunctions: string[];
  currentTask?: string;
  projectType?: string;
  techStack?: string[];
}

// Intent patterns with keywords and regex
const INTENT_PATTERNS: Record<IntentType, {
  keywords: string[];
  patterns: RegExp[];
  weight: number;
}> = {
  'code-generation': {
    keywords: ['create', 'add', 'implement', 'write', 'generate', 'new', 'build', 'make', 'scaffold'],
    patterns: [
      /(?:create|add|implement|write|generate|build|make)\s+(?:a\s+)?(?:new\s+)?(\w+)/i,
      /(?:need|want)\s+(?:a\s+)?(?:new\s+)?(\w+)/i
    ],
    weight: 1.0
  },
  'code-modification': {
    keywords: ['change', 'modify', 'update', 'edit', 'alter', 'adjust', 'replace'],
    patterns: [
      /(?:change|modify|update|edit|alter|adjust|replace)\s+(?:the\s+)?(\w+)/i,
      /(?:can you|please)\s+(?:change|modify|update)/i
    ],
    weight: 1.0
  },
  'bug-fix': {
    keywords: ['fix', 'bug', 'error', 'issue', 'problem', 'broken', 'wrong', 'fails', 'crash', 'exception'],
    patterns: [
      /(?:fix|solve|resolve)\s+(?:the\s+)?(?:bug|error|issue|problem)/i,
      /(?:not working|doesn't work|broken|failing)/i,
      /(?:error|exception|crash)(?:ing|ed)?/i
    ],
    weight: 1.2 // Higher weight for bug fixes
  },
  'refactoring': {
    keywords: ['refactor', 'clean', 'improve', 'optimize', 'restructure', 'simplify', 'extract', 'rename'],
    patterns: [
      /(?:refactor|clean\s*up|improve|restructure|simplify)\s+(?:the\s+)?(\w+)/i,
      /(?:extract|rename|move)\s+(?:the\s+)?(\w+)/i
    ],
    weight: 0.9
  },
  'explanation': {
    keywords: ['explain', 'what', 'how', 'why', 'understand', 'mean', 'does', 'work'],
    patterns: [
      /(?:explain|describe|tell\s+me)\s+(?:how|what|why)/i,
      /(?:what|how)\s+(?:does|is|are)\s+/i,
      /(?:can you|could you)\s+explain/i
    ],
    weight: 0.8
  },
  'documentation': {
    keywords: ['document', 'docs', 'readme', 'comment', 'jsdoc', 'api', 'describe'],
    patterns: [
      /(?:add|write|create|generate)\s+(?:the\s+)?(?:docs|documentation|comments)/i,
      /(?:document|describe)\s+(?:the\s+)?(\w+)/i
    ],
    weight: 0.9
  },
  'testing': {
    keywords: ['test', 'spec', 'coverage', 'unit', 'integration', 'e2e', 'mock', 'assert'],
    patterns: [
      /(?:add|write|create)\s+(?:a\s+)?tests?/i,
      /(?:test|spec)\s+(?:for\s+)?(?:the\s+)?(\w+)/i,
      /(?:run|execute)\s+(?:the\s+)?tests?/i
    ],
    weight: 1.0
  },
  'debugging': {
    keywords: ['debug', 'log', 'trace', 'inspect', 'breakpoint', 'step', 'watch'],
    patterns: [
      /(?:debug|trace|inspect)\s+(?:the\s+)?(\w+)/i,
      /(?:add|put)\s+(?:a\s+)?(?:log|breakpoint)/i
    ],
    weight: 1.0
  },
  'performance': {
    keywords: ['performance', 'slow', 'fast', 'optimize', 'speed', 'memory', 'profile', 'benchmark'],
    patterns: [
      /(?:optimize|improve)\s+(?:the\s+)?(?:performance|speed)/i,
      /(?:too\s+slow|taking\s+too\s+long|memory\s+leak)/i,
      /(?:profile|benchmark)\s+(?:the\s+)?(\w+)/i
    ],
    weight: 1.0
  },
  'security': {
    keywords: ['security', 'vulnerability', 'auth', 'permission', 'encrypt', 'sanitize', 'xss', 'sql'],
    patterns: [
      /(?:security|vulnerability|exploit)/i,
      /(?:add|implement)\s+(?:auth|authentication|authorization)/i,
      /(?:sanitize|validate|escape)\s+(?:the\s+)?(?:input|data)/i
    ],
    weight: 1.1
  },
  'deployment': {
    keywords: ['deploy', 'release', 'publish', 'ship', 'production', 'staging', 'ci', 'cd'],
    patterns: [
      /(?:deploy|release|publish)\s+(?:to\s+)?(\w+)/i,
      /(?:set\s*up|configure)\s+(?:the\s+)?(?:ci|cd|deployment)/i
    ],
    weight: 0.9
  },
  'configuration': {
    keywords: ['config', 'setup', 'configure', 'settings', 'environment', 'env', 'option'],
    patterns: [
      /(?:configure|set\s*up)\s+(?:the\s+)?(\w+)/i,
      /(?:change|update)\s+(?:the\s+)?(?:config|settings|options)/i
    ],
    weight: 0.8
  },
  'search': {
    keywords: ['find', 'search', 'locate', 'where', 'look', 'grep'],
    patterns: [
      /(?:find|search|locate|look\s+for)\s+(?:the\s+)?(\w+)/i,
      /where\s+(?:is|are|can\s+I\s+find)\s+/i
    ],
    weight: 0.7
  },
  'navigation': {
    keywords: ['go', 'open', 'show', 'navigate', 'jump', 'take'],
    patterns: [
      /(?:go|navigate|jump)\s+to\s+(?:the\s+)?(\w+)/i,
      /(?:open|show)\s+(?:me\s+)?(?:the\s+)?(\w+)/i
    ],
    weight: 0.6
  },
  'review': {
    keywords: ['review', 'check', 'look', 'audit', 'inspect', 'analyze', 'assess'],
    patterns: [
      /(?:review|check|audit|analyze)\s+(?:the\s+)?(?:code|pr|changes)/i,
      /(?:can you|please)\s+(?:review|check)/i
    ],
    weight: 0.9
  },
  'learning': {
    keywords: ['learn', 'tutorial', 'example', 'how to', 'best practice', 'recommend'],
    patterns: [
      /(?:how\s+do\s+I|how\s+to|what's\s+the\s+best\s+way)/i,
      /(?:show\s+me|give\s+me)\s+(?:an?\s+)?example/i
    ],
    weight: 0.7
  },
  'planning': {
    keywords: ['plan', 'design', 'architect', 'structure', 'approach', 'strategy'],
    patterns: [
      /(?:plan|design|architect)\s+(?:the\s+)?(\w+)/i,
      /(?:how\s+should\s+I|what's\s+the\s+best\s+approach)/i
    ],
    weight: 0.8
  },
  'unknown': {
    keywords: [],
    patterns: [],
    weight: 0.1
  }
};

// Entity extraction patterns
const ENTITY_PATTERNS: Record<EntityType, RegExp[]> = {
  'file-path': [
    /(?:^|[\s'"(])([a-zA-Z0-9_\-./]+\.(?:ts|tsx|js|jsx|py|java|go|rs|rb|php|vue|svelte|html|css|scss|json|yaml|yml|md|sql))/gi,
    /(?:in|at|from|to)\s+['"]?([a-zA-Z0-9_\-./]+(?:\/[a-zA-Z0-9_\-./]+)+)['"]?/gi
  ],
  'function-name': [
    /(?:function|method|func)\s+['"`]?(\w+)['"`]?/gi,
    /(?:the\s+)?['"`]?(\w+)['"`]?\s+(?:function|method)/gi,
    /(?:call(?:ing|s)?|invoke|run)\s+['"`]?(\w+)['"`]?/gi
  ],
  'class-name': [
    /(?:class|component|service)\s+['"`]?(\w+)['"`]?/gi,
    /(?:the\s+)?['"`]?(\w+)['"`]?\s+(?:class|component|service)/gi
  ],
  'variable-name': [
    /(?:variable|const|let|var)\s+['"`]?(\w+)['"`]?/gi,
    /(?:the\s+)?['"`]?(\w+)['"`]?\s+variable/gi
  ],
  'package-name': [
    /(?:package|module|library|dependency)\s+['"`]?(@?[\w/-]+)['"`]?/gi,
    /(?:import|require|from)\s+['"`](@?[\w/-]+)['"`]/gi,
    /(?:install|add|npm|yarn|pnpm)\s+(?:install\s+)?['"`]?(@?[\w/-]+)['"`]?/gi
  ],
  'error-message': [
    /(?:error|exception|crash):\s*(.+?)(?:\n|$)/gi,
    /['"`]([^'"`]*(?:error|failed|cannot|unable)[^'"`]*)['"`]/gi
  ],
  'line-number': [
    /(?:line|ln|L)\s*(?:#)?(\d+)/gi,
    /:(\d+)(?::\d+)?(?:\s|$)/g
  ],
  'technology': [
    /(?:using|with|in)\s+(react|vue|angular|svelte|next|nuxt|express|fastify|node|typescript|javascript|python|java|go|rust|ruby|php)/gi
  ],
  'feature-description': [
    /(?:feature|functionality|capability)\s+(?:to|that|for)\s+(.+?)(?:\.|$)/gi
  ],
  'code-snippet': [
    /```[\s\S]*?```/g,
    /`([^`]+)`/g
  ]
};

// Tool mapping for intents
const INTENT_TOOLS: Record<IntentType, string[]> = {
  'code-generation': ['Edit', 'Write', 'Bash'],
  'code-modification': ['Read', 'Edit', 'Write'],
  'bug-fix': ['Read', 'Grep', 'Edit', 'Bash'],
  'refactoring': ['Read', 'Edit', 'Grep'],
  'explanation': ['Read', 'Grep'],
  'documentation': ['Read', 'Write', 'Edit'],
  'testing': ['Read', 'Write', 'Bash'],
  'debugging': ['Read', 'Bash', 'Grep'],
  'performance': ['Read', 'Grep', 'Bash'],
  'security': ['Read', 'Grep', 'Bash'],
  'deployment': ['Bash', 'Read', 'Write'],
  'configuration': ['Read', 'Edit', 'Write'],
  'search': ['Grep', 'Glob', 'Read'],
  'navigation': ['Read', 'Glob'],
  'review': ['Read', 'Grep', 'Bash'],
  'learning': ['Read', 'WebSearch', 'WebFetch'],
  'planning': ['Read', 'Grep', 'Glob'],
  'unknown': ['Read', 'Grep']
};

export class IntentPredictor {
  private conversationHistory: PredictedIntent[] = [];
  private context: ConversationContext = {
    recentIntents: [],
    mentionedFiles: [],
    mentionedFunctions: []
  };

  /**
   * Predict intent from user message
   */
  predict(message: string): PredictedIntent {
    // Extract entities first
    const entities = this.extractEntities(message);

    // Score each intent type
    const scores = this.scoreIntents(message, entities);

    // Get top intent
    const sortedIntents = Object.entries(scores)
      .sort(([, a], [, b]) => b - a);

    const topIntent = sortedIntents[0];
    const intent = topIntent[0] as IntentType;
    const confidence = Math.min(topIntent[1], 1.0);

    // Determine sub-intent
    const subIntent = this.determineSubIntent(intent, message, entities);

    // Get suggested actions
    const suggestedActions = this.generateSuggestedActions(intent, entities);

    // Determine context required
    const contextRequired = this.determineContextRequired(intent, entities);

    // Estimate complexity
    const complexity = this.estimateComplexity(intent, message, entities);

    // Update context
    this.updateContext(intent, entities);

    const prediction: PredictedIntent = {
      intent,
      confidence,
      subIntent,
      entities,
      suggestedActions,
      contextRequired,
      estimatedComplexity: complexity
    };

    this.conversationHistory.push(prediction);

    return prediction;
  }

  /**
   * Predict multiple possible intents
   */
  predictMultiple(message: string, topN: number = 3): PredictedIntent[] {
    const entities = this.extractEntities(message);
    const scores = this.scoreIntents(message, entities);

    const sortedIntents = Object.entries(scores)
      .sort(([, a], [, b]) => b - a)
      .slice(0, topN);

    return sortedIntents.map(([intentType, score]) => {
      const intent = intentType as IntentType;
      return {
        intent,
        confidence: Math.min(score, 1.0),
        subIntent: this.determineSubIntent(intent, message, entities),
        entities,
        suggestedActions: this.generateSuggestedActions(intent, entities),
        contextRequired: this.determineContextRequired(intent, entities),
        estimatedComplexity: this.estimateComplexity(intent, message, entities)
      };
    });
  }

  /**
   * Get proactive suggestions based on context
   */
  getProactiveSuggestions(): string[] {
    const suggestions: string[] = [];

    // Based on recent intents
    const recentIntents = this.context.recentIntents.slice(-3);

    if (recentIntents.includes('bug-fix') && !recentIntents.includes('testing')) {
      suggestions.push('Consider adding tests for the fixed bug to prevent regression');
    }

    if (recentIntents.includes('code-generation') && recentIntents.length > 2) {
      suggestions.push('Would you like me to generate documentation for the new code?');
    }

    if (recentIntents.includes('refactoring')) {
      suggestions.push('Should I run the test suite to verify the refactoring?');
    }

    if (this.context.mentionedFiles.length > 5) {
      suggestions.push('Multiple files have been mentioned - shall I create a summary?');
    }

    return suggestions;
  }

  /**
   * Improve prediction with feedback
   */
  provideFeedback(prediction: PredictedIntent, actualIntent: IntentType): void {
    // In a real implementation, this would update model weights
    // For now, we just adjust context
    if (prediction.intent !== actualIntent) {
      this.context.recentIntents.pop();
      this.context.recentIntents.push(actualIntent);
    }
  }

  /**
   * Reset context
   */
  resetContext(): void {
    this.context = {
      recentIntents: [],
      mentionedFiles: [],
      mentionedFunctions: []
    };
    this.conversationHistory = [];
  }

  /**
   * Set project context
   */
  setProjectContext(projectType: string, techStack: string[]): void {
    this.context.projectType = projectType;
    this.context.techStack = techStack;
  }

  // Private helper methods

  private extractEntities(message: string): ExtractedEntity[] {
    const entities: ExtractedEntity[] = [];

    for (const [entityType, patterns] of Object.entries(ENTITY_PATTERNS)) {
      for (const pattern of patterns) {
        const regex = new RegExp(pattern.source, pattern.flags);
        let match;

        while ((match = regex.exec(message)) !== null) {
          const value = match[1] || match[0];

          // Skip if already extracted
          if (entities.some(e => e.value === value && e.type === entityType)) {
            continue;
          }

          entities.push({
            type: entityType as EntityType,
            value,
            position: { start: match.index, end: match.index + match[0].length },
            confidence: this.calculateEntityConfidence(entityType as EntityType, value)
          });
        }
      }
    }

    // Sort by position
    return entities.sort((a, b) => a.position.start - b.position.start);
  }

  private scoreIntents(message: string, entities: ExtractedEntity[]): Record<IntentType, number> {
    const scores: Record<IntentType, number> = {} as Record<IntentType, number>;
    const messageLower = message.toLowerCase();

    for (const [intentType, config] of Object.entries(INTENT_PATTERNS)) {
      let score = 0;

      // Keyword matching
      for (const keyword of config.keywords) {
        if (messageLower.includes(keyword.toLowerCase())) {
          score += 0.2;
        }
      }

      // Pattern matching
      for (const pattern of config.patterns) {
        if (pattern.test(message)) {
          score += 0.4;
        }
      }

      // Apply weight
      score *= config.weight;

      // Context boost
      score += this.getContextBoost(intentType as IntentType);

      // Entity-based boost
      score += this.getEntityBoost(intentType as IntentType, entities);

      scores[intentType as IntentType] = score;
    }

    // Normalize scores
    const maxScore = Math.max(...Object.values(scores));
    if (maxScore > 0) {
      for (const key of Object.keys(scores)) {
        scores[key as IntentType] /= maxScore;
      }
    }

    return scores;
  }

  private getContextBoost(intent: IntentType): number {
    let boost = 0;

    // Boost based on recent intents
    if (this.context.recentIntents.length > 0) {
      const lastIntent = this.context.recentIntents[this.context.recentIntents.length - 1];

      // Follow-up intents get a boost
      const followUps: Partial<Record<IntentType, IntentType[]>> = {
        'code-generation': ['testing', 'documentation', 'review'],
        'bug-fix': ['testing', 'review'],
        'refactoring': ['testing', 'review'],
        'planning': ['code-generation', 'configuration']
      };

      if (followUps[lastIntent]?.includes(intent)) {
        boost += 0.2;
      }
    }

    // Project type boost
    if (this.context.projectType) {
      if (this.context.projectType === 'frontend' && ['performance', 'testing'].includes(intent)) {
        boost += 0.1;
      }
      if (this.context.projectType === 'backend' && ['security', 'performance'].includes(intent)) {
        boost += 0.1;
      }
    }

    return boost;
  }

  private getEntityBoost(intent: IntentType, entities: ExtractedEntity[]): number {
    let boost = 0;

    const entityIntentMap: Record<EntityType, IntentType[]> = {
      'file-path': ['code-modification', 'refactoring', 'review'],
      'function-name': ['code-modification', 'refactoring', 'testing'],
      'class-name': ['code-generation', 'refactoring', 'documentation'],
      'error-message': ['bug-fix', 'debugging'],
      'line-number': ['bug-fix', 'code-modification'],
      'package-name': ['configuration', 'deployment'],
      'technology': ['code-generation', 'configuration', 'learning'],
      'code-snippet': ['explanation', 'bug-fix', 'review'],
      'feature-description': ['code-generation', 'planning'],
      'variable-name': ['code-modification', 'debugging']
    };

    for (const entity of entities) {
      if (entityIntentMap[entity.type]?.includes(intent)) {
        boost += 0.1 * entity.confidence;
      }
    }

    return boost;
  }

  private calculateEntityConfidence(type: EntityType, value: string): number {
    let confidence = 0.5;

    switch (type) {
      case 'file-path':
        // Higher confidence for paths with extensions
        if (/\.\w{2,4}$/.test(value)) confidence = 0.9;
        // Lower for relative paths
        if (value.startsWith('./') || value.startsWith('../')) confidence = 0.8;
        break;

      case 'function-name':
        // camelCase or snake_case = higher confidence
        if (/^[a-z][a-zA-Z0-9]*$/.test(value) || /^[a-z][a-z0-9_]*$/.test(value)) {
          confidence = 0.8;
        }
        break;

      case 'class-name':
        // PascalCase = higher confidence
        if (/^[A-Z][a-zA-Z0-9]*$/.test(value)) confidence = 0.9;
        break;

      case 'error-message':
        // Longer messages = higher confidence
        confidence = Math.min(0.5 + value.length * 0.01, 0.95);
        break;

      case 'package-name':
        // Scoped packages = higher confidence
        if (value.startsWith('@')) confidence = 0.9;
        break;

      default:
        confidence = 0.7;
    }

    return confidence;
  }

  private determineSubIntent(
    intent: IntentType,
    message: string,
    _entities: ExtractedEntity[]
  ): string | undefined {
    const messageLower = message.toLowerCase();

    const subIntentMap: Partial<Record<IntentType, Record<string, string[]>>> = {
      'code-generation': {
        'create-component': ['component', 'react', 'vue', 'svelte'],
        'create-api': ['api', 'endpoint', 'route', 'controller'],
        'create-test': ['test', 'spec'],
        'create-model': ['model', 'schema', 'entity'],
        'create-service': ['service', 'util', 'helper']
      },
      'bug-fix': {
        'type-error': ['type', 'typescript', 'cannot read property'],
        'null-error': ['null', 'undefined', 'is not defined'],
        'async-error': ['promise', 'async', 'await', 'callback'],
        'import-error': ['import', 'module', 'cannot find']
      },
      'refactoring': {
        'extract-function': ['extract', 'pull out', 'separate'],
        'rename': ['rename', 'name', 'called'],
        'simplify': ['simplify', 'clean', 'reduce'],
        'split': ['split', 'break', 'divide']
      },
      'testing': {
        'unit-test': ['unit', 'function', 'method'],
        'integration-test': ['integration', 'api', 'endpoint'],
        'e2e-test': ['e2e', 'end to end', 'browser', 'cypress', 'playwright']
      }
    };

    const subIntents = subIntentMap[intent];
    if (!subIntents) return undefined;

    for (const [subIntent, keywords] of Object.entries(subIntents)) {
      if (keywords.some(k => messageLower.includes(k))) {
        return subIntent;
      }
    }

    return undefined;
  }

  private generateSuggestedActions(
    intent: IntentType,
    entities: ExtractedEntity[]
  ): SuggestedAction[] {
    const actions: SuggestedAction[] = [];
    const tools = INTENT_TOOLS[intent] || ['Read'];

    // File-related actions
    const filePaths = entities.filter(e => e.type === 'file-path');
    if (filePaths.length > 0) {
      actions.push({
        action: `Read file: ${filePaths[0].value}`,
        tool: 'Read',
        priority: 'immediate',
        parameters: { file_path: filePaths[0].value }
      });
    }

    // Search-related actions
    const functionNames = entities.filter(e => e.type === 'function-name');
    if (functionNames.length > 0 && tools.includes('Grep')) {
      actions.push({
        action: `Search for function: ${functionNames[0].value}`,
        tool: 'Grep',
        priority: 'immediate',
        parameters: { pattern: functionNames[0].value }
      });
    }

    // Intent-specific actions
    switch (intent) {
      case 'testing':
        actions.push({
          action: 'Run test suite',
          tool: 'Bash',
          priority: 'follow-up',
          parameters: { command: 'npm test' }
        });
        break;

      case 'deployment':
        actions.push({
          action: 'Check build',
          tool: 'Bash',
          priority: 'immediate',
          parameters: { command: 'npm run build' }
        });
        break;

      case 'security':
        actions.push({
          action: 'Run security audit',
          tool: 'Bash',
          priority: 'immediate',
          parameters: { command: 'npm audit' }
        });
        break;

      case 'performance':
        actions.push({
          action: 'Profile application',
          tool: 'Read',
          priority: 'follow-up'
        });
        break;
    }

    return actions;
  }

  private determineContextRequired(
    intent: IntentType,
    entities: ExtractedEntity[]
  ): string[] {
    const required: string[] = [];

    // File content often needed
    if (['code-modification', 'refactoring', 'bug-fix', 'explanation'].includes(intent)) {
      if (entities.some(e => e.type === 'file-path')) {
        required.push('File content');
      } else {
        required.push('Target file path');
      }
    }

    // Error context for debugging
    if (['bug-fix', 'debugging'].includes(intent)) {
      if (!entities.some(e => e.type === 'error-message')) {
        required.push('Error message or stack trace');
      }
    }

    // Test context
    if (intent === 'testing') {
      required.push('Function/component to test');
      required.push('Expected behavior');
    }

    // Deployment context
    if (intent === 'deployment') {
      required.push('Target environment');
      required.push('Deployment configuration');
    }

    return required;
  }

  private estimateComplexity(
    intent: IntentType,
    message: string,
    entities: ExtractedEntity[]
  ): 'simple' | 'moderate' | 'complex' {
    let score = 0;

    // Intent base complexity
    const complexIntents: IntentType[] = ['refactoring', 'deployment', 'security', 'planning'];
    const simpleIntents: IntentType[] = ['search', 'navigation', 'explanation'];

    if (complexIntents.includes(intent)) score += 2;
    if (simpleIntents.includes(intent)) score -= 1;

    // Message length
    if (message.length > 200) score += 1;
    if (message.length > 500) score += 1;

    // Number of entities
    if (entities.length > 3) score += 1;
    if (entities.length > 6) score += 1;

    // Multiple files involved
    const files = entities.filter(e => e.type === 'file-path');
    if (files.length > 2) score += 2;

    // Keywords that suggest complexity
    const complexKeywords = ['multiple', 'all', 'entire', 'across', 'system', 'architecture'];
    if (complexKeywords.some(k => message.toLowerCase().includes(k))) {
      score += 1;
    }

    if (score <= 0) return 'simple';
    if (score <= 3) return 'moderate';
    return 'complex';
  }

  private updateContext(intent: IntentType, entities: ExtractedEntity[]): void {
    // Update recent intents
    this.context.recentIntents.push(intent);
    if (this.context.recentIntents.length > 10) {
      this.context.recentIntents.shift();
    }

    // Update mentioned files
    const files = entities.filter(e => e.type === 'file-path').map(e => e.value);
    for (const file of files) {
      if (!this.context.mentionedFiles.includes(file)) {
        this.context.mentionedFiles.push(file);
      }
    }

    // Update mentioned functions
    const functions = entities.filter(e => e.type === 'function-name').map(e => e.value);
    for (const func of functions) {
      if (!this.context.mentionedFunctions.includes(func)) {
        this.context.mentionedFunctions.push(func);
      }
    }
  }

  /**
   * Generate instructions for agents
   */
  static generateInstructions(): string {
    return `
## IntentPredictor - User Intent Prediction

Predicts user intent for proactive assistance and smart tool selection.

### Intent Types
- **code-generation**: Creating new code/features
- **code-modification**: Changing existing code
- **bug-fix**: Fixing errors and issues
- **refactoring**: Improving code structure
- **explanation**: Understanding code
- **documentation**: Creating docs
- **testing**: Writing/running tests
- **debugging**: Investigating issues
- **performance**: Optimization
- **security**: Security improvements
- **deployment**: Release operations
- **search/navigation**: Finding code

### Methods
- \`predict(message)\`: Get primary intent prediction
- \`predictMultiple(message, n)\`: Get top N predictions
- \`getProactiveSuggestions()\`: Context-based suggestions
- \`provideFeedback(prediction, actual)\`: Improve predictions
- \`setProjectContext(type, techStack)\`: Set project context

### Entity Types Extracted
- file-path, function-name, class-name
- variable-name, package-name
- error-message, line-number
- technology, code-snippet

### Usage
\`\`\`typescript
const predictor = new IntentPredictor();
const intent = predictor.predict("Fix the bug in auth.ts");
// { intent: 'bug-fix', confidence: 0.9, entities: [...] }
\`\`\`

### Best Practices
- Use context for better predictions
- Provide feedback to improve accuracy
- Check suggested actions for workflow
    `;
  }
}
