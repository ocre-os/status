#!/usr/bin/env bash
# Cliente mínimo de la Hosting API de GoDaddy (https://api.godaddy.com/v1/hosting) para GitHub Actions.
# Requiere: curl, jq, zip/git. Autenticación: GDDY_PAT (Personal Access Token). Nunca imprime secretos.
set -euo pipefail

API="${GODADDY_API:-https://api.godaddy.com/v1/hosting}"
: "${GDDY_PAT:?Falta GDDY_PAT (secreto de GitHub Actions)}"

# Configuración versionada (no secreta); una variable de entorno explícita tiene prioridad.
CONFIG_FILE="$(dirname "$0")/../config/godaddy.env"
if [[ -f $CONFIG_FILE ]]; then
  _cfg_app=$(sed -n 's/^GODADDY_APP_ID=//p' "$CONFIG_FILE")
  GODADDY_APP_ID=${GODADDY_APP_ID:-$_cfg_app}
fi

log() { echo "::notice::$*"; }
die() { echo "::error::$*"; exit 1; }

# api METHOD PATH [curl args...] -> cuerpo JSON en stdout; falla con el código y cuerpo de error.
api() {
  local method=$1 path=$2; shift 2
  local out code
  out=$(mktemp)
  code=$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$API$path" \
    -H "Authorization: Bearer $GDDY_PAT" -H 'Accept: application/json' "$@")
  if [[ $code != 2* ]]; then
    echo "::error::$method $path -> HTTP $code" >&2
    jq -c '{code, message, fields}' "$out" 2>/dev/null >&2 || head -c 600 "$out" >&2
    rm -f "$out"; return 1
  fi
  cat "$out"; rm -f "$out"
}

idem() { echo "Idempotency-Key: $(cat /proc/sys/kernel/random/uuid)"; }

# poll PATH -> espera status COMPLETED (o ACTIVE); FAILED o 10 min sin terminar = error.
poll() {
  local path=$1 status body i
  for i in $(seq 1 120); do
    body=$(api GET "$path")
    status=$(jq -r '.status // empty' <<<"$body")
    case $status in
      COMPLETED|ACTIVE) echo "$body"; return 0 ;;
      FAILED) jq -c '{status, logs}' <<<"$body" >&2; die "$path terminó en FAILED" ;;
    esac
    sleep ${POLL_SLEEP:-5}
  done
  die "$path no terminó en 10 minutos (último estado: $status)"
}

need_app() { : "${GODADDY_APP_ID:?Falta la variable de repo GODADDY_APP_ID}"; }

cmd_list_apps()      { api GET '/apps' | jq '.items[] | {id, name, status, region, updatedAt}'; }
# El repo es público: los IDs de suscripción se enmascaran y solo se muestran campos operativos.
cmd_subscriptions() {
  local body
  body=$(api GET '/subscriptions?hostingProduct=WEB_HOSTING')
  jq -r '.items[].subscriptionId' <<<"$body" | while read -r id; do echo "::add-mask::$id"; done
  jq '.items[] | {label, tier, status, attachedCount, slotLimit, availableSlots}' <<<"$body"
}
cmd_status()         { need_app; api GET "/apps/$GODADDY_APP_ID/status" | jq '{status, variants}'; }
cmd_app()            { need_app; api GET "/apps/$GODADDY_APP_ID" | jq; }
cmd_deployments()    { need_app; api GET "/apps/$GODADDY_APP_ID/deployments?pageSize=10" | jq '.items'; }
cmd_secrets()        { need_app; api GET "/apps/$GODADDY_APP_ID/secrets?variant=${VARIANT:-PUBLISH}" | jq '[.items[]? | {name, updatedAt}]'; }
cmd_logs() {
  need_app
  api GET "/apps/$GODADDY_APP_ID/logs?variant=${VARIANT:-PUBLISH}&pageSize=${LINES:-200}" | jq -r '.items[]? | "\(.timestamp) \(.level) [\(.source)] \(.message)"'
}
cmd_restart() {
  need_app
  api POST "/apps/$GODADDY_APP_ID/restarts" -H "$(idem)" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg v "${VARIANT:-PUBLISH}" '{variant:$v}')" | jq
}

