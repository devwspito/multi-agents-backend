# Multi-Project Development Platform Architecture

## 🏗️ System Overview

This platform enables users to create development environments that span multiple GitHub repositories, with Claude Code orchestrating development tasks across different teams and codebases.

## 🎯 Core Features

### 1. 🏢 Project/Environment Management
- **Multi-Environment Creation**: Users can create isolated development environments
- **Repository Clustering**: Connect multiple GitHub repositories (backend, frontend, mobile, etc.)
- **Team Assignment**: Assign different development teams to different repositories
- **Cross-Repository Task Coordination**: Tasks that span multiple repositories

### 2. 🔄 Multi-Repository Integration
- **GitHub API Integration**: Connect and manage multiple repositories
- **Branch Synchronization**: Coordinate branches across repositories
- **Dependency Management**: Handle inter-repository dependencies
- **Unified Deployment Pipeline**: Deploy changes across all connected repositories

### 3. 👥 Development Team Orchestration
- **Team-Specific Agents**: Different Claude Code agents for different repositories
- **Task Distribution**: Intelligently distribute tasks based on repository and expertise
- **Cross-Team Communication**: Coordinate changes that affect multiple teams
- **Unified Code Review**: Consolidated review process across all repositories

### 4. 📋 Complete Code Review Interface
- **Full Diff Display**: Show EVERY line changed across all repositories
- **Interactive Approval**: Line-by-line approval or rejection
- **Cross-Repository Impact Analysis**: Show how changes in one repo affect others
- **Unified Merge Strategy**: Coordinate merges across all repositories

## 🏗️ Technical Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Frontend Interface                      │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐│
│  │   Project       │  │   Task          │  │   Code       ││
│  │   Management    │  │   Distribution  │  │   Review     ││
│  │   Dashboard     │  │   Center        │  │   Interface  ││
│  └─────────────────┘  └─────────────────┘  └──────────────┘│
└─────────────────────────────────────────────────────────────┘
                                │
                                │ REST API
                                ▼
┌─────────────────────────────────────────────────────────────┐
│                    Backend API Server                       │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐│
│  │   Project       │  │   Task          │  │   Repository ││
│  │   Controller    │  │   Orchestrator  │  │   Manager    ││
│  └─────────────────┘  └─────────────────┘  └──────────────┘│
│                                                             │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐│
│  │   Claude Code   │  │   GitHub API    │  │   Deployment ││
│  │   Headless      │  │   Integration   │  │   Orchestrator││
│  └─────────────────┘  └─────────────────┘  └──────────────┘│
└─────────────────────────────────────────────────────────────┘
                                │
                                │ Claude Code Agents
                                ▼
┌─────────────────────────────────────────────────────────────┐
│                 Development Teams Layer                     │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐ │
│  │   Frontend   │  │   Backend    │  │    DevOps        │ │
│  │   Team       │  │   Team       │  │    Team          │ │
│  │              │  │              │  │                  │ │
│  │ • React/Vue  │  │ • Node.js    │  │ • Infrastructure │ │
│  │ • Mobile     │  │ • Python     │  │ • CI/CD          │ │
│  │ • UI/UX      │  │ • Database   │  │ • Monitoring     │ │
│  └──────────────┘  └──────────────┘  └───────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                                │
                                │ Repository Operations
                                ▼
┌─────────────────────────────────────────────────────────────┐
│                    GitHub Repositories                      │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐ │
│  │   Frontend   │  │   Backend    │  │   Infrastructure │ │
│  │   Repo       │  │   Repo       │  │   Repo           │ │
│  └──────────────┘  └──────────────┘  └───────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## 🔧 Implementation Components

### 1. Database Schema
```sql
-- Projects table
CREATE TABLE projects (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    owner_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Repositories table
CREATE TABLE repositories (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id),
    github_url VARCHAR(500) NOT NULL,
    repo_name VARCHAR(255) NOT NULL,
    branch VARCHAR(255) DEFAULT 'main',
    team_assignment VARCHAR(100), -- frontend, backend, devops
    access_token_encrypted TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Tasks table
CREATE TABLE tasks (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id),
    title VARCHAR(500) NOT NULL,
    description TEXT,
    status VARCHAR(50) DEFAULT 'pending', -- pending, in_progress, review, completed
    assigned_repositories INTEGER[], -- Array of repository IDs
    created_by VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
);

-- Code changes table
CREATE TABLE code_changes (
    id SERIAL PRIMARY KEY,
    task_id INTEGER REFERENCES tasks(id),
    repository_id INTEGER REFERENCES repositories(id),
    branch_name VARCHAR(255),
    diff_content TEXT, -- Complete diff
    file_changes JSON, -- Structured file changes
    status VARCHAR(50) DEFAULT 'pending', -- pending, approved, rejected
    reviewed_at TIMESTAMP,
    merged_at TIMESTAMP
);
```

### 2. Claude Code Headless Integration
```javascript
// backend/src/services/ClaudeOrchestrator.js
class ClaudeOrchestrator {
    constructor() {
        this.agentPools = {
            frontend: new ClaudeAgentPool('frontend-team'),
            backend: new ClaudeAgentPool('backend-team'),
            devops: new ClaudeAgentPool('devops-team'),
            qa: new ClaudeAgentPool('qa-engineer')
        };
    }

    async distributeTask(taskDescription, repositories) {
        const analysis = await this.analyzeTaskRequirements(taskDescription, repositories);
        const assignments = await this.createTeamAssignments(analysis);
        
        const results = await Promise.all(
            assignments.map(assignment => 
                this.executeTeamTask(assignment.team, assignment.task, assignment.repositories)
            )
        );

        return this.consolidateResults(results);
    }

    async executeTeamTask(team, task, repositories) {
        const agent = this.agentPools[team].getAvailableAgent();
        
        return await agent.execute({
            prompt: this.buildTeamSpecificPrompt(team, task),
            repositories: repositories,
            tools: this.getTeamTools(team),
            outputStyle: `${team}-development`
        });
    }
}
```

