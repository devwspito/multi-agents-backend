/**
 * Webhook Notification Service
 *
 * Notifies clients when their webhook reports an error and we start working on it
 * Supports multiple notification channels: email, webhook callback, Slack
 *
 * NOTE: Currently disabled - requires SMTP configuration and nodemailer package
 */

// import nodemailer from 'nodemailer';
import { LogService } from '../logging/LogService';

export interface NotificationChannel {
  type: 'email' | 'webhook' | 'slack';
  enabled: boolean;
  config: {
    // Email config
    email?: string;
    // Webhook config
    webhookUrl?: string;
    webhookSecret?: string;
    // Slack config
    slackWebhookUrl?: string;
    slackChannel?: string;
  };
}

export interface ErrorNotificationPayload {
  taskId: string;
  projectId: string;
  errorType: string;
  errorMessage: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  occurrenceCount: number;
  isDuplicate: boolean;
  taskUrl: string;
  timestamp: string;
}

export class WebhookNotificationService {
  private transporter: any | null = null; // nodemailer.Transporter

  constructor() {
    // Initialize email transporter if configured
    // NOTE: Disabled - requires nodemailer package and SMTP configuration
    /*
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
      this.transporter = nodemailer.createTransporter({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });
    }
    */
  }

  /**
   * Send notification to client via configured channels
   */
  async notifyClient(
    channels: NotificationChannel[],
    payload: ErrorNotificationPayload
  ): Promise<void> {
    const enabledChannels = channels.filter((c) => c.enabled);

    if (enabledChannels.length === 0) {
      console.log(`ℹ️  No notification channels enabled for project ${payload.projectId}`);
      return;
    }

    console.log(`\n📧 Sending notifications for error: ${payload.errorType}`);
    console.log(`   Task: ${payload.taskId}`);
    console.log(`   Channels: ${enabledChannels.map((c) => c.type).join(', ')}`);

    const promises = enabledChannels.map((channel) => {
      switch (channel.type) {
        case 'email':
          return this.sendEmailNotification(channel, payload);
        case 'webhook':
          return this.sendWebhookNotification(channel, payload);
        case 'slack':
          return this.sendSlackNotification(channel, payload);
        default:
          return Promise.resolve();
      }
    });

    await Promise.allSettled(promises);
  }

  /**
   * Send email notification
   */
  private async sendEmailNotification(
    channel: NotificationChannel,
    payload: ErrorNotificationPayload
  ): Promise<void> {
    if (!this.transporter) {
      console.warn('⚠️  Email transporter not configured - skipping email notification');
      return;
    }

    if (!channel.config.email) {
      console.warn('⚠️  Email address not configured - skipping email notification');
      return;
    }

    try {
      const severityEmoji = {
        critical: '🔴',
        high: '🟠',
        medium: '🟡',
        low: '🟢',
      }[payload.severity];

      const subject = payload.isDuplicate
        ? `${severityEmoji} Error Update: ${payload.errorType} (${payload.occurrenceCount}x)`
        : `${severityEmoji} New Error Detected: ${payload.errorType}`;

      const html = this.buildEmailTemplate(payload);

      await this.transporter.sendMail({
        from: process.env.SMTP_FROM || 'noreply@multi-agents.com',
        to: channel.config.email,
        subject,
        html,
      });

      console.log(`   ✅ Email sent to ${channel.config.email}`);

      await LogService.info('Email notification sent', {
        taskId: payload.taskId,
        category: 'webhook',
        metadata: {
          to: channel.config.email,
          errorType: payload.errorType,
        },
      });
    } catch (error: any) {
      console.error(`   ❌ Failed to send email: ${error.message}`);
      await LogService.error('Email notification failed', {
        taskId: payload.taskId,
        category: 'webhook',
        error,
      });
    }
  }

  /**
   * Send webhook callback notification
   */
  private async sendWebhookNotification(
    channel: NotificationChannel,
    payload: ErrorNotificationPayload
  ): Promise<void> {
    if (!channel.config.webhookUrl) {
      console.warn('⚠️  Webhook URL not configured - skipping webhook notification');
      return;
    }

    try {
      const response = await fetch(channel.config.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(channel.config.webhookSecret && {
            'X-Webhook-Secret': channel.config.webhookSecret,
          }),
        },
        body: JSON.stringify({
          event: 'error.detected',
          data: payload,
        }),
      });

      if (!response.ok) {
        throw new Error(`Webhook returned ${response.status}`);
      }

      console.log(`   ✅ Webhook notification sent to ${channel.config.webhookUrl}`);

