/**
 * APIContractValidator
 *
 * Validates API contracts between frontend and backend.
 * Detects breaking changes and ensures type consistency.
 *
 * Key behaviors:
 * 1. Extract API contracts from route definitions
 * 2. Validate request/response schemas
 * 3. Detect breaking changes in API
 * 4. Generate TypeScript types for API
 */

import * as fs from 'fs';
import * as path from 'path';

export interface APIEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  file: string;
  line: number;
  handler: string;
  requestSchema?: SchemaDefinition;
  responseSchema?: SchemaDefinition;
  authentication?: boolean;
  deprecated?: boolean;
  version?: string;
}

export interface SchemaDefinition {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  properties?: Record<string, SchemaDefinition>;
  items?: SchemaDefinition;
  required?: string[];
  nullable?: boolean;
  enum?: string[];
  description?: string;
}

export interface ContractViolation {
  type: 'missing_field' | 'type_mismatch' | 'breaking_change' |
        'deprecated_usage' | 'inconsistent_response' | 'schema_drift';
  severity: 'error' | 'warning' | 'info';
  endpoint: string;
  message: string;
  location: { file: string; line?: number };
  suggestion: string;
}

export interface APIContract {
  version: string;
  baseUrl: string;
  endpoints: APIEndpoint[];
  types: Record<string, SchemaDefinition>;
  timestamp: number;
}

export interface ValidationResult {
  valid: boolean;
  contract: APIContract;
  violations: ContractViolation[];
  coverage: {
    documented: number;
    typed: number;
    tested: number;
  };
  recommendations: string[];
}

export interface BreakingChange {
  endpoint: string;
  type: 'removed' | 'method_changed' | 'path_changed' |
        'required_param_added' | 'response_type_changed';
  before: string;
  after: string;
  impact: 'high' | 'medium' | 'low';
  migration: string;
}

export class APIContractValidator {
  private static currentContract: APIContract | null = null;

  /**
   * Extract API contract from codebase
   */
  static async extractContract(workspacePath: string): Promise<APIContract> {
    console.log(`\n📋 [APIContractValidator] Extracting API contract...`);

    const endpoints: APIEndpoint[] = [];
    const types: Record<string, SchemaDefinition> = {};

    // Find route files
    const routeFiles = await this.findRouteFiles(workspacePath);
    console.log(`   Found ${routeFiles.length} route files`);

    for (const file of routeFiles) {
      const fileEndpoints = await this.parseRouteFile(workspacePath, file);
      endpoints.push(...fileEndpoints);
    }

    // Find type definitions
    const typeFiles = await this.findTypeFiles(workspacePath);
    for (const file of typeFiles) {
      const fileTypes = await this.parseTypeFile(workspacePath, file);
      Object.assign(types, fileTypes);
    }

    const contract: APIContract = {
      version: await this.getVersion(workspacePath),
      baseUrl: '/api',
      endpoints,
      types,
      timestamp: Date.now(),
    };

    this.currentContract = contract;

    console.log(`   Extracted ${endpoints.length} endpoints`);
    console.log(`   Found ${Object.keys(types).length} type definitions`);

    return contract;
  }

