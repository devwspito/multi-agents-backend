/**
 * TrainingExportScheduler
 *
 * Exporta automáticamente los datos de training para Sentinel Core.
 * Genera archivos JSONL listos para consumo.
 *
 * Configuración via environment variables:
 *   TRAINING_EXPORT_ENABLED=true        (habilitar exportación automática)
 *   TRAINING_EXPORT_INTERVAL_HOURS=24   (cada cuántas horas exportar)
 *   TRAINING_EXPORT_DIR=/path/to/exports (directorio de exportación)
 */

import fs from 'fs';
import path from 'path';
import { trainingExportService } from './TrainingExportService';

export class TrainingExportScheduler {
  private intervalId?: NodeJS.Timeout;
  private exportIntervalHours: number;
  private exportDir: string;
  private enabled: boolean;
  private lastExportDate?: string;

  constructor(exportIntervalHours?: number, exportDir?: string) {
    // Disabled by default - must opt-in
    this.enabled = process.env.TRAINING_EXPORT_ENABLED === 'true';

    this.exportIntervalHours = exportIntervalHours
      ?? parseInt(process.env.TRAINING_EXPORT_INTERVAL_HOURS || '24', 10);

    this.exportDir = exportDir
      ?? process.env.TRAINING_EXPORT_DIR
      ?? path.join(process.cwd(), 'exports', 'training');
  }

  /**
   * Check if auto-export is enabled
   */
  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Start the export scheduler
   */
  public start(): void {
    if (!this.enabled) {
      console.log(`\n📊 Training export scheduler: DISABLED`);
      console.log(`   To enable: TRAINING_EXPORT_ENABLED=true`);
      console.log(`   Use API endpoint: GET /api/training/export\n`);
      return;
    }

    // Ensure export directory exists
    if (!fs.existsSync(this.exportDir)) {
      fs.mkdirSync(this.exportDir, { recursive: true });
    }

    console.log(`\n📊 Training export scheduler: ENABLED`);
    console.log(`   - Export interval: ${this.exportIntervalHours} hour(s)`);
    console.log(`   - Export directory: ${this.exportDir}`);
    console.log(`   - To disable: Remove TRAINING_EXPORT_ENABLED\n`);

    // Run export immediately
    this.runExport();

    // Schedule periodic exports
    const intervalMs = this.exportIntervalHours * 60 * 60 * 1000;
    this.intervalId = setInterval(() => {
      this.runExport();
    }, intervalMs);
  }

  /**
   * Stop the scheduler
   */
  public stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      console.log('📊 Training export scheduler stopped');
    }
  }

  /**
   * Run the export
   */
  private async runExport(): Promise<void> {
    try {
      const now = new Date();
      const today = now.toISOString().split('T')[0];

      // Calculate date range (last 24 hours or since last export)
      const endDate = now.toISOString();
      const startDate = this.lastExportDate
        ? this.lastExportDate
        : new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

      console.log(`📊 Running training data export (${startDate} to ${endDate})...`);

      // Export as JSONL
      const jsonl = await trainingExportService.exportAsJSONL({
        startDate,
        endDate,
        status: 'all',
      });

      if (!jsonl || jsonl.trim() === '') {
        console.log('📊 No new training data to export');
        this.lastExportDate = endDate;
        return;
      }

      // Write to file
      const filename = `training-${today}-${Date.now()}.jsonl`;
      const filepath = path.join(this.exportDir, filename);
      fs.writeFileSync(filepath, jsonl, 'utf-8');

      // Count records
      const recordCount = jsonl.split('\n').filter(line => line.trim()).length;

      console.log(`✅ Training export complete: ${recordCount} records → ${filepath}`);

      // Update last export date
      this.lastExportDate = endDate;

      // Get stats
      const stats = await trainingExportService.getExportStats({ startDate, endDate });
      console.log(`   Stats: ${stats.totalTasks} tasks, ${stats.totalVulnerabilities} vulnerabilities`);

    } catch (error: any) {
      console.error('❌ Training export failed:', error.message);
      // Don't throw - export failures should not crash the app
    }
  }

  /**
   * Manual export trigger
   */
  public async exportNow(options?: {
    startDate?: string;
    endDate?: string;
  }): Promise<string | null> {
    try {
      const now = new Date();
      const endDate = options?.endDate || now.toISOString();
      const startDate = options?.startDate
        || new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(); // Last 7 days

      const jsonl = await trainingExportService.exportAsJSONL({
        startDate,
        endDate,
        status: 'all',
      });

      if (!jsonl || jsonl.trim() === '') {
        return null;
      }

      const filename = `training-manual-${Date.now()}.jsonl`;
      const filepath = path.join(this.exportDir, filename);

      if (!fs.existsSync(this.exportDir)) {
        fs.mkdirSync(this.exportDir, { recursive: true });
      }

      fs.writeFileSync(filepath, jsonl, 'utf-8');
      return filepath;

    } catch (error: any) {
      console.error('❌ Manual export failed:', error.message);
      return null;
    }
  }
}

// Export singleton
export const trainingExportScheduler = new TrainingExportScheduler();
export default trainingExportScheduler;
