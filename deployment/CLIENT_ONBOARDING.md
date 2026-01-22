# AI Development Team - Client Onboarding Guide

Welcome to AI Development Team! This guide will help you get your developers connected to your dedicated VM.

## For IT Administrators

### Your VM Details

Your dedicated AI Development Team server is hosted at:

- **Server URL**: `https://[your-domain].aidevteam.com`
- **API Endpoint**: `https://[your-domain].aidevteam.com/api`

### Required Configuration (One-time Setup)

1. **Anthropic API Key**: Add your company's Anthropic API key to the server
   - Log into the VM via SSH
   - Edit `/home/aidevteam/app/.env`
   - Add: `ANTHROPIC_API_KEY=sk-ant-...`
   - Restart: `pm2 restart aidevteam`

2. **GitHub OAuth App** (for developer authentication):
   - Go to GitHub → Settings → Developer Settings → OAuth Apps → New
   - Application name: "AI Dev Team - [Your Company]"
   - Homepage URL: `https://[your-domain].aidevteam.com`
   - Callback URL: `https://[your-domain].aidevteam.com/api/auth/github/callback`
   - Save the Client ID and Client Secret
   - Add to `.env`:
     ```
     GITHUB_CLIENT_ID=...
     GITHUB_CLIENT_SECRET=...
     ```

---

## For Developers

### Installation (5 minutes)

#### Option A: npm (Recommended)

```bash
npm install -g @aidevteam/cli
```

#### Option B: Direct Download

```bash
curl -fsSL https://install.aidevteam.com | bash
```

### First-Time Setup

1. **Connect to your company server:**

```bash
aidev connect https://yourcompany.aidevteam.com
```

2. **Start the CLI:**

```bash
aidev
```

3. **Login with GitHub:**
   - Select "Login" when prompted
   - A browser window will open
   - Authorize with your GitHub account
   - Return to the terminal

### Daily Usage

```bash
# Start the interactive CLI
aidev

# Check your connection
aidev status

# Disconnect (logout)
aidev disconnect

# Reset everything
aidev --reset
```

### CLI Navigation

| Key | Action |
|-----|--------|
| ↑/↓ | Navigate menus |
| Enter | Select option |
| Esc/b | Go back |
| r | Refresh data |
| q | Quit |

### Creating Tasks

1. From Dashboard, select "📋 New Task"
2. Select the project to work on
3. Select repositories to include
4. Enter task title (what you want built)
5. Enter detailed description (requirements)
6. Watch the AI team work!

### Monitoring Tasks

- **Live logs**: View real-time progress
- **Phase progress**: See current development phase
- **Approvals**: Approve or reject code reviews
- **Actions**: Pause, resume, or cancel tasks

---

## Troubleshooting

### "Connection refused"
- Check that you're using the correct server URL
- Verify your internet connection
- Contact your IT administrator

### "Unauthorized" or login issues
- Run `aidev disconnect` and try logging in again
- Clear cache: `aidev --reset`
- Make sure GitHub OAuth is configured on the server

### Slow or unresponsive
- Check server status: `aidev status`
- The server might be processing heavy tasks
- Contact your IT administrator

---

## Support

- **Documentation**: https://docs.aidevteam.com
- **Issues**: Contact your IT administrator
- **Emergency**: support@aidevteam.com
