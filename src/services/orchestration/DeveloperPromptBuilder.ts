/**
 * DeveloperPromptBuilder
 *
 * Extracted prompt building logic from executeDeveloper to reduce complexity.
 * This builder creates the detailed prompt for developer agents.
 */

import { NotificationService } from '../NotificationService';

export interface DeveloperPromptContext {
  story: any;
  targetRepository: string;
  repoName: string;
  workspacePath: string;
  projectId: string;
  taskId: string;
  memberId: string;
  directivesBlock: string;
  branchName: string;
  judgeFeedback?: string;
  devAuth?: any;
  architectureBrief?: any;
  projectRadiography?: any;
  environmentCommands?: any;
}

export class DeveloperPromptBuilder {
  /**
   * Build the complete developer prompt
   */
  static async build(ctx: DeveloperPromptContext): Promise<string> {
    const parts: string[] = [];

    // 1. Header with philosophy
    parts.push(this.buildHeader(ctx));

    // 2. Story details
    parts.push(this.buildStorySection(ctx));

    // 3. File analysis (if files specified)
    const fileAnalysis = await this.buildFileAnalysisSection(ctx);
    if (fileAnalysis) parts.push(fileAnalysis);

    // 4. Target repository
    parts.push(this.buildTargetSection(ctx));

    // 5. Memory context
    parts.push(this.buildMemorySection(ctx));

    // 6. Architecture brief (if provided)
    if (ctx.architectureBrief) {
      parts.push(this.buildArchitectureSection(ctx));
    }

    // 7. Project radiography (if provided)
    if (ctx.projectRadiography) {
      parts.push(await this.buildRadiographySection(ctx));
    }

    // 8. Judge feedback (if retry)
    if (ctx.judgeFeedback) {
      parts.push(this.buildJudgeFeedbackSection(ctx));
    }

    // 9. DevAuth section
    parts.push(this.buildDevAuthSection(ctx));

    // 10. Environment verification commands (if provided)
    if (ctx.environmentCommands) {
      parts.push(this.buildVerificationSection(ctx));
    }

    // 11. Files to work with
    parts.push(this.buildFilesSection(ctx));

    // 12. Iterative workflow
    parts.push(this.buildWorkflowSection(ctx));

    // 13. Git workflow (mandatory)
    parts.push(this.buildGitWorkflowSection(ctx));

    return parts.join('\n\n');
  }

  private static buildHeader(ctx: DeveloperPromptContext): string {
    return `${ctx.directivesBlock}
# 🚀 DEVELOPER AGENT - IMPLEMENTATION MODE

## 💡 YOUR PHILOSOPHY: BE A DOER, NOT A TALKER

**You are an IMPLEMENTER, not a planner.** Your job is to WRITE CODE, not describe what code you would write.

### ⚡ GOLDEN RULES:
1. **USE TOOLS IMMEDIATELY** - Don't describe, DO
   - ❌ WRONG: "I would read the file to understand..."
   - ✅ RIGHT: \`Read("src/services/UserService.ts")\` → then analyze

2. **READ BEFORE WRITE** - SDK requires this
   - ❌ WRONG: \`Edit("file.ts", "old", "new")\` without reading first
   - ✅ RIGHT: \`Read("file.ts")\` → then \`Edit("file.ts", "old", "new")\`

3. **🐳 USE SANDBOX FOR BUILD/TEST/RUN** - Execute in Docker environment!
   - ❌ WRONG: \`Bash("flutter build")\` → fails because Flutter not on host
   - ✅ RIGHT: \`sandbox_bash(command="flutter build")\` → runs in Docker with Flutter
   - **ALL build/test/run commands MUST use \`sandbox_bash\`**:
     - \`sandbox_bash(command="flutter pub get")\`
     - \`sandbox_bash(command="flutter build apk")\`
     - \`sandbox_bash(command="npm install")\`
     - \`sandbox_bash(command="npm run build")\`
     - \`sandbox_bash(command="npm test")\`
     - \`sandbox_bash(command="dart analyze")\`
   - **Use regular \`Bash\` ONLY for git commands** (git add, git commit, git push)

4. **COMMIT AND PUSH INCREMENTALLY** - Push after EACH file write!
   - ❌ WRONG: Writing 5 files, then one big commit at the end
   - ✅ RIGHT: Write file → Commit → Push → Write next file → Commit → Push
   - **WHY**: If you crash mid-way, unpushed work is LOST forever

5. **🚨 PUSH FREQUENCY RULE** - At minimum, push after every 2-3 file changes
   - After creating/modifying each component → commit + push
   - **NEVER** accumulate more than 3 uncommitted files

6. **ONE STORY, COMPLETE IMPLEMENTATION** - You own this story end-to-end`;
  }

