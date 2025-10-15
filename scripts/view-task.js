#!/usr/bin/env node

/**
 * Script to view complete task orchestration details
 * Usage: node scripts/view-task.js <taskId>
 */

const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/multi-agents';

// Task schema (simplified)
const taskSchema = new mongoose.Schema({}, { strict: false });
const Task = mongoose.model('Task', taskSchema);

async function viewTask(taskId) {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    const task = await Task.findById(taskId);

    if (!task) {
      console.error(`❌ Task ${taskId} not found`);
      process.exit(1);
    }

    console.log('═══════════════════════════════════════════════════════════');
    console.log('📋 TASK DETAILS');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`ID: ${task._id}`);
    console.log(`Title: ${task.title}`);
    console.log(`Status: ${task.status}`);
    console.log(`Created: ${task.createdAt}`);
    console.log(`\nDescription:\n${task.description}\n`);

    if (task.orchestration) {
      const orch = task.orchestration;

      // Product Manager
      if (orch.productManager) {
        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('📊 PRODUCT MANAGER OUTPUT');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`Status: ${orch.productManager.status}`);
        console.log(`Duration: ${orch.productManager.duration}ms`);
        console.log(`Cost: $${orch.productManager.cost_usd?.toFixed(4) || 0}\n`);
        console.log(orch.productManager.output || 'No output');
      }

      // Project Manager
      if (orch.projectManager) {
        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('📋 PROJECT MANAGER OUTPUT');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`Status: ${orch.projectManager.status}`);
        console.log(`Duration: ${orch.projectManager.duration}ms`);
        console.log(`Cost: $${orch.projectManager.cost_usd?.toFixed(4) || 0}\n`);
        console.log(orch.projectManager.output || 'No output');
      }

      // Tech Lead
      if (orch.techLead) {
        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('🏗️  TECH LEAD OUTPUT');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`Status: ${orch.techLead.status}`);
        console.log(`Duration: ${orch.techLead.duration}ms`);
        console.log(`Cost: $${orch.techLead.cost?.toFixed(4) || 0}\n`);
        console.log(orch.techLead.output || 'No output');
      }

      // Team Members (Developers)
      if (orch.teamMembers && orch.teamMembers.length > 0) {
        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('👨‍💻 DEVELOPERS');
        console.log('═══════════════════════════════════════════════════════════');

        orch.teamMembers.forEach((member, idx) => {
          console.log(`\n--- Developer ${idx + 1}: ${member.name} ---`);
          console.log(`Status: ${member.status}`);
          console.log(`Cost: $${member.cost_usd?.toFixed(4) || 0}`);

          if (member.stories && member.stories.length > 0) {
            console.log(`\nStories (${member.stories.length}):`);
            member.stories.forEach((story, sIdx) => {
              console.log(`\n  ${sIdx + 1}. ${story.title}`);
              console.log(`     Status: ${story.status}`);
              console.log(`     Repository: ${story.repository}`);
              console.log(`     Branch: ${story.branch || 'N/A'}`);

              if (story.steps && story.steps.length > 0) {
                console.log(`     Agent Steps: ${story.steps.length}`);
                story.steps.forEach((step, stepIdx) => {
                  console.log(`       ${stepIdx + 1}. ${step.agent} - ${step.status}`);
                  if (step.judgeScore !== undefined) {
                    console.log(`          Judge Score: ${step.judgeScore}/100`);
                  }
                });
              }
            });
          }
        });
      }

      // QA Engineer
      if (orch.qaEngineer) {
        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('🧪 QA ENGINEER OUTPUT');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`Status: ${orch.qaEngineer.status}`);
        console.log(`Duration: ${orch.qaEngineer.duration}ms`);
        console.log(`Cost: $${orch.qaEngineer.cost?.toFixed(4) || 0}\n`);
        console.log(orch.qaEngineer.output || 'No output');
      }

      // Merge Coordinator
      if (orch.mergeCoordinator) {
        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('🔀 MERGE COORDINATOR OUTPUT');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`Status: ${orch.mergeCoordinator.status}`);
        console.log(`Duration: ${orch.mergeCoordinator.duration}ms`);
        console.log(`Cost: $${orch.mergeCoordinator.cost?.toFixed(4) || 0}\n`);
        console.log(orch.mergeCoordinator.output || 'No output');
      }

      // Summary
      console.log('\n═══════════════════════════════════════════════════════════');
      console.log('💰 COST SUMMARY');
      console.log('═══════════════════════════════════════════════════════════');
      console.log(`Total Cost: $${orch.totalCost?.toFixed(4) || 0}`);
      console.log(`Total Tokens: ${orch.totalTokens || 0}`);
      console.log(`Total Duration: ${orch.duration}ms`);

      // Branches created
      if (orch.branches && orch.branches.length > 0) {
        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('🌿 BRANCHES CREATED');
        console.log('═══════════════════════════════════════════════════════════');
        orch.branches.forEach(branch => {
          console.log(`${branch.repository}: ${branch.name}`);
        });
      }

      // PRs created
      if (orch.pullRequests && orch.pullRequests.length > 0) {
        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('🔀 PULL REQUESTS');
        console.log('═══════════════════════════════════════════════════════════');
        orch.pullRequests.forEach(pr => {
          console.log(`${pr.repository}: #${pr.number} - ${pr.title}`);
          console.log(`  URL: ${pr.url}`);
          console.log(`  State: ${pr.state}`);
        });
      }
    }

    console.log('\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

// Get taskId from command line
const taskId = process.argv[2];

if (!taskId) {
  console.error('Usage: node scripts/view-task.js <taskId>');
  console.error('Example: node scripts/view-task.js 68eb9973fd8c4987b7847360');
  process.exit(1);
}

viewTask(taskId);
