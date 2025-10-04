# 🔧 Complete GitHub Integration Setup Guide

## 📋 Overview

This guide will help you set up **complete GitHub integration** for your Multi-Agent Software Development Platform:

1. **GitHub OAuth App** - For user authentication (allows users to connect their GitHub accounts)
2. **GitHub App** - For webhooks and advanced repository operations
3. **Webhooks** - For real-time events (push, PR, issues, etc.)

---

## 🎯 What You'll Need

After completing this guide, you'll have:

✅ Users can connect their GitHub accounts
✅ Platform can access user repositories
✅ Real-time webhook events from GitHub
✅ Automatic activity tracking for commits, PRs, issues
✅ GitHub App for server-side repository operations

---

# Part 1: GitHub OAuth App (User Authentication)

## Step 1: Create GitHub OAuth App

### 1.1 Go to GitHub Developer Settings

1. Log in to GitHub
2. Go to **Settings** → **Developer settings** → **OAuth Apps**
3. Or visit directly: https://github.com/settings/developers

### 1.2 Click "New OAuth App"

### 1.3 Fill in OAuth App Details

```
Application name: Multi-Agent Software Platform
Homepage URL: http://localhost:3000 (for development)
Application description: Educational multi-agent software development platform with Claude Code integration
Authorization callback URL: http://localhost:3001/api/github-auth/callback
```

**Important Notes:**
- For **development**: Use `http://localhost:3001/api/github-auth/callback`
- For **production**: Update to your production URL (e.g., `https://your-domain.com/api/github-auth/callback`)

### 1.4 Register Application

Click **"Register application"**

### 1.5 Copy Credentials

You'll see:
- **Client ID**: `Iv1.xxxxxxxxxxxxxxxx` (visible)
- **Client Secret**: Click **"Generate a new client secret"**

⚠️ **IMPORTANT**: Copy the Client Secret immediately - you won't see it again!

---

## Step 2: Configure OAuth App in Your Backend

### 2.1 Update `.env` File

Add these variables to `/backend/.env`:

```bash
# =============================================================================
# GITHUB OAUTH (Multi-tenant)
# =============================================================================
# GitHub OAuth App credentials (from https://github.com/settings/developers)
GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxxxxxx
GITHUB_CLIENT_SECRET=your-client-secret-here

# Callback URL (must match OAuth App settings)
BASE_URL=http://localhost:3001
FRONTEND_URL=http://localhost:3000
```

### 2.2 Test OAuth Flow

1. Start your backend:
   ```bash
   cd backend
   npm start
   ```

2. Test the OAuth URL endpoint:
   ```bash
   # You need to be logged in first, so this needs a valid JWT token
   curl http://localhost:3001/api/github-auth/url \
     -H "Authorization: Bearer YOUR_JWT_TOKEN"
   ```

3. You should get a response like:
   ```json
   {
     "success": true,
     "data": {
       "authUrl": "https://github.com/login/oauth/authorize?client_id=...",
       "state": "..."
     }
   }
   ```

---

# Part 2: GitHub App (Webhooks & Advanced Features)

## Step 1: Create GitHub App

### 1.1 Go to GitHub Apps Settings

1. Go to **Settings** → **Developer settings** → **GitHub Apps**
2. Or visit: https://github.com/settings/apps

### 1.2 Click "New GitHub App"

### 1.3 Fill in GitHub App Details

#### **Basic Information:**
```
GitHub App name: multi-agent-platform-dev (must be globally unique)
Homepage URL: http://localhost:3000
Description: Multi-agent software development platform with Claude Code integration
```

#### **Identifying and authorizing users:**
```
☑ Request user authorization (OAuth) during installation
Callback URL: http://localhost:3001/api/github-auth/callback
☐ Expire user authorization tokens
☑ Enable Device Flow
```

