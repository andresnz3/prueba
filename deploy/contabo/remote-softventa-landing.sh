#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

die() { printf 'DETENIDO: %s\n' "$1" >&2; exit 1; }
note() { printf '%s\n' "$1"; }
hash_file() { sha256sum -- "$1" | awk '{print $1}'; }
validate_landing_csp() {
  local policy="$1" directive
  [[ -n "$policy" ]] || return 1
  for directive in "default-src 'self'" "script-src 'self'" "style-src 'self'" "img-src 'self'" "font-src 'self'" "connect-src 'self'"; do
    [[ "$policy" == *"$directive"* ]] || return 1
  done
  [[ "$policy" != *'unsafe-eval'* && "$policy" != *'https://'* && "$policy" != *'*'* ]]
}
container_for() {
  local service="$1"
  local -a ids=()
  mapfile -t ids < <(docker ps --quiet --filter 'label=com.docker.compose.project=pos-production' --filter "label=com.docker.compose.service=$service")
  [[ ${#ids[@]} -eq 1 ]] || return 1
  printf '%s' "${ids[0]}"
}
health_of() {
  docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$1" 2>/dev/null
}
label_of() { docker inspect --format "{{index .Config.Labels \"$2\"}}" "$1" 2>/dev/null; }
inspect_static_image() {
  local image="$1"
  docker run --rm --read-only --security-opt no-new-privileges:true --cap-drop ALL --network none --entrypoint /bin/sh "$image" -ec '
check_path() {
  name="$1"; path="$2"; expected_mode="$3"; kind="$4"
  if [ -e "$path" ]; then
    mode="$(stat -c %a "$path" 2>/dev/null || printf unknown)"
    if [ "$kind" = directory ]; then
      if [ "$mode" = "$expected_mode" ] && [ -r "$path" ] && [ -x "$path" ]; then result=PASS; else result=FAIL; fi
      readable=NO; searchable=NO
      [ -r "$path" ] && readable=YES || true
      [ -x "$path" ] && searchable=YES || true
      printf "CANDIDATE_CHECK=%s|exists=YES|mode=%s|readable=%s|searchable=%s|result=%s\n" "$name" "$mode" "$readable" "$searchable" "$result"
    else
      if [ "$mode" = "$expected_mode" ] && [ -r "$path" ]; then result=PASS; else result=FAIL; fi
      readable=NO; [ -r "$path" ] && readable=YES || true
      printf "CANDIDATE_CHECK=%s|exists=YES|mode=%s|readable=%s|result=%s\n" "$name" "$mode" "$readable" "$result"
    fi
  else
    printf "CANDIDATE_CHECK=%s|exists=NO|mode=missing|readable=NO|result=FAIL\n" "$name"
  fi
}
check_path landing-directory /usr/share/nginx/html/inicio 755 directory
check_path landing-html /usr/share/nginx/html/inicio/index.html 644 file
check_path landing-css /usr/share/nginx/html/inicio/styles.css 644 file
check_path robots-txt /usr/share/nginx/html/robots.txt 644 file
check_path sitemap-xml /usr/share/nginx/html/sitemap.xml 644 file
check_path softventa-logo /usr/share/nginx/html/assets/pwa/softventaweb-logo.webp 644 file
check_path favicon-16 /usr/share/nginx/html/assets/pwa/favicon-16.png 644 file
check_path favicon-32 /usr/share/nginx/html/assets/pwa/favicon-32.png 644 file
check_path favicon-48 /usr/share/nginx/html/assets/pwa/favicon-48.png 644 file
'
}
static_report_valid() {
  local report="$1" expected
  for expected in \
    'CANDIDATE_CHECK=landing-directory|exists=YES|mode=755|readable=YES|searchable=YES|result=PASS' \
    'CANDIDATE_CHECK=landing-html|exists=YES|mode=644|readable=YES|result=PASS' \
    'CANDIDATE_CHECK=landing-css|exists=YES|mode=644|readable=YES|result=PASS' \
    'CANDIDATE_CHECK=robots-txt|exists=YES|mode=644|readable=YES|result=PASS' \
    'CANDIDATE_CHECK=sitemap-xml|exists=YES|mode=644|readable=YES|result=PASS' \
    'CANDIDATE_CHECK=softventa-logo|exists=YES|mode=644|readable=YES|result=PASS' \
    'CANDIDATE_CHECK=favicon-16|exists=YES|mode=644|readable=YES|result=PASS' \
    'CANDIDATE_CHECK=favicon-32|exists=YES|mode=644|readable=YES|result=PASS' \
    'CANDIDATE_CHECK=favicon-48|exists=YES|mode=644|readable=YES|result=PASS'; do
    grep -Fqx "$expected" <<<"$report" || return 1
  done
  ! grep -q '|result=FAIL$' <<<"$report"
}
validate_html_no_event_handlers() {
  python3 -c 'import sys
from html.parser import HTMLParser

class AttributeScanner(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.handlers = set()
    def handle_starttag(self, tag, attrs):
        for name, _value in attrs:
            lowered = name.lower()
            if lowered.startswith("on") and len(lowered) > 2:
                self.handlers.add((tag.lower(), lowered))
    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

scanner = AttributeScanner()
scanner.feed(sys.stdin.read())
if scanner.handlers:
    for tag, attr in sorted(scanner.handlers):
        print(f"INLINE_HANDLER_FOUND;element={tag};attribute={attr}")
    raise SystemExit(1)
print("INLINE_HANDLER_CHECK=PASS")'
}
valid_sitemap_content_type() {
  local value="${1,,}"
  value="${value//$'\r'/}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  local pattern='^(application/xml|text/xml)([[:space:]]*;[[:space:]]*charset[[:space:]]*=[[:space:]]*([a-z0-9._-]+|"[a-z0-9._-]+"))?[[:space:]]*$'
  [[ "$value" =~ $pattern ]]
}
diagnose_prior_candidates() {
  local ref id base legacy_base found=0
  local -a refs=()
  mapfile -t refs < <(docker image ls --filter 'reference=pos-frontend:landing-candidate-*' --format '{{.Repository}}:{{.Tag}}' | LC_ALL=C sort -u)
  for ref in "${refs[@]}"; do
    id="$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true)"
    [[ -n "$id" ]] || continue
    base="$(label_of "$id" 'org.softventa.landing.base-image-id' || true)"
    legacy_base="$(label_of "$id" 'org.softventa.landing.base-image' || true)"
    if [[ "$base" == "$ORIGINAL_ID" || "$legacy_base" == "$ORIGINAL_ID" ]]; then
      found=1
      note "PREVIOUS_CANDIDATE_INSPECTION=$ref; image=$id; production_unchanged=yes"
      inspect_static_image "$id" || die 'No se pudo inspeccionar de forma aislada la imagen candidata anterior.'
    fi
  done
  [[ "$found" == 1 ]] || note 'PREVIOUS_CANDIDATE_INSPECTION=SKIP; no hay candidata anterior basada en el frontend activo'
}

MODE="${1:-}"
PACKAGE="${2:-}"
EXPECTED_PACKAGE_SHA="${3:-}"
EXPECTED_HELPER_SHA="${4:-}"
EXPECTED_CSP_SHA="${5:-}"

if [[ "$MODE" == '--self-test' ]]; then
  [[ "/home/posadmin/.pos-softventa-landing-0123456789abcdef/package.tar.gz" =~ ^/home/posadmin/\.pos-softventa-landing-[a-f0-9]{16}/package\.tar\.gz$ ]] || exit 1
  test "${EXPECTED_PACKAGE_SHA:-}" = '' || exit 1
  grep -Fq 'pos-production_edge' "$0" || exit 1
  grep -Fq 'docker compose' "$0" || exit 1
  grep -Fq 'chmod 755 /usr/share/nginx/html/inicio' "$0" || exit 1
  grep -Fq 'chmod 644 /usr/share/nginx/html/inicio/styles.css' "$0" || exit 1
  grep -Fq 'chmod 644 /usr/share/nginx/html/robots.txt' "$0" || exit 1
  grep -Fq 'chmod 644 /usr/share/nginx/html/sitemap.xml' "$0" || exit 1
  grep -Fq 'CANDIDATE_CHECK=softventa-logo' "$0" || exit 1
  grep -Fq 'assets/pwa/favicon-16.png' "$0" || exit 1
  grep -Fq 'assets/pwa/favicon-32.png' "$0" || exit 1
  grep -Fq 'assets/pwa/favicon-48.png' "$0" || exit 1
  grep -Fq 'assets/pwa/softventaweb-logo.webp' "$0" || exit 1
  pass_report=$'CANDIDATE_CHECK=landing-directory|exists=YES|mode=755|readable=YES|searchable=YES|result=PASS\nCANDIDATE_CHECK=landing-html|exists=YES|mode=644|readable=YES|result=PASS\nCANDIDATE_CHECK=landing-css|exists=YES|mode=644|readable=YES|result=PASS\nCANDIDATE_CHECK=robots-txt|exists=YES|mode=644|readable=YES|result=PASS\nCANDIDATE_CHECK=sitemap-xml|exists=YES|mode=644|readable=YES|result=PASS\nCANDIDATE_CHECK=softventa-logo|exists=YES|mode=644|readable=YES|result=PASS\nCANDIDATE_CHECK=favicon-16|exists=YES|mode=644|readable=YES|result=PASS\nCANDIDATE_CHECK=favicon-32|exists=YES|mode=644|readable=YES|result=PASS\nCANDIDATE_CHECK=favicon-48|exists=YES|mode=644|readable=YES|result=PASS'
  static_report_valid "$pass_report" || exit 1
  bad_report="${pass_report/landing-directory|exists=YES|mode=755/landing-directory|exists=YES|mode=700}"
  if static_report_valid "$bad_report"; then exit 1; fi
  if python3 -c 'import html.parser' >/dev/null 2>&1; then
  good_html_report="$(validate_html_no_event_handlers <<'HTML'
<meta name="description" content="Controlá tus ventas">
<a href="/" title="Iniciar sesión">Ir</a>
HTML
)" || exit 1
  [[ "$good_html_report" == 'INLINE_HANDLER_CHECK=PASS' ]] || exit 1
  if validate_html_no_event_handlers >/dev/null <<'HTML'; then
<button onclick="run()">Abrir</button>
HTML
    exit 1
  fi
  printf 'HTML_EVENT_ATTRIBUTE_FIXTURE_TEST=PASS\n'
  else
    printf 'HTML_EVENT_ATTRIBUTE_FIXTURE_TEST=SKIP;python3-unavailable-on-this-host\n'
  fi
  for mime in 'application/xml' 'application/xml; charset=utf-8' 'text/xml' 'text/xml; charset="UTF-8"'; do
    valid_sitemap_content_type "$mime" || exit 1
  done
  for mime in 'text/html' 'text/html; charset=utf-8' 'application/octet-stream' 'application/xmlp' 'application/xml; other=value' ''; do
    if valid_sitemap_content_type "$mime"; then exit 1; fi
  done
  printf 'SITEMAP_MIME_FIXTURE_TEST=PASS\n'
  printf 'STATIC_DIAGNOSTIC_FIXTURE_TEST=PASS\n'
  validate_landing_csp "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'" || exit 1
  if validate_landing_csp "default-src 'self'; script-src 'self' https://cdn.invalid; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'"; then exit 1; fi
  if grep -Eq 'docker[[:space:]]+(system[[:space:]]+prune|volume[[:space:]]+prune)|compose[[:space:]]+down[[:space:]]+-v|migrate(:|[[:space:]])' "$0"; then
    printf 'SELF_TEST=FAIL; destructive-or-migration-command-found\n' >&2
    exit 1
  fi
  printf 'REMOTE_LANDING_SELF_TEST=PASS\n'
  exit 0
fi

[[ "$MODE" == '--prepare-only' || "$MODE" == '--deploy' ]] || die 'Modo no reconocido.'
[[ "$PACKAGE" =~ ^/home/posadmin/\.pos-softventa-landing-[a-f0-9]{16}/package\.tar\.gz$ ]] || die 'La ruta del paquete temporal no es válida.'
[[ "$EXPECTED_PACKAGE_SHA" =~ ^[a-f0-9]{64}$ && "$EXPECTED_HELPER_SHA" =~ ^[a-f0-9]{64}$ && "$EXPECTED_CSP_SHA" =~ ^[a-f0-9]{64}$ ]] || die 'Falta una huella SHA-256 válida.'
[[ -f "$PACKAGE" && ! -L "$PACKAGE" ]] || die 'No se encuentra el paquete temporal esperado.'
[[ "$(stat -c '%U:%G:%a' "$PACKAGE")" == 'posadmin:posadmin:600' ]] || die 'Los permisos del paquete temporal no son los esperados.'
[[ "$(hash_file "$PACKAGE")" == "$EXPECTED_PACKAGE_SHA" ]] || die 'La huella del paquete transferido no coincide.'
[[ "$(hash_file "$0")" == "$EXPECTED_HELPER_SHA" ]] || die 'La huella del helper transferido no coincide.'

case "$PACKAGE" in
  /home/posadmin/.pos-softventa-landing-????????????????/package.tar.gz) ;;
  *) die 'El nombre del paquete temporal no pasó la validación.' ;;
esac

WORK="$(mktemp -d /tmp/pos-softventa-landing.XXXXXX)"
VALIDATION_NAME=""
VALIDATION_ID=""
FRONT_ID=""
BACKEND_ID=""
MYSQL_ID=""
ORIGINAL_ID=""
PRODUCTION_IMAGE=""
ROLLBACK_IMAGE=""
COMPOSE=()
DEPLOY_MUTATION_STARTED=0
DEPLOY_OK=0
TMP_HEADERS=''
TMP_BODY=''

cleanup() {
  local rc=$?
  if [[ -n "$VALIDATION_ID" ]]; then
    local current_validation_id
    current_validation_id="$(docker inspect --format '{{.Id}}' "$VALIDATION_NAME" 2>/dev/null || true)"
    if [[ -n "$current_validation_id" && "$current_validation_id" == "$VALIDATION_ID" ]]; then
      docker rm --force "$VALIDATION_ID" >/dev/null 2>&1 || true
    fi
  fi
  if [[ "$DEPLOY_MUTATION_STARTED" == 1 && "$DEPLOY_OK" != 1 ]]; then
    note 'RECOVERY=START; solo frontend'
    if [[ -n "$ORIGINAL_ID" && -n "$PRODUCTION_IMAGE" && ${#COMPOSE[@]} -gt 0 ]]; then
      if docker tag "$ORIGINAL_ID" "$PRODUCTION_IMAGE" && "${COMPOSE[@]}" up --detach --no-deps --force-recreate frontend >/dev/null 2>&1; then
        local rollback_front rollback_backend rollback_mysql
        rollback_front="$(container_for frontend 2>/dev/null || true)"
        rollback_backend="$(container_for backend 2>/dev/null || true)"
        rollback_mysql="$(container_for mysql 2>/dev/null || true)"
        if [[ -n "$rollback_front" && -n "$rollback_backend" && -n "$rollback_mysql" ]] \
          && [[ "$(docker inspect --format '{{.Image}}' "$rollback_front")" == "$ORIGINAL_ID" ]] \
          && [[ "$rollback_backend" == "$BACKEND_ID" && "$rollback_mysql" == "$MYSQL_ID" ]] \
          && [[ "$(health_of "$rollback_front")" == 'running|healthy' ]] \
          && [[ "$(health_of "$rollback_backend")" == 'running|healthy' ]] \
          && [[ "$(health_of "$rollback_mysql")" == 'running|healthy' ]]; then
          note 'ROLLBACK=PASS; frontend restaurado; backend/MySQL sin cambios'
        else
          note 'ROLLBACK=FAIL; preservar servicios y solicitar intervención'
          rc=1
        fi
      else
        note 'ROLLBACK=FAIL; no se pudo restaurar frontend; preservar servicios y solicitar intervención'
        rc=1
      fi
    else
      note 'ROLLBACK=FAIL; faltan referencias de recuperación'
      rc=1
    fi
  fi
  case "$WORK" in
    /tmp/pos-softventa-landing.*) rm -rf -- "$WORK" ;;
    *) note 'TEMP_CLEANUP=SKIP; ruta temporal fuera del prefijo permitido' ;;
  esac
  exit "$rc"
}
trap cleanup EXIT

[[ -d /opt/pos/app && -r /etc/pos/production.env ]] || die 'Falta el proyecto o el env-file de producción.'
[[ "$(stat -c '%U:%G:%a' /etc/pos/production.env)" == 'root:root:600' ]] || die 'production.env no conserva propietario y permisos aprobados.'
[[ -d /home/posadmin && -r /home/posadmin ]] || die 'No se puede verificar el directorio privado de posadmin.'
command -v docker >/dev/null && docker compose version >/dev/null 2>&1 || die 'Docker Engine o Compose no están disponibles.'
command -v curl >/dev/null || die 'curl no está disponible para las verificaciones HTTP.'
command -v tar >/dev/null && command -v sha256sum >/dev/null || die 'Faltan herramientas del sistema para validar el paquete.'

STAGE_OWNER="$(stat -c '%U' "$(dirname "$PACKAGE")")"
[[ "$STAGE_OWNER" == 'posadmin' ]] || die 'El directorio temporal de transferencia no pertenece a posadmin.'
mapfile -t PACKAGE_FILES < <(tar -tzf "$PACKAGE" | LC_ALL=C sort)
EXPECTED_FILES=(Dockerfile assets/pwa/favicon-16.png assets/pwa/favicon-32.png assets/pwa/favicon-48.png assets/pwa/softventaweb-logo.webp inicio/index.html inicio/styles.css robots.txt sitemap.xml)
[[ ${#PACKAGE_FILES[@]} -eq ${#EXPECTED_FILES[@]} ]] || die 'El paquete contiene archivos faltantes o adicionales.'
for i in "${!EXPECTED_FILES[@]}"; do
  [[ "${PACKAGE_FILES[$i]}" == "${EXPECTED_FILES[$i]}" ]] || die 'La lista del paquete no coincide exactamente con la permitida.'
done
tar -xzf "$PACKAGE" -C "$WORK" --no-same-owner --no-same-permissions || die 'No se pudo extraer el paquete aislado.'

grep -Fq '<title>SoftVentaWeb | Sistema POS para negocios</title>' "$WORK/inicio/index.html" || die 'El título de la landing no coincide.'
grep -Fq '<link rel="canonical" href="https://softventaweb.com/inicio/">' "$WORK/inicio/index.html" || die 'El canonical de la landing no coincide.'
grep -Fq '<a class="button button-small" href="/">Iniciar sesión</a>' "$WORK/inicio/index.html" || die 'El enlace de login no coincide.'
if grep -Eiq '<script|<iframe|<object|<embed' "$WORK/inicio/index.html"; then die 'La landing contiene un elemento activo no aprobado.'; fi
if grep -Eiq 'url\([^)]*https?://' "$WORK/inicio/styles.css"; then die 'La hoja de estilos contiene recursos externos.'; fi
grep -Fq 'Disallow: /api/' "$WORK/robots.txt" || die 'robots.txt no excluye la API.'
grep -Fq 'Sitemap: https://softventaweb.com/sitemap.xml' "$WORK/robots.txt" || die 'robots.txt no referencia el sitemap esperado.'
grep -Fq '<loc>https://softventaweb.com/inicio/</loc>' "$WORK/sitemap.xml" || die 'El sitemap no apunta a /inicio/.'
[[ "$(grep -o '<loc>' "$WORK/sitemap.xml" | wc -l | tr -d '[:space:]')" == 1 ]] || die 'El sitemap debe contener únicamente /inicio/.'
if grep -Eiq '/api/|system-admin|businesses|users' "$WORK/sitemap.xml"; then die 'El sitemap contiene una ruta interna no pública.'; fi

FRONT_ID="$(container_for frontend)" || die 'No se encontró exactamente un frontend activo.'
BACKEND_ID="$(container_for backend)" || die 'No se encontró exactamente un backend activo.'
MYSQL_ID="$(container_for mysql)" || die 'No se encontró exactamente un MySQL activo.'
for item in "frontend:$FRONT_ID" "backend:$BACKEND_ID" "mysql:$MYSQL_ID"; do
  service="${item%%:*}"; id="${item#*:}"
  [[ "$(health_of "$id")" == 'running|healthy' ]] || die "El servicio $service no está healthy."
done
[[ "$(label_of "$FRONT_ID" 'com.docker.compose.project')" == 'pos-production' ]] || die 'El frontend no pertenece al proyecto pos-production.'
[[ "$(label_of "$FRONT_ID" 'com.docker.compose.project.working_dir')" == '/opt/pos/app' ]] || die 'El frontend no usa el directorio de proyecto esperado.'
CONFIG_RAW="$(label_of "$FRONT_ID" 'com.docker.compose.project.config_files')" || die 'No se pudieron leer las etiquetas Compose del frontend.'
IFS=',' read -r -a CONFIG_FILES <<< "$CONFIG_RAW"
[[ ${#CONFIG_FILES[@]} -eq 2 || ${#CONFIG_FILES[@]} -eq 3 ]] || die 'El frontend no identifica dos o tres archivos Compose efectivos.'
[[ "${CONFIG_FILES[0]}" == '/opt/pos/app/compose.yaml' && "${CONFIG_FILES[1]}" == '/opt/pos/app/compose.production.yaml' ]] || die 'Los archivos Compose efectivos no corresponden al proyecto aprobado.'
if [[ ${#CONFIG_FILES[@]} -eq 3 ]]; then
  [[ "${CONFIG_FILES[2]}" == '/home/posadmin/pos-private-test.override.yaml' ]] || die 'El override Compose activo no es el archivo privado conocido.'
fi
for file in "${CONFIG_FILES[@]}"; do [[ -f "$file" && -r "$file" ]] || die 'Falta un archivo Compose efectivo.'; done

ENV_FILES=(/etc/pos/production.env)
if [[ ${#CONFIG_FILES[@]} -eq 3 ]]; then
  [[ -r /home/posadmin/pos-private-test.env ]] || die 'Falta el env-file requerido por el override privado.'
  ENV_FILES+=(/home/posadmin/pos-private-test.env)
fi
COMPOSE=(docker compose --project-name pos-production --project-directory /opt/pos/app)
for env_file in "${ENV_FILES[@]}"; do COMPOSE+=(--env-file "$env_file"); done
for file in "${CONFIG_FILES[@]}"; do COMPOSE+=(-f "$file"); done
COMPOSE_LOG="$WORK/compose-validation.log"
if ! "${COMPOSE[@]}" config --quiet >"$COMPOSE_LOG" 2>&1; then die 'Compose config --quiet falló; no se mostraron valores ni se modificaron servicios.'; fi
COMPOSE_JSON="$WORK/compose.json"
"${COMPOSE[@]}" config --format json >"$COMPOSE_JSON" 2>/dev/null || die 'No se pudo validar la estructura efectiva de Compose.'
if ! python3 - "$COMPOSE_JSON" <<'PY'
import json, sys
try:
    cfg=json.load(open(sys.argv[1], encoding='utf-8'))
    services=cfg.get('services', {})
    if not all(name in services for name in ('frontend','backend','mysql')):
        raise ValueError('missing service')
    front=services['frontend']
    if front.get('image') != 'pos-frontend:production':
        raise ValueError('unexpected frontend image reference')
    ports=front.get('ports') or []
    if len(ports) != 1 or str(ports[0].get('published','')) != '8080' or ports[0].get('host_ip') != '127.0.0.1':
        raise ValueError('frontend binding is not loopback 8080')
    if services['backend'].get('ports') or services['mysql'].get('ports'):
        raise ValueError('backend or mysql publishes a host port')
except Exception:
    raise SystemExit(1)
PY
then
  die 'Compose no conserva imagen frontend o puertos privados esperados.'
fi
PRODUCTION_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$FRONT_ID")"
ORIGINAL_ID="$(docker inspect --format '{{.Image}}' "$FRONT_ID")"
[[ "$PRODUCTION_IMAGE" == 'pos-frontend:production' ]] || die 'El frontend activo no usa la referencia de imagen production esperada.'
[[ "$(docker image inspect --format '{{.Id}}' "$PRODUCTION_IMAGE")" == "$ORIGINAL_ID" ]] || die 'La etiqueta production no coincide con la imagen frontend activa.'
[[ "$(docker inspect --format '{{.Image}}' "$BACKEND_ID")" != '' && "$(docker inspect --format '{{.Image}}' "$MYSQL_ID")" != '' ]] || die 'No se pudieron identificar las imágenes backend/MySQL.'
MYSQL_MOUNTS="$(docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}@{{.Destination}}{{";"}}{{end}}{{end}}' "$MYSQL_ID")"
[[ "$MYSQL_MOUNTS" == *'pos-production_mysql_data@'* ]] || die 'No se identificó el volumen principal de MySQL esperado.'
[[ "$(docker network inspect --format '{{.Name}}' pos-production_edge 2>/dev/null)" == 'pos-production_edge' ]] || die 'No se encuentra la red real del frontend.'
FRONT_NETWORKS="$(docker inspect --format '{{json .NetworkSettings.Networks}}' "$FRONT_ID")"
BACKEND_NETWORKS="$(docker inspect --format '{{json .NetworkSettings.Networks}}' "$BACKEND_ID")"
if ! python3 - pos-production_edge "$FRONT_NETWORKS" "$BACKEND_NETWORKS" <<'PY'
import json, sys
try:
    n=sys.argv[1]; front=json.loads(sys.argv[2]); backend=json.loads(sys.argv[3])
    if n not in front or n not in backend or 'backend' not in (backend[n].get('Aliases') or []):
        raise ValueError('network/alias')
except Exception:
    raise SystemExit(1)
PY
then
  die 'La red pos-production_edge no conserva la ruta frontend/backend esperada.'
fi
note "PREFLIGHT=PASS; frontend=$(health_of "$FRONT_ID"); backend=$(health_of "$BACKEND_ID"); mysql=$(health_of "$MYSQL_ID")"
note "COMPOSE=PASS; project=pos-production; files=${#CONFIG_FILES[@]}; env-files=${#ENV_FILES[@]}; values=hidden"
note "ACTIVE_FRONTEND_IMAGE=$ORIGINAL_ID"

BASELINE_HEADERS="$WORK/public-baseline.headers"
BASELINE_BODY="$WORK/public-baseline.body"
curl --silent --show-error --fail --max-time 20 --dump-header "$BASELINE_HEADERS" --output "$BASELINE_BODY" https://softventaweb.com/ || die 'No se pudo leer el sitio HTTPS público para validar la CSP activa.'
[[ "$(grep -ic '^Content-Security-Policy:' "$BASELINE_HEADERS" || true)" == 1 ]] || die 'El sitio público no devuelve exactamente una CSP activa.'
[[ "$(grep -ic '^Strict-Transport-Security:' "$BASELINE_HEADERS" || true)" == 1 ]] || die 'El sitio público no devuelve exactamente un HSTS activo.'
PUBLIC_CSP_POLICY="$(awk 'tolower($1)=="content-security-policy:" {sub(/^[^:]*:[[:space:]]*/, ""); gsub(/\r/, ""); sub(/[[:space:]]+$/, ""); print}' "$BASELINE_HEADERS")"
[[ "$(printf '%s' "$PUBLIC_CSP_POLICY" | sha256sum | awk '{print $1}')" == "$EXPECTED_CSP_SHA" ]] || die 'La CSP activa cambió desde el preflight de Windows.'
validate_landing_csp "$PUBLIC_CSP_POLICY" || die 'La CSP activa no permite con seguridad los recursos locales de la landing.'
grep -Eiq '^Strict-Transport-Security:[[:space:]]*max-age=[1-9][0-9]*' "$BASELINE_HEADERS" || die 'El HSTS activo no tiene max-age positivo.'
note 'PUBLIC_SECURITY_HEADERS=PASS; single CSP/HSTS; same-origin landing resources allowed'

if ! docker run --rm --network none --entrypoint /bin/sh "$ORIGINAL_ID" -ec 'test -r /usr/share/nginx/html/assets/pwa/pos-icon-512.png && test -r /usr/share/nginx/html/assets/pwa/pos-icon.svg && test -r /usr/share/nginx/html/vendor/fonts/inter-latin-wght-normal.woff2'; then
  die 'La imagen base no contiene los iconos y la fuente compartidos que el overlay no reemplaza.'
fi
BASE_NGINX_SHA="$(docker run --rm --network none --entrypoint /bin/sh "$ORIGINAL_ID" -ec 'sha256sum /etc/nginx/conf.d/default.conf' | awk '{print $1}')" || die 'No se pudo identificar la configuración Nginx de la imagen activa.'
BASE_INDEX_SHA="$(docker run --rm --network none --entrypoint /bin/sh "$ORIGINAL_ID" -ec 'sha256sum /usr/share/nginx/html/index.html' | awk '{print $1}')" || die 'No se pudo fijar la huella del POS activo.'

BASE_IMAGE_TAG="pos-frontend:landing-base-${ORIGINAL_ID#sha256:}"
if docker image inspect "$BASE_IMAGE_TAG" >/dev/null 2>&1; then
  [[ "$(docker image inspect --format '{{.Id}}' "$BASE_IMAGE_TAG")" == "$ORIGINAL_ID" ]] || die 'La referencia local de imagen base existe y apunta a otra imagen.'
else
  docker tag "$ORIGINAL_ID" "$BASE_IMAGE_TAG" || die 'No se pudo fijar una referencia local inmutable a la imagen activa.'
fi
CANDIDATE_SUFFIX="${EXPECTED_PACKAGE_SHA:0:8}-$(docker image inspect --format '{{.Id}}' "$ORIGINAL_ID" | cut -c 8-19)"
CANDIDATE_IMAGE="pos-frontend:landing-candidate-$CANDIDATE_SUFFIX"
diagnose_prior_candidates
if docker image inspect "$CANDIDATE_IMAGE" >/dev/null 2>&1; then
  [[ "$(docker image inspect --format '{{index .Config.Labels "org.softventa.landing.package-sha256"}}' "$CANDIDATE_IMAGE")" == "$EXPECTED_PACKAGE_SHA" ]] || die 'La etiqueta candidata existe con una huella de paquete diferente.'
else
  docker build --pull=false --build-arg "BASE_IMAGE=$BASE_IMAGE_TAG" --build-arg "BASE_IMAGE_ID=$ORIGINAL_ID" --build-arg "PACKAGE_SHA256=$EXPECTED_PACKAGE_SHA" --tag "$CANDIDATE_IMAGE" "$WORK" >/dev/null || die 'Falló la compilación aislada de la imagen candidata.'
fi
CANDIDATE_ID="$(docker image inspect --format '{{.Id}}' "$CANDIDATE_IMAGE")" || die 'No se pudo identificar la imagen candidata.'
[[ "$(docker image inspect --format '{{index .Config.Labels "org.softventa.landing.package-sha256"}}' "$CANDIDATE_ID")" == "$EXPECTED_PACKAGE_SHA" ]] || die 'La imagen candidata no conserva la huella del paquete aprobado.'
[[ "$(docker image inspect --format '{{index .Config.Labels "org.softventa.landing.base-image-id"}}' "$CANDIDATE_ID")" == "$ORIGINAL_ID" ]] || die 'La candidata no parte de la imagen frontend actualmente activa.'
CANDIDATE_NGINX_SHA="$(docker run --rm --network none --entrypoint /bin/sh "$CANDIDATE_ID" -ec 'sha256sum /etc/nginx/conf.d/default.conf' | awk '{print $1}')" || die 'No se pudo comprobar la configuración Nginx candidata.'
[[ "$CANDIDATE_NGINX_SHA" == "$BASE_NGINX_SHA" ]] || die 'La candidata modificó inesperadamente la configuración Nginx.'
CANDIDATE_INDEX_SHA="$(docker run --rm --network none --entrypoint /bin/sh "$CANDIDATE_ID" -ec 'sha256sum /usr/share/nginx/html/index.html' | awk '{print $1}')" || die 'No se pudo comprobar el HTML actual del POS.'
[[ "$CANDIDATE_INDEX_SHA" == "$BASE_INDEX_SHA" ]] || die 'El overlay modificó el HTML actual del POS.'
docker run --rm --network pos-production_edge --entrypoint nginx "$CANDIDATE_ID" -t >/dev/null 2>&1 || die 'nginx -t falló en la candidata usando pos-production_edge.'
STATIC_REPORT="$(inspect_static_image "$CANDIDATE_ID")" || die 'No se pudieron medir por separado existencia y permisos de los archivos públicos de la candidata.'
printf '%s\n' "$STATIC_REPORT"
static_report_valid "$STATIC_REPORT" || die 'La candidata incumple al menos una comprobación independiente de existencia o permisos.'

VALIDATION_NAME="pos-landing-candidate-$(date -u +%Y%m%dT%H%M%SZ)-${EXPECTED_PACKAGE_SHA:0:6}"
if docker container inspect "$VALIDATION_NAME" >/dev/null 2>&1; then die 'Ya existe un contenedor con el nombre temporal de validación.'; fi
PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')" || die 'No se pudo reservar un puerto loopback temporal.'
[[ "$PORT" =~ ^[0-9]{4,5}$ ]] || die 'El puerto loopback temporal no es válido.'
VALIDATION_ID="$(docker run --detach --name "$VALIDATION_NAME" --network pos-production_edge --publish "127.0.0.1:$PORT:80" "$CANDIDATE_ID")" || die 'No se pudo iniciar el contenedor temporal de validación.'
[[ "$(docker inspect --format '{{.HostConfig.Privileged}}' "$VALIDATION_ID")" == 'false' ]] || die 'La validación temporal obtuvo privilegios no esperados.'
[[ "$(docker port "$VALIDATION_ID" 80/tcp)" == "127.0.0.1:$PORT" ]] || die 'La candidata no está publicada exclusivamente en loopback.'
for _ in $(seq 1 30); do
  if curl --silent --show-error --fail --output /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then break; fi
  sleep 1
done
ROOT_HEADERS="$WORK/root.headers"; ROOT_BODY="$WORK/root.body"
curl --silent --show-error --fail --max-time 10 --dump-header "$ROOT_HEADERS" --output "$ROOT_BODY" "http://127.0.0.1:$PORT/" || die 'La ruta / del POS no responde en la candidata.'
[[ "$(sha256sum "$ROOT_BODY" | awk '{print $1}')" == "$BASE_INDEX_SHA" ]] || die 'La ruta / dejó de servir el HTML POS original.'
TMP_HEADERS="$WORK/candidate.headers"
TMP_BODY="$WORK/candidate.body"
curl --silent --show-error --fail --max-time 10 --dump-header "$TMP_HEADERS" --output "$TMP_BODY" "http://127.0.0.1:$PORT/inicio/" || die 'La ruta /inicio/ no responde 200 en la candidata.'
grep -Eiq '^Content-Type:[[:space:]]*text/html' "$TMP_HEADERS" || die 'La landing candidata no se sirve como HTML.'
[[ "$(grep -ic '^Content-Security-Policy:' "$TMP_HEADERS" || true)" == 0 ]] || die 'Nginx está agregando CSP; se detiene para evitar duplicarla con la política de Caddy.'
[[ "$(grep -ic '^Strict-Transport-Security:' "$TMP_HEADERS" || true)" == 0 ]] || die 'Nginx está agregando HSTS; se detiene para evitar duplicarlo con Caddy.'
# El candidato habla directamente con Nginx; CSP/HSTS se comprueban en la respuesta HTTPS
# de Caddy. La huella de la política pública se valida de nuevo después del despliegue.
[[ "$EXPECTED_CSP_SHA" =~ ^[a-f0-9]{64}$ ]] && validate_landing_csp "$PUBLIC_CSP_POLICY" || die 'La CSP pública no permite únicamente los recursos locales requeridos por la landing.'
grep -Fq '<title>SoftVentaWeb | Sistema POS para negocios</title>' "$TMP_BODY" || die 'El HTML servido por la candidata no contiene el título esperado.'
grep -Fq '<link rel="canonical" href="https://softventaweb.com/inicio/">' "$TMP_BODY" || die 'El HTML servido no contiene el canonical esperado.'
grep -Fq 'href="/"' "$TMP_BODY" || die 'El HTML servido no contiene el enlace de inicio de sesión.'
if grep -Eiq '<script|src="https?://' "$TMP_BODY"; then die 'El HTML servido solicita scripts o recursos externos.'; fi
validate_html_no_event_handlers < "$TMP_BODY" || die 'El HTML servido contiene un atributo real de manejador inline no aprobado.'
curl --silent --show-error --fail --max-time 10 --output /dev/null "http://127.0.0.1:$PORT/inicio/styles.css" || die 'Falta la hoja de estilos de la landing.'
for asset in /assets/pwa/softventaweb-logo.webp /assets/pwa/pos-icon-512.png /assets/pwa/favicon-16.png /assets/pwa/favicon-32.png /assets/pwa/favicon-48.png /assets/pwa/pos-icon.svg /vendor/fonts/inter-latin-wght-normal.woff2; do
  curl --silent --show-error --fail --max-time 10 --output /dev/null "http://127.0.0.1:$PORT$asset" || die "Falta un recurso local requerido: $asset"
done
TMP_HEADERS="$WORK/robots.headers"; TMP_BODY="$WORK/robots.body"
curl --silent --show-error --fail --max-time 10 --dump-header "$TMP_HEADERS" --output "$TMP_BODY" "http://127.0.0.1:$PORT/robots.txt" || die 'robots.txt no se sirve directamente.'
grep -Eiq '^Content-Type:[[:space:]]*text/plain' "$TMP_HEADERS" || die 'robots.txt no usa Content-Type text/plain.'
grep -Fq 'Sitemap: https://softventaweb.com/sitemap.xml' "$TMP_BODY" || die 'robots.txt no apunta al sitemap esperado.'
TMP_HEADERS="$WORK/sitemap.headers"; TMP_BODY="$WORK/sitemap.body"
curl --silent --show-error --fail --max-time 10 --dump-header "$TMP_HEADERS" --output "$TMP_BODY" "http://127.0.0.1:$PORT/sitemap.xml" || die 'sitemap.xml no se sirve directamente.'
SITEMAP_CT_COUNT="$(awk 'tolower($1)=="content-type:" {count++} END {print count+0}' "$TMP_HEADERS")"
SITEMAP_CONTENT_TYPE="$(awk 'tolower($1)=="content-type:" {sub(/^[^:]*:[[:space:]]*/, ""); gsub(/\r/, ""); print; exit}' "$TMP_HEADERS")"
SITEMAP_CONTENT_TYPE_DISPLAY="$(printf '%s' "$SITEMAP_CONTENT_TYPE" | tr -cd '[:alnum:]/;=._ "-')"
[[ -n "$SITEMAP_CONTENT_TYPE_DISPLAY" ]] || SITEMAP_CONTENT_TYPE_DISPLAY='missing'
note "CANDIDATE_SITEMAP_CONTENT_TYPE=$SITEMAP_CONTENT_TYPE_DISPLAY"
[[ "$SITEMAP_CT_COUNT" == 1 ]] || die 'sitemap.xml debe devolver exactamente un encabezado Content-Type.'
valid_sitemap_content_type "$SITEMAP_CONTENT_TYPE" || die 'sitemap.xml debe usar application/xml o text/xml con charset opcional.'
grep -Fq '<loc>https://softventaweb.com/inicio/</loc>' "$TMP_BODY" || die 'sitemap.xml no apunta a /inicio/.'
TMP_HEADERS="$WORK/login.headers"; TMP_BODY="$WORK/login.body"
curl --silent --show-error --fail --max-time 10 --dump-header "$TMP_HEADERS" --output "$TMP_BODY" "http://127.0.0.1:$PORT/" || die 'El login en / no responde 200.'
grep -Fq 'id="loginScreen"' "$TMP_BODY" || die 'El shell de login no está presente en /.'
docker rm --force "$VALIDATION_ID" >/dev/null || die 'No se pudo retirar el contenedor temporal creado por la validación.'
VALIDATION_ID=''
note "CANDIDATE=PASS; tag=$CANDIDATE_IMAGE; image=$CANDIDATE_ID; base=$ORIGINAL_ID; nginx-test=pass; CSP=preserved; no-published-services"

if [[ "$MODE" == '--prepare-only' ]]; then
  note 'PREPARE_ONLY=PASS; producción intacta'
  exit 0
fi

[[ -t 0 ]] || die 'La publicación requiere un TTY para la confirmación interactiva.'
read -r -p 'La candidata pasó las verificaciones. Escriba PUBLICAR para recrear únicamente frontend: ' CONFIRMATION
[[ "$CONFIRMATION" == 'PUBLICAR' ]] || die 'No se confirmó la publicación; producción sigue intacta.'

UTC_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ROLLBACK_IMAGE="pos-frontend:rollback-pre-landing-$UTC_STAMP-${ORIGINAL_ID#sha256:}"
ROLLBACK_IMAGE="${ROLLBACK_IMAGE:0:79}"
if docker image inspect "$ROLLBACK_IMAGE" >/dev/null 2>&1; then die 'La etiqueta de rollback ya existe; no se sobrescribirá.'; fi
docker tag "$ORIGINAL_ID" "$ROLLBACK_IMAGE" || die 'No se pudo guardar una referencia de rollback.'
[[ "$(docker image inspect --format '{{.Id}}' "$ROLLBACK_IMAGE")" == "$ORIGINAL_ID" ]] || die 'La etiqueta de rollback no apunta a la imagen anterior.'
DEPLOY_MUTATION_STARTED=1
docker tag "$CANDIDATE_ID" "$PRODUCTION_IMAGE" || die 'No se pudo actualizar la etiqueta frontend production.'
"${COMPOSE[@]}" up --detach --no-deps --force-recreate frontend >/dev/null || die 'Compose no pudo recrear únicamente frontend.'

for _ in $(seq 1 120); do
  FRONT_ID="$(container_for frontend 2>/dev/null || true)"
  if [[ -n "$FRONT_ID" && "$(health_of "$FRONT_ID" 2>/dev/null || true)" == 'running|healthy' ]]; then break; fi
  sleep 2
done
[[ -n "$FRONT_ID" && "$(health_of "$FRONT_ID")" == 'running|healthy' ]] || die 'El frontend candidato no quedó healthy.'
[[ "$(docker inspect --format '{{.Image}}' "$FRONT_ID")" == "$CANDIDATE_ID" ]] || die 'El frontend activo no usa la imagen candidata.'
[[ "$(container_for backend)" == "$BACKEND_ID" && "$(container_for mysql)" == "$MYSQL_ID" ]] || die 'Cambió inesperadamente la identidad del backend o MySQL.'
[[ "$(health_of "$BACKEND_ID")" == 'running|healthy' && "$(health_of "$MYSQL_ID")" == 'running|healthy' ]] || die 'Backend o MySQL dejó de estar healthy.'
[[ "$(docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}@{{.Destination}}{{";"}}{{end}}{{end}}' "$MYSQL_ID")" == "$MYSQL_MOUNTS" ]] || die 'Los volúmenes de MySQL cambiaron inesperadamente.'

PUBLIC_HEADERS="$WORK/public-landing.headers"; PUBLIC_BODY="$WORK/public-landing.body"
curl --silent --show-error --fail --max-time 20 --dump-header "$PUBLIC_HEADERS" --output "$PUBLIC_BODY" https://softventaweb.com/inicio/ || die 'HTTPS público no sirve /inicio/.'
[[ "$(grep -ic '^Content-Security-Policy:' "$PUBLIC_HEADERS")" == 1 ]] || die 'HTTPS público no devuelve exactamente una CSP.'
[[ "$(grep -ic '^Strict-Transport-Security:' "$PUBLIC_HEADERS")" == 1 ]] || die 'HTTPS público no devuelve exactamente un HSTS.'
PUBLIC_CSP="$(awk 'tolower($1)=="content-security-policy:" {sub(/^[^:]*:[[:space:]]*/, ""); gsub(/\r/, ""); print}' "$PUBLIC_HEADERS")"
[[ "$(printf '%s' "$PUBLIC_CSP" | sha256sum | awk '{print $1}')" == "$EXPECTED_CSP_SHA" ]] || die 'La CSP pública cambió durante la publicación.'
grep -Fq '<title>SoftVentaWeb | Sistema POS para negocios</title>' "$PUBLIC_BODY" || die 'La landing pública no muestra el título esperado.'
curl --silent --show-error --fail --max-time 20 --output "$WORK/robots-public.body" https://softventaweb.com/robots.txt || die 'robots.txt público no responde.'
grep -Fq 'Sitemap: https://softventaweb.com/sitemap.xml' "$WORK/robots-public.body" || die 'robots.txt público no apunta al sitemap esperado.'
curl --silent --show-error --fail --max-time 20 --dump-header "$WORK/sitemap-public.headers" --output "$WORK/sitemap-public.body" https://softventaweb.com/sitemap.xml || die 'sitemap.xml público no responde.'
grep -Fq '<loc>https://softventaweb.com/inicio/</loc>' "$WORK/sitemap-public.body" || die 'El sitemap público no apunta a /inicio/.'
PUBLIC_SITEMAP_CT_COUNT="$(awk 'tolower($1)=="content-type:" {count++} END {print count+0}' "$WORK/sitemap-public.headers")"
PUBLIC_SITEMAP_CONTENT_TYPE="$(awk 'tolower($1)=="content-type:" {sub(/^[^:]*:[[:space:]]*/, ""); gsub(/\r/, ""); print; exit}' "$WORK/sitemap-public.headers")"
[[ "$PUBLIC_SITEMAP_CT_COUNT" == 1 ]] && valid_sitemap_content_type "$PUBLIC_SITEMAP_CONTENT_TYPE" || die 'El sitemap público no conserva un Content-Type XML válido único.'
curl --silent --show-error --fail --max-time 20 --output "$WORK/login-public.body" https://softventaweb.com/ || die 'El login público no responde.'
grep -Fq 'id="loginScreen"' "$WORK/login-public.body" || die 'El login público dejó de estar disponible.'
API_STATUS="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 20 https://softventaweb.com/api/health)" || die 'No se pudo comprobar /api/health.'
[[ "$API_STATUS" == '200' ]] || die 'La API no devolvió 200 después del cambio frontend.'
API_HEADERS="$WORK/api-public.headers"
curl --silent --show-error --fail --max-time 20 --dump-header "$API_HEADERS" --output /dev/null https://softventaweb.com/api/health || die 'No se pudieron revisar los encabezados de la API.'
[[ "$(grep -ic '^Content-Security-Policy:' "$API_HEADERS" || true)" == 1 ]] || die 'La API no devuelve exactamente una CSP después del cambio frontend.'
[[ "$(grep -ic '^Strict-Transport-Security:' "$API_HEADERS" || true)" == 1 ]] || die 'La API no devuelve exactamente un HSTS después del cambio frontend.'
[[ "$(health_of "$FRONT_ID")" == 'running|healthy' ]] || die 'Frontend dejó de estar healthy al completar las comprobaciones.'
DEPLOY_OK=1
note "DEPLOY=PASS; frontend=$CANDIDATE_ID; rollback=$ROLLBACK_IMAGE; backend/mysql=unchanged; API=200; CSP/HSTS=single"
