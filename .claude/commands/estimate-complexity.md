---
description: Estimate the complexity of a task and recommend team size
allowed-tools: Read, Grep, Glob
---

Estimate Task Complexity: "$1"

Analyze the task and provide:

1. **Complexity Assessment**
   - Trivial: Single file, <50 LOC, no dependencies
   - Simple: Few files, <200 LOC, minimal integration
   - Moderate: Multiple files, <500 LOC, some integration
   - Complex: Many files, >500 LOC, significant integration
   - Epic: Multiple complex features, requires team

2. **Recommended Team Size**
   - 1 Developer: Trivial to Simple tasks
   - 2 Developers: Moderate tasks
   - 3-5 Developers: Complex tasks
   - 5+ Developers: Epic-level projects

3. **Estimated Time**
   - Hours or days to completion

4. **Required Skills**
   - Frontend, Backend, Database, DevOps, etc.

5. **Dependencies & Risks**
   - What needs to be done first
   - Potential blockers

Provide structured JSON output:
```json
{
  "complexity": "moderate",
  "developers": 2,
  "estimatedHours": 16,
  "skills": ["backend", "database"],
  "dependencies": ["authentication-system"],
  "risks": ["database migration required"]
}
```
