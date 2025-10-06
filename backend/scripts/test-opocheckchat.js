#!/usr/bin/env node

/**
 * Test script to simulate project creation with opocheckchat repository
 */

const mongoose = require('mongoose');
const Project = require('../src/models/Project');
const User = require('../src/models/User');
const repositoryService = require('../src/services/RepositoryService');
require('dotenv').config();

async function testOpocheckchat() {
  try {
    console.log('\n' + '='.repeat(80));
    console.log('🧪 TESTING OPOCHECKCHAT REPOSITORY CLONE');
    console.log('='.repeat(80));

    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Find the user devwspito
    const user = await User.findOne({ username: 'devwspito' }).select('+github.accessToken');
    if (!user) {
      throw new Error('User devwspito not found');
    }

    console.log(`\n👤 User found: ${user.username}`);
    console.log(`   GitHub username: ${user.github?.username || 'Not set'}`);
    console.log(`   Has access token: ${user.github?.accessToken ? 'Yes' : 'No'}`);

    // Create or update test project
    let project = await Project.findOne({ name: 'Test Opocheckchat' });

    if (!project) {
      console.log('\n📁 Creating new test project...');
      project = new Project({
        name: 'Test Opocheckchat',
        description: 'Testing repository cloning with opocheckchat',
        type: 'web-app',
        owner: user._id,
        repositories: []
      });
    }

    // Use GitHub API to get repository info
    const { Octokit } = require('@octokit/rest');
    const octokit = new Octokit({
      auth: user.github.accessToken
    });

    console.log('\n🔍 Fetching repository info from GitHub...');

    try {
      // Try to get the repository
      const { data: repoInfo } = await octokit.rest.repos.get({
        owner: user.github.username,
        repo: 'opocheckchat'
      });

      console.log(`✅ Repository found on GitHub:`);
      console.log(`   Name: ${repoInfo.name}`);
      console.log(`   Owner: ${repoInfo.owner.login}`);
      console.log(`   Clone URL: ${repoInfo.clone_url}`);
      console.log(`   Language: ${repoInfo.language}`);
      console.log(`   Default branch: ${repoInfo.default_branch}`);

      // Add repository to project
      const repository = {
        name: repoInfo.name,
        githubUrl: repoInfo.clone_url,
        owner: repoInfo.owner.login,
        branch: repoInfo.default_branch || 'main',
        type: 'frontend',
        technologies: repoInfo.language ? [repoInfo.language] : [],
        isActive: true
      };

      // Check if repository already exists in project
      const existingRepoIndex = project.repositories.findIndex(r => r.name === repository.name);
      if (existingRepoIndex >= 0) {
        project.repositories[existingRepoIndex] = repository;
      } else {
        project.repositories.push(repository);
      }

      await project.save();
      console.log(`✅ Project saved with repository`);

      // Now clone the repository
      console.log('\n🔄 Cloning repository...');
      const repoPath = await repositoryService.cloneRepository(
        repository.githubUrl,
        user.github.accessToken,
        project._id.toString(),
        repository.name
      );

      console.log(`✅ Repository cloned to: ${repoPath}`);

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
      }

      console.log('\n📁 Sample files:');
      content.files.slice(0, 10).forEach(file => {
        console.log(`   - ${file}`);
      });

      // Get languages
      const languages = await repositoryService.getLanguages(
        repository.owner,
        repository.name,
        user.github.accessToken
      );

      console.log('\n💻 Languages:');
      Object.entries(languages).forEach(([lang, bytes]) => {
        const percentage = (bytes / Object.values(languages).reduce((a, b) => a + b, 0) * 100).toFixed(1);
        console.log(`   ${lang}: ${percentage}%`);
      });

    } catch (error) {
      console.error(`\n❌ Error fetching/cloning repository:`, error.message);

      if (error.status === 404) {
        console.log('\n⚠️ Repository not found. Make sure:');
        console.log('   1. The repository exists on GitHub');
        console.log('   2. The user has access to it');
        console.log('   3. The repository name is correct');
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log('✅ TEST COMPLETED');
    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('\n❌ Test error:', error.message);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

testOpocheckchat().catch(console.error);