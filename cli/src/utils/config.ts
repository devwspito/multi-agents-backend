/**
 * Configuration Store
 * Stores auth tokens, API URL, and user preferences
 */

import Conf from 'conf';

interface ConfigSchema {
  apiUrl: string;
  authToken: string | null;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  githubConnected: boolean;
  currentProjectId: string | null;
  currentProjectName: string | null;
  theme: 'dark' | 'light';
}

const config = new Conf<ConfigSchema>({
  projectName: 'ai-dev-team-cli',
  defaults: {
    apiUrl: 'http://localhost:3001',
    authToken: null,
    userId: null,
    userName: null,
    userEmail: null,
    githubConnected: false,
    currentProjectId: null,
    currentProjectName: null,
    theme: 'dark',
  },
});

export const configStore = {
  // API URL
  getApiUrl: () => config.get('apiUrl'),
  setApiUrl: (url: string) => config.set('apiUrl', url),

  // Auth
  getAuthToken: () => config.get('authToken'),
  setAuthToken: (token: string | null) => config.set('authToken', token),

  isAuthenticated: () => !!config.get('authToken'),

  // User info
  getUserId: () => config.get('userId'),
  setUserId: (id: string | null) => config.set('userId', id),

  getUserName: () => config.get('userName'),
  setUserName: (name: string | null) => config.set('userName', name),

  getUserEmail: () => config.get('userEmail'),
  setUserEmail: (email: string | null) => config.set('userEmail', email),

  // GitHub
  isGithubConnected: () => config.get('githubConnected'),
  setGithubConnected: (connected: boolean) => config.set('githubConnected', connected),

  // Current project
  getCurrentProjectId: () => config.get('currentProjectId'),
  setCurrentProjectId: (id: string | null) => config.set('currentProjectId', id),

  getCurrentProjectName: () => config.get('currentProjectName'),
  setCurrentProjectName: (name: string | null) => config.set('currentProjectName', name),

  setCurrentProject: (id: string | null, name: string | null) => {
    config.set('currentProjectId', id);
    config.set('currentProjectName', name);
  },

  // Theme
  getTheme: () => config.get('theme'),
  setTheme: (theme: 'dark' | 'light') => config.set('theme', theme),

  // Login/Logout
  login: (data: {
    token: string;
    userId: string;
    userName: string;
    userEmail: string;
    githubConnected: boolean;
  }) => {
    config.set('authToken', data.token);
    config.set('userId', data.userId);
    config.set('userName', data.userName);
    config.set('userEmail', data.userEmail);
    config.set('githubConnected', data.githubConnected);
  },

  logout: () => {
    config.set('authToken', null);
    config.set('userId', null);
    config.set('userName', null);
    config.set('userEmail', null);
    config.set('githubConnected', false);
    config.set('currentProjectId', null);
    config.set('currentProjectName', null);
  },

  // Clear all
  clear: () => config.clear(),

  // Get all config (for debugging)
  getAll: () => config.store,
};

export default configStore;
