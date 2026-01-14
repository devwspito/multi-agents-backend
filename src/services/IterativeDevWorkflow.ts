/**
 * IterativeDevWorkflow
 *
 * Generates instructions for Claude Code-style iterative development.
 * This enforces the pattern: READ → EDIT → VERIFY → FIX → REPEAT
 *
 * Key behaviors:
 * 1. After EVERY edit, run verification (tsc, lint)
 * 2. If verification fails, FIX IMMEDIATELY (don't continue)
 * 3. Only proceed to next file after current file compiles
 * 4. Commit incrementally after each working change
 */

export interface IterativeWorkflowConfig {
  language: 'typescript' | 'javascript' | 'python' | 'go' | 'rust';
  hasTests: boolean;
  hasLint: boolean;
  repoPath: string;
  filesToModify: string[];
  filesToCreate: string[];
}

export class IterativeDevWorkflow {
  /**
   * Generate the iterative workflow instructions for Developer prompt
   */
  static generateWorkflowInstructions(config: IterativeWorkflowConfig): string {
    const verifyCommand = this.getVerifyCommand(config.language);
    const lintCommand = this.getLintCommand(config.language);

    return `
## 🔄 ITERATIVE DEVELOPMENT WORKFLOW (MANDATORY)

You MUST follow this **exact workflow** for EVERY file you modify:

### The Loop: READ → EDIT → VERIFY → FIX

\`\`\`
┌─────────────────────────────────────────────────────────┐
│  1. READ the file completely                            │
│     ↓                                                   │
│  2. EDIT with your changes                              │
│     ↓                                                   │
│  3. VERIFY immediately: ${verifyCommand.padEnd(25)}     │
│     ↓                                                   │
│  ┌─ 4a. If errors → FIX NOW (don't continue!)          │
│  │      Go back to step 2                               │
│  │                                                      │
│  └─ 4b. If clean → Proceed to next file                │
│                                                         │
│  5. After all files done → Run full verification        │
│  6. COMMIT only when everything compiles                │
└─────────────────────────────────────────────────────────┘
\`\`\`

### 🚨 CRITICAL RULES:

1. **NEVER skip verification** - After EVERY Edit(), run:
   \`\`\`bash
   cd ${config.repoPath} && ${verifyCommand}
   \`\`\`

2. **FIX ERRORS IMMEDIATELY** - If verification fails:
   - Read the error message
   - Fix the issue in the SAME file
   - Verify again
   - Do NOT move to another file until current file compiles

3. **INCREMENTAL COMMITS** - After each working change:
   \`\`\`bash
   git add <file> && git commit -m "feat: <what you did>"
   \`\`\`

4. **NO BROKEN COMMITS** - Never commit code that doesn't compile

${config.hasLint ? `5. **RUN LINT** - After TypeScript passes:
   \`\`\`bash
   ${lintCommand}
   \`\`\`
   Fix any lint errors before proceeding.` : ''}

### Example Workflow:

\`\`\`
# Step 1: Read the file
Read("src/services/UserService.ts")

# Step 2: Make your edit
Edit("src/services/UserService.ts", oldCode, newCode)

# Step 3: IMMEDIATELY verify (don't skip this!)
Bash("cd ${config.repoPath} && ${verifyCommand}")

# Step 4a: If error appears:
#   "error TS2322: Type 'string' is not assignable to type 'number'"
#   → FIX IT NOW:
Edit("src/services/UserService.ts", wrongCode, fixedCode)
Bash("cd ${config.repoPath} && ${verifyCommand}")  # Verify again!

# Step 4b: If clean → proceed to next file
# Step 5: Commit the working change
Bash("git add src/services/UserService.ts && git commit -m 'feat: add user validation'")
\`\`\`

### Files to Modify (follow this order):
${config.filesToModify.map((f, i) => `${i + 1}. ${f}`).join('\n')}

### Files to Create:
${config.filesToCreate.map((f, i) => `${i + 1}. ${f}`).join('\n')}

**Remember**: Quality over speed. A working change is better than multiple broken changes.
`;
  }

  /**
   * Generate inline error recovery instructions
   */
  static generateErrorRecoveryInstructions(config: IterativeWorkflowConfig): string {
    return `
## 🔧 INLINE ERROR RECOVERY

When you see a compilation error, follow this pattern:

### Common TypeScript Errors and Fixes:

| Error | Likely Cause | Fix |
|-------|--------------|-----|
| \`Cannot find module 'X'\` | Missing import | Add \`import { X } from './path'\` |
| \`Property 'X' does not exist\` | Wrong type or typo | Check interface definition |
| \`Type 'X' is not assignable\` | Type mismatch | Cast or fix the type |
| \`'X' is declared but never used\` | Unused variable | Remove or prefix with \`_\` |
| \`Object is possibly 'undefined'\` | Null check needed | Add \`if (x) {}\` or \`x?.prop\` |

### Error Recovery Workflow:

1. **READ the error message completely**
   \`\`\`
   src/services/UserService.ts:42:15 - error TS2339:
   Property 'email' does not exist on type 'User'.
   \`\`\`

2. **IDENTIFY the file and line**: \`UserService.ts:42\`

3. **READ that specific section**:
   \`\`\`
   Read("src/services/UserService.ts", offset=40, limit=10)
   \`\`\`

4. **UNDERSTAND the context** - Why is this error happening?
   - Is the property missing from the interface?
   - Is there a typo?
   - Is the import wrong?

5. **FIX with surgical precision**:
   \`\`\`
   Edit("src/services/UserService.ts", "user.email", "user.emailAddress")
   \`\`\`

6. **VERIFY the fix**:
   \`\`\`bash
   cd ${config.repoPath} && ${this.getVerifyCommand(config.language)}
   \`\`\`

### 🚨 DO NOT:
- Ignore errors and continue
- Comment out broken code
- Add \`// @ts-ignore\`
- Remove type annotations to "fix" errors
- Create new files to work around the issue

### ✅ DO:
- Fix errors at the source
- Understand WHY the error occurred
- Verify your fix works
- Commit only working code
`;
  }

  /**
   * Generate confidence checkpoint instructions
   */
  static generateConfidenceCheckpoints(): string {
    return `
## 🤔 CONFIDENCE CHECKPOINTS

Before making changes, ask yourself these questions. If you answer "NO" to any, STOP and gather more information.

### Before Editing a File:
- [ ] Have I READ this file completely?
- [ ] Do I understand what this file does?
- [ ] Do I know what imports/dependencies it has?
- [ ] Do I understand the existing patterns?

### Before Creating a New File:
- [ ] Does a similar file already exist?
- [ ] Am I following the project's file structure pattern?
- [ ] Do I know what to import?
- [ ] Will this integrate with existing code?

### Before Committing:
- [ ] Does the code compile? (\`tsc --noEmit\`)
- [ ] Does lint pass? (\`eslint\`)
- [ ] Did I use the correct helper functions?
- [ ] Did I follow the architecture patterns?

### If Uncertain:
1. **EXPLORE first** - Read related files to understand patterns
2. **CHECK existing code** - Look for similar implementations
3. **VERIFY assumptions** - Run a quick test
4. **ASK if stuck** - Don't guess on critical decisions

**Remember**: It's better to spend 30 seconds understanding than 5 minutes fixing a wrong assumption.
`;
  }

  /**
   * Get verification command for language
   */
  private static getVerifyCommand(language: string): string {
    switch (language) {
      case 'typescript':
        return 'npx tsc --noEmit 2>&1 | head -20';
      case 'javascript':
        return 'npx eslint . --ext .js,.jsx 2>&1 | head -20';
      case 'python':
        return 'python -m py_compile *.py 2>&1 | head -20';
      case 'go':
        return 'go build ./... 2>&1 | head -20';
      case 'rust':
        return 'cargo check 2>&1 | head -20';
      default:
        return 'npm run build 2>&1 | head -20';
    }
  }

  /**
   * Get lint command for language
   */
  private static getLintCommand(language: string): string {
    switch (language) {
      case 'typescript':
        return 'npx eslint . --ext .ts,.tsx --max-warnings 0 2>&1 | head -30';
      case 'javascript':
        return 'npx eslint . --ext .js,.jsx --max-warnings 0 2>&1 | head -30';
      case 'python':
        return 'flake8 . 2>&1 | head -30';
      case 'go':
        return 'golint ./... 2>&1 | head -30';
      case 'rust':
        return 'cargo clippy 2>&1 | head -30';
      default:
        return 'npm run lint 2>&1 | head -30';
    }
  }

  /**
   * Detect language from workspace
   */
  static detectLanguage(workspacePath: string): 'typescript' | 'javascript' | 'python' | 'go' | 'rust' {
    const fs = require('fs');
    const path = require('path');

    if (fs.existsSync(path.join(workspacePath, 'tsconfig.json'))) {
      return 'typescript';
    }
    if (fs.existsSync(path.join(workspacePath, 'go.mod'))) {
      return 'go';
    }
    if (fs.existsSync(path.join(workspacePath, 'Cargo.toml'))) {
      return 'rust';
    }
    if (fs.existsSync(path.join(workspacePath, 'requirements.txt')) ||
        fs.existsSync(path.join(workspacePath, 'setup.py'))) {
      return 'python';
    }
    if (fs.existsSync(path.join(workspacePath, 'package.json'))) {
      return 'javascript';
    }

    return 'javascript'; // Default
  }

  /**
   * Check if project has lint config
   */
  static hasLintConfig(workspacePath: string): boolean {
    const fs = require('fs');
    const path = require('path');

    const lintConfigs = [
      '.eslintrc',
      '.eslintrc.js',
      '.eslintrc.json',
      '.eslintrc.yaml',
      'eslint.config.js',
      '.flake8',
      'setup.cfg',
    ];

    return lintConfigs.some(config =>
      fs.existsSync(path.join(workspacePath, config))
    );
  }

  /**
   * Check if project has tests
   */
  static hasTests(workspacePath: string): boolean {
    const fs = require('fs');
    const path = require('path');

    const testIndicators = [
      'jest.config.js',
      'jest.config.ts',
      'vitest.config.ts',
      'pytest.ini',
      'conftest.py',
      '__tests__',
      'tests',
      'test',
    ];

    return testIndicators.some(indicator =>
      fs.existsSync(path.join(workspacePath, indicator))
    );
  }
}
