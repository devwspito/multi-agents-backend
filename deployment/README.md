# Multi-Agent Platform - Deployment Guide

## Quick Start (Single Command)

Deploy a new client VM with one command:

```bash
curl -sSL https://raw.githubusercontent.com/<org>/agents-software-arq/main/deployment/deploy.sh | sudo bash -s -- \
  --anthropic-key "sk-ant-xxx" \
  --github-client-id "Ov23lixxx" \
  --github-client-secret "xxx"
```

### Required Parameters

| Parameter | Description |
|-----------|-------------|
| `--anthropic-key` | Anthropic API key (sk-ant-...) |
| `--github-client-id` | GitHub OAuth Client ID |
| `--github-client-secret` | GitHub OAuth Client Secret |

### Optional Parameters

| Parameter | Description |
|-----------|-------------|
| `--github-app-id` | GitHub App ID (for advanced features) |
| `--github-private-key` | GitHub App private key |
| `--github-installation-id` | GitHub App installation ID |
| `--voyage-key` | Voyage AI key for embeddings |
| `--frontend-url` | Frontend URL (default: http://localhost:3000) |
| `--repo-url` | Custom repo URL |
| `--skip-disk` | Skip persistent disk setup (for local dev) |

---

## Manual Deployment

### Prerequisites

1. **Google Cloud VM**
   - Ubuntu 22.04 LTS
   - e2-standard-4 (4 vCPU, 16GB RAM) or larger
   - Persistent Disk attached at /dev/sdb

2. **Create Resources**
   ```bash
   # Create Persistent Disk
   gcloud compute disks create agents-data \
     --size=100GB \
     --type=pd-ssd \
     --zone=us-central1-a

   # Create VM with disk attached
   gcloud compute instances create agents-vm \
     --machine-type=e2-standard-4 \
     --image-family=ubuntu-2204-lts \
     --image-project=ubuntu-os-cloud \
     --disk=name=agents-data,device-name=data-disk,mode=rw,boot=no
   ```

### Step 1: Initial Setup

```bash
# SSH into VM
gcloud compute ssh agents-vm

# Download and run setup
git clone https://github.com/<org>/agents-software-arq.git /app
cd /app
sudo ./deployment/setup.sh
```

### Step 2: Configure Environment

```bash
# Edit .env with client values
nano /app/.env
```

### Step 3: Start Services

```bash
./deployment/start.sh
```

---

## Architecture

```
Client VM (Google Cloud)
├── /app                          ← Application code
├── /mnt/data                     ← Persistent Disk (SSD)
│   ├── agent-workspace/          ← Agent workspaces
│   │   └── task-{id}/
│   │       └── v3_backend/
│   │           └── .agents/      ← Artifacts backup
│   ├── mongodb-data/             ← MongoDB data
│   └── backups/                  ← Local backups
└── Docker containers
    ├── agents-backend
    └── mongodb
```

---

## Daily Operations

### Start/Stop

```bash
# Start
./deployment/start.sh

# Stop (keeps data)
./deployment/stop.sh

# Stop and remove containers
./deployment/stop.sh --clean
```

### View Logs

```bash
# All logs
docker compose -f docker-compose.prod.yml logs -f

# Backend only
docker logs -f agents-backend

# MongoDB only
docker logs -f agents-mongodb
```

### Health Check

```bash
curl http://localhost:3001/api/health
```

### Update Application

```bash
cd /app
git pull
./deployment/start.sh --build
```

---

## Backup & Recovery

### Automatic Backups (Recommended)

Create snapshot schedule in Google Cloud:

```bash
gcloud compute resource-policies create snapshot-schedule agents-backup \
  --region=us-central1 \
  --max-retention-days=7 \
  --daily-schedule \
  --start-time=02:00

gcloud compute disks add-resource-policies agents-data \
  --resource-policies=agents-backup \
  --zone=us-central1-a
```

### Manual Snapshot

```bash
gcloud compute disks snapshot agents-data \
  --snapshot-names="pre-upgrade-$(date +%Y%m%d)" \
  --zone=us-central1-a
```

### Restore from Snapshot

```bash
# Stop VM
gcloud compute instances stop agents-vm

# Create disk from snapshot
gcloud compute disks create agents-data-restored \
  --source-snapshot=<snapshot-name>

# Swap disks
gcloud compute instances detach-disk agents-vm --disk=agents-data
gcloud compute instances attach-disk agents-vm --disk=agents-data-restored

# Start VM
gcloud compute instances start agents-vm
```

---

## Workspace Cleanup

Cleanup is **DISABLED by default** - client controls their data.

### Manual Cleanup

```bash
# List workspaces with sizes
curl http://localhost:3001/api/cleanup/workspaces/stats

# Delete specific task workspace
curl -X DELETE http://localhost:3001/api/cleanup/workspace/{taskId}

# Clean all completed tasks
curl -X POST http://localhost:3001/api/cleanup/completed
```

### Enable Auto-Cleanup (Optional)

Add to `.env`:

```bash
WORKSPACE_AUTO_CLEANUP_ENABLED=true
WORKSPACE_CLEANUP_INTERVAL_HOURS=1
WORKSPACE_MAX_AGE_HOURS=168  # 7 days
```

---

## Troubleshooting

### Container won't start

```bash
# Check logs
docker logs agents-backend

# Check .env file
cat /app/.env | grep -v "KEY\|SECRET"

# Rebuild
./deployment/start.sh --build
```

### MongoDB connection issues

```bash
# Check if MongoDB is running
docker ps | grep mongodb

# Check MongoDB logs
docker logs agents-mongodb

# Restart MongoDB
docker restart agents-mongodb
```

### Disk full

```bash
# Check disk usage
df -h /mnt/data

# Resize disk (Google Cloud)
gcloud compute disks resize agents-data --size=200GB --zone=us-central1-a

# Extend filesystem (inside VM)
sudo resize2fs /dev/sdb
```

### Permission issues

```bash
# Fix workspace permissions
sudo chown -R 1001:1001 /mnt/data/agent-workspace
```

---

## Security Checklist

- [ ] Firewall allows only ports 3001, 443, 22
- [ ] SSH uses key authentication (no passwords)
- [ ] JWT_SECRET is unique and random
- [ ] Persistent Disk encrypted (default in GCP)
- [ ] MongoDB not exposed externally
- [ ] Regular backups enabled
- [ ] Monitoring configured

---

## Scaling

| Workload | VM Type | Disk Size |
|----------|---------|-----------|
| Light (1-2 tasks) | e2-medium | 50GB |
| Medium (3-5 tasks) | e2-standard-4 | 100GB |
| Heavy (5-10 tasks) | e2-standard-8 | 200GB |
