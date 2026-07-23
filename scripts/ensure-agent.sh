#!/bin/bash
# SessionStart hookから呼ばれる。失敗してもセッションを妨げないよう常にexit 0。
set -u

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DATA_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.local/share/otel-agent}"
LOG_DIR="$DATA_DIR/logs"
BIN="$DATA_DIR/bin/otel-agent"
PORT="${OTEL_AGENT_PORT:-4318}"
RELEASE_BASE="${OTEL_AGENT_RELEASE_BASE:-https://github.com/togishima/otel-agent/releases/latest/download}"

mkdir -p "$LOG_DIR"

# 実行方法の解決: 1) 取得済み単一バイナリ 2) node 3) GitHub Releaseからバイナリ取得
# node がないマシン（非開発者PC）でも 3) で動作する
USE_NODE=""
if [ -x "$BIN" ]; then
  :
elif command -v node >/dev/null 2>&1; then
  USE_NODE=1
else
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH="$(uname -m)"
  mkdir -p "$DATA_DIR/bin"
  if curl -fsSL -o "$BIN.tmp" "$RELEASE_BASE/otel-agent-${OS}-${ARCH}" >>"$LOG_DIR/setup.log" 2>&1; then
    chmod +x "$BIN.tmp" && mv "$BIN.tmp" "$BIN"
  else
    rm -f "$BIN.tmp"
    echo "otel-agent: node not found and binary download failed (${OS}-${ARCH}); agent not started" >&2
    exit 0
  fi
fi

if [ -n "$USE_NODE" ]; then
  node "$PLUGIN_ROOT/src/cli.js" merge-env >>"$LOG_DIR/setup.log" 2>&1 || true
else
  "$BIN" merge-env >>"$LOG_DIR/setup.log" 2>&1 || true
fi

# 既に起動済みなら何もしない
if curl -s -o /dev/null -m 1 "http://localhost:${PORT}/api/summary"; then
  exit 0
fi

# gateway_url はプラグイン設定（userConfig）から渡される。未設定なら転送無効
start_server() {
  OTEL_AGENT_DB_PATH="$DATA_DIR/otel-agent.db" \
  OTEL_AGENT_FORWARD_URL="${CLAUDE_PLUGIN_OPTION_GATEWAY_URL:-${OTEL_AGENT_FORWARD_URL:-}}" \
  PORT="$PORT" \
    nohup "$@" >>"$LOG_DIR/server.log" 2>>"$LOG_DIR/server.err.log" &
}

if [ -n "$USE_NODE" ]; then
  start_server node "$PLUGIN_ROOT/src/cli.js"
else
  start_server "$BIN"
fi

exit 0
