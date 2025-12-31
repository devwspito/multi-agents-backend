/**
 * BuildVerificationService Tests
 *
 * Tests for automatic code verification that enforces
 * typecheck/test/lint at the orchestration level.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

// Mock external dependencies
jest.mock('./logging/LogService', () => ({
  LogService: {
    info: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  },
}));

// Import after mocking
import { BuildVerificationService, DEFAULT_VERIFICATION_COMMANDS } from './BuildVerificationService';

describe('BuildVerificationService', () => {
  let testProjectPath: string;

  beforeAll(() => {
    // Create a temporary Node.js project for testing
    testProjectPath = path.join(os.tmpdir(), `test-project-${Date.now()}`);
    fs.mkdirSync(testProjectPath, { recursive: true });

    // Create a minimal package.json
    const packageJson = {
      name: 'test-project',
      version: '1.0.0',
      scripts: {
        test: 'echo "Tests passed"',
        lint: 'echo "Lint passed"',
        typecheck: 'echo "Typecheck passed"',
      },
    };
    fs.writeFileSync(
      path.join(testProjectPath, 'package.json'),
      JSON.stringify(packageJson, null, 2)
    );

    // Create tsconfig.json to make it a TypeScript project
    const tsconfig = {
      compilerOptions: {
        target: 'ES2020',
        module: 'commonjs',
        strict: true,
      },
    };
    fs.writeFileSync(
      path.join(testProjectPath, 'tsconfig.json'),
      JSON.stringify(tsconfig, null, 2)
    );

    // Create node_modules directory (simulate npm install)
    fs.mkdirSync(path.join(testProjectPath, 'node_modules'), { recursive: true });
  });

  afterAll(() => {
    // Cleanup test project
    if (testProjectPath && fs.existsSync(testProjectPath)) {
      fs.rmSync(testProjectPath, { recursive: true, force: true });
    }
  });

  describe('detectProjectType', () => {
    it('should detect TypeScript project', () => {
      const type = BuildVerificationService.detectProjectType(testProjectPath);
      expect(type).toBe('node-typescript');
    });

    it('should detect JavaScript project when no tsconfig', () => {
      const jsProjectPath = path.join(os.tmpdir(), `js-project-${Date.now()}`);
      fs.mkdirSync(jsProjectPath, { recursive: true });
      fs.writeFileSync(
        path.join(jsProjectPath, 'package.json'),
        JSON.stringify({ name: 'js-project' })
      );

      const type = BuildVerificationService.detectProjectType(jsProjectPath);
      expect(type).toBe('node-javascript');

      fs.rmSync(jsProjectPath, { recursive: true, force: true });
    });

    it('should detect Python project', () => {
      const pyProjectPath = path.join(os.tmpdir(), `py-project-${Date.now()}`);
      fs.mkdirSync(pyProjectPath, { recursive: true });
      fs.writeFileSync(path.join(pyProjectPath, 'requirements.txt'), 'flask\n');

      const type = BuildVerificationService.detectProjectType(pyProjectPath);
      expect(type).toBe('python');

      fs.rmSync(pyProjectPath, { recursive: true, force: true });
    });

    it('should detect Go project', () => {
      const goProjectPath = path.join(os.tmpdir(), `go-project-${Date.now()}`);
      fs.mkdirSync(goProjectPath, { recursive: true });
      fs.writeFileSync(path.join(goProjectPath, 'go.mod'), 'module test\n');

      const type = BuildVerificationService.detectProjectType(goProjectPath);
      expect(type).toBe('go');

      fs.rmSync(goProjectPath, { recursive: true, force: true });
    });
  });

  describe('parseErrors', () => {
    it('should parse TypeScript errors', () => {
      const output = `src/file.ts(10,5): error TS2345: Argument of type 'string' is not assignable`;

      const errors = (BuildVerificationService as any).parseErrors(output, 'typecheck');

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].file).toBe('src/file.ts');
      expect(errors[0].line).toBe(10);
      expect(errors[0].severity).toBe('error');
    });

    it('should parse TSC style errors', () => {
      const output = `src/service.ts:25:10 - error TS2339: Property 'foo' does not exist`;

      const errors = (BuildVerificationService as any).parseErrors(output, 'typecheck');

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].file).toBe('src/service.ts');
      expect(errors[0].line).toBe(25);
    });

    it('should parse Jest test failures', () => {
      const output = `
PASS src/utils.test.ts
FAIL src/service.test.ts
  ● should handle errors
`;

      const errors = (BuildVerificationService as any).parseErrors(output, 'test');

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].file).toBe('src/service.test.ts');
    });

    it('should handle empty output', () => {
      const errors = (BuildVerificationService as any).parseErrors('', 'typecheck');
      expect(errors).toEqual([]);
    });
  });

  describe('runVerificationCommand', () => {
    it('should run successful command', async () => {
      const result = await BuildVerificationService.runVerificationCommand(
        testProjectPath,
        {
          name: 'test',
          command: 'echo "success"',
          timeout: 5000,
          required: true,
          parseErrors: false,
        }
      );

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('success');
    });

    it('should handle failed command', async () => {
      const result = await BuildVerificationService.runVerificationCommand(
        testProjectPath,
        {
          name: 'fail-test',
          command: 'exit 1',
          timeout: 5000,
          required: true,
          parseErrors: false,
        }
      );

      expect(result.success).toBe(false);
      expect(result.exitCode).not.toBe(0);
    });

    it('should handle timeout', async () => {
      const result = await BuildVerificationService.runVerificationCommand(
        testProjectPath,
        {
          name: 'slow-test',
          command: 'sleep 10',
          timeout: 100, // Very short timeout
          required: true,
          parseErrors: false,
        }
      );

      expect(result.timedOut).toBe(true);
      expect(result.success).toBe(false);
    });

    it('should mark non-required failed command as success', async () => {
      const result = await BuildVerificationService.runVerificationCommand(
        testProjectPath,
        {
          name: 'optional-test',
          command: 'exit 1',
          timeout: 5000,
          required: false, // Not required
          parseErrors: false,
        }
      );

      expect(result.success).toBe(true); // Still success because not required
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe('quickCheck', () => {
    it('should pass when node_modules exists', async () => {
      const result = await BuildVerificationService.quickCheck(testProjectPath);
      expect(result.likely_fails).toBe(false);
    });

    it('should fail when node_modules missing', async () => {
      const noModulesPath = path.join(os.tmpdir(), `no-modules-${Date.now()}`);
      fs.mkdirSync(noModulesPath, { recursive: true });
      fs.writeFileSync(
        path.join(noModulesPath, 'package.json'),
        JSON.stringify({ name: 'test' })
      );

      const result = await BuildVerificationService.quickCheck(noModulesPath);
      expect(result.likely_fails).toBe(true);
      expect(result.reason).toContain('node_modules');

      fs.rmSync(noModulesPath, { recursive: true, force: true });
    });
  });

  describe('verifyBuild', () => {
    it('should run full verification with custom commands', async () => {
      const report = await BuildVerificationService.verifyBuild(
        testProjectPath,
        'test-task-id',
        [
          {
            name: 'simple-check',
            command: 'echo "all good"',
            timeout: 5000,
            required: true,
            parseErrors: false,
          },
        ]
      );

      expect(report.overall).toBe(true);
      expect(report.results['simple-check']).toBeDefined();
      expect(report.results['simple-check'].success).toBe(true);
    });

    it('should generate feedback for failed builds', async () => {
      const report = await BuildVerificationService.verifyBuild(
        testProjectPath,
        'test-task-id',
        [
          {
            name: 'failing-check',
            command: 'echo "src/file.ts(1,1): error TS0001: Test error" && exit 1',
            timeout: 5000,
            required: true,
            parseErrors: true,
          },
        ]
      );

      expect(report.overall).toBe(false);
      expect(report.feedbackForAgent).toContain('BUILD VERIFICATION FAILED');
    });
  });

  describe('DEFAULT_VERIFICATION_COMMANDS', () => {
    it('should have commands for node-typescript', () => {
      const commands = DEFAULT_VERIFICATION_COMMANDS['node-typescript'];
      expect(commands).toBeDefined();
      expect(commands.length).toBeGreaterThan(0);
      expect(commands.find(c => c.name === 'typecheck')).toBeDefined();
    });

    it('should have commands for python', () => {
      const commands = DEFAULT_VERIFICATION_COMMANDS['python'];
      expect(commands).toBeDefined();
      expect(commands.find(c => c.name === 'test')).toBeDefined();
    });

    it('should have commands for go', () => {
      const commands = DEFAULT_VERIFICATION_COMMANDS['go'];
      expect(commands).toBeDefined();
      expect(commands.find(c => c.name === 'build')).toBeDefined();
    });
  });
});
