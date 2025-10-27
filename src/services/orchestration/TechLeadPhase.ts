import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';
import { RealisticCostEstimator } from '../RealisticCostEstimator';

/**
 * Tech Lead Phase
 *
 * Designs technical architecture and builds development team
 * - Breaks down epics into implementable stories
 * - Creates technical architecture design
 * - Decides team composition (number of developers)
 * - Assigns stories to team members
 */
export class TechLeadPhase extends BasePhase {
  readonly name = 'TechLead'; // Must match PHASE_ORDER
  readonly description = 'Designing architecture and building development team';

  constructor(private executeAgentFn: Function) {
    super();
  }

  /**
   * Skip if Tech Lead already completed
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    // Refresh task from DB to get latest state
    const Task = require('../../models/Task').Task;
    const freshTask = await Task.findById(task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    // 🔄 CONTINUATION: Never skip - always re-execute all phases with new context
    const isContinuation = context.task.orchestration.continuations &&
                          context.task.orchestration.continuations.length > 0;

    if (isContinuation) {
      console.log(`🔄 [TechLead] This is a CONTINUATION - will re-execute with additional requirements`);
      return false; // DO NOT SKIP
    }

    // 🛠️ RECOVERY: Skip if already completed (orchestration interrupted and restarting)
    if (context.task.orchestration.techLead?.status === 'completed') {
      console.log(`[SKIP] Tech Lead already completed - skipping re-execution (recovery mode)`);

      // Restore phase data from previous execution for next phases
      if (context.task.orchestration.techLead.output) {
        context.setData('techLeadOutput', context.task.orchestration.techLead.output);
      }
      // TODO: Add epics and storiesMap to IAgentStep if needed
      // if (context.task.orchestration.techLead.epics) {
      //   context.setData('epics', context.task.orchestration.techLead.epics);
      // }
      // if (context.task.orchestration.techLead.storiesMap) {
      //   context.setData('storiesMap', context.task.orchestration.techLead.storiesMap);
      // }

      return true;
    }

    return false;
  }

  protected async executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const task = context.task;
    const taskId = (task._id as any).toString();
    const workspacePath = context.workspacePath;
    const workspaceStructure = context.getData<string>('workspaceStructure') || '';

    // 🔥 MULTI-TEAM MODE: Check if we're in team mode BEFORE updating task
    const teamEpic = context.getData<any>('teamEpic');
    const multiTeamMode = !!teamEpic;

    // Update task status (skip in multi-team mode to avoid conflicts)
    const startTime = new Date();
    if (!multiTeamMode) {
      task.orchestration.techLead.status = 'in_progress';
      task.orchestration.techLead.startedAt = startTime;
      await task.save();
    }

    // Notify agent started
    NotificationService.emitAgentStarted(taskId, 'Tech Lead');

    await LogService.agentStarted('tech-lead', taskId, {
      phase: 'architecture',
    });

    try {
      // Get epic branch if in multi-team mode
      const epicBranch = context.getData<string>('epicBranch');

      if (multiTeamMode) {
        console.log(`\n🎯 [TechLead] Multi-Team Mode: Working on epic: ${teamEpic.id}`);
        console.log(`   Epic: ${teamEpic.title}`);
        console.log(`   Branch: ${epicBranch}`);
        console.log(`   Complexity: ${teamEpic.estimatedComplexity}`);
      }

      // TODO: Add epicsIdentified to IAgentStep if needed
      // For now, extract epics from productManager output manually if needed
      const epicsIdentified: string[] = []; // task.orchestration.productManager.epicsIdentified || [];

      // Build repositories information with TYPE for multi-repo orchestration
      const repoInfo = context.repositories.length > 0
        ? `\n## Available Repositories:\n${context.repositories.map((repo, i) => {
            const typeEmoji = repo.type === 'backend' ? '🔧' : repo.type === 'frontend' ? '🎨' : '📦';
            const isDefault = i === 0 ? ' (default workspace)' : '';
            return `${i + 1}. **${repo.name}** (${typeEmoji} ${repo.type.toUpperCase()})${isDefault}
   - GitHub: ${repo.githubRepoName}
   - Branch: ${repo.githubBranch}
   - Execution Order: ${repo.executionOrder || 'not set'}`;
          }).join('\n')}\n`
        : '';

      const workspaceInfo = workspaceStructure
        ? `\n## Workspace Structure:\n\`\`\`\n${workspaceStructure}\`\`\`\n\nDesign architecture considering all repositories.`
        : '';

      // TODO: Add feedbackHistory to IAgentStep if revision support is needed
      // For now, check if there's previous output for revision detection
      const previousOutput = task.orchestration.techLead.output;
      const hasRevision = previousOutput && task.orchestration.techLead.status === 'in_progress';

      let revisionSection = '';
      if (hasRevision) {
        revisionSection = `

# Previous Architecture Available
Your previous architecture design is available if needed for reference:
\`\`\`
${previousOutput}
\`\`\`
`;
      }

      // 🔥 MULTI-TEAM MODE: Different prompt for epic breakdown into stories
      const firstRepoName = context.repositories[0]?.full_name || context.repositories[0]?.githubRepoName || 'repository-name';

      // 🔥 NEW: Get Master Epic context for contract awareness
      const masterEpic = context.getData<any>('masterEpic');

      const prompt = multiTeamMode ? this.buildMultiTeamPrompt(teamEpic, repoInfo, workspaceInfo, workspacePath || process.cwd(), firstRepoName, epicBranch, masterEpic) : `Act as the tech-lead agent.

# Architecture Design & Team Building
${revisionSection}
## Task:
${task.title}

## Description:
${task.description || 'See title for requirements'}

## Epics Identified by Product Manager:
${epicsIdentified.length > 0 ? epicsIdentified.map((e, i) => `${i + 1}. ${e}`).join('\n') : 'No epics identified - analyze task and create epics as needed'}

## 🚨 CRITICAL: WORKSPACE LOCATION - READ THIS CAREFULLY

**⚠️  YOU ARE SANDBOXED IN THIS WORKSPACE: ${workspacePath}**

**ABSOLUTE RULE**: ONLY explore files inside this workspace path. NEVER explore outside.

The following repositories are cloned INSIDE your workspace:
${context.repositories.map(repo =>
  `- **${workspacePath}/${repo.name}** (${repo.type}) → ${repo.githubRepoName}`
).join('\n')}

**✅ CORRECT Commands (stay inside workspace)**:
\`\`\`bash
cd ${workspacePath}/${context.repositories[0]?.name || 'repo'} && find src -name "*.ts"
Read("${context.repositories[0]?.name || 'repo'}/src/models/User.ts")
\`\`\`

**❌ INCORRECT Commands (FORBIDDEN)**:
\`\`\`bash
# ❌ NEVER explore outside workspace
find ~ -name "*.ts"
Read("mult-agents-frontend/src/components/Modal.jsx")  # NOT in your workspace!
\`\`\`

**📝 FILE PATHS IN STORIES**: Must be relative to repo root
- ✅ CORRECT: "src/models/User.ts"
- ❌ WRONG: "${context.repositories[0]?.name || 'repo'}/src/models/User.ts"

${repoInfo}${workspaceInfo}

## Your Mission:
Create a comprehensive technical plan with:
1. **Epics & Stories Breakdown** - Implementable, testable units of work
2. **Technical Architecture** - Complete design with patterns and best practices
3. **Repository Assignment** - Clear repository mapping for each epic
4. **Team Composition** - Right team size with balanced workload
5. **Story Assignments** - Smart distribution based on complexity

---

## ⚠️ CRITICAL: Story Description Requirements

Each story description MUST include ALL of the following sections:

### 1. ACCEPTANCE CRITERIA (Given/When/Then format)
Provide clear, testable acceptance criteria:
- **Given**: Initial state/preconditions
- **When**: Action or trigger
- **Then**: Expected outcome

Example:
\`\`\`
**Acceptance Criteria:**
- Given a user is on the login page
- When they enter valid credentials and click "Login"
- Then they should be redirected to the dashboard
- And their session should be persisted
\`\`\`

### 2. TECHNICAL SPECIFICATIONS
Be extremely specific about implementation:

**Files to Create/Modify:**
- Exact file paths to create or modify
- Example: \`src/components/LoginForm.tsx\` (create)
- Example: \`src/services/AuthService.ts\` (modify - add login method)

**Functions/Classes/Components:**
- Specific names and signatures
- Example: \`async function login(email: string, password: string): Promise<User>\`
- Example: \`class AuthService { async authenticate(credentials): Promise<Token> }\`

**Data Structures:**
- Interfaces, types, or schemas
- Example:
\`\`\`typescript
interface LoginCredentials {
  email: string;
  password: string;
}
\`\`\`

**API/Endpoints (if applicable):**
- HTTP methods, routes, request/response formats
- Example: \`POST /api/auth/login\`
- Request: \`{ email, password }\`
- Response: \`{ token, user }\`

### 3. IMPLEMENTATION GUIDELINES
Provide clear direction:

**Design Patterns to Follow:**
- Which patterns to use (e.g., Service pattern, Repository pattern, Factory pattern)
- Example: "Use Repository pattern for data access"

**Security Considerations:**
- Authentication/authorization requirements
- Input validation rules
- Data sanitization needs
- Example: "Hash passwords with bcrypt (10 rounds), validate email format, sanitize all user inputs"

**Performance Considerations:**
- Caching strategies
- Database query optimization
- Async/await patterns
- Example: "Use Redis cache for session storage, debounce search by 300ms"

**Error Handling:**
- Specific errors to handle
- Error messages to return
- Example: "Handle InvalidCredentials (401), UserNotFound (404), ServerError (500)"

### 4. TESTING REQUIREMENTS
Define what tests are needed:
- Unit tests for each function
- Integration tests for workflows
- Test cases to cover
- Example: "Test successful login, invalid credentials, missing fields, SQL injection attempts"

### 5. DEFINITION OF DONE
Clear completion criteria:
- [ ] All acceptance criteria met
- [ ] All functions implemented and typed
- [ ] Unit tests written and passing
- [ ] Integration tests passing
- [ ] Code linted (no ESLint errors)
- [ ] TypeScript compilation successful
- [ ] Security considerations addressed
- [ ] Performance requirements met

### 6. CODE EXAMPLES (when helpful)
Provide code snippets for complex logic:
\`\`\`typescript
// Example: JWT token generation
const token = jwt.sign(
  { userId: user.id, email: user.email },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);
\`\`\`

---

**RESPOND ONLY WITH VALID JSON** in this exact format:
\`\`\`json
{
  "epics": [
    {
      "id": "epic-1",
      "name": "Epic Name",
      "description": "Epic description",
      "branchName": "epic/epic-name",
      "targetRepository": "${context.repositories[0]?.full_name || context.repositories[0]?.name || 'repository-name'}",
      "stories": [
        {
          "id": "story-1",
          "title": "Story title",
          "description": "COMPLETE story description following ALL sections above (Acceptance Criteria, Technical Specifications, Implementation Guidelines, Testing Requirements, Definition of Done, Code Examples if needed)",
          "epicId": "epic-1",
          "priority": 1,
          "estimatedComplexity": "simple|moderate|complex",
          "dependencies": [],
          "status": "pending",
          "filesToRead": ["src/path/to/file1.ts"],
          "filesToModify": ["src/path/to/file2.ts", "src/path/to/file3.ts"],
          "filesToCreate": ["src/path/to/newfile.ts"]
        }
      ],
      "status": "pending"
    }
  ],
  "architectureDesign": "Comprehensive technical architecture including: system design, data flow, component interactions, database schema, API contracts, security measures, performance optimizations, error handling strategy, testing approach",
  "teamComposition": {
    "developers": 2,
    "reasoning": "Why this team size based on story complexity and interdependencies"
  },
  "storyAssignments": [
    {
      "storyId": "story-1",
      "assignedTo": "dev-1"
    }
  ]
}
\`\`\`

**Critical Rules**:
- 🚨 **YOU MUST EXPLORE THE CODEBASE FIRST** - Before outputting JSON:
  1. Use \`ls -la\` to list all repositories
  2. Use \`cd repo-name && find . -name "*.ts" -o -name "*.js" | head -20\` to see file structure
  3. Use Read tool to examine key files (package.json, main entry points, existing models)
  4. Identify EXACTLY which files exist and need modification
  5. ONLY THEN output the JSON with real file paths
- ⚠️ **filesToRead, filesToModify, filesToCreate MUST contain REAL paths** - Use paths from your exploration (e.g., "src/services/AuthService.ts")
- ⚠️ **STORY DESCRIPTIONS MUST BE DETAILED**: Include ALL 6 sections above (Acceptance Criteria, Technical Specs, Guidelines, Testing, Definition of Done, Examples)
- ⚠️ **BE SPECIFIC**: No vague descriptions like "Implement feature X". Instead: "Create LoginForm.tsx component with email/password fields, validate inputs, call AuthService.login(), handle errors, redirect on success"
- ⚠️ **EACH STORY MUST BE SELF-CONTAINED**: Developer should know exactly what files to create/modify, what functions to write, what tests to add
- Each epic MUST specify targetRepository (the repository where changes will be made)
- Use exact repository names from the "Available Repositories" list above
- If targetRepository is not specified, the first repository will be used as default
- Use instanceIds like "dev-1", "dev-2", "dev-3", etc.
- Assign stories based on complexity and developer availability
- Balance workload across developers
- Each story must have a unique ID and belong to an epic
- Stories should be implementable in 1-3 hours max
- Break complex features into multiple stories if needed`;

      // 🔥 CRITICAL: Retrieve processed attachments from context (shared from ProductManager)
      // This ensures ALL agents receive the same multimedia context without re-processing
      const attachments = context.getData<any[]>('attachments') || [];
      if (attachments.length > 0) {
        console.log(`📎 [TechLead] Using ${attachments.length} attachment(s) from context`);
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `📎 Tech Lead: Received ${attachments.length} image(s) from context for architecture design`
        );
      }

      // Progress notification

      NotificationService.emitAgentProgress(
        taskId,
        'Tech Lead',
        'Designing architecture and building team...'
      );

      // Execute agent
      const result = await this.executeAgentFn(
        'tech-lead',
        prompt,
        workspacePath || process.cwd(),
        taskId,
        'Tech Lead',
        undefined, // resumeSessionId
        undefined, // forkSession
        attachments.length > 0 ? attachments : undefined // Pass attachments
      );

      // Parse JSON response with better error handling
      let parsed: any;

      // Try parsing as pure JSON first (no markdown)
      try {
        const trimmed = result.output.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          parsed = JSON.parse(trimmed);
          if (parsed.epics && Array.isArray(parsed.epics)) {
            console.log('✅ [TechLead] Parsed as pure JSON (no markdown blocks)');
          } else {
            parsed = null; // Not the right structure
          }
        }
      } catch (e) {
        // Not pure JSON, try markdown patterns
      }

      // Try multiple extraction patterns (most specific to least specific)
      const patterns = [
        /```json\s*\n([\s\S]*?)\n```/,       // ```json\n{...}\n``` (strict)
        /```json\s*\n([\s\S]*?)```/,         // ```json\n{...}``` (newline after json)
        /```json\s*([\s\S]*?)```/,           // ```json{...}``` (no newlines)
        /```\s*\n([\s\S]*?)\n```/,           // ```\n{...}\n``` (no json keyword)
        /```\s*([\s\S]*?)```/                // ``` {...} ``` (minimal)
      ];

      // Try markdown patterns if pure JSON failed
      if (!parsed) {
        for (const pattern of patterns) {
          const match = result.output.match(pattern);
          if (match) {
            try {
              // Use captured group if available, otherwise full match
              const jsonText = match[1] || match[0];
              const trimmed = jsonText.trim();
              parsed = JSON.parse(trimmed);

              // Verify it has the required structure
              if (parsed.epics && Array.isArray(parsed.epics)) {
                console.log(`✅ [TechLead] Parsed JSON using pattern: ${pattern.toString().substring(0, 50)}...`);
                break;
              } else {
                console.log(`⚠️  [TechLead] Parsed JSON but missing epics array with pattern: ${pattern.toString().substring(0, 50)}...`);
                parsed = null; // Reset and try next pattern
                continue;
              }
            } catch (e) {
              console.log(`⚠️  [TechLead] Failed to parse with pattern: ${pattern.toString().substring(0, 50)}...`);
              continue;
            }
          }
        }
      }

      // Final fallback: find the longest valid JSON object with "epics" key
      if (!parsed) {
        console.log('⚠️  [TechLead] Standard patterns failed, trying fallback extraction...');

        // Strategy: Find all positions where '{' appears, then try to parse from each position
        const output = result.output;
        const candidates: Array<{text: string, length: number}> = [];

        for (let i = 0; i < output.length; i++) {
          if (output[i] === '{') {
            // Try to find balanced braces from this position
            let braceCount = 0;
            let j = i;
            let startFound = false;

            while (j < output.length) {
              if (output[j] === '{') {
                braceCount++;
                startFound = true;
              } else if (output[j] === '}') {
                braceCount--;
                if (startFound && braceCount === 0) {
                  // Found a complete object
                  const candidate = output.substring(i, j + 1);
                  candidates.push({ text: candidate, length: candidate.length });
                  break;
                }
              }
              j++;
            }
          }
        }

        // Sort by length (longest first) and try to parse
        candidates.sort((a, b) => b.length - a.length);

        for (const candidate of candidates) {
          try {
            const candidateParsed = JSON.parse(candidate.text);
            if (candidateParsed.epics && Array.isArray(candidateParsed.epics) && candidateParsed.epics.length > 0) {
              parsed = candidateParsed;
              console.log(`✅ [TechLead] Parsed JSON using fallback extraction (found ${candidate.length} char object with epics)`);
              break;
            }
          } catch (e) {
            // Not valid JSON, continue
          }
        }
      }

      if (!parsed) {
        console.log('❌ [TechLead] All JSON extraction patterns failed');
      }

      // Final validation - MUST have both epics[] and storyAssignments[]
      if (!parsed || !parsed.epics || !Array.isArray(parsed.epics)) {
        console.log('\n🔍 [TechLead] FULL Agent output:\n', result.output);
        NotificationService.emitConsoleLog(taskId, 'error', `❌ Tech Lead parsing failed. Full output:\n${result.output}`);
        throw new Error(`Tech Lead did not return valid JSON with epics array. Found ${parsed?.epics ? 'non-array epics' : 'no epics'}`);
      }

      if (parsed.epics.length === 0) {
        console.log('\n⚠️  [TechLead] Agent returned empty epics array');
        throw new Error('Tech Lead returned empty epics array - cannot proceed with development');
      }

      // Validate storyAssignments[] exists (critical for developers)
      if (!parsed.storyAssignments || !Array.isArray(parsed.storyAssignments)) {
        console.log('\n🔍 [TechLead] Missing storyAssignments in output');
        throw new Error('Tech Lead did not return storyAssignments array - developers need file paths');
      }

      if (parsed.storyAssignments.length === 0) {
        console.log('\n⚠️  [TechLead] Agent returned empty storyAssignments array');
        throw new Error('Tech Lead returned empty storyAssignments - developers need work assignments');
      }

      console.log(`✅ [TechLead] Successfully parsed ${parsed.epics.length} epic(s) with ${parsed.storyAssignments.length} story assignment(s)`);

      // Build complete stories map - Preserve all story data from Tech Lead
      const storiesMap: { [storyId: string]: any } = {};
      parsed.epics.forEach((epic: any) => {
        epic.stories.forEach((story: any) => {
          storiesMap[story.id] = {
            id: story.id,
            title: story.title,
            description: story.description,
            epicId: epic.id,
            priority: story.priority,
            estimatedComplexity: story.estimatedComplexity,
            status: 'pending',
            dependencies: story.dependencies || [],
          };
        });
      });

      // 🔥 EVENT SOURCING: Emit events instead of storing nested objects
      const { eventStore } = await import('../EventStore');

      // Emit epic events
      for (const epic of parsed.epics) {
        await eventStore.append({
          taskId: task._id as any,
          eventType: 'EpicCreated',
          agentName: 'tech-lead',
          payload: {
            id: epic.id,
            name: epic.name,
            description: epic.description,
            branchName: epic.branchName,
            stories: epic.stories.map((s: any) => s.id), // Story IDs only
            targetRepository: epic.targetRepository || undefined,
          },
        });

        // Emit story events for each story in this epic
        for (const story of epic.stories) {
          await eventStore.append({
            taskId: task._id as any,
            eventType: 'StoryCreated',
            agentName: 'tech-lead',
            payload: {
              id: story.id,
              epicId: epic.id,
              title: story.title,
              description: story.description,
              priority: story.priority,
              complexity: story.estimatedComplexity,
              estimatedComplexity: story.estimatedComplexity, // For backward compatibility
              assignedTo: parsed.storyAssignments?.find((a: any) => a.storyId === story.id)?.assignedTo,
              filesToRead: story.filesToRead || [],
              filesToModify: story.filesToModify || [],
              filesToCreate: story.filesToCreate || [],
              dependencies: story.dependencies || [],
            },
          });
        }
      }

      // Emit team composition event
      await eventStore.append({
        taskId: task._id as any,
        eventType: 'TeamCompositionDefined',
        agentName: 'tech-lead',
        payload: parsed.teamComposition,
      });

      // ✅ BACKWARD COMPATIBILITY: Also store in Task model (will remove later)
      const epicsWithStringIds = parsed.epics.map((epic: any) => ({
        ...epic,
        stories: epic.stories.map((s: any) => s.id),
        targetRepository: epic.targetRepository || undefined,
      }));
      // TODO: Add epics and storiesMap to IAgentStep if needed
      // For now, store in output only
      // task.orchestration.techLead.epics = epicsWithStringIds;
      // task.orchestration.techLead.storiesMap = storiesMap;
      task.orchestration.techLead.architectureDesign = parsed.architectureDesign;
      task.orchestration.techLead.teamComposition = parsed.teamComposition;
      task.orchestration.techLead.storyAssignments = parsed.storyAssignments;
      // task.markModified('orchestration.techLead.epics');
      // task.markModified('orchestration.techLead.storiesMap');

      // Store agent metadata
      task.orchestration.techLead.status = 'completed';
      task.orchestration.techLead.completedAt = new Date();
      task.orchestration.techLead.output = result.output;
      task.orchestration.techLead.sessionId = result.sessionId;
      // TODO: Add canResumeSession, todos, lastTodoUpdate to IAgentStep if needed
      // task.orchestration.techLead.canResumeSession = result.canResume;
      task.orchestration.techLead.usage = result.usage;
      task.orchestration.techLead.cost_usd = result.cost;

      // if (result.todos) {
      //   task.orchestration.techLead.todos = result.todos;
      //   task.orchestration.techLead.lastTodoUpdate = new Date();
      // }

      // Update costs
      task.orchestration.totalCost += result.cost;
      task.orchestration.totalTokens +=
        (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);

      // 💰 COST ESTIMATION (INFORMATIONAL) - No approval required
      console.log('\n💰 =============== COST ESTIMATION (INFORMATIONAL) ===============');
      const realisticCostEstimator = new RealisticCostEstimator();
      try {
        const costEstimate = await realisticCostEstimator.estimateRealistic(
          epicsWithStringIds,
          context.repositories || [],
          workspacePath
        );

        console.log(`\n💵 REALISTIC COST ESTIMATE:`);
        console.log(`   Total: $${costEstimate.totalEstimated.toFixed(2)}`);
        console.log(`   Range: $${costEstimate.totalMinimum.toFixed(2)} - $${costEstimate.totalMaximum.toFixed(2)}`);
        console.log(`   Per story: $${costEstimate.perStoryEstimate.toFixed(2)}`);
        console.log(`   Duration: ${costEstimate.estimatedDuration} minutes`);
        console.log(`   Confidence: ${costEstimate.confidence}%`);
        console.log(`   Methodology: ${costEstimate.methodology}\n`);

        // Append cost estimate to Tech Lead output (informational)
        task.orchestration.techLead.output += `\n\n---\n\n## 💰 Cost Estimate (Informational)\n\n` +
          `**Total Estimated Cost**: $${costEstimate.totalEstimated.toFixed(2)}\n` +
          `**Range**: $${costEstimate.totalMinimum.toFixed(2)} - $${costEstimate.totalMaximum.toFixed(2)}\n` +
          `**Per Story**: $${costEstimate.perStoryEstimate.toFixed(2)}\n` +
          `**Stories**: ${costEstimate.storiesCount}\n` +
          `**Estimated Duration**: ${costEstimate.estimatedDuration} minutes\n` +
          `**Confidence**: ${costEstimate.confidence}%\n` +
          `**Methodology**: ${costEstimate.methodology}\n\n` +
          `*This is an informational estimate and does not require approval.*`;

        // TODO: Add costEstimate to IAgentStep if needed
        // For now, cost estimate is already appended to output above
        // task.orchestration.techLead.costEstimate = {
        //   estimated: costEstimate.totalEstimated,
        //   minimum: costEstimate.totalMinimum,
        //   maximum: costEstimate.totalMaximum,
        //   perStory: costEstimate.perStoryEstimate,
        //   duration: costEstimate.estimatedDuration,
        //   confidence: costEstimate.confidence,
        //   methodology: costEstimate.methodology,
        //   informationalOnly: true
        // };

        // 🔥 CRITICAL: Mark nested object as modified for Mongoose
        // task.markModified('orchestration.techLead.costEstimate');

        console.log(`✅ [Cost Estimation] Added to Tech Lead output (informational only)`);
      } catch (error: any) {
        console.warn(`⚠️  [Cost Estimation] Failed: ${error.message} - Continuing without cost estimate`);
        task.orchestration.techLead.output += `\n\n---\n\n## 💰 Cost Estimate\n\n*Cost estimation unavailable: ${error.message}*`;
      }

      // Save task (skip in multi-team mode to avoid version conflicts)
      if (!multiTeamMode) {
        await task.save();
      }

      // 🔥 EVENT SOURCING: Emit completion event
      await eventStore.append({
        taskId: task._id as any,
        eventType: 'TechLeadCompleted',
        agentName: 'tech-lead',
        payload: {
          output: result.output,
          epicsCount: parsed.epics.length,
          storiesCount: Object.keys(storiesMap).length,
        },
        metadata: {
          cost: result.cost,
          duration: Date.now() - startTime.getTime(),
        },
      });

      console.log(`📝 [TechLead] Emitted ${parsed.epics.length} EpicCreated + ${Object.keys(storiesMap).length} StoryCreated events`);

      // 🔥 EMIT FULL OUTPUT TO CONSOLE VIEWER (no truncation)
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `\n${'='.repeat(80)}\n🏗️ TECH LEAD - FULL OUTPUT\n${'='.repeat(80)}\n\n${result.output}\n\n${'='.repeat(80)}`
      );

      // Send output to chat
      NotificationService.emitAgentMessage(taskId, 'Tech Lead', result.output);

      // Notify completion
      NotificationService.emitAgentCompleted(
        taskId,
        'Tech Lead',
        `Architecture designed. Team: ${parsed.teamComposition.developers} developers. Stories assigned.`
      );

      await LogService.agentCompleted('tech-lead', taskId, {
        phase: 'architecture',
        metadata: {
          developersCount: parsed.teamComposition.developers,
          epicsCount: parsed.epics.length,
          storiesCount: Object.keys(storiesMap).length,
          cost: result.cost,
          inputTokens: result.usage?.input_tokens || 0,
          outputTokens: result.usage?.output_tokens || 0,
        },
      });

      // Store phase data for next phases
      context.setData('epics', epicsWithStringIds);
      context.setData('storiesMap', storiesMap);
      context.setData('teamComposition', parsed.teamComposition);
      context.setData('storyAssignments', parsed.storyAssignments);
      context.setData('architectureDesign', parsed.architectureDesign);

      return {
        success: true,
        data: {
          epics: epicsWithStringIds,
          storiesMap,
          teamComposition: parsed.teamComposition,
          storyAssignments: parsed.storyAssignments,
          architectureDesign: parsed.architectureDesign,
        },
        metrics: {
          cost_usd: result.cost,
          input_tokens: result.usage?.input_tokens || 0,
          output_tokens: result.usage?.output_tokens || 0,
          developers_count: parsed.teamComposition.developers,
          epics_count: parsed.epics.length,
          stories_count: Object.keys(storiesMap).length,
        },
      };
    } catch (error: any) {
      // Skip task updates in multi-team mode to avoid version conflicts
      if (!multiTeamMode) {
        task.orchestration.techLead.status = 'failed';
        task.orchestration.techLead.error = error.message;
        await task.save();
      }

      // Notify failure
      NotificationService.emitAgentFailed(taskId, 'Tech Lead', error.message);

      await LogService.agentFailed('tech-lead', taskId, error, {
        phase: 'architecture',
      });

      // 🔥 EVENT SOURCING: Emit failure event to prevent infinite loop
      const { eventStore } = await import('../EventStore');
      await eventStore.append({
        taskId: task._id as any,
        eventType: 'TechLeadCompleted', // Mark as completed even on error
        agentName: 'tech-lead',
        payload: {
          error: error.message,
          failed: true,
        },
        metadata: {
          error: error.message,
        },
      });

      console.log(`📝 [TechLead] Emitted TechLeadCompleted event (error state)`);

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Build prompt for Multi-Team mode (epic breakdown into stories + dev assignment)
   * 🔥 NEW: Includes Master Epic context for contract awareness
   */
  private buildMultiTeamPrompt(epic: any, repoInfo: string, workspaceInfo: string, workspacePath: string, firstRepo?: string, branchName?: string, masterEpic?: any): string {
    const targetRepo = epic.targetRepository || epic.affectedRepositories?.[0] || firstRepo || 'repository-name';
    const repoType = epic.targetRepository ? (epic.targetRepository.includes('frontend') || epic.targetRepository.includes('ws-project') ? 'FRONTEND' : 'BACKEND') : 'UNKNOWN';

    // 🔥 NEW: Build Master Epic context section
    let masterEpicContext = '';
    if (masterEpic && epic.masterEpicId === masterEpic.id) {
      const namingConventions = epic.globalNamingConventions || masterEpic.globalNamingConventions || {};
      const sharedContracts = epic.sharedContracts || masterEpic.sharedContracts || {};
      const otherRepos = (masterEpic.affectedRepositories || []).filter((r: string) => r !== targetRepo);

      masterEpicContext = `
## 🎯 CRITICAL: Master Epic Context

⚠️ **YOU ARE WORKING ON A SUB-EPIC THAT IS PART OF A LARGER MASTER EPIC**

**Master Epic ID**: ${masterEpic.id}
**Master Epic Title**: ${masterEpic.title}
**Your Sub-Epic**: ${epic.id} (${repoType} repository)
${otherRepos.length > 0 ? `**Other Teams Working On**: ${otherRepos.join(', ')} (parallel development)` : ''}

---

### 📋 MANDATORY Naming Conventions (ALL stories MUST follow these)

${Object.entries(namingConventions).map(([key, value]) => `- **${key}**: ${value}`).join('\n')}

**Why this matters**:
- Backend team uses these EXACT field names in database models
- Frontend team uses these EXACT field names in API calls
- If you deviate, you create integration bugs (e.g., backend sends "userId", frontend expects "user_id" → 💥 FAILURE)

**Examples**:
${namingConventions.primaryIdField ? `- User ID field: \`${namingConventions.primaryIdField}\` (NOT "id", "user_id", "userID", etc.)` : ''}
${namingConventions.timestampFormat ? `- Timestamps: ${namingConventions.timestampFormat} format` : ''}
${namingConventions.errorCodePrefix ? `- Error codes: ${namingConventions.errorCodePrefix}ERROR_NAME` : ''}

---

### 🔗 Shared Contracts (APIs and Types)

${sharedContracts.apiEndpoints && sharedContracts.apiEndpoints.length > 0 ? `
**API Endpoints**:
${sharedContracts.apiEndpoints.map((api: any, i: number) => `
${i + 1}. **${api.method} ${api.path}**
   - Description: ${api.description || 'Not provided'}
   - Request: \`${JSON.stringify(api.request)}\`
   - Response: \`${JSON.stringify(api.response)}\`
   ${repoType === 'BACKEND' ? '   → YOU MUST IMPLEMENT this endpoint with this EXACT signature' : ''}
   ${repoType === 'FRONTEND' ? '   → YOU MUST CONSUME this endpoint with this EXACT request format' : ''}
`).join('\n')}
` : ''}

${sharedContracts.sharedTypes && sharedContracts.sharedTypes.length > 0 ? `
**Shared Data Types**:
${sharedContracts.sharedTypes.map((type: any, i: number) => `
${i + 1}. **${type.name}**
   - Description: ${type.description || 'Not provided'}
   - Fields: \`${JSON.stringify(type.fields)}\`
   ${repoType === 'BACKEND' ? '   → Database model MUST use these field names and types' : ''}
   ${repoType === 'FRONTEND' ? '   → Components MUST use these field names when displaying data' : ''}
`).join('\n')}
` : ''}

${sharedContracts.eventSchemas && sharedContracts.eventSchemas.length > 0 ? `
**Event Schemas**:
${sharedContracts.eventSchemas.map((event: any, i: number) => `
${i + 1}. **${event.name}**
   - Description: ${event.description || 'Not provided'}
   - Payload: \`${JSON.stringify(event.payload)}\`
`).join('\n')}
` : ''}

---

### ⚠️ CRITICAL RULES FOR YOUR STORIES

1. **Field Names**: Use EXACT field names from naming conventions
   - ✅ CORRECT: \`userId: req.body.userId\`
   - ❌ WRONG: \`userId: req.body.user_id\` (different from contract!)

2. **API Implementation** (Backend):
   - Implement endpoints with EXACT paths, methods, request/response formats
   - Return responses matching contract EXACTLY (no extra/missing fields)

3. **API Consumption** (Frontend):
   - Call endpoints with EXACT request format from contract
   - Expect responses matching contract EXACTLY

4. **Type Alignment**:
   - Backend models MUST match shared types
   - Frontend interfaces MUST match shared types
   - NO custom field names or structure changes

5. **Cross-Repo Awareness**:
${otherRepos.length > 0 ? `   - ${otherRepos.join(', ')} team(s) are working in parallel on their part
   - They will use the SAME naming conventions and contracts
   - Your work must integrate seamlessly with theirs` : '   - No other repositories involved in this epic'}

---
`;
    }

    return `Act as the TECH LEAD in MULTI-TEAM MODE.
${masterEpicContext}

# Epic Architecture Design & Team Building

You are the TEAM LEAD for this epic. Your job is to:
1. **Break this epic into 2-5 implementable stories**
2. **Decide how many developers you need** (1-5 devs recommended)
3. **Assign each story to a specific developer**
4. **Provide detailed technical specifications** for each story

## Epic Assignment:
**ID**: ${epic.id}
**Title**: ${epic.title}
**Description**: ${epic.description}
**Complexity**: ${epic.estimatedComplexity}
**Target Repository**: ${targetRepo} (${repoType === 'BACKEND' ? '🔧 BACKEND' : repoType === 'FRONTEND' ? '🎨 FRONTEND' : '📦 GENERAL'})
**Affected Repositories**: ${epic.affectedRepositories?.join(', ') || 'Not specified'}
**Dependencies**: ${epic.dependencies?.length > 0 ? epic.dependencies.join(', ') : 'None'}
**Branch**: ${branchName || `epic/${epic.id}`}
**Execution Order**: ${epic.executionOrder || 'not set'}

## 🚨 CRITICAL: WORKSPACE LOCATION - READ THIS CAREFULLY

**⚠️  YOU ARE SANDBOXED IN THIS WORKSPACE: ${workspacePath}**

**ABSOLUTE RULE**: ONLY explore files inside **${workspacePath}/${targetRepo}**

**✅ CORRECT Commands (stay inside workspace)**:
\`\`\`bash
cd ${workspacePath}/${targetRepo} && find src -name "*.ts" | head -20
Read("${targetRepo}/src/models/User.ts")
\`\`\`

**❌ INCORRECT Commands (FORBIDDEN - exploring outside workspace)**:
\`\`\`bash
# ❌ NEVER explore system directories or other projects
find ~ -name "*.ts"
Read("mult-agents-frontend/src/components/Modal.jsx")  # NOT in your workspace!
ls /Users/.../Desktop/mult-agent-software-project  # System directory!
\`\`\`

**📝 FILE PATHS IN STORIES**: Must be relative to repo root
- ✅ CORRECT: "src/models/User.ts"
- ❌ WRONG: "${targetRepo}/src/models/User.ts"

${repoInfo}${workspaceInfo}

## Repository Type Guidance:

${repoType === 'BACKEND' ? `
### 🔧 BACKEND Repository - Focus On:
- **API Endpoints**: REST routes, GraphQL resolvers, WebSocket handlers
- **Data Models**: MongoDB/Mongoose schemas, database migrations
- **Business Logic**: Services, controllers, middleware, utilities
- **Authentication**: JWT, sessions, OAuth, password hashing
- **Data Processing**: Agenda jobs, cron tasks, background workers
- **File Paths Typically**: backend/src/models/, backend/src/routes/, backend/src/services/, src/middleware/
` : repoType === 'FRONTEND' ? `
### 🎨 FRONTEND Repository - Focus On:
- **UI Components**: React/Vue components, forms, modals, layouts
- **Views/Pages**: Route-level components, dashboard views
- **State Management**: Hooks (useState, useEffect), context, stores
- **API Integration**: Service calls, API clients, data fetching hooks
- **Styling**: CSS, styled-components, Tailwind classes
- **File Paths Typically**: src/components/, src/views/, src/hooks/, src/services/
` : ''}

## Your Mission (as Team Lead):
Break this EPIC into 2-5 implementable STORIES with:
1. **Exact file paths** to read/modify/create (matching repository type above)
2. **Detailed acceptance criteria** (Given/When/Then)
3. **Technical specifications** (functions, classes, APIs)
4. **Implementation guidelines** (patterns, security, performance)
5. **Testing requirements**
6. **Definition of done**

**CRITICAL RULES**:
- 🚨 **EXPLORE CODEBASE FIRST** - Use tools to find actual file paths
- ⚠️ **REAL PATHS ONLY** - No placeholder paths like "src/path/to/file.ts"
- ⚠️ **REPOSITORY AWARENESS** - All file paths MUST match the target repository type (${repoType})
- ⚠️ **2-5 STORIES RECOMMENDED** - Break epic into manageable stories
- ⚠️ **GRANULAR** - Each story = 1-3 hours of work for 1 developer
- ⚠️ **ASSIGN DEVS** - Decide team size (1-5 devs) and assign stories
- ⚠️ **1 DEV = 1 STORY** - Each developer gets exactly one story to work on

**RESPOND ONLY WITH VALID JSON** in this exact format:
\`\`\`json
{
  "epics": [
    {
      "id": "${epic.id}",
      "name": "${epic.title}",
      "description": "Architecture for ${epic.title}",
      "branchName": "${branchName || `epic/${epic.id}`}",
      "targetRepository": "${targetRepo}",
      "stories": [
        {
          "id": "${epic.id}-story-1",
          "title": "Story title (e.g., 'Create AuthService with JWT login')",
          "description": "COMPLETE description with ALL sections: Acceptance Criteria (Given/When/Then), Technical Specifications (files, functions, types, APIs), Implementation Guidelines (patterns, security, performance), Testing Requirements, Definition of Done, Code Examples",
          "epicId": "${epic.id}",
          "priority": 1,
          "estimatedComplexity": "simple|moderate|complex",
          "dependencies": [],
          "status": "pending",
          "filesToRead": ["real/path/file1.ts"],
          "filesToModify": ["real/path/file2.ts"],
          "filesToCreate": ["real/path/newfile.ts"]
        },
        {
          "id": "${epic.id}-story-2",
          "title": "Another story (e.g., 'Add JWT middleware to routes')",
          "description": "COMPLETE description with ALL sections...",
          "epicId": "${epic.id}",
          "priority": 2,
          "estimatedComplexity": "simple|moderate|complex",
          "dependencies": ["${epic.id}-story-1"],
          "status": "pending",
          "filesToRead": ["real/path/file3.ts"],
          "filesToModify": ["real/path/file4.ts"],
          "filesToCreate": []
        }
      ],
      "status": "pending"
    }
  ],
  "architectureDesign": "Technical architecture for ${epic.title} including: system design, data flow, component interactions, API contracts, security, performance, error handling",
  "teamComposition": {
    "developers": 2,
    "reasoning": "2 developers needed - story-1 and story-2 can run in parallel after dependencies resolved"
  },
  "storyAssignments": [
    {
      "storyId": "${epic.id}-story-1",
      "assignedTo": "dev-1"
    },
    {
      "storyId": "${epic.id}-story-2",
      "assignedTo": "dev-2"
    }
  ]
}
\`\`\`

🎯 **TEAM SIZE DECISION**:
- ${epic.estimatedComplexity === 'simple' ? '1-2 developers' : ''}
- ${epic.estimatedComplexity === 'moderate' ? '2-3 developers' : ''}
- ${epic.estimatedComplexity === 'complex' ? '3-4 developers' : ''}
- ${epic.estimatedComplexity === 'epic' ? '4-5 developers' : ''}

Each developer = 1 story. If epic has 3 stories, assign 3 developers.

**Start by exploring the codebase, then output the JSON.**`;
  }
}
