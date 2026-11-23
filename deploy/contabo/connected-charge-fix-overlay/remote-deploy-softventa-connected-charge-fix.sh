#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

die() { printf 'DETENIDO: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || die "Falta comando requerido: $1"; }
[[ $# -eq 5 ]] || die 'Uso interno inválido.'
MODE="$1"; PACKAGE="$2"; EXPECTED_PACKAGE_SHA="$3"; EXPECTED_HELPER_SHA="$4"; ROLLBACK_TOKEN="$5"
[[ "$MODE" == '--prepare-only' || "$MODE" == '--deploy' || "$MODE" == '--rollback' ]] || die 'Modo inválido.'
[[ "$PACKAGE" =~ ^/home/posadmin/\.pos-charge-fix-[a-f0-9]{16}/connected-charge-fix-overlay\.tar\.gz$ ]] || die 'La ruta del paquete remoto no está permitida.'
[[ "$EXPECTED_PACKAGE_SHA" =~ ^[a-f0-9]{64}$ && "$EXPECTED_HELPER_SHA" =~ ^[a-f0-9]{64}$ ]] || die 'SHA-256 inválido.'
if [[ "$MODE" == '--rollback' ]]; then
  [[ "$ROLLBACK_TOKEN" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]] || die 'Token de rollback inválido.'
else
  [[ -z "$ROLLBACK_TOKEN" ]] || die 'Rollback solo admite su propio token.'
fi
[[ "$(id -u)" == 0 ]] || die 'El helper debe ejecutarse con sudo.'
for cmd in docker python3 tar sha256sum awk grep sed find sort stat cut curl date install; do need "$cmd"; done
if LC_ALL=C grep -q $'\r' "$0"; then die 'El helper Bash tiene CRLF; se exige LF.'; fi
bash -n "$0" || die 'bash -n rechazó el helper remoto.'
[[ -f "$PACKAGE" && ! -L "$PACKAGE" && -f "$0" && ! -L "$0" ]] || die 'Faltan los archivos transferidos esperados.'
STAGE="$(dirname "$PACKAGE")"
[[ "$STAGE" =~ ^/home/posadmin/\.pos-charge-fix-[a-f0-9]{16}$ && "$(dirname "$0")" == "$STAGE" ]] || die 'Helper y paquete no pertenecen al mismo staging.'
[[ "$(stat -c '%U:%G:%a' "$PACKAGE")" == 'posadmin:posadmin:600' ]] || die 'Permisos del paquete remoto incorrectos.'
[[ "$(stat -c '%U:%G:%a' "$0")" == 'posadmin:posadmin:600' ]] || die 'Permisos del helper remoto incorrectos.'
hash_file() { sha256sum "$1" | awk '{print $1}'; }
[[ "$(hash_file "$PACKAGE")" == "$EXPECTED_PACKAGE_SHA" && "$(hash_file "$0")" == "$EXPECTED_HELPER_SHA" ]] || die 'No coincide el SHA-256 transferido.'

WORK="$(mktemp -d /tmp/pos-charge-fix.XXXXXX)"
VALIDATION_ID=''; MUTATION_STARTED=0; DEPLOY_OK=0
PRE_MUTATION_FRONT_ID=''; PRE_MUTATION_FRONT_REF=''
ORIGINAL_FRONT_ID=''; ORIGINAL_BACK_ID=''; ORIGINAL_MYSQL_ID=''; ORIGINAL_MYSQL_IMAGE_ID=''; ORIGINAL_MYSQL_MOUNTS=''
ORIGINAL_FRONT_REF=''; ORIGINAL_BACK_REF=''; COMPOSE=()
cleanup() {
  local rc=$?
  if [[ -n "$VALIDATION_ID" ]]; then
    local found
    found="$(docker inspect --format '{{.Id}}' "$VALIDATION_ID" 2>/dev/null || true)"
    if [[ "$found" == "$VALIDATION_ID" ]]; then docker rm --force "$VALIDATION_ID" >/dev/null 2>&1 || true; fi
  fi
  if [[ "$MUTATION_STARTED" == 1 && "$DEPLOY_OK" != 1 ]]; then
    note 'RECOVERY=START; restaurando solo frontend al estado inmediatamente anterior'
    if [[ -n "$PRE_MUTATION_FRONT_ID" && -n "$PRE_MUTATION_FRONT_REF" ]]; then
      docker tag "$PRE_MUTATION_FRONT_ID" "$PRE_MUTATION_FRONT_REF" >/dev/null 2>&1 &&
      dc up -d --no-deps --force-recreate frontend >/dev/null 2>&1 || true
      local now_front now_back now_mysql
      now_front="$(active_cid frontend 2>/dev/null || true)"; now_back="$(active_cid backend 2>/dev/null || true)"; now_mysql="$(active_cid mysql 2>/dev/null || true)"
      if [[ -n "$now_front" && -n "$now_back" && -n "$now_mysql" &&
        "$(docker inspect --format '{{.Image}}' "$now_front" 2>/dev/null || true)" == "$PRE_MUTATION_FRONT_ID" &&
        "$(docker inspect --format '{{.Image}}' "$now_back" 2>/dev/null || true)" == "$ORIGINAL_BACK_ID" &&
        "$(docker inspect --format '{{.Image}}' "$now_mysql" 2>/dev/null || true)" == "$ORIGINAL_MYSQL_IMAGE_ID" ]]; then
        note 'RECOVERY=PASS; frontend anterior restaurado; backend y MySQL no cambiaron'
      else
        note 'RECOVERY=FAIL; requiere revisión manual' >&2; rc=1
      fi
    else
      note 'RECOVERY=FAIL; falta la imagen frontend anterior' >&2; rc=1
    fi
  fi
  case "$WORK" in /tmp/pos-charge-fix.*) rm -rf -- "$WORK" ;; *) note 'TEMP_CLEANUP=SKIP; ruta temporal inesperada' ;; esac
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

mapfile -t ARCHIVE_FILES < <(tar -tzf "$PACKAGE" | LC_ALL=C sort)
EXPECTED_FILES=(Dockerfile.frontend MANIFEST.sha256 apply-connected-charge-fix.cjs)
[[ ${#ARCHIVE_FILES[@]} -eq ${#EXPECTED_FILES[@]} ]] || die 'El payload contiene archivos faltantes o adicionales.'
for i in "${!EXPECTED_FILES[@]}"; do [[ "${ARCHIVE_FILES[$i]}" == "${EXPECTED_FILES[$i]}" ]] || die 'El payload no coincide con el allowlist.'; done
tar -xzf "$PACKAGE" -C "$WORK" --no-same-owner --no-same-permissions || die 'No se pudo extraer el payload.'
(cd "$WORK" && sha256sum -c MANIFEST.sha256 >/dev/null) || die 'El manifiesto interno no coincide.'
for file in Dockerfile.frontend apply-connected-charge-fix.cjs MANIFEST.sha256; do [[ -s "$WORK/$file" && ! -L "$WORK/$file" ]] || die "Falta recurso allowlist: $file"; done
grep -Fq 'FROM ${FRONTEND_BASE}' "$WORK/Dockerfile.frontend" || die 'El Dockerfile no parte de la imagen frontend activa.'
grep -Fq 'COPY --from=patcher /tmp/site /usr/share/nginx/html' "$WORK/Dockerfile.frontend" || die 'El Dockerfile no conserva la raíz web base.'
grep -Fq 'node /tmp/apply-connected-charge-fix.cjs --apply /tmp/site' "$WORK/Dockerfile.frontend" || die 'El Dockerfile no ejecuta el overlay allowlist.'

APP=/opt/pos/app; ENV_FILE=/etc/pos/production.env; PROJECT=pos-production; STATE_DIR=/opt/pos/backups
[[ -d "$APP" && -r "$ENV_FILE" && -d "$STATE_DIR" ]] || die 'Falta el proyecto, env-file o directorio de respaldos esperado.'
[[ "$(stat -c '%U:%G:%a' "$ENV_FILE")" == 'root:root:600' ]] || die 'production.env no conserva propietario/permisos root:600.'
docker compose version >/dev/null 2>&1 || die 'Docker Compose no está disponible.'
docker network inspect --format '{{.Name}}' pos-production_edge 2>/dev/null | grep -Fxq pos-production_edge || die 'No existe la red Docker esperada.'

active_cid() {
  local service="$1"; local -a ids
  mapfile -t ids < <(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$service")
  [[ ${#ids[@]} -eq 1 ]] || die "Se esperaba un contenedor activo para $service; se encontraron ${#ids[@]}."
  [[ "$(docker inspect --format '{{.State.Running}}' "${ids[0]}")" == true ]] || die "$service no está ejecutándose."
  printf '%s\n' "${ids[0]}"
}
assert_healthy() {
  local service="$1" cid="$2" state health
  state="$(docker inspect --format '{{.State.Status}}' "$cid")"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid")"
  [[ "$state" == running && ( "$health" == healthy || "$health" == none ) ]] || die "$service no está saludable."
}
wait_healthy() {
  local service="$1" i cid state health; local -a ids
  for i in $(seq 1 60); do
    mapfile -t ids < <(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$service")
    if [[ ${#ids[@]} -eq 1 ]]; then
      cid="${ids[0]}"; state="$(docker inspect --format '{{.State.Status}}' "$cid")"; health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid")"
      if [[ "$state" == running && ( "$health" == healthy || "$health" == none ) ]]; then printf '%s\n' "$cid"; return 0; fi
    fi
    sleep 2
  done
  die "$service no llegó a healthy."
}

active_front_cid="$(active_cid frontend)"; active_back_cid="$(active_cid backend)"; active_mysql_cid="$(active_cid mysql)"
for pair in "frontend:$active_front_cid" "backend:$active_back_cid" "mysql:$active_mysql_cid"; do assert_healthy "${pair%%:*}" "${pair#*:}"; done
[[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$active_front_cid")" == "$APP" ]] || die 'Frontend activo fuera del proyecto esperado.'
CONFIG_RAW="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$active_front_cid")"
IFS=',' read -r -a CONFIG_FILES <<< "$CONFIG_RAW"
[[ ${#CONFIG_FILES[@]} -eq 2 || ${#CONFIG_FILES[@]} -eq 3 ]] || die 'No se reconoció la combinación de Compose activa.'
[[ "${CONFIG_FILES[0]}" == "$APP/compose.yaml" && "${CONFIG_FILES[1]}" == "$APP/compose.production.yaml" ]] || die 'Los Compose activos no coinciden con el proyecto esperado.'
for file in "${CONFIG_FILES[@]}"; do [[ -r "$file" ]] || die 'Falta un archivo Compose activo.'; done
ENV_FILES=("$ENV_FILE")
if [[ ${#CONFIG_FILES[@]} -eq 3 ]]; then
  [[ "${CONFIG_FILES[2]}" == '/home/posadmin/pos-private-test.override.yaml' && -r "${CONFIG_FILES[2]}" && -r /home/posadmin/pos-private-test.env ]] || die 'El override activo no es el override privado conocido.'
  ENV_FILES+=(/home/posadmin/pos-private-test.env)
fi
COMPOSE=(docker compose --project-name "$PROJECT" --project-directory "$APP")
for envfile in "${ENV_FILES[@]}"; do COMPOSE+=(--env-file "$envfile"); done
for file in "${CONFIG_FILES[@]}"; do COMPOSE+=(-f "$file"); done
dc() { "${COMPOSE[@]}" "$@"; }
dc --profile tools config --quiet >/dev/null 2>&1 || die 'Compose config --quiet falló.'
dc --profile tools config --format json >"$WORK/compose.json" 2>/dev/null || die 'No se pudo leer Compose efectivo sin imprimir variables.'
compose_fields() {
  python3 -c 'import json,sys;s=json.load(open(sys.argv[1],encoding="utf-8"))["services"]; e=lambda n,k: str((s[n].get("environment") or {}).get(k,"")) if isinstance(s[n].get("environment") or {},dict) else next((v.split("=",1)[1] for v in (s[n].get("environment") or []) if v.startswith(k+"=")),""); print("\n".join((e("backend","DB_NAME"),e("mysql","MYSQL_DATABASE"),s["backend"]["image"],s["frontend"]["image"],s["migrate"]["image"])))' "$1"
}
mapfile -t CFG < <(compose_fields "$WORK/compose.json")
[[ ${#CFG[@]} -eq 5 ]] || die 'No se pudieron fijar los cinco valores de Compose.'
DB_NAME="${CFG[0]}"; MYSQL_DB="${CFG[1]}"; ORIGINAL_BACK_REF="${CFG[2]}"; ORIGINAL_FRONT_REF="${CFG[3]}"; MIGRATE_REF="${CFG[4]}"
[[ "$DB_NAME" =~ ^pos_contabo_prod_[0-9]{8}$ && "$MYSQL_DB" == "$DB_NAME" ]] || die 'Compose no apunta a la base productiva esperada.'
[[ "$ORIGINAL_BACK_REF" == "$MIGRATE_REF" && "$ORIGINAL_FRONT_REF" != *@* && "$ORIGINAL_BACK_REF" != *@* ]] || die 'Compose no conserva las referencias backend/migrate esperadas.'
ORIGINAL_FRONT_ID="$(docker inspect --format '{{.Image}}' "$active_front_cid")"; ORIGINAL_BACK_ID="$(docker inspect --format '{{.Image}}' "$active_back_cid")"
ORIGINAL_MYSQL_ID="$active_mysql_cid"; ORIGINAL_MYSQL_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$active_mysql_cid")"
ORIGINAL_MYSQL_MOUNTS="$(docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}@{{.Destination}};{{end}}{{end}}' "$active_mysql_cid")"
[[ "$(docker image inspect --format '{{.Id}}' "$ORIGINAL_FRONT_REF")" == "$ORIGINAL_FRONT_ID" ]] || die 'La etiqueta frontend no apunta a la imagen activa.'
[[ "$(docker image inspect --format '{{.Id}}' "$ORIGINAL_BACK_REF")" == "$ORIGINAL_BACK_ID" ]] || die 'La etiqueta backend no apunta a la imagen activa.'
[[ "$ORIGINAL_MYSQL_MOUNTS" == *'pos-production_mysql_data@'* ]] || die 'No se identificó el volumen persistente MySQL esperado.'
note 'ACTIVE_FRONTEND=PASS; imagen activa fijada por ID'
note 'ACTIVE_BACKEND=PASS; se conservará sin construir ni recrear'
note 'MYSQL_IDENTITY=PASS; solo Docker metadata, sin consultas ni escrituras SQL'

PACKAGE_SHORT="${EXPECTED_PACKAGE_SHA:0:8}"
front_short="${ORIGINAL_FRONT_ID#sha256:}"; front_short="${front_short:0:12}"
back_short="${ORIGINAL_BACK_ID#sha256:}"; back_short="${back_short:0:12}"
BASE_FRONT_TAG="pos-frontend:charge-fix-base-${front_short}-${PACKAGE_SHORT}"
BASE_BACK_TAG="pos-backend:charge-fix-base-${back_short}-${PACKAGE_SHORT}"
CAND_FRONT_TAG="pos-frontend:charge-fix-candidate-${PACKAGE_SHORT}-${front_short}"
ensure_tag() {
  local image="$1" tag="$2" present
  present="$(docker image inspect --format '{{.Id}}' "$tag" 2>/dev/null || true)"
  if [[ -n "$present" ]]; then [[ "$present" == "$image" ]] || die "La etiqueta base apunta a otra imagen: $tag"; else docker image tag "$image" "$tag"; fi
}
candidate_valid() {
  local id package_label front_label back_label
  id="$(docker image inspect --format '{{.Id}}' "$CAND_FRONT_TAG" 2>/dev/null || true)"
  [[ -n "$id" ]] || return 1
  package_label="$(docker image inspect --format '{{index .Config.Labels "org.softventa.connected-charge-fix.package-sha256"}}' "$id")"
  front_label="$(docker image inspect --format '{{index .Config.Labels "org.softventa.connected-charge-fix.frontend-base-image-id"}}' "$id")"
  back_label="$(docker image inspect --format '{{index .Config.Labels "org.softventa.connected-charge-fix.backend-base-image-id"}}' "$id")"
  [[ "$package_label" == "$EXPECTED_PACKAGE_SHA" && "$front_label" == "$ORIGINAL_FRONT_ID" && "$back_label" == "$ORIGINAL_BACK_ID" ]]
}
STATE_FILE="$STATE_DIR/softventa-charge-fix-${EXPECTED_PACKAGE_SHA}.state"
write_state() {
  local candidate_id="$1" temporary="${STATE_FILE}.tmp.$$"
  (umask 077; printf '%s\n' "$EXPECTED_PACKAGE_SHA" "$ORIGINAL_FRONT_ID" "$ORIGINAL_BACK_ID" "$ORIGINAL_FRONT_REF" "$ORIGINAL_BACK_REF" "$ORIGINAL_MYSQL_ID" "$ORIGINAL_MYSQL_IMAGE_ID" "$ORIGINAL_MYSQL_MOUNTS" "$CAND_FRONT_TAG" "$candidate_id" >"$temporary")
  chown root:root "$temporary"; chmod 600 "$temporary"; mv -f -- "$temporary" "$STATE_FILE"
}
read_state() {
  [[ -f "$STATE_FILE" && ! -L "$STATE_FILE" && "$(stat -c '%U:%G:%a' "$STATE_FILE")" == 'root:root:600' ]] || die 'No existe estado válido de PrepareCandidateOnly para este paquete.'
  local -a data; mapfile -t data <"$STATE_FILE"
  [[ ${#data[@]} -eq 10 && "${data[0]}" == "$EXPECTED_PACKAGE_SHA" ]] || die 'El estado persistido de preparación es inválido.'
  [[ "${data[1]}" == "$ORIGINAL_FRONT_ID" && "${data[2]}" == "$ORIGINAL_BACK_ID" && "${data[3]}" == "$ORIGINAL_FRONT_REF" && "${data[4]}" == "$ORIGINAL_BACK_REF" && "${data[5]}" == "$ORIGINAL_MYSQL_ID" && "${data[6]}" == "$ORIGINAL_MYSQL_IMAGE_ID" && "${data[7]}" == "$ORIGINAL_MYSQL_MOUNTS" && "${data[8]}" == "$CAND_FRONT_TAG" ]] || die 'La imagen activa o identidad de MySQL cambió desde PrepareCandidateOnly.'
  [[ "$(docker image inspect --format '{{.Id}}' "$CAND_FRONT_TAG" 2>/dev/null || true)" == "${data[9]}" ]] || die 'La candidata preparada no existe o su ID cambió.'
}

assert_candidate_http() {
  local image="$1" name port status endpoint
  name="softventa-charge-fix-check-${PACKAGE_SHORT}"
  [[ -z "$(docker ps -aq --filter "name=^/${name}$")" ]] || die 'Ya existe un contenedor temporal de validación con este identificador.'
  port="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
  [[ "$port" =~ ^[0-9]{1,5}$ ]] || die 'No se pudo asignar puerto loopback temporal.'
  VALIDATION_ID="$(docker run -d --name "$name" --network pos-production_edge -p "127.0.0.1:${port}:80" "$image")" || die 'No inició la candidata en loopback.'
  local ready=0
  for _ in $(seq 1 30); do
    status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 3 "http://127.0.0.1:${port}/" || true)"
    if [[ "$status" == 200 ]]; then ready=1; break; fi
    sleep 1
  done
  [[ "$ready" == 1 ]] || die 'La página raíz candidata no respondió HTTP 200.'
  docker exec "$VALIDATION_ID" nginx -t >/dev/null 2>&1 || die 'nginx -t falló dentro de la candidata.'
  note 'CANDIDATE_NGINX=PASS'
  for endpoint in / /api-client.js /app.js /connected-auth.js /connected-sales.js /service-worker.js /manifest.webmanifest /assets/pwa/softventaweb-favicon-20261106-32.png; do
    status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "http://127.0.0.1:${port}${endpoint}" || true)"
    [[ "$status" == 200 ]] || die "Recurso estático candidato falló: $endpoint HTTP=$status"
  done
  curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${port}/app.js" -o "$WORK/candidate-app.js" || die 'No se pudo leer app.js candidato.'
  curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${port}/connected-sales.js" -o "$WORK/candidate-connected-sales.js" || die 'No se pudo leer connected-sales.js candidato.'
  curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${port}/api-client.js" -o "$WORK/candidate-api-client.js" || die 'No se pudo leer api-client.js candidato.'
  curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${port}/service-worker.js" -o "$WORK/candidate-service-worker.js" || die 'No se pudo leer service-worker.js candidato.'
  grep -Fq 'clearSaleDetail(value)' "$WORK/candidate-app.js" || die 'PosRuntime no publica clearSaleDetail en la candidata.'
  grep -Fq 'SOFTVENTAWEB_HISTORY_DIAGNOSTICS_V1:runtime' "$WORK/candidate-app.js" || die 'Falta el marcador de diagnosticos del historial en app.js.'
  grep -Fq '[SoftVentaWeb diagnostic]' "$WORK/candidate-connected-sales.js" || die 'Faltan los diagnosticos publicados del historial en connected-sales.js.'
  grep -Fq '[SoftVentaWeb diagnostic]' "$WORK/candidate-api-client.js" || die 'Faltan los diagnosticos publicados del historial en api-client.js.'
  grep -Fq 'clearConfirmedSaleDetail(result.sale.detail);' "$WORK/candidate-connected-sales.js" || die 'Falta la limpieza segura del detalle confirmado.'
  grep -Fq 'completeCommittedResult(result, true)' "$WORK/candidate-connected-sales.js" || die 'Falta la reconciliacion idempotente del resultado recuperado.'
  grep -Fq 'value.order.saleId!==value.sale.id' "$WORK/candidate-api-client.js" || die 'Falta la validacion del vinculo venta/orden.'
  grep -Fq "pos-pwa-shell-chargefix-${EXPECTED_PACKAGE_SHA:0:16}" "$WORK/candidate-service-worker.js" || die 'La candidata no tiene la revision de cache esperada.'
  note 'CANDIDATE_CHARGE_FIX_STATIC_CONTENT=PASS; history diagnostics preserved'
  note 'CANDIDATE_STATIC_RESOURCES=PASS'
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 8 "http://127.0.0.1:${port}/api/health" || true)"
  [[ "$status" == 200 ]] || die "API health por proxy candidato falló: HTTP=$status"
  note 'CANDIDATE_API_ROUTING=PASS'
  for endpoint in '/api/sales?limit=1&offset=0' '/api/sales/orders/history?limit=1&offset=0' '/api/reports/connected'; do
    status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 8 "http://127.0.0.1:${port}${endpoint}" || true)"
    [[ "$status" == 401 || "$status" == 403 ]] || die "Ruta protegida sin autenticación: ${endpoint%%\?*} HTTP=$status"
  done
  note 'CANDIDATE_AUTH_GATES=PASS; rutas protegidas requieren sesión'
  docker rm --force "$VALIDATION_ID" >/dev/null; VALIDATION_ID=''
}

if [[ "$MODE" == '--rollback' ]]; then
  BACKUP_DIR="$STATE_DIR/softventa-charge-fix-$ROLLBACK_TOKEN"
  [[ -d "$BACKUP_DIR" && ! -L "$BACKUP_DIR" && "$(stat -c '%U:%G:%a' "$BACKUP_DIR")" == 'root:root:700' && -s "$BACKUP_DIR/images.tsv" && "$(stat -c '%U:%G:%a' "$BACKUP_DIR/images.tsv")" == 'root:root:600' ]] || die 'No existe respaldo íntegro para el token indicado.'
  mapfile -t BACKUP <"$BACKUP_DIR/images.tsv"
  [[ ${#BACKUP[@]} -eq 9 && "${BACKUP[0]}" == "$EXPECTED_PACKAGE_SHA" && "${BACKUP[4]}" == "$ORIGINAL_BACK_ID" && "${BACKUP[5]}" == "$ORIGINAL_MYSQL_ID" && "${BACKUP[6]}" == "$ORIGINAL_MYSQL_IMAGE_ID" && "${BACKUP[7]}" == "$ORIGINAL_MYSQL_MOUNTS" && "${BACKUP[8]}" == "$ORIGINAL_FRONT_REF" ]] || die 'El respaldo no corresponde a este paquete, referencias o identidad de producción.'
  current_front="$(docker inspect --format '{{.Image}}' "$active_front_cid")"; current_back="$(docker inspect --format '{{.Image}}' "$active_back_cid")"
  [[ "$current_front" == "${BACKUP[3]}" && "$current_back" == "$ORIGINAL_BACK_ID" ]] || die 'El frontend no coincide con el despliegue o cambió el backend; rollback obsoleto rechazado.'
  [[ "$(docker image inspect --format '{{.Id}}' "${BACKUP[1]}")" == "${BACKUP[2]}" ]] || die 'La imagen de respaldo frontend no coincide.'
  read -r -p "Restaurar solo frontend al respaldo $ROLLBACK_TOKEN. Escriba exactamente ROLLBACK $ROLLBACK_TOKEN: " CONFIRM
  [[ "$CONFIRM" == "ROLLBACK $ROLLBACK_TOKEN" ]] || die 'No se confirmó rollback.'
  docker tag "${BACKUP[2]}" "$ORIGINAL_FRONT_REF"
  PRE_MUTATION_FRONT_ID="$current_front"; PRE_MUTATION_FRONT_REF="$ORIGINAL_FRONT_REF"; MUTATION_STARTED=1
  dc up -d --no-deps --force-recreate frontend >/dev/null || die 'Compose falló durante rollback.'
  restored_front="$(wait_healthy frontend)"; restored_back="$(active_cid backend)"; restored_mysql="$(active_cid mysql)"
  [[ "$(docker inspect --format '{{.Image}}' "$restored_front")" == "${BACKUP[2]}" && "$(docker inspect --format '{{.Image}}' "$restored_back")" == "$ORIGINAL_BACK_ID" && "$(docker inspect --format '{{.Image}}' "$restored_mysql")" == "$ORIGINAL_MYSQL_IMAGE_ID" ]] || die 'No se verificó rollback frontend o cambió backend/MySQL.'
  MUTATION_STARTED=0; DEPLOY_OK=1
  note 'ROLLBACK=PASS; solo frontend restaurado; backend y MySQL conservados'
  exit 0
fi

if [[ "$MODE" == '--prepare-only' ]]; then
  ensure_tag "$ORIGINAL_FRONT_ID" "$BASE_FRONT_TAG"
  ensure_tag "$ORIGINAL_BACK_ID" "$BASE_BACK_TAG"
  if ! candidate_valid; then
    docker image inspect "$CAND_FRONT_TAG" >/dev/null 2>&1 && die 'La etiqueta de candidata existe con otras bases o paquete.'
    docker run --rm --network none --user 0:0 --entrypoint node -v "$WORK:/payload:ro" "$ORIGINAL_BACK_ID" /payload/apply-connected-charge-fix.cjs --self-test >/dev/null || die 'SelfTest del transformador en Node del backend activo falló.'
    note 'TRANSFORM_SELFTEST=PASS; Node provisto por la imagen backend activa'
    docker build --progress=plain --pull=false --network=none --build-arg "FRONTEND_BASE=$BASE_FRONT_TAG" --build-arg "BACKEND_BASE=$BASE_BACK_TAG" --build-arg "FRONTEND_BASE_ID=$ORIGINAL_FRONT_ID" --build-arg "BACKEND_BASE_ID=$ORIGINAL_BACK_ID" --build-arg "PACKAGE_SHA256=$EXPECTED_PACKAGE_SHA" --file "$WORK/Dockerfile.frontend" --tag "$CAND_FRONT_TAG" "$WORK" || die 'Falló la construcción de la candidata frontend.'
  fi
  candidate_valid || die 'La candidata no está vinculada a las imágenes base actuales y a este paquete.'
  CANDIDATE_ID="$(docker image inspect --format '{{.Id}}' "$CAND_FRONT_TAG")"
  assert_candidate_http "$CAND_FRONT_TAG"
  [[ "$(docker inspect --format '{{.Image}}' "$active_back_cid")" == "$ORIGINAL_BACK_ID" && "$(docker inspect --format '{{.Image}}' "$active_mysql_cid")" == "$ORIGINAL_MYSQL_IMAGE_ID" ]] || die 'Backend o MySQL cambiaron durante la preparación.'
  write_state "$CANDIDATE_ID"
  note "PREPARE_ONLY=PASS; frontend=$CANDIDATE_ID; base_frontend=$ORIGINAL_FRONT_ID; backend_unchanged=$ORIGINAL_BACK_ID; mysql_unchanged=$ORIGINAL_MYSQL_IMAGE_ID"
  note 'La candidata no se publicó; no se modificaron contenedores activos ni datos.'
  DEPLOY_OK=1
  exit 0
fi

read_state
candidate_valid || die 'La candidata preparada no existe o ya no corresponde a sus bases.'
CANDIDATE_ID="$(docker image inspect --format '{{.Id}}' "$CAND_FRONT_TAG")"
assert_candidate_http "$CAND_FRONT_TAG"
read -r -p 'Publicar solo la corrección frontend de cobro. Escriba exactamente PUBLICAR CORRECCION DE COBRO: ' CONFIRM
[[ "$CONFIRM" == 'PUBLICAR CORRECCION DE COBRO' ]] || die 'No se confirmó el despliegue.'
TOKEN="$(date -u +%Y%m%dT%H%M%SZ)-${CANDIDATE_ID#sha256:}"
TOKEN="${TOKEN:0:29}"
[[ "$TOKEN" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]] || die 'No se pudo crear token de rollback.'
BACKUP_DIR="$STATE_DIR/softventa-charge-fix-$TOKEN"
[[ ! -e "$BACKUP_DIR" ]] || die 'El directorio de respaldo ya existe.'
install -d -o root -g root -m 700 "$BACKUP_DIR"
BACKUP_TAG="pos-frontend:charge-fix-backup-$TOKEN"
docker tag "$ORIGINAL_FRONT_ID" "$BACKUP_TAG"
(umask 077; printf '%s\n' "$EXPECTED_PACKAGE_SHA" "$BACKUP_TAG" "$ORIGINAL_FRONT_ID" "$CANDIDATE_ID" "$ORIGINAL_BACK_ID" "$ORIGINAL_MYSQL_ID" "$ORIGINAL_MYSQL_IMAGE_ID" "$ORIGINAL_MYSQL_MOUNTS" "$ORIGINAL_FRONT_REF" >"$BACKUP_DIR/images.tsv")
chown root:root "$BACKUP_DIR/images.tsv"; chmod 600 "$BACKUP_DIR/images.tsv"
docker tag "$CANDIDATE_ID" "$ORIGINAL_FRONT_REF" || die 'No se pudo asignar la candidata a la referencia frontend activa.'
PRE_MUTATION_FRONT_ID="$ORIGINAL_FRONT_ID"; PRE_MUTATION_FRONT_REF="$ORIGINAL_FRONT_REF"; MUTATION_STARTED=1
dc up -d --no-deps --force-recreate frontend >/dev/null || die 'Compose falló al publicar frontend.'
new_front="$(wait_healthy frontend)"; new_back="$(active_cid backend)"; new_mysql="$(active_cid mysql)"
[[ "$(docker inspect --format '{{.Image}}' "$new_front")" == "$CANDIDATE_ID" ]] || die 'Frontend no quedó ejecutando la candidata preparada.'
[[ "$(docker inspect --format '{{.Image}}' "$new_back")" == "$ORIGINAL_BACK_ID" && "$new_back" == "$active_back_cid" ]] || die 'El backend se modificó durante el despliegue.'
[[ "$(docker inspect --format '{{.Image}}' "$new_mysql")" == "$ORIGINAL_MYSQL_IMAGE_ID" && "$new_mysql" == "$ORIGINAL_MYSQL_ID" ]] || die 'MySQL se modificó durante el despliegue.'
docker exec "$new_front" nginx -t >/dev/null 2>&1 || die 'nginx -t falló después del despliegue.'
for endpoint in / /api-client.js /app.js /connected-auth.js /connected-sales.js /service-worker.js; do
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 8 "http://127.0.0.1:8080${endpoint}" || true)"
  [[ "$status" == 200 ]] || die "Recurso publicado falló: $endpoint HTTP=$status"
done
status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 8 http://127.0.0.1:8080/api/health || true)"
[[ "$status" == 200 ]] || die "API health posterior falló: HTTP=$status"
note "DEPLOY=PASS; solo frontend; backend=$ORIGINAL_BACK_ID; MySQL=$ORIGINAL_MYSQL_IMAGE_ID; ROLLBACK_TOKEN=$TOKEN"
DEPLOY_OK=1
