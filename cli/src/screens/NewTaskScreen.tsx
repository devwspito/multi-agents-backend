/**
 * New Task Screen
 * Create and start a new AI development task
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

type Step = 'project' | 'repos' | 'title' | 'description' | 'options' | 'confirm' | 'creating' | 'starting' | 'done' | 'error';

interface Project {
  _id: string;
  name: string;
}

interface Repository {
  _id: string;
  name: string;
  githubRepoName: string;
}

interface NewTaskScreenProps {
  onNavigate: (screen: string, data?: any) => void;
  onBack: () => void;
  wsConnected: boolean;
}

export const NewTaskScreen: React.FC<NewTaskScreenProps> = ({
  onNavigate,
  onBack,
  wsConnected,
}) => {
  const [step, setStep] = useState<Step>('project');
  const [projects, setProjects] = useState<Project[]>([]);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);
  const [autoApproval, setAutoApproval] = useState(false);
  const [priority, setPriority] = useState<'low' | 'medium' | 'high' | 'urgent'>('medium');

  useEffect(() => {
    loadProjects();
  }, []);

  const loadProjects = async () => {
    setLoading(true);
    try {
      const response = await api.getProjects();
      setProjects(response.data?.projects || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const loadRepositories = async (projectId: string) => {
    setLoading(true);
    try {
      const response = await api.getRepositories(projectId);
      setRepositories(response.data?.repositories || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useInput((input, key) => {
    if (key.escape || (input === 'b' && step !== 'description' && step !== 'title')) {
      if (step === 'project') {
        onBack();
      } else if (step === 'repos') {
        setStep('project');
      } else if (step === 'title') {
        setStep('repos');
      } else if (step === 'description') {
        setStep('title');
      } else if (step === 'options') {
        setStep('description');
      } else if (step === 'confirm') {
        setStep('options');
      }
    }

    // In repos step, space toggles selection
    if (step === 'repos' && input === ' ') {
      // Handled by custom component
    }
  });

  const handleProjectSelect = async (item: { value: string }) => {
    const project = projects.find(p => p._id === item.value);
    if (project) {
      setSelectedProject(project);
      configStore.setCurrentProject(project._id, project.name);
      await loadRepositories(project._id);
      setStep('repos');
    }
  };

  const handleRepoToggle = (repoId: string) => {
    setSelectedRepos(prev =>
      prev.includes(repoId)
        ? prev.filter(id => id !== repoId)
        : [...prev, repoId]
    );
  };

  const handleReposConfirm = () => {
    if (selectedRepos.length === 0) {
      setError('Please select at least one repository');
      return;
    }
    setError(null);
    setStep('title');
  };

  const handleTitleSubmit = () => {
    if (title.length < 3) {
      setError('Title must be at least 3 characters');
      return;
    }
    setError(null);
    setStep('description');
  };

  const handleDescriptionSubmit = () => {
    if (description.length < 10) {
      setError('Please provide a more detailed description');
      return;
    }
    setError(null);
    setStep('options');
  };

  const handleConfirm = async () => {
    setStep('creating');

    try {
      // Create task
      const createResponse = await api.createTask({
        title,
        description,
        projectId: selectedProject!._id,
        repositoryIds: selectedRepos,
        priority,
      });

      if (!createResponse.success) {
        throw new Error(createResponse.message || 'Failed to create task');
      }

      const taskId = createResponse.data.task._id;
      setCreatedTaskId(taskId);

      // Configure auto-approval if enabled
      if (autoApproval) {
        await api.setAutoApprovalConfig(taskId, {
          enabled: true,
          phases: [
            'planning',
            'tech-lead',
            'team-orchestration',
            'development',
            'judge',
            'recovery',
            'integration',
            'verification',
            'auto-merge',
          ],
        });
      }

      setStep('starting');

      // Start task
      const startResponse = await api.startTask(taskId, { description });

      if (startResponse.success) {
        setStep('done');
        setTimeout(() => {
          onNavigate('task-detail', { taskId });
        }, 1500);
      } else {
        throw new Error(startResponse.message || 'Failed to start task');
      }
    } catch (err: any) {
      setError(err.message);
      setStep('error');
    }
  };

  const projectItems = projects.map(p => ({
    label: `📁 ${p.name}`,
    value: p._id,
  }));

  return (
    <Box flexDirection="column" padding={1}>
      <Header connected={wsConnected} currentView="New Task" />

      <Box
        borderStyle="round"
        borderColor="cyan"
        flexDirection="column"
        padding={2}
        minHeight={15}
      >
        {/* Step 1: Select Project */}
        {step === 'project' && (
          <Box flexDirection="column" gap={1}>
            <Text bold color="cyan">Step 1/5: Select Project</Text>
            <Text color="gray">Choose the project for this task:</Text>
            {loading ? (
              <Box gap={1}>
                <Spinner type="dots" />
                <Text>Loading projects...</Text>
              </Box>
            ) : projects.length === 0 ? (
              <Box flexDirection="column">
                <Text color="yellow">No projects found.</Text>
                <Text color="gray">Create a project first in the Projects menu.</Text>
              </Box>
            ) : (
              <SelectInput items={projectItems} onSelect={handleProjectSelect} />
            )}
          </Box>
        )}

        {/* Step 2: Select Repositories */}
        {step === 'repos' && (
          <Box flexDirection="column" gap={1}>
            <Text bold color="cyan">Step 2/5: Select Repositories</Text>
            <Text color="gray">
              Select repositories to include (space to toggle, enter to confirm):
            </Text>
            {loading ? (
              <Box gap={1}>
                <Spinner type="dots" />
                <Text>Loading repositories...</Text>
              </Box>
            ) : repositories.length === 0 ? (
              <Text color="yellow">No repositories in this project.</Text>
            ) : (
              <Box flexDirection="column">
                {repositories.map(repo => (
                  <Box key={repo._id} gap={1}>
                    <Text
                      color={selectedRepos.includes(repo._id) ? 'green' : 'gray'}
                    >
                      {selectedRepos.includes(repo._id) ? '☑' : '☐'} {repo.name}
                    </Text>
                    <Text color="gray" dimColor>
                      ({repo.githubRepoName})
                    </Text>
                  </Box>
                ))}
                <Box marginTop={1}>
                  <SelectInput
                    items={[
                      ...repositories.map(r => ({
                        label: `${selectedRepos.includes(r._id) ? '☑' : '☐'} ${r.name}`,
                        value: r._id,
                      })),
                      { label: '✓ Confirm selection', value: '__confirm__' },
                    ]}
                    onSelect={(item) => {
                      if (item.value === '__confirm__') {
                        handleReposConfirm();
                      } else {
                        handleRepoToggle(item.value);
                      }
                    }}
                  />
                </Box>
              </Box>
            )}
            {error && <Text color="red">{error}</Text>}
          </Box>
        )}

        {/* Step 3: Task Title */}
        {step === 'title' && (
          <Box flexDirection="column" gap={1}>
            <Text bold color="cyan">Step 3/5: Task Title</Text>
            <Text color="gray">Enter a short title for this task:</Text>
            <Box>
              <Text color="cyan">Title: </Text>
              <TextInput
                value={title}
                onChange={setTitle}
                onSubmit={handleTitleSubmit}
                placeholder="Add user authentication"
              />
            </Box>
            {error && <Text color="red">{error}</Text>}
          </Box>
        )}

        {/* Step 4: Task Description */}
        {step === 'description' && (
          <Box flexDirection="column" gap={1}>
            <Text bold color="cyan">Step 4/5: Task Description</Text>
            <Text color="gray">
              Describe what you want the AI team to build:
            </Text>
            <Box>
              <Text color="cyan">Description: </Text>
              <TextInput
                value={description}
                onChange={setDescription}
                onSubmit={handleDescriptionSubmit}
                placeholder="Implement JWT authentication with login, register, and protected routes..."
              />
            </Box>
            {error && <Text color="red">{error}</Text>}
            <Text color="gray" dimColor>
              Tip: Be specific! Include requirements, constraints, and expected behavior.
            </Text>
          </Box>
        )}

        {/* Step 5: Options */}
        {step === 'options' && (
          <Box flexDirection="column" gap={1}>
            <Text bold color="cyan">Step 5/5: Task Options</Text>
            <Text color="gray">Configure how the AI team should work:</Text>

            <Box marginTop={1} flexDirection="column">
              <Text bold>Priority:</Text>
              <SelectInput
                items={[
                  { label: `${priority === 'low' ? '●' : '○'} 🟢 Low`, value: 'low' },
                  { label: `${priority === 'medium' ? '●' : '○'} 🟡 Medium`, value: 'medium' },
                  { label: `${priority === 'high' ? '●' : '○'} 🟠 High`, value: 'high' },
                  { label: `${priority === 'urgent' ? '●' : '○'} 🔴 Urgent`, value: 'urgent' },
                ]}
                onSelect={(item) => setPriority(item.value as any)}
              />
            </Box>

            <Box marginTop={1} flexDirection="column">
              <Text bold>Auto-Approval:</Text>
              <SelectInput
                items={[
                  {
                    label: `${autoApproval ? '●' : '○'} 🚀 Enabled - AI runs autonomously`,
                    value: 'enabled',
                  },
                  {
                    label: `${!autoApproval ? '●' : '○'} 🛡️ Disabled - Manual approval required`,
                    value: 'disabled',
                  },
                ]}
                onSelect={(item) => setAutoApproval(item.value === 'enabled')}
              />
              <Text color="gray" dimColor>
                {autoApproval
                  ? 'The AI team will proceed through all phases automatically.'
                  : 'You will be asked to approve each phase before proceeding.'}
              </Text>
            </Box>

            <Box marginTop={1}>
              <SelectInput
                items={[
                  { label: '✓ Continue to Review', value: 'continue' },
                  { label: '← Go Back', value: 'back' },
                ]}
                onSelect={(item) => {
                  if (item.value === 'continue') {
                    setStep('confirm');
                  } else {
                    setStep('description');
                  }
                }}
              />
            </Box>
          </Box>
        )}

        {/* Confirm */}
        {step === 'confirm' && (
          <Box flexDirection="column" gap={1}>
            <Text bold color="cyan">Review & Confirm</Text>
            <Box flexDirection="column" marginY={1}>
              <Text>
                <Text color="gray">Project: </Text>
                <Text bold>{selectedProject?.name}</Text>
              </Text>
              <Text>
                <Text color="gray">Repos: </Text>
                <Text bold>{selectedRepos.length} selected</Text>
              </Text>
              <Text>
                <Text color="gray">Title: </Text>
                <Text bold>{title}</Text>
              </Text>
              <Text>
                <Text color="gray">Description: </Text>
                <Text>{description.substring(0, 80)}...</Text>
              </Text>
              <Text>
                <Text color="gray">Priority: </Text>
                <Text bold>
                  {priority === 'urgent' ? '🔴' : priority === 'high' ? '🟠' : priority === 'medium' ? '🟡' : '🟢'} {priority}
                </Text>
              </Text>
              <Text>
                <Text color="gray">Auto-Approval: </Text>
                <Text bold color={autoApproval ? 'green' : 'yellow'}>
                  {autoApproval ? '🚀 ENABLED' : '🛡️ DISABLED'}
                </Text>
              </Text>
            </Box>
            {autoApproval && (
              <Box marginBottom={1}>
                <Text color="yellow">
                  ⚠ Auto-approval is ON. The AI will work autonomously without asking for confirmation.
                </Text>
              </Box>
            )}
            <Box gap={2}>
              <SelectInput
                items={[
                  { label: autoApproval ? '🚀 Start Task (Auto-Approval ON)' : '✓ Start Task', value: 'confirm' },
                  { label: '← Go Back', value: 'back' },
                ]}
                onSelect={(item) => {
                  if (item.value === 'confirm') {
                    handleConfirm();
                  } else {
                    setStep('options');
                  }
                }}
              />
            </Box>
          </Box>
        )}

        {/* Creating */}
        {step === 'creating' && (
          <Box gap={1}>
            <Spinner type="dots" />
            <Text>Creating task...</Text>
          </Box>
        )}

        {/* Starting */}
        {step === 'starting' && (
          <Box gap={1}>
            <Spinner type="dots" />
            <Text>Starting AI orchestration...</Text>
          </Box>
        )}

        {/* Done */}
        {step === 'done' && (
          <Box flexDirection="column" gap={1}>
            <Text color="green">✓ Task started successfully!</Text>
            <Text color="gray">Redirecting to task view...</Text>
          </Box>
        )}

        {/* Error */}
        {step === 'error' && (
          <Box flexDirection="column" gap={1}>
            <Text color="red">✗ Error: {error}</Text>
            <SelectInput
              items={[
                { label: 'Try Again', value: 'retry' },
                { label: 'Go Back', value: 'back' },
              ]}
              onSelect={(item) => {
                if (item.value === 'retry') {
                  setStep('confirm');
                } else {
                  onBack();
                }
              }}
            />
          </Box>
        )}
      </Box>

      <StatusBar shortcuts={[]} />
    </Box>
  );
};

export default NewTaskScreen;
