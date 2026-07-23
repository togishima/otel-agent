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
  24: 30 * 60_000, // 24時間表示: 30分バケット
  168: 3 * 60 * 60_000, // 7日表示: 3時間バケット
  720: 12 * 60 * 60_000, // 1ヶ月表示: 12時間バケット
  2160: 24 * 60 * 60_000, // 3ヶ月表示: 1日バケット
};

const TIMESERIES_GROUPS = {
  type: '$.type', // input/output/cacheRead/cacheCreation
  model: '$.model', // モデル名（UI側でファミリーに集約）
};

export function getTimeseries(db, hours, by) {
  const h = TIMESERIES_BUCKETS[hours] ? hours : 24;
  const g = TIMESERIES_GROUPS[by] ? by : 'type';
  const bucketMs = TIMESERIES_BUCKETS[h];
  const since = Date.now() - h * 60 * 60_000;
  // node:sqlite は数値をREALでバインドし整数除算にならないため、
  // ホワイトリスト由来の bucketMs は整数リテラルとして埋め込む
  const rows = db
    .prepare(
      `SELECT
         (received_at / ${bucketMs}) * ${bucketMs} AS bucket,
         json_extract(attributes_json, '${TIMESERIES_GROUPS[g]}') AS series,
         SUM(value) AS total
       FROM metric_points
       WHERE metric_name = 'claude_code.token.usage' AND received_at >= ?
       GROUP BY bucket, series
       ORDER BY bucket`
    )
    .all(since);
  return { hours: h, by: g, bucketMs, since, rows };
}

// skill.name はスキル起動後のAPIリクエスト・トークン計測に自動付与される
// （フラグ不要。サードパーティプラグインのスキル名は 'third-party' に置換済みで届く）。
export function getSkillBreakdown(db) {
  const usage = db
    .prepare(
      `SELECT
         json_extract(attributes_json, '$."skill.name"') AS skill,
         SUM(CASE WHEN metric_name = 'claude_code.token.usage' THEN value ELSE 0 END) AS tokens,
         SUM(CASE WHEN metric_name = 'claude_code.cost.usage' THEN value ELSE 0 END) AS cost
       FROM metric_points
       WHERE json_extract(attributes_json, '$."skill.name"') IS NOT NULL
       GROUP BY skill`
    )
    .all();
  const requests = db
    .prepare(
      `SELECT
         json_extract(attributes_json, '$."skill.name"') AS skill,
         COUNT(*) AS requests
       FROM log_records
       WHERE event_name = 'api_request' AND json_extract(attributes_json, '$."skill.name"') IS NOT NULL
       GROUP BY skill`
    )
    .all();
  const bySkill = new Map(usage.map((r) => [r.skill, { skill: r.skill, tokens: r.tokens, cost: r.cost, requests: 0 }]));
  for (const r of requests) {
    const s = bySkill.get(r.skill) || { skill: r.skill, tokens: 0, cost: 0, requests: 0 };
    s.requests = r.requests;
    bySkill.set(r.skill, s);
  }
  return [...bySkill.values()].sort((a, b) => b.tokens - a.tokens);
}

export function getRecentEvents(db) {
  return db
    .prepare(
      `SELECT id, received_at, event_name, attributes_json
       FROM log_records
       ORDER BY id DESC
       LIMIT 15`
    )
    .all();
}
