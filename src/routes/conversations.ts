import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { ConversationRepository, IMessage } from '../database/repositories/ConversationRepository.js';
import { TaskRepository } from '../database/repositories/TaskRepository.js';
import { z } from 'zod';
import crypto from 'crypto';

const router = Router();

// Validación schemas
const addMessageSchema = z.object({
  content: z.string().min(1),
  role: z.enum(['user', 'assistant', 'system']).optional().default('user'),
  agent: z.string().optional(),
});

/**
 * GET /api/conversations/task/:taskId
 * Obtener la conversación de una tarea
 */
router.get('/task/:taskId', authenticate, async (req: AuthRequest, res) => {
  try {
    const { taskId } = req.params;

    // Verificar que la tarea pertenece al usuario
    const task = TaskRepository.findByIdAndUser(taskId, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    // Buscar o crear conversación
    let conversation = ConversationRepository.findByTaskId(taskId);

    if (!conversation) {
      conversation = ConversationRepository.create({
        taskId,
        userId: req.user!.id,
        messages: [],
      });
    }

    res.json({
      success: true,
      data: conversation,
    });
  } catch (error) {
    console.error('Error fetching conversation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch conversation',
    });
  }
});

/**
 * POST /api/conversations/task/:taskId/messages
 * Agregar un mensaje a la conversación
 */
router.post('/task/:taskId/messages', authenticate, async (req: AuthRequest, res) => {
  try {
    const { taskId } = req.params;
    const validatedData = addMessageSchema.parse(req.body);

    // Verificar que la tarea pertenece al usuario
    const task = TaskRepository.findByIdAndUser(taskId, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    // Buscar o crear conversación
    let conversation = ConversationRepository.findByTaskId(taskId);

    if (!conversation) {
      conversation = ConversationRepository.create({
        taskId,
        userId: req.user!.id,
        messages: [],
      });
    }

    // Agregar mensaje
    const newMessage: IMessage = {
      id: `msg-${crypto.randomBytes(8).toString('hex')}`,
      role: validatedData.role,
      content: validatedData.content,
      timestamp: new Date(),
      agent: validatedData.agent,
    };

    ConversationRepository.addMessage(taskId, newMessage);

    // Re-fetch the updated conversation
    const updatedConversation = ConversationRepository.findByTaskId(taskId);

    console.log(`💬 New message added to task ${taskId}: "${validatedData.content.substring(0, 50)}..."`);

    res.json({
      success: true,
      data: {
        conversation: updatedConversation,
        message: newMessage,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        message: 'Invalid message data',
        errors: error.errors,
      });
      return;
    }

    console.error('Error adding message:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add message',
    });
  }
});

/**
 * GET /api/conversations/:id
 * Obtener una conversación por ID
 */
router.get('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const conversation = ConversationRepository.findById(req.params.id);

    if (!conversation || conversation.userId !== req.user!.id) {
      res.status(404).json({
        success: false,
        message: 'Conversation not found',
      });
      return;
    }

    res.json({
      success: true,
      data: conversation,
    });
  } catch (error) {
    console.error('Error fetching conversation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch conversation',
    });
  }
});

/**
 * POST /api/conversations/:id/messages
 * Agregar mensaje a conversación por ID (legacy)
 */
router.post('/:id/messages', authenticate, async (req: AuthRequest, res) => {
  try {
    const validatedData = addMessageSchema.parse(req.body);

    const conversation = ConversationRepository.findById(req.params.id);

    if (!conversation || conversation.userId !== req.user!.id) {
      res.status(404).json({
        success: false,
        message: 'Conversation not found',
      });
      return;
    }

    const newMessage: IMessage = {
      id: `msg-${crypto.randomBytes(8).toString('hex')}`,
      role: validatedData.role,
      content: validatedData.content,
      timestamp: new Date(),
      agent: validatedData.agent,
    };

    ConversationRepository.addMessage(conversation.taskId, newMessage);

    // Re-fetch the updated conversation
    const updatedConversation = ConversationRepository.findById(req.params.id);

    res.json({
      success: true,
      data: {
        conversation: updatedConversation,
        message: newMessage,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        message: 'Invalid message data',
        errors: error.errors,
      });
      return;
    }

    console.error('Error adding message:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add message',
    });
  }
});

/**
 * GET /api/conversations/task/:taskId/unified
 * Obtener conversación unificada (incluye mensajes de usuario y agentes)
 */
router.get('/task/:taskId/unified', authenticate, async (req: AuthRequest, res) => {
  try {
    const { taskId } = req.params;

    // Verificar tarea
    const task = TaskRepository.findByIdAndUser(taskId, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    // Obtener conversación
    const conversation = ConversationRepository.findByTaskId(taskId);

    res.json({
      success: true,
      data: {
        messages: conversation?.messages || [],
        task: {
          id: task.id,
          title: task.title,
          description: task.description,
          status: task.status,
        },
      },
    });
  } catch (error) {
    console.error('Error fetching unified conversation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch unified conversation',
    });
  }
});

export default router;
