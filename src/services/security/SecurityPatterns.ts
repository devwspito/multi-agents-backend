/**
 * Security Patterns
 *
 * OWASP Top 10 and common vulnerability detection patterns.
 * Used by SecurityAgentService for real-time code analysis.
 */

export interface SecurityPattern {
  id: string;
  name: string;
  category: SecurityCategory;
  severity: Severity;
  patterns: RegExp[];
  description: string;
  recommendation: string;
  owaspCategory?: string;
  cweId?: string;
  // File extensions where this pattern applies (empty = all)
  fileExtensions?: string[];
  // Exclude patterns (false positives)
  excludePatterns?: RegExp[];
}

export type SecurityCategory =
  | 'xss'
  | 'injection'
  | 'secrets'
  | 'path_traversal'
  | 'eval'
  | 'insecure_deps'
  | 'csrf'
  | 'auth_bypass'
  | 'sensitive_data'
  | 'insecure_config'
  | 'command_injection'
  | 'ssrf'
  | 'xxe'
  | 'deserialization'
  | 'other';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

/**
 * Code Security Patterns
 * Detects vulnerabilities in source code
 */
export const CODE_PATTERNS: SecurityPattern[] = [
  // ============================================
  // XSS (Cross-Site Scripting)
  // ============================================
  {
    id: 'xss-innerhtml',
    name: 'Dangerous innerHTML Usage',
    category: 'xss',
    severity: 'high',
    patterns: [
      /\.innerHTML\s*=\s*[^"'`]/,
      /\.innerHTML\s*=\s*[`'"].*\$\{/,
      /\.innerHTML\s*\+=\s*/,
    ],
    description: 'Direct innerHTML assignment with dynamic content can lead to XSS attacks',
    recommendation: 'Use textContent for plain text, or sanitize HTML with DOMPurify before innerHTML assignment',
    owaspCategory: 'A03:2021',
    cweId: 'CWE-79',
    fileExtensions: ['.js', '.ts', '.jsx', '.tsx', '.vue', '.svelte'],
  },
  {
    id: 'xss-dangerously-set',
    name: 'React dangerouslySetInnerHTML',
    category: 'xss',
    severity: 'high',
    patterns: [
      /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:/,
    ],
    description: 'dangerouslySetInnerHTML bypasses React XSS protection',
    recommendation: 'Avoid dangerouslySetInnerHTML, or sanitize content with DOMPurify first',
    owaspCategory: 'A03:2021',
    cweId: 'CWE-79',
    fileExtensions: ['.jsx', '.tsx'],
  },
  {
    id: 'xss-document-write',
    name: 'document.write Usage',
    category: 'xss',
    severity: 'medium',
    patterns: [
      /document\.write\s*\(/,
      /document\.writeln\s*\(/,
    ],
    description: 'document.write can be exploited for XSS attacks',
    recommendation: 'Use DOM manipulation methods like appendChild instead',
    owaspCategory: 'A03:2021',
    cweId: 'CWE-79',
    fileExtensions: ['.js', '.ts', '.jsx', '.tsx'],
  },

  // ============================================
  // SQL Injection
  // ============================================
  {
    id: 'sql-injection-concat',
    name: 'SQL String Concatenation',
    category: 'injection',
    severity: 'critical',
    patterns: [
      /['"`]\s*\+\s*\w+\s*\+\s*['"`].*(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)/i,
      /(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE).*['"`]\s*\+\s*\w+/i,
      /`SELECT.*\$\{.*\}.*FROM/i,
      /`.*FROM.*WHERE.*\$\{.*\}`/i,
    ],
    description: 'SQL queries built with string concatenation are vulnerable to SQL injection',
    recommendation: 'Use parameterized queries or prepared statements',
    owaspCategory: 'A03:2021',
    cweId: 'CWE-89',
    fileExtensions: ['.js', '.ts', '.py', '.java', '.php', '.rb'],
    excludePatterns: [
      /\.prepare\s*\(/,
      /\?\s*,/,  // Parameterized query indicator
    ],
  },
  {
    id: 'sql-injection-template',
    name: 'SQL Template Literal Injection',
    category: 'injection',
    severity: 'critical',
    patterns: [
      /query\s*\(\s*`[^`]*\$\{[^}]+\}[^`]*`\s*\)/,
      /execute\s*\(\s*`[^`]*\$\{[^}]+\}[^`]*`\s*\)/,
      /raw\s*\(\s*`[^`]*\$\{[^}]+\}[^`]*`\s*\)/,
    ],
    description: 'Template literals in SQL queries can lead to injection',
    recommendation: 'Use query builders or parameterized queries instead',
    owaspCategory: 'A03:2021',
    cweId: 'CWE-89',
    fileExtensions: ['.js', '.ts'],
  },

  // ============================================
  // Command Injection
  // ============================================
  {
    id: 'command-injection-exec',
    name: 'Command Injection via exec',
    category: 'command_injection',
    severity: 'critical',
    patterns: [
      /child_process.*exec\s*\([^)]*\$\{/,
      /child_process.*exec\s*\([^)]*\+/,
      /exec\s*\(\s*['"`][^'"`]*\$\{/,
      /execSync\s*\(\s*['"`][^'"`]*\$\{/,
      /subprocess\.(?:call|run|Popen)\s*\([^)]*\+/,
      /os\.system\s*\([^)]*\+/,
      /Runtime\.getRuntime\(\)\.exec\s*\([^)]*\+/,
    ],
    description: 'Command execution with user input can lead to arbitrary command execution',
    recommendation: 'Use execFile with argument arrays, or validate/sanitize input strictly',
    owaspCategory: 'A03:2021',
    cweId: 'CWE-78',
    fileExtensions: ['.js', '.ts', '.py', '.java', '.rb', '.php'],
  },
  {
    id: 'command-injection-shell',
    name: 'Shell Command with User Input',
    category: 'command_injection',
    severity: 'critical',
    patterns: [
      /shell\s*:\s*true/,
      /spawn\s*\([^)]*,\s*\{[^}]*shell\s*:\s*true/,
    ],
    description: 'Using shell: true with spawn allows shell metacharacter injection',
    recommendation: 'Avoid shell: true, use argument arrays instead',
    owaspCategory: 'A03:2021',
    cweId: 'CWE-78',
    fileExtensions: ['.js', '.ts'],
  },

  // ============================================
  // Secrets & Credentials
  // ============================================
  {
    id: 'secrets-api-key',
    name: 'Hardcoded API Key',
    category: 'secrets',
    severity: 'critical',
    patterns: [
      /(?:api[_-]?key|apikey)\s*[:=]\s*['"`][a-zA-Z0-9_\-]{20,}['"`]/i,
      /sk-[a-zA-Z0-9]{20,}/,  // OpenAI/Anthropic style
      /AIza[0-9A-Za-z_-]{35}/,  // Google API
      /ghp_[a-zA-Z0-9]{36}/,  // GitHub token
      /gho_[a-zA-Z0-9]{36}/,  // GitHub OAuth
      /glpat-[a-zA-Z0-9_-]{20,}/,  // GitLab token
      /xox[baprs]-[0-9]{10,}-[a-zA-Z0-9-]+/,  // Slack token
    ],
    description: 'API keys should never be hardcoded in source code',
    recommendation: 'Use environment variables or a secrets manager',
    owaspCategory: 'A02:2021',
    cweId: 'CWE-798',
  },
  {
    id: 'secrets-password',
    name: 'Hardcoded Password',
    category: 'secrets',
    severity: 'critical',
    patterns: [
      /(?:password|passwd|pwd)\s*[:=]\s*['"`][^'"`]{8,}['"`]/i,
      /(?:secret|token)\s*[:=]\s*['"`][^'"`]{16,}['"`]/i,
    ],
    description: 'Passwords should never be hardcoded in source code',
    recommendation: 'Use environment variables or a secrets manager',
    owaspCategory: 'A02:2021',
    cweId: 'CWE-798',
    excludePatterns: [
      /process\.env/,
      /os\.environ/,
      /System\.getenv/,
      /placeholder/i,
      /example/i,
      /your[_-]?password/i,
    ],
  },
  {
    id: 'secrets-private-key',
    name: 'Private Key in Code',
    category: 'secrets',
    severity: 'critical',
    patterns: [
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
      /-----BEGIN PGP PRIVATE KEY BLOCK-----/,
    ],
    description: 'Private keys should never be in source code',
    recommendation: 'Store private keys in secure key management systems',
    owaspCategory: 'A02:2021',
    cweId: 'CWE-321',
  },
  {
    id: 'secrets-aws',
    name: 'AWS Credentials',
    category: 'secrets',
    severity: 'critical',
    patterns: [
      /AKIA[0-9A-Z]{16}/,  // AWS Access Key ID
      /aws[_-]?secret[_-]?access[_-]?key\s*[:=]\s*['"`][^'"`]{40}['"`]/i,
    ],
    description: 'AWS credentials should never be in source code',
    recommendation: 'Use IAM roles, environment variables, or AWS Secrets Manager',
    owaspCategory: 'A02:2021',
    cweId: 'CWE-798',
  },

  // ============================================
  // Path Traversal
  // ============================================
  {
    id: 'path-traversal',
    name: 'Path Traversal Vulnerability',
    category: 'path_traversal',
    severity: 'high',
    patterns: [
      /(?:readFile|writeFile|unlink|rmdir|mkdir|access|stat)\s*\([^)]*\+/,
      /(?:readFile|writeFile|unlink|rmdir|mkdir|access|stat)\s*\([^)]*\$\{/,
      /path\.join\s*\([^)]*req\./,
      /open\s*\([^)]*\+.*['"`]r/,
    ],
    description: 'File operations with user input can allow directory traversal attacks',
    recommendation: 'Validate paths, use path.resolve() and ensure result is within allowed directory',
    owaspCategory: 'A01:2021',
    cweId: 'CWE-22',
    fileExtensions: ['.js', '.ts', '.py', '.java', '.php', '.rb'],
  },

  // ============================================
  // Eval & Code Injection
  // ============================================
  {
    id: 'eval-usage',
    name: 'Dangerous eval() Usage',
    category: 'eval',
    severity: 'critical',
    patterns: [
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /setTimeout\s*\(\s*['"`]/,
      /setInterval\s*\(\s*['"`]/,
    ],
    description: 'eval() and similar constructs can execute arbitrary code',
    recommendation: 'Avoid eval(), use safer alternatives like JSON.parse() for data',
    owaspCategory: 'A03:2021',
    cweId: 'CWE-95',
    fileExtensions: ['.js', '.ts', '.jsx', '.tsx'],
    excludePatterns: [
      /JSON\.parse/,
    ],
  },
  {
    id: 'eval-python',
    name: 'Python eval/exec Usage',
    category: 'eval',
    severity: 'critical',
    patterns: [
      /\beval\s*\(/,
      /\bexec\s*\(/,
      /compile\s*\([^)]+,\s*['"`]exec['"`]/,
    ],
    description: 'eval() and exec() in Python can execute arbitrary code',
    recommendation: 'Use ast.literal_eval() for safe evaluation of literals',
    owaspCategory: 'A03:2021',
    cweId: 'CWE-95',
    fileExtensions: ['.py'],
  },

  // ============================================
  // Insecure Configuration
  // ============================================
  {
    id: 'insecure-cors',
    name: 'Insecure CORS Configuration',
    category: 'insecure_config',
    severity: 'medium',
    patterns: [
      /Access-Control-Allow-Origin['"]\s*:\s*['"]\*/,
      /cors\s*\(\s*\{\s*origin\s*:\s*['"]\*['"]/,
      /cors\s*\(\s*\{\s*origin\s*:\s*true/,
    ],
    description: 'Wildcard CORS allows any origin to access resources',
    recommendation: 'Specify allowed origins explicitly',
    owaspCategory: 'A05:2021',
    cweId: 'CWE-942',
    fileExtensions: ['.js', '.ts', '.py', '.java'],
  },
  {
    id: 'insecure-ssl',
    name: 'SSL/TLS Verification Disabled',
    category: 'insecure_config',
    severity: 'high',
    patterns: [
      /rejectUnauthorized\s*:\s*false/,
      /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"`]0['"`]/,
      /verify\s*=\s*False/,  // Python requests
      /ssl\s*:\s*\{\s*rejectUnauthorized\s*:\s*false/,
    ],
    description: 'Disabling SSL verification allows man-in-the-middle attacks',
    recommendation: 'Always verify SSL certificates in production',
    owaspCategory: 'A02:2021',
    cweId: 'CWE-295',
  },
  {
    id: 'insecure-cookie',
    name: 'Insecure Cookie Configuration',
    category: 'insecure_config',
    severity: 'medium',
    patterns: [
      /httpOnly\s*:\s*false/,
      /secure\s*:\s*false/,
      /sameSite\s*:\s*['"`]none['"`]/i,
    ],
    description: 'Cookies without proper security flags are vulnerable to theft',
    recommendation: 'Set httpOnly: true, secure: true, and appropriate sameSite',
    owaspCategory: 'A05:2021',
    cweId: 'CWE-614',
    fileExtensions: ['.js', '.ts'],
  },

  // ============================================
  // SSRF (Server-Side Request Forgery)
  // ============================================
  {
    id: 'ssrf-fetch',
    name: 'Potential SSRF via User Input',
    category: 'ssrf',
    severity: 'high',
    patterns: [
      /fetch\s*\(\s*(?:req\.|request\.|params\.|query\.)/,
      /axios\s*\.\s*(?:get|post|put|delete)\s*\(\s*(?:req\.|request\.|params\.|query\.)/,
      /http\.request\s*\(\s*(?:req\.|request\.|params\.|query\.)/,
      /requests\.(?:get|post)\s*\([^)]*\+/,
    ],
    description: 'Making HTTP requests with user-controlled URLs can lead to SSRF',
    recommendation: 'Validate and whitelist allowed URLs/domains',
    owaspCategory: 'A10:2021',
    cweId: 'CWE-918',
    fileExtensions: ['.js', '.ts', '.py'],
  },

  // ============================================
  // Insecure Deserialization
  // ============================================
  {
    id: 'insecure-pickle',
    name: 'Insecure Pickle Deserialization',
    category: 'deserialization',
    severity: 'critical',
    patterns: [
      /pickle\.loads?\s*\(/,
      /cPickle\.loads?\s*\(/,
    ],
    description: 'Pickle deserialization of untrusted data can execute arbitrary code',
    recommendation: 'Use JSON or other safe serialization formats for untrusted data',
    owaspCategory: 'A08:2021',
    cweId: 'CWE-502',
    fileExtensions: ['.py'],
  },
  {
    id: 'insecure-yaml',
    name: 'Insecure YAML Loading',
    category: 'deserialization',
    severity: 'high',
    patterns: [
      /yaml\.load\s*\([^)]*\)/,
      /yaml\.unsafe_load\s*\(/,
    ],
    description: 'yaml.load() can execute arbitrary Python code',
    recommendation: 'Use yaml.safe_load() instead',
    owaspCategory: 'A08:2021',
    cweId: 'CWE-502',
    fileExtensions: ['.py'],
    excludePatterns: [
      /yaml\.safe_load/,
    ],
  },
];

/**
 * Bash Command Security Patterns
 * Detects dangerous commands and potential vulnerabilities
 */
export const BASH_PATTERNS: SecurityPattern[] = [
  {
    id: 'bash-curl-pipe',
    name: 'Curl Pipe to Shell',
    category: 'command_injection',
    severity: 'high',
    patterns: [
      /curl\s+[^|]*\|\s*(?:bash|sh|zsh)/,
      /wget\s+[^|]*\|\s*(?:bash|sh|zsh)/,
    ],
    description: 'Piping curl/wget output directly to shell is dangerous',
    recommendation: 'Download script first, review it, then execute',
    owaspCategory: 'A08:2021',
    cweId: 'CWE-494',
  },
  {
    id: 'bash-rm-rf',
    name: 'Dangerous rm -rf Command',
    category: 'command_injection',
    severity: 'high',
    patterns: [
      /rm\s+-rf\s+\/(?!tmp|var\/tmp)/,
      /rm\s+-rf\s+\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\/?\s*$/,
      /rm\s+-rf\s+\*/,
    ],
    description: 'rm -rf with variables or wildcards can delete unintended files',
    recommendation: 'Always verify paths before destructive operations',
    cweId: 'CWE-73',
  },
  {
    id: 'bash-chmod-777',
    name: 'Overly Permissive chmod',
    category: 'insecure_config',
    severity: 'medium',
    patterns: [
      /chmod\s+777/,
      /chmod\s+666/,
      /chmod\s+-R\s+777/,
    ],
    description: 'chmod 777 gives everyone read/write/execute permissions',
    recommendation: 'Use minimum necessary permissions (e.g., 755 for directories, 644 for files)',
    cweId: 'CWE-732',
  },
  {
    id: 'bash-sudo-nopasswd',
    name: 'Sudo without Password',
    category: 'auth_bypass',
    severity: 'high',
    patterns: [
      /NOPASSWD/,
      /sudo\s+-S/,
    ],
    description: 'Passwordless sudo can be a security risk',
    recommendation: 'Require password for sudo operations when possible',
    cweId: 'CWE-269',
  },
  {
    id: 'bash-env-secrets',
    name: 'Secrets in Environment Variable Command',
    category: 'secrets',
    severity: 'high',
    patterns: [
      /export\s+(?:PASSWORD|SECRET|API_KEY|TOKEN)\s*=\s*['"][^'"]+['"]/i,
      /(?:PASSWORD|SECRET|API_KEY|TOKEN)\s*=\s*['"][^'"]+['"]\s+\w+/i,
    ],
    description: 'Secrets passed as environment variables may be logged',
    recommendation: 'Use secret management tools instead of inline secrets',
    cweId: 'CWE-798',
  },
];

/**
 * Dependency Security Patterns
 * Detects insecure dependency configurations
 */
export const DEPENDENCY_PATTERNS: SecurityPattern[] = [
  {
    id: 'npm-install-unsafe',
    name: 'Unsafe npm install',
    category: 'insecure_deps',
    severity: 'medium',
    patterns: [
      /npm\s+install\s+--unsafe-perm/,
      /npm\s+install\s+-g\s+--unsafe-perm/,
    ],
    description: 'Installing npm packages with --unsafe-perm can be risky',
    recommendation: 'Avoid --unsafe-perm unless absolutely necessary',
    cweId: 'CWE-269',
  },
  {
    id: 'pip-trusted-host',
    name: 'Pip Trusted Host',
    category: 'insecure_deps',
    severity: 'medium',
    patterns: [
      /pip\s+install\s+--trusted-host/,
    ],
    description: 'Trusting arbitrary hosts can lead to package compromise',
    recommendation: 'Only use trusted package sources',
    cweId: 'CWE-494',
  },
];

/**
 * Get all patterns combined
 */
export function getAllPatterns(): SecurityPattern[] {
  return [...CODE_PATTERNS, ...BASH_PATTERNS, ...DEPENDENCY_PATTERNS];
}

/**
 * Get patterns by category
 */
export function getPatternsByCategory(category: SecurityCategory): SecurityPattern[] {
  return getAllPatterns().filter(p => p.category === category);
}

/**
 * Get patterns by severity
 */
export function getPatternsBySeverity(severity: Severity): SecurityPattern[] {
  return getAllPatterns().filter(p => p.severity === severity);
}

/**
 * Get patterns applicable to a file extension
 */
export function getPatternsForFile(filePath: string): SecurityPattern[] {
  const ext = '.' + filePath.split('.').pop()?.toLowerCase();
  return getAllPatterns().filter(p => {
    if (!p.fileExtensions || p.fileExtensions.length === 0) {
      return true; // Applies to all files
    }
    return p.fileExtensions.includes(ext);
  });
}

export default {
  CODE_PATTERNS,
  BASH_PATTERNS,
  DEPENDENCY_PATTERNS,
  getAllPatterns,
  getPatternsByCategory,
  getPatternsBySeverity,
  getPatternsForFile,
};
