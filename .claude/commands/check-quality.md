---
description: Check code quality using linters and static analysis
allowed-tools: Bash, Read
---

Code Quality Check

Run quality checks on the codebase:

1. **Linting**
   - Run `npm run lint`
   - Report errors and warnings

2. **TypeScript Compilation**
   - Run `npm run typecheck`
   - Report type errors

3. **Code Style**
   - Check for inconsistent formatting
   - Verify naming conventions

4. **Complexity Analysis**
   - Identify functions with high cyclomatic complexity
   - Suggest refactoring opportunities

5. **Dead Code Detection**
   - Find unused imports, variables, functions

Provide:
- **Quality Score**: 0-100 (100 = perfect)
- **Errors**: Count of linting/type errors
- **Warnings**: Count of warnings
- **Recommendations**: Top 3 improvements to make
- **Pass/Fail**: Does code meet quality standards?

**Quality Standards**:
- Zero linting errors
- Zero type errors
- Max cyclomatic complexity: 10 per function
