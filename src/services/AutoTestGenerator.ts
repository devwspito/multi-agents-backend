/**
 * AutoTestGenerator
 *
 * Automatically generates test specifications and test stubs for new code.
 * This ensures that Developers always create tests alongside their implementations.
 *
 * Key behaviors:
 * 1. Analyze function signatures to generate test cases
 * 2. Detect edge cases and error conditions
 * 3. Generate test file structure matching project patterns
 * 4. Integrate with existing test framework (Jest, Vitest, etc.)
 */

import * as fs from 'fs';
import * as path from 'path';

export interface TestCase {
  name: string;
  description: string;
  type: 'unit' | 'integration' | 'edge-case' | 'error-handling';
  input?: string;
  expectedOutput?: string;
  setup?: string;
}

export interface TestSpecification {
  targetFile: string;
  testFile: string;
  framework: 'jest' | 'vitest' | 'mocha' | 'unknown';
  imports: string[];
  testCases: TestCase[];
  setupCode?: string;
  teardownCode?: string;
}

export interface FunctionSignature {
  name: string;
  params: { name: string; type: string; optional: boolean }[];
  returnType: string;
  isAsync: boolean;
  isExported: boolean;
  className?: string;
  isStatic?: boolean;
}

export interface GeneratedTest {
  filePath: string;
  content: string;
  testCount: number;
  coverageEstimate: number;
}

export class AutoTestGenerator {
  /**
   * Generate test specifications for a source file
   */
  static async generateTestSpec(
    sourceFilePath: string,
    workspacePath: string
  ): Promise<TestSpecification> {
    const content = fs.readFileSync(sourceFilePath, 'utf8');
    const functions = this.extractFunctions(content);
    const framework = this.detectTestFramework(workspacePath);
    const testFile = this.getTestFilePath(sourceFilePath, workspacePath);

    const testCases: TestCase[] = [];

    for (const func of functions) {
      testCases.push(...this.generateTestCasesForFunction(func));
    }

    return {
      targetFile: sourceFilePath,
      testFile,
      framework,
      imports: this.generateImports(sourceFilePath, functions, framework),
      testCases,
      setupCode: this.generateSetupCode(functions),
      teardownCode: this.generateTeardownCode(functions),
    };
  }

  /**
   * Generate actual test file content
   */
  static generateTestFile(spec: TestSpecification): GeneratedTest {
    let content = '';

    // Imports
    content += spec.imports.join('\n') + '\n\n';

    // Describe block
    const fileName = path.basename(spec.targetFile, path.extname(spec.targetFile));
    content += `describe('${fileName}', () => {\n`;

    // Setup
    if (spec.setupCode) {
      content += `  beforeEach(() => {\n`;
      content += `    ${spec.setupCode}\n`;
      content += `  });\n\n`;
    }

    // Teardown
    if (spec.teardownCode) {
      content += `  afterEach(() => {\n`;
      content += `    ${spec.teardownCode}\n`;
      content += `  });\n\n`;
    }

    // Test cases
    for (const testCase of spec.testCases) {
      content += this.generateTestBlock(testCase, spec.framework);
    }

    content += '});\n';

    return {
      filePath: spec.testFile,
      content,
      testCount: spec.testCases.length,
      coverageEstimate: this.estimateCoverage(spec.testCases),
    };
  }

  /**
   * Extract function signatures from source code
   */
  private static extractFunctions(content: string): FunctionSignature[] {
    const functions: FunctionSignature[] = [];

    // Match function declarations
    const functionRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*([^{]+))?/g;
    let match;

    while ((match = functionRegex.exec(content)) !== null) {
      functions.push({
        name: match[1],
        params: this.parseParams(match[2]),
        returnType: match[3]?.trim() || 'void',
        isAsync: content.substring(match.index - 10, match.index).includes('async'),
        isExported: content.substring(match.index - 10, match.index).includes('export'),
      });
    }

    // Match arrow functions
    const arrowRegex = /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*([^=]+))?\s*=>/g;

