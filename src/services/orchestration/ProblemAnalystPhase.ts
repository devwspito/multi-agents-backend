import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';

/**
 * Problem Analyst Phase
 *
 * Deep problem understanding and solution architecture.
 * Executes BEFORE Product Manager to provide rich context.
 *
 * Responsibilities:
 * 1. Analyze the root problem (not just the surface request)
 * 2. Identify stakeholders and their needs
 * 3. Define clear success criteria
 * 4. Anticipate edge cases and failure modes
 * 5. Suggest high-level architecture approach
 * 6. Identify technical risks and constraints
 *
 * Output feeds into Product Manager for better epic/story creation.
 */
export class ProblemAnalystPhase extends BasePhase {
  readonly name = 'ProblemAnalyst';
  readonly description = 'Deep problem analysis and solution architecture';

  constructor(private executeAgentFn: Function) {
    super();
  }

  /**
   * Skip if Problem Analyst already completed (ONLY for recovery, NOT for continuations)
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
      console.log(`🔄 [ProblemAnalyst] This is a CONTINUATION - will re-execute with additional requirements`);
      return false; // DO NOT SKIP
    }

    // 🛠️ RECOVERY: Skip if already completed (orchestration interrupted and restarting)
    if (context.task.orchestration?.problemAnalyst?.status === 'completed') {
      console.log(`[SKIP] Problem Analyst already completed - skipping re-execution (recovery mode)`);

      // Restore previous analysis to context
      if (context.task.orchestration.problemAnalyst.analysis) {
        context.setData('problemAnalysis', context.task.orchestration.problemAnalyst.analysis);
      }
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
    const repositories = context.repositories;

    console.log(`\n🧠 [ProblemAnalyst] Starting deep problem analysis`);
    console.log(`   Task: ${task.title}`);
    console.log(`   Description: ${task.description?.substring(0, 200)}...`);

    // Initialize phase state
    if (!task.orchestration.problemAnalyst) {
      task.orchestration.problemAnalyst = {
        agent: 'problem-analyst',
        status: 'pending',
      } as any;
    }

    task.orchestration.problemAnalyst!.status = 'in_progress';
    task.orchestration.problemAnalyst!.startedAt = new Date();
    await task.save();

    NotificationService.emitAgentStarted(taskId, 'Problem Analyst');
    NotificationService.emitConsoleLog(
      taskId,
      'info',
      '🧠 Problem Analyst: Analyzing the root problem and designing solution approach...'
    );

    await LogService.agentStarted('problem-analyst', taskId, {
      phase: 'analysis',
      metadata: {
        taskTitle: task.title,
        hasAttachments: task.attachments ? task.attachments.length > 0 : false,
        repositoryCount: repositories.length,
      },
    });

    try {
      // Previous analysis for continuations - ALWAYS include if exists
      const previousOutput = task.orchestration.problemAnalyst?.output;

      let previousAnalysisSection = '';
      if (previousOutput) {
        previousAnalysisSection = `

# Previous Problem Analysis Available
Your previous problem analysis is available for reference. Use it to build upon your previous understanding:
\`\`\`
${previousOutput}
\`\`\`

**IMPORTANT**: In continuations, build upon this previous analysis. Consider:
- What was already analyzed and implemented
- How the new requirements relate to the previous problem
- Whether the solution approach needs to evolve
- New risks or considerations based on previous work
`;
      }

      // Build comprehensive prompt for deep analysis
      const attachmentsInfo = task.attachments && task.attachments.length > 0
        ? `\nAttachments: ${task.attachments.length} image(s) provided for context`
        : '';

      const prompt = `You are a Problem Analyst - your role is to deeply understand the problem before any implementation begins.
${previousAnalysisSection}
# Task Request
Title: ${task.title}
Description: ${task.description || 'No description provided'}
${attachmentsInfo}

# Selected Repositories
${repositories.map((repo: any) => `- ${repo.githubRepoName} (${repo.type || 'unknown'})`).join('\n')}

# Your Mission
Provide a comprehensive problem analysis that will guide the entire development process.

# Required Analysis Structure

## 1. Problem Statement
- What is the REAL problem being solved? (not just what was asked)
- Who are the stakeholders affected?
- What is the current pain point or limitation?

## 2. Success Criteria
- How will we measure if this solution is successful?
- What are the acceptance criteria?
- What are the key performance indicators?

## 3. User Stories & Scenarios
- Primary use case (happy path)
- Edge cases to consider
- Failure scenarios and error handling needs

## 4. Technical Analysis
- Affected components/services
- Data flow implications
- Performance considerations
- Security considerations
- Scalability implications

## 5. Solution Architecture
- High-level approach recommendation
- Design patterns that should be used
- Component interactions
- API changes needed (if any)

## 6. Risks & Mitigations
- Technical risks
- Implementation complexity areas
- Potential breaking changes
- Mitigation strategies

## 7. Implementation Strategy
- Suggested phasing/milestones
- Dependencies between components
- Testing strategy recommendation
- Rollback plan if needed

## 8. Constraints & Assumptions
- Technical constraints
- Time/resource constraints
- Assumptions being made

# Output Format
Provide your analysis in a clear, structured format that the Product Manager can use to create better epics and stories.
Focus on clarity and actionable insights.

IMPORTANT: This analysis will be used by the Product Manager to create technical stories, so be specific about technical requirements and architecture decisions.`;

      // Get attachments from context (shared from task creation)
      const attachments = context.getData<any[]>('attachments') || [];
      if (attachments.length > 0) {
        console.log(`📎 [ProblemAnalyst] Using ${attachments.length} attachment(s) for analysis`);
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `📎 Problem Analyst: Analyzing ${attachments.length} image(s) to understand visual context...`
        );
      }

      // Execute analysis
      const result = await this.executeAgentFn(
        'problem-analyst',
        prompt,
        workspacePath || process.cwd(),
        taskId,
        'Problem Analyst',
        undefined, // sessionId
        undefined, // fork
        attachments.length > 0 ? attachments : undefined
      );

      console.log(`✅ [ProblemAnalyst] Analysis complete`);

      // Parse and structure the analysis
      const analysis = this.parseAnalysisOutput(result.output || '');

      // Store analysis in context for Product Manager
      context.setData('problemAnalysis', analysis);
      context.setData('problemAnalysisRaw', result.output);

      // Update task
      task.orchestration.problemAnalyst!.status = 'completed';
      task.orchestration.problemAnalyst!.completedAt = new Date();
      task.orchestration.problemAnalyst!.output = result.output;
      task.orchestration.problemAnalyst!.analysis = analysis;
      task.orchestration.problemAnalyst!.sessionId = result.sessionId;
      task.orchestration.problemAnalyst!.usage = result.usage;
      task.orchestration.problemAnalyst!.cost_usd = result.cost;

      // Update costs
      task.orchestration.totalCost += result.cost;
      task.orchestration.totalTokens +=
        (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);

      await task.save();

      // Emit full output to console
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `\n${'='.repeat(80)}\n🧠 PROBLEM ANALYST - FULL ANALYSIS\n${'='.repeat(80)}\n\n${result.output || '(no output)'}\n\n${'='.repeat(80)}`
      );

      // Send summary to chat
      const summary = `🧠 Problem Analysis Complete:
• Problem: ${analysis.problemStatement?.substring(0, 150)}...
• Solution: ${analysis.solutionApproach?.substring(0, 150)}...
• Risks Identified: ${analysis.risks?.length || 0}
• Success Criteria: ${analysis.successCriteria?.length || 0}`;

      NotificationService.emitAgentMessage(taskId, 'Problem Analyst', summary);
      NotificationService.emitAgentCompleted(taskId, 'Problem Analyst', 'Deep analysis complete');

      await LogService.agentCompleted('problem-analyst', taskId, {
        phase: 'analysis',
        metadata: {
          hasRisks: analysis.risks?.length > 0,
          hasSuccessCriteria: analysis.successCriteria?.length > 0,
          hasTechnicalAnalysis: !!analysis.technicalAnalysis,
        },
      });

      return {
        success: true,
        data: {
          analysis,
          output: result.output,
        },
        metrics: {
          cost_usd: result.cost,
          input_tokens: result.usage?.input_tokens || 0,
          output_tokens: result.usage?.output_tokens || 0,
        },
      };

    } catch (error: any) {
      console.error(`❌ [ProblemAnalyst] Failed: ${error.message}`);

      task.orchestration.problemAnalyst!.status = 'failed';
      task.orchestration.problemAnalyst!.completedAt = new Date();
      task.orchestration.problemAnalyst!.error = error.message;
      await task.save();

      NotificationService.emitAgentFailed(taskId, 'Problem Analyst', error.message);

      await LogService.agentFailed('problem-analyst', taskId, error, {
        phase: 'analysis',
      });

      // Don't fail the entire orchestration - let PM work without deep analysis
      return {
        success: true, // Continue to PM even if analysis fails
        warnings: [`Problem analysis failed: ${error.message}. Proceeding with basic requirements.`],
        data: {
          analysis: null,
          error: error.message,
        },
      };
    }
  }

  /**
   * Parse the analysis output into structured data
   */
  private parseAnalysisOutput(output: string): any {
    const analysis: any = {
      problemStatement: '',
      successCriteria: [],
      userStories: [],
      technicalAnalysis: '',
      solutionApproach: '',
      risks: [],
      implementationStrategy: '',
      constraints: [],
    };

    try {
      // Extract sections using regex patterns
      const sections = {
        problemStatement: /##?\s*1\.\s*Problem Statement([\s\S]*?)(?=##?\s*2\.|$)/i,
        successCriteria: /##?\s*2\.\s*Success Criteria([\s\S]*?)(?=##?\s*3\.|$)/i,
        userStories: /##?\s*3\.\s*User Stories([\s\S]*?)(?=##?\s*4\.|$)/i,
        technicalAnalysis: /##?\s*4\.\s*Technical Analysis([\s\S]*?)(?=##?\s*5\.|$)/i,
        solutionArchitecture: /##?\s*5\.\s*Solution Architecture([\s\S]*?)(?=##?\s*6\.|$)/i,
        risks: /##?\s*6\.\s*Risks([\s\S]*?)(?=##?\s*7\.|$)/i,
        implementation: /##?\s*7\.\s*Implementation Strategy([\s\S]*?)(?=##?\s*8\.|$)/i,
        constraints: /##?\s*8\.\s*Constraints([\s\S]*?)(?=$)/i,
      };

      // Extract problem statement
      const problemMatch = output.match(sections.problemStatement);
      if (problemMatch) {
        analysis.problemStatement = problemMatch[1].trim();
      }

      // Extract success criteria (as array)
      const successMatch = output.match(sections.successCriteria);
      if (successMatch) {
        const criteria = successMatch[1].split(/\n-\s+/).filter(s => s.trim());
        analysis.successCriteria = criteria.map(c => c.trim());
      }

      // Extract user stories
      const storiesMatch = output.match(sections.userStories);
      if (storiesMatch) {
        const stories = storiesMatch[1].split(/\n-\s+/).filter(s => s.trim());
        analysis.userStories = stories.map(s => s.trim());
      }

      // Extract technical analysis
      const techMatch = output.match(sections.technicalAnalysis);
      if (techMatch) {
        analysis.technicalAnalysis = techMatch[1].trim();
      }

      // Extract solution approach
      const solutionMatch = output.match(sections.solutionArchitecture);
      if (solutionMatch) {
        analysis.solutionApproach = solutionMatch[1].trim();
      }

      // Extract risks
      const risksMatch = output.match(sections.risks);
      if (risksMatch) {
        const risks = risksMatch[1].split(/\n-\s+/).filter(r => r.trim());
        analysis.risks = risks.map(r => r.trim());
      }

      // Extract implementation strategy
      const implMatch = output.match(sections.implementation);
      if (implMatch) {
        analysis.implementationStrategy = implMatch[1].trim();
      }

      // Extract constraints
      const constraintsMatch = output.match(sections.constraints);
      if (constraintsMatch) {
        const constraints = constraintsMatch[1].split(/\n-\s+/).filter(c => c.trim());
        analysis.constraints = constraints.map(c => c.trim());
      }

      // If we couldn't parse structured data, use the full output
      if (!analysis.problemStatement && !analysis.solutionApproach) {
        analysis.problemStatement = output.substring(0, 500);
        analysis.rawAnalysis = output;
      }

    } catch (error) {
      console.warn(`⚠️ [ProblemAnalyst] Could not parse structured analysis, using raw output`);
      analysis.rawAnalysis = output;
    }

    return analysis;
  }
}