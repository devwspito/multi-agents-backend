#!/usr/bin/env node

/**
 * TEST MÍNIMO - Para verificar que el sistema funcione
 *
 * Crea una tarea súper simple que debería:
 * 1. Costar < $0.50
 * 2. Modificar un archivo real
 * 3. Hacer commit y push
 */

const mongoose = require('mongoose');
const { Task } = require('./dist/models/Task');
const { Repository } = require('./dist/models/Repository');
const { User } = require('./dist/models/User');
const { TeamOrchestrator } = require('./dist/services/TeamOrchestrator');

require('dotenv').config();

async function runMinimalTest() {
  try {
    console.log('🧪 Starting minimal test...\n');

    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/multi-agents');
    console.log('✅ Connected to MongoDB');

    // Get or create test user
    let user = await User.findOne({ email: 'test@test.com' });
    if (!user) {
      user = await User.create({
        email: 'test@test.com',
        name: 'Test User',
        githubId: '12345',
        githubAccessToken: process.env.GITHUB_TOKEN
      });
    }
    console.log(`✅ Using user: ${user.email}`);

    // Create a test repository (or use existing)
    let repo = await Repository.findOne({ githubRepoName: 'test-repo/minimal' });
    if (!repo) {
      repo = await Repository.create({
        name: 'Test Minimal Repo',
        githubRepoName: 'test-repo/minimal',
        githubRepoOwner: 'test-repo',
        githubBranch: 'main',
        userId: user._id
      });
    }
    console.log(`✅ Using repository: ${repo.githubRepoName}`);

    // Create SUPER SIMPLE task
    const task = await Task.create({
      title: 'Add console.log test',
      description: 'Add a single console.log("Hello from test") to index.js file',
      userId: user._id,
      repositoryIds: [repo._id],
      priority: 'low',
      orchestration: {
        productManager: { status: 'pending' },
        projectManager: { status: 'pending' },
        techLead: { status: 'pending' },
        totalCost: 0,
        totalTokens: 0
      }
    });
    console.log(`✅ Created task: ${task._id}`);

    // Set environment for minimal cost
    process.env.MAX_AUTO_COST = '1.0'; // Auto approve up to $1
    process.env.ENABLE_MANUAL_REVIEW = 'false'; // No manual review
    process.env.ENABLE_JUDGE = 'false'; // Skip judge to save money
    process.env.INTERACTIVE_MODE = 'false';

    console.log('\n📊 Cost settings:');
    console.log('  - Max auto cost: $1.00');
    console.log('  - Manual review: disabled');
    console.log('  - Judge: disabled');

    console.log('\n🚀 Starting orchestration...\n');

    // Run orchestration
    const orchestrator = new TeamOrchestrator();
    await orchestrator.orchestrateTask(task._id.toString());

    console.log('\n✅ Test completed!');

    // Check results
    const updatedTask = await Task.findById(task._id);
    console.log('\n📊 Final Results:');
    console.log(`  - Status: ${updatedTask.orchestration.status}`);
    console.log(`  - Total cost: $${updatedTask.orchestration.totalCost.toFixed(4)}`);
    console.log(`  - Total tokens: ${updatedTask.orchestration.totalTokens}`);

    // Check workspace for actual files
    const fs = require('fs');
    const workspaceDir = `.agent-workspace/task-${task._id}`;
    if (fs.existsSync(workspaceDir)) {
      console.log(`\n📁 Workspace contents:`);
      const files = fs.readdirSync(workspaceDir);
      files.forEach(file => {
        console.log(`  - ${file}/`);
      });
    }

  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\n👋 Test finished');
    process.exit(0);
  }
}

// Run if called directly
if (require.main === module) {
  runMinimalTest();
}