    while ((match = arrowRegex.exec(content)) !== null) {
      functions.push({
        name: match[1],
        params: this.parseParams(match[2]),
        returnType: match[3]?.trim() || 'void',
        isAsync: content.substring(match.index, match.index + 100).includes('async'),
        isExported: content.substring(match.index - 10, match.index).includes('export'),
      });
    }

    // Match class methods
    const classRegex = /class\s+(\w+)/g;
    while ((match = classRegex.exec(content)) !== null) {
      const className = match[1];
      const classStart = match.index;
      const classEnd = this.findMatchingBrace(content, classStart);
      const classContent = content.substring(classStart, classEnd);

      const methodRegex = /(?:static\s+)?(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*([^{]+))?/g;
      let methodMatch;

      while ((methodMatch = methodRegex.exec(classContent)) !== null) {
        if (methodMatch[1] !== 'constructor' && methodMatch[1] !== 'class') {
          functions.push({
            name: methodMatch[1],
            params: this.parseParams(methodMatch[2]),
            returnType: methodMatch[3]?.trim() || 'void',
            isAsync: classContent.substring(methodMatch.index - 10, methodMatch.index).includes('async'),
            isExported: true,
            className,
            isStatic: classContent.substring(methodMatch.index - 10, methodMatch.index).includes('static'),
          });
        }
      }
    }

    return functions;
  }

  /**
   * Parse function parameters
   */
  private static parseParams(paramsString: string): FunctionSignature['params'] {
    if (!paramsString.trim()) return [];

    const params: FunctionSignature['params'] = [];
    const parts = paramsString.split(',');

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      const optional = trimmed.includes('?');
      const match = trimmed.match(/(\w+)\??\s*(?::\s*(.+))?/);

      if (match) {
        params.push({
          name: match[1],
          type: match[2]?.trim() || 'any',
          optional,
        });
      }
    }

    return params;
  }

  /**
   * Find matching closing brace
   */
  private static findMatchingBrace(content: string, start: number): number {
    let depth = 0;
    let inString = false;
    let stringChar = '';

    for (let i = start; i < content.length; i++) {
      const char = content[i];

      if (inString) {
        if (char === stringChar && content[i - 1] !== '\\') {
          inString = false;
        }
        continue;
      }

      if (char === '"' || char === "'" || char === '`') {
        inString = true;
        stringChar = char;
        continue;
      }

      if (char === '{') depth++;
      if (char === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }

    return content.length;
  }

  /**
   * Generate test cases for a function
   */
  private static generateTestCasesForFunction(func: FunctionSignature): TestCase[] {
    const testCases: TestCase[] = [];
    const funcDisplay = func.className ? `${func.className}.${func.name}` : func.name;

    // Basic functionality test
    testCases.push({
      name: `should execute ${funcDisplay} successfully`,
      description: `Test that ${funcDisplay} works with valid inputs`,
      type: 'unit',
    });

    // Parameter-based tests
    for (const param of func.params) {
      if (!param.optional) {
        // Required parameter validation
        testCases.push({
          name: `should handle ${param.name} parameter correctly`,
          description: `Test ${funcDisplay} with various ${param.name} values`,
          type: 'unit',
        });
      } else {
        // Optional parameter test
        testCases.push({
          name: `should work without ${param.name} parameter`,
          description: `Test ${funcDisplay} when ${param.name} is not provided`,
          type: 'edge-case',
        });
      }
    }

    // Edge cases based on types
    for (const param of func.params) {
      if (param.type.includes('string')) {
        testCases.push({
          name: `should handle empty string for ${param.name}`,
          description: `Test ${funcDisplay} with empty string ${param.name}`,
          type: 'edge-case',
        });
      }
      if (param.type.includes('number')) {
        testCases.push({
          name: `should handle zero and negative numbers for ${param.name}`,
          description: `Test ${funcDisplay} with edge number values`,
          type: 'edge-case',
        });
      }
      if (param.type.includes('[]') || param.type.includes('Array')) {
        testCases.push({
          name: `should handle empty array for ${param.name}`,
          description: `Test ${funcDisplay} with empty array`,
          type: 'edge-case',
        });
      }
    }

    // Error handling test
    testCases.push({
      name: `should handle errors gracefully in ${funcDisplay}`,
      description: `Test ${funcDisplay} error handling`,
      type: 'error-handling',
    });

    // Async tests
    if (func.isAsync) {
      testCases.push({
        name: `should resolve ${funcDisplay} correctly`,
        description: `Test async ${funcDisplay} resolution`,
        type: 'unit',
      });
      testCases.push({
        name: `should reject ${funcDisplay} on failure`,
        description: `Test async ${funcDisplay} rejection`,
        type: 'error-handling',
      });
    }

    return testCases;
  }

  /**
   * Generate test block code
   */
  private static generateTestBlock(testCase: TestCase, _framework: string): string {
    const itFunc = testCase.type === 'unit' ? 'it' : 'it';
    const asyncKeyword = testCase.type !== 'unit' ? 'async ' : '';

    return `  ${itFunc}('${testCase.name}', ${asyncKeyword}() => {
    // TODO: Implement test
    // ${testCase.description}
    ${testCase.setup ? `// Setup: ${testCase.setup}` : ''}
    ${testCase.input ? `// Input: ${testCase.input}` : ''}
    ${testCase.expectedOutput ? `// Expected: ${testCase.expectedOutput}` : ''}
    expect(true).toBe(true); // Placeholder
  });

