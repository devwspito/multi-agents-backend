#!/usr/bin/env node

/**
 * Script to update a project with a repository URL
 * Usage: node update-project-repository.js <project-name> <repository-url>
 *
 * Example:
 * node update-project-repository.js "Test" "https://github.com/devwspito/multi-agents-backend.git"
 */

const mongoose = require('mongoose');
const Project = require('../src/models/Project');
require('dotenv').config();

async function updateProjectRepository() {
  try {
    // Get command line arguments
    const projectName = process.argv[2] || 'Test';
    const repositoryUrl = process.argv[3] || 'https://github.com/devwspito/multi-agents-backend.git';

    if (!projectName || !repositoryUrl) {
      console.log('❌ Usage: node update-project-repository.js <project-name> <repository-url>');
      process.exit(1);
    }

    // Connect to MongoDB
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Find the project
    console.log(`🔍 Looking for project: "${projectName}"`);
    const project = await Project.findOne({ name: projectName });

    if (!project) {
      console.log(`❌ Project "${projectName}" not found`);

      // List available projects
      const projects = await Project.find({}, 'name');
      console.log('\n📋 Available projects:');
      projects.forEach(p => console.log(`  - ${p.name}`));

      await mongoose.disconnect();
      process.exit(1);
    }

    // Update the repository
    console.log(`📝 Current repository: ${project.repository?.url || 'Not configured'}`);

    project.repository = {
      url: repositoryUrl,
      branch: project.repository?.branch || 'main'
    };

    await project.save();
    console.log(`✅ Repository updated to: ${repositoryUrl}`);

    // Show updated project info
    console.log('\n📊 Updated project:');
    console.log(`  Name: ${project.name}`);
    console.log(`  Repository: ${project.repository.url}`);
    console.log(`  Branch: ${project.repository.branch}`);

    await mongoose.disconnect();
    console.log('\n✅ Update complete! Your project now has a repository configured.');
    console.log('🎯 Agents will now clone this repository when executing tasks.');

  } catch (error) {
    console.error('❌ Error:', error.message);
    await mongoose.disconnect();
    process.exit(1);
  }
}

updateProjectRepository();