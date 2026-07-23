#!/bin/bash
set -euo pipefail

PORT=4318
LOG_DIR="$HOME/Library/Logs/otel-agent"
PROJECT_DIR="/Users/ogi/projects/otel-agent"

mkdir -p "$LOG_DIR"

if curl -s -o /dev/null -m 1 "http://localhost:${PORT}/api/summary"; then
  exit 0
fi

cd "$PROJECT_DIR"
nohup node src/server.js >> "$LOG_DIR/server.log" 2>> "$LOG_DIR/server.err.log" &
exit 0
