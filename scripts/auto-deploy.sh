#!/bin/bash
# Auto-deploy dyad-channel plugin on new commits
# Polls origin/main every POLL_INTERVAL seconds, pulls, compiles, restarts both gateways
set -euo pipefail

REPO_DIR="/Users/joshua/projects/dyad/dyad-channel"
POLL_INTERVAL="${POLL_INTERVAL:-60}"
LOG="/Users/joshua/clawd/logs/dyad-autodeploy.log"
REBECCA_PW="${REBECCA_PW:?Set REBECCA_PW env var}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

restart_gateway() {
  local user="$1"
  if [ "$user" = "joshua" ]; then
    local pid=$(ps aux | grep openclaw-gateway | grep joshua | grep -v grep | awk '{print $2}')
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
      sleep 2
      nohup openclaw gateway start > /dev/null 2>&1 &
      log "  Ren gateway restarted"
    fi
  elif [ "$user" = "rebecca" ]; then
    local pid=$(ps aux | grep openclaw-gateway | grep rebecca | grep -v grep | awk '{print $2}')
    if [ -n "$pid" ]; then
      expect -c "spawn su rebecca -c \"kill $pid; sleep 2; nohup openclaw gateway start > /dev/null 2>&1 &\"; expect \"Password:\"; send \"${REBECCA_PW}\r\"; expect eof" 2>/dev/null
      log "  Noa gateway restarted"
    fi
  fi
}

log "Auto-deploy started (poll every ${POLL_INTERVAL}s)"

while true; do
  cd "$REPO_DIR"
  
  # Fetch latest
  git fetch origin 2>/dev/null || { log "WARN: git fetch failed"; sleep "$POLL_INTERVAL"; continue; }
  
  # Check for new commits
  LOCAL=$(git rev-parse HEAD)
  REMOTE=$(git rev-parse origin/main)
  
  if [ "$LOCAL" != "$REMOTE" ]; then
    NEW_COMMITS=$(git log --oneline HEAD..origin/main)
    log "New commits detected:"
    log "$NEW_COMMITS"
    
    # Pull
    git pull origin main 2>&1 | tee -a "$LOG"
    
    # Compile
    log "Compiling..."
    if npx tsc 2>&1 | tee -a "$LOG"; then
      log "Compile OK — restarting gateways"
      
      # Restart Noa first (doesn't break our own session)
      restart_gateway rebecca
      sleep 3
      
      # Restart Ren
      restart_gateway joshua
      
      log "Deploy complete: $(git rev-parse --short HEAD)"
    else
      log "ERROR: Compile failed — not deploying"
    fi
  fi
  
  sleep "$POLL_INTERVAL"
done
