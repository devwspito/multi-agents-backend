/**
 * ConversationMemory
 *
 * Persistent memory across conversation sessions.
 * Stores architectural decisions, preferences, and context.
 *
 * Key behaviors:
 * 1. Persist decisions across sessions
 * 2. Track user preferences
 * 3. Remember project-specific context
 * 4. Avoid re-discussing decided topics
 */

import * as fs from 'fs';
import * as path from 'path';

export interface Decision {
  id: string;
  timestamp: number;
  category: 'architecture' | 'technology' | 'pattern' | 'preference' | 'convention';
  topic: string;
  decision: string;
  reasoning?: string;
  alternatives?: string[];
  confidence: 'definite' | 'preferred' | 'tentative';
  tags: string[];
}

export interface ProjectContext {
  projectId: string;
  name: string;
  description?: string;
  techStack: string[];
  conventions: string[];
  lastUpdated: number;
}

export interface UserPreference {
  key: string;
  value: string;
  category: 'style' | 'workflow' | 'communication' | 'technical';
  timestamp: number;
}

export interface ConversationState {
  sessionId: string;
  startTime: number;
  topicsDiscussed: string[];
  decisionsReferenced: string[];
  filesAccessed: string[];
}

export interface MemoryStore {
  decisions: Decision[];
  projectContext: ProjectContext | null;
  preferences: UserPreference[];
  conversations: ConversationState[];
  version: string;
}

export class ConversationMemory {
  private static memoryPath: string | null = null;
  private static store: MemoryStore = {
    decisions: [],
    projectContext: null,
    preferences: [],
    conversations: [],
    version: '1.0.0',
  };
  private static currentSession: ConversationState | null = null;

  /**
   * Initialize memory from disk
   */
  static async initialize(workspacePath: string): Promise<void> {
    this.memoryPath = path.join(workspacePath, '.conversation-memory.json');

    if (fs.existsSync(this.memoryPath)) {
      try {
        this.store = JSON.parse(fs.readFileSync(this.memoryPath, 'utf8'));
        console.log(`📚 [ConversationMemory] Loaded ${this.store.decisions.length} decisions`);
      } catch {
        console.log(`📚 [ConversationMemory] Starting fresh`);
        this.store = {
          decisions: [],
          projectContext: null,
          preferences: [],
          conversations: [],
          version: '1.0.0',
        };
      }
    }

    // Start new session
    this.currentSession = {
      sessionId: `session-${Date.now()}`,
      startTime: Date.now(),
      topicsDiscussed: [],
      decisionsReferenced: [],
      filesAccessed: [],
    };
  }

  /**
   * Save memory to disk
   */
  private static save(): void {
    if (this.memoryPath) {
      try {
        // Add current session to history
        if (this.currentSession) {
          this.store.conversations.push(this.currentSession);
          // Keep only last 20 sessions
          if (this.store.conversations.length > 20) {
            this.store.conversations = this.store.conversations.slice(-20);
          }
        }

        fs.writeFileSync(this.memoryPath, JSON.stringify(this.store, null, 2));
      } catch {
        // Ignore write errors
      }
    }
  }

