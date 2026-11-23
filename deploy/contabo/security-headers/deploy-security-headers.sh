#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

MODE="${5:-}"
CURRENT_STEP='bootstrap'
PACKAGE_DIR=''
RUN_ID=''
STAGE=''
CADDY_CHANGED=0
CANDIDATE_CREATED=0
CADDY_CANDIDATE=''
ROLLBACK_DIR=''
CADDY_TEMP=''
ORIGINAL_HASH=''
ORIGINAL_OWNER_MODE=''
SERVICE_SNAPSHOT=''
PATCHER=''

note() { printf '%s\n' "$1"; }
die() {
  if [[ "$MODE" == 'diagnose-only' ]]; then
    printf 'DIAGNOSE_ONLY=FAIL; STEP=%s; DETAIL=%s\n' "$CURRENT_STEP" "$1" >&2
  else
    printf 'DETENIDO: STEP=%s; %s\n' "$CURRENT_STEP" "$1" >&2
  fi
  exit 1
}
on_error() {
  local status="$1" line="$2"
  if [[ "$MODE" == 'diagnose-only' ]]; then
    printf 'DIAGNOSE_ONLY=FAIL; STEP=%s; CODE=%s; LINE=%s; DETAIL=command-failed\n' "$CURRENT_STEP" "$status" "$line" >&2
  else
    printf 'DETENIDO: STEP=%s; CODE=%s; LINE=%s; command-failed\n' "$CURRENT_STEP" "$status" "$line" >&2
  fi
  exit "$status"
}
hash_file() { sha256sum -- "$1" | awk '{print $1}'; }
service_container() {
  local service="$1"; local -a ids=()
  mapfile -t ids < <(docker ps -q --filter 'label=com.docker.compose.project=pos-production' --filter "label=com.docker.compose.service=$service")
  [[ ${#ids[@]} -eq 1 ]] || return 1
  printf '%s' "${ids[0]}"
}
health_of() {
  docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$1" 2>/dev/null
}
service_snapshot() {
  local service id info mounts
  for service in frontend backend mysql; do
    id="$(service_container "$service")" || return 1
    info="$(docker inspect --format '{{.Id}}|{{.Image}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$id")" || return 1
    [[ "$info" == *'|running|healthy' ]] || return 1
    printf '%s=%s\n' "$service" "$info"
    if [[ "$service" == mysql ]]; then
      mounts="$(docker inspect --format '{{range .Mounts}}{{.Type}}:{{.Name}}:{{.Destination}}:{{.RW}};{{end}}' "$id")" || return 1
      [[ "$mounts" == *'volume:pos-production_mysql_data:/var/lib/mysql:true;'* ]] || return 1
      printf 'mysql_mount=%s\n' "$mounts"
    fi
  done
}
get_headers() {
  local name="$1" url="$2" resolve="$3" origin="${4:-}" code
  local -a origin_arg=() resolve_arg=()
  [[ -z "$origin" ]] || origin_arg=(-H "Origin: $origin")
  [[ -z "$resolve" ]] || resolve_arg=(--resolve "$resolve")
  code="$(curl --silent --show-error --max-time 20 "${resolve_arg[@]}" "${origin_arg[@]}" -D "$STAGE/$name.headers" -o /dev/null -w '%{http_code}' "$url" 2>"$STAGE/$name.curl.err")" || return 1
  printf '%s' "$code"
}
probe_routes() {
  local stage_name="$1" root api www recovery plain allowed blocked
  root="$(get_headers "${stage_name}-root" 'https://softventaweb.com/' 'softventaweb.com:443:127.0.0.1')" || return 1
  api="$(get_headers "${stage_name}-api" 'https://softventaweb.com/api/health' 'softventaweb.com:443:127.0.0.1')" || return 1
  www="$(get_headers "${stage_name}-www" 'https://www.softventaweb.com/' 'www.softventaweb.com:443:127.0.0.1')" || return 1
  recovery="$(get_headers "${stage_name}-recovery" 'http://127.0.0.1:8443/' '')" || return 1
  plain="$(get_headers "${stage_name}-http" 'http://softventaweb.com/' 'softventaweb.com:80:127.0.0.1')" || return 1
  allowed="$(get_headers "${stage_name}-cors-allowed" 'https://softventaweb.com/api/health' 'softventaweb.com:443:127.0.0.1' 'https://softventaweb.com')" || return 1
  blocked="$(get_headers "${stage_name}-cors-blocked" 'https://softventaweb.com/api/health' 'softventaweb.com:443:127.0.0.1' 'https://headers-probe.invalid')" || return 1
  [[ "$root" == 200 && "$api" == 200 && "$www" == 308 && "$recovery" == 200 && "$plain" == 308 && "$allowed" == 200 ]] || return 1
  [[ "$blocked" == 200 || "$blocked" == 401 || "$blocked" == 403 ]] || return 1
  printf '%s\n' "ROOT=$root" "API=$api" "WWW=$www" "RECOVERY=$recovery" "HTTP=$plain" "CORS_ALLOWED=$allowed" "CORS_BLOCKED=$blocked"
}
verify_post_headers() {
  python3 - "$PATCHER" "$STAGE/post-root.headers" "$STAGE/post-api.headers" "$STAGE/post-www.headers" "$STAGE/post-recovery.headers" "$STAGE/post-http.headers" "$STAGE/post-cors-allowed.headers" "$STAGE/post-cors-blocked.headers" <<'PY'
import importlib.util
import sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("softventa_security_header_policy", sys.argv[1])
if spec is None or spec.loader is None:
    raise SystemExit(1)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
PUBLIC_RESPONSE_HEADERS = policy.PUBLIC_RESPONSE_HEADERS

def read(path):
    result={}
    for line in open(path,encoding='iso-8859-1'):
        if line.startswith('HTTP/') or ':' not in line: continue
        key,value=line.split(':',1)
        result.setdefault(key.strip().lower(),[]).append(value.strip())
    return result
root,api,www,recovery,plain,allowed,blocked=map(read,sys.argv[2:])
for response in (root,api,www):
    for field,value in PUBLIC_RESPONSE_HEADERS.items():
        values=response.get(field.lower(),[])
        if len(values)!=1 or values[0]!=value: raise SystemExit(1)
if recovery.get('strict-transport-security'): raise SystemExit(1)
if plain.get('location') is None or not any(v.lower().startswith('https://softventaweb.com') for v in plain['location']): raise SystemExit(1)
if www.get('location') is None or not any(v.lower().startswith('https://softventaweb.com') for v in www['location']): raise SystemExit(1)
if len(allowed.get('access-control-allow-origin',[]))!=1 or allowed['access-control-allow-origin'][0]!='https://softventaweb.com': raise SystemExit(1)
if blocked.get('access-control-allow-origin'): raise SystemExit(1)
PY
}
verify_recovery_headers_absent() {
  ! grep -Eiq '^Strict-Transport-Security:' "$STAGE/post-recovery.headers"
}
verify_current_response_summary() {
  python3 - "$STAGE/pre-root.headers" "$STAGE/pre-api.headers" <<'PY'
import sys
expected=('content-security-policy','strict-transport-security','x-content-type-options','referrer-policy','x-frame-options')
def headers(path):
    out={}
    for line in open(path,encoding='iso-8859-1'):
        if line.startswith('HTTP/') or ':' not in line: continue
        key,_=line.split(':',1); out[key.strip().lower()]=out.get(key.strip().lower(),0)+1
    return out
states=[]
for path in sys.argv[1:]:
    h=headers(path)
    if any(h.get(key,0)!=1 for key in expected): states.append('needs-update-or-duplicate')
    else: states.append('single-values-present')
print('CURRENT_PUBLIC_HEADERS=' + ('PASS' if all(x=='single-values-present' for x in states) else 'NEEDS_UPDATE'))
PY
}
verify_backup() {
  [[ -d "$ROLLBACK_DIR" && ! -L "$ROLLBACK_DIR" ]] || return 1
  [[ "$(stat -c '%U:%G:%a' "$ROLLBACK_DIR")" == 'root:root:700' ]] || return 1
  [[ "$(find "$ROLLBACK_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)" == $'Caddyfile\nSHA256SUMS\nmanifest.txt' ]] || return 1
  [[ -f "$ROLLBACK_DIR/Caddyfile" && ! -L "$ROLLBACK_DIR/Caddyfile" ]] || return 1
  [[ -f "$ROLLBACK_DIR/manifest.txt" && ! -L "$ROLLBACK_DIR/manifest.txt" ]] || return 1
  [[ "$(stat -c '%U:%G:%a' "$ROLLBACK_DIR/Caddyfile")" == 'root:root:600' ]] || return 1
  [[ "$(stat -c '%U:%G:%a' "$ROLLBACK_DIR/manifest.txt")" == 'root:root:600' ]] || return 1
  [[ "$(stat -c '%U:%G:%a' "$ROLLBACK_DIR/SHA256SUMS")" == 'root:root:600' ]] || return 1
  grep -Fxq "run_id=$RUN_ID" "$ROLLBACK_DIR/manifest.txt" || return 1
  grep -Fxq "caddyfile_sha256=$ORIGINAL_HASH" "$ROLLBACK_DIR/manifest.txt" || return 1
  grep -Fxq "caddyfile_owner_mode=$ORIGINAL_OWNER_MODE" "$ROLLBACK_DIR/manifest.txt" || return 1
  [[ "$(awk '{print $2}' "$ROLLBACK_DIR/SHA256SUMS" | LC_ALL=C sort)" == $'Caddyfile\nmanifest.txt' ]] || return 1
  (cd "$ROLLBACK_DIR" && sha256sum --check --status SHA256SUMS) || return 1
  [[ "$(hash_file "$ROLLBACK_DIR/Caddyfile")" == "$ORIGINAL_HASH" ]]
}
verify_unchanged_services() {
  local current
  current="$(service_snapshot)" || return 1
  [[ "$current" == "$SERVICE_SNAPSHOT" ]]
}
rollback_caddy() {
  set +e
  note 'ROLLBACK=START; scope=Caddyfile+Caddy-reload-only'
  if ! verify_backup; then note 'ROLLBACK=FAIL; backup-integrity-or-permissions'; return 1; fi
  local restore="$CADDY_FILE.rollback-$RUN_ID"
  [[ ! -e "$restore" && ! -L "$restore" ]] || { note 'ROLLBACK=FAIL; restore-temp-exists'; return 1; }
  install -T -o "${CADDY_OWNER_GROUP%:*}" -g "${CADDY_OWNER_GROUP#*:}" -m "${CADDY_MODE}" "$ROLLBACK_DIR/Caddyfile" "$restore" || { note 'ROLLBACK=FAIL; copy'; return 1; }
  caddy validate --config "$restore" --adapter caddyfile >/dev/null 2>&1 || { rm -f -- "$restore"; note 'ROLLBACK=FAIL; restored-config-invalid'; return 1; }
  mv -f -- "$restore" "$CADDY_FILE" || { rm -f -- "$restore"; note 'ROLLBACK=FAIL; atomic-restore'; return 1; }
  if systemctl reload caddy && systemctl is-active --quiet caddy; then
    local rollback_probe
    rollback_probe="$(probe_routes rollback)" || { note 'ROLLBACK=FAIL; endpoint-recovery'; return 1; }
    verify_unchanged_services || { note 'ROLLBACK=FAIL; container-or-volume-changed'; return 1; }
    CADDY_CHANGED=0
    note 'ROLLBACK=PASS; endpoints-and-containers-verified'
    return 0
  fi
  note 'ROLLBACK=FAIL; Caddy service reload'
  return 1
}
cleanup() {
  local status=$?
  trap - EXIT ERR
  if [[ "$status" -ne 0 && "$CADDY_CHANGED" == 1 && "$MODE" == 'deploy' ]]; then rollback_caddy || true; fi
  if [[ "$CANDIDATE_CREATED" == 1 && -n "$CADDY_CANDIDATE" && "$CADDY_CANDIDATE" == "$STAGE/Caddyfile.candidate" ]]; then rm -f -- "$CADDY_CANDIDATE"; fi
  if [[ -n "$CADDY_TEMP" && "$CADDY_TEMP" == "/etc/caddy/.Caddyfile.security-$RUN_ID" ]]; then rm -f -- "$CADDY_TEMP"; fi
  [[ -n "$STAGE" && "$STAGE" == "/tmp/pos-caddy-security-$RUN_ID."* && -d "$STAGE" ]] && rm -rf -- "$STAGE"
  [[ -n "${PACKAGE_DIR:-}" && "$PACKAGE_DIR" == "/run/pos-caddy-security-$RUN_ID" && -d "$PACKAGE_DIR" && ! -L "$PACKAGE_DIR" && "$(stat -c '%U:%G:%a' "$PACKAGE_DIR")" == 'root:root:700' ]] && rm -rf -- "$PACKAGE_DIR"
  exit "$status"
}

if [[ "${1:-}" == '--self-test' ]]; then
  patcher="$(dirname -- "$(readlink -f -- "$0")")/patch-security-config.py"
  [[ -f "$patcher" && ! -L "$patcher" ]] || { printf 'CADDY_ONLY_SELF_TEST=FAIL; patcher-missing\n' >&2; exit 1; }
  PATCHER="$patcher"
  STAGE="$(mktemp -d /tmp/pos-caddy-verifier-selftest.XXXXXX)"
  chmod 0700 "$STAGE"
  trap 'rm -rf -- "$STAGE"' EXIT
  if grep -Eq '^[[:space:]]*(docker (compose|build|run|tag|rm|restart|stop|start)|systemctl restart|nginx)([[:space:]]|$)' "$0"; then
    printf 'CADDY_ONLY_SELF_TEST=FAIL; forbidden-frontend-nginx-or-container-operation\n' >&2
    exit 1
  fi
  python3 "$patcher" --self-test >/dev/null || { printf 'CADDY_ONLY_SELF_TEST=FAIL; patcher\n' >&2; exit 1; }
  python3 - "$patcher" "$STAGE" <<'PY'
import importlib.util
import pathlib
import sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("softventa_security_header_fixture", sys.argv[1])
if spec is None or spec.loader is None:
    raise SystemExit(1)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
root = pathlib.Path(sys.argv[2])
public = "HTTP/1.1 200 OK\r\n" + "".join(
    f"{name}: {value}\r\n" for name, value in module.PUBLIC_RESPONSE_HEADERS.items()
)
for name in ("post-root.headers", "post-api.headers", "post-www.headers"):
    (root / name).write_text(public, encoding="iso-8859-1")
(root / "post-www.headers").write_text(
    public.replace("HTTP/1.1 200 OK", "HTTP/1.1 308 Permanent Redirect")
    + "Location: https://softventaweb.com/\r\n", encoding="iso-8859-1"
)
(root / "post-recovery.headers").write_text("HTTP/1.1 200 OK\r\n", encoding="iso-8859-1")
(root / "post-http.headers").write_text(
    "HTTP/1.1 308 Permanent Redirect\r\nLocation: https://softventaweb.com/\r\n", encoding="iso-8859-1"
)
(root / "post-cors-allowed.headers").write_text(
    "HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: https://softventaweb.com\r\n", encoding="iso-8859-1"
)
(root / "post-cors-blocked.headers").write_text("HTTP/1.1 200 OK\r\n", encoding="iso-8859-1")
PY
  if ! verify_post_headers; then printf 'POST_HEADER_VERIFIER_SELF_TEST=FAIL; valid-fixture-rejected\n' >&2; exit 1; fi
  cp -- "$STAGE/post-api.headers" "$STAGE/post-api.valid"
  printf 'X-Frame-Options: SAMEORIGIN\r\n' >>"$STAGE/post-api.headers"
  if verify_post_headers; then printf 'POST_HEADER_VERIFIER_SELF_TEST=FAIL; bad-fixture-accepted\n' >&2; exit 1; fi
  mv -f -- "$STAGE/post-api.valid" "$STAGE/post-api.headers"
  printf 'Content-Security-Policy: default-src *\r\n' >>"$STAGE/post-root.headers"
  if verify_post_headers; then printf 'POST_HEADER_VERIFIER_SELF_TEST=FAIL; duplicate-fixture-accepted\n' >&2; exit 1; fi
  printf 'POST_HEADER_VERIFIER_TEST=PASS; valid=accepted; wrong-and-duplicate=rejected\n'
  printf 'CADDY_ONLY_SELF_TEST=PASS; no-frontend-nginx-or-container-mutations\n'
  exit 0
fi

[[ $EUID -eq 0 ]] || { printf 'DETENIDO: ejecuta esta etapa mediante sudo interactivo.\n' >&2; exit 1; }
[[ $# -eq 5 ]] || die 'argumentos-invalidos'
PACKAGE_DIR="$1"
RUN_ID="$2"
HELPER_SHA="$3"
PATCHER_SHA="$4"
MODE="$5"
[[ "$MODE" == 'diagnose-only' || "$MODE" == 'deploy' ]] || die 'modo-invalido'
[[ "$RUN_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{32}$ ]] || die 'run-id-invalido'
[[ "$PACKAGE_DIR" == "/run/pos-caddy-security-$RUN_ID" ]] || die 'staging-root-privado-no-aprobado'
[[ "$HELPER_SHA" =~ ^[a-f0-9]{64}$ && "$PATCHER_SHA" =~ ^[a-f0-9]{64}$ ]] || die 'sha256-formato-invalido'
[[ "$(readlink -f -- "$0")" == "$PACKAGE_DIR/deploy-security-headers.sh" ]] || die 'helper-fuera-del-staging-validado'
[[ -d "$PACKAGE_DIR" && ! -L "$PACKAGE_DIR" && -f "$0" && ! -L "$0" ]] || die 'paquete-incompleto'
[[ "$(stat -c '%U:%G:%a' "$PACKAGE_DIR")" == 'root:root:700' ]] || die 'permisos-staging-root-invalidos'
[[ "$(stat -c '%U:%G:%a' "$0")" == 'root:root:700' ]] || die 'permisos-helper-root-invalidos'
PATCHER="$PACKAGE_DIR/patch-security-config.py"
[[ -f "$PATCHER" && ! -L "$PATCHER" && "$(stat -c '%U:%G:%a' "$PATCHER")" == 'root:root:600' ]] || die 'parcheador-root-invalido'
[[ "$(hash_file "$0")" == "$HELPER_SHA" && "$(hash_file "$PATCHER")" == "$PATCHER_SHA" ]] || die 'sha256-paquete-no-coincide'
EXPECTED_ENTRIES=$'deploy-security-headers.sh\npatch-security-config.py'
ACTUAL_ENTRIES="$(find "$PACKAGE_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)"
[[ "$ACTUAL_ENTRIES" == "$(printf '%s\n' "$EXPECTED_ENTRIES" | LC_ALL=C sort)" ]] || die 'archivos-staging-inesperados'

CURRENT_STEP='dependencies-and-caddy-preflight'
for command in awk cat caddy chmod chown cp curl docker find grep install mkdir mktemp mv python3 readlink rm sha256sum ss stat systemctl; do command -v "$command" >/dev/null || die "falta-comando-$command"; done
[[ -f /etc/caddy/Caddyfile && ! -L /etc/caddy/Caddyfile ]] || die 'Caddyfile-no-regular-o-no-disponible'
CADDY_FILE='/etc/caddy/Caddyfile'
CADDY_META="$(stat -c '%U:%G:%a' "$CADDY_FILE")"
[[ "${CADDY_META%%:*}" == 'root' ]] || die 'Caddyfile-no-pertenece-a-root'
CADDY_OWNER_GROUP="${CADDY_META%:*}"
CADDY_MODE="${CADDY_META##*:}"
if ! python3 - "$CADDY_MODE" <<'PY'
import sys
mode=int(sys.argv[1],8)
if mode & 0o022 or mode & 0o007: raise SystemExit(1)
PY
then die 'permisos-Caddyfile-permiten-escritura-o-lectura-no-aprobada'; fi
systemctl is-active --quiet caddy || die 'Caddy-no-esta-activo'
EXEC_START="$(systemctl show caddy -p ExecStart --value 2>/dev/null)" || die 'no-se-leyo-ExecStart-de-Caddy'
[[ "$EXEC_START" == *'--config /etc/caddy/Caddyfile'* ]] || die 'Caddy-no-usa-el-Caddyfile-esperado'
RECOVERY_SOCKETS="$(ss -H -ltn 'sport = :8443' | awk '{print $4}')"
[[ "$RECOVERY_SOCKETS" == '127.0.0.1:8443' ]] || die 'listener-privado-no-esta-limitado-a-loopback'
ORIGINAL_HASH="$(hash_file "$CADDY_FILE")"
ORIGINAL_OWNER_MODE="$(stat -c '%u:%g:%a' "$CADDY_FILE")"

STAGE="$(mktemp -d "/tmp/pos-caddy-security-$RUN_ID.XXXXXX")"
chmod 0700 "$STAGE"
trap cleanup EXIT
trap 'on_error "$?" "$LINENO"' ERR
patcher_self_test_output="$(python3 "$PATCHER" --self-test 2>&1)" || die 'self-test-del-parcheador-fallo'
[[ "$patcher_self_test_output" == *'CADDYFILE_PUBLIC_EDGE_TEST=PASS'* && "$patcher_self_test_output" == *'CADDY_TOPOLOGY_TEST=PASS'* ]] || die 'faltan-pruebas-Caddy-del-parcheador'

CURRENT_STEP='services-and-live-config'
SERVICE_SNAPSHOT="$(service_snapshot)" || die 'frontend-backend-mysql-no-estan-healthy-o-volumen-esperado'
FRONT_ID="$(service_container frontend)"
BACKEND_ID="$(service_container backend)"
MYSQL_ID="$(service_container mysql)"
FRONT_IMAGE="$(docker inspect --format '{{.Image}}' "$FRONT_ID")"
BACKEND_IMAGE="$(docker inspect --format '{{.Image}}' "$BACKEND_ID")"
MYSQL_IMAGE="$(docker inspect --format '{{.Image}}' "$MYSQL_ID")"
CURRENT_STEP='caddy-admin-api'
curl --silent --show-error --fail --max-time 5 http://127.0.0.1:2019/config/ -o "$STAGE/live-caddy.json" 2>"$STAGE/admin-api.err" || die 'API-admin-de-Caddy-no-disponible'
chmod 0600 "$STAGE/live-caddy.json"
LIVE_TOPOLOGY="$(python3 "$PATCHER" inspect-caddy-json "$STAGE/live-caddy.json" 2>"$STAGE/live-topology.err")" || die 'topologia-Caddy-activa-no-coincide-con-el-sitio-y-recuperacion-aprobados'
caddy validate --config "$CADDY_FILE" --adapter caddyfile >"$STAGE/caddy-active-validate.log" 2>&1 || die 'Caddyfile-activo-no-valida'
caddy adapt --config "$CADDY_FILE" --adapter caddyfile --pretty >"$STAGE/file-adapted.json" 2>"$STAGE/caddy-adapt.log" || die 'no-se-pudo-adaptar-el-Caddyfile-activo'
chmod 0600 "$STAGE/file-adapted.json"
FILE_TOPOLOGY="$(python3 "$PATCHER" inspect-caddy-json "$STAGE/file-adapted.json" 2>"$STAGE/file-topology.err")" || die 'el-Caddyfile-no-representa-la-topologia-publica-y-privada-activa'
[[ "$FILE_TOPOLOGY" == "$LIVE_TOPOLOGY" ]] || die 'el-Caddyfile-y-la-configuracion-Caddy-en-vivo-tienen-topologias-distintas'
note "$LIVE_TOPOLOGY"
note 'CADDY_ACTIVE_FILE=PASS; runtime-and-file-topology-match; secrets-hidden'
note "SERVICES=PASS; frontend_image=$FRONT_IMAGE; backend_image=$BACKEND_IMAGE; mysql_image=$MYSQL_IMAGE; all_healthy; mysql_volume=preserved"

CURRENT_STEP='candidate-and-validation'
CADDY_CANDIDATE="$STAGE/Caddyfile.candidate"
CANDIDATE_CREATED=1
python3 "$PATCHER" patch-caddy "$CADDY_FILE" "$CADDY_CANDIDATE" >"$STAGE/patch.out" 2>"$STAGE/patch.err" || die 'el-Caddyfile-real-no-permite-un-parche-seguro'
chmod 0600 "$CADDY_CANDIDATE"
caddy validate --config "$CADDY_CANDIDATE" --adapter caddyfile >"$STAGE/caddy-candidate-validate.log" 2>&1 || die 'la-candidata-Caddy-no-valida; configuracion-activa-intacta'
caddy adapt --config "$CADDY_CANDIDATE" --adapter caddyfile --pretty >"$STAGE/candidate-adapted.json" 2>"$STAGE/candidate-adapt.log" || die 'no-se-pudo-adaptar-la-candidata-Caddy'
chmod 0600 "$STAGE/candidate-adapted.json"
CANDIDATE_TOPOLOGY="$(python3 "$PATCHER" inspect-caddy-json "$STAGE/candidate-adapted.json" 2>"$STAGE/candidate-topology.err")" || die 'la-candidata-no-conserva-la-topologia-publica-y-privada-aprobada'
[[ "$CANDIDATE_TOPOLOGY" == "$LIVE_TOPOLOGY" ]] || die 'la-candidata-cambio-proxy-redireccion-o-listener-privado'
[[ "$(grep -cF 'softventa-security-headers:public-v1' "$CADDY_CANDIDATE")" == 2 ]] || die 'la-candidata-no-cubre-exactamente-los-dos-sitios-publicos'
[[ "$(grep -cF '>Strict-Transport-Security "max-age=31536000"' "$CADDY_CANDIDATE")" == 2 ]] || die 'HSTS-no-es-el-valor-aprobado-en-los-dos-sitios'
[[ "$(hash_file "$CADDY_FILE")" == "$ORIGINAL_HASH" ]] || die 'Caddyfile-cambio-durante-la-validacion'
note 'CADDY_CANDIDATE=PASS; caddy-validate=PASS; adapted-topology=unchanged; only-public-response-headers; Nginx-and-containers=untouched'

CURRENT_STEP='read-only-endpoint-preflight'
probe_output="$(probe_routes pre)" || die 'HTTPS-API-redirect-o-recuperacion-no-funcionan-antes-del-cambio'
while IFS= read -r result; do note "BASELINE_$result"; done <<<"$probe_output"
verify_current_response_summary

if [[ "$MODE" == 'diagnose-only' ]]; then
  CURRENT_STEP='temporary-backup-self-check'
  cp --preserve=mode,ownership,timestamps -- "$CADDY_FILE" "$STAGE/backup-check"
  ORIGINAL_HASH="$(hash_file "$CADDY_FILE")"
  [[ "$(hash_file "$STAGE/backup-check")" == "$ORIGINAL_HASH" ]] || die 'copia-temporal-no-coincide-en-SHA-256'
  printf '%s  %s\n' "$ORIGINAL_HASH" backup-check >"$STAGE/SHA256SUMS"
  (cd "$STAGE" && sha256sum --check --status SHA256SUMS) || die 'autoverificacion-de-respaldo-temporal-fallo'
  [[ "$(hash_file "$CADDY_FILE")" == "$ORIGINAL_HASH" ]] || die 'Caddyfile-activo-cambio-en-diagnostico'
  [[ "$(systemctl is-active caddy)" == 'active' ]] || die 'Caddy-dejo-de-estar-activo'
  [[ "$(service_snapshot)" == "$SERVICE_SNAPSHOT" ]] || die 'un-servicio-o-volumen-cambio-durante-el-diagnostico'
  note 'BACKUP_SELF_CHECK=PASS; temporary-only; SHA-256=PASS'
  note 'CADDY_RELOAD=NOT_RUN; FRONTEND_BACKEND_MYSQL=UNCHANGED'
  note 'DIAGNOSE_ONLY=PASS; no-production-config-or-service-changes'
  exit 0
fi

CURRENT_STEP='verified-rollback-backup'
BACKUP_ROOT='/root/pos-caddy-headers-rollback'
ROLLBACK_DIR="$BACKUP_ROOT/$RUN_ID"
[[ ! -e "$ROLLBACK_DIR" && ! -L "$ROLLBACK_DIR" ]] || die 'ya-existe-este-identificador-de-respaldo'
if [[ ! -e "$BACKUP_ROOT" ]]; then install -d -o root -g root -m 0700 "$BACKUP_ROOT"; fi
[[ ! -L "$BACKUP_ROOT" && "$(stat -c '%U:%G:%a' "$BACKUP_ROOT")" == 'root:root:700' ]] || die 'directorio-de-respaldo-no-es-privado'
install -d -o root -g root -m 0700 "$ROLLBACK_DIR"
cp --preserve=mode,ownership,timestamps -- "$CADDY_FILE" "$ROLLBACK_DIR/Caddyfile"
ORIGINAL_HASH="$(hash_file "$CADDY_FILE")"
ORIGINAL_OWNER_MODE="$(stat -c '%u:%g:%a' "$CADDY_FILE")"
printf 'run_id=%s\ncaddyfile_sha256=%s\ncaddyfile_owner_mode=%s\nfrontend_image=%s\nbackend_image=%s\nmysql_image=%s\n' "$RUN_ID" "$ORIGINAL_HASH" "$ORIGINAL_OWNER_MODE" "$FRONT_IMAGE" "$BACKEND_IMAGE" "$MYSQL_IMAGE" >"$ROLLBACK_DIR/manifest.txt"
chmod 0600 "$ROLLBACK_DIR/Caddyfile" "$ROLLBACK_DIR/manifest.txt"
chown root:root "$ROLLBACK_DIR/Caddyfile" "$ROLLBACK_DIR/manifest.txt"
[[ "$(stat -c '%U:%G:%a' "$ROLLBACK_DIR/Caddyfile")" == 'root:root:600' ]] || die 'respaldo-no-quedo-privado'
(cd "$ROLLBACK_DIR" && sha256sum Caddyfile manifest.txt >SHA256SUMS && chmod 0600 SHA256SUMS && sha256sum --check --status SHA256SUMS) || die 'respaldo-Caddy-o-manifiesto-no-pasaron-SHA-256'
verify_backup || die 'la-verificacion-final-del-respaldo-fallo'
note "BACKUP=PASS; path=$ROLLBACK_DIR; SHA-256=verified; Caddyfile-only"

CURRENT_STEP='atomic-caddyfile-install'
[[ "$(hash_file "$CADDY_FILE")" == "$ORIGINAL_HASH" ]] || die 'Caddyfile-cambio-despues-del-respaldo'
verify_unchanged_services || die 'cambiaron-los-contenedores-antes-de-la-activacion'
CADDY_TEMP="/etc/caddy/.Caddyfile.security-$RUN_ID"
[[ ! -e "$CADDY_TEMP" && ! -L "$CADDY_TEMP" ]] || die 'el-temporal-atomico-ya-existe'
install -T -o "${CADDY_OWNER_GROUP%:*}" -g "${CADDY_OWNER_GROUP#*:}" -m "$CADDY_MODE" "$CADDY_CANDIDATE" "$CADDY_TEMP"
CADDY_CHANGED=1
mv -f -- "$CADDY_TEMP" "$CADDY_FILE"
CADDY_TEMP=''
CADDY_CHANGED=1
systemctl reload caddy || die 'fallo-la-recarga-de-Caddy-se-restaurara-el-Caddyfile-anterior'
systemctl is-active --quiet caddy || die 'Caddy-no-quedo-activo-tras-la-recarga'

CURRENT_STEP='post-reload-verification'
SERVICE_SNAPSHOT_AFTER="$(service_snapshot)" || die 'frontend-backend-mysql-no-estan-healthy-tras-la-recarga'
[[ "$SERVICE_SNAPSHOT_AFTER" == "$SERVICE_SNAPSHOT" ]] || die 'cambio-un-contenedor-una-imagen-o-el-volumen-MySQL'
post_probe="$(probe_routes post)" || die 'HTTPS-API-CORS-o-recuperacion-fallaron-tras-la-recarga'
while IFS= read -r result; do note "POST_$result"; done <<<"$post_probe"
verify_post_headers || die 'encabezados-duplicados-o-valores-publicos-incorrectos'
verify_recovery_headers_absent || die 'el-listener-privado-recibio-HSTS'
curl --silent --show-error --fail --max-time 5 http://127.0.0.1:2019/config/ -o "$STAGE/post-live-caddy.json" 2>"$STAGE/post-admin.err" || die 'API-admin-Caddy-no-responde-tras-la-recarga'
POST_TOPOLOGY="$(python3 "$PATCHER" inspect-caddy-json "$STAGE/post-live-caddy.json" 2>"$STAGE/post-topology.err")" || die 'la-topologia-Caddy-no-se-conserva-tras-la-recarga'
[[ "$POST_TOPOLOGY" == "$LIVE_TOPOLOGY" ]] || die 'la-recarga-cambio-la-topologia-de-proxy-o-recuperacion'
verify_unchanged_services || die 'servicios-o-volumenes-cambiaron-tras-la-recarga'
CADDY_CHANGED=0
note 'DEPLOY=PASS; CADDY_RELOADED=YES; frontend-backend-mysql=unchanged; nginx=untouched'
note 'PUBLIC_HEADERS=PASS; CSP=1; HSTS=1; duplicates=0; X_FRAME_OPTIONS=DENY'
note 'HTTPS=PASS; API_HEALTH=200; WWW_REDIRECT=PASS; PRIVATE_RECOVERY=PASS; CORS=PASS'
note "ROLLBACK_BACKUP=$ROLLBACK_DIR"
