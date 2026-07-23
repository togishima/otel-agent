export function getSummary(db) {
  const tokenTotal = (type) =>
    db
      .prepare(
        `SELECT COALESCE(SUM(value), 0) as total
         FROM metric_points
         WHERE metric_name = 'claude_code.token.usage' AND json_extract(attributes_json, '$.type') = ?`
      )
      .get(type).total;

  const input = tokenTotal('input');
  const output = tokenTotal('output');
  const cacheRead = tokenTotal('cacheRead');
  const cacheCreation = tokenTotal('cacheCreation');

  const cost = db
    .prepare(`SELECT COALESCE(SUM(value), 0) as total FROM metric_points WHERE metric_name = 'claude_code.cost.usage'`)
    .get().total;

  const sessions = db
    .prepare(`SELECT COALESCE(SUM(value), 0) as total FROM metric_points WHERE metric_name = 'claude_code.session.count'`)
    .get().total;

  // 実際のClaude Codeは 'tool_result'（プレフィックスなし）で送ってくる
  const toolCalls = db
    .prepare(`SELECT COUNT(*) as total FROM log_records WHERE event_name IN ('claude_code.tool_result', 'tool_result')`)
    .get().total;

  const lastEventAt = db
    .prepare(
      `SELECT MAX(received_at) as t FROM (
         SELECT received_at FROM metric_points
         UNION ALL
         SELECT received_at FROM log_records
       )`
    )
    .get().t;

  return { input, output, cacheRead, cacheCreation, cost, sessions, toolCalls, lastEventAt };
}

export function getToolBreakdown(db) {
  return db
    .prepare(
      `SELECT
         json_extract(attributes_json, '$.tool_name') as tool_name,
         SUM(CASE WHEN json_extract(attributes_json, '$.success') IN ('true', 1) THEN 1 ELSE 0 END) as success_count,
         SUM(CASE WHEN json_extract(attributes_json, '$.success') IN ('false', 0) THEN 1 ELSE 0 END) as fail_count,
         COUNT(*) as total
       FROM log_records
       WHERE event_name IN ('claude_code.tool_result', 'tool_result')
       GROUP BY tool_name
       ORDER BY total DESC`
    )
    .all();
}

export function getModelBreakdown(db) {
  return db
    .prepare(
      `SELECT
         json_extract(attributes_json, '$.model') as model,
         json_extract(attributes_json, '$.type') as type,
         SUM(value) as total
       FROM metric_points
       WHERE metric_name = 'claude_code.token.usage'
       GROUP BY model, type
       ORDER BY model, type`
    )
    .all();
}

// token.usage はdelta値で届くので、時間バケットごとの SUM がその期間の使用量になる。
const TIMESERIES_BUCKETS = {
  1: 2 * 60_000, // 1時間表示: 2分バケット
  6: 10 * 60_000,
  24: 30 * 60_000,
  168: 3 * 60 * 60_000, // 7日表示: 3時間バケット
};

export function getTimeseries(db, hours) {
  const h = TIMESERIES_BUCKETS[hours] ? hours : 24;
  const bucketMs = TIMESERIES_BUCKETS[h];
  const since = Date.now() - h * 60 * 60_000;
  // node:sqlite は数値をREALでバインドし整数除算にならないため、
  // ホワイトリスト由来の bucketMs は整数リテラルとして埋め込む
  const rows = db
    .prepare(
      `SELECT
         (received_at / ${bucketMs}) * ${bucketMs} AS bucket,
         json_extract(attributes_json, '$.type') AS type,
         SUM(value) AS total
       FROM metric_points
       WHERE metric_name = 'claude_code.token.usage' AND received_at >= ?
       GROUP BY bucket, type
       ORDER BY bucket`
    )
    .all(since);
  return { hours: h, bucketMs, since, rows };
}

export function getRecentEvents(db) {
  return db
    .prepare(
      `SELECT id, received_at, event_name, attributes_json
       FROM log_records
       ORDER BY id DESC
       LIMIT 50`
    )
    .all();
}
