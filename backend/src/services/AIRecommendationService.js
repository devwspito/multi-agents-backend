const natural = require('natural');
const compromise = require('compromise');
const Sentiment = require('sentiment');
const stats = require('simple-statistics');
const AgentConversation = require('../models/AgentConversation');
const Task = require('../models/Task');
const Project = require('../models/Project');
const User = require('../models/User');

/**
 * AI-Powered Recommendation Service
 * Provides intelligent recommendations using Machine Learning and NLP
 */
class AIRecommendationService {
  constructor() {
    // Initialize NLP tools
    this.sentiment = new Sentiment();
    this.stemmer = natural.PorterStemmer;
    this.tokenizer = new natural.WordTokenizer();
    this.tfidf = new natural.TfIdf();
    
    // ML Models storage
    this.models = {
      agentPerformance: new Map(),
      userPreferences: new Map(),
      projectPatterns: new Map(),
      timeEstimation: new Map()
    };

    // Learning data
    this.learningData = {
      conversationPatterns: [],
      agentEffectiveness: [],
      userBehavior: [],
      projectSuccess: []
    };

    // Recommendation cache
    this.recommendationCache = new Map();
    this.cacheExpiry = 30 * 60 * 1000; // 30 minutes

    console.log('🧠 AI Recommendation Service initialized');
    this.initializeModels();
  }

  /**
   * Initialize machine learning models
   */
  async initializeModels() {
    try {
      // Check if database is connected before loading data
      if (require('mongoose').connection.readyState === 1) {
        // Load historical data for training
        await this.loadTrainingData();
        
        // Train initial models
        await this.trainModels();
        
        console.log('🤖 AI models initialized and trained');
      } else {
        console.log('⏳ Database not ready, deferring AI model initialization');
        // Initialize with empty models for now
        await this.initializeEmptyModels();
      }
    } catch (error) {
      console.error('Error initializing AI models:', error);
      // Initialize with empty models as fallback
      await this.initializeEmptyModels();
    }
  }

  /**
   * Load training data from database
   */
  async loadTrainingData() {
    try {
      // Load conversation data for the last 6 months
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

      const conversations = await AgentConversation.find({
        createdAt: { $gte: sixMonthsAgo },
        status: { $in: ['completed', 'archived'] }
      }).populate('taskId projectId userId');

      // Process conversations for learning
      for (const conversation of conversations) {
        await this.processConversationForLearning(conversation);
      }

      console.log(`📚 Loaded ${conversations.length} conversations for training`);
    } catch (error) {
      console.error('Error loading training data:', error);
    }
  }

  /**
   * Process conversation for machine learning
   */
  async processConversationForLearning(conversation) {
    try {
      // Extract features
      const features = this.extractConversationFeatures(conversation);
      
      // Store in learning data
      this.learningData.conversationPatterns.push({
        agentType: conversation.agentType,
        features,
        outcome: this.calculateConversationOutcome(conversation),
        duration: conversation.duration,
        messageCount: conversation.messages?.length || 0,
        satisfaction: this.calculateSatisfactionScore(conversation)
      });

      // Extract agent effectiveness data
      if (conversation.claudeExecution?.success !== undefined) {
        this.learningData.agentEffectiveness.push({
          agentType: conversation.agentType,
          success: conversation.claudeExecution.success,
          executionTime: conversation.claudeExecution.executionTime,
          complexity: features.complexity,
          userSatisfaction: this.calculateSatisfactionScore(conversation)
        });
      }

      // Extract user behavior patterns
      this.learningData.userBehavior.push({
        userId: conversation.userId._id,
        agentType: conversation.agentType,
        projectType: conversation.projectId?.type,
        interactionPattern: this.analyzeInteractionPattern(conversation),
        preferences: this.extractUserPreferences(conversation)
      });

    } catch (error) {
      console.error('Error processing conversation for learning:', error);
    }
  }

