#!/usr/bin/env node
'use strict';

// Corre en la X280: lee el estado de Core (contrato ocre-status-v1) y lo reenvía al relay de
// status.ocre.mx cada INTERVAL_MS. Sin dependencias; requiere Node 18+.
//
//   CORE_STATUS_URL   URL local del estado de Core (p. ej. http://127.0.0.1:8080/api/status)
//   RELAY_URL         https://status.ocre.mx/api/heartbeat
//   HEARTBEAT_TOKEN   el mismo valor guardado como secreto en GoDaddy
//   INTERVAL_MS       opcional, 10000 por defecto (la UI marca obsoleta una muestra congelada a los 25 s)

const CORE_STATUS_URL = process.env.CORE_STATUS_URL;
const RELAY_URL = process.env.RELAY_URL;
const TOKEN = process.env.HEARTBEAT_TOKEN;
const INTERVAL_MS = Math.max(5000, Number(process.env.INTERVAL_MS) || 10000);
const TIMEOUT_MS = 5000;

for (const [name, value] of Object.entries({ CORE_STATUS_URL, RELAY_URL, HEARTBEAT_TOKEN: TOKEN })) {
  if (!value) {
    console.error(`Falta la variable ${name}`);
    process.exit(2);
  }
}

async function readCore() {
  try {
    const res = await fetch(CORE_STATUS_URL, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body?.contract !== 'ocre-status-v1') throw new Error('contrato inesperado');
    return body;
  } catch (error) {
    // La X280 está viva pero la API de Core no respondió: se informa como falla de la API,
    // y lo demás como desconocido, sin suponer nada más.
    console.warn(new Date().toISOString(), 'Core no respondió:', error.message);
    return {
      contract: 'ocre-status-v1',
      observed_at: new Date().toISOString(),
      checks: { api: { status: 'failed' }, database: { status: 'unknown' }, schema: { status: 'unknown' } },
    };
  }
}

async function beat() {
  const payload = await readCore();
  try {
    const res = await fetch(RELAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 202) console.warn(new Date().toISOString(), 'El relay respondió', res.status, await res.text());
  } catch (error) {
    console.warn(new Date().toISOString(), 'No se pudo contactar el relay:', error.message);
  }
}

let running = false;
async function tick() {
  if (running) return; // nunca encimar dos envíos
  running = true;
  try {
    await beat();
  } finally {
    running = false;
  }
}

tick();
setInterval(tick, INTERVAL_MS);
