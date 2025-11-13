# Anthropic Best Practices Compliance Guide

## Executive Summary
This guide implements Anthropic's best practices for AI agents in our orchestration system, focusing on efficient context management, clear tool design, and structured agent interactions.

## 1. Context Engineering Compliance

### Current Issues Identified:
- ❌ Overly verbose agent prompts (600+ lines in QAPhase.ts)
- ❌ Redundant information passed between phases
- ❌ Unstructured output formats causing parsing issues
- ❌ Context pollution with debug information

### Recommended Fixes:

#### A. Minimize Context Size
```typescript
// BEFORE: Verbose prompt with redundant info
const prompt = `
## Task: ${task.title}
## Description: ${task.description}
## Full Requirements: ${task.requirements}
## All Previous Agent Outputs: ${previousOutputs}
... (600+ lines)
`;

// AFTER: Focused, high-signal context
const prompt = `
## Objective
${task.title}

## Essential Context
- Working directory: ${workspacePath}
- Branches to test: ${branches.join(', ')}
- Error threshold: 30%

## Execute
Run build, tests, and type checks. Return JSON result.
`;
```

#### B. Structured Output Requirements
```typescript
// Define clear TypeScript interfaces for all agent outputs
interface QAResult {
  decision: 'GO' | 'NO-GO';
  metrics: {
    build: TestStatus;
    tests: TestStatus;
    runtime: TestStatus;
  };
  issues: string[];
  recommendation: string;
}

interface TestStatus {
  status: 'PASS' | 'FAIL' | 'NONE';
  reason: string;
  duration?: number;
}
```

## 2. Tool Design Compliance

### Current Issues:
- ❌ Agents executing raw bash commands without structure
- ❌ No timeout enforcement on long-running operations
- ❌ Missing error categorization
- ❌ Inconsistent output formats

### Recommended Implementation:

#### A. Create Specialized Testing Tools
```typescript
// src/tools/TestingTools.ts
export class TestingTools {
  async runBuild(projectPath: string, timeout: number = 60000): Promise<BuildResult> {
    return this.executeWithTimeout(
      'npm run build',
      projectPath,
      timeout,
      this.parseBuildOutput
    );
  }

  async runTests(projectPath: string, options: TestOptions): Promise<TestResult> {
    const command = this.constructTestCommand(options);
    return this.executeWithTimeout(
      command,
      projectPath,
      options.timeout || 120000,
      this.parseTestOutput
    );
  }

  private executeWithTimeout(
    command: string,
    cwd: string,
    timeout: number,
    parser: (output: string) => any
  ): Promise<any> {
    // Implementation with proper timeout and output parsing
  }
}
```

#### B. Implement Tool Namespacing
```typescript
// Clear tool naming convention
const tools = {
  'qa_validate_build': validateBuild,
  'qa_run_tests': runTests,
  'qa_check_types': checkTypes,
  'e2e_run_suite': runE2ESuite,
  'e2e_validate_performance': validatePerformance,
  'fixer_apply_patch': applyPatch,
  'fixer_validate_fix': validateFix
};
```

## 3. Agent Loop Design Compliance

### Implement Consistent Feedback Loop:
```typescript
class OptimizedQAPhase {
  async execute(context: OrchestrationContext): Promise<PhaseResult> {
    // 1. GATHER CONTEXT (minimal, focused)
    const essentials = this.gatherEssentialContext(context);

    // 2. TAKE ACTION (with clear tools)
    const testResults = await this.runValidation(essentials);

    // 3. VERIFY WORK (structured validation)
    const verification = this.verifyResults(testResults);

    // 4. REPORT (structured output)
    return this.formatStructuredResult(verification);
  }

  private gatherEssentialContext(context: OrchestrationContext) {
    return {
      workDir: context.workspacePath,
      branches: context.getData('epicBranches'),
      errorThreshold: 0.3,
      timeout: 180000
    };
  }
}
```

## 4. Prompt Optimization Examples

### QA Engineer Prompt (Optimized):
```markdown
# QA Validation

## Input
- Directory: ${workDir}
- Branches: ${branches}

## Actions Required
1. Run build (timeout: 60s)
2. Execute tests (timeout: 120s)
3. Verify types (timeout: 30s)

## Success Criteria
- Build: No errors
- Tests: <30% failure rate
- Runtime: No crashes

## Output Format
Return JSON with decision, metrics, and issues.
```

### Fixer Agent Prompt (Optimized):
```markdown
# Error Resolution

## Error Details
Type: ${errorType}
File: ${errorFile}
Line: ${errorLine}
Message: ${errorMessage}

## Fix Strategy
1. Identify root cause
2. Apply minimal change
3. Verify fix

## Output Format
Return JSON with fix details and verification status.
```

