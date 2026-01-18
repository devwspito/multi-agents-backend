#!/bin/bash
# ============================================================================
# Multi-Agent Platform - Provisioning Script para Nuevo Cliente
# ============================================================================
# Uso: ./provision-client.sh --name acme --anthropic-key sk-ant-xxx
#
# Este script automatiza:
# 1. Crear VM en Google Cloud
# 2. Configurar disco persistente
# 3. Instalar Docker
# 4. Generar .env
# 5. Desplegar la aplicación
#
# Prerequisitos:
# - gcloud CLI instalado y autenticado con cuenta del cliente
# - Billing habilitado en el proyecto
# ============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Defaults
REGION="us-central1"
ZONE="${REGION}-a"
MACHINE_TYPE="e2-standard-4"
DISK_SIZE="100GB"
DOCKER_IMAGE="multiagents/backend:latest"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --name) CLIENT_NAME="$2"; shift 2 ;;
    --anthropic-key) ANTHROPIC_KEY="$2"; shift 2 ;;
    --github-client-id) GITHUB_CLIENT_ID="$2"; shift 2 ;;
    --github-client-secret) GITHUB_CLIENT_SECRET="$2"; shift 2 ;;
    --mongodb-uri) MONGODB_URI="$2"; shift 2 ;;
    --region) REGION="$2"; ZONE="${REGION}-a"; shift 2 ;;
    --machine-type) MACHINE_TYPE="$2"; shift 2 ;;
    --skip-gcp) SKIP_GCP="true"; shift ;;
    --vm-ip) VM_IP="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Validate
if [ -z "$CLIENT_NAME" ]; then
  echo -e "${RED}❌ --name is required${NC}"
  echo "Usage: ./provision-client.sh --name acme --anthropic-key sk-ant-xxx"
  exit 1
fi

PROJECT_ID="${CLIENT_NAME}-agents"
VM_NAME="${CLIENT_NAME}-agents"
DISK_NAME="${CLIENT_NAME}-data"

echo ""
echo -e "${BLUE}╔══════════════════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║        Multi-Agent Platform - Provisioning: ${CLIENT_NAME}${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════════════════════╝${NC}"
echo ""

# ============================================================================
# STEP 1: Google Cloud Setup
# ============================================================================
if [ "$SKIP_GCP" != "true" ]; then
  echo -e "${GREEN}[1/5]${NC} Setting up Google Cloud..."
  
  # Check if project exists, create if not
  if ! gcloud projects describe $PROJECT_ID &>/dev/null; then
    echo "   Creating project: $PROJECT_ID"
    gcloud projects create $PROJECT_ID --name="Multi-Agent Platform - ${CLIENT_NAME}"
  fi
  
  gcloud config set project $PROJECT_ID
  
  # Enable required APIs
  echo "   Enabling Compute Engine API..."
  gcloud services enable compute.googleapis.com
  
  # Create disk
  if ! gcloud compute disks describe $DISK_NAME --zone=$ZONE &>/dev/null; then
    echo "   Creating persistent disk..."
    gcloud compute disks create $DISK_NAME \
      --size=$DISK_SIZE \
      --type=pd-ssd \
      --zone=$ZONE
  fi
  
  # Create VM
  if ! gcloud compute instances describe $VM_NAME --zone=$ZONE &>/dev/null; then
    echo "   Creating VM..."
    gcloud compute instances create $VM_NAME \
      --machine-type=$MACHINE_TYPE \
      --image-family=ubuntu-2204-lts \
      --image-project=ubuntu-os-cloud \
      --boot-disk-size=20GB \
      --disk=name=$DISK_NAME,device-name=data-disk,mode=rw,boot=no \
      --zone=$ZONE \
      --tags=http-server,https-server
  fi
  
  # Firewall
  if ! gcloud compute firewall-rules describe allow-agents-api &>/dev/null; then
    echo "   Creating firewall rules..."
    gcloud compute firewall-rules create allow-agents-api \
      --allow=tcp:3001,tcp:3000,tcp:443 \
      --target-tags=http-server
  fi
  
  # Get IP
  VM_IP=$(gcloud compute instances describe $VM_NAME --zone=$ZONE --format='get(networkInterfaces[0].accessConfigs[0].natIP)')
  
  # Snapshot policy
  if ! gcloud compute resource-policies describe ${CLIENT_NAME}-backup --region=$REGION &>/dev/null; then
    echo "   Creating backup policy..."
    gcloud compute resource-policies create snapshot-schedule ${CLIENT_NAME}-backup \
      --region=$REGION \
      --max-retention-days=7 \
      --daily-schedule \
      --start-time=02:00
    
    gcloud compute disks add-resource-policies $DISK_NAME \
      --resource-policies=${CLIENT_NAME}-backup \
      --zone=$ZONE
  fi
  
  echo -e "   ${GREEN}✅ GCP Setup complete. VM IP: $VM_IP${NC}"
else
  echo -e "${YELLOW}[1/5]${NC} Skipping GCP setup (--skip-gcp)"
  if [ -z "$VM_IP" ]; then
    echo -e "${RED}❌ --vm-ip required when using --skip-gcp${NC}"
    exit 1
  fi
fi

# ============================================================================
# STEP 2: Wait for VM to be ready
# ============================================================================
echo -e "${GREEN}[2/5]${NC} Waiting for VM to be ready..."
sleep 30

