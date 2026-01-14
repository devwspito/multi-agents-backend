/**
 * DocGenerator
 *
 * Automatically generate documentation from code.
 * Creates JSDoc, README, API docs, and more.
 *
 * Key behaviors:
 * 1. Extract documentation from code structure
 * 2. Generate JSDoc comments for functions
 * 3. Create README files from exports
 * 4. Generate API documentation
 */

import * as fs from 'fs';
import * as path from 'path';

export interface DocConfig {
  format: 'jsdoc' | 'markdown' | 'html' | 'json';
  includePrivate: boolean;
  includeExamples: boolean;
  includeTypes: boolean;
  outputDir?: string;
}

export interface FunctionDoc {
  name: string;
  description: string;
  params: ParamDoc[];
  returns: ReturnDoc;
  throws: string[];
  examples: string[];
  isAsync: boolean;
  isExported: boolean;
  line: number;
}

export interface ParamDoc {
  name: string;
  type: string;
  description: string;
  optional: boolean;
  defaultValue?: string;
}

export interface ReturnDoc {
  type: string;
  description: string;
}

export interface ClassDoc {
  name: string;
  description: string;
  extends?: string;
  implements?: string[];
  classConstructor?: FunctionDoc;
  methods: FunctionDoc[];
  properties: PropertyDoc[];
  isExported: boolean;
  line: number;
}

export interface PropertyDoc {
  name: string;
  type: string;
  description: string;
  isReadonly: boolean;
  isStatic: boolean;
  isPrivate: boolean;
}

export interface ModuleDoc {
  name: string;
  description: string;
  exports: string[];
  classes: ClassDoc[];
  functions: FunctionDoc[];
  types: TypeDoc[];
  constants: ConstantDoc[];
}

export interface TypeDoc {
  name: string;
  type: 'interface' | 'type' | 'enum';
  description: string;
  properties?: PropertyDoc[];
  values?: string[];
  isExported: boolean;
}

export interface ConstantDoc {
  name: string;
  type: string;
  value: string;
  description: string;
  isExported: boolean;
}

const DEFAULT_CONFIG: DocConfig = {
  format: 'markdown',
  includePrivate: false,
  includeExamples: true,
  includeTypes: true,
};

export class DocGenerator {
  private config: DocConfig;

  constructor(config: Partial<DocConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Generate documentation for a file
   */
  generateForFile(filePath: string): ModuleDoc {
    const content = fs.readFileSync(filePath, 'utf8');
    const fileName = path.basename(filePath, path.extname(filePath));

    return {
      name: fileName,
      description: this.extractModuleDescription(content),
      exports: this.extractExports(content),
      classes: this.extractClasses(content),
      functions: this.extractFunctions(content),
      types: this.extractTypes(content),
      constants: this.extractConstants(content),
    };
  }

  /**
   * Generate JSDoc comments for code
   */
  generateJSDoc(code: string): string {
    const lines = code.split('\n');
    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Check if this line needs JSDoc
      const needsDoc = this.needsJSDoc(line, lines[i - 1]);

      if (needsDoc) {
        const docComment = this.generateJSDocForLine(line, lines, i);
        if (docComment) {
          result.push(docComment);
        }
      }

      result.push(line);
      i++;
    }

    return result.join('\n');
  }

  /**
   * Generate README from module documentation
   */
  generateReadme(moduleDoc: ModuleDoc): string {
    let readme = `# ${moduleDoc.name}\n\n`;
    readme += `${moduleDoc.description || 'No description available.'}\n\n`;

    // Installation section
    readme += `## Installation\n\n`;
    readme += '```bash\nnpm install\n```\n\n';

    // Exports section
    if (moduleDoc.exports.length > 0) {
      readme += `## Exports\n\n`;
      readme += moduleDoc.exports.map(e => `- \`${e}\``).join('\n');
      readme += '\n\n';
    }

    // Classes section
    if (moduleDoc.classes.length > 0) {
      readme += `## Classes\n\n`;
      for (const cls of moduleDoc.classes) {
        readme += this.formatClassDoc(cls);
      }
    }

    // Functions section
    if (moduleDoc.functions.length > 0) {
      readme += `## Functions\n\n`;
      for (const func of moduleDoc.functions) {
        readme += this.formatFunctionDoc(func);
      }
    }

    // Types section
    if (this.config.includeTypes && moduleDoc.types.length > 0) {
      readme += `## Types\n\n`;
      for (const type of moduleDoc.types) {
        readme += this.formatTypeDoc(type);
      }
    }

    return readme;
  }

