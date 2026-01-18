#!/bin/bash
# ============================================================================
# Multi-Agent Platform - Check All Clients Status
# ============================================================================
# Verifica el estado de todos los clientes activos
#
# Uso: ./check-clients-status.sh
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INVENTORY_FILE="${SCRIPT_DIR}/clients-inventory.yaml"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo ""
echo -e "${BLUE}╔══════════════════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║        Multi-Agent Platform - Client Status Check                            ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════════════════════╝${NC}"
echo ""
printf "%-15s %-18s %-12s %-10s %s\n" "CLIENT" "IP" "VERSION" "STATUS" "HEALTH"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Parse inventory and check each client
current_client=""
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ -z "${line// }" ]] && continue
  
  [[ "$line" =~ ^[[:space:]]*-[[:space:]]*name:[[:space:]]*(.+)$ ]] && current_client="${BASH_REMATCH[1]//\"/}"
  [[ "$line" =~ vm_ip:[[:space:]]*(.+)$ ]] && client_ip="${BASH_REMATCH[1]//\"/}"
  [[ "$line" =~ deployed_version:[[:space:]]*(.+)$ ]] && client_version="${BASH_REMATCH[1]//\"/}"
  [[ "$line" =~ status:[[:space:]]*(.+)$ ]] && client_status="${BASH_REMATCH[1]//\"/}"
  
  if [[ -n "$current_client" && -n "$client_status" ]]; then
    if [ "$client_status" = "active" ]; then
      # Check health
      HEALTH=$(curl -s --connect-timeout 5 "http://${client_ip}:3001/api/health" 2>/dev/null || echo "error")
      
      if echo "$HEALTH" | grep -q '"status":"ok"'; then
        health_status="${GREEN}✅ OK${NC}"
      else
        health_status="${RED}❌ DOWN${NC}"
      fi
      
      printf "%-15s %-18s %-12s %-10s %b\n" "$current_client" "$client_ip" "$client_version" "$client_status" "$health_status"
    else
      printf "%-15s %-18s %-12s ${YELLOW}%-10s${NC} %s\n" "$current_client" "$client_ip" "$client_version" "$client_status" "N/A"
    fi
    current_client=""
  fi
done < "$INVENTORY_FILE"

echo ""
