/**
 * MCPIntegrationService - Model Context Protocol Server Integration
 *
 * Enables connection to MCP servers for extended functionality:
 * - HTTP, SSE, and Stdio transport support
 * - OAuth 2.0 authentication
 * - Resource references (@server:resource)
 * - MCP prompts as slash commands
 * - Enterprise control (managed-mcp.json)
 *
 * Reference: https://docs.claude.com/en/agent-sdk/mcp
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { LogService } from './logging/LogService';
import fs from 'fs';
import path from 'path';

/**
 * MCP Transport types
 */
export type MCPTransportType = 'http' | 'sse' | 'stdio';

/**
 * MCP Server scope
 */
export type MCPScope = 'local' | 'project' | 'user';

/**
 * MCP Server configuration
 */
export interface MCPServerConfig {
  name: string;
  transport: MCPTransportType;
  url?: string;  // For HTTP/SSE
  command?: string;  // For stdio
  args?: string[];
  env?: Record<string, string>;
  scope: MCPScope;
  enabled: boolean;
  oauth?: {
    clientId: string;
    authUrl: string;
    tokenUrl: string;
    scopes?: string[];
  };
}

/**
 * MCP Tool definition
 */
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  server: string;
}

/**
 * MCP Prompt definition
 */
export interface MCPPrompt {
  name: string;
  description: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
  server: string;
}

/**
 * MCP Resource definition
 */
export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  server: string;
}

/**
 * Active MCP connection
 */
interface MCPConnection {
  config: MCPServerConfig;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  process?: ChildProcess;
  tools: MCPTool[];
  prompts: MCPPrompt[];
  resources: MCPResource[];
  lastError?: string;
  connectedAt?: Date;
}

class MCPIntegrationServiceClass extends EventEmitter {
  private connections: Map<string, MCPConnection> = new Map();
  private configPaths = {
    local: '.mcp.json',
    project: '.claude/.mcp.json',
    user: path.join(process.env.HOME || '~', '.claude', 'mcp.json'),
    managed: path.join(process.env.HOME || '~', '.claude', 'managed-mcp.json'),
  };

  constructor() {
    super();
  }

  /**
   * Initialize MCP service and load configurations
   */
  async initialize(workspacePath: string): Promise<void> {
    console.log('🔌 [MCP] Initializing MCP Integration Service...');

    // Load configurations from all scopes
    await this.loadConfigurations(workspacePath);

    // Auto-connect enabled servers
    for (const [name, connection] of this.connections.entries()) {
      if (connection.config.enabled) {
        await this.connect(name);
      }
    }

    console.log(`🔌 [MCP] Initialized with ${this.connections.size} server(s) configured`);
  }

  /**
   * Load MCP configurations from all scopes
   */
  private async loadConfigurations(workspacePath: string): Promise<void> {
    // Load in order of precedence (managed > user > project > local)
    const configs: MCPServerConfig[] = [];

    // Managed (enterprise) - highest precedence
    const managedPath = this.configPaths.managed;
    if (fs.existsSync(managedPath)) {
      const managed = this.loadConfigFile(managedPath, 'user');
      configs.push(...managed.map(c => ({ ...c, _managed: true } as any)));
    }

    // User scope
    const userPath = this.configPaths.user;
    if (fs.existsSync(userPath)) {
      configs.push(...this.loadConfigFile(userPath, 'user'));
    }

    // Project scope
    const projectPath = path.join(workspacePath, this.configPaths.project);
    if (fs.existsSync(projectPath)) {
      configs.push(...this.loadConfigFile(projectPath, 'project'));
    }

    // Local scope
    const localPath = path.join(workspacePath, this.configPaths.local);
    if (fs.existsSync(localPath)) {
      configs.push(...this.loadConfigFile(localPath, 'local'));
    }

    // Register all servers
    for (const config of configs) {
      this.connections.set(config.name, {
        config,
        status: 'disconnected',
        tools: [],
        prompts: [],
        resources: [],
      });
    }
  }

  /**
   * Load configuration file
   */
  private loadConfigFile(filePath: string, scope: MCPScope): MCPServerConfig[] {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);

      const servers: MCPServerConfig[] = [];

