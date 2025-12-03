#!/bin/bash

# Script to replace ALL "JSON-forced" sections with plain text markers
# Following Anthropic SDK best practices

FILE="src/services/orchestration/AgentDefinitions.ts"

echo "🔄 Replacing ALL JSON-forced output formats with plain text markers..."

# Create backup
cp "$FILE" "$FILE.backup"

# Replace generic JSON output sections
# Pattern: YOUR ENTIRE RESPONSE MUST BE VALID JSON
sed -i.tmp '
/YOUR ENTIRE RESPONSE MUST BE VALID JSON/,/🚨 REMINDER.*FIRST.*{.*LAST.*}/ {
  /YOUR ENTIRE RESPONSE MUST BE VALID JSON/c\
## OUTPUT FORMAT (Plain Text with Markers)\
\
⚠️ IMPORTANT: Following Anthropic SDK best practices, communicate in natural language.\
❌ DO NOT output JSON - agents think in text, not data structures\
✅ DO use clear sections and completion markers\
\
Structure your response with clear sections and end with appropriate completion marker:\
✅ [AGENT]_COMPLETE or ✅ SUCCESS\
\
See documentation for agent-specific markers.
  d
}
' "$FILE"

# Remove temp file
rm -f "$FILE.tmp"

echo "✅ Replacements complete!"
echo "📋 Backup saved to: $FILE.backup"
echo ""
echo "Next steps:"
echo "1. Review changes: git diff $FILE"
echo "2. Test build: npm run build"
echo "3. If good, commit. If bad, restore: mv $FILE.backup $FILE"
