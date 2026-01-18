#!/bin/bash
# ============================================================================
# Multi-Agent Platform - Update Clients Script
# ============================================================================
# Actualiza uno o todos los clientes a una nueva versión
#
# Uso:
#   ./update-clients.sh --all --version v2.1.0
#   ./update-clients.sh --client acme --version v2.1.0
#   ./update-clients.sh --client acme --version latest
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INVENTORY_FILE="${SCRIPT_DIR}/clients-inventory.yaml"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --all) UPDATE_ALL="true"; shift ;;
    --client) TARGET_CLIENT="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --dry-run) DRY_RUN="true"; shift ;;
    --force) FORCE="true"; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [ -z "$VERSION" ]; then
  echo -e "${RED}❌ --version is required${NC}"
  echo "Usage: ./update-clients.sh --all --version v2.1.0"
  exit 1
fi

if [ -z "$UPDATE_ALL" ] && [ -z "$TARGET_CLIENT" ]; then
  echo -e "${RED}❌ Specify --all or --client <name>${NC}"
  exit 1
fi

echo ""
echo -e "${BLUE}╔══════════════════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║        Multi-Agent Platform - Client Update                                  ║${NC}"
echo -e "${BLUE}║        Version: ${VERSION}${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Function to update a single client
update_client() {
  local name=$1
  local project_id=$2
  local vm_name=$3
  local zone=$4
  local vm_ip=$5
  local current_version=$6
  
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}Updating: ${name}${NC}"
  echo "  VM: ${vm_name} (${vm_ip})"
  echo "  Current: ${current_version} → New: ${VERSION}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  
  if [ "$DRY_RUN" = "true" ]; then
    echo -e "${YELLOW}  [DRY RUN] Would update ${name}${NC}"
    return 0
  fi
  
  # Set project
  gcloud config set project $project_id 2>/dev/null
  
  # Update commands
  UPDATE_COMMANDS="
cd /app

# Backup current .env
cp .env .env.backup.\$(date +%Y%m%d_%H%M%S)

# Pull new image
echo 'Pulling new image...'
docker compose pull

# Restart with new version
echo 'Restarting services...'
docker compose up -d

# Wait for startup
sleep 15

# Health check
HEALTH=\$(curl -s http://localhost:3001/api/health)
if echo \"\$HEALTH\" | grep -q '\"status\":\"ok\"'; then
  echo '✅ Update successful'
else
  echo '❌ Health check failed'
  echo \"\$HEALTH\"
  exit 1
fi

# Show running version
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
"
  
  # Execute update
  echo "  Executing update..."
  if gcloud compute ssh $vm_name --zone=$zone --command="$UPDATE_COMMANDS" 2>&1; then
    echo -e "  ${GREEN}✅ ${name} updated successfully${NC}"
    return 0
  else
    echo -e "  ${RED}❌ ${name} update FAILED${NC}"
    return 1
  fi
}

# Read inventory and update
echo "Reading inventory from: $INVENTORY_FILE"
echo ""

# Simple YAML parser (for this specific format)
FAILED_CLIENTS=""
SUCCESS_COUNT=0
FAIL_COUNT=0

# Parse YAML and update clients
current_client=""
while IFS= read -r line || [[ -n "$line" ]]; do
  # Skip comments and empty lines
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ -z "${line// }" ]] && continue
  
  # Check for new client entry
  if [[ "$line" =~ ^[[:space:]]*-[[:space:]]*name:[[:space:]]*(.+)$ ]]; then
    current_client="${BASH_REMATCH[1]}"
    current_client="${current_client//\"/}"
    unset client_project client_vm client_zone client_ip client_version client_status
  fi
  
  # Parse client fields
  [[ "$line" =~ project_id:[[:space:]]*(.+)$ ]] && client_project="${BASH_REMATCH[1]//\"/}"
  [[ "$line" =~ vm_name:[[:space:]]*(.+)$ ]] && client_vm="${BASH_REMATCH[1]//\"/}"
  [[ "$line" =~ zone:[[:space:]]*(.+)$ ]] && client_zone="${BASH_REMATCH[1]//\"/}"
  [[ "$line" =~ vm_ip:[[:space:]]*(.+)$ ]] && client_ip="${BASH_REMATCH[1]//\"/}"
  [[ "$line" =~ deployed_version:[[:space:]]*(.+)$ ]] && client_version="${BASH_REMATCH[1]//\"/}"
  [[ "$line" =~ status:[[:space:]]*(.+)$ ]] && client_status="${BASH_REMATCH[1]//\"/}"
  
  # Check if we have a complete client entry and should update
  if [[ -n "$current_client" && -n "$client_status" ]]; then
    # Determine if we should update this client
    should_update="false"
    
    if [ "$UPDATE_ALL" = "true" ] && [ "$client_status" = "active" ]; then
      should_update="true"
    elif [ "$TARGET_CLIENT" = "$current_client" ]; then
      should_update="true"
    fi
    
    if [ "$should_update" = "true" ]; then
      if update_client "$current_client" "$client_project" "$client_vm" "$client_zone" "$client_ip" "$client_version"; then
        ((SUCCESS_COUNT++))
      else
        ((FAIL_COUNT++))
        FAILED_CLIENTS="${FAILED_CLIENTS}${current_client} "
      fi
      echo ""
    fi
    
    # Reset for next client
    current_client=""
  fi
done < "$INVENTORY_FILE"

# Summary
echo ""
echo -e "${BLUE}╔══════════════════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                         Update Summary                                       ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "Version: ${VERSION}"
echo "Success: ${SUCCESS_COUNT}"
echo "Failed:  ${FAIL_COUNT}"

if [ -n "$FAILED_CLIENTS" ]; then
  echo ""
  echo -e "${RED}Failed clients: ${FAILED_CLIENTS}${NC}"
  echo "Check logs and retry manually"
fi

echo ""
