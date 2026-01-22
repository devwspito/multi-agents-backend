/**
 * Dashboard Screen
 * Main navigation hub
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import { Header } from '../components/Header.js';
import { StatusBar } from '../components/StatusBar.js';
import { api } from '../api/client.js';
import { configStore } from '../utils/config.js';

interface DashboardScreenProps {
  onNavigate: (screen: string, data?: any) => void;
  onLogout: () => void;
  wsConnected: boolean;
}

interface Stats {
  projectCount: number;
  taskCount: number;
  runningTasks: number;
  completedTasks: number;
}

export const DashboardScreen: React.FC<DashboardScreenProps> = ({
  onNavigate,
  onLogout,
  wsConnected,
}) => {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const githubConnected = configStore.isGithubConnected();

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    setLoading(true);
    setError(null);

    try {
      const [projectsRes, tasksRes] = await Promise.all([
        api.getProjects(),
        api.getTasks(),
      ]);

      const tasks = tasksRes.data?.tasks || [];

      setStats({
        projectCount: projectsRes.data?.projects?.length || 0,
        taskCount: tasks.length,
        runningTasks: tasks.filter((t: any) => t.status === 'in_progress').length,
        completedTasks: tasks.filter((t: any) => t.status === 'completed').length,
      });
    } catch (err: any) {
      setError(err.message || 'Failed to load stats');
    } finally {
      setLoading(false);
    }
  };

  useInput((input, key) => {
    if (input === 'r') {
      loadStats();
    } else if (input === 'q') {
      onLogout();
    }
  });

  const menuItems = [
    {
      label: '📋 New Task - Start AI development',
      value: 'new-task',
    },
    {
      label: '📊 Tasks - View all tasks',
      value: 'tasks',
    },
    {
      label: '📁 Projects - Manage projects',
      value: 'projects',
    },
    {
      label: '🔗 Repositories - Manage repos',
      value: 'repositories',
    },
    ...(githubConnected
      ? []
      : [
          {
            label: '🔐 Connect GitHub',
            value: 'github-connect',
          },
        ]),
    {
      label: '⚙️  Settings',
      value: 'settings',
    },
    {
      label: '🚪 Logout',
      value: 'logout',
    },
  ];

  const handleSelect = (item: { value: string }) => {
    if (item.value === 'logout') {
      onLogout();
    } else {
      onNavigate(item.value);
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Header connected={wsConnected} currentView="Dashboard" />

      {/* Stats Box */}
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={2}
        paddingY={1}
        marginBottom={1}
      >
        {loading ? (
          <Box gap={1}>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
            <Text>Loading stats...</Text>
          </Box>
        ) : error ? (
          <Text color="red">⚠ {error}</Text>
        ) : (
          <Box gap={4}>
            <Box flexDirection="column" alignItems="center">
              <Text bold color="cyan">
                {stats?.projectCount || 0}
              </Text>
              <Text color="gray">Projects</Text>
            </Box>
            <Box flexDirection="column" alignItems="center">
              <Text bold color="yellow">
                {stats?.runningTasks || 0}
              </Text>
              <Text color="gray">Running</Text>
            </Box>
            <Box flexDirection="column" alignItems="center">
              <Text bold color="green">
                {stats?.completedTasks || 0}
              </Text>
              <Text color="gray">Completed</Text>
            </Box>
            <Box flexDirection="column" alignItems="center">
              <Text bold color="white">
                {stats?.taskCount || 0}
              </Text>
              <Text color="gray">Total Tasks</Text>
            </Box>
          </Box>
        )}
      </Box>

      {/* GitHub Warning */}
      {!githubConnected && (
        <Box
          borderStyle="single"
          borderColor="yellow"
          paddingX={2}
          paddingY={1}
          marginBottom={1}
        >
          <Text color="yellow">
            ⚠ GitHub not connected. Connect GitHub to use all features.
          </Text>
        </Box>
      )}

      {/* Menu */}
      <Box flexDirection="column" marginTop={1}>
        <Box marginBottom={1}>
          <Text bold color="white">
            What would you like to do?
          </Text>
        </Box>
        <SelectInput items={menuItems} onSelect={handleSelect} />
      </Box>

      <StatusBar
        shortcuts={[
          { key: 'r', label: 'Refresh' },
          { key: '↑↓', label: 'Navigate' },
          { key: 'Enter', label: 'Select' },
        ]}
      />
    </Box>
  );
};

export default DashboardScreen;
