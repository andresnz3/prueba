#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

die() { printf 'DETENIDO: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || die "Falta comando requerido: $1"; }
[[ $# -eq 5 ]] || die 'Uso interno inválido.'
MODE="$1"; PACKAGE="$2"; EXPECTED_PACKAGE_SHA="$3"; EXPECTED_HELPER_SHA="$4"; ROLLBACK_TOKEN="$5"
[[ "$MODE" == '--prepare-only' || "$MODE" == '--deploy' || "$MODE" == '--rollback' ]] || die 'Modo inválido.'
[[ "$PACKAGE" =~ ^/home/posadmin/\.pos-invoice-[a-f0-9]{16}/invoice-overlay\.tar\.gz$ ]] || die 'Ruta de paquete no permitida.'
[[ "$EXPECTED_PACKAGE_SHA" =~ ^[a-f0-9]{64}$ && "$EXPECTED_HELPER_SHA" =~ ^[a-f0-9]{64}$ ]] || die 'SHA-256 inválido.'
if [[ "$MODE" == '--rollback' ]]; then
  [[ "$ROLLBACK_TOKEN" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]] || die 'Token de rollback inválido.'
else
  [[ -z "$ROLLBACK_TOKEN" ]] || die 'Rollback solo admite su token propio.'
fi
[[ "$(id -u)" == 0 ]] || die 'El helper debe ejecutarse con sudo.'
for c in docker python3 tar sha256sum awk grep sed find sort stat curl node; do need "$c"; done
[[ -f "$PACKAGE" && ! -L "$PACKAGE" && -f "$0" && ! -L "$0" ]] || die 'No se encuentran los archivos transferidos esperados.'
STAGE="$(dirname "$PACKAGE")"
[[ "$STAGE" =~ ^/home/posadmin/\.pos-invoice-[a-f0-9]{16}$ && "$(dirname "$0")" == "$STAGE" ]] || die 'El helper no coincide con el staging esperado.'
[[ "$(stat -c '%U:%G:%a' "$PACKAGE")" == 'posadmin:posadmin:600' ]] || die 'El paquete no conserva propietario y permisos esperados.'
[[ "$(stat -c '%U:%G:%a' "$0")" == 'posadmin:posadmin:600' ]] || die 'El helper no conserva propietario y permisos esperados.'
hash_file() { sha256sum "$1" | awk '{print $1}'; }
[[ "$(hash_file "$PACKAGE")" == "$EXPECTED_PACKAGE_SHA" && "$(hash_file "$0")" == "$EXPECTED_HELPER_SHA" ]] || die 'Las huellas SHA-256 no coinciden.'

WORK="$(mktemp -d /tmp/pos-invoice-search.XXXXXX)"
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
  case "$WORK" in /tmp/pos-invoice-search.*) rm -rf -- "$WORK" ;; *) note 'TEMP_CLEANUP=SKIP; ruta no permitida' ;; esac
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

mapfile -t ARCHIVE_FILES < <(tar -tzf "$PACKAGE" | LC_ALL=C sort)
EXPECTED_FILES=(Dockerfile.backend Dockerfile.frontend MANIFEST.sha256 apply-invoice-overlay.cjs backend.patch frontend.patch)
[[ ${#ARCHIVE_FILES[@]} -eq ${#EXPECTED_FILES[@]} ]] || die 'El paquete interno tiene archivos faltantes o adicionales.'
for i in 0 1 2 3 4 5; do [[ "${ARCHIVE_FILES[$i]}" == "${EXPECTED_FILES[$i]}" ]] || die 'El paquete interno no coincide con el allowlist.'; done
tar -xzf "$PACKAGE" -C "$WORK" --no-same-owner --no-same-permissions || die 'No se pudo extraer el paquete.'
(cd "$WORK" && sha256sum -c MANIFEST.sha256 >/dev/null) || die 'El manifiesto de payload no coincide.'
for f in Dockerfile.frontend Dockerfile.backend apply-invoice-overlay.cjs frontend.patch backend.patch; do [[ -s "$WORK/$f" && ! -L "$WORK/$f" ]] || die "Falta archivo allowlist: $f"; done
grep -Fq 'COPY --from=patcher /tmp/site /usr/share/nginx/html' "$WORK/Dockerfile.frontend" || die 'Dockerfile frontend no conserva la imagen base.'
grep -Fq 'RUN node /tmp/apply-invoice-overlay.cjs frontend' "$WORK/Dockerfile.frontend" || die 'Dockerfile frontend no usa el parche acotado.'
grep -Fq 'RUN node /tmp/apply-invoice-overlay.cjs backend' "$WORK/Dockerfile.backend" || die 'Dockerfile backend no usa el parche acotado.'
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
for x in (value("backend","DB_NAME"),value("mysql","MYSQL_DATABASE"),s["backend"]["image"],s["frontend"]["image"],s["migrate"]["image"]): print(x)'
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
  grep -Eq "router.get\\('/product-categories'" "$r"
  grep -Eq "router.post\\('/product-categories', m.admin" "$r"
  grep -Eq "router.patch\\('/product-categories/:id', m.admin" "$r"
  grep -Fq "SELECT id, business_id, name FROM product_categories WHERE business_id = ? ORDER BY name, id" "$s"
  grep -Fq "INSERT INTO product_categories (business_id, name, normalized_name)" "$s"
  grep -Fq "current.business_id, data.name, data.normalizedName" "$s"
  grep -Fq "WHERE business_id = ? AND id = ?" "$s"
  grep -Fq "data.name, data.normalizedName, current.business_id, id" "$s"
  grep -Fq "current.role !== 'ADMIN'" "$s"
  grep -Fq "current.business_id" "$s"
  '
}
verify_category_source "$ORIGINAL_BACK_ID" || die 'La imagen backend activa no conserva rutas de categorías admin y aislamiento por negocio.'
note 'CATEGORIES_READ_ONLY=PASS; list/create/rename endpoints, ADMIN guard and business scope present'

frontend_protected_hashes() {
  docker run --rm --read-only --network none --entrypoint /bin/sh "$1" -ec '
  find /etc/nginx/conf.d /usr/share/nginx/html -type f \
    ! -path /usr/share/nginx/html/index.html \
    ! -path /usr/share/nginx/html/service-worker.js \
    ! -path /usr/share/nginx/html/app.js \
    ! -path /usr/share/nginx/html/api-client.js \
    ! -path /usr/share/nginx/html/connected-sales.js \
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
verify_presentation_base() {
  docker run --rm --read-only --network none --entrypoint /bin/sh "$1" -ec '
  root=/usr/share/nginx/html
  test -s "$root/index.html" && test -s "$root/styles.css" && test -s "$root/inicio/index.html" && test -s "$root/inicio/styles.css"
  grep -Eiq "<title>[[:space:]]*SoftVentaWeb[[:space:]]*</title>" "$root/index.html"
  grep -Eiq "<title>[[:space:]]*SoftVentaWeb[[:space:]]*</title>" "$root/inicio/index.html"
  grep -Fq "rel=\"icon\"" "$root/index.html"
  grep -Fq "rel=\"icon\"" "$root/inicio/index.html"
  grep -Fq "softventaweb-logo.webp" "$root/index.html"
  grep -Fq "rel=\"manifest\"" "$root/index.html"
  test -s "$root/assets/pwa/softventaweb-logo.webp" && test -s "$root/manifest.webmanifest"
  '
}
verify_presentation_base "$ORIGINAL_FRONT_ID" || die 'La imagen activa no conserva el favicon, título, logo o landing publicados.'
BASE_FRONT_PROTECTED="$(frontend_protected_hashes "$ORIGINAL_FRONT_ID")" || die 'No se pudieron fijar hashes de landing/presentación.'
BASE_BACK_PROTECTED="$(backend_protected_hashes "$ORIGINAL_BACK_ID")" || die 'No se pudieron fijar hashes de categorías/admin/migraciones.'

if [[ "$MODE" == '--rollback' ]]; then
  BACKUP_DIR="/opt/pos/backups/softventa-invoice-search-$ROLLBACK_TOKEN"
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
BASE_FRONT_TAG="pos-frontend:invoice-base-$front_short-$package_short"
BASE_BACK_TAG="pos-backend:invoice-base-$back_short-$package_short"
CAND_FRONT_TAG="pos-frontend:invoice-candidate-$package_short-$front_short"
CAND_BACK_TAG="pos-backend:invoice-candidate-$package_short-$back_short"
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
  package_label="$(docker image inspect --format '{{index .Config.Labels "org.softventa.invoice.package-sha256"}}' "$image")"
  back_label="$(docker image inspect --format '{{index .Config.Labels "org.softventa.invoice.backend-base-image-id"}}' "$image")"
  if [[ "$is_front" == yes ]]; then front_label="$(docker image inspect --format '{{index .Config.Labels "org.softventa.invoice.frontend-base-image-id"}}' "$image")"
  else front_label="$back_label"; fi
  [[ "$package_label" == "$EXPECTED_PACKAGE_SHA" && "$back_label" == "$back" && "$front_label" == "$front" ]]
}
candidate_front_id=''; candidate_back_id=''
if [[ "$MODE" == '--prepare-only' ]]; then
  ensure_tag "$ORIGINAL_FRONT_ID" "$BASE_FRONT_TAG"
  ensure_tag "$ORIGINAL_BACK_ID" "$BASE_BACK_TAG"
  if ! candidate_valid "$CAND_FRONT_TAG" "$ORIGINAL_FRONT_ID" "$ORIGINAL_BACK_ID" yes; then
    docker image inspect "$CAND_FRONT_TAG" >/dev/null 2>&1 && die 'La etiqueta de candidata frontend existe con otra base o paquete.'
    docker build --pull=false --network=none \
      --build-arg "FRONTEND_BASE=$BASE_FRONT_TAG" --build-arg "BACKEND_BASE=$BASE_BACK_TAG" \
      --build-arg "FRONTEND_BASE_ID=$ORIGINAL_FRONT_ID" --build-arg "BACKEND_BASE_ID=$ORIGINAL_BACK_ID" \
      --build-arg "PACKAGE_SHA256=$EXPECTED_PACKAGE_SHA" \
      --file "$WORK/Dockerfile.frontend" --tag "$CAND_FRONT_TAG" "$WORK" >/dev/null || die 'Falló la candidata frontend.'
  fi
  if ! candidate_valid "$CAND_BACK_TAG" "$ORIGINAL_BACK_ID" "$ORIGINAL_BACK_ID" no; then
    docker image inspect "$CAND_BACK_TAG" >/dev/null 2>&1 && die 'La etiqueta de candidata backend existe con otra base o paquete.'
    docker build --pull=false --network=none \
      --build-arg "BASE_IMAGE=$BASE_BACK_TAG" --build-arg "BASE_IMAGE_ID=$ORIGINAL_BACK_ID" \
      --build-arg "PACKAGE_SHA256=$EXPECTED_PACKAGE_SHA" \
      --file "$WORK/Dockerfile.backend" --tag "$CAND_BACK_TAG" "$WORK" >/dev/null || die 'Falló la candidata backend.'
  fi
else
  candidate_valid "$CAND_FRONT_TAG" "$ORIGINAL_FRONT_ID" "$ORIGINAL_BACK_ID" yes || die 'La candidata frontend no existe o la imagen activa cambió desde PrepareCandidateOnly.'
  candidate_valid "$CAND_BACK_TAG" "$ORIGINAL_BACK_ID" "$ORIGINAL_BACK_ID" no || die 'La candidata backend no existe o la imagen activa cambió desde PrepareCandidateOnly.'
fi
candidate_front_id="$(docker image inspect --format '{{.Id}}' "$CAND_FRONT_TAG")"
candidate_back_id="$(docker image inspect --format '{{.Id}}' "$CAND_BACK_TAG")"
[[ "$(docker image inspect --format '{{index .Config.Labels "org.softventa.invoice.frontend-base-image-id"}}' "$candidate_front_id")" == "$ORIGINAL_FRONT_ID" ]] || die 'La candidata frontend no usa la imagen activa como base.'
[[ "$(docker image inspect --format '{{index .Config.Labels "org.softventa.invoice.backend-base-image-id"}}' "$candidate_front_id")" == "$ORIGINAL_BACK_ID" ]] || die 'La candidata frontend no usó el runtime Node del backend activo.'
[[ "$(frontend_protected_hashes "$candidate_front_id")" == "$BASE_FRONT_PROTECTED" ]] || die 'Cambió CSS, favicon, logo, landing, Nginx u otro recurso fuera del allowlist.'
[[ "$(backend_protected_hashes "$candidate_back_id")" == "$BASE_BACK_PROTECTED" ]] || die 'Cambió un módulo distinto de facturación, categorías, administración o migraciones.'
verify_category_source "$candidate_back_id" || die 'La candidata alteró o perdió el flujo de categorías.'
verify_presentation_base "$candidate_front_id" || die 'La candidata no conserva la presentación publicada.'
docker run --rm --network none --entrypoint /bin/sh "$candidate_front_id" -ec '
grep -Fq "id=\"historyInvoiceSearch\"" /usr/share/nginx/html/index.html
grep -Fq "const CACHE_PREFIX = 'pos-pwa-shell-'" /usr/share/nginx/html/service-worker.js
grep -Fq '"/api-client.js"' /usr/share/nginx/html/service-worker.js
grep -Fq "historyInvoiceSearch" /usr/share/nginx/html/app.js
' || die 'La candidata no contiene la búsqueda de facturas o su precache.'
docker run --rm --network none --entrypoint node "$candidate_back_id" --check backend/src/routes/sales.js || die 'Error de sintaxis en ruta de ventas.'
docker run --rm --network none --entrypoint node "$candidate_back_id" --check backend/src/services/sales.js || die 'Error de sintaxis en servicio de ventas.'
docker run --rm --network none --entrypoint /bin/sh "$candidate_back_id" -ec '
grep -Fq "v.text(req.query.q, 100)" backend/src/routes/sales.js
grep -Fq "s.business_id = ?" backend/src/services/sales.js
grep -Fq "c.business_id = s.business_id" backend/src/services/sales.js
grep -Fq "options.maxId" backend/src/services/sales.js
' || die 'La búsqueda no conserva validación, aislamiento o paginación.'
docker run --rm --network pos-production_edge --entrypoint nginx "$candidate_front_id" -t >/dev/null 2>&1 || die 'nginx -t falló en la candidata.'

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
validate_routes() {
  local image="$1" name="$2" port headers body
  name="pos-invoice-check-$package_short-$front_short"
  port="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')" || die 'No se reservó un puerto loopback.'
  VALIDATION_ID="$(docker run -d --name "$name" --network pos-production_edge -p "127.0.0.1:$port:80" "$image")" || die 'No se pudo iniciar la candidata aislada.'
  [[ "$(docker port "$VALIDATION_ID" 80/tcp)" == "127.0.0.1:$port" ]] || die 'La candidata no quedó limitada a loopback.'
  for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$port/" -o /dev/null && break || sleep 1; done
  headers="$WORK/root.headers"; body="$WORK/root.html"
  curl --silent --show-error --fail --max-time 10 --dump-header "$headers" --output "$body" "http://127.0.0.1:$port/" || die 'La ruta POS de la candidata falló.'
  grep -Eiq '^Content-Type:[[:space:]]*text/html' "$headers" || die 'El POS no respondió HTML.'
  grep -Eiq '<title>[[:space:]]*SoftVentaWeb[[:space:]]*</title>' "$body" || die 'El título POS cambió.'
  grep -Fq 'id="historyInvoiceSearch"' "$body" || die 'Falta el buscador de facturas.'
  curl --silent --show-error --fail --max-time 10 --dump-header "$WORK/logo.headers" --output /dev/null "http://127.0.0.1:$port/assets/pwa/softventaweb-logo.webp" || die 'Falta el logo publicado.'
  grep -Eiq '^Content-Type:[[:space:]]*image/webp' "$WORK/logo.headers" || die 'MIME inválido para el logo.'
  root_icon_routes="$(extract_icon_routes "$body" / yes)" || die 'No se pudieron identificar los iconos publicados del POS.'
  for route in /inicio/ /inicio/styles.css; do
    curl --silent --show-error --fail --max-time 10 --output /dev/null "http://127.0.0.1:$port$route" || die "La landing no responde: $route"
  done
  curl --silent --show-error --fail --max-time 10 --output "$WORK/landing.html" "http://127.0.0.1:$port/inicio/" || die 'No se pudo leer el HTML de la landing.'
  grep -Eiq '<title>[[:space:]]*SoftVentaWeb[[:space:]]*</title>' "$WORK/landing.html" || die 'El título de la landing cambió.'
  landing_icon_routes="$(extract_icon_routes "$WORK/landing.html" /inicio/ no)" || die 'No se pudieron identificar los iconos publicados de la landing.'
  icon_routes="$(printf '%s\n%s\n' "$root_icon_routes" "$landing_icon_routes" | sed '/^$/d' | LC_ALL=C sort -u)"
  [[ -n "$icon_routes" ]] || die 'No hay rutas locales de icono que comprobar.'
  while IFS= read -r route; do
    headers="$WORK/icon.$(printf '%s' "$route" | sha256sum | cut -c1-12).headers"
    curl --silent --show-error --fail --max-time 10 --dump-header "$headers" --output /dev/null "http://127.0.0.1:$port$route" || die "No responde un recurso de favicon: $route"
    grep -Eiq '^Content-Type:[[:space:]]*(image/|application/)' "$headers" || die "MIME inválido para el recurso de icono: $route"
  done <<< "$icon_routes"
  docker rm --force "$VALIDATION_ID" >/dev/null || die 'No se retiró el contenedor aislado.'
  VALIDATION_ID=''
  note 'CANDIDATE_ROUTES=PASS; POS, favicon, manifest, landing; temporary frontend bound to loopback'
}
validate_routes "$candidate_front_id" invoice-search

front_changed="$(docker run --rm --network none --entrypoint /bin/sh "$candidate_front_id" -ec 'sha256sum /usr/share/nginx/html/app.js /usr/share/nginx/html/api-client.js /usr/share/nginx/html/connected-sales.js /usr/share/nginx/html/index.html /usr/share/nginx/html/service-worker.js')"
front_base_changed="$(docker run --rm --network none --entrypoint /bin/sh "$ORIGINAL_FRONT_ID" -ec 'sha256sum /usr/share/nginx/html/app.js /usr/share/nginx/html/api-client.js /usr/share/nginx/html/connected-sales.js /usr/share/nginx/html/index.html /usr/share/nginx/html/service-worker.js')"
back_changed="$(docker run --rm --network none --entrypoint /bin/sh "$candidate_back_id" -ec 'sha256sum /app/backend/src/routes/sales.js /app/backend/src/services/sales.js')"
back_base_changed="$(docker run --rm --network none --entrypoint /bin/sh "$ORIGINAL_BACK_ID" -ec 'sha256sum /app/backend/src/routes/sales.js /app/backend/src/services/sales.js')"
if [[ "$front_changed" == "$front_base_changed" && "$back_changed" == "$back_base_changed" ]]; then
  note 'NO_CHANGES_REQUIRED=PASS; la funcionalidad ya está publicada; no se recrearon servicios'
  exit 0
fi

if [[ "$MODE" == '--prepare-only' ]]; then
  note "PREPARE_ONLY=PASS; candidate_frontend=$CAND_FRONT_TAG; candidate_backend=$CAND_BACK_TAG; active services unchanged; MySQL read-only"
  exit 0
fi

[[ -t 0 ]] || die 'El despliegue requiere terminal interactiva.'
read -r -p 'Candidatas verificadas. Escriba exactamente PUBLICAR FACTURACION: ' CONFIRM
[[ "$CONFIRM" == 'PUBLICAR FACTURACION' ]] || die 'No se confirmó la publicación; servicios siguen intactos.'
UTC_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ROLLBACK_TOKEN="${UTC_STAMP}-$(printf '%s' "$front_short" | cut -c1-12)"
BACKUP_DIR="/opt/pos/backups/softventa-invoice-search-$ROLLBACK_TOKEN"
[[ ! -e "$BACKUP_DIR" ]] || die 'El directorio de respaldo ya existe.'
FRONT_ROLLBACK_TAG="pos-frontend:rollback-pre-invoice-$ROLLBACK_TOKEN"
BACK_ROLLBACK_TAG="pos-backend:rollback-pre-invoice-$ROLLBACK_TOKEN"
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
curl --silent --show-error --fail --max-time 10 http://127.0.0.1:8080/api/health -o "$WORK/health.json" || die 'El health endpoint no respondió.'
curl --silent --show-error --fail --max-time 10 http://127.0.0.1:8080/ -o "$WORK/live-index.html" || die 'El POS no respondió tras el despliegue.'
grep -Fq 'id="historyInvoiceSearch"' "$WORK/live-index.html" || die 'No se ve la búsqueda tras el despliegue.'
printf '%s\n' DEPLOYED > "$BACKUP_DIR/state"
DEPLOY_OK=1
note 'DEPLOY=PASS; solo frontend/backend; sin ventas de prueba, sin migraciones, sin cambios en MySQL'
note "BACKUP_DIR=$BACKUP_DIR"
note "ROLLBACK_TOKEN=$ROLLBACK_TOKEN"
note "ROLLBACK_COMMAND=.\deploy-softventa-invoice-search.ps1 -Rollback -RollbackTag $ROLLBACK_TOKEN"
