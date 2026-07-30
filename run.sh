#!/usr/bin/env bash
# Boot the Claude Code shim + the app together. Ctrl-C stops both.
# Override model with:  CLAUDE_MODEL=opus ./run.sh
set -euo pipefail

cd "$(dirname "$0")"
SHIM=./claude-openai-shim.mjs

PORT=8790 CLAUDE_MODEL="${CLAUDE_MODEL:-sonnet}" node "$SHIM" &
SHIM_PID=$!
trap 'kill "$SHIM_PID" 2>/dev/null' EXIT

# Fail loud if the shim didn't bind (usually port 8790 already taken),
# instead of running the app with no LLM backend.
sleep 1
kill -0 "$SHIM_PID" 2>/dev/null || { echo "shim failed to start — is port 8790 already in use? (lsof -i:8790)"; exit 1; }

npm run dev   # foreground; Ctrl-C here triggers the trap and kills the shim