#### **Webhook:**
```
☑ Active

Webhook URL: https://your-public-url.com/api/github-webhooks
   ⚠️ IMPORTANT: This MUST be a public HTTPS URL!

   For development, use one of these services:
   - ngrok: https://ngrok.com
   - localtunnel: https://localtunnel.github.io
   - Cloudflare Tunnel: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/

Webhook secret: (generate a random string)
   Generate with: openssl rand -hex 32
   Example: 3f7a9b2c8d1e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a
```

#### **Repository permissions:**
```
☑ Contents: Read & write
☑ Issues: Read & write
☑ Pull requests: Read & write
☑ Metadata: Read-only (automatically selected)
☑ Webhooks: Read & write
```

#### **Subscribe to events:**
```
☑ Push
☑ Pull request
☑ Pull request review
☑ Issues
☑ Issue comment
```

#### **Where can this GitHub App be installed?**
```
⦿ Only on this account (recommended for development)
○ Any account (for public apps)
```

### 1.4 Create GitHub App

Click **"Create GitHub App"**

---

## Step 2: Generate Private Key

### 2.1 Generate Private Key

1. After creating the app, scroll down to **"Private keys"**
2. Click **"Generate a private key"**
3. A `.pem` file will download automatically
4. Save it securely (e.g., `github-app-private-key.pem`)

### 2.2 Copy App Credentials

You'll need:
- **App ID**: Found at the top (e.g., `123456`)
- **Client ID**: Found in "About" section
- **Client Secret**: Click "Generate a new client secret"
- **Webhook Secret**: The random string you generated earlier
- **Private Key**: The `.pem` file you just downloaded

---

## Step 3: Configure GitHub App in Backend

### 3.1 Save Private Key

Option A - **As File (Recommended for Development):**

1. Save the `.pem` file in your backend root:
   ```bash
   cp ~/Downloads/your-app-name.*.private-key.pem \
      /path/to/backend/github-app-private-key.pem
   ```

2. Add to `.gitignore`:
   ```bash
   echo "github-app-private-key.pem" >> backend/.gitignore
   ```

Option B - **As Environment Variable (For Production):**

1. Convert to single-line format:
   ```bash
   awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' github-app-private-key.pem
   ```

2. Copy the output and add to `.env`

### 3.2 Update `.env` File

Add to `/backend/.env`:

```bash
# =============================================================================
# GITHUB APP (for advanced features)
# =============================================================================
# GitHub App credentials (from https://github.com/settings/apps)
GITHUB_APP_ID=123456

# Option A: Path to private key file (development)
GITHUB_PRIVATE_KEY_PATH=./github-app-private-key.pem

# Option B: Private key as environment variable (production)
# GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"

# Webhook secret (same one you set when creating the app)
GITHUB_WEBHOOK_SECRET=3f7a9b2c8d1e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a

# Installation ID (you'll get this after installing the app)
# GITHUB_INSTALLATION_ID=12345678
```

### 3.3 Update GitHubService.js to Read Private Key

If using file path, update `backend/src/services/GitHubService.js`:

```javascript
initializeGitHubApp() {
  if (!process.env.GITHUB_APP_ID) {
    console.warn('⚠️ GitHub App not configured.');
    return;
  }

  let privateKey;

  // Read from file or environment variable
  if (process.env.GITHUB_PRIVATE_KEY_PATH) {
    const fs = require('fs');
    privateKey = fs.readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf8');
  } else if (process.env.GITHUB_PRIVATE_KEY) {
    privateKey = process.env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n');
  } else {
    console.error('❌ GitHub App private key not found!');
    return;
  }

  this.githubApp = new App({
    appId: process.env.GITHUB_APP_ID,
    privateKey: privateKey,
    webhooks: {
      secret: process.env.GITHUB_WEBHOOK_SECRET
    }
  });

  console.log('✅ GitHub App initialized successfully');
}
```

---

## Step 4: Install GitHub App

### 4.1 Install on Your Account

1. Go to your GitHub App settings page
2. Click **"Install App"** in the left sidebar
3. Select your account/organization
4. Choose repositories:
   - ⦿ **All repositories** (easier for development)
   - ○ **Only select repositories** (more secure for production)
