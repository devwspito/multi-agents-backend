/**
 * SemanticCodeSearch
 *
 * Search code by meaning, not just keywords.
 * Uses AST parsing and semantic understanding to find relevant code.
 *
 * Key behaviors:
 * 1. Understand what code DOES, not just what it contains
 * 2. Find similar implementations across codebase
 * 3. Locate code by intent (e.g., "find where users are authenticated")
 * 4. Cross-reference related functionality
 */

import * as fs from 'fs';
import * as path from 'path';

export interface CodeEntity {
  type: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'method';
  name: string;
  file: string;
  line: number;
  signature?: string;
  docstring?: string;
  semanticTags: string[];
  dependencies: string[];
  usedBy: string[];
}

export interface SemanticMatch {
  entity: CodeEntity;
  relevanceScore: number; // 0-100
  matchReason: string;
  matchedConcepts: string[];
}

export interface SearchResult {
  query: string;
  interpretedIntent: string;
  matches: SemanticMatch[];
  relatedConcepts: string[];
  searchDuration: number;
}

export interface SemanticIndex {
  entities: Map<string, CodeEntity>;
  conceptMap: Map<string, string[]>; // concept -> entity IDs
  fileIndex: Map<string, string[]>; // file -> entity IDs
  timestamp: number;
}