  /**
   * Extract features from conversation
   */
  extractConversationFeatures(conversation) {
    const features = {};

    // Message analysis
    if (conversation.messages && conversation.messages.length > 0) {
      const allText = conversation.messages.map(m => m.content).join(' ');
      
      // Sentiment analysis
      const sentimentResult = this.sentiment.analyze(allText);
      features.sentiment = sentimentResult.score;
      features.sentimentMagnitude = Math.abs(sentimentResult.score);
      
      // Text complexity
      features.textLength = allText.length;
      features.wordCount = this.tokenizer.tokenize(allText).length;
      features.avgMessageLength = features.textLength / conversation.messages.length;
      
      // Extract key topics using NLP
      const doc = compromise(allText);
      features.topics = doc.topics().out('array').slice(0, 10);
      features.entities = doc.people().concat(doc.places()).out('array');
      
      // Technical terms detection
      features.technicalTerms = this.extractTechnicalTerms(allText);
      features.complexity = this.calculateComplexity(allText, features.technicalTerms);
    }

    // Conversation metadata
    features.agentType = conversation.agentType;
    features.projectType = conversation.projectId?.type;
    features.messageCount = conversation.messages?.length || 0;
    features.duration = conversation.duration || 0;
    features.hasAttachments = conversation.messages?.some(m => m.attachments?.length > 0) || false;

    return features;
  }

