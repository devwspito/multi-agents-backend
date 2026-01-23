/**
 * Reusable Prompt Sections
 *
 * Modular prompt components shared across multiple agents (TechLead, Developer, Judge).
 * Inspired by AITMPL pattern but native TypeScript implementation.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// 📋 STRUCTURED SPECIFICATION FORMAT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Structured Epic Specification - Forces complete context
 * Based on BrainGrid's specify pattern
 */
export interface StructuredEpicSpec {
  /** What problem does this epic solve? */
  problem: string;
  /** Technical/business background context */
  context: string;
  /** Limitations (time, tech stack, dependencies) */
  constraints: string[];
  /** How do we know it's done? Measurable criteria */
  successCriteria: string[];
  /** What is explicitly OUT of scope? */
  nonGoals?: string[];
}

/**
 * Format StructuredEpicSpec for prompt inclusion
 */
export function formatStructuredSpec(spec: StructuredEpicSpec): string {
  return `
## 📋 STRUCTURED SPECIFICATION

### Problem Statement
${spec.problem}

### Context
${spec.context}

### Constraints
${spec.constraints.map(c => `- ${c}`).join('\n')}

### Success Criteria (Definition of Done)
${spec.successCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

${spec.nonGoals?.length ? `### Non-Goals (Out of Scope)
${spec.nonGoals.map(n => `- ❌ ${n}`).join('\n')}` : ''}
`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🔒 SCOPE BOUNDARY RULES (used by TechLead, Developer, Judge)
// ═══════════════════════════════════════════════════════════════════════════════

export const SCOPE_BOUNDARY_SECTION = `
## 🔒 SCOPE BOUNDARY RULES

### For TechLead:
- Stories MUST define: \`filesToRead\`, \`filesToModify\`, \`filesToCreate\`
- Each story can ONLY touch files explicitly listed
- If a story needs a file from another epic → use STUB import pattern

### For Developer:
- You can ONLY modify files in \`filesToModify\`
- You can ONLY create files in \`filesToCreate\`
- If you need something from another epic that doesn't exist yet:
  \`\`\`typescript
  // STUB: This will be implemented by epic-auth
  // import { AuthService } from '../auth/AuthService';
  const AuthService = { login: async () => ({ success: true }) }; // Stub
  \`\`\`

### For Judge:
- Compare files touched vs files allowed in story spec
- AUTO-REJECT if developer modifies files outside scope
- Exception: package.json, pubspec.yaml (dependency files)
`;

// ═══════════════════════════════════════════════════════════════════════════════
// 🚫 PLACEHOLDER CODE DETECTION (used by Developer, Judge)
// ═══════════════════════════════════════════════════════════════════════════════

export const NO_PLACEHOLDERS_SECTION = `
## 🚫 NO PLACEHOLDER CODE

### Forbidden Patterns:
- "Coming Soon", "TODO:", "WIP", "Placeholder", "Not implemented"
- Empty functions/methods with just \`pass\` or \`return null\`
- Widgets named \`_PlaceholderScreen\`, \`_PlaceholderWidget\`
- Buttons without \`onPressed\` handlers
- Forms without validation logic
- API calls that return hardcoded mock data

### Required Instead:
- REAL functional code that compiles and runs
- Actual UI elements (TextFields, Buttons with handlers)
- Working API integration (even if using test endpoints)
- Error handling (try/catch, error states)

### Judge Auto-Reject Triggers:
\`\`\`
❌ "Coming Soon" in any string
❌ // TODO: implement later
❌ Container() with no children
❌ onPressed: null
❌ return MockData()
\`\`\`
`;

// ═══════════════════════════════════════════════════════════════════════════════
// 📦 STORY DECOMPOSITION METHODOLOGY (used by TechLead)
// ═══════════════════════════════════════════════════════════════════════════════

export const DECOMPOSITION_METHODOLOGY_SECTION = `
## 📦 STORY DECOMPOSITION METHODOLOGY

### Atomicity Criteria (Each story MUST be):
| Criteria | Requirement | Example |
|----------|-------------|---------|
| **Single Responsibility** | One logical change | ✅ "Add login endpoint" NOT "Add auth system" |
| **Testable in Isolation** | Can be verified standalone | ✅ Unit test can mock dependencies |
| **Deliverable** | Compiles and runs after completion | ✅ No broken imports |
| **Max ~50 lines changed** | Focused scope | ✅ One file or small set |

### Dependency Analysis:
- **Parallel**: Stories with \`dependencies: []\` run simultaneously
- **Sequential**: Stories with deps MUST wait

### Granularity Guidelines:
| Complexity | Max Files | Typical Tasks |
|------------|-----------|---------------|
| **Simple** | 1-2 files | Add field, fix bug, validation |
| **Moderate** | 2-4 files | New endpoint, component, service |
| **Complex** | 4-6 files | Multi-layer feature |

### Risk Markers:
Add \`"hasRisk": true\` if story involves:
- Authentication/authorization
- Database schema changes
- External API integration
- Unclear requirements
`;

// ═══════════════════════════════════════════════════════════════════════════════
// 🔧 CONFLICT RESOLUTION METHODOLOGY (used by ConflictResolver)
// ═══════════════════════════════════════════════════════════════════════════════

export const CONFLICT_RESOLUTION_SECTION = `
## 🔧 CONFLICT RESOLUTION METHODOLOGY

### Resolution Strategy (Priority Order):
| Priority | Condition | Action |
|----------|-----------|--------|
| 1 | Feature code is complete | Keep INCOMING (story branch) |
| 2 | HEAD has critical fixes | Merge both carefully |
| 3 | Codes incompatible | Rewrite combining intents |
| 4 | Feature breaks existing | Keep HEAD, document issue |

### Process:
1. Read file with conflicts
2. Find ALL markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`)
3. Decide based on priority table
4. Edit to remove markers with resolved code
5. Verify NO markers remain