`;
  }

  /**
   * Detect test framework from workspace
   */
  private static detectTestFramework(workspacePath: string): TestSpecification['framework'] {
    const packageJsonPath = path.join(workspacePath, 'package.json');

    if (!fs.existsSync(packageJsonPath)) {
      return 'unknown';
    }

    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

      if (deps['vitest']) return 'vitest';
      if (deps['jest']) return 'jest';
      if (deps['mocha']) return 'mocha';
    } catch {
      // Ignore parse errors
    }

    return 'jest'; // Default
  }

  /**
   * Get test file path
   */
  private static getTestFilePath(sourceFile: string, workspacePath: string): string {
    const relativePath = path.relative(workspacePath, sourceFile);
    const dir = path.dirname(relativePath);
    const base = path.basename(sourceFile, path.extname(sourceFile));
    const ext = path.extname(sourceFile);

    // Check for __tests__ convention
    const testsDir = path.join(workspacePath, '__tests__');
    if (fs.existsSync(testsDir)) {
      return path.join(testsDir, `${base}.test${ext}`);
    }

    // Co-located tests
    return path.join(workspacePath, dir, `${base}.test${ext}`);
  }

  /**
   * Generate imports for test file
   */
  private static generateImports(
    sourceFile: string,
    functions: FunctionSignature[],
    framework: string
  ): string[] {
    const imports: string[] = [];
    const relativePath = './' + path.basename(sourceFile, path.extname(sourceFile));

    // Framework imports
    if (framework === 'vitest') {
      imports.push(`import { describe, it, expect, beforeEach, afterEach } from 'vitest';`);
    }
    // Jest doesn't need explicit imports

    // Source imports
    const exportedFunctions = functions.filter(f => f.isExported && !f.className);
    const exportedClasses = [...new Set(functions.filter(f => f.className).map(f => f.className))];

    const namedExports = [
      ...exportedFunctions.map(f => f.name),
      ...exportedClasses,
    ].filter(Boolean);

    if (namedExports.length > 0) {
      imports.push(`import { ${namedExports.join(', ')} } from '${relativePath}';`);
    }

    return imports;
  }

  /**
   * Generate setup code
   */
  private static generateSetupCode(functions: FunctionSignature[]): string | undefined {
    const hasClass = functions.some(f => f.className);

    if (hasClass) {
      return '// Initialize test instance if needed';
    }

    return undefined;
  }

  /**
   * Generate teardown code
   */
  private static generateTeardownCode(functions: FunctionSignature[]): string | undefined {
    const hasAsync = functions.some(f => f.isAsync);

    if (hasAsync) {
      return '// Clean up async resources if needed';
    }

    return undefined;
  }

  /**
   * Estimate coverage from test cases
   */
  private static estimateCoverage(testCases: TestCase[]): number {
    const unitTests = testCases.filter(t => t.type === 'unit').length;
    const edgeCases = testCases.filter(t => t.type === 'edge-case').length;
    const errorTests = testCases.filter(t => t.type === 'error-handling').length;

    // Simple heuristic: each test type contributes to coverage
    const baseScore = Math.min(unitTests * 15, 50);
    const edgeScore = Math.min(edgeCases * 10, 30);
    const errorScore = Math.min(errorTests * 10, 20);

    return Math.min(baseScore + edgeScore + errorScore, 100);
  }

  /**
   * Generate instructions for Developer prompt
   */
  static generateInstructions(): string {
    return `
