/**
 * 📋 REQUIREMENTS VALIDATOR
 * Validates task requirements for completeness and clarity
 * Detects ambiguous requirements and asks for clarification
 */

interface ValidationIssue {
  type: 'missing' | 'ambiguous' | 'unclear' | 'incomplete' | 'conflicting';
  severity: 'critical' | 'warning' | 'info';
  field: string;
  message: string;
  suggestion?: string;
}

interface RequirementsAnalysis {
  isValid: boolean;
  confidence: number; // 0-100
  issues: ValidationIssue[];
  clarificationQuestions: string[];
  requirements: {
    functional: string[];
    nonFunctional: string[];
    acceptance: string[];
  };
  estimatedClarity: 'very_clear' | 'clear' | 'somewhat_clear' | 'unclear' | 'very_unclear';
  recommendation: 'proceed' | 'clarify' | 'reject';
}

export class RequirementsValidator {
  /**
   * Validate task requirements before execution
   */
  validateRequirements(
    title: string,
    description: string,
    additionalContext?: any
  ): RequirementsAnalysis {
    console.log('\n📋 [Requirements Validator] Analyzing requirements...');

    const issues: ValidationIssue[] = [];
    const clarificationQuestions: string[] = [];
    const requirements = {
      functional: [] as string[],
      nonFunctional: [] as string[],
      acceptance: [] as string[]
    };

    // Check if there's additional context (image, attachments, etc.)
    const hasAdditionalContext = !!(additionalContext?.attachments?.length || additionalContext?.image);

    // 1. Check for basic completeness
    this.checkBasicCompleteness(title, description, issues, hasAdditionalContext);

    // 2. Check for ambiguous language
    this.checkForAmbiguity(description, issues, clarificationQuestions);

    // 3. Extract requirements
    this.extractRequirements(description, requirements);

    // 4. Check for missing critical information (skip if has additional context)
    if (!hasAdditionalContext) {
      this.checkForMissingInfo(description, issues, clarificationQuestions);
    }

    // 5. Check for conflicting requirements
    this.checkForConflicts(description, issues);

    // 6. Analyze technical feasibility
    this.analyzeTechnicalFeasibility(description, issues);

    // Calculate overall confidence and recommendation
    const confidence = this.calculateConfidence(issues);
    const clarity = this.estimateClarity(confidence);
    const recommendation = this.makeRecommendation(confidence, issues);

    const analysis: RequirementsAnalysis = {
      isValid: issues.filter(i => i.severity === 'critical').length === 0,
      confidence,
      issues,
      clarificationQuestions,
      requirements,
      estimatedClarity: clarity,
      recommendation
    };

    // Display analysis results
    this.displayAnalysis(analysis);

    return analysis;
  }

  /**
   * Check basic completeness of requirements
   */
  private checkBasicCompleteness(
    title: string,
    description: string,
    issues: ValidationIssue[],
    hasAdditionalContext: boolean = false
  ): void {
    // Check title - be more lenient if there's additional context
    if (!title || title.length < 3) {
      issues.push({
        type: 'missing',
        severity: hasAdditionalContext ? 'warning' : 'critical',
        field: 'title',
        message: 'Task title is very short',
        suggestion: 'Provide a descriptive title for the task'
      });
    }

    // Check description - be more lenient if there's an image or additional context
    if (!description || description.length < 10) {
      issues.push({
        type: 'missing',
        severity: hasAdditionalContext ? 'warning' : 'critical',
        field: 'description',
        message: 'Task description is brief',
        suggestion: 'Provide more details about what needs to be done'
      });
    }
  }

