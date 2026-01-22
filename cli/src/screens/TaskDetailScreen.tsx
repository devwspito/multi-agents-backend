/**
 * Task Detail Screen
 * Real-time view of task orchestration with logs
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import { Header } from '../components/Header.js';
import { StatusBar } from '../components/StatusBar.js';
import { api } from '../api/client.js';
import { wsClient, LogMessage, PhaseUpdate, ApprovalRequest } from '../api/websocket.js';

interface TaskDetailScreenProps {
  taskId: string;
  onNavigate: (screen: string, data?: any) => void;
  onBack: () => void;
  wsConnected: boolean;
}

interface TaskData {
  _id: string;
  title: string;
  status: string;
  description: string;
  orchestration?: {
    currentPhase?: string;
    planning?: { status: string };
    techLead?: { status: string };
    developers?: { status: string };
    judge?: { status: string };
    autoMerge?: { status: string };
    totalCost?: number;
    totalTokens?: number;
    autoApprovalEnabled?: boolean;
    autoApprovalPhases?: string[];
  };
}

const PHASE_ORDER = ['Planning', 'Approval', 'TeamOrchestration', 'Recovery', 'Integration', 'AutoMerge'];

const STATUS_COLORS: Record<string, string> = {
  pending: 'gray',
  in_progress: 'yellow',
  completed: 'green',
  failed: 'red',
  waiting_approval: 'magenta',
};

export const TaskDetailScreen: React.FC<TaskDetailScreenProps> = ({
  taskId,
  onNavigate,
  onBack,
  wsConnected,
}) => {
  const [task, setTask] = useState<TaskData | null>(null);
  const [logs, setLogs] = useState<LogMessage[]>([]);
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showActions, setShowActions] = useState(false);
  const [autoApprovalEnabled, setAutoApprovalEnabled] = useState(false);
  const [togglingAutoApproval, setTogglingAutoApproval] = useState(false);

  // Load task data
  const loadTask = useCallback(async () => {
    try {
      const response = await api.getTask(taskId);
      if (response.success) {
        setTask(response.data);
        setAutoApprovalEnabled(response.data.orchestration?.autoApprovalEnabled || false);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  // Subscribe to real-time updates
  useEffect(() => {
    loadTask();

    // Subscribe to task events
    wsClient.subscribeToTask(taskId);

    // Handle log messages
    const handleLog = (data: LogMessage) => {
      if (data.taskId === taskId) {
        setLogs(prev => [...prev.slice(-50), data]); // Keep last 50 logs
      }
    };

    // Handle phase updates
    const handlePhaseUpdate = () => {
      loadTask(); // Refresh task data on phase change
    };

    // Handle approval requests
    const handleApproval = (data: ApprovalRequest) => {
      if (data.taskId === taskId) {
        setPendingApproval(data);
      }
    };

    // Handle task completion
    const handleComplete = (data: { taskId: string }) => {
      if (data.taskId === taskId) {
        loadTask();
      }
    };

    wsClient.on('log', handleLog);
    wsClient.on('phase-start', handlePhaseUpdate);
    wsClient.on('phase-complete', handlePhaseUpdate);
    wsClient.on('approval-required', handleApproval);
    wsClient.on('task-completed', handleComplete);
    wsClient.on('task-failed', handleComplete);

    return () => {
      wsClient.unsubscribeFromTask(taskId);
      wsClient.off('log', handleLog);
      wsClient.off('phase-start', handlePhaseUpdate);
      wsClient.off('phase-complete', handlePhaseUpdate);
      wsClient.off('approval-required', handleApproval);
      wsClient.off('task-completed', handleComplete);
      wsClient.off('task-failed', handleComplete);
    };
  }, [taskId, loadTask]);

  useInput((input, key) => {
    if (key.escape || input === 'b') {
      if (showActions) {
        setShowActions(false);
      } else {
        onBack();
      }
    } else if (input === 'a') {
      setShowActions(!showActions);
    } else if (input === 'r') {
      loadTask();
    } else if (input === 'y' && pendingApproval) {
      handleApprove();
    } else if (input === 'n' && pendingApproval) {
      handleReject();
    } else if (input === 't' && !togglingAutoApproval) {
      // Quick toggle auto-approval
      handleToggleAutoApproval();
    }
  });

  const handleApprove = async () => {
    if (!pendingApproval) return;
    try {
      await api.approvePhase(taskId, pendingApproval.phase);
      setPendingApproval(null);
      loadTask();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleReject = async () => {
    if (!pendingApproval) return;
    try {
      await api.rejectPhase(taskId, pendingApproval.phase, 'Rejected from CLI');
      setPendingApproval(null);
      loadTask();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleAction = async (action: string) => {
    setShowActions(false);
    try {
      switch (action) {
        case 'pause':
          await api.pauseTask(taskId);
          break;
        case 'resume':
          await api.resumeTask(taskId);
          break;
        case 'cancel':
          await api.cancelTask(taskId);
          break;
        case 'toggle-auto':
          await handleToggleAutoApproval();
          return; // Don't call loadTask, it's called in handleToggleAutoApproval
        case 'approve-all':
          if (pendingApproval) {
            await api.bypassApproval(taskId, pendingApproval.phase, {
              enableAutoApproval: true,
              enableForAllPhases: true,
            });
            setPendingApproval(null);
          }
          break;
      }
      loadTask();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleToggleAutoApproval = async () => {
    setTogglingAutoApproval(true);
    try {
      const newState = !autoApprovalEnabled;
      await api.setAutoApprovalConfig(taskId, {
        enabled: newState,
        phases: newState ? [
          'planning',
          'tech-lead',
          'team-orchestration',
          'development',
          'judge',
          'recovery',
          'integration',
          'verification',
          'auto-merge',
        ] : [],
      });
      setAutoApprovalEnabled(newState);
      loadTask();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setTogglingAutoApproval(false);
    }
  };

  const getPhaseStatus = (phase: string): string => {
    if (!task?.orchestration) return 'pending';
    const currentPhase = task.orchestration.currentPhase;

    // Check specific phase statuses
    const phaseKey = phase.toLowerCase().replace('orchestration', '');
    const phaseData = (task.orchestration as any)[phaseKey];
    if (phaseData?.status) return phaseData.status;

    // Infer from current phase
    const currentIndex = PHASE_ORDER.indexOf(currentPhase || '');
    const phaseIndex = PHASE_ORDER.indexOf(phase);

    if (currentIndex < 0) return 'pending';
    if (phaseIndex < currentIndex) return 'completed';
    if (phaseIndex === currentIndex) return 'in_progress';
    return 'pending';
  };

  if (loading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Header connected={wsConnected} currentView="Task" />
        <Box gap={1}>
          <Spinner type="dots" />
          <Text>Loading task...</Text>
        </Box>
      </Box>
    );
  }

  if (!task) {
    return (
      <Box flexDirection="column" padding={1}>
        <Header connected={wsConnected} currentView="Task" />
        <Text color="red">Task not found</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Header connected={wsConnected} currentView={`Task: ${task.title.substring(0, 30)}`} />

      {/* Task Info */}
      <Box borderStyle="single" borderColor="cyan" paddingX={2} paddingY={1} marginBottom={1}>
        <Box flexDirection="column" width="60%">
          <Text bold>{task.title}</Text>
          <Text color="gray">{task.description?.substring(0, 100)}...</Text>
        </Box>
        <Box flexDirection="column" alignItems="flex-end" width="40%">
          <Text color={STATUS_COLORS[task.status] || 'white'}>
            Status: {task.status.toUpperCase()}
          </Text>
          <Text color="gray">
            Cost: ${(task.orchestration?.totalCost || 0).toFixed(4)}
          </Text>
          <Text color={autoApprovalEnabled ? 'green' : 'yellow'}>
            Auto: {autoApprovalEnabled ? '🚀 ON' : '🛡️ OFF'}
          </Text>
        </Box>
      </Box>

      {/* Approval Request */}
      {pendingApproval && (
        <Box
          borderStyle="double"
          borderColor="magenta"
          paddingX={2}
          paddingY={1}
          marginBottom={1}
          flexDirection="column"
        >
          <Text bold color="magenta">
            ⚠ APPROVAL REQUIRED: {pendingApproval.phase}
          </Text>
          <Text>{pendingApproval.description}</Text>
          <Box gap={2} marginTop={1}>
            <Text color="green">[Y] Approve</Text>
            <Text color="red">[N] Reject</Text>
          </Box>
        </Box>
      )}

      {/* Phase Progress */}
      <Box borderStyle="round" borderColor="gray" paddingX={2} paddingY={1} marginBottom={1}>
        <Text bold>Progress: </Text>
        {PHASE_ORDER.map((phase, i) => {
          const status = getPhaseStatus(phase);
          const color = STATUS_COLORS[status];
          const icon = status === 'completed' ? '✓' :
                      status === 'in_progress' ? '◐' :
                      status === 'failed' ? '✗' : '○';
          return (
            <React.Fragment key={phase}>
              <Text color={color}>{icon} {phase}</Text>
              {i < PHASE_ORDER.length - 1 && <Text color="gray"> → </Text>}
            </React.Fragment>
          );
        })}
      </Box>

      {/* Logs */}
      <Box
        borderStyle="round"
        borderColor="cyan"
        flexDirection="column"
        padding={1}
        height={15}
        overflow="hidden"
      >
        <Text bold color="cyan">Live Logs:</Text>
        {logs.length === 0 ? (
          <Text color="gray">Waiting for logs...</Text>
        ) : (
          logs.slice(-12).map((log, i) => (
            <Text
              key={i}
              color={log.level === 'error' ? 'red' :
                     log.level === 'warn' ? 'yellow' :
                     log.level === 'debug' ? 'gray' : 'white'}
              wrap="truncate"
            >
              {log.message}
            </Text>
          ))
        )}
      </Box>

      {/* Actions Menu */}
      {showActions && (
        <Box
          borderStyle="single"
          borderColor="yellow"
          marginTop={1}
          padding={1}
        >
          {togglingAutoApproval ? (
            <Box gap={1}>
              <Spinner type="dots" />
              <Text>Updating auto-approval...</Text>
            </Box>
          ) : (
            <SelectInput
              items={[
                {
                  label: autoApprovalEnabled
                    ? '🛡️ Disable Auto-Approval'
                    : '🚀 Enable Auto-Approval',
                  value: 'toggle-auto',
                },
                ...(pendingApproval ? [{
                  label: '⚡ Approve & Enable Auto for All',
                  value: 'approve-all',
                }] : []),
                ...(task.status === 'in_progress' ? [{ label: '⏸ Pause Task', value: 'pause' }] : []),
                ...(task.status === 'paused' || task.status === 'failed' ? [{ label: '▶ Resume Task', value: 'resume' }] : []),
                ...(task.status === 'in_progress' || task.status === 'paused' ? [{ label: '✗ Cancel Task', value: 'cancel' }] : []),
                { label: '← Close Menu', value: 'close' },
              ]}
              onSelect={(item) => {
                if (item.value === 'close') {
                  setShowActions(false);
                } else {
                  handleAction(item.value);
                }
              }}
            />
          )}
        </Box>
      )}

      {error && (
        <Box marginTop={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      )}

      <StatusBar
        shortcuts={[
          { key: 'a', label: 'Actions' },
          { key: 't', label: autoApprovalEnabled ? 'Auto:OFF' : 'Auto:ON' },
          { key: 'r', label: 'Refresh' },
          ...(pendingApproval ? [
            { key: 'y', label: 'Approve' },
            { key: 'n', label: 'Reject' },
          ] : []),
        ]}
      />
    </Box>
  );
};

export default TaskDetailScreen;