5. Click **"Install"**

### 4.2 Get Installation ID

After installation, you'll be redirected to a URL like:
```
https://github.com/settings/installations/12345678
```

The number at the end (`12345678`) is your **Installation ID**.

Add it to `.env`:
```bash
GITHUB_INSTALLATION_ID=12345678
```

---

# Part 3: Webhook Setup

## Step 1: Expose Local Server (Development)

For development, you need to expose your local server to the internet so GitHub can send webhooks.

### Option A: Using ngrok (Recommended)

1. **Install ngrok:**
   ```bash
   # macOS
   brew install ngrok

   # Or download from https://ngrok.com/download
   ```

2. **Authenticate ngrok:**
   ```bash
   ngrok authtoken YOUR_AUTHTOKEN
   ```

3. **Start tunnel:**
   ```bash
   ngrok http 3001
   ```

4. **Copy the HTTPS URL:**
   ```
   Forwarding: https://abc123.ngrok.io -> http://localhost:3001
   ```

5. **Update GitHub App webhook URL:**
   - Go to your GitHub App settings
   - Update **Webhook URL** to: `https://abc123.ngrok.io/api/github-webhooks`
   - Click **"Update GitHub App"**

### Option B: Using Cloudflare Tunnel

1. **Install cloudflared:**
   ```bash
   brew install cloudflare/cloudflare/cloudflared
   ```

2. **Start tunnel:**
   ```bash
   cloudflared tunnel --url http://localhost:3001
   ```

3. **Copy the URL and update GitHub App webhook URL**

---

## Step 2: Test Webhook

### 2.1 Check Webhook Endpoint

```bash
curl http://localhost:3001/api/github-webhooks/test
```

You should see:
```json
{
  "success": true,
  "message": "GitHub Webhooks endpoint is active",
  "webhookUrl": "http://localhost:3001/api/github-webhooks",
  "environment": "development",
  "configured": true
}
```

### 2.2 Test from GitHub

1. Go to your GitHub App settings
2. Click **"Advanced"** tab
3. Scroll to **"Recent Deliveries"**
4. Click **"Redeliver"** on any recent webhook (or trigger a new event)

You should see:
- ✅ Green checkmark = successful delivery
- ❌ Red X = failed delivery (check logs)

### 2.3 Check Backend Logs

You should see webhook events in your backend console:
```
✅ GitHub Webhook: push (abc123-def456-ghi789)
📥 Processing push event (abc123-def456-ghi789)
📝 Push to owner/repo on refs/heads/main by username
   3 commit(s) pushed
✅ Successfully processed push event
```

---

# Part 4: Complete Environment Variables

## Final `.env` Configuration

Here's your complete `.env` file with all GitHub integrations:

```bash
# =============================================================================
# MULTI-AGENT SOFTWARE ARCHITECTURE - BACKEND ENVIRONMENT VARIABLES
# =============================================================================

# =============================================================================
# SERVER CONFIGURATION
# =============================================================================
NODE_ENV=development
PORT=3001
BASE_URL=http://localhost:3001
FRONTEND_URL=http://localhost:3000

# =============================================================================
# DATABASE CONFIGURATION
# =============================================================================
MONGODB_URI=mongodb+srv://your-cluster.mongodb.net/agents-software-arq

# =============================================================================
# JWT AUTHENTICATION
# =============================================================================
JWT_SECRET=your-secret-key-change-in-production
JWT_ACCESS_EXPIRE=1h
JWT_REFRESH_SECRET=your-refresh-secret-key-change-in-production
JWT_REFRESH_EXPIRE=7d

# =============================================================================
# CLAUDE API CONFIGURATION
# =============================================================================
ANTHROPIC_API_KEY=sk-ant-api03-your-api-key-here
WORKSPACE_BASE=./workspaces
UPLOAD_DIR=./uploads

# =============================================================================
# GITHUB OAUTH (Multi-tenant - User Authentication)
# =============================================================================
GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxxxxxx
GITHUB_CLIENT_SECRET=your-oauth-client-secret-here

# =============================================================================
# GITHUB APP (Webhooks & Advanced Features)
# =============================================================================
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY_PATH=./github-app-private-key.pem
# OR (for production):
# GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"

GITHUB_WEBHOOK_SECRET=your-webhook-secret-here
GITHUB_INSTALLATION_ID=12345678

# =============================================================================
# SESSION CONFIGURATION
# =============================================================================
SESSION_SECRET=your-session-secret-change-in-production

# =============================================================================
# SECURITY & RATE LIMITING
# =============================================================================
RATE_LIMIT_WINDOW=900000
```

