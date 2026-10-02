#!/usr/bin/env node
/**
 * Local Engine Dashboard event sink — verification harness only.
 *
 * The real Engine Dashboard service is NOT part of this repository and no
 * credential for it exists in this environment. This sink implements the
 * ingestion side of the contract that `CstDashboardPublisher` targets so the
 * CST side of the integration can be exercised end-to-end over real HTTP:
 *
 *   POST <ENGINE_DASHBOARD_URL>
 *   Authorization: Bearer <ENGINE_DASHBOARD_KEY>
 *   x-dashboard-key: <ENGINE_DASHBOARD_KEY>
 *   x-cst-specversion: cst.event.v1
 *   body: { specversion, id, type, source, time, tenant_id, project_id, ... }
 *
 * It is a TEST FIXTURE. It is not a Dashboard implementation and must never be
 * deployed: it accepts any bearer value, keeps everything in memory, and writes
 * a JSONL transcript so a test can assert on what was actually delivered.
 *
 * Fault injection for retry verification:
 *   POST /_control/fail-next  { "count": 2, "status": 503 }
 *     -> the next `count` event POSTs are answered with `status` (default 503),
 *        then normal 202 handling resumes.
 *   POST /_control/reset
 *   GET  /_control/events    -> every event received, in order
 *   GET  /_control/counts    -> { total, byType: { "cst.turn": n, ... } }
 */
import http from 'http';

const PORT = Number(process.env.SINK_PORT || 4310);
const SHARED_KEY = process.env.SINK_EXPECT_KEY || '';

const events = [];
const requestLog = [];
let failNextCount = 0;
let failNextStatus = 503;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '';

  // ── control plane ─────────────────────────────────────────────────────────
  if (url.startsWith('/_control')) {
    if (req.method === 'GET' && url === '/_control/events') return send(res, 200, { total: events.length, events });
    if (req.method === 'GET' && url === '/_control/counts') {
      const byType = {};
      for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;
      return send(res, 200, { total: events.length, byType });
    }
    if (req.method === 'GET' && url === '/_control/requests') {
      return send(res, 200, { total: requestLog.length, requests: requestLog });
    }
    if (req.method === 'POST' && url === '/_control/fail-next') {
      const body = JSON.parse((await readBody(req)) || '{}');
      failNextCount = Number(body.count ?? 1);
      failNextStatus = Number(body.status ?? 503);
      return send(res, 200, { armed: failNextCount, status: failNextStatus });
    }
    if (req.method === 'POST' && url === '/_control/reset') {
      events.length = 0;
      requestLog.length = 0;
      failNextCount = 0;
      return send(res, 200, { reset: true });
    }
    return send(res, 404, { error: 'UNKNOWN_CONTROL_ROUTE' });
  }

  // ── ingestion plane ───────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  }

  const raw = await readBody(req);
  const auth = req.headers['authorization'] || '';
  const xKey = req.headers['x-dashboard-key'] || '';
  const spec = req.headers['x-cst-specversion'] || '';
  const presented = auth.replace(/^Bearer\s+/i, '');

  requestLog.push({
    at: new Date().toISOString(),
    path: url,
    hasBearer: Boolean(presented),
    hasDashboardKey: Boolean(xKey),
    spec,
    keysAgree: presented === xKey,
    bytes: raw.length,
  });

  // Reject a missing/incorrect credential exactly as a real consumer would, so
  // the test proves the publisher is actually authenticating.
  if (SHARED_KEY && presented !== SHARED_KEY) {
    return send(res, 401, { error: 'UNAUTHORIZED' });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return send(res, 400, { error: 'INVALID_JSON' });
  }

  // Validate the spec version in BOTH the header and the payload: the header is
  // what routing uses, the payload is what a consumer will actually index.
  if (spec !== 'cst.event.v1' || parsed?.specversion !== 'cst.event.v1') {
    return send(res, 400, {
      error: 'BAD_SPEC_VERSION',
      header: spec,
      payload: parsed?.specversion ?? null,
    });
  }

  if (failNextCount > 0) {
    failNextCount -= 1;
    return send(res, failNextStatus, { error: 'INJECTED_FAULT' });
  }

  events.push(parsed);
  return send(res, 202, { accepted: true, id: parsed.id, type: parsed.type });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[sink] listening on http://127.0.0.1:${PORT} (expects key len ${SHARED_KEY.length})`);
});
