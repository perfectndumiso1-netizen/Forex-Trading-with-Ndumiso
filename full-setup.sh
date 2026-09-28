#!/bin/bash
set -e
REPO="https://github.com/perfectndumiso1-netizen/Forex-Trading-with-Ndumiso.git"
KEY="d1cbb83e823a4dbca0bf169e075ea8df"
echo "=== Forex Signals — Full Setup ==="
echo ""
echo "Step 1: Adding remote..."
cd /home/user/forex-signals
if git remote get-url origin &>/dev/null; then
  git remote set-url origin "$REPO"
else
  git remote add origin "$REPO"
fi
echo "Remote set to: $REPO"

