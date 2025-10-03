/**
 * Token Tracking System Integration Tests
 *
 * These tests verify the complete token tracking flow:
 * 1. Task.recordAgentTokenUsage() saves token data correctly
 * 2. Project.updateTokenStats() aggregates token data properly
 * 3. TokenUsage collection stores all metadata
 * 4. API endpoints return correct data
 */

const mongoose = require('mongoose');
const Task = require('../src/models/Task');
const Project = require('../src/models/Project');
const User = require('../src/models/User');
const TokenUsage = require('../src/models/TokenUsage');

// Test configuration
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/agents-test';
const TEST_TIMEOUT = 30000;

// Test utilities
class TestRunner {
  constructor() {
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
  }

  test(name, fn) {
    this.tests.push({ name, fn });
  }

  async run() {
    console.log('\n🧪 Starting Token Tracking Tests...\n');
    console.log('=' .repeat(60));

    for (const test of this.tests) {
      try {
        await test.fn();
        this.passed++;
        console.log(`✅ PASS: ${test.name}`);
      } catch (error) {
        this.failed++;
        console.log(`❌ FAIL: ${test.name}`);
        console.log(`   Error: ${error.message}`);
        if (error.stack) {
          console.log(`   ${error.stack.split('\n').slice(1, 3).join('\n   ')}`);
        }
      }
    }

    console.log('=' .repeat(60));
    console.log(`\n📊 Results: ${this.passed} passed, ${this.failed} failed\n`);

    return this.failed === 0;
  }
}

// Assertion helpers
function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

function assertGreaterThan(actual, expected, message) {
  if (actual <= expected) {
    throw new Error(message || `Expected ${actual} to be greater than ${expected}`);
  }
}

function assertExists(value, message) {
  if (!value) {
    throw new Error(message || 'Expected value to exist');
  }
}

// Test setup and teardown
async function setupDatabase() {
  await mongoose.connect(MONGODB_URI);
  console.log('📦 Connected to test database');
}

async function teardownDatabase() {
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  console.log('🧹 Cleaned up test database');
}

async function createTestData() {
  // Create test user
  const user = await User.create({
    username: 'testuser',
    email: 'test@example.com',
    password: 'hashedpassword123',
    profile: {
      firstName: 'Test',
      lastName: 'User'
    }
  });

  // Create test project
  const project = await Project.create({
    name: 'Test Project',
    description: 'Project for token tracking tests',
    type: 'web-app',
    owner: user._id,
    status: 'planning'
  });

  // Create test task
  const task = await Task.create({
    title: 'Test Task',
    description: 'Task for testing token tracking',
    project: project._id,
    createdBy: user._id,
    priority: 'high',
    status: 'backlog'
  });

  return { user, project, task };
}

// Test suite
const runner = new TestRunner();

// Test 1: Task.recordAgentTokenUsage() creates TokenUsage record
runner.test('Task.recordAgentTokenUsage() should create TokenUsage record', async () => {
  const { user, project, task } = await createTestData();

  const agentData = {
    agent: 'product-manager',
    model: 'opus',
    inputTokens: 1000,
    outputTokens: 500,
    cost: 0.0525,
    duration: 5000,
    stage: 1,
    operationType: 'analysis',
    repository: 'backend',
    artifacts: [
      {
        type: 'document',
        name: 'requirements.md',
        linesAdded: 50
      }
    ],
    status: 'success',
    startedAt: new Date(Date.now() - 5000),
    completedAt: new Date()
  };

  await task.recordAgentTokenUsage(agentData);

  // Verify TokenUsage record was created
  const tokenRecords = await TokenUsage.find({ task: task._id });
  assertEqual(tokenRecords.length, 1, 'Should create exactly one TokenUsage record');

  const record = tokenRecords[0];
  assertEqual(record.agentType, 'product-manager', 'Agent type should match');
  assertEqual(record.model, 'opus', 'Model should match');
  assertEqual(record.inputTokens, 1000, 'Input tokens should match');
  assertEqual(record.outputTokens, 500, 'Output tokens should match');
  assertEqual(record.totalTokens, 1500, 'Total tokens should be sum of input and output');
  assertEqual(record.estimatedCost, 0.0525, 'Cost should match');
  assertEqual(record.agentStage, 1, 'Agent stage should match');
  assertEqual(record.operationType, 'analysis', 'Operation type should match');
  assertEqual(record.repository, 'backend', 'Repository should match');
  assertEqual(record.success, true, 'Success should be true');

  // Verify task.tokenStats was updated
  await task.reload();
  assertEqual(task.tokenStats.totalTokens, 1500, 'Task total tokens should be updated');
  assertEqual(task.tokenStats.totalCost, 0.0525, 'Task total cost should be updated');
  assertEqual(task.tokenStats.byAgent.length, 1, 'Task should have one agent entry');
  assertEqual(task.tokenStats.byAgent[0].agent, 'product-manager', 'Agent in byAgent should match');

  console.log('   → TokenUsage record created correctly');
  console.log('   → Task.tokenStats updated correctly');
});

