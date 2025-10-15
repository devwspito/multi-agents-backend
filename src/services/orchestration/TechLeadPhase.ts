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

    if (context.task.orchestration.techLead?.status === 'completed') {
      console.log(`[SKIP] Tech Lead already completed - skipping re-execution`);

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

    // Update task status
    const startTime = new Date();
    task.orchestration.techLead.status = 'in_progress';
    task.orchestration.techLead.startedAt = startTime;
    await task.save();

    // Notify agent started
    NotificationService.emitAgentStarted(taskId, 'Tech Lead');

    await LogService.agentStarted('tech-lead', taskId, {
      phase: 'architecture',
    });

    try {
      // TODO: Add epicsIdentified to IAgentStep if needed
      // For now, extract epics from productManager output manually if needed
      const epicsIdentified: string[] = []; // task.orchestration.productManager.epicsIdentified || [];

      // Build repositories information
      const repoInfo = context.repositories.length > 0
        ? `\n## Available Repositories:\n${context.repositories.map((repo, i) =>
            `${i + 1}. ${repo.githubRepoName} (branch: ${repo.githubBranch}) ${i === 0 ? '(default)' : ''}`
          ).join('\n')}\n`
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

      const prompt = `Act as the tech-lead agent.

# Architecture Design & Team Building
${revisionSection}
## Task:
${task.title}

## Description:
${task.description || 'See title for requirements'}

## Epics Identified by Product Manager:
${epicsIdentified.length > 0 ? epicsIdentified.map((e, i) => `${i + 1}. ${e}`).join('\n') : 'No epics identified - analyze task and create epics as needed'}
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
          "filesToModify": ["src/path/to/file1.ts", "src/path/to/file2.ts"],
          "maxReadsAllowed": 5
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
- ⚠️ **filesToModify MUST contain REAL paths** - Use paths from your exploration (e.g., "src/services/AuthService.ts")
- ⚠️ **maxReadsAllowed = filesToModify.length + 3** - This prevents developers from wasting time
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

      // Progress notification
      // 🔥 IMAGES: Convert task attachments to SDK format (same as Product Manager)
      const fs = require('fs');
      const path = require('path');
      const attachments: any[] = [];
      if (task.attachments && task.attachments.length > 0) {
        console.log(`📎 [TechLead] Processing ${task.attachments.length} attachment(s)`);

        for (const attachmentUrl of task.attachments) {
          // attachments are stored as URL strings
          try {
            // Convert URL path (/uploads/file.png) to filesystem path
            let imagePath: string;
            if (attachmentUrl.startsWith('/uploads/')) {
              imagePath = path.join(process.cwd(), attachmentUrl);
            } else if (path.isAbsolute(attachmentUrl)) {
              imagePath = attachmentUrl;
            } else {
              imagePath = path.join(process.cwd(), attachmentUrl);
            }

            console.log(`  🔍 Resolving image path: ${attachmentUrl} -> ${imagePath}`);

            if (fs.existsSync(imagePath)) {
              const imageBuffer = fs.readFileSync(imagePath);
              const base64Image = imageBuffer.toString('base64');

              // Detect mime type from file extension
              const ext = path.extname(imagePath).toLowerCase();
              let mimeType = 'image/jpeg';
              if (ext === '.png') mimeType = 'image/png';
              else if (ext === '.gif') mimeType = 'image/gif';
              else if (ext === '.webp') mimeType = 'image/webp';

              attachments.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mimeType,
                  data: base64Image,
                },
              });

              const fileName = path.basename(imagePath);
              const fileSizeKB = (imageBuffer.length / 1024).toFixed(1);
              console.log(`  ✅ Attached image: ${fileName} (${fileSizeKB} KB)`);
            } else {
              console.warn(`  ⚠️ Image file not found: ${imagePath}`);
            }
          } catch (error: any) {
            const fileName = path.basename(attachmentUrl);
            console.error(`  ❌ Failed to process image ${fileName}:`, error.message);
          }
        }
      }

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

      // Try to extract JSON from code blocks first
      const codeBlockMatch = result.output.match(/```json\n([\s\S]*?)\n```/);
      if (codeBlockMatch) {
        try {
          parsed = JSON.parse(codeBlockMatch[1]);
        } catch (e) {
          console.log('❌ Failed to parse JSON from code block, trying raw extraction...');
        }
      }

      // Fallback: try to find JSON object in output
      if (!parsed) {
        const jsonMatch = result.output.match(/{[\s\S]*}/);
        if (jsonMatch) {
          try {
            parsed = JSON.parse(jsonMatch[0]);
          } catch (e) {
            console.log('❌ Failed to parse JSON from raw match');
          }
        }
      }

      // Final validation
      if (!parsed || !parsed.epics || !Array.isArray(parsed.epics)) {
        console.log('\n🔍 [TechLead] Agent output (first 1000 chars):\n', result.output.substring(0, 1000));
        throw new Error(`Tech Lead did not return valid JSON with epics array. Found ${parsed?.epics ? 'non-array epics' : 'no epics'}`);
      }

      if (parsed.epics.length === 0) {
        console.log('\n⚠️  [TechLead] Agent returned empty epics array');
        throw new Error('Tech Lead returned empty epics array - cannot proceed with development');
      }

      console.log(`✅ [TechLead] Successfully parsed ${parsed.epics.length} epic(s)`);

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
              assignedTo: parsed.storyAssignments?.find((a: any) => a.storyId === story.id)?.assignedTo,
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

      await task.save();

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
      task.orchestration.techLead.status = 'failed';
      task.orchestration.techLead.error = error.message;
      await task.save();

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
}