  private static buildStorySection(ctx: DeveloperPromptContext): string {
    const { story } = ctx;
    const criteria = story.acceptanceCriteria || [];
    const helpers = story.mustUseHelpers || [];
    const antiPatterns = story.antiPatterns || [];
    const examples = story.codeExamples || [];

    let section = `# Story: ${story.title}

${story.description}`;

    if (criteria.length > 0) {
      section += `\n\n## ✅ ACCEPTANCE CRITERIA (ALL MUST BE MET!)
${criteria.map((ac: string, i: number) => `${i + 1}. ${ac}`).join('\n')}

**⚠️ Your PR will be REJECTED if any criterion is not met.**`;
    }

    if (helpers.length > 0) {
      section += `\n\n## 🔧 REQUIRED HELPERS (YOU MUST USE THESE!)
${helpers.map((h: any) => `- **\`${h.function}()\`** from \`${h.from}\` - ${h.reason}`).join('\n')}`;
    }

    if (antiPatterns.length > 0) {
      section += `\n\n## ❌ ANTI-PATTERNS (DO NOT DO THIS!)
${antiPatterns.map((ap: any) => `- ❌ BAD: \`${ap.bad}\` → ✅ GOOD: \`${ap.good}\``).join('\n')}`;
    }

    if (examples.length > 0) {
      section += `\n\n## 📝 CODE EXAMPLES
${examples.map((ex: any) => `### ${ex.description}\n\`\`\`typescript\n${ex.code}\n\`\`\``).join('\n\n')}`;
    }

    return section;
  }

  private static async buildFileAnalysisSection(ctx: DeveloperPromptContext): Promise<string | null> {
    const filesToModify = ctx.story.filesToModify || [];
    const filesToCreate = ctx.story.filesToCreate || [];

    if (filesToModify.length === 0 && filesToCreate.length === 0) {
      return null;
    }

    try {
      const { SmartCodeAnalyzer } = await import('../SmartCodeAnalyzer');
      const targetFiles = [...filesToModify, ...filesToCreate];
      const suggestions = SmartCodeAnalyzer.getSuggestedReads(targetFiles, ctx.workspacePath, 8);

      if (suggestions.length === 0) return null;

      return `## 📊 SMART FILE ANALYSIS

Before making changes, understand these file relationships:

| File | Why Read This |
|------|---------------|
${suggestions.map(s => `| \`${s.file}\` | ${s.reason} |`).join('\n')}

**Read these files first** to understand the existing patterns.`;
    } catch {
      return null;
    }
  }

  private static buildTargetSection(ctx: DeveloperPromptContext): string {
    return `## 🎯 TARGET REPOSITORY: ${ctx.targetRepository}
**CRITICAL**: You MUST work ONLY in the "${ctx.targetRepository}" directory.
- All file paths must start with: ${ctx.targetRepository}/
- Navigate to this repository first: cd ${ctx.workspacePath}/${ctx.targetRepository}
- DO NOT modify files in other repositories`;
  }

  private static buildMemorySection(ctx: DeveloperPromptContext): string {
    return `## 🧠 MEMORY CONTEXT
- **Project ID**: \`${ctx.projectId}\`
- **Task ID**: \`${ctx.taskId}\`
- **Story ID**: \`${ctx.story.id}\``;
  }

  private static buildArchitectureSection(ctx: DeveloperPromptContext): string {
    const brief = ctx.architectureBrief;
    let section = `## 🏗️ ARCHITECTURE BRIEF (CRITICAL - Follow These Patterns!)

**This project has established patterns. You MUST follow them.**`;

    if (brief.codePatterns) {
      section += `\n\n### Code Patterns
- **Naming**: ${brief.codePatterns.namingConvention || 'Not specified'}
- **File Structure**: ${brief.codePatterns.fileStructure || 'Not specified'}
- **Error Handling**: ${brief.codePatterns.errorHandling || 'Not specified'}`;
    }

    if (brief.helperFunctions?.length > 0) {
      section += `\n\n### 🔧 MANDATORY HELPER FUNCTIONS
| Function | File | Usage |
|----------|------|-------|
${brief.helperFunctions.map((h: any) => `| \`${h.name}()\` | ${h.file} | ${h.usage} |`).join('\n')}