  /**
   * Check for ambiguous language
   */
  private checkForAmbiguity(
    description: string,
    issues: ValidationIssue[],
    questions: string[]
  ): void {
    const lower = description.toLowerCase();

    // Ambiguous terms
    const ambiguousTerms = [
      { term: 'somehow', question: 'How exactly should this be implemented?' },
      { term: 'something like', question: 'Can you provide specific requirements instead of examples?' },
      { term: 'maybe', question: 'Is this a requirement or optional? Please clarify.' },
      { term: 'probably', question: 'Please confirm: is this definitely required?' },
      { term: 'etc', question: 'Can you provide the complete list instead of using "etc"?' },
      { term: 'and so on', question: 'Please list all requirements explicitly.' },
      { term: 'various', question: 'Which specific items are included?' },
      { term: 'several', question: 'How many exactly? Please be specific.' },
      { term: 'some', question: 'Which ones specifically?' },
      { term: 'appropriate', question: 'What criteria determine what is appropriate?' }
    ];

    ambiguousTerms.forEach(({ term, question }) => {
      if (lower.includes(term)) {
        issues.push({
          type: 'ambiguous',
          severity: 'warning',
          field: 'description',
          message: `Contains ambiguous term: "${term}"`,
          suggestion: question
        });
        questions.push(question);
      }
    });

    // Check for vague action words
    const vagueActions = ['improve', 'enhance', 'optimize', 'better', 'fix'];
    vagueActions.forEach(action => {
      if (lower.includes(action) && !lower.includes('specific')) {
        issues.push({
          type: 'unclear',
          severity: 'warning',
          field: 'description',
          message: `Vague action word: "${action}" - needs specifics`,
          suggestion: `What specific aspects should be ${action}d? What are the success criteria?`
        });
        questions.push(`What specific improvements are needed for "${action}"?`);
      }
    });
  }

  /**
   * Extract requirements from description
   */
  private extractRequirements(
    description: string,
    requirements: { functional: string[]; nonFunctional: string[]; acceptance: string[] }
  ): void {
    const lines = description.split(/[.!?\n]/).filter(l => l.trim());

    lines.forEach(line => {
      const lower = line.toLowerCase();

      // Functional requirements (what the system should do)
      if (lower.includes('should') || lower.includes('must') || lower.includes('need')) {
        requirements.functional.push(line.trim());
      }

      // Non-functional requirements (how the system should be)
      if (lower.includes('performance') || lower.includes('security') ||
          lower.includes('responsive') || lower.includes('scalable') ||
          lower.includes('reliable') || lower.includes('accessible')) {
        requirements.nonFunctional.push(line.trim());
      }

      // Acceptance criteria
      if (lower.includes('when') || lower.includes('given') || lower.includes('then') ||
          lower.includes('expect') || lower.includes('result')) {
        requirements.acceptance.push(line.trim());
      }
    });
  }

  /**
   * Check for missing critical information
   */
  private checkForMissingInfo(
    description: string,
    issues: ValidationIssue[],
    questions: string[]
  ): void {
    const lower = description.toLowerCase();

    // Check for UI/UX tasks without design specs
    if ((lower.includes('ui') || lower.includes('interface') || lower.includes('design') ||
         lower.includes('button') || lower.includes('form') || lower.includes('page')) &&
        !lower.includes('figma') && !lower.includes('design') && !lower.includes('mockup')) {
      issues.push({
        type: 'missing',
        severity: 'warning',
        field: 'design',
        message: 'UI task without design specifications',
        suggestion: 'Provide design mockups, wireframes, or detailed UI specifications'
      });
      questions.push('Do you have design specifications or mockups for the UI elements?');
    }

    // Check for API tasks without specifications
    if ((lower.includes('api') || lower.includes('endpoint') || lower.includes('service')) &&
        !lower.includes('response') && !lower.includes('request') && !lower.includes('payload')) {
      issues.push({
        type: 'missing',
        severity: 'warning',
        field: 'api',
        message: 'API task without request/response specifications',
        suggestion: 'Provide API contract details: endpoints, methods, payloads, responses'
      });
      questions.push('What should the API request and response formats be?');
    }

    // Check for data tasks without schema
    if ((lower.includes('database') || lower.includes('model') || lower.includes('schema')) &&
        !lower.includes('field') && !lower.includes('column') && !lower.includes('table')) {
      issues.push({
        type: 'missing',
        severity: 'warning',
        field: 'database',
        message: 'Database task without schema details',
        suggestion: 'Provide database schema, field types, relationships'
      });
      questions.push('What are the database schema requirements?');
    }

    // Check for missing success criteria
    if (!lower.includes('success') && !lower.includes('complete') && !lower.includes('done') &&
        !lower.includes('expect') && !lower.includes('result')) {
      issues.push({
        type: 'missing',
        severity: 'warning',
        field: 'acceptance',
        message: 'No clear success criteria defined',
        suggestion: 'Define how we will know when this task is successfully completed'
      });
      questions.push('How will we know when this task is successfully completed?');
    }
  }

