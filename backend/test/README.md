# Token Tracking System Tests

## Overview

This directory contains comprehensive tests for the token tracking system that monitors Claude API usage across projects, tasks, and agents.

## Test Files

### 1. `token-tracking.test.js`
**Integration tests for core token tracking functionality**

Tests the complete flow of token recording and aggregation:

- ✅ Task.recordAgentTokenUsage() creates TokenUsage records
- ✅ Multiple agent executions aggregate correctly
- ✅ Project.updateTokenStats() aggregates from all tasks
- ✅ Task.getTokenSummary() returns correct summary
- ✅ Error cases are handled correctly
- ✅ orchestrationWorkflowId groups related executions

**Run with:**
```bash
npm run test:token-tracking
```

### 2. `token-usage-api.test.js`
**Integration tests for token usage API endpoints**

Tests the API endpoints that expose token data:

- ✅ GET /api/token-usage/project/:id returns correct structure
- ✅ GET /api/token-usage/task/:id returns workflow details
- ✅ Project aggregation includes all tasks
- ✅ CSV export generates valid format
- ✅ Access control verifies project ownership
- ✅ Top tasks aggregation ranks by cost

**Run with:**
```bash
npm run test:token-api
```

### 3. `validate-integration.js`
**Static validation of system integration**

Validates that all components are properly integrated:

- ✅ Models have required methods and fields
- ✅ Services have tracking methods
- ✅ Routes use AgentOrchestrator tracking
- ✅ API endpoints are implemented
- ✅ Database indexes are defined
- ✅ Pricing constants are correct
- ✅ Test files exist
- ✅ Package.json scripts configured

**Run with:**
```bash
node backend/test/validate-integration.js
```

## Running Tests

### Run all tests
```bash
npm test
```

### Run specific test suites
```bash
# Token tracking tests only
npm run test:token-tracking

# API tests only
npm run test:token-api

# All tests
npm run test:all
```

### Run validation
```bash
node backend/test/validate-integration.js
```

## Test Database

Tests use a separate test database to avoid affecting production data:

- **Default**: `mongodb://localhost:27017/agents-test`
- **Override**: Set `MONGODB_URI` environment variable

Tests automatically:
1. Connect to test database
2. Create test data
3. Run assertions
4. Clean up (drop database)
5. Close connection

## Test Structure

Each test file uses a simple custom test runner:

```javascript
const runner = new TestRunner();

runner.test('Test name', async () => {
  // Setup
  const { user, project, task } = await createTestData();

  // Action
  await task.recordAgentTokenUsage({ ... });

  // Assertions
  assertEqual(task.tokenStats.totalTokens, 1500);
});

await runner.run();
```

## What Gets Tested

### Token Recording Flow
```
User creates task
     ↓
POST /api/tasks/:id/start
     ↓
executeFullOrchestration() runs 6 agents
     ↓
For each agent:
  agentOrchestrator.executeAgentWithTokenTracking()
     ↓
  claudeService.executeTask() → returns tokenUsage
     ↓
  task.recordAgentTokenUsage() → saves to TokenUsage
     ↓
  task.tokenStats updated (aggregation by agent)
     ↓
  project.updateTokenStats() → aggregates by model & agent
```

### Data Validation

**TokenUsage Collection:**
- ✅ User, project, task references
- ✅ Agent type and model
- ✅ Input/output tokens
- ✅ Cost calculation
- ✅ Orchestration workflow ID
- ✅ Agent stage (1-6)
- ✅ Duration, operation type, repository
- ✅ Artifacts generated
- ✅ Success/error status

**Task Aggregation:**
- ✅ Total tokens and cost
- ✅ Breakdown by agent
- ✅ Token usage records array

**Project Aggregation:**
- ✅ Total tokens and cost
- ✅ Breakdown by model (Opus/Sonnet)
- ✅ Breakdown by agent (6 types)
- ✅ Last updated timestamp

### API Endpoints

**GET /api/token-usage/project/:projectId**
- ✅ Access control (owner/collaborators)
- ✅ Aggregation by model
- ✅ Aggregation by agent
- ✅ Daily trends
- ✅ Top tasks ranking
- ✅ Recent records