## 5. Performance Optimizations

### A. Parallel Execution
```typescript
// Execute independent validations in parallel
const [buildResult, testResult, lintResult] = await Promise.all([
  this.tools.runBuild(projectPath),
  this.tools.runTests(projectPath),
  this.tools.runLint(projectPath)
]);
```

### B. Early Termination
```typescript
// Fail fast on critical errors
if (buildResult.status === 'FAIL') {
  return {
    decision: 'NO-GO',
    reason: 'Build failed',
    skipRemaining: true
  };
}
```

### C. Caching Strategy
```typescript
// Cache expensive operations
const cacheKey = `${projectPath}_${branch}_deps`;
if (this.cache.has(cacheKey)) {
  console.log('Using cached dependencies');
  return this.cache.get(cacheKey);
}
```

## 6. Implementation Checklist

### Phase 1: Immediate Improvements (Day 1-2)
- [ ] Reduce QA prompt from 600+ to <100 lines
- [ ] Implement JSON output format for all agents
- [ ] Add timeouts to all test operations
- [ ] Create structured error types

### Phase 2: Tool Refactoring (Day 3-5)
- [ ] Create TestingTools class
- [ ] Implement tool namespacing
- [ ] Add error categorization
- [ ] Build output parsers

### Phase 3: Agent Optimization (Day 6-7)
- [ ] Implement gather-action-verify loop
- [ ] Add parallel execution where possible
- [ ] Create context compaction for long tasks
- [ ] Add performance metrics

### Phase 4: Validation (Day 8-10)
- [ ] Create test suite for new tools
- [ ] Benchmark performance improvements
- [ ] Document token usage reduction
- [ ] Measure success rates

## 7. Success Metrics

### Target Improvements:
- **Token Usage**: 50% reduction
- **Execution Time**: 40% faster
- **Success Rate**: 95%+ first-attempt success
- **Error Recovery**: 80% automated fix rate

### Measurement Strategy:
```typescript
interface AgentMetrics {
  tokenUsage: {
    before: number;
    after: number;
    reduction: number;
  };
  executionTime: {
    average: number;
    p95: number;
    p99: number;
  };
  successRate: {
    firstAttempt: number;
    afterRetry: number;
  };
}
```

## 8. Code Examples

### Optimized QAPhase.ts Structure:
```typescript
export class OptimizedQAPhase extends BasePhase {
  private tools: TestingTools;

  async executePhase(context: OrchestrationContext): Promise<PhaseResult> {
    const config = this.buildMinimalConfig(context);
    const agent = new QAAgent(this.tools, config);

    const result = await agent.validate();

    return this.formatResult(result);
  }

  private buildMinimalConfig(context: OrchestrationContext): QAConfig {
    return {
      workDir: context.workspacePath,
      branches: context.getData('epicBranches'),
      timeouts: {
        build: 60000,
        test: 120000,
        typeCheck: 30000
      },
      thresholds: {
        testFailure: 0.3,
        coverage: 0.7
      }
    };
  }
}
```

### Optimized Fixer Implementation:
```typescript
export class OptimizedFixer {
  async fix(error: ErrorDetails): Promise<FixResult> {
    // 1. Categorize error
    const category = this.categorizeError(error);

    // 2. Apply targeted fix strategy
    const strategy = this.selectStrategy(category);
    const fix = await strategy.apply(error);

    // 3. Verify fix
    const verification = await this.verifyFix(fix);

    return {
      success: verification.passed,
      fix: fix,
      verification: verification
    };
  }

  private categorizeError(error: ErrorDetails): ErrorCategory {
    if (error.message.includes('Cannot find module')) return 'IMPORT';
    if (error.message.includes('TypeError')) return 'TYPE';
    if (error.message.includes('test failed')) return 'TEST';
    return 'UNKNOWN';
  }
}
```

## 9. Migration Path

### Week 1:
1. Create new optimized agent configurations
2. Implement TestingTools class
3. Add structured output formats

### Week 2:
1. Refactor QAPhase to use new tools
2. Implement Fixer with categorized strategies
3. Add E2E test automation

### Week 3:
1. Performance testing and optimization
2. Documentation updates
3. Team training on new patterns

## 10. Conclusion

By implementing these Anthropic best practices, we expect:
- **50% reduction** in token usage
- **40% faster** execution times
- **Higher success rates** with fewer retries
- **Better maintainability** through clear structure

The key principles to remember:
1. **Minimal Context**: Only include essential information
2. **Clear Tools**: Specialized, well-documented tools
3. **Structured Output**: JSON responses for automation
4. **Fast Feedback**: Fail early on critical errors
5. **Continuous Improvement**: Monitor and optimize based on metrics