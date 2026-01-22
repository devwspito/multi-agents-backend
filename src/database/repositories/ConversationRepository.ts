/**
 * Conversation Repository
 *
 * Database operations for task conversations
 */

import db from '../index.js';
import { generateId, now, parseJSON, toJSON } from '../utils.js';

export interface IMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  attachments?: string[];
  agent?: string;
}

export interface IConversation {
  id: string;
  taskId: string;
  userId: string;
  messages: IMessage[];
  createdAt: Date;
  updatedAt: Date;
}

interface ConversationRow {
  id: string;
  task_id: string;
  user_id: string;
  messages: string;
  created_at: string;
  updated_at: string;
}

function rowToConversation(row: ConversationRow): IConversation {
  return {
    id: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    messages: parseJSON(row.messages, []),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class ConversationRepository {
  /**
   * Find conversation by ID
   */
  static findById(id: string): IConversation | null {
    const stmt = db.prepare(`SELECT * FROM conversations WHERE id = ?`);
    const row = stmt.get(id) as ConversationRow | undefined;
    if (!row) return null;

    return rowToConversation(row);
  }

  /**
   * Find conversation by task ID
   */
  static findByTaskId(taskId: string): IConversation | null {
    const stmt = db.prepare(`SELECT * FROM conversations WHERE task_id = ?`);
    const row = stmt.get(taskId) as ConversationRow | undefined;
    if (!row) return null;

    return rowToConversation(row);
  }

  /**
   * Find conversations by user ID
   */
  static findByUserId(userId: string): IConversation[] {
    const stmt = db.prepare(`SELECT * FROM conversations WHERE user_id = ? ORDER BY created_at DESC`);
    const rows = stmt.all(userId) as ConversationRow[];
    return rows.map(rowToConversation);
  }

  /**
   * Create a new conversation
   */
  static create(data: {
    taskId: string;
    userId: string;
    messages?: IMessage[];
  }): IConversation {
    const id = generateId();
    const timestamp = now();

    const stmt = db.prepare(`
      INSERT INTO conversations (id, task_id, user_id, messages, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.taskId,
      data.userId,
      toJSON(data.messages || []),
      timestamp,
      timestamp
    );

    return this.findById(id)!;
  }

  /**
   * Add message to conversation
   */
  static addMessage(taskId: string, message: IMessage): boolean {
    const conversation = this.findByTaskId(taskId);
    if (!conversation) return false;

    const messages = conversation.messages;
    messages.push(message);

    const stmt = db.prepare(`UPDATE conversations SET messages = ?, updated_at = ? WHERE task_id = ?`);
    const result = stmt.run(toJSON(messages), now(), taskId);
    return result.changes > 0;
  }

  /**
   * Get or create conversation for task
   */
  static getOrCreate(taskId: string, userId: string): IConversation {
    const existing = this.findByTaskId(taskId);
    if (existing) return existing;

    return this.create({ taskId, userId });
  }

  /**
   * Update messages
   */
  static updateMessages(taskId: string, messages: IMessage[]): boolean {
    const stmt = db.prepare(`UPDATE conversations SET messages = ?, updated_at = ? WHERE task_id = ?`);
    const result = stmt.run(toJSON(messages), now(), taskId);
    return result.changes > 0;
  }

  /**
   * Delete conversation
   */
  static delete(id: string): boolean {
    const stmt = db.prepare(`DELETE FROM conversations WHERE id = ?`);
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Delete by task ID
   */
  static deleteByTaskId(taskId: string): boolean {
    const stmt = db.prepare(`DELETE FROM conversations WHERE task_id = ?`);
    const result = stmt.run(taskId);
    return result.changes > 0;
  }

  /**
   * Count messages in conversation
   */
  static countMessages(taskId: string): number {
    const conversation = this.findByTaskId(taskId);
    return conversation?.messages.length || 0;
  }
}

export default ConversationRepository;
