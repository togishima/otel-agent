// 「AIエージェントのトークン消費を最小化する8つの原則」に沿った利用診断。
// 受信済みの OTel イベント（user_prompt / api_request / tool_result / tool_decision）と
// 成果メトリクス（lines_of_code / commit / pull_request）をセッション単位に並べ、
// 原則ごとの「守れていない兆候」を機械的に判定する。
// 本人の改善支援が目的のため、出力は数値とセッションIDの先頭だけで、プロンプト本文やパスは含めない。

export const THRESHOLDS = {
  exploreBeforeEdit: 15, // 最初の編集までの探索ツール回数
  largeResultBytes: 40_000, // 1回のツール結果がこれ以上なら「大きい」（約1万トークン）
  largeResultsPerSession: 2,
  baseContextTokens: 40_000, // 最初のリクエスト時点の固定コンテキスト（ツール定義・CLAUDE.md等）
  longContextTokens: 150_000, // 1リクエストの文脈がこれを超えたら長すぎ
  sameToolStreak: 10, // 同じツールの連続実行
  shortReplyChars: 20, // 「はい」「続けて」程度の短い追い発言
  shortReplyMinPrompts: 5,
  shortReplyRatio: 0.3,
  failureStreak: 3, // 同じツールの連続失敗
  rejectedEdits: 3, // ユーザーが却下したツール実行
  writeBytesMin: 20_000, // Write（全書き換え）が多いとみなす最小量
  outputTokensPerLine: 200, // 変更1行あたりの出力トークン
  outputTokensMin: 20_000,
  cacheHitRateMin: 0.7,
  cacheHitMinInput: 200_000,
  cacheRebuildTokens: 50_000, // 途中のリクエストでキャッシュを作り直した量
  cacheRebuilds: 2,
  smallTaskLines: 30, // 「小さな作業」とみなす変更行数
  topModelCostShare: 0.8,
  smallTaskMinCost: 0.5, // これ未満のセッションはモデル選択を問わない（USD）
  measureMinSessions: 5,
};

const EXPLORE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const MEASURE_COMMANDS = new Set(['cost', 'usage', 'context', 'stats']);
const TOP_MODEL = /opus|fable|mythos/i;
const CACHE_TTL_MS = 5 * 60_000;

export const PRINCIPLES = {
  1: '入力を減らす',
  2: 'コンテキストの寿命を管理する',
  3: '往復を減らす',
  4: 'やり直しを早く止める',
  5: '出力を減らす',
  6: 'プロンプトキャッシュを壊さない',
  7: 'モデルと推論量を使い分ける',
  8: '計測してから最適化する',
};

