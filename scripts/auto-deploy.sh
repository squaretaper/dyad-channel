#!/bin/bash
# Auto-deploy dyad-channel plugin on new commits
# Polls origin/main every POLL_INTERVAL seconds, pulls, compiles, restarts both gateways.
#
# Gateway restart strategy:
#   - Ren (joshua): direct kill + openclaw gateway start
#   - Noa (rebecca): webhook hook trigger → Noa restarts herself via system event
#
# SIGUSR1 won't work here — it reuses loaded JS modules. TS plugin changes
# need a full process restart to load new compiled JS.
set -euo pipefail

REPO_DIR="/Users/joshua/projects/dyad/dyad-channel"
POLL_INTERVAL="${POLL_INTERVAL:-60}"
LOG="/Users/joshua/clawd/logs/dyad-autodeploy.log"

mkdir -p "$(dirname "$LOG")"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

restart_ren() {
  local pid
  pid=$(pgrep -u joshua -f openclaw-gateway 2>/dev/null || true)
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    sleep 2
    nohup openclaw gateway start >> "$LOG" 2>&1 &
    log "  Ren gateway restarted (killed $pid)"
  else
    log "  WARN: Ren gateway not running, starting fresh"
    nohup openclaw gateway start >> "$LOG" 2>&1 &
  fi
}

restart_noa() {
  # Signal Noa via webhook hook — she'll restart herself.
  # This avoids cross-user password issues entirely.
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "http://127.0.0.1:18790/hooks/agent" \
    -H "Authorization: Bearer rebecca-hooks-2026" \
    -H "Content-Type: application/json" \
    -d "{\"message\":\"Dyad channel plugin updated — new commit deployed. Please restart your gateway to pick up the new compiled JS. Run: kill your gateway PID then openclaw gateway start. The new code has table-backed dispatch with broadcast fast path + 5s poll safety net.\"}")

  if [ "$http_code" = "200" ]; then
    log "  Noa notified via webhook hook (she'll restart herself)"
  else
    log "  WARN: Failed to notify Noa (HTTP $http_code) — file fallback"
    /Users/Shared/bot-messages/bot-send.sh rebecca \
      "Dyad channel plugin updated. Please restart your gateway (kill PID + openclaw gateway start)." 2>/dev/null || true
  fi
}

log "Auto-deploy started (poll every ${POLL_INTERVAL}s)"
log "Repo: $REPO_DIR"

while true; do
  cd "$REPO_DIR"

  # Fetch latest
  if ! git fetch origin 2>/dev/null; then
    log "WARN: git fetch failed"
    sleep "$POLL_INTERVAL"
    continue
  fi

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
      log "Compile OK — deploying"

      # Restart Noa first (doesn't break our own session)
      restart_noa
      sleep 3

      # Restart Ren
      restart_ren

      log "Deploy complete: $(git rev-parse --short HEAD)"
    else
      log "ERROR: Compile failed — not deploying"
    fi
  fi

  sleep "$POLL_INTERVAL"
done
