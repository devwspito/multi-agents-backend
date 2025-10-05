#!/usr/bin/env node

const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

const execAsync = promisify(exec);

async function testFinal() {
  console.log('🔥 TESTING FINAL CLAUDE CODE SETUP');
  console.log('=' .repeat(60));

  const testDir = path.resolve(process.cwd(), 'test-workspace-final');
  await fs.mkdir(testDir, { recursive: true });

  const instructions = `You are a senior developer. Tell me what directory you are in and list the files.`;
  const instructionFile = path.resolve(testDir, 'instructions.txt');
  await fs.writeFile(instructionFile, instructions);

  // This is EXACTLY how ClaudeService.js will run it
  const CLAUDE_CODE_CLI = 'npx claude';
  const model = 'sonnet';
  const command = `ANTHROPIC_API_KEY="${process.env.ANTHROPIC_API_KEY}" ${CLAUDE_CODE_CLI} --print --model "${model}" < "${instructionFile}"`;

  console.log('📝 Command:', command);
  console.log('🔑 API Key:', process.env.ANTHROPIC_API_KEY ? 'Set' : 'NOT SET');

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: testDir,
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024
    });

    console.log('\n✅ SUCCESS! Claude Code works!');
    console.log('Output:', stdout.substring(0, 500));

  } catch (error) {
    console.error('\n❌ FAILED:', error.message);
    process.exit(1);
  }

  // Clean up
  await fs.rm(testDir, { recursive: true, force: true });
  console.log('\n✅ TEST PASSED - READY TO DEPLOY');
}

testFinal().catch(console.error);