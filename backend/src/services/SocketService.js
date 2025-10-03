const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const AgentConversation = require('../models/AgentConversation');
const User = require('../models/User');

/**
 * Real-time Socket Service for Agent Conversations
 * Handles WebSocket connections for instant messaging and collaboration
 */
class SocketService {
  constructor() {
    this.io = null;
    this.connectedUsers = new Map(); // userId -> socket mapping
    this.activeConversations = new Map(); // conversationId -> Set of socketIds
    this.typingUsers = new Map(); // conversationId -> Set of userIds typing
  }

  /**
   * Initialize Socket.IO server
   */
  initialize(httpServer) {
    this.io = new Server(httpServer, {
      cors: {
        origin: process.env.FRONTEND_URL || "http://localhost:3001",
        methods: ["GET", "POST"],
        credentials: true
      },
      pingTimeout: 60000,
      pingInterval: 25000
    });

    this.setupSocketHandlers();
    console.log('🔌 Socket.IO server initialized for real-time conversations');
  }

  /**
   * Setup socket event handlers
   */
  setupSocketHandlers() {
    this.io.use(this.authenticateSocket.bind(this));

    this.io.on('connection', (socket) => {
      console.log(`👤 User ${socket.user.username} connected - Socket: ${socket.id}`);
      
      // Store user connection
      this.connectedUsers.set(socket.user._id.toString(), socket);
      
      // Join user to their personal room
      socket.join(`user:${socket.user._id}`);
      
      // Emit user online status
      this.broadcastUserStatus(socket.user._id, 'online');

      // Socket event handlers
      this.setupConversationHandlers(socket);
      this.setupTypingHandlers(socket);
      this.setupAgentExecutionHandlers(socket);
      this.setupCollaborationHandlers(socket);

      // Handle disconnection
      socket.on('disconnect', () => {
        this.handleDisconnection(socket);
      });
    });
  }

  /**
   * Authenticate socket connections
   */
  async authenticateSocket(socket, next) {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];
      
      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select('-password');
      
      if (!user || !user.isActive) {
        return next(new Error('Authentication error: Invalid user'));
      }

