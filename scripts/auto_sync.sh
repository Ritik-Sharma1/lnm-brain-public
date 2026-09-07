#!/bin/bash
#
# Periodic Sync Script
#
# This script syncs the Lnm-Brain vault with GitHub and updates the graph.
# Run this periodically (via cron or GitHub Actions) to keep everything in sync.
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
REPO="your-username/your-repo"
WORKER_URL="https://your-worker-subdomain.workers.dev"
LOG_FILE="sync.log"

# Functions
log() {
    echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $1" | tee -a "$LOG_FILE"
}

error() {
    echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')] ERROR:${NC} $1" | tee -a "$LOG_FILE"
}

warn() {
    echo -e "${YELLOW}[$(date '+%Y-%m-%d %H:%M:%S')] WARNING:${NC} $1" | tee -a "$LOG_FILE"
}

# Check if we're in the right directory
if [ ! -f "AGENTS.md" ] || [ ! -f "CLAUDE.md" ]; then
    error "Not in Lnm-Brain directory. Please run from the repo root."
    exit 1
fi

log "Starting sync process..."

# Step 1: Pull latest changes from GitHub
log "Pulling latest changes from GitHub..."
if git pull origin main; then
    log "✓ Git pull successful"
else
    error "Git pull failed"
    exit 1
fi

# Step 2: Check for new conversation files
log "Checking for new conversation files..."
NEW_FILES=$(git diff --name-only HEAD@{1} HEAD | grep "raw/conversations/" || true)

if [ -n "$NEW_FILES" ]; then
    log "Found new conversation files:"
    echo "$NEW_FILES" | tee -a "$LOG_FILE"

    # Step 3: Process new conversations
    log "Processing new conversations..."
    if python3 scripts/process_conversations.py raw/conversations/; then
        log "✓ Conversation processing successful"
    else
        warn "Conversation processing failed, continuing..."
    fi
else
    log "No new conversation files found"
fi

# Step 4: Update index
log "Updating index..."
if [ -f "scripts/update_index.py" ]; then
    python3 scripts/update_index.py
    log "✓ Index updated"
else
    warn "update_index.py not found, skipping..."
fi

# Step 4b: Inject [[index]] backlinks into EVERY md (raw/wiki/handoffs/docs/meta/web/graph + root)
# so no file can ever orphan in the graph. Idempotent — skips files already linked.
log "Injecting index backlinks (orphan guard)..."
if node scripts/inject-wikilinks.js --apply >> "$LOG_FILE" 2>&1; then
    log "✓ Backlinks injected"
else
    warn "inject-wikilinks failed, continuing..."
fi

# Step 5: Commit and push changes
log "Committing and pushing changes..."
if git add -A && git commit -m "Auto-sync: Update knowledge graph [$(date '+%Y-%m-%d %H:%M:%S')]" && git push origin main; then
    log "✓ Changes pushed to GitHub"
else
    warn "Nothing to commit or push failed"
fi

# Step 6: Verify Worker is healthy
log "Checking Worker health..."
if curl -s "$WORKER_URL/health" > /dev/null; then
    log "✓ Worker is healthy"
else
    warn "Worker health check failed"
fi

# Step 7: Update sync log
log "Sync completed successfully"
echo "" >> "$LOG_FILE"

# Display summary
echo ""
echo "=========================================="
echo "Sync Summary"
echo "=========================================="
echo "Time: $(date '+%Y-%m-%d %H:%M:%S')"
echo "Status: Success"
echo "New files: $(echo "$NEW_FILES" | wc -l)"
echo "=========================================="
