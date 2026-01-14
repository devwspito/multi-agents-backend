/**
 * SecurityDeepScanner
 *
 * Deep security analysis beyond basic checks.
 * Detects vulnerabilities, security anti-patterns, and compliance issues.
 *
 * Key behaviors:
 * 1. Detect OWASP Top 10 vulnerabilities
 * 2. Find hardcoded secrets and credentials
 * 3. Check for insecure dependencies
 * 4. Validate authentication/authorization patterns
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface SecurityVulnerability {
  id: string;
  type: 'injection' | 'xss' | 'auth' | 'exposure' | 'misconfiguration' |
        'crypto' | 'deserialization' | 'logging' | 'ssrf' | 'dependency';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  description: string;
  file: string;
  line?: number;
  code?: string;
  cwe?: string;
  owasp?: string;
  remediation: string;
  falsePositiveRisk: 'low' | 'medium' | 'high';
}

export interface SecretFinding {
  type: 'api_key' | 'password' | 'token' | 'certificate' | 'private_key' | 'connection_string';
  file: string;
  line: number;
  pattern: string;
  entropy: number;
  confidence: 'high' | 'medium' | 'low';
  masked: string;
}

export interface DependencyVulnerability {
  package: string;
  version: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  cve?: string;
  description: string;
  fixedIn?: string;
  exploitable: boolean;
}

export interface SecurityScanResult {
  score: number; // 0-100 (100 = secure)
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  vulnerabilities: SecurityVulnerability[];
  secrets: SecretFinding[];
  dependencies: DependencyVulnerability[];
  compliance: {
    owasp: { passed: number; failed: number; checks: string[] };
    gdpr: { compliant: boolean; issues: string[] };
    pci: { applicable: boolean; issues: string[] };
  };
  recommendations: string[];
  scanDuration: number;
  timestamp: number;
}

// Security patterns to detect
const VULNERABILITY_PATTERNS: {
  name: string;
  type: SecurityVulnerability['type'];
  severity: SecurityVulnerability['severity'];
  pattern: RegExp;
  cwe: string;
  owasp: string;
  remediation: string;
}[] = [
  // SQL Injection
  {
    name: 'SQL Injection - String Concatenation',
    type: 'injection',
    severity: 'critical',
    pattern: /(?:query|execute|sql)\s*\(\s*[`'"].*?\$\{|(?:query|execute|sql)\s*\(\s*['"].*?\+/gi,
    cwe: 'CWE-89',
    owasp: 'A03:2021',
    remediation: 'Use parameterized queries or prepared statements',
  },
  // Command Injection
  {
    name: 'Command Injection',
    type: 'injection',
    severity: 'critical',
    pattern: /exec(?:Sync)?\s*\(\s*(?:[`'"].*?\$\{|['"].*?\+)/gi,
    cwe: 'CWE-78',
    owasp: 'A03:2021',
    remediation: 'Use safe command execution libraries, validate and sanitize input',
  },
  // XSS - innerHTML
  {
    name: 'XSS via innerHTML',
    type: 'xss',
    severity: 'high',
    pattern: /innerHTML\s*=\s*(?![`'"][^`'"]*[`'"])/gi,
    cwe: 'CWE-79',
    owasp: 'A03:2021',
    remediation: 'Use textContent or sanitize HTML with DOMPurify',
  },
  // XSS - dangerouslySetInnerHTML
  {
    name: 'XSS via dangerouslySetInnerHTML',
    type: 'xss',
    severity: 'high',
    pattern: /dangerouslySetInnerHTML/gi,
    cwe: 'CWE-79',
    owasp: 'A03:2021',
    remediation: 'Sanitize input with DOMPurify before rendering',
  },
  // Hardcoded secrets
  {
    name: 'Hardcoded API Key',
    type: 'exposure',
    severity: 'critical',
    pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*[`'"][a-zA-Z0-9_\-]{20,}[`'"]/gi,
    cwe: 'CWE-798',
    owasp: 'A07:2021',
    remediation: 'Use environment variables or secret management',
  },
  // Hardcoded passwords
  {
    name: 'Hardcoded Password',
    type: 'exposure',
    severity: 'critical',
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*[`'"][^`'"]{4,}[`'"]/gi,
    cwe: 'CWE-798',
    owasp: 'A07:2021',
    remediation: 'Never hardcode passwords, use secure credential storage',
  },
  // Weak crypto
  {
    name: 'Weak Cryptography - MD5',
    type: 'crypto',
    severity: 'medium',
    pattern: /createHash\s*\(\s*['"]md5['"]\s*\)/gi,
    cwe: 'CWE-328',
    owasp: 'A02:2021',
    remediation: 'Use SHA-256 or stronger hashing algorithms',
  },
  // Weak crypto - SHA1
  {
    name: 'Weak Cryptography - SHA1',
    type: 'crypto',
    severity: 'medium',
    pattern: /createHash\s*\(\s*['"]sha1['"]\s*\)/gi,
    cwe: 'CWE-328',
    owasp: 'A02:2021',
    remediation: 'Use SHA-256 or stronger hashing algorithms',
  },
  // Insecure random
  {
    name: 'Insecure Random Number',
    type: 'crypto',
    severity: 'medium',
    pattern: /Math\.random\s*\(\s*\)/gi,
    cwe: 'CWE-330',
    owasp: 'A02:2021',
    remediation: 'Use crypto.randomBytes() for security-sensitive random values',
  },
  // Missing auth check
  {
    name: 'Potentially Unprotected Route',
    type: 'auth',
    severity: 'medium',
    pattern: /router\.(?:get|post|put|delete|patch)\s*\(\s*['"][^'"]+['"],\s*(?!.*(?:auth|protect|verify))/gi,
    cwe: 'CWE-306',
    owasp: 'A01:2021',
    remediation: 'Add authentication middleware to protect sensitive routes',
  },
  // Eval usage
  {
    name: 'Unsafe eval() Usage',
    type: 'injection',
    severity: 'critical',
    pattern: /(?<!\/\/.*)\beval\s*\(/gi,
    cwe: 'CWE-95',
    owasp: 'A03:2021',
    remediation: 'Remove eval() usage, use safe alternatives like JSON.parse()',
  },
  // CORS wildcard
  {
    name: 'CORS Wildcard',
    type: 'misconfiguration',
    severity: 'medium',
    pattern: /cors\s*\(\s*\{[^}]*origin:\s*['"]\*['"]/gi,
    cwe: 'CWE-942',
    owasp: 'A05:2021',
    remediation: 'Restrict CORS to specific trusted origins',
  },
  // Disabled SSL verification
  {
    name: 'Disabled SSL Verification',
    type: 'misconfiguration',
    severity: 'high',
    pattern: /rejectUnauthorized:\s*false/gi,
    cwe: 'CWE-295',
    owasp: 'A02:2021',
    remediation: 'Enable SSL certificate verification in production',
  },
  // Sensitive data logging
  {
    name: 'Sensitive Data in Logs',
    type: 'logging',
    severity: 'medium',
    pattern: /console\.log\s*\([^)]*(?:password|token|secret|key|credential)/gi,
    cwe: 'CWE-532',
    owasp: 'A09:2021',
    remediation: 'Remove sensitive data from log statements',
  },
  // Path traversal
  {
    name: 'Potential Path Traversal',
    type: 'injection',
    severity: 'high',
    pattern: /(?:readFile|writeFile|unlink|rmdir)(?:Sync)?\s*\(\s*(?:req\.|params\.|query\.)/gi,
    cwe: 'CWE-22',
    owasp: 'A03:2021',
    remediation: 'Validate and sanitize file paths, use path.resolve() with base directory check',
  },
  // NoSQL Injection
  {
    name: 'NoSQL Injection',
    type: 'injection',
    severity: 'high',
    pattern: /(?:find|findOne|update|delete)\s*\(\s*\{[^}]*\$where/gi,
    cwe: 'CWE-943',
    owasp: 'A03:2021',
    remediation: 'Avoid $where operator, use structured queries',
  },
  // JWT without verification
  {
    name: 'JWT Algorithm None',
    type: 'auth',
    severity: 'critical',
    pattern: /algorithms:\s*\[.*['"]none['"]/gi,
    cwe: 'CWE-327',
    owasp: 'A02:2021',
    remediation: 'Never allow "none" algorithm for JWT verification',
  },
];

// Secret patterns
const SECRET_PATTERNS: {
  type: SecretFinding['type'];
  pattern: RegExp;
  minEntropy: number;
}[] = [
  { type: 'api_key', pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*[`'"]([a-zA-Z0-9_\-]{20,})[`'"]/gi, minEntropy: 3.0 },
  { type: 'password', pattern: /(?:password|passwd|pwd)\s*[:=]\s*[`'"]([^`'"]{8,})[`'"]/gi, minEntropy: 2.5 },
  { type: 'token', pattern: /(?:token|bearer|jwt)\s*[:=]\s*[`'"]([a-zA-Z0-9_\-.]{20,})[`'"]/gi, minEntropy: 3.0 },
  { type: 'private_key', pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/gi, minEntropy: 0 },
  { type: 'connection_string', pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^'"\s]+/gi, minEntropy: 2.0 },
  { type: 'api_key', pattern: /sk-[a-zA-Z0-9]{20,}/gi, minEntropy: 3.5 }, // OpenAI
  { type: 'api_key', pattern: /ghp_[a-zA-Z0-9]{36}/gi, minEntropy: 4.0 }, // GitHub
  { type: 'api_key', pattern: /xox[baprs]-[a-zA-Z0-9\-]+/gi, minEntropy: 3.5 }, // Slack
];

export class SecurityDeepScanner {
  /**
   * Run deep security scan
   */
  static async scan(workspacePath: string, options?: {
    fileFilter?: string[];
    skipDependencies?: boolean;
    strictMode?: boolean;
  }): Promise<SecurityScanResult> {
    const startTime = Date.now();
    console.log(`\n🔐 [SecurityDeepScanner] Starting deep security scan...`);

    const vulnerabilities: SecurityVulnerability[] = [];
    const secrets: SecretFinding[] = [];
    let dependencies: DependencyVulnerability[] = [];

    // Find source files
    const files = await this.findSourceFiles(workspacePath, options?.fileFilter);
    console.log(`   Scanning ${files.length} source files`);

    // Scan each file
    for (const file of files) {
      try {
        const fullPath = path.join(workspacePath, file);
        const content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.split('\n');

        // Check for vulnerabilities
        for (const vuln of VULNERABILITY_PATTERNS) {
          vuln.pattern.lastIndex = 0;
          let match;

          while ((match = vuln.pattern.exec(content)) !== null) {
            const lineNumber = this.getLineNumber(content, match.index);
            const codeLine = lines[lineNumber - 1]?.trim() || '';

            // Skip if in comment
            if (codeLine.startsWith('//') || codeLine.startsWith('*')) continue;

            vulnerabilities.push({
              id: `vuln-${vulnerabilities.length + 1}`,
              type: vuln.type,
              severity: vuln.severity,
              title: vuln.name,
              description: `Found pattern: ${match[0].substring(0, 50)}...`,
              file,
              line: lineNumber,
              code: codeLine.substring(0, 100),
              cwe: vuln.cwe,
              owasp: vuln.owasp,
              remediation: vuln.remediation,
              falsePositiveRisk: 'medium',
            });
          }
        }

        // Check for secrets
        for (const secretPattern of SECRET_PATTERNS) {
          secretPattern.pattern.lastIndex = 0;
          let match;

          while ((match = secretPattern.pattern.exec(content)) !== null) {
            const lineNumber = this.getLineNumber(content, match.index);
            const secretValue = match[1] || match[0];
            const entropy = this.calculateEntropy(secretValue);

            if (entropy >= secretPattern.minEntropy) {
              secrets.push({
                type: secretPattern.type,
                file,
                line: lineNumber,
                pattern: secretPattern.type,
                entropy,
                confidence: entropy > 4 ? 'high' : entropy > 3 ? 'medium' : 'low',
                masked: this.maskSecret(secretValue),
              });
            }
          }
        }
      } catch {
        // Skip files that can't be read
      }
    }

    // Scan dependencies
    if (!options?.skipDependencies) {
      dependencies = await this.scanDependencies(workspacePath);
    }

    // Calculate compliance
    const compliance = this.checkCompliance(vulnerabilities, secrets);

    // Calculate security score
    const score = this.calculateScore(vulnerabilities, secrets, dependencies);
    const grade = this.scoreToGrade(score);

    // Generate recommendations
    const recommendations = this.generateRecommendations(vulnerabilities, secrets, dependencies, compliance);

    console.log(`   Found ${vulnerabilities.length} vulnerabilities`);
    console.log(`   Found ${secrets.length} potential secrets`);
    console.log(`   Found ${dependencies.length} dependency issues`);
    console.log(`   Security score: ${score}/100 (${grade})`);

    return {
      score,
      grade,
      vulnerabilities,
      secrets,
      dependencies,
      compliance,
      recommendations,
      scanDuration: Date.now() - startTime,
      timestamp: Date.now(),
    };
  }

  /**
   * Calculate Shannon entropy
   */
  private static calculateEntropy(str: string): number {
    const freq = new Map<string, number>();
    for (const char of str) {
      freq.set(char, (freq.get(char) || 0) + 1);
    }

    let entropy = 0;
    for (const count of freq.values()) {
      const p = count / str.length;
      entropy -= p * Math.log2(p);
    }

    return entropy;
  }

  /**
   * Mask a secret for display
   */
  private static maskSecret(secret: string): string {
    if (secret.length <= 8) return '*'.repeat(secret.length);
    return secret.substring(0, 4) + '*'.repeat(secret.length - 8) + secret.substring(secret.length - 4);
  }

  /**
   * Get line number from character index
   */
  private static getLineNumber(content: string, index: number): number {
    return content.substring(0, index).split('\n').length;
  }

  /**
   * Scan dependencies for vulnerabilities
   */
  private static async scanDependencies(workspacePath: string): Promise<DependencyVulnerability[]> {
    const vulnerabilities: DependencyVulnerability[] = [];

    try {
      // Try npm audit
      const output = execSync('npm audit --json 2>/dev/null || true', {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
      });

      if (output) {
        const audit = JSON.parse(output);

        if (audit.vulnerabilities) {
          for (const [pkg, vuln] of Object.entries(audit.vulnerabilities as Record<string, any>)) {
            vulnerabilities.push({
              package: pkg,
              version: vuln.range || 'unknown',
              severity: vuln.severity || 'medium',
              cve: vuln.cve || undefined,
              description: vuln.title || `Vulnerability in ${pkg}`,
              fixedIn: vuln.fixAvailable?.version,
              exploitable: vuln.severity === 'critical' || vuln.severity === 'high',
            });
          }
        }
      }
    } catch {
      // npm audit failed, try basic check
      try {
        const pkgPath = path.join(workspacePath, 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };

        // Known vulnerable patterns (simplified check)
        const knownVulnerable: Record<string, { below: string; severity: string; desc: string }> = {
          'lodash': { below: '4.17.21', severity: 'high', desc: 'Prototype pollution' },
          'minimist': { below: '1.2.6', severity: 'critical', desc: 'Prototype pollution' },
          'axios': { below: '0.21.2', severity: 'high', desc: 'SSRF vulnerability' },
          'express': { below: '4.17.3', severity: 'medium', desc: 'Open redirect' },
        };

        for (const [dep, version] of Object.entries(deps)) {
          if (knownVulnerable[dep]) {
            const versionNum = (version as string).replace(/[\^~>=<]/g, '');
            // Simplified version comparison
            if (versionNum < knownVulnerable[dep].below) {
              vulnerabilities.push({
                package: dep,
                version: version as string,
                severity: knownVulnerable[dep].severity as any,
                description: knownVulnerable[dep].desc,
                fixedIn: knownVulnerable[dep].below,
                exploitable: true,
              });
            }
          }
        }
      } catch {
        // Can't read package.json
      }
    }

    return vulnerabilities;
  }

  /**
   * Check compliance standards
   */
  private static checkCompliance(
    vulnerabilities: SecurityVulnerability[],
    secrets: SecretFinding[]
  ): SecurityScanResult['compliance'] {
    // OWASP Top 10 checks
    const owaspChecks = [
      { name: 'A01 - Broken Access Control', failed: vulnerabilities.filter(v => v.type === 'auth').length > 0 },
      { name: 'A02 - Cryptographic Failures', failed: vulnerabilities.filter(v => v.type === 'crypto').length > 0 },
      { name: 'A03 - Injection', failed: vulnerabilities.filter(v => v.type === 'injection' || v.type === 'xss').length > 0 },
      { name: 'A05 - Security Misconfiguration', failed: vulnerabilities.filter(v => v.type === 'misconfiguration').length > 0 },
      { name: 'A07 - Auth Failures', failed: secrets.length > 0 },
      { name: 'A09 - Logging Failures', failed: vulnerabilities.filter(v => v.type === 'logging').length > 0 },
    ];

    const passed = owaspChecks.filter(c => !c.failed).length;
    const failed = owaspChecks.filter(c => c.failed).length;

    // GDPR checks
    const gdprIssues: string[] = [];
    if (secrets.filter(s => s.type === 'password' || s.type === 'connection_string').length > 0) {
      gdprIssues.push('Hardcoded credentials may expose personal data');
    }
    if (vulnerabilities.filter(v => v.type === 'logging').length > 0) {
      gdprIssues.push('Sensitive data in logs violates data minimization');
    }

    // PCI checks (simplified)
    const pciApplicable = vulnerabilities.some(v =>
      v.description.toLowerCase().includes('payment') ||
      v.description.toLowerCase().includes('card')
    );

    return {
      owasp: {
        passed,
        failed,
        checks: owaspChecks.filter(c => c.failed).map(c => c.name),
      },
      gdpr: {
        compliant: gdprIssues.length === 0,
        issues: gdprIssues,
      },
      pci: {
        applicable: pciApplicable,
        issues: pciApplicable ? ['PCI DSS compliance review needed'] : [],
      },
    };
  }

  /**
   * Calculate security score
   */
  private static calculateScore(
    vulnerabilities: SecurityVulnerability[],
    secrets: SecretFinding[],
    dependencies: DependencyVulnerability[]
  ): number {
    let score = 100;

    // Deduct for vulnerabilities
    for (const vuln of vulnerabilities) {
      const deduction = {
        critical: 15,
        high: 10,
        medium: 5,
        low: 2,
        info: 1,
      }[vuln.severity];
      score -= deduction;
    }

    // Deduct for secrets
    for (const secret of secrets) {
      const deduction = {
        high: 15,
        medium: 10,
        low: 5,
      }[secret.confidence];
      score -= deduction;
    }

    // Deduct for vulnerable dependencies
    for (const dep of dependencies) {
      const deduction = {
        critical: 10,
        high: 7,
        medium: 4,
        low: 2,
      }[dep.severity];
      score -= deduction;
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Convert score to letter grade
   */
  private static scoreToGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
    if (score >= 90) return 'A';
    if (score >= 80) return 'B';
    if (score >= 70) return 'C';
    if (score >= 60) return 'D';
    return 'F';
  }

  /**
   * Generate recommendations
   */
  private static generateRecommendations(
    vulnerabilities: SecurityVulnerability[],
    secrets: SecretFinding[],
    dependencies: DependencyVulnerability[],
    compliance: SecurityScanResult['compliance']
  ): string[] {
    const recommendations: string[] = [];

    // Critical issues first
    const criticalVulns = vulnerabilities.filter(v => v.severity === 'critical');
    if (criticalVulns.length > 0) {
      recommendations.push(`🚨 CRITICAL: Fix ${criticalVulns.length} critical vulnerabilities immediately`);
    }

    // Secrets
    if (secrets.filter(s => s.confidence === 'high').length > 0) {
      recommendations.push(`🔑 Remove ${secrets.length} hardcoded secrets, use environment variables`);
    }

    // Dependencies
    const criticalDeps = dependencies.filter(d => d.severity === 'critical' || d.severity === 'high');
    if (criticalDeps.length > 0) {
      recommendations.push(`📦 Update ${criticalDeps.length} vulnerable dependencies`);
    }

    // OWASP compliance
    if (compliance.owasp.failed > 0) {
      recommendations.push(`📋 Address ${compliance.owasp.failed} OWASP Top 10 violations`);
    }

    // GDPR
    if (!compliance.gdpr.compliant) {
      recommendations.push(`🇪🇺 Fix GDPR compliance issues: ${compliance.gdpr.issues.join(', ')}`);
    }

    // General recommendations
    if (vulnerabilities.filter(v => v.type === 'injection').length > 0) {
      recommendations.push(`💉 Implement input validation and parameterized queries`);
    }

    if (vulnerabilities.filter(v => v.type === 'xss').length > 0) {
      recommendations.push(`🌐 Add Content Security Policy and sanitize HTML output`);
    }

    if (vulnerabilities.filter(v => v.type === 'auth').length > 0) {
      recommendations.push(`🔐 Review authentication and authorization on all routes`);
    }

    return recommendations.slice(0, 10);
  }

  /**
   * Find source files
   */
  private static async findSourceFiles(workspacePath: string, fileFilter?: string[]): Promise<string[]> {
    const files: string[] = [];

    const walk = (dir: string, prefix: string = ''): void => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
            continue;
          }

          const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

          if (fileFilter && !fileFilter.some(f => relativePath.includes(f))) {
            continue;
          }

          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            walk(fullPath, relativePath);
          } else if (entry.name.match(/\.(ts|tsx|js|jsx|json|yml|yaml|env|config)$/i)) {
            files.push(relativePath);
          }
        }
      } catch {
        // Ignore errors
      }
    };

    walk(workspacePath);
    return files;
  }

  /**
   * Format scan result for prompt
   */
  static formatResultForPrompt(result: SecurityScanResult): string {
    const gradeEmoji = {
      'A': '🟢',
      'B': '🟡',
      'C': '🟠',
      'D': '🟠',
      'F': '🔴',
    }[result.grade];

    let output = `
## 🔐 Security Scan Results

**Score**: ${gradeEmoji} ${result.score}/100 (Grade: ${result.grade})
**Scan Duration**: ${result.scanDuration}ms

### Findings Summary:
- 🐛 Vulnerabilities: ${result.vulnerabilities.length}
- 🔑 Secrets: ${result.secrets.length}
- 📦 Dependency Issues: ${result.dependencies.length}

### OWASP Compliance:
- Passed: ${result.compliance.owasp.passed}/6
- Failed: ${result.compliance.owasp.checks.join(', ') || 'None'}
`;

    // Critical vulnerabilities
    const critical = result.vulnerabilities.filter(v => v.severity === 'critical');
    if (critical.length > 0) {
      output += `\n### 🚨 Critical Vulnerabilities:\n`;
      for (const v of critical.slice(0, 5)) {
        output += `- **${v.title}** in \`${v.file}:${v.line}\`
  - ${v.description}
  - Fix: ${v.remediation}
`;
      }
    }

    // Secrets
    if (result.secrets.length > 0) {
      output += `\n### 🔑 Exposed Secrets:\n`;
      for (const s of result.secrets.slice(0, 5)) {
        output += `- ${s.type} in \`${s.file}:${s.line}\` (${s.confidence} confidence)\n`;
      }
    }

    // Recommendations
    if (result.recommendations.length > 0) {
      output += `\n### 💡 Recommendations:\n`;
      output += result.recommendations.map(r => `- ${r}`).join('\n');
    }

    return output;
  }

  /**
   * Generate instructions for agents
   */
  static generateInstructions(): string {
    return `
## 🔐 SECURITY DEEP SCANNING

The system scans for security vulnerabilities:

### Vulnerabilities Detected:

| Category | Examples |
|----------|----------|
| Injection | SQL, Command, NoSQL, XSS |
| Auth | Missing auth, weak JWT |
| Crypto | MD5, SHA1, Math.random |
| Exposure | Hardcoded secrets |
| Config | CORS, SSL disabled |

### Severity Levels:

- 🔴 **Critical**: Fix immediately, blocks release
- 🟠 **High**: Fix before release
- 🟡 **Medium**: Plan to fix
- 🟢 **Low**: Fix when convenient

### OWASP Top 10 Checked:

1. A01 - Broken Access Control
2. A02 - Cryptographic Failures
3. A03 - Injection
4. A05 - Security Misconfiguration
5. A07 - Authentication Failures
6. A09 - Security Logging Failures

### When Writing Code:

| Pattern | ❌ Don't | ✅ Do |
|---------|----------|-------|
| SQL | String concat | Parameterized queries |
| Secrets | Hardcode | Environment variables |
| Crypto | MD5/SHA1 | SHA-256/bcrypt |
| Random | Math.random | crypto.randomBytes |
| HTML | innerHTML | textContent/sanitize |

### Security Score:

- **A (90-100)**: Excellent security posture
- **B (80-89)**: Good, minor issues
- **C (70-79)**: Fair, needs attention
- **D (60-69)**: Poor, significant issues
- **F (<60)**: Critical, immediate action needed
`;
  }
}
