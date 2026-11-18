'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Relay, MAX_BODY_BYTES } = require('./lib/relay');

const PUBLIC_DIR = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self' https://os.ocre.mx https://staging.ocre.mx; img-src 'self' data:; " +
    "style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function tokenMatches(header, expected) {
  if (!expected || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  return crypto.timingSafeEqual(digest(header.slice(7)), digest(expected));
}

function sendJson(res, status, body, extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    // Al pasar el límite se deja de guardar y se descarta el resto, para poder responder 413 limpio.
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      if (size > 16 * MAX_BODY_BYTES) req.destroy(); // no seguir leyendo cuerpos enormes
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) reject(Object.assign(new Error('too_large'), { code: 'too_large' }));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'not_found' });
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return sendJson(res, 404, { error: 'not_found' });
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const cache = path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=300';
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': cache, 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function createServer({ relay = new Relay(), token = process.env.HEARTBEAT_TOKEN } = {}) {
  return http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      if (pathname === '/api/status') {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { ...SECURITY_HEADERS, ...corsHeaders() });
          return res.end();
        }
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
        return sendJson(res, 200, relay.snapshot(), corsHeaders());
      }
      if (pathname === '/api/heartbeat') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
        if (!token) return sendJson(res, 503, { error: 'heartbeat_token_not_configured' });
        if (!tokenMatches(req.headers.authorization, token)) return sendJson(res, 401, { error: 'unauthorized' });
        let payload;
        try {
          payload = JSON.parse(await readBody(req));
        } catch (error) {
          return sendJson(res, error.code === 'too_large' ? 413 : 400, { error: error.code === 'too_large' ? 'too_large' : 'invalid_json' });
        }
        const result = relay.accept(payload);
        return result.ok ? sendJson(res, 202, { accepted: true }) : sendJson(res, 422, { error: result.error });
      }
      if (pathname === '/healthz') return sendJson(res, 200, { ok: true });
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' });
      return serveStatic(req, res, pathname);
    } catch (_error) {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
    }
  });
}

// La página de estado es pública; cualquier origen puede leerla, nadie puede escribir sin token.
function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '600' };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => {
    console.log(`ocre-status escuchando en el puerto ${port}`);
    if (!process.env.HEARTBEAT_TOKEN) console.warn('HEARTBEAT_TOKEN no está configurado: /api/heartbeat responderá 503');
  });
}

module.exports = { createServer };
