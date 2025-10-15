---
description: Run the full test suite and report results
allowed-tools: Bash, Read
---

Run Test Suite

Execute the following in the repository:

1. **Unit Tests**: `npm test`
2. **Integration Tests**: `npm run test:integration` (if available)
3. **Coverage Report**: `npm run test:coverage` (if available)

Report:
- Total tests run
- Passed/Failed counts
- Code coverage percentage
- Any failing tests with details
- Recommendations for improving test coverage

**Success Criteria**: >85% code coverage, all tests passing