// Semantic concept mappings
const CONCEPT_PATTERNS: Record<string, RegExp[]> = {
  authentication: [
    /auth/i, /login/i, /logout/i, /signin/i, /signout/i, /password/i,
    /token/i, /jwt/i, /session/i, /credential/i, /oauth/i,
  ],
  authorization: [
    /permission/i, /role/i, /access/i, /privilege/i, /authorize/i,
    /acl/i, /policy/i, /guard/i,
  ],
  validation: [
    /valid/i, /check/i, /verify/i, /sanitize/i, /parse/i, /schema/i,
    /constraint/i, /rule/i,
  ],
  database: [
    /db/i, /database/i, /query/i, /model/i, /schema/i, /repository/i,
    /mongoose/i, /sequelize/i, /prisma/i, /sql/i, /mongo/i,
  ],
  api: [
    /api/i, /endpoint/i, /route/i, /controller/i, /handler/i,
    /request/i, /response/i, /rest/i, /graphql/i,
  ],
  error_handling: [
    /error/i, /exception/i, /catch/i, /throw/i, /fail/i,
    /recover/i, /retry/i, /fallback/i,
  ],
  testing: [
    /test/i, /spec/i, /mock/i, /stub/i, /assert/i, /expect/i,
    /describe/i, /it\(/i, /jest/i, /vitest/i,
  ],
  logging: [
    /log/i, /logger/i, /debug/i, /trace/i, /console/i,
    /monitor/i, /metric/i, /telemetry/i,
  ],
  caching: [
    /cache/i, /memo/i, /store/i, /redis/i, /ttl/i,
    /invalidate/i, /refresh/i,
  ],
  async_operations: [
    /async/i, /await/i, /promise/i, /callback/i, /queue/i,
    /worker/i, /job/i, /scheduler/i,
  ],
  file_operations: [
    /file/i, /read/i, /write/i, /stream/i, /buffer/i,
    /path/i, /directory/i, /fs\./i,
  ],
  http: [
    /http/i, /fetch/i, /axios/i, /request/i, /response/i,
    /get\(/i, /post\(/i, /put\(/i, /delete\(/i, /patch\(/i,
  ],
  state_management: [
    /state/i, /store/i, /redux/i, /context/i, /reducer/i,
    /action/i, /dispatch/i, /selector/i,
  ],
  configuration: [
    /config/i, /setting/i, /option/i, /env/i, /constant/i,
    /parameter/i, /preference/i,
  ],
  security: [
    /security/i, /encrypt/i, /decrypt/i, /hash/i, /secret/i,
    /key/i, /salt/i, /cipher/i, /sanitize/i,
  ],
};

// Intent patterns for natural language queries
const INTENT_PATTERNS: { pattern: RegExp; intent: string; concepts: string[] }[] = [
  { pattern: /where.*user.*auth/i, intent: 'Find user authentication code', concepts: ['authentication'] },
  { pattern: /how.*error.*handle/i, intent: 'Find error handling logic', concepts: ['error_handling'] },
  { pattern: /validate.*input/i, intent: 'Find input validation', concepts: ['validation'] },
  { pattern: /connect.*database/i, intent: 'Find database connection', concepts: ['database'] },
  { pattern: /api.*endpoint/i, intent: 'Find API endpoints', concepts: ['api'] },
  { pattern: /cache.*data/i, intent: 'Find caching logic', concepts: ['caching'] },
  { pattern: /log.*message/i, intent: 'Find logging code', concepts: ['logging'] },
  { pattern: /test.*function/i, intent: 'Find test code', concepts: ['testing'] },
  { pattern: /read.*file/i, intent: 'Find file reading code', concepts: ['file_operations'] },
  { pattern: /fetch.*data/i, intent: 'Find HTTP requests', concepts: ['http'] },
  { pattern: /manage.*state/i, intent: 'Find state management', concepts: ['state_management'] },
  { pattern: /security.*check/i, intent: 'Find security checks', concepts: ['security'] },
];

export class SemanticCodeSearch {
  private static index: SemanticIndex | null = null;

  /**
   * Build semantic index for workspace
   */
  static async buildIndex(workspacePath: string): Promise<SemanticIndex> {
    console.log(`\n🔍 [SemanticSearch] Building semantic index...`);

    const index: SemanticIndex = {
      entities: new Map(),
      conceptMap: new Map(),
      fileIndex: new Map(),
      timestamp: Date.now(),
    };

    // Find all source files
    const files = await this.findSourceFiles(workspacePath);
    console.log(`   Found ${files.length} source files`);

    // Parse each file
    for (const file of files) {
      try {
        const entities = await this.parseFile(workspacePath, file);

        for (const entity of entities) {
          const entityId = `${entity.file}:${entity.name}:${entity.line}`;
          index.entities.set(entityId, entity);

          // Add to file index
          if (!index.fileIndex.has(entity.file)) {
            index.fileIndex.set(entity.file, []);
          }
          index.fileIndex.get(entity.file)!.push(entityId);

          // Add to concept map
          for (const tag of entity.semanticTags) {
            if (!index.conceptMap.has(tag)) {
              index.conceptMap.set(tag, []);
            }
            index.conceptMap.get(tag)!.push(entityId);
          }
        }
      } catch {
        // Skip files that can't be parsed
      }
    }

    console.log(`   Indexed ${index.entities.size} code entities`);
    console.log(`   Mapped ${index.conceptMap.size} semantic concepts`);

    this.index = index;
    return index;
  }

  /**
   * Search code by semantic meaning
   */
  static async search(query: string, options?: {
    maxResults?: number;
    minRelevance?: number;
    fileFilter?: string[];
    conceptFilter?: string[];
  }): Promise<SearchResult> {
    const startTime = Date.now();
    const maxResults = options?.maxResults || 20;
    const minRelevance = options?.minRelevance || 30;

    if (!this.index) {
      return {
        query,
        interpretedIntent: 'Index not built',
        matches: [],
        relatedConcepts: [],
        searchDuration: Date.now() - startTime,
      };
    }

    // Interpret the query intent
    const { intent, concepts } = this.interpretQuery(query);

    // Find matching entities
    const matches: SemanticMatch[] = [];
    const queryTerms = query.toLowerCase().split(/\s+/);

    for (const [_entityId, entity] of this.index.entities) {
      // Apply file filter
      if (options?.fileFilter && !options.fileFilter.some(f => entity.file.includes(f))) {
        continue;
      }

      // Apply concept filter
      if (options?.conceptFilter && !options.conceptFilter.some(c => entity.semanticTags.includes(c))) {
        continue;
      }

      const { score, reason, matchedConcepts } = this.calculateRelevance(
        entity,
        queryTerms,
        concepts
      );

      if (score >= minRelevance) {
        matches.push({
          entity,
          relevanceScore: score,
          matchReason: reason,
          matchedConcepts,
        });
      }
    }

    // Sort by relevance and limit results
    matches.sort((a, b) => b.relevanceScore - a.relevanceScore);
    const topMatches = matches.slice(0, maxResults);

    // Find related concepts
    const relatedConcepts = this.findRelatedConcepts(concepts, topMatches);

    return {
      query,
      interpretedIntent: intent,
      matches: topMatches,
      relatedConcepts,
      searchDuration: Date.now() - startTime,
    };
  }

  /**
   * Find similar code to a given entity
   */
  static findSimilar(entityId: string, maxResults: number = 10): SemanticMatch[] {
    if (!this.index) return [];

    const entity = this.index.entities.get(entityId);
    if (!entity) return [];

    const matches: SemanticMatch[] = [];

    for (const [id, candidate] of this.index.entities) {
      if (id === entityId) continue;

      // Calculate similarity based on:
      // 1. Same semantic tags
      // 2. Similar dependencies
      // 3. Same type
      let score = 0;
      const matchedConcepts: string[] = [];

      // Tag overlap
      const tagOverlap = entity.semanticTags.filter(t => candidate.semanticTags.includes(t));
      score += tagOverlap.length * 20;
      matchedConcepts.push(...tagOverlap);

      // Same type bonus
      if (entity.type === candidate.type) {
        score += 15;
      }

      // Dependency overlap
      const depOverlap = entity.dependencies.filter(d => candidate.dependencies.includes(d));
      score += depOverlap.length * 10;

      // Name similarity
      if (this.similarNames(entity.name, candidate.name)) {
        score += 25;
      }

      if (score > 20) {
        matches.push({
          entity: candidate,
          relevanceScore: Math.min(100, score),
          matchReason: `Similar ${entity.type} with shared concepts`,
          matchedConcepts,
        });
      }
    }

    matches.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return matches.slice(0, maxResults);
  }

  /**
   * Search by concept
   */
  static searchByConcept(concept: string): CodeEntity[] {
    if (!this.index) return [];

    const entityIds = this.index.conceptMap.get(concept) || [];
    return entityIds
      .map(id => this.index!.entities.get(id))
      .filter((e): e is CodeEntity => e !== undefined);
  }

  /**
   * Get entities in file
   */
  static getFileEntities(file: string): CodeEntity[] {
    if (!this.index) return [];

    const entityIds = this.index.fileIndex.get(file) || [];
    return entityIds
      .map(id => this.index!.entities.get(id))
      .filter((e): e is CodeEntity => e !== undefined);
  }

  /**
   * Interpret natural language query
   */
  private static interpretQuery(query: string): { intent: string; concepts: string[] } {
    // Check against intent patterns
    for (const { pattern, intent, concepts } of INTENT_PATTERNS) {
      if (pattern.test(query)) {
        return { intent, concepts };
      }
    }

    // Extract concepts from query terms
    const concepts: string[] = [];
    const queryLower = query.toLowerCase();

    for (const [concept, patterns] of Object.entries(CONCEPT_PATTERNS)) {
      if (patterns.some(p => p.test(queryLower))) {
        concepts.push(concept);
      }
    }

    return {
      intent: concepts.length > 0
        ? `Search for ${concepts.join(', ')} related code`
        : `Search for: ${query}`,
      concepts,
    };
  }

  /**
   * Calculate relevance score
   */
  private static calculateRelevance(
    entity: CodeEntity,
    queryTerms: string[],
    concepts: string[]
  ): { score: number; reason: string; matchedConcepts: string[] } {
    let score = 0;
    const matchedConcepts: string[] = [];
    const reasons: string[] = [];

    // Concept matching (highest weight)
    const conceptMatches = concepts.filter(c => entity.semanticTags.includes(c));
    if (conceptMatches.length > 0) {
      score += conceptMatches.length * 30;
      matchedConcepts.push(...conceptMatches);
      reasons.push(`Matches concepts: ${conceptMatches.join(', ')}`);
    }

    // Name matching
    const nameLower = entity.name.toLowerCase();
    const nameMatches = queryTerms.filter(t => nameLower.includes(t));
    if (nameMatches.length > 0) {
      score += nameMatches.length * 25;
      reasons.push(`Name contains: ${nameMatches.join(', ')}`);
    }

    // Docstring matching
    if (entity.docstring) {
      const docLower = entity.docstring.toLowerCase();
      const docMatches = queryTerms.filter(t => docLower.includes(t));
      if (docMatches.length > 0) {
        score += docMatches.length * 15;
        reasons.push(`Documentation mentions: ${docMatches.join(', ')}`);
      }
    }

    // Signature matching
    if (entity.signature) {
      const sigLower = entity.signature.toLowerCase();
      const sigMatches = queryTerms.filter(t => sigLower.includes(t));
      if (sigMatches.length > 0) {
        score += sigMatches.length * 10;
        reasons.push(`Signature contains: ${sigMatches.join(', ')}`);
      }
    }

    return {
      score: Math.min(100, score),
      reason: reasons.join('; ') || 'Partial keyword match',
      matchedConcepts,
    };
  }

  /**
   * Find related concepts based on search results
   */
  private static findRelatedConcepts(queryConcepts: string[], matches: SemanticMatch[]): string[] {
    const relatedConcepts = new Set<string>();

    for (const match of matches.slice(0, 10)) {
      for (const tag of match.entity.semanticTags) {
        if (!queryConcepts.includes(tag)) {
          relatedConcepts.add(tag);
        }
      }
    }

    return Array.from(relatedConcepts).slice(0, 5);
  }

  /**
   * Check if two names are similar
   */
  private static similarNames(name1: string, name2: string): boolean {
    // Same base word
    const base1 = name1.replace(/^(get|set|is|has|create|update|delete|handle|process|validate)/i, '');
    const base2 = name2.replace(/^(get|set|is|has|create|update|delete|handle|process|validate)/i, '');

    return base1.toLowerCase() === base2.toLowerCase() && base1.length > 2;
  }

  /**
   * Find all source files
   */
  private static async findSourceFiles(workspacePath: string): Promise<string[]> {
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
          } else if (entry.name.match(/\.(ts|tsx|js|jsx)$/)) {
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
   * Parse a file for code entities
   */
  private static async parseFile(workspacePath: string, file: string): Promise<CodeEntity[]> {
    const fullPath = path.join(workspacePath, file);
    const content = fs.readFileSync(fullPath, 'utf8');
    const entities: CodeEntity[] = [];
    const lines = content.split('\n');

    let currentDocstring = '';
    let lineNumber = 0;

    for (const line of lines) {
      lineNumber++;

      // Capture docstrings
      if (line.includes('/**') || line.includes('/*')) {
        currentDocstring = line;
      } else if (currentDocstring && (line.includes('*/') || !line.includes('*'))) {
        if (line.includes('*/')) {
          currentDocstring += ' ' + line;
        }
      } else if (currentDocstring && line.trim().startsWith('*')) {
        currentDocstring += ' ' + line.replace(/^\s*\*\s*/, '');
      }

      // Parse functions
      const funcMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
      if (funcMatch) {
        entities.push(this.createEntity('function', funcMatch[1], file, lineNumber,
          `function ${funcMatch[1]}(${funcMatch[2]})`, currentDocstring, content));
        currentDocstring = '';
      }

      // Parse arrow functions
      const arrowMatch = line.match(/(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::|=>)/);
      if (arrowMatch) {
        entities.push(this.createEntity('function', arrowMatch[1], file, lineNumber,
          line.trim(), currentDocstring, content));
        currentDocstring = '';
      }

      // Parse classes
      const classMatch = line.match(/(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[\w,\s]+)?/);
      if (classMatch) {
        entities.push(this.createEntity('class', classMatch[1], file, lineNumber,
          line.trim(), currentDocstring, content));
        currentDocstring = '';
      }

      // Parse interfaces
      const interfaceMatch = line.match(/(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+[\w,\s]+)?/);
      if (interfaceMatch) {
        entities.push(this.createEntity('interface', interfaceMatch[1], file, lineNumber,
          line.trim(), currentDocstring, content));
        currentDocstring = '';
      }

      // Parse types
      const typeMatch = line.match(/(?:export\s+)?type\s+(\w+)\s*=/);
      if (typeMatch) {
        entities.push(this.createEntity('type', typeMatch[1], file, lineNumber,
          line.trim(), currentDocstring, content));
        currentDocstring = '';
      }

      // Parse methods inside classes
      const methodMatch = line.match(/^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[\w<>[\]|&\s]+)?\s*\{/);
      if (methodMatch && !['if', 'for', 'while', 'switch', 'catch'].includes(methodMatch[1])) {
        entities.push(this.createEntity('method', methodMatch[1], file, lineNumber,
          line.trim(), currentDocstring, content));
        currentDocstring = '';
      }
    }

    return entities;
  }

  /**
   * Create a code entity with semantic tags
   */
  private static createEntity(
    type: CodeEntity['type'],
    name: string,
    file: string,
    line: number,
    signature: string,
    docstring: string,
    fileContent: string
  ): CodeEntity {
    const semanticTags: string[] = [];

    // Determine semantic tags based on name and content
    const nameLower = name.toLowerCase();

    for (const [concept, patterns] of Object.entries(CONCEPT_PATTERNS)) {
      // Check name
      if (patterns.some(p => p.test(nameLower))) {
        semanticTags.push(concept);
        continue;
      }

      // Check docstring
      if (docstring && patterns.some(p => p.test(docstring.toLowerCase()))) {
        semanticTags.push(concept);
        continue;
      }

      // Check signature
      if (patterns.some(p => p.test(signature.toLowerCase()))) {
        semanticTags.push(concept);
      }
    }

    // Extract dependencies (imports used)
    const dependencies: string[] = [];
    const importMatches = fileContent.matchAll(/import\s+(?:{([^}]+)}|(\w+))\s+from\s+['"]([^'"]+)['"]/g);
    for (const match of importMatches) {
      if (match[3] && !match[3].startsWith('.')) {
        dependencies.push(match[3]);
      }
    }

    return {
      type,
      name,
      file,
      line,
      signature,
      docstring: docstring || undefined,
      semanticTags: [...new Set(semanticTags)],
      dependencies: [...new Set(dependencies)].slice(0, 10),
      usedBy: [],
    };
  }

  /**
   * Format search results for prompt
   */
  static formatResultsForPrompt(result: SearchResult): string {
    if (result.matches.length === 0) {
      return `No code found for: "${result.query}"`;
    }

    let output = `
## 🔍 Semantic Search Results

**Query**: "${result.query}"
**Intent**: ${result.interpretedIntent}
**Found**: ${result.matches.length} matches in ${result.searchDuration}ms

### Top Matches:

`;

    for (const match of result.matches.slice(0, 10)) {
      const icon = match.entity.type === 'class' ? '📦' :
                   match.entity.type === 'function' ? '⚡' :
                   match.entity.type === 'interface' ? '📋' :
                   match.entity.type === 'method' ? '🔧' : '📄';

      output += `${icon} **${match.entity.name}** (${match.relevanceScore}%)
   - File: \`${match.entity.file}:${match.entity.line}\`
   - Type: ${match.entity.type}
   - Why: ${match.matchReason}
   ${match.matchedConcepts.length > 0 ? `- Concepts: ${match.matchedConcepts.join(', ')}` : ''}

`;
    }

    if (result.relatedConcepts.length > 0) {
      output += `\n### Related Concepts: ${result.relatedConcepts.join(', ')}\n`;
    }

    return output;
  }

  /**
   * Generate instructions for agents
   */
  static generateInstructions(): string {
    return `
## 🔍 SEMANTIC CODE SEARCH

Search code by meaning, not just keywords:

### Query Examples:

| Query | Finds |
|-------|-------|
| "where is user authenticated" | Authentication logic |
| "how are errors handled" | Error handling code |
| "database connection" | DB setup/queries |
| "validate input data" | Input validation |
| "cache user data" | Caching logic |

### Concepts Available:

- **authentication**: login, JWT, sessions, OAuth
- **authorization**: permissions, roles, access control
- **validation**: input checking, schemas
- **database**: queries, models, repositories
- **api**: endpoints, routes, controllers
- **error_handling**: try-catch, recovery
- **testing**: tests, mocks, assertions
- **caching**: memoization, Redis, TTL
- **security**: encryption, hashing, sanitization

### Benefits:

- 🎯 Find code by INTENT, not exact keywords
- 🔗 Discover related functionality
- 📊 Ranked by relevance (0-100%)
- 🏷️ Automatic concept tagging
`;
  }
}
