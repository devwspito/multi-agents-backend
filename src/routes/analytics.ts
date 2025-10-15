import express, { Request, Response } from 'express';
import { AnalyticsService } from '../services/AnalyticsService';
import { authenticate } from '../middleware/auth';

const router = express.Router();
const analyticsService = new AnalyticsService();

/**
 * GET /api/analytics/dashboard
 * Get system-wide analytics dashboard
 */
router.get('/dashboard', authenticate, async (req: Request, res: Response) => {
  try {
    const period = (req.query.period as 'hour' | 'day' | 'week' | 'month' | 'all') || 'day';

    const dashboard = await analyticsService.getDashboard(period);

    res.json({
      success: true,
      data: dashboard,
    });
  } catch (error: any) {
    console.error('❌ [Analytics API] Error getting dashboard:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/analytics/agents/:agentType
 * Get metrics for a specific agent type
 */
router.get('/agents/:agentType', authenticate, async (req: Request, res: Response) => {
  try {
    const { agentType } = req.params;
    const period = (req.query.period as 'hour' | 'day' | 'week' | 'month' | 'all') || 'day';

    const metrics = await analyticsService.getAgentMetrics(agentType, period);

    res.json({
      success: true,
      data: metrics,
    });
  } catch (error: any) {
    console.error(`❌ [Analytics API] Error getting metrics for ${req.params.agentType}:`, error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/analytics/metrics
 * Get metrics for all agent types
 */
router.get('/metrics', authenticate, async (req: Request, res: Response) => {
  try {
    const period = (req.query.period as 'hour' | 'day' | 'week' | 'month' | 'all') || 'day';

    const allMetrics = await analyticsService.getAllAgentMetrics(period);

    res.json({
      success: true,
      data: allMetrics,
    });
  } catch (error: any) {
    console.error('❌ [Analytics API] Error getting all metrics:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/analytics/cleanup
 * Cleanup old analytics data
 */
router.post('/cleanup', authenticate, async (req: Request, res: Response) => {
  try {
    const { daysToKeep = 90 } = req.body;

    const deletedCount = await analyticsService.cleanupOldData(daysToKeep);

    res.json({
      success: true,
      message: `Cleaned up ${deletedCount} old records`,
      deletedCount,
    });
  } catch (error: any) {
    console.error('❌ [Analytics API] Error cleaning up data:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