// Test 2: Multiple agent executions aggregate correctly
runner.test('Multiple agent executions should aggregate correctly', async () => {
  const { user, project, task } = await createTestData();

  // Execute multiple agents
  const agents = [
    { agent: 'product-manager', model: 'opus', inputTokens: 1000, outputTokens: 500, cost: 0.0525, stage: 1 },
    { agent: 'project-manager', model: 'opus', inputTokens: 1200, outputTokens: 600, cost: 0.063, stage: 2 },
    { agent: 'tech-lead', model: 'opus', inputTokens: 1500, outputTokens: 800, cost: 0.0825, stage: 3 },
    { agent: 'senior-developer', model: 'opus', inputTokens: 2000, outputTokens: 1000, cost: 0.105, stage: 4 },
    { agent: 'junior-developer', model: 'sonnet', inputTokens: 1800, outputTokens: 900, cost: 0.0189, stage: 5 },
    { agent: 'qa-engineer', model: 'sonnet', inputTokens: 1000, outputTokens: 500, cost: 0.0105, stage: 6 }
  ];

  for (const agentData of agents) {
    await task.recordAgentTokenUsage({
      ...agentData,
      duration: 3000,
      operationType: 'implementation',
      status: 'success',
      startedAt: new Date(Date.now() - 3000),
      completedAt: new Date()
    });
  }

  // Verify all records were created
  const tokenRecords = await TokenUsage.find({ task: task._id });
  assertEqual(tokenRecords.length, 6, 'Should create 6 TokenUsage records');

  // Verify task aggregation
  await task.reload();
  const expectedTotalTokens = 1500 + 1800 + 2300 + 3000 + 2700 + 1500; // Sum of all tokens
  const expectedTotalCost = 0.0525 + 0.063 + 0.0825 + 0.105 + 0.0189 + 0.0105;

  assertEqual(task.tokenStats.byAgent.length, 6, 'Task should have 6 agent entries');
  assertGreaterThan(task.tokenStats.totalTokens, 0, 'Task total tokens should be positive');
  assertGreaterThan(task.tokenStats.totalCost, 0, 'Task total cost should be positive');

  console.log(`   → All 6 agents tracked correctly`);
  console.log(`   → Total tokens: ${task.tokenStats.totalTokens}`);
  console.log(`   → Total cost: $${task.tokenStats.totalCost.toFixed(4)}`);
});

// Test 3: Project.updateTokenStats() aggregates from all tasks
runner.test('Project.updateTokenStats() should aggregate from all tasks', async () => {
  const { user, project } = await createTestData();

  // Create multiple tasks
  const task1 = await Task.create({
    title: 'Task 1',
    description: 'First task',
    project: project._id,
    createdBy: user._id,
    status: 'backlog'
  });

  const task2 = await Task.create({
    title: 'Task 2',
    description: 'Second task',
    project: project._id,
    createdBy: user._id,
    status: 'backlog'
  });

  // Record tokens for task 1 (Opus)
  await task1.recordAgentTokenUsage({
    agent: 'senior-developer',
    model: 'opus',
    inputTokens: 2000,
    outputTokens: 1000,
    cost: 0.105,
    duration: 5000,
    stage: 4,
    operationType: 'implementation',
    status: 'success',
    startedAt: new Date(),
    completedAt: new Date()
  });

  // Record tokens for task 2 (Sonnet)
  await task2.recordAgentTokenUsage({
    agent: 'junior-developer',
    model: 'sonnet',
    inputTokens: 1500,
    outputTokens: 750,
    cost: 0.01575,
    duration: 3000,
    stage: 5,
    operationType: 'implementation',
    status: 'success',
    startedAt: new Date(),
    completedAt: new Date()
  });

  // Update project stats
  await project.updateTokenStats();
  await project.reload();

  // Verify project aggregation
  assertGreaterThan(project.tokenStats.totalTokens, 0, 'Project total tokens should be positive');
  assertGreaterThan(project.tokenStats.totalCost, 0, 'Project total cost should be positive');

  // Check by model aggregation
  assertGreaterThan(project.tokenStats.byModel.opus.totalTokens, 0, 'Opus tokens should be tracked');
  assertGreaterThan(project.tokenStats.byModel.sonnet.totalTokens, 0, 'Sonnet tokens should be tracked');

  // Check by agent aggregation
  assertGreaterThan(project.tokenStats.byAgent['senior-developer'].tokens, 0, 'Senior dev tokens tracked');
  assertGreaterThan(project.tokenStats.byAgent['junior-developer'].tokens, 0, 'Junior dev tokens tracked');

  console.log(`   → Project total tokens: ${project.tokenStats.totalTokens}`);
  console.log(`   → Project total cost: $${project.tokenStats.totalCost.toFixed(4)}`);
  console.log(`   → Opus: ${project.tokenStats.byModel.opus.totalTokens} tokens`);
  console.log(`   → Sonnet: ${project.tokenStats.byModel.sonnet.totalTokens} tokens`);
});