---

# Part 5: Testing the Complete Integration

## Test 1: OAuth Flow

### Frontend Flow (User connects GitHub):

1. User clicks "Connect GitHub" button
2. Frontend calls: `GET /api/github-auth/url`
3. User is redirected to GitHub authorization page
4. User approves
5. GitHub redirects to: `http://localhost:3001/api/github-auth/callback?code=...`
6. Backend exchanges code for access token
7. User is redirected to: `http://localhost:3000/dashboard?github=connected`

### Test with cURL:

```bash
# Step 1: Get authorization URL (requires login)
curl http://localhost:3001/api/github-auth/url \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# Response:
# {
#   "success": true,
#   "data": {
#     "authUrl": "https://github.com/login/oauth/authorize?...",
#     "state": "..."
#   }
# }

# Step 2: Open authUrl in browser, approve

# Step 3: Check connection status
curl http://localhost:3001/api/github-auth/status \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# Response:
# {
#   "success": true,
#   "data": {
#     "connected": true,
#     "github": {
#       "username": "youruser",
#       "profile": { ... }
#     }
#   }
# }

# Step 4: Get user repositories
curl http://localhost:3001/api/github-auth/repositories \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

## Test 2: Webhooks

### Trigger Events:

1. **Push Event:**
   ```bash
   cd /path/to/any/github/repo
   echo "test" > test.txt
   git add test.txt
   git commit -m "Test webhook"
   git push
   ```

2. **Pull Request Event:**
   - Create a PR on GitHub
   - Check backend logs for webhook event

3. **Check Webhook Deliveries:**
   - Go to GitHub App settings → Advanced
   - Check "Recent Deliveries"
   - Should see ✅ green checkmarks

---

## Test 3: Full Integration

### Create Project with GitHub Repository:

```bash
# 1. Connect GitHub (use OAuth flow above)

# 2. Create project with repository
curl -X POST http://localhost:3001/api/projects \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Project",
    "description": "Testing GitHub integration",
    "type": "web-app",
    "repositories": [
      {
        "name": "my-repo",
        "clone_url": "https://github.com/youruser/my-repo.git",
        "language": "JavaScript"
      }
    ]
  }'

# 3. Push to repository
# Check Activity log - should show push event

# 4. Check activities
curl http://localhost:3001/api/projects/PROJECT_ID/activities \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# Should see push event logged
```

---

# Part 6: Production Deployment

## Step 1: Update URLs

1. **GitHub OAuth App:**
   - Homepage URL: `https://your-domain.com`
   - Callback URL: `https://your-domain.com/api/github-auth/callback`

2. **GitHub App:**
   - Homepage URL: `https://your-domain.com`
   - Webhook URL: `https://your-domain.com/api/github-webhooks`

3. **Environment Variables:**
   ```bash
   BASE_URL=https://your-domain.com
   FRONTEND_URL=https://your-domain.com
   NODE_ENV=production
   ```

## Step 2: Secure Private Key

Use environment variable instead of file:

```bash
# Convert PEM to environment variable
GITHUB_PRIVATE_KEY=$(awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' github-app-private-key.pem)

# Add to production environment (Heroku, Railway, etc.)
# NOT in .env file - use platform's secrets manager
```

## Step 3: Security Checklist

