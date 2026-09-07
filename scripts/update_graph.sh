#!/bin/bash
#
# Update Graph Script
#
# This script regenerates the graph from all markdown files and pushes to GitHub.
# Run this after adding new notes or conversations.
#

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🔄 Updating Lnm-Brain graph...${NC}"

# Check if we're in the right directory
if [ ! -f "AGENTS.md" ] || [ ! -f "CLAUDE.md" ]; then
    echo "❌ Error: Not in Lnm-Brain directory. Please run from the repo root."
    exit 1
fi

# Generate graph from all markdown files
echo -e "${BLUE}📊 Scanning markdown files...${NC}"
python3 scripts/generate_graph.py

# Commit and push changes
echo -e "${BLUE}📤 Committing and pushing to GitHub...${NC}"
git add graph/graph.json
git commit -m "Update graph - $(date '+%Y-%m-%d %H:%M:%S')" || echo "No changes to commit"
git push origin main

echo -e "${GREEN}✅ Graph updated successfully!${NC}"
echo ""
echo "View your graph at: https://your-worker-subdomain.workers.dev/"
