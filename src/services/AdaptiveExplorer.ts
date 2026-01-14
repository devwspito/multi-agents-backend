/**
 * AdaptiveExplorer
 *
 * Generates instructions for dynamic codebase exploration.
 * This teaches agents to explore when they encounter unexpected code
 * rather than making assumptions.
 *
 * Key behaviors:
 * 1. Recognize when exploration is needed
 * 2. Use efficient exploration strategies
 * 3. Learn from discoveries and adapt
 */

export interface ExplorationTrigger {
  condition: string;
  action: string;
  example: string;
}

export class AdaptiveExplorer {
  /**
   * Triggers that should prompt exploration
   */
  static readonly EXPLORATION_TRIGGERS: ExplorationTrigger[] = [
    {
      condition: 'Import path unclear',
      action: 'Search for the file/module with Glob',
      example: `
// Need to import UserService but don't know the path?
Glob("**/UserService.ts")
// Or search for exports:
Grep("export.*UserService", path="src")`
    },
    {
      condition: 'Unknown function signature',
      action: 'Read the function definition',
      example: `
// Need to call createProject() but don't know the params?
Grep("function createProject|createProject.*=", path="src")
// Then read the file to see the signature`
    },
    {
      condition: 'Missing type definition',
      action: 'Search for the interface/type',
      example: `
// Need the User interface?
Grep("interface User|type User", path="src")`
    },
    {
      condition: 'Unknown project structure',
      action: 'List directories to understand organization',
      example: `
// Unsure where to put a new service?
Bash("ls -la src/")
Bash("ls -la src/services/")`
    },
    {
      condition: 'Similar implementation exists',
      action: 'Find and study similar code',
      example: `
// Creating a new API endpoint? Find existing ones:
Grep("app.get|app.post|router.get", path="src/routes")
// Then read one to understand the pattern`
    },
    {
      condition: 'Test pattern unclear',
      action: 'Find existing test files',
      example: `
// Need to write tests? Find similar tests:
Glob("**/*.test.ts")
// Then read one to understand the test structure`
    },
  ];

  /**
   * Generate adaptive exploration instructions for Developer prompt
   */
  static generateInstructions(): string {
    return `
## 🔍 ADAPTIVE EXPLORATION (When Unsure, Explore First)

**Before assuming, VERIFY by exploring the codebase.**

### When to Explore:

${this.EXPLORATION_TRIGGERS.map((t, i) => `
#### ${i + 1}. ${t.condition}
→ **Action**: ${t.action}
\`\`\`
${t.example.trim()}
\`\`\`
`).join('\n')}

### Exploration Decision Tree:

\`\`\`
                    ┌─────────────────────┐
                    │  Need to do X?      │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Do I know HOW?     │
                    └──────────┬──────────┘
                               │
              ┌────────────────┴────────────────┐
              │                                 │
        ┌─────▼─────┐                    ┌─────▼─────┐
        │    YES    │                    │    NO     │
        └─────┬─────┘                    └─────┬─────┘
              │                                │
        ┌─────▼─────┐                    ┌─────▼─────┐
        │  Do it!   │                    │ EXPLORE   │
        └───────────┘                    │  FIRST    │
                                         └─────┬─────┘
                                               │
                                   ┌───────────▼───────────┐
                                   │ 1. Grep for similar   │
                                   │ 2. Read examples      │
                                   │ 3. Understand pattern │
                                   │ 4. Then implement     │
                                   └───────────────────────┘
\`\`\`

### Smart Search Strategies:

| Need | Tool | Pattern |
|------|------|---------|
| Find a file | Glob | \`**/FileName.ts\` |
| Find a function | Grep | \`function funcName\\|funcName.*=\` |
| Find a class | Grep | \`class ClassName\` |
| Find usage | Grep | \`funcName(\` |
| Find imports | Grep | \`import.*from.*module\` |
| Find tests | Glob | \`**/*.test.ts\` |
| Find types | Grep | \`interface TypeName\\|type TypeName\` |

### 🚨 DON'T:
- Guess import paths
- Assume function signatures
- Create duplicate utilities
- Ignore existing patterns

### ✅ DO:
- Search before creating
- Read before editing
- Understand before implementing
- Follow existing patterns
`;
  }

  /**
   * Generate exploration prompts based on what the agent needs
   */
  static getExplorationPrompts(needs: string[]): string {
    let prompts = '';

    for (const need of needs) {
      const lowerNeed = need.toLowerCase();

      if (lowerNeed.includes('import') || lowerNeed.includes('module')) {
        prompts += `
To find the correct import:
\`\`\`
Glob("**/${need}.ts")
Grep("export.*${need}", path="src")
\`\`\`
`;
      }

      if (lowerNeed.includes('function') || lowerNeed.includes('method')) {
        prompts += `
To find the function signature:
\`\`\`
Grep("function ${need}|${need}.*=.*=>|${need}\\(", path="src")
\`\`\`
`;
      }

      if (lowerNeed.includes('type') || lowerNeed.includes('interface')) {
        prompts += `
To find the type definition:
\`\`\`
Grep("interface ${need}|type ${need}", path="src")
\`\`\`
`;
      }

      if (lowerNeed.includes('test') || lowerNeed.includes('spec')) {
        prompts += `
To find test examples:
\`\`\`
Glob("**/*.test.ts")
Grep("describe\\|it\\|test", path="__tests__")
\`\`\`
`;
      }
    }

    return prompts;
  }

  /**
   * Check if a task requires exploration first
   */
  static shouldExploreFirst(taskDescription: string): boolean {
    const explorationKeywords = [
      'new service',
      'new feature',
      'integrate with',
      'similar to',
      'like existing',
      'follow the pattern',
      'based on',
      'refactor',
      'modify existing',
    ];

    return explorationKeywords.some(keyword =>
      taskDescription.toLowerCase().includes(keyword)
    );
  }

  /**
   * Generate pre-task exploration checklist
   */
  static generatePreTaskChecklist(filesToModify: string[], filesToCreate: string[]): string {
    let checklist = `
## 📋 PRE-TASK EXPLORATION CHECKLIST

Before writing any code, verify you understand the codebase:

`;

    if (filesToModify.length > 0) {
      checklist += `### Files to Modify (Read these FIRST):
${filesToModify.map(f => `- [ ] Read \`${f}\` completely`).join('\n')}

`;
    }

    if (filesToCreate.length > 0) {
      checklist += `### Files to Create (Find similar examples FIRST):
${filesToCreate.map(f => {
        const ext = f.split('.').pop();
        const name = f.split('/').pop();
        return `- [ ] Find similar \`*.${ext}\` files for pattern
- [ ] Understand where \`${name}\` should be imported`;
      }).join('\n')}

`;
    }

    checklist += `### General Exploration:
- [ ] Understand project structure: \`ls -la src/\`
- [ ] Find related tests: \`Glob("**/*.test.ts")\`
- [ ] Check for helper functions: \`Grep("export.*function create")\`

**Only start coding after completing this checklist!**
`;

    return checklist;
  }
}
