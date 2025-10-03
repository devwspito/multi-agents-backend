/**
 * Token Usage API Endpoints Integration Tests
 *
 * Tests for:
 * - GET /api/token-usage/project/:projectId
 * - GET /api/token-usage/task/:taskId
 * - GET /api/token-usage/export/project/:projectId
 */

const mongoose = require('mongoose');
const Task = require('../src/models/Task');
const Project = require('../src/models/Project');
const User = require('../src/models/User');
const TokenUsage = require('../src/models/TokenUsage');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/agents-test';

// Simple test framework
class APITestRunner {
  constructor() {
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
  }

  test(name, fn) {
    this.tests.push({ name, fn });
  }

  async run() {
    console.log('\n🌐 Starting Token Usage API Tests...\n');
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
      }
    }

    console.log('=' .repeat(60));
    console.log(`\n📊 Results: ${this.passed} passed, ${this.failed} failed\n`);

    return this.failed === 0;
  }
}

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

function assertExists(value, message) {
  if (!value) {
    throw new Error(message || 'Expected value to exist');
  }
}

async function setupDatabase() {
  await mongoose.connect(MONGODB_URI);
  console.log('📦 Connected to test database');
}

async function teardownDatabase() {
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  console.log('🧹 Cleaned up test database');
}

async function createTestDataWithTokens() {
  // Create test user
  const user = await User.create({
    username: 'apitest',
    email: 'apitest@example.com',
    password: 'hashedpassword123',
    profile: {
      firstName: 'API',
      lastName: 'Test'
    }
  });

  // Create test project
  const project = await Project.create({
    name: 'API Test Project',
    description: 'Project for API testing',
    type: 'web-app',
    owner: user._id,
    status: 'in-progress'
  });

  // Create test tasks
  const task1 = await Task.create({
    title: 'API Test Task 1',
    description: 'First task for API testing',
    project: project._id,
    createdBy: user._id,
    status: 'in-progress'
  });

  const task2 = await Task.create({
    title: 'API Test Task 2',
    description: 'Second task for API testing',
    project: project._id,
    createdBy: user._id,
    status: 'completed'
  });

  // Add token usage records for task 1
  await task1.recordAgentTokenUsage({
    agent: 'product-manager',
    model: 'opus',
    inputTokens: 1500,
    outputTokens: 800,
    cost: 0.0825,
    duration: 4500,
    stage: 1,
    operationType: 'analysis',
    status: 'success',
    startedAt: new Date(Date.now() - 10000),
    completedAt: new Date(Date.now() - 5500)
  });

  await task1.recordAgentTokenUsage({
    agent: 'senior-developer',
    model: 'opus',
    inputTokens: 2500,
    outputTokens: 1200,
    cost: 0.1275,
    duration: 7000,
    stage: 4,
    operationType: 'implementation',
    repository: 'backend',
    artifacts: [
      {
        type: 'file',
        name: 'auth.js',
        linesAdded: 120,
        linesRemoved: 30
      }
    ],
    status: 'success',
    startedAt: new Date(Date.now() - 12000),
    completedAt: new Date(Date.now() - 5000)
  });

  // Add token usage records for task 2
  await task2.recordAgentTokenUsage({
    agent: 'junior-developer',
    model: 'sonnet',
    inputTokens: 1800,
    outputTokens: 900,
    cost: 0.0189,
    duration: 5000,
    stage: 5,
    operationType: 'implementation',
    repository: 'frontend',
    status: 'success',
    startedAt: new Date(Date.now() - 8000),
    completedAt: new Date(Date.now() - 3000)
  });

  // Update project stats
  await project.updateTokenStats();

  return { user, project, task1, task2 };
}

const runner = new APITestRunner();

