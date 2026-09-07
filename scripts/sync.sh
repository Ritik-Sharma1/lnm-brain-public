#!/bin/bash
set -e

REPO="your-username/your-repo"
BRANCH="main"

echo "Syncing Lnm-Brain to GitHub..."

if [ ! -d "/tmp/lnm-brain-local" ]; then
    git clone "https://github.com/$REPO.git" /tmp/lnm-brain-local
fi

cd /tmp/lnm-brain-local
git pull origin "$BRANCH"

echo "Sync complete."
