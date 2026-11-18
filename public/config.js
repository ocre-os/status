// Configuración propia de status.ocre.mx: CORE, agentes y devenv se leen del relay de este mismo
// servidor, que la X280 alimenta desde su Core local. Staging y Xpress se leen a través del proxy de este
// servidor (/api/staging/*): Core solo autoriza el CORS de apps.ocre.mx y no se amplía.
window.OCRE_STATUS_TARGETS = {
  core: { label: 'CORE', url: '/api/status' },
  staging: { label: 'STAGING', url: '/api/staging/status' },
};
window.OCRE_STATUS_ENDPOINTS = { agents: '/api/agents', devenv: '/api/devenv', xpress: '/api/staging/xpress-status' };
