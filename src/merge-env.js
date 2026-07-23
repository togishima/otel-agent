// ~/.claude/settings.json の env にテレメトリ設定をマージする。
// 既にユーザーが設定済みのキーは上書きしない。パース不能な場合は何もしない（設定破壊防止）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TELEMETRY_ENV = {
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_METRICS_EXPORTER: 'otlp',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
  OTEL_METRICS_INCLUDE_ENTRYPOINT: 'true',
};

export function mergeClaudeEnv() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

  let settings = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`merge-claude-env: cannot parse ${settingsPath}, aborting: ${err.message}`);
      return;
    }
  }

  settings.env ??= {};
  let changed = false;
  for (const [key, value] of Object.entries(TELEMETRY_ENV)) {
    if (!(key in settings.env)) {
      settings.env[key] = value;
      changed = true;
    }
  }

  if (changed) {
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    console.error('merge-claude-env: telemetry env merged into settings.json (takes effect next session)');
  }
}