  /**
   * Generate API documentation
   */
  generateApiDocs(filePaths: string[]): string {
    let docs = `# API Documentation\n\n`;
    docs += `Generated: ${new Date().toISOString()}\n\n`;
    docs += `---\n\n`;

    for (const filePath of filePaths) {
      const moduleDoc = this.generateForFile(filePath);

      if (moduleDoc.exports.length > 0 || moduleDoc.classes.length > 0) {
        docs += `## ${moduleDoc.name}\n\n`;
        docs += this.generateReadme(moduleDoc);
        docs += `\n---\n\n`;
      }
    }

    return docs;
  }

  // ============== Private Methods ==============

  private extractModuleDescription(content: string): string {
    // Look for file-level JSDoc comment
    const match = content.match(/^\/\*\*\s*\n([^*]|\*[^/])*\*\//);
    if (match) {
      return this.cleanJSDoc(match[0]);
    }

    // Look for first comment
    const firstComment = content.match(/^\/\/\s*(.+)/);
    if (firstComment) {
      return firstComment[1];
    }

    return '';
  }

  private extractExports(content: string): string[] {
    const exports: string[] = [];

    // Named exports
    const namedExports = content.matchAll(/export\s+(?:const|let|function|class|interface|type|enum)\s+(\w+)/g);
    for (const match of namedExports) {
      exports.push(match[1]);
    }

    // Export { } statements
    const exportBlocks = content.matchAll(/export\s*\{([^}]+)\}/g);
    for (const match of exportBlocks) {
      const names = match[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0]);
      exports.push(...names);
    }

    // Default export
    if (content.includes('export default')) {
      exports.push('default');
    }

