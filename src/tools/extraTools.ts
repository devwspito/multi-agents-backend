/**
 * Extra Tools - Additional MCP Tools for Claude Code-like functionality
 *
 * Tool implementations have been moved to ./categories/ for better organization.
 * This file now re-exports all tools and provides the MCP server factory.
 */

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

// Re-export all categorized tools for backward compatibility
export {
  // Memory tools
  memoryRecallTool,
  memoryRememberTool,
  memoryFeedbackTool,
  // Scaffolding tools
  scaffoldTestTool,
  scaffoldComponentTool,
  scaffoldServiceTool,
  scaffoldModelTool,
  // Web tools
  webSearchTool,
  webFetchTool,
  browserPreviewTool,
  exposePortTool,
  screenshotCaptureTool,
  inspectSiteTool,
  httpRequestTool,
  // IDE tools
  todoWriteTool,
  notebookEditTool,
  logUserMessageTool,
  updatePlanTool,
  thinkTool,
  waitTool,
  undoEditTool,
  readLintsTool,
  reportEnvironmentIssueTool,
  // Code navigation tools
  goToDefinitionTool,
  goToReferencesTool,
  codebaseRetrievalTool,
  semanticSearchTool,
  hoverSymbolTool,
  trajectorySearchTool,
  // Git tools
  gitCommitRetrievalTool,
  // Package tools
  packageManagerTool,
  deploymentConfigTool,
  knowledgeBaseTool,
  // Refactoring tools
  findAndEditTool,
  safeRenameSymbolTool,
  extractFunctionTool,
  // Analysis tools
  analyzeDependenciesTool,
  findUnusedExportsTool,
  checkBundleImpactTool,
  profileFunctionTool,
  findNPlusOneTool,
  checkAccessibilityTool,
  // Documentation tools
  generateDesignInspirationTool,
  generateJsdocTool,
  extractApiDocsTool,
  // Sandbox tools (Docker container execution)
  sandboxBashTool,
  sandboxStatusTool,
  sandboxFileSyncTool,
} from './categories';

// Re-export sandbox context functions for use in AgentExecutorService
export { setSandboxContext, clearSandboxContext, getSandboxContext } from './categories';

// Import for use in createExtraToolsServer
import {
  memoryRecallTool,
  memoryRememberTool,
  memoryFeedbackTool,
  scaffoldTestTool,
  scaffoldComponentTool,
  scaffoldServiceTool,
  scaffoldModelTool,
  webSearchTool,
  webFetchTool,
  browserPreviewTool,
  exposePortTool,
  screenshotCaptureTool,
  inspectSiteTool,
  httpRequestTool,
  todoWriteTool,
  notebookEditTool,
  logUserMessageTool,
  updatePlanTool,
  thinkTool,
  waitTool,
  undoEditTool,
  readLintsTool,
  reportEnvironmentIssueTool,
  goToDefinitionTool,
  goToReferencesTool,
  codebaseRetrievalTool,
  semanticSearchTool,
  hoverSymbolTool,
  trajectorySearchTool,
  gitCommitRetrievalTool,
  packageManagerTool,
  deploymentConfigTool,
  knowledgeBaseTool,
  findAndEditTool,
  safeRenameSymbolTool,
  extractFunctionTool,
  analyzeDependenciesTool,
  findUnusedExportsTool,
  checkBundleImpactTool,
  profileFunctionTool,
  findNPlusOneTool,
  checkAccessibilityTool,
  generateDesignInspirationTool,
  generateJsdocTool,
  extractApiDocsTool,
  // Sandbox tools
  sandboxBashTool,
  sandboxStatusTool,
  sandboxFileSyncTool,
} from './categories';

/**
 * Create MCP server with all extra tools
 */
export function createExtraToolsServer() {
  return createSdkMcpServer({
    name: 'extra-tools',
    version: '4.0.0',
    tools: [
      // Web tools
      webSearchTool,
      webFetchTool,
      browserPreviewTool,
      exposePortTool,
      screenshotCaptureTool,
      inspectSiteTool,
      httpRequestTool,
      // IDE tools
      todoWriteTool,
      notebookEditTool,
      logUserMessageTool,
      updatePlanTool,
      thinkTool,
      waitTool,
      undoEditTool,
      readLintsTool,
      reportEnvironmentIssueTool,
      // Code navigation tools
      goToDefinitionTool,
      goToReferencesTool,
      codebaseRetrievalTool,
      semanticSearchTool,
      hoverSymbolTool,
      trajectorySearchTool,
      // Git tools
      gitCommitRetrievalTool,
      // Package tools
      packageManagerTool,
      deploymentConfigTool,
      knowledgeBaseTool,
      // Refactoring tools
      findAndEditTool,
      safeRenameSymbolTool,
      extractFunctionTool,
      // Analysis tools
      analyzeDependenciesTool,
      findUnusedExportsTool,
      checkBundleImpactTool,
      profileFunctionTool,
      findNPlusOneTool,
      checkAccessibilityTool,
      // Documentation tools
      generateDesignInspirationTool,
      generateJsdocTool,
      extractApiDocsTool,
      // Memory tools
      memoryRecallTool,
      memoryRememberTool,
      memoryFeedbackTool,
      // Scaffolding tools
      scaffoldTestTool,
      scaffoldComponentTool,
      scaffoldServiceTool,
      scaffoldModelTool,
      // 🐳 Sandbox tools (Docker container execution)
      sandboxBashTool,
      sandboxStatusTool,
      sandboxFileSyncTool,
    ],
  });
}