## 🧪 AUTO-TEST GENERATION

When you create or modify code, you MUST also create or update tests.

### Test Requirements for Each Function:

1. **Basic Functionality Test**
   - Test that the function works with valid inputs
   - Verify the return value matches expectations

2. **Parameter Tests** (for each parameter)
   - Test with various valid values
   - Test optional parameters are truly optional
   - Test type coercion if applicable

3. **Edge Cases**
   - Empty strings: \`""\`
   - Zero and negative numbers: \`0\`, \`-1\`
   - Empty arrays: \`[]\`
   - Null/undefined (if allowed)
   - Maximum/minimum values

4. **Error Handling**
   - Invalid inputs should throw/reject appropriately
   - Error messages should be helpful
   - Async functions should reject properly

### Test File Structure:

\`\`\`typescript
// src/services/UserService.test.ts
import { UserService } from './UserService';

describe('UserService', () => {
  describe('createUser', () => {
    it('should create a user with valid data', async () => {
      const result = await UserService.createUser({
        name: 'Test User',
        email: 'test@example.com',
      });
      expect(result.id).toBeDefined();
      expect(result.name).toBe('Test User');
    });

    it('should throw on invalid email', async () => {
      await expect(
        UserService.createUser({ name: 'Test', email: 'invalid' })
      ).rejects.toThrow('Invalid email');
    });

    it('should handle empty name', async () => {
      await expect(
        UserService.createUser({ name: '', email: 'test@example.com' })
      ).rejects.toThrow('Name required');
    });
  });
});
\`\`\`

### Test Commands:

\`\`\`bash
# Run all tests
npm test

# Run specific test file
npm test -- UserService.test.ts

# Run tests in watch mode
npm test -- --watch

# Run with coverage
npm test -- --coverage
\`\`\`

### 🚨 DO NOT:
- Skip writing tests
- Write tests that always pass
- Test implementation details instead of behavior
- Forget to test error cases

### ✅ DO:
- Write tests BEFORE or WITH the implementation
- Test public API behavior
- Include edge cases
- Mock external dependencies
`;
  }

  /**
   * Format test spec for prompt
   */
  static formatTestSpecForPrompt(spec: TestSpecification): string {
    return `
## Generated Test Specification

**Target File**: ${spec.targetFile}
**Test File**: ${spec.testFile}
**Framework**: ${spec.framework}
**Test Cases**: ${spec.testCases.length}

### Test Cases to Implement:

${spec.testCases.map((tc, i) => `
${i + 1}. **${tc.name}** (${tc.type})
   - ${tc.description}
`).join('')}

### Imports Needed:
\`\`\`typescript
${spec.imports.join('\n')}
\`\`\`
`;
  }
}
