/**
 * Tasks Screen
 * View and manage all tasks with advanced filtering
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import { Header } from '../components/Header.js';
import { StatusBar } from '../components/StatusBar.js';
import { api } from '../api/client.js';
import { configStore } from '../utils/config.js';

interface Task {
  _id: string;
  title: string;
  status: string;
  priority: string;
  createdAt: string;
  projectId?: string;
  orchestration?: {
    currentPhase?: string;
    totalCost?: number;
  };
  pullRequests?: Array<{
    url: string;
    status: string;
  }>;
}

interface Project {
  _id: string;
  name: string;
}

interface TasksScreenProps {
  onNavigate: (screen: string, data?: any) => void;
  onBack: () => void;
  wsConnected: boolean;
  projectId?: string;
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'gray',
  in_progress: 'yellow',
  completed: 'green',
  failed: 'red',
  cancelled: 'gray',
  paused: 'cyan',
};

const STATUS_ICONS: Record<string, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
  failed: '✗',
  cancelled: '⊘',
  paused: '⏸',
};

const PRIORITY_ICONS: Record<string, string> = {
  urgent: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🟢',
};

type Mode = 'list' | 'search' | 'actions';

export const TasksScreen: React.FC<TasksScreenProps> = ({
  onNavigate,
  onBack,
  wsConnected,
  projectId,
}) => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string>(projectId || 'all');
  const [searchQuery, setSearchQuery] = useState('');
  const [mode, setMode] = useState<Mode>('list');
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    setError(null);

    try {
      const [tasksRes, projectsRes] = await Promise.all([
        api.getTasks({ projectId: projectFilter !== 'all' ? projectFilter : undefined }),
        api.getProjects(),
      ]);
      setTasks(tasksRes.data?.tasks || []);
      setProjects(projectsRes.data?.projects || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    setDeleting(true);
    try {
      await api.deleteTask(taskId);
      await loadData();
      setMode('list');
      setSelectedTask(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  useInput((input, key) => {
    if (mode === 'search') {
      if (key.escape) {
        setMode('list');
        setSearchQuery('');
      }
      return;
    }

    if (mode === 'actions') {
      if (key.escape || input === 'b') {
        setMode('list');
        setSelectedTask(null);
      }
      return;
    }

    if (input === 'b' || key.escape) {
      onBack();
    } else if (input === 'r') {
      loadData();
    } else if (input === 'n') {
      onNavigate('new-task');
    } else if (input === 'f') {
      // Cycle through status filters
      const filters = ['all', 'in_progress', 'completed', 'failed', 'pending', 'paused'];
      const currentIndex = filters.indexOf(statusFilter);
      setStatusFilter(filters[(currentIndex + 1) % filters.length]);
    } else if (input === 'p') {
      // Cycle through project filters
      const projectIds = ['all', ...projects.map(p => p._id)];
      const currentIndex = projectIds.indexOf(projectFilter);
      setProjectFilter(projectIds[(currentIndex + 1) % projectIds.length]);
    } else if (input === '/') {
      setMode('search');
    }
  });

  // Apply filters
  let filteredTasks = tasks;

  if (statusFilter !== 'all') {
    filteredTasks = filteredTasks.filter(t => t.status === statusFilter);
  }

  if (projectFilter !== 'all') {
    filteredTasks = filteredTasks.filter(t => t.projectId === projectFilter);
  }

  if (searchQuery) {
    const query = searchQuery.toLowerCase();
    filteredTasks = filteredTasks.filter(t =>
      t.title.toLowerCase().includes(query)
    );
  }

  // Sort by date (newest first)
  filteredTasks = [...filteredTasks].sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  const getProjectName = (id?: string) => {
    if (!id) return '';
    const project = projects.find(p => p._id === id);
    return project?.name || '';
  };

  const menuItems = filteredTasks.map(task => {
    const priorityIcon = PRIORITY_ICONS[task.priority] || '';
    const statusIcon = STATUS_ICONS[task.status] || '?';
    const phase = task.orchestration?.currentPhase || '';
    const cost = task.orchestration?.totalCost;
    const hasPR = task.pullRequests && task.pullRequests.length > 0;

    return {
      label: `${statusIcon} ${priorityIcon} ${task.title.substring(0, 40)}${task.title.length > 40 ? '...' : ''} ${phase ? `[${phase}]` : ''} ${hasPR ? '🔗' : ''} ${cost ? `$${cost.toFixed(2)}` : ''}`,
      value: task._id,
      task,
    };
  });

  const handleSelect = (item: { value: string; task?: Task }) => {
    if (item.task) {
      setSelectedTask(item.task);
      setMode('actions');
    }
  };

  const currentProjectName = projectFilter === 'all'
    ? 'All Projects'
    : getProjectName(projectFilter) || 'Unknown';

  return (
    <Box flexDirection="column" padding={1}>
      <Header connected={wsConnected} currentView="Tasks" />

      {/* Filter Bar */}
      <Box marginBottom={1} flexDirection="column">
        <Box gap={2}>
          <Text bold>Status:</Text>
          {['all', 'in_progress', 'completed', 'failed'].map(f => (
            <Text key={f} color={statusFilter === f ? STATUS_COLORS[f] || 'cyan' : 'gray'}>
              {f === 'all' ? 'All' : f.replace('_', ' ')} ({
                f === 'all' ? tasks.length : tasks.filter(t => t.status === f).length
              })
            </Text>
          ))}
        </Box>
        <Box gap={2}>
          <Text bold>Project:</Text>
          <Text color="cyan">{currentProjectName}</Text>
          <Text color="gray">[p] to change</Text>
        </Box>
        {searchQuery && (
          <Box gap={2}>
            <Text bold>Search:</Text>
            <Text color="yellow">"{searchQuery}"</Text>
            <Text color="gray">[Esc] to clear</Text>
          </Box>
        )}
      </Box>

      {/* Search Mode */}
      {mode === 'search' && (
        <Box borderStyle="single" borderColor="yellow" padding={1} marginBottom={1}>
          <Text color="yellow">Search: </Text>
          <TextInput
            value={searchQuery}
            onChange={setSearchQuery}
            onSubmit={() => setMode('list')}
            placeholder="Type to search tasks..."
          />
        </Box>
      )}

      {/* Task Actions Mode */}
      {mode === 'actions' && selectedTask && (
        <Box
          borderStyle="double"
          borderColor="cyan"
          flexDirection="column"
          padding={1}
          marginBottom={1}
        >
          <Text bold color="cyan">{selectedTask.title}</Text>
          <Box marginTop={1} flexDirection="column" marginLeft={2}>
            <Text>
              <Text color="gray">Status: </Text>
              <Text color={STATUS_COLORS[selectedTask.status]}>
                {selectedTask.status}
              </Text>
            </Text>
            <Text>
              <Text color="gray">Priority: </Text>
              <Text>{PRIORITY_ICONS[selectedTask.priority]} {selectedTask.priority}</Text>
            </Text>
            <Text>
              <Text color="gray">Phase: </Text>
              <Text>{selectedTask.orchestration?.currentPhase || 'N/A'}</Text>
            </Text>
            <Text>
              <Text color="gray">Cost: </Text>
              <Text>${(selectedTask.orchestration?.totalCost || 0).toFixed(4)}</Text>
            </Text>
            {selectedTask.pullRequests && selectedTask.pullRequests.length > 0 && (
              <Text>
                <Text color="gray">PRs: </Text>
                <Text color="green">{selectedTask.pullRequests.length} created</Text>
              </Text>
            )}
          </Box>
          <Box marginTop={1}>
            {deleting ? (
              <Box gap={1}>
                <Spinner type="dots" />
                <Text>Deleting...</Text>
              </Box>
            ) : (
              <SelectInput
                items={[
                  { label: '👁  View Details & Logs', value: 'view' },
                  ...(selectedTask.status === 'in_progress' ? [{ label: '⏸  Pause Task', value: 'pause' }] : []),
                  ...(selectedTask.status === 'paused' ? [{ label: '▶  Resume Task', value: 'resume' }] : []),
                  ...(selectedTask.status === 'failed' ? [{ label: '🔄 Retry Task', value: 'retry' }] : []),
                  { label: '🗑️  Delete Task', value: 'delete' },
                  { label: '← Back to List', value: 'back' },
                ]}
                onSelect={async (item) => {
                  switch (item.value) {
                    case 'view':
                      onNavigate('task-detail', { taskId: selectedTask._id });
                      break;
                    case 'pause':
                      await api.pauseTask(selectedTask._id);
                      loadData();
                      setMode('list');
                      break;
                    case 'resume':
                      await api.resumeTask(selectedTask._id);
                      loadData();
                      setMode('list');
                      break;
                    case 'retry':
                      await api.resumeTask(selectedTask._id);
                      loadData();
                      setMode('list');
                      break;
                    case 'delete':
                      handleDeleteTask(selectedTask._id);
                      break;
                    case 'back':
                      setMode('list');
                      setSelectedTask(null);
                      break;
                  }
                }}
              />
            )}
          </Box>
        </Box>
      )}

      {/* Task List */}
      {mode !== 'actions' && (
        <Box
          borderStyle="round"
          borderColor="cyan"
          flexDirection="column"
          padding={1}
          minHeight={12}
        >
          {loading ? (
            <Box gap={1}>
              <Text color="cyan">
                <Spinner type="dots" />
              </Text>
              <Text>Loading tasks...</Text>
            </Box>
          ) : error ? (
            <Text color="red">{error}</Text>
          ) : filteredTasks.length === 0 ? (
            <Box flexDirection="column" alignItems="center" padding={2}>
              <Text color="gray">
                {searchQuery ? `No tasks matching "${searchQuery}"` : 'No tasks found'}
              </Text>
              <Text color="cyan">Press [n] to create a new task</Text>
            </Box>
          ) : (
            <SelectInput
              items={menuItems}
              onSelect={handleSelect}
              itemComponent={({ isSelected, label }) => (
                <Text color={isSelected ? 'cyan' : undefined}>
                  {isSelected ? '› ' : '  '}{label}
                </Text>
              )}
            />
          )}
        </Box>
      )}

      {/* Legend */}
      <Box marginTop={1} gap={2}>
        <Text color="gray" dimColor>
          {PRIORITY_ICONS.urgent} Urgent {PRIORITY_ICONS.high} High {PRIORITY_ICONS.medium} Medium {PRIORITY_ICONS.low} Low | 🔗 Has PR
        </Text>
      </Box>

      <StatusBar
        shortcuts={
          mode === 'search'
            ? [{ key: 'Esc', label: 'Cancel' }, { key: 'Enter', label: 'Search' }]
            : mode === 'actions'
            ? [{ key: 'Esc', label: 'Back' }]
            : [
                { key: 'n', label: 'New' },
                { key: 'f', label: 'Filter' },
                { key: 'p', label: 'Project' },
                { key: '/', label: 'Search' },
                { key: 'r', label: 'Refresh' },
              ]
        }
      />
    </Box>
  );
};

export default TasksScreen;
