# Webhook Notifications Setup Guide

## Current Status

🚧 **DISABLED** - Webhook notifications are currently commented out and require setup before activation.

## What's Implemented

The notification system is **fully coded** but disabled until you configure SMTP/email service:

### ✅ Features Ready
- **Multi-channel notifications**: Email, Webhook callbacks, Slack
- **Beautiful HTML email templates** with error details and severity colors
- **Project-level notification preferences** stored in MongoDB
- **Duplicate detection integration** - notifies on both new errors and updates
- **Fail-safe design** - notification errors don't break webhook functionality

### 📁 Files Modified
- `src/services/webhooks/WebhookNotificationService.ts` - Complete notification service
- `src/models/Project.ts` - Added `settings.errorNotifications` field
- `src/routes/webhooks/errors.ts` - Integration points (currently commented)

## How to Enable

### 1. Install Required Package

```bash
npm install nodemailer
npm install --save-dev @types/nodemailer
```

### 2. Configure Environment Variables

Add to your `.env` file:

```bash
# Email Notifications (SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password  # For Gmail, use App Password, not your regular password
SMTP_FROM=noreply@multi-agents.com

# Frontend URL (for task links in emails)
FRONTEND_URL=http://localhost:3000  # or your production URL
```

### 3. Uncomment Code

#### In `src/services/webhooks/WebhookNotificationService.ts`:

**Line 10** - Uncomment:
```typescript
import nodemailer from 'nodemailer';
```

**Lines 41-59** - Uncomment the transporter initialization:
```typescript
private transporter: nodemailer.Transporter | null = null;

constructor() {
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
}
```

#### In `src/routes/webhooks/errors.ts`:

**Line 19** - Uncomment:
```typescript
import { WebhookNotificationService } from '../../services/webhooks/WebhookNotificationService';
```

**Line 24** - Uncomment:
```typescript
const notificationService = new WebhookNotificationService();
```

**Lines 218-241** - Uncomment (duplicate error notification):
```typescript
try {
  const project = await Project.findById(projectId);
  if (project?.settings?.errorNotifications?.enabled) {
    await notificationService.notifyClient(
      project.settings.errorNotifications.channels || [],
      { taskId, projectId, errorType, ... }
    );
  }
} catch (notifError: any) {
  console.error(`Failed to send notification: ${notifError.message}`);
}
```

**Lines 294-317** - Uncomment (new error notification):
```typescript
try {
  const project = await Project.findById(projectId);
  if (project?.settings?.errorNotifications?.enabled) {
    await notificationService.notifyClient(
      project.settings.errorNotifications.channels || [],
      { taskId, projectId, errorType, ... }
    );
  }
} catch (notifError: any) {
  console.error(`Failed to send notification: ${notifError.message}`);
}
```

### 4. Configure Project Notification Preferences

Use the API to enable notifications for a project:

```bash
# Example: Enable email notifications for a project
curl -X PATCH http://localhost:3001/api/projects/{projectId} \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "settings": {
      "errorNotifications": {
        "enabled": true,
        "channels": [
          {
            "type": "email",
            "enabled": true,
            "config": {
              "email": "alerts@yourcompany.com"
            }
          }
        ]
      }
    }
  }'
```

### 5. Test

Send a test webhook error:

```bash
curl -X POST http://localhost:3001/api/webhooks/errors \
  -H "X-API-Key: YOUR_WEBHOOK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "errorType": "TypeError",
    "severity": "high",
    "message": "Cannot read property of undefined",
    "stackTrace": "at app.js:123:45"
  }'
```

Check your email for the notification! 📧

## SMTP Providers

### Gmail Setup (Recommended for Testing)

1. Enable 2-Factor Authentication
2. Go to https://myaccount.google.com/apppasswords
3. Create an App Password for "Mail"
4. Use that password in `SMTP_PASS`

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-gmail@gmail.com
SMTP_PASS=your-16-char-app-password
```

### SendGrid

```bash
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=apikey
SMTP_PASS=your-sendgrid-api-key
```

### Amazon SES

```bash
SMTP_HOST=email-smtp.us-east-1.amazonaws.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-ses-smtp-username
SMTP_PASS=your-ses-smtp-password
```

## Notification Channels

### Email
- Beautiful HTML templates
- Severity color coding (red, orange, yellow, green)
- Error details table
- Direct link to task
- Automatic workflow explanation

### Webhook Callback
- POST to custom URL
- JSON payload with error details
- Optional secret for authentication
- Event type: `error.detected`

### Slack
- Rich message attachments
- Color-coded by severity
- Inline fields (Severity, Occurrences, Status)
- Action button to view task
- Custom channel support

## Architecture

```
Webhook Error → Deduplication → Task Creation/Update
                                      ↓
                              Fetch Project Settings
                                      ↓
                              Notification Enabled?
                                   ↙    ↘
                                YES      NO
                                 ↓       ↓
                        Send Notifications  Skip
                        (Email/Webhook/Slack)
                                 ↓
                        Continue Orchestration
```

## Security Notes

- ⚠️ Never commit `.env` file with real credentials
- 🔐 Use App Passwords for Gmail (not your main password)
- 🔒 Webhook secrets should be strong random strings
- 📧 Email notifications use nodemailer (trusted library)
- 🛡️ Notification failures don't break webhook functionality

## Next Steps

When ready to enable:
1. ✅ Choose an SMTP provider
2. ✅ Configure environment variables
3. ✅ Install nodemailer
4. ✅ Uncomment the code (4 locations)
5. ✅ Restart server
6. ✅ Test with sample webhook
7. ✅ Configure project notification preferences

---

**Implementation Status**: Complete but disabled pending SMTP setup
**Last Updated**: 2025-01-27
