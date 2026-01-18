# Production Setup - Single-Tenant Architecture

## Overview

Each client gets their own Google Cloud VM with a Persistent Disk for complete data isolation and ownership.

```
Client VM (Google Cloud)
├── /app                          ← Application code
├── /mnt/data                     ← Persistent Disk (SSD)
│   ├── agent-workspace/          ← Agent workspaces
│   ├── mongodb-data/             ← MongoDB data
│   └── backups/                  ← Local backups
└── Docker containers
    ├── agents-backend
    └── mongodb
```

## 1. Google Cloud Setup

### Create VM with Persistent Disk

```bash
# Variables
PROJECT_ID="client-project-id"
ZONE="us-central1-a"
VM_NAME="agents-vm"
DISK_NAME="agents-data"
DISK_SIZE="100GB"  # Adjust based on expected usage

# Create Persistent Disk (SSD for better git performance)
gcloud compute disks create $DISK_NAME \
  --project=$PROJECT_ID \
  --zone=$ZONE \
  --size=$DISK_SIZE \
  --type=pd-ssd

# Create VM with disk attached
gcloud compute instances create $VM_NAME \
  --project=$PROJECT_ID \
  --zone=$ZONE \
  --machine-type=e2-standard-4 \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=20GB \
  --disk=name=$DISK_NAME,device-name=data-disk,mode=rw,boot=no
```

### Mount Persistent Disk

```bash
# SSH into VM
gcloud compute ssh $VM_NAME --zone=$ZONE

# Format disk (ONLY FIRST TIME!)
sudo mkfs.ext4 -m 0 -F -E lazy_itable_init=0,lazy_journal_init=0,discard /dev/sdb

# Create mount point
sudo mkdir -p /mnt/data

# Mount disk
sudo mount -o discard,defaults /dev/sdb /mnt/data

# Auto-mount on reboot
echo "/dev/sdb /mnt/data ext4 discard,defaults,nofail 0 2" | sudo tee -a /etc/fstab

# Set permissions
sudo chown -R $USER:$USER /mnt/data
```

## 2. Application Configuration

### Environment Variables (.env.production)

```bash
# Storage Configuration
AGENT_WORKSPACE_DIR=/mnt/data/agent-workspace
MONGODB_DATA_DIR=/mnt/data/mongodb-data

# MongoDB
MONGODB_URI=mongodb://localhost:27017/agents-prod

# API Keys (set per client)
ANTHROPIC_API_KEY=sk-ant-...

# Server
PORT=3001
NODE_ENV=production

# Git timeouts (generous for large repos)
GIT_CLONE_TIMEOUT=600000      # 10 min
GIT_PUSH_TIMEOUT=600000       # 10 min
GIT_COMMIT_TIMEOUT=300000     # 5 min

# Recovery
AUTO_RECOVER_ON_STARTUP=true
CANCELLATION_CHECK_INTERVAL_MS=5000

# Workspace Cleanup (DISABLED by default - client must opt-in)
# WORKSPACE_AUTO_CLEANUP_ENABLED=true          # Uncomment to enable
# WORKSPACE_CLEANUP_INTERVAL_HOURS=1           # How often to check (default: 1 hour)
# WORKSPACE_MAX_AGE_HOURS=168                  # Max age before deletion (default: 7 days)
```

### Docker Compose (docker-compose.prod.yml)

```yaml
version: '3.8'

services:
  mongodb:
    image: mongo:6
    restart: always
    volumes:
      - /mnt/data/mongodb-data:/data/db
    networks:
      - agents-network

  agents-backend:
    build: .
    restart: always
    ports:
      - "3001:3001"
    environment:
      - NODE_ENV=production
      - AGENT_WORKSPACE_DIR=/mnt/data/agent-workspace
      - MONGODB_URI=mongodb://mongodb:27017/agents-prod
    volumes:
      - /mnt/data/agent-workspace:/mnt/data/agent-workspace
    depends_on:
      - mongodb
    networks:
      - agents-network

networks:
  agents-network:
    driver: bridge
```

## 3. Directory Structure

```bash
# Create directory structure
sudo mkdir -p /mnt/data/{agent-workspace,mongodb-data,backups}
sudo chown -R $USER:$USER /mnt/data
```

### Workspace Hierarchy

```
/mnt/data/agent-workspace/
├── task-{taskId-1}/
│   ├── team-1/
│   │   ├── v3_backend/          ← Cloned repo
│   │   │   └── .agents/         ← Local backup artifacts
│   │   └── story-ABC/           ← Isolated story workspace
│   └── team-2/
├── task-{taskId-2}/
└── .cleanup-marker              ← For cleanup service
```

## 4. Backup Strategy

### Automated Disk Snapshots

