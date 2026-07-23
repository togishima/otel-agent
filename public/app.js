const COLORS = { input: '#4C9AFF', output: '#36B37E', cacheRead: '#FFAB00', cacheCreation: '#FF5630' };
const LABELS = { input: 'Input', output: 'Output', cacheRead: 'Cache Read', cacheCreation: 'Cache Creation' };
const TYPE_ORDER = ['input', 'output', 'cacheRead', 'cacheCreation'];

const FAMILY_ORDER = ['opus', 'sonnet', 'haiku', 'fable', 'mythos', 'other'];
const FAMILY_COLORS = { opus: '#6554C0', sonnet: '#4C9AFF', haiku: '#36B37E', fable: '#FF8B00', mythos: '#FF5630', other: '#8993A4' };

// 'claude-fable-5[1m]' や 'claude-haiku-4-5-20251001' からファミリー名を抽出
function familyOf(model) {
  const m = String(model || '').toLowerCase().match(/opus|sonnet|haiku|fable|mythos/);
  return m ? m[0] : 'other';
}

async function fetchJson(url) {
  const res = await fetch(url);
  return res.json();
}

function fmtNum(n) {
  return new Intl.NumberFormat('ja-JP').format(Math.round(n || 0));
}

function fmtUsd(n) {
  return '$' + (n || 0).toFixed(4);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderCards(summary) {
  const totalTokens = summary.input + summary.output + summary.cacheRead + summary.cacheCreation;
  const cards = [
    { label: '総トークン数', value: fmtNum(totalTokens) },
    { label: '概算コスト', value: fmtUsd(summary.cost) },
    { label: 'セッション数', value: fmtNum(summary.sessions) },
    { label: 'ツール呼び出し数', value: fmtNum(summary.toolCalls) },
    { label: '最終受信', value: summary.lastEventAt ? new Date(summary.lastEventAt).toLocaleTimeString('ja-JP') : '-' },
  ];
  document.getElementById('cards').innerHTML = cards
    .map((c) => `<div class="card"><div class="card-value">${c.value}</div><div class="card-label">${c.label}</div></div>`)
    .join('');
}

function renderTokenBar(summary) {
  const total = summary.input + summary.output + summary.cacheRead + summary.cacheCreation;
  const bar = document.getElementById('token-bar');
  const legend = document.getElementById('token-legend');
  if (total === 0) {
    bar.innerHTML = '<div class="empty">データがまだありません。Claude Code を起動してください。</div>';
    legend.innerHTML = '';
    return;
  }
  const parts = ['input', 'output', 'cacheRead', 'cacheCreation'];
  bar.innerHTML = parts
    .map((k) => {
      const pct = ((summary[k] / total) * 100).toFixed(1);
      return Number(pct) > 0 ? `<div class="bar-seg" style="width:${pct}%;background:${COLORS[k]}" title="${LABELS[k]}: ${pct}%"></div>` : '';
    })
    .join('');
  legend.innerHTML = parts
    .map((k) => `<span class="legend-item"><span class="dot" style="background:${COLORS[k]}"></span>${LABELS[k]}: ${fmtNum(summary[k])} (${((summary[k] / total) * 100).toFixed(1)}%)</span>`)
    .join('');
}

let tsHours = 24;
let tsBy = 'type';

function niceCeil(n) {
  if (n <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(n)));
  for (const m of [1, 2, 5, 10]) {
    if (m * p >= n) return m * p;
  }
  return 10 * p;
}

function fmtBucketTime(t, hours) {
  const d = new Date(t);
  if (hours >= 720) return `${d.getMonth() + 1}/${d.getDate()}`;
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return hours >= 168 ? `${d.getMonth() + 1}/${d.getDate()} ${hm}` : hm;
}

