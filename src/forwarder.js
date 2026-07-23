// ゲートウェイ転送（store-and-forward）。
// OTEL_AGENT_FORWARD_URL が未設定なら完全に無効（ローカル収集のみ）。
// VPN切断などで送信に失敗した分は outbox に残り、次回以降のflushで再送される。

const FORWARD_URL = process.env.OTEL_AGENT_FORWARD_URL || '';
const FORWARD_TOKEN = process.env.OTEL_AGENT_FORWARD_TOKEN || '';
const INTERVAL_MS = Number(process.env.OTEL_AGENT_FORWARD_INTERVAL_MS) || 60_000;
const RETENTION_DAYS = Number(process.env.OTEL_AGENT_RETENTION_DAYS) || 7;
const BATCH_SIZE = 200;

export function isForwardingEnabled() {
  return FORWARD_URL !== '';
}

export function enqueue(db, kind, payloadJson) {
  db.prepare(
    'INSERT INTO outbox (received_at, kind, payload_json) VALUES (?, ?, ?)'
  ).run(Date.now(), kind, payloadJson);
}

async function flush(db) {
  const rows = db.prepare(
    'SELECT id, received_at, kind, payload_json FROM outbox WHERE sent_at IS NULL ORDER BY id LIMIT ?'
  ).all(BATCH_SIZE);
  if (rows.length === 0) return { sent: 0, pending: 0 };

  const body = JSON.stringify({
    records: rows.map((r) => ({
      id: r.id,
      received_at: r.received_at,
      kind: r.kind,
      payload: JSON.parse(r.payload_json),
    })),
  });

  const headers = { 'Content-Type': 'application/json' };
  if (FORWARD_TOKEN) headers.Authorization = `Bearer ${FORWARD_TOKEN}`;

  const res = await fetch(FORWARD_URL, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`gateway responded ${res.status}`);

  const now = Date.now();
  const markSent = db.prepare('UPDATE outbox SET sent_at = ? WHERE id = ?');
  for (const r of rows) markSent.run(now, r.id);

  const pending = db.prepare(
    'SELECT COUNT(*) AS c FROM outbox WHERE sent_at IS NULL'
  ).get().c;
  return { sent: rows.length, pending };
}

function prune(db) {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  db.prepare('DELETE FROM outbox WHERE sent_at IS NOT NULL AND sent_at < ?').run(cutoff);
}

export function startForwarder(db) {
  if (!isForwardingEnabled()) {
    console.log('[forwarder] disabled (OTEL_AGENT_FORWARD_URL not set)');
    return;
  }
  console.log(`[forwarder] enabled -> ${FORWARD_URL} (interval ${INTERVAL_MS}ms)`);

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { sent, pending } = await flush(db);
      if (sent > 0) console.log(`[forwarder] sent ${sent} records (${pending} pending)`);
      prune(db);
    } catch (err) {
      // VPN切断・ゲートウェイ停止時はここに来る。データはoutboxに残り次回再送。
      console.warn(`[forwarder] flush failed, will retry: ${err.message}`);
    } finally {
      running = false;
    }
  };
  setInterval(tick, INTERVAL_MS);
  tick();
}
