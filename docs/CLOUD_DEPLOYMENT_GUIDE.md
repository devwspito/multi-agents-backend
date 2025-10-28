# Cloud Deployment Guide - Multi-Agent Platform

## 📋 Requirements Analysis

Your project needs:
- ✅ **Node.js 20+** runtime
- ✅ **MongoDB** database
- ✅ **Persistent file system** (for git clones and workspaces)
- ✅ **WebSockets support** (Socket.IO)
- ✅ **Long-running processes** (orchestration can take minutes/hours)
- ✅ **Background cron jobs** (workspace cleanup, branch cleanup)
- ✅ **Git operations** (clone repos, create branches, PRs)
- ✅ **Environment variables** (API keys, secrets)

---

## 🏆 Recommended Options

### Option 1: Railway (⭐ EASIEST - Recommended for Quick Start)

**Why Railway?**
- ✅ Zero configuration deployment
- ✅ Automatic MongoDB addon
- ✅ Built-in environment variables management
- ✅ Supports WebSockets natively
- ✅ Persistent volumes for file system
- ✅ Free $5/month credit
- ✅ Automatic SSL certificates
- ✅ GitHub integration (auto-deploy on push)

**Cost**: ~$10-20/month (backend + MongoDB)

**Setup Steps**:

#### 1. Install Railway CLI
```bash
npm install -g @railway/cli
railway login
```

#### 2. Initialize Project
```bash
cd /path/to/agents-software-arq
railway init
```

#### 3. Add MongoDB
```bash
railway add mongodb
```

Railway will automatically set `MONGODB_URI` environment variable.

#### 4. Set Environment Variables
```bash
railway variables set ANTHROPIC_API_KEY="your-key"
railway variables set GITHUB_TOKEN="your-token"
railway variables set JWT_SECRET="your-secret"
railway variables set PORT=3001
railway variables set NODE_ENV=production
railway variables set FRONTEND_URL="https://your-frontend.com"
```

#### 5. Configure Volume (for workspaces)
```bash
# In railway.toml
[build]
builder = "NIXPACKS"

[deploy]
startCommand = "npm run build && npm start"
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 10

[[volumes]]
name = "workspaces"
mountPath = "/app/workspaces"
```

#### 6. Deploy
```bash
railway up
```

**Access**: Railway provides a public URL like `your-app.railway.app`

---

### Option 2: DigitalOcean App Platform (💪 BEST BALANCE)

**Why DigitalOcean?**
- ✅ Managed platform (less DevOps)
- ✅ MongoDB addon or managed cluster
- ✅ Good performance/cost ratio
- ✅ Persistent volumes
- ✅ Automatic scaling
- ✅ Built-in monitoring

**Cost**: ~$12-25/month (Basic + MongoDB)

**Setup Steps**:

#### 1. Create MongoDB Database
```bash
# Option A: Use DigitalOcean Managed MongoDB ($15/month)
# Go to: https://cloud.digitalocean.com/databases

# Option B: Use MongoDB Atlas (free tier)
# Go to: https://cloud.mongodb.com
```

#### 2. Create App Platform App
1. Go to https://cloud.digitalocean.com/apps
2. Click "Create App"
3. Connect your GitHub repo
4. Select branch: `main`
5. Auto-detect: Node.js

#### 3. Configure Build & Run
```yaml
# In .do/app.yaml (create this file)
name: multi-agent-platform
region: nyc
services:
  - name: backend
    github:
      repo: your-username/agents-software-arq
      branch: main
      deploy_on_push: true

    build_command: npm run build
    run_command: npm start

    environment_slug: node-js
    instance_count: 1
    instance_size_slug: basic-xs  # $5/month

    envs:
      - key: NODE_ENV
        value: production
      - key: PORT
        value: "3001"
      - key: ANTHROPIC_API_KEY
        value: ${ANTHROPIC_API_KEY}  # Set in dashboard
      - key: MONGODB_URI
        value: ${MONGODB_URI}
      - key: GITHUB_TOKEN
        value: ${GITHUB_TOKEN}
      - key: JWT_SECRET
        value: ${JWT_SECRET}

    health_check:
      http_path: /health
```

