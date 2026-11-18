'use strict';

// Proxy de solo lectura hacia staging.ocre.mx.
// Core solo autoriza el origen https://apps.ocre.mx en su CORS y sus documentos dicen que no se amplía.
// En lugar de abrirlo, este servidor consulta staging por su cuenta y la página lo lee desde su propio dominio.
// - Solo las rutas de la lista, solo GET, sin cookies ni cabeceras del visitante.
// - Caché corta y una sola consulta en vuelo por ruta: muchos visitantes no multiplican la carga sobre staging.
// - La respuesta se valida como JSON y se vuelve a serializar; nunca se reenvía el cuerpo tal cual.

const ROUTES = { status: '/api/status', 'xpress-status': '/api/xpress-status' };
const MAX_BYTES = 64 * 1024;

class UpstreamProxy {
  constructor({ origin = process.env.STAGING_ORIGIN || 'https://staging.ocre.mx', ttlMs = 5000, timeoutMs = 5000, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    this.origin = origin.replace(/\/$/, '');
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.now = now;
    this.cache = new Map();
    this.inflight = new Map();
  }

  static has(name) {
    return Object.prototype.hasOwnProperty.call(ROUTES, name);
  }

  async get(name) {
    if (!UpstreamProxy.has(name)) return { status: 404, body: { error: 'not_found' } };
    const hit = this.cache.get(name);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.result;
    if (this.inflight.has(name)) return this.inflight.get(name);
    const pending = this.load(name).then((result) => {
      this.cache.set(name, { at: this.now(), result });
      return result;
    }).finally(() => this.inflight.delete(name));
    this.inflight.set(name, pending);
    return pending;
  }

  async load(name) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(this.origin + ROUTES[name], {
        headers: { Accept: 'application/json', 'User-Agent': 'ocre-status-proxy' },
        redirect: 'error',
        signal: controller.signal,
      });
      const text = await response.text();
      if (text.length > MAX_BYTES) return { status: 502, body: { error: 'upstream_too_large' } };
      let body;
      try { body = JSON.parse(text); } catch { return { status: 502, body: { error: 'upstream_invalid_json' } }; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 502, body: { error: 'upstream_invalid_json' } };
      // Se respeta el código de staging (p. ej. 503 con contrato «failed»): la página ya sabe interpretarlo.
      return { status: response.status >= 200 && response.status < 600 ? response.status : 502, body };
    } catch (_error) {
      return { status: 502, body: { error: 'upstream_unavailable' } };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { UpstreamProxy, ROUTES };
