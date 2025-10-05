#!/usr/bin/env node

/**
 * Script to view agent outputs from completed tasks
 * Usage: node view-task-outputs.js <task-id>
 */

const mongoose = require('mongoose');
const Task = require('../src/models/Task');
require('dotenv').config();

async function viewTaskOutputs() {
  try {
    const taskId = process.argv[2];

    if (!taskId) {
      console.log('❌ Usage: node view-task-outputs.js <task-id>');
      console.log('Example: node view-task-outputs.js 68e2465df14db85c06dcc8a4');
      process.exit(1);
    }

    // Connect to MongoDB
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Find the task
    console.log(`🔍 Looking for task: ${taskId}`);
    const task = await Task.findById(taskId)
      .populate('project', 'name');

    if (!task) {
      console.log(`❌ Task not found: ${taskId}`);

      // Show recent tasks
      const recentTasks = await Task.find({})
        .sort({ createdAt: -1 })
        .limit(5)
        .select('_id title createdAt');

      console.log('\n📋 Recent tasks:');
      recentTasks.forEach(t => {
        console.log(`  ${t._id} - ${t.title} (${t.createdAt.toLocaleDateString()})`);
      });

      await mongoose.disconnect();
      process.exit(1);
    }

    // Display task info
    console.log('\n' + '='.repeat(80));
    console.log(`📋 TASK: ${task.title}`);
    console.log(`📝 Description: ${task.description}`);
    console.log(`📁 Project: ${task.project?.name || 'No project'}`);
    console.log(`📊 Status: ${task.orchestration.status}`);
    console.log('='.repeat(80));

    // Display each agent's output
    let totalTokens = 0;
    let totalTime = 0;

    for (const step of task.orchestration.pipeline) {
      console.log('\n' + '-'.repeat(80));
      console.log(`\n🤖 AGENT: ${step.agent.toUpperCase()}`);
      console.log(`📊 Status: ${step.status}`);

      if (step.startedAt && step.completedAt) {
        const duration = new Date(step.completedAt) - new Date(step.startedAt);
        console.log(`⏱️ Time: ${Math.round(duration / 1000)}s`);
        totalTime += duration;
      }

      if (step.metrics) {
        console.log(`💰 Tokens: ${step.metrics.tokensUsed || 0}`);
        totalTokens += step.metrics.tokensUsed || 0;
      }

      console.log('\n📄 OUTPUT:');
      console.log('-'.repeat(40));

      if (step.output) {
        // Limit output display to 2000 chars for readability
        const output = step.output.substring(0, 2000);
        console.log(output);

        if (step.output.length > 2000) {
          console.log(`\n... [Output truncated - ${step.output.length} total characters]`);
        }
      } else {
        console.log('❌ No output available for this agent');
      }
    }

    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('📊 SUMMARY:');
    console.log(`  Total Tokens Used: ${totalTokens.toLocaleString()}`);
    console.log(`  Total Time: ${Math.round(totalTime / 1000)}s`);

    // Calculate approximate cost
    const opusTokens = task.orchestration.pipeline
      .filter(s => ['product-manager', 'project-manager', 'tech-lead'].includes(s.agent))
      .reduce((sum, s) => sum + (s.metrics?.tokensUsed || 0), 0);

    const sonnetTokens = task.orchestration.pipeline
      .filter(s => ['senior-developer', 'junior-developer', 'qa-engineer'].includes(s.agent))
      .reduce((sum, s) => sum + (s.metrics?.tokensUsed || 0), 0);

    const opusCost = (opusTokens / 1000) * 0.051; // $51 per million tokens
    const sonnetCost = (sonnetTokens / 1000) * 0.0102; // $10.20 per million tokens

    console.log(`  Estimated Cost: $${(opusCost + sonnetCost).toFixed(2)}`);
    console.log('='.repeat(80));

    await mongoose.disconnect();
    console.log('\n✅ Done!');

  } catch (error) {
    console.error('❌ Error:', error.message);
    await mongoose.disconnect();
    process.exit(1);
  }
}

viewTaskOutputs();