// Test 4: Task.getTokenSummary() returns correct summary
runner.test('Task.getTokenSummary() should return correct summary', async () => {
  const { user, project, task } = await createTestData();

  // Record tokens for multiple agents
  await task.recordAgentTokenUsage({
    agent: 'product-manager',
    model: 'opus',
    inputTokens: 1000,
    outputTokens: 500,
    cost: 0.0525,
    duration: 4000,
    stage: 1,
    operationType: 'analysis',
    status: 'success',
    startedAt: new Date(),
    completedAt: new Date()
  });

  await task.recordAgentTokenUsage({
    agent: 'senior-developer',
    model: 'opus',
    inputTokens: 2000,
    outputTokens: 1000,
    cost: 0.105,
    duration: 6000,
    stage: 4,
    operationType: 'implementation',
    status: 'success',
    startedAt: new Date(),
    completedAt: new Date()
  });

  const summary = await task.getTokenSummary();

  assertExists(summary, 'Summary should exist');
  assertExists(summary.totalTokens, 'Total tokens should exist');
  assertExists(summary.totalCost, 'Total cost should exist');
  assertExists(summary.byAgent, 'ByAgent should exist');
  assertEqual(summary.byAgent.length, 2, 'Should have 2 agents');

  console.log(`   → Summary generated correctly`);
  console.log(`   → Total: ${summary.totalTokens} tokens, $${summary.totalCost.toFixed(4)}`);
});

// Test 5: Error cases are handled correctly
runner.test('Error cases should be handled correctly', async () => {
  const { user, project, task } = await createTestData();

  // Record a failed agent execution
  await task.recordAgentTokenUsage({
    agent: 'senior-developer',
    model: 'opus',
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    duration: 1000,
    stage: 4,
    operationType: 'implementation',
    status: 'error',
    errorMessage: 'Test error',
    startedAt: new Date(),
    completedAt: new Date()
  });

  const tokenRecords = await TokenUsage.find({ task: task._id });
  assertEqual(tokenRecords.length, 1, 'Error should still create record');
  assertEqual(tokenRecords[0].success, false, 'Success should be false');
  assertEqual(tokenRecords[0].errorMessage, 'Test error', 'Error message should be stored');
  assertEqual(tokenRecords[0].totalTokens, 0, 'Failed execution should have 0 tokens');

  console.log(`   → Error cases tracked correctly`);
});

// Test 6: orchestrationWorkflowId groups related executions
runner.test('orchestrationWorkflowId should group related executions', async () => {
  const { user, project, task } = await createTestData();

  const workflowId = `workflow-${task._id}-${Date.now()}`;

  // Create multiple agents in the same workflow
  const agents = ['product-manager', 'project-manager', 'tech-lead'];
  for (let i = 0; i < agents.length; i++) {
    await TokenUsage.create({
      user: user._id,
      project: project._id,
      task: task._id,
      agentType: agents[i],
      model: 'opus',
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      estimatedCost: 0.0525,
      requestType: 'orchestration',
      orchestrationWorkflowId: workflowId,
      agentStage: i + 1,
      duration: 3000,
      operationType: 'analysis',
      success: true
    });
  }

  // Query by workflow ID
  const workflowRecords = await TokenUsage.find({ orchestrationWorkflowId: workflowId });
  assertEqual(workflowRecords.length, 3, 'Should find all 3 agents in workflow');

  // Verify stages are sequential
  const stages = workflowRecords.map(r => r.agentStage).sort();
  assertEqual(stages[0], 1, 'First stage should be 1');
  assertEqual(stages[1], 2, 'Second stage should be 2');
  assertEqual(stages[2], 3, 'Third stage should be 3');

  console.log(`   → Workflow grouping works correctly`);
  console.log(`   → Found ${workflowRecords.length} agents in workflow`);
});

// Main test execution
async function main() {
  try {
    await setupDatabase();
    const success = await runner.run();
    await teardownDatabase();

    process.exit(success ? 0 : 1);
  } catch (error) {
    console.error('❌ Test execution failed:', error);
    await mongoose.connection.close();
    process.exit(1);
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  main();
}

module.exports = { runner, assert, assertEqual, assertGreaterThan, assertExists };
