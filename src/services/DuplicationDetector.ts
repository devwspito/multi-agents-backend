/**
 * 🔍 DUPLICATION DETECTOR
 * Previene que los agents reimplementen código que ya existe
 * Analiza el código existente antes de implementar
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execAsync = promisify(exec);

interface ExistingFeature {
  type: 'endpoint' | 'component' | 'function' | 'class' | 'file';
  name: string;
  path: string;
  signature?: string;
  description?: string;
  confidence: number; // 0-100
}

interface DuplicationCheck {
  isDuplicate: boolean;
  confidence: number;
  existingFeatures: ExistingFeature[];
  suggestions: string[];
  warning?: string;
}

export class DuplicationDetector {
  /**
   * Analiza si una tarea ya está implementada
   */
  async checkForExistingImplementation(
    taskDescription: string,
    workspacePath: string
  ): Promise<DuplicationCheck> {
    console.log(`\n🔍 [DuplicationDetector] Analyzing existing code...`);

    const features: ExistingFeature[] = [];
    const keywords = this.extractKeywords(taskDescription);

    // 1. Buscar endpoints existentes
    if (this.looksLikeEndpoint(taskDescription)) {
      const endpoints = await this.findExistingEndpoints(workspacePath, keywords);
      features.push(...endpoints);
    }

    // 2. Buscar componentes React/Vue existentes
    if (this.looksLikeComponent(taskDescription)) {
      const components = await this.findExistingComponents(workspacePath, keywords);
      features.push(...components);
    }

    // 3. Buscar funciones/clases existentes
    const functions = await this.findExistingFunctions(workspacePath, keywords);
    features.push(...functions);

    // 4. Buscar archivos con nombres similares
    const files = await this.findSimilarFiles(workspacePath, keywords);
    features.push(...files);

    // Calcular si es duplicación
    const isDuplicate = this.calculateIsDuplicate(features);
    const confidence = this.calculateConfidence(features);

    // Generar sugerencias
    const suggestions = this.generateSuggestions(features, taskDescription);

    // Generar warning si es alta probabilidad de duplicación
    const warning = confidence > 70
      ? `⚠️ HIGH PROBABILITY: This feature already exists! ${features.length} matching implementations found.`
      : confidence > 40
      ? `⚠️ POSSIBLE DUPLICATION: Similar features found. Verify before implementing.`
      : undefined;

    const result = {
      isDuplicate,
      confidence,
      existingFeatures: features,
      suggestions,
      warning
    };

    if (warning) {
      console.log(`\n${warning}`);
      console.log(`Found ${features.length} potentially existing implementations:`);
      features.forEach(f => {
        console.log(`  - ${f.type}: ${f.name} in ${f.path} (${f.confidence}% match)`);
      });
    }

    return result;
  }

  /**
   * Busca endpoints API existentes
   */
  private async findExistingEndpoints(
    workspacePath: string,
    keywords: string[]
  ): Promise<ExistingFeature[]> {
    const features: ExistingFeature[] = [];

    try {
      // Buscar rutas Express/FastAPI/etc
      const patterns = [
        'router\\.(get|post|put|delete|patch)\\s*\\(',
        'app\\.(get|post|put|delete|patch)\\s*\\(',
        '@(Get|Post|Put|Delete|Patch)\\(',
        '@app\\.route\\(',
      ];

      for (const keyword of keywords) {
        for (const pattern of patterns) {
          try {
            const { stdout } = await execAsync(
              `grep -r -E "${pattern}.*${keyword}" --include="*.js" --include="*.ts" --include="*.jsx" --include="*.tsx" --include="*.py" . 2>/dev/null | head -20`,
              { cwd: workspacePath }
            );

            const lines = stdout.trim().split('\n').filter(l => l);

            for (const line of lines) {
              const [filePath, ...codeParts] = line.split(':');
              const code = codeParts.join(':');

              // Extraer ruta del endpoint
              const routeMatch = code.match(/['"`](\/[^'"`]*)['"`)]/);
              if (routeMatch) {
                features.push({
                  type: 'endpoint',
                  name: routeMatch[1],
                  path: filePath,
                  signature: code.trim(),
                  confidence: this.calculateKeywordMatch(code, keywords)
                });
              }
            }
          } catch (e) {
            // Grep no encontró nada, está bien
          }
        }
      }
    } catch (error) {
      console.log(`  ⚠️ Could not search for endpoints: ${error}`);
    }

    return features;
  }

  /**
   * Busca componentes existentes
   */
  private async findExistingComponents(
    workspacePath: string,
    keywords: string[]
  ): Promise<ExistingFeature[]> {
    const features: ExistingFeature[] = [];

    try {
      for (const keyword of keywords) {
        // React/Vue/Angular components
        const patterns = [
          `(function|const|class)\\s+${keyword}`,
          `export.*${keyword}`,
          `<${keyword}[\\s/>]`,
        ];

        for (const pattern of patterns) {
          try {
            const { stdout } = await execAsync(
              `grep -r -E "${pattern}" --include="*.jsx" --include="*.tsx" --include="*.vue" --include="*.js" --include="*.ts" . 2>/dev/null | head -10`,
              { cwd: workspacePath }
            );

            const lines = stdout.trim().split('\n').filter(l => l);

            for (const line of lines) {
              const [filePath] = line.split(':');

              // Verificar si es realmente un componente
              if (filePath.includes('component') || filePath.includes('Component') ||
                  filePath.includes('.jsx') || filePath.includes('.tsx') || filePath.includes('.vue')) {
                features.push({
                  type: 'component',
                  name: keyword,
                  path: filePath,
                  confidence: 80 // Alta confianza para componentes con nombre exacto
                });
              }
            }
          } catch (e) {
            // No encontró nada
          }
        }
      }
    } catch (error) {
      console.log(`  ⚠️ Could not search for components: ${error}`);
    }

    return features;
  }

  /**
   * Busca funciones/clases existentes
   */
  private async findExistingFunctions(
    workspacePath: string,
    keywords: string[]
  ): Promise<ExistingFeature[]> {
    const features: ExistingFeature[] = [];

    try {
      for (const keyword of keywords) {
        const patterns = [
          `(function|const|let|var)\\s+${keyword}\\s*[=(]`,
          `class\\s+${keyword}`,
          `def\\s+${keyword}\\s*\\(`,
        ];

        for (const pattern of patterns) {
          try {
            const { stdout } = await execAsync(
              `grep -r -E "${pattern}" --include="*.js" --include="*.ts" --include="*.py" --include="*.java" . 2>/dev/null | head -10`,
              { cwd: workspacePath }
            );

            const lines = stdout.trim().split('\n').filter(l => l);

            for (const line of lines) {
              const [filePath, ...codeParts] = line.split(':');
              const code = codeParts.join(':');

              const type = code.includes('class') ? 'class' : 'function';

              features.push({
                type,
                name: keyword,
                path: filePath,
                signature: code.trim(),
                confidence: this.calculateKeywordMatch(code, keywords)
              });
            }
          } catch (e) {
            // No encontró nada
          }
        }
      }
    } catch (error) {
      console.log(`  ⚠️ Could not search for functions: ${error}`);
    }

    return features;
  }

  /**
   * Busca archivos con nombres similares
   */
  private async findSimilarFiles(
    workspacePath: string,
    keywords: string[]
  ): Promise<ExistingFeature[]> {
    const features: ExistingFeature[] = [];

    try {
      for (const keyword of keywords) {
        const { stdout } = await execAsync(
          `find . -type f -iname "*${keyword}*" 2>/dev/null | grep -v node_modules | grep -v ".git" | head -20`,
          { cwd: workspacePath }
        );

        const files = stdout.trim().split('\n').filter(f => f);

        for (const file of files) {
          features.push({
            type: 'file',
            name: path.basename(file),
            path: file,
            confidence: 60 // Confianza media para archivos con nombre similar
          });
        }
      }
    } catch (error) {
      console.log(`  ⚠️ Could not search for files: ${error}`);
    }

    return features;
  }

  /**
   * Extrae palabras clave de la descripción
   */
  private extractKeywords(description: string): string[] {
    // Remover palabras comunes
    const stopWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
                       'create', 'implement', 'add', 'make', 'build', 'develop', 'need', 'want'];

    // Extraer palabras significativas
    const words = description
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.includes(w));

    // Extraer posibles nombres de endpoints/componentes
    const camelCaseMatches = description.match(/[A-Z][a-z]+|[a-z]+/g) || [];
    const snakeCaseMatches = description.match(/[a-z]+_[a-z]+/g) || [];
    const kebabCaseMatches = description.match(/[a-z]+-[a-z]+/g) || [];

    // Combinar todo y eliminar duplicados
    const allKeywords = [
      ...words,
      ...camelCaseMatches.map(m => m.toLowerCase()),
      ...snakeCaseMatches,
      ...kebabCaseMatches
    ];

    return [...new Set(allKeywords)].slice(0, 10); // Máximo 10 keywords
  }

  /**
   * Detecta si la tarea parece ser un endpoint
   */
  private looksLikeEndpoint(description: string): boolean {
    const endpointKeywords = ['api', 'endpoint', 'route', 'rest', 'get', 'post', 'put', 'delete',
                              'fetch', 'request', 'response', 'http', '/api/', 'controller'];
    const lower = description.toLowerCase();
    return endpointKeywords.some(k => lower.includes(k));
  }

  /**
   * Detecta si la tarea parece ser un componente UI
   */
  private looksLikeComponent(description: string): boolean {
    const componentKeywords = ['component', 'button', 'modal', 'form', 'input', 'card', 'list',
                               'table', 'header', 'footer', 'navbar', 'sidebar', 'page', 'view',
                               'widget', 'dialog', 'dropdown', 'menu'];
    const lower = description.toLowerCase();
    return componentKeywords.some(k => lower.includes(k));
  }

  /**
   * Calcula qué tan bien coinciden las palabras clave
   */
  private calculateKeywordMatch(text: string, keywords: string[]): number {
    const lower = text.toLowerCase();
    const matches = keywords.filter(k => lower.includes(k)).length;
    return Math.min(100, (matches / keywords.length) * 100);
  }

  /**
   * Determina si es una duplicación
   */
  private calculateIsDuplicate(features: ExistingFeature[]): boolean {
    // Si hay alguna feature con alta confianza
    if (features.some(f => f.confidence > 80)) return true;

    // Si hay múltiples features con confianza media
    const mediumConfidence = features.filter(f => f.confidence > 50);
    if (mediumConfidence.length >= 3) return true;

    return false;
  }

  /**
   * Calcula la confianza general
   */
  private calculateConfidence(features: ExistingFeature[]): number {
    if (features.length === 0) return 0;

    // Promedio ponderado de confianzas
    const totalConfidence = features.reduce((sum, f) => sum + f.confidence, 0);
    const avgConfidence = totalConfidence / features.length;

    // Bonus por cantidad de features encontradas
    const quantityBonus = Math.min(20, features.length * 5);

    return Math.min(100, avgConfidence + quantityBonus);
  }

  /**
   * Genera sugerencias basadas en lo encontrado
   */
  private generateSuggestions(features: ExistingFeature[], task: string): string[] {
    const suggestions: string[] = [];

    if (features.length === 0) {
      suggestions.push('✅ No existing implementation found. Safe to proceed.');
      return suggestions;
    }

    // Agrupar por tipo
    const byType = features.reduce((acc, f) => {
      if (!acc[f.type]) acc[f.type] = [];
      acc[f.type].push(f);
      return acc;
    }, {} as Record<string, ExistingFeature[]>);

    // Sugerencias por tipo
    if (byType.endpoint) {
      suggestions.push(`📡 Found ${byType.endpoint.length} existing endpoint(s). Consider reusing or extending them.`);
      byType.endpoint.slice(0, 3).forEach(e => {
        suggestions.push(`   - ${e.name} in ${e.path}`);
      });
    }

    if (byType.component) {
      suggestions.push(`🎨 Found ${byType.component.length} existing component(s). Check if they meet your needs.`);
      byType.component.slice(0, 3).forEach(c => {
        suggestions.push(`   - ${c.name} in ${c.path}`);
      });
    }

    if (byType.function || byType.class) {
      const count = (byType.function?.length || 0) + (byType.class?.length || 0);
      suggestions.push(`📦 Found ${count} existing function(s)/class(es) with similar names.`);
    }

    // Sugerencia general
    if (this.calculateIsDuplicate(features)) {
      suggestions.push(`\n⚠️ RECOMMENDATION: Review existing code before implementing. High chance of duplication!`);
      suggestions.push(`💡 Consider: Extending, refactoring, or reusing existing implementation instead.`);
    }

    return suggestions;
  }
}

// Singleton instance
const duplicationDetector = new DuplicationDetector();
export default duplicationDetector;