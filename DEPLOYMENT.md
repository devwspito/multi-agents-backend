# 🚀 Deployment Guide - Hetzner Cloud

Complete guide to deploy the Multi-Agent Platform on Hetzner Cloud.

## 📋 Prerequisites

Before deploying, make sure you have:

### 1. Hetzner Cloud Account
- Sign up at [https://www.hetzner.com/cloud](https://www.hetzner.com/cloud)
- Add payment method
- **Recommended plan**: CX11 (€4.15/month) - 2GB RAM, 1 vCPU, 20GB SSD

### 2. Domain Name
- You need a domain pointing to your server IP
- Configure DNS A record: `api.yourdomain.com` → `YOUR_SERVER_IP`
- DNS propagation takes 5-60 minutes

### 3. Required Accounts & Keys

#### MongoDB Atlas (Free Tier)
1. Create account at [https://www.mongodb.com/cloud/atlas](https://www.mongodb.com/cloud/atlas)
2. Create a free cluster (M0 - Free Forever)
3. Get connection string: `mongodb+srv://username:password@cluster.mongodb.net/dbname`

#### Anthropic API Key
1. Sign up at [https://console.anthropic.com](https://console.anthropic.com)
2. Add credits ($5 minimum)
3. Generate API key: Settings → API Keys → Create Key

#### GitHub OAuth App
1. Go to [https://github.com/settings/developers](https://github.com/settings/developers)
2. Click "New OAuth App"
3. Fill in:
   - **Application name**: Multi-Agent Platform
   - **Homepage URL**: `https://api.yourdomain.com`
   - **Authorization callback URL**: `https://api.yourdomain.com/api/auth/github/callback`
4. Save **Client ID** and **Client Secret**

---

## 🖥️ Step 1: Create Hetzner Server

### Option A: Via Hetzner Cloud Console (Recommended)

1. **Login** to [https://console.hetzner.cloud](https://console.hetzner.cloud)

2. **Create Project**
   - Click "New Project"
   - Name: "multi-agent-platform"

3. **Add Server**
   - Click "Add Server"
   - **Location**: Choose closest to your users
     - 🇩🇪 Germany (Falkenstein/Nuremberg) - Europe
     - 🇫🇮 Finland (Helsinki) - Europe
     - 🇺🇸 USA (Ashburn) - North America
   - **Image**: Ubuntu 24.04
   - **Type**: CX11 (€4.15/month, 2GB RAM)
   - **Networking**:
     - ✅ Enable Public IPv4
     - ✅ Enable Public IPv6 (optional)
   - **SSH Keys**: Add your SSH key (or use password)
   - **Name**: multi-agent-platform
   - Click "Create & Buy Now"

4. **Get Server IP**
   - Copy the IPv4 address (e.g., `95.217.123.45`)

5. **Configure DNS**
   - Go to your domain registrar
   - Add A record:
     ```
     Type: A
     Name: api (or @)
     Value: YOUR_SERVER_IP
     TTL: 300
     ```
   - Wait 5-60 minutes for DNS propagation

### Option B: Via Hetzner CLI (Advanced)

```bash
# Install hcloud CLI
brew install hcloud  # macOS
# or
curl -L https://github.com/hetznercloud/cli/releases/download/v1.39.0/hcloud-linux-amd64.tar.gz | tar xz

# Login
hcloud context create multi-agent

# Create SSH key
hcloud ssh-key create --name my-key --public-key-from-file ~/.ssh/id_rsa.pub

# Create server
hcloud server create \
  --name multi-agent-platform \
  --type cx11 \
  --image ubuntu-24.04 \
  --location nbg1 \
  --ssh-key my-key

# Get IP
hcloud server ip multi-agent-platform
```

---

## 🚀 Step 2: Deploy Application

### Connect to Server

```bash
# Replace with your server IP
ssh root@YOUR_SERVER_IP
```

### Run Deployment Script

```bash
# Download and execute deployment script
bash <(curl -s https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/deploy-hetzner.sh)
```

### Deployment Wizard

The script will ask you for:

```
1. Domain name: api.yourdomain.com
2. Email: your@email.com (for SSL certificate)
3. GitHub repository URL: https://github.com/YOUR_USERNAME/YOUR_REPO
4. GitHub branch: main
5. MongoDB Atlas connection string: mongodb+srv://...
6. Anthropic API key: sk-ant-api03-...
7. GitHub OAuth Client ID: Ov23li...
8. GitHub OAuth Client Secret: ...
9. Frontend URL: https://app.yourdomain.com
```

### What the Script Does

The deployment script automatically:

1. ✅ Updates Ubuntu system packages
2. ✅ Installs Node.js 20
3. ✅ Installs Git, Nginx, Certbot
4. ✅ Installs PM2 process manager
5. ✅ Configures UFW firewall
6. ✅ Clones your repository
7. ✅ Installs npm dependencies
8. ✅ Creates `.env` file with your credentials
9. ✅ Builds TypeScript application
10. ✅ Configures Nginx as reverse proxy
11. ✅ Installs SSL certificate (Let's Encrypt)
12. ✅ Starts application with PM2
13. ✅ Configures auto-restart on reboot
14. ✅ Sets up log rotation
15. ✅ Enables automatic security updates

**Deployment time**: ~5-10 minutes

---

## ✅ Step 3: Verify Deployment

### Test API Endpoint

```bash
# Test health endpoint
curl https://api.yourdomain.com/health

# Expected response:
{
  "success": true,
  "message": "Multi-Agent Platform is running",
  "timestamp": "2025-10-07T...",
  "uptime": 123.456
}
```

### Check Application Status

```bash
# SSH to server
ssh root@YOUR_SERVER_IP

# Check PM2 status
pm2 status

# View logs
pm2 logs multi-agents

# Monitor resources
pm2 monit
```

### Test GitHub OAuth Flow

1. Go to: `https://api.yourdomain.com/api/auth/github`
2. Should redirect to GitHub login
3. After login, redirects back with JWT token

---

## 🔧 Management Commands

### On Server (via SSH)

```bash
# Application Management
pm2 status                  # Check app status
pm2 restart multi-agents    # Restart app
pm2 stop multi-agents       # Stop app
pm2 start multi-agents      # Start app
pm2 logs multi-agents       # View logs (Ctrl+C to exit)
pm2 logs multi-agents --lines 100  # Last 100 lines
pm2 monit                   # Resource monitor

# Update Application
update-multi-agents         # Pull latest code & restart

# Nginx Management
nginx -t                    # Test configuration
systemctl reload nginx      # Reload config
systemctl restart nginx     # Restart nginx
systemctl status nginx      # Check status

# SSL Certificate Renewal (automatic)
certbot renew              # Manual renewal test
certbot certificates       # Check certificate status

# System Monitoring
htop                       # Resource usage
df -h                      # Disk space
free -h                    # Memory usage
journalctl -u nginx        # Nginx system logs
```

---

## 🔄 Updating Your Application

### Method 1: Using Update Script (Easiest)

```bash
# SSH to server
ssh root@YOUR_SERVER_IP

# Run update command
update-multi-agents
```

This will:
1. Pull latest code from GitHub
2. Install new dependencies
3. Build TypeScript
4. Restart with PM2

### Method 2: Manual Update

```bash
cd /var/www/multi-agents
git pull origin main
npm ci --production
npm run build
pm2 restart multi-agents
```

### Method 3: Zero-Downtime Deployment

```bash
cd /var/www/multi-agents
git pull origin main
npm ci --production
npm run build
pm2 reload multi-agents  # Reload instead of restart
```

---

## 📊 Monitoring & Logs

### Application Logs

```bash
# Real-time logs
pm2 logs multi-agents

# Last 100 lines
pm2 logs multi-agents --lines 100

# Error logs only
pm2 logs multi-agents --err

# Save logs to file
pm2 logs multi-agents > app-logs.txt
```

### Nginx Access Logs

```bash
# Access logs
tail -f /var/log/nginx/access.log

# Error logs
tail -f /var/log/nginx/error.log
```

### System Logs

```bash
# System journal
journalctl -f

# Nginx logs
journalctl -u nginx -f

# Last 50 lines
journalctl -n 50
```

---

## 🐛 Troubleshooting

### Application Won't Start

```bash
# Check logs
pm2 logs multi-agents

# Check environment file
cat /var/www/multi-agents/.env

# Test manually
cd /var/www/multi-agents
npm start
```

### Port Already in Use

```bash
# Find process on port 3001
lsof -ti:3001

# Kill process
kill -9 $(lsof -ti:3001)

# Restart
pm2 restart multi-agents
```

### SSL Certificate Issues

```bash
# Check certificate
certbot certificates

# Renew certificate
certbot renew --force-renewal

# Test Nginx config
nginx -t

# Reload Nginx
systemctl reload nginx
```

### Out of Memory

```bash
# Check memory
free -h

# Restart application
pm2 restart multi-agents

# Or upgrade server
# Hetzner Console → Resize Server → CX21 (4GB RAM)
```

### MongoDB Connection Failed

```bash
# Check environment
cat /var/www/multi-agents/.env | grep MONGODB

# Test connection from server
curl -I https://cloud.mongodb.com

# Check MongoDB Atlas whitelist
# Add server IP to MongoDB Atlas Network Access
```

---

## 🔒 Security Best Practices

### 1. Change SSH Port (Optional)

```bash
# Edit SSH config
nano /etc/ssh/sshd_config

# Change port (e.g., Port 2222)
# Restart SSH
systemctl restart sshd

# Update firewall
ufw allow 2222/tcp
ufw delete allow 22/tcp
```

### 2. Disable Root Login

```bash
# Create non-root user
adduser deployer
usermod -aG sudo deployer

# Disable root SSH login
nano /etc/ssh/sshd_config
# Set: PermitRootLogin no

# Restart SSH
systemctl restart sshd
```

### 3. Enable Fail2Ban

```bash
apt-get install -y fail2ban
systemctl enable fail2ban
systemctl start fail2ban
```

### 4. Regular Backups

```bash
# Backup application
tar -czf backup-$(date +%Y%m%d).tar.gz /var/www/multi-agents

# Backup to local machine
scp root@YOUR_SERVER_IP:/root/backup-*.tar.gz ./
```

### 5. Environment Variables

```bash
# NEVER commit .env to Git
# NEVER expose API keys
# Rotate secrets regularly
```

---

## 💰 Cost Breakdown

### Hetzner CX11 Server
- **Cost**: €4.15/month (~$4.50/month)
- **RAM**: 2GB
- **CPU**: 1 vCPU
- **Storage**: 20GB SSD
- **Traffic**: 20TB included

### MongoDB Atlas
- **Cost**: FREE (M0 cluster)
- **Storage**: 512MB
- **RAM**: Shared

### Anthropic API
- **Cost**: Pay-as-you-go
- **Pricing**: ~$3 per million input tokens
- **Estimate**: $10-50/month depending on usage

### Domain Name
- **Cost**: ~$12/year (varies)

### SSL Certificate
- **Cost**: FREE (Let's Encrypt)

**Total Monthly Cost**: ~€4.15 + API usage (~$5-15) = **~€10-20/month (~$11-22/month)**

---

## 📞 Support

### Hetzner Support
- Email: support@hetzner.com
- Docs: https://docs.hetzner.com
- Community: https://community.hetzner.com

### Application Issues
- GitHub Issues: YOUR_REPO/issues
- Claude Agent SDK: https://docs.anthropic.com/en/api/agent-sdk

---

## 🎉 Next Steps

After deployment:

1. ✅ Test all API endpoints
2. ✅ Configure frontend to use API URL
3. ✅ Set up monitoring (optional: PM2 Plus)
4. ✅ Create regular backups
5. ✅ Monitor costs and usage
6. ✅ Set up staging environment (optional)

Happy coding! 🚀