**GET /api/token-usage/task/:taskId**
- ✅ Access control
- ✅ Orchestration workflow details
- ✅ Agent execution timeline
- ✅ Artifacts generated
- ✅ Token summary

**GET /api/token-usage/export/project/:projectId**
- ✅ Access control
- ✅ CSV format validation
- ✅ Date range filtering
- ✅ Special character escaping

## Expected Results

When all tests pass, you should see:

```
🧪 Starting Token Tracking Tests...
======================================================
✅ PASS: Task.recordAgentTokenUsage() should create TokenUsage record
✅ PASS: Multiple agent executions should aggregate correctly
✅ PASS: Project.updateTokenStats() should aggregate from all tasks
✅ PASS: Task.getTokenSummary() should return correct summary
✅ PASS: Error cases should be handled correctly
✅ PASS: orchestrationWorkflowId should group related executions
======================================================

📊 Results: 6 passed, 0 failed

🌐 Starting Token Usage API Tests...
======================================================
✅ PASS: GET /api/token-usage/project/:id should return correct data structure
✅ PASS: GET /api/token-usage/task/:id should return workflow details
✅ PASS: Project aggregation should include data from all tasks
✅ PASS: CSV export should generate valid format
✅ PASS: Access control should verify project ownership
✅ PASS: Top tasks aggregation should rank by cost
======================================================

📊 Results: 6 passed, 0 failed
```

## Token Pricing (2024-2025)

Tests validate correct pricing constants:

**Claude Opus:**
- Input: $15 per 1M tokens
- Output: $75 per 1M tokens

**Claude Sonnet:**
- Input: $3 per 1M tokens
- Output: $15 per 1M tokens

## Coverage

The tests cover:

- ✅ **Models**: Task, Project, TokenUsage
- ✅ **Services**: ClaudeService, AgentOrchestrator
- ✅ **Routes**: /api/tasks, /api/token-usage
- ✅ **Aggregations**: MongoDB aggregation pipelines
- ✅ **Access Control**: Project ownership verification
- ✅ **Error Handling**: Failed executions
- ✅ **Data Export**: CSV generation

## Manual Testing

After running automated tests, you can manually test the endpoints:

### 1. Create a project and task
```bash
# Create project
curl -X POST http://localhost:5000/api/projects \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Project","type":"web-app","description":"Testing"}'

# Create task
curl -X POST http://localhost:5000/api/tasks \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test Task","project":"PROJECT_ID","priority":"high"}'
```

### 2. Start orchestration
```bash
curl -X POST http://localhost:5000/api/tasks/TASK_ID/start \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"instructions":"Implement user authentication"}'
```

### 3. Check token usage
```bash
# Project usage
curl http://localhost:5000/api/token-usage/project/PROJECT_ID \
  -H "Authorization: Bearer YOUR_TOKEN"

# Task usage
curl http://localhost:5000/api/token-usage/task/TASK_ID \
  -H "Authorization: Bearer YOUR_TOKEN"

# Export CSV
curl http://localhost:5000/api/token-usage/export/project/PROJECT_ID \
  -H "Authorization: Bearer YOUR_TOKEN" \
  > token-usage.csv
```

## Troubleshooting

### Tests fail with "Connection refused"
- Ensure MongoDB is running: `mongod --dbpath /path/to/data`
- Check MONGODB_URI environment variable

### Tests timeout
- Increase timeout in test files (default: 30000ms)
- Check MongoDB performance
- Ensure no network latency

### Validation fails
- Check that all files are saved
- Verify no syntax errors in models/services
- Run `node backend/test/validate-integration.js` for details

## Contributing

When adding new token tracking features:

1. Add tests to `token-tracking.test.js` for model/service changes
2. Add tests to `token-usage-api.test.js` for API changes
3. Update `validate-integration.js` with new validation checks
4. Run all tests: `npm test`
5. Run validation: `node backend/test/validate-integration.js`
6. Update this README with new test descriptions

## Next Steps

After tests pass:

1. ✅ Phase 1 (Models): Complete
2. ✅ Phase 2 (Services): Complete
3. ✅ Phase 3 (API Endpoints): Complete
4. ✅ Phase 4 (Testing): Complete
5. 🔄 Phase 5 (Frontend Dashboard): Optional

Optional: Implement frontend dashboard to visualize token usage with charts and graphs.