#### 4. Add Environment Variables
In DigitalOcean dashboard → App → Settings → Environment Variables

#### 5. Enable Persistent Storage (IMPORTANT!)
```yaml
# Add to .do/app.yaml
storage:
  - name: workspaces
    path: /app/workspaces
    size: 5GB  # Adjust as needed
```

---

### Option 3: Render (🎯 SIMPLE & AFFORDABLE)

**Why Render?**
- ✅ Very similar to Heroku but cheaper
- ✅ Free tier for testing
- ✅ Automatic SSL
- ✅ Zero-downtime deploys
- ✅ Easy to use dashboard

**Cost**: $7-15/month (Starter plan)

**Setup Steps**:

#### 1. Create Web Service
1. Go to https://dashboard.render.com
2. New → Web Service
3. Connect GitHub repo
4. Settings:
   - **Environment**: Node
   - **Build Command**: `npm run build`
   - **Start Command**: `npm start`
   - **Plan**: Starter ($7/month)

#### 2. Add MongoDB
```bash
# Option A: Use Render's MongoDB (coming soon)
# Option B: Use MongoDB Atlas (free tier)
```

#### 3. Configure Environment Variables
In Render dashboard:
```
ANTHROPIC_API_KEY=your-key
MONGODB_URI=your-mongodb-connection-string
GITHUB_TOKEN=your-token
JWT_SECRET=your-secret
NODE_ENV=production
PORT=3001
FRONTEND_URL=https://your-frontend.onrender.com
```

#### 4. Add Persistent Disk
Settings → Disks → Add Disk:
- **Mount Path**: `/app/workspaces`
- **Size**: 5 GB

---

### Option 4: DigitalOcean Droplet (🔧 FULL CONTROL)

**Why Droplet?**
- ✅ Full server control
- ✅ Can run multiple services
- ✅ Best performance/cost
- ✅ Root access for custom setup
- ❌ Requires more DevOps knowledge

**Cost**: $6-12/month (Basic Droplet)

**Setup Steps**:

#### 1. Create Droplet
```bash
# Create Ubuntu 22.04 droplet ($6/month)
# CPU: 1 vCPU
# RAM: 1 GB
# Storage: 25 GB SSD
```

#### 2. SSH and Setup Server
```bash
ssh root@your-droplet-ip

# Update system
apt update && apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Install MongoDB
wget -qO - https://www.mongodb.org/static/pgp/server-7.0.asc | apt-key add -
echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | tee /etc/apt/sources.list.d/mongodb-org-7.0.list
apt update
apt install -y mongodb-org
systemctl start mongod
systemctl enable mongod

# Install PM2 (process manager)
npm install -g pm2

# Install Nginx (reverse proxy)
apt install -y nginx
```

#### 3. Deploy Application
```bash
# Create app directory
mkdir -p /var/www/multi-agent-platform
cd /var/www/multi-agent-platform

# Clone repo
git clone https://github.com/your-username/agents-software-arq.git .

# Install dependencies
npm install

# Build
npm run build

# Create .env file
cat > .env << EOF
NODE_ENV=production
PORT=3001
MONGODB_URI=mongodb://localhost:27017/multi-agents
ANTHROPIC_API_KEY=your-key
GITHUB_TOKEN=your-token
JWT_SECRET=your-secret
FRONTEND_URL=https://your-domain.com
EOF

# Start with PM2
pm2 start dist/index.js --name multi-agent-platform
pm2 save
pm2 startup
```

#### 4. Configure Nginx Reverse Proxy
```bash
cat > /etc/nginx/sites-available/multi-agent-platform << 'EOF'
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;

        # WebSocket support
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

ln -s /etc/nginx/sites-available/multi-agent-platform /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx
```

#### 5. SSL Certificate (Let's Encrypt)
```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d your-domain.com
```

