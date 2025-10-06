#!/usr/bin/env node

/**
 * Script to clean duplicate repositories in projects
 * Keeps only repositories with githubUrl and removes duplicates
 */

const mongoose = require('mongoose');
const Project = require('../src/models/Project');
require('dotenv').config();

async function cleanDuplicateRepos() {
  try {
    console.log('🧹 CLEANING DUPLICATE REPOSITORIES IN PROJECTS');
    console.log('='.repeat(60));

    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Get all projects
    const projects = await Project.find({});
    console.log(`📊 Found ${projects.length} projects to check`);

    let projectsFixed = 0;
    let reposRemoved = 0;

    for (const project of projects) {
      console.log(`\n📁 Project: ${project.name} (ID: ${project._id})`);
      console.log(`   Original repositories: ${project.repositories.length}`);

      if (project.repositories.length === 0) {
        console.log('   ⏭️ No repositories to process');
        continue;
      }

      // Track unique repositories by name
      const uniqueRepos = new Map();
      let hasChanges = false;

      for (const repo of project.repositories) {
        console.log(`   📦 Repository: ${repo.name}`);
        console.log(`      - Has githubUrl: ${repo.githubUrl ? '✅ Yes' : '❌ No'}`);
        console.log(`      - Owner: ${repo.owner || 'not set'}`);

        // If this repo already exists in our map
        if (uniqueRepos.has(repo.name)) {
          const existing = uniqueRepos.get(repo.name);

          // Keep the one with githubUrl, or the more complete one
          if (repo.githubUrl && !existing.githubUrl) {
            // This one has URL, replace
            console.log(`      ✅ Replacing with version that has githubUrl`);
            uniqueRepos.set(repo.name, repo);
            hasChanges = true;
            reposRemoved++;
          } else if (!repo.githubUrl && existing.githubUrl) {
            // Existing has URL, skip this one
            console.log(`      ❌ Removing duplicate without githubUrl`);
            hasChanges = true;
            reposRemoved++;
          } else if (repo.githubUrl && existing.githubUrl) {
            // Both have URLs, keep the more complete one
            const repoScore = getCompletenessScore(repo);
            const existingScore = getCompletenessScore(existing);

            if (repoScore > existingScore) {
              console.log(`      ✅ Replacing with more complete version`);
              uniqueRepos.set(repo.name, repo);
            } else {
              console.log(`      ⏭️ Keeping existing more complete version`);
            }
            hasChanges = true;
            reposRemoved++;
          } else {
            // Neither has URL, keep the more complete one
            const repoScore = getCompletenessScore(repo);
            const existingScore = getCompletenessScore(existing);

            if (repoScore > existingScore) {
              uniqueRepos.set(repo.name, repo);
            }
            console.log(`      ⚠️ Neither version has githubUrl`);
            hasChanges = true;
            reposRemoved++;
          }
        } else {
          // First occurrence of this repo
          uniqueRepos.set(repo.name, repo);
        }
      }

      // Update project if there were duplicates
      if (hasChanges) {
        project.repositories = Array.from(uniqueRepos.values());
        await project.save();
        console.log(`   💾 Project updated: ${uniqueRepos.size} unique repositories`);
        projectsFixed++;
      } else {
        console.log(`   ✅ No duplicates found`);
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('📊 SUMMARY:');
    console.log(`   Projects fixed: ${projectsFixed}`);
    console.log(`   Duplicate repos removed: ${reposRemoved}`);

    // Special attention to the Test project
    const testProject = await Project.findOne({ name: 'Test' });
    if (testProject) {
      console.log('\n🎯 TEST PROJECT STATUS:');
      console.log(`   Total repositories: ${testProject.repositories.length}`);

      for (const repo of testProject.repositories) {
        console.log(`   📦 ${repo.name}:`);
        console.log(`      - githubUrl: ${repo.githubUrl || '❌ MISSING'}`);
        console.log(`      - owner: ${repo.owner || '❌ MISSING'}`);
        console.log(`      - type: ${repo.type || 'not set'}`);
      }

      // If still missing URLs, provide instructions
      const missingUrls = testProject.repositories.filter(r => !r.githubUrl);
      if (missingUrls.length > 0) {
        console.log('\n⚠️ Some repositories still missing URLs!');
        console.log('Run the fix-repository-urls.js script to add them.');
      }
    }

    await mongoose.disconnect();
    console.log('\n✅ Cleanup completed!');

  } catch (error) {
    console.error('❌ Error:', error.message);
    await mongoose.disconnect();
    process.exit(1);
  }
}

function getCompletenessScore(repo) {
  let score = 0;
  if (repo.githubUrl) score += 10;
  if (repo.owner) score += 5;
  if (repo.type) score += 3;
  if (repo.technologies && repo.technologies.length > 0) score += 2;
  if (repo.branch) score += 1;
  return score;
}

cleanDuplicateRepos();