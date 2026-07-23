// 収集テーブル（metric_points / log_records）のローカル保持期間管理。
// 転送の有無に関わらず、保持日数を超えた分を起動時と1時間ごとに削除する。
// 時系列グラフ（最長3ヶ月）が機能するようデフォルトは100日。
// 転送用 outbox の保持は forwarder.js（OTEL_AGENT_RETENTION_DAYS）が担当。

const DATA_RETENTION_DAYS = Number(process.env.OTEL_AGENT_DATA_RETENTION_DAYS) || 100;
const SWEEP_INTERVAL_MS = 60 * 60_000;

export function startMaintenance(db) {
  const sweep = () => {
    const cutoff = Date.now() - DATA_RETENTION_DAYS * 24 * 60 * 60_000;
    try {
      const m = db.prepare('DELETE FROM metric_points WHERE received_at < ?').run(cutoff);
      const l = db.prepare('DELETE FROM log_records WHERE received_at < ?').run(cutoff);
      const deleted = Number(m.changes) + Number(l.changes);
      if (deleted > 0) console.log(`[maintenance] pruned ${deleted} rows older than ${DATA_RETENTION_DAYS} days`);
    } catch (err) {
      console.warn(`[maintenance] prune failed: ${err.message}`);
    }
  };
  console.log(`[maintenance] data retention: ${DATA_RETENTION_DAYS} days (sweep hourly)`);
  setInterval(sweep, SWEEP_INTERVAL_MS);
  sweep();
}