```bash
# Create snapshot schedule (daily, keep 7 days)
gcloud compute resource-policies create snapshot-schedule agents-backup-policy \
  --project=$PROJECT_ID \
  --region=us-central1 \
  --max-retention-days=7 \
  --on-source-disk-delete=apply-retention-policy \
  --daily-schedule \
  --start-time=02:00

# Attach to disk
gcloud compute disks add-resource-policies $DISK_NAME \
  --project=$PROJECT_ID \
  --zone=$ZONE \
  --resource-policies=agents-backup-policy
```

### Manual Snapshot

```bash
# Create manual snapshot before major changes
gcloud compute disks snapshot $DISK_NAME \
  --project=$PROJECT_ID \
  --zone=$ZONE \
  --snapshot-names="pre-upgrade-$(date +%Y%m%d)"
```

## 5. Recovery Procedures

### VM Restart Recovery

The application automatically recovers interrupted tasks on startup:

1. `OrchestrationRecoveryService.recoverAllInterruptedOrchestrations()` runs on startup
2. Finds tasks with `status='in_progress'`
3. Verifies workspace exists on Persistent Disk
4. Syncs from Local backup if MongoDB is empty
5. Resumes from last completed phase

### Disk Recovery (if disk corrupted)

```bash
# 1. Stop VM
gcloud compute instances stop $VM_NAME --zone=$ZONE

# 2. Create new disk from latest snapshot
gcloud compute disks create $DISK_NAME-recovered \
  --source-snapshot=<snapshot-name> \
  --zone=$ZONE

# 3. Detach old disk, attach new one
gcloud compute instances detach-disk $VM_NAME --disk=$DISK_NAME --zone=$ZONE
gcloud compute instances attach-disk $VM_NAME --disk=$DISK_NAME-recovered --zone=$ZONE

# 4. Start VM
gcloud compute instances start $VM_NAME --zone=$ZONE
```

## 6. Workspace Cleanup (Client-Controlled)

### ⚠️ Automatic Cleanup is DISABLED by Default

The client owns their data. Workspace cleanup must be explicitly enabled.

### Option A: Keep Auto-Cleanup Disabled (Recommended)

Workspaces are preserved indefinitely. Client manages disk space manually via:

```bash
# Delete specific task workspace
curl -X DELETE http://localhost:3001/api/cleanup/workspace/{taskId}

# List all workspaces with sizes
curl http://localhost:3001/api/cleanup/workspaces/stats

# Clean all completed tasks (manual trigger)
curl -X POST http://localhost:3001/api/cleanup/completed
```

### Option B: Enable Auto-Cleanup (Opt-In)

If client wants automatic cleanup, add to `.env`:

```bash
# Enable automatic workspace cleanup
WORKSPACE_AUTO_CLEANUP_ENABLED=true

# Optional: Customize cleanup settings
WORKSPACE_CLEANUP_INTERVAL_HOURS=1    # How often to run cleanup (default: 1 hour)
WORKSPACE_MAX_AGE_HOURS=168           # Delete workspaces older than X hours (default: 7 days)
```

### Recommended Strategy for Clients

| Scenario | Setting |
|----------|---------|
| Auditing/Compliance required | Keep disabled, use disk snapshots |
| Limited disk space | Enable with 7-day retention |
| Debugging needed | Keep disabled, manual cleanup |
| High volume (many tasks) | Enable with 24-hour retention |

---

## 7. Monitoring

### Health Check Endpoint

```bash
# Add to your API
GET /api/health
{
  "status": "ok",
  "workspace": {
    "path": "/mnt/data/agent-workspace",
    "exists": true,
    "writable": true
  },
  "mongodb": "connected",
  "activeOrchestrations": 2
}
```

### Disk Usage Alert

```bash
# Cron job to check disk usage
*/30 * * * * df -h /mnt/data | awk 'NR==2 {if ($5+0 > 80) print "ALERT: Disk usage at "$5}'
```

## 8. Security Checklist

- [ ] VM firewall allows only necessary ports (3001, 443)
- [ ] SSH keys properly configured (no password auth)
- [ ] Persistent Disk encrypted at rest (default in GCP)
- [ ] Environment variables secured (not in git)
- [ ] MongoDB not exposed externally
- [ ] Regular snapshots enabled
- [ ] Monitoring/alerting configured

## 10. Scaling Considerations

| Workload | Recommended VM | Disk Size |
|----------|----------------|-----------|
| Light (1-2 concurrent tasks) | e2-medium | 50GB |
| Medium (3-5 concurrent tasks) | e2-standard-4 | 100GB |
| Heavy (5-10 concurrent tasks) | e2-standard-8 | 200GB |

### Disk Resize (no downtime)

```bash
# Resize disk
gcloud compute disks resize $DISK_NAME --size=200GB --zone=$ZONE

# Inside VM, extend filesystem
sudo resize2fs /dev/sdb
```