  /**
   * Record a decision
   */
  static recordDecision(
    topic: string,
    decision: string,
    category: Decision['category'],
    options?: {
      reasoning?: string;
      alternatives?: string[];
      confidence?: Decision['confidence'];
      tags?: string[];
    }
  ): Decision {
    const newDecision: Decision = {
      id: `decision-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      category,
      topic,
      decision,
      reasoning: options?.reasoning,
      alternatives: options?.alternatives,
      confidence: options?.confidence || 'preferred',
      tags: options?.tags || [],
    };

    // Check if we already have a decision on this topic
    const existingIndex = this.store.decisions.findIndex(
      d => d.topic.toLowerCase() === topic.toLowerCase() && d.category === category
    );

    if (existingIndex >= 0) {
      // Update existing decision
      this.store.decisions[existingIndex] = newDecision;
    } else {
      this.store.decisions.push(newDecision);
    }

    // Keep only last 100 decisions
    if (this.store.decisions.length > 100) {
      this.store.decisions = this.store.decisions.slice(-100);
    }

    this.save();
    return newDecision;
  }

  /**
   * Get decision on a topic
   */
  static getDecision(topic: string, category?: Decision['category']): Decision | null {
    const topicLower = topic.toLowerCase();

    const decisions = this.store.decisions.filter(d => {
      const matches = d.topic.toLowerCase().includes(topicLower) ||
                     d.tags.some(t => t.toLowerCase().includes(topicLower));
      return matches && (!category || d.category === category);
    });

    // Return most recent
    if (decisions.length > 0) {
      // Track that we referenced this decision
      if (this.currentSession) {
        this.currentSession.decisionsReferenced.push(decisions[0].id);
      }
      return decisions.sort((a, b) => b.timestamp - a.timestamp)[0];
    }

    return null;
  }

  /**
   * Get all decisions in a category
   */
  static getDecisionsByCategory(category: Decision['category']): Decision[] {
    return this.store.decisions
      .filter(d => d.category === category)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Set user preference
   */
  static setPreference(key: string, value: string, category: UserPreference['category']): void {
    const existingIndex = this.store.preferences.findIndex(p => p.key === key);

    const preference: UserPreference = {
      key,
      value,
      category,
      timestamp: Date.now(),
    };

    if (existingIndex >= 0) {
      this.store.preferences[existingIndex] = preference;
    } else {
      this.store.preferences.push(preference);
    }

    this.save();
  }

  /**
   * Get user preference
   */
  static getPreference(key: string): string | null {
    const pref = this.store.preferences.find(p => p.key === key);
    return pref?.value || null;
  }

  /**
   * Update project context
   */
  static updateProjectContext(context: Partial<ProjectContext>): void {
    if (!this.store.projectContext) {
      this.store.projectContext = {
        projectId: context.projectId || 'default',
        name: context.name || 'Unknown',
        techStack: context.techStack || [],
        conventions: context.conventions || [],
        lastUpdated: Date.now(),
      };
    } else {
      this.store.projectContext = {
        ...this.store.projectContext,
        ...context,
        lastUpdated: Date.now(),
      };
    }

    this.save();
  }

  /**
   * Get project context
   */
  static getProjectContext(): ProjectContext | null {
    return this.store.projectContext;
  }

  /**
   * Record that a topic was discussed
   */
  static recordTopicDiscussed(topic: string): void {
    if (this.currentSession && !this.currentSession.topicsDiscussed.includes(topic)) {
      this.currentSession.topicsDiscussed.push(topic);
    }
  }

  /**
   * Record file access
   */
  static recordFileAccess(file: string): void {
    if (this.currentSession && !this.currentSession.filesAccessed.includes(file)) {
      this.currentSession.filesAccessed.push(file);
    }
  }

  /**
   * Check if topic was already discussed this session
   */
  static wasTopicDiscussed(topic: string): boolean {
    return this.currentSession?.topicsDiscussed.includes(topic) || false;
  }

  /**
   * Get relevant context for current task
   */
  static getRelevantContext(keywords: string[]): {
    decisions: Decision[];
    preferences: UserPreference[];
    recentTopics: string[];
  } {
    const keywordsLower = keywords.map(k => k.toLowerCase());

    const relevantDecisions = this.store.decisions.filter(d =>
      keywordsLower.some(k =>
        d.topic.toLowerCase().includes(k) ||
        d.decision.toLowerCase().includes(k) ||
        d.tags.some(t => t.toLowerCase().includes(k))
      )
    );

    const relevantPrefs = this.store.preferences.filter(p =>
      keywordsLower.some(k =>
        p.key.toLowerCase().includes(k) ||
        p.value.toLowerCase().includes(k)
      )
    );

    // Get topics from recent sessions
    const recentSessions = this.store.conversations.slice(-5);
    const recentTopics = [...new Set(recentSessions.flatMap(s => s.topicsDiscussed))];

    return {
      decisions: relevantDecisions,
      preferences: relevantPrefs,
      recentTopics,
    };
  }

  /**
   * Format memory for prompt injection
   */
  static formatForPrompt(): string {
    if (this.store.decisions.length === 0 && !this.store.projectContext) {
      return '';
    }

    let output = `
## 📚 CONVERSATION MEMORY (Previous Decisions)

`;

    // Project context
    if (this.store.projectContext) {
      output += `### Project: ${this.store.projectContext.name}
- **Tech Stack**: ${this.store.projectContext.techStack.join(', ') || 'Not specified'}
- **Conventions**: ${this.store.projectContext.conventions.slice(0, 3).join(', ') || 'Not specified'}

`;
    }

    // Architecture decisions
    const archDecisions = this.getDecisionsByCategory('architecture').slice(0, 3);
    if (archDecisions.length > 0) {
      output += `### 🏗️ Architecture Decisions:
${archDecisions.map(d => `- **${d.topic}**: ${d.decision}${d.confidence === 'definite' ? ' ✓' : ''}`).join('\n')}

`;
    }

    // Technology decisions
    const techDecisions = this.getDecisionsByCategory('technology').slice(0, 3);
    if (techDecisions.length > 0) {
      output += `### 🔧 Technology Choices:
${techDecisions.map(d => `- **${d.topic}**: ${d.decision}`).join('\n')}

`;
    }

    // Pattern preferences
    const patternDecisions = this.getDecisionsByCategory('pattern').slice(0, 3);
    if (patternDecisions.length > 0) {
      output += `### 📐 Patterns to Follow:
${patternDecisions.map(d => `- **${d.topic}**: ${d.decision}`).join('\n')}

`;
    }

    output += `
**⚠️ Follow these decisions - they were made for good reasons!**
`;

    return output;
  }

  /**
   * Generate summary of all stored knowledge
   */
  static generateSummary(): string {
    return `
📚 Memory Summary:
- Decisions stored: ${this.store.decisions.length}
- Preferences: ${this.store.preferences.length}
- Past sessions: ${this.store.conversations.length}
- Project: ${this.store.projectContext?.name || 'Not set'}
`;
  }

  /**
   * Generate instructions for agents
   */
  static generateInstructions(): string {
    return `
## 📚 CONVERSATION MEMORY

This system remembers decisions across sessions.

### What Gets Remembered:

1. **Architecture Decisions**
   - "We use JWT, not sessions"
   - "API follows REST, not GraphQL"

2. **Technology Choices**
   - "Database: MongoDB"
   - "Testing: Jest"

3. **Conventions**
   - "Services use factory functions"
   - "Components are functional"

### How to Use Memory:

1. **Check before proposing changes**
   - Don't suggest JWT if we decided on sessions
   - Don't propose new patterns if existing ones work

2. **Reference past decisions**
   - "As we decided earlier, using..."
   - "Following our convention of..."

3. **Record new decisions**
   - When making architectural choices
   - When establishing conventions

### 🚨 Important:

- **Don't contradict past decisions** without good reason
- **Don't re-discuss** settled topics
- **Build on** what was decided, don't start over
`;
  }

  /**
   * End current session
   */
  static endSession(): void {
    if (this.currentSession) {
      this.save();
      this.currentSession = null;
    }
  }
}