- [ ] Private key NOT in repository
- [ ] `.pem` file in `.gitignore`
- [ ] Webhook secret is random and secure (32+ characters)
- [ ] OAuth secrets not exposed in frontend
- [ ] HTTPS for all production URLs
- [ ] Rate limiting enabled
- [ ] Webhook signature verification enabled

---

# Part 7: Troubleshooting

## Common Issues

### Issue 1: "GitHub OAuth not configured"

**Solution:** Make sure `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are in `.env`

```bash
grep GITHUB_CLIENT_ID backend/.env
grep GITHUB_CLIENT_SECRET backend/.env
```

### Issue 2: Webhook not receiving events

**Checks:**
1. Is ngrok/tunnel running?
2. Is webhook URL correct in GitHub App settings?
3. Is `GITHUB_WEBHOOK_SECRET` in `.env`?
4. Check GitHub App → Advanced → Recent Deliveries for errors

### Issue 3: "Invalid signature" on webhook

**Solution:** Make sure `GITHUB_WEBHOOK_SECRET` matches exactly what you set in GitHub App

### Issue 4: "GitHub App not configured"

**Solution:** Check these environment variables:
```bash
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY_PATH=./github-app-private-key.pem
GITHUB_WEBHOOK_SECRET=...
```

### Issue 5: Private key error

**Solutions:**

Option 1 - Check file exists:
```bash
ls -la backend/github-app-private-key.pem
```

Option 2 - Check file permissions:
```bash
chmod 600 backend/github-app-private-key.pem
```

Option 3 - Use environment variable instead:
```bash
# Read file content
cat backend/github-app-private-key.pem

# Manually add to .env:
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
...
-----END RSA PRIVATE KEY-----"
```

---

# Part 8: Verification Checklist

## ✅ GitHub OAuth App

- [ ] OAuth App created on GitHub
- [ ] `GITHUB_CLIENT_ID` in `.env`
- [ ] `GITHUB_CLIENT_SECRET` in `.env`
- [ ] Callback URL matches backend URL
- [ ] Can get authorization URL: `GET /api/github-auth/url`
- [ ] OAuth flow completes successfully
- [ ] Can fetch repositories: `GET /api/github-auth/repositories`

## ✅ GitHub App

- [ ] GitHub App created on GitHub
- [ ] `GITHUB_APP_ID` in `.env`
- [ ] Private key downloaded and saved
- [ ] `GITHUB_PRIVATE_KEY_PATH` or `GITHUB_PRIVATE_KEY` in `.env`
- [ ] `GITHUB_WEBHOOK_SECRET` in `.env`
- [ ] App installed on account/organization
- [ ] `GITHUB_INSTALLATION_ID` in `.env`
- [ ] Backend starts without errors
- [ ] GitHubService initializes: "✅ GitHub App initialized successfully"

## ✅ Webhooks

- [ ] Webhook URL is public (ngrok/tunnel running)
- [ ] Webhook URL configured in GitHub App
- [ ] Webhook endpoint responds: `GET /api/github-webhooks/test`
- [ ] Test webhook delivery shows ✅ in GitHub
- [ ] Push events are received and logged
- [ ] Pull request events are received
- [ ] Activities are logged in database

---

# 🎉 Success!

If all checkboxes are ✅, your GitHub integration is fully configured!

You now have:
- ✅ Multi-tenant OAuth (users can connect their GitHub)
- ✅ Real-time webhooks (push, PR, issues)
- ✅ Automatic activity tracking
- ✅ GitHub App for advanced operations

---

# 📚 Additional Resources

- [GitHub OAuth Apps Documentation](https://docs.github.com/en/developers/apps/building-oauth-apps)
- [GitHub Apps Documentation](https://docs.github.com/en/developers/apps/building-github-apps)
- [GitHub Webhooks Documentation](https://docs.github.com/en/developers/webhooks-and-events/webhooks)
- [ngrok Documentation](https://ngrok.com/docs)

---

**Last Updated:** 2024-01-15
**Status:** Complete and Production-Ready
**Support:** Check backend logs for detailed error messages
