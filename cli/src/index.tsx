#!/usr/bin/env node
/**
 * AI Development Team CLI
 *
 * Main entry point for the CLI application
 * Usage: aidev [options]
 *
 * Options:
 *   --api-url <url>  Set the API URL (default: http://localhost:3001)
 *   --help           Show help
 *   --version        Show version
 */

import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import { App } from './App.js';
import { configStore } from './utils/config.js';
import axios from 'axios';

// Parse CLI arguments
const cli = meow(`
  Usage
    $ aidev [command] [options]

  Commands
    connect <url>    Connect to a remote AI Dev Team server
    status           Show current connection status
    disconnect       Logout and disconnect from server

  Options
    --api-url <url>  Set the API URL (default: http://localhost:3001)
    --reset          Reset all stored configuration
    --help           Show this help message
    --version        Show version number

  Examples
    $ aidev                                    # Start interactive CLI
    $ aidev connect https://mycompany.aidev.com  # Connect to company server
    $ aidev status                             # Check connection status
    $ aidev --reset                            # Reset all settings

  AI Development Team - Multi-Agent Orchestration Platform
  Powered by Claude Agent SDK
`, {
  importMeta: import.meta,
  flags: {
    apiUrl: {
      type: 'string',
      shortFlag: 'u',
    },
    reset: {
      type: 'boolean',
      shortFlag: 'r',
    },
  },
});

// Handle commands
const command = cli.input[0];

// Status command - show connection info
if (command === 'status') {
  const apiUrl = configStore.getApiUrl();
  const userName = configStore.getUserName();
  const userEmail = configStore.getUserEmail();
  const isAuth = configStore.isAuthenticated();
  const isGithub = configStore.isGithubConnected();

  console.log('\n🤖 AI Development Team - Connection Status\n');
  console.log(`  Server:     ${apiUrl}`);
  console.log(`  Connected:  ${isAuth ? '✅ Yes' : '❌ No'}`);
  if (isAuth) {
    console.log(`  User:       ${userName || 'Unknown'}`);
    console.log(`  Email:      ${userEmail || 'Unknown'}`);
    console.log(`  GitHub:     ${isGithub ? '✅ Connected' : '⚠️  Not connected'}`);
  }
  console.log('');
  process.exit(0);
}

// Connect command - connect to remote server
if (command === 'connect') {
  const url = cli.input[1];
  if (!url) {
    console.error('❌ Please provide a server URL');
    console.log('   Usage: aidev connect https://yourcompany.aidev.com');
    process.exit(1);
  }

  // Normalize URL
  let apiUrl = url;
  if (!apiUrl.startsWith('http://') && !apiUrl.startsWith('https://')) {
    apiUrl = 'https://' + apiUrl;
  }
  if (!apiUrl.endsWith('/api')) {
    apiUrl = apiUrl.replace(/\/$/, '') + '/api';
  }

  console.log(`\n🔗 Connecting to ${apiUrl}...`);

  // Test connection and exit (don't start the app)
  (async () => {
    try {
      await axios.get(`${apiUrl}/health`, { timeout: 10000 });
      configStore.setApiUrl(apiUrl);
      console.log('✅ Connected successfully!\n');
      console.log('   Run `aidev` to start the interactive CLI');
      console.log('   Run `aidev status` to check your connection\n');
      process.exit(0);
    } catch (err: any) {
      console.error('❌ Failed to connect to server');
      if (err.code === 'ECONNREFUSED') {
        console.log('   The server is not responding. Check the URL and try again.');
      } else if (err.code === 'ENOTFOUND') {
        console.log('   Could not find the server. Check the URL and your internet connection.');
      } else if (err.response?.status === 404) {
        console.log('   Server responded but /api/health endpoint not found.');
        console.log('   Make sure you are connecting to an AI Dev Team server.');
      } else {
        console.log(`   Error: ${err.message}`);
      }
      process.exit(1);
    }
  })();
} else {

  // Disconnect command
  if (command === 'disconnect') {
    configStore.logout();
    console.log('✅ Logged out and disconnected');
    console.log('   Your server URL is still saved. Run `aidev` to reconnect.');
    process.exit(0);
  }

  // Handle reset flag
  if (cli.flags.reset) {
    configStore.clear();
    console.log('✓ Configuration reset successfully');
    process.exit(0);
  }

  // Handle API URL flag
  if (cli.flags.apiUrl) {
    configStore.setApiUrl(cli.flags.apiUrl);
    console.log(`✓ API URL set to: ${cli.flags.apiUrl}`);
  }

  // Clear screen
  console.clear();

  // Render the app
  const { waitUntilExit } = render(<App />);

  // Wait for app to exit
  waitUntilExit().then(() => {
    console.log('\n👋 Goodbye!\n');
    process.exit(0);
  });
}
