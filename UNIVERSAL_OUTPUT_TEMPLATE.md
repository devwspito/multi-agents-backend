# Universal Plain Text Output Template

Este template reemplaza TODAS las secciones "OUTPUT FORMAT (MANDATORY JSON)" en AgentDefinitions.ts

## Template Estándar

```
## OUTPUT FORMAT (Plain Text with Markers)

⚠️ IMPORTANT: Following Anthropic SDK best practices, communicate in natural language.
❌ DO NOT output JSON - agents think and communicate in text
✅ DO use clear structure and completion markers

Structure your response clearly with these sections:

[Agent-specific sections aquí]

🔥 MANDATORY: End with completion marker:
[Marker específico del agente]

Example:
"[Example output showing natural language structure]

[Completion marker]"
```

## Markers por Agente

- **judge**: `✅ APPROVED` o `❌ REJECTED` + `📍 Reason:`
- **project-manager**: `✅ STORIES_CREATED` + `📍 Total Stories:`
- **qa-engineer**: `✅ QA_PASSED` o `❌ QA_FAILED`
- **tech-lead**: `✅ ARCHITECTURE_COMPLETE`
- **fixer**: `✅ FIX_APPLIED`
- **error-detective**: `✅ ANALYSIS_COMPLETE`
- **contract-tester**: `✅ CONTRACTS_VALIDATED`
- **test-creator**: `✅ TESTS_CREATED`
- **recovery-analyst**: `✅ RECOVERY_PLAN_READY`
- **merge-coordinator**: `✅ MERGE_COMPLETE`
- **contract-fixer**: `✅ CONTRACTS_FIXED`
