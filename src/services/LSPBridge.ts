/**
 * LSPBridge - Language Server Protocol Integration
 *
 * THIS IS A KEY DIFFERENTIATOR vs Claude Code.
 *
 * Provides real-time IDE-level code intelligence to agents:
 * - Go to definition
 * - Find references
 * - Get hover information (types, docs)
 * - Code completions
 * - Diagnostics (errors, warnings)
 * - Rename symbol
 * - Code actions (quick fixes)
 *
 * This gives our agents the same capabilities as a full IDE.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// ==================== TYPES ====================

export interface LSPPosition {
  line: number;    // 0-indexed
  character: number;  // 0-indexed
}

export interface LSPRange {
  start: LSPPosition;
  end: LSPPosition;
}

export interface LSPLocation {
  uri: string;
  range: LSPRange;
}

export interface LSPDiagnostic {
  range: LSPRange;
  message: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  source?: string;
  code?: string | number;
}

export interface LSPCompletionItem {
  label: string;
  kind: string;
  detail?: string;
  documentation?: string;
  insertText?: string;
}

export interface LSPHoverInfo {
  contents: string;
  range?: LSPRange;
}

export interface LSPSymbol {
  name: string;
  kind: string;
  location: LSPLocation;
  containerName?: string;
}

export interface LSPCodeAction {
  title: string;
  kind: string;
  diagnostics?: LSPDiagnostic[];
  edit?: {
    changes: Record<string, Array<{ range: LSPRange; newText: string }>>;
  };
}

export type LanguageId = 'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'java';

interface LSPServerConfig {
  command: string;
  args: string[];
  initializationOptions?: Record<string, any>;
}

// ==================== LSP BRIDGE ====================

export class LSPBridge {
  private static instance: LSPBridge;
  private servers: Map<LanguageId, LSPServerProcess> = new Map();
  private workspacePath: string;
  private initialized: boolean = false;

  private constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  static getInstance(workspacePath?: string): LSPBridge {
    if (!LSPBridge.instance) {
      LSPBridge.instance = new LSPBridge(workspacePath || process.cwd());
    }
    return LSPBridge.instance;
  }

  /**
   * Initialize LSP servers for detected languages
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const languages = await this.detectLanguages();

    for (const lang of languages) {
      try {
        await this.startServer(lang);
      } catch (error) {
        console.warn(`[LSPBridge] Could not start ${lang} server:`, error);
      }
    }

    this.initialized = true;
  }

  /**
   * Go to definition
   */
  async goToDefinition(
    filePath: string,
    position: LSPPosition
  ): Promise<LSPLocation[]> {
    const lang = this.getLanguageId(filePath);
    const server = this.servers.get(lang);

    if (!server) {
      return [];
    }

    return server.sendRequest('textDocument/definition', {
      textDocument: { uri: this.pathToUri(filePath) },
      position
    });
  }

  /**
   * Find all references
   */
  async findReferences(
    filePath: string,
    position: LSPPosition,
    includeDeclaration: boolean = true
  ): Promise<LSPLocation[]> {
    const lang = this.getLanguageId(filePath);
    const server = this.servers.get(lang);

    if (!server) {
      return [];
    }

    return server.sendRequest('textDocument/references', {
      textDocument: { uri: this.pathToUri(filePath) },
      position,
      context: { includeDeclaration }
    });
  }

  /**
   * Get hover information (types, documentation)
   */
  async getHoverInfo(
    filePath: string,
    position: LSPPosition
  ): Promise<LSPHoverInfo | null> {
    const lang = this.getLanguageId(filePath);
    const server = this.servers.get(lang);

    if (!server) {
      return null;
    }

    const result = await server.sendRequest('textDocument/hover', {
      textDocument: { uri: this.pathToUri(filePath) },
      position
    });

    if (!result) return null;

    return {
      contents: this.extractHoverContents(result.contents),
      range: result.range
    };
  }

  /**
   * Get completions at position
   */
  async getCompletions(
    filePath: string,
    position: LSPPosition
  ): Promise<LSPCompletionItem[]> {
    const lang = this.getLanguageId(filePath);
    const server = this.servers.get(lang);

    if (!server) {
      return [];
    }

    const result = await server.sendRequest('textDocument/completion', {
      textDocument: { uri: this.pathToUri(filePath) },
      position
    });

    const items = Array.isArray(result) ? result : result?.items || [];

    return items.map((item: any) => ({
      label: item.label,
      kind: this.completionKindToString(item.kind),
      detail: item.detail,
      documentation: this.extractDocumentation(item.documentation),
      insertText: item.insertText || item.label
    }));
  }

  /**
   * Get diagnostics for a file
   */
  async getDiagnostics(filePath: string): Promise<LSPDiagnostic[]> {
    const lang = this.getLanguageId(filePath);
    const server = this.servers.get(lang);

    if (!server) {
      return [];
    }

    // Force a document update to get fresh diagnostics
    const content = await fs.promises.readFile(filePath, 'utf-8');
    await this.notifyDocumentOpen(filePath, content);

    // Wait a bit for diagnostics to be computed
    await new Promise(resolve => setTimeout(resolve, 500));

    return server.getDiagnostics(this.pathToUri(filePath));
  }

  /**
   * Get all workspace symbols matching query
   */
  async getWorkspaceSymbols(query: string): Promise<LSPSymbol[]> {
    const results: LSPSymbol[] = [];

    for (const server of this.servers.values()) {
      const symbols = await server.sendRequest('workspace/symbol', { query });

      if (Array.isArray(symbols)) {
        for (const sym of symbols) {
          results.push({
            name: sym.name,
            kind: this.symbolKindToString(sym.kind),
            location: {
              uri: sym.location.uri,
              range: sym.location.range
            },
            containerName: sym.containerName
          });
        }
      }
    }

    return results;
  }

  /**
   * Get document symbols (outline)
   */
  async getDocumentSymbols(filePath: string): Promise<LSPSymbol[]> {
    const lang = this.getLanguageId(filePath);
    const server = this.servers.get(lang);

    if (!server) {
      return [];
    }

    const result = await server.sendRequest('textDocument/documentSymbol', {
      textDocument: { uri: this.pathToUri(filePath) }
    });

    return this.flattenSymbols(result, filePath);
  }

  /**
   * Get code actions (quick fixes, refactorings)
   */
  async getCodeActions(
    filePath: string,
    range: LSPRange,
    diagnostics?: LSPDiagnostic[]
  ): Promise<LSPCodeAction[]> {
    const lang = this.getLanguageId(filePath);
    const server = this.servers.get(lang);

    if (!server) {
      return [];
    }

    const result = await server.sendRequest('textDocument/codeAction', {
      textDocument: { uri: this.pathToUri(filePath) },
      range,
      context: {
        diagnostics: diagnostics || []
      }
    });

    return (result || []).map((action: any) => ({
      title: action.title,
      kind: action.kind || 'quickfix',
      diagnostics: action.diagnostics,
      edit: action.edit
    }));
  }

  /**
   * Rename symbol
   */
  async renameSymbol(
    filePath: string,
    position: LSPPosition,
    newName: string
  ): Promise<Record<string, Array<{ range: LSPRange; newText: string }>>> {
    const lang = this.getLanguageId(filePath);
    const server = this.servers.get(lang);

    if (!server) {
      return {};
    }

    const result = await server.sendRequest('textDocument/rename', {
      textDocument: { uri: this.pathToUri(filePath) },
      position,
      newName
    });

    return result?.changes || {};
  }

  /**
   * Notify document opened
   */
  async notifyDocumentOpen(filePath: string, content: string): Promise<void> {
    const lang = this.getLanguageId(filePath);
    const server = this.servers.get(lang);

    if (!server) return;

    await server.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: this.pathToUri(filePath),
        languageId: lang,
        version: 1,
        text: content
      }
    });
  }

  /**
   * Notify document changed
   */
  async notifyDocumentChange(filePath: string, content: string, version: number): Promise<void> {
    const lang = this.getLanguageId(filePath);
    const server = this.servers.get(lang);

    if (!server) return;

    await server.sendNotification('textDocument/didChange', {
      textDocument: {
        uri: this.pathToUri(filePath),
        version
      },
      contentChanges: [{ text: content }]
    });
  }

  /**
   * Shutdown all servers
   */
  async shutdown(): Promise<void> {
    for (const server of this.servers.values()) {
      await server.shutdown();
    }
    this.servers.clear();
    this.initialized = false;
  }

  /**
   * Get stats
   */
  getStats(): { activeServers: string[]; initialized: boolean } {
    return {
      activeServers: Array.from(this.servers.keys()),
      initialized: this.initialized
    };
  }

  // ==================== PRIVATE METHODS ====================

  private async detectLanguages(): Promise<LanguageId[]> {
    const languages: Set<LanguageId> = new Set();

    // Check for common file extensions
    const extensions: Record<string, LanguageId> = {
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.py': 'python',
      '.go': 'go',
      '.rs': 'rust',
      '.java': 'java'
    };

    const checkDir = async (dir: string, depth: number = 0) => {
      if (depth > 3) return; // Limit depth

      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

          if (entry.isFile()) {
            const ext = path.extname(entry.name);
            if (extensions[ext]) {
              languages.add(extensions[ext]);
            }
          } else if (entry.isDirectory()) {
            await checkDir(path.join(dir, entry.name), depth + 1);
          }
        }
      } catch {
        // Ignore errors
      }
    };

    await checkDir(this.workspacePath);
    return Array.from(languages);
  }

  private async startServer(lang: LanguageId): Promise<void> {
    const config = this.getServerConfig(lang);
    if (!config) {
      throw new Error(`No LSP server configured for ${lang}`);
    }

    const server = new LSPServerProcess(config, this.workspacePath);
    await server.start();
    this.servers.set(lang, server);
  }

  private getServerConfig(lang: LanguageId): LSPServerConfig | null {
    const configs: Record<LanguageId, LSPServerConfig> = {
      typescript: {
        command: 'typescript-language-server',
        args: ['--stdio'],
        initializationOptions: {
          preferences: {
            includeCompletionsForModuleExports: true,
            includeCompletionsWithInsertText: true
          }
        }
      },
      javascript: {
        command: 'typescript-language-server',
        args: ['--stdio']
      },
      python: {
        command: 'pylsp',
        args: []
      },
      go: {
        command: 'gopls',
        args: ['serve']
      },
      rust: {
        command: 'rust-analyzer',
        args: []
      },
      java: {
        command: 'jdtls',
        args: []
      }
    };

    return configs[lang] || null;
  }

  private getLanguageId(filePath: string): LanguageId {
    const ext = path.extname(filePath);
    const mapping: Record<string, LanguageId> = {
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.py': 'python',
      '.go': 'go',
      '.rs': 'rust',
      '.java': 'java'
    };
    return mapping[ext] || 'typescript';
  }

  private pathToUri(filePath: string): string {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.workspacePath, filePath);
    return `file://${absolutePath}`;
  }

  private extractHoverContents(contents: any): string {
    if (typeof contents === 'string') return contents;
    if (Array.isArray(contents)) {
      return contents.map(c => this.extractHoverContents(c)).join('\n');
    }
    if (contents?.value) return contents.value;
    return String(contents);
  }

  private extractDocumentation(doc: any): string | undefined {
    if (!doc) return undefined;
    if (typeof doc === 'string') return doc;
    if (doc.value) return doc.value;
    return undefined;
  }

  private completionKindToString(kind: number): string {
    const kinds = [
      '', 'Text', 'Method', 'Function', 'Constructor', 'Field',
      'Variable', 'Class', 'Interface', 'Module', 'Property',
      'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color',
      'File', 'Reference', 'Folder', 'EnumMember', 'Constant',
      'Struct', 'Event', 'Operator', 'TypeParameter'
    ];
    return kinds[kind] || 'Unknown';
  }

  private symbolKindToString(kind: number): string {
    const kinds = [
      '', 'File', 'Module', 'Namespace', 'Package', 'Class',
      'Method', 'Property', 'Field', 'Constructor', 'Enum',
      'Interface', 'Function', 'Variable', 'Constant', 'String',
      'Number', 'Boolean', 'Array', 'Object', 'Key', 'Null',
      'EnumMember', 'Struct', 'Event', 'Operator', 'TypeParameter'
    ];
    return kinds[kind] || 'Unknown';
  }

  private flattenSymbols(symbols: any[], filePath: string, container?: string): LSPSymbol[] {
    const results: LSPSymbol[] = [];

    for (const sym of symbols || []) {
      const location = sym.location || {
        uri: this.pathToUri(filePath),
        range: sym.range || sym.selectionRange
      };

      results.push({
        name: sym.name,
        kind: this.symbolKindToString(sym.kind),
        location,
        containerName: container
      });

      // Recurse into children
      if (sym.children) {
        results.push(...this.flattenSymbols(sym.children, filePath, sym.name));
      }
    }

    return results;
  }
}