**🚨 You MUST use these helpers. DO NOT create entities manually!**`;
    }

    if (brief.entityCreationRules?.length > 0) {
      section += `\n\n### 📋 ENTITY CREATION RULES
| Entity | MUST Use | NEVER Use |
|--------|----------|-----------|
${brief.entityCreationRules.map((r: any) => `| ${r.entity} | \`${r.mustUse}\` | \`${r.mustNotUse}\` |`).join('\n')}

**🔴 FAILURE TO FOLLOW = AUTOMATIC REJECTION**`;
    }

    return section;
  }

  private static async buildRadiographySection(ctx: DeveloperPromptContext): Promise<string> {
    try {
      const { ProjectRadiographyService } = await import('../ProjectRadiographyService');
      return `## 🔬 PROJECT RADIOGRAPHY (${ctx.repoName})

${ProjectRadiographyService.formatForPrompt(ctx.projectRadiography)}`;
    } catch {
      return '';
    }
  }

  private static buildJudgeFeedbackSection(ctx: DeveloperPromptContext): string {
    return `## 🔄 JUDGE REJECTED YOUR PREVIOUS CODE - RETRY REQUIRED

### Judge Feedback:
${ctx.judgeFeedback}

### What You MUST Do:
1. Read the files you modified to see your previous code
2. Fix ONLY the issues mentioned
3. Commit and push to the CURRENT branch

### ⚠️ BRANCH RULES FOR RETRY:
- You are ALREADY on the correct branch: ${ctx.story.branchName || 'your story branch'}
- **DO NOT create a new branch**
- Simply make your changes, commit, and push

**This is a RETRY. Focus on fixing what was rejected.**`;
  }

  private static buildDevAuthSection(ctx: DeveloperPromptContext): string {
    const devAuth = ctx.devAuth;

    if (!devAuth || devAuth.method === 'none') {
      NotificationService.emitConsoleLog(
        ctx.taskId,
        'warn',
        `⚠️ [Developer ${ctx.memberId}] DevAuth NOT configured - 401 errors expected`
      );

      return `## ⚠️ NO API AUTHENTICATION CONFIGURED

**Status**: ❌ NOT CONFIGURED

- If you access protected endpoints → expect **401 Unauthorized**
- **DO NOT** let 401 errors block your work
- Write the code correctly, auth testing will happen later`;
    }

    NotificationService.emitConsoleLog(
      ctx.taskId,
      'info',
      `🔐 [Developer ${ctx.memberId}] DevAuth: method=${devAuth.method}`
    );

    let section = `## 🔐 API AUTHENTICATION
**Method**: ${devAuth.method}
**Status**: ✅ CONFIGURED`;

    if (devAuth.method === 'token') {
      section += `
