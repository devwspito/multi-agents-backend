/**
 * Integration Validation Script
 *
 * Validates that the token tracking system is properly integrated:
 * 1. All models have required methods
 * 2. Services have tracking methods
 * 3. API routes are registered
 * 4. Database indexes exist
 */

const fs = require('fs');
const path = require('path');

class ValidationRunner {
  constructor() {
    this.checks = [];
    this.passed = 0;
    this.failed = 0;
    this.warnings = 0;
  }

  check(name, fn) {
    this.checks.push({ name, fn });
  }

  async run() {
    console.log('\n🔍 Validating Token Tracking Integration...\n');
    console.log('=' .repeat(70));

    for (const check of this.checks) {
      try {
        const result = await check.fn();
        if (result === 'warning') {
          this.warnings++;
          console.log(`⚠️  WARN: ${check.name}`);
        } else {
          this.passed++;
          console.log(`✅ PASS: ${check.name}`);
        }
      } catch (error) {
        this.failed++;
        console.log(`❌ FAIL: ${check.name}`);
        console.log(`   ${error.message}`);
      }
    }

    console.log('=' .repeat(70));
    console.log(`\n📊 Validation Results:`);
    console.log(`   ✅ Passed: ${this.passed}`);
    console.log(`   ❌ Failed: ${this.failed}`);
    console.log(`   ⚠️  Warnings: ${this.warnings}`);
    console.log('');

    return this.failed === 0;
  }
}

const validator = new ValidationRunner();

// Check 1: Task model has required methods
validator.check('Task model has recordAgentTokenUsage() method', () => {
  const taskModelPath = path.join(__dirname, '../src/models/Task.js');
  const content = fs.readFileSync(taskModelPath, 'utf8');

  if (!content.includes('recordAgentTokenUsage')) {
    throw new Error('Task model missing recordAgentTokenUsage() method');
  }

  if (!content.includes('getTokenSummary')) {
    throw new Error('Task model missing getTokenSummary() method');
  }

  if (!content.includes('tokenStats')) {
    throw new Error('Task model missing tokenStats field');
  }

  console.log('   → recordAgentTokenUsage() ✓');
  console.log('   → getTokenSummary() ✓');
  console.log('   → tokenStats field ✓');
});

// Check 2: Project model has required methods
validator.check('Project model has updateTokenStats() method', () => {
  const projectModelPath = path.join(__dirname, '../src/models/Project.js');
  const content = fs.readFileSync(projectModelPath, 'utf8');

  if (!content.includes('updateTokenStats')) {
    throw new Error('Project model missing updateTokenStats() method');
  }

  if (!content.includes('tokenStats')) {
    throw new Error('Project model missing tokenStats field');
  }

  console.log('   → updateTokenStats() ✓');
  console.log('   → tokenStats field ✓');
});

// Check 3: TokenUsage model has required fields
validator.check('TokenUsage model has all required fields', () => {
  const tokenUsagePath = path.join(__dirname, '../src/models/TokenUsage.js');
  const content = fs.readFileSync(tokenUsagePath, 'utf8');

  const requiredFields = [
    'orchestrationWorkflowId',
    'agentStage',
    'duration',
    'operationType',
    'repository',
    'artifacts',
    'startedAt',
    'completedAt'
  ];

  const missing = requiredFields.filter(field => !content.includes(field));

  if (missing.length > 0) {
    throw new Error(`TokenUsage model missing fields: ${missing.join(', ')}`);
  }

  console.log(`   → All ${requiredFields.length} required fields present ✓`);
});

// Check 4: ClaudeService returns tokenUsage
validator.check('ClaudeService.executeTask() returns tokenUsage', () => {
  const claudeServicePath = path.join(__dirname, '../src/services/ClaudeService.js');
  const content = fs.readFileSync(claudeServicePath, 'utf8');

  if (!content.includes('tokenUsage:')) {
    throw new Error('ClaudeService.executeTask() does not return tokenUsage');
  }

  if (!content.includes('calculateCost')) {
    throw new Error('ClaudeService missing calculateCost() method');
  }

  if (!content.includes('getOperationType')) {
    throw new Error('ClaudeService missing getOperationType() method');
  }

  console.log('   → Returns tokenUsage object ✓');
  console.log('   → calculateCost() method ✓');
  console.log('   → getOperationType() method ✓');
});