### Verification:
\`\`\`bash
git diff --check  # No conflict markers
# Then validate syntax: tsc --noEmit OR dart analyze
\`\`\`
`;

// ═══════════════════════════════════════════════════════════════════════════════
// 🎯 1 DEV = 1 STORY RULE (used by TechLead)
// ═══════════════════════════════════════════════════════════════════════════════

export const ONE_DEV_ONE_STORY_SECTION = `
## 🚨 MANDATORY: 1 DEV = 1 STORY

**NON-NEGOTIABLE. System REJECTS violations.**

- 3 stories → 3 developers (dev-1, dev-2, dev-3)
- 5 stories → 5 developers (dev-1, dev-2, dev-3, dev-4, dev-5)
- NEVER assign 2+ stories to same developer
- \`teamComposition.developers\` MUST EQUAL story count
`;

// ═══════════════════════════════════════════════════════════════════════════════
// 📊 HELPER: Generate epic spec from free-form description
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract structured spec from epic description (best-effort parsing)
 */
export function extractStructuredSpec(
  epicDescription: string,
  epicTitle: string
): Partial<StructuredEpicSpec> {
  const spec: Partial<StructuredEpicSpec> = {};

  // Try to identify problem statement
  const problemMatch = epicDescription.match(/(?:problem|issue|need|want)[:.]?\s*([^.]+\.)/i);
  if (problemMatch) {
    spec.problem = problemMatch[1].trim();
  } else {
    spec.problem = `Implement ${epicTitle}`;
  }

  // Extract constraints from description
  const constraintPatterns = [
    /must use ([^,.\n]+)/gi,
    /should not ([^,.\n]+)/gi,
    /constraint[:.]?\s*([^.\n]+)/gi,
    /require(?:s|d)?[:.]?\s*([^.\n]+)/gi,
  ];

  spec.constraints = [];
  for (const pattern of constraintPatterns) {
    const matches = epicDescription.matchAll(pattern);
    for (const match of matches) {
      spec.constraints.push(match[1].trim());
    }
  }

  // Extract success criteria from acceptance criteria patterns
  const criteriaPatterns = [
    /given[^,]+when[^,]+then[^.\n]+/gi,
    /should ([^.\n]+)/gi,
    /must ([^.\n]+)/gi,
  ];

  spec.successCriteria = [];
  for (const pattern of criteriaPatterns) {
    const matches = epicDescription.matchAll(pattern);
    for (const match of matches) {
      if (match[0].length > 10) { // Skip very short matches
        spec.successCriteria.push(match[0].trim());
      }
    }
  }

  // Set context from description
  spec.context = epicDescription.slice(0, 500);

  return spec;
}
