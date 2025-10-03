const Queue = require('bull');
const Redis = require('ioredis');
const AgentConversation = require('../models/AgentConversation');
const User = require('../models/User');

/**
 * Notification Service for Real-time Alerts and Push Notifications
 * Handles various types of notifications for agent interactions
 */
class NotificationService {
  constructor() {
    // Redis connection for queues
    this.redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    
    // Notification queues
    this.notificationQueue = new Queue('notifications', {
      redis: { port: 6379, host: 'localhost' },
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 3,
        backoff: 'exponential'
      }
    });

    this.emailQueue = new Queue('email notifications', {
      redis: { port: 6379, host: 'localhost' }
    });

    this.setupQueueProcessors();
    console.log('📢 Notification Service initialized');
  }

  /**
   * Setup queue processors
   */
  setupQueueProcessors() {
    // Process in-app notifications
    this.notificationQueue.process('send_notification', async (job) => {
      const { userId, type, title, message, data, priority } = job.data;
      return await this.processInAppNotification(userId, type, title, message, data, priority);
    });

    // Process email notifications
    this.emailQueue.process('send_email', async (job) => {
      const { to, subject, template, data } = job.data;
      return await this.processEmailNotification(to, subject, template, data);
    });

    // Process agent execution notifications
    this.notificationQueue.process('agent_execution_notification', async (job) => {
      const { conversationId, agentType, status, result } = job.data;
      return await this.processAgentExecutionNotification(conversationId, agentType, status, result);
    });
  }

  /**
   * Send notification when agent execution starts
   */
  async notifyAgentExecutionStart(conversationId, agentType, executedBy) {
    try {
      const conversation = await AgentConversation.findById(conversationId)
        .populate('userId', 'name email preferences')
        .populate('participants.user', 'name email preferences');

      // Notify conversation owner
      if (conversation.userId._id.toString() !== executedBy) {
        await this.queueNotification({
          userId: conversation.userId._id,
          type: 'agent_execution_start',
          title: `${agentType} Started`,
          message: `Agent execution started in your conversation`,
          data: { conversationId, agentType },
          priority: 'normal'
        });
      }

      // Notify participants
      for (const participant of conversation.participants) {
        if (participant.user._id.toString() !== executedBy && participant.permissions.canView) {
          await this.queueNotification({
            userId: participant.user._id,
            type: 'agent_execution_start',
            title: `${agentType} Started`,
            message: `Agent execution started in conversation`,
            data: { conversationId, agentType },
            priority: 'normal'
          });
        }
      }

      console.log(`📢 Notified users about agent execution start: ${agentType}`);
    } catch (error) {
      console.error('Error sending agent execution start notification:', error);
    }
  }

  /**
   * Send notification when agent execution completes
   */
  async notifyAgentExecutionComplete(conversationId, agentType, success, result, executedBy) {
    try {
      const conversation = await AgentConversation.findById(conversationId)
        .populate('userId', 'name email preferences')
        .populate('participants.user', 'name email preferences');

      const title = success ? `${agentType} Completed` : `${agentType} Failed`;
      const message = success 
        ? `Agent execution completed successfully`
        : `Agent execution failed - please review`;

      const priority = success ? 'normal' : 'high';

      // Notify conversation owner
      if (conversation.userId._id.toString() !== executedBy) {
        await this.queueNotification({
          userId: conversation.userId._id,
          type: success ? 'agent_execution_success' : 'agent_execution_failure',
          title,
          message,
          data: { conversationId, agentType, result },
          priority
        });

        // Send email for failures or important completions
        if (!success || this.shouldSendEmail(conversation.userId.preferences)) {
          await this.queueEmail({
            to: conversation.userId.email,
            subject: title,
            template: 'agent_execution_complete',
            data: { agentType, success, result, conversationId }
          });
        }
      }

      // Notify participants
      for (const participant of conversation.participants) {
        if (participant.user._id.toString() !== executedBy && participant.permissions.canView) {
          await this.queueNotification({
            userId: participant.user._id,
            type: success ? 'agent_execution_success' : 'agent_execution_failure',
            title,
            message,
            data: { conversationId, agentType, result },
            priority
          });
        }
      }

      console.log(`📢 Notified users about agent execution completion: ${agentType} - ${success ? 'Success' : 'Failure'}`);
    } catch (error) {
      console.error('Error sending agent execution completion notification:', error);
    }
  }

  /**
   * Send notification for new messages
   */
  async notifyNewMessage(conversationId, messageId, senderId) {
    try {
      const conversation = await AgentConversation.findById(conversationId)
        .populate('userId', 'name email preferences')
        .populate('participants.user', 'name email preferences');

      const sender = await User.findById(senderId).select('name username');
      
      // Notify conversation owner
      if (conversation.userId._id.toString() !== senderId) {
        await this.queueNotification({
          userId: conversation.userId._id,
          type: 'new_message',
          title: 'New Message',
          message: `${sender.name} sent a message`,
          data: { conversationId, messageId, senderId },
          priority: 'normal'
        });
      }

      // Notify participants
      for (const participant of conversation.participants) {
        if (participant.user._id.toString() !== senderId && participant.permissions.canView) {
          await this.queueNotification({
            userId: participant.user._id,
            type: 'new_message',
            title: 'New Message',
            message: `${sender.name} sent a message`,
            data: { conversationId, messageId, senderId },
            priority: 'normal'
          });
        }
      }

      console.log(`📢 Notified users about new message in conversation ${conversationId}`);
    } catch (error) {
      console.error('Error sending new message notification:', error);
    }
  }

  /**
   * Send notification for code review requests
   */
  async notifyCodeReviewRequest(conversationId, requesterId, reviewerAgentType, codeSnippet) {
    try {
      const conversation = await AgentConversation.findById(conversationId)
        .populate('userId', 'name email preferences')
        .populate('participants.user', 'name email preferences');

      const requester = await User.findById(requesterId).select('name username');

      // Find users who can handle this agent type review
      const eligibleReviewers = await this.findEligibleReviewers(reviewerAgentType);

      for (const reviewer of eligibleReviewers) {
        await this.queueNotification({
          userId: reviewer._id,
          type: 'code_review_request',
          title: 'Code Review Requested',
          message: `${requester.name} requested ${reviewerAgentType} review`,
          data: { 
            conversationId, 
            requesterId, 
            reviewerAgentType, 
            codeSnippet: codeSnippet.substring(0, 200) + '...' 
          },
          priority: 'high'
        });

        // Send email for code review requests
        await this.queueEmail({
          to: reviewer.email,
          subject: 'Code Review Request',
          template: 'code_review_request',
          data: { requester: requester.name, agentType: reviewerAgentType, conversationId }
        });
      }

      console.log(`📢 Notified eligible reviewers about code review request: ${reviewerAgentType}`);
    } catch (error) {
      console.error('Error sending code review notification:', error);
    }
  }

  /**
   * Send system-wide notifications
   */
  async broadcastSystemNotification(title, message, type = 'info', targetUsers = null) {
    try {
      const notification = {
        type: 'system_notification',
        title,
        message,
        data: { systemWide: true, notificationType: type },
        priority: type === 'critical' ? 'urgent' : 'normal'
      };

      if (targetUsers) {
        // Send to specific users
        for (const userId of targetUsers) {
          await this.queueNotification({
            ...notification,
            userId
          });
        }
      } else {
        // Send to all active users
        const activeUsers = await User.find({ isActive: true }).select('_id');
        for (const user of activeUsers) {
          await this.queueNotification({
            ...notification,
            userId: user._id
          });
        }
      }

      console.log(`📢 Broadcasted system notification: ${title}`);
    } catch (error) {
      console.error('Error broadcasting system notification:', error);
    }
  }

  /**
   * Send notification for agent handoff
   */
  async notifyAgentHandoff(conversationId, fromAgent, toAgent, context, initiatedBy) {
    try {
      const conversation = await AgentConversation.findById(conversationId)
        .populate('userId', 'name email preferences')
        .populate('participants.user', 'name email preferences');

      const initiator = await User.findById(initiatedBy).select('name username');

      // Find users eligible for the target agent
      const eligibleUsers = await this.findEligibleReviewers(toAgent);

      for (const user of eligibleUsers) {
        await this.queueNotification({
          userId: user._id,
          type: 'agent_handoff',
          title: 'Agent Handoff',
          message: `${initiator.name} requested ${fromAgent} → ${toAgent} handoff`,
          data: { conversationId, fromAgent, toAgent, context },
          priority: 'high'
        });
      }

      console.log(`📢 Notified eligible users about agent handoff: ${fromAgent} → ${toAgent}`);
    } catch (error) {
      console.error('Error sending agent handoff notification:', error);
    }
  }

  /**
   * Queue a notification for processing
   */
  async queueNotification(notificationData) {
    return await this.notificationQueue.add('send_notification', notificationData, {
      priority: this.getPriorityValue(notificationData.priority)
    });
  }

  /**
   * Queue an email for processing
   */
  async queueEmail(emailData) {
    return await this.emailQueue.add('send_email', emailData);
  }

  /**
   * Process in-app notification
   */
  async processInAppNotification(userId, type, title, message, data, priority) {
    try {
      // Store notification in database (you'd implement a Notification model)
      const notification = {
        userId,
        type,
        title,
        message,
        data,
        priority,
        read: false,
        createdAt: new Date()
      };

      // Store in Redis for real-time delivery
      await this.redis.lpush(
        `notifications:${userId}`, 
        JSON.stringify(notification)
      );

      // Keep only last 100 notifications per user
      await this.redis.ltrim(`notifications:${userId}`, 0, 99);

      // Emit to user via Socket.IO if available
      const socketService = require('./SocketService');
      socketService.emitToUser(userId, 'new_notification', notification);

      return { success: true, notificationId: `${userId}_${Date.now()}` };
    } catch (error) {
      console.error('Error processing in-app notification:', error);
      throw error;
    }
  }

  /**
   * Process email notification
   */
  async processEmailNotification(to, subject, template, data) {
    try {
      // In a real implementation, you'd use a service like SendGrid, Mailgun, etc.
      console.log(`📧 Email would be sent to ${to} with subject: ${subject}`);
      
      // Simulate email sending
      const emailContent = this.generateEmailContent(template, data);
      
      // Log email for development
      console.log('Email Content:', emailContent);
      
      return { success: true, emailId: `email_${Date.now()}` };
    } catch (error) {
      console.error('Error processing email notification:', error);
      throw error;
    }
  }

  /**
   * Find users eligible for specific agent type
   */
  async findEligibleReviewers(agentType) {
    // This would depend on your user role/permission system
    const specializations = {
      'senior-developer': ['senior-developer', 'tech-lead'],
      'tech-lead': ['tech-lead'],
      'qa-engineer': ['qa-engineer', 'tech-lead'],
      'product-manager': ['product-manager'],
      'project-manager': ['project-manager', 'tech-lead']
    };

    const eligibleSpecializations = specializations[agentType] || [agentType];
    
    return await User.find({
      isActive: true,
      specializations: { $in: eligibleSpecializations }
    }).select('_id name email specializations');
  }

  /**
   * Check if user should receive email notifications
   */
  shouldSendEmail(userPreferences) {
    return userPreferences?.emailNotifications !== false;
  }

  /**
   * Get priority value for queue processing
   */
  getPriorityValue(priority) {
    const priorityMap = {
      'urgent': 1,
      'high': 2,
      'normal': 3,
      'low': 4
    };
    return priorityMap[priority] || 3;
  }

  /**
   * Generate email content from template
   */
  generateEmailContent(template, data) {
    const templates = {
      agent_execution_complete: `
        Agent ${data.agentType} execution ${data.success ? 'completed successfully' : 'failed'}.
        
        Conversation: ${data.conversationId}
        Result: ${JSON.stringify(data.result, null, 2)}
      `,
      code_review_request: `
        ${data.requester} has requested a code review from ${data.agentType}.
        
        Please review the code in conversation: ${data.conversationId}
      `
    };

    return templates[template] || `Notification: ${JSON.stringify(data)}`;
  }

  /**
   * Get user notifications
   */
  async getUserNotifications(userId, limit = 20) {
    try {
      const notifications = await this.redis.lrange(`notifications:${userId}`, 0, limit - 1);
      return notifications.map(n => JSON.parse(n));
    } catch (error) {
      console.error('Error getting user notifications:', error);
      return [];
    }
  }

  /**
   * Mark notification as read
   */
  async markNotificationRead(userId, notificationIndex) {
    try {
      // In a real implementation, you'd update the notification record
      console.log(`Marked notification ${notificationIndex} as read for user ${userId}`);
      return true;
    } catch (error) {
      console.error('Error marking notification as read:', error);
      return false;
    }
  }

  /**
   * Get notification statistics
   */
  async getNotificationStats() {
    try {
      const stats = {
        totalNotifications: await this.notificationQueue.getJobCounts(),
        emailsInQueue: await this.emailQueue.getJobCounts(),
        activeNotifications: await this.notificationQueue.getActive(),
        failedNotifications: await this.notificationQueue.getFailed()
      };
      
      return stats;
    } catch (error) {
      console.error('Error getting notification stats:', error);
      return {};
    }
  }

  /**
   * Cleanup old notifications
   */
  async cleanupOldNotifications(daysOld = 30) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);
      
      // In a real implementation, you'd clean up from database
      console.log(`Would cleanup notifications older than ${cutoffDate}`);
      
      return true;
    } catch (error) {
      console.error('Error cleaning up old notifications:', error);
      return false;
    }
  }
}

// Export singleton instance
const notificationService = new NotificationService();
module.exports = notificationService;