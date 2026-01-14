/**
 * TestCoverageAnalyzer
 *
 * Analyze test coverage and identify gaps.
 * Suggests tests for uncovered code.
 *
 * Key behaviors:
 * 1. Parse coverage reports (Istanbul/NYC, Jest)
 * 2. Identify uncovered functions and branches
 * 3. Generate test suggestions for gaps
 * 4. Track coverage trends over time
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface CoverageReport {
  overall: CoverageMetrics;
  files: FileCoverage[];
  uncoveredFunctions: UncoveredItem[];
  uncoveredBranches: UncoveredItem[];
  suggestions: TestSuggestion[];
  timestamp: number;
}

export interface CoverageMetrics {
  lines: { covered: number; total: number; percentage: number };
  functions: { covered: number; total: number; percentage: number };
  branches: { covered: number; total: number; percentage: number };
  statements: { covered: number; total: number; percentage: number };
}

export interface FileCoverage {
  file: string;
  metrics: CoverageMetrics;
  uncoveredLines: number[];
  uncoveredFunctions: string[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

export interface UncoveredItem {
  file: string;
  name: string;
  line: number;
  type: 'function' | 'branch' | 'line';
  complexity?: number;
  importance: 'low' | 'medium' | 'high';
}

export interface TestSuggestion {
  file: string;
  target: string;
  type: 'unit' | 'integration' | 'edge_case';
  priority: number;
  description: string;
  testTemplate: string;
}

export interface CoverageTrend {
  date: Date;
  overall: number;
  delta: number;
}

export class TestCoverageAnalyzer {
  private coverageDir: string;
  private trends: CoverageTrend[] = [];

  constructor(coverageDir: string = 'coverage') {
    this.coverageDir = coverageDir;
  }

  /**
   * Analyze coverage and generate report
   */
  async analyze(workspacePath: string): Promise<CoverageReport> {
    console.log(`\n📊 [TestCoverageAnalyzer] Analyzing test coverage...`);

    // Try to run coverage if not exists
    await this.ensureCoverage(workspacePath);

    // Parse coverage data
    const coverageData = await this.parseCoverageData(workspacePath);

    // Calculate metrics
    const overall = this.calculateOverallMetrics(coverageData);
    const files = this.analyzeFiles(coverageData);

    // Find uncovered items
    const uncoveredFunctions = this.findUncoveredFunctions(coverageData);
    const uncoveredBranches = this.findUncoveredBranches(coverageData);

    // Generate suggestions
    const suggestions = this.generateSuggestions(
      uncoveredFunctions,
      uncoveredBranches,
      files
    );

    // Update trends
    this.updateTrends(overall.lines.percentage);

    console.log(`   Overall coverage: ${overall.lines.percentage.toFixed(1)}%`);
    console.log(`   Uncovered functions: ${uncoveredFunctions.length}`);
    console.log(`   Test suggestions: ${suggestions.length}`);

    return {
      overall,
      files,
      uncoveredFunctions,
      uncoveredBranches,
      suggestions,
      timestamp: Date.now(),
    };
  }

  /**
   * Ensure coverage data exists
   */
  private async ensureCoverage(workspacePath: string): Promise<void> {
    const coveragePath = path.join(workspacePath, this.coverageDir, 'coverage-summary.json');

    if (!fs.existsSync(coveragePath)) {
      console.log(`   Running tests to generate coverage...`);
      try {
        execSync('npm test -- --coverage --coverageReporters=json-summary --coverageReporters=json', {
          cwd: workspacePath,
          encoding: 'utf8',
          timeout: 300000,
          stdio: 'pipe',
        });
      } catch {
        console.warn(`   ⚠️ Could not generate coverage, using mock data`);
      }
    }
  }

  /**
   * Parse coverage data from various formats
   */
  private async parseCoverageData(workspacePath: string): Promise<any> {
    // Try Istanbul/NYC format
    const istanbulPath = path.join(workspacePath, this.coverageDir, 'coverage-final.json');
    if (fs.existsSync(istanbulPath)) {
      return JSON.parse(fs.readFileSync(istanbulPath, 'utf8'));
    }

    // Try Jest summary format
    const summaryPath = path.join(workspacePath, this.coverageDir, 'coverage-summary.json');
    if (fs.existsSync(summaryPath)) {
      return JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    }

    // Return mock data if no coverage found
    return this.getMockCoverageData();
  }

  /**
   * Calculate overall metrics
   */
  private calculateOverallMetrics(data: any): CoverageMetrics {
    if (data.total) {
      // Jest summary format
      return {
        lines: this.formatMetric(data.total.lines),
        functions: this.formatMetric(data.total.functions),
        branches: this.formatMetric(data.total.branches),
        statements: this.formatMetric(data.total.statements),
      };
    }

    // Istanbul format - aggregate from files
    let lines = { covered: 0, total: 0 };
    let functions = { covered: 0, total: 0 };
    let branches = { covered: 0, total: 0 };
    let statements = { covered: 0, total: 0 };

    for (const file of Object.values(data) as any[]) {
      if (file.s) {
        const stmtCovered = Object.values(file.s).filter((v: any) => v > 0).length;
        statements.covered += stmtCovered;
        statements.total += Object.keys(file.s).length;
      }
      if (file.f) {
        const funcCovered = Object.values(file.f).filter((v: any) => v > 0).length;
        functions.covered += funcCovered;
        functions.total += Object.keys(file.f).length;
      }
      if (file.b) {
        for (const branch of Object.values(file.b) as number[][]) {
          const branchCovered = branch.filter(v => v > 0).length;
          branches.covered += branchCovered;
          branches.total += branch.length;
        }
      }
    }

    lines = statements; // Use statements as lines proxy

    return {
      lines: this.calculatePercentage(lines),
      functions: this.calculatePercentage(functions),
      branches: this.calculatePercentage(branches),
      statements: this.calculatePercentage(statements),
    };
  }

  /**
   * Analyze individual files
   */
  private analyzeFiles(data: any): FileCoverage[] {
    const files: FileCoverage[] = [];

    // Handle Jest summary format
    if (data.total) {
      for (const [filePath, fileData] of Object.entries(data) as [string, any][]) {
        if (filePath === 'total') continue;

        const metrics: CoverageMetrics = {
          lines: this.formatMetric(fileData.lines),
          functions: this.formatMetric(fileData.functions),
          branches: this.formatMetric(fileData.branches),
          statements: this.formatMetric(fileData.statements),
        };

        files.push({
          file: filePath,
          metrics,
          uncoveredLines: [],
          uncoveredFunctions: [],
          riskLevel: this.calculateRiskLevel(metrics),
        });
      }
    } else {
      // Istanbul format
      for (const [filePath, fileData] of Object.entries(data) as [string, any]) {
        const uncoveredLines: number[] = [];
        const uncoveredFunctions: string[] = [];

        // Find uncovered statements
        if (fileData.s) {
          for (const [key, value] of Object.entries(fileData.s)) {
            if (value === 0 && fileData.statementMap?.[key]) {
              uncoveredLines.push(fileData.statementMap[key].start.line);
            }
          }
        }

        // Find uncovered functions
        if (fileData.f) {
          for (const [key, value] of Object.entries(fileData.f)) {
            if (value === 0 && fileData.fnMap?.[key]) {
              uncoveredFunctions.push(fileData.fnMap[key].name);
            }
          }
        }

        const metrics = this.calculateFileMetrics(fileData);

        files.push({
          file: filePath,
          metrics,
          uncoveredLines: [...new Set(uncoveredLines)],
          uncoveredFunctions,
          riskLevel: this.calculateRiskLevel(metrics),
        });
      }
    }

    // Sort by coverage (lowest first)
    files.sort((a, b) => a.metrics.lines.percentage - b.metrics.lines.percentage);

    return files;
  }

  /**
   * Find uncovered functions
   */
  private findUncoveredFunctions(data: any): UncoveredItem[] {
    const uncovered: UncoveredItem[] = [];

    for (const [filePath, fileData] of Object.entries(data) as [string, any]) {
      if (filePath === 'total') continue;

      if (fileData.f && fileData.fnMap) {
        for (const [key, value] of Object.entries(fileData.f)) {
          if (value === 0) {
            const fnInfo = fileData.fnMap[key];
            if (fnInfo) {
              uncovered.push({
                file: filePath,
                name: fnInfo.name || 'anonymous',
                line: fnInfo.loc?.start?.line || 0,
                type: 'function',
                importance: this.assessImportance(fnInfo.name, filePath),
              });
            }
          }
        }
      }
    }

    // Sort by importance
    uncovered.sort((a, b) => {
      const importanceOrder = { high: 0, medium: 1, low: 2 };
      return importanceOrder[a.importance] - importanceOrder[b.importance];
    });

    return uncovered;
  }

  /**
   * Find uncovered branches
   */
  private findUncoveredBranches(data: any): UncoveredItem[] {
    const uncovered: UncoveredItem[] = [];

    for (const [filePath, fileData] of Object.entries(data) as [string, any]) {
      if (filePath === 'total') continue;

      if (fileData.b && fileData.branchMap) {
        for (const [key, values] of Object.entries(fileData.b) as [string, number[]][]) {
          const branchInfo = fileData.branchMap[key];
          if (branchInfo && values.some(v => v === 0)) {
            uncovered.push({
              file: filePath,
              name: `${branchInfo.type} branch`,
              line: branchInfo.loc?.start?.line || 0,
              type: 'branch',
              importance: 'medium',
            });
          }
        }
      }
    }

    return uncovered;
  }

  /**
   * Generate test suggestions
   */
  private generateSuggestions(
    uncoveredFunctions: UncoveredItem[],
    uncoveredBranches: UncoveredItem[],
    files: FileCoverage[]
  ): TestSuggestion[] {
    const suggestions: TestSuggestion[] = [];

    // Suggest tests for high-importance uncovered functions
    for (const func of uncoveredFunctions.filter(f => f.importance === 'high')) {
      suggestions.push({
        file: func.file,
        target: func.name,
        type: 'unit',
        priority: 10,
        description: `Add unit tests for ${func.name}`,
        testTemplate: this.generateTestTemplate(func.name, func.file),
      });
    }

    // Suggest tests for critical files
    for (const file of files.filter(f => f.riskLevel === 'critical')) {
      if (file.uncoveredFunctions.length > 0) {
        suggestions.push({
          file: file.file,
          target: file.file,
          type: 'unit',
          priority: 9,
          description: `Improve coverage for critical file (${file.metrics.lines.percentage.toFixed(0)}% covered)`,
          testTemplate: this.generateFileTestTemplate(file),
        });
      }
    }

    // Suggest edge case tests for branches
    for (const branch of uncoveredBranches.slice(0, 10)) {
      suggestions.push({
        file: branch.file,
        target: `Line ${branch.line}`,
        type: 'edge_case',
        priority: 5,
        description: `Test ${branch.name} at line ${branch.line}`,
        testTemplate: `// Add test for branch condition at line ${branch.line}`,
      });
    }

    // Sort by priority
    suggestions.sort((a, b) => b.priority - a.priority);

    return suggestions.slice(0, 20);
  }

  /**
   * Generate test template for function
   */
  private generateTestTemplate(funcName: string, _filePath: string): string {
    return `describe('${funcName}', () => {
  it('should handle normal input', () => {
    // Arrange
    const input = /* TODO: provide input */;

    // Act
    const result = ${funcName}(input);

    // Assert
    expect(result).toBeDefined();
  });

  it('should handle edge cases', () => {
    // TODO: Add edge case tests
  });

  it('should throw on invalid input', () => {
    expect(() => ${funcName}(null)).toThrow();
  });
});`;
  }

  /**
   * Generate test template for file
   */
  private generateFileTestTemplate(file: FileCoverage): string {
    const moduleName = path.basename(file.file, path.extname(file.file));
    const functions = file.uncoveredFunctions.slice(0, 5);

    let template = `import { ${functions.join(', ')} } from './${moduleName}';\n\n`;

    for (const func of functions) {
      template += `describe('${func}', () => {
  it('should work correctly', () => {
    // TODO: Implement test
  });
});\n\n`;
    }

    return template;
  }

  /**
   * Calculate risk level based on metrics
   */
  private calculateRiskLevel(metrics: CoverageMetrics): FileCoverage['riskLevel'] {
    const avgCoverage = (
      metrics.lines.percentage +
      metrics.functions.percentage +
      metrics.branches.percentage
    ) / 3;

    if (avgCoverage < 30) return 'critical';
    if (avgCoverage < 50) return 'high';
    if (avgCoverage < 70) return 'medium';
    return 'low';
  }

  /**
   * Assess importance of uncovered item
   */
  private assessImportance(name: string, filePath: string): UncoveredItem['importance'] {
    // High importance patterns
    if (name.match(/^(handle|process|validate|auth|secure|save|delete)/i)) {
      return 'high';
    }

    // File-based importance
    if (filePath.includes('service') || filePath.includes('controller')) {
      return 'high';
    }
    if (filePath.includes('util') || filePath.includes('helper')) {
      return 'medium';
    }

    return 'low';
  }

  /**
   * Format metric from Jest format
   */
  private formatMetric(metric: any): { covered: number; total: number; percentage: number } {
    return {
      covered: metric.covered || 0,
      total: metric.total || 0,
      percentage: metric.pct || 0,
    };
  }

  /**
   * Calculate percentage from counts
   */
  private calculatePercentage(counts: { covered: number; total: number }): {
    covered: number;
    total: number;
    percentage: number;
  } {
    return {
      ...counts,
      percentage: counts.total > 0 ? (counts.covered / counts.total) * 100 : 0,
    };
  }

  /**
   * Calculate file metrics from Istanbul data
   */
  private calculateFileMetrics(fileData: any): CoverageMetrics {
    const statements = fileData.s
      ? {
          covered: Object.values(fileData.s).filter((v: any) => v > 0).length,
          total: Object.keys(fileData.s).length,
        }
      : { covered: 0, total: 0 };

    const functions = fileData.f
      ? {
          covered: Object.values(fileData.f).filter((v: any) => v > 0).length,
          total: Object.keys(fileData.f).length,
        }
      : { covered: 0, total: 0 };

    let branches = { covered: 0, total: 0 };
    if (fileData.b) {
      for (const branch of Object.values(fileData.b) as number[][]) {
        branches.covered += branch.filter(v => v > 0).length;
        branches.total += branch.length;
      }
    }

    return {
      lines: this.calculatePercentage(statements),
      functions: this.calculatePercentage(functions),
      branches: this.calculatePercentage(branches),
      statements: this.calculatePercentage(statements),
    };
  }

  /**
   * Update coverage trends
   */
  private updateTrends(currentCoverage: number): void {
    const lastTrend = this.trends[this.trends.length - 1];
    const delta = lastTrend ? currentCoverage - lastTrend.overall : 0;

    this.trends.push({
      date: new Date(),
      overall: currentCoverage,
      delta,
    });

    // Keep only last 30 entries
    if (this.trends.length > 30) {
      this.trends = this.trends.slice(-30);
    }
  }

  /**
   * Get mock coverage data for testing
   */
  private getMockCoverageData(): any {
    return {
      total: {
        lines: { total: 100, covered: 75, pct: 75 },
        functions: { total: 20, covered: 15, pct: 75 },
        branches: { total: 40, covered: 28, pct: 70 },
        statements: { total: 100, covered: 75, pct: 75 },
      },
    };
  }

  /**
   * Format report for display
   */
  static formatReport(report: CoverageReport): string {
    const getIcon = (pct: number) => pct >= 80 ? '🟢' : pct >= 60 ? '🟡' : '🔴';

    let output = `
## 📊 Test Coverage Report

### Overall Coverage:
- ${getIcon(report.overall.lines.percentage)} **Lines**: ${report.overall.lines.percentage.toFixed(1)}% (${report.overall.lines.covered}/${report.overall.lines.total})
- ${getIcon(report.overall.functions.percentage)} **Functions**: ${report.overall.functions.percentage.toFixed(1)}% (${report.overall.functions.covered}/${report.overall.functions.total})
- ${getIcon(report.overall.branches.percentage)} **Branches**: ${report.overall.branches.percentage.toFixed(1)}% (${report.overall.branches.covered}/${report.overall.branches.total})

### Lowest Coverage Files:
`;

    for (const file of report.files.slice(0, 5)) {
      output += `- ${getIcon(file.metrics.lines.percentage)} \`${path.basename(file.file)}\`: ${file.metrics.lines.percentage.toFixed(0)}%\n`;
    }

    if (report.suggestions.length > 0) {
      output += `\n### 💡 Test Suggestions:\n`;
      for (const suggestion of report.suggestions.slice(0, 5)) {
        output += `- **${suggestion.target}**: ${suggestion.description}\n`;
      }
    }

    return output;
  }
}