**Token**: \`${devAuth.token}\`
**Header**: ${devAuth.tokenHeader || 'Authorization'}
**Prefix**: "${devAuth.tokenPrefix || 'Bearer '}"

\`\`\`bash
curl -H "${devAuth.tokenHeader || 'Authorization'}: ${devAuth.tokenPrefix || 'Bearer '}${devAuth.token}" http://localhost:PORT/api/endpoint
\`\`\``;
    } else if (devAuth.method === 'credentials') {
      section += `
**Login**: ${devAuth.loginEndpoint}
**Username**: ${devAuth.credentials?.username}

\`\`\`bash
TOKEN=$(curl -s -X POST ${devAuth.loginEndpoint} -d '{"username":"${devAuth.credentials?.username}","password":"***"}' | jq -r '.${devAuth.tokenResponsePath || 'token'}')
curl -H "Authorization: Bearer $TOKEN" http://localhost:PORT/api/endpoint
\`\`\``;
    }

    section += `\n\n⚠️ **DELETE method is ALWAYS FORBIDDEN**`;
    return section;
  }

  private static buildVerificationSection(ctx: DeveloperPromptContext): string {
    const env = ctx.environmentCommands;
    const markers: string[] = ['✅ ENVIRONMENT_READY (after setup commands succeed)'];
    const verificationSteps: string[] = [];

    // Typecheck
    if (env.typecheck && env.typecheck !== 'N/A') {
      markers.push('✅ TYPECHECK_PASSED');
      verificationSteps.push(`1. **Typecheck**: \`${env.typecheck}\` → Output: ✅ TYPECHECK_PASSED`);
    } else {
      verificationSteps.push(`1. **Typecheck**: ⚠️ NOT CONFIGURED - skip this marker`);
    }

    // Tests
    if (env.test && env.test !== 'N/A' && env.test !== 'npm run build') {
      markers.push('✅ TESTS_PASSED');
      verificationSteps.push(`2. **Tests**: \`${env.test}\` → Output: ✅ TESTS_PASSED`);
    } else {
      verificationSteps.push(`2. **Tests**: ⚠️ NOT CONFIGURED - skip this marker`);
    }

    // Lint
    if (env.lint && env.lint !== 'N/A') {
      markers.push('✅ LINT_PASSED');
      verificationSteps.push(`3. **Lint**: \`${env.lint}\` → Output: ✅ LINT_PASSED`);
    } else {
      verificationSteps.push(`3. **Lint**: ⚠️ NOT CONFIGURED - skip this marker`);
    }

    // Build
    if (env.build) {
      verificationSteps.push(`4. **Build**: \`${env.build}\` (verify build passes)`);
    }

    markers.push('✅ EXHAUSTIVE_VERIFICATION_PASSED (all verification loops complete)');
    markers.push('📍 Commit SHA: [40-character SHA]');
    markers.push('✅ DEVELOPER_FINISHED_SUCCESSFULLY');

    return `## 🔧 PROJECT-SPECIFIC VERIFICATION

**⚠️ This project has CUSTOM verification commands from TechLead.**

### Verification Commands:
${verificationSteps.join('\n')}

### Required Markers:
${markers.map((m, i) => `${i}. ${m}`).join('\n')}

### Workflow:
1. Run available verification commands
2. Output the corresponding marker ONLY if the command exists
3. If a command is "NOT CONFIGURED", skip that marker
4. Always end with ✅ DEVELOPER_FINISHED_SUCCESSFULLY`;
  }

  private static buildFilesSection(ctx: DeveloperPromptContext): string {
    const { story, targetRepository } = ctx;
    const prefixPath = (f: string) => `${targetRepository}/${f}`;

    return `## Files to work with:

**Read these files first** (understand existing code):
${story.filesToRead?.length > 0 ? story.filesToRead.map((f: string) => `- ${prefixPath(f)}`).join('\n') : '- (explore as needed)'}

**Modify these existing files**:
${story.filesToModify?.length > 0 ? story.filesToModify.map((f: string) => `- ${prefixPath(f)}`).join('\n') : '- (none specified)'}

**Create these new files**:
${story.filesToCreate?.length > 0 ? story.filesToCreate.map((f: string) => `- ${prefixPath(f)}`).join('\n') : '- (none specified)'}

## Working directory:
You are in: ${ctx.workspacePath}
Target repository: ${targetRepository}/

All file paths must be prefixed with: ${targetRepository}/`;
  }

  private static buildWorkflowSection(ctx: DeveloperPromptContext): string {
    const { targetRepository } = ctx;

    return `## 🔄 ITERATIVE DEVELOPMENT WORKFLOW (CLAUDE CODE STYLE)

**You MUST follow this exact pattern for EVERY file:**

\`\`\`
┌───────────────────────────────────────────────────────────┐
│  1. READ file completely                                   │
│  2. EDIT with your changes                                 │
│  3. VERIFY: npx tsc --noEmit                               │
│  4. If ERROR → FIX NOW, then verify                        │
│  5. If CLEAN → COMMIT + PUSH immediately!                  │
│  6. 🚨 PUSH after EVERY 2-3 files (never accumulate more!) │
└───────────────────────────────────────────────────────────┘
\`\`\`

**🚨 INCREMENTAL PUSH PATTERN (MANDATORY!):**
After creating/modifying 2-3 files:
\`\`\`bash
git add <files> && git commit -m "feat(story): add X component" && git push
\`\`\`
**WHY?** If you crash or timeout mid-story, ALL unpushed work is LOST!

**🚨 CRITICAL: After EVERY Edit(), run verification:**
\`\`\`bash
cd ${targetRepository} && npx tsc --noEmit 2>&1 | head -20
\`\`\`

**If you see an error:**
1. READ the error message (file:line)
2. FIX the issue IMMEDIATELY (don't continue)
3. VERIFY again
4. Only proceed when clean

**DO NOT:**
- Skip verification after edits
- Continue to next file with errors
- Use @ts-ignore or // @ts-expect-error
- Commit code that doesn't compile

## 🔧 INLINE ERROR RECOVERY

| Error Pattern | Fix |
|--------------|-----|
| \`Cannot find module 'X'\` | Add import: \`import { X } from './path'\` |
| \`Property 'X' does not exist\` | Check interface or use \`obj?.X\` |
| \`Type 'X' not assignable to 'Y'\` | Cast: \`value as Type\` or fix source |
| \`'X' is declared but never used\` | Remove or prefix with \`_\` |
| \`Object is possibly undefined\` | Add null check: \`if (x) { }\` |

## 🔍 ADAPTIVE EXPLORATION

**When unsure, EXPLORE first - don't guess!**

| Need | Search |
|------|--------|
| Find a file | \`Glob("**/FileName.ts")\` |
| Find a function | \`Grep("function funcName", path="src")\` |
| Find a type | \`Grep("interface TypeName", path="src")\` |
| Find usage | \`Grep("funcName(", path="src")\` |
| Find tests | \`Glob("**/*.test.ts")\` |`;
  }

  private static buildGitWorkflowSection(ctx: DeveloperPromptContext): string {
    const { story, branchName } = ctx;

    return `## Your task:
${ctx.judgeFeedback ? 'Fix the code based on Judge feedback above.' : 'Implement this story completely with production-ready code.'}

## 🚨 MANDATORY: Git workflow (MUST DO):
⚠️ **You are already on branch: ${branchName}** (branch was created for you)

After writing code, you MUST follow this EXACT sequence:
1. cd ${ctx.targetRepository}
2. git add .
3. git commit -m "Implement: ${story.title}"
4. git push origin ${branchName}
5. **MANDATORY: Print commit SHA**:
   \`\`\`bash
   git rev-parse HEAD
   \`\`\`
   Then output: 📍 Commit SHA: <the-40-character-sha>

6. **MANDATORY: Verify push succeeded**:
   \`\`\`bash
   git ls-remote origin ${branchName}
   \`\`\`
   Check that output shows your commit SHA

7. **MANDATORY: Print SUCCESS marker**:
   Output exactly this line:
   ✅ DEVELOPER_FINISHED_SUCCESSFULLY

**CRITICAL RULES:**
- You MUST see "✅ DEVELOPER_FINISHED_SUCCESSFULLY" in your output
- Judge will ONLY review if you print this success marker
- If git push fails, retry it until it succeeds
- If you cannot push, print "❌ DEVELOPER_FAILED" and explain why`;
  }
}
