# Render Deployment Guide

## Quick Deploy to Render

### Prerequisites
- GitHub account with your repository
- MongoDB Atlas account (free tier available)
- Anthropic API key

### Step 1: Prepare MongoDB Atlas (Free)

1. Go to https://cloud.mongodb.com
2. Create a free cluster
3. Create a database user
4. Get connection string (should look like: `mongodb+srv://user:pass@cluster.mongodb.net/dbname`)

### Step 2: Push to GitHub

```bash
# Make sure all changes are committed
git add .
git commit -m "feat: Ready for Render deployment"
git push origin main
```

### Step 3: Deploy to Render

#### Option A: Using render.yaml (Automatic)

1. Go to https://dashboard.render.com
2. Click "New +" → "Blueprint"
3. Connect your GitHub repository
4. Render will automatically detect `render.yaml`
5. Set environment variables:
   - `MONGODB_URI`: Your MongoDB Atlas connection string
   - `ANTHROPIC_API_KEY`: Your Claude API key
   - `GITHUB_TOKEN`: Your GitHub personal access token
   - `JWT_SECRET`: Generate random string (e.g., `openssl rand -base64 32`)
   - `SESSION_SECRET`: Generate random string
   - `FRONTEND_URL`: Your frontend URL (or leave empty for now)
   - `CORS_ORIGIN`: Same as FRONTEND_URL
6. Click "Apply"

#### Option B: Manual Setup

1. Go to https://dashboard.render.com
2. Click "New +" → "Web Service"
3. Connect your GitHub repository
4. Configure:
   - **Name**: multi-agent-backend
   - **Region**: Oregon (or closest to you)
   - **Branch**: main
   - **Root Directory**: (leave empty)
   - **Environment**: Node
   - **Build Command**: `npm install --include=dev && npm run build`
   - **Start Command**: `npm start`
   - **Plan**: Starter ($7/month) or Free (with limitations)

5. Add Environment Variables (click "Advanced"):
   ```
   NODE_ENV=production
   PORT=3001
   MONGODB_URI=your-mongodb-connection-string
   ANTHROPIC_API_KEY=sk-ant-api03-...
   GITHUB_TOKEN=ghp_...
   JWT_SECRET=your-generated-secret
   SESSION_SECRET=your-generated-secret
   FRONTEND_URL=https://your-frontend.onrender.com
   CORS_ORIGIN=https://your-frontend.onrender.com
   ```

6. Click "Create Web Service"

### Step 4: Verify Deployment

1. Wait for build to complete (~2-3 minutes)
2. Once deployed, Render gives you a URL like: `https://multi-agent-backend.onrender.com`
3. Test health endpoint:
   ```bash
   curl https://your-app.onrender.com/health
   # Should return: {"status":"healthy"}
   ```

### Step 5: Common Issues & Solutions

#### Build Error: "Could not find declaration file"
**Solution**: The `render.yaml` file fixes this by using `npm install --include=dev`

If you deployed manually, update your Build Command to:
```bash
npm install --include=dev && npm run build
```

#### Build Error: "Cannot find module 'minimatch'"
**Solution**: Already fixed - minimatch is now in dependencies

#### Connection Error: MongoDB
**Check**:
- MongoDB Atlas IP whitelist includes `0.0.0.0/0` (allow all)
- Connection string is correct
- Database user has read/write permissions

#### CORS Errors
**Check**:
- `CORS_ORIGIN` matches your frontend URL exactly
- Frontend URL includes protocol (https://)

### Render-Specific Configuration

#### Free Tier Limitations
- ❌ Server spins down after 15 minutes of inactivity
- ❌ 750 hours/month limit
- ❌ Build timeouts after 15 minutes
- ✅ Good for testing/demos

#### Starter Plan ($7/month)
- ✅ Always on (no spin down)
- ✅ Unlimited hours
- ✅ Better performance
- ✅ Recommended for production

#### Persistent Disk (Optional - $1/GB/month)
If you need persistent workspace storage:

1. In Render dashboard → Your Service → "Disks"
2. Click "Add Disk"
3. Mount Path: `/app/workspaces`
4. Size: 5 GB
5. Click "Save"

### Environment Variables Reference

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `NODE_ENV` | Yes | Environment | `production` |
| `PORT` | Yes | Port | `3001` |
| `MONGODB_URI` | Yes | MongoDB connection | `mongodb+srv://...` |
| `ANTHROPIC_API_KEY` | Yes | Claude API key | `sk-ant-api03-...` |
| `GITHUB_TOKEN` | Yes | GitHub PAT | `ghp_...` |
| `JWT_SECRET` | Yes | JWT signing key | Random 32+ chars |
| `SESSION_SECRET` | Yes | Session signing key | Random 32+ chars |
| `FRONTEND_URL` | Optional | Frontend URL | `https://app.com` |
| `CORS_ORIGIN` | Optional | CORS origin | `https://app.com` |
| `ENV_ENCRYPTION_KEY` | Optional | Encryption key | Random 32 chars |

### Generate Secrets

```bash
# Generate JWT_SECRET
openssl rand -base64 32

# Generate SESSION_SECRET
openssl rand -base64 32

# Generate ENV_ENCRYPTION_KEY (32 chars)
openssl rand -hex 16
```

### Logs & Monitoring

#### View Logs
1. Render Dashboard → Your Service → "Logs"
2. Or use Render CLI:
   ```bash
   npm install -g @render-tools/render-cli
   render logs -f
   ```

#### Health Check
Render automatically pings `/health` every 30 seconds.

If your app doesn't respond, Render will restart it.

### Auto-Deploy on Push

Render automatically deploys when you push to `main`:

```bash
git add .
git commit -m "feat: New feature"
git push origin main
# Render will automatically deploy
```

### Scaling

#### Vertical Scaling (More Power)
1. Render Dashboard → Your Service → "Settings"
2. Change Plan: Starter → Standard → Pro
3. Click "Save Changes"

#### Horizontal Scaling (More Instances)
Available on Pro plan and above:
1. Settings → "Scaling"
2. Set number of instances
3. Render handles load balancing automatically

### Cost Estimation

#### Development/Testing
- Render Free Plan: $0
- MongoDB Atlas Free: $0
- **Total**: $0/month

#### Production (Recommended)
- Render Starter: $7/month
- MongoDB Atlas M0 (free): $0
- **Total**: $7/month

#### Production (High Traffic)
- Render Standard: $25/month
- MongoDB Atlas M10: $57/month
- Persistent Disk (5GB): $5/month
- **Total**: $87/month

### Troubleshooting

#### Build Fails
1. Check logs for specific error
2. Verify all dependencies in package.json
3. Test build locally: `npm run build`

#### Runtime Errors
1. Check environment variables are set
2. View logs: Render Dashboard → Logs
3. Check MongoDB connection

#### Slow Performance (Free Tier)
- Upgrade to Starter plan ($7/month)
- Server won't spin down

#### Out of Memory
- Upgrade to Standard plan (more RAM)
- Optimize MongoDB queries

### Next Steps After Deploy

1. ✅ Test all endpoints
2. ✅ Deploy frontend (separate Render service)
3. ✅ Update CORS_ORIGIN with frontend URL
4. ✅ Test end-to-end workflow
5. ✅ Set up monitoring/alerts
6. ✅ Configure custom domain (optional)

### Support

- Render Docs: https://render.com/docs
- Render Community: https://community.render.com
- MongoDB Atlas Docs: https://docs.atlas.mongodb.com

---

**Status**: Ready to Deploy ✅
**Estimated Setup Time**: 15 minutes
**Cost**: $0 (free) or $7/month (production)
