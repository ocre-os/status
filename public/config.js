// Configuración propia de status.ocre.mx: CORE, agentes y devenv se leen del relay de este mismo
// servidor, que la X280 alimenta desde su Core local. Xpress sigue leyéndose de staging.
window.OCRE_STATUS_TARGETS = {
  core: { label: 'CORE', url: '/api/status' },
  staging: { label: 'STAGING', url: 'https://staging.ocre.mx/api/status' },
};
window.OCRE_STATUS_ENDPOINTS = { agents: '/api/agents', devenv: '/api/devenv' };