  /**
   * Validate API contract
   */
  static async validate(workspacePath: string, contract?: APIContract): Promise<ValidationResult> {
    console.log(`\n✅ [APIContractValidator] Validating API contract...`);

    const targetContract = contract || this.currentContract || await this.extractContract(workspacePath);
    const violations: ContractViolation[] = [];

    // Check each endpoint
    for (const endpoint of targetContract.endpoints) {
      // Check for missing schemas
      if (!endpoint.requestSchema && ['POST', 'PUT', 'PATCH'].includes(endpoint.method)) {
        violations.push({
          type: 'schema_drift',
          severity: 'warning',
          endpoint: `${endpoint.method} ${endpoint.path}`,
          message: 'No request schema defined for mutation endpoint',
          location: { file: endpoint.file, line: endpoint.line },
          suggestion: 'Add request body validation with Zod or express-validator',
        });
      }

      if (!endpoint.responseSchema) {
        violations.push({
          type: 'schema_drift',
          severity: 'info',
          endpoint: `${endpoint.method} ${endpoint.path}`,
          message: 'No response schema defined',
          location: { file: endpoint.file, line: endpoint.line },
          suggestion: 'Define response type for documentation and type safety',
        });
      }

      // Check for deprecated endpoints
      if (endpoint.deprecated) {
        violations.push({
          type: 'deprecated_usage',
          severity: 'warning',
          endpoint: `${endpoint.method} ${endpoint.path}`,
          message: 'Endpoint is marked as deprecated',
          location: { file: endpoint.file, line: endpoint.line },
          suggestion: 'Plan migration to replacement endpoint',
        });
      }

      // Validate path patterns
      const pathIssues = this.validatePathPattern(endpoint.path);
      for (const issue of pathIssues) {
        violations.push({
          type: 'inconsistent_response',
          severity: 'warning',
          endpoint: `${endpoint.method} ${endpoint.path}`,
          message: issue,
          location: { file: endpoint.file, line: endpoint.line },
          suggestion: 'Follow RESTful naming conventions',
        });
      }
    }

    // Check for duplicate routes
    const routeMap = new Map<string, APIEndpoint[]>();
    for (const endpoint of targetContract.endpoints) {
      const key = `${endpoint.method} ${endpoint.path}`;
      if (!routeMap.has(key)) {
        routeMap.set(key, []);
      }
      routeMap.get(key)!.push(endpoint);
    }

    for (const [route, endpoints] of routeMap) {
      if (endpoints.length > 1) {
        violations.push({
          type: 'inconsistent_response',
          severity: 'error',
          endpoint: route,
          message: `Duplicate route definition (${endpoints.length} occurrences)`,
          location: { file: endpoints[0].file, line: endpoints[0].line },
          suggestion: 'Remove duplicate route definitions',
        });
      }
    }

    // Calculate coverage
    const documented = targetContract.endpoints.filter(e => e.responseSchema).length;
    const typed = targetContract.endpoints.filter(e => e.requestSchema || e.responseSchema).length;
    const tested = 0; // Would need to scan test files

    const coverage = {
      documented: Math.round((documented / Math.max(1, targetContract.endpoints.length)) * 100),
      typed: Math.round((typed / Math.max(1, targetContract.endpoints.length)) * 100),
      tested,
    };

    // Generate recommendations
    const recommendations = this.generateRecommendations(violations, coverage);

    console.log(`   Found ${violations.filter(v => v.severity === 'error').length} errors`);
    console.log(`   Found ${violations.filter(v => v.severity === 'warning').length} warnings`);
    console.log(`   Documentation coverage: ${coverage.documented}%`);

    return {
      valid: violations.filter(v => v.severity === 'error').length === 0,
      contract: targetContract,
      violations,
      coverage,
      recommendations,
    };
  }

  /**
   * Compare two contracts for breaking changes
   */
  static detectBreakingChanges(oldContract: APIContract, newContract: APIContract): BreakingChange[] {
    const changes: BreakingChange[] = [];

    // Build endpoint maps
    const oldEndpoints = new Map(oldContract.endpoints.map(e => [`${e.method} ${e.path}`, e]));
    const newEndpoints = new Map(newContract.endpoints.map(e => [`${e.method} ${e.path}`, e]));

    // Check for removed endpoints
    for (const [key, _endpoint] of oldEndpoints) {
      if (!newEndpoints.has(key)) {
        changes.push({
          endpoint: key,
          type: 'removed',
          before: key,
          after: 'N/A',
          impact: 'high',
          migration: `Endpoint ${key} was removed. Update all clients to use the replacement.`,
        });
      }
    }

    // Check for changes in existing endpoints
    for (const [key, newEndpoint] of newEndpoints) {
      const oldEndpoint = oldEndpoints.get(key);
      if (!oldEndpoint) continue; // New endpoint, not a breaking change

      // Check schema changes
      if (newEndpoint.requestSchema && oldEndpoint.requestSchema) {
        const schemaChanges = this.compareSchemas(oldEndpoint.requestSchema, newEndpoint.requestSchema);
        for (const change of schemaChanges) {
          if (change.breaking) {
            changes.push({
              endpoint: key,
              type: 'required_param_added',
              before: change.before,
              after: change.after,
              impact: 'medium',
              migration: change.migration,
            });
          }
        }
      }
    }

    return changes;
  }