#### 6. Auto-deploy Script
```bash
cat > /var/www/multi-agent-platform/deploy.sh << 'EOF'
#!/bin/bash
cd /var/www/multi-agent-platform
git pull origin main
npm install
npm run build
pm2 restart multi-agent-platform
EOF

chmod +x deploy.sh
```

---

## 📊 Cost Comparison

| Platform | Backend | MongoDB | Total/Month | Difficulty |
|----------|---------|---------|-------------|------------|
| **Railway** | $10 | $10 | **$20** | ⭐ Easy |
| **Render** | $7 | $0 (Atlas free) | **$7** | ⭐⭐ Easy |
| **DigitalOcean App** | $12 | $15 | **$27** | ⭐⭐ Medium |
| **DigitalOcean Droplet** | $6 | $0 (self-hosted) | **$6** | ⭐⭐⭐⭐ Hard |
| **Heroku** | $25 | $15 | **$40** | ⭐⭐ Easy |

---

## 🎯 My Recommendation

### For Quick Start (⏱️ 10 minutes)
→ **Railway** - Zero configuration, just works

### For Best Cost/Performance (💰 Cheapest managed)
→ **Render** - $7/month with MongoDB Atlas free tier

### For Production Scale (🏢 Enterprise-ready)
→ **DigitalOcean App Platform** - Managed with good monitoring

### For Maximum Control (🔧 Expert users)
→ **DigitalOcean Droplet** - Full control, cheapest, but requires DevOps

---

## 🔐 Required Environment Variables

```bash
# Core
NODE_ENV=production
PORT=3001

# Database
MONGODB_URI=mongodb://localhost:27017/multi-agents

# Authentication
JWT_SECRET=your-super-secret-key-change-this
SESSION_SECRET=another-secret-key

# External APIs
ANTHROPIC_API_KEY=sk-ant-api03-...
GITHUB_TOKEN=ghp_...

# Frontend
FRONTEND_URL=https://your-frontend.com
CORS_ORIGIN=https://your-frontend.com

# Optional - Encryption (for env variables in DB)
ENV_ENCRYPTION_KEY=your-32-char-encryption-key

# Optional - Email notifications (when ready)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=noreply@multi-agents.com
```

---

## 🚀 Post-Deployment Checklist

- [ ] Server is running and accessible
- [ ] MongoDB connection successful
- [ ] GitHub integration working (can clone repos)
- [ ] Claude API calls working
- [ ] WebSocket connections working
- [ ] Workspace cleanup cron job running
- [ ] Logs are accessible
- [ ] Environment variables set correctly
- [ ] SSL certificate installed (HTTPS)
- [ ] Frontend can connect to backend
- [ ] Webhook endpoints accessible (if using)

---

## 🔍 Monitoring & Logs

### Railway
```bash
railway logs --tail
```

### Render
Dashboard → Logs (real-time)

### DigitalOcean Droplet
```bash
pm2 logs multi-agent-platform
pm2 monit
```

---

## 🆘 Troubleshooting

### "Cannot connect to MongoDB"
- Check `MONGODB_URI` format: `***REMOVED***host:port/database`
- Verify MongoDB is running: `systemctl status mongod`
- Check firewall rules

### "WebSocket connection failed"
- Ensure reverse proxy supports WebSocket upgrade
- Check CORS settings
- Verify Socket.IO is bound to correct port

### "Out of disk space"
- Workspace cleanup not running properly
- Check: `du -sh /app/workspaces`
- Run manual cleanup: `npm run cleanup-workspaces`

### "Git clone fails"
- GitHub token invalid or expired
- Check SSH key setup
- Verify repo access permissions

---

## 📝 Next Steps

1. Choose your platform (I recommend **Railway** for simplicity)
2. Set up MongoDB (Railway addon or MongoDB Atlas)
3. Configure environment variables
4. Deploy backend
5. Deploy frontend (separate guide)
6. Test end-to-end workflow
7. Set up monitoring and alerts

---

**Need help?** Check specific platform documentation:
- Railway: https://docs.railway.app
- Render: https://render.com/docs
- DigitalOcean: https://docs.digitalocean.com
- MongoDB Atlas: https://docs.atlas.mongodb.com
