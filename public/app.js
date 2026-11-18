// OCRE OS · Estado — tablero de control.
// Toda la lógica de contratos, obsolescencia y validación vive en status.js, view.js, agents.js,
// xpress.js, devenv.js y compact-ui.js (sin DOM). Este archivo solo sondea y dibuja.
// CSP: style-src 'self' prohíbe atributos style en el HTML; los tamaños se fijan con CSSOM.
(() => {
  const S = window.OcreStatus, V = window.OcreView, A = window.OcreAgents, X = window.OcreXpress, D = window.OcreDevenv, C = window.OcreCompact;
  const targets = window.OCRE_STATUS_TARGETS || {
    core: { label: 'CORE', url: 'https://os.ocre.mx/api/status' },
    staging: { label: 'STAGING', url: 'https://staging.ocre.mx/api/status' },
  };
  const endpoints = window.OCRE_STATUS_ENDPOINTS || {};
  const URLS = {
    agents: endpoints.agents || 'https://staging.ocre.mx/api/agents',
    devenv: endpoints.devenv || 'https://staging.ocre.mx/api/devenv',
    xpress: endpoints.xpress || 'https://staging.ocre.mx/api/xpress-status',
  };
  const ENV_NAME = { core: 'Core', staging: 'Staging' };
  const ENV_NOTE = { core: 'relay de status.ocre.mx', staging: 'staging.ocre.mx' };
  const POLL_MS = 10000, FRESH_MS = 30000, HISTORY = 48;

  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtTime = (iso, seconds = true) => new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: false }).format(new Date(iso));
  const fmtDay = (iso) => new Intl.DateTimeFormat('es-MX', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  function agoShort(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return 'hace ' + s + ' s';
    const m = Math.floor(s / 60);
    if (m < 60) return 'hace ' + m + ' min';
    const h = Math.floor(m / 60);
    return h < 48 ? 'hace ' + h + ' h' : 'hace ' + Math.floor(h / 24) + ' d';
  }

  // ── Íconos: el estado nunca depende solo del color ────────────────────────
  const ICON = {
    healthy: '<path d="M3.5 8.3l2.9 2.9 6-6.4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
    degraded: '<path d="M8 2.2l6.2 11H1.8z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6.4v3.2M8 11.5v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    failed: '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    stale: '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.6V8l2.4 1.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    unknown: '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.4 2"/><path d="M6.4 6.4a1.7 1.7 0 1 1 2.3 1.6c-.5.2-.7.6-.7 1.1M8 11.4v.1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
    neutral: '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.3 8h5.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  };
  const TONE_ALIAS = { not_configured: 'neutral', disabled: 'neutral', checking: 'unknown', ok: 'healthy', late: 'degraded', reconcile: 'degraded', available: 'healthy', low: 'degraded', exhausted: 'failed' };
  const toneOf = (t) => TONE_ALIAS[t] || (ICON[t] ? t : 'unknown');
  const icon = (t) => '<svg viewBox="0 0 16 16" aria-hidden="true">' + ICON[toneOf(t)] + '</svg>';
  const STATUS_WORD = { healthy: 'Operativo', degraded: 'Degradado', failed: 'Falla', stale: 'Obsoleto', unknown: 'Sin señal', not_configured: 'No configurado' };
  const VERDICT_WORD = { healthy: 'Operativo', degraded: 'Degradado', failed: 'Con falla', stale: 'Obsoleto', unknown: 'Sin señal' };

  // ── Tooltip compartido ────────────────────────────────────────────────────
  const tip = $('tooltip');
  function showTip(event, html) {
    tip.innerHTML = html; tip.hidden = false;
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = event.clientX + pad, y = event.clientY - h - pad;
    if (x + w > innerWidth - 8) x = event.clientX - w - pad;
    if (y < 8) y = event.clientY + pad;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  const hideTip = () => { tip.hidden = true; };

  // ── Estado de la página ───────────────────────────────────────────────────
  let selected = 'core';
  const statusMonitor = new S.StatusMonitor({ timeoutMs: 5500 });
  const agentMonitor = new A.AgentMonitor();
  const devenvMonitor = new D.DevenvMonitor();
  const xpressMonitor = new X.XpressMonitor();
  const data = { raw: null, status: null, agents: null, agentsChecked: false, devenv: null, devenvChecked: false, xpress: null, xpressChecked: false };
  let history = [];
  let lastPollAt = 0, checking = false, pollTimer = null;

  // ── Plataforma: panel de anunciadores ─────────────────────────────────────
  const CHECK_DESC = {
    web: 'El servidor de estado responde.', api: 'Aplicación y diagnóstico.', database: 'Conexión con la base de datos.',
    schema: 'Migraciones al día.', worker: 'Envío de notificaciones.', media: 'Fotos y videos de Solicitudes.',
    storage: 'Archivos operativos.', notifications: 'Correo y canales externos.', pwa: 'App instalable.',
  };
  const ANN_ORDER = ['web', 'api', 'database', 'schema', 'worker', 'media', 'storage', 'notifications', 'pwa'];
  const CRITICAL = new Set(S.CRITICAL);

  function renderPlatform(state) {
    const grid = $('annunciator');
    if (!grid.children.length) {
      grid.innerHTML = ANN_ORDER.map((key) => '<div class="ann" role="listitem" data-key="' + key + '" data-critical="' + CRITICAL.has(key) + '" data-tone="checking">'
        + '<p class="ann-name">' + esc(V.names[key]) + '</p><div><p class="ann-state"></p><p class="ann-reason"></p></div></div>').join('');
    }
    for (const el of grid.children) {
      const key = el.dataset.key;
      const view = state ? V.checkView(state, key) : { status: 'checking', text: '' };
      const tone = view.status === 'not_configured' ? 'neutral' : view.status;
      el.dataset.tone = tone;
      el.querySelector('.ann-state').innerHTML = state ? icon(tone) + '<span>' + STATUS_WORD[view.status] + '</span>' : '<span>Comprobando</span>';
      const unreachable = key === 'web' && view.status === 'failed' && !state.contractValid;
      el.querySelector('.ann-reason').textContent = state ? (unreachable ? 'Este navegador no pudo leer la API de estado.' : (view.text || CHECK_DESC[key])) : '';
      el.setAttribute('aria-label', V.names[key] + (CRITICAL.has(key) ? ' (crítico)' : '') + ': ' + (state ? STATUS_WORD[view.status] + '. ' + (view.text || '') : 'comprobando'));
    }
    $('platformSummary').textContent = state ? V.platformView(state).text : 'Comprobando';
  }

  function renderHistory() {
    const svg = $('historyStrip'), w = 240 / HISTORY;
    const offset = HISTORY - history.length;
    svg.innerHTML = Array.from({ length: HISTORY }, (_, i) => {
      const h = history[i - offset];
      return '<rect x="' + (i * w + 0.6).toFixed(2) + '" y="0" width="' + (w - 1.2).toFixed(2) + '" height="14" data-i="' + (h ? i - offset : '') + '" data-tone="' + (h ? h.overall : 'empty') + '"/>';
    }).join('');
  }
  $('historyStrip').addEventListener('pointermove', (e) => {
    const i = e.target.dataset && e.target.dataset.i;
    if (i === undefined || i === '') return hideTip();
    const h = history[Number(i)];
    showTip(e, '<b>' + VERDICT_WORD[h.overall] + '</b><br><span>' + fmtTime(h.at) + (h.latency != null ? ' · ' + h.latency + ' ms' : '') + '</span>');
  });
  $('historyStrip').addEventListener('pointerleave', hideTip);

  // ── Veredicto y lecturas ──────────────────────────────────────────────────
  function message(state, items) {
    if (!state) return 'Consultando los puntos críticos de OCRE OS.';
    const outside = items.filter((i) => i.domain !== 'Plataforma');
    const count = (n) => '<strong>' + n + (n === 1 ? ' aviso' : ' avisos') + '</strong>';
    if (state.overall === 'healthy') {
      if (!items.length) return 'Todos los puntos responden. Nada pendiente.';
      const where = [...new Set(outside.map((i) => i.domain.toLowerCase()))].join(' y ');
      return 'La plataforma responde. ' + count(items.length) + (where ? ' en ' + esc(where) : '') + '.';
    }
    const base = {
      degraded: 'OCRE OS responde, pero un servicio secundario requiere atención.',
      failed: 'Hay una interrupción crítica que puede impedir el acceso a OCRE OS.',
      stale: 'La última muestra es antigua: no se confirma el estado actual.',
      unknown: 'No hay evidencia suficiente para confirmar el estado del entorno.',
    }[state.overall];
    return base + (items.length ? ' ' + count(items.length) + ' en total.' : '');
  }

  function renderSpark() {
    const box = $('latencyChart');
    const pts = history.map((h, i) => ({ i, v: h.latency, at: h.at })).filter((p) => p.v != null);
    if (pts.length < 2) { box.innerHTML = ''; return; }
    const max = Math.max(...pts.map((p) => p.v)) * 1.15 || 1, W = 100, H = 30, n = Math.max(history.length - 1, 1);
    const off = 0;
    const x = (i) => ((i + off) / n) * W, y = (v) => H - (v / max) * (H - 3) - 1.5;
    const line = pts.map((p, k) => (k ? 'L' : 'M') + x(p.i).toFixed(2) + ' ' + y(p.v).toFixed(2)).join(' ');
    const first = pts[0], last = pts[pts.length - 1];
    const area = line + ' L' + x(last.i).toFixed(2) + ' ' + H + ' L' + x(first.i).toFixed(2) + ' ' + H + ' Z';
    box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none"><line class="guide" x1="0" x2="' + W + '" y1="' + H + '" y2="' + H + '"/>'
      + '<path class="area" d="' + area + '"/><path class="line" d="' + line + '"/>'
      + '<line class="cross" x1="0" x2="0" y1="0" y2="' + H + '" visibility="hidden"/></svg>';
    box._pts = pts; box._x = x; box._w = W;
  }
  $('latencyChart').addEventListener('pointermove', (e) => {
    const box = e.currentTarget, pts = box._pts;
    if (!pts) return;
    const r = box.getBoundingClientRect(), xv = ((e.clientX - r.left) / r.width) * box._w;
    let best = pts[0];
    for (const p of pts) if (Math.abs(box._x(p.i) - xv) < Math.abs(box._x(best.i) - xv)) best = p;
    const cross = box.querySelector('.cross');
    cross.setAttribute('x1', box._x(best.i)); cross.setAttribute('x2', box._x(best.i)); cross.setAttribute('visibility', 'visible');
    showTip(e, '<b>' + best.v + ' ms</b><br><span>' + fmtTime(best.at) + '</span>');
  });
  $('latencyChart').addEventListener('pointerleave', (e) => { e.currentTarget.querySelector('.cross')?.setAttribute('visibility', 'hidden'); hideTip(); });

  function renderVerdict(state, items) {
    const tone = state ? state.overall : 'checking';
    document.body.dataset.overall = tone;
    $('mainLamp').dataset.tone = tone;
    $('environmentName').textContent = ENV_NAME[selected];
    $('envNote').textContent = ENV_NOTE[selected];
    $('verdictTitle').textContent = state ? VERDICT_WORD[state.overall] : 'Comprobando';
    $('verdictMessage').innerHTML = message(state, items);
    document.title = (state ? VERDICT_WORD[state.overall] + ' · ' : '') + 'OCRE OS · Estado';
    $('latency').textContent = state && state.latencyMs != null ? state.latencyMs : '—';
    $('version').textContent = state?.deployment?.version || '—';
    $('commit').textContent = state?.deployment?.commit ? 'commit ' + String(state.deployment.commit).slice(0, 7) : 'commit no informado';
    renderSpark();
  }

  // ── Agentes ───────────────────────────────────────────────────────────────
  const EXEC = {
    working: ['Trabajando', 'healthy'], available: ['Disponible', 'healthy'], waiting: ['En espera', 'neutral'], unknown: ['Sin señal', 'unknown'],
  };
  function fact(label, value, title) {
    return '<div' + (title ? ' title="' + esc(title) + '"' : '') + '><dt>' + label + '</dt><dd' + (value == null ? ' class="fact-muted">Sin señal' : '>' + value) + '</dd></div>';
  }
  function arc(fraction, r = 46) {
    // Arco de 270° que abre hacia abajo, en un lienzo de 120×120.
    const start = 135, sweep = 270 * Math.max(0, Math.min(1, fraction));
    const p = (deg) => [60 + r * Math.cos((deg * Math.PI) / 180), 60 + r * Math.sin((deg * Math.PI) / 180)];
    const [sx, sy] = p(start), [ex, ey] = p(start + sweep);
    if (sweep <= 0) return '';
    return 'M' + sx.toFixed(2) + ' ' + sy.toFixed(2) + ' A' + r + ' ' + r + ' 0 ' + (sweep > 180 ? 1 : 0) + ' 1 ' + ex.toFixed(2) + ' ' + ey.toFixed(2);
  }
  function agentsFresh(now = Date.now()) {
    const st = data.agents;
    const ok = st && Number.isFinite(Date.parse(st.observedAt)) && now - Date.parse(st.observedAt) <= FRESH_MS;
    return ok ? st : A.normalize();
  }
  function devenvCurrent(now = Date.now()) {
    return data.devenv && C.currentTelemetry(data.devenv, now) ? data.devenv : null;
  }
  function renderAgents(now = Date.now()) {
    const agents = agentsFresh(now), stale = A.isMonitorStale(agents, data.agentsChecked);
    const devenv = devenvCurrent(now);
    for (const name of ['claude', 'codex']) {
      const card = $('agent-' + name);
      const exec = agents.states[name] || 'unknown';
      const reason = agents.reasons[name];
      let [execLabel, execTone] = EXEC[exec] || EXEC.unknown;
      if (reason === 'waiting_approval') { execLabel = 'Espera tu aprobación'; execTone = 'degraded'; }
      if (reason === 'waiting_input') { execLabel = 'Espera tu respuesta'; execTone = 'degraded'; }
      const agent = devenv?.agents?.[name];
      const q = C.quota(agent?.quota);
      const pct = q.percent;
      const weekly = agent?.quota?.weekly;
      const weeklyOk = weekly && Number.isInteger(weekly.remainingPercent) && Date.parse(weekly.resetsAt) > now;
      const occ = C.occupancy(agent);
      const slots = occ.valid ? Array.from({ length: Math.min(agent.capacity, 8) }, (_, i) => '<i class="' + (i < agent.slotsUsed ? 'on' : '') + '"></i>').join('') : '';
      const resetAt = Date.parse(agent?.quota?.resetsAt);
      const reset = Number.isFinite(resetAt) && resetAt > now ? new Intl.DateTimeFormat('es-MX', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(resetAt)) : '—';
      const reading = agent?.quota?.observedAt ? C.readingLabel(agent.quota.observedAt, now) : null;
      const gaugeTone = pct === null ? 'unknown' : q.tone;
      card.innerHTML =
        '<div class="agent-head"><h3 class="agent-name">' + D.NAMES[name] + '</h3><span class="chip" data-tone="' + execTone + '">' + icon(execTone) + esc(execLabel) + '</span></div>'
        + '<div class="gauge" data-tone="' + gaugeTone + '" role="img" aria-label="Cuota restante de ' + D.NAMES[name] + ': ' + (pct === null ? 'sin medición' : pct + ' por ciento') + '">'
        + '<svg viewBox="0 0 120 120"><path class="track" d="' + arc(1) + '"/>' + (pct ? '<path class="value" d="' + arc(pct / 100) + '"/>' : '')
        + (weeklyOk ? '<path class="weekly-track" d="' + arc(1, 34) + '"/>' + (weekly.remainingPercent ? '<path class="weekly" d="' + arc(weekly.remainingPercent / 100, 34) + '"/>' : '') : '') + '</svg>'
        + '<div class="gauge-center"><strong>' + (pct === null ? '—' : pct + '<small>%</small>') + '</strong><span>' + (pct === null ? 'sin medición' : 'cuota') + '</span></div></div>'
        + '<dl class="agent-facts">'
        + fact('Ocupación', occ.valid ? occ.text + '<span class="slots" aria-hidden="true">' + slots + '</span>' : null)
        + fact('Turno', agent ? esc(C.turnLabel(agent.turnSeconds ?? 0)) : null)
        + fact('Reinicio', pct === null ? null : esc(reset), pct === null ? '' : C.resetLabel(agent?.quota?.resetsAt, now))
        + (weeklyOk ? fact('Semanal', weekly.remainingPercent + '%', 'Anillo interior. ' + C.resetLabel(weekly.resetsAt, now)) : '')
        + fact('Lectura', reading ? esc(reading) : (name === 'claude' ? 'interactiva' : null), name === 'claude' ? 'La cuota de Claude solo se actualiza durante sesiones interactivas de Claude Code.' : 'Consulta al servidor de app de Codex cada 5 min.')
        + '</dl>';
      card.title = name === 'claude'
        ? 'La cuota de Claude se lee de la statusLine de Claude Code y solo se actualiza en sesiones interactivas.'
        : 'La cuota de Codex se consulta al servidor de app de Codex cada 5 minutos.';
    }
    $('agentsMeta').textContent = agents.observedAt ? 'Observado ' + fmtTime(agents.observedAt) + ' · ocupación, cuota y turno' : stale ? 'El monitor de agentes dejó de publicar' : 'Sin muestra reciente';
  }

  // ── Desarrollo ────────────────────────────────────────────────────────────
  const XP_LABEL = { ok: 'Al día', late: 'Atención tardía', reconcile: 'Requiere reconciliar', disabled: 'No habilitado', unknown: 'Sin señal' };
  const XP_TEXT = { ok: 'Sin entregas vencidas.', late: 'Hay una entrega pendiente de más de 15 minutos.', reconcile: 'Hay entregas con lease vencido o bloqueadas.', disabled: 'Xpress está apagado en este entorno.', unknown: 'staging.ocre.mx no entregó una muestra reciente.' };
  function statusTag(tone, label) { return '<span class="chip" data-tone="' + toneOf(tone) + '">' + icon(tone) + esc(label) + '</span>'; }
  function renderDev(now = Date.now()) {
    const devenv = devenvCurrent(now);
    const sha = data.status?.deployment?.commit;
    const val = D.validationView(devenv, sha, now);
    $('validation').innerHTML = '<h3>Validación</h3>' + statusTag(val.tone, val.label) + '<p>' + esc(val.text) + '</p>';

    const sup = D.supervisorView(devenv, now), s = devenv?.supervisor;
    const fresh = s && now - Date.parse(s.at) <= 15 * 60 * 1000;
    let body = '<h3>Cola autónoma</h3>' + statusTag(sup.tone, sup.tone === 'healthy' ? (s.mode === 'observe' ? 'Solo observa' : 'Ejecutando') : sup.label);
    if (fresh && !s.stopped) {
      const max = Math.max(s.valid, s.rejected, s.launched, 1);
      body += '<div class="phases" aria-label="Fase ' + s.phase + ' de F0 a F3">' + ['F0', 'F1', 'F2', 'F3'].map((p) => '<span class="phase"' + (p === s.phase ? ' aria-current="step"' : '') + '>' + p + '</span>').join('') + '<span class="phase-mode">' + esc(D.ago(s.at, now)) + '</span></div>'
        + '<dl class="bars" data-max="' + max + '">'
        + [['Válidas', s.valid], ['Rechazadas', s.rejected], ['Lanzadas', s.launched]].map(([l, v]) => '<dt>' + l + '</dt><dd><i data-v="' + v + '"></i></dd><span class="val">' + v + '</span>').join('')
        + '</dl>';
    } else body += '<p>' + esc(sup.text) + '</p>';
    $('supervisor').innerHTML = body;
    $('supervisor').querySelectorAll('.bars i').forEach((i) => { i.style.width = (Number(i.dataset.v) / Number(i.closest('.bars').dataset.max)) * 100 + '%'; });

    const xp = data.xpress && Number.isFinite(Date.parse(data.xpress.observedAt)) && now - Date.parse(data.xpress.observedAt) <= FRESH_MS ? data.xpress : X.normalize();
    const c = xp.counts;
    $('xpress').innerHTML = '<h3>Bandeja Xpress</h3>' + statusTag(xp.state, XP_LABEL[xp.state])
      + (['ok', 'late', 'reconcile'].includes(xp.state)
        ? '<div class="counts"><span>Pendientes <b>' + c.pending + '</b></span><span>Reclamadas <b>' + c.claimed + '</b></span><span>Vencidas <b>' + c.lease_expired + '</b></span><span>Bloqueadas <b>' + c.blocked + '</b></span><span>Confirmadas 24 h <b>' + c.acked_24h + '</b></span></div>'
        : '<p>' + esc(XP_TEXT[xp.state]) + '</p>');
  }

  // ── Avisos ────────────────────────────────────────────────────────────────
  function attentionItems(now = Date.now()) {
    const devenv = devenvCurrent(now);
    const agents = agentsFresh(now);
    const sha = data.status?.deployment?.commit;
    const xp = data.xpress && now - Date.parse(data.xpress.observedAt) <= FRESH_MS ? data.xpress : X.normalize();
    const missing = ['claude', 'codex'].filter((n) => agents.states[n] === 'unknown').map((n) => D.NAMES[n]);
    return V.attention(data.status, agents, xp, {
      agentsChecked: data.agentsChecked, monitorStale: A.isMonitorStale(agents, data.agentsChecked),
      xpressChecked: data.xpressChecked, devenvIssues: D.issues(devenv), validationIssues: D.validationIssues(devenv, sha, now),
    }).reduce((acc, i) => {
      // Sin contrato válido, cada punto queda «sin señal»: se agrupan en un solo aviso en vez de repetir ocho.
      if (i.domain === 'Plataforma' && i.tone === 'unknown') {
        const g = acc.find((x) => x.group);
        if (g) { g.names.push(i.name); g.name = g.names.length + ' puntos sin señal'; g.text = g.names.join(', ') + '.'; return acc; }
        acc.push({ ...i, group: true, names: [i.name], text: 'Sin evidencia suficiente.' }); return acc;
      }
      acc.push(i); return acc;
    }, []).map((i) => (i.domain === 'Plataforma' && i.tone === 'failed' && !data.status?.contractValid && i.name === V.names.web
      ? { ...i, text: 'Este navegador no pudo leer la API de estado del entorno.' } : i)).map((i) => i.name === 'Agentes' && i.tone === 'unknown' && missing.length
      ? { ...i, name: missing.join(' y ') + ' sin señal', text: (missing.length === 1 ? 'No reporta' : 'No reportan') + ' su estado de ejecución al monitor de agentes.' } : i);
  }
  function renderAlerts(items) {
    const list = $('alertsList');
    $('alertsCount').textContent = items.length; $('alertsCount').dataset.count = items.length;
    list.innerHTML = !data.status ? '<li class="alerts-empty" data-tone="unknown">Comprobando…</li>'
      : items.length ? items.map((i) => '<li data-tone="' + toneOf(i.tone) + '">' + icon(i.tone) + '<p class="alert-title">' + esc(i.name) + (i.name !== i.domain ? '<small>' + esc(i.domain) + '</small>' : '') + '</p><p class="alert-text">' + esc(i.text) + '</p></li>').join('')
        : '<li class="alerts-empty" data-tone="healthy">' + icon('healthy') + 'Nada pendiente.</li>';
  }

  // ── Actividad ─────────────────────────────────────────────────────────────
  function renderActivity(now = Date.now()) {
    const devenv = devenvCurrent(now);
    const events = devenv ? devenv.events : [];
    const list = $('activityList'), tl = $('timeline');
    $('activityMeta').textContent = events.length ? events.length + ' eventos · staging y monitor' : 'Despliegues de staging y cambios del monitor';
    if (!events.length) { tl.innerHTML = ''; list.innerHTML = '<li class="empty">Sin eventos recientes.</li>'; return; }
    const oldest = Math.min(...events.map((e) => Date.parse(e.at)));
    const spanH = Math.max(48, Math.ceil((now - oldest) / 3600000 / 12) * 12 + 12);
    const W = 1000, start = now - spanH * 3600000, x = (t) => ((t - start) / (spanH * 3600000)) * W;
    const ticks = Array.from({ length: 5 }, (_, i) => i / 4);
    tl.innerHTML = '<svg viewBox="0 0 ' + W + ' 38" preserveAspectRatio="none">'
      + '<line class="axis" x1="0" x2="' + W + '" y1="14" y2="14"/>'
      + ticks.map((f) => '<line class="tick" x1="' + f * W + '" x2="' + f * W + '" y1="8" y2="20"/>').join('')
      + '</svg>'
      + ticks.map((f) => { const h = Math.round(spanH * (1 - f)); return '<span class="tl-label" data-f="' + f + '">' + (h ? '−' + h + ' h' : 'ahora') + '</span>'; }).join('')
      + events.map((e, i) => { const v = D.eventView(e, now); return '<button type="button" class="tl-ev" data-i="' + i + '" data-tone="' + v.tone + '" data-x="' + (x(Date.parse(e.at)) / W) + '" aria-label="' + esc(v.label + ', ' + v.when) + '"></button>'; }).join('');
    tl.querySelectorAll('[data-f]').forEach((el) => { el.style.left = Number(el.dataset.f) * 100 + '%'; });
    tl.querySelectorAll('[data-x]').forEach((el) => { el.style.left = Number(el.dataset.x) * 100 + '%'; });
    tl._events = events;
    list.innerHTML = events.map((e) => { const v = D.eventView(e, now); return '<li><i class="lamp" data-tone="' + v.tone + '"></i><span>' + esc(v.label) + '</span><time datetime="' + esc(e.at) + '" title="' + esc(fmtDay(e.at)) + '">' + esc(v.when) + '</time></li>'; }).join('');
  }
  $('timeline').addEventListener('pointerover', (e) => {
    const b = e.target.closest('.tl-ev'); if (!b) return;
    const ev = $('timeline')._events[Number(b.dataset.i)], v = D.eventView(ev);
    showTip(e, '<b>' + esc(v.label) + '</b><br><span>' + esc(fmtDay(ev.at)) + ' · ' + esc(v.when) + '</span>');
  });
  $('timeline').addEventListener('pointerout', (e) => { if (e.target.closest('.tl-ev')) hideTip(); });

  // ── Indicador en vivo y reloj ─────────────────────────────────────────────
  function renderLive(now = Date.now()) {
    const st = data.raw ? S.applyStaleness(data.raw, now) : null;
    const badge = checking && !st ? 'checking' : S.freshnessBadge(st, now);
    const live = $('live');
    live.dataset.state = badge;
    $('liveLabel').textContent = { current: 'En vivo', stale: 'Obsoleto', unknown: 'Sin señal', checking: 'Comprobando' }[badge];
    $('liveDetail').textContent = badge === 'current' ? 'lectura cada 10 s' : badge === 'stale' ? 'sin muestra vigente' : badge === 'checking' ? 'primera lectura' : 'el servicio no responde';
    const progress = lastPollAt ? Math.min(1, (now - lastPollAt) / POLL_MS) : 0;
    $('liveProgress').style.strokeDashoffset = String(50.27 * (1 - progress));
    $('clock').textContent = new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(now));
    if (st && st.observedAt) {
      $('sampleAge').textContent = fmtTime(st.observedAt);
      $('sampleDetail').textContent = (badge === 'current' ? 'actual · ' : badge === 'stale' ? 'obsoleta · ' : '') + 'recibida ' + agoShort(now - (st.receivedAt || now));
    } else {
      $('sampleAge').textContent = '—';
      $('sampleDetail').textContent = st ? 'el servicio no entregó una muestra válida' : 'sin muestra';
    }
  }

  // ── Render completo ───────────────────────────────────────────────────────
  function renderAll(now = Date.now()) {
    data.status = data.raw ? S.applyStaleness(data.raw, now) : null;
    const items = data.status ? attentionItems(now) : [];
    renderVerdict(data.status, items);
    renderPlatform(data.status);
    renderHistory();
    renderAgents(now);
    renderDev(now);
    renderAlerts(items);
    renderActivity(now);
    renderLive(now);
    window.OcreMatrix?.setTelemetry(targets[selected].label, data.status);
  }

  // ── Sondeo ────────────────────────────────────────────────────────────────
  async function poll() {
    checking = true; $('refreshButton').classList.add('loading');
    const env = selected;
    const [status, agents, devenv, xpress] = await Promise.all([
      statusMonitor.check(targets[env].url), agentMonitor.check(URLS.agents), devenvMonitor.check(URLS.devenv), xpressMonitor.check(URLS.xpress),
    ]);
    checking = false; $('refreshButton').classList.remove('loading');
    if (env !== selected || status.cycleId !== statusMonitor.latestCycle) return;
    lastPollAt = Date.now();
    data.raw = status;
    data.agents = agents; data.agentsChecked = true;
    data.devenv = devenv; data.devenvChecked = true;
    data.xpress = xpress; data.xpressChecked = true;
    const shown = S.applyStaleness(status);
    history.push({ at: new Date().toISOString(), overall: shown.overall, latency: status.latencyMs ?? null });
    if (history.length > HISTORY) history = history.slice(-HISTORY);
    renderAll();
  }
  function schedule() { clearInterval(pollTimer); pollTimer = setInterval(poll, POLL_MS); }

  function selectEnv(env) {
    if (!targets[env] || env === selected) return;
    selected = env; data.raw = null; data.status = null; history = []; lastPollAt = 0;
    document.querySelectorAll('.env').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.env === env)));
    window.OcreMatrix?.setTelemetry(targets[env].label, null);
    renderAll(); poll(); schedule();
  }
  document.querySelectorAll('.env').forEach((b) => b.addEventListener('click', () => selectEnv(b.dataset.env)));
  $('refreshButton').addEventListener('click', () => { poll(); schedule(); });
  $('matrixToggle').addEventListener('click', () => window.OcreMatrix?.enter(targets[selected].label, data.status));
  $('matrixExit').addEventListener('click', () => window.OcreMatrix?.exit());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.OcreMatrix?.exit(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { poll(); schedule(); } });

  // Cada segundo: frescura, edades y transiciones por tiempo (sin esperar otra respuesta HTTP).
  let lastStale = null;
  const ticker = setInterval(() => {
    const now = Date.now();
    renderLive(now);
    const st = data.raw ? S.applyStaleness(data.raw, now) : null;
    const key = (st?.overall || '') + '|' + Math.floor(now / 5000);
    if (!checking && key !== lastStale) { lastStale = key; renderAll(now); }
  }, 1000);

  renderAll(); poll(); schedule();
  window.addEventListener('beforeunload', () => { clearInterval(pollTimer); clearInterval(ticker); });
})();