  /**
   * Check for conflicting requirements
   */
  private checkForConflicts(description: string, issues: ValidationIssue[]): void {
    const lower = description.toLowerCase();

    // Check for performance vs feature conflicts
    if (lower.includes('all') && lower.includes('fast')) {
      issues.push({
        type: 'conflicting',
        severity: 'warning',
        field: 'requirements',
        message: 'Potential conflict: "all features" vs "fast performance"',
        suggestion: 'Prioritize: comprehensive features or optimized performance?'
      });
    }

    // Check for timeline conflicts
    if ((lower.includes('asap') || lower.includes('urgent')) &&
        (lower.includes('perfect') || lower.includes('comprehensive'))) {
      issues.push({
        type: 'conflicting',
        severity: 'warning',
        field: 'timeline',
        message: 'Conflict between urgency and perfection',
        suggestion: 'Choose priority: speed of delivery or completeness?'
      });
    }
  }

  /**
   * Analyze technical feasibility
   */
  private analyzeTechnicalFeasibility(description: string, issues: ValidationIssue[]): void {
    const lower = description.toLowerCase();

    // Check for potentially impossible requirements
    const impossibleTerms = ['100% uptime', 'no bugs', 'perfect', 'never fail', 'always work'];
    impossibleTerms.forEach(term => {
      if (lower.includes(term)) {
        issues.push({
          type: 'unclear',
          severity: 'warning',
          field: 'feasibility',
          message: `Unrealistic requirement: "${term}"`,
          suggestion: 'Consider setting realistic, measurable goals'
        });
      }
    });

    // Check for missing technical context
    if (lower.includes('integrate') && !lower.includes('with')) {
      issues.push({
        type: 'incomplete',
        severity: 'warning',
        field: 'integration',
        message: 'Integration mentioned but target system not specified',
        suggestion: 'Specify what system/service to integrate with'
      });
    }
  }

  /**
   * Calculate overall confidence score
   */
  private calculateConfidence(issues: ValidationIssue[]): number {
    let confidence = 100;

    issues.forEach(issue => {
      switch (issue.severity) {
        case 'critical':
          confidence -= 30;
          break;
        case 'warning':
          confidence -= 10;
          break;
        case 'info':
          confidence -= 2;
          break;
      }
    });

    return Math.max(0, confidence);
  }

  /**
   * Estimate clarity level
   */
  private estimateClarity(confidence: number): RequirementsAnalysis['estimatedClarity'] {
    if (confidence >= 90) return 'very_clear';
    if (confidence >= 75) return 'clear';
    if (confidence >= 60) return 'somewhat_clear';
    if (confidence >= 40) return 'unclear';
    return 'very_unclear';
  }

  /**
   * Make recommendation based on analysis
   */
  private makeRecommendation(
    confidence: number,
    issues: ValidationIssue[]
  ): RequirementsAnalysis['recommendation'] {
    const criticalIssues = issues.filter(i => i.severity === 'critical');

    // Only reject if there are multiple critical issues
    if (criticalIssues.length > 1) {
      return 'reject';
    }

    // Be more lenient with confidence threshold
    if (confidence < 40) {
      return 'clarify';
    }

    return 'proceed';
  }

