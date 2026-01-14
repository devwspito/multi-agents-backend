/**
 * TUI Module - Professional Terminal User Interface
 *
 * Export all TUI components for easy importing.
 */

// Main TUI Manager
export {
  TUIManager,
  getTUI,
  TUIConfig,
  TUITheme,
  AgentActivity,
  ContextInfo,
  MCPServer,
  LSPServer,
  TodoItem
} from './TUIManager';

// Diff Viewer
export {
  DiffViewer,
  DiffOptions,
  DiffResult,
  createDiff,
  createInlineDiff
} from './DiffViewer';

// Orchestration Hook
export {
  TUIOrchestrationHook,
  getTUIHook,
  OrchestrationEvent,
  wrapWithTUI,
  createTUIEventListener
} from './TUIOrchestrationHook';
