---
description: Review a specific pull request for code quality, security, and best practices
allowed-tools: Read, Grep, Glob, Bash
---

Review Pull Request #$1

Analyze the pull request for:
1. **Code Quality**: Check for code smells, complexity, maintainability
2. **Security**: Look for vulnerabilities, hardcoded secrets, SQL injection risks
3. **Best Practices**: Verify adherence to project coding standards
4. **Testing**: Ensure adequate test coverage
5. **Documentation**: Check for JSDoc comments and README updates
6. **WCAG 2.1 AA Compliance**: Verify accessibility standards (if UI changes)
7. **GDPR Compliance**: Check for proper PII handling

Provide a detailed review with:
- ✅ **Approved** - Ready to merge
- 🔄 **Changes Requested** - Issues found (list them)
- ❌ **Blocked** - Critical issues (explain why)