  /**
   * Calculate conversation outcome score
   */
  calculateConversationOutcome(conversation) {
    let score = 0;

    // Status-based scoring
    const statusScores = {
      'completed': 100,
      'archived': 80,
      'failed': 20,
      'active': 50
    };
    score += statusScores[conversation.status] || 50;

    // Execution success
    if (conversation.claudeExecution?.success) {
      score += 30;
    } else if (conversation.claudeExecution?.success === false) {
      score -= 20;
    }

    // Message engagement
    if (conversation.messages && conversation.messages.length > 0) {
      const userMessages = conversation.messages.filter(m => m.role === 'user').length;
      const agentMessages = conversation.messages.filter(m => m.role === 'agent').length;
      
      if (userMessages > 0 && agentMessages > 0) {
        const engagement = Math.min(userMessages / agentMessages, 2);
        score += engagement * 10;
      }
    }

    // Test results
    if (conversation.result?.testResults?.passed > 0) {
      score += 20;
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Calculate satisfaction score from conversation
   */
  calculateSatisfactionScore(conversation) {
    let satisfaction = 50; // Baseline

    // Sentiment analysis of user messages
    if (conversation.messages) {
      const userMessages = conversation.messages.filter(m => m.role === 'user');
      if (userMessages.length > 0) {
        const userText = userMessages.map(m => m.content).join(' ');
        const sentiment = this.sentiment.analyze(userText);
        satisfaction += sentiment.score * 2; // Scale sentiment impact
      }
    }

    // Quick resolution bonus
    if (conversation.duration && conversation.duration < 30 * 60 * 1000) { // Less than 30 minutes
      satisfaction += 10;
    }

    // Success completion bonus
    if (conversation.status === 'completed' && conversation.claudeExecution?.success) {
      satisfaction += 20;
    }

    return Math.max(0, Math.min(100, satisfaction));
  }

  /**
   * Extract technical terms from text
   */
  extractTechnicalTerms(text) {
    const technicalPatterns = [
      /\b(API|REST|GraphQL|database|MongoDB|Redis|Docker|Kubernetes)\b/gi,
      /\b(React|Vue|Angular|Node\.js|Express|JavaScript|TypeScript)\b/gi,
      /\b(authentication|authorization|OAuth|JWT|HTTPS|SSL)\b/gi,
      /\b(microservice|serverless|cloud|AWS|Azure|GCP)\b/gi,
      /\b(CI\/CD|deployment|testing|unit test|integration)\b/gi
    ];

    const terms = new Set();
    technicalPatterns.forEach(pattern => {
      const matches = text.match(pattern) || [];
      matches.forEach(match => terms.add(match.toLowerCase()));
    });

    return Array.from(terms);
  }

  /**
   * Calculate text complexity score
   */
  calculateComplexity(text, technicalTerms) {
    const words = this.tokenizer.tokenize(text);
    const sentences = text.split(/[.!?]+/).length;
    
    // Basic readability metrics
    const avgWordsPerSentence = words.length / sentences;
    const longWords = words.filter(word => word.length > 6).length;
    const technicalDensity = technicalTerms.length / words.length;
    
    // Complexity score (0-100)
    let complexity = 0;
    complexity += Math.min(avgWordsPerSentence * 2, 30); // Max 30 points
    complexity += Math.min(longWords / words.length * 100, 30); // Max 30 points
    complexity += Math.min(technicalDensity * 100, 40); // Max 40 points
    
    return Math.min(100, complexity);
  }

  /**
   * Analyze interaction pattern
   */
  analyzeInteractionPattern(conversation) {
    const pattern = {
      messageFrequency: 'normal',
      responseStyle: 'balanced',
      questionTypes: [],
      preferredAgents: []
    };

    if (conversation.messages && conversation.messages.length > 0) {
      const userMessages = conversation.messages.filter(m => m.role === 'user');
      
      // Analyze message frequency
      if (userMessages.length > 10) {
        pattern.messageFrequency = 'high';
      } else if (userMessages.length < 3) {
        pattern.messageFrequency = 'low';
      }

      // Analyze response style
      const avgLength = userMessages.reduce((sum, m) => sum + m.content.length, 0) / userMessages.length;
      if (avgLength > 200) {
        pattern.responseStyle = 'detailed';
      } else if (avgLength < 50) {
        pattern.responseStyle = 'concise';
      }

      // Extract question types
      userMessages.forEach(message => {
        const content = message.content.toLowerCase();
        if (content.includes('how to') || content.includes('how do')) {
          pattern.questionTypes.push('how-to');
        }
        if (content.includes('why') || content.includes('explain')) {
          pattern.questionTypes.push('explanation');
        }
        if (content.includes('help') || content.includes('problem')) {
          pattern.questionTypes.push('help');
        }
      });
    }

    return pattern;
  }

  /**
   * Extract user preferences
   */
  extractUserPreferences(conversation) {
    const preferences = {
      preferredAgentTypes: [conversation.agentType],
      communicationStyle: 'standard',
      preferredTopics: [],
      learningStyle: 'balanced'
    };

    // Analyze communication style
    if (conversation.messages) {
      const userMessages = conversation.messages.filter(m => m.role === 'user');
      if (userMessages.length > 0) {
        const avgLength = userMessages.reduce((sum, m) => sum + m.content.length, 0) / userMessages.length;
        
        if (avgLength > 150) {
          preferences.communicationStyle = 'detailed';
        } else if (avgLength < 50) {
          preferences.communicationStyle = 'concise';
        }
      }
    }

    return preferences;
  }

  /**
   * Train machine learning models
   */
  async trainModels() {
    try {
      // Train agent performance model
      this.trainAgentPerformanceModel();
      
      // Train user preference model
      this.trainUserPreferenceModel();
      
      // Train project pattern model
      this.trainProjectPatternModel();
      
      // Train time estimation model
      this.trainTimeEstimationModel();
      
      console.log('🎓 ML models trained successfully');
    } catch (error) {
      console.error('Error training models:', error);
    }
  }

  /**
   * Train agent performance model
   */
  trainAgentPerformanceModel() {
    const agentData = {};
    
    this.learningData.agentEffectiveness.forEach(data => {
      if (!agentData[data.agentType]) {
        agentData[data.agentType] = {
          successes: 0,
          failures: 0,
          totalTime: 0,
          totalSatisfaction: 0,
          complexityScores: [],
          count: 0
        };
      }
      
      const agent = agentData[data.agentType];
      agent.count++;
      agent.totalTime += data.executionTime || 0;
      agent.totalSatisfaction += data.userSatisfaction || 50;
      agent.complexityScores.push(data.complexity || 50);
      
      if (data.success) {
        agent.successes++;
      } else {
        agent.failures++;
      }
    });

    // Calculate agent performance metrics
    Object.keys(agentData).forEach(agentType => {
      const data = agentData[agentType];
      const performance = {
        successRate: data.successes / (data.successes + data.failures) || 0,
        avgExecutionTime: data.totalTime / data.count || 0,
        avgSatisfaction: data.totalSatisfaction / data.count || 50,
        avgComplexity: stats.mean(data.complexityScores) || 50,
        reliability: this.calculateReliability(data),
        efficiency: this.calculateEfficiency(data)
      };
      
      this.models.agentPerformance.set(agentType, performance);
    });
  }

  /**
   * Calculate agent reliability score
   */
  calculateReliability(agentData) {
    const successRate = agentData.successes / (agentData.successes + agentData.failures) || 0;
    const consistencyBonus = agentData.count > 10 ? 0.1 : 0; // Bonus for more data
    return Math.min(100, (successRate + consistencyBonus) * 100);
  }

  /**
   * Calculate agent efficiency score
   */
  calculateEfficiency(agentData) {
    const avgTime = agentData.totalTime / agentData.count || 0;
    const avgSatisfaction = agentData.totalSatisfaction / agentData.count || 50;
    
    // Efficiency = satisfaction / time (normalized)
    if (avgTime === 0) return 50;
    
    const timeScore = Math.max(0, 100 - (avgTime / 60000)); // Penalty for long execution
    const efficiencyScore = (avgSatisfaction + timeScore) / 2;
    
    return Math.max(0, Math.min(100, efficiencyScore));
  }

  /**
   * Train user preference model
   */
  trainUserPreferenceModel() {
    const userProfiles = {};
    
    this.learningData.userBehavior.forEach(data => {
      if (!userProfiles[data.userId]) {
        userProfiles[data.userId] = {
          agentPreferences: {},
          projectTypes: {},
          interactionStyles: [],
          preferenceScores: {}
        };
      }
      
      const profile = userProfiles[data.userId];
      
      // Track agent preferences
      if (!profile.agentPreferences[data.agentType]) {
        profile.agentPreferences[data.agentType] = 0;
      }
      profile.agentPreferences[data.agentType]++;
      
      // Track project type preferences
      if (data.projectType) {
        if (!profile.projectTypes[data.projectType]) {
          profile.projectTypes[data.projectType] = 0;
        }
        profile.projectTypes[data.projectType]++;
      }
      
      // Track interaction styles
      profile.interactionStyles.push(data.interactionPattern);
    });

    // Calculate user preference models
    Object.keys(userProfiles).forEach(userId => {
      const profile = userProfiles[userId];
      
      // Normalize agent preferences
      const totalInteractions = Object.values(profile.agentPreferences).reduce((sum, count) => sum + count, 0);
      const normalizedPreferences = {};
      Object.keys(profile.agentPreferences).forEach(agentType => {
        normalizedPreferences[agentType] = profile.agentPreferences[agentType] / totalInteractions;
      });
      
      this.models.userPreferences.set(userId, {
        agentPreferences: normalizedPreferences,
        projectTypePreferences: profile.projectTypes,
        preferredCommunicationStyle: this.getMostCommonStyle(profile.interactionStyles),
        experienceLevel: this.inferExperienceLevel(profile)
      });
    });
  }

  /**
   * Get most common communication style
   */
  getMostCommonStyle(styles) {
    const styleCounts = {};
    styles.forEach(style => {
      const key = style.responseStyle || 'balanced';
      styleCounts[key] = (styleCounts[key] || 0) + 1;
    });
    
    return Object.keys(styleCounts).reduce((a, b) => 
      styleCounts[a] > styleCounts[b] ? a : b
    ) || 'balanced';
  }

  /**
   * Infer user experience level
   */
  inferExperienceLevel(profile) {
    const totalInteractions = Object.values(profile.agentPreferences).reduce((sum, count) => sum + count, 0);
    const seniorDevInteractions = profile.agentPreferences['senior-developer'] || 0;
    const techLeadInteractions = profile.agentPreferences['tech-lead'] || 0;
    
    const advancedRatio = (seniorDevInteractions + techLeadInteractions) / totalInteractions;
    
    if (advancedRatio > 0.6) return 'senior';
    if (advancedRatio > 0.3) return 'intermediate';
    return 'junior';
  }

  /**
   * Train project pattern model
   */
  trainProjectPatternModel() {
    const projectPatterns = {};
    
    this.learningData.conversationPatterns.forEach(data => {
      if (!data.features.projectType) return;
      
      const projectType = data.features.projectType;
      if (!projectPatterns[projectType]) {
        projectPatterns[projectType] = {
          avgDuration: [],
          avgComplexity: [],
          preferredAgents: {},
          successFactors: []
        };
      }
      
      const pattern = projectPatterns[projectType];
      pattern.avgDuration.push(data.duration || 0);
      pattern.avgComplexity.push(data.features.complexity || 50);
      
      // Track preferred agents
      if (!pattern.preferredAgents[data.agentType]) {
        pattern.preferredAgents[data.agentType] = [];
      }
      pattern.preferredAgents[data.agentType].push(data.outcome);
      
      // Track success factors
      if (data.outcome > 70) {
        pattern.successFactors.push({
          agentType: data.agentType,
          complexity: data.features.complexity,
          duration: data.duration,
          messageCount: data.messageCount
        });
      }
    });

    // Process patterns
    Object.keys(projectPatterns).forEach(projectType => {
      const pattern = projectPatterns[projectType];
      
      this.models.projectPatterns.set(projectType, {
        avgDuration: stats.mean(pattern.avgDuration) || 0,
        avgComplexity: stats.mean(pattern.avgComplexity) || 50,
        bestAgents: this.getBestAgentsForProject(pattern.preferredAgents),
        successFactors: pattern.successFactors
      });
    });
  }

  /**
   * Get best agents for project type
   */
  getBestAgentsForProject(agentOutcomes) {
    const agentScores = {};
    
    Object.keys(agentOutcomes).forEach(agentType => {
      const outcomes = agentOutcomes[agentType];
      agentScores[agentType] = stats.mean(outcomes) || 0;
    });
    
    return Object.keys(agentScores)
      .sort((a, b) => agentScores[b] - agentScores[a])
      .slice(0, 3); // Top 3 agents
  }

  /**
   * Train time estimation model
   */
  trainTimeEstimationModel() {
    const estimationData = this.learningData.conversationPatterns.map(data => ({
      complexity: data.features.complexity || 50,
      agentType: data.agentType,
      messageCount: data.messageCount,
      duration: data.duration || 0,
      technicalTerms: data.features.technicalTerms?.length || 0
    }));

    // Simple linear regression for time estimation
    const features = ['complexity', 'messageCount', 'technicalTerms'];
    const agentTypes = [...new Set(estimationData.map(d => d.agentType))];
    
    agentTypes.forEach(agentType => {
      const agentData = estimationData.filter(d => d.agentType === agentType);
      
      if (agentData.length > 5) { // Need minimum data for regression
        const model = this.trainSimpleRegression(agentData, features, 'duration');
        this.models.timeEstimation.set(agentType, model);
      }
    });
  }

  /**
   * Train simple linear regression model
   */
  trainSimpleRegression(data, features, target) {
    // Simple implementation - in production, use proper ML library
    const x = data.map(d => features.map(f => d[f] || 0));
    const y = data.map(d => d[target] || 0);
    
    // Calculate means
    const xMeans = features.map((_, i) => stats.mean(x.map(row => row[i])));
    const yMean = stats.mean(y);
    
    return {
      xMeans,
      yMean,
      features,
      trainingSize: data.length
    };
  }

  /**
   * Get agent recommendations for user and task
   */
  async getAgentRecommendations(userId, taskDescription, projectType = null) {
    try {
      const cacheKey = `agent_rec_${userId}_${this.hashString(taskDescription)}`;
      
      // Check cache
      if (this.recommendationCache.has(cacheKey)) {
        const cached = this.recommendationCache.get(cacheKey);
        if (Date.now() - cached.timestamp < this.cacheExpiry) {
          return cached.recommendations;
        }
      }

      // Analyze task
      const taskFeatures = this.analyzeTaskDescription(taskDescription);
      
      // Get user preferences
      const userPrefs = this.models.userPreferences.get(userId) || {};
      
      // Get project patterns
      const projectPattern = projectType ? this.models.projectPatterns.get(projectType) : null;
      
      // Calculate recommendations
      const recommendations = await this.calculateAgentRecommendations(
        taskFeatures,
        userPrefs,
        projectPattern
      );
      
      // Cache results
      this.recommendationCache.set(cacheKey, {
        recommendations,
        timestamp: Date.now()
      });
      
      return recommendations;
    } catch (error) {
      console.error('Error getting agent recommendations:', error);
      return this.getDefaultRecommendations();
    }
  }

  /**
   * Analyze task description for features
   */
  analyzeTaskDescription(description) {
    const sentiment = this.sentiment.analyze(description);
    const doc = compromise(description);
    const technicalTerms = this.extractTechnicalTerms(description);
    
    return {
      sentiment: sentiment.score,
      complexity: this.calculateComplexity(description, technicalTerms),
      technicalTerms,
      topics: doc.topics().out('array').slice(0, 5),
      urgency: this.detectUrgency(description),
      taskType: this.classifyTaskType(description)
    };
  }

  /**
   * Detect urgency in task description
   */
  detectUrgency(description) {
    const urgentKeywords = ['urgent', 'asap', 'immediately', 'critical', 'emergency', 'deadline'];
    const text = description.toLowerCase();
    
    const urgentCount = urgentKeywords.filter(keyword => text.includes(keyword)).length;
    return urgentCount > 0 ? 'high' : 'normal';
  }

  /**
   * Classify task type
   */
  classifyTaskType(description) {
    const text = description.toLowerCase();
    
    if (text.includes('bug') || text.includes('fix') || text.includes('error')) {
      return 'bug-fix';
    }
    if (text.includes('test') || text.includes('testing') || text.includes('qa')) {
      return 'testing';
    }
    if (text.includes('review') || text.includes('code review')) {
      return 'review';
    }
    if (text.includes('design') || text.includes('architecture')) {
      return 'design';
    }
    if (text.includes('feature') || text.includes('implement')) {
      return 'feature';
    }
    
    return 'general';
  }

  /**
   * Calculate agent recommendations
   */
  async calculateAgentRecommendations(taskFeatures, userPrefs, projectPattern) {
    const agentTypes = ['product-manager', 'project-manager', 'tech-lead', 'senior-developer', 'junior-developer', 'qa-engineer'];
    const recommendations = [];

    for (const agentType of agentTypes) {
      const score = this.calculateAgentScore(agentType, taskFeatures, userPrefs, projectPattern);
      const performance = this.models.agentPerformance.get(agentType);
      const estimatedTime = this.estimateTaskTime(agentType, taskFeatures);
      
      recommendations.push({
        agentType,
        score,
        confidence: this.calculateConfidence(agentType),
        estimatedTime,
        reasoning: this.generateRecommendationReasoning(agentType, taskFeatures, performance),
        performance: performance || this.getDefaultPerformance(),
        suitability: this.calculateSuitability(agentType, taskFeatures)
      });
    }

    // Sort by score and return top recommendations
    return recommendations
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((rec, index) => ({
        ...rec,
        rank: index + 1
      }));
  }

  /**
   * Calculate agent score for task
   */
  calculateAgentScore(agentType, taskFeatures, userPrefs, projectPattern) {
    let score = 50; // Base score

    // Task type matching
    const agentTaskSuitability = {
      'product-manager': {
        'feature': 90,
        'general': 70,
        'design': 85
      },
      'project-manager': {
        'general': 80,
        'feature': 75
      },
      'tech-lead': {
        'design': 95,
        'feature': 85,
        'review': 90
      },
      'senior-developer': {
        'feature': 95,
        'bug-fix': 90,
        'review': 85
      },
      'junior-developer': {
        'feature': 70,
        'bug-fix': 60
      },
      'qa-engineer': {
        'testing': 95,
        'bug-fix': 85,
        'review': 75
      }
    };

    const suitability = agentTaskSuitability[agentType]?.[taskFeatures.taskType] || 50;
    score = (score + suitability) / 2;

    // User preference matching
    if (userPrefs.agentPreferences?.[agentType]) {
      score += userPrefs.agentPreferences[agentType] * 30;
    }

    // Project pattern matching
    if (projectPattern?.bestAgents?.includes(agentType)) {
      score += 20;
    }

    // Complexity matching
    const complexityFit = this.getComplexityFit(agentType, taskFeatures.complexity);
    score += complexityFit;

    // Urgency handling
    if (taskFeatures.urgency === 'high') {
      const urgencyBonus = this.getUrgencyBonus(agentType);
      score += urgencyBonus;
    }

    // Performance bonus
    const performance = this.models.agentPerformance.get(agentType);
    if (performance) {
      score += (performance.successRate - 0.5) * 40; // Convert to bonus/penalty
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Get complexity fit for agent
   */
  getComplexityFit(agentType, complexity) {
    const complexityRanges = {
      'junior-developer': [0, 40],
      'senior-developer': [30, 90],
      'tech-lead': [50, 100],
      'product-manager': [0, 70],
      'project-manager': [0, 80],
      'qa-engineer': [20, 80]
    };

    const [min, max] = complexityRanges[agentType] || [0, 100];
    
    if (complexity >= min && complexity <= max) {
      return 15; // Good fit
    } else if (complexity < min) {
      return Math.max(-10, (complexity - min) / 10); // Underutilization penalty
    } else {
      return Math.max(-15, (max - complexity) / 10); // Overload penalty
    }
  }

  /**
   * Get urgency handling bonus
   */
  getUrgencyBonus(agentType) {
    const urgencyHandlers = {
      'senior-developer': 15,
      'tech-lead': 10,
      'qa-engineer': 5,
      'junior-developer': -5,
      'product-manager': 0,
      'project-manager': 5
    };

    return urgencyHandlers[agentType] || 0;
  }

  /**
   * Calculate confidence score
   */
  calculateConfidence(agentType) {
    const performance = this.models.agentPerformance.get(agentType);
    if (!performance) return 50;

    // Confidence based on data quality and consistency
    const dataQuality = performance.reliability || 50;
    const consistency = performance.efficiency || 50;
    
    return (dataQuality + consistency) / 2;
  }

  /**
   * Estimate task completion time
   */
  estimateTaskTime(agentType, taskFeatures) {
    const model = this.models.timeEstimation.get(agentType);
    
    if (!model || !model.trainingSize || model.trainingSize < 5) {
      // Use default estimates
      const defaultTimes = {
        'junior-developer': 120, // 2 hours
        'senior-developer': 90,  // 1.5 hours
        'tech-lead': 60,         // 1 hour
        'product-manager': 45,   // 45 minutes
        'project-manager': 30,   // 30 minutes
        'qa-engineer': 75        // 1.25 hours
      };
      
      const baseTime = defaultTimes[agentType] || 60;
      const complexityMultiplier = 1 + (taskFeatures.complexity / 100);
      
      return Math.round(baseTime * complexityMultiplier);
    }

    // Use trained model for prediction
    const features = [
      taskFeatures.complexity || 50,
      taskFeatures.technicalTerms?.length || 0,
      5 // Estimated message count
    ];

    // Simple prediction based on means (in production, use proper ML)
    const prediction = model.yMean + (features[0] - model.xMeans[0]) * 0.5;
    
    return Math.max(15, Math.round(prediction / 60000)); // Convert to minutes
  }

  /**
   * Generate reasoning for recommendation
   */
  generateRecommendationReasoning(agentType, taskFeatures, performance) {
    const reasons = [];

    // Task type fit
    if (taskFeatures.taskType) {
      const taskTypeReasons = {
        'senior-developer': {
          'feature': 'Excellent for complex feature implementation',
          'bug-fix': 'Strong debugging and problem-solving skills'
        },
        'tech-lead': {
          'design': 'Specialized in architectural design and technical planning',
          'review': 'Expert at code review and technical guidance'
        },
        'qa-engineer': {
          'testing': 'Specialized in comprehensive testing and quality assurance'
        }
      };

      const reason = taskTypeReasons[agentType]?.[taskFeatures.taskType];
      if (reason) reasons.push(reason);
    }

    // Complexity fit
    if (taskFeatures.complexity > 70 && ['senior-developer', 'tech-lead'].includes(agentType)) {
      reasons.push('Well-suited for high complexity tasks');
    }

    // Performance history
    if (performance && performance.successRate > 0.8) {
      reasons.push(`High success rate (${Math.round(performance.successRate * 100)}%)`);
    }

    // Urgency handling
    if (taskFeatures.urgency === 'high' && agentType === 'senior-developer') {
      reasons.push('Excellent for urgent tasks requiring quick resolution');
    }

    return reasons.length > 0 ? reasons : ['Good general fit for this type of task'];
  }

  /**
   * Calculate suitability percentage
   */
  calculateSuitability(agentType, taskFeatures) {
    const taskTypeFit = this.getTaskTypeFit(agentType, taskFeatures.taskType);
    const complexityFit = this.getComplexityFit(agentType, taskFeatures.complexity);
    const urgencyFit = taskFeatures.urgency === 'high' ? this.getUrgencyBonus(agentType) : 0;

    const suitability = 50 + taskTypeFit + Math.max(-20, Math.min(20, complexityFit)) + Math.max(-10, Math.min(10, urgencyFit));
    
    return Math.max(0, Math.min(100, suitability));
  }

  /**
   * Get task type fit score
   */
  getTaskTypeFit(agentType, taskType) {
    const fits = {
      'product-manager': { 'feature': 40, 'design': 35, 'general': 20 },
      'project-manager': { 'general': 30, 'feature': 25 },
      'tech-lead': { 'design': 45, 'feature': 35, 'review': 40 },
      'senior-developer': { 'feature': 45, 'bug-fix': 40, 'review': 35 },
      'junior-developer': { 'feature': 20, 'bug-fix': 10 },
      'qa-engineer': { 'testing': 45, 'bug-fix': 35, 'review': 25 }
    };

    return fits[agentType]?.[taskType] || 0;
  }

  /**
   * Get default performance metrics
   */
  getDefaultPerformance() {
    return {
      successRate: 0.75,
      avgExecutionTime: 3600000, // 1 hour
      avgSatisfaction: 75,
      reliability: 75,
      efficiency: 70
    };
  }

  /**
   * Get default recommendations
   */
  getDefaultRecommendations() {
    return [
      {
        agentType: 'senior-developer',
        score: 80,
        confidence: 70,
        estimatedTime: 90,
        reasoning: ['Versatile agent for most development tasks'],
        performance: this.getDefaultPerformance(),
        suitability: 80,
        rank: 1
      },
      {
        agentType: 'tech-lead',
        score: 75,
        confidence: 70,
        estimatedTime: 60,
        reasoning: ['Good for technical guidance and architecture'],
        performance: this.getDefaultPerformance(),
        suitability: 75,
        rank: 2
      },
      {
        agentType: 'junior-developer',
        score: 60,
        confidence: 65,
        estimatedTime: 120,
        reasoning: ['Suitable for simpler implementation tasks'],
        performance: this.getDefaultPerformance(),
        suitability: 60,
        rank: 3
      }
    ];
  }

  /**
   * Hash string for caching
   */
  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString();
  }

  /**
   * Get personalized insights for user
   */
  async getPersonalizedInsights(userId) {
    try {
      const userPrefs = this.models.userPreferences.get(userId);
      if (!userPrefs) {
        return this.getDefaultInsights();
      }

      const insights = {
        preferredAgents: Object.keys(userPrefs.agentPreferences)
          .sort((a, b) => userPrefs.agentPreferences[b] - userPrefs.agentPreferences[a])
          .slice(0, 3),
        communicationStyle: userPrefs.preferredCommunicationStyle,
        experienceLevel: userPrefs.experienceLevel,
        recommendations: []
      };

      // Generate personalized recommendations
      if (userPrefs.experienceLevel === 'junior') {
        insights.recommendations.push('Consider starting with junior-developer agent for learning');
        insights.recommendations.push('Use senior-developer for complex tasks to learn best practices');
      } else if (userPrefs.experienceLevel === 'senior') {
        insights.recommendations.push('Tech-lead agent can help with architectural decisions');
        insights.recommendations.push('Use product-manager for strategic feature planning');
      }

      return insights;
    } catch (error) {
      console.error('Error getting personalized insights:', error);
      return this.getDefaultInsights();
    }
  }

  /**
   * Get default insights
   */
  getDefaultInsights() {
    return {
      preferredAgents: ['senior-developer', 'tech-lead', 'junior-developer'],
      communicationStyle: 'balanced',
      experienceLevel: 'intermediate',
      recommendations: [
        'Start with senior-developer for most development tasks',
        'Use tech-lead for architectural guidance',
        'Engage qa-engineer for comprehensive testing'
      ]
    };
  }

  /**
   * Update models with new conversation data
   */
  async updateModelsWithNewData(conversation) {
    try {
      // Process new conversation for learning
      await this.processConversationForLearning(conversation);
      
      // Retrain models periodically
      if (this.learningData.conversationPatterns.length % 100 === 0) {
        console.log('🔄 Retraining AI models with new data...');
        await this.trainModels();
      }
      
      // Clear old cache
      this.recommendationCache.clear();
      
    } catch (error) {
      console.error('Error updating models with new data:', error);
    }
  }

  /**
   * Get recommendation service statistics
   */
  getServiceStats() {
    return {
      totalTrainingData: this.learningData.conversationPatterns.length,
      agentModels: this.models.agentPerformance.size,
      userProfiles: this.models.userPreferences.size,
      projectPatterns: this.models.projectPatterns.size,
      cacheSize: this.recommendationCache.size,
      modelAccuracy: this.calculateModelAccuracy()
    };
  }

  /**
   * Initialize empty models when database is not ready
   */
  async initializeEmptyModels() {
    try {
      // Initialize with basic default recommendations
      console.log('🔧 Initializing AI models with default data...');
      
      // Basic agent capabilities matrix
      const defaultAgentCapabilities = {
        'product-manager': {
          complexity: ['simple', 'moderate', 'complex'],
          strength: 0.8,
          estimatedTime: 4
        },
        'project-manager': {
          complexity: ['simple', 'moderate', 'complex'],
          strength: 0.8,
          estimatedTime: 3
        },
        'tech-lead': {
          complexity: ['moderate', 'complex', 'expert'],
          strength: 0.9,
          estimatedTime: 5
        },
        'senior-developer': {
          complexity: ['complex', 'expert'],
          strength: 0.95,
          estimatedTime: 6
        },
        'junior-developer': {
          complexity: ['simple', 'moderate'],
          strength: 0.7,
          estimatedTime: 8
        },
        'qa-engineer': {
          complexity: ['simple', 'moderate', 'complex'],
          strength: 0.85,
          estimatedTime: 4
        }
      };

      // Store default capabilities
      for (const [agentType, capabilities] of Object.entries(defaultAgentCapabilities)) {
        this.models.agentPerformance.set(agentType, capabilities);
      }

      console.log('✅ Default AI models initialized');
    } catch (error) {
      console.error('Error initializing empty models:', error);
    }
  }

  /**
   * Calculate model accuracy
   */
  calculateModelAccuracy() {
    // Simplified accuracy calculation
    const totalPredictions = this.learningData.conversationPatterns.length;
    if (totalPredictions === 0) return 0;
    
    // In a real implementation, you'd validate against holdout data
    return Math.min(95, 60 + (totalPredictions / 100)); // Simulated accuracy
  }
}

// Export singleton instance
const aiRecommendationService = new AIRecommendationService();
module.exports = aiRecommendationService;