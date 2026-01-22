/**
 * Status Bar Component
 * Shows keyboard shortcuts and status info
 */

import React from 'react';
import { Box, Text } from 'ink';

interface StatusBarProps {
  shortcuts?: Array<{ key: string; label: string }>;
  message?: string;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  shortcuts = [],
  message,
}) => {
  const defaultShortcuts = [
    { key: 'q', label: 'Quit' },
    { key: 'b', label: 'Back' },
    { key: '?', label: 'Help' },
  ];

  const allShortcuts = [...shortcuts, ...defaultShortcuts];

  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      marginTop={1}
      justifyContent="space-between"
    >
      <Box gap={2}>
        {allShortcuts.map(({ key, label }) => (
          <Box key={key}>
            <Text color="yellow" bold>
              [{key}]
            </Text>
            <Text color="gray"> {label}</Text>
          </Box>
        ))}
      </Box>
      {message && (
        <Text color="cyan">{message}</Text>
      )}
    </Box>
  );
};

export default StatusBar;
