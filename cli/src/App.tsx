/**
 * Main App Component
 * Handles routing and global state
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { configStore } from './utils/config.js';
import { wsClient } from './api/websocket.js';
import { api } from './api/client.js';

// Screens
import { LoginScreen } from './screens/LoginScreen.js';
import { GithubConnectScreen } from './screens/GithubConnectScreen.js';
import { DashboardScreen } from './screens/DashboardScreen.js';
import { TasksScreen } from './screens/TasksScreen.js';
import { NewTaskScreen } from './screens/NewTaskScreen.js';
import { TaskDetailScreen } from './screens/TaskDetailScreen.js';
import { ProjectsScreen } from './screens/ProjectsScreen.js';
import { RepositoriesScreen } from './screens/RepositoriesScreen.js';
import { SettingsScreen } from './screens/SettingsScreen.js';

type Screen =
  | 'loading'
  | 'login'
  | 'github-connect'
  | 'dashboard'
  | 'tasks'
  | 'new-task'
  | 'task-detail'
  | 'projects'
  | 'repositories'
  | 'settings';

interface NavigationState {
  screen: Screen;
  data?: any;
  history: Array<{ screen: Screen; data?: any }>;
}

export const App: React.FC = () => {
  const { exit } = useApp();
  const [nav, setNav] = useState<NavigationState>({
    screen: 'loading',
    history: [],
  });
  const [wsConnected, setWsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize app
  useEffect(() => {
    initializeApp();
  }, []);

  const initializeApp = async () => {
    // Check if already authenticated
    if (configStore.isAuthenticated()) {
      try {
        // Verify token is still valid
        const response = await api.getProfile();
        if (response.success) {
          // Update user info
          configStore.setUserName(response.data.name);
          configStore.setUserEmail(response.data.email);
          configStore.setGithubConnected(!!response.data.githubId);

          // Connect WebSocket
          await connectWebSocket();

          // Check if GitHub is connected
          if (!configStore.isGithubConnected()) {
            setNav({ screen: 'github-connect', history: [] });
          } else {
            setNav({ screen: 'dashboard', history: [] });
          }
        } else {
          // Token invalid, logout
          configStore.logout();
          setNav({ screen: 'login', history: [] });
        }
      } catch (err) {
        // Error checking profile, go to login
        configStore.logout();
        setNav({ screen: 'login', history: [] });
      }
    } else {
      setNav({ screen: 'login', history: [] });
    }
  };

  const connectWebSocket = async () => {
    try {
      await wsClient.connect();
      setWsConnected(true);

      wsClient.on('disconnected', () => setWsConnected(false));
      wsClient.on('connected', () => setWsConnected(true));
    } catch (err) {
      console.error('WebSocket connection failed:', err);
      // Continue without WebSocket - will work in polling mode
    }
  };

  // Global keyboard shortcuts
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      handleExit();
    }
  });

  const handleExit = () => {
    wsClient.disconnect();
    exit();
  };

  const navigate = (screen: Screen | string, data?: any) => {
    setNav(prev => ({
      screen: screen as Screen,
      data,
      history: [...prev.history, { screen: prev.screen, data: prev.data }],
    }));
  };

  const goBack = () => {
    setNav(prev => {
      if (prev.history.length === 0) {
        return { screen: 'dashboard', history: [] };
      }
      const history = [...prev.history];
      const last = history.pop()!;
      return { screen: last.screen, data: last.data, history };
    });
  };

  const handleLoginSuccess = async () => {
    await connectWebSocket();

    if (!configStore.isGithubConnected()) {
      setNav({ screen: 'github-connect', history: [] });
    } else {
      setNav({ screen: 'dashboard', history: [] });
    }
  };

  const handleGithubConnected = () => {
    setNav({ screen: 'dashboard', history: [] });
  };

  const handleGithubSkipped = () => {
    setNav({ screen: 'dashboard', history: [] });
  };

  const handleLogout = () => {
    wsClient.disconnect();
    configStore.logout();
    setNav({ screen: 'login', history: [] });
  };

  // Render current screen
  const renderScreen = () => {
    switch (nav.screen) {
      case 'loading':
        return (
          <Box flexDirection="column" alignItems="center" padding={4}>
            <Text bold color="cyan">
              🤖 AI Development Team
            </Text>
            <Box marginTop={2} gap={1}>
              <Spinner type="dots" />
              <Text>Initializing...</Text>
            </Box>
          </Box>
        );

      case 'login':
        return <LoginScreen onLoginSuccess={handleLoginSuccess} />;

      case 'github-connect':
        return (
          <GithubConnectScreen
            onConnected={handleGithubConnected}
            onSkip={handleGithubSkipped}
          />
        );

      case 'dashboard':
        return (
          <DashboardScreen
            onNavigate={navigate}
            onLogout={handleLogout}
            wsConnected={wsConnected}
          />
        );

      case 'tasks':
        return (
          <TasksScreen
            onNavigate={navigate}
            onBack={goBack}
            wsConnected={wsConnected}
            projectId={nav.data?.projectId}
          />
        );

      case 'new-task':
        return (
          <NewTaskScreen
            onNavigate={navigate}
            onBack={goBack}
            wsConnected={wsConnected}
          />
        );

      case 'task-detail':
        return (
          <TaskDetailScreen
            taskId={nav.data?.taskId}
            onNavigate={navigate}
            onBack={goBack}
            wsConnected={wsConnected}
          />
        );

      case 'projects':
        return (
          <ProjectsScreen
            onNavigate={navigate}
            onBack={goBack}
            wsConnected={wsConnected}
          />
        );

      case 'repositories':
        return (
          <RepositoriesScreen
            onNavigate={navigate}
            onBack={goBack}
            wsConnected={wsConnected}
            projectId={nav.data?.projectId}
          />
        );

      case 'settings':
        return (
          <SettingsScreen
            onNavigate={navigate}
            onBack={goBack}
            onLogout={handleLogout}
            wsConnected={wsConnected}
          />
        );

      default:
        return (
          <Box>
            <Text color="red">Unknown screen: {nav.screen}</Text>
          </Box>
        );
    }
  };

  return (
    <Box flexDirection="column">
      {renderScreen()}
      {error && (
        <Box marginTop={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      )}
    </Box>
  );
};

export default App;
