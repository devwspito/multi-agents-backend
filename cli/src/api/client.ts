/**
 * API Client
 * Connects to the Multi-Agent Backend
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import { configStore } from '../utils/config.js';

class ApiClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: configStore.getApiUrl(),
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Request interceptor - add auth token
    this.client.interceptors.request.use((config) => {
      const token = configStore.getAuthToken();
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      // Update baseURL in case it changed
      config.baseURL = configStore.getApiUrl();
      return config;
    });

    // Response interceptor - handle errors
    this.client.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        if (error.response?.status === 401) {
          // Token expired or invalid
          configStore.logout();
        }
        return Promise.reject(error);
      }
    );
  }

  // ============================================================================
  // AUTH
  // ============================================================================

  async login(email: string, password: string) {
    const response = await this.client.post('/api/auth/login', { email, password });
    return response.data;
  }

  async register(name: string, email: string, password: string) {
    const response = await this.client.post('/api/auth/register', { name, email, password });
    return response.data;
  }

  async getProfile() {
    const response = await this.client.get('/api/auth/profile');
    return response.data;
  }

  async getGithubAuthUrl() {
    const response = await this.client.get('/api/auth/github/url');
    return response.data;
  }

  async checkGithubConnection() {
    const response = await this.client.get('/api/auth/github/status');
    return response.data;
  }

  // ============================================================================
  // PROJECTS
  // ============================================================================

  async getProjects() {
    const response = await this.client.get('/api/projects');
    return response.data;
  }

  async getProject(id: string) {
    const response = await this.client.get(`/api/projects/${id}`);
    return response.data;
  }

  async createProject(data: { name: string; description?: string }) {
    const response = await this.client.post('/api/projects', data);
    return response.data;
  }

  async deleteProject(id: string) {
    const response = await this.client.delete(`/api/projects/${id}`);
    return response.data;
  }

  // ============================================================================
  // REPOSITORIES
  // ============================================================================

  async getRepositories(projectId?: string) {
    const url = projectId ? `/api/repositories?projectId=${projectId}` : '/api/repositories';
    const response = await this.client.get(url);
    return response.data;
  }

  async addRepository(data: {
    projectId: string;
    githubRepoName: string;
    name?: string;
  }) {
    const response = await this.client.post('/api/repositories', data);
    return response.data;
  }

  async syncRepository(id: string) {
    const response = await this.client.post(`/api/repositories/${id}/sync`);
    return response.data;
  }

  async deleteRepository(id: string) {
    const response = await this.client.delete(`/api/repositories/${id}`);
    return response.data;
  }

  async getGithubRepos() {
    const response = await this.client.get('/api/repositories/github/repos');
    return response.data;
  }

  // ============================================================================
  // TASKS
  // ============================================================================

  async getTasks(filters?: { projectId?: string; status?: string }) {
    const params = new URLSearchParams();
    if (filters?.projectId) params.append('projectId', filters.projectId);
    if (filters?.status) params.append('status', filters.status);
    const url = `/api/tasks${params.toString() ? '?' + params.toString() : ''}`;
    const response = await this.client.get(url);
    return response.data;
  }

  async getTask(id: string) {
    const response = await this.client.get(`/api/tasks/${id}`);
    return response.data;
  }

  async createTask(data: {
    title: string;
    description?: string;
    projectId: string;
    repositoryIds: string[];
    priority?: 'low' | 'medium' | 'high' | 'urgent';
  }) {
    const response = await this.client.post('/api/tasks', data);
    return response.data;
  }

  async startTask(id: string, data: { description: string }) {
    const response = await this.client.post(`/api/tasks/${id}/start`, data);
    return response.data;
  }

  async pauseTask(id: string) {
    const response = await this.client.post(`/api/tasks/${id}/pause`);
    return response.data;
  }

  async resumeTask(id: string) {
    const response = await this.client.post(`/api/tasks/${id}/resume`);
    return response.data;
  }

  async cancelTask(id: string) {
    const response = await this.client.post(`/api/tasks/${id}/cancel`);
    return response.data;
  }

  async deleteTask(id: string) {
    const response = await this.client.delete(`/api/tasks/${id}`);
    return response.data;
  }

  async getTaskStatus(id: string) {
    const response = await this.client.get(`/api/tasks/${id}/status`);
    return response.data;
  }

  async getTaskLogs(id: string) {
    const response = await this.client.get(`/api/tasks/${id}/logs`);
    return response.data;
  }

  async getTaskOrchestration(id: string) {
    const response = await this.client.get(`/api/tasks/${id}/orchestration`);
    return response.data;
  }

  // ============================================================================
  // APPROVALS
  // ============================================================================

  async approvePhase(taskId: string, phase: string) {
    const response = await this.client.post(`/api/tasks/${taskId}/approve/${phase}`);
    return response.data;
  }

  async rejectPhase(taskId: string, phase: string, feedback: string) {
    const response = await this.client.post(`/api/tasks/${taskId}/reject/${phase}`, { feedback });
    return response.data;
  }

  // ============================================================================
  // AUTO-APPROVAL
  // ============================================================================

  async getAutoApprovalConfig(taskId: string) {
    const response = await this.client.get(`/api/tasks/${taskId}/auto-approval`);
    return response.data;
  }

  async setAutoApprovalConfig(taskId: string, config: {
    enabled: boolean;
    phases?: string[];
  }) {
    const response = await this.client.put(`/api/tasks/${taskId}/auto-approval`, config);
    return response.data;
  }

  async bypassApproval(taskId: string, phase: string, options?: {
    enableAutoApproval?: boolean;
    enableForAllPhases?: boolean;
  }) {
    const response = await this.client.post(`/api/tasks/${taskId}/bypass-approval/${phase}`, options || {});
    return response.data;
  }

  // ============================================================================
  // ANALYTICS
  // ============================================================================

  async getAnalytics() {
    const response = await this.client.get('/api/analytics');
    return response.data;
  }

  // ============================================================================
  // HEALTH
  // ============================================================================

  async checkHealth() {
    const response = await this.client.get('/api/health');
    return response.data;
  }
}

export const api = new ApiClient();
export default api;
