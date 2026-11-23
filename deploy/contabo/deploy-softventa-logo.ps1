[CmdletBinding()]
param(
    [switch]$SelfTest,
    [switch]$DiagnoseCandidateOnly,
    [switch]$Deploy
)

$ErrorActionPreference = 'Stop'
$Target = 'posadmin@31.220.84.51'
$ExpectedFrontendImage = 'sha256:bf2b7cba050e8848b56243d6041486ab7acc85303b5da4dee4b4220ccc1ca079'

$RemoteDeploy = @'
#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

die() { printf 'DETENIDO: %s\n' "$1" >&2; exit 1; }
note() { printf '%s\n' "$1"; }
hash_file() { sha256sum -- "$1" | awk '{print $1}'; }
image_id() { docker image inspect --format '{{.Id}}' "$1" 2>/dev/null; }
container_for() {
  local service="$1"
  local -a ids=()
  mapfile -t ids < <(docker ps --quiet --filter "label=com.docker.compose.project=pos-production" --filter "label=com.docker.compose.service=$service")
  [[ ${#ids[@]} -eq 1 ]] || return 1
  printf '%s' "${ids[0]}"
}
health_of() {
  docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$1" 2>/dev/null
}
EDGE_NETWORK='pos-production_edge'
verify_edge_network() {
  local front_json backend_json
  docker network inspect "$EDGE_NETWORK" >/dev/null 2>&1 || return 1
  front_json="$(docker inspect --format '{{json .NetworkSettings.Networks}}' "$FRONT_ID" 2>/dev/null)" || return 1
  backend_json="$(docker inspect --format '{{json .NetworkSettings.Networks}}' "$BACKEND_ID" 2>/dev/null)" || return 1
  python3 - "$EDGE_NETWORK" "$front_json" "$backend_json" <<'PY'
import json, sys
network, front_raw, backend_raw = sys.argv[1:]
try:
    front=json.loads(front_raw)
    backend=json.loads(backend_raw)
except Exception:
    raise SystemExit(1)
if network not in front or network not in backend:
    raise SystemExit(1)
if 'backend' not in (backend[network].get('Aliases') or []):
    raise SystemExit(1)
PY
}
nginx_failure_class() {
  local log="$1"
  if grep -Eiq 'host not found in upstream|could not be resolved|no resolver defined to resolve' "$log"; then
    printf 'UPSTREAM_DNS'
  elif grep -Eiq 'unexpected "?[{}]|directive .* is not allowed here|"?[A-Za-z_]+"? directive is not allowed here|unknown directive|duplicate .* directive|invalid number of arguments|directive .* is not terminated by|"(events|http)" directive is not allowed here' "$log"; then
    printf 'NGINX_SYNTAX'
  elif grep -Eiq 'open\(\).*failed|No such file or directory|Permission denied' "$log"; then
    printf 'CONFIG_FILE_OR_PERMISSION'
  elif grep -Eiq 'network .* not found|failed to create endpoint|could not attach to network|error while connecting to network' "$log"; then
    printf 'DOCKER_NETWORK'
  else
    printf 'NGINX_CONFIG_OR_RUNTIME'
  fi
}
test_nginx_image() {
  local tag="$1" id="$2" log="$3"
  if docker run --rm --network "$EDGE_NETWORK" --entrypoint nginx "$id" -t >"$log" 2>&1; then
    note "NGINX_TEST=PASS; IMAGE=$tag; NETWORK=$EDGE_NETWORK"
    return 0
  fi
  note "NGINX_TEST=FAIL; IMAGE=$tag; NETWORK=$EDGE_NETWORK; CAUSE=$(nginx_failure_class "$log")"
  return 1
}
if [[ "${1:-}" == '--self-test' ]]; then
  self_tmp="$(mktemp -d /tmp/pos-logo-nginx-selftest.XXXXXX)"
  trap 'rm -rf -- "$self_tmp"' EXIT
  expect_nginx_class() {
    local expected="$1" case_name="$2" actual
    actual="$(nginx_failure_class "$3")"
    if [[ "$actual" != "$expected" ]]; then
      printf 'NGINX_CLASS_TEST=FAIL; CASE=%s; EXPECTED=%s; ACTUAL=%s\n' "$case_name" "$expected" "$actual" >&2
      exit 1
    fi
  }
  printf '%s\n' '[emerg] host not found in upstream "backend"' >"$self_tmp/dns"
  printf '%s\n' '[emerg] "server" directive is not allowed here' >"$self_tmp/syntax"
  printf '%s\n' 'open() "/etc/nginx/mime.types" failed (2: No such file or directory)' >"$self_tmp/file"
  printf '%s\n' 'failed to create endpoint: network not found' >"$self_tmp/network"
  printf '%s\n' 'unclassified nginx validation failure' >"$self_tmp/other"
  expect_nginx_class 'UPSTREAM_DNS' 'upstream-dns' "$self_tmp/dns"
  expect_nginx_class 'NGINX_SYNTAX' 'syntax' "$self_tmp/syntax"
  expect_nginx_class 'CONFIG_FILE_OR_PERMISSION' 'file-or-permission' "$self_tmp/file"
  expect_nginx_class 'DOCKER_NETWORK' 'docker-network' "$self_tmp/network"
  expect_nginx_class 'NGINX_CONFIG_OR_RUNTIME' 'other-config' "$self_tmp/other"
  printf 'NGINX_DIAGNOSTIC_SELF_TEST=PASS\n'
  exit 0
fi
compose_diagnostic() {
  python3 - "$1" <<'PY'
import re, sys
text=open(sys.argv[1], encoding='utf-8', errors='replace').read()
names=set(re.findall(r'required variable\s+([A-Z][A-Z0-9_]*)', text, re.I))
names.update(re.findall(r'"([A-Z][A-Z0-9_]*)"\s+variable is not set', text, re.I))
names.update(re.findall(r'variable\s+([A-Z][A-Z0-9_]*)\s+(?:is required|must be set|is missing)', text, re.I))
if names:
    print('variables de interpolación no resueltas: ' + ', '.join(sorted(names)))
elif re.search(r'permission denied|cannot read|failed to read|no such file|not found', text, re.I):
    print('Compose no pudo leer uno de los archivos aprobados (revisar rutas y permisos).')
elif re.search(r'yaml|mapping|syntax|line [0-9]+', text, re.I):
    line=re.search(r'line ([0-9]+)', text, re.I)
    print('error de sintaxis/estructura Compose' + (f' cerca de la línea {line.group(1)}' if line else '') + '.')
elif re.search(r'unknown flag|unknown shorthand|flag provided but not defined', text, re.I):
    print('la versión de Compose no admite una opción utilizada.')
else:
    print('inconsistencia de resolución/validación; detalle interno no mostrado.')
PY
}
wait_healthy() {
  local service="$1" id state n
  for n in $(seq 1 60); do
    id="$(container_for "$service" 2>/dev/null || true)"
    if [[ -n "$id" ]]; then
      state="$(health_of "$id" 2>/dev/null || true)"
      [[ "$state" == 'running|healthy' ]] && { printf '%s' "$id"; return 0; }
    fi
    sleep 2
  done
  return 1
}

[[ $EUID -eq 0 ]] || die 'Este helper debe ejecutarse mediante sudo interactivo.'
[[ $# -eq 7 ]] || die 'Argumentos de ejecución incorrectos.'
PACKAGE="$1"; PACKAGE_SHA="$2"; RUN_ID="$3"; SCRIPT_SHA="$4"; PATCH_SHA="$5"; EXPECTED_SCRIPT_IMAGE="$6"; MODE="$7"
[[ "$MODE" == 'deploy' || "$MODE" == 'diagnose-candidate' ]] || die 'Modo de ejecución no permitido.'
[[ "$RUN_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$ ]] || die 'Identificador de ejecución inválido.'
[[ "$PACKAGE" == "/home/posadmin/pos-logo-update-$RUN_ID/bundle.tar.gz" ]] || die 'Ruta del paquete fuera del directorio permitido.'
[[ "$PACKAGE_SHA" =~ ^[a-f0-9]{64}$ && "$SCRIPT_SHA" =~ ^[a-f0-9]{64}$ && "$PATCH_SHA" =~ ^[a-f0-9]{64}$ ]] || die 'Checksum inválido.'
[[ "$EXPECTED_SCRIPT_IMAGE" == 'sha256:bf2b7cba050e8848b56243d6041486ab7acc85303b5da4dee4b4220ccc1ca079' ]] || die 'La imagen esperada no coincide con la autorización.'
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd -P)"
[[ "$SCRIPT_DIR" == "/home/posadmin/pos-logo-update-$RUN_ID" ]] || die 'Ruta del helper fuera del directorio permitido.'
[[ "$(hash_file "$0")" == "$SCRIPT_SHA" ]] || die 'El helper transferido no coincide con su SHA-256 local.'
[[ "$(hash_file "$PACKAGE")" == "$PACKAGE_SHA" ]] || die 'El paquete transferido no coincide con su SHA-256 local.'

EXPECTED_FILES=$'patch-logo.py\nremote-deploy.sh'
ACTUAL_FILES="$(tar -tzf "$PACKAGE" 2>/dev/null | LC_ALL=C sort)" || die 'No se pudo leer el paquete.'
[[ "$ACTUAL_FILES" == "$(printf '%s\n' "$EXPECTED_FILES" | LC_ALL=C sort)" ]] || die 'El paquete contiene archivos inesperados.'
STAGE="$(mktemp -d "/tmp/pos-logo-$RUN_ID.XXXXXX")"
chmod 0700 "$STAGE"
cleanup() {
  if [[ -n "${BASE_CONTAINER:-}" ]]; then docker rm "$BASE_CONTAINER" >/dev/null 2>&1 || true; fi
  if [[ -n "${STAGE:-}" && "$STAGE" == "/tmp/pos-logo-$RUN_ID."* && -d "$STAGE" ]]; then rm -rf -- "$STAGE"; fi
}
trap cleanup EXIT
tar -xzf "$PACKAGE" -C "$STAGE" || die 'No se pudo extraer el paquete verificado.'
[[ "$(hash_file "$STAGE/remote-deploy.sh")" == "$SCRIPT_SHA" ]] || die 'El helper dentro del paquete no coincide.'
[[ "$(hash_file "$STAGE/patch-logo.py")" == "$PATCH_SHA" ]] || die 'El parcheador dentro del paquete no coincide.'
command -v python3 >/dev/null || die 'Python 3 no está disponible; no se instalará software.'
command -v curl >/dev/null || die 'curl no está disponible para las verificaciones HTTPS.'

PROJECT_DIR='/opt/pos/app'
ENV_FILE='/etc/pos/production.env'
PRIVATE_ENV_FILE='/home/posadmin/pos-private-test.env'
[[ -d "$PROJECT_DIR" && -r "$ENV_FILE" && -r "$PRIVATE_ENV_FILE" ]] || die 'Faltan el proyecto o uno de los dos archivos env autorizados.'
[[ "$(stat -c '%U:%G:%a' "$ENV_FILE")" == 'root:root:600' ]] || die 'Los permisos del archivo privado no son los esperados.'
[[ "$(stat -c '%U:%G:%a' "$PRIVATE_ENV_FILE")" == 'posadmin:posadmin:600' ]] || die 'Los permisos del env privado de prueba no son los esperados.'
command -v docker >/dev/null || die 'Docker no está disponible.'
docker compose version >/dev/null 2>&1 || die 'Docker Compose no está disponible.'

mapfile -t FRONT_IDS < <(docker ps --quiet --filter 'label=com.docker.compose.project=pos-production' --filter 'label=com.docker.compose.service=frontend')
[[ ${#FRONT_IDS[@]} -eq 1 ]] || die 'No se encontró exactamente un frontend activo de pos-production.'
FRONT_ID="${FRONT_IDS[0]}"
BACKEND_ID="$(container_for backend)" || die 'No se encontró exactamente un backend activo de pos-production.'
MYSQL_ID="$(container_for mysql)" || die 'No se encontró exactamente un MySQL activo de pos-production.'
[[ "$(health_of "$FRONT_ID")" == 'running|healthy' ]] || die 'El frontend no está healthy antes del cambio.'
[[ "$(health_of "$BACKEND_ID")" == 'running|healthy' ]] || die 'El backend no está healthy antes del cambio.'
[[ "$(health_of "$MYSQL_ID")" == 'running|healthy' ]] || die 'MySQL no está healthy antes del cambio.'

CURRENT_ID="$(docker inspect --format '{{.Image}}' "$FRONT_ID")"
IMAGE_REF="$(docker inspect --format '{{.Config.Image}}' "$FRONT_ID")"
[[ "$CURRENT_ID" == "$EXPECTED_SCRIPT_IMAGE" ]] || die 'La imagen frontend activa no coincide con el ID confirmado; no se modificó nada.'
[[ "$(image_id "$IMAGE_REF")" == "$CURRENT_ID" ]] || die 'La etiqueta Compose no apunta a la imagen frontend activa.'
[[ "$(image_id 'pos-frontend:rollback-rc6')" == 'sha256:31d1c752a9df5c702588fad3a6bdc13ba7971754b24bd70808cde52688fcfad0' ]] || die 'La referencia rollback-rc6 no coincide con su ID protegido.'

COMPOSE_PROJECT="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$FRONT_ID")"
WORKDIR="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$FRONT_ID")"
CONFIG_FILES="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$FRONT_ID")"
[[ "$COMPOSE_PROJECT" == 'pos-production' && "$WORKDIR" == "$PROJECT_DIR" && -n "$CONFIG_FILES" ]] || die 'Las etiquetas del contenedor no identifican el Compose esperado.'
IFS=',' read -r -a FILES <<< "$CONFIG_FILES"
EXPECTED_FILES=(/opt/pos/app/compose.yaml /opt/pos/app/compose.production.yaml /home/posadmin/pos-private-test.override.yaml)
[[ ${#FILES[@]} -eq ${#EXPECTED_FILES[@]} ]] || die 'Las etiquetas Compose no incluyen exactamente los tres archivos aprobados.'
for index in "${!EXPECTED_FILES[@]}"; do
  [[ "${FILES[$index]}" == "${EXPECTED_FILES[$index]}" ]] || die 'El orden o la ruta de Compose difiere de la configuración aprobada.'
  [[ -f "${EXPECTED_FILES[$index]}" ]] || die 'Falta un archivo Compose efectivo.'
done
COMPOSE_ARGS=(--project-name pos-production --profile tools --project-directory "$WORKDIR" --env-file "$ENV_FILE" --env-file "$PRIVATE_ENV_FILE")
for file in "${EXPECTED_FILES[@]}"; do COMPOSE_ARGS+=(-f "$file"); done
COMPOSE=(docker compose "${COMPOSE_ARGS[@]}")
COMPOSE_ERROR="$STAGE/compose-config.log"
if ! "${COMPOSE[@]}" config --quiet >"$COMPOSE_ERROR" 2>&1; then
  DIAGNOSTIC="$(compose_diagnostic "$COMPOSE_ERROR")" || DIAGNOSTIC='no se pudo clasificar el error de Compose'
  die "Compose config --quiet falló: $DIAGNOSTIC"
fi
COMPOSE_IMAGES="$STAGE/compose-images.txt"
if ! "${COMPOSE[@]}" config --images >"$COMPOSE_IMAGES" 2>"$STAGE/compose-images.log"; then
  DIAGNOSTIC="$(compose_diagnostic "$STAGE/compose-images.log")" || DIAGNOSTIC='no se pudo clasificar el error de Compose'
  die "Compose config --images falló: $DIAGNOSTIC"
fi
grep -Fxq "$IMAGE_REF" "$COMPOSE_IMAGES" || die 'config --images no incluyó la imagen del frontend activo.'
CONFIG_JSON="$STAGE/compose.json"
"${COMPOSE[@]}" config --format json >"$CONFIG_JSON" 2>/dev/null || die 'No se pudo analizar la configuración efectiva.'
if ! python3 - "$CONFIG_JSON" "$IMAGE_REF" <<'PY'
import json, sys
cfg=json.load(open(sys.argv[1], encoding='utf-8'))
services=cfg.get('services', {})
if not all(name in services for name in ('frontend','backend','mysql')):
    raise SystemExit(1)
front=services['frontend']
if front.get('image') != sys.argv[2]:
    raise SystemExit(1)
ports=front.get('ports') or []
if not any(str(p.get('published','')) == '8080' and p.get('host_ip') == '127.0.0.1' for p in ports):
    raise SystemExit(1)
if services['backend'].get('ports') or services['mysql'].get('ports'):
    raise SystemExit(1)
PY
then
  die 'El Compose efectivo no conserva imagen y puertos privados esperados.'
fi
note 'PREFLIGHT=PASS'

verify_edge_network || die 'La red pos-production_edge no conecta frontend y backend con el alias backend; nginx -t no se ejecutó.'
note 'EDGE_NETWORK=PASS; puertos publicados=ninguno'

if [[ "$MODE" == 'diagnose-candidate' ]]; then
  mapfile -t CANDIDATE_ROWS < <(docker image ls --filter 'reference=pos-frontend:logo-fix-*' --format '{{.Repository}}:{{.Tag}}|{{.ID}}')
  VALID_ROWS=()
  for row in "${CANDIDATE_ROWS[@]}"; do
    tag="${row%%|*}"
    [[ "$tag" =~ ^pos-frontend:logo-fix-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$ ]] && VALID_ROWS+=("$row")
  done
  [[ ${#VALID_ROWS[@]} -gt 0 ]] || die 'No se encontró una imagen candidata retenida pos-frontend:logo-fix-*.'
  SELECTED_ROW="$(printf '%s\n' "${VALID_ROWS[@]}" | LC_ALL=C sort | tail -n 1)"
  SELECTED_TAG="${SELECTED_ROW%%|*}"
  SELECTED_ID="$(image_id "$SELECTED_TAG")"
  [[ -n "$SELECTED_ID" && "$SELECTED_ID" != "$CURRENT_ID" ]] || die 'La candidata seleccionada no es una imagen distinta de la producción.'
  BASE_NGINX_HASH="$(docker run --rm --network none --entrypoint sha256sum "$CURRENT_ID" /etc/nginx/conf.d/default.conf 2>/dev/null | awk '{print $1}')" || die 'No se pudo inspeccionar la configuración Nginx activa.'
  CANDIDATE_NGINX_HASH="$(docker run --rm --network none --entrypoint sha256sum "$SELECTED_ID" /etc/nginx/conf.d/default.conf 2>/dev/null | awk '{print $1}')" || die 'No se pudo inspeccionar la configuración Nginx candidata.'
  [[ -n "$BASE_NGINX_HASH" && "$BASE_NGINX_HASH" == "$CANDIDATE_NGINX_HASH" ]] || die 'La configuración Nginx candidata difiere de la activa; se omitió nginx -t.'
  note "DIAGNOSTIC_CANDIDATE=$SELECTED_TAG"
  note "DIAGNOSTIC_IMAGE_ID=$SELECTED_ID"
  if ! test_nginx_image "$SELECTED_TAG" "$SELECTED_ID" "$STAGE/nginx-test.log"; then
    die 'La prueba aislada de nginx falló; ningún servicio ni etiqueta de producción fue modificado.'
  fi
  note 'PRODUCTION_TAGS_CHANGED=no; SERVICES_RECREATED=no; PORTS_PUBLISHED=no'
  exit 0
fi

BACKEND_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$BACKEND_ID")"
MYSQL_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$MYSQL_ID")"
MYSQL_MOUNTS="$(docker inspect --format '{{range .Mounts}}{{if .Name}}{{.Name}}:{{.Destination}};{{end}}{{end}}' "$MYSQL_ID")"
ROLLBACK_TAG="pos-frontend:rollback-logo-$RUN_ID"
CANDIDATE_TAG="pos-frontend:logo-fix-$RUN_ID"
if docker image inspect "$ROLLBACK_TAG" >/dev/null 2>&1 || docker image inspect "$CANDIDATE_TAG" >/dev/null 2>&1; then die 'Ya existe una etiqueta con este identificador.'; fi

BUILD="$STAGE/build"
mkdir -m 0700 "$BUILD"
BASE_CONTAINER="pos-logo-base-$RUN_ID"
docker create --name "$BASE_CONTAINER" --network none "$CURRENT_ID" >/dev/null || die 'No se pudo crear el contenedor temporal de lectura.'
docker cp "$BASE_CONTAINER:/usr/share/nginx/html/." "$BUILD/" >/dev/null || die 'No se pudieron extraer los archivos públicos de la imagen activa.'
for required in index.html styles.css service-worker.js; do
  [[ -s "$BUILD/$required" ]] || die 'Falta un archivo público requerido en la imagen activa.'
done
for asset in assets/pwa/softventaweb-logo.webp assets/pwa/favicon-32.png manifest.webmanifest; do
  [[ -s "$BUILD/$asset" ]] || die 'Falta un recurso público de SoftVentaWeb en la imagen activa.'
done
python3 "$STAGE/patch-logo.py" "$BUILD/index.html" "$BUILD/styles.css" "$BUILD/service-worker.js" "$BUILD"
chmod 0644 "$BUILD/index.html" "$BUILD/styles.css" "$BUILD/service-worker.js"
cat >"$BUILD/Dockerfile" <<EOF
FROM $ROLLBACK_TAG
COPY --chmod=0644 index.html /usr/share/nginx/html/index.html
COPY --chmod=0644 styles.css /usr/share/nginx/html/styles.css
COPY --chmod=0644 service-worker.js /usr/share/nginx/html/service-worker.js
EOF
docker tag "$CURRENT_ID" "$ROLLBACK_TAG" || die 'No se pudo crear la etiqueta de recuperación de la imagen actual.'
docker build --pull=false --network=none --tag "$CANDIDATE_TAG" "$BUILD" >"$STAGE/build.log" 2>&1 || die 'Falló el build aislado del frontend candidato.'
CANDIDATE_ID="$(image_id "$CANDIDATE_TAG")"
[[ -n "$CANDIDATE_ID" && "$CANDIDATE_ID" != "$CURRENT_ID" ]] || die 'La imagen candidata no es una imagen nueva.'

test_nginx_image "$CANDIDATE_TAG" "$CANDIDATE_ID" "$STAGE/nginx-test.log" || die 'nginx -t falló en la imagen candidata; consulte CAUSE en el diagnóstico anterior.'
PERMISSIONS="$(docker run --rm --network none --entrypoint sh "$CANDIDATE_ID" -c 'stat -c %a /usr/share/nginx/html /usr/share/nginx/html/assets /usr/share/nginx/html/assets/pwa /usr/share/nginx/html/index.html /usr/share/nginx/html/styles.css /usr/share/nginx/html/service-worker.js /usr/share/nginx/html/assets/pwa/softventaweb-logo.webp /usr/share/nginx/html/assets/pwa/favicon-32.png' 2>/dev/null)" || die 'No se pudieron comprobar permisos estáticos.'
[[ "$PERMISSIONS" == $'755\n755\n755\n644\n644\n644\n644\n644' ]] || die 'Los permisos estáticos no son 755 para directorios y 644 para archivos.'
BASE_NGINX_HASH="$(docker run --rm --network none --entrypoint sha256sum "$CURRENT_ID" /etc/nginx/conf.d/default.conf 2>/dev/null | awk '{print $1}')" || die 'No se pudo medir la configuración Nginx base.'
CANDIDATE_NGINX_HASH="$(docker run --rm --network none --entrypoint sha256sum "$CANDIDATE_ID" /etc/nginx/conf.d/default.conf 2>/dev/null | awk '{print $1}')" || die 'No se pudo medir la configuración Nginx candidata.'
[[ -n "$BASE_NGINX_HASH" && "$BASE_NGINX_HASH" == "$CANDIDATE_NGINX_HASH" ]] || die 'La configuración Nginx difiere de la imagen publicada.'
docker run --rm --network none --entrypoint sh "$CANDIDATE_ID" -c 'grep -Fq "width=\"220\" height=\"56\"" /usr/share/nginx/html/index.html && grep -Fq "softventa-login-logo-bounds:v1" /usr/share/nginx/html/styles.css && test -s /usr/share/nginx/html/assets/pwa/softventaweb-logo.webp && test -s /usr/share/nginx/html/assets/pwa/favicon-32.png && grep -Fq "pos-pwa-shell-" /usr/share/nginx/html/service-worker.js' >/dev/null 2>&1 || die 'Falló la validación de HTML, CSS, PWA o recursos estáticos.'
note 'CANDIDATE=PASS'
note "ROLLBACK_TAG=$ROLLBACK_TAG"
note "CANDIDATE_TAG=$CANDIDATE_TAG"
note "CANDIDATE_IMAGE_ID=$CANDIDATE_ID"

verify_unchanged_services() {
  local b m mounts
  b="$(container_for backend)" || return 1
  m="$(container_for mysql)" || return 1
  [[ "$b" == "$BACKEND_ID" && "$m" == "$MYSQL_ID" ]] || return 1
  [[ "$(docker inspect --format '{{.Image}}' "$b")" == "$BACKEND_IMAGE_ID" ]] || return 1
  [[ "$(docker inspect --format '{{.Image}}' "$m")" == "$MYSQL_IMAGE_ID" ]] || return 1
  mounts="$(docker inspect --format '{{range .Mounts}}{{if .Name}}{{.Name}}:{{.Destination}};{{end}}{{end}}' "$m")" || return 1
  [[ "$mounts" == "$MYSQL_MOUNTS" ]] || return 1
  [[ "$(health_of "$b")" == 'running|healthy' && "$(health_of "$m")" == 'running|healthy' ]]
}
rollback_on_unexpected_error() {
  local status=$?
  trap - ERR
  if [[ "${DEPLOYMENT_STARTED:-0}" == '1' ]]; then
    note 'FALLO_INESPERADO=se intenta rollback exclusivo del frontend'
    restore_frontend || true
  fi
  exit "$status"
}
restore_frontend() {
  set +e
  docker tag "$CURRENT_ID" "$IMAGE_REF" >/dev/null 2>&1
  "${COMPOSE[@]}" up --detach --no-deps --no-build --pull never frontend >/dev/null 2>&1
  local restored
  restored="$(wait_healthy frontend 2>/dev/null)"
  [[ -n "$restored" ]] || { note 'ROLLBACK=FAIL; frontend no volvió a healthy'; return 1; }
  [[ "$(docker inspect --format '{{.Image}}' "$restored")" == "$CURRENT_ID" ]] || { note 'ROLLBACK=FAIL; imagen anterior no restaurada'; return 1; }
  verify_unchanged_services || { note 'ROLLBACK=FAIL; backend/MySQL requieren inspección'; return 1; }
  note 'ROLLBACK=PASS; solo frontend restaurado'
  return 0
}
deployment_failed() {
  local why="$1"
  trap - ERR
  note "VERIFICACION=FAIL ($why)"
  restore_frontend || true
  exit 1
}

FRONT_NOW="$(container_for frontend)" || die 'El frontend cambió antes del despliegue.'
[[ "$FRONT_NOW" == "$FRONT_ID" && "$(docker inspect --format '{{.Image}}' "$FRONT_NOW")" == "$CURRENT_ID" ]] || die 'La imagen frontend activa cambió durante la preparación.'
verify_unchanged_services || die 'Backend o MySQL cambió durante la preparación.'
DEPLOYMENT_STARTED=1
trap rollback_on_unexpected_error ERR
docker tag "$CANDIDATE_ID" "$IMAGE_REF" >/dev/null 2>&1 || deployment_failed 'no se pudo asignar la imagen Compose'
"${COMPOSE[@]}" up --detach --no-deps --no-build --pull never frontend >"$STAGE/compose-up.log" 2>&1 || deployment_failed 'Compose no pudo recrear frontend'
NEW_FRONT_ID="$(wait_healthy frontend 2>/dev/null)" || deployment_failed 'frontend no quedó healthy'
[[ "$(docker inspect --format '{{.Image}}' "$NEW_FRONT_ID")" == "$CANDIDATE_ID" ]] || deployment_failed 'frontend activo no usa la candidata'
verify_unchanged_services || deployment_failed 'backend, MySQL o volumen cambió inesperadamente'

PUBLIC="$STAGE/public"
mkdir -m 0700 "$PUBLIC"
http_get() {
  local url="$1" output="$2" code
  code="$(curl --silent --show-error --fail --location --resolve softventaweb.com:443:127.0.0.1 --max-time 20 --output "$output" --write-out '%{http_code}' "$url" 2>/dev/null)" || return 1
  [[ "$code" == '200' ]]
}
http_get 'https://softventaweb.com/' "$PUBLIC/index.html" || deployment_failed 'HTTPS de la página de login no respondió 200'
grep -Fq 'width="220" height="56"' "$PUBLIC/index.html" || deployment_failed 'HTML HTTPS no contiene el tamaño seguro del logo'
grep -Fq 'id="loginForm"' "$PUBLIC/index.html" || deployment_failed 'El formulario de login no está presente en el HTML servido'
http_get 'https://softventaweb.com/styles.css' "$PUBLIC/styles.css" || deployment_failed 'CSS público no respondió 200'
grep -Fq 'softventa-login-logo-bounds:v1' "$PUBLIC/styles.css" || deployment_failed 'CSS público no contiene la corrección del logo'
http_get 'https://softventaweb.com/service-worker.js' "$PUBLIC/service-worker.js" || deployment_failed 'Service worker no respondió 200'
grep -Fq 'softventaweb-logo.webp' "$PUBLIC/service-worker.js" || deployment_failed 'El service worker no precarga el logo'
http_get 'https://softventaweb.com/assets/pwa/softventaweb-logo.webp' "$PUBLIC/logo.webp" || deployment_failed 'El logo público no respondió 200'
http_get 'https://softventaweb.com/assets/pwa/favicon-32.png' "$PUBLIC/favicon.png" || deployment_failed 'El favicon público no respondió 200'
API_CODE="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --resolve softventaweb.com:443:127.0.0.1 --max-time 20 'https://softventaweb.com/api/health' 2>/dev/null)" || deployment_failed 'No se pudo comprobar la API por HTTPS'
[[ "$API_CODE" == '200' ]] || deployment_failed 'API health no respondió 200'
verify_unchanged_services || deployment_failed 'Verificación final de backend/MySQL/volumen falló'
[[ "$(health_of "$NEW_FRONT_ID")" == 'running|healthy' ]] || deployment_failed 'El healthcheck final del frontend falló'
[[ "$(image_id 'pos-frontend:rollback-rc6')" == 'sha256:31d1c752a9df5c702588fad3a6bdc13ba7971754b24bd70808cde52688fcfad0' ]] || deployment_failed 'La imagen rollback-rc6 fue alterada inesperadamente'
note 'DEPLOY=PASS'
note 'HTTPS=200; API_HEALTH=200; LOGO=200; FAVICON=200; FRONTEND=healthy; BACKEND/MySQL=unchanged-and-healthy'
note "ACTIVE_FRONTEND_IMAGE_ID=$CANDIDATE_ID"
note "ROLLBACK_IMAGE_TAG=$ROLLBACK_TAG"
'@

$PatchLogo = @'
#!/usr/bin/env python3
import hashlib
import json
import re
import sys
from pathlib import Path

MARKER = 'softventa-login-logo-bounds:v1'
CSS_RULES = '''\n/* softventa-login-logo-bounds:v1 */\n.login-card h1.login-logo { display:flex; justify-content:center; width:100%; margin:0 auto .45rem; line-height:0; }\n.login-card h1.login-logo img { display:block; width:min(100%,260px); max-width:100%; height:auto; max-height:66px; object-fit:contain; }\n@media (max-width:640px) { .login-card h1.login-logo { margin-bottom:.35rem; } .login-card h1.login-logo img { width:min(100%,220px); max-height:56px; } }\n'''

def set_attr(tag, name, value):
    pattern = re.compile(r'(?<![\w:-])' + re.escape(name) + r'\s*=\s*(?:"[^"]*"|\'[^\']*\'|[^\s>]+)', re.I)
    matches = list(pattern.finditer(tag))
    if len(matches) > 1:
        raise ValueError('atributo duplicado en la imagen objetivo')
    replacement = f'{name}="{value}"'
    if matches:
        return tag[:matches[0].start()] + replacement + tag[matches[0].end():]
    return tag[:-1].rstrip() + ' ' + replacement + '>'

def patch(index_path, css_path, worker_path, root):
    index_bytes = index_path.read_bytes()
    index = index_bytes.decode('utf-8')
    images = re.findall(r'<img\b(?=[^>]*\bsrc=["\']/assets/pwa/softventaweb-logo\.webp["\'])[^>]*>', index, re.I)
    if len(images) != 1:
        raise ValueError('no existe exactamente un logo oficial esperado')
    tag = set_attr(set_attr(images[0], 'width', '220'), 'height', '56')
    index = index.replace(images[0], tag, 1)
    if index.count('src="/assets/pwa/softventaweb-logo.webp"') != 1:
        raise ValueError('la referencia del logo cambió de forma inesperada')
    index_path.write_bytes(index.encode('utf-8'))

    css_bytes = css_path.read_bytes()
    css = css_bytes.decode('utf-8')
    if MARKER not in css:
        newline = '\r\n' if b'\r\n' in css_bytes else '\n'
        css = css.rstrip('\r\n') + CSS_RULES.replace('\n', newline)
        css_path.write_bytes(css.encode('utf-8'))
    elif '.login-card h1.login-logo img' not in css:
        raise ValueError('marcador de CSS presente con reglas incompletas')

    worker_bytes = worker_path.read_bytes()
    worker = worker_bytes.decode('utf-8')
    cache_match = re.search(r"const CACHE_NAME = 'pos-pwa-shell-([a-f0-9]{16})';", worker)
    list_match = re.search(r'const PRECACHE_URLS = (\[.*?\]);', worker, re.S)
    if not cache_match or not list_match:
        raise ValueError('el service worker publicado no tiene la estructura esperada')
    urls = json.loads(list_match.group(1))
    if not isinstance(urls, list) or not urls or any(not isinstance(u, str) or not u.startswith('/') or '..' in u for u in urls):
        raise ValueError('lista de precarga inválida')
    template, c1 = re.subn(r"const CACHE_NAME = 'pos-pwa-shell-[a-f0-9]{16}';", "const CACHE_NAME = '__POS_CACHE_NAME__';", worker, count=1)
    template, c2 = re.subn(r'const PRECACHE_URLS = \[.*?\];', 'const PRECACHE_URLS = __POS_PRECACHE_URLS__;', template, count=1, flags=re.S)
    if c1 != 1 or c2 != 1:
        raise ValueError('no se pudo reconstruir la plantilla segura del service worker')
    digest = hashlib.sha256()
    digest.update(template.encode('utf-8'))
    for url in sorted(urls):
        if url == '/service-worker.js':
            raise ValueError('el service worker no debe precargarse a sí mismo')
        static_file = root / url.lstrip('/')
        if not static_file.is_file():
            raise ValueError('falta un archivo listado en la precarga offline')
        digest.update(url.encode('utf-8'))
        digest.update(static_file.read_bytes())
    revision = digest.hexdigest()[:16]
    compact_urls = json.dumps(urls, ensure_ascii=False, separators=(',', ':'))
    rebuilt = template.replace('__POS_CACHE_NAME__', 'pos-pwa-shell-' + revision).replace('__POS_PRECACHE_URLS__', compact_urls)
    if '__POS_CACHE_NAME__' in rebuilt or '__POS_PRECACHE_URLS__' in rebuilt:
        raise ValueError('no se completó la revisión del service worker')
    worker_path.write_bytes(rebuilt.encode('utf-8'))

def self_test():
    import tempfile
    with tempfile.TemporaryDirectory(prefix='pos-logo-patch-test-') as d:
        root = Path(d)
        (root / 'assets/pwa').mkdir(parents=True)
        (root / 'index.html').write_text('<h1 class="login-logo"><img src="/assets/pwa/softventaweb-logo.webp" width="1440" height="366"></h1>\n', encoding='utf-8')
        (root / 'styles.css').write_text('.login-card { color: navy; }\n', encoding='utf-8')
        (root / 'service-worker.js').write_text("const CACHE_NAME = 'pos-pwa-shell-0123456789abcdef';\nconst PRECACHE_URLS = [\"/index.html\",\"/styles.css\"];\n", encoding='utf-8')
        (root / 'index.html').write_text((root / 'index.html').read_text(encoding='utf-8'), encoding='utf-8')
        (root / 'styles.css').write_text((root / 'styles.css').read_text(encoding='utf-8'), encoding='utf-8')
        (root / 'service-worker.js').write_text((root / 'service-worker.js').read_text(encoding='utf-8'), encoding='utf-8')
        # The generated precache hashes the complete listed file set.
        (root / 'assets/pwa/softventaweb-logo.webp').write_bytes(b'fixture-logo')
        # Use the real asset list expected by the updater's algorithm.
        worker = root / 'service-worker.js'
        worker.write_text("const CACHE_NAME = 'pos-pwa-shell-0123456789abcdef';\nconst PRECACHE_URLS = [\"/index.html\",\"/styles.css\",\"/assets/pwa/softventaweb-logo.webp\"];\n", encoding='utf-8')
        patch(root / 'index.html', root / 'styles.css', worker, root)
        assert 'width="220" height="56"' in (root / 'index.html').read_text(encoding='utf-8')
        assert MARKER in (root / 'styles.css').read_text(encoding='utf-8')
        assert 'pos-pwa-shell-0123456789abcdef' not in worker.read_text(encoding='utf-8')
        assert 'softventaweb-logo.webp' in worker.read_text(encoding='utf-8')
    print('PATCH_SELF_TEST=PASS')

if __name__ == '__main__':
    if sys.argv[1:] == ['--self-test']:
        self_test()
    elif len(sys.argv) == 5:
        try:
            patch(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]))
            print('STATIC_PATCH=PASS')
        except Exception as exc:
            print('STATIC_PATCH=FAIL: ' + str(exc), file=sys.stderr)
            raise SystemExit(1)
    else:
        raise SystemExit('uso: patch-logo.py INDEX CSS SERVICE_WORKER STATIC_ROOT | --self-test')
'@

if ($SelfTest) {
    if ($DiagnoseCandidateOnly -or $Deploy) { throw 'Usá SelfTest, DiagnoseCandidateOnly o Deploy, no los combines.' }
    if ($RemoteDeploy.Contains('docker run --rm --network none --entrypoint nginx')) { throw 'La prueba nginx -t no debe ejecutarse sin la red de servicio.' }
    if (-not $RemoteDeploy.Contains('docker run --rm --network "$EDGE_NETWORK" --entrypoint nginx')) { throw 'No se encontró la prueba nginx -t sobre la red real.' }
    $diagnoseBranchIndex = $RemoteDeploy.IndexOf('if [[ "$MODE" == ''diagnose-candidate'' ]]')
    $productionTagIndex = $RemoteDeploy.IndexOf('docker tag "$CANDIDATE_ID" "$IMAGE_REF"')
    $composeUpIndex = $RemoteDeploy.IndexOf('${COMPOSE[@]}" up --detach --no-deps --no-build --pull never frontend')
    if ($diagnoseBranchIndex -lt 0 -or $productionTagIndex -lt 0 -or $composeUpIndex -lt 0 -or $diagnoseBranchIndex -gt $productionTagIndex -or $diagnoseBranchIndex -gt $composeUpIndex) {
        throw 'La ruta de diagnóstico debe terminar antes de modificar la etiqueta de producción o recrear frontend.'
    }
    $stage = Join-Path $env:TEMP ('pos-logo-script-selftest-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage | Out-Null
    try {
        $remotePath = Join-Path $stage 'remote-deploy.sh'
        $patchPath = Join-Path $stage 'patch-logo.py'
        [IO.File]::WriteAllText($remotePath, $RemoteDeploy, [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText($patchPath, $PatchLogo, [Text.UTF8Encoding]::new($false))
        $parseTokens = $null
        $parseErrors = $null
        [System.Management.Automation.Language.Parser]::ParseFile($PSCommandPath, [ref]$parseTokens, [ref]$parseErrors) | Out-Null
        if ($parseErrors.Count) { throw 'La sintaxis de PowerShell no es válida.' }
        $sshExe = (Get-Command ssh.exe -ErrorAction Stop).Source
        $scpExe = (Get-Command scp.exe -ErrorAction Stop).Source
        $syntaxRemote = "/home/posadmin/.pos-logo-syntax-$([guid]::NewGuid().ToString('N')).sh"
        $syntaxCopyOk = $false
        try {
            & $scpExe -o BatchMode=yes -o StrictHostKeyChecking=yes $remotePath "${Target}:$syntaxRemote"
            if ($LASTEXITCODE -ne 0) { throw 'No se pudo copiar el helper temporal para bash -n.' }
            $syntaxCopyOk = $true
            & $sshExe -o BatchMode=yes -o StrictHostKeyChecking=yes $Target "bash -n '$syntaxRemote'"
            if ($LASTEXITCODE -ne 0) { throw 'bash -n remoto rechazó el helper.' }
            & $sshExe -o BatchMode=yes -o StrictHostKeyChecking=yes $Target "bash '$syntaxRemote' --self-test"
            if ($LASTEXITCODE -ne 0) { throw 'Fallaron las pruebas remotas de clasificación de nginx.' }
        }
        finally {
            if ($syntaxCopyOk) {
                & $sshExe -o BatchMode=yes -o StrictHostKeyChecking=yes $Target "rm -f -- '$syntaxRemote'" | Out-Null
            }
        }
        $python = Get-Command py.exe -ErrorAction Stop
        & $python.Source -3 $patchPath --self-test
        if ($LASTEXITCODE -ne 0) { throw 'Falló el self-test del parcheador.' }
        $archive = Join-Path $stage 'bundle.tar.gz'
        & tar.exe -czf $archive -C $stage remote-deploy.sh patch-logo.py
        if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear el paquete de prueba.' }
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
        if ($hash.Length -ne 64) { throw 'El SHA-256 del paquete de prueba no es válido.' }
        Write-Output 'POWERSHELL_SYNTAX=PASS'
        Write-Output 'BASH_SYNTAX=PASS'
        Write-Output 'PATCHER_SELF_TEST=PASS'
        Write-Output 'PACKAGE_SHA256=PASS'
    }
    finally {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
    exit 0
}

if ($DiagnoseCandidateOnly -and $Deploy) { throw 'No combines DiagnoseCandidateOnly y Deploy.' }
if (-not $DiagnoseCandidateOnly -and -not $Deploy) { throw 'Elegí explícitamente -DiagnoseCandidateOnly o -Deploy.' }

$ssh = (Get-Command ssh.exe -ErrorAction Stop).Source
$scp = (Get-Command scp.exe -ErrorAction Stop).Source
$tar = (Get-Command tar.exe -ErrorAction Stop).Source
$runId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$remoteDir = "/home/posadmin/pos-logo-update-$runId"
$remoteArchive = "$remoteDir/bundle.tar.gz"
$localStage = Join-Path $env:TEMP "pos-logo-deploy-$runId"
New-Item -ItemType Directory -Path $localStage | Out-Null
try {
    $remotePath = Join-Path $localStage 'remote-deploy.sh'
    $patchPath = Join-Path $localStage 'patch-logo.py'
    [IO.File]::WriteAllText($remotePath, $RemoteDeploy, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($patchPath, $PatchLogo, [Text.UTF8Encoding]::new($false))
    $archive = Join-Path $localStage 'bundle.tar.gz'
    & $tar -czf $archive -C $localStage remote-deploy.sh patch-logo.py
    if ($LASTEXITCODE -ne 0) { throw 'Falló la creación del paquete.' }
    $packageHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
    $scriptHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $remotePath).Hash.ToLowerInvariant()
    $patchHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $patchPath).Hash.ToLowerInvariant()
    if ($packageHash -notmatch '^[a-f0-9]{64}$') { throw 'SHA-256 local del paquete inválido.' }

    $identity = & $ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 $Target 'id -un'
    if ($LASTEXITCODE -ne 0 -or ($identity -join '').Trim() -ne 'posadmin') { throw 'No se pudo verificar la conexión SSH por clave como posadmin.' }
    $createRemote = "mkdir -m 700 -- '$remoteDir'"
    & $ssh -o BatchMode=yes -o StrictHostKeyChecking=yes $Target $createRemote
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear el directorio temporal privado del paquete en el VPS.' }
    & $scp -o BatchMode=yes -o StrictHostKeyChecking=yes $archive "${Target}:$remoteArchive"
    if ($LASTEXITCODE -ne 0) { throw 'Falló la transferencia del paquete por SSH.' }
    $extractRemote = "tar -xzf '$remoteArchive' -C '$remoteDir' && chmod 700 '$remoteDir/remote-deploy.sh' && chmod 600 '$remoteDir/patch-logo.py' && sha256sum '$remoteArchive' '$remoteDir/remote-deploy.sh' '$remoteDir/patch-logo.py'"
    $remoteHashes = & $ssh -o BatchMode=yes -o StrictHostKeyChecking=yes $Target $extractRemote
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo verificar el paquete transferido en el VPS.' }
    $hashLines = @($remoteHashes | ForEach-Object { if ($_ -match '^([a-f0-9]{64})\s+') { $Matches[1] } })
    if ($hashLines.Count -ne 3 -or $hashLines[0] -ne $packageHash -or $hashLines[1] -ne $scriptHash -or $hashLines[2] -ne $patchHash) {
        throw 'Los SHA-256 local y remoto no coinciden; no se invocó sudo ni se modificaron servicios.'
    }

    Write-Output "PAQUETE_SHA256_VERIFICADO=$packageHash"
    Write-Output 'Iniciando el helper remoto. sudo solicitará la contraseña en esta terminal; no se almacena ni se transmite como argumento.'
    $mode = if ($DiagnoseCandidateOnly) { 'diagnose-candidate' } else { 'deploy' }
    $remoteRun = "sudo bash '$remoteDir/remote-deploy.sh' '$remoteArchive' '$packageHash' '$runId' '$scriptHash' '$patchHash' '$ExpectedFrontendImage' '$mode'"
    & $ssh -tt -o BatchMode=yes -o StrictHostKeyChecking=yes $Target $remoteRun
    if ($LASTEXITCODE -ne 0) { throw 'El helper remoto se detuvo; revisá PREFLIGHT, NGINX_TEST, CAUSE o ROLLBACK.' }
    if ($DiagnoseCandidateOnly) { Write-Output 'DIAGNOSTICO_CANDIDATA=PASS' }
    else { Write-Output 'DESPLIEGUE_FRONTEND=PASS' }
}
finally {
    if (Test-Path -LiteralPath $localStage) {
        Remove-Item -LiteralPath $localStage -Recurse -Force -ErrorAction SilentlyContinue
    }
}
