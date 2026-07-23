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

  const toolCalls = db
    .prepare(`SELECT COUNT(*) as total FROM log_records WHERE event_name = 'claude_code.tool_result'`)
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
         SUM(CASE WHEN json_extract(attributes_json, '$.success') = 1 THEN 1 ELSE 0 END) as success_count,
         SUM(CASE WHEN json_extract(attributes_json, '$.success') = 0 THEN 1 ELSE 0 END) as fail_count,
         COUNT(*) as total
       FROM log_records
       WHERE event_name = 'claude_code.tool_result'
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
