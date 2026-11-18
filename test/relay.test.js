'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Relay, STALE_AFTER_MS, EXPIRED_AFTER_MS } = require('../lib/relay');
const { createServer } = require('../server');
const UI = require(path.join(__dirname, '..', 'public', 'status.js'));

const sample = (overrides = {}) => ({
  contract: 'ocre-status-v1',
  observed_at: '2026-11-18T13:00:00.000Z',
  checks: {
    api: { status: 'healthy' },
    database: { status: 'healthy' },
    schema: { status: 'healthy' },
    worker: { status: 'failed', reason: 'heartbeat_expired' },
    media: { status: 'not_configured' },
  },
  deployment: { commit: 'abc1234', secret: 'x'.repeat(200) },
  ...overrides,
});

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test('sin heartbeat: todo desconocido con no_heartbeat y la UI no lo muestra operativo', () => {
  const snap = new Relay().snapshot();
  assert.equal(snap.relay.state, 'no_heartbeat');
  assert.equal(snap.checks.api.status, 'unknown');
  assert.equal(snap.checks.api.reason, 'no_heartbeat');
  assert.equal(UI.normalizeContract(snap).overall, 'unknown');
});

test('heartbeat vigente se reenvía tal cual y descarta campos fuera del contrato', () => {
  const c = clock();
  const relay = new Relay({ now: c.now });
  assert.deepEqual(relay.accept(sample()), { ok: true });
  c.advance(5_000);
  const snap = relay.snapshot();
  assert.equal(snap.relay.state, 'current');
  assert.equal(snap.checks.api.status, 'healthy');
  assert.deepEqual(snap.deployment, { commit: 'abc1234' }); // 'secret' se descarta
  assert.equal(relay.latest.payload.deployment.secret, undefined);
});

test('conserva commit válido en deployment', () => {
  const relay = new Relay();
  relay.accept(sample({ deployment: { commit: 'abc1234' } }));
  assert.equal(relay.snapshot().deployment.commit, 'abc1234');
});

test('muestra vieja se marca obsoleta; fallas y no_configurado se conservan', () => {
  const c = clock();
  const relay = new Relay({ now: c.now });
  relay.accept(sample());
  c.advance(STALE_AFTER_MS + 1);
  let snap = relay.snapshot();
  assert.equal(snap.relay.state, 'stale');
  assert.deepEqual(snap.checks.api, { status: 'stale', reason: 'heartbeat_stale' });
  assert.equal(snap.checks.worker.status, 'failed');
  assert.equal(snap.checks.media.status, 'not_configured');
  // Una página abierta en frío (primera muestra) también debe verla obsoleta.
  assert.equal(UI.normalizeContract(snap).overall, 'stale');
  c.advance(EXPIRED_AFTER_MS);
  snap = relay.snapshot();
  assert.equal(snap.relay.state, 'expired');
  assert.equal(snap.checks.api.reason, 'heartbeat_expired');
});

test('rechaza heartbeats fuera de contrato', () => {
  const relay = new Relay();
  assert.equal(relay.accept(null).error, 'body_not_object');
  assert.equal(relay.accept(sample({ contract: 'otro' })).error, 'contract_mismatch');
  assert.equal(relay.accept(sample({ observed_at: 'ayer' })).error, 'observed_at_invalid');
  assert.equal(relay.accept(sample({ checks: { api: { status: 'ok' } } })).error, 'check_invalid:api');
  assert.equal(relay.accept(sample({ checks: { api: { status: 'healthy', reason: 'Bad Reason' } } })).error, 'reason_invalid:api');
  assert.equal(relay.latest, null);
});

