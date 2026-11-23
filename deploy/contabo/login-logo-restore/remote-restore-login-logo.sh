#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

die() { printf 'DETENIDO: %s\n' "$1" >&2; exit 1; }
note() { printf '%s\n' "$1"; }
hash_file() { sha256sum -- "$1" | awk '{print $1}'; }
container_for() {
  local service="$1"; local -a ids=()
  mapfile -t ids < <(docker ps --quiet --filter 'label=com.docker.compose.project=pos-production' --filter "label=com.docker.compose.service=$service")
  [[ ${#ids[@]} -eq 1 ]] || return 1
  printf '%s' "${ids[0]}"
}
health_of() { docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$1" 2>/dev/null; }

MODE="${1:-}"
PACKAGE="${2:-}"
EXPECTED_PACKAGE_SHA="${3:-}"
EXPECTED_HELPER_SHA="${4:-}"
ROLLBACK_IMAGE="${5:-}"
if [[ "$MODE" == '--self-test' ]]; then
  grep -Fq 'class="login-softventa-logo"' "$0" || exit 1
  grep -Fq 'pos-frontend:rollback-pre-login-logo-' "$0" || exit 1
  grep -Fq 'LOGIN_LOGO_POSTCHECK=PASS' "$0" || exit 1
  printf 'REMOTE_LOGIN_LOGO_SELF_TEST=PASS\n'
  exit 0
fi

[[ "$MODE" == '--prepare-only' || "$MODE" == '--deploy' || "$MODE" == '--rollback' ]] || die 'Modo no reconocido.'
[[ "$PACKAGE" =~ ^/home/posadmin/\.pos-login-logo-[a-f0-9]{16}/login-overlay\.tar\.gz$ ]] || die 'Ruta de paquete temporal inválida.'
[[ "$EXPECTED_PACKAGE_SHA" =~ ^[a-f0-9]{64}$ && "$EXPECTED_HELPER_SHA" =~ ^[a-f0-9]{64}$ ]] || die 'Falta una huella SHA-256 válida.'
[[ -f "$PACKAGE" && ! -L "$PACKAGE" && -f "$0" && ! -L "$0" ]] || die 'No se encuentran los archivos transferidos esperados.'
[[ "$(stat -c '%U:%G:%a' "$PACKAGE")" == 'posadmin:posadmin:600' ]] || die 'El paquete no conserva propietario y permisos esperados.'
[[ "$(stat -c '%U:%G:%a' "$0")" == 'posadmin:posadmin:600' ]] || die 'El helper no conserva propietario y permisos esperados.'
[[ "$(hash_file "$PACKAGE")" == "$EXPECTED_PACKAGE_SHA" && "$(hash_file "$0")" == "$EXPECTED_HELPER_SHA" ]] || die 'Las huellas SHA-256 no coinciden.'

WORK="$(mktemp -d /tmp/pos-login-logo.XXXXXX)"
FRONT_ID=""; BACKEND_ID=""; MYSQL_ID=""; ORIGINAL_ID=""; PRODUCTION_IMAGE=""; ROLLBACK_TAG=""
VALIDATION_ID=""; VALIDATION_NAME=""; DEPLOY_MUTATION_STARTED=0; DEPLOY_OK=0
COMPOSE=(); MYSQL_MOUNTS=""; PORT=""
cleanup() {
  local rc=$?
  if [[ -n "$VALIDATION_ID" ]]; then
    local found
    found="$(docker inspect --format '{{.Id}}' "$VALIDATION_NAME" 2>/dev/null || true)"
    if [[ "$found" == "$VALIDATION_ID" ]]; then docker rm --force "$VALIDATION_ID" >/dev/null 2>&1 || true; fi
  fi
  if [[ "$DEPLOY_MUTATION_STARTED" == 1 && "$DEPLOY_OK" != 1 ]]; then
    note 'RECOVERY=START; únicamente frontend'
    if [[ -n "$ORIGINAL_ID" && -n "$PRODUCTION_IMAGE" && ${#COMPOSE[@]} -gt 0 ]] && docker tag "$ORIGINAL_ID" "$PRODUCTION_IMAGE" && "${COMPOSE[@]}" up --detach --no-deps --force-recreate frontend >/dev/null 2>&1; then
      local restored_front restored_backend restored_mysql
      restored_front="$(container_for frontend 2>/dev/null || true)"
      restored_backend="$(container_for backend 2>/dev/null || true)"
      restored_mysql="$(container_for mysql 2>/dev/null || true)"
      if [[ -n "$restored_front" && "$(docker inspect --format '{{.Image}}' "$restored_front" 2>/dev/null || true)" == "$ORIGINAL_ID" \
        && "$restored_backend" == "$BACKEND_ID" && "$restored_mysql" == "$MYSQL_ID" \
        && "$(health_of "$restored_front" 2>/dev/null || true)" == 'running|healthy' ]]; then
        note 'ROLLBACK=PASS; imagen frontend anterior restaurada; backend/MySQL sin cambios'
      else
        note 'ROLLBACK=FAIL; no se pudo verificar la restauración; intervención manual requerida' >&2
        rc=1
      fi
    else
      note 'ROLLBACK=FAIL; no se pudo restaurar frontend; intervención manual requerida' >&2
      rc=1
    fi
  fi
  case "$WORK" in /tmp/pos-login-logo.*) rm -rf -- "$WORK" ;; *) note 'TEMP_CLEANUP=SKIP; ruta no permitida' ;; esac
  exit "$rc"
}
trap cleanup EXIT

[[ "$(id -u)" == 0 ]] || die 'El helper debe ejecutarse con sudo.'
[[ -d /opt/pos/app && -r /etc/pos/production.env ]] || die 'Falta el proyecto o el env-file de producción.'
[[ "$(stat -c '%U:%G:%a' /etc/pos/production.env)" == 'root:root:600' ]] || die 'production.env no conserva propietario y permisos esperados.'
command -v docker >/dev/null && docker compose version >/dev/null 2>&1 || die 'Docker Engine o Compose no disponibles.'
command -v curl >/dev/null && command -v tar >/dev/null && command -v sha256sum >/dev/null || die 'Faltan herramientas para validar el overlay.'

mapfile -t PACKAGE_FILES < <(tar -tzf "$PACKAGE" | LC_ALL=C sort)
EXPECTED_FILES=(Dockerfile apply-login-logo.sh)
[[ ${#PACKAGE_FILES[@]} -eq ${#EXPECTED_FILES[@]} ]] || die 'El paquete contiene archivos faltantes o adicionales.'
for i in "${!EXPECTED_FILES[@]}"; do [[ "${PACKAGE_FILES[$i]}" == "${EXPECTED_FILES[$i]}" ]] || die 'La lista del paquete no coincide con la allowlist.'; done
tar -xzf "$PACKAGE" -C "$WORK" --no-same-owner --no-same-permissions || die 'No se pudo extraer el overlay.'
grep -Fq 'COPY apply-login-logo.sh /tmp/apply-login-logo.sh' "$WORK/Dockerfile" || die 'Dockerfile no limita la copia al parche de login.'
grep -Fq 'RUN /bin/sh /tmp/apply-login-logo.sh' "$WORK/Dockerfile" || die 'Dockerfile no aplica el parche esperado.'

FRONT_ID="$(container_for frontend)" || die 'No se encontró exactamente un frontend activo.'
BACKEND_ID="$(container_for backend)" || die 'No se encontró exactamente un backend activo.'
MYSQL_ID="$(container_for mysql)" || die 'No se encontró exactamente un MySQL activo.'
for pair in "frontend:$FRONT_ID" "backend:$BACKEND_ID" "mysql:$MYSQL_ID"; do
  service="${pair%%:*}"; id="${pair#*:}"
  [[ "$(health_of "$id")" == 'running|healthy' ]] || die "El servicio $service no está healthy."
done
[[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$FRONT_ID")" == '/opt/pos/app' ]] || die 'Frontend no corresponde al proyecto esperado.'
CONFIG_RAW="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$FRONT_ID")"
IFS=',' read -r -a CONFIG_FILES <<< "$CONFIG_RAW"
[[ ${#CONFIG_FILES[@]} -eq 2 || ${#CONFIG_FILES[@]} -eq 3 ]] || die 'No se identificaron los archivos Compose activos.'
[[ "${CONFIG_FILES[0]}" == '/opt/pos/app/compose.yaml' && "${CONFIG_FILES[1]}" == '/opt/pos/app/compose.production.yaml' ]] || die 'Los archivos Compose activos no son los esperados.'
for file in "${CONFIG_FILES[@]}"; do [[ -r "$file" ]] || die 'Falta un archivo Compose activo.'; done
ENV_FILES=(/etc/pos/production.env)
if [[ ${#CONFIG_FILES[@]} -eq 3 ]]; then
  [[ "${CONFIG_FILES[2]}" == '/home/posadmin/pos-private-test.override.yaml' && -r /home/posadmin/pos-private-test.env ]] || die 'El override Compose activo no es el archivo privado conocido.'
  ENV_FILES+=(/home/posadmin/pos-private-test.env)
fi
COMPOSE=(docker compose --project-name pos-production --project-directory /opt/pos/app)
for env_file in "${ENV_FILES[@]}"; do COMPOSE+=(--env-file "$env_file"); done
for file in "${CONFIG_FILES[@]}"; do COMPOSE+=(-f "$file"); done
"${COMPOSE[@]}" config --quiet >/dev/null 2>&1 || die 'Compose config --quiet falló.'
COMPOSE_JSON="$WORK/compose.json"
"${COMPOSE[@]}" config --format json >"$COMPOSE_JSON" 2>/dev/null || die 'No se pudo revisar la configuración efectiva de Compose.'
python3 - "$COMPOSE_JSON" <<'PY' || die 'Compose no conserva los servicios y puertos privados esperados.'
import json, sys
cfg=json.load(open(sys.argv[1], encoding='utf-8')); services=cfg.get('services', {})
if not all(name in services for name in ('frontend','backend','mysql')): raise SystemExit(1)
front=services['frontend']
if front.get('image') != 'pos-frontend:production': raise SystemExit(1)
ports=front.get('ports') or []
if len(ports)!=1 or str(ports[0].get('published',''))!='8080' or ports[0].get('host_ip')!='127.0.0.1': raise SystemExit(1)
if services['backend'].get('ports') or services['mysql'].get('ports'): raise SystemExit(1)
PY
PRODUCTION_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$FRONT_ID")"
ORIGINAL_ID="$(docker inspect --format '{{.Image}}' "$FRONT_ID")"
[[ "$PRODUCTION_IMAGE" == 'pos-frontend:production' && "$(docker image inspect --format '{{.Id}}' "$PRODUCTION_IMAGE")" == "$ORIGINAL_ID" ]] || die 'La referencia production no coincide con la imagen frontend activa.'
MYSQL_MOUNTS="$(docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}@{{.Destination}};{{end}}{{end}}' "$MYSQL_ID")"
[[ "$MYSQL_MOUNTS" == *'pos-production_mysql_data@'* ]] || die 'No se identificó el volumen de datos esperado.'
[[ "$(docker network inspect --format '{{.Name}}' pos-production_edge 2>/dev/null)" == 'pos-production_edge' ]] || die 'No se encuentra la red activa del frontend.'

PRESERVED_PATHS='/etc/nginx/conf.d/default.conf /usr/share/nginx/html/app.js /usr/share/nginx/html/connected-auth.js /usr/share/nginx/html/connected-inventory.js /usr/share/nginx/html/connected-sales.js /usr/share/nginx/html/api-config.js /usr/share/nginx/html/inicio/index.html /usr/share/nginx/html/inicio/styles.css /usr/share/nginx/html/robots.txt /usr/share/nginx/html/sitemap.xml'
image_hashes() { docker run --rm --network none --entrypoint /bin/sh "$1" -ec "sha256sum $PRESERVED_PATHS"; }
docker run --rm --network none --entrypoint /bin/sh "$ORIGINAL_ID" -ec 'test -s /usr/share/nginx/html/index.html && test -s /usr/share/nginx/html/styles.css && test -s /usr/share/nginx/html/assets/pwa/softventaweb-logo.webp && grep -Fq "<div class=\"login-logo\"><div class=\"logo-icon\">POS</div></div>" /usr/share/nginx/html/index.html' || die 'La imagen activa no coincide con la base esperada o falta el logo.'
BASE_PRESERVED_HASHES="$(image_hashes "$ORIGINAL_ID")" || die 'No se pudieron fijar hashes de módulos y landing de la imagen activa.'
BASE_NGINX_SHA="$(docker run --rm --network none --entrypoint /bin/sh "$ORIGINAL_ID" -ec 'sha256sum /etc/nginx/conf.d/default.conf' | awk '{print $1}')" || die 'No se pudo fijar la configuración Nginx activa.'

BASE_TAG="pos-frontend:login-logo-base-${ORIGINAL_ID#sha256:}"
if docker image inspect "$BASE_TAG" >/dev/null 2>&1; then
  [[ "$(docker image inspect --format '{{.Id}}' "$BASE_TAG")" == "$ORIGINAL_ID" ]] || die 'La referencia de respaldo base apunta a otra imagen.'
else
  docker tag "$ORIGINAL_ID" "$BASE_TAG" || die 'No se pudo conservar la imagen frontend activa.'
fi
CANDIDATE_TAG="pos-frontend:login-logo-candidate-${EXPECTED_PACKAGE_SHA:0:8}-$(docker image inspect --format '{{.Id}}' "$ORIGINAL_ID" | cut -c 8-19)"
if [[ "$MODE" == '--rollback' ]]; then
  [[ "$ROLLBACK_IMAGE" =~ ^pos-frontend:rollback-pre-login-logo-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]] || die 'La etiqueta de rollback no tiene el formato esperado.'
  ROLLBACK_ID="$(docker image inspect --format '{{.Id}}' "$ROLLBACK_IMAGE" 2>/dev/null || true)"
  [[ -n "$ROLLBACK_ID" ]] || die 'No existe la imagen de rollback solicitada.'
  docker run --rm --network none --entrypoint /bin/sh "$ROLLBACK_ID" -ec 'grep -Fq "<div class=\"login-logo\"><div class=\"logo-icon\">POS</div></div>" /usr/share/nginx/html/index.html' || die 'La imagen elegida no contiene el login anterior esperado.'
  ROLLBACK_TAG="$ROLLBACK_IMAGE"
else
  docker build --pull=false --build-arg "BASE_IMAGE=$BASE_TAG" --build-arg "BASE_IMAGE_ID=$ORIGINAL_ID" --build-arg "PACKAGE_SHA256=$EXPECTED_PACKAGE_SHA" --tag "$CANDIDATE_TAG" "$WORK" >/dev/null || die 'Falló la construcción aislada de la candidata.'
  CANDIDATE_ID="$(docker image inspect --format '{{.Id}}' "$CANDIDATE_TAG")" || die 'No se identificó la imagen candidata.'
  [[ "$(docker image inspect --format '{{index .Config.Labels "org.softventa.login-logo.base-image-id"}}' "$CANDIDATE_ID")" == "$ORIGINAL_ID" ]] || die 'La candidata no usa la imagen activa como base.'
  [[ "$(docker image inspect --format '{{index .Config.Labels "org.softventa.login-logo.package-sha256"}}' "$CANDIDATE_ID")" == "$EXPECTED_PACKAGE_SHA" ]] || die 'La candidata no conserva el hash aprobado.'
  [[ "$(image_hashes "$CANDIDATE_ID")" == "$BASE_PRESERVED_HASHES" ]] || die 'Cambió Nginx, los módulos, API estática, landing, robots o sitemap.'
  CANDIDATE_NGINX_SHA="$(docker run --rm --network none --entrypoint /bin/sh "$CANDIDATE_ID" -ec 'sha256sum /etc/nginx/conf.d/default.conf' | awk '{print $1}')"
  [[ "$CANDIDATE_NGINX_SHA" == "$BASE_NGINX_SHA" ]] || die 'Cambió la configuración Nginx.'
  docker run --rm --network none --entrypoint /bin/sh "$CANDIDATE_ID" -ec 'grep -Fq "class=\"login-softventa-logo\" src=\"/assets/pwa/softventaweb-logo.webp\"" /usr/share/nginx/html/index.html && grep -Fq ".login-softventa-logo" /usr/share/nginx/html/styles.css && ! grep -Fq "<div class=\"login-logo\"><div class=\"logo-icon\">POS</div></div>" /usr/share/nginx/html/index.html' || die 'La candidata no contiene el logo y CSS esperados.'
  docker run --rm --network pos-production_edge --entrypoint nginx "$CANDIDATE_ID" -t >/dev/null 2>&1 || die 'nginx -t falló en la candidata.'
fi

if [[ "$MODE" != '--rollback' ]]; then
  VALIDATION_NAME="pos-login-logo-check-$(date -u +%Y%m%dT%H%M%SZ)-${EXPECTED_PACKAGE_SHA:0:6}"
  PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')" || die 'No se pudo reservar un puerto loopback.'
  VALIDATION_ID="$(docker run --detach --name "$VALIDATION_NAME" --network pos-production_edge --publish "127.0.0.1:$PORT:80" "$CANDIDATE_ID")" || die 'No se pudo iniciar la candidata aislada.'
  [[ "$(docker port "$VALIDATION_ID" 80/tcp)" == "127.0.0.1:$PORT" ]] || die 'La candidata no quedó limitada a loopback.'
  for _ in $(seq 1 30); do curl --silent --fail --output /dev/null "http://127.0.0.1:$PORT/" && break || sleep 1; done
  for mode in connected local; do
    HEADERS="$WORK/$mode.headers"; BODY="$WORK/$mode.html"
    curl --silent --show-error --fail --max-time 10 --dump-header "$HEADERS" --output "$BODY" "http://127.0.0.1:$PORT/?mode=$mode&svcheck=$EXPECTED_PACKAGE_SHA" || die "Falló /?mode=$mode en la candidata."
    grep -Eiq '^Content-Type:[[:space:]]*text/html' "$HEADERS" || die "La vista $mode no respondió HTML."
    grep -Fq 'id="loginScreen"' "$BODY" && grep -Fq 'class="login-softventa-logo" src="/assets/pwa/softventaweb-logo.webp"' "$BODY" || die "Falta el logo en modo $mode."
    ! grep -Fq '<div class="login-logo"><div class="logo-icon">POS</div></div>' "$BODY" || die "Sigue el POS de texto en modo $mode."
  done
  curl --silent --show-error --fail --max-time 10 --dump-header "$WORK/login-css.headers" --output "$WORK/login-css.body" "http://127.0.0.1:$PORT/styles.css" || die 'No se sirve el CSS del POS.'
  grep -Eiq '^Content-Type:[[:space:]]*text/css' "$WORK/login-css.headers" && grep -Fq '.login-softventa-logo' "$WORK/login-css.body" || die 'Falta el CSS responsive del logo.'
  curl --silent --show-error --fail --max-time 10 --dump-header "$WORK/logo.headers" --output "$WORK/logo.webp" "http://127.0.0.1:$PORT/assets/pwa/softventaweb-logo.webp" || die 'No se sirve el logo.'
  grep -Eiq '^Content-Type:[[:space:]]*image/webp' "$WORK/logo.headers" && [[ -s "$WORK/logo.webp" ]] || die 'El logo no responde como image/webp con contenido.'
  curl --silent --show-error --fail --max-time 10 --dump-header "$WORK/landing.headers" --output "$WORK/landing.html" "http://127.0.0.1:$PORT/inicio/" || die 'La landing no responde.'
  grep -Eiq '^Content-Type:[[:space:]]*text/html' "$WORK/landing.headers" && grep -Fq 'rel="canonical" href="https://softventaweb.com/inicio/"' "$WORK/landing.html" || die 'La landing no conserva el HTML esperado.'
  curl --silent --show-error --fail --max-time 10 --dump-header "$WORK/landing-css.headers" --output "$WORK/landing-css.body" "http://127.0.0.1:$PORT/inicio/styles.css" || die 'Falta el CSS de la landing.'
  grep -Eiq '^Content-Type:[[:space:]]*text/css' "$WORK/landing-css.headers" || die 'El CSS de la landing no se sirve como text/css.'
  docker rm --force "$VALIDATION_ID" >/dev/null || die 'No se pudo retirar el contenedor de validación.'
  VALIDATION_ID=""
  note 'CANDIDATE_ROUTES=PASS; connected/local login image and CSS; WebP MIME; landing unchanged'
fi

if [[ "$MODE" == '--prepare-only' ]]; then
  note "PREPARE_ONLY=PASS; active_frontend=$ORIGINAL_ID; candidate=$CANDIDATE_ID; running services unchanged"
  exit 0
fi

if [[ "$MODE" == '--rollback' ]]; then
  TARGET_ID="$ROLLBACK_ID"
  note "ROLLBACK_TARGET=$ROLLBACK_IMAGE; image=$TARGET_ID"
else
  [[ -t 0 ]] || die 'La publicación requiere terminal interactiva.'
  read -r -p 'La candidata pasó todas las validaciones. Escriba PUBLICAR para cambiar solo frontend: ' CONFIRMATION
  [[ "$CONFIRMATION" == 'PUBLICAR' ]] || die 'No se confirmó la publicación; servicios siguen intactos.'
  TARGET_ID="$CANDIDATE_ID"
  UTC_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  ROLLBACK_TAG="pos-frontend:rollback-pre-login-logo-$UTC_STAMP-$(docker image inspect --format '{{.Id}}' "$ORIGINAL_ID" | cut -c 8-19)"
  docker image inspect "$ROLLBACK_TAG" >/dev/null 2>&1 && die 'La etiqueta de respaldo ya existe; no se sobrescribirá.'
  docker tag "$ORIGINAL_ID" "$ROLLBACK_TAG" || die 'No se pudo fijar el respaldo de la imagen frontend activa.'
  [[ "$(docker image inspect --format '{{.Id}}' "$ROLLBACK_TAG")" == "$ORIGINAL_ID" ]] || die 'La etiqueta de respaldo no apunta a la imagen activa.'
fi

[[ "$(docker inspect --format '{{.Image}}' "$BACKEND_ID")" != '' && "$(docker inspect --format '{{.Image}}' "$MYSQL_ID")" != '' ]] || die 'No se pudieron fijar las identidades backend/MySQL.'
DEPLOY_MUTATION_STARTED=1
docker tag "$TARGET_ID" "$PRODUCTION_IMAGE" || die 'No se pudo asignar la imagen frontend elegida.'
"${COMPOSE[@]}" up --detach --no-deps --force-recreate frontend >/dev/null || die 'Compose no pudo recrear únicamente frontend.'
for _ in $(seq 1 120); do
  FRONT_ID="$(container_for frontend 2>/dev/null || true)"
  [[ -n "$FRONT_ID" && "$(health_of "$FRONT_ID" 2>/dev/null || true)" == 'running|healthy' ]] && break
  sleep 2
done
[[ -n "$FRONT_ID" && "$(health_of "$FRONT_ID")" == 'running|healthy' ]] || die 'El frontend no quedó healthy.'
[[ "$(docker inspect --format '{{.Image}}' "$FRONT_ID")" == "$TARGET_ID" ]] || die 'El contenedor frontend no usa la imagen seleccionada.'
[[ "$(container_for backend)" == "$BACKEND_ID" && "$(container_for mysql)" == "$MYSQL_ID" ]] || die 'Cambió la identidad de backend o MySQL.'
[[ "$(health_of "$BACKEND_ID")" == 'running|healthy' && "$(health_of "$MYSQL_ID")" == 'running|healthy' ]] || die 'Backend o MySQL dejó de estar healthy.'
[[ "$(docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}@{{.Destination}};{{end}}{{end}}' "$MYSQL_ID")" == "$MYSQL_MOUNTS" ]] || die 'Cambió el volumen MySQL.'

if [[ "$MODE" == '--deploy' ]]; then
  for mode in connected local; do
    curl --silent --show-error --fail --max-time 20 --output "$WORK/public-$mode.html" "https://softventaweb.com/?mode=$mode&svcheck=$EXPECTED_PACKAGE_SHA" || die "La página pública no sirve modo $mode."
    grep -Fq 'class="login-softventa-logo" src="/assets/pwa/softventaweb-logo.webp"' "$WORK/public-$mode.html" || die "La respuesta pública de $mode no tiene el logo nuevo."
    ! grep -Fq '<div class="login-logo"><div class="logo-icon">POS</div></div>' "$WORK/public-$mode.html" || die "La respuesta pública de $mode conserva POS de texto."
  done
  curl --silent --show-error --fail --max-time 20 --dump-header "$WORK/public-logo.headers" --output "$WORK/public-logo.webp" "https://softventaweb.com/assets/pwa/softventaweb-logo.webp?svcheck=$EXPECTED_PACKAGE_SHA" || die 'El logo público no responde.'
  grep -Eiq '^Content-Type:[[:space:]]*image/webp' "$WORK/public-logo.headers" && [[ -s "$WORK/public-logo.webp" ]] || die 'El logo público no es una imagen WebP válida.'
  curl --silent --show-error --fail --max-time 20 --dump-header "$WORK/public-landing.headers" --output "$WORK/public-landing.html" 'https://softventaweb.com/inicio/' || die 'La landing pública dejó de responder.'
  grep -Fq 'rel="canonical" href="https://softventaweb.com/inicio/"' "$WORK/public-landing.html" || die 'Cambió la landing pública.'
  curl --silent --show-error --fail --max-time 20 --dump-header "$WORK/public-landing-css.headers" --output /dev/null 'https://softventaweb.com/inicio/styles.css' || die 'Falta el CSS público de la landing.'
  grep -Eiq '^Content-Type:[[:space:]]*text/css' "$WORK/public-landing-css.headers" || die 'El CSS público de la landing no es text/css.'
  curl --silent --show-error --fail --max-time 20 --output /dev/null https://softventaweb.com/api/health || die 'La API dejó de responder tras el cambio frontend.'
  grep -Fq 'id="loginScreen"' "$WORK/public-connected.html" || die 'No está el formulario de login público.'
  note "LOGIN_LOGO_POSTCHECK=PASS; connected/local; logo=image/webp; landing intact; backend/MySQL unchanged"
  DEPLOY_OK=1
  note "DEPLOY=PASS; frontend=$TARGET_ID; rollback=$ROLLBACK_TAG; backend/mysql=unchanged"
else
  for mode in connected local; do
    curl --silent --show-error --fail --max-time 20 --output "$WORK/rollback-$mode.html" "https://softventaweb.com/?mode=$mode&svcheck=$EXPECTED_PACKAGE_SHA" || die "La página pública no responde en modo $mode tras el rollback."
    grep -Fq '<div class="login-logo"><div class="logo-icon">POS</div></div>' "$WORK/rollback-$mode.html" || die "No se verificó el HTML del frontend restaurado en modo $mode."
  done
  DEPLOY_OK=1
  note "ROLLBACK=PASS; frontend=$TARGET_ID; rollback-source=$ROLLBACK_IMAGE; backend/mysql=unchanged"
fi
