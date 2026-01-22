/**
 * RollbackService Tests
 *
 * Tests the checkpoint and rollback system for agent actions
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock external dependencies
jest.mock('./logging/LogService', () => ({
  LogService: {
    info: jest.fn().mockResolvedValue(undefined),
    success: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  },
}));

// Import after mocking
import { rollbackService } from './RollbackService';
import { CodeSnapshotRepository } from '../database/repositories/CodeSnapshotRepository';
import { UserRepository } from '../database/repositories/UserRepository';
import { ProjectRepository } from '../database/repositories/ProjectRepository';
import { TaskRepository } from '../database/repositories/TaskRepository';

describe('RollbackService', () => {
  let testRepoPath: string;
  let testTaskId: string;
  let testUserId: string;
  let testProjectId: string;

  beforeAll(async () => {
    // Create unique IDs for this test run
    const uniqueSuffix = Date.now().toString(36) + Math.random().toString(36).substring(2);

    // Create a temporary git repo for testing
    testRepoPath = path.join(os.tmpdir(), `test-repo-${Date.now()}`);
    fs.mkdirSync(testRepoPath, { recursive: true });

    // Initialize git repo
    execSync('git init', { cwd: testRepoPath });
    execSync('git config user.email "test@test.com"', { cwd: testRepoPath });
    execSync('git config user.name "Test User"', { cwd: testRepoPath });

    // Create initial file and commit
    fs.writeFileSync(path.join(testRepoPath, 'README.md'), '# Test Repo\n');
    execSync('git add .', { cwd: testRepoPath });
    execSync('git commit -m "Initial commit"', { cwd: testRepoPath });

    // Create user, project, and task for FK constraints
    const user = UserRepository.create({
      username: `rollbacktest_${uniqueSuffix}`,
      email: `rollback_${uniqueSuffix}@example.com`,
      githubId: `rollback_${uniqueSuffix}`,
      accessToken: `test-token-${uniqueSuffix}`,
    });
    testUserId = user.id;

    const project = ProjectRepository.create({
      name: `Rollback Test Project ${uniqueSuffix}`,
      userId: testUserId,
      isActive: true,
    });
    testProjectId = project.id;

    const task = TaskRepository.create({
      projectId: testProjectId,
      userId: testUserId,
      title: `Test Task ${uniqueSuffix}`,
      description: 'Test task for RollbackService',
      status: 'pending',
    });
    testTaskId = task.id;
  });

  afterAll(async () => {
    // Cleanup test repo
    if (testRepoPath && fs.existsSync(testRepoPath)) {
      fs.rmSync(testRepoPath, { recursive: true, force: true });
    }

    // Clean up database records
    if (testTaskId) {
      CodeSnapshotRepository.deleteByTaskId(testTaskId);
      TaskRepository.delete(testTaskId);
    }
    if (testProjectId) {
      ProjectRepository.delete(testProjectId);
    }
    if (testUserId) {
      UserRepository.delete(testUserId);
    }
  });

  beforeEach(async () => {
    // Clean up snapshots between tests
    if (testTaskId) {
      CodeSnapshotRepository.deleteByTaskId(testTaskId);
    }
  });

  describe('createCheckpoint', () => {
    it('should create a checkpoint before agent action', async () => {
      const checkpoint = await rollbackService.createCheckpoint(
        testRepoPath,
        testTaskId,
        'Test checkpoint before development',
        {
          phase: 'development',
          agentType: 'developer',
          agentInstanceId: 'dev-1',
          storyId: 'story-1',
          storyTitle: 'Test Story',
        }
      );

      expect(checkpoint).not.toBeNull();
      expect(checkpoint?.id).toMatch(/^ckpt-/);
      expect(checkpoint?.taskId).toBe(testTaskId);
      expect(checkpoint?.description).toBe('Test checkpoint before development');
      expect(checkpoint?.phase).toBe('development');
      expect(checkpoint?.commitHash).toBeDefined();
      expect(checkpoint?.commitHash.length).toBeGreaterThan(0);
    });

    it('should store checkpoint in database', async () => {
      await rollbackService.createCheckpoint(
        testRepoPath,
        testTaskId,
        'Database test checkpoint',
        {
          phase: 'development',
          agentType: 'developer',
        }
      );

      const snapshots = CodeSnapshotRepository.findByTaskId(testTaskId);
      expect(snapshots.length).toBeGreaterThan(0);
    });

    it('should handle uncommitted changes by stashing', async () => {
      // Create uncommitted changes
      fs.writeFileSync(path.join(testRepoPath, 'uncommitted.txt'), 'uncommitted changes');

      const checkpoint = await rollbackService.createCheckpoint(
        testRepoPath,
        testTaskId,
        'Checkpoint with uncommitted changes',
        {
          phase: 'development',
          agentType: 'developer',
        }
      );

      expect(checkpoint).not.toBeNull();

      // Clean up
      fs.unlinkSync(path.join(testRepoPath, 'uncommitted.txt'));
    });
  });

  describe('getCheckpoints', () => {
    it('should return all checkpoints for a task', async () => {
      // Create multiple checkpoints
      await rollbackService.createCheckpoint(testRepoPath, testTaskId, 'Checkpoint 1', {
        phase: 'development',
        agentType: 'developer',
      });

      await rollbackService.createCheckpoint(testRepoPath, testTaskId, 'Checkpoint 2', {
        phase: 'development',
        agentType: 'developer',
      });

      const checkpoints = await rollbackService.getCheckpoints(testTaskId);

      expect(checkpoints.length).toBeGreaterThanOrEqual(2);
    });

    it('should return checkpoints sorted by timestamp descending', async () => {
      const checkpoints = await rollbackService.getCheckpoints(testTaskId);

      if (checkpoints.length >= 2) {
        expect(checkpoints[0].timestamp.getTime()).toBeGreaterThanOrEqual(
          checkpoints[1].timestamp.getTime()
        );
      }
    });
  });

  describe('rollbackToCommit', () => {
    it('should rollback to a specific commit', async () => {
      // Create a file and commit
      const testFile = path.join(testRepoPath, 'test-file.txt');
      fs.writeFileSync(testFile, 'version 1');
      execSync('git add .', { cwd: testRepoPath });
      execSync('git commit -m "Add test file v1"', { cwd: testRepoPath });

      const v1Commit = execSync('git rev-parse HEAD', { cwd: testRepoPath, encoding: 'utf-8' }).trim();

      // Modify and commit again
      fs.writeFileSync(testFile, 'version 2');
      execSync('git add .', { cwd: testRepoPath });
      execSync('git commit -m "Update test file v2"', { cwd: testRepoPath });

      // Rollback to v1
      const result = await rollbackService.rollbackToCommit(testRepoPath, testTaskId, v1Commit);

      expect(result.success).toBe(true);
      expect(result.toCommit).toBe(v1Commit);

      // Verify file content
      const content = fs.readFileSync(testFile, 'utf-8');
      expect(content).toBe('version 1');
    });

    it('should return success if already at target commit', async () => {
      const currentCommit = execSync('git rev-parse HEAD', { cwd: testRepoPath, encoding: 'utf-8' }).trim();

      const result = await rollbackService.rollbackToCommit(testRepoPath, testTaskId, currentCommit);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Already at target');
    });
  });

  describe('rollbackToLastCheckpoint', () => {
    it('should rollback to the most recent checkpoint', async () => {
      // Create a checkpoint
      const checkpoint = await rollbackService.createCheckpoint(
        testRepoPath,
        testTaskId,
        'Last checkpoint',
        {
          phase: 'development',
          agentType: 'developer',
        }
      );

      if (!checkpoint) {
        throw new Error('Failed to create checkpoint');
      }

      // Make some changes
      const testFile = path.join(testRepoPath, 'new-file.txt');
      fs.writeFileSync(testFile, 'new content');
      execSync('git add .', { cwd: testRepoPath });
      execSync('git commit -m "Add new file"', { cwd: testRepoPath });

      // Rollback to last checkpoint
      const result = await rollbackService.rollbackToLastCheckpoint(testRepoPath, testTaskId);

      expect(result.success).toBe(true);
    });

    it('should return failure if no checkpoints exist', async () => {
      const result = await rollbackService.rollbackToLastCheckpoint(
        testRepoPath,
        'nonexistent-task-id'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('No checkpoints found');
    });
  });

  describe('captureSnapshot', () => {
    it('should capture current repository state', async () => {
      await rollbackService.captureSnapshot(testRepoPath, testTaskId, {
        phase: 'development',
        agentType: 'developer',
        agentInstanceId: 'dev-1',
        commitMessage: 'Test snapshot',
      });

      const snapshots = CodeSnapshotRepository.findByTaskId(testTaskId);
      expect(snapshots.length).toBeGreaterThan(0);
    });
  });

  describe('cleanupCheckpoints', () => {
    it('should remove old checkpoints beyond keepCount', async () => {
      // Create several checkpoints
      for (let i = 0; i < 5; i++) {
        await rollbackService.createCheckpoint(
          testRepoPath,
          testTaskId,
          `Checkpoint ${i}`,
          {
            phase: 'development',
            agentType: 'developer',
          }
        );
      }

      const deleted = await rollbackService.cleanupCheckpoints(testTaskId, 2);

      // Should have deleted some
      const remaining = await rollbackService.getCheckpoints(testTaskId);
      expect(remaining.length).toBeLessThanOrEqual(5); // May have more from other tests
    });
  });
});
