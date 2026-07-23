const COLORS = { input: '#4C9AFF', output: '#36B37E', cacheRead: '#FFAB00', cacheCreation: '#FF5630' };
const LABELS = { input: 'Input', output: 'Output', cacheRead: 'Cache Read', cacheCreation: 'Cache Creation' };

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
    tbody.innerHTML = '<tr><td colspan="3" class="empty">データなし</td></tr>';
    return;
  }
  tbody.innerHTML = rows
    .map((r) => `<tr><td>${r.model || '(unknown)'}</td><td>${LABELS[r.type] || r.type}</td><td>${fmtNum(r.total)}</td></tr>`)
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
    const [summary, tools, models, events] = await Promise.all([
      fetchJson('/api/summary'),
      fetchJson('/api/tools'),
      fetchJson('/api/models'),
      fetchJson('/api/events'),
    ]);
    renderCards(summary);
    renderTokenBar(summary);
    renderToolTable(tools);
    renderModelTable(models);
    renderEvents(events);
  } catch (e) {
    console.error('refresh failed', e);
  }
}

refresh();
setInterval(refresh, 4000);