  /**
   * Compare two schemas
   */
  private static compareSchemas(oldSchema: SchemaDefinition, newSchema: SchemaDefinition): {
    breaking: boolean;
    before: string;
    after: string;
    migration: string;
  }[] {
    const changes: { breaking: boolean; before: string; after: string; migration: string }[] = [];

    // Check type changes
    if (oldSchema.type !== newSchema.type) {
      changes.push({
        breaking: true,
        before: `type: ${oldSchema.type}`,
        after: `type: ${newSchema.type}`,
        migration: 'Update client to handle new type',
      });
    }

    // Check for new required fields
    if (newSchema.required && oldSchema.required) {
      const newRequired = newSchema.required.filter(r => !oldSchema.required!.includes(r));
      for (const field of newRequired) {
        changes.push({
          breaking: true,
          before: `${field}: optional`,
          after: `${field}: required`,
          migration: `Field '${field}' is now required. Ensure all clients provide this field.`,
        });
      }
    }

    // Check for removed fields
    if (oldSchema.properties && newSchema.properties) {
      for (const field of Object.keys(oldSchema.properties)) {
        if (!(field in newSchema.properties)) {
          changes.push({
            breaking: true,
            before: `${field}: present`,
            after: `${field}: removed`,
            migration: `Field '${field}' was removed. Update clients that depend on it.`,
          });
        }
      }
    }

    return changes;
  }

  /**
   * Generate TypeScript types from contract
   */
  static generateTypes(contract: APIContract): string {
    let output = `// Auto-generated API types from contract\n`;
    output += `// Generated: ${new Date(contract.timestamp).toISOString()}\n\n`;

    // Generate endpoint types
    for (const endpoint of contract.endpoints) {
      const typeName = this.pathToTypeName(endpoint.path, endpoint.method);

      if (endpoint.requestSchema) {
        output += `export interface ${typeName}Request `;
        output += this.schemaToType(endpoint.requestSchema);
        output += '\n\n';
      }

      if (endpoint.responseSchema) {
        output += `export interface ${typeName}Response `;
        output += this.schemaToType(endpoint.responseSchema);
        output += '\n\n';
      }
    }

    // Generate shared types
    for (const [name, schema] of Object.entries(contract.types)) {
      output += `export interface ${name} `;
      output += this.schemaToType(schema);
      output += '\n\n';
    }

    return output;
  }

