---
description: Perform comprehensive security analysis on the codebase
allowed-tools: Bash, Read, Grep, Glob
---

Security Analysis

Perform a comprehensive security audit:

1. **Dependency Vulnerabilities**
   - Run `npm audit`
   - Check for critical and high severity issues

2. **Hardcoded Secrets**
   - Search for API keys, passwords, tokens in code
   - Check .env files are in .gitignore

3. **SQL Injection Risks**
   - Look for raw SQL queries without parameterization
   - Check for user input concatenation in queries

4. **XSS Vulnerabilities**
   - Check for unescaped user input in HTML
   - Verify input sanitization

5. **Authentication & Authorization**
   - Verify JWT implementation
   - Check for proper password hashing (bcrypt, 10+ rounds)
   - Validate session management

6. **GDPR Compliance**
   - Check for PII logging
   - Verify data encryption
   - Validate consent mechanisms

Provide:
- **Risk Level**: Low/Medium/High/Critical
- **Issues Found**: Detailed list with file/line references
- **Recommendations**: How to fix each issue
- **GO/NO-GO**: Can this code go to production?
