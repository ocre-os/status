'use strict';

// Lógica pura del relay de estado: guarda el último heartbeat `ocre-status-v1` que manda la X280
// y decide, con el reloj del servidor, si esa muestra sigue vigente. No inventa estados: solo
// reenvía lo que Core reportó, o lo marca obsoleto o sin señal con los códigos que ya usa la UI.

const CONTRACT = 'ocre-status-v1';
const STALE_AFTER_MS = 30_000; // igual que STALE_AFTER_MS de la UI
const EXPIRED_AFTER_MS = 5 * 60_000;
const MAX_BODY_BYTES = 64 * 1024;
const CHECK_KEYS = ['api', 'database', 'schema', 'worker', 'media', 'storage', 'notifications', 'pwa'];
const STATUSES = new Set(['healthy', 'degraded', 'failed', 'stale', 'unknown', 'not_configured']);
const REASON_CODE = /^[a-z_]{1,40}$/;

function validateHeartbeat(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'body_not_object';
  if (payload.contract !== CONTRACT) return 'contract_mismatch';
  if (!Number.isFinite(Date.parse(payload.observed_at))) return 'observed_at_invalid';
  if (!payload.checks || typeof payload.checks !== 'object' || Array.isArray(payload.checks)) return 'checks_missing';
  for (const [key, value] of Object.entries(payload.checks)) {
    if (!value || typeof value !== 'object' || !STATUSES.has(value.status)) return `check_invalid:${key}`;
    if (value.reason !== undefined && (typeof value.reason !== 'string' || !REASON_CODE.test(value.reason))) {
      return `reason_invalid:${key}`;
    }
  }
  return null;
}

// Solo se conservan los campos del contrato; cualquier otro dato del cuerpo se descarta.
function sanitize(payload) {
  const checks = {};
  for (const [key, value] of Object.entries(payload.checks)) {
    checks[key] = value.reason === undefined ? { status: value.status } : { status: value.status, reason: value.reason };
  }
  const out = { contract: CONTRACT, observed_at: new Date(Date.parse(payload.observed_at)).toISOString(), checks };
  if (payload.deployment && typeof payload.deployment === 'object' && !Array.isArray(payload.deployment)) {
    const d = {};
    for (const k of ['commit', 'version', 'environment', 'deployed_at']) {
      if (typeof payload.deployment[k] === 'string' && payload.deployment[k].length <= 80) d[k] = payload.deployment[k];
    }
    out.deployment = d;
  }
  return out;
}

class Relay {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.latest = null; // { payload, receivedAt }
  }

  accept(payload) {
    const error = validateHeartbeat(payload);
    if (error) return { ok: false, error };
    this.latest = { payload: sanitize(payload), receivedAt: this.now() };
    return { ok: true };
  }

  // Respuesta para GET /api/status. `relay` describe la frescura según el reloj del servidor.
  snapshot() {
    const now = this.now();
    if (!this.latest) {
      const checks = Object.fromEntries(CHECK_KEYS.map((k) => [k, { status: 'unknown', reason: 'no_heartbeat' }]));
      return {
        contract: CONTRACT,
        observed_at: null,
        checks,
        relay: { state: 'no_heartbeat', received_at: null, age_ms: null, served_at: new Date(now).toISOString() },
      };
    }
    const { payload, receivedAt } = this.latest;
    const age = now - receivedAt;
    const relay = {
      state: age > EXPIRED_AFTER_MS ? 'expired' : age > STALE_AFTER_MS ? 'stale' : 'current',
      received_at: new Date(receivedAt).toISOString(),
      age_ms: age,
      served_at: new Date(now).toISOString(),
    };
    if (relay.state === 'current') return { ...payload, relay };
    // Muestra vieja: se marca obsoleta; una falla explícita nunca se oculta (misma regla que la UI).
    const reason = relay.state === 'expired' ? 'heartbeat_expired' : 'heartbeat_stale';
    const checks = {};
    for (const [key, value] of Object.entries(payload.checks)) {
      checks[key] = value.status === 'failed' || value.status === 'not_configured' ? value : { status: 'stale', reason };
    }
    return { ...payload, checks, relay };
  }
}

module.exports = { Relay, validateHeartbeat, CONTRACT, STALE_AFTER_MS, EXPIRED_AFTER_MS, MAX_BODY_BYTES };

// Canales que Core ya publica (staging) y que la X280 reenvía tal cual: `ocre-agents-v1` y `ocre-devenv-v1`.
// Core es la fuente de verdad de esos contratos; el relay no los reinterpreta: valida forma mínima,
// guarda la última muestra y la sirve. La UI juzga la frescura por `observed_at` (≤ 30 s).
const CHANNELS = { agents: 'ocre-agents-v1', devenv: 'ocre-devenv-v1' };

class ChannelRelay {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.latest = {};
  }

  accept(channel, payload) {
    const contract = CHANNELS[channel];
    if (!contract) return { ok: false, error: 'unknown_channel' };
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, error: 'body_not_object' };
    if (payload.contract !== contract) return { ok: false, error: 'contract_mismatch' };
    if (!Number.isFinite(Date.parse(payload.observed_at))) return { ok: false, error: 'observed_at_invalid' };
    if (!payload.agents || typeof payload.agents !== 'object' || Array.isArray(payload.agents)) return { ok: false, error: 'agents_missing' };
    this.latest[channel] = { payload, receivedAt: this.now() };
    return { ok: true };
  }

  snapshot(channel) {
    const contract = CHANNELS[channel];
    const entry = this.latest[channel];
    const servedAt = new Date(this.now()).toISOString();
    if (!entry) return { contract, observed_at: null, agents: {}, relay: { state: 'no_heartbeat', served_at: servedAt } };
    const age = this.now() - entry.receivedAt;
    return {
      ...entry.payload,
      relay: {
        state: age > EXPIRED_AFTER_MS ? 'expired' : age > STALE_AFTER_MS ? 'stale' : 'current',
        received_at: new Date(entry.receivedAt).toISOString(),
        age_ms: age,
        served_at: servedAt,
      },
    };
  }
}

module.exports.ChannelRelay = ChannelRelay;
module.exports.CHANNELS = CHANNELS;
