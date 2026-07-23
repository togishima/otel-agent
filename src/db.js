import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.OTEL_AGENT_DB_PATH || path.join(__dirname, '..', 'otel-agent.db');

export function initDb() {
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS metric_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at INTEGER NOT NULL,
      metric_name TEXT NOT NULL,
      point_type TEXT NOT NULL,
      value REAL,
      unit TEXT,
      time_unix_nano TEXT,
      attributes_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_metric_name ON metric_points(metric_name);
    CREATE INDEX IF NOT EXISTS idx_metric_received ON metric_points(received_at);

    CREATE TABLE IF NOT EXISTS log_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at INTEGER NOT NULL,
      event_name TEXT,
      time_unix_nano TEXT,
      attributes_json TEXT NOT NULL,
      body_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_log_event ON log_records(event_name);
    CREATE INDEX IF NOT EXISTS idx_log_received ON log_records(received_at);

    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      sent_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_unsent ON outbox(sent_at) WHERE sent_at IS NULL;
  `);
  return db;
}