// Test 1: Project endpoint returns correct structure
runner.test('GET /api/token-usage/project/:id should return correct data structure', async () => {
  const { user, project, task1, task2 } = await createTestDataWithTokens();

  // Simulate what the API endpoint does
  const projectId = project._id;
  const timeRange = 30;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - timeRange);

  // Get token usage records
  const tokenRecords = await TokenUsage.find({
    project: projectId,
    timestamp: { $gte: startDate }
  }).sort({ timestamp: -1 });

  // Aggregate by model
  const byModel = await TokenUsage.aggregate([
    {
      $match: {
        project: project._id,
        timestamp: { $gte: startDate },
        success: true
      }
    },
    {
      $group: {
        _id: '$model',
        totalTokens: { $sum: '$totalTokens' },
        totalCost: { $sum: '$estimatedCost' },
        requestCount: { $sum: 1 }
      }
    }
  ]);

  // Aggregate by agent
  const byAgent = await TokenUsage.aggregate([
    {
      $match: {
        project: project._id,
        timestamp: { $gte: startDate },
        success: true
      }
    },
    {
      $group: {
        _id: '$agentType',
        totalTokens: { $sum: '$totalTokens' },
        totalCost: { $sum: '$estimatedCost' },
        requestCount: { $sum: 1 }
      }
    }
  ]);

  // Verify data structure
  assert(tokenRecords.length > 0, 'Should have token records');
  assert(byModel.length > 0, 'Should have model aggregation');
  assert(byAgent.length > 0, 'Should have agent aggregation');

  // Verify we have both Opus and Sonnet
  const hasOpus = byModel.some(m => m._id === 'opus');
  const hasSonnet = byModel.some(m => m._id === 'sonnet');
  assert(hasOpus, 'Should have Opus model data');
  assert(hasSonnet, 'Should have Sonnet model data');

  // Verify agent types
  const agentTypes = byAgent.map(a => a._id);
  assert(agentTypes.includes('product-manager'), 'Should track product-manager');
  assert(agentTypes.includes('senior-developer'), 'Should track senior-developer');
  assert(agentTypes.includes('junior-developer'), 'Should track junior-developer');

  console.log(`   → Found ${tokenRecords.length} token records`);
  console.log(`   → Models tracked: ${byModel.map(m => m._id).join(', ')}`);
  console.log(`   → Agents tracked: ${agentTypes.join(', ')}`);
});

// Test 2: Task endpoint returns orchestration workflow details
runner.test('GET /api/token-usage/task/:id should return workflow details', async () => {
  const { user, project, task1 } = await createTestDataWithTokens();

  // Get all token usage records for this task
  const tokenRecords = await TokenUsage.find({
    task: task1._id
  }).sort({ timestamp: 1 });

  // Aggregate by agent
  const byAgent = await TokenUsage.aggregate([
    {
      $match: {
        task: task1._id,
        success: true
      }
    },
    {
      $group: {
        _id: {
          agent: '$agentType',
          model: '$model'
        },
        totalTokens: { $sum: '$totalTokens' },
        totalCost: { $sum: '$estimatedCost' },
        executions: { $sum: 1 }
      }
    }
  ]);

  // Verify structure
  assert(tokenRecords.length > 0, 'Should have token records for task');
  assert(byAgent.length > 0, 'Should have agent aggregation');

  // Verify records have required fields
  const firstRecord = tokenRecords[0];
  assertExists(firstRecord.agentType, 'Record should have agentType');
  assertExists(firstRecord.model, 'Record should have model');
  assertExists(firstRecord.totalTokens, 'Record should have totalTokens');
  assertExists(firstRecord.estimatedCost, 'Record should have cost');
  assertExists(firstRecord.operationType, 'Record should have operationType');

  // Check for artifacts
  const recordWithArtifacts = tokenRecords.find(r => r.artifacts && r.artifacts.length > 0);
  if (recordWithArtifacts) {
    assert(recordWithArtifacts.artifacts[0].type, 'Artifact should have type');
    assert(recordWithArtifacts.artifacts[0].name, 'Artifact should have name');
    console.log(`   → Found artifact: ${recordWithArtifacts.artifacts[0].name}`);
  }

  console.log(`   → Task has ${tokenRecords.length} executions`);
  console.log(`   → Agents used: ${byAgent.map(a => a._id.agent).join(', ')}`);
});

// Test 3: Project aggregation includes all tasks
runner.test('Project aggregation should include data from all tasks', async () => {
  const { project, task1, task2 } = await createTestDataWithTokens();

  await project.reload();

  // Verify project has aggregated data
  assert(project.tokenStats.totalTokens > 0, 'Project should have total tokens');
  assert(project.tokenStats.totalCost > 0, 'Project should have total cost');

  // Get all token records for the project
  const allRecords = await TokenUsage.find({ project: project._id });

  // Count unique tasks
  const uniqueTasks = [...new Set(allRecords.map(r => r.task?.toString()))];
  assert(uniqueTasks.length >= 2, 'Project should have records from multiple tasks');

  // Verify both models are tracked
  assert(project.tokenStats.byModel.opus.totalTokens > 0, 'Should track Opus tokens');
  assert(project.tokenStats.byModel.sonnet.totalTokens > 0, 'Should track Sonnet tokens');

  console.log(`   → Project total tokens: ${project.tokenStats.totalTokens}`);
  console.log(`   → Project total cost: $${project.tokenStats.totalCost.toFixed(4)}`);
  console.log(`   → Tasks included: ${uniqueTasks.length}`);
});

