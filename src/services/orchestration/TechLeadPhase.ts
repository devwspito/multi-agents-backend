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

      // Previous output for revision (if any) - ALWAYS include if exists (for continuations)
      const previousOutput = task.orchestration.techLead.output;
      const hasRevision = !!previousOutput;

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

# Architecture & Planning
${revisionSection}
## Task: ${task.title}
${task.description ? `Description: ${task.description}` : ''}

## Workspace: ${workspacePath}
${repoInfo}

## 🎯 INSTRUCTIONS (Be concise and efficient):

1. **EXPLORE** (max 3 minutes): Scan codebase structure to find real file paths
2. **CREATE 2-4 EPICS**: Major feature groups
3. **CREATE 3-5 STORIES PER EPIC**: Each 1-3 hours of work

## STORY FORMAT (include all):
- **Acceptance Criteria**: Given/When/Then format
- **Files**: Exact paths to read/modify/create
- **Technical Details**: Functions, APIs, types to implement
- **Testing**: What tests to write
- **Done Criteria**: Checklist for completion

## JSON OUTPUT ONLY:
\`\`\`json
{
  "epics": [
    {
      "id": "epic-1",
      "name": "Epic Name",
      "description": "Brief description",
      "branchName": "epic/epic-name",
      "targetRepository": "${context.repositories[0]?.name || 'repository'}",
      "stories": [
        {
          "id": "story-1",
          "title": "Story title",
          "description": "Complete description with: Acceptance Criteria (Given/When/Then), Files to modify, Functions/APIs to implement, Tests to write, Done criteria",
          "epicId": "epic-1",
          "priority": 1,
          "estimatedComplexity": "simple|moderate|complex",
          "dependencies": [],
          "status": "pending",
          "filesToRead": ["real/path/file.ts"],
          "filesToModify": ["real/path/file2.ts"],
          "filesToCreate": ["real/path/new.ts"]
        }
      ],
      "status": "pending"
    }
  ],
  "architectureDesign": "Technical architecture: system design, data flow, APIs, security, error handling",
  "teamComposition": {
    "developers": 2,
    "reasoning": "Team size reasoning"
  },
  "storyAssignments": [
    {"storyId": "story-1", "assignedTo": "dev-1"}
  ]
}
\`\`\`

**RULES**:
- EXPLORE FIRST: Use ls, find, Read to get real file paths
- USE REAL PATHS: No placeholders
- COMPLETE STORIES: Each must include acceptance criteria, files, technical specs, tests
- ASSIGN ALL STORIES: Each to a dev-1, dev-2, etc.`;

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

    // Master Epic context if available
    let masterEpicContext = '';
    if (masterEpic && epic.masterEpicId === masterEpic.id) {
      const namingConventions = epic.globalNamingConventions || masterEpic.globalNamingConventions || {};
      const sharedContracts = epic.sharedContracts || masterEpic.sharedContracts || {};
      const otherRepos = (masterEpic.affectedRepositories || []).filter((r: string) => r !== targetRepo);

      masterEpicContext = `
## Master Epic Context
**Master Epic**: ${masterEpic.title} (${masterEpic.id})
**Your Sub-Epic**: ${epic.id} (${repoType})
${otherRepos.length > 0 ? `**Other Teams**: ${otherRepos.join(', ')}` : ''}

### Naming Conventions (MANDATORY)
${Object.entries(namingConventions).map(([key, value]) => `- ${key}: ${value}`).join('\n')}

### Shared Contracts
${sharedContracts.apiEndpoints?.length > 0 ? `APIs: ${sharedContracts.apiEndpoints.map((api: any) => `${api.method} ${api.path}`).join(', ')}` : ''}
${sharedContracts.sharedTypes?.length > 0 ? `Types: ${sharedContracts.sharedTypes.map((t: any) => t.name).join(', ')}` : ''}

**CRITICAL**: Use exact field names and API signatures from contracts above.
`;
    }

    return `TECH LEAD - MULTI-TEAM MODE
${masterEpicContext}

## Epic: ${epic.id} - ${epic.title}
**Complexity**: ${epic.estimatedComplexity}
**Target**: ${targetRepo} (${repoType})
**Branch**: ${branchName || `epic/${epic.id}`}

## Workspace: ${workspacePath}/${targetRepo}
${repoInfo}

## INSTRUCTIONS:
1. EXPLORE codebase (max 2 min): cd ${workspacePath}/${targetRepo} && find src
2. BREAK INTO 2-5 STORIES (each 1-3 hours work)
3. ASSIGN DEVELOPERS (1 dev per story)

## JSON OUTPUT ONLY:
\`\`\`json
{
  "epics": [{
    "id": "${epic.id}",
    "name": "${epic.title}",
    "description": "Architecture",
    "branchName": "${branchName || `epic/${epic.id}`}",
    "targetRepository": "${targetRepo}",
    "stories": [
      {
        "id": "${epic.id}-story-1",
        "title": "Story title",
        "description": "Complete with: Acceptance Criteria, Files, Functions/APIs, Tests, Done criteria",
        "epicId": "${epic.id}",
        "priority": 1,
        "estimatedComplexity": "simple|moderate|complex",
        "dependencies": [],
        "status": "pending",
        "filesToRead": ["real/path.ts"],
        "filesToModify": ["real/path2.ts"],
        "filesToCreate": ["real/new.ts"]
      }
    ],
    "status": "pending"
  }],
  "architectureDesign": "Technical design",
  "teamComposition": {"developers": 2, "reasoning": "Why"},
  "storyAssignments": [
    {"storyId": "${epic.id}-story-1", "assignedTo": "dev-1"}
  ]
}
\`\`\`

Team size: ${epic.estimatedComplexity === 'simple' ? '1-2' : epic.estimatedComplexity === 'moderate' ? '2-3' : epic.estimatedComplexity === 'complex' ? '3-4' : '4-5'} developers

Explore first, then output JSON.`;
  }
}
