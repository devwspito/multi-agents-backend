/**
 * Header Component
 * Shows app title and connection status
 */

import React from 'react';
import { Box, Text } from 'ink';
import { configStore } from '../utils/config.js';

interface HeaderProps {
  connected?: boolean;
  currentView?: string;
}

export const Header: React.FC<HeaderProps> = ({ connected = false, currentView }) => {
  const userName = configStore.getUserName();
  const projectName = configStore.getCurrentProjectName();

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="double" borderColor="cyan" paddingX={2}>
        <Text bold color="cyan">
          🤖 AI Development Team
        </Text>
        <Text color="gray"> v1.0.0</Text>
        <Box flexGrow={1} />
        {connected ? (
          <Text color="green">● Connected</Text>
        ) : (
          <Text color="red">○ Disconnected</Text>
        )}
      </Box>

      <Box paddingX={1} gap={2}>
        {userName && (
          <Text color="gray">
            👤 {userName}
          </Text>
        )}
        {projectName && (
          <Text color="yellow">
            📁 {projectName}
          </Text>
        )}
        {currentView && (
          <Text color="cyan">
            → {currentView}
          </Text>
        )}
      </Box>
    </Box>
  );
};

export default Header;