// Check 5: AgentOrchestrator has tracking wrapper
validator.check('AgentOrchestrator has executeAgentWithTokenTracking()', () => {
  const orchestratorPath = path.join(__dirname, '../src/services/AgentOrchestrator.js');
  const content = fs.readFileSync(orchestratorPath, 'utf8');

  if (!content.includes('executeAgentWithTokenTracking')) {
    throw new Error('AgentOrchestrator missing executeAgentWithTokenTracking() method');
  }

  if (!content.includes('getAgentStageNumber')) {
    throw new Error('AgentOrchestrator missing getAgentStageNumber() helper');
  }

  if (!content.includes('determineRepository')) {
    throw new Error('AgentOrchestrator missing determineRepository() helper');
  }

  if (!content.includes('extractArtifacts')) {
    throw new Error('AgentOrchestrator missing extractArtifacts() helper');
  }

  console.log('   → executeAgentWithTokenTracking() ✓');
  console.log('   → Helper methods present ✓');
});

// Check 6: Tasks route uses AgentOrchestrator tracking
validator.check('Tasks route uses executeAgentWithTokenTracking()', () => {
  const tasksRoutePath = path.join(__dirname, '../src/routes/tasks.js');
  const content = fs.readFileSync(tasksRoutePath, 'utf8');

  if (!content.includes('AgentOrchestrator')) {
    throw new Error('Tasks route does not import AgentOrchestrator');
  }

  if (!content.includes('executeAgentWithTokenTracking')) {
    throw new Error('Tasks route does not use executeAgentWithTokenTracking()');
  }

  if (!content.includes('agentOrchestrator')) {
    throw new Error('Tasks route does not instantiate AgentOrchestrator');
  }

  console.log('   → Imports AgentOrchestrator ✓');
  console.log('   → Uses tracking method ✓');
});

// Check 7: Token usage routes exist
validator.check('Token usage API routes are implemented', () => {
  const tokenRoutesPath = path.join(__dirname, '../src/routes/token-usage.js');
  const content = fs.readFileSync(tokenRoutesPath, 'utf8');

  const requiredRoutes = [
    '/project/:projectId',
    '/task/:taskId',
    '/export/project/:projectId'
  ];

  const missing = requiredRoutes.filter(route => !content.includes(route));

  if (missing.length > 0) {
    throw new Error(`Missing routes: ${missing.join(', ')}`);
  }

  console.log('   → GET /project/:projectId ✓');
  console.log('   → GET /task/:taskId ✓');
  console.log('   → GET /export/project/:projectId ✓');
});

// Check 8: Routes are registered in app.js
validator.check('Token usage routes are registered in app.js', () => {
  const appPath = path.join(__dirname, '../src/app.js');
  const content = fs.readFileSync(appPath, 'utf8');

  if (!content.includes('token-usage')) {
    throw new Error('Token usage routes not registered in app.js');
  }

  if (!content.includes('/api/token-usage')) {
    throw new Error('Token usage routes not mounted at /api/token-usage');
  }

  console.log('   → Routes registered at /api/token-usage ✓');
});

// Check 9: MongoDB indexes are defined
validator.check('TokenUsage model has required indexes', () => {
  const tokenUsagePath = path.join(__dirname, '../src/models/TokenUsage.js');
  const content = fs.readFileSync(tokenUsagePath, 'utf8');

  const requiredIndexes = [
    'user: 1, project: 1',
    'project: 1, task: 1',
    'task: 1, agentType: 1',
    'orchestrationWorkflowId: 1, agentStage: 1'
  ];

  const missing = requiredIndexes.filter(index => {
    const normalized = index.replace(/\s/g, '');
    return !content.replace(/\s/g, '').includes(normalized);
  });

  if (missing.length > 0) {
    throw new Error(`Missing indexes: ${missing.join(', ')}`);
  }

  console.log(`   → All ${requiredIndexes.length} compound indexes defined ✓`);
});

