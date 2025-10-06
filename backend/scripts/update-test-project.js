#!/usr/bin/env node

/**
 * Quick script to update the Test project repositories with GitHub URLs
 */

const https = require('https');

// Production API endpoint
const API_URL = 'https://multi-agents-backend.onrender.com';

function makeRequest(method, path, data = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_URL + path);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }

    const req = https.request(options, (res) => {
      let body = '';

      res.on('data', (chunk) => {
        body += chunk;
      });

      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(`${res.statusCode}: ${parsed.message || body}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse response: ${body}`));
        }
      });
    });

    req.on('error', reject);

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
}

async function updateTestProject() {
  try {
    console.log('🔧 UPDATING TEST PROJECT REPOSITORIES');
    console.log('=' .repeat(60));

    // First, let's try to get projects without auth to see if it works
    console.log('📊 Getting projects list...');

    try {
      const projects = await makeRequest('GET', '/api/projects');
      console.log('✅ Got projects without auth:', projects);
    } catch (error) {
      console.log('⚠️ Could not get projects without auth (expected)');
      console.log('ℹ️ You need to manually update the Test project in the database');
      console.log('\nHere\'s what needs to be updated:');
      console.log('Project: Test');
      console.log('Repositories:');
      console.log('  - opocheckchat: https://github.com/devwspito/opocheckchat');
      console.log('  - opocheckserver: https://github.com/devwspito/opocheckserver');
      console.log('\nYou can update this in MongoDB Atlas or via the API with valid credentials');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

updateTestProject();