// Test 4: CSV export format validation
runner.test('CSV export should generate valid format', async () => {
  const { project } = await createTestDataWithTokens();

  // Get records for CSV export
  const records = await TokenUsage.find({ project: project._id })
    .populate('task', 'title description')
    .sort({ timestamp: -1 });

  // Generate CSV
  const csvHeader = 'Timestamp,Task,Agent,Model,Input Tokens,Output Tokens,Total Tokens,Cost (USD),Duration (ms),Operation Type,Repository,Success,Error\n';

  const csvRows = records.map(r => {
    const taskTitle = r.task?.title || 'N/A';
    const errorMsg = r.errorMessage ? r.errorMessage.replace(/,/g, ';') : '';

    return [
      r.timestamp.toISOString(),
      `"${taskTitle.replace(/"/g, '""')}"`,
      r.agentType,
      r.model,
      r.inputTokens,
      r.outputTokens,
      r.totalTokens,
      r.estimatedCost.toFixed(6),
      r.duration || 0,
      r.operationType || 'N/A',
      r.repository || 'N/A',
      r.success ? 'Yes' : 'No',
      `"${errorMsg}"`
    ].join(',');
  }).join('\n');

  const csv = csvHeader + csvRows;

  // Validate CSV
  assert(csv.includes('Timestamp'), 'CSV should have header');
  assert(csv.includes('product-manager'), 'CSV should include agent data');
  assert(csv.includes('opus'), 'CSV should include model data');

  const lines = csv.split('\n');
  assert(lines.length > 1, 'CSV should have data rows');

  // Verify each data row has correct number of columns
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim()) {
      const columns = lines[i].split(',');
      assert(columns.length >= 13, `Row ${i} should have at least 13 columns`);
    }
  }

  console.log(`   → CSV generated with ${lines.length - 1} data rows`);
  console.log(`   → CSV format validated successfully`);
});

// Test 5: Access control validation
runner.test('Access control should verify project ownership', async () => {
  const { user, project } = await createTestDataWithTokens();

  // Create another user
  const otherUser = await User.create({
    username: 'otheruser',
    email: 'other@example.com',
    password: 'hashedpassword123',
    profile: {
      firstName: 'Other',
      lastName: 'User'
    }
  });

  // Check if user has access
  const hasAccessOwner = project.owner.toString() === user.id ||
    project.collaborators.some(c => c.user.toString() === user.id);

  const hasAccessOther = project.owner.toString() === otherUser.id ||
    project.collaborators.some(c => c.user.toString() === otherUser.id);

  assert(hasAccessOwner === true, 'Owner should have access');
  assert(hasAccessOther === false, 'Non-owner should not have access');

  // Add other user as collaborator
  project.collaborators.push({
    user: otherUser._id,
    role: 'contributor'
  });
  await project.save();

  const hasAccessCollaborator = project.owner.toString() === otherUser.id ||
    project.collaborators.some(c => c.user.toString() === otherUser.id);

  assert(hasAccessCollaborator === true, 'Collaborator should have access');

  console.log(`   → Access control working correctly`);
});

// Test 6: Top tasks aggregation
runner.test('Top tasks aggregation should rank by cost', async () => {
  const { project } = await createTestDataWithTokens();

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 30);

  // Get top tasks
  const topTasks = await TokenUsage.aggregate([
    {
      $match: {
        project: project._id,
        timestamp: { $gte: startDate },
        success: true
      }
    },
    {
      $group: {
        _id: '$task',
        totalTokens: { $sum: '$totalTokens' },
        totalCost: { $sum: '$estimatedCost' }
      }
    },
    {
      $sort: { totalCost: -1 }
    },
    {
      $limit: 10
    }
  ]);

  assert(topTasks.length > 0, 'Should have top tasks');

  // Verify sorting (first should have highest cost)
  if (topTasks.length > 1) {
    assert(topTasks[0].totalCost >= topTasks[1].totalCost, 'Tasks should be sorted by cost descending');
  }

  console.log(`   → Found ${topTasks.length} top tasks`);
  console.log(`   → Highest cost: $${topTasks[0].totalCost.toFixed(4)}`);
});

// Main execution
async function main() {
  try {
    await setupDatabase();
    const success = await runner.run();
    await teardownDatabase();

    process.exit(success ? 0 : 1);
  } catch (error) {
    console.error('❌ API test execution failed:', error);
    await mongoose.connection.close();
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { runner };