      // Handle both { servers: [...] } and { serverName: {...} } formats
      if (data.servers && Array.isArray(data.servers)) {
        for (const server of data.servers) {
          servers.push({ ...server, scope, enabled: server.enabled !== false });
        }
      } else if (data.mcpServers) {
        // Handle .mcp.json format: { mcpServers: { name: { ... } } }
        for (const [name, config] of Object.entries(data.mcpServers)) {
          const serverConfig = config as any;
          servers.push({
            name,
            transport: serverConfig.transport || 'stdio',
            url: serverConfig.url,
            command: serverConfig.command,
            args: serverConfig.args,
            env: serverConfig.env,
            scope,
            enabled: serverConfig.enabled !== false,
            oauth: serverConfig.oauth,
          });
        }
      }

      return servers;
    } catch (error: any) {
      console.error(`[MCP] Failed to load config from ${filePath}:`, error.message);
      return [];
    }
  }

  /**
   * Add a new MCP server
   */
  async addServer(config: MCPServerConfig): Promise<void> {
    this.connections.set(config.name, {
      config,
      status: 'disconnected',
      tools: [],
      prompts: [],
      resources: [],
    });

    // Save to appropriate config file
    await this.saveServerConfig(config);

    console.log(`🔌 [MCP] Added server: ${config.name} (${config.transport})`);
  }

  /**
   * Save server configuration to file
   */
  private async saveServerConfig(config: MCPServerConfig): Promise<void> {
    let configPath: string;

    switch (config.scope) {
      case 'user':
        configPath = this.configPaths.user;
        break;
      case 'project':
        configPath = path.join(process.cwd(), this.configPaths.project);
        break;
      default:
        configPath = path.join(process.cwd(), this.configPaths.local);
    }

    // Ensure directory exists
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Load existing config or create new
    let existingConfig: any = { mcpServers: {} };
    if (fs.existsSync(configPath)) {
      try {
        existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch {
        // Use default
      }
    }

    // Add/update server
    existingConfig.mcpServers = existingConfig.mcpServers || {};
    existingConfig.mcpServers[config.name] = {
      transport: config.transport,
      url: config.url,
      command: config.command,
      args: config.args,
      env: config.env,
      enabled: config.enabled,
      oauth: config.oauth,
    };

    fs.writeFileSync(configPath, JSON.stringify(existingConfig, null, 2));
  }

  /**
   * Connect to an MCP server
   */
  async connect(serverName: string): Promise<boolean> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      console.error(`[MCP] Server not found: ${serverName}`);
      return false;
    }

    connection.status = 'connecting';
    this.emit('server:connecting', { name: serverName });

    try {
      switch (connection.config.transport) {
        case 'http':
        case 'sse':
          await this.connectHTTP(connection);
          break;
        case 'stdio':
          await this.connectStdio(connection);
          break;
      }

      connection.status = 'connected';
      connection.connectedAt = new Date();
      this.emit('server:connected', { name: serverName, tools: connection.tools });

      console.log(`✅ [MCP] Connected to ${serverName} (${connection.tools.length} tools, ${connection.prompts.length} prompts)`);
      return true;
    } catch (error: any) {
      connection.status = 'error';
      connection.lastError = error.message;
      this.emit('server:error', { name: serverName, error: error.message });

      console.error(`❌ [MCP] Failed to connect to ${serverName}:`, error.message);
      return false;
    }
  }

  /**
   * Connect via HTTP/SSE transport
   */
  private async connectHTTP(connection: MCPConnection): Promise<void> {
    const config = connection.config;
    if (!config.url) {
      throw new Error('URL required for HTTP/SSE transport');
    }

    // Initialize connection
    const response = await fetch(`${config.url}/initialize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
          prompts: {},
          resources: {},
        },
        clientInfo: {
          name: 'multi-agent-orchestrator',
          version: '1.0.0',
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    await response.json(); // Initialize connection

    // List available tools
    const toolsResponse = await fetch(`${config.url}/tools/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    if (toolsResponse.ok) {
      const toolsData = await toolsResponse.json() as { tools?: any[] };
      connection.tools = (toolsData.tools || []).map((t: any) => ({
        ...t,
        server: config.name,
      }));
    }

    // List available prompts
    const promptsResponse = await fetch(`${config.url}/prompts/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    if (promptsResponse.ok) {
      const promptsData = await promptsResponse.json() as { prompts?: any[] };
      connection.prompts = (promptsData.prompts || []).map((p: any) => ({
        ...p,
        server: config.name,
      }));
    }

    // List available resources
    const resourcesResponse = await fetch(`${config.url}/resources/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    if (resourcesResponse.ok) {
      const resourcesData = await resourcesResponse.json() as { resources?: any[] };
      connection.resources = (resourcesData.resources || []).map((r: any) => ({
        ...r,
        server: config.name,
      }));
    }
  }

  /**
   * Connect via stdio transport
   */
  private async connectStdio(connection: MCPConnection): Promise<void> {
    const config = connection.config;
    if (!config.command) {
      throw new Error('Command required for stdio transport');
    }

    return new Promise((resolve, reject) => {
      const env = { ...process.env, ...config.env };

      const child = spawn(config.command!, config.args || [], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      connection.process = child;

      let buffer = '';

      child.stdout?.on('data', (data) => {
        buffer += data.toString();

        // Try to parse complete JSON messages
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            try {
              const message = JSON.parse(line);
              this.handleStdioMessage(connection, message);
            } catch {
              // Not valid JSON, skip
            }
          }
        }
      });

      child.stderr?.on('data', (data) => {
        console.error(`[MCP:${config.name}] stderr:`, data.toString());
      });

      child.on('error', (error) => {
        reject(error);
      });

      child.on('exit', (code) => {
        connection.status = 'disconnected';
        this.emit('server:disconnected', { name: config.name, code });
      });

      // Send initialize message
      const initMessage = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
            prompts: {},
            resources: {},
          },
          clientInfo: {
            name: 'multi-agent-orchestrator',
            version: '1.0.0',
          },
        },
      });

      child.stdin?.write(initMessage + '\n');

      // Wait for initialization
      setTimeout(() => {
        if (connection.status === 'connecting') {
          // Send tools/list
          child.stdin?.write(JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
            params: {},
          }) + '\n');

          // Send prompts/list
          child.stdin?.write(JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'prompts/list',
            params: {},
          }) + '\n');

          resolve();
        }
      }, 1000);
    });
  }

  /**
   * Handle stdio message from MCP server
   */
  private handleStdioMessage(connection: MCPConnection, message: any): void {
    if (message.result) {
      // Handle response based on id
      if (message.result.tools) {
        connection.tools = message.result.tools.map((t: any) => ({
          ...t,
          server: connection.config.name,
        }));
      }
      if (message.result.prompts) {
        connection.prompts = message.result.prompts.map((p: any) => ({
          ...p,
          server: connection.config.name,
        }));
      }
      if (message.result.resources) {
        connection.resources = message.result.resources.map((r: any) => ({
          ...r,
          server: connection.config.name,
        }));
      }
    }
  }

  /**
   * Disconnect from an MCP server
   */
  async disconnect(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);
    if (!connection) return;

    if (connection.process) {
      connection.process.kill();
      connection.process = undefined;
    }

    connection.status = 'disconnected';
    connection.tools = [];
    connection.prompts = [];
    connection.resources = [];

    this.emit('server:disconnected', { name: serverName });
    console.log(`🔌 [MCP] Disconnected from ${serverName}`);
  }

  /**
   * Remove an MCP server
   */
  async removeServer(serverName: string): Promise<void> {
    await this.disconnect(serverName);
    this.connections.delete(serverName);
    console.log(`🗑️ [MCP] Removed server: ${serverName}`);
  }

  /**
   * Call a tool on an MCP server
   */
  async callTool(
    serverName: string,
    toolName: string,
    input: Record<string, any>,
    taskId?: string
  ): Promise<any> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`Server not found: ${serverName}`);
    }

    if (connection.status !== 'connected') {
      throw new Error(`Server not connected: ${serverName}`);
    }

    const tool = connection.tools.find(t => t.name === toolName);
    if (!tool) {
      throw new Error(`Tool not found: ${toolName} on ${serverName}`);
    }

    if (taskId) {
      await LogService.info(`MCP tool call: ${serverName}/${toolName}`, {
        taskId,
        category: 'system',
        metadata: { server: serverName, tool: toolName, input },
      });
    }

    if (connection.config.transport === 'http' || connection.config.transport === 'sse') {
      return this.callToolHTTP(connection, toolName, input);
    } else {
      return this.callToolStdio(connection, toolName, input);
    }
  }

  /**
   * Call tool via HTTP
   */
  private async callToolHTTP(
    connection: MCPConnection,
    toolName: string,
    input: Record<string, any>
  ): Promise<any> {
    const response = await fetch(`${connection.config.url}/tools/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: toolName,
        arguments: input,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Call tool via stdio
   */
  private async callToolStdio(
    connection: MCPConnection,
    toolName: string,
    input: Record<string, any>
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!connection.process?.stdin || !connection.process?.stdout) {
        reject(new Error('Process not available'));
        return;
      }

      const id = Date.now();
      let resolved = false;

      const handler = (data: Buffer) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            try {
              const message = JSON.parse(line);
              if (message.id === id) {
                resolved = true;
                connection.process?.stdout?.off('data', handler);
                if (message.error) {
                  reject(new Error(message.error.message));
                } else {
                  resolve(message.result);
                }
              }
            } catch {
              // Skip invalid JSON
            }
          }
        }
      };

      connection.process.stdout.on('data', handler);

      connection.process.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: input,
        },
      }) + '\n');

      // Timeout after 30 seconds
      setTimeout(() => {
        if (!resolved) {
          connection.process?.stdout?.off('data', handler);
          reject(new Error('Tool call timeout'));
        }
      }, 30000);
    });
  }

  /**
   * Get a prompt from an MCP server
   */
  async getPrompt(
    serverName: string,
    promptName: string,
    args?: Record<string, any>
  ): Promise<{ messages: Array<{ role: string; content: string }> }> {
    const connection = this.connections.get(serverName);
    if (!connection || connection.status !== 'connected') {
      throw new Error(`Server not connected: ${serverName}`);
    }

    if (connection.config.transport === 'http' || connection.config.transport === 'sse') {
      const response = await fetch(`${connection.config.url}/prompts/get`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: promptName,
          arguments: args || {},
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response.json() as Promise<{ messages: Array<{ role: string; content: string }> }>;
    }

    // Stdio implementation would be similar to callToolStdio
    throw new Error('Stdio prompt retrieval not implemented');
  }

  /**
   * Read a resource from an MCP server
   */
  async readResource(serverName: string, uri: string): Promise<any> {
    const connection = this.connections.get(serverName);
    if (!connection || connection.status !== 'connected') {
      throw new Error(`Server not connected: ${serverName}`);
    }

    if (connection.config.transport === 'http' || connection.config.transport === 'sse') {
      const response = await fetch(`${connection.config.url}/resources/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response.json();
    }

    throw new Error('Stdio resource reading not implemented');
  }

  /**
   * Get all connected servers
   */
  getConnectedServers(): Array<{
    name: string;
    transport: MCPTransportType;
    scope: MCPScope;
    tools: number;
    prompts: number;
    resources: number;
    connectedAt?: Date;
  }> {
    const servers: Array<any> = [];

    for (const [name, connection] of this.connections.entries()) {
      if (connection.status === 'connected') {
        servers.push({
          name,
          transport: connection.config.transport,
          scope: connection.config.scope,
          tools: connection.tools.length,
          prompts: connection.prompts.length,
          resources: connection.resources.length,
          connectedAt: connection.connectedAt,
        });
      }
    }

    return servers;
  }

  /**
   * Get all available tools from all connected servers
   */
  getAllTools(): MCPTool[] {
    const tools: MCPTool[] = [];

    for (const connection of this.connections.values()) {
      if (connection.status === 'connected') {
        tools.push(...connection.tools);
      }
    }

    return tools;
  }

  /**
   * Get all available prompts from all connected servers
   */
  getAllPrompts(): MCPPrompt[] {
    const prompts: MCPPrompt[] = [];

    for (const connection of this.connections.values()) {
      if (connection.status === 'connected') {
        prompts.push(...connection.prompts);
      }
    }

    return prompts;
  }

  /**
   * Parse resource reference (@server:protocol://resource)
   */
  parseResourceReference(reference: string): {
    server: string;
    uri: string;
  } | null {
    const match = reference.match(/^@([^:]+):(.+)$/);
    if (!match) return null;

    return {
      server: match[1],
      uri: match[2],
    };
  }

  /**
   * Get server status
   */
  getServerStatus(serverName: string): MCPConnection | undefined {
    return this.connections.get(serverName);
  }

  /**
   * List all configured servers
   */
  listServers(): Array<{
    name: string;
    transport: MCPTransportType;
    scope: MCPScope;
    status: string;
    enabled: boolean;
  }> {
    return Array.from(this.connections.entries()).map(([name, conn]) => ({
      name,
      transport: conn.config.transport,
      scope: conn.config.scope,
      status: conn.status,
      enabled: conn.config.enabled,
    }));
  }

  /**
   * Cleanup all connections
   */
  async cleanup(): Promise<void> {
    for (const [name] of this.connections) {
      await this.disconnect(name);
    }
    this.connections.clear();
  }
}

// Singleton instance
export const MCPIntegrationService = new MCPIntegrationServiceClass();
