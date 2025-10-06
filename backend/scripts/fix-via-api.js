#!/usr/bin/env node

/**
 * Script to fix repository URLs via the production API
 */

const axios = require('axios');

const API_URL = 'https://multi-agents-backend.onrender.com';

async function fixRepositoryUrls() {
  try {
    console.log('🔧 FIXING REPOSITORY URLs VIA API');
    console.log('=' .repeat(60));

    // Login first (you need to provide credentials)
    const loginResponse = await axios.post(`${API_URL}/api/auth/login`, {
      email: 'admin@admin.com', // Replace with actual credentials
      password: 'Admin@123'
    });

    const token = loginResponse.data.token;
    console.log('✅ Logged in successfully');

    // Get all projects
    const projectsResponse = await axios.get(`${API_URL}/api/projects`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const projects = projectsResponse.data.projects;
    console.log(`📊 Found ${projects.length} projects to check`);

    for (const project of projects) {
      console.log(`\n📁 Project: ${project.name}`);

      if (project.repositories && project.repositories.length > 0) {
        console.log(`  📚 Has ${project.repositories.length} repositories`);

        let needsUpdate = false;
        const updatedRepositories = [];

        for (const repo of project.repositories) {
          console.log(`    📦 Repository: ${repo.name}`);

          if (!repo.githubUrl) {
            console.log(`      ❌ Missing githubUrl!`);

            // For the Test project, set specific URLs
            if (project.name === 'Test') {
              const repoUrls = {
                'opocheckchat': 'https://github.com/devwspito/opocheckchat',
                'opocheckserver': 'https://github.com/devwspito/opocheckserver'
              };

              if (repoUrls[repo.name]) {
                repo.githubUrl = repoUrls[repo.name];
                repo.owner = 'devwspito';
                needsUpdate = true;
                console.log(`      ✅ Set URL to ${repoUrls[repo.name]}`);
              }
            }
          } else {
            console.log(`      ✅ githubUrl exists: ${repo.githubUrl}`);
          }

          updatedRepositories.push(repo);
        }

        // Update project if needed
        if (needsUpdate) {
          try {
            const updateResponse = await axios.put(
              `${API_URL}/api/projects/${project._id}`,
              { repositories: updatedRepositories },
              { headers: { Authorization: `Bearer ${token}` } }
            );
            console.log(`  💾 Updated project successfully`);
          } catch (error) {
            console.error(`  ❌ Failed to update project: ${error.message}`);
          }
        }
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ Done!');

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
    process.exit(1);
  }
}

fixRepositoryUrls();