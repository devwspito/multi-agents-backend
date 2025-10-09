import { GitHubService } from './GitHubService';
import path from 'path';
import os from 'os';

/**
 * WorkspaceCleanupScheduler - Limpia workspaces antiguos periódicamente
 *
 * Previene acumulación de workspaces temporales que consumen disco.
 * Por defecto, elimina workspaces con más de 24 horas de antigüedad.
 */
export class WorkspaceCleanupScheduler {
  private intervalId?: NodeJS.Timeout;
  private githubService: GitHubService;
  private cleanupIntervalHours: number;
  private maxWorkspaceAgeHours: number;

  constructor(
    cleanupIntervalHours: number = 1, // Ejecutar cada 1 hora
    maxWorkspaceAgeHours: number = 24  // Eliminar workspaces > 24 horas
  ) {
    const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
    this.githubService = new GitHubService(workspaceDir);
    this.cleanupIntervalHours = cleanupIntervalHours;
    this.maxWorkspaceAgeHours = maxWorkspaceAgeHours;
  }

  /**
   * Inicia el scheduler de limpieza
   */
  public start(): void {
    console.log(`🧹 Workspace cleanup scheduler started`);
    console.log(`   - Cleanup interval: ${this.cleanupIntervalHours} hour(s)`);
    console.log(`   - Max workspace age: ${this.maxWorkspaceAgeHours} hour(s)`);

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
