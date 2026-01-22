/**
 * GitHub Connect Screen
 * Handles GitHub OAuth flow
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import open from 'open';
import { api } from '../api/client.js';
import { configStore } from '../utils/config.js';

interface GithubConnectScreenProps {
  onConnected: () => void;
  onSkip: () => void;
}

export const GithubConnectScreen: React.FC<GithubConnectScreenProps> = ({
  onConnected,
  onSkip,
}) => {
  const [status, setStatus] = useState<'prompt' | 'opening' | 'waiting' | 'connected' | 'error'>('prompt');
  const [error, setError] = useState<string | null>(null);
  const [checkCount, setCheckCount] = useState(0);

  useInput((input, key) => {
    if (status === 'prompt') {
      if (input === 'y' || input === 'Y') {
        handleConnect();
      } else if (input === 'n' || input === 'N' || input === 's' || input === 'S') {
        onSkip();
      }
    }
  });

  const handleConnect = async () => {
    setStatus('opening');

    try {
      const response = await api.getGithubAuthUrl();

      if (response.success && response.data?.url) {
        // Open browser for GitHub OAuth
        await open(response.data.url);
        setStatus('waiting');

        // Start polling for connection status
        startPolling();
      } else {
        setError('Could not get GitHub auth URL');
        setStatus('error');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to start GitHub connection');
      setStatus('error');
    }
  };

  const startPolling = () => {
    const interval = setInterval(async () => {
      try {
        const response = await api.checkGithubConnection();

        if (response.data?.connected) {
          clearInterval(interval);
          configStore.setGithubConnected(true);
          setStatus('connected');
          setTimeout(onConnected, 1500);
        } else {
          setCheckCount((c) => c + 1);

          // Timeout after 60 checks (about 2 minutes)
          if (checkCount > 60) {
            clearInterval(interval);
            setError('Connection timed out. Please try again.');
            setStatus('error');
          }
        }
      } catch (err) {
        // Ignore polling errors, keep trying
      }
    }, 2000);

    // Cleanup on unmount
    return () => clearInterval(interval);
  };

  return (
    <Box flexDirection="column" padding={2}>
      <Box marginBottom={2}>
        <Text bold color="cyan">
          ═══════════════════════════════════════════
        </Text>
      </Box>
      <Box marginBottom={2} justifyContent="center">
        <Text bold color="cyan">
          🔗 Connect GitHub Account
        </Text>
      </Box>
      <Box marginBottom={2}>
        <Text bold color="cyan">
          ═══════════════════════════════════════════
        </Text>
      </Box>

      {status === 'prompt' && (
        <Box flexDirection="column" gap={1}>
          <Text>
            To use the AI Development Team, you need to connect your GitHub account.
          </Text>
          <Text color="gray">
            This allows the system to:
          </Text>
          <Text color="gray">• Clone your repositories</Text>
          <Text color="gray">• Create branches and commits</Text>
          <Text color="gray">• Create pull requests</Text>
          <Text> </Text>
          <Text color="yellow">[Y] Connect GitHub now</Text>
          <Text color="gray">[S] Skip for now (limited functionality)</Text>
        </Box>
      )}

      {status === 'opening' && (
        <Box gap={1}>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text>Opening browser for GitHub authorization...</Text>
        </Box>
      )}

      {status === 'waiting' && (
        <Box flexDirection="column" gap={1}>
          <Box gap={1}>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
            <Text>Waiting for GitHub authorization...</Text>
          </Box>
          <Text color="gray">
            Please complete the authorization in your browser.
          </Text>
          <Text color="gray" dimColor>
            Checking... ({checkCount})
          </Text>
        </Box>
      )}

      {status === 'connected' && (
        <Box flexDirection="column" gap={1}>
          <Text color="green">✓ GitHub connected successfully!</Text>
          <Text color="gray">Redirecting to dashboard...</Text>
        </Box>
      )}

      {status === 'error' && (
        <Box flexDirection="column" gap={1}>
          <Text color="red">✗ {error}</Text>
          <Text> </Text>
          <Text color="yellow">[Y] Try again</Text>
          <Text color="gray">[S] Skip for now</Text>
        </Box>
      )}
    </Box>
  );
};

export default GithubConnectScreen;
