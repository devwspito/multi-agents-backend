#!/usr/bin/env node

/**
 * Script to fix missing repository URLs in existing projects
 * The model has githubUrl field but it's not being populated
 */

const mongoose = require('mongoose');
const Project = require('../src/models/Project');
require('dotenv').config();

async function fixRepositoryUrls() {
  try {
    console.log('🔧 FIXING REPOSITORY URLs IN PROJECTS');
    console.log('='.repeat(60));

    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Get all projects
    const projects = await Project.find({});
    console.log(`📊 Found ${projects.length} projects to check`);

    let updated = 0;
    let needsManualUpdate = [];

    for (const project of projects) {
      console.log(`\n📁 Project: ${project.name}`);

      // Check main repository field
      if (project.repository?.url) {
        console.log(`  ✅ Main repository URL exists: ${project.repository.url}`);
      }

      // Check multi-repository support
      if (project.repositories && project.repositories.length > 0) {
        console.log(`  📚 Has ${project.repositories.length} repositories`);

        for (let i = 0; i < project.repositories.length; i++) {
          const repo = project.repositories[i];
          console.log(`    📦 Repository: ${repo.name}`);

          if (!repo.githubUrl) {
            console.log(`      ❌ Missing githubUrl!`);

            // Try to construct URL if we have owner info
            if (repo.owner && repo.name) {
              const guessedUrl = `https://github.com/${repo.owner}/${repo.name}`;
              console.log(`      💡 Guessing URL: ${guessedUrl}`);

              // Update the repository
              project.repositories[i].githubUrl = guessedUrl;
              updated++;
            } else {
              console.log(`      ⚠️ Cannot construct URL - missing owner or name`);
              needsManualUpdate.push({
                project: project.name,
                repository: repo.name,
                projectId: project._id
              });
            }
          } else {
            console.log(`      ✅ githubUrl exists: ${repo.githubUrl}`);
          }
        }

        // Save if we made changes
        if (updated > 0) {
          await project.save();
          console.log(`  💾 Saved project with updated URLs`);
        }
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('📊 SUMMARY:');
    console.log(`  ✅ Updated ${updated} repository URLs`);
    console.log(`  ⚠️ ${needsManualUpdate.length} repositories need manual update`);

    if (needsManualUpdate.length > 0) {
      console.log('\n⚠️ NEED MANUAL UPDATE:');
      needsManualUpdate.forEach(item => {
        console.log(`  - Project: ${item.project}, Repo: ${item.repository}`);
        console.log(`    Run: node scripts/update-project-repository.js "${item.project}" "GITHUB_URL_HERE"`);
      });
    }

    // For the Test project specifically
    const testProject = await Project.findOne({ name: 'Test' });
    if (testProject) {
      console.log('\n🎯 UPDATING TEST PROJECT:');

      // Set URLs for Test project repositories
      const repoUrls = {
        'opocheckchat': 'https://github.com/devwspito/opocheckchat',
        'opocheckserver': 'https://github.com/devwspito/opocheckserver'
      };

      for (let i = 0; i < testProject.repositories.length; i++) {
        const repo = testProject.repositories[i];
        if (repoUrls[repo.name]) {
          testProject.repositories[i].githubUrl = repoUrls[repo.name];
          testProject.repositories[i].owner = 'devwspito';
          console.log(`  ✅ Set ${repo.name} URL to ${repoUrls[repo.name]}`);
        }
      }

      await testProject.save();
      console.log('  💾 Test project updated successfully');
    }

    await mongoose.disconnect();
    console.log('\n✅ Done!');

  } catch (error) {
    console.error('❌ Error:', error.message);
    await mongoose.disconnect();
    process.exit(1);
  }
}

fixRepositoryUrls();