# Crea la app, espera a que quede ACTIVE y la adjunta al primer plan de web hosting con lugar libre.
cmd_bootstrap() {
  local name=${APP_NAME:?Falta APP_NAME} op app_id sub
  op=$(api POST '/apps?appType=NODEJS' -H "$(idem)" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg n "$name" '{name:$n}')" | jq -r '.operationId')
  app_id=$(poll "/app-operations/$op" | jq -r '.app.id // .appId // empty')
  [[ -n $app_id ]] || die "La operación terminó sin App ID"
  log "App creada: $name ($app_id)"
  sub=$(api GET '/subscriptions?hostingProduct=WEB_HOSTING' \
    | jq -r '[.items[] | select((.availableSlots // 0) > 0)][0].subscriptionId // empty')
  [[ -n $sub ]] || die "No hay planes de web hosting con lugares libres"
  echo "::add-mask::$sub"
  api PUT "/apps/$app_id/subscription" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg s "$sub" '{subscriptionId:$s}')" >/dev/null
  log "Adjuntada al plan de web hosting con lugar libre"
  echo "GODADDY_APP_ID=$app_id"
  [[ -n ${GITHUB_STEP_SUMMARY:-} ]] && echo "**GODADDY_APP_ID=\`$app_id\`**" >> "$GITHUB_STEP_SUMMARY"
}

cmd_delete_app() {
  local id=${TARGET_APP_ID:?Falta TARGET_APP_ID}
  [[ ${CONFIRM:-} == "$id" ]] || die "Para borrar, CONFIRM debe repetir exactamente el App ID"
  api DELETE "/apps/$id" >/dev/null
  log "App $id eliminada"
}

# Copia secretos de GitHub a ambas variantes (JSON Patch). Solo nombres en SYNC_SECRETS con valor definido.
cmd_sync_secrets() {
  need_app
  local ops='[]' name
  for name in ${SYNC_SECRETS:-HEARTBEAT_TOKEN}; do
    [[ -n ${!name:-} ]] || { log "Secreto $name vacío en GitHub: no se sincroniza"; continue; }
    ops=$(jq -c --arg n "$name" --arg v "${!name}" '. + [{op:"add", path:("/"+$n), value:$v}]' <<<"$ops")
  done
  [[ $ops == '[]' ]] && return 0
  for variant in PREVIEW PUBLISH; do
    api PATCH "/apps/$GODADDY_APP_ID/secrets?variant=$variant" -H "$(idem)" \
      -H 'Content-Type: application/json-patch+json' -d "$ops" >/dev/null
    log "Secretos sincronizados en $variant"
  done
}

# Sube el código de HEAD como zip a preview, publica y verifica que PUBLISH quede ACTIVE/running.
cmd_deploy() {
  need_app
  local zip import deployment status
  zip=$(mktemp -d)/app.zip
  git archive --format=zip -o "$zip" HEAD -- . ':(exclude).github' ':(exclude)test'
  import=$(api POST "/apps/$GODADDY_APP_ID/imports" -H "$(idem)" -F "file=@$zip;type=application/zip" | jq -r '.importId')
  poll "/apps/$GODADDY_APP_ID/imports/$import" >/dev/null
  log "Código subido a preview (import $import)"
  deployment=$(api POST "/apps/$GODADDY_APP_ID/deployments" -H "$(idem)" -H "Content-Length: 0" | jq -r '.deploymentId')
  poll "/apps/$GODADDY_APP_ID/deployments/$deployment" >/dev/null
  log "Publicado (deployment $deployment)"
  for _ in $(seq 1 24); do
    status=$(api GET "/apps/$GODADDY_APP_ID/status")
    if jq -e '.status == "ACTIVE" and any(.variants[]; .variant == "PUBLISH" and .status == "ACTIVE" and .lifecycleState == "running")' <<<"$status" >/dev/null; then
      log "PUBLISH activo y corriendo"; return 0
    fi
    sleep ${POLL_SLEEP:-5}
  done
  jq -c '{status, variants}' <<<"$status" >&2
  die "PUBLISH no quedó ACTIVE/running en 2 minutos"
}

# Comprueba la URL pública: /healthz y que /api/status responda con el contrato.
cmd_smoke() {
  need_app
  local url
  url=${PUBLIC_URL:-$(api GET "/apps/$GODADDY_APP_ID" | jq -r '.urls.publish // empty')}
  [[ -n $url ]] || die "La app no tiene URL de publish"
  url=${url%/}
  curl -fsS --retry 5 --retry-delay 5 --retry-all-errors "$url/healthz" >/dev/null
  curl -fsS "$url/api/status" | jq -e '.contract == "ocre-status-v1"' >/dev/null
  log "Smoke test OK en $url"
}

cmd=${1:?Uso: godaddy.sh <comando>}
shift || true
"cmd_${cmd//-/_}" "$@"
