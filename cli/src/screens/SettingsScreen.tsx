/**
 * Settings Screen
 * Configure CLI and view account settings
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

type Mode = 'menu' | 'change-api' | 'confirm-logout' | 'confirm-reset';

interface SettingsScreenProps {
  onNavigate: (screen: string, data?: any) => void;
  onBack: () => void;
  onLogout: () => void;
  wsConnected: boolean;
}

interface UserProfile {
  name: string;
  email: string;
  githubUsername?: string;
  githubId?: string;
  createdAt?: string;
}

export const SettingsScreen: React.FC<SettingsScreenProps> = ({
  onNavigate,
  onBack,
  onLogout,
  wsConnected,
}) => {
  const [mode, setMode] = useState<Mode>('menu');
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [newApiUrl, setNewApiUrl] = useState(configStore.getApiUrl());
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    setLoading(true);
    try {
      const response = await api.getProfile();
      if (response.success) {
        setProfile(response.data);
      }
    } catch (err: any) {
      // Profile might not load if not authenticated
    } finally {
      setLoading(false);
    }
  };

  useInput((input, key) => {
    if (key.escape || input === 'b') {
      if (mode === 'menu') {
        onBack();
      } else {
        setMode('menu');
        setError(null);
      }
    }
  });

  const handleChangeApiUrl = () => {
    if (!newApiUrl || newApiUrl.length < 5) {
      setError('Please enter a valid URL');
      return;
    }

    let url = newApiUrl;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    configStore.setApiUrl(url);
    setSuccess('API URL updated. Restart CLI to apply.');
    setMode('menu');
    setTimeout(() => setSuccess(null), 3000);
  };

  const handleLogout = () => {
    onLogout();
  };

  const handleReset = () => {
    configStore.clear();
    setSuccess('All settings reset');
    setTimeout(() => {
      onLogout();
    }, 1000);
  };

  const handleReconnectGithub = () => {
    onNavigate('github-connect');
  };

  const menuItems = [
    { label: '👤 Account Info', value: 'account' },
    { label: '🔗 Change Server URL', value: 'change-api' },
    { label: '🔄 Reconnect GitHub', value: 'github' },
    { label: '🚪 Logout', value: 'logout' },
    { label: '🗑️  Reset All Settings', value: 'reset' },
    { label: '← Back', value: 'back' },
  ];

  const handleSelect = (item: { value: string }) => {
    switch (item.value) {
      case 'account':
        // Just show account info (already visible)
        break;
      case 'change-api':
        setNewApiUrl(configStore.getApiUrl());
        setMode('change-api');
        break;
      case 'github':
        handleReconnectGithub();
        break;
      case 'logout':
        setMode('confirm-logout');
        break;
      case 'reset':
        setMode('confirm-reset');
        break;
      case 'back':
        onBack();
        break;
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Header connected={wsConnected} currentView="Settings" />

      <Box
        borderStyle="round"
        borderColor="cyan"
        flexDirection="column"
        padding={1}
        minHeight={16}
      >
        {/* Account Info Section */}
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="cyan">Account Information</Text>
          {loading ? (
            <Box gap={1} marginLeft={2}>
              <Spinner type="dots" />
              <Text>Loading...</Text>
            </Box>
          ) : (
            <Box flexDirection="column" marginLeft={2}>
              <Text>
                <Text color="gray">Name:     </Text>
                <Text>{profile?.name || configStore.getUserName() || 'Not set'}</Text>
              </Text>
              <Text>
                <Text color="gray">Email:    </Text>
                <Text>{profile?.email || configStore.getUserEmail() || 'Not set'}</Text>
              </Text>
              <Text>
                <Text color="gray">GitHub:   </Text>
                <Text color={profile?.githubId ? 'green' : 'yellow'}>
                  {profile?.githubUsername || (configStore.isGithubConnected() ? 'Connected' : 'Not connected')}
                </Text>
              </Text>
              <Text>
                <Text color="gray">Server:   </Text>
                <Text>{configStore.getApiUrl()}</Text>
              </Text>
            </Box>
          )}
        </Box>

        {/* Menu Mode */}
        {mode === 'menu' && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="white">Options</Text>
            <SelectInput items={menuItems} onSelect={handleSelect} />
          </Box>
        )}

        {/* Change API URL Mode */}
        {mode === 'change-api' && (
          <Box flexDirection="column" gap={1}>
            <Text bold color="cyan">Change Server URL</Text>
            <Box>
              <Text color="cyan">URL: </Text>
              <TextInput
                value={newApiUrl}
                onChange={setNewApiUrl}
                onSubmit={handleChangeApiUrl}
                placeholder="https://yourserver.com/api"
              />
            </Box>
            <Text color="gray" dimColor>
              Press Enter to save, Escape to cancel
            </Text>
            {error && <Text color="red">{error}</Text>}
          </Box>
        )}

        {/* Confirm Logout */}
        {mode === 'confirm-logout' && (
          <Box flexDirection="column" gap={1}>
            <Text bold color="yellow">Confirm Logout</Text>
            <Text>Are you sure you want to logout?</Text>
            <Text color="gray">Your server URL will be saved.</Text>
            <SelectInput
              items={[
                { label: '✓ Yes, logout', value: 'yes' },
                { label: '✗ Cancel', value: 'no' },
              ]}
              onSelect={(item) => {
                if (item.value === 'yes') {
                  handleLogout();
                } else {
                  setMode('menu');
                }
              }}
            />
          </Box>
        )}

        {/* Confirm Reset */}
        {mode === 'confirm-reset' && (
          <Box flexDirection="column" gap={1}>
            <Text bold color="red">Reset All Settings</Text>
            <Text>This will:</Text>
            <Box flexDirection="column" marginLeft={2}>
              <Text color="yellow">- Log you out</Text>
              <Text color="yellow">- Clear saved server URL</Text>
              <Text color="yellow">- Remove all local data</Text>
            </Box>
            <Text bold>Are you sure?</Text>
            <SelectInput
              items={[
                { label: '✗ Cancel', value: 'no' },
                { label: '⚠ Yes, reset everything', value: 'yes' },
              ]}
              onSelect={(item) => {
                if (item.value === 'yes') {
                  handleReset();
                } else {
                  setMode('menu');
                }
              }}
            />
          </Box>
        )}

        {/* Messages */}
        {success && (
          <Box marginTop={1}>
            <Text color="green">✓ {success}</Text>
          </Box>
        )}
      </Box>

      {/* Version Info */}
      <Box marginTop={1} justifyContent="space-between">
        <Text color="gray" dimColor>
          AI Dev Team CLI v1.0.0
        </Text>
        <Text color="gray" dimColor>
          Powered by Claude Agent SDK
        </Text>
      </Box>

      <StatusBar shortcuts={[]} />
    </Box>
  );
};

export default SettingsScreen;
