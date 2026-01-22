/**
 * Repositories Screen
 * Manage GitHub repositories - add, sync, remove
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import { Header } from '../components/Header.js';
import { StatusBar } from '../components/StatusBar.js';
import { api } from '../api/client.js';
import { configStore } from '../utils/config.js';

interface Repository {
  _id: string;
  name: string;
  githubRepoName: string;
  defaultBranch?: string;
  lastSyncedAt?: string;
  status?: string;
}

interface GithubRepo {
  full_name: string;
  name: string;
  description?: string;
  private: boolean;
  default_branch: string;
}

type Mode = 'list' | 'add' | 'detail' | 'select-github';

interface RepositoriesScreenProps {
  onNavigate: (screen: string, data?: any) => void;
  onBack: () => void;
  wsConnected: boolean;
  projectId?: string;
}

export const RepositoriesScreen: React.FC<RepositoriesScreenProps> = ({
  onNavigate,
  onBack,
  wsConnected,
  projectId,
}) => {
  const [mode, setMode] = useState<Mode>('list');
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [githubRepos, setGithubRepos] = useState<GithubRepo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<Repository | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const currentProjectId = projectId || configStore.getCurrentProjectId();
  const currentProjectName = configStore.getCurrentProjectName();

  useEffect(() => {
    loadRepositories();
  }, []);

  const loadRepositories = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.getRepositories(currentProjectId || undefined);
      setRepositories(response.data?.repositories || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const loadGithubRepos = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.getGithubRepos();
      setGithubRepos(response.data?.repos || []);
      setMode('select-github');
    } catch (err: any) {
      setError(err.message || 'Failed to load GitHub repos. Is GitHub connected?');
    } finally {
      setLoading(false);
    }
  };

  const handleAddRepository = async (githubRepoName: string) => {
    if (!currentProjectId) {
      setError('Please select a project first');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await api.addRepository({
        projectId: currentProjectId,
        githubRepoName,
      });

      if (response.success) {
        setSuccess(`Added ${githubRepoName}`);
        await loadRepositories();
        setMode('list');
        setTimeout(() => setSuccess(null), 3000);
      } else {
        setError(response.message || 'Failed to add repository');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSyncRepository = async (repoId: string) => {
    setSyncing(repoId);
    setError(null);
    try {
      await api.syncRepository(repoId);
      setSuccess('Repository synced successfully');
      await loadRepositories();
      setTimeout(() => setSuccess(null), 3000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSyncing(null);
    }
  };

  const handleDeleteRepository = async (repoId: string) => {
    setLoading(true);
    setError(null);
    try {
      await api.deleteRepository(repoId);
      setSuccess('Repository removed');
      await loadRepositories();
      setMode('list');
      setSelectedRepo(null);
      setTimeout(() => setSuccess(null), 3000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useInput((input, key) => {
    if (key.escape || input === 'b') {
      if (mode === 'list') {
        onBack();
      } else {
        setMode('list');
        setSelectedRepo(null);
      }
    } else if (input === 'a' && mode === 'list') {
      loadGithubRepos();
    } else if (input === 'r' && mode === 'list') {
      loadRepositories();
    } else if (input === 's' && mode === 'detail' && selectedRepo) {
      handleSyncRepository(selectedRepo._id);
    }
  });

  const menuItems = [
    ...repositories.map(r => ({
      label: `📦 ${r.name || r.githubRepoName} ${r.status === 'syncing' ? '(syncing...)' : ''}`,
      value: r._id,
    })),
    { label: '➕ Add Repository from GitHub', value: '__add__' },
  ];

  const handleSelectRepo = (item: { value: string }) => {
    if (item.value === '__add__') {
      loadGithubRepos();
    } else {
      const repo = repositories.find(r => r._id === item.value);
      if (repo) {
        setSelectedRepo(repo);
        setMode('detail');
      }
    }
  };

  // Filter out already added repos
  const availableGithubRepos = githubRepos.filter(
    gr => !repositories.some(r => r.githubRepoName === gr.full_name)
  );

  const githubRepoItems = [
    ...availableGithubRepos.map(r => ({
      label: `${r.private ? '🔒' : '📂'} ${r.full_name}`,
      value: r.full_name,
    })),
    { label: '← Back', value: '__back__' },
  ];

  return (
    <Box flexDirection="column" padding={1}>
      <Header connected={wsConnected} currentView="Repositories" />

      {/* Project Context */}
      {currentProjectName && (
        <Box marginBottom={1}>
          <Text color="gray">Project: </Text>
          <Text color="cyan" bold>{currentProjectName}</Text>
        </Box>
      )}

      <Box
        borderStyle="round"
        borderColor="cyan"
        flexDirection="column"
        padding={1}
        minHeight={14}
      >
        {/* List Mode */}
        {mode === 'list' && (
          <>
            {loading ? (
              <Box gap={1}>
                <Spinner type="dots" />
                <Text>Loading repositories...</Text>
              </Box>
            ) : !currentProjectId ? (
              <Box flexDirection="column" alignItems="center" padding={2}>
                <Text color="yellow">No project selected</Text>
                <Text color="gray">Go to Projects and select one first</Text>
              </Box>
            ) : repositories.length === 0 ? (
              <Box flexDirection="column" alignItems="center" padding={2}>
                <Text color="gray">No repositories added yet</Text>
                <Text color="cyan">Press [a] to add from GitHub</Text>
              </Box>
            ) : (
              <SelectInput items={menuItems} onSelect={handleSelectRepo} />
            )}
          </>
        )}

        {/* Select GitHub Repo Mode */}
        {mode === 'select-github' && (
          <Box flexDirection="column" gap={1}>
            <Text bold color="cyan">Select a GitHub Repository</Text>
            {loading ? (
              <Box gap={1}>
                <Spinner type="dots" />
                <Text>Loading your GitHub repos...</Text>
              </Box>
            ) : availableGithubRepos.length === 0 ? (
              <Box flexDirection="column">
                <Text color="yellow">No available repositories</Text>
                <Text color="gray">All your repos are already added, or you have none.</Text>
                <Box marginTop={1}>
                  <Text color="gray">Press [b] to go back</Text>
                </Box>
              </Box>
            ) : (
              <SelectInput
                items={githubRepoItems}
                onSelect={(item) => {
                  if (item.value === '__back__') {
                    setMode('list');
                  } else {
                    handleAddRepository(item.value);
                  }
                }}
              />
            )}
          </Box>
        )}

        {/* Detail Mode */}
        {mode === 'detail' && selectedRepo && (
          <Box flexDirection="column" gap={1}>
            <Text bold color="cyan">📦 {selectedRepo.name || selectedRepo.githubRepoName}</Text>
            <Box flexDirection="column" marginLeft={2}>
              <Text>
                <Text color="gray">GitHub: </Text>
                <Text>{selectedRepo.githubRepoName}</Text>
              </Text>
              <Text>
                <Text color="gray">Branch: </Text>
                <Text>{selectedRepo.defaultBranch || 'main'}</Text>
              </Text>
              <Text>
                <Text color="gray">Last Sync: </Text>
                <Text>
                  {selectedRepo.lastSyncedAt
                    ? new Date(selectedRepo.lastSyncedAt).toLocaleString()
                    : 'Never'}
                </Text>
              </Text>
              <Text>
                <Text color="gray">Status: </Text>
                <Text color={selectedRepo.status === 'ready' ? 'green' : 'yellow'}>
                  {selectedRepo.status || 'unknown'}
                </Text>
              </Text>
            </Box>

            <Box marginTop={1}>
              {syncing === selectedRepo._id ? (
                <Box gap={1}>
                  <Spinner type="dots" />
                  <Text>Syncing...</Text>
                </Box>
              ) : (
                <SelectInput
                  items={[
                    { label: '🔄 Sync Repository', value: 'sync' },
                    { label: '🗑️  Remove Repository', value: 'delete' },
                    { label: '← Back to List', value: 'back' },
                  ]}
                  onSelect={(item) => {
                    switch (item.value) {
                      case 'sync':
                        handleSyncRepository(selectedRepo._id);
                        break;
                      case 'delete':
                        handleDeleteRepository(selectedRepo._id);
                        break;
                      case 'back':
                        setMode('list');
                        setSelectedRepo(null);
                        break;
                    }
                  }}
                />
              )}
            </Box>
          </Box>
        )}

        {/* Messages */}
        {error && (
          <Box marginTop={1}>
            <Text color="red">Error: {error}</Text>
          </Box>
        )}
        {success && (
          <Box marginTop={1}>
            <Text color="green">✓ {success}</Text>
          </Box>
        )}
      </Box>

      <StatusBar
        shortcuts={
          mode === 'list'
            ? [
                { key: 'a', label: 'Add Repo' },
                { key: 'r', label: 'Refresh' },
              ]
            : mode === 'detail'
            ? [{ key: 's', label: 'Sync' }]
            : []
        }
      />
    </Box>
  );
};

export default RepositoriesScreen;
