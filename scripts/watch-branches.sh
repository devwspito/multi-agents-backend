#!/bin/bash

# Script para ver branches y código en tiempo real
# Uso: ./scripts/watch-branches.sh <taskId>

TASK_ID=$1

if [ -z "$TASK_ID" ]; then
  echo "❌ Usage: ./scripts/watch-branches.sh <taskId>"
  echo "Example: ./scripts/watch-branches.sh 68eb9973fd8c4987b7847360"
  exit 1
fi

echo "🔍 Watching branches for task: $TASK_ID"
echo ""

# Get task details from MongoDB
TASK_DATA=$(node -e "
const mongoose = require('mongoose');
const Task = mongoose.model('Task', new mongoose.Schema({}, { strict: false }));

mongoose.connect('${MONGODB_URI:-mongodb://localhost:27017/multi-agents}')
  .then(async () => {
    const task = await Task.findById('$TASK_ID');
    if (!task) {
      console.error('Task not found');
      process.exit(1);
    }

    const branches = task.orchestration?.branches || [];
    console.log(JSON.stringify(branches));
    process.exit(0);
  })
  .catch(err => {
    console.error(err.message);
    process.exit(1);
  });
")

if [ $? -ne 0 ]; then
  echo "❌ Error getting task data"
  exit 1
fi

# Parse branches
echo "📍 BRANCHES CREATED:"
echo "$TASK_DATA" | node -e "
const branches = JSON.parse(require('fs').readFileSync(0, 'utf-8'));
branches.forEach((b, i) => {
  console.log(\`\n\${i+1}. \${b.name}\`);
  console.log(\`   Repository: \${b.repository}\`);
  console.log(\`   URL: \${b.url}\`);
  console.log(\`   View commits: \${b.url}/commits\`);
  console.log(\`   View diff: \${b.url}/compare/main...\${b.name}\`);
});
"

echo ""
echo "🔄 To watch for new commits, run:"
echo "   watch -n 5 'git -C /tmp/agent-workspace/task-$TASK_ID fetch && git -C /tmp/agent-workspace/task-$TASK_ID log --oneline'"
echo ""
echo "📖 To view task details:"
echo "   node scripts/view-task.js $TASK_ID"
