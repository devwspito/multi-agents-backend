import { GitHubService } from './GitHubService';
import path from 'path';
import os from 'os';

/**
 * WorkspaceCleanupScheduler - Limpia workspaces antiguos periódicamente
 *
 * Previene acumulación de workspaces temporales que consumen disco.
 * Por defecto, elimina workspaces con más de 24 horas de antigüedad.
 *
 * ⚠️ DISABLED BY DEFAULT - El cliente debe activarlo explícitamente con:
 *    WORKSPACE_AUTO_CLEANUP_ENABLED=true
 *
 * Configuración adicional:
 *    WORKSPACE_CLEANUP_INTERVAL_HOURS=1   (cada cuántas horas ejecutar)
 *    WORKSPACE_MAX_AGE_HOURS=24           (máxima antigüedad antes de eliminar)
 */
export class WorkspaceCleanupScheduler {
  private intervalId?: NodeJS.Timeout;
  private githubService: GitHubService;
  private cleanupIntervalHours: number;
  private maxWorkspaceAgeHours: number;
  private enabled: boolean;

  constructor(
    cleanupIntervalHours?: number,
    maxWorkspaceAgeHours?: number
  ) {
    const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
    this.githubService = new GitHubService(workspaceDir);

    // 🔥 DISABLED BY DEFAULT - Client must opt-in
    this.enabled = process.env.WORKSPACE_AUTO_CLEANUP_ENABLED === 'true';

    // Configurable via environment variables
    this.cleanupIntervalHours = cleanupIntervalHours
      ?? parseInt(process.env.WORKSPACE_CLEANUP_INTERVAL_HOURS || '1', 10);
    this.maxWorkspaceAgeHours = maxWorkspaceAgeHours
      ?? parseInt(process.env.WORKSPACE_MAX_AGE_HOURS || '168', 10); // Default: 7 days (168 hours)
  }

  /**
   * Check if auto-cleanup is enabled
   */
  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Inicia el scheduler de limpieza
   */
  public start(): void {
    // 🔥 CRITICAL: Check if cleanup is enabled
    if (!this.enabled) {
      console.log(`\n🧹 Workspace cleanup scheduler: DISABLED`);
      console.log(`   To enable automatic cleanup, set: WORKSPACE_AUTO_CLEANUP_ENABLED=true`);
      console.log(`   Workspaces will NOT be automatically deleted.`);
      console.log(`   Client can manually clean via API: DELETE /api/cleanup/workspace/{taskId}\n`);
      return;
    }

    console.log(`\n🧹 Workspace cleanup scheduler: ENABLED`);
    console.log(`   - Cleanup interval: ${this.cleanupIntervalHours} hour(s)`);
    console.log(`   - Max workspace age: ${this.maxWorkspaceAgeHours} hour(s)`);
    console.log(`   - To disable: Remove WORKSPACE_AUTO_CLEANUP_ENABLED or set to false\n`);

    // Ejecutar limpieza inmediatamente al iniciar
    this.runCleanup();

    // Ejecutar limpieza periódicamente
    const intervalMs = this.cleanupIntervalHours * 60 * 60 * 1000;
    this.intervalId = setInterval(() => {
      this.runCleanup();
    }, intervalMs);
  }

  /**
   * Detiene el scheduler de limpieza
   */
  public stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      console.log('🧹 Workspace cleanup scheduler stopped');
    }
  }

  /**
   * Ejecuta la limpieza de workspaces antiguos
   */
  private async runCleanup(): Promise<void> {
    try {
      console.log(`🧹 Running workspace cleanup (max age: ${this.maxWorkspaceAgeHours}h)...`);
      await this.githubService.cleanupOldWorkspaces(this.maxWorkspaceAgeHours);
      console.log('✅ Workspace cleanup completed');
    } catch (error: any) {
      console.error('❌ Workspace cleanup failed:', error.message);
      // No throw - cleanup failures should not crash the app
    }
  }
}
