#!/bin/bash
# SessionStart hookから呼ばれる。失敗してもセッションを妨げないよう常にexit 0。
set -u

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DATA_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.local/share/otel-agent}"
LOG_DIR="$DATA_DIR/logs"
PORT="${OTEL_AGENT_PORT:-4318}"

mkdir -p "$LOG_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "otel-agent: node not found; agent not started" >&2
  exit 0
fi

node "$PLUGIN_ROOT/scripts/merge-claude-env.mjs" >>"$LOG_DIR/setup.log" 2>&1 || true

# 既に起動済みなら何もしない
if curl -s -o /dev/null -m 1 "http://localhost:${PORT}/api/summary"; then
  exit 0
fi

# gateway_url はプラグイン設定（userConfig）から渡される。未設定なら転送無効
OTEL_AGENT_DB_PATH="$DATA_DIR/otel-agent.db" \
OTEL_AGENT_FORWARD_URL="${CLAUDE_PLUGIN_OPTION_GATEWAY_URL:-${OTEL_AGENT_FORWARD_URL:-}}" \
PORT="$PORT" \
  nohup node "$PLUGIN_ROOT/src/server.js" \
    >>"$LOG_DIR/server.log" 2>>"$LOG_DIR/server.err.log" &

exit 0
