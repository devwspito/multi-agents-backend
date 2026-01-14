/**
 * InlineErrorRecovery
 *
 * Generates instructions for immediate error recovery during development.
 * This teaches agents to fix compilation errors inline without waiting
 * for the Judge-Fixer cycle.
 *
 * Key behaviors:
 * 1. Recognize common error patterns
 * 2. Apply fixes immediately
 * 3. Verify fixes work before continuing
 */

export interface ErrorPattern {
  regex: RegExp;
  description: string;
  likelyFix: string;
  example: string;
}

export class InlineErrorRecovery {
  /**
   * Common TypeScript/JavaScript error patterns and their fixes
   */
  static readonly ERROR_PATTERNS: ErrorPattern[] = [
    {
      regex: /Cannot find module ['"]([^'"]+)['"]/,
      description: 'Missing import or module not installed',
      likelyFix: 'Add the import or install the package',
      example: `
// Error: Cannot find module './UserService'
// Fix: Add the import
import { UserService } from './UserService';
// Or if package: npm install <package-name>`
    },
    {
      regex: /Property ['"]([^'"]+)['"] does not exist on type/,
      description: 'Property not defined on type',
      likelyFix: 'Check interface definition or use optional chaining',
      example: `
// Error: Property 'email' does not exist on type 'User'
// Fix options:
// 1. Add to interface: interface User { email: string; }
// 2. Use optional: user?.email
// 3. Type assertion: (user as UserWithEmail).email`
    },
    {
      regex: /Type ['"]([^'"]+)['"] is not assignable to type ['"]([^'"]+)['"]/,
      description: 'Type mismatch',
      likelyFix: 'Cast the type or fix the source',
      example: `
// Error: Type 'string' is not assignable to type 'number'
// Fix: Convert the type
const count: number = parseInt(value, 10);
// Or fix the declaration: let value: string = "10";`
    },
    {
      regex: /['"]([^'"]+)['"] is declared but (its value is )?never (used|read)/,
      description: 'Unused variable',
      likelyFix: 'Remove the variable or prefix with underscore',
      example: `
// Error: 'result' is declared but never used
// Fix: Either use it or prefix with _
const _result = someFunction(); // If intentionally unused
// Or remove: const result = ... (if not needed)`
    },
    {
      regex: /Object is possibly ['"]undefined['"]/,
      description: 'Potential null/undefined access',
      likelyFix: 'Add null check or optional chaining',
      example: `
// Error: Object is possibly 'undefined'
// Fix options:
// 1. Optional chaining: user?.profile?.name
// 2. Guard clause: if (!user) return;
// 3. Non-null assertion (if certain): user!.profile`
    },
    {
      regex: /Cannot find name ['"]([^'"]+)['"]/,
      description: 'Undeclared variable or missing import',
      likelyFix: 'Declare the variable or add import',
      example: `
// Error: Cannot find name 'Router'
// Fix: Add the import
import { Router } from 'express';`
    },
    {
      regex: /Argument of type ['"]([^'"]+)['"] is not assignable to parameter/,
      description: 'Wrong argument type',
      likelyFix: 'Cast the argument or fix the function signature',
      example: `
// Error: Argument of type 'string' is not assignable to parameter of type 'number'
// Fix: Convert or cast
someFunction(Number(stringValue));`
    },
    {
      regex: /Expected (\d+) arguments?, but got (\d+)/,
      description: 'Wrong number of arguments',
      likelyFix: 'Add missing arguments or make them optional',
      example: `
// Error: Expected 2 arguments, but got 1
// Fix: Add the missing argument
createUser(name, email); // Was: createUser(name)`
    },
    {
      regex: /Duplicate identifier ['"]([^'"]+)['"]/,
      description: 'Variable declared twice',
      likelyFix: 'Rename one or remove duplicate',
      example: `
// Error: Duplicate identifier 'user'
// Fix: Rename one
const user = getUser();
const newUser = createUser(); // Was also 'user'`
    },
    {
      regex: /Module ['"]([^'"]+)['"] has no exported member ['"]([^'"]+)['"]/,
      description: 'Wrong export name',
      likelyFix: 'Check the correct export name',
      example: `
// Error: Module './utils' has no exported member 'helper'
// Fix: Use the correct name
import { helperFunction } from './utils'; // Check actual export name`
    },
  ];

  /**
   * Generate inline error recovery instructions for Developer prompt
   */
  static generateInstructions(): string {
    return `
## 🔧 INLINE ERROR RECOVERY (Fix Errors Immediately)

When you see a TypeScript error, DON'T wait for the Fixer. Fix it NOW using this guide:

### Common Errors and Fixes:

${this.ERROR_PATTERNS.map((p, i) => `
#### ${i + 1}. ${p.description}
- **Pattern**: \`${p.regex.source.substring(0, 50)}...\`
- **Fix**: ${p.likelyFix}
\`\`\`typescript
${p.example.trim()}
\`\`\`
`).join('\n')}

### Error Recovery Workflow:

\`\`\`
When you see an error like:
  src/services/UserService.ts:42:15 - error TS2339:
  Property 'email' does not exist on type 'User'.

Do this:
1. IDENTIFY: File=UserService.ts, Line=42, Issue=missing property
2. READ: Read the file around line 42
3. UNDERSTAND: Why is 'email' not on User type?
   - Is User interface missing it?
   - Is it a typo (should be 'emailAddress')?
   - Is it on a different type?
4. FIX: Make the minimal change to fix
5. VERIFY: Run tsc --noEmit again
6. REPEAT: If more errors, fix them too
\`\`\`

### 🚨 DO NOT:
- Ignore the error and continue
- Add \`// @ts-ignore\` or \`// @ts-expect-error\`
- Comment out the problematic code
- Remove type annotations
- Create workarounds (new functions, type assertions everywhere)

### ✅ DO:
- Fix the root cause
- Understand WHY the error occurred
- Learn from the error to avoid it in future files
- Verify the fix compiles before continuing
`;
  }

  /**
   * Analyze an error message and suggest a fix
   */
  static analyzeError(errorMessage: string): {
    pattern: ErrorPattern | null;
    suggestion: string;
    confidence: 'high' | 'medium' | 'low';
  } {
    for (const pattern of this.ERROR_PATTERNS) {
      if (pattern.regex.test(errorMessage)) {
        return {
          pattern,
          suggestion: pattern.likelyFix,
          confidence: 'high',
        };
      }
    }

    // Generic suggestions for unknown errors
    if (errorMessage.includes('error TS')) {
      return {
        pattern: null,
        suggestion: 'Read the error message carefully, check the file and line number, and fix the type issue',
        confidence: 'low',
      };
    }

    return {
      pattern: null,
      suggestion: 'Unknown error type - read the full message and investigate',
      confidence: 'low',
    };
  }

  /**
   * Format error analysis for prompt injection
   */
  static formatErrorAnalysis(errors: string[]): string {
    if (errors.length === 0) return '';

    let output = `
## 🔴 COMPILATION ERRORS DETECTED - FIX THESE FIRST!

`;

    for (const error of errors.slice(0, 10)) {
      const analysis = this.analyzeError(error);
      output += `
### Error: \`${error.substring(0, 100)}...\`
- **Suggested Fix**: ${analysis.suggestion}
- **Confidence**: ${analysis.confidence}
`;
    }

    if (errors.length > 10) {
      output += `\n... and ${errors.length - 10} more errors. Fix the above first.\n`;
    }

    return output;
  }
}
