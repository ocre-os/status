// Configuración propia de status.ocre.mx: CORE se lee del relay de este mismo servidor, que recibe
// el heartbeat de la X280 y marca la muestra como obsoleta cuando deja de llegar.
window.OCRE_STATUS_TARGETS = {
  core: { label: 'CORE', url: '/api/status' },
  staging: { label: 'STAGING', url: 'https://staging.ocre.mx/api/status' },
};
