/**
 * Training Data Export Routes
 *
 * API endpoints for Sentinel Core to consume training data.
 * Exports the combined table: { success, vulnerabilities, recommendations }
 */

import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { trainingExportService } from '../services/training/TrainingExportService';

const router = express.Router();

/**
 * GET /api/training/export/:taskId
 * Export training data for a single task
 *
 * Returns: { success, vulnerabilities, recommendations }
 */
router.get('/export/:taskId', authenticate, async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;

    const record = await trainingExportService.exportTask(taskId);

    res.json({
      success: true,
      data: record,
    });
  } catch (error: any) {
    console.error(`❌ [Training API] Error exporting task ${req.params.taskId}:`, error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/training/export
 * Export training data batch (for Sentinel Core)
 *
 * Query params:
 * - startDate: ISO date string (optional)
 * - endDate: ISO date string (optional)
 * - status: 'completed' | 'failed' | 'all' (default: 'all')
 * - minVulnerabilities: number (optional)
 * - excludeFalsePositives: boolean (default: false)
 * - limit: number (default: 100)
 * - offset: number (default: 0)
 * - format: 'json' | 'jsonl' (default: 'json')
 *
 * Returns: Array of { success, vulnerabilities, recommendations }
 */
router.get('/export', authenticate, async (req: Request, res: Response) => {
  try {
    const {
      startDate,
      endDate,
      status = 'all',
      minVulnerabilities,
      excludeFalsePositives,
      limit = '100',
      offset = '0',
      format = 'json',
    } = req.query;

    const options = {
      startDate: startDate as string | undefined,
      endDate: endDate as string | undefined,
      status: status as 'completed' | 'failed' | 'all',
      minVulnerabilities: minVulnerabilities ? parseInt(minVulnerabilities as string) : undefined,
      excludeFalsePositives: excludeFalsePositives === 'true',
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
    };

    if (format === 'jsonl') {
      // JSONL format for streaming
      const jsonl = await trainingExportService.exportAsJSONL(options);
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Content-Disposition', 'attachment; filename="training-data.jsonl"');
      res.send(jsonl);
    } else {
      // JSON array format
      const records = await trainingExportService.exportBatch(options);
      res.json({
        success: true,
        count: records.length,
        data: records,
      });
    }
  } catch (error: any) {
    console.error('❌ [Training API] Error exporting batch:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/training/stats
 * Get export statistics
 *
 * Query params:
 * - startDate: ISO date string (optional)
 * - endDate: ISO date string (optional)
 */
router.get('/stats', authenticate, async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.query;

    const stats = await trainingExportService.getExportStats({
      startDate: startDate as string | undefined,
      endDate: endDate as string | undefined,
    });

    res.json({
      success: true,
      data: stats,
    });
  } catch (error: any) {
    console.error('❌ [Training API] Error getting stats:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
