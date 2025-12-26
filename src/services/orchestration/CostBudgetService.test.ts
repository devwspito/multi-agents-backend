/**
 * CostBudgetService Tests
 *
 * Tests cost budget tracking and limits for orchestration
 */

import mongoose from 'mongoose';
import { CostBudgetService } from './CostBudgetService';
import { Task, ITask } from '../../models/Task';

// Mock external dependencies
jest.mock('../NotificationService', () => ({
  NotificationService: {
    emitConsoleLog: jest.fn(),
    emitNotification: jest.fn(),
  },
}));

jest.mock('../logging/LogService', () => ({
  LogService: {
    info: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  },
}));

describe('CostBudgetService', () => {
  const testTaskId = new mongoose.Types.ObjectId().toString();

  // Mock task for testing
  const createMockTask = (totalCost: number): Partial<ITask> => ({
    _id: new mongoose.Types.ObjectId(testTaskId),
    orchestration: {
      currentPhase: 'development' as any,
      completedPhases: [],
      paused: false,
      totalCost,
    } as any,
  });

  beforeEach(() => {
    // Reset task configs between tests
    CostBudgetService.cleanupTaskConfig(testTaskId);
  });

  describe('getDefaultConfig', () => {
    it('should return default configuration', () => {
      const config = CostBudgetService.getDefaultConfig();

      expect(config).toHaveProperty('maxTaskCostUSD');
      expect(config).toHaveProperty('maxPhaseCostUSD');
      expect(config).toHaveProperty('warningThreshold');
      expect(config).toHaveProperty('enableHardStop');
      expect(config.warningThreshold).toBeLessThanOrEqual(1);
      expect(config.warningThreshold).toBeGreaterThan(0);
    });
  });

  describe('setTaskConfig', () => {
    it('should set custom configuration for a task', () => {
      CostBudgetService.setTaskConfig(testTaskId, {
        maxTaskCostUSD: 50,
        maxPhaseCostUSD: 10,
      });

      const mockTask = createMockTask(0);
      const status = CostBudgetService.getBudgetStatus(mockTask as ITask);

      expect(status.limit).toBe(50);
    });
  });

  describe('checkBudgetBeforePhase', () => {
    it('should allow execution when under budget', async () => {
      const mockTask = createMockTask(5); // $5 used

      const result = await CostBudgetService.checkBudgetBeforePhase(
        mockTask as ITask,
        'Developer'
      );

      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should warn when approaching budget threshold', async () => {
      CostBudgetService.setTaskConfig(testTaskId, {
        maxTaskCostUSD: 100,
        warningThreshold: 0.8,
      });

      const mockTask = createMockTask(85); // 85% used

      const result = await CostBudgetService.checkBudgetBeforePhase(
        mockTask as ITask,
        'Developer'
      );

      expect(result.allowed).toBe(true);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('%');
    });

    it('should block when budget exceeded with hard stop enabled', async () => {
      CostBudgetService.setTaskConfig(testTaskId, {
        maxTaskCostUSD: 10,
        enableHardStop: true,
      });

      const mockTask = createMockTask(15); // Exceeded

      const result = await CostBudgetService.checkBudgetBeforePhase(
        mockTask as ITask,
        'Developer'
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('exceeded');
    });

    it('should allow with warning when budget exceeded without hard stop', async () => {
      CostBudgetService.setTaskConfig(testTaskId, {
        maxTaskCostUSD: 10,
        enableHardStop: false,
      });

      const mockTask = createMockTask(15); // Exceeded

      const result = await CostBudgetService.checkBudgetBeforePhase(
        mockTask as ITask,
        'Developer'
      );

      expect(result.allowed).toBe(true);
      expect(result.warning).toBeDefined();
    });

    it('should check projected cost when estimate provided', async () => {
      CostBudgetService.setTaskConfig(testTaskId, {
        maxTaskCostUSD: 20,
        enableHardStop: true,
      });

      const mockTask = createMockTask(15); // $15 used

      const result = await CostBudgetService.checkBudgetBeforePhase(
        mockTask as ITask,
        'Developer',
        10 // Would project to $25, over $20 limit
      );

      expect(result.allowed).toBe(false);
    });
  });

  describe('checkPhaseCost', () => {
    it('should return true when phase cost is within limit', () => {
      CostBudgetService.setTaskConfig(testTaskId, {
        maxPhaseCostUSD: 5,
      });

      const result = CostBudgetService.checkPhaseCost(3, 'Developer', testTaskId);

      expect(result).toBe(true);
    });

    it('should return false when phase cost exceeds limit', () => {
      CostBudgetService.setTaskConfig(testTaskId, {
        maxPhaseCostUSD: 5,
      });

      const result = CostBudgetService.checkPhaseCost(10, 'Developer', testTaskId);

      expect(result).toBe(false);
    });
  });

  describe('getPhaseEstimate', () => {
    it('should return estimates for known phases', () => {
      const developerEstimate = CostBudgetService.getPhaseEstimate('Developer');
      const judgeEstimate = CostBudgetService.getPhaseEstimate('Judge');
      const techLeadEstimate = CostBudgetService.getPhaseEstimate('TechLead');

      expect(developerEstimate).toBeGreaterThan(0);
      expect(judgeEstimate).toBeGreaterThan(0);
      expect(techLeadEstimate).toBeGreaterThan(0);
    });

    it('should return default estimate for unknown phases', () => {
      const unknownEstimate = CostBudgetService.getPhaseEstimate('UnknownPhase');

      expect(unknownEstimate).toBe(0.25); // Default
    });
  });

  describe('getRemainingBudget', () => {
    it('should calculate remaining budget correctly', () => {
      CostBudgetService.setTaskConfig(testTaskId, {
        maxTaskCostUSD: 100,
      });

      const mockTask = createMockTask(30);
      const remaining = CostBudgetService.getRemainingBudget(mockTask as ITask);

      expect(remaining).toBe(70);
    });

    it('should return 0 when budget is exceeded', () => {
      CostBudgetService.setTaskConfig(testTaskId, {
        maxTaskCostUSD: 50,
      });

      const mockTask = createMockTask(60);
      const remaining = CostBudgetService.getRemainingBudget(mockTask as ITask);

      expect(remaining).toBe(0);
    });
  });

  describe('getBudgetStatus', () => {
    it('should return healthy status when under warning threshold', () => {
      CostBudgetService.setTaskConfig(testTaskId, {
        maxTaskCostUSD: 100,
        warningThreshold: 0.8,
      });

      const mockTask = createMockTask(50); // 50%
      const status = CostBudgetService.getBudgetStatus(mockTask as ITask);

      expect(status.status).toBe('healthy');
      expect(status.percentage).toBeCloseTo(50, 0);
    });

    it('should return warning status when approaching threshold', () => {
      CostBudgetService.setTaskConfig(testTaskId, {
        maxTaskCostUSD: 100,
        warningThreshold: 0.8,
      });

      const mockTask = createMockTask(85); // 85%
      const status = CostBudgetService.getBudgetStatus(mockTask as ITask);

      expect(status.status).toBe('warning');
    });

    it('should return critical status when above 90%', () => {
      CostBudgetService.setTaskConfig(testTaskId, {
        maxTaskCostUSD: 100,
      });

      const mockTask = createMockTask(95); // 95%
      const status = CostBudgetService.getBudgetStatus(mockTask as ITask);

      expect(status.status).toBe('critical');
    });

    it('should return exceeded status when over 100%', () => {
      CostBudgetService.setTaskConfig(testTaskId, {
        maxTaskCostUSD: 100,
      });

      const mockTask = createMockTask(110); // 110%
      const status = CostBudgetService.getBudgetStatus(mockTask as ITask);

      expect(status.status).toBe('exceeded');
      expect(status.percentage).toBe(100); // Capped at 100
    });
  });

  describe('formatCost', () => {
    it('should format cost with 4 decimal places', () => {
      const formatted = CostBudgetService.formatCost(1.2345678);

      expect(formatted).toBe('$1.2346');
    });

    it('should handle zero cost', () => {
      const formatted = CostBudgetService.formatCost(0);

      expect(formatted).toBe('$0.0000');
    });
  });

  describe('cleanupTaskConfig', () => {
    it('should remove task-specific configuration', () => {
      CostBudgetService.setTaskConfig(testTaskId, {
        maxTaskCostUSD: 999,
      });

      CostBudgetService.cleanupTaskConfig(testTaskId);

      // After cleanup, should use default config
      const mockTask = createMockTask(0);
      const status = CostBudgetService.getBudgetStatus(mockTask as ITask);

      expect(status.limit).not.toBe(999);
    });
  });
});