    return [...new Set(exports)];
  }

  private extractClasses(content: string): ClassDoc[] {
    const classes: ClassDoc[] = [];
    const classRegex = /(?:\/\*\*[\s\S]*?\*\/\s*)?(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?\s*\{/g;

    let match;
    while ((match = classRegex.exec(content)) !== null) {
      const [fullMatch, name, extendsClass, implementsInterfaces] = match;
      const line = content.substring(0, match.index).split('\n').length;

      // Extract JSDoc above class
      const jsdoc = this.extractJSDocAbove(content, match.index);

      // Extract class body
      const classBody = this.extractBlockBody(content, match.index + fullMatch.length - 1);

      const classDoc: ClassDoc = {
        name,
        description: this.cleanJSDoc(jsdoc),
        extends: extendsClass,
        implements: implementsInterfaces?.split(',').map(i => i.trim()),
        methods: this.extractMethods(classBody),
        properties: this.extractProperties(classBody),
        isExported: fullMatch.includes('export'),
        line,
      };
      classes.push(classDoc);
    }

    return classes;
  }

  private extractFunctions(content: string): FunctionDoc[] {
    const functions: FunctionDoc[] = [];
    const funcRegex = /(?:\/\*\*[\s\S]*?\*\/\s*)?(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?\s*\{/g;

    let match;
    while ((match = funcRegex.exec(content)) !== null) {
      const [fullMatch, name, params, returnType] = match;
      const line = content.substring(0, match.index).split('\n').length;

      const jsdoc = this.extractJSDocAbove(content, match.index);

      functions.push({
        name,
        description: this.cleanJSDoc(jsdoc),
        params: this.parseParams(params, jsdoc),
        returns: { type: returnType?.trim() || 'void', description: '' },
        throws: this.extractThrows(jsdoc),
        examples: this.extractExamples(jsdoc),
        isAsync: fullMatch.includes('async'),
        isExported: fullMatch.includes('export'),
        line,
      });
    }

    return functions;
  }

  private extractTypes(content: string): TypeDoc[] {
    const types: TypeDoc[] = [];

    // Interfaces
    const interfaceRegex = /(?:\/\*\*[\s\S]*?\*\/\s*)?(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+[\w,\s]+)?\s*\{([^}]*)\}/g;
    let match;
    while ((match = interfaceRegex.exec(content)) !== null) {
      const [fullMatch, name, body] = match;
      const jsdoc = this.extractJSDocAbove(content, match.index);

      types.push({
        name,
        type: 'interface',
        description: this.cleanJSDoc(jsdoc),
        properties: this.extractInterfaceProperties(body),
        isExported: fullMatch.includes('export'),
      });
    }

    // Type aliases
    const typeRegex = /(?:\/\*\*[\s\S]*?\*\/\s*)?(?:export\s+)?type\s+(\w+)\s*=\s*([^;]+);/g;
    while ((match = typeRegex.exec(content)) !== null) {
      const [fullMatch, name] = match;
      const jsdoc = this.extractJSDocAbove(content, match.index);

      types.push({
        name,
        type: 'type',
        description: this.cleanJSDoc(jsdoc),
        isExported: fullMatch.includes('export'),
      });
    }

    return types;
  }

  private extractConstants(content: string): ConstantDoc[] {
    const constants: ConstantDoc[] = [];
    const constRegex = /(?:\/\*\*[\s\S]*?\*\/\s*)?(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*([^=]+))?\s*=\s*([^;]+);/g;

    let match;
    while ((match = constRegex.exec(content)) !== null) {
      const [fullMatch, name, type, value] = match;
      const jsdoc = this.extractJSDocAbove(content, match.index);

      constants.push({
        name,
        type: type?.trim() || 'unknown',
        value: value.trim().substring(0, 50),
        description: this.cleanJSDoc(jsdoc),
        isExported: fullMatch.includes('export'),
      });
    }

    return constants;
  }

  private extractMethods(classBody: string): FunctionDoc[] {
    const methods: FunctionDoc[] = [];
    const methodRegex = /(?:\/\*\*[\s\S]*?\*\/\s*)?(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?\s*\{/g;

    let match;
    while ((match = methodRegex.exec(classBody)) !== null) {
      const [fullMatch, name, params, returnType] = match;

      if (name === 'constructor') continue;

      const jsdoc = this.extractJSDocAbove(classBody, match.index);

      methods.push({
        name,
        description: this.cleanJSDoc(jsdoc),
        params: this.parseParams(params, jsdoc),
        returns: { type: returnType?.trim() || 'void', description: '' },
        throws: this.extractThrows(jsdoc),
        examples: this.extractExamples(jsdoc),
        isAsync: fullMatch.includes('async'),
        isExported: true,
        line: 0,
      });
    }

    return methods;
  }

  private extractProperties(classBody: string): PropertyDoc[] {
    const properties: PropertyDoc[] = [];
    const propRegex = /(?:(?:public|private|protected)\s+)?(?:readonly\s+)?(?:static\s+)?(\w+)(?:\s*[?!])?(?:\s*:\s*([^;=]+))?(?:\s*=\s*[^;]+)?;/g;

    let match;
    while ((match = propRegex.exec(classBody)) !== null) {
      const [fullMatch, name, type] = match;

      if (name === 'constructor') continue;

      properties.push({
        name,
        type: type?.trim() || 'unknown',
        description: '',
        isReadonly: fullMatch.includes('readonly'),
        isStatic: fullMatch.includes('static'),
        isPrivate: fullMatch.includes('private'),
      });
    }

    return properties;
  }

  private extractInterfaceProperties(body: string): PropertyDoc[] {
    const properties: PropertyDoc[] = [];
    const propRegex = /(\w+)(\?)?:\s*([^;]+);/g;

    let match;
    while ((match = propRegex.exec(body)) !== null) {
      const [, name, _optional, type] = match;

      properties.push({
        name,
        type: type.trim(),
        description: '',
        isReadonly: false,
        isStatic: false,
        isPrivate: false,
      });
    }

    return properties;
  }

  private extractJSDocAbove(content: string, index: number): string {
    const beforeIndex = content.substring(0, index);
    const lastJSDoc = beforeIndex.lastIndexOf('/**');

    if (lastJSDoc === -1) return '';

    const between = beforeIndex.substring(lastJSDoc);
    const closingIndex = between.indexOf('*/');

    if (closingIndex === -1) return '';

    // Check there's only whitespace between JSDoc and target
    const afterJSDoc = between.substring(closingIndex + 2);
    if (afterJSDoc.trim().length > 0) return '';

    return between.substring(0, closingIndex + 2);
  }

  private extractBlockBody(content: string, startIndex: number): string {
    let braceCount = 1;
    let i = startIndex + 1;

    while (i < content.length && braceCount > 0) {
      if (content[i] === '{') braceCount++;
      if (content[i] === '}') braceCount--;
      i++;
    }

    return content.substring(startIndex, i);
  }

  private cleanJSDoc(jsdoc: string): string {
    if (!jsdoc) return '';

    return jsdoc
      .replace(/^\/\*\*\s*/m, '')
      .replace(/\s*\*\/$/m, '')
      .replace(/^\s*\*\s?/gm, '')
      .replace(/@\w+[^\n]*/g, '')
      .trim();
  }

  private parseParams(paramsStr: string, jsdoc: string): ParamDoc[] {
    if (!paramsStr.trim()) return [];

    const params: ParamDoc[] = [];
    const paramParts = paramsStr.split(',');

    for (const part of paramParts) {
      const match = part.match(/(\w+)(\?)?(?:\s*:\s*([^=]+))?(?:\s*=\s*(.+))?/);
      if (match) {
        const [, name, optional, type, defaultValue] = match;

        // Try to find description in JSDoc
        const paramDoc = jsdoc.match(new RegExp(`@param\\s+(?:\\{[^}]+\\}\\s+)?${name}\\s+(.+)`));

        params.push({
          name,
          type: type?.trim() || 'any',
          description: paramDoc?.[1]?.trim() || '',
          optional: !!optional || !!defaultValue,
          defaultValue: defaultValue?.trim(),
        });
      }
    }

    return params;
  }

  private extractThrows(jsdoc: string): string[] {
    const throws: string[] = [];
    const throwsRegex = /@throws\s+(?:\{([^}]+)\}\s+)?(.+)/g;

    let match;
    while ((match = throwsRegex.exec(jsdoc)) !== null) {
      throws.push(match[2].trim());
    }

    return throws;
  }

  private extractExamples(jsdoc: string): string[] {
    const examples: string[] = [];
    const exampleRegex = /@example\s+([\s\S]+?)(?=@|$)/g;

    let match;
    while ((match = exampleRegex.exec(jsdoc)) !== null) {
      examples.push(match[1].trim());
    }

    return examples;
  }

  private needsJSDoc(line: string, prevLine?: string): boolean {
    // Skip if already has JSDoc
    if (prevLine?.trim().endsWith('*/')) return false;

    // Check if this line is a function/class/etc that needs docs
    return !!(
      line.match(/(?:export\s+)?(?:async\s+)?function\s+\w+/) ||
      line.match(/(?:export\s+)?class\s+\w+/) ||
      line.match(/(?:export\s+)?interface\s+\w+/) ||
      line.match(/(?:export\s+)?type\s+\w+/)
    );
  }

  private generateJSDocForLine(line: string, _lines: string[], _index: number): string {
    const funcMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
    if (funcMatch) {
      const [, name, params] = funcMatch;
      return this.buildJSDoc(name, params);
    }

    const classMatch = line.match(/(?:export\s+)?class\s+(\w+)/);
    if (classMatch) {
      return `/**\n * ${classMatch[1]} class\n */`;
    }

    return '';
  }

  private buildJSDoc(name: string, paramsStr: string): string {
    let doc = `/**\n * ${name}\n`;

    if (paramsStr.trim()) {
      const params = paramsStr.split(',');
      for (const param of params) {
        const match = param.match(/(\w+)/);
        if (match) {
          doc += ` * @param ${match[1]} - Description\n`;
        }
      }
    }

    doc += ` * @returns Description\n */`;
    return doc;
  }

  private formatClassDoc(cls: ClassDoc): string {
    let doc = `### \`${cls.name}\`\n\n`;
    doc += `${cls.description || 'No description.'}\n\n`;

    if (cls.extends) {
      doc += `**Extends**: \`${cls.extends}\`\n\n`;
    }

    if (cls.methods.length > 0) {
      doc += `**Methods**:\n`;
      for (const method of cls.methods) {
        doc += `- \`${method.name}()\` - ${method.description || 'No description'}\n`;
      }
      doc += '\n';
    }

    return doc;
  }

  private formatFunctionDoc(func: FunctionDoc): string {
    let doc = `### \`${func.name}()\`\n\n`;
    doc += `${func.description || 'No description.'}\n\n`;

    if (func.params.length > 0) {
      doc += `**Parameters**:\n`;
      for (const param of func.params) {
        doc += `- \`${param.name}\` (${param.type}${param.optional ? '?' : ''}) - ${param.description || 'No description'}\n`;
      }
      doc += '\n';
    }

    doc += `**Returns**: \`${func.returns.type}\`\n\n`;

    return doc;
  }

  private formatTypeDoc(type: TypeDoc): string {
    let doc = `### \`${type.name}\` (${type.type})\n\n`;
    doc += `${type.description || 'No description.'}\n\n`;

    if (type.properties && type.properties.length > 0) {
      doc += `**Properties**:\n`;
      for (const prop of type.properties) {
        doc += `- \`${prop.name}\`: \`${prop.type}\`\n`;
      }
      doc += '\n';
    }

    return doc;
  }
}