// ==================== LSP SERVER PROCESS ====================

class LSPServerProcess {
  private process: ChildProcess | null = null;
  private config: LSPServerConfig;
  private workspacePath: string;
  private requestId: number = 0;
  private pendingRequests: Map<number, { resolve: Function; reject: Function }> = new Map();
  private diagnostics: Map<string, LSPDiagnostic[]> = new Map();
  private buffer: string = '';

  constructor(config: LSPServerConfig, workspacePath: string) {
    this.config = config;
    this.workspacePath = workspacePath;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(this.config.command, this.config.args, {
          cwd: this.workspacePath,
          stdio: ['pipe', 'pipe', 'pipe']
        });

        this.process.stdout?.on('data', (data) => this.handleData(data));
        this.process.stderr?.on('data', (data) => {
          console.warn(`[LSP ${this.config.command}] stderr:`, data.toString());
        });

        this.process.on('error', (error) => {
          reject(error);
        });

        this.process.on('close', (code) => {
          console.log(`[LSP ${this.config.command}] closed with code ${code}`);
        });

        // Send initialize request
        this.sendRequest('initialize', {
          processId: process.pid,
          rootUri: `file://${this.workspacePath}`,
          capabilities: {
            textDocument: {
              completion: { completionItem: { snippetSupport: true } },
              hover: { contentFormat: ['markdown', 'plaintext'] },
              definition: { linkSupport: true },
              references: {},
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: [] } } },
              rename: { prepareSupport: true },
              publishDiagnostics: { relatedInformation: true }
            },
            workspace: {
              symbol: { symbolKind: { valueSet: [] } }
            }
          },
          initializationOptions: this.config.initializationOptions
        }).then(() => {
          this.sendNotification('initialized', {});
          resolve();
        }).catch(reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  async sendRequest(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;

      this.pendingRequests.set(id, { resolve, reject });

      const message = {
        jsonrpc: '2.0',
        id,
        method,
        params
      };

      this.send(message);

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`LSP request ${method} timed out`));
        }
      }, 30000);
    });
  }

  async sendNotification(method: string, params: any): Promise<void> {
    const message = {
      jsonrpc: '2.0',
      method,
      params
    };

    this.send(message);
  }

  getDiagnostics(uri: string): LSPDiagnostic[] {
    return this.diagnostics.get(uri) || [];
  }

  async shutdown(): Promise<void> {
    if (!this.process) return;

    try {
      await this.sendRequest('shutdown', null);
      this.sendNotification('exit', null);
    } finally {
      this.process.kill();
      this.process = null;
    }
  }

  private send(message: any): void {
    if (!this.process?.stdin) return;

    const json = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;

    this.process.stdin.write(header + json);
  }

  private handleData(data: Buffer): void {
    this.buffer += data.toString();

    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this.buffer.substring(0, headerEnd);
      const contentLengthMatch = header.match(/Content-Length: (\d+)/);

      if (!contentLengthMatch) {
        this.buffer = this.buffer.substring(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;

      if (this.buffer.length < messageEnd) break;

      const messageJson = this.buffer.substring(messageStart, messageEnd);
      this.buffer = this.buffer.substring(messageEnd);

      try {
        const message = JSON.parse(messageJson);
        this.handleMessage(message);
      } catch {
        // Ignore malformed messages
      }
    }
  }

  private handleMessage(message: any): void {
    if (message.id !== undefined && this.pendingRequests.has(message.id)) {
      const { resolve, reject } = this.pendingRequests.get(message.id)!;
      this.pendingRequests.delete(message.id);

      if (message.error) {
        reject(new Error(message.error.message));
      } else {
        resolve(message.result);
      }
    } else if (message.method === 'textDocument/publishDiagnostics') {
      // Store diagnostics
      const { uri, diagnostics } = message.params;
      this.diagnostics.set(uri, diagnostics.map((d: any) => ({
        range: d.range,
        message: d.message,
        severity: this.severityToString(d.severity),
        source: d.source,
        code: d.code
      })));
    }
  }

  private severityToString(severity: number): LSPDiagnostic['severity'] {
    switch (severity) {
      case 1: return 'error';
      case 2: return 'warning';
      case 3: return 'info';
      case 4: return 'hint';
      default: return 'info';
    }
  }
}

// Export singleton getter
export function getLSPBridge(workspacePath?: string): LSPBridge {
  return LSPBridge.getInstance(workspacePath);
}