# ============================================================================
# STEP 3: Setup VM
# ============================================================================
echo -e "${GREEN}[3/5]${NC} Configuring VM..."

# Generate JWT secret
JWT_SECRET=$(openssl rand -base64 32)

# Create setup script
SETUP_SCRIPT=$(cat << 'REMOTE_SCRIPT'
#!/bin/bash
set -e

# Install Docker
if ! command -v docker &> /dev/null; then
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker $USER
fi

# Mount disk
if ! mountpoint -q /mnt/data; then
  if ! blkid /dev/sdb | grep -q "TYPE="; then
    sudo mkfs.ext4 -m 0 -F -E lazy_itable_init=0,discard /dev/sdb
  fi
  sudo mkdir -p /mnt/data
  sudo mount -o discard,defaults /dev/sdb /mnt/data
  grep -q "/dev/sdb" /etc/fstab || echo "/dev/sdb /mnt/data ext4 discard,defaults,nofail 0 2" | sudo tee -a /etc/fstab
fi

sudo mkdir -p /mnt/data/{agent-workspace,backups}
sudo chown -R $USER:$USER /mnt/data
mkdir -p /app
REMOTE_SCRIPT
)

gcloud compute ssh $VM_NAME --zone=$ZONE --command="$SETUP_SCRIPT"

# ============================================================================
# STEP 4: Create config files
# ============================================================================
echo -e "${GREEN}[4/5]${NC} Creating configuration..."

# Create .env content
ENV_CONTENT="# Multi-Agent Platform - ${CLIENT_NAME}
# Generated: $(date)

# MongoDB Atlas
MONGODB_URI=${MONGODB_URI:-PENDING_MONGODB_URI}

# Anthropic
ANTHROPIC_API_KEY=${ANTHROPIC_KEY:-PENDING_ANTHROPIC_KEY}

# GitHub OAuth
GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID:-PENDING_GITHUB_CLIENT_ID}
GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET:-PENDING_GITHUB_CLIENT_SECRET}

# Security
JWT_SECRET=${JWT_SECRET}
JWT_REFRESH_SECRET=${JWT_SECRET}
SESSION_SECRET=${JWT_SECRET}

# URLs
BASE_URL=http://${VM_IP}:3001
FRONTEND_URL=http://${VM_IP}:3000
PORT=3001

# Workspace
AGENT_WORKSPACE_DIR=/mnt/data/agent-workspace

# Performance
ENABLE_PERFORMANCE_CACHE=true
ENABLE_FILE_CONTENT_CACHE=true
ENABLE_ENHANCED_GIT_EXECUTION=true
"

# Upload .env
echo "$ENV_CONTENT" | gcloud compute ssh $VM_NAME --zone=$ZONE --command="cat > /app/.env"

# Download docker-compose
gcloud compute ssh $VM_NAME --zone=$ZONE --command="curl -sSL https://raw.githubusercontent.com/<org>/agents-backend/main/docker-compose.prod.yml -o /app/docker-compose.yml"

# ============================================================================
# STEP 5: Start services
# ============================================================================
echo -e "${GREEN}[5/5]${NC} Starting services..."

# Check if all required vars are set
if [[ "$ENV_CONTENT" == *"PENDING"* ]]; then
  echo -e "${YELLOW}⚠️  Some environment variables are pending. Complete them before starting:${NC}"
  echo "   SSH: gcloud compute ssh $VM_NAME --zone=$ZONE"
  echo "   Edit: nano /app/.env"
  echo "   Start: cd /app && docker compose up -d"
else
  gcloud compute ssh $VM_NAME --zone=$ZONE --command="cd /app && docker compose up -d"
  sleep 10
  
  # Health check
  HEALTH=$(gcloud compute ssh $VM_NAME --zone=$ZONE --command="curl -s http://localhost:3001/api/health" 2>/dev/null || echo "error")
  if echo "$HEALTH" | grep -q '"status":"ok"'; then
    echo -e "${GREEN}✅ Health check passed${NC}"
  else
    echo -e "${YELLOW}⚠️  Health check pending. Check logs: docker logs agents-backend${NC}"
  fi
fi

# ============================================================================
# Summary
# ============================================================================
echo ""
echo -e "${BLUE}╔══════════════════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                    ✅ Provisioning Complete!                                 ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "Client: ${CLIENT_NAME}"
echo "Project: ${PROJECT_ID}"
echo "VM IP: ${VM_IP}"
echo ""
echo "URLs:"
echo "  API: http://${VM_IP}:3001"
echo "  Health: http://${VM_IP}:3001/api/health"
echo ""
echo "Pending (if not provided):"
[[ -z "$MONGODB_URI" ]] && echo "  - MongoDB Atlas URI"
[[ -z "$GITHUB_CLIENT_ID" ]] && echo "  - GitHub OAuth (Client ID & Secret)"
echo ""
echo "SSH Access:"
echo "  gcloud compute ssh ${VM_NAME} --zone=${ZONE}"
echo ""
echo "Next steps:"
echo "  1. Create MongoDB Atlas cluster (region: ${REGION})"
echo "  2. Create GitHub OAuth App (callback: http://${VM_IP}:3001/api/auth/github/callback)"
echo "  3. Update /app/.env on VM"
echo "  4. Restart: docker compose restart"
echo ""
