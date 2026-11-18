# OCRE OS Status

Monitor de estado de OCRE OS, independiente de la X280. Corre en el hosting de Node.js de GoDaddy
(plan Deluxe de ocre.mx) y se despliega desde este repo (`main`).

## Cómo funciona

```text
X280 (Core) ──heartbeat cada 10 s──▶ status.ocre.mx /api/heartbeat  (token Bearer)
                                              │
navegador ◀── página os-status ◀── /api/status (último ocre-status-v1, con obsolescencia)
```

- La X280 manda el estado que Core ya publica (contrato `ocre-status-v1`). El relay no inventa estados.
- Si deja de llegar, el relay marca cada check como `stale` (`heartbeat_stale` a los 30 s,
  `heartbeat_expired` a los 5 min). Las fallas explícitas y `not_configured` se conservan.
- Si nunca ha llegado nada (p. ej. justo después de reiniciar), todo es `unknown` con `no_heartbeat`.
- Si la X280 está viva pero Core no responde, el script manda `api: failed` y lo demás `unknown`.

## Endpoints

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/status` | Último estado + bloque `relay` (frescura según el reloj del servidor). Público, CORS abierto. |
| POST | `/api/heartbeat` | Solo con `Authorization: Bearer $HEARTBEAT_TOKEN`. Máx. 64 KB. |
| GET | `/healthz` | Comprobación de vida del servicio. |
| GET | `/` | Página de estado (copia de `ocre-os/apps/os-status`, con `config.js`). |

## Despliegue y operación (sin panel)

Todo pasa por la Hosting API de GoDaddy (`https://api.godaddy.com/v1/hosting`) desde GitHub Actions,
con `scripts/godaddy.sh`. Nadie despliega desde la X280 ni desde el panel web.

| Workflow | Cuándo | Qué hace |
|---|---|---|
| `deploy.yml` | push a `main` (o manual) | pruebas → copia secretos a preview y publish → sube zip → publica → verifica PUBLISH `ACTIVE/running` → smoke test |
| `ops.yml` | `gh workflow run ops.yml -f op=<op>` | `status`, `app`, `deployments`, `logs`, `secrets`, `restart`, `list-apps`, `subscriptions`, `bootstrap`, `delete-app` |
| `test.yml` | pull requests | pruebas |

Configuración del repo (entorno `production`):

| Tipo | Nombre | Valor |
|---|---|---|
| Secreto | `GDDY_PAT` | PAT de GoDaddy con los scopes `hosting.*` (abajo) |
| Secreto | `HEARTBEAT_TOKEN` | cadena aleatoria larga; el deploy la copia a GoDaddy |
| Variable | `GODADDY_APP_ID` | ID que imprime `ops.yml -f op=bootstrap` |
| Variable | `PUBLIC_URL` | opcional, p. ej. `https://status.ocre.mx` para el smoke test |

Scopes del PAT: `hosting.application:read/create/update/delete`, `hosting.deployment:execute`,
`hosting.source:read/write`, `hosting.secret:read/write`, `hosting.log:read`, `hosting.domain:read/write`,
`hosting.subscription:read/write`.

`delete-app` exige repetir el App ID en `confirm`. `PORT` lo asigna la plataforma.

## En la X280

```bash
CORE_STATUS_URL=http://127.0.0.1:<puerto-core>/api/status \
RELAY_URL=https://status.ocre.mx/api/heartbeat \
HEARTBEAT_TOKEN=<mismo valor que en GoDaddy> \
node scripts/heartbeat.js
```

Debe correr como servicio (systemd/pm2) para que arranque con la X280.

## Desarrollo

```bash
npm test                         # relay, HTTP y la UI leyendo del relay
HEARTBEAT_TOKEN=dev npm start    # http://localhost:3000
```

## Límites conocidos

- El último heartbeat vive en memoria: tras un reinicio se ve `no_heartbeat` hasta el siguiente envío (≤ 10 s).
- En esta página el check `web` de la UI indica que **este** servidor responde, no que `os.ocre.mx` sea
  accesible desde Internet.
- `public/` es una copia de `ocre-os/apps/os-status` (commit `33c55ce`) más `config.js` y un override
  de destinos en `app.js`. Los cambios de UI deben llevarse a ambos lados hasta consolidar una sola fuente.

## Repo público

Este repo es público para que GitHub Actions corra sin costo. Los secretos viven solo en GitHub y
GoDaddy; `godaddy.sh` enmascara IDs de suscripción y no imprime valores de secretos. Solo quien tiene
escritura en `ocre-os/status` puede lanzar `ops.yml`.