function renderTimeseries(ts) {
  const el = document.getElementById('ts-chart');
  const byModel = ts.by === 'model';

  const byBucket = new Map();
  const present = new Set();
  for (const r of ts.rows) {
    const key = byModel ? familyOf(r.series) : r.series;
    if (!byModel && !TYPE_ORDER.includes(key)) continue;
    present.add(key);
    const b = byBucket.get(r.bucket) || {};
    b[key] = (b[key] || 0) + (r.total || 0);
    byBucket.set(r.bucket, b);
  }
  const parts = (byModel ? FAMILY_ORDER : TYPE_ORDER).filter((k) => present.has(k));
  const colorOf = (k) => (byModel ? FAMILY_COLORS[k] : COLORS[k]);
  const labelOf = (k) => (byModel ? k : LABELS[k]);

  const start = Math.floor(ts.since / ts.bucketMs) * ts.bucketMs + ts.bucketMs;
  const end = Math.floor(Date.now() / ts.bucketMs) * ts.bucketMs;
  const buckets = [];
  for (let t = start; t <= end; t += ts.bucketMs) buckets.push(t);

  const stackTotal = (t) => {
    const b = byBucket.get(t);
    return b ? parts.reduce((s, k) => s + (b[k] || 0), 0) : 0;
  };
  const legend = document.getElementById('ts-legend');
  if (!buckets.length || !buckets.some((t) => stackTotal(t) > 0)) {
    el.innerHTML = '<div class="empty">この期間のデータはありません。</div>';
    legend.innerHTML = '';
    return;
  }
  legend.innerHTML = parts
    .map((k) => `<span class="legend-item"><span class="dot" style="background:${colorOf(k)}"></span>${labelOf(k)}</span>`)
    .join('');

  const W = 800, H = 220, L = 70, R = 10, T = 10, B = 24;
  const plotW = W - L - R;
  const plotH = H - T - B;
  const yMax = niceCeil(Math.max(...buckets.map(stackTotal)));
  const bw = plotW / buckets.length;

  const gridLines = [0, 0.5, 1]
    .map((f) => {
      const y = T + plotH * (1 - f);
      return `<line x1="${L}" y1="${y}" x2="${W - R}" y2="${y}"></line>
        <text x="${L - 8}" y="${y + 4}" text-anchor="end">${fmtNum(yMax * f)}</text>`;
    })
    .join('');

  const bars = buckets
    .map((t, i) => {
      const b = byBucket.get(t);
      if (!b) return '';
      let y = T + plotH;
      const x = (L + i * bw + bw * 0.1).toFixed(1);
      const w = Math.max(bw * 0.8, 1).toFixed(1);
      const rects = parts
        .map((k) => {
          const h = ((b[k] || 0) / yMax) * plotH;
          if (h <= 0) return '';
          y -= h;
          return `<rect x="${x}" y="${y.toFixed(1)}" width="${w}" height="${h.toFixed(1)}" fill="${colorOf(k)}"></rect>`;
        })
        .join('');
      const title = `${fmtBucketTime(t, ts.hours)}\n` + parts.map((k) => `${labelOf(k)}: ${fmtNum(b[k] || 0)}`).join('\n');
      return `<g><title>${title}</title>${rects}</g>`;
    })
    .join('');

  const labelStep = Math.max(1, Math.ceil(buckets.length / 5));
  const xLabels = buckets
    .map((t, i) =>
      i % labelStep === 0
        ? `<text x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${fmtBucketTime(t, ts.hours)}</text>`
        : ''
    )
    .join('');

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${gridLines}${bars}${xLabels}</svg>`;
}

function renderToolTable(rows) {
  const tbody = document.querySelector('#tool-table tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">データなし</td></tr>';
    return;
  }
  tbody.innerHTML = rows
    .map((r) => `<tr><td>${r.tool_name || '(unknown)'}</td><td>${r.success_count}</td><td>${r.fail_count}</td><td>${r.total}</td></tr>`)
    .join('');
}

function renderModelTable(rows) {
  const tbody = document.querySelector('#model-table tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">データなし</td></tr>';
    return;
  }
  // (model, type, total) の行をモデルごとに1行へピボット
  const byModel = new Map();
  for (const r of rows) {
    const model = r.model || '(unknown)';
    const m = byModel.get(model) || { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
    if (TYPE_ORDER.includes(r.type)) m[r.type] += r.total || 0;
    m.total += r.total || 0;
    byModel.set(model, m);
  }
  const grand = [...byModel.values()].reduce((s, m) => s + m.total, 0);
  tbody.innerHTML = [...byModel.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([model, m]) => {
      const pct = grand > 0 ? ((m.total / grand) * 100).toFixed(1) : '0.0';
      const cells = TYPE_ORDER.map((k) => `<td>${fmtNum(m[k])}</td>`).join('');
      return `<tr><td>${model}</td>${cells}<td>${fmtNum(m.total)}</td><td>${pct}%</td></tr>`;
    })
    .join('');
}

function renderSkillTable(rows) {
  const tbody = document.querySelector('#skill-table tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">データなし（スキルが呼び出されるとここに表示されます）</td></tr>';
    return;
  }
  tbody.innerHTML = rows
    .map((r) => `<tr><td>${escapeHtml(r.skill)}</td><td>${fmtNum(r.requests)}</td><td>${fmtNum(r.tokens)}</td><td>${fmtUsd(r.cost)}</td></tr>`)
    .join('');
}

function renderEvents(rows) {
  const tbody = document.querySelector('#events-table tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">データなし</td></tr>';
    return;
  }
  tbody.innerHTML = rows
    .map((r) => {
      let attrs = {};
      try {
        attrs = JSON.parse(r.attributes_json);
      } catch {
        // ignore malformed payloads
      }
      return `<tr><td>${new Date(r.received_at).toLocaleTimeString('ja-JP')}</td><td>${r.event_name || '(unknown)'}</td><td class="attrs">${escapeHtml(JSON.stringify(attrs))}</td></tr>`;
    })
    .join('');
}

async function refresh() {
  try {
    const [summary, tools, models, skills, events, timeseries] = await Promise.all([
      fetchJson('/api/summary'),
      fetchJson('/api/tools'),
      fetchJson('/api/models'),
      fetchJson('/api/skills'),
      fetchJson('/api/events'),
      fetchJson(`/api/timeseries?hours=${tsHours}&by=${tsBy}`),
    ]);
    renderCards(summary);
    renderTokenBar(summary);
    renderTimeseries(timeseries);
    renderToolTable(tools);
    renderModelTable(models);
    renderSkillTable(skills);
    renderEvents(events);
  } catch (e) {
    console.error('refresh failed', e);
  }
}

document.querySelectorAll('#ts-hours button').forEach((btn) => {
  btn.addEventListener('click', () => {
    tsHours = Number(btn.dataset.hours);
    document.querySelectorAll('#ts-hours button').forEach((b) => b.classList.toggle('active', b === btn));
    refresh();
  });
});

document.querySelectorAll('#ts-by button').forEach((btn) => {
  btn.addEventListener('click', () => {
    tsBy = btn.dataset.by;
    document.querySelectorAll('#ts-by button').forEach((b) => b.classList.toggle('active', b === btn));
    refresh();
  });
});

refresh();
setInterval(refresh, 4000);
