function anyValueToJs(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('boolValue' in v) return v.boolValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(anyValueToJs);
  if ('kvlistValue' in v) return attrsArrayToObject(v.kvlistValue.values || []);
  return null;
}

function attrsArrayToObject(attrs) {
  const obj = {};
  for (const a of attrs || []) {
    obj[a.key] = anyValueToJs(a.value);
  }
  return obj;
}

const METRIC_POINT_KINDS = ['sum', 'gauge', 'histogram', 'summary', 'exponentialHistogram'];

export function ingestMetricsPayload(db, payload) {
  const insert = db.prepare(`
    INSERT INTO metric_points (received_at, metric_name, point_type, value, unit, time_unix_nano, attributes_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  let count = 0;

  for (const rm of payload.resourceMetrics || []) {
    for (const sm of rm.scopeMetrics || []) {
      for (const metric of sm.metrics || []) {
        const name = metric.name;
        const unit = metric.unit || null;
        for (const kind of METRIC_POINT_KINDS) {
          const container = metric[kind];
          if (!container) continue;
          for (const dp of container.dataPoints || []) {
            const attrs = attrsArrayToObject(dp.attributes);
            let value = null;
            if (dp.asInt !== undefined) value = Number(dp.asInt);
            else if (dp.asDouble !== undefined) value = dp.asDouble;
            else if (dp.sum !== undefined) value = dp.sum;

            insert.run(now, name, kind, value, unit, dp.timeUnixNano ?? null, JSON.stringify(attrs));
            count++;
          }
        }
      }
    }
  }
  return count;
}

export function ingestLogsPayload(db, payload) {
  const insert = db.prepare(`
    INSERT INTO log_records (received_at, event_name, time_unix_nano, attributes_json, body_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  let count = 0;

  for (const rl of payload.resourceLogs || []) {
    for (const sl of rl.scopeLogs || []) {
      for (const lr of sl.logRecords || []) {
        const attrs = attrsArrayToObject(lr.attributes);
        const eventName = lr.eventName || attrs['event.name'] || attrs['event_name'] || null;
        const body = lr.body ? anyValueToJs(lr.body) : null;
        insert.run(now, eventName, lr.timeUnixNano ?? null, JSON.stringify(attrs), JSON.stringify(body));
        count++;
      }
    }
  }
  return count;
}

export { anyValueToJs, attrsArrayToObject };