function bareName(eventName) {
  return String(eventName || '').replace(/^claude_code\./, '');
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isTrue(v) {
  return v === true || v === 'true' || v === 1;
}

function timeOf(row, attrs) {
  const iso = attrs['event.timestamp'];
  if (iso) {
    const t = Date.parse(iso);
    if (Number.isFinite(t)) return t;
  }
  // time_unix_nano は未設定だと "0" で届くことがある
  if (row.time_unix_nano && row.time_unix_nano !== '0') return Number(BigInt(row.time_unix_nano) / 1_000_000n);
  return row.received_at;
}

// 本人とのやり取りのリクエストか。タイトル生成などの補助リクエストやサブエージェントは除く
// （対話モードは repl_main_thread*、`claude -p` / Agent SDK は sdk で届く）
function isMainThread(attrs) {
  if (attrs.agent_id) return false;
  const q = attrs.query_source;
  return q == null || q === 'main' || q === 'sdk' || String(q).startsWith('repl_main_thread');
}

function contextTokens(a) {
  return num(a.input_tokens) + num(a.cache_read_tokens) + num(a.cache_creation_tokens);
}

function newSession(id) {
  return {
    id,
    start: Infinity,
    end: -Infinity,
    prompts: [],
    requests: [],
    tools: [],
    rejects: 0,
    cost: 0,
    linesAdded: 0,
    linesRemoved: 0,
    commits: 0,
    prs: 0,
  };
}

// log_records / metric_points の行（DBそのまま）からセッション集合を作る
export function buildSessions(logRows, metricRows) {
  const sessions = new Map();
  const get = (id) => {
    const key = id || 'unknown';
    if (!sessions.has(key)) sessions.set(key, newSession(key));
    return sessions.get(key);
  };

  const events = logRows.map((row) => {
    const attrs = JSON.parse(row.attributes_json || '{}');
    return { row, attrs, name: bareName(row.event_name), t: timeOf(row, attrs), seq: num(attrs['event.sequence']) };
  });
  events.sort((a, b) => a.t - b.t || a.seq - b.seq || a.row.id - b.row.id);

  for (const e of events) {
    const s = get(e.attrs['session.id']);
    s.start = Math.min(s.start, e.t);
    s.end = Math.max(s.end, e.t);
    const a = e.attrs;
    if (e.name === 'user_prompt') {
      s.prompts.push({ t: e.t, length: num(a.prompt_length), command: a.command_name || null });
    } else if (e.name === 'api_request') {
      s.requests.push({
        t: e.t,
        model: a.model || 'unknown',
        main: isMainThread(a),
        compact: a.query_source === 'compact',
        effort: a.effort || null,
        input: num(a.input_tokens),
        output: num(a.output_tokens),
        cacheRead: num(a.cache_read_tokens),
        cacheCreation: num(a.cache_creation_tokens),
        context: contextTokens(a),
        cost: num(a.cost_usd),
      });
      s.cost += num(a.cost_usd);
    } else if (e.name === 'tool_result') {
      s.tools.push({
        t: e.t,
        name: a.tool_name || 'unknown',
        main: !a.agent_id,
        success: isTrue(a.success),
        inputBytes: num(a.tool_input_size_bytes),
        resultBytes: num(a.tool_result_size_bytes),
      });
    } else if (e.name === 'tool_decision') {
      if (a.decision === 'reject') s.rejects++;
    }
  }

  for (const row of metricRows) {
    const a = JSON.parse(row.attributes_json || '{}');
    const sid = a['session.id'];
    if (!sid) continue;
    const s = get(sid);
    const v = num(row.value);
    if (row.metric_name === 'claude_code.lines_of_code.count') {
      if (a.type === 'removed') s.linesRemoved += v;
      else s.linesAdded += v;
    } else if (row.metric_name === 'claude_code.commit.count') s.commits += v;
    else if (row.metric_name === 'claude_code.pull_request.count') s.prs += v;
  }

  return [...sessions.values()].filter((s) => s.requests.length > 0 || s.tools.length > 0);
}

function lines(s) {
  return s.linesAdded + s.linesRemoved;
}

// 合格の代理指標: コミット/PRがあれば shipped、変更行だけなら changed、
// 編集を試みたのに何も残らなければ no_change、編集を試みていなければ explore（調査・質問）
export function outcomeOf(s) {
  if (s.commits + s.prs > 0) return 'shipped';
  if (lines(s) > 0) return 'changed';
  if (s.tools.some((t) => EDIT_TOOLS.has(t.name)) || s.rejects > 0) return 'no_change';
  return 'explore';
}

function maxStreak(items, keyOf) {
  let best = { key: null, len: 0 };
  let cur = { key: null, len: 0 };
  for (const it of items) {
    const k = keyOf(it);
    if (k == null) {
      cur = { key: null, len: 0 };
      continue;
    }
    cur = k === cur.key ? { key: k, len: cur.len + 1 } : { key: k, len: 1 };
    if (cur.len > best.len) best = { ...cur };
  }
  return best;
}

// 各ルールは (session) => null | { value, detail } を返す。value は閾値と比べた実測値。
const RULES = [
  {
    id: 'explore_before_edit',
    principle: 1,
    title: '編集に入るまでの探索が多い',
    advice: '依頼に「どのファイル・関数を、どう直すか」と関連テストを書くと探し回る量が減ります。',
    check(s, T) {
      const main = s.tools.filter((t) => t.main);
      const firstEdit = main.findIndex((t) => EDIT_TOOLS.has(t.name) && t.success);
      if (firstEdit < 0) return null;
      const n = main.slice(0, firstEdit).filter((t) => EXPLORE_TOOLS.has(t.name)).length;
      const first = s.prompts.find((p) => !p.command);
      return n >= T.exploreBeforeEdit ? { value: n, detail: { firstPromptChars: first ? first.length : null } } : null;
    },
  },
  {
    id: 'large_tool_results',
    principle: 1,
    title: '巨大なツール結果を読み込んでいる',
    advice: '長いログやファイルは全文を渡さず、失敗箇所だけ・範囲を絞った読み込み・保存先の提示にします。',
    check(s, T) {
      const big = s.tools.filter((t) => t.resultBytes >= T.largeResultBytes);
      if (big.length < T.largeResultsPerSession) return null;
      const top = maxStreak(big, (t) => t.name);
      return { value: big.length, detail: { maxBytes: Math.max(...big.map((t) => t.resultBytes)), tool: top.key } };
    },
  },
  {
    id: 'heavy_base_context',
    principle: 1,
    title: '会話開始時点の固定コンテキストが重い',
    advice: '使っていない MCP サーバーやプラグインを外し、CLAUDE.md を必要な指示だけに絞ります。道具の説明も毎回読まれます。',
    check(s, T) {
      const first = s.requests.find((r) => r.main && !r.compact);
      return first && first.context >= T.baseContextTokens ? { value: first.context } : null;
    },
  },
  {
    id: 'long_context',
    principle: 2,
    title: '1つの会話を長く引っ張っている',
    advice: '別の仕事は /clear か新しい会話で始め、進捗はメモファイルに書いてから引き継ぎます。',
    check(s, T) {
      const max = Math.max(0, ...s.requests.filter((r) => r.main).map((r) => r.context));
      return max >= T.longContextTokens ? { value: max, detail: { prompts: s.prompts.length } } : null;
    },
  },
  {
    id: 'auto_compaction',
    principle: 2,
    title: '上限まで使い切って自動圧縮されている',
    advice: '上限を待たず、区切りの良いところで要点をファイルに残して /compact か新しい会話に切り替えます。',
    check(s) {
      // api_request には prompt.id が付かないため、直前の発言が /compact かどうかで手動と自動を分ける。
      // 1つの発言の間に複数回届いた圧縮リクエストは1回と数える
      const auto = new Set();
      for (const r of s.requests.filter((r) => r.compact)) {
        const i = s.prompts.findLastIndex((p) => p.t <= r.t);
        if (i < 0 || s.prompts[i].command !== 'compact') auto.add(i);
      }
      return auto.size > 0 ? { value: auto.size } : null;
    },
  },
  {
    id: 'same_tool_streak',
    principle: 3,
    title: '同じツールを1件ずつ繰り返している',
    advice: '大量の確認や置換は、スクリプトで一括処理して集計結果だけを返させます。',
    check(s, T) {
      const st = maxStreak(s.tools.filter((t) => t.main), (t) => t.name);
      return st.len >= T.sameToolStreak ? { value: st.len, detail: { tool: st.key } } : null;
    },
  },
  {
    id: 'short_followups',
    principle: 3,
    title: '短い追い発言での往復が多い',
    advice: '制約・完了条件・検証方法を最初の依頼に書くと、聞き返しや「続けて」の往復が減ります。',
    check(s, T) {
      const typed = s.prompts.filter((p) => !p.command);
      if (typed.length < T.shortReplyMinPrompts) return null;
      const short = typed.slice(1).filter((p) => p.length > 0 && p.length < T.shortReplyChars).length;
      const ratio = short / (typed.length - 1);
      return ratio >= T.shortReplyRatio ? { value: Number(ratio.toFixed(2)), detail: { prompts: typed.length, short } } : null;
    },
  },
  {
    id: 'failure_streak',
    principle: 4,
    title: '同じ失敗を繰り返している',
    advice: '同じ失敗が続いたら止めて原因を確認させます。回数の上限と「未実行は合格ではない」を先に伝えます。',
    check(s, T) {
      const st = maxStreak(s.tools, (t) => (t.success ? null : t.name));
      return st.len >= T.failureStreak ? { value: st.len, detail: { tool: st.key } } : null;
    },
  },
  {
    id: 'rejected_edits',
    principle: 4,
    title: 'ツール実行の却下が多い（方向のずれ）',
    advice: '大きな変更は先に計画だけ確認し、確認できる単位に区切って進めます。',
    check(s, T) {
      return s.rejects >= T.rejectedEdits ? { value: s.rejects } : null;
    },
  },
  {
    id: 'full_rewrites',
    principle: 5,
    title: '部分編集でなく全書き換えが多い',
    advice: '小さな修正は Edit での部分編集にさせ、ファイル全体を書き直させないようにします。',
    check(s, T) {
      const bytes = (names) => s.tools.filter((t) => names.includes(t.name)).reduce((n, t) => n + t.inputBytes, 0);
      const write = bytes(['Write']);
      const edit = bytes(['Edit', 'MultiEdit', 'NotebookEdit']);
      return write >= T.writeBytesMin && write > edit * 2 ? { value: write, detail: { editBytes: edit } } : null;
    },
  },
  {
    id: 'verbose_output',
    principle: 5,
    title: '変更量に対して出力が多い',
    advice: '報告は変更点・検証結果・未解決事項に絞らせ、全文や差分の再掲は必要な時だけ頼みます。思考量は effort で調整します。',
    check(s, T) {
      const out = s.requests.reduce((n, r) => n + r.output, 0);
      const l = lines(s);
      if (l === 0 || out < T.outputTokensMin) return null;
      const per = Math.round(out / l);
      return per >= T.outputTokensPerLine ? { value: per, detail: { outputTokens: out, lines: l } } : null;
    },
  },
  {
    id: 'low_cache_hit',
    principle: 6,
    title: 'キャッシュのヒット率が低い',
    advice: '作業の途中でモデルや MCP 構成を切り替えず、長く放置した会話は再開より要点を引き継いだ新規会話にします。',
    check(s, T) {
      const read = s.requests.reduce((n, r) => n + r.cacheRead, 0);
      const all = s.requests.reduce((n, r) => n + r.context, 0);
      if (all < T.cacheHitMinInput) return null;
      const rate = read / all;
      return rate < T.cacheHitRateMin ? { value: Number(rate.toFixed(2)) } : null;
    },
  },
  {
    id: 'cache_rebuilds',
    principle: 6,
    title: '会話の途中でキャッシュを作り直している',
    advice: '5分以上の放置やモデル切替でキャッシュが切れます。切り替えは会話の区切りで行います。',
    check(s, T) {
      const main = s.requests.filter((r) => r.main && !r.compact);
      let rebuilds = 0;
      let idle = 0;
      let modelSwitch = 0;
      for (let i = 1; i < main.length; i++) {
        const r = main[i];
        if (r.cacheCreation >= T.cacheRebuildTokens && r.cacheRead < r.cacheCreation) {
          rebuilds++;
          if (r.t - main[i - 1].t > CACHE_TTL_MS) idle++;
          if (r.model !== main[i - 1].model) modelSwitch++;
        }
      }
      return rebuilds >= T.cacheRebuilds ? { value: rebuilds, detail: { afterIdle: idle, afterModelSwitch: modelSwitch } } : null;
    },
  },
  {
    id: 'top_model_small_task',
    principle: 7,
    title: '小さな作業に最上位モデル・高い推論量を使っている',
    advice: '定型の修正・分類・抽出は小型モデルや低い effort で十分なことが多いです。切り替える基準を先に決めておきます。',
    check(s, T) {
      if (s.cost < T.smallTaskMinCost || lines(s) >= T.smallTaskLines || s.commits + s.prs > 0) return null;
      const top = s.requests.filter((r) => TOP_MODEL.test(r.model) || r.effort === 'xhigh' || r.effort === 'max');
      const share = top.reduce((n, r) => n + r.cost, 0) / s.cost;
      return share >= T.topModelCostShare ? { value: Number(share.toFixed(2)), detail: { lines: lines(s) } } : null;
    },
  },
];

function shortId(id) {
  return String(id).slice(0, 8);
}

function sum(arr, f) {
  return arr.reduce((n, x) => n + f(x), 0);
}

// sessions: buildSessions の結果。thresholds で閾値を上書きできる。
export function diagnoseSessions(sessions, thresholds = {}) {
  const T = { ...THRESHOLDS, ...thresholds };
  const byOutcome = { shipped: [], changed: [], no_change: [], explore: [] };
  for (const s of sessions) byOutcome[outcomeOf(s)].push(s);

  const totalCost = sum(sessions, (s) => s.cost);
  const shippedCost = sum(byOutcome.shipped, (s) => s.cost);
  const noOutput = [...byOutcome.no_change, ...byOutcome.explore];

  const findings = [];
  for (const rule of RULES) {
    const hits = [];
    for (const s of sessions) {
      const r = rule.check(s, T);
      if (r) hits.push({ session: s, ...r });
    }
    if (hits.length === 0) continue;
    hits.sort((a, b) => b.session.cost - a.session.cost);
    findings.push({
      id: rule.id,
      principle: rule.principle,
      principleName: PRINCIPLES[rule.principle],
      title: rule.title,
      advice: rule.advice,
      sessions: hits.length,
      sessionShare: Number((hits.length / sessions.length).toFixed(2)),
      cost: sum(hits, (h) => h.session.cost),
      examples: hits.slice(0, 3).map((h) => ({
        session: shortId(h.session.id),
        date: new Date(h.session.start).toISOString().slice(0, 10),
        cost: Number(h.session.cost.toFixed(4)),
        outcome: outcomeOf(h.session),
        value: h.value,
        ...(h.detail ? { detail: h.detail } : {}),
      })),
    });
  }

  // 原則8は個々のセッションではなく期間全体で見る
  const measured = sessions.some((s) => s.prompts.some((p) => MEASURE_COMMANDS.has(p.command)));
  if (!measured && sessions.length >= T.measureMinSessions) {
    findings.push({
      id: 'no_measurement',
      principle: 8,
      principleName: PRINCIPLES[8],
      title: '自分の使用量を確認した形跡がない',
      advice: '/cost や /context で内訳を見てから、一番大きい費目を1つだけ直します。施策は1つずつ試します。',
      sessions: sessions.length,
      sessionShare: 1,
      cost: 0,
      examples: [],
    });
  }

  // 影響の大きい順（該当セッションのコスト合計）。原則8のように金額のないものは最後
  findings.sort((a, b) => b.cost - a.cost || b.sessions - a.sessions);

  return {
    summary: {
      sessions: sessions.length,
      totalCost: Number(totalCost.toFixed(4)),
      outcomes: Object.fromEntries(Object.entries(byOutcome).map(([k, v]) => [k, { sessions: v.length, cost: Number(sum(v, (s) => s.cost).toFixed(4)) }])),
      costPerShipped: byOutcome.shipped.length ? Number((totalCost / byOutcome.shipped.length).toFixed(4)) : null,
      shippedCostShare: totalCost ? Number((shippedCost / totalCost).toFixed(2)) : null,
      noOutputCostShare: totalCost ? Number((sum(noOutput, (s) => s.cost) / totalCost).toFixed(2)) : null,
    },
    findings,
    thresholds: T,
  };
}

const EVENT_NAMES = ['user_prompt', 'api_request', 'tool_result', 'tool_decision'];
const OUTCOME_METRICS = ['claude_code.lines_of_code.count', 'claude_code.commit.count', 'claude_code.pull_request.count'];

export function getDiagnosis(db, { days = 7, top } = {}) {
  const d = [1, 7, 30, 90].includes(days) ? days : 7;
  const since = Date.now() - d * 24 * 60 * 60_000;
  const names = EVENT_NAMES.flatMap((n) => [n, `claude_code.${n}`]);
  const logRows = db
    .prepare(
      `SELECT id, received_at, event_name, time_unix_nano, attributes_json
       FROM log_records
       WHERE received_at >= ? AND event_name IN (${names.map(() => '?').join(',')})`
    )
    .all(since, ...names);
  const metricRows = db
    .prepare(
      `SELECT metric_name, value, attributes_json
       FROM metric_points
       WHERE received_at >= ? AND metric_name IN (${OUTCOME_METRICS.map(() => '?').join(',')})`
    )
    .all(since, ...OUTCOME_METRICS);
  const result = diagnoseSessions(buildSessions(logRows, metricRows));
  if (top) result.findings = result.findings.slice(0, top);
  return { days: d, generatedAt: new Date().toISOString(), ...result };
}
