import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ingestLogsPayload, ingestMetricsPayload } from '../src/otlp-parse.js';
import { getDiagnosis } from '../src/diagnose.js';

function memDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE metric_points (id INTEGER PRIMARY KEY AUTOINCREMENT, received_at INTEGER NOT NULL, metric_name TEXT NOT NULL,
      point_type TEXT NOT NULL, value REAL, unit TEXT, time_unix_nano TEXT, attributes_json TEXT NOT NULL);
    CREATE TABLE log_records (id INTEGER PRIMARY KEY AUTOINCREMENT, received_at INTEGER NOT NULL, event_name TEXT,
      time_unix_nano TEXT, attributes_json TEXT NOT NULL, body_json TEXT);
  `);
  return db;
}

function otlpAttrs(obj) {
  return Object.entries(obj).map(([key, v]) => ({
    key,
    value: typeof v === 'number' ? { intValue: String(v) } : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v) },
  }));
}

// Claude Code が送る形に近い OTLP logs ペイロードを、イベントの並びから組み立てる
class SessionBuilder {
  constructor(id, start = Date.now() - 60 * 60_000) {
    this.id = id;
    this.t = start;
    this.seq = 0;
    this.records = [];
    this.metrics = [];
    this.promptId = null;
  }
  event(name, attrs, advanceMs = 1000) {
    this.t += advanceMs;
    this.records.push({
      timeUnixNano: String(BigInt(this.t) * 1_000_000n),
      attributes: otlpAttrs({
        'event.name': name,
        'event.timestamp': new Date(this.t).toISOString(),
        'event.sequence': this.seq++,
        'session.id': this.id,
        // 実際の Claude Code では api_request に prompt.id が付かない
        ...(this.promptId && name !== 'api_request' ? { 'prompt.id': this.promptId } : {}),
        ...attrs,
      }),
    });
    return this;
  }
  prompt(length, command) {
    this.promptId = `p${this.seq}`;
    return this.event('user_prompt', { prompt_length: length, ...(command ? { command_name: command } : {}) });
  }
  request({ model = 'claude-sonnet-5', input = 100, cacheRead = 0, cacheCreation = 0, output = 200, cost = 0.01, ...rest } = {}, advanceMs) {
    return this.event(
      'api_request',
      { model, input_tokens: input, cache_read_tokens: cacheRead, cache_creation_tokens: cacheCreation, output_tokens: output, cost_usd: cost, query_source: 'sdk', ...rest },
      advanceMs
    );
  }
  tool(name, { success = true, inputBytes = 100, resultBytes = 500 } = {}) {
    return this.event('tool_result', { tool_name: name, success: String(success), tool_input_size_bytes: inputBytes, tool_result_size_bytes: resultBytes });
  }
  metric(name, value, attrs = {}) {
    this.metrics.push({ name, sum: { dataPoints: [{ asInt: String(value), attributes: otlpAttrs({ 'session.id': this.id, ...attrs }) }] } });
    return this;
  }
  ingest(db) {
    ingestLogsPayload(db, { resourceLogs: [{ scopeLogs: [{ logRecords: this.records }] }] });
    ingestMetricsPayload(db, { resourceMetrics: [{ scopeMetrics: [{ metrics: this.metrics }] }] });
  }
}

function finding(report, id) {
  return report.findings.find((f) => f.id === id);
}

test('良い使い方のセッションは何も指摘されず、shipped に数えられる', () => {
  const db = memDb();
  new SessionBuilder('good-session')
    .prompt(300)
    .request({ input: 5000, cacheCreation: 15000 })
    .tool('Read')
    .tool('Edit')
    .request({ cacheRead: 20000, input: 500 })
    .tool('Bash')
    .metric('claude_code.lines_of_code.count', 12, { type: 'added' })
    .metric('claude_code.commit.count', 1)
    .ingest(db);

  const r = getDiagnosis(db, { days: 7 });
  assert.equal(r.summary.sessions, 1);
  assert.equal(r.summary.outcomes.shipped.sessions, 1);
  assert.deepEqual(r.findings, []);
});

test('探索過多・同じ失敗の繰り返し・自動圧縮を検出し、成果なしのコストを数える', () => {
  const db = memDb();
  const s = new SessionBuilder('bad-session-1234').prompt(15).request({ input: 3000, cacheCreation: 10000, cost: 1 });
  for (let i = 0; i < 16; i++) s.tool(i % 2 ? 'Grep' : 'Read');
  s.tool('Edit');
  for (let i = 0; i < 4; i++) s.tool('Bash', { success: false });
  s.request({ query_source: 'compact', cost: 0.5 });
  s.ingest(db);

  const r = getDiagnosis(db, { days: 7 });
  assert.equal(r.summary.outcomes.no_change.sessions, 1);
  assert.equal(r.summary.noOutputCostShare, 1);
  assert.equal(r.summary.costPerShipped, null);

  const explore = finding(r, 'explore_before_edit');
  assert.equal(explore.principle, 1);
  assert.equal(explore.examples[0].value, 16);
  assert.equal(explore.examples[0].detail.firstPromptChars, 15);
  assert.equal(explore.examples[0].session, 'bad-sess');

  assert.equal(finding(r, 'failure_streak').examples[0].detail.tool, 'Bash');
  assert.equal(finding(r, 'auto_compaction').examples[0].value, 1);
});

test('手動の /compact は自動圧縮として数えない', () => {
  const db = memDb();
  new SessionBuilder('manual-compact').prompt(200).request().prompt(8, 'compact').request({ query_source: 'compact' }).ingest(db);
  assert.equal(finding(getDiagnosis(db, { days: 7 }), 'auto_compaction'), undefined);
});

test('放置後のキャッシュ作り直しとヒット率の低さを原則6として検出する', () => {
  const db = memDb();
  const s = new SessionBuilder('cache-breaker').prompt(200).request({ input: 1000, cacheCreation: 60000 });
  for (let i = 0; i < 3; i++) s.prompt(200).request({ input: 1000, cacheCreation: 60000, cacheRead: 1000 }, 10 * 60_000);
  s.ingest(db);

  const r = getDiagnosis(db, { days: 7 });
  const rebuild = finding(r, 'cache_rebuilds');
  assert.equal(rebuild.principle, 6);
  assert.equal(rebuild.examples[0].value, 3);
  assert.equal(rebuild.examples[0].detail.afterIdle, 3);
  assert.ok(finding(r, 'low_cache_hit'));
});

test('小さな作業での最上位モデル利用と、計測していないことを指摘する', () => {
  const db = memDb();
  for (let i = 0; i < 5; i++) {
    new SessionBuilder(`opus-small-${i}`).prompt(100).request({ model: 'claude-opus-5-5', cost: 1 }).tool('Edit')
      .metric('claude_code.lines_of_code.count', 3, { type: 'added' })
      .ingest(db);
  }
  const r = getDiagnosis(db, { days: 7 });
  assert.equal(finding(r, 'top_model_small_task').sessions, 5);
  assert.equal(r.findings.at(-1).id, 'no_measurement');
  // 該当コストの大きい順に並ぶ
  assert.equal(r.findings[0].id, 'top_model_small_task');
});

test('/cost を使っていれば原則8は指摘しない。top で件数を絞れる', () => {
  const db = memDb();
  for (let i = 0; i < 5; i++) new SessionBuilder(`s${i}`).prompt(100).request().prompt(4, 'cost').ingest(db);
  assert.equal(finding(getDiagnosis(db, { days: 7 }), 'no_measurement'), undefined);

  const db2 = memDb();
  for (let i = 0; i < 5; i++) new SessionBuilder(`s${i}`).prompt(100).request({ model: 'claude-opus-5-5', cost: 1 }).ingest(db2);
  assert.equal(getDiagnosis(db2, { days: 7, top: 1 }).findings.length, 1);
});

test('タイトル生成などの補助リクエストは会話開始時の固定コンテキストに数えない', () => {
  const db = memDb();
  new SessionBuilder('aux-first')
    .request({ query_source: 'generate_session_title', input: 50000 })
    .prompt(200)
    .request({ query_source: 'repl_main_thread', input: 1000, cacheCreation: 60000 })
    .ingest(db);
  const f = finding(getDiagnosis(db, { days: 7 }), 'heavy_base_context');
  assert.equal(f.examples[0].value, 61000);
});

test('サブエージェントのツール実行は探索回数に含めない', () => {
  const db = memDb();
  const s = new SessionBuilder('with-subagent').prompt(200).request();
  for (let i = 0; i < 20; i++) s.event('tool_result', { tool_name: 'Read', success: 'true', agent_id: 'a1' });
  s.tool('Edit').ingest(db);
  assert.equal(finding(getDiagnosis(db, { days: 7 }), 'explore_before_edit'), undefined);
});
