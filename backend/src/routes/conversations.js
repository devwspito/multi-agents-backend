const express = require('express');
const multer = require('multer');
const router = express.Router();
const AgentConversation = require('../models/AgentConversation');
const { authenticate, protectData } = require('../middleware/auth');

// Configure multer for image uploads in conversations (screenshots, error images, etc.)
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit per image
    files: 1 // Maximum 1 image per message
  },
  fileFilter: (req, file, cb) => {
    // OFFICIAL Claude API supported image types only
    const officialClaudeTypes = [
      'image/jpeg',
      'image/png', 
      'image/gif',
      'image/webp'
    ];
    
    if (officialClaudeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type. Claude API only supports: ${officialClaudeTypes.join(', ')}`), false);
    }
  }
});

// Create new conversation
router.post('/', authenticate, protectData, async (req, res) => {
  try {
    const {
      taskId,
      projectId,
      repositoryId,
      agentType,
      initialMessage
    } = req.body;

    // Validate required fields
    if (!taskId || !projectId || !agentType) {
      return res.status(400).json({
        success: false,
        message: 'taskId, projectId, and agentType are required'
      });
    }

    // Validate agent type
    const validAgentTypes = [
      'product-manager',
      'project-manager',
      'tech-lead',
      'senior-developer',
      'junior-developer',
      'qa-engineer'
    ];

    if (!validAgentTypes.includes(agentType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid agent type'
      });
    }

    // Create conversation
    const conversation = new AgentConversation({
      taskId,
      projectId,
      repositoryId,
      agentType,
      userId: req.user.id,
      messages: [],
      status: 'active'
    });

    // Add initial message if provided
    if (initialMessage) {
      conversation.addMessage('user', initialMessage);
    }

    await conversation.save();

    res.status(201).json({
      success: true,
      data: {
        conversationId: conversation._id,
        taskId: conversation.taskId,
        projectId: conversation.projectId,
        agentType: conversation.agentType,
        status: conversation.status,
        messageCount: conversation.messages.length
      }
    });

  } catch (error) {
    console.error('Error creating conversation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create conversation'
    });
  }
});

// Get conversation by ID
router.get('/:id', authenticate, async (req, res) => {
  try {
    const conversation = await AgentConversation
      .findById(req.params.id)
      .populate('taskId', 'title description status')
      .populate('projectId', 'name type status')
      .populate('userId', 'name email avatar');

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: 'Conversation not found'
      });
    }

    // Check if user has access to this conversation
    if (conversation.userId._id.toString() !== req.user.id) {
      // Check if user is a participant
      const isParticipant = conversation.participants.some(
        p => p.user.toString() === req.user.id && p.permissions.canView
      );

      if (!isParticipant) {
        return res.status(403).json({
          success: false,
          message: 'Access denied to this conversation'
        });
      }
    }

    res.json({
      success: true,
      data: conversation
    });

  } catch (error) {
    console.error('Error fetching conversation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch conversation'
    });
  }
});

// Add message to conversation with optional single image attachment
router.post('/:id/messages', authenticate, upload.single('attachment'), protectData, async (req, res) => {
  try {
    const { role, content, attachments = [], structured = null } = req.body;

    // Validate required fields
    if (!role || !content) {
      return res.status(400).json({
        success: false,
        message: 'role and content are required'
      });
    }

    // Validate role
    if (!['user', 'agent'].includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid role. Must be user or agent'
      });
    }

    const conversation = await AgentConversation.findById(req.params.id);

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: 'Conversation not found'
      });
    }

    // Check permissions
    if (conversation.userId.toString() !== req.user.id) {
      const participant = conversation.participants.find(
        p => p.user.toString() === req.user.id
      );

      if (!participant || !participant.permissions.canEdit) {
        return res.status(403).json({
          success: false,
          message: 'Permission denied to add messages'
        });
      }
    }

    // Process uploaded single image as attachment
    const uploadedFile = req.file;
    const processedAttachments = uploadedFile ? [{
      type: 'image',
      filename: `${Date.now()}-${uploadedFile.originalname}`,
      originalName: uploadedFile.originalname,
      size: uploadedFile.size,
      mimeType: uploadedFile.mimetype,
      // Store file buffer for Claude Code processing
      buffer: uploadedFile.buffer,
      metadata: {
        uploadedAt: new Date(),
        userId: req.user.id
      }
    }] : [];

    // Add message with processed attachment (if any)
    const message = conversation.addMessage(role, content, processedAttachments, structured);
    await conversation.save();

    res.status(201).json({
      success: true,
      data: {
        message: message,
        conversationId: conversation._id,
        messageCount: conversation.messages.length
      }
    });

  } catch (error) {
    console.error('Error adding message:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add message'
    });
  }
});

// Update Claude execution result
router.patch('/:id/execution', authenticate, protectData, async (req, res) => {
  try {
    const {
      model,
      workspacePath,
      instructions,
      executionTime,
      success,
      error,
      claudeSessionId,
      result
    } = req.body;

    const conversation = await AgentConversation.findById(req.params.id);

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: 'Conversation not found'
      });
    }

    // Check permissions
    if (conversation.userId.toString() !== req.user.id) {
      const participant = conversation.participants.find(
        p => p.user.toString() === req.user.id
      );

      if (!participant || !participant.permissions.canExecute) {
        return res.status(403).json({
          success: false,
          message: 'Permission denied to update execution'
        });
      }
    }

    // Update execution data
    const executionData = {
      model,
      workspacePath,
      instructions,
      executionTime,
      success,
      error,
      claudeSessionId
    };

    conversation.updateExecutionResult(executionData);

    // Update result if provided
    if (result) {
      conversation.result = {
        ...conversation.result,
        ...result
      };
    }

    await conversation.save();

    res.json({
      success: true,
      data: {
        conversationId: conversation._id,
        executionResult: conversation.claudeExecution,
        metrics: conversation.metrics
      }
    });

  } catch (error) {
    console.error('Error updating execution:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update execution result'
    });
  }
});

// Get conversations by task
router.get('/task/:taskId', authenticate, async (req, res) => {
  try {
    const { agentType } = req.query;

    const conversations = await AgentConversation.findByTask(
      req.params.taskId,
      agentType
    ).populate('userId', 'name email avatar');

    // Filter conversations user has access to
    const accessibleConversations = conversations.filter(conv => {
      if (conv.userId._id.toString() === req.user.id) return true;

      return conv.participants.some(
        p => p.user.toString() === req.user.id && p.permissions.canView
      );
    });

    res.json({
      success: true,
      data: accessibleConversations
    });

  } catch (error) {
    console.error('Error fetching conversations by task:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch conversations'
    });
  }
});

// Get unified conversation for task (all agents merged into single conversation)
router.get('/task/:taskId/unified', authenticate, async (req, res) => {
  try {
    const { taskId } = req.params;

    // Get all conversations for this task
    const conversations = await AgentConversation.findByTask(taskId)
      .populate('userId', 'name email avatar')
      .populate('taskId', 'title description status')
      .populate('projectId', 'name type');

    // Filter conversations user has access to
    const accessibleConversations = conversations.filter(conv => {
      if (conv.userId._id.toString() === req.user.id) return true;

      return conv.participants.some(
        p => p.user.toString() === req.user.id && p.permissions.canView
      );
    });

    if (accessibleConversations.length === 0) {
      return res.json({
        success: true,
        data: {
          conversationId: `unified-${taskId}`,
          taskId: taskId,
          messages: [],
          metadata: {
            totalConversations: 0,
            agents: []
          }
        }
      });
    }

    // Merge all messages from all conversations, sorted by timestamp
    const allMessages = [];
    const agentsInvolved = new Set();

    accessibleConversations.forEach(conv => {
      agentsInvolved.add(conv.agentType);

      conv.messages.forEach(msg => {
        allMessages.push({
          id: msg.id || msg._id.toString(),
          role: msg.role === 'agent' ? 'assistant' : msg.role,
          content: msg.content,
          timestamp: msg.timestamp,
          agent: msg.role === 'agent' ? conv.agentType : null,
          attachments: msg.attachments || [],
          structured: msg.structured || null
        });
      });
    });

    // Sort messages by timestamp
    allMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // Get task and project info from first conversation
    const firstConv = accessibleConversations[0];

    res.json({
      success: true,
      data: {
        conversationId: `unified-${taskId}`,
        taskId: firstConv.taskId,
        projectId: firstConv.projectId,
        messages: allMessages,
        metadata: {
          totalConversations: accessibleConversations.length,
          agents: Array.from(agentsInvolved),
          totalMessages: allMessages.length,
          lastUpdated: allMessages.length > 0
            ? allMessages[allMessages.length - 1].timestamp
            : null
        }
      }
    });

  } catch (error) {
    console.error('Error fetching unified conversation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch unified conversation'
    });
  }
});

// Get active conversations for user
router.get('/user/active', authenticate, async (req, res) => {
  try {
    const conversations = await AgentConversation
      .findActiveConversations(req.user.id)
      .populate('taskId', 'title description status')
      .populate('projectId', 'name type status');

    res.json({
      success: true,
      data: conversations
    });

  } catch (error) {
    console.error('Error fetching active conversations:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch active conversations'
    });
  }
});

// Archive conversation
router.patch('/:id/archive', authenticate, async (req, res) => {
  try {
    const conversation = await AgentConversation.findById(req.params.id);

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: 'Conversation not found'
      });
    }

    // Check permissions
    if (conversation.userId.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Permission denied to archive conversation'
      });
    }

    conversation.archive();
    await conversation.save();

    res.json({
      success: true,
      message: 'Conversation archived successfully'
    });

  } catch (error) {
    console.error('Error archiving conversation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to archive conversation'
    });
  }
});

// Get conversation metrics for project
router.get('/project/:projectId/metrics', authenticate, async (req, res) => {
  try {
    const { timeRange = 30 } = req.query;

    const metrics = await AgentConversation.getConversationMetrics(
      req.params.projectId,
      parseInt(timeRange)
    );

    res.json({
      success: true,
      data: metrics
    });

  } catch (error) {
    console.error('Error fetching conversation metrics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch conversation metrics'
    });
  }
});

module.exports = router;