### 3. Multi-Repository Manager
```javascript
// backend/src/services/MultiRepoManager.js
class MultiRepoManager {
    async cloneProjectRepositories(project) {
        const repositories = await this.getProjectRepositories(project.id);
        const workspaceDir = `./workspaces/${project.id}`;
        
        await fs.ensureDir(workspaceDir);
        
        const cloneResults = await Promise.all(
            repositories.map(repo => this.cloneRepository(repo, workspaceDir))
        );

        return {
            workspaceDir,
            repositories: cloneResults
        };
    }

    async createFeatureBranches(projectId, taskId) {
        const repositories = await this.getProjectRepositories(projectId);
        const branchName = `feature/task-${taskId}`;
        
        const branchResults = await Promise.all(
            repositories.map(repo => 
                this.createBranch(repo, branchName)
            )
        );

        return branchResults;
    }

    async generateUnifiedDiff(projectId, taskId) {
        const repositories = await this.getProjectRepositories(projectId);
        const allChanges = [];

        for (const repo of repositories) {
            const diff = await this.getRepositoryDiff(repo, `feature/task-${taskId}`);
            if (diff.hasChanges) {
                allChanges.push({
                    repository: repo.repo_name,
                    changes: diff
                });
            }
        }

        return this.formatUnifiedDiff(allChanges);
    }
}
```

## 🎨 Frontend Interface Design

### Project Dashboard
```jsx
// frontend/src/components/ProjectDashboard.jsx
const ProjectDashboard = () => {
    const [projects, setProjects] = useState([]);
    const [selectedProject, setSelectedProject] = useState(null);

    return (
        <div className="dashboard">
            <header className="dashboard-header">
                <h1>🏢 Development Projects</h1>
                <button onClick={() => setShowCreateModal(true)}>
                    + Create New Project
                </button>
            </header>

            <div className="project-grid">
                {projects.map(project => (
                    <ProjectCard 
                        key={project.id}
                        project={project}
                        onSelect={setSelectedProject}
                    />
                ))}
            </div>

            {selectedProject && (
                <ProjectDetails project={selectedProject} />
            )}
        </div>
    );
};

const ProjectCard = ({ project }) => (
    <div className="project-card">
        <h3>{project.name}</h3>
        <div className="repository-list">
            {project.repositories.map(repo => (
                <RepositoryBadge key={repo.id} repository={repo} />
            ))}
        </div>
        <div className="project-stats">
            <span>🔄 {project.activeTasks} active tasks</span>
            <span>📝 {project.pendingReviews} pending reviews</span>
        </div>
    </div>
);
```

### Task Creation Interface
```jsx
// frontend/src/components/TaskCreator.jsx
const TaskCreator = ({ projectId }) => {
    const [taskDescription, setTaskDescription] = useState('');
    const [selectedRepositories, setSelectedRepositories] = useState([]);
    const [taskAnalysis, setTaskAnalysis] = useState(null);

    const analyzeTask = async () => {
        const analysis = await api.analyzeTask({
            description: taskDescription,
            repositories: selectedRepositories
        });
        setTaskAnalysis(analysis);
    };

    return (
        <div className="task-creator">
            <h2>📝 Create New Task</h2>
            
            <div className="task-input">
                <label>Task Description</label>
                <textarea 
                    value={taskDescription}
                    onChange={(e) => setTaskDescription(e.target.value)}
                    placeholder="Describe what needs to be implemented..."
                />
            </div>

            <RepositorySelector 
                repositories={projectRepositories}
                selected={selectedRepositories}
                onChange={setSelectedRepositories}
            />

            <button onClick={analyzeTask}>
                🔍 Analyze Task Requirements
            </button>

            {taskAnalysis && (
                <TaskAnalysisResult analysis={taskAnalysis} />
            )}
        </div>
    );
};
```

### Code Review Interface
```jsx
// frontend/src/components/CodeReviewInterface.jsx
const CodeReviewInterface = ({ taskId }) => {
    const [allChanges, setAllChanges] = useState([]);
    const [reviewStatus, setReviewStatus] = useState({});

    return (
        <div className="code-review">
            <header className="review-header">
                <h2>📋 Code Review - Task #{taskId}</h2>
                <div className="review-actions">
                    <button 
                        className="approve-all"
                        onClick={() => approveAllChanges()}
                    >
                        ✅ Approve All Changes
                    </button>
                    <button 
                        className="deploy"
                        onClick={() => deployChanges()}
                    >
                        🚀 Deploy to Production
                    </button>
                </div>
            </header>

            <div className="repository-changes">
                {allChanges.map(repoChange => (
                    <RepositoryDiff 
                        key={repoChange.repository}
                        repository={repoChange.repository}
                        changes={repoChange.changes}
                        onApprove={(file) => approveFileChange(repoChange.repository, file)}
                        onReject={(file) => rejectFileChange(repoChange.repository, file)}
                    />
                ))}
            </div>

            <UnifiedDiffView changes={allChanges} />
        </div>
    );
};

const RepositoryDiff = ({ repository, changes, onApprove, onReject }) => (
    <div className="repository-diff">
        <h3>📁 {repository}</h3>
        {changes.files.map(file => (
            <FileDiff 
                key={file.path}
                file={file}
                onApprove={() => onApprove(file)}
                onReject={() => onReject(file)}
            />
        ))}
    </div>
);
```

Este diseño proporciona la base completa para el sistema que describiste. ¿Te gustaría que implemente alguna parte específica primero?