  /**
   * Convert path to type name
   */
  private static pathToTypeName(path: string, method: string): string {
    const parts = path
      .replace(/^\/api\//, '')
      .replace(/:[a-zA-Z]+/g, 'ById')
      .split('/')
      .map(p => p.charAt(0).toUpperCase() + p.slice(1));

    return method.charAt(0) + method.slice(1).toLowerCase() + parts.join('');
  }

  /**
   * Convert schema to TypeScript type
   */
  private static schemaToType(schema: SchemaDefinition, indent: number = 0): string {
    const pad = '  '.repeat(indent);

    switch (schema.type) {
      case 'string':
        return schema.enum ? schema.enum.map(e => `'${e}'`).join(' | ') : 'string';
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'null':
        return 'null';
      case 'array':
        return schema.items ? `${this.schemaToType(schema.items)}[]` : 'unknown[]';
      case 'object':
        if (!schema.properties) return 'Record<string, unknown>';
        const props = Object.entries(schema.properties).map(([key, value]) => {
          const optional = schema.required?.includes(key) ? '' : '?';
          return `${pad}  ${key}${optional}: ${this.schemaToType(value, indent + 1)}`;
        });
        return `{\n${props.join(';\n')};\n${pad}}`;
      default:
        return 'unknown';
    }
  }

  /**
   * Find route files
   */
  private static async findRouteFiles(workspacePath: string): Promise<string[]> {
    const patterns = ['routes', 'api', 'controllers', 'endpoints'];
    const files: string[] = [];

    const walk = (dir: string, prefix: string = ''): void => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
            continue;
          }

          const fullPath = path.join(dir, entry.name);
          const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

          if (entry.isDirectory()) {
            walk(fullPath, relativePath);
          } else if (
            entry.name.match(/\.(ts|js)$/) &&
            (patterns.some(p => relativePath.includes(p)) || entry.name.includes('route'))
          ) {
            files.push(relativePath);
          }
        }
      } catch {
        // Ignore errors
      }
    };

    walk(workspacePath);
    return files;
  }

  /**
   * Parse route file for endpoints
   */
  private static async parseRouteFile(workspacePath: string, file: string): Promise<APIEndpoint[]> {
    const endpoints: APIEndpoint[] = [];
    const fullPath = path.join(workspacePath, file);
    const content = fs.readFileSync(fullPath, 'utf8');
    const lines = content.split('\n');

    // Match Express-style routes
    const routePatterns = [
      /router\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
      /app\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
      /(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
    ];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      for (const pattern of routePatterns) {
        pattern.lastIndex = 0;
        let match;

        while ((match = pattern.exec(line)) !== null) {
          const method = match[1].toUpperCase() as APIEndpoint['method'];
          const routePath = match[2];

          // Try to extract handler name
          const handlerMatch = line.match(/,\s*(\w+)\s*\)/);
          const handler = handlerMatch ? handlerMatch[1] : 'anonymous';

          // Check for authentication middleware
          const hasAuth = line.includes('auth') || line.includes('protect');

          // Check for deprecation
          const deprecated = lines.slice(Math.max(0, i - 3), i).some(l =>
            l.includes('@deprecated') || l.includes('deprecated')
          );

          endpoints.push({
            method,
            path: routePath.startsWith('/') ? routePath : `/${routePath}`,
            file,
            line: i + 1,
            handler,
            authentication: hasAuth,
            deprecated,
          });
        }
      }
    }

    return endpoints;
  }

  /**
   * Find type definition files
   */
  private static async findTypeFiles(workspacePath: string): Promise<string[]> {
    const files: string[] = [];

    const walk = (dir: string, prefix: string = ''): void => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
            continue;
          }

          const fullPath = path.join(dir, entry.name);
          const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

          if (entry.isDirectory()) {
            walk(fullPath, relativePath);
          } else if (
            entry.name.match(/\.d\.ts$/) ||
            entry.name.includes('types') ||
            entry.name.includes('interface')
          ) {
            files.push(relativePath);
          }
        }
      } catch {
        // Ignore errors
      }
    };

    walk(workspacePath);
    return files;
  }

  /**
   * Parse type file for definitions
   */
  private static async parseTypeFile(
    workspacePath: string,
    file: string
  ): Promise<Record<string, SchemaDefinition>> {
    const types: Record<string, SchemaDefinition> = {};
    const fullPath = path.join(workspacePath, file);

    try {
      const content = fs.readFileSync(fullPath, 'utf8');

      // Match interface definitions
      const interfaceRegex = /(?:export\s+)?interface\s+(\w+)\s*\{([^}]+)\}/g;
      let match;

      while ((match = interfaceRegex.exec(content)) !== null) {
        const name = match[1];
        const body = match[2];

        types[name] = this.parseInterfaceBody(body);
      }

      // Match type definitions
      const typeRegex = /(?:export\s+)?type\s+(\w+)\s*=\s*\{([^}]+)\}/g;

      while ((match = typeRegex.exec(content)) !== null) {
        const name = match[1];
        const body = match[2];

        types[name] = this.parseInterfaceBody(body);
      }
    } catch {
      // Ignore parse errors
    }

    return types;
  }

  /**
   * Parse interface body to schema
   */
  private static parseInterfaceBody(body: string): SchemaDefinition {
    const schema: SchemaDefinition = {
      type: 'object',
      properties: {},
      required: [],
    };

    const propRegex = /(\w+)(\?)?:\s*([^;]+)/g;
    let match;

    while ((match = propRegex.exec(body)) !== null) {
      const name = match[1];
      const optional = match[2] === '?';
      const typeStr = match[3].trim();

      if (!optional) {
        schema.required!.push(name);
      }

      schema.properties![name] = this.typeStringToSchema(typeStr);
    }

    return schema;
  }

  /**
   * Convert TypeScript type string to schema
   */
  private static typeStringToSchema(typeStr: string): SchemaDefinition {
    typeStr = typeStr.trim();

    if (typeStr === 'string') return { type: 'string' };
    if (typeStr === 'number') return { type: 'number' };
    if (typeStr === 'boolean') return { type: 'boolean' };
    if (typeStr === 'null') return { type: 'null' };
    if (typeStr.endsWith('[]')) return { type: 'array', items: this.typeStringToSchema(typeStr.slice(0, -2)) };
    if (typeStr.startsWith("'") || typeStr.includes("'")) {
      const values = typeStr.split('|').map(v => v.trim().replace(/'/g, ''));
      return { type: 'string', enum: values };
    }

    return { type: 'object' };
  }

  /**
   * Get version from package.json
   */
  private static async getVersion(workspacePath: string): Promise<string> {
    try {
      const pkgPath = path.join(workspacePath, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      return pkg.version || '1.0.0';
    } catch {
      return '1.0.0';
    }
  }

  /**
   * Validate path pattern
   */
  private static validatePathPattern(routePath: string): string[] {
    const issues: string[] = [];

    // Check for inconsistent naming
    if (routePath.includes('_') && routePath.includes('-')) {
      issues.push('Mixed underscore and hyphen naming');
    }

    // Check for uppercase
    if (/[A-Z]/.test(routePath)) {
      issues.push('Path contains uppercase letters (use lowercase)');
    }

    // Check for version in path
    if (/\/v\d+\//.test(routePath) === false && !routePath.includes('version')) {
      // Could suggest versioning, but it's optional
    }

    // Check for trailing slash
    if (routePath.endsWith('/') && routePath !== '/') {
      issues.push('Path has trailing slash');
    }

    return issues;
  }

  /**
   * Generate recommendations
   */
  private static generateRecommendations(
    violations: ContractViolation[],
    coverage: { documented: number; typed: number; tested: number }
  ): string[] {
    const recommendations: string[] = [];

    const errors = violations.filter(v => v.severity === 'error');
    const warnings = violations.filter(v => v.severity === 'warning');

    if (errors.length > 0) {
      recommendations.push(`🚨 Fix ${errors.length} critical API contract errors`);
    }

    if (warnings.length > 5) {
      recommendations.push(`⚠️ Address ${warnings.length} API contract warnings`);
    }

    if (coverage.documented < 50) {
      recommendations.push(`📝 Improve documentation coverage (currently ${coverage.documented}%)`);
    }

    if (coverage.typed < 70) {
      recommendations.push(`🔷 Add type definitions for ${100 - coverage.typed}% of endpoints`);
    }

    if (violations.filter(v => v.type === 'deprecated_usage').length > 0) {
      recommendations.push(`⏰ Plan migration for deprecated endpoints`);
    }

    return recommendations;
  }

  /**
   * Format validation result for prompt
   */
  static formatResultForPrompt(result: ValidationResult): string {
    const icon = result.valid ? '✅' : '❌';

    let output = `
## ${icon} API Contract Validation

**Status**: ${result.valid ? 'VALID' : 'INVALID'}
**Version**: ${result.contract.version}
**Endpoints**: ${result.contract.endpoints.length}

### Coverage:
- 📝 Documented: ${result.coverage.documented}%
- 🔷 Typed: ${result.coverage.typed}%

### Violations:
`;

    if (result.violations.length === 0) {
      output += '✅ No violations found\n';
    } else {
      const errors = result.violations.filter(v => v.severity === 'error');
      const warnings = result.violations.filter(v => v.severity === 'warning');

      if (errors.length > 0) {
        output += `\n**❌ Errors (${errors.length}):**\n`;
        for (const v of errors.slice(0, 5)) {
          output += `- ${v.endpoint}: ${v.message}\n`;
        }
      }

      if (warnings.length > 0) {
        output += `\n**⚠️ Warnings (${warnings.length}):**\n`;
        for (const v of warnings.slice(0, 5)) {
          output += `- ${v.endpoint}: ${v.message}\n`;
        }
      }
    }

    if (result.recommendations.length > 0) {
      output += `\n### Recommendations:\n`;
      output += result.recommendations.map(r => `- ${r}`).join('\n');
    }

    return output;
  }

  /**
   * Generate instructions for agents
   */
  static generateInstructions(): string {
    return `
## 📋 API CONTRACT VALIDATION

Ensure API consistency between frontend and backend:

### Checks Performed:

1. **Schema Validation**
   - Request body schemas defined
   - Response types documented
   - Type consistency

2. **Breaking Changes**
   - Removed endpoints
   - Changed required fields
   - Type modifications

3. **Best Practices**
   - RESTful naming
   - Versioning
   - Authentication markers

### When Modifying APIs:

| Change | Action |
|--------|--------|
| Add endpoint | Add schema and docs |
| Add field | Update types |
| Remove field | Mark deprecated first |
| Change type | Version the API |

### Coverage Goals:

- 🎯 100% documented: All endpoints have descriptions
- 🎯 100% typed: All request/response schemas defined
- 🎯 100% tested: Integration tests for all endpoints

### Contract File:

Keep \`api-contract.json\` updated:
\`\`\`json
{
  "version": "1.0.0",
  "endpoints": [...]
}
\`\`\`
`;
  }
}