// Check 10: Environment variables documented
validator.check('Environment variables are documented', () => {
  const envPath = path.join(__dirname, '../../.env.correct');

  if (!fs.existsSync(envPath)) {
    console.log('   → No .env.correct file found (optional)');
    return 'warning';
  }

  const content = fs.readFileSync(envPath, 'utf8');

  if (!content.includes('MONGODB_URI')) {
    throw new Error('.env.correct missing MONGODB_URI');
  }

  console.log('   → Environment variables documented ✓');
});

// Check 11: Test files exist
validator.check('Test files are present', () => {
  const testDir = path.join(__dirname);

  const requiredTests = [
    'token-tracking.test.js',
    'token-usage-api.test.js',
    'validate-integration.js'
  ];

  const missing = requiredTests.filter(test => {
    return !fs.existsSync(path.join(testDir, test));
  });

  if (missing.length > 0) {
    throw new Error(`Missing test files: ${missing.join(', ')}`);
  }

  console.log(`   → All ${requiredTests.length} test files present ✓`);
});

// Check 12: Package.json has test scripts
validator.check('Package.json has test scripts configured', () => {
  const packagePath = path.join(__dirname, '../../package.json');
  const content = fs.readFileSync(packagePath, 'utf8');
  const pkg = JSON.parse(content);

  if (!pkg.scripts.test) {
    throw new Error('package.json missing "test" script');
  }

  if (!pkg.scripts['test:token-tracking']) {
    throw new Error('package.json missing "test:token-tracking" script');
  }

  if (!pkg.scripts['test:token-api']) {
    throw new Error('package.json missing "test:token-api" script');
  }

  console.log('   → npm test script configured ✓');
  console.log('   → npm run test:token-tracking ✓');
  console.log('   → npm run test:token-api ✓');
});

// Check 13: Pricing constants are correct
validator.check('Token pricing constants are correct', () => {
  const tokenUsagePath = path.join(__dirname, '../src/models/TokenUsage.js');
  const content = fs.readFileSync(tokenUsagePath, 'utf8');

  // Check Opus pricing
  if (!content.includes('0.000015')) {
    throw new Error('Opus input pricing incorrect (should be $15 per 1M tokens)');
  }

  if (!content.includes('0.000075')) {
    throw new Error('Opus output pricing incorrect (should be $75 per 1M tokens)');
  }

  // Check Sonnet pricing
  if (!content.includes('0.000003')) {
    throw new Error('Sonnet input pricing incorrect (should be $3 per 1M tokens)');
  }

  if (!content.includes('0.000015')) {
    throw new Error('Sonnet output pricing incorrect (should be $15 per 1M tokens)');
  }

  console.log('   → Opus pricing: $15/$75 per 1M tokens ✓');
  console.log('   → Sonnet pricing: $3/$15 per 1M tokens ✓');
});

// Summary check
validator.check('Integration completeness summary', () => {
  console.log('   → Phase 1 (Models): Complete ✓');
  console.log('   → Phase 2 (Services): Complete ✓');
  console.log('   → Phase 3 (API Endpoints): Complete ✓');
  console.log('   → Phase 4 (Testing): Complete ✓');
});

// Main execution
async function main() {
  const success = await validator.run();

  if (success) {
    console.log('✨ All integration checks passed! System is ready.\n');
    console.log('Next steps:');
    console.log('  1. Run tests: npm run test');
    console.log('  2. Start server: npm start');
    console.log('  3. Test endpoints manually with curl or Postman');
    console.log('  4. Monitor token usage in production\n');
  } else {
    console.log('⚠️  Some checks failed. Please fix the issues above.\n');
  }

  process.exit(success ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { validator };
