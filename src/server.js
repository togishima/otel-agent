import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { initDb } from './db.js';
import { ingestMetricsPayload, ingestLogsPayload } from './otlp-parse.js';
import { getSummary, getToolBreakdown, getModelBreakdown, getSkillBreakdown, getRecentEvents, getTimeseries } from './queries.js';
import { enqueue, startForwarder, isForwardingEnabled } from './forwarder.js';
import { startMaintenance } from './maintenance.js';
import { IS_SEA, packageRoot, readSeaAsset } from './paths.js';

const PUBLIC_DIR = path.join(packageRoot(), 'public');
const PORT = process.env.PORT ? Number(process.env.PORT) : 4318;

const db = initDb();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// rel は先頭スラッシュなしの相対パス（例: 'index.html'）。
// SEAバイナリでは埋め込みアセットから、通常実行では public/ から返す。
async function serveStatic(res, rel) {
  try {
    let data;
    if (IS_SEA) {
      data = readSeaAsset(rel);
    } else {
      const filePath = path.join(PUBLIC_DIR, rel);
      if (!filePath.startsWith(PUBLIC_DIR)) throw new Error('forbidden');
      data = await readFile(filePath);
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function sendJson(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === 'POST' && url.pathname === '/v1/metrics') {
      const body = await readBody(req);
      const raw = body.toString('utf8') || '{}';
      const count = ingestMetricsPayload(db, JSON.parse(raw));
      if (isForwardingEnabled()) enqueue(db, 'metrics', raw);
      sendJson(res, {});
      console.log(`[metrics] ingested ${count} data points`);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/logs') {
      const body = await readBody(req);
      const raw = body.toString('utf8') || '{}';
      const count = ingestLogsPayload(db, JSON.parse(raw));
      if (isForwardingEnabled()) enqueue(db, 'logs', raw);
      sendJson(res, {});
      console.log(`[logs] ingested ${count} log records`);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/summary') {
      sendJson(res, getSummary(db));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/tools') {
      sendJson(res, getToolBreakdown(db));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/models') {
      sendJson(res, getModelBreakdown(db));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/skills') {
      sendJson(res, getSkillBreakdown(db));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      sendJson(res, getRecentEvents(db));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/timeseries') {
      sendJson(res, getTimeseries(db, Number(url.searchParams.get('hours')), url.searchParams.get('by')));
      return;
    }

    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      await serveStatic(res, rel);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
});

server.listen(PORT, () => {
  console.log(`otel-agent: receiver + dashboard listening on http://localhost:${PORT}`);
  console.log(`  OTLP metrics endpoint: POST http://localhost:${PORT}/v1/metrics`);
  console.log(`  OTLP logs endpoint:    POST http://localhost:${PORT}/v1/logs`);
  console.log(`  Dashboard:             http://localhost:${PORT}/`);
  startForwarder(db);
  startMaintenance(db);
});
