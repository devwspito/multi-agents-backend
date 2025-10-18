---
description: Compact conversation history to reduce token usage
allowed-tools: Read
---

Compact Conversation History

Following Anthropic best practice for context management:
https://www.anthropic.com/engineering/context-management

Execute the following:

1. **Analyze Current Context**:
   - Estimate current token usage in conversation
   - Identify messages that can be summarized

2. **Compact History**:
   - Summarize older messages (keeping last 10 messages intact)
   - Focus on:
     * Key requirements and decisions
     * Important technical details
     * Actions taken and outcomes
     * Errors or issues encountered

3. **Report**:
   - Original message count
   - Compacted message count
   - Estimated token reduction
   - Summary quality assessment

**When to Use**:
- When conversation exceeds 50 messages
- When approaching token limits (80% of 200K context window)
- Before starting complex analysis that requires large context

**Success Criteria**:
- Significant token reduction (>40%)
- Critical context preserved
- No loss of essential technical information
