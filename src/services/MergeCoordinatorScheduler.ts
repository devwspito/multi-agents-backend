import { MergeCoordinatorService } from './MergeCoordinatorService';

/**
 * MergeCoordinatorScheduler - Ejecuta MergeCoordinator periódicamente
 *
 * Este scheduler corre en background y monitorea constantemente
 * todos los repositorios con tasks activas para detectar y resolver
 * conflictos entre PRs.
 *
 * Frequency: Cada 5 minutos (configurable)
 */
export class MergeCoordinatorScheduler {
  private intervalId?: NodeJS.Timeout;
  private mergeCoordinatorService: MergeCoordinatorService;
  private intervalMinutes: number;
  private isRunning: boolean = false;

  constructor(intervalMinutes: number = 5) {
    this.mergeCoordinatorService = new MergeCoordinatorService();
    this.intervalMinutes = intervalMinutes;
  }

  /**
   * Inicia el scheduler
   */
  public start(): void {
    console.log(`🔀 Merge Coordinator Scheduler started`);
    console.log(`   - Monitoring interval: ${this.intervalMinutes} minute(s)`);

    // Ejecutar inmediatamente al iniciar
    this.runCheck();

    // Ejecutar periódicamente
    const intervalMs = this.intervalMinutes * 60 * 1000;
    this.intervalId = setInterval(() => {
      this.runCheck();
    }, intervalMs);
  }

  /**
   * Detiene el scheduler
   */
  public stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      console.log('🔀 Merge Coordinator Scheduler stopped');
    }
  }

  /**
   * Ejecuta un ciclo de monitoreo
   */
  private async runCheck(): Promise<void> {
    // Evitar ejecuciones concurrentes
    if (this.isRunning) {
      console.log('⏭️ Merge Coordinator already running, skipping this cycle');
      return;
    }

    this.isRunning = true;

    try {
      console.log(`🔀 [${new Date().toISOString()}] Running Merge Coordinator check...`);
      await this.mergeCoordinatorService.monitorAllRepositories();
      console.log(`✅ Merge Coordinator check completed`);
    } catch (error: any) {
      console.error('❌ Merge Coordinator check failed:', error.message);
      // No throw - scheduler debe continuar funcionando
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Ejecuta un check manual (útil para testing)
   */
  public async runManualCheck(): Promise<void> {
    console.log('🔀 Running manual Merge Coordinator check...');
    await this.runCheck();
  }
}
