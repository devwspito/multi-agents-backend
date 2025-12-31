/**
 * Coherence Checker
 *
 * Validates full-stack coherence between frontend and backend.
 * This is the "is everything connected properly?" check.
 *
 * Key checks:
 * 1. Routes are registered in app.js/index.js
 * 2. Frontend API calls match backend endpoints
 * 3. Request/response field names match
 * 4. Imports are valid (no missing modules)
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface RouteCheck {
  routeFile: string;
  routePath: string;
  registeredInApp: boolean;
  appFile?: string;
  registrationLine?: string;
}

export interface ApiCallCheck {
  frontendFile: string;
  endpoint: string;
  method: string;
  backendHasEndpoint: boolean;
  backendFile?: string;
}

export interface ImportCheck {
  file: string;
  importPath: string;
  exists: boolean;
  resolvedPath?: string;
}

export interface CoherenceReport {
  repoPath: string;
  repoType: 'frontend' | 'backend' | 'fullstack' | 'unknown';
  routeChecks: RouteCheck[];
  apiCallChecks: ApiCallCheck[];
  importChecks: ImportCheck[];
  issues: CoherenceIssue[];
  isCoherent: boolean;
  feedback: string;
}

export interface CoherenceIssue {
  severity: 'critical' | 'warning';
  category: 'route_not_registered' | 'api_mismatch' | 'missing_import' | 'field_mismatch';
  description: string;
  file: string;
  fix: string;
}

class CoherenceCheckerClass {

  /**
   * Run full coherence check on a repository
   */
  async checkCoherence(repoPath: string): Promise<CoherenceReport> {
    console.log(`\n🔗 [Coherence] Checking coherence for: ${repoPath}`);

    const repoType = this.detectRepoType(repoPath);
    console.log(`   Repo type: ${repoType}`);

    const routeChecks: RouteCheck[] = [];
    const apiCallChecks: ApiCallCheck[] = [];
    const importChecks: ImportCheck[] = [];
    const issues: CoherenceIssue[] = [];

    // Check route registration (backend/fullstack)
    if (repoType === 'backend' || repoType === 'fullstack') {
      const routes = await this.findRouteFiles(repoPath);
      for (const route of routes) {
        const check = await this.checkRouteRegistration(repoPath, route);
        routeChecks.push(check);

        if (!check.registeredInApp) {
          issues.push({
            severity: 'critical',
            category: 'route_not_registered',
            description: `Route ${route.routePath} defined in ${route.routeFile} but NOT registered in app`,
            file: route.routeFile,
            fix: `Add app.use('${route.routePath}', ${this.getRouteVarName(route.routeFile)}) to app.js/index.js`
          });
        }
      }
    }

    // Check API calls (frontend/fullstack)
    if (repoType === 'frontend' || repoType === 'fullstack') {
      const apiCalls = await this.findApiCalls(repoPath);
      for (const call of apiCalls) {
        apiCallChecks.push(call);

        if (!call.backendHasEndpoint) {
          issues.push({
            severity: 'warning',
            category: 'api_mismatch',
            description: `Frontend calls ${call.method} ${call.endpoint} but backend endpoint not found`,
            file: call.frontendFile,
            fix: `Create backend endpoint for ${call.method} ${call.endpoint} or fix frontend URL`
          });
        }
      }
    }

    // Check critical imports
    const criticalImports = await this.checkCriticalImports(repoPath);
    importChecks.push(...criticalImports);

    for (const imp of criticalImports) {
      if (!imp.exists) {
        issues.push({
          severity: 'critical',
          category: 'missing_import',
          description: `Import "${imp.importPath}" in ${imp.file} does not resolve`,
          file: imp.file,
          fix: `Create file ${imp.importPath} or fix import path`
        });
      }
    }

    const isCoherent = issues.filter(i => i.severity === 'critical').length === 0;
    const feedback = this.generateFeedback(issues, isCoherent);

    console.log(`   Issues found: ${issues.length} (${issues.filter(i => i.severity === 'critical').length} critical)`);

    return {
      repoPath,
      repoType,
      routeChecks,
      apiCallChecks,
      importChecks,
      issues,
      isCoherent,
      feedback,
    };
  }

  /**
   * Detect repository type
   */
  private detectRepoType(repoPath: string): 'frontend' | 'backend' | 'fullstack' | 'unknown' {
    const hasFrontend = fs.existsSync(path.join(repoPath, 'src', 'components')) ||
                        fs.existsSync(path.join(repoPath, 'src', 'pages')) ||
                        fs.existsSync(path.join(repoPath, 'src', 'App.tsx')) ||
                        fs.existsSync(path.join(repoPath, 'src', 'App.jsx'));

    const hasBackend = fs.existsSync(path.join(repoPath, 'src', 'routes')) ||
                       fs.existsSync(path.join(repoPath, 'src', 'controllers')) ||
                       fs.existsSync(path.join(repoPath, 'src', 'api'));

    if (hasFrontend && hasBackend) return 'fullstack';
    if (hasFrontend) return 'frontend';
    if (hasBackend) return 'backend';
    return 'unknown';
  }

  /**
   * Find all route files in the backend
   */
  private async findRouteFiles(repoPath: string): Promise<Array<{ routeFile: string; routePath: string }>> {
    const routes: Array<{ routeFile: string; routePath: string }> = [];
    const routeDirs = ['src/routes', 'routes', 'src/api', 'api'];

    for (const dir of routeDirs) {
      const fullDir = path.join(repoPath, dir);
      if (!fs.existsSync(fullDir)) continue;

      try {
        const files = fs.readdirSync(fullDir);
        for (const file of files) {
          if (!file.endsWith('.ts') && !file.endsWith('.js')) continue;
          if (file === 'index.ts' || file === 'index.js') continue;

          const routeFile = path.join(dir, file);
          const routeName = file.replace(/\.(ts|js)$/, '');
          const routePath = `/api/${routeName}`;

          routes.push({ routeFile, routePath });
        }
      } catch {
        // Directory might not exist
      }
    }

    return routes;
  }

  /**
   * Check if a route is registered in app.js/index.js
   */
  private async checkRouteRegistration(
    repoPath: string,
    route: { routeFile: string; routePath: string }
  ): Promise<RouteCheck> {
    const appFiles = [
      'src/index.ts', 'src/index.js',
      'src/app.ts', 'src/app.js',
      'src/server.ts', 'src/server.js',
      'index.ts', 'index.js',
      'app.ts', 'app.js',
      'server.ts', 'server.js'
    ];

    const routeName = path.basename(route.routeFile).replace(/\.(ts|js)$/, '');
    const searchPatterns = [
      `'${route.routePath}'`,
      `"${route.routePath}"`,
      `'/${routeName}'`,
      `"/${routeName}"`,
      routeName + 'Routes',
      routeName + 'Router'
    ];

    for (const appFile of appFiles) {
      const fullPath = path.join(repoPath, appFile);
      if (!fs.existsSync(fullPath)) continue;

      const content = fs.readFileSync(fullPath, 'utf-8');

      for (const pattern of searchPatterns) {
        if (content.includes(pattern)) {
          // Find the actual line
          const lines = content.split('\n');
          const lineNum = lines.findIndex(l => l.includes(pattern));
          const registrationLine = lineNum >= 0 ? lines[lineNum].trim() : undefined;

          return {
            routeFile: route.routeFile,
            routePath: route.routePath,
            registeredInApp: true,
            appFile,
            registrationLine
          };
        }
      }
    }

    return {
      routeFile: route.routeFile,
      routePath: route.routePath,
      registeredInApp: false
    };
  }

  /**
   * Get variable name for route file
   */
  private getRouteVarName(routeFile: string): string {
    const baseName = path.basename(routeFile).replace(/\.(ts|js)$/, '');
    return baseName + 'Routes';
  }

  /**
   * Find API calls in frontend code
   */
  private async findApiCalls(repoPath: string): Promise<ApiCallCheck[]> {
    const apiCalls: ApiCallCheck[] = [];

    try {
      // Search for fetch/axios calls
      const grepResult = execSync(
        `grep -rE "(fetch|axios|api).*['\\"]/api/" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" "${repoPath}/src" 2>/dev/null || true`,
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
      );

      const lines = grepResult.split('\n').filter(Boolean);

      for (const line of lines.slice(0, 20)) { // Limit to 20
        const [filePath] = line.split(':');

        // Extract endpoint from the line
        const endpointMatch = line.match(/['"](\/api\/[^'"]+)['"]/);
        if (!endpointMatch) continue;

        const endpoint = endpointMatch[1];

        // Detect HTTP method
        let method = 'GET';
        if (line.toLowerCase().includes('post')) method = 'POST';
        else if (line.toLowerCase().includes('put')) method = 'PUT';
        else if (line.toLowerCase().includes('delete')) method = 'DELETE';
        else if (line.toLowerCase().includes('patch')) method = 'PATCH';

        // Check if backend has this endpoint
        const backendCheck = await this.checkBackendEndpoint(repoPath, endpoint, method);

        apiCalls.push({
          frontendFile: filePath.replace(repoPath + '/', ''),
          endpoint,
          method,
          backendHasEndpoint: backendCheck.exists,
          backendFile: backendCheck.file
        });
      }
    } catch {
      // No matches
    }

    return apiCalls;
  }

  /**
   * Check if backend has a specific endpoint
   */
  private async checkBackendEndpoint(
    repoPath: string,
    endpoint: string,
    _method: string
  ): Promise<{ exists: boolean; file?: string }> {
    try {
      // Search for the endpoint in backend files
      const searchPattern = endpoint.replace(/\//g, '\\/');
      const grepResult = execSync(
        `grep -rl "${searchPattern}" --include="*.ts" --include="*.js" "${repoPath}/src/routes" "${repoPath}/routes" "${repoPath}/src/api" 2>/dev/null || true`,
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
      );

      if (grepResult.trim()) {
        return {
          exists: true,
          file: grepResult.split('\n')[0].replace(repoPath + '/', '')
        };
      }

      // Also search for partial path matches
      const pathParts = endpoint.split('/').filter(Boolean);
      const lastPart = pathParts[pathParts.length - 1];

      if (lastPart && !lastPart.startsWith(':')) {
        const partialSearch = execSync(
          `grep -rl "/${lastPart}" --include="*.ts" --include="*.js" "${repoPath}/src" 2>/dev/null || true`,
          { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
        );

        if (partialSearch.trim()) {
          return {
            exists: true,
            file: partialSearch.split('\n')[0].replace(repoPath + '/', '')
          };
        }
      }

      return { exists: false };
    } catch {
      return { exists: false };
    }
  }

  /**
   * Check critical imports resolve correctly
   */
  private async checkCriticalImports(repoPath: string): Promise<ImportCheck[]> {
    const imports: ImportCheck[] = [];

    try {
      // Find imports from ./routes, ./services, ./controllers
      const grepResult = execSync(
        `grep -rE "from ['\"]\\./(?:routes|services|controllers|api)/[^'\"]+['\"]" --include="*.ts" --include="*.js" "${repoPath}/src" 2>/dev/null | head -20 || true`,
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
      );

      const lines = grepResult.split('\n').filter(Boolean);

      for (const line of lines) {
        const [filePath] = line.split(':');
        const importMatch = line.match(/from ['"](\.\/[^'"]+)['"]/);

        if (!importMatch) continue;

        const importPath = importMatch[1];
        const baseDir = path.dirname(path.join(repoPath, filePath.replace(repoPath + '/', '')));

        // Try to resolve the import
        const possiblePaths = [
          path.join(baseDir, importPath + '.ts'),
          path.join(baseDir, importPath + '.js'),
          path.join(baseDir, importPath, 'index.ts'),
          path.join(baseDir, importPath, 'index.js')
        ];

        const exists = possiblePaths.some(p => fs.existsSync(p));
        const resolvedPath = possiblePaths.find(p => fs.existsSync(p));

        imports.push({
          file: filePath.replace(repoPath + '/', ''),
          importPath,
          exists,
          resolvedPath: resolvedPath?.replace(repoPath + '/', '')
        });
      }
    } catch {
      // No critical imports found
    }

    return imports;
  }

  /**
   * Generate feedback for fixing issues
   */
  private generateFeedback(issues: CoherenceIssue[], isCoherent: boolean): string {
    if (isCoherent && issues.length === 0) {
      return '✅ Full-stack coherence verified. All routes registered, API calls match.';
    }

    const critical = issues.filter(i => i.severity === 'critical');
    const warnings = issues.filter(i => i.severity === 'warning');

    const lines: string[] = [];

    if (critical.length > 0) {
      lines.push(`🚨 COHERENCE CHECK FAILED - ${critical.length} critical issue(s):\n`);

      for (const issue of critical) {
        lines.push(`❌ [${issue.category.toUpperCase()}] ${issue.description}`);
        lines.push(`   📁 File: ${issue.file}`);
        lines.push(`   🔧 Fix: ${issue.fix}`);
        lines.push('');
      }
    }

    if (warnings.length > 0) {
      lines.push(`\n⚠️ ${warnings.length} warning(s):\n`);

      for (const issue of warnings) {
        lines.push(`⚠️ ${issue.description}`);
        lines.push(`   🔧 Fix: ${issue.fix}`);
      }
    }

    lines.push('\n📋 ACTION REQUIRED: Fix critical issues before merge.');

    return lines.join('\n');
  }
}

export const CoherenceChecker = new CoherenceCheckerClass();