      await LogService.info('Webhook notification sent', {
        taskId: payload.taskId,
        category: 'webhook',
        metadata: {
          webhookUrl: channel.config.webhookUrl,
          errorType: payload.errorType,
        },
      });
    } catch (error: any) {
      console.error(`   ❌ Failed to send webhook: ${error.message}`);
      await LogService.error('Webhook notification failed', {
        taskId: payload.taskId,
        category: 'webhook',
        error,
      });
    }
  }

  /**
   * Send Slack notification
   */
  private async sendSlackNotification(
    channel: NotificationChannel,
    payload: ErrorNotificationPayload
  ): Promise<void> {
    if (!channel.config.slackWebhookUrl) {
      console.warn('⚠️  Slack webhook URL not configured - skipping Slack notification');
      return;
    }

    try {
      const severityColor = {
        critical: '#FF0000',
        high: '#FF6600',
        medium: '#FFCC00',
        low: '#00CC00',
      }[payload.severity];

      const message = {
        channel: channel.config.slackChannel || '#errors',
        username: 'Multi-Agent Platform',
        icon_emoji: ':robot_face:',
        attachments: [
          {
            color: severityColor,
            title: payload.isDuplicate
              ? `🔄 Error Update: ${payload.errorType}`
              : `🚨 New Error Detected: ${payload.errorType}`,
            text: payload.errorMessage,
            fields: [
              {
                title: 'Severity',
                value: payload.severity.toUpperCase(),
                short: true,
              },
              {
                title: 'Occurrences',
                value: payload.occurrenceCount.toString(),
                short: true,
              },
              {
                title: 'Task ID',
                value: payload.taskId,
                short: true,
              },
              {
                title: 'Status',
                value: payload.isDuplicate ? 'Duplicate (count updated)' : 'New (orchestration started)',
                short: true,
              },
            ],
            footer: 'Multi-Agent Development Platform',
            footer_icon: 'https://platform.openai.com/img/favicon-32x32.png',
            ts: Math.floor(new Date(payload.timestamp).getTime() / 1000),
            actions: [
              {
                type: 'button',
                text: 'View Task',
                url: payload.taskUrl,
                style: 'primary',
              },
            ],
          },
        ],
      };

      const response = await fetch(channel.config.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        throw new Error(`Slack returned ${response.status}`);
      }

      console.log(`   ✅ Slack notification sent to ${channel.config.slackChannel || 'default'}`);

      await LogService.info('Slack notification sent', {
        taskId: payload.taskId,
        category: 'webhook',
        metadata: {
          slackChannel: channel.config.slackChannel,
          errorType: payload.errorType,
        },
      });
    } catch (error: any) {
      console.error(`   ❌ Failed to send Slack notification: ${error.message}`);
      await LogService.error('Slack notification failed', {
        taskId: payload.taskId,
        category: 'webhook',
        error,
      });
    }
  }

  /**
   * Build HTML email template
   */
  private buildEmailTemplate(payload: ErrorNotificationPayload): string {
    const severityColor = {
      critical: '#FF0000',
      high: '#FF6600',
      medium: '#FFCC00',
      low: '#00CC00',
    }[payload.severity];

    const statusMessage = payload.isDuplicate
      ? `This error has occurred <strong>${payload.occurrenceCount} times</strong>. We've updated the existing task to reflect the increased frequency.`
      : `We've created a new task and started our automated development process to fix this issue.`;

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Error Notification</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 24px;">
      ${payload.isDuplicate ? '🔄 Error Update' : '🚨 New Error Detected'}
    </h1>
  </div>

  <div style="background: white; padding: 30px; border: 1px solid #e1e4e8; border-top: none; border-radius: 0 0 10px 10px;">
    <div style="background: ${severityColor}; color: white; padding: 10px 15px; border-radius: 5px; margin-bottom: 20px; text-align: center;">
      <strong>SEVERITY: ${payload.severity.toUpperCase()}</strong>
    </div>

    <h2 style="color: #333; margin-top: 0;">Error Details</h2>

    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
      <tr style="border-bottom: 1px solid #e1e4e8;">
        <td style="padding: 10px 0; font-weight: bold; width: 40%;">Type:</td>
        <td style="padding: 10px 0;"><code style="background: #f6f8fa; padding: 2px 6px; border-radius: 3px;">${payload.errorType}</code></td>
      </tr>
      <tr style="border-bottom: 1px solid #e1e4e8;">
        <td style="padding: 10px 0; font-weight: bold;">Message:</td>
        <td style="padding: 10px 0;">${payload.errorMessage.substring(0, 100)}${payload.errorMessage.length > 100 ? '...' : ''}</td>
      </tr>
      <tr style="border-bottom: 1px solid #e1e4e8;">
        <td style="padding: 10px 0; font-weight: bold;">Occurrences:</td>
        <td style="padding: 10px 0;">${payload.occurrenceCount}x</td>
      </tr>
      <tr style="border-bottom: 1px solid #e1e4e8;">
        <td style="padding: 10px 0; font-weight: bold;">Status:</td>
        <td style="padding: 10px 0;">${payload.isDuplicate ? 'Duplicate (count updated)' : 'New (orchestration started)'}</td>
      </tr>
      <tr>
        <td style="padding: 10px 0; font-weight: bold;">Task ID:</td>
        <td style="padding: 10px 0;"><code style="background: #f6f8fa; padding: 2px 6px; border-radius: 3px;">${payload.taskId}</code></td>
      </tr>
    </table>

    <div style="background: #f6f8fa; padding: 15px; border-left: 4px solid #0366d6; margin-bottom: 20px;">
      <p style="margin: 0;">${statusMessage}</p>
    </div>

    <div style="text-align: center; margin-top: 30px;">
      <a href="${payload.taskUrl}" style="display: inline-block; background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-weight: bold;">
        View Task Details
      </a>
    </div>

    <hr style="border: none; border-top: 1px solid #e1e4e8; margin: 30px 0;">

    <h3 style="color: #333;">What Happens Next?</h3>
    <ol style="padding-left: 20px;">
      <li><strong>Planning:</strong> Our planning agent analyzes the error and creates tasks</li>
      <li><strong>Architecture:</strong> Tech Lead designs the solution</li>
      <li><strong>Development:</strong> Developers implement the fix</li>
      <li><strong>Review:</strong> Judge validates code quality</li>
      <li><strong>Deployment:</strong> Auto-merge to production (if verification passes)</li>
    </ol>

    <p style="color: #666; font-size: 12px; text-align: center; margin-top: 30px;">
      <em>This is an automated notification from Multi-Agent Development Platform</em><br>
      <a href="https://your-platform.com/settings/notifications" style="color: #667eea;">Manage notification preferences</a>
    </p>
  </div>
</body>
</html>
    `.trim();
  }
}