async function withServer(opts, fn) {
  const server = createServer(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('HTTP: token, validación, estado, estáticos y path traversal', async () => {
  await withServer({ token: 'secreto-de-prueba' }, async (base) => {
    const post = (body, auth = 'Bearer secreto-de-prueba') =>
      fetch(`${base}/api/heartbeat`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body });

    assert.equal((await post(JSON.stringify(sample()), 'Bearer otro')).status, 401);
    assert.equal((await post(JSON.stringify(sample()), '')).status, 401);
    assert.equal((await post('{no json')).status, 400);
    assert.equal((await post('x'.repeat(70 * 1024))).status, 413);
    assert.equal((await post(JSON.stringify(sample({ contract: 'v0' })))).status, 422);
    assert.equal((await post(JSON.stringify(sample()))).status, 202);

    const status = await fetch(`${base}/api/status`);
    assert.equal(status.status, 200);
    assert.equal(status.headers.get('cache-control'), 'no-store');
    assert.equal(status.headers.get('access-control-allow-origin'), '*');
    const body = await status.json();
    assert.equal(body.relay.state, 'current');
    assert.equal(UI.normalizeContract(body).overall, 'degraded'); // worker en falla

    assert.equal((await fetch(`${base}/api/status`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/api/status`, { method: 'OPTIONS' })).status, 204);

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    const html = await page.text();
    assert.ok(html.indexOf('config.js') < html.indexOf('app.js'), 'config.js debe cargarse antes que app.js');
    assert.equal((await fetch(`${base}/config.js`)).status, 200);
    assert.equal((await fetch(`${base}/..%2fserver.js`)).status, 404);
    assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
    assert.equal((await fetch(`${base}/no-existe.js`)).status, 404);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  });
});

test('HTTP: sin HEARTBEAT_TOKEN el endpoint de escritura queda cerrado', async () => {
  await withServer({ token: '' }, async (base) => {
    const res = await fetch(`${base}/api/heartbeat`, { method: 'POST', body: JSON.stringify(sample()) });
    assert.equal(res.status, 503);
  });
});

test('canales agents/devenv: token, contrato, reenvío intacto y frescura', async () => {
  const devenv = { contract: 'ocre-devenv-v1', observed_at: new Date().toISOString(),
    agents: { claude: { slots_used: 0, quota: { state: 'available', remaining_percent: 40, observed_at: new Date().toISOString() } } }, events: [] };
  await withServer({ token: 'secreto-de-prueba' }, async (base) => {
    const post = (path, body, auth = 'Bearer secreto-de-prueba') =>
      fetch(`${base}${path}`, { method: 'POST', headers: { Authorization: auth }, body: JSON.stringify(body) });
    const empty = await (await fetch(`${base}/api/devenv`)).json();
    assert.equal(empty.relay.state, 'no_heartbeat');
    assert.equal(empty.observed_at, null);
    assert.equal((await post('/api/heartbeat/devenv', devenv, 'Bearer otro')).status, 401);
    assert.equal((await post('/api/heartbeat/devenv', { ...devenv, contract: 'ocre-agents-v1' })).status, 422);
    assert.equal((await post('/api/heartbeat/agents', { contract: 'ocre-agents-v1', observed_at: 'x', agents: {} })).status, 422);
    assert.equal((await post('/api/heartbeat/otro', devenv)).status, 405);
    assert.equal((await post('/api/heartbeat/devenv', devenv)).status, 202);
    const got = await (await fetch(`${base}/api/devenv`)).json();
    assert.equal(got.relay.state, 'current');
    assert.deepEqual(got.agents, devenv.agents); // Core es la fuente: se reenvía sin reinterpretar
    assert.equal((await fetch(`${base}/api/agents`, { method: 'POST' })).status, 405);
  });
});

test('UI: la página respeta la CSP y todos sus recursos existen', () => {
  const fs = require('node:fs');
  const dir = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /\sstyle=/, 'style-src self bloquea atributos style');
  assert.doesNotMatch(html, /<script>(?!<\/script>)|<style>/, 'sin scripts ni estilos en línea');
  const refs = [...html.matchAll(/(?:src|href)="([^"?#]+)/g)].map((m) => m[1]).filter((r) => !r.startsWith('http') && r !== '../');
  assert.ok(refs.length >= 10);
  for (const ref of refs) assert.ok(fs.existsSync(path.join(dir, ref)), 'falta ' + ref);
  const css = fs.readFileSync(path.join(dir, 'board.css'), 'utf8');
  for (const m of css.matchAll(/url\(([^)]+)\)/g)) assert.ok(fs.existsSync(path.join(dir, m[1])), 'falta ' + m[1]);
  for (const js of ['app.js', 'matrix.js']) {
    const src = fs.readFileSync(path.join(dir, js), 'utf8');
    assert.doesNotMatch(src, /style="/, js + ': nada de atributos style en el HTML generado');
  }
});

test('proxy de staging: solo rutas de la lista, caché y una consulta en vuelo', async () => {
  const { UpstreamProxy } = require('../lib/upstream');
  let calls = 0, t = 0;
  const fetchImpl = async (url, opts) => {
    calls++;
    assert.equal(url, 'https://staging.example/api/status');
    assert.equal(opts.redirect, 'error');
    await new Promise((r) => setTimeout(r, 5));
    return { status: 200, text: async () => JSON.stringify({ contract: 'ocre-status-v1', observed_at: 'x' }) };
  };
  const proxy = new UpstreamProxy({ origin: 'https://staging.example/', fetchImpl, now: () => t, ttlMs: 5000 });
  const [a, b] = await Promise.all([proxy.get('status'), proxy.get('status')]);
  assert.equal(calls, 1);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, b.body);
  t = 4000; await proxy.get('status'); assert.equal(calls, 1);
  t = 6000; await proxy.get('status'); assert.equal(calls, 2);
  assert.equal((await proxy.get('../secret')).status, 404);
});

test('proxy de staging: falla cerrado ante errores, JSON inválido o respuestas enormes', async () => {
  const { UpstreamProxy } = require('../lib/upstream');
  const mk = (impl) => new UpstreamProxy({ fetchImpl: impl, ttlMs: 0 });
  assert.deepEqual(await mk(async () => { throw new Error('down'); }).get('status'), { status: 502, body: { error: 'upstream_unavailable' } });
  assert.equal((await mk(async () => ({ status: 200, text: async () => '<html>' })).get('status')).body.error, 'upstream_invalid_json');
  assert.equal((await mk(async () => ({ status: 200, text: async () => '[1]' })).get('status')).body.error, 'upstream_invalid_json');
  assert.equal((await mk(async () => ({ status: 200, text: async () => 'x'.repeat(70000) })).get('status')).body.error, 'upstream_too_large');
  const kept = await mk(async () => ({ status: 503, text: async () => '{"contract":"ocre-status-v1"}' })).get('status');
  assert.equal(kept.status, 503);
});

test('servidor: /api/staging/* usa el proxy y solo acepta GET', async () => {
  const staging = { get: async (name) => ({ status: 200, body: { proxied: name } }) };
  const server = createServer({ staging, token: 't' });
  await new Promise((r) => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const ok = await fetch(base + '/api/staging/xpress-status');
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { proxied: 'xpress-status' });
    assert.equal(ok.headers.get('access-control-allow-origin'), '*');
    assert.equal((await fetch(base + '/api/staging/status', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/api/staging/agents')).status, 404);
  } finally {
    server.close();
  }
});
