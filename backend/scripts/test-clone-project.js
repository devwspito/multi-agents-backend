#!/usr/bin/env node

/**
 * Test cloning the opocheckchat repository from the Test project
 */

const mongoose = require('mongoose');
const Project = require('../src/models/Project');
const User = require('../src/models/User');
const repositoryService = require('../src/services/RepositoryService');
require('dotenv').config();

async function testCloneProject() {
  try {
    console.log('\n' + '='.repeat(80));
    console.log('🚀 TESTING REPOSITORY CLONE FOR PROJECT "Test"');
    console.log('='.repeat(80));

    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Get the Test project
    const projectId = '68e380509201311999de3c45';
    const project = await Project.findById(projectId);

    if (!project) {
      throw new Error('Project not found');
    }

    console.log(`\n📁 Project: ${project.name}`);
    console.log(`   ID: ${project._id}`);
    console.log(`   Repositories: ${project.repositories.length}`);

    // Get the user (owner)
    const user = await User.findById(project.owner).select('+github.accessToken +github.username');

    if (!user) {
      throw new Error('User not found');
    }

    console.log(`\n👤 User: ${user.username}`);
    console.log(`   GitHub username: ${user.github?.username || 'Not set'}`);
    console.log(`   Has access token: ${user.github?.accessToken ? 'Yes' : 'No'}`);

    // Find the opocheckchat repository
    const repository = project.repositories.find(r =>
      r.name === 'opocheckchat' && r.githubUrl
    );

    if (!repository) {
      throw new Error('Repository opocheckchat with GitHub URL not found');
    }

    console.log(`\n📦 Repository found:`);
    console.log(`   Name: ${repository.name}`);
    console.log(`   Owner: ${repository.owner}`);
    console.log(`   GitHub URL: ${repository.githubUrl}`);
    console.log(`   Type: ${repository.type || 'not specified'}`);

    // Fix the GitHub URL if needed (remove .git if present for API calls)
    const githubUrl = repository.githubUrl.replace(/\.git$/, '');

    console.log('\n' + '='.repeat(80));
    console.log('🔄 ATTEMPTING TO CLONE REPOSITORY');
    console.log('='.repeat(80));

    try {
      // Clone the repository
      const repoPath = await repositoryService.cloneRepository(
        githubUrl,
        user.github.accessToken,
        project._id.toString(),
        repository.name
      );

      console.log(`\n✅ SUCCESSFULLY CLONED!`);
      console.log(`📍 Repository location: ${repoPath}`);

      // Read repository content
      console.log('\n📖 Reading repository content...');
      const content = await repositoryService.readRepositoryContent(repoPath);

      console.log('\n📊 Repository Analysis:');
      console.log(`   Total files: ${content.files.length}`);
      console.log(`   Has package.json: ${content.packageJson ? 'Yes' : 'No'}`);
      console.log(`   Has README: ${content.readme ? 'Yes' : 'No'}`);
      console.log(`   Main files: ${content.mainFiles.join(', ') || 'None found'}`);

      if (content.packageJson) {
        console.log('\n📦 Package.json info:');
        console.log(`   Name: ${content.packageJson.name}`);
        console.log(`   Version: ${content.packageJson.version}`);
        console.log(`   Scripts: ${Object.keys(content.packageJson.scripts || {}).join(', ')}`);

        if (content.packageJson.dependencies) {
          console.log(`   Dependencies: ${Object.keys(content.packageJson.dependencies).length}`);
        }
      }

      console.log('\n📁 First 15 files:');
      content.files.slice(0, 15).forEach(file => {
        console.log(`   - ${file}`);
      });

      // Try to read a specific file
      if (content.mainFiles.length > 0) {
        console.log(`\n📄 Reading ${content.mainFiles[0]}...`);
        const fileContent = await repositoryService.readFile(repoPath, content.mainFiles[0]);
        console.log(`   File size: ${fileContent.length} characters`);
        console.log(`   First 200 chars:`);
        console.log(fileContent.substring(0, 200) + '...');
      }

      console.log('\n' + '='.repeat(80));
      console.log('🎉 SUCCESS! Repository is accessible and readable!');
      console.log('='.repeat(80));
      console.log('\nThe system can now:');
      console.log('✅ Clone the repository');
      console.log('✅ Read all files');
      console.log('✅ Analyze the structure');
      console.log('✅ Provide code context to agents');
      console.log('\nWhen you create a task, the agents will have full access to this code.');

    } catch (cloneError) {
      console.error('\n❌ Clone error:', cloneError.message);

      if (cloneError.message.includes('Authentication failed')) {
        console.log('\n⚠️ Authentication issue. Possible causes:');
        console.log('   1. The GitHub token might have expired');
        console.log('   2. The token might not have repo access');
        console.log('   3. The repository might be private and token lacks permissions');
      }

      if (cloneError.message.includes('Repository not found')) {
        console.log('\n⚠️ Repository not found. Check:');
        console.log('   1. The repository exists at:', githubUrl);
        console.log('   2. The owner is correct:', repository.owner);
        console.log('   3. The user has access to this repository');
      }
    }

  } catch (error) {
    console.error('\n❌ Test error:', error.message);
    console.error(error);
  } finally {
    await mongoose.disconnect();
    console.log('\n📊 Disconnected from MongoDB');
  }
}

console.log('🚀 Starting repository clone test...');
testCloneProject().catch(console.error);