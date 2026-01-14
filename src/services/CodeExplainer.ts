/**
 * CodeExplainer
 *
 * Explain complex code in natural language.
 * Generates explanations at different detail levels.
 *
 * Key behaviors:
 * 1. Parse code structure (AST-like analysis)
 * 2. Generate high-level summaries
 * 3. Explain complex logic step-by-step
 * 4. Identify patterns and design decisions
 */

import * as fs from 'fs';
import * as path from 'path';

export interface CodeExplanation {
  summary: string;
  purpose: string;
  complexity: 'simple' | 'moderate' | 'complex' | 'very_complex';
  keyComponents: ComponentExplanation[];
  controlFlow: string[];
  dataFlow: string[];
  patterns: string[];
  warnings: string[];
  suggestions: string[];
}

export interface ComponentExplanation {
  type: 'function' | 'class' | 'variable' | 'import' | 'export' | 'type';
  name: string;
  line: number;
  explanation: string;
  parameters?: ParameterExplanation[];
  returnType?: string;
  sideEffects?: string[];
}

export interface ParameterExplanation {
  name: string;
  type: string;
  purpose: string;
  optional: boolean;
}

export interface ExplanationOptions {
  level: 'brief' | 'detailed' | 'comprehensive';
  audience: 'beginner' | 'intermediate' | 'expert';
  focusOn?: string[]; // Specific functions/classes to focus on
  includeExamples?: boolean;
}

// Complexity indicators
const COMPLEXITY_PATTERNS = {
  simple: [/if\s*\(/g, /for\s*\(/g, /while\s*\(/g],
  moderate: [/async/g, /await/g, /Promise/g, /try\s*\{/g],
  complex: [/recursion|recursive/gi, /callback/gi, /\.then\(/g, /\?\./g],
  very_complex: [/generator|yield/gi, /Proxy/g, /Reflect\./g, /Symbol\./g],
};

// Common patterns to identify
const DESIGN_PATTERNS = {
  singleton: /private\s+static\s+instance|getInstance\s*\(/,
  factory: /create\w+|factory/i,
  observer: /subscribe|unsubscribe|notify|emit/,
  strategy: /strategy|setStrategy|executeStrategy/i,
  decorator: /@\w+|decorator/i,
  middleware: /middleware|next\s*\(/,
  repository: /repository|Repository/,
  service: /service|Service/,
};

export class CodeExplainer {
  /**
   * Explain a code snippet or file
   */
  static explain(
    code: string,
    options: ExplanationOptions = { level: 'detailed', audience: 'intermediate' }
  ): CodeExplanation {
    // Parse code structure
    const components = this.parseComponents(code);
    const complexity = this.assessComplexity(code);
    const patterns = this.identifyPatterns(code);

    // Generate explanations based on level
    const summary = this.generateSummary(code, components, options.level);
    const purpose = this.inferPurpose(code, components, patterns);
    const controlFlow = this.analyzeControlFlow(code);
    const dataFlow = this.analyzeDataFlow(code);
    const warnings = this.identifyWarnings(code);
    const suggestions = this.generateSuggestions(code, complexity);

    // Filter components based on focus
    const filteredComponents = options.focusOn
      ? components.filter(c => options.focusOn!.some(f =>
          c.name.toLowerCase().includes(f.toLowerCase())
        ))
      : components;

    // Adjust explanation depth based on audience
    const adjustedComponents = this.adjustForAudience(filteredComponents, options.audience);

    return {
      summary,
      purpose,
      complexity,
      keyComponents: adjustedComponents,
      controlFlow,
      dataFlow,
      patterns,
      warnings,
      suggestions,
    };
  }

  /**
   * Explain a file
   */
  static explainFile(
    filePath: string,
    options?: ExplanationOptions
  ): CodeExplanation {
    const code = fs.readFileSync(filePath, 'utf8');
    const explanation = this.explain(code, options);

    // Add file-specific context
    const fileName = path.basename(filePath);
    const fileType = this.inferFileType(fileName);

    explanation.summary = `**${fileName}** (${fileType})\n\n${explanation.summary}`;

    return explanation;
  }

  /**
   * Parse code components
   */
  private static parseComponents(code: string): ComponentExplanation[] {
    const components: ComponentExplanation[] = [];
    const lines = code.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Parse imports
      const importMatch = line.match(/^import\s+(?:{([^}]+)}|(\w+))\s+from\s+['"]([^'"]+)['"]/);
      if (importMatch) {
        const imports = importMatch[1] || importMatch[2];
        const source = importMatch[3];
        components.push({
          type: 'import',
          name: imports,
          line: lineNum,
          explanation: `Imports ${imports} from "${source}"`,
        });
        continue;
      }

      // Parse functions
      const funcMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
      if (funcMatch) {
        const [, name, params] = funcMatch;
        components.push({
          type: 'function',
          name,
          line: lineNum,
          explanation: this.explainFunction(name, params, this.getFunctionBody(lines, i)),
          parameters: this.parseParameters(params),
        });
        continue;
      }

      // Parse arrow functions
      const arrowMatch = line.match(/(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*([^=]+))?\s*=>/);
      if (arrowMatch) {
        const [, name, params, returnType] = arrowMatch;
        components.push({
          type: 'function',
          name,
          line: lineNum,
          explanation: this.explainFunction(name, params, this.getFunctionBody(lines, i)),
          parameters: this.parseParameters(params),
          returnType: returnType?.trim(),
        });
        continue;
      }

      // Parse classes
      const classMatch = line.match(/(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?/);
      if (classMatch) {
        const [, name, extendsClass, implementsInterfaces] = classMatch;
        components.push({
          type: 'class',
          name,
          line: lineNum,
          explanation: this.explainClass(name, extendsClass, implementsInterfaces),
        });
        continue;
      }

      // Parse interfaces/types
      const typeMatch = line.match(/(?:export\s+)?(?:interface|type)\s+(\w+)/);
      if (typeMatch) {
        components.push({
          type: 'type',
          name: typeMatch[1],
          line: lineNum,
          explanation: `Defines the "${typeMatch[1]}" type structure`,
        });
      }
    }

    return components;
  }

  /**
   * Assess code complexity
   */
  private static assessComplexity(code: string): CodeExplanation['complexity'] {
    let score = 0;

    // Count complexity indicators
    for (const [level, patterns] of Object.entries(COMPLEXITY_PATTERNS)) {
      const weight = level === 'simple' ? 1 : level === 'moderate' ? 2 : level === 'complex' ? 3 : 4;
      for (const pattern of patterns) {
        const matches = code.match(pattern) || [];
        score += matches.length * weight;
      }
    }

    // Consider nesting depth
    const maxNesting = this.getMaxNestingDepth(code);
    score += maxNesting * 2;

    // Consider line count
    const lines = code.split('\n').length;
    score += Math.floor(lines / 50);

    if (score < 10) return 'simple';
    if (score < 25) return 'moderate';
    if (score < 50) return 'complex';
    return 'very_complex';
  }

  /**
   * Identify design patterns
   */
  private static identifyPatterns(code: string): string[] {
    const patterns: string[] = [];

    for (const [name, pattern] of Object.entries(DESIGN_PATTERNS)) {
      if (pattern.test(code)) {
        patterns.push(name);
      }
    }

    // Check for common coding patterns
    if (code.includes('async') && code.includes('await')) {
      patterns.push('async/await');
    }
    if (code.match(/\.map\s*\(/) || code.match(/\.filter\s*\(/) || code.match(/\.reduce\s*\(/)) {
      patterns.push('functional');
    }
    if (code.match(/class.*extends/)) {
      patterns.push('inheritance');
    }
    if (code.match(/implements\s+\w+/)) {
      patterns.push('interface implementation');
    }

    return patterns;
  }

  /**
   * Generate summary
   */
  private static generateSummary(
    _code: string,
    inputComponents: ComponentExplanation[],
    level: ExplanationOptions['level']
  ): string {
    const functions = inputComponents.filter(c => c.type === 'function');
    const classes = inputComponents.filter(c => c.type === 'class');
    const types = inputComponents.filter(c => c.type === 'type');

    let summary = '';

    if (level === 'brief') {
      summary = `Contains ${functions.length} functions, ${classes.length} classes, and ${types.length} types.`;
    } else if (level === 'detailed') {
      summary = `This code module contains:\n`;
      if (classes.length > 0) {
        summary += `- **Classes**: ${classes.map(c => c.name).join(', ')}\n`;
      }
      if (functions.length > 0) {
        summary += `- **Functions**: ${functions.map(c => c.name).join(', ')}\n`;
      }
      if (types.length > 0) {
        summary += `- **Types**: ${types.map(c => c.name).join(', ')}\n`;
      }
    } else {
      summary = `## Code Structure\n\n`;
      summary += `This module provides the following components:\n\n`;

      for (const cls of classes) {
        summary += `### ${cls.name}\n${cls.explanation}\n\n`;
      }

      for (const func of functions) {
        summary += `### ${func.name}()\n${func.explanation}\n\n`;
      }
    }

    return summary;
  }

  /**
   * Infer code purpose
   */
  private static inferPurpose(
    sourceCode: string,
    _components: ComponentExplanation[],
    patterns: string[]
  ): string {
    const purposes: string[] = [];

    // Check for common purposes
    if (sourceCode.includes('export') && sourceCode.includes('import')) {
      purposes.push('module that exports functionality');
    }
    if (patterns.includes('service')) {
      purposes.push('service layer component');
    }
    if (patterns.includes('repository')) {
      purposes.push('data access layer');
    }
    if (sourceCode.includes('router') || sourceCode.includes('route')) {
      purposes.push('API routing');
    }
    if (sourceCode.includes('validate') || sourceCode.includes('schema')) {
      purposes.push('validation logic');
    }
    if (sourceCode.includes('test') || sourceCode.includes('describe') || sourceCode.includes('it(')) {
      purposes.push('test suite');
    }

    if (purposes.length === 0) {
      return 'General-purpose code module';
    }

    return `This code provides ${purposes.join(', ')}.`;
  }

  /**
   * Analyze control flow
   */
  private static analyzeControlFlow(code: string): string[] {
    const flows: string[] = [];

    if (code.includes('if')) flows.push('Conditional branching');
    if (code.includes('for') || code.includes('while')) flows.push('Iteration/loops');
    if (code.includes('try') && code.includes('catch')) flows.push('Error handling');
    if (code.includes('switch')) flows.push('Multi-way branching');
    if (code.includes('return')) flows.push('Early returns');
    if (code.includes('throw')) flows.push('Exception throwing');
    if (code.includes('async') && code.includes('await')) flows.push('Asynchronous flow');

    return flows;
  }

  /**
   * Analyze data flow
   */
  private static analyzeDataFlow(code: string): string[] {
    const flows: string[] = [];

    if (code.includes('const')) flows.push('Immutable variables');
    if (code.includes('let')) flows.push('Mutable variables');
    if (code.match(/\.map\s*\(/)) flows.push('Data transformation (map)');
    if (code.match(/\.filter\s*\(/)) flows.push('Data filtering');
    if (code.match(/\.reduce\s*\(/)) flows.push('Data aggregation');
    if (code.includes('state') || code.includes('setState')) flows.push('State management');
    if (code.includes('this.')) flows.push('Instance state');

    return flows;
  }

  /**
   * Identify warnings
   */
  private static identifyWarnings(code: string): string[] {
    const warnings: string[] = [];

    if (code.includes('any')) warnings.push('Uses "any" type - consider stronger typing');
    if (code.includes('// TODO') || code.includes('// FIXME')) warnings.push('Contains TODO/FIXME comments');
    if (code.includes('console.log')) warnings.push('Contains console.log statements');
    if (code.match(/catch\s*\(\s*\w*\s*\)\s*\{\s*\}/)) warnings.push('Empty catch block');
    if (code.includes('eval(')) warnings.push('Uses eval() - security risk');
    if (this.getMaxNestingDepth(code) > 4) warnings.push('Deep nesting detected');

    return warnings;
  }

  /**
   * Generate improvement suggestions
   */
  private static generateSuggestions(code: string, complexity: string): string[] {
    const suggestions: string[] = [];

    if (complexity === 'very_complex') {
      suggestions.push('Consider breaking down into smaller functions');
    }

    if (code.includes('callback')) {
      suggestions.push('Consider converting callbacks to async/await');
    }

    if (!code.includes('interface') && !code.includes('type') && code.length > 500) {
      suggestions.push('Consider adding type definitions');
    }

    const longFunctions = code.match(/function\s+\w+[^}]+\{[\s\S]{500,}?\}/g);
    if (longFunctions && longFunctions.length > 0) {
      suggestions.push('Some functions are long - consider extracting helpers');
    }

    return suggestions;
  }

  /**
   * Explain a function
   */
  private static explainFunction(name: string, params: string, body: string): string {
    const isAsync = body.includes('async') || body.includes('await');
    const hasReturn = body.includes('return');
    const throwsError = body.includes('throw');

    let explanation = `The \`${name}\` function`;

    if (params) {
      const paramCount = params.split(',').filter(p => p.trim()).length;
      explanation += ` takes ${paramCount} parameter${paramCount !== 1 ? 's' : ''}`;
    } else {
      explanation += ` takes no parameters`;
    }

    if (isAsync) {
      explanation += `, runs asynchronously`;
    }

    if (hasReturn) {
      explanation += `, and returns a value`;
    }

    if (throwsError) {
      explanation += `. May throw errors`;
    }

    explanation += '.';

    return explanation;
  }

  /**
   * Explain a class
   */
  private static explainClass(name: string, extendsClass?: string, implementsInterfaces?: string): string {
    let explanation = `The \`${name}\` class`;

    if (extendsClass) {
      explanation += ` extends \`${extendsClass}\``;
    }

    if (implementsInterfaces) {
      explanation += ` and implements ${implementsInterfaces.split(',').map(i => `\`${i.trim()}\``).join(', ')}`;
    }

    explanation += '.';

    return explanation;
  }

  /**
   * Parse function parameters
   */
  private static parseParameters(params: string): ParameterExplanation[] {
    if (!params.trim()) return [];

    return params.split(',').map(param => {
      const [nameType, defaultValue] = param.split('=');
      const [name, type] = nameType.split(':').map(s => s.trim());
      const optional = name.includes('?') || !!defaultValue;

      return {
        name: name.replace('?', ''),
        type: type || 'any',
        purpose: `Parameter "${name.replace('?', '')}"`,
        optional,
      };
    });
  }

  /**
   * Get function body
   */
  private static getFunctionBody(lines: string[], startLine: number): string {
    let braceCount = 0;
    let started = false;
    const body: string[] = [];

    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i];

      braceCount += (line.match(/\{/g) || []).length;
      braceCount -= (line.match(/\}/g) || []).length;

      if (braceCount > 0) started = true;
      if (started) body.push(line);
      if (started && braceCount === 0) break;
    }

    return body.join('\n');
  }

  /**
   * Get max nesting depth
   */
  private static getMaxNestingDepth(code: string): number {
    let maxDepth = 0;
    let currentDepth = 0;

    for (const char of code) {
      if (char === '{') {
        currentDepth++;
        maxDepth = Math.max(maxDepth, currentDepth);
      } else if (char === '}') {
        currentDepth--;
      }
    }

    return maxDepth;
  }

  /**
   * Adjust explanations for audience
   */
  private static adjustForAudience(
    components: ComponentExplanation[],
    audience: ExplanationOptions['audience']
  ): ComponentExplanation[] {
    if (audience === 'expert') {
      // Brief explanations for experts
      return components.map(c => ({
        ...c,
        explanation: c.explanation.split('.')[0] + '.',
      }));
    }

    if (audience === 'beginner') {
      // More detailed explanations for beginners
      return components.map(c => ({
        ...c,
        explanation: c.explanation + ' This is a key part of how the code works.',
      }));
    }

    return components;
  }

  /**
   * Infer file type from name
   */
  private static inferFileType(fileName: string): string {
    if (fileName.includes('.test.') || fileName.includes('.spec.')) return 'Test file';
    if (fileName.includes('service')) return 'Service';
    if (fileName.includes('controller')) return 'Controller';
    if (fileName.includes('model')) return 'Model';
    if (fileName.includes('route')) return 'Router';
    if (fileName.includes('util')) return 'Utility';
    if (fileName.includes('type') || fileName.includes('interface')) return 'Type definitions';
    if (fileName.includes('config')) return 'Configuration';
    if (fileName === 'index.ts' || fileName === 'index.js') return 'Module entry point';
    return 'Module';
  }

  /**
   * Format explanation for display
   */
  static formatExplanation(explanation: CodeExplanation): string {
    let output = `## Code Explanation\n\n`;
    output += `${explanation.summary}\n\n`;
    output += `**Purpose**: ${explanation.purpose}\n\n`;
    output += `**Complexity**: ${explanation.complexity}\n\n`;

    if (explanation.patterns.length > 0) {
      output += `**Patterns Used**: ${explanation.patterns.join(', ')}\n\n`;
    }

    if (explanation.controlFlow.length > 0) {
      output += `**Control Flow**:\n${explanation.controlFlow.map(f => `- ${f}`).join('\n')}\n\n`;
    }

    if (explanation.warnings.length > 0) {
      output += `**⚠️ Warnings**:\n${explanation.warnings.map(w => `- ${w}`).join('\n')}\n\n`;
    }

    if (explanation.suggestions.length > 0) {
      output += `**💡 Suggestions**:\n${explanation.suggestions.map(s => `- ${s}`).join('\n')}\n\n`;
    }

    return output;
  }
}