      socket.user = user;
      next();
    } catch (error) {
      next(new Error('Authentication error: Invalid token'));
    }
  }

  /**
   * Setup conversation-related socket handlers
   */
  setupConversationHandlers(socket) {
    // Join conversation room
    socket.on('join_conversation', async (data) => {
      try {
        const { conversationId } = data;
        
        // Verify user has access to conversation
        const conversation = await AgentConversation.findById(conversationId);
        if (!conversation) {
          return socket.emit('error', { message: 'Conversation not found' });
        }

        if (!this.userCanAccessConversation(socket.user, conversation)) {
          return socket.emit('error', { message: 'Access denied to conversation' });
        }

        // Join conversation room
        socket.join(`conversation:${conversationId}`);
        
        // Track active conversation
        if (!this.activeConversations.has(conversationId)) {
          this.activeConversations.set(conversationId, new Set());
        }
        this.activeConversations.get(conversationId).add(socket.id);

        // Notify other participants
        socket.to(`conversation:${conversationId}`).emit('user_joined_conversation', {
          userId: socket.user._id,
          username: socket.user.username,
          avatar: socket.user.avatar
        });

        console.log(`👤 ${socket.user.username} joined conversation ${conversationId}`);
      } catch (error) {
        socket.emit('error', { message: 'Failed to join conversation' });
      }
    });

    // Leave conversation room
    socket.on('leave_conversation', (data) => {
      const { conversationId } = data;
      socket.leave(`conversation:${conversationId}`);
      
      // Remove from active conversations
      if (this.activeConversations.has(conversationId)) {
        this.activeConversations.get(conversationId).delete(socket.id);
        if (this.activeConversations.get(conversationId).size === 0) {
          this.activeConversations.delete(conversationId);
        }
      }

      // Notify other participants
      socket.to(`conversation:${conversationId}`).emit('user_left_conversation', {
        userId: socket.user._id,
        username: socket.user.username
      });

      console.log(`👤 ${socket.user.username} left conversation ${conversationId}`);
    });

    // Handle new message
    socket.on('send_message', async (data) => {
      try {
        const { conversationId, content, attachments = [] } = data;
        
        // Validate and save message
        const conversation = await AgentConversation.findById(conversationId);
        if (!conversation || !this.userCanAccessConversation(socket.user, conversation)) {
          return socket.emit('error', { message: 'Cannot send message to this conversation' });
        }

        // Add message to conversation
        const message = conversation.addMessage('user', content, attachments);
        await conversation.save();

        // Broadcast message to all participants
        this.io.to(`conversation:${conversationId}`).emit('new_message', {
          conversationId,
          message: {
            id: message.id,
            role: message.role,
            content: message.content,
            timestamp: message.timestamp,
            attachments: message.attachments,
            user: {
              id: socket.user._id,
              username: socket.user.username,
              avatar: socket.user.avatar
            }
          }
        });

        // Stop typing for this user
        this.handleStopTyping(socket, conversationId);

        console.log(`💬 Message sent in conversation ${conversationId} by ${socket.user.username}`);
      } catch (error) {
        socket.emit('error', { message: 'Failed to send message' });
      }
    });
  }

  /**
   * Setup typing indicators
   */
  setupTypingHandlers(socket) {
    socket.on('start_typing', (data) => {
      const { conversationId } = data;
      this.handleStartTyping(socket, conversationId);
    });

    socket.on('stop_typing', (data) => {
      const { conversationId } = data;
      this.handleStopTyping(socket, conversationId);
    });
  }

  /**
   * Setup agent execution handlers
   */
  setupAgentExecutionHandlers(socket) {
    // Agent execution started
    socket.on('agent_execution_start', (data) => {
      const { conversationId, agentType, instructions } = data;
      
      socket.to(`conversation:${conversationId}`).emit('agent_execution_started', {
        conversationId,
        agentType,
        executedBy: socket.user.username,
        timestamp: new Date().toISOString()
      });
    });

    // Agent execution progress update
    socket.on('agent_execution_progress', (data) => {
      const { conversationId, progress, currentStep } = data;
      
      socket.to(`conversation:${conversationId}`).emit('agent_execution_progress', {
        conversationId,
        progress,
        currentStep,
        timestamp: new Date().toISOString()
      });
    });

    // Agent execution completed
    socket.on('agent_execution_complete', async (data) => {
      try {
        const { conversationId, result, executionTime, success } = data;
        
        // Update conversation with execution result
        const conversation = await AgentConversation.findById(conversationId);
        if (conversation) {
          conversation.updateExecutionResult({
            executionTime,
            success,
            result
          });
          await conversation.save();
        }

        // Broadcast completion to all participants
        this.io.to(`conversation:${conversationId}`).emit('agent_execution_completed', {
          conversationId,
          result,
          executionTime,
          success,
          executedBy: socket.user.username,
          timestamp: new Date().toISOString()
        });

        console.log(`🤖 Agent execution completed in conversation ${conversationId}`);
      } catch (error) {
        socket.emit('error', { message: 'Failed to update execution result' });
      }
    });
  }

  /**
   * Setup collaboration handlers
   */
  setupCollaborationHandlers(socket) {
    // Request code review
    socket.on('request_code_review', (data) => {
      const { conversationId, codeSnippet, reviewerAgentType } = data;
      
      socket.to(`conversation:${conversationId}`).emit('code_review_requested', {
        conversationId,
        codeSnippet,
        reviewerAgentType,
        requestedBy: socket.user.username,
        timestamp: new Date().toISOString()
      });
    });

    // Share screen/workspace
    socket.on('share_workspace', (data) => {
      const { conversationId, workspaceUrl, repositoryBranch } = data;
      
      socket.to(`conversation:${conversationId}`).emit('workspace_shared', {
        conversationId,
        workspaceUrl,
        repositoryBranch,
        sharedBy: socket.user.username,
        timestamp: new Date().toISOString()
      });
    });

    // Agent handoff
    socket.on('agent_handoff', (data) => {
      const { conversationId, fromAgent, toAgent, context } = data;
      
      socket.to(`conversation:${conversationId}`).emit('agent_handoff_initiated', {
        conversationId,
        fromAgent,
        toAgent,
        context,
        initiatedBy: socket.user.username,
        timestamp: new Date().toISOString()
      });
    });
  }

  /**
   * Handle user typing indicators
   */
  handleStartTyping(socket, conversationId) {
    if (!this.typingUsers.has(conversationId)) {
      this.typingUsers.set(conversationId, new Set());
    }
    
    this.typingUsers.get(conversationId).add(socket.user._id.toString());
    
    socket.to(`conversation:${conversationId}`).emit('user_typing', {
      userId: socket.user._id,
      username: socket.user.username,
      conversationId
    });
  }

  handleStopTyping(socket, conversationId) {
    if (this.typingUsers.has(conversationId)) {
      this.typingUsers.get(conversationId).delete(socket.user._id.toString());
      
      if (this.typingUsers.get(conversationId).size === 0) {
        this.typingUsers.delete(conversationId);
      }
    }
    
    socket.to(`conversation:${conversationId}`).emit('user_stopped_typing', {
      userId: socket.user._id,
      username: socket.user.username,
      conversationId
    });
  }

  /**
   * Handle user disconnection
   */
  handleDisconnection(socket) {
    console.log(`👤 User ${socket.user.username} disconnected - Socket: ${socket.id}`);
    
    // Remove from connected users
    this.connectedUsers.delete(socket.user._id.toString());
    
    // Remove from all active conversations
    for (const [conversationId, socketIds] of this.activeConversations.entries()) {
      if (socketIds.has(socket.id)) {
        socketIds.delete(socket.id);
        
        // Notify other participants
        socket.to(`conversation:${conversationId}`).emit('user_left_conversation', {
          userId: socket.user._id,
          username: socket.user.username
        });
        
        if (socketIds.size === 0) {
          this.activeConversations.delete(conversationId);
        }
      }
    }
    
    // Remove from typing users
    for (const [conversationId, typingUserIds] of this.typingUsers.entries()) {
      if (typingUserIds.has(socket.user._id.toString())) {
        this.handleStopTyping(socket, conversationId);
      }
    }
    
    // Broadcast user offline status (after a delay to handle reconnections)
    setTimeout(() => {
      if (!this.connectedUsers.has(socket.user._id.toString())) {
        this.broadcastUserStatus(socket.user._id, 'offline');
      }
    }, 5000);
  }

  /**
   * Broadcast user online status
   */
  broadcastUserStatus(userId, status) {
    this.io.emit('user_status_change', {
      userId,
      status,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Check if user can access conversation
   */
  userCanAccessConversation(user, conversation) {
    // User is owner
    if (conversation.userId.toString() === user._id.toString()) {
      return true;
    }
    
    // User is participant with view permissions
    const participant = conversation.participants.find(p => 
      p.user.toString() === user._id.toString()
    );
    
    return participant && participant.permissions.canView;
  }

  /**
   * Emit message to specific conversation
   */
  emitToConversation(conversationId, event, data) {
    this.io.to(`conversation:${conversationId}`).emit(event, data);
  }

  /**
   * Emit message to specific user
   */
  emitToUser(userId, event, data) {
    this.io.to(`user:${userId}`).emit(event, data);
  }

  /**
   * Get online users count
   */
  getOnlineUsersCount() {
    return this.connectedUsers.size;
  }

  /**
   * Get active conversations count
   */
  getActiveConversationsCount() {
    return this.activeConversations.size;
  }

  /**
   * Broadcast system notification
   */
  broadcastSystemNotification(message, type = 'info') {
    this.io.emit('system_notification', {
      message,
      type,
      timestamp: new Date().toISOString()
    });
  }
}

// Export singleton instance
const socketService = new SocketService();
module.exports = socketService;