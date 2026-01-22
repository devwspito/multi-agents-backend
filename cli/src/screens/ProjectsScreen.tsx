/**
 * Projects Screen
 * Manage projects and their repositories
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

interface Project {
  _id: string;
  name: string;
  description?: string;
  repositoryCount?: number;
}

type Mode = 'list' | 'create' | 'detail';

interface ProjectsScreenProps {
  onNavigate: (screen: string, data?: any) => void;
  onBack: () => void;
  wsConnected: boolean;
}

export const ProjectsScreen: React.FC<ProjectsScreenProps> = ({
  onNavigate,
  onBack,
  wsConnected,
}) => {
  const [mode, setMode] = useState<Mode>('list');
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create project form
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [createStep, setCreateStep] = useState<'name' | 'description' | 'creating'>('name');

  useEffect(() => {
    loadProjects();
  }, []);

  const loadProjects = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.getProjects();
      setProjects(response.data?.projects || []);
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
        setCreateStep('name');
        setNewName('');
        setNewDescription('');
      }
    } else if (input === 'n' && mode === 'list') {
      setMode('create');
    } else if (input === 'r' && mode === 'list') {
      loadProjects();
    }
  });

  const handleSelectProject = (item: { value: string }) => {
    if (item.value === '__create__') {
      setMode('create');
    } else {
      const project = projects.find(p => p._id === item.value);
      if (project) {
        setSelectedProject(project);
        configStore.setCurrentProject(project._id, project.name);
        setMode('detail');
      }
    }
  };

  const handleCreateProject = async () => {
    if (newName.length < 2) {
      setError('Project name must be at least 2 characters');
      return;
    }

    setCreateStep('creating');
    setError(null);

    try {
      const response = await api.createProject({
        name: newName,
        description: newDescription || undefined,
      });

      if (response.success) {
        await loadProjects();
        setMode('list');
        setNewName('');
        setNewDescription('');
        setCreateStep('name');
      } else {
        setError(response.message || 'Failed to create project');
        setCreateStep('name');
      }
    } catch (err: any) {
      setError(err.message);
      setCreateStep('name');
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    try {
      await api.deleteProject(projectId);
      await loadProjects();
      setMode('list');
      setSelectedProject(null);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const menuItems = [
    ...projects.map(p => ({
      label: `📁 ${p.name}`,
      value: p._id,
    })),
    { label: '➕ Create New Project', value: '__create__' },
  ];

  return (
    <Box flexDirection="column" padding={1}>
      <Header connected={wsConnected} currentView="Projects" />

      <Box
        borderStyle="round"
        borderColor="cyan"
        flexDirection="column"
        padding={1}
        minHeight={12}
      >
        {/* List Mode */}
        {mode === 'list' && (
          <>
            {loading ? (
              <Box gap={1}>
                <Spinner type="dots" />
                <Text>Loading projects...</Text>
              </Box>
            ) : projects.length === 0 ? (
              <Box flexDirection="column" alignItems="center" padding={2}>
                <Text color="gray">No projects yet</Text>
                <Text color="cyan">Press [n] to create your first project</Text>
              </Box>
            ) : (
              <SelectInput items={menuItems} onSelect={handleSelectProject} />
            )}
          </>
        )}

        {/* Create Mode */}
        {mode === 'create' && (
          <Box flexDirection="column" gap={1}>
            <Text bold color="cyan">Create New Project</Text>

            {createStep === 'name' && (
              <>
                <Box>
                  <Text color="cyan">Name: </Text>
                  <TextInput
                    value={newName}
                    onChange={setNewName}
                    onSubmit={() => {
                      if (newName.length >= 2) {
                        setCreateStep('description');
                        setError(null);
                      } else {
                        setError('Name must be at least 2 characters');
                      }
                    }}
                    placeholder="My Project"
                  />
                </Box>
                {error && <Text color="red">{error}</Text>}
              </>
            )}

            {createStep === 'description' && (
              <>
                <Text>Name: {newName}</Text>
                <Box>
                  <Text color="cyan">Description (optional): </Text>
                  <TextInput
                    value={newDescription}
                    onChange={setNewDescription}
                    onSubmit={handleCreateProject}
                    placeholder="Project description..."
                  />
                </Box>
                <Text color="gray" dimColor>
                  Press Enter to create, Escape to go back
                </Text>
              </>
            )}

            {createStep === 'creating' && (
              <Box gap={1}>
                <Spinner type="dots" />
                <Text>Creating project...</Text>
              </Box>
            )}
          </Box>
        )}

        {/* Detail Mode */}
        {mode === 'detail' && selectedProject && (
          <Box flexDirection="column" gap={1}>
            <Text bold color="cyan">📁 {selectedProject.name}</Text>
            {selectedProject.description && (
              <Text color="gray">{selectedProject.description}</Text>
            )}
            <Box marginTop={1}>
              <SelectInput
                items={[
                  { label: '🔗 Manage Repositories', value: 'repos' },
                  { label: '📋 View Tasks', value: 'tasks' },
                  { label: '🗑️  Delete Project', value: 'delete' },
                  { label: '← Back to List', value: 'back' },
                ]}
                onSelect={(item) => {
                  switch (item.value) {
                    case 'repos':
                      onNavigate('repositories', { projectId: selectedProject._id });
                      break;
                    case 'tasks':
                      onNavigate('tasks', { projectId: selectedProject._id });
                      break;
                    case 'delete':
                      handleDeleteProject(selectedProject._id);
                      break;
                    case 'back':
                      setMode('list');
                      setSelectedProject(null);
                      break;
                  }
                }}
              />
            </Box>
          </Box>
        )}

        {error && mode !== 'create' && (
          <Text color="red">Error: {error}</Text>
        )}
      </Box>

      <StatusBar
        shortcuts={
          mode === 'list'
            ? [
                { key: 'n', label: 'New Project' },
                { key: 'r', label: 'Refresh' },
              ]
            : []
        }
      />
    </Box>
  );
};

export default ProjectsScreen;
