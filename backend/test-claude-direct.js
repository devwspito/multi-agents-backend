#!/usr/bin/env node

/**
 * TEST DIRECTO DE CLAUDE CODE
 * Si esto no funciona, nada funcionará
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

const execAsync = promisify(exec);

async function testClaude() {
  console.log('🔥 TESTING CLAUDE CODE DIRECTLY');
  console.log('=' .repeat(60));

  // Test 1: Check if claude command exists
  console.log('\n1️⃣ Testing: npx @anthropic-ai/claude-code --version');
  try {
    const { stdout } = await execAsync('npx @anthropic-ai/claude-code --version');
    console.log(`✅ Claude Code version: ${stdout.trim()}`);
  } catch (error) {
    console.error('❌ FAILED:', error.message);
    process.exit(1);
  }

  // Test 2: Execute a simple command with Claude
  console.log('\n2️⃣ Testing: Execute simple command with Claude');

  const testDir = path.join(process.cwd(), 'test-claude-workspace');
  await fs.mkdir(testDir, { recursive: true });

  const instructions = `List the files in the current directory and tell me what you see.`;
  const instructionFile = path.join(testDir, 'test.txt');
  await fs.writeFile(instructionFile, instructions);

  const command = `ANTHROPIC_API_KEY="${process.env.ANTHROPIC_API_KEY}" npx @anthropic-ai/claude-code --print --model "sonnet" < "${instructionFile}"`;

  console.log('📝 Command:', command);

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: testDir,
      timeout: 30000
    });

    console.log('✅ CLAUDE CODE EXECUTED SUCCESSFULLY!');
    console.log('Output:', stdout.substring(0, 200));

    if (stderr) {
      console.log('Stderr:', stderr);
    }
  } catch (error) {
    console.error('❌ EXECUTION FAILED:', error.message);
    if (error.stderr) {
      console.error('Error output:', error.stderr);
    }
    process.exit(1);
  }

  // Clean up
  await fs.rm(testDir, { recursive: true, force: true });

  console.log('\n' + '='.repeat(60));
  console.log('✅ ALL TESTS PASSED - CLAUDE CODE WORKS!');
}

testClaude().catch(console.error);