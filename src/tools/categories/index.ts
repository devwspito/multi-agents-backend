/**
 * Tool Categories Index
 * Re-exports all categorized tools for easy import
 */

// Memory tools
export {
  memoryRecallTool,
  memoryRememberTool,
  memoryFeedbackTool,
} from './memoryTools';

// Scaffolding tools
export {
  scaffoldTestTool,
  scaffoldComponentTool,
  scaffoldServiceTool,
  scaffoldModelTool,
} from './scaffoldingTools';

// Web tools
export {
  webSearchTool,
  webFetchTool,
  browserPreviewTool,
  exposePortTool,
  screenshotCaptureTool,
  inspectSiteTool,
  httpRequestTool,
} from './webTools';

// IDE tools
export {
  todoWriteTool,
  notebookEditTool,
  logUserMessageTool,
  updatePlanTool,
  thinkTool,
  waitTool,
  undoEditTool,
  readLintsTool,
  reportEnvironmentIssueTool,
} from './ideTools';

// Code navigation tools
export {
  goToDefinitionTool,
  goToReferencesTool,
  codebaseRetrievalTool,
  semanticSearchTool,
  hoverSymbolTool,
  trajectorySearchTool,
} from './codeNavTools';

// Git tools
export {
  gitCommitRetrievalTool,
} from './gitTools';

// Package and deployment tools
export {
  packageManagerTool,
  deploymentConfigTool,
  knowledgeBaseTool,
} from './packageTools';

// Refactoring tools
export {
  findAndEditTool,
  safeRenameSymbolTool,
  extractFunctionTool,
} from './refactoringTools';

// Analysis tools
export {
  analyzeDependenciesTool,
  findUnusedExportsTool,
  checkBundleImpactTool,
  profileFunctionTool,
  findNPlusOneTool,
  checkAccessibilityTool,
} from './analysisTools';

// Documentation tools
export {
  generateDesignInspirationTool,
  generateJsdocTool,
  extractApiDocsTool,
} from './documentationTools';

// Sandbox tools (Docker container execution)
export {
  sandboxBashTool,
  sandboxStatusTool,
  sandboxFileSyncTool,
  setSandboxContext,
  clearSandboxContext,
  getSandboxContext,
} from './sandboxTools';
