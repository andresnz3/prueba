#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

die() { printf 'DETENIDO: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || die "Falta comando requerido: $1"; }
[[ $# -eq 5 ]] || die 'Uso interno inválido.'
MODE="$1"; PACKAGE="$2"; EXPECTED_PACKAGE_SHA="$3"; EXPECTED_HELPER_SHA="$4"; ROLLBACK_TOKEN="$5"
[[ "$MODE" == '--prepare-only' || "$MODE" == '--deploy' || "$MODE" == '--rollback' ]] || die 'Modo inválido.'
[[ "$PACKAGE" =~ ^/home/posadmin/\.pos-billing-favicon-[a-f0-9]{16}/billing-favicon-overlay\.tar\.gz$ ]] || die 'Package path is not allowlisted.'
[[ "$EXPECTED_PACKAGE_SHA" =~ ^[a-f0-9]{64}$ && "$EXPECTED_HELPER_SHA" =~ ^[a-f0-9]{64}$ ]] || die 'SHA-256 inválido.'
if [[ "$MODE" == '--rollback' ]]; then
  [[ "$ROLLBACK_TOKEN" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]] || die 'Token de rollback inválido.'
else
  [[ -z "$ROLLBACK_TOKEN" ]] || die 'Rollback solo admite su token propio.'
fi
[[ "$(id -u)" == 0 ]] || die 'El helper debe ejecutarse con sudo.'
for c in docker python3 tar sha256sum awk grep sed find sort stat cut curl; do need "$c"; done
[[ -f "$PACKAGE" && ! -L "$PACKAGE" && -f "$0" && ! -L "$0" ]] || die 'No se encuentran los archivos transferidos esperados.'
STAGE="$(dirname "$PACKAGE")"
[[ "$STAGE" =~ ^/home/posadmin/\.pos-billing-favicon-[a-f0-9]{16}$ && "$(dirname "$0")" == "$STAGE" ]] || die 'Helper does not match package staging directory.'
[[ "$(stat -c '%U:%G:%a' "$PACKAGE")" == 'posadmin:posadmin:600' ]] || die 'El paquete no conserva propietario y permisos esperados.'
[[ "$(stat -c '%U:%G:%a' "$0")" == 'posadmin:posadmin:600' ]] || die 'El helper no conserva propietario y permisos esperados.'
hash_file() { sha256sum "$1" | awk '{print $1}'; }
[[ "$(hash_file "$PACKAGE")" == "$EXPECTED_PACKAGE_SHA" && "$(hash_file "$0")" == "$EXPECTED_HELPER_SHA" ]] || die 'Las huellas SHA-256 no coinciden.'

WORK="$(mktemp -d /tmp/pos-billing-favicon.XXXXXX)"
VALIDATION_ID=''
DEPLOY_MUTATION_STARTED=0
DEPLOY_OK=0
ORIGINAL_FRONT_ID=''
ORIGINAL_BACK_ID=''
ORIGINAL_FRONT_REF=''
ORIGINAL_BACK_REF=''
COMPOSE=()
cleanup() {
  local rc=$?
  if [[ -n "$VALIDATION_ID" ]]; then
    local found
    found="$(docker inspect --format '{{.Id}}' "$VALIDATION_ID" 2>/dev/null || true)"
    if [[ "$found" == "$VALIDATION_ID" ]]; then docker rm --force "$VALIDATION_ID" >/dev/null 2>&1 || true; fi
  fi
  if [[ "$DEPLOY_MUTATION_STARTED" == 1 && "$DEPLOY_OK" != 1 ]]; then
    note 'RECOVERY=START; restaurando solo frontend/backend'
    if [[ -n "$ORIGINAL_FRONT_ID" && -n "$ORIGINAL_BACK_ID" && -n "$ORIGINAL_FRONT_REF" && -n "$ORIGINAL_BACK_REF" ]]; then
      docker tag "$ORIGINAL_FRONT_ID" "$ORIGINAL_FRONT_REF" &&
      docker tag "$ORIGINAL_BACK_ID" "$ORIGINAL_BACK_REF" &&
      "${COMPOSE[@]}" up -d --no-deps --force-recreate backend frontend >/dev/null 2>&1 || true
      local now_front now_back now_mysql
      now_front="$(active_cid frontend 2>/dev/null || true)"
      now_back="$(active_cid backend 2>/dev/null || true)"
      now_mysql="$(active_cid mysql 2>/dev/null || true)"
      if [[ -n "$now_front" && -n "$now_back" && -n "$now_mysql" && "$now_mysql" == "$active_mysql_cid" &&
        "$(docker inspect --format '{{.Image}}' "$now_front" 2>/dev/null || true)" == "$ORIGINAL_FRONT_ID" &&
        "$(docker inspect --format '{{.Image}}' "$now_back" 2>/dev/null || true)" == "$ORIGINAL_BACK_ID" &&
        "$(docker inspect --format '{{.Image}}' "$now_mysql" 2>/dev/null || true)" == "$MYSQL_IMAGE_ID" ]]; then
        note 'RECOVERY=PASS; imágenes anteriores restauradas; MySQL no fue recreado'
      else
        note 'RECOVERY=FAIL; se requiere intervención manual' >&2
        rc=1
      fi
    else
      note 'RECOVERY=FAIL; faltan referencias originales' >&2
      rc=1
    fi
  fi
  case "$WORK" in /tmp/pos-billing-favicon.*) rm -rf -- "$WORK" ;; *) note 'TEMP_CLEANUP=SKIP; unexpected work path' ;; esac
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

mapfile -t ARCHIVE_FILES < <(tar -tzf "$PACKAGE" | LC_ALL=C sort)
EXPECTED_FILES=(Dockerfile.backend Dockerfile.frontend MANIFEST.sha256 apply-softventa-overlay.cjs backend.patch frontend.patch softventaweb-favicon-20261106-16.png softventaweb-favicon-20261106-32.png softventaweb-favicon-20261106-48.png softventaweb-favicon-20261106.svg softventaweb-pwa-20261106-512.png softventaweb-touch-20261106-192.png)
[[ ${#ARCHIVE_FILES[@]} -eq ${#EXPECTED_FILES[@]} ]] || die 'El paquete interno tiene archivos faltantes o adicionales.'
for i in "${!EXPECTED_FILES[@]}"; do [[ "${ARCHIVE_FILES[$i]}" == "${EXPECTED_FILES[$i]}" ]] || die 'El paquete interno no coincide con el allowlist.'; done
tar -xzf "$PACKAGE" -C "$WORK" --no-same-owner --no-same-permissions || die 'No se pudo extraer el paquete.'
(cd "$WORK" && sha256sum -c MANIFEST.sha256 >/dev/null) || die 'El manifiesto de payload no coincide.'
for f in Dockerfile.frontend Dockerfile.backend apply-softventa-overlay.cjs frontend.patch backend.patch softventaweb-favicon-20261106-16.png softventaweb-favicon-20261106-32.png softventaweb-favicon-20261106-48.png softventaweb-favicon-20261106.svg softventaweb-pwa-20261106-512.png softventaweb-touch-20261106-192.png; do [[ -s "$WORK/$f" && ! -L "$WORK/$f" ]] || die "Falta archivo allowlist: $f"; done
grep -Fq 'COPY --from=patcher /tmp/site /usr/share/nginx/html' "$WORK/Dockerfile.frontend" || die 'Dockerfile frontend no conserva la imagen base.'
grep -Fq 'RUN node /tmp/apply-softventa-overlay.cjs frontend' "$WORK/Dockerfile.frontend" || die 'Frontend Dockerfile does not use the allowlisted overlay.'
grep -Fq 'RUN node /tmp/apply-softventa-overlay.cjs backend' "$WORK/Dockerfile.backend" || die 'Backend Dockerfile does not use the allowlisted overlay.'
if grep -Eiq '^[+-][^+-].*(migrate-all|database/migrations|ALTER TABLE|mysql.*UPDATE|INSERT INTO sales)' "$WORK/frontend.patch" "$WORK/backend.patch"; then
  die 'El paquete contiene operaciones de migración o escritura comercial.'
fi
if grep -Eiq '^[+-][^+-].*(inicio/|assets/pwa|styles\.css|connected-inventory|system-admin|product-categor)' "$WORK/frontend.patch" "$WORK/backend.patch"; then
  die 'El parche incluye landing, presentación, categorías o Panel de Administración.'
fi

APP=/opt/pos/app
ENV_FILE=/etc/pos/production.env
PROJECT=pos-production
[[ -d "$APP" && -r "$ENV_FILE" ]] || die 'Falta el proyecto o env-file de producción.'
[[ "$(stat -c '%U:%G:%a' "$ENV_FILE")" == 'root:root:600' ]] || die 'production.env no conserva propietario y permisos esperados.'
docker compose version >/dev/null 2>&1 || die 'Docker Compose no está disponible.'
docker network inspect --format '{{.Name}}' pos-production_edge 2>/dev/null | grep -Fxq pos-production_edge || die 'No se encuentra la red pos-production_edge.'

active_cid() {
  local service="$1"; local -a ids
  mapfile -t ids < <(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$service")
  [[ ${#ids[@]} -eq 1 ]] || die "Se esperaba exactamente un contenedor activo para $service."
  [[ "$(docker inspect --format '{{.State.Running}}' "${ids[0]}")" == true ]] || die "$service no está en ejecución."
  printf '%s\n' "${ids[0]}"
}
assert_healthy() {
  local service="$1" cid="$2" state health
  state="$(docker inspect --format '{{.State.Status}}' "$cid")"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid")"
  [[ "$state" == running && ( "$health" == healthy || "$health" == none ) ]] || die "$service no está healthy."
}
wait_healthy() {
  local service="$1" i cid state health
  for i in $(seq 1 60); do
    local -a ids
    mapfile -t ids < <(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$service")
    if [[ ${#ids[@]} -eq 1 ]]; then
      cid="${ids[0]}"
      state="$(docker inspect --format '{{.State.Status}}' "$cid")"
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid")"
      if [[ "$state" == running && ( "$health" == healthy || "$health" == none ) ]]; then printf '%s\n' "$cid"; return 0; fi
    fi
    sleep 2
  done
  die "$service no llegó a healthy."
}
active_front_cid="$(active_cid frontend)"
active_back_cid="$(active_cid backend)"
active_mysql_cid="$(active_cid mysql)"
for pair in "frontend:$active_front_cid" "backend:$active_back_cid" "mysql:$active_mysql_cid"; do
  assert_healthy "${pair%%:*}" "${pair#*:}"
done
[[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$active_front_cid")" == "$APP" ]] || die 'Frontend no corresponde al proyecto esperado.'
CONFIG_RAW="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$active_front_cid")"
IFS=',' read -r -a CONFIG_FILES <<< "$CONFIG_RAW"
[[ ${#CONFIG_FILES[@]} -eq 2 || ${#CONFIG_FILES[@]} -eq 3 ]] || die 'No se identificaron los Compose activos.'
[[ "${CONFIG_FILES[0]}" == "$APP/compose.yaml" && "${CONFIG_FILES[1]}" == "$APP/compose.production.yaml" ]] || die 'Los Compose activos no son los esperados.'
for file in "${CONFIG_FILES[@]}"; do [[ -r "$file" ]] || die 'Falta un Compose activo.'; done
ENV_FILES=("$ENV_FILE")
if [[ ${#CONFIG_FILES[@]} -eq 3 ]]; then
  [[ "${CONFIG_FILES[2]}" == '/home/posadmin/pos-private-test.override.yaml' && -r "${CONFIG_FILES[2]}" && -r /home/posadmin/pos-private-test.env ]] || die 'El override activo no es el archivo privado conocido.'
  ENV_FILES+=(/home/posadmin/pos-private-test.env)
fi
COMPOSE=(docker compose --project-name "$PROJECT" --project-directory "$APP")
for env_file in "${ENV_FILES[@]}"; do COMPOSE+=(--env-file "$env_file"); done
for file in "${CONFIG_FILES[@]}"; do COMPOSE+=(-f "$file"); done
dc() { "${COMPOSE[@]}" "$@"; }
dc_images() {
  local backend="$1" frontend="$2"; shift 2
  env POS_BACKEND_IMAGE="$backend" POS_FRONTEND_IMAGE="$frontend" "${COMPOSE[@]}" "$@"
}
dc --profile tools config --quiet >/dev/null 2>&1 || die 'Compose config --quiet falló.'
dc --profile tools config --format json >"$WORK/compose.json" 2>/dev/null || die 'No se pudo revisar Compose sin mostrar secretos.'
compose_fields() {
  python3 -c 'import json,sys
s=json.load(open(sys.argv[1],encoding="utf-8"))["services"]
def value(name,key):
 e=s[name].get("environment") or {}
 if isinstance(e,dict): return str(e.get(key,""))
 for item in e:
  if item.startswith(key+"="): return item.split("=",1)[1]
 return ""
for x in (value("backend","DB_NAME"),value("mysql","MYSQL_DATABASE"),s["backend"]["image"],s["frontend"]["image"],s["migrate"]["image"]): print(x)' "$1"
}
mapfile -t CFG < <(compose_fields "$WORK/compose.json")
[[ ${#CFG[@]} -eq 5 ]] || die 'No se pudo fijar la configuración efectiva.'
DB_NAME="${CFG[0]}"; MYSQL_DB="${CFG[1]}"
ORIGINAL_BACK_REF="${CFG[2]}"; ORIGINAL_FRONT_REF="${CFG[3]}"; MIGRATE_REF="${CFG[4]}"
[[ "$DB_NAME" =~ ^pos_contabo_prod_[0-9]{8}$ && "$MYSQL_DB" == "$DB_NAME" ]] || die 'Compose no apunta a la base productiva esperada.'
[[ "$ORIGINAL_BACK_REF" == "$MIGRATE_REF" && -n "$ORIGINAL_FRONT_REF" && "$ORIGINAL_FRONT_REF" != *@* && "$ORIGINAL_BACK_REF" != *@* ]] || die 'Compose no conserva imágenes compartidas y etiquetables.'
[[ "$(docker inspect --format '{{.Image}}' "$active_front_cid")" == "$(docker image inspect --format '{{.Id}}' "$ORIGINAL_FRONT_REF")" ]] || die 'La referencia frontend no coincide con la imagen activa.'
[[ "$(docker inspect --format '{{.Image}}' "$active_back_cid")" == "$(docker image inspect --format '{{.Id}}' "$ORIGINAL_BACK_REF")" ]] || die 'La referencia backend no coincide con la imagen activa.'
ORIGINAL_FRONT_ID="$(docker inspect --format '{{.Image}}' "$active_front_cid")"
ORIGINAL_BACK_ID="$(docker inspect --format '{{.Image}}' "$active_back_cid")"
MYSQL_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$active_mysql_cid")"
MYSQL_MOUNTS="$(docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}@{{.Destination}};{{end}}{{end}}' "$active_mysql_cid")"
[[ "$MYSQL_MOUNTS" == *'pos-production_mysql_data@'* ]] || die 'No se identificó el volumen MySQL esperado.'

sql_scalar() {
  printf '%s\n' "$1" | docker exec -i "$active_mysql_cid" sh -lc 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql --user=root --batch --raw --skip-column-names --database="$1"' sh "$DB_NAME" | tail -n 1
}
[[ "$(sql_scalar 'SELECT DATABASE();')" == "$DB_NAME" ]] || die 'MySQL no está en la base esperada.'
category_columns="$(sql_scalar "SELECT COUNT(DISTINCT column_name) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='product_categories' AND column_name IN ('id','business_id','name','normalized_name');")"
category_unique_key="$(sql_scalar "SELECT COUNT(*) FROM (SELECT index_name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='product_categories' AND non_unique=0 GROUP BY index_name HAVING GROUP_CONCAT(column_name ORDER BY seq_in_index)='business_id,normalized_name') AS category_keys;")"
category_schema_before="$category_columns:$category_unique_key"
sales_columns="$(sql_scalar "SELECT COUNT(DISTINCT column_name) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='sales' AND column_name IN ('business_id','invoice_number','detail','client_id');")"
client_columns="$(sql_scalar "SELECT COUNT(DISTINCT column_name) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='clients' AND column_name IN ('business_id','id','name');")"
[[ "$category_columns" == 4 && "$category_unique_key" -ge 1 ]] || die 'El esquema product_categories publicado no está completo; no se ejecutarán migraciones.'
[[ "$sales_columns" == 4 && "$client_columns" == 3 ]] || die 'Faltan columnas actuales para búsqueda de facturas; no se ejecutarán migraciones.'
note 'DB_SCHEMA=PASS; facturación y categorías usan el esquema actual; solo se consultó metadata; sin migraciones'

verify_category_source() {
  local image="$1"
  docker run --rm --read-only --network none --entrypoint /bin/sh "$image" -ec '
  r=/app/backend/src/routes/inventory.js
  s=/app/backend/src/services/inventory.js
  failed=0
  check() {
    label="$1"; shift
    if "$@" >/dev/null 2>&1; then printf "CATEGORY_SOURCE_%s=PASS\n" "$label"
    else printf "CATEGORY_SOURCE_%s=FAIL\n" "$label"; failed=1; fi
  }
  check route_get grep -Eq "router.get\\('\''/product-categories'\''" "$r"
  check route_create_admin grep -Eq "router.post\\('\''/product-categories'\'', m.admin" "$r"
  check route_rename_admin grep -Eq "router.patch\\('\''/product-categories/:id'\'', m.admin" "$r"
  check list_business_scope grep -Fq "SELECT id, business_id, name FROM product_categories WHERE business_id = ? ORDER BY name, id" "$s"
  check create_business_insert grep -Fq "INSERT INTO product_categories (business_id, name, normalized_name)" "$s"
  check create_business_binding grep -Fq "current.business_id, data.name, data.normalizedName" "$s"
  check category_id_business_scope grep -Fq "WHERE business_id = ? AND id = ?" "$s"
  check rename_business_binding grep -Fq "data.name, data.normalizedName, current.business_id, id" "$s"
  check service_admin_guard grep -Fq "current.role !== '\''ADMIN'\''" "$s"
  check service_business_context grep -Fq "current.business_id" "$s"
  exit "$failed"
  '
}
verify_category_source "$ORIGINAL_BACK_ID" || die 'La imagen backend activa no conserva rutas de categorías admin y aislamiento por negocio.'
note 'CATEGORIES_READ_ONLY=PASS; list/create/rename endpoints, ADMIN guard and business scope present'

frontend_protected_hashes() {
  # The wildcard covers numbered PNGs; the standalone SVG is allowlisted by its exact path.
  docker run --rm --read-only --network none --entrypoint /bin/sh "$1" -ec '
  find /etc/nginx/conf.d /usr/share/nginx/html -type f \
    ! -path /usr/share/nginx/html/index.html \
    ! -path /usr/share/nginx/html/service-worker.js \
    ! -path /usr/share/nginx/html/app.js \
    ! -path /usr/share/nginx/html/api-client.js \
    ! -path /usr/share/nginx/html/connected-sales.js \
    ! -path /usr/share/nginx/html/manifest.webmanifest \
    ! -path /usr/share/nginx/html/inicio/index.html \
    ! -path '\''/usr/share/nginx/html/assets/pwa/softventaweb-favicon-20261106-*'\'' \
    ! -path '\''/usr/share/nginx/html/assets/pwa/softventaweb-favicon-20261106.svg'\'' \
    ! -path /usr/share/nginx/html/assets/pwa/softventaweb-touch-20261106-192.png \
    ! -path /usr/share/nginx/html/assets/pwa/softventaweb-pwa-20261106-512.png \
    -exec sha256sum {} + | LC_ALL=C sort
  '
}
backend_protected_hashes() {
  docker run --rm --read-only --network none --entrypoint /bin/sh "$1" -ec '
  find /app/backend/src /app/backend/scripts /app/database -type f \
    ! -path /app/backend/src/routes/sales.js \
    ! -path /app/backend/src/services/sales.js \
    -exec sha256sum {} + | LC_ALL=C sort
  '
}
compare_protected_hashes() {
  python3 - "$1" "$2" "$3" <<'PY'
import re, sys

surface, before_path, after_path = sys.argv[1:]
def read_hashes(path):
    hashes = {}
    for number, line in enumerate(open(path, encoding='utf-8'), 1):
        line = line.rstrip('\n')
        if not line: continue
        match = re.fullmatch(r'([a-f0-9]{64})  (.+)', line)
        if not match: raise SystemExit(f'{surface}_HASH_OUTPUT=INVALID file={path} line={number}')
        digest, name = match.groups()
        if name in hashes: raise SystemExit(f'{surface}_HASH_OUTPUT=DUPLICATE path={name}')
        hashes[name] = digest
    return hashes

before, after = read_hashes(before_path), read_hashes(after_path)
changed = False
for name in sorted(set(before) | set(after)):
    old, new = before.get(name), after.get(name)
    if old != new:
        changed = True
        print(f'{surface}_PROTECTED_FILE_CHANGE path={name} old_sha256={old or "MISSING"} new_sha256={new or "MISSING"}')
if changed:
    print(f'{surface}_PROTECTED_HASHES=FAIL')
    raise SystemExit(1)
print(f'{surface}_PROTECTED_HASHES=PASS')
PY
}
verify_presentation_base() {
  docker run --rm --read-only --network none --entrypoint /bin/sh "$1" -ec '
  root=/usr/share/nginx/html
  test -s "$root/index.html" && test -s "$root/styles.css" && test -s "$root/inicio/index.html" && test -s "$root/inicio/styles.css"
  grep -Eiq "<title>[[:space:]]*SoftVentaWeb[[:space:]]*</title>" "$root/index.html"
  grep -Eiq "<title>[[:space:]]*SoftVentaWeb[^<]*</title>" "$root/inicio/index.html"
  grep -Fq "softventaweb-logo.webp" "$root/index.html"
  grep -Fq "rel=\"manifest\"" "$root/index.html"
  test -s "$root/assets/pwa/softventaweb-logo.webp" && test -s "$root/manifest.webmanifest"
  '
}
verify_presentation_base "$ORIGINAL_FRONT_ID" || die 'La imagen activa no conserva el favicon, título, logo o landing publicados.'
BASE_FRONT_PROTECTED_FILE="$WORK/frontend-protected-base.sha256"
BASE_BACK_PROTECTED_FILE="$WORK/backend-protected-base.sha256"
frontend_protected_hashes "$ORIGINAL_FRONT_ID" > "$BASE_FRONT_PROTECTED_FILE" || die 'Unable to capture baseline frontend hashes.'
backend_protected_hashes "$ORIGINAL_BACK_ID" > "$BASE_BACK_PROTECTED_FILE" || die 'Unable to capture baseline backend hashes.'

if [[ "$MODE" == '--rollback' ]]; then
  BACKUP_DIR="/opt/pos/backups/softventa-billing-favicon-$ROLLBACK_TOKEN"
  [[ -s "$BACKUP_DIR/images.tsv" && -s "$BACKUP_DIR/identities.txt" && -s "$BACKUP_DIR/state" ]] || die 'No existe el respaldo completo para ese token.'
  [[ "$(stat -c '%U:%G:%a' "$BACKUP_DIR/images.tsv")" == 'root:root:600' && "$(stat -c '%U:%G:%a' "$BACKUP_DIR/identities.txt")" == 'root:root:600' ]] || die 'Permisos del respaldo no válidos.'
  mapfile -t BACKUP < "$BACKUP_DIR/images.tsv"
  mapfile -t IDENTITIES < "$BACKUP_DIR/identities.txt"
  [[ ${#BACKUP[@]} -eq 8 && ${#IDENTITIES[@]} -eq 8 && "${BACKUP[4]}" == "$EXPECTED_PACKAGE_SHA" && "${BACKUP[7]}" == "$DB_NAME" ]] || die 'El respaldo no corresponde a este paquete o base.'
  [[ "${BACKUP[5]}" == "$ORIGINAL_BACK_REF" && "${BACKUP[6]}" == "$ORIGINAL_FRONT_REF" ]] || die 'Las referencias Compose cambiaron desde el respaldo.'
  [[ "${IDENTITIES[0]}" == "$EXPECTED_PACKAGE_SHA" && "${IDENTITIES[5]}" == "$active_mysql_cid" && "${IDENTITIES[6]}" == "$MYSQL_IMAGE_ID" && "${IDENTITIES[7]}" == "$MYSQL_MOUNTS" ]] || die 'Cambió la identidad de MySQL desde el despliegue.'
  current_front_id="$(docker inspect --format '{{.Image}}' "$active_front_cid")"
  current_back_id="$(docker inspect --format '{{.Image}}' "$active_back_cid")"
  [[ "$current_front_id" == "${IDENTITIES[3]}" && "$current_back_id" == "${IDENTITIES[4]}" ]] || die 'Las imágenes activas ya cambiaron; no se aplicará un rollback obsoleto.'
  RESTORE_FRONT_TAG="${BACKUP[0]}"; RESTORE_FRONT_ID="${BACKUP[1]}"
  RESTORE_BACK_TAG="${BACKUP[2]}"; RESTORE_BACK_ID="${BACKUP[3]}"
  [[ "$(docker image inspect --format '{{.Id}}' "$RESTORE_FRONT_TAG")" == "$RESTORE_FRONT_ID" ]] || die 'La imagen frontend de respaldo no coincide.'
  [[ "$(docker image inspect --format '{{.Id}}' "$RESTORE_BACK_TAG")" == "$RESTORE_BACK_ID" ]] || die 'La imagen backend de respaldo no coincide.'
  read -r -p "Revertir frontend y backend al respaldo $ROLLBACK_TOKEN. Escriba exactamente ROLLBACK $ROLLBACK_TOKEN: " CONFIRM
  [[ "$CONFIRM" == "ROLLBACK $ROLLBACK_TOKEN" ]] || die 'No se confirmó rollback.'
  ORIGINAL_FRONT_ID="$current_front_id"; ORIGINAL_BACK_ID="$current_back_id"
  ORIGINAL_FRONT_REF="$ORIGINAL_FRONT_REF"; ORIGINAL_BACK_REF="$ORIGINAL_BACK_REF"
  DEPLOY_MUTATION_STARTED=1
  docker tag "$RESTORE_FRONT_ID" "$ORIGINAL_FRONT_REF"
  docker tag "$RESTORE_BACK_ID" "$ORIGINAL_BACK_REF"
  "${COMPOSE[@]}" up -d --no-deps --force-recreate backend frontend >/dev/null
  restored_front="$(wait_healthy frontend)"; restored_back="$(wait_healthy backend)"
  [[ "$(docker inspect --format '{{.Image}}' "$restored_front")" == "$RESTORE_FRONT_ID" && "$(docker inspect --format '{{.Image}}' "$restored_back")" == "$RESTORE_BACK_ID" ]] || die 'No se verificaron ambas imágenes de rollback.'
  [[ "$(active_cid mysql)" == "$active_mysql_cid" && "$(docker inspect --format '{{.Image}}' "$active_mysql_cid")" == "$MYSQL_IMAGE_ID" ]] || die 'MySQL cambió durante rollback.'
  DEPLOY_OK=1
  note "ROLLBACK=PASS; frontend/backend restaurados; MySQL sin cambios; backup=$BACKUP_DIR"
  exit 0
fi

short_id() { docker image inspect --format '{{.Id}}' "$1" | cut -d: -f2 | cut -c1-12; }
front_short="$(short_id "$ORIGINAL_FRONT_ID")"
back_short="$(short_id "$ORIGINAL_BACK_ID")"
package_short="$(printf '%s' "$EXPECTED_PACKAGE_SHA" | cut -c1-8)"
BASE_FRONT_TAG="pos-frontend:billing-favicon-base-$front_short-$package_short"
BASE_BACK_TAG="pos-backend:billing-favicon-base-$back_short-$package_short"
CAND_FRONT_TAG="pos-frontend:billing-favicon-candidate-$package_short-$front_short"
CAND_BACK_TAG="pos-backend:billing-favicon-candidate-$package_short-$back_short"
PREP_FRONT_TAG="pos-frontend:billing-favicon-prepared-$package_short-$front_short"
PREP_BACK_TAG="pos-backend:billing-favicon-prepared-$package_short-$back_short"
ensure_tag() {
  local image="$1" tag="$2" existing
  existing="$(docker image inspect --format '{{.Id}}' "$tag" 2>/dev/null || true)"
  if [[ -n "$existing" ]]; then [[ "$existing" == "$image" ]] || die "La etiqueta base ya apunta a otra imagen: $tag"
  else docker image tag "$image" "$tag"; fi
}
candidate_valid() {
  local tag="$1" front="$2" back="$3" is_front="$4" image package_label front_label back_label
  image="$(docker image inspect --format '{{.Id}}' "$tag" 2>/dev/null || true)"
  [[ -n "$image" ]] || return 1
  package_label="$(docker image inspect --format '{{index .Config.Labels "org.softventa.billing-favicon.package-sha256"}}' "$image")"
  back_label="$(docker image inspect --format '{{index .Config.Labels "org.softventa.billing-favicon.backend-base-image-id"}}' "$image")"
  if [[ "$is_front" == yes ]]; then front_label="$(docker image inspect --format '{{index .Config.Labels "org.softventa.billing-favicon.frontend-base-image-id"}}' "$image")"
  else front_label="$back_label"; fi
  [[ "$package_label" == "$EXPECTED_PACKAGE_SHA" && "$back_label" == "$back" && "$front_label" == "$front" ]]
}
diagnose_missing_candidate() {
  local role="$1" tag="$2" expected_front="$3" expected_back="$4" marker="$5" image package_label front_label back_label matched=0 repository marker_id marker_package marker_front marker_back
  note "CANDIDATE_${role}_EXISTS=FAIL; expected_tag=$tag"
  if [[ "$role" == FRONTEND ]]; then repository=pos-frontend; else repository=pos-backend; fi
  local -a candidate_images=()
  mapfile -t candidate_images < <(docker image ls --all --quiet --filter "reference=$repository:billing-favicon-candidate-*" | LC_ALL=C sort -u)
  for image in "${candidate_images[@]}"; do
    [[ -n "$image" ]] || continue
    package_label="$(docker image inspect --format '{{index .Config.Labels "org.softventa.billing-favicon.package-sha256"}}' "$image" 2>/dev/null || true)"
    front_label="$(docker image inspect --format '{{index .Config.Labels "org.softventa.billing-favicon.frontend-base-image-id"}}' "$image" 2>/dev/null || true)"
    back_label="$(docker image inspect --format '{{index .Config.Labels "org.softventa.billing-favicon.backend-base-image-id"}}' "$image" 2>/dev/null || true)"
    if [[ "$package_label" != "$EXPECTED_PACKAGE_SHA" ]]; then
      note "CANDIDATE_${role}_TAG=FAIL; reason=package_identity_mismatch; expected=$EXPECTED_PACKAGE_SHA; actual=$package_label; image_id=$image"
      matched=1
      continue
    fi
    if [[ "$role" == FRONTEND ]]; then
      if [[ "$front_label" != "$expected_front" || "$back_label" != "$expected_back" ]]; then
        note "ACTIVE_IMAGE_CHANGED=FAIL; service=frontend; current_frontend=$expected_front; prepared_frontend=$front_label; current_backend=$expected_back; prepared_backend=$back_label; image_id=$image"
      else
        note "CANDIDATE_${role}_TAG=FAIL; expected_tag=$tag; matching_package_and_base_image=$image; alias_missing_or_incorrect=yes"
        matched=1
      fi
    else
      if [[ "$back_label" != "$expected_back" ]]; then
        note "ACTIVE_IMAGE_CHANGED=FAIL; service=backend; current_backend=$expected_back; prepared_backend=$back_label; image_id=$image"
      else
        note "CANDIDATE_${role}_TAG=FAIL; expected_tag=$tag; matching_package_and_base_image=$image; alias_missing_or_incorrect=yes"
        matched=1
      fi
    fi
  done
  if [[ "$matched" == 0 && ${#candidate_images[@]} -eq 0 ]]; then note "CANDIDATE_${role}=MISSING; no candidate tag exists for this service"; fi
  marker_id="$(docker image inspect --format '{{.Id}}' "$marker" 2>/dev/null || true)"
  if [[ -z "$marker_id" ]]; then
    note "PREPARATION_STATE=FAIL; service=$role; validated_marker_missing=$marker; rerun -PrepareCandidateOnly before -Deploy"
  else
    marker_package="$(docker image inspect --format '{{index .Config.Labels "org.softventa.billing-favicon.package-sha256"}}' "$marker_id" 2>/dev/null || true)"
    marker_front="$(docker image inspect --format '{{index .Config.Labels "org.softventa.billing-favicon.frontend-base-image-id"}}' "$marker_id" 2>/dev/null || true)"
    marker_back="$(docker image inspect --format '{{index .Config.Labels "org.softventa.billing-favicon.backend-base-image-id"}}' "$marker_id" 2>/dev/null || true)"
    if [[ "$marker_package" != "$EXPECTED_PACKAGE_SHA" ]]; then
      note "CANDIDATE_${role}_TAG=FAIL; marker_package=$marker_package; expected_package=$EXPECTED_PACKAGE_SHA; marker_image=$marker_id"
    elif [[ "$role" == FRONTEND && ( "$marker_front" != "$expected_front" || "$marker_back" != "$expected_back" ) ]]; then
      note "ACTIVE_IMAGE_CHANGED=FAIL; service=frontend; current_frontend=$expected_front; prepared_frontend=$marker_front; current_backend=$expected_back; prepared_backend=$marker_back"
    elif [[ "$role" == BACKEND && "$marker_back" != "$expected_back" ]]; then
      note "ACTIVE_IMAGE_CHANGED=FAIL; service=backend; current_backend=$expected_back; prepared_backend=$marker_back"
    fi
    note "PREPARATION_STATE=FAIL; service=$role; validated_marker_exists=$marker; marker_image=$marker_id; candidate_alias=$tag"
  fi
}
diagnose_candidate_conflict() {
  local role="$1" tag="$2" expected_front="$3" expected_back="$4" image package_label front_label back_label
  image="$(docker image inspect --format '{{.Id}}' "$tag" 2>/dev/null || true)"
  [[ -n "$image" ]] || return 0
  package_label="$(docker image inspect --format '{{index .Config.Labels "org.softventa.billing-favicon.package-sha256"}}' "$image")"
  front_label="$(docker image inspect --format '{{index .Config.Labels "org.softventa.billing-favicon.frontend-base-image-id"}}' "$image")"
  back_label="$(docker image inspect --format '{{index .Config.Labels "org.softventa.billing-favicon.backend-base-image-id"}}' "$image")"
  if [[ "$role" == BACKEND ]]; then front_label="$back_label"; fi
  if [[ "$package_label" != "$EXPECTED_PACKAGE_SHA" ]]; then
    note "CANDIDATE_${role}_TAG=FAIL; tag=$tag; reason=package_identity_mismatch; expected=$EXPECTED_PACKAGE_SHA; actual=$package_label; image_id=$image"
  elif [[ "$front_label" != "$expected_front" || "$back_label" != "$expected_back" ]]; then
    note "ACTIVE_IMAGE_CHANGED=FAIL; service=$role; tag=$tag; expected_frontend=$expected_front; prepared_frontend=$front_label; expected_backend=$expected_back; prepared_backend=$back_label; image_id=$image"
  else
    note "CANDIDATE_${role}_TAG=FAIL; tag=$tag; reason=unexpected_existing_image_id=$image"
  fi
  note "PREPARATION_STATE=FAIL; service=$role; existing_candidate_tag_does_not_match_expected_metadata"
}
assert_prepared_candidate() {
  local role="$1" tag="$2" marker="$3" expected_front="$4" expected_back="$5" image package_label front_label back_label marker_id
  image="$(docker image inspect --format '{{.Id}}' "$tag" 2>/dev/null || true)"
  if [[ -z "$image" ]]; then diagnose_missing_candidate "$role" "$tag" "$expected_front" "$expected_back" "$marker"; return 1; fi
  note "CANDIDATE_${role}_EXISTS=PASS; tag=$tag; image_id=$image"
  package_label="$(docker image inspect --format '{{index .Config.Labels "org.softventa.billing-favicon.package-sha256"}}' "$image")"
  front_label="$(docker image inspect --format '{{index .Config.Labels "org.softventa.billing-favicon.frontend-base-image-id"}}' "$image")"
  back_label="$(docker image inspect --format '{{index .Config.Labels "org.softventa.billing-favicon.backend-base-image-id"}}' "$image")"
  if [[ "$role" == BACKEND ]]; then front_label="$back_label"; fi
  if [[ "$package_label" != "$EXPECTED_PACKAGE_SHA" ]]; then
    note "CANDIDATE_${role}_TAG=FAIL; reason=package_identity_mismatch; expected=$EXPECTED_PACKAGE_SHA; actual=$package_label"
    note "PREPARATION_STATE=FAIL; service=$role; candidate_metadata_invalid"
    return 1
  fi
  if [[ "$front_label" != "$expected_front" || "$back_label" != "$expected_back" ]]; then
    note "ACTIVE_IMAGE_CHANGED=FAIL; service=$role; current_frontend=$expected_front; prepared_frontend=$front_label; current_backend=$expected_back; prepared_backend=$back_label"
    note "PREPARATION_STATE=FAIL; service=$role; candidate_is_bound_to_different_active_images"
    return 1
  fi
  note "CANDIDATE_${role}_TAG=PASS; package_and_active_image_labels_match"
  marker_id="$(docker image inspect --format '{{.Id}}' "$marker" 2>/dev/null || true)"
  if [[ -z "$marker_id" ]]; then
    note "PREPARATION_STATE=FAIL; service=$role; validated_marker_missing=$marker; rerun -PrepareCandidateOnly before -Deploy"
    return 1
  fi
  if [[ "$marker_id" != "$image" ]]; then
    note "PREPARATION_STATE=FAIL; service=$role; candidate_image=$image; validated_marker_image=$marker_id"
    return 1
  fi
  note "PREPARATION_STATE=PASS; service=$role; candidate=$image; active_image_labels_bound=yes"
}
record_prepared_marker() {
  local role="$1" image="$2" marker="$3" existing
  existing="$(docker image inspect --format '{{.Id}}' "$marker" 2>/dev/null || true)"
  if [[ -n "$existing" && "$existing" != "$image" ]]; then
    note "PREPARATION_STATE=REFRESH; service=$role; marker=$marker; previous_image=$existing; validated_image=$image"
  fi
  if [[ "$existing" != "$image" ]]; then docker image tag "$image" "$marker" || die "Could not persist validated preparation marker for $role."; fi
  [[ "$(docker image inspect --format '{{.Id}}' "$marker")" == "$image" ]] || die "Preparation marker verification failed for $role."
  note "PREPARATION_STATE=PASS; service=$role; validated_marker=$marker; image_id=$image"
}
candidate_front_id=''; candidate_back_id=''
if [[ "$MODE" == '--prepare-only' ]]; then
  ensure_tag "$ORIGINAL_FRONT_ID" "$BASE_FRONT_TAG"
  ensure_tag "$ORIGINAL_BACK_ID" "$BASE_BACK_TAG"
  if ! candidate_valid "$CAND_FRONT_TAG" "$ORIGINAL_FRONT_ID" "$ORIGINAL_BACK_ID" yes; then
    if docker image inspect "$CAND_FRONT_TAG" >/dev/null 2>&1; then
      diagnose_candidate_conflict FRONTEND "$CAND_FRONT_TAG" "$ORIGINAL_FRONT_ID" "$ORIGINAL_BACK_ID"
      die 'Candidate frontend tag has conflicting package or active-image metadata.'
    fi
    docker build --pull=false --network=none \
      --build-arg "FRONTEND_BASE=$BASE_FRONT_TAG" --build-arg "BACKEND_BASE=$BASE_BACK_TAG" \
      --build-arg "FRONTEND_BASE_ID=$ORIGINAL_FRONT_ID" --build-arg "BACKEND_BASE_ID=$ORIGINAL_BACK_ID" \
      --build-arg "PACKAGE_SHA256=$EXPECTED_PACKAGE_SHA" \
      --file "$WORK/Dockerfile.frontend" --tag "$CAND_FRONT_TAG" "$WORK" >/dev/null || die 'Falló la candidata frontend.'
  fi
  if ! candidate_valid "$CAND_BACK_TAG" "$ORIGINAL_BACK_ID" "$ORIGINAL_BACK_ID" no; then
    if docker image inspect "$CAND_BACK_TAG" >/dev/null 2>&1; then
      diagnose_candidate_conflict BACKEND "$CAND_BACK_TAG" "$ORIGINAL_BACK_ID" "$ORIGINAL_BACK_ID"
      die 'Candidate backend tag has conflicting package or active-image metadata.'
    fi
    docker build --pull=false --network=none \
      --build-arg "BASE_IMAGE=$BASE_BACK_TAG" --build-arg "BASE_IMAGE_ID=$ORIGINAL_BACK_ID" \
      --build-arg "PACKAGE_SHA256=$EXPECTED_PACKAGE_SHA" \
      --file "$WORK/Dockerfile.backend" --tag "$CAND_BACK_TAG" "$WORK" >/dev/null || die 'Falló la candidata backend.'
  fi
else
  assert_prepared_candidate FRONTEND "$CAND_FRONT_TAG" "$PREP_FRONT_TAG" "$ORIGINAL_FRONT_ID" "$ORIGINAL_BACK_ID" || die 'Frontend candidate is not the validated prepared image for the current active bases; rerun -PrepareCandidateOnly.'
  assert_prepared_candidate BACKEND "$CAND_BACK_TAG" "$PREP_BACK_TAG" "$ORIGINAL_BACK_ID" "$ORIGINAL_BACK_ID" || die 'Backend candidate is not the validated prepared image for the current active base; rerun -PrepareCandidateOnly.'
fi
candidate_front_id="$(docker image inspect --format '{{.Id}}' "$CAND_FRONT_TAG")"
candidate_back_id="$(docker image inspect --format '{{.Id}}' "$CAND_BACK_TAG")"
[[ "$(docker image inspect --format '{{index .Config.Labels "org.softventa.billing-favicon.frontend-base-image-id"}}' "$candidate_front_id")" == "$ORIGINAL_FRONT_ID" ]] || die 'La candidata frontend no usa la imagen activa como base.'
[[ "$(docker image inspect --format '{{index .Config.Labels "org.softventa.billing-favicon.backend-base-image-id"}}' "$candidate_front_id")" == "$ORIGINAL_BACK_ID" ]] || die 'La candidata frontend no usó el runtime Node del backend activo.'
CAND_FRONT_PROTECTED_FILE="$WORK/frontend-protected-candidate.sha256"
CAND_BACK_PROTECTED_FILE="$WORK/backend-protected-candidate.sha256"
frontend_protected_hashes "$candidate_front_id" > "$CAND_FRONT_PROTECTED_FILE" || die 'Unable to capture candidate frontend hashes.'
backend_protected_hashes "$candidate_back_id" > "$CAND_BACK_PROTECTED_FILE" || die 'Unable to capture candidate backend hashes.'
compare_protected_hashes FRONTEND "$BASE_FRONT_PROTECTED_FILE" "$CAND_FRONT_PROTECTED_FILE" || die 'The candidate changed protected frontend files; inspect the per-file hashes above.'
compare_protected_hashes BACKEND "$BASE_BACK_PROTECTED_FILE" "$CAND_BACK_PROTECTED_FILE" || die 'The candidate changed protected backend files; inspect the per-file hashes above.'
verify_category_source "$candidate_back_id" || die 'La candidata alteró o perdió el flujo de categorías.'
verify_presentation_base "$candidate_front_id" || die 'La candidata no conserva la presentación publicada.'
for pair in "active:$ORIGINAL_FRONT_ID" "candidate:$candidate_front_id"; do
  label="${pair%%:*}"; image_id="${pair#*:}"
  docker run --rm --read-only --network none --entrypoint cat "$image_id" /usr/share/nginx/html/index.html > "$WORK/$label-index.html"
  docker run --rm --read-only --network none --entrypoint cat "$image_id" /usr/share/nginx/html/inicio/index.html > "$WORK/$label-landing.html"
  docker run --rm --read-only --network none --entrypoint cat "$image_id" /usr/share/nginx/html/manifest.webmanifest > "$WORK/$label-manifest.webmanifest"
  docker run --rm --read-only --network none --entrypoint cat "$image_id" /usr/share/nginx/html/service-worker.js > "$WORK/$label-service-worker.js"
done
python3 - "$WORK/active-index.html" "$WORK/candidate-index.html" "$WORK/active-landing.html" "$WORK/candidate-landing.html" "$WORK/active-manifest.webmanifest" "$WORK/candidate-manifest.webmanifest" "$WORK/active-service-worker.js" "$WORK/candidate-service-worker.js" <<'PY'
import difflib, json, re, sys

def html(path, invoice=False):
    text = open(path, encoding='utf-8').read()
    source_lines = text.splitlines(keepends=True)
    normalized = []
    icon_only_lines = []
    line_offsets = []
    offset = 0
    for line in source_lines:
        line_offsets.append(offset)
        offset += len(line)
        matches = list(re.finditer(r'<link\b[^>]*>', line, re.I))
        icon_tags = []
        replacements = []
        for match in matches:
            tag = match.group(0)
            rel = re.search(r'\brel=["\']([^"\']+)["\']', tag, re.I)
            tokens = set(rel.group(1).lower().split()) if rel else set()
            if tokens.intersection({'icon', 'shortcut', 'apple-touch-icon'}):
                icon_tags.append(match)
                replacements.append((match.start(), match.end(), ''))
            elif 'manifest' in tokens:
                updated = re.sub(r'(\bhref=["\'][^?"\']+)(?:\?v=[^"\']*)?(["\'])', r'\1\2', tag, flags=re.I)
                replacements.append((match.start(), match.end(), updated))
        icon_only = bool(matches and len(icon_tags) == len(matches))
        if icon_only:
            without_icons = line
            for match in reversed(icon_tags):
                without_icons = without_icons[:match.start()] + without_icons[match.end():]
            icon_only = not without_icons.strip()
        for start, end, value in reversed(replacements):
            line = line[:start] + value + line[end:]
        normalized.append('' if icon_only else line)
        icon_only_lines.append(icon_only)

    head = re.search(r'<head\b[^>]*>(.*?)</head>', text, re.I | re.S)
    icon_gaps = set()
    if head:
        head_start, head_end = head.start(1), head.end(1)
        for i, line in enumerate(source_lines):
            if not icon_only_lines[i] or not (head_start <= line_offsets[i] < head_end): continue
            previous = i - 1
            while previous >= 0 and (icon_only_lines[previous] or not normalized[previous].strip()): previous -= 1
            following = i + 1
            while following < len(source_lines) and (icon_only_lines[following] or not normalized[following].strip()): following += 1
            if previous >= 0 and following < len(source_lines):
                icon_gaps.add((normalized[previous].strip(), normalized[following].strip()))
    text = ''.join(normalized)
    if invoice:
        text = re.sub(r'<!-- SOFTVENTA_INVOICE_SEARCH_START -->.*?<!-- SOFTVENTA_INVOICE_SEARCH_END -->\s*', '', text, flags=re.S)
    return text, icon_gaps

def normalize_icon_gaps(text, icon_gaps):
    head = re.search(r'<head\b[^>]*>(.*?)</head>', text, re.I | re.S)
    if head and icon_gaps:
        head_lines = head.group(1).splitlines(keepends=True)
        for before, after in icon_gaps:
            i = 0
            while i < len(head_lines):
                if head_lines[i].strip() != before:
                    i += 1
                    continue
                j = i + 1
                while j < len(head_lines) and not head_lines[j].strip(): j += 1
                blank_count = j - i - 1
                if j < len(head_lines) and head_lines[j].strip() == after and 0 < blank_count <= 6:
                    del head_lines[i + 1:j]
                    i += 1
                else:
                    i += 1
        head_text = ''.join(head_lines)
        text = text[:head.start(1)] + head_text + text[head.end(1):]
    return text

def compare_html(label, before_path, after_path, invoice=False):
    before, before_gaps = html(before_path, invoice)
    after, after_gaps = html(after_path, invoice)
    icon_gaps = before_gaps | after_gaps
    before = normalize_icon_gaps(before, icon_gaps)
    after = normalize_icon_gaps(after, icon_gaps)
    if before != after:
        print(f'{label}=FAIL; normalized unified diff follows')
        diff = difflib.unified_diff(before.splitlines(keepends=True), after.splitlines(keepends=True),
            fromfile='active/' + label.lower() + '.html', tofile='candidate/' + label.lower() + '.html', n=3)
        sys.stdout.writelines(diff)
        raise SystemExit(1)
    print(f'{label}=PASS')

compare_html('POS_HTML_ALLOWLIST', sys.argv[1], sys.argv[2], True)
compare_html('LANDING_HTML_ALLOWLIST', sys.argv[3], sys.argv[4])

def manifest(path):
    data = json.load(open(path, encoding='utf-8'))
    for icon in data.get('icons', []):
        if icon.get('sizes') in {'192x192', '512x512'}: icon['src'] = '<versioned-' + icon['sizes'] + '>'
    return data
if manifest(sys.argv[5]) != manifest(sys.argv[6]): raise SystemExit('PWA_MANIFEST_ALLOWLIST=FAIL; changes outside versioned 192x192/512x512 icon paths.')
print('PWA_MANIFEST_ALLOWLIST=PASS')

def worker(path):
    text = open(path, encoding='utf-8').read()
    cache = re.search(r"^const CACHE_NAME = '([^']+)';$", text, re.M)
    precache = re.search(r'^const PRECACHE_URLS = (.+);$', text, re.M)
    if not cache or not precache: raise SystemExit('Unrecognized service-worker format.')
    urls = json.loads(precache.group(1))
    text = text.replace(cache.group(0), "const CACHE_NAME = '<revision>';", 1)
    text = text.replace(precache.group(0), "const PRECACHE_URLS = <precache>;", 1)
    return text, urls
old_worker, old_urls = worker(sys.argv[7])
new_worker, new_urls = worker(sys.argv[8])
required = [
    '/manifest.webmanifest?v=20261106',
    '/assets/pwa/softventaweb-favicon-20261106-16.png',
    '/assets/pwa/softventaweb-favicon-20261106-32.png',
    '/assets/pwa/softventaweb-favicon-20261106-48.png',
    '/assets/pwa/softventaweb-favicon-20261106.svg',
    '/assets/pwa/softventaweb-touch-20261106-192.png',
    '/assets/pwa/softventaweb-pwa-20261106-512.png'
]
if new_urls != sorted(set(old_urls + required)): raise SystemExit('SERVICE_WORKER_PRECACHE_ALLOWLIST=FAIL; URLs differ outside the favicon set.')
print('SERVICE_WORKER_PRECACHE_ALLOWLIST=PASS')
if old_worker != new_worker: raise SystemExit('SERVICE_WORKER_SOURCE_ALLOWLIST=FAIL; changes outside cache revision and icon precache.')
print('SERVICE_WORKER_SOURCE_ALLOWLIST=PASS')
PY
note 'PUBLISHED_SURFACES=PASS; active POS/login and landing are preserved outside favicon links; manifest and service-worker changes are allowlisted'
docker run --rm --network none --entrypoint /bin/sh "$candidate_front_id" -ec '
failed=0
check() {
  label="$1"; shift
  if "$@" >/dev/null 2>&1; then printf "CANDIDATE_FRONTEND_%s=PASS\n" "$label"
  else printf "CANDIDATE_FRONTEND_%s=FAIL\n" "$label"; failed=1; fi
}
check history_search_markup grep -Fq "id=\"historyInvoiceSearch\"" /usr/share/nginx/html/index.html
check service_worker_cache_prefix grep -Fq "const CACHE_PREFIX = '\''pos-pwa-shell-'\''" /usr/share/nginx/html/service-worker.js
check service_worker_api_client_precache grep -Fq "\"/api-client.js\"" /usr/share/nginx/html/service-worker.js
check history_search_logic grep -Fq "historyInvoiceSearch" /usr/share/nginx/html/app.js
check pos_favicon_png grep -Fq "softventaweb-favicon-20261106-16.png" /usr/share/nginx/html/index.html
check landing_favicon_png grep -Fq "softventaweb-favicon-20261106-32.png" /usr/share/nginx/html/inicio/index.html
check shortcut_icon_link grep -Fq "rel=\"shortcut icon\"" /usr/share/nginx/html/index.html
check apple_touch_icon_link grep -Fq "rel=\"apple-touch-icon\"" /usr/share/nginx/html/index.html
check manifest_cache_bust grep -Fq "manifest.webmanifest?v=20261106" /usr/share/nginx/html/index.html
check manifest_touch_icon grep -Fq "softventaweb-touch-20261106-192.png" /usr/share/nginx/html/manifest.webmanifest
check manifest_pwa_icon grep -Fq "softventaweb-pwa-20261106-512.png" /usr/share/nginx/html/manifest.webmanifest
check service_worker_svg_favicon grep -Fq "softventaweb-favicon-20261106.svg" /usr/share/nginx/html/service-worker.js
exit "$failed"
' || die 'One or more favicon, manifest, or service-worker checks failed; inspect the individual results.'
docker run --rm --network none --entrypoint node "$candidate_back_id" --check backend/src/routes/sales.js || die 'Error de sintaxis en ruta de ventas.'
docker run --rm --network none --entrypoint node "$candidate_back_id" --check backend/src/services/sales.js || die 'Error de sintaxis en servicio de ventas.'
docker run --rm --network none --entrypoint /bin/sh "$candidate_back_id" -ec '
grep -Fq "v.text(req.query.q, 100)" backend/src/routes/sales.js
grep -Fq "s.business_id = ?" backend/src/services/sales.js
grep -Fq "c.business_id = s.business_id" backend/src/services/sales.js
grep -Fq "options.maxId" backend/src/services/sales.js
grep -Fq "m.authenticate" backend/src/routes/sales.js
grep -Fq "MODULE_FORBIDDEN" backend/src/services/sales.js
grep -Eq "work\\(session, .history." backend/src/services/sales.js
' || die 'La búsqueda no conserva validación, aislamiento o paginación.'
note 'API_PERMISSIONS=PASS; authenticated route and history permission are preserved'
docker run --rm --network pos-production_edge --entrypoint nginx "$candidate_front_id" -t >/dev/null 2>&1 || die 'nginx -t falló en la candidata.'

frontend_release_hashes() {
  docker run --rm --read-only --network none --entrypoint /bin/sh "$1" -ec '
  root=/usr/share/nginx/html
  for f in app.js api-client.js connected-sales.js index.html inicio/index.html manifest.webmanifest service-worker.js \
    assets/pwa/softventaweb-favicon-20261106-16.png assets/pwa/softventaweb-favicon-20261106-32.png \
    assets/pwa/softventaweb-favicon-20261106-48.png assets/pwa/softventaweb-favicon-20261106.svg \
    assets/pwa/softventaweb-touch-20261106-192.png assets/pwa/softventaweb-pwa-20261106-512.png; do
    if [ -f "$root/$f" ]; then printf "%s|%s\n" "$(sha256sum "$root/$f" | cut -d" " -f1)" "$f"; else printf "MISSING|%s\n" "$f"; fi
  done
  '
}
extract_icon_routes() {
  python3 - "$1" "$2" "$3" <<'PY'
from html.parser import HTMLParser
from urllib.parse import urlsplit
import posixpath, sys
source, base, require_manifest = sys.argv[1], sys.argv[2], sys.argv[3] == 'yes'
class Links(HTMLParser):
    def __init__(self):
        super().__init__(); self.icon = False; self.manifest = False; self.routes = []
    def handle_starttag(self, tag, attrs):
        if tag.lower() != 'link': return
        values = dict((k.lower(), v or '') for k, v in attrs)
        rel = set(values.get('rel', '').lower().split())
        href = values.get('href', '')
        is_icon = bool(rel.intersection({'icon', 'apple-touch-icon'}))
        is_manifest = 'manifest' in rel
        self.icon |= is_icon; self.manifest |= is_manifest
        if not href or not (is_icon or is_manifest): return
        parts = urlsplit(href)
        if parts.scheme or parts.netloc: return
        path = parts.path
        if not path.startswith('/'): path = posixpath.normpath(posixpath.join(base, path))
        if '..' in path.split('/'): raise ValueError('icon path traversal')
        self.routes.append(path + (('?' + parts.query) if parts.query else ''))
page = Links()
page.feed(open(source, encoding='utf-8').read())
if not page.icon or (require_manifest and not page.manifest): raise SystemExit(2)
print('\n'.join(dict.fromkeys(page.routes)))
PY
}
http_probe_diagnostics() {
  local label="$1" route="$2" status="$3" remote="$4" headers="$5" body="$6" container="$7" origin="$8" file_route
  file_route="$(printf '%s' "$route" | cut -d '?' -f 1)"
  case "$file_route" in /*) ;; *) file_route='/' ;; esac
  case "$file_route" in *'/../'*|*/..) file_route='/' ;; esac
  printf 'HTTP_DIAGNOSTIC=FAIL; check=%s; route=%s; status=%s; remote_ip=%s; origin=%s; proxy_bypassed=yes; container=%s\n' \
    "$label" "$route" "$status" "$remote" "$origin" "$container" >&2
  if [[ -n "$headers" && -f "$headers" ]]; then
    grep -Ei '^(HTTP/|Server:|Content-Type:|Location:|Via:|X-Cache:|X-Served-By:)' "$headers" >&2 || true
  fi
  if [[ -n "$container" ]]; then
    docker exec "$container" sh -c '
      root=/usr/share/nginx/html
      requested="$root$1"
      printf "HTTP_DIAG_FILE=%s\n" "$requested"
      for p in "$root" "$root/assets" "$root/assets/pwa" "$requested"; do
        stat -c "mode=%a uid=%u gid=%g links=%h path=%n" "$p" 2>&1 || true
      done
      printf "HTTP_DIAG_NGINX_DIRECTIVES=\n"
      nginx -T 2>&1 | grep -E "^(user |[[:space:]]*(root|alias|deny|allow|disable_symlinks|try_files|auth_basic|error_page)([[:space:];]|$))" | sed -n "1,40p" || true
    ' sh "$file_route" >&2 || true
    docker logs --tail 25 "$container" 2>&1 | grep -Ei 'permission denied|forbidden|access forbidden|\[error\]| 403 ' >&2 || true
  fi
}
checked_http_get() {
  local label="$1" host="$2" route="$3" body="$4" headers="$5" container="$6" expected="$7" origin="$8"
  local result='' curl_rc=0 okay=0
  HTTP_STATUS=''; HTTP_REMOTE=''
  if result="$(curl --noproxy '*' --silent --show-error --connect-timeout 3 --max-time 10 \
    --dump-header "$headers" --output "$body" --write-out '%{http_code}|%{remote_ip}' \
    "http://$host$route" 2>/dev/null)"; then curl_rc=0; else curl_rc=$?; fi
  HTTP_STATUS="$(printf '%s' "$result" | cut -d '|' -f 1)"
  HTTP_REMOTE="$(printf '%s' "$result" | cut -d '|' -f 2)"
  if [[ "$expected" == '2xx' && "$HTTP_STATUS" =~ ^2[0-9][0-9]$ ]]; then okay=1; fi
  if [[ "$expected" == 'auth-denied' && ( "$HTTP_STATUS" == 401 || "$HTTP_STATUS" == 403 ) ]]; then okay=1; fi
  if [[ "$curl_rc" != 0 || "$okay" != 1 ]]; then
    http_probe_diagnostics "$label" "$route" "$HTTP_STATUS" "$HTTP_REMOTE" "$headers" "$body" "$container" "$origin"
    return 1
  fi
  note "HTTP_PROBE=PASS; check=$label; status=$HTTP_STATUS; remote_ip=$HTTP_REMOTE; origin=$origin; proxy_bypassed=yes; expected=$expected"
}
validate_routes() {
  local image="$1" name="$2" port headers body response status remote ready=0 route
  name="pos-invoice-check-$package_short-$front_short"
  port="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')" || die 'No se reservo un puerto loopback.'
  VALIDATION_ID="$(docker run -d --name "$name" --network pos-production_edge -p "127.0.0.1:$port:80" "$image")" || die 'No se pudo iniciar la candidata aislada.'
  [[ "$(docker port "$VALIDATION_ID" 80/tcp)" == "127.0.0.1:$port" ]] || die 'La candidata no quedo limitada a loopback.'
  note "HTTP_PROBE_ORIGIN=container-loopback; container=$VALIDATION_ID; bind=127.0.0.1:$port; proxy_bypassed=yes"
  for _ in $(seq 1 30); do
    response="$(curl --noproxy '*' --silent --show-error --connect-timeout 2 --max-time 4 --dump-header "$WORK/readiness.headers" --output /dev/null --write-out '%{http_code}|%{remote_ip}' "http://127.0.0.1:$port/" 2>/dev/null || true)"
    status="$(printf '%s' "$response" | cut -d '|' -f 1)"
    remote="$(printf '%s' "$response" | cut -d '|' -f 2)"
    if [[ "$status" =~ ^2[0-9][0-9]$ ]]; then ready=1; break; fi
    sleep 1
  done
  if [[ "$ready" != 1 ]]; then
    http_probe_diagnostics candidate_readiness / "$status" "$remote" "$WORK/readiness.headers" /dev/null "$VALIDATION_ID" "127.0.0.1:$port -> $VALIDATION_ID:80"
    die 'La candidata frontend no respondio 2xx en su puerto loopback.'
  fi
  note "HTTP_PROBE=PASS; check=candidate_readiness; status=$status; remote_ip=$remote; origin=container-loopback; proxy_bypassed=yes"
  headers="$WORK/root.headers"; body="$WORK/root.html"
  checked_http_get candidate_pos "127.0.0.1:$port" / "$body" "$headers" "$VALIDATION_ID" 2xx "127.0.0.1:$port -> $VALIDATION_ID:80" || die 'La ruta POS de la candidata fallo.'
  grep -Eiq '^Content-Type:[[:space:]]*text/html' "$headers" || die 'El POS no respondio HTML.'
  grep -Eiq '<title>[[:space:]]*SoftVentaWeb[[:space:]]*</title>' "$body" || die 'El titulo POS cambio.'
  grep -Fq 'id="historyInvoiceSearch"' "$body" || die 'Falta el buscador de facturas.'
  grep -Fq 'rel="shortcut icon"' "$body" || die 'Missing shortcut icon in POS/login.'
  grep -Fq 'rel="apple-touch-icon"' "$body" || die 'Missing apple-touch-icon in POS/login.'
  grep -Fq 'softventaweb-favicon-20261106-16.png' "$body" || die 'Missing versioned favicon in POS/login.'
  checked_http_get candidate_existing_logo "127.0.0.1:$port" /assets/pwa/softventaweb-logo.webp /dev/null "$WORK/logo.headers" "$VALIDATION_ID" 2xx "127.0.0.1:$port -> $VALIDATION_ID:80" || die 'Falta el logo publicado.'
  grep -Eiq '^Content-Type:[[:space:]]*image/webp' "$WORK/logo.headers" || die 'MIME invalido para el logo.'
  root_icon_routes="$(extract_icon_routes "$body" / yes)" || die 'No se pudieron identificar los iconos publicados del POS.'
  for route in /inicio/ /inicio/styles.css; do
    headers="$WORK/surface.$(printf '%s' "$route" | sha256sum | cut -c1-12).headers"
    checked_http_get candidate_landing_surface "127.0.0.1:$port" "$route" /dev/null "$headers" "$VALIDATION_ID" 2xx "127.0.0.1:$port -> $VALIDATION_ID:80" || die "La landing no responde: $route"
  done
  checked_http_get candidate_landing_html "127.0.0.1:$port" /inicio/ "$WORK/landing.html" "$WORK/landing.headers" "$VALIDATION_ID" 2xx "127.0.0.1:$port -> $VALIDATION_ID:80" || die 'No se pudo leer el HTML de la landing.'
  grep -Eiq '<title>[[:space:]]*SoftVentaWeb[^<]*</title>' "$WORK/landing.html" || die 'El titulo de la landing cambio.'
  grep -Fq 'rel="shortcut icon"' "$WORK/landing.html" || die 'Missing shortcut icon in landing.'
  grep -Fq 'rel="apple-touch-icon"' "$WORK/landing.html" || die 'Missing apple-touch-icon in landing.'
  grep -Fq 'softventaweb-favicon-20261106-16.png' "$WORK/landing.html" || die 'Missing versioned favicon in landing.'
  landing_icon_routes="$(extract_icon_routes "$WORK/landing.html" /inicio/ no)" || die 'No se pudieron identificar los iconos publicados de la landing.'
  grep -Fq 'manifest.webmanifest?v=20261106' "$body" || die 'PWA manifest cache version is missing.'
  checked_http_get candidate_manifest "127.0.0.1:$port" '/manifest.webmanifest?v=20261106' "$WORK/manifest.webmanifest" "$WORK/manifest.headers" "$VALIDATION_ID" 2xx "127.0.0.1:$port -> $VALIDATION_ID:80" || die 'PWA manifest route failed.'
  manifest_icon_routes="$(python3 - "$WORK/manifest.webmanifest" <<'PY'
import json, sys
from urllib.parse import urljoin, urlsplit
data = json.load(open(sys.argv[1], encoding='utf-8'))
if not isinstance(data.get('name'), str) or not data['name'].strip() or not isinstance(data.get('icons'), list): raise SystemExit(2)
sizes = {item.get('sizes'): item.get('src') for item in data['icons']}
if sizes.get('192x192') != '/assets/pwa/softventaweb-touch-20261106-192.png': raise SystemExit(2)
if sizes.get('512x512') != '/assets/pwa/softventaweb-pwa-20261106-512.png': raise SystemExit(2)
for item in data['icons']:
    url = urlsplit(urljoin('http://candidate.invalid/manifest.webmanifest', item['src']))
    if url.netloc != 'candidate.invalid' or '..' in url.path.split('/'): raise SystemExit(2)
    print(url.path + (('?' + url.query) if url.query else ''))
PY
)" || die 'Manifest brand or icon routes are invalid.'
  icon_routes="$(printf '%s\n%s\n%s\n' "$root_icon_routes" "$landing_icon_routes" "$manifest_icon_routes" | sed '/^$/d' | LC_ALL=C sort -u)"
  [[ -n "$icon_routes" ]] || die 'No hay rutas locales de icono que comprobar.'
  while IFS= read -r route; do
    headers="$WORK/icon.$(printf '%s' "$route" | sha256sum | cut -c1-12).headers"
    checked_http_get favicon_resource "127.0.0.1:$port" "$route" /dev/null "$headers" "$VALIDATION_ID" 2xx "127.0.0.1:$port -> $VALIDATION_ID:80" || die "No responde un recurso de favicon: $route"
    grep -Eiq '^Content-Type:[[:space:]]*(image/|application/)' "$headers" || die "MIME invalido para el recurso de icono: $route"
  done <<< "$icon_routes"
  checked_http_get candidate_api_health "127.0.0.1:$port" /api/health "$WORK/api-health.json" "$WORK/api-health.headers" "$VALIDATION_ID" 2xx "127.0.0.1:$port -> $VALIDATION_ID:80" || die 'API health endpoint failed.'
  checked_http_get candidate_invoice_history_unauth "127.0.0.1:$port" '/api/sales?q=softventa-candidate-check' "$WORK/api-sales-unauth.json" "$WORK/api-sales-unauth.headers" "$VALIDATION_ID" auth-denied "127.0.0.1:$port -> $VALIDATION_ID:80" || die 'Protected API route check failed.'
  api_status="$HTTP_STATUS"
  [[ "$api_status" == 401 || "$api_status" == 403 ]] || die 'Invoice history did not reject a request without a session.'
  note 'API_ROUTES=PASS; health is ready and unauthenticated invoice history is denied without writes'
  docker rm --force "$VALIDATION_ID" >/dev/null || die 'No se retiro el contenedor aislado.'
  VALIDATION_ID=''
  note 'CANDIDATE_ROUTES=PASS; POS, favicon, manifest, landing; temporary frontend bound to loopback'
}
validate_routes "$candidate_front_id" billing-favicon

front_changed="$(frontend_release_hashes "$candidate_front_id")"
front_base_changed="$(frontend_release_hashes "$ORIGINAL_FRONT_ID")"
back_changed="$(docker run --rm --network none --entrypoint /bin/sh "$candidate_back_id" -ec 'sha256sum /app/backend/src/routes/sales.js /app/backend/src/services/sales.js')"
back_base_changed="$(docker run --rm --network none --entrypoint /bin/sh "$ORIGINAL_BACK_ID" -ec 'sha256sum /app/backend/src/routes/sales.js /app/backend/src/services/sales.js')"
front_delta="$(diff -u <(printf '%s\n' "$front_base_changed") <(printf '%s\n' "$front_changed") || true)"
back_delta="$(diff -u <(printf '%s\n' "$back_base_changed") <(printf '%s\n' "$back_changed") || true)"
front_delta_paths="$(printf '%s\n' "$front_delta" | awk -F'|' '/^[+-][^+-]/ { gsub(/^[+-]/,"",$1); print $2 }' | sed '/^$/d' | LC_ALL=C sort -u | tr '\n' ',')"
back_delta_paths="$(printf '%s\n' "$back_delta" | awk -F'|' '/^[+-][^+-]/ { gsub(/^[+-]/,"",$1); print $2 }' | sed '/^$/d' | LC_ALL=C sort -u | tr '\n' ',')"
note "ACTIVE_CANDIDATE_FRONTEND_FILES=${front_delta_paths:-none}"
note "ACTIVE_CANDIDATE_BACKEND_FILES=${back_delta_paths:-none}"
if [[ "$MODE" == '--prepare-only' ]]; then
  record_prepared_marker FRONTEND "$candidate_front_id" "$PREP_FRONT_TAG"
  record_prepared_marker BACKEND "$candidate_back_id" "$PREP_BACK_TAG"
fi
if [[ "$front_changed" == "$front_base_changed" && "$back_changed" == "$back_base_changed" ]]; then
  note 'NO_CHANGES_REQUIRED=PASS; la funcionalidad ya está publicada; no se recrearon servicios'
  exit 0
fi

if [[ "$MODE" == '--prepare-only' ]]; then
  note "PREPARE_ONLY=PASS; candidate_frontend=$CAND_FRONT_TAG; candidate_backend=$CAND_BACK_TAG; active services unchanged; MySQL metadata read-only"
  exit 0
fi

[[ -t 0 ]] || die 'El despliegue requiere terminal interactiva.'
read -r -p 'Candidatas verificadas. Escriba exactamente PUBLICAR FACTURACION: ' CONFIRM
[[ "$CONFIRM" == 'PUBLICAR FACTURACION' ]] || die 'No se confirmó la publicación; servicios siguen intactos.'
UTC_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ROLLBACK_TOKEN="${UTC_STAMP}-$(printf '%s' "$front_short" | cut -c1-12)"
BACKUP_DIR="/opt/pos/backups/softventa-billing-favicon-$ROLLBACK_TOKEN"
[[ ! -e "$BACKUP_DIR" ]] || die 'El directorio de respaldo ya existe.'
FRONT_ROLLBACK_TAG="pos-frontend:rollback-pre-billing-favicon-$ROLLBACK_TOKEN"
BACK_ROLLBACK_TAG="pos-backend:rollback-pre-billing-favicon-$ROLLBACK_TOKEN"
docker image inspect "$FRONT_ROLLBACK_TAG" >/dev/null 2>&1 && die 'La etiqueta frontend de rollback ya existe.'
docker image inspect "$BACK_ROLLBACK_TAG" >/dev/null 2>&1 && die 'La etiqueta backend de rollback ya existe.'
install -d -o root -g root -m 700 "$BACKUP_DIR"
docker tag "$ORIGINAL_FRONT_ID" "$FRONT_ROLLBACK_TAG"
docker tag "$ORIGINAL_BACK_ID" "$BACK_ROLLBACK_TAG"
[[ "$(docker image inspect --format '{{.Id}}' "$FRONT_ROLLBACK_TAG")" == "$ORIGINAL_FRONT_ID" ]] || die 'No quedó fijada la imagen frontend de respaldo.'
[[ "$(docker image inspect --format '{{.Id}}' "$BACK_ROLLBACK_TAG")" == "$ORIGINAL_BACK_ID" ]] || die 'No quedó fijada la imagen backend de respaldo.'
printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n' \
  "$FRONT_ROLLBACK_TAG" "$ORIGINAL_FRONT_ID" "$BACK_ROLLBACK_TAG" "$ORIGINAL_BACK_ID" \
  "$EXPECTED_PACKAGE_SHA" "$ORIGINAL_BACK_REF" "$ORIGINAL_FRONT_REF" "$DB_NAME" |
  install -o root -g root -m 600 /dev/stdin "$BACKUP_DIR/images.tsv"
printf '%s\n' PREPARED | install -o root -g root -m 600 /dev/stdin "$BACKUP_DIR/state"
install -o root -g root -m 600 "$PACKAGE" "$BACKUP_DIR/invoice-overlay.tar.gz"
printf '%s\n' "$EXPECTED_PACKAGE_SHA" "$ORIGINAL_FRONT_ID" "$ORIGINAL_BACK_ID" "$candidate_front_id" "$candidate_back_id" "$active_mysql_cid" "$MYSQL_IMAGE_ID" "$MYSQL_MOUNTS" |
  install -o root -g root -m 600 /dev/stdin "$BACKUP_DIR/identities.txt"
DEPLOY_MUTATION_STARTED=1
printf '%s\n' DEPLOYING > "$BACKUP_DIR/state"
docker tag "$candidate_front_id" "$ORIGINAL_FRONT_REF" || die 'No se pudo asignar la candidata frontend a su referencia productiva.'
docker tag "$candidate_back_id" "$ORIGINAL_BACK_REF" || die 'No se pudo asignar la candidata backend a su referencia productiva.'
"${COMPOSE[@]}" up -d --no-deps --force-recreate backend frontend >/dev/null || die 'Compose no pudo actualizar solo backend/frontend.'
new_front="$(wait_healthy frontend)"; new_back="$(wait_healthy backend)"
[[ "$(docker inspect --format '{{.Image}}' "$new_front")" == "$candidate_front_id" ]] || die 'Frontend no usa la imagen candidata.'
[[ "$(docker inspect --format '{{.Image}}' "$new_back")" == "$candidate_back_id" ]] || die 'Backend no usa la imagen candidata.'
[[ "$(active_cid mysql)" == "$active_mysql_cid" && "$(docker inspect --format '{{.Image}}' "$active_mysql_cid")" == "$MYSQL_IMAGE_ID" ]] || die 'MySQL cambió inesperadamente.'
[[ "$(docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}@{{.Destination}};{{end}}{{end}}' "$active_mysql_cid")" == "$MYSQL_MOUNTS" ]] || die 'Cambió el volumen MySQL.'
category_columns_after="$(sql_scalar "SELECT COUNT(DISTINCT column_name) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='product_categories' AND column_name IN ('id','business_id','name','normalized_name');")"
category_unique_key_after="$(sql_scalar "SELECT COUNT(*) FROM (SELECT index_name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='product_categories' AND non_unique=0 GROUP BY index_name HAVING GROUP_CONCAT(column_name ORDER BY seq_in_index)='business_id,normalized_name') AS category_keys;")"
[[ "$category_columns_after:$category_unique_key_after" == "$category_schema_before" ]] || die 'Cambió el esquema de categorías; el helper no ejecutó migraciones.'
checked_http_get post_deploy_api_health 127.0.0.1:8080 /api/health "$WORK/health.json" "$WORK/health.headers" "$new_front" 2xx host-loopback-8080 || die "Post-deploy API health check failed."
checked_http_get post_deploy_pos 127.0.0.1:8080 / "$WORK/live-index.html" "$WORK/live-index.headers" "$new_front" 2xx host-loopback-8080 || die "The POS did not respond after deployment."
grep -Fq 'id="historyInvoiceSearch"' "$WORK/live-index.html" || die 'No se ve la búsqueda tras el despliegue.'
printf '%s\n' DEPLOYED > "$BACKUP_DIR/state"
DEPLOY_OK=1
note 'DEPLOY=PASS; frontend/backend only; no sales, migrations or MySQL data changes'
note "BACKUP_DIR=$BACKUP_DIR"
note "ROLLBACK_TOKEN=$ROLLBACK_TOKEN"
note "ROLLBACK_COMMAND=.\deploy-softventa-billing-favicon.ps1 -Rollback -RollbackTag $ROLLBACK_TOKEN"