  /**
   * Display analysis results
   */
  private displayAnalysis(analysis: RequirementsAnalysis): void {
    const separator = '═'.repeat(60);

    console.log(`\n${separator}`);
    console.log('📋 REQUIREMENTS VALIDATION REPORT');
    console.log(separator);

    // Overall status
    const statusEmoji = analysis.isValid ? '✅' : '❌';
    const clarityEmoji = {
      'very_clear': '🌟',
      'clear': '✨',
      'somewhat_clear': '🌤️',
      'unclear': '☁️',
      'very_unclear': '🌫️'
    }[analysis.estimatedClarity];

    console.log(`${statusEmoji} Valid: ${analysis.isValid}`);
    console.log(`📊 Confidence: ${analysis.confidence}%`);
    console.log(`${clarityEmoji} Clarity: ${analysis.estimatedClarity.replace('_', ' ')}`);
    console.log(`🎯 Recommendation: ${analysis.recommendation.toUpperCase()}`);

    // Issues
    if (analysis.issues.length > 0) {
      console.log(`\n⚠️ ISSUES FOUND (${analysis.issues.length}):`);
      console.log('─'.repeat(60));

      const criticalIssues = analysis.issues.filter(i => i.severity === 'critical');
      const warningIssues = analysis.issues.filter(i => i.severity === 'warning');
      const infoIssues = analysis.issues.filter(i => i.severity === 'info');

      if (criticalIssues.length > 0) {
        console.log('\n🔴 Critical:');
        criticalIssues.forEach(issue => {
          console.log(`  - ${issue.message}`);
          if (issue.suggestion) {
            console.log(`    💡 ${issue.suggestion}`);
          }
        });
      }

      if (warningIssues.length > 0) {
        console.log('\n🟡 Warnings:');
        warningIssues.forEach(issue => {
          console.log(`  - ${issue.message}`);
          if (issue.suggestion) {
            console.log(`    💡 ${issue.suggestion}`);
          }
        });
      }

      if (infoIssues.length > 0) {
        console.log('\n🔵 Info:');
        infoIssues.forEach(issue => {
          console.log(`  - ${issue.message}`);
        });
      }
    }

    // Clarification questions
    if (analysis.clarificationQuestions.length > 0) {
      console.log('\n❓ CLARIFICATION NEEDED:');
      console.log('─'.repeat(60));
      analysis.clarificationQuestions.forEach((q, i) => {
        console.log(`${i + 1}. ${q}`);
      });
    }

    // Requirements summary
    const totalReqs =
      analysis.requirements.functional.length +
      analysis.requirements.nonFunctional.length +
      analysis.requirements.acceptance.length;

    if (totalReqs > 0) {
      console.log('\n📝 EXTRACTED REQUIREMENTS:');
      console.log('─'.repeat(60));
      console.log(`  Functional: ${analysis.requirements.functional.length}`);
      console.log(`  Non-functional: ${analysis.requirements.nonFunctional.length}`);
      console.log(`  Acceptance criteria: ${analysis.requirements.acceptance.length}`);
    }

    // Final recommendation
    console.log('\n🎯 RECOMMENDATION:');
    console.log('─'.repeat(60));

    switch (analysis.recommendation) {
      case 'proceed':
        console.log('✅ Requirements are clear enough to proceed with execution.');
        break;
      case 'clarify':
        console.log('⚠️ Requirements need clarification before execution.');
        console.log('💡 Please answer the clarification questions above.');
        break;
      case 'reject':
        console.log('❌ Requirements are too incomplete or unclear to proceed.');
        console.log('💡 Please provide more detailed requirements.');
        break;
    }

    console.log(separator);
  }

  /**
   * Generate clarification prompt for user
   */
  generateClarificationPrompt(analysis: RequirementsAnalysis): string {
    const lines: string[] = [];

    lines.push('📋 Requirements need clarification:\n');

    if (analysis.clarificationQuestions.length > 0) {
      lines.push('Please answer these questions:\n');
      analysis.clarificationQuestions.forEach((q, i) => {
        lines.push(`${i + 1}. ${q}`);
      });
    }

    if (analysis.issues.filter(i => i.severity === 'critical').length > 0) {
      lines.push('\nCritical information missing:');
      analysis.issues
        .filter(i => i.severity === 'critical')
        .forEach(issue => {
          lines.push(`- ${issue.suggestion || issue.message}`);
        });
    }

    return lines.join('\n');
  }
}

// Singleton instance
const requirementsValidator = new RequirementsValidator();
export default requirementsValidator;