# SoftVenta — paquete conjunto: permisos + reservas

## Estado y alcance

Paquete preparado desde las imágenes QA finales que el operador probó y aprobó. Incluye Excel, permisos personalizados por apartados y reservas de inventario. No incluye la migración 023. No se conectó a Contabo, no se ejecutó ninguna migración productiva ni se cambió producción.

El paquete no contiene `.env`, claves, contraseñas, datos de negocios, bases de datos ni imágenes de productos. El archivo de imágenes Docker solo contiene las dos imágenes de aplicación listadas en `manifests/IMAGE-IDS.txt`.

## Imágenes verificadas

| Artefacto | Etiqueta de entrega | Image ID | Base aprobada |
|---|---|---|---|
| Frontend | `sv-softventa-frontend:permisos-reservas-20261121-c4a98ed1` | `sha256:f599b0995c00086ffb0393d020f1e51d180e8f69cab728d8588a80dd427b4288` | `sha256:291e7b83a9ed99ccb735764de20a1ad1f2bf6c93b4b64ee8cc763009755832e8` |
| Backend | `sv-softventa-backend:permisos-reservas-20261121-c4a98ed1` | `sha256:8858869b8d884bdd1a8397de93d07666055c6afaf5f5fde3e97d689b6ed2c819` | `sha256:c357b5a1e36d4e7f3bbac299ecae0b903007ac391572010dad91e575b40dfa65` |

El archivo `images/softventa-permissions-reservations-images.tar.gz` tiene SHA-256 `d8b8a4f13ed906a0b031aeff2d0c6b788eaaf9c245a01f33440397786123190f` y 127,961,416 bytes. Se cargó de vuelta en Docker local: las dos etiquetas resultaron en los mismos Image IDs. Los tests críticos se ejecutaron contra esos mismos IDs antes de empaquetarlos.

El manifiesto completo de archivos del paquete es `manifests/SHA256SUMS.txt`. Las credenciales privadas de producción deben seguir en `/etc/pos/production.env` y en el almacén privado de secretos; no se transfieren dentro de este paquete.

## Migraciones

- 021 y 022 permanecen intactas. El contenido de la imagen backend final tiene los checksums `d412cd557dc1359c6000a6b4cd9d6edc64ccb5e229e87e4a41e411cc0b68f93c` y `5db367fcc9c65c7e48e79bf324138f1af0213e3cb80732ef74b1209f378e0157`, respectivamente. Coinciden con los valores de producción proporcionados previamente por el operador.
- 024 crea exclusivamente tablas nuevas para perfiles y apartados permitidos. No actualiza usuarios existentes ni cambia contraseñas. Los usuarios sin perfil explícito conservan el comportamiento previo; los permisos personalizados quedan almacenados por negocio/usuario.
- 025 crea exclusivamente la tabla `sale_order_inventory_reservations`, con claves foráneas, índice por negocio/producto/estado y clave única por línea de orden. No descuenta stock ni modifica órdenes durante la migración.
- El registro del migrador requiere 022 para 024 y 024 para 025. No contiene 023. El plan QA local confirmó 001–022 y 024–025 aplicadas, sin fila 023.

Checksums del SQL incluido:

- 024: `16d34641e3f03e5eca47c2f6a20ee248a6c781bfa1842ebd9455f172b9ab7e73`
- 025: `9ef10f924a17b6a29d14da8353e40f59d0d61847b8a542cecff0499e51a284b0`

No correr `023` ni continuar si la consulta de preflight encuentra una fila 023, un estado parcial, una diferencia de checksum o una migración 001–022 pendiente/desconocida.

## Compatibilidad con órdenes pendientes existentes

025 no hace backfill. Una orden pendiente anterior que no tenga fila en la nueva tabla se cuenta como una retención virtual a partir de `sale_order_items`; no se inserta una segunda reserva ni se duplica la cantidad.

El backend nuevo resta del disponible las reservas explícitas y las líneas pendientes anteriores. Al cotizar/cobrar una orden anterior, valida el stock excluyendo la orden actual y las órdenes posteriores; bloquea si ya no hay unidades suficientes. Al cobrar, el flujo normal descuenta stock físico una sola vez y la orden deja de contarse como pendiente. Al cancelar, la orden deja de contribuir a la disponibilidad; no se crea una salida/entrada de Kardex y el stock físico no cambia. La prueba MySQL de QA cubrió una orden anterior al esquema: se retuvo, se cobró una vez y el saldo físico terminó en cero.

El preflight informa cantidad de órdenes, líneas, negocios, productos cuyo total pendiente excede el stock físico y unidades excedidas, sin mostrar nombres de clientes ni detalles de órdenes. Si `products_already_overcommitted` o `excess_pending_units` es mayor que cero, **detener la publicación**. No intentar arreglarlo haciendo backfill manual: primero revisar las órdenes en Caja y resolver/reponer según la decisión operativa del negocio. Si hay pendientes pero no hay sobrecompromiso, pueden mantenerse durante el cambio; el backend nuevo los incluye en disponibilidad desde el primer arranque.

## Paso 1 — Transferir y verificar el paquete

Desde la computadora del operador, después de acordar la ventana:

```powershell
scp -r "C:\Users\andre\AppData\Local\Temp\softventa-stock-reservation-qa-20261121-c4a98ed1\candidate\release\permissions-reservations-release-20261121" posadmin@31.220.84.51:/opt/pos/releases/
```

En Contabo, definir las rutas y verificar los hashes. Este paso solo copia artefactos; no inicia contenedores ni toca MySQL:

```bash
set -euo pipefail
PROJECT=pos-production
APP_DIR=/opt/pos/app
ENV_FILE=/etc/pos/production.env
RELEASE_DIR=/opt/pos/releases/permissions-reservations-release-20261121
DB_EXPECTED=pos_contabo_prod_20261029
cd "$RELEASE_DIR"
sha256sum -c manifests/SHA256SUMS.txt
```

## Paso 2 — Preflight de solo lectura en producción

No continúes si un contenedor no está healthy, la base seleccionada no es `pos_contabo_prod_20261029`, 021/022 no coinciden exactamente, 023 aparece, 024/025 están parcialmente instaladas, el índice/estructura de `product_categories` difiere, hay productos con más unidades pendientes que stock o hay órdenes pendientes con referencias a productos inexistentes.

Los SQL `SQL/preflight-before-migration.read-only.sql` y `SQL/postflight-after-migration.read-only.sql` contienen únicamente `SELECT`/CTE `WITH ... SELECT` e `INFORMATION_SCHEMA`. Fueron ejecutados contra MySQL QA aislado; **no se ejecutaron contra Contabo**.

```bash
dc_base() {
  docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" \
    --file "$APP_DIR/compose.yaml" \
    --file "$APP_DIR/compose.production.yaml" "$@"
}
dc_base config --quiet
dc_base ps

for SERVICE in mysql backend frontend; do
  CID="$(dc_base ps -q "$SERVICE")"
  test -n "$CID"
  docker inspect --format '{{.Name}}|{{.Config.Image}}|{{.Image}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$CID"
done

dc_base exec -T mysql sh -ec \
  'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql --user=root --database="$MYSQL_DATABASE" --batch --raw' \
  < "$RELEASE_DIR/SQL/preflight-before-migration.read-only.sql"
```

La consulta de conteos no devuelve nombres de clientes. Guardá una copia del resultado del ledger y los agregados; no incluyas secretos. El valor esperado de `migration_023_ledger_rows` es 0. La fila 021 debe coincidir con `d412...f93c`, y 022 con `5db...0157`, ambas `APPLIED`.

## Paso 3 — Cargar y comprobar las imágenes sin activarlas

```bash
docker image load --input "$RELEASE_DIR/images/softventa-permissions-reservations-images.tar.gz"
docker image inspect \
  sv-softventa-frontend:permisos-reservas-20261121-c4a98ed1 \
  sv-softventa-backend:permisos-reservas-20261121-c4a98ed1 \
  --format '{{.RepoTags}}|{{.Id}}'
```

Los IDs deben coincidir exactamente con la tabla de imágenes de este documento. Valida la configuración Compose sin imprimirla (puede interpolar variables privadas):

```bash
dc_release() {
  docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" \
    --file "$APP_DIR/compose.yaml" \
    --file "$APP_DIR/compose.production.yaml" \
    --file "$RELEASE_DIR/compose.permissions-reservations.override.yaml" "$@"
}
dc_release config --quiet
```

## Paso 4 — Preparar y verificar el respaldo

El script oficial `scripts/docker-backup.cjs` se detiene de forma segura si `backend` o `frontend` siguen corriendo. Usa `mysqldump --single-transaction`, compara manifiestos de DB antes/después, archiva las imágenes de productos y verifica el tar. La verificación de consistencia exige una ventana breve con Ventas/Caja no disponibles; MySQL permanece levantado.

El host no tiene Node. El `Dockerfile.backup-runner` de este paquete prepara un helper que incluye Node y Docker CLI/Compose. Antes de la ventana, descargar e inspeccionar la imagen oficial `docker:cli`, registrar su digest del registro y construir el helper con ese digest fijado; no construir desde la etiqueta flotante sin fijarla:

```bash
docker pull docker:cli
docker image inspect docker:cli --format '{{.Id}}|{{json .RepoDigests}}'
DOCKER_CLI_BASE='docker:cli@sha256:<digest-verificado-en-el-registro>'
docker build --pull --build-arg "DOCKER_CLI_BASE=$DOCKER_CLI_BASE" \
  --file "$RELEASE_DIR/Dockerfile.backup-runner" \
  --tag sv-pos-backup-runner:20261121-c4a98ed1 "$RELEASE_DIR"
docker run --rm --entrypoint node sv-pos-backup-runner:20261121-c4a98ed1 --version
docker run --rm --entrypoint docker sv-pos-backup-runner:20261121-c4a98ed1 compose version
```

Antes de detener los servicios, guardá las referencias e IDs reales de imágenes que están ejecutándose. No uses los Image IDs QA como rollback de producción:

```bash
FRONT_CID="$(dc_base ps -q frontend)"
BACK_CID="$(dc_base ps -q backend)"
OLD_FRONTEND_REF="$(docker inspect --format '{{.Config.Image}}' "$FRONT_CID")"
OLD_FRONTEND_ID="$(docker inspect --format '{{.Image}}' "$FRONT_CID")"
OLD_BACKEND_REF="$(docker inspect --format '{{.Config.Image}}' "$BACK_CID")"
OLD_BACKEND_ID="$(docker inspect --format '{{.Image}}' "$BACK_CID")"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ROOT="/var/backups/pos/pre-permissions-reservations-$STAMP"
umask 077
install -d -m 700 "$BACKUP_ROOT" "$BACKUP_ROOT/config"
cp "$APP_DIR/compose.yaml" "$APP_DIR/compose.production.yaml" "$BACKUP_ROOT/config/"
printf 'frontend_ref=%s\nfrontend_id=%s\nbackend_ref=%s\nbackend_id=%s\n' \
  "$OLD_FRONTEND_REF" "$OLD_FRONTEND_ID" "$OLD_BACKEND_REF" "$OLD_BACKEND_ID" \
  > "$BACKUP_ROOT/config/previous-images.txt"
```

La copia de Compose no incluye secretos. Mantené `/etc/pos/production.env` intacto y respáldalo solo en el almacén privado cifrado ya autorizado; nunca lo agregues a este paquete ni lo muestres en logs.

Abrí la ventana de mantenimiento y detené **solo** frontend y backend. No detengas MySQL:

```bash
dc_base stop frontend
dc_base stop backend
```

Retaggea las dos imágenes anteriores con nombres únicos y conserva una copia comprimida para rollback condicionado:

```bash
ROLLBACK_FRONTEND_TAG="pos-rollback:pre-permissions-reservations-$STAMP-frontend"
ROLLBACK_BACKEND_TAG="pos-rollback:pre-permissions-reservations-$STAMP-backend"
docker image tag "$OLD_FRONTEND_ID" "$ROLLBACK_FRONTEND_TAG"
docker image tag "$OLD_BACKEND_ID" "$ROLLBACK_BACKEND_TAG"
ROLLBACK_ENV="$BACKUP_ROOT/config/rollback-images.env"
printf 'POS_ROLLBACK_FRONTEND_IMAGE=%s\nPOS_ROLLBACK_BACKEND_IMAGE=%s\n' "$ROLLBACK_FRONTEND_TAG" "$ROLLBACK_BACKEND_TAG" > "$ROLLBACK_ENV"
chmod 600 "$ROLLBACK_ENV"
docker image save "$ROLLBACK_FRONTEND_TAG" "$ROLLBACK_BACKEND_TAG" | gzip -1 > "$BACKUP_ROOT/previous-app-images.tar.gz"
sha256sum "$BACKUP_ROOT/previous-app-images.tar.gz" "$BACKUP_ROOT/config/previous-images.txt" "$ROLLBACK_ENV" > "$BACKUP_ROOT/SHA256SUMS.txt"
```

Ejecutá el script oficial remoto mediante el helper. El `--backend-image` debe ser el tag de backend que el Compose productivo resuelve; si no coincide con `$OLD_BACKEND_REF` o Compose rechaza la verificación, detenete y revisá el override/env privado antes de continuar.

```bash
docker run --rm --network none \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume "$APP_DIR:$APP_DIR:ro" \
  --volume "$ENV_FILE:$ENV_FILE:ro" \
  --volume "$BACKUP_ROOT:$BACKUP_ROOT" \
  --workdir "$APP_DIR" \
  sv-pos-backup-runner:20261121-c4a98ed1 \
  "$APP_DIR/scripts/docker-backup.cjs" \
  --out "$BACKUP_ROOT" --project pos-production \
  --env-file "$ENV_FILE" --file compose.yaml --file compose.production.yaml \
  --database "$DB_EXPECTED" --backend-image "$OLD_BACKEND_REF"
```

El script genera una subcarpeta `pos-backup-*` con `database.sql.gz`, `product-images.tar.gz` y `manifest.json`. Verificá SHA-256 y `gzip -t` de ambos archivos contra el manifiesto. La base real contiene datos de clientes: mantené esta copia privada, cifrala antes de cualquier transferencia fuera del servidor y no la uses en pruebas. La restauración de prueba previa verificada en QA fue de otro respaldo; este nuevo respaldo no debe considerarse restaurado/verificado operacionalmente hasta una prueba privada autorizada.


Para conservar una copia externa privada y cifrada, archivá la carpeta de backup con `age` usando la clave pública de recuperación guardada en el gestor privado. No transfieras el dump sin cifrar:

```bash
BACKUP_AGE_RECIPIENT='<clave-pública-age-del-almacén-privado>'
ENCRYPTED_BACKUP="${BACKUP_ROOT}.tar.gz.age"
tar -C "$(dirname "$BACKUP_ROOT")" -czf - "$(basename "$BACKUP_ROOT")" \
  | age --recipient "$BACKUP_AGE_RECIPIENT" --output "$ENCRYPTED_BACKUP"
age --decrypt "$ENCRYPTED_BACKUP" | tar -tzf - >/dev/null
sha256sum "$ENCRYPTED_BACKUP" > "${ENCRYPTED_BACKUP}.sha256"
```

Verificá el descifrado y el listado antes de copiar el `.age` y su checksum al almacenamiento externo privado. Protegé el archivo de backup sin cifrar en el servidor con permisos `0700` y borrado según la política de retención autorizada; no se elimina automáticamente.
Si el backup falla, no migrés. Como el esquema aún no cambió, restablecé solo los servicios anteriores con `dc_base up -d backend frontend` y revisá la causa en privado.

## Paso 5 — Plan y aplicación de 024/025

Con las aplicaciones aún detenidas y el respaldo completo verificado, revisá el plan con la nueva imagen. Debe listar 024 y 025 como pendientes y el resto de 001–022 aplicado, sin mencionar 023:

```bash
dc_release run --rm --no-deps migrate \
  --plan --target "$DB_EXPECTED" --confirm-target "$DB_EXPECTED"
```

Si el plan es exactamente ese, aplica ambas migraciones en orden, con el mismo runner validado y el identificador principal explícito:

```bash
dc_release run --rm --no-deps migrate \
  --apply --target "$DB_EXPECTED" --confirm-target "$DB_EXPECTED" --allow-principal
```

No ejecutes otra vez si aparece estado `RUNNING`, `partial`, checksum distinto o se corta la conexión durante DDL. Dejá frontend/backend detenidos, conserva el backup y diagnostica el estado con el postflight antes de cualquier recuperación. No intentes borrar tablas a mano ni ejecutar una migración de reversa.

Ejecutá el postflight de solo lectura y revisá: 024/025 `APPLIED` con los checksums esperados; 023 ausente; tablas e índices íntegros; cero órdenes explícitas inconsistentes; cero reservas `RESERVED` sin orden pendiente; y sin incremento de productos sobrecomprometidos. Las órdenes antiguas sin fila de reserva deben aparecer como `pending_legacy_virtual_orders` y siguen reteniendo stock.

```bash
dc_base exec -T mysql sh -ec \
  'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql --user=root --database="$MYSQL_DATABASE" --batch --raw' \
  < "$RELEASE_DIR/SQL/postflight-after-migration.read-only.sql"
```

## Paso 6 — Activar en orden y comprobar

Arrancá primero el backend con la nueva imagen, esperá su healthcheck y revisá salud. Frontend permanece detenido durante esta comprobación:

```bash
dc_release up -d --no-deps backend
dc_release ps backend
BACK_CID="$(dc_release ps -q backend)"
docker inspect --format '{{.State.Status}}|{{.State.Health.Status}}|{{.Image}}' "$BACK_CID"
```

Solo con `running|healthy` y postflight limpio, arrancá el frontend:

```bash
dc_release up -d --no-deps frontend
dc_release ps
curl --fail --silent --show-error "http://127.0.0.1:${POS_HTTP_PORT:-8080}/api/health"
curl --fail --silent --show-error "http://127.0.0.1:${POS_HTTP_PORT:-8080}/"
```

Verificá en Chrome el Service Worker nuevo y que una actualización no borre IndexedDB. El paquete cambia el identificador de caché; no contiene una operación `indexedDB.deleteDatabase`. La prueba de Edge local confirmó autenticación, módulo de permisos y actualización del Service Worker.

Antes de dar por terminado el cambio, la supervisión debe revisar: login con una cuenta existente (sin cambiar contraseña), apartados personalizados, órdenes previas, disponibilidad en Productos/Venta, Caja/cobro/cancelación, y Excel. No crees ventas de prueba con datos reales. Si se quiere una venta sintética post-deploy, acordá primero un producto/negocio de prueba controlado y su limpieza contable.

## Recuperación / rollback

**No reviertas simplemente ambas imágenes si hay órdenes pendientes o perfiles de permisos personalizados.** El backend anterior no conoce las reservas de 025 ni aplica los perfiles de 024. Ignorarlos podría permitir sobreventa o ampliar acceso de empleados.

- Si algo falla antes de aplicar 024, 025: con DB sin cambios, vuelve a la configuración/imagenes anteriores guardadas y arranca solo backend/frontend anteriores.
- Si 024/025 fueron aplicadas pero el backend nuevo aún no recibió tráfico: no hagas `DROP` ni downgrade. El cambio de esquema es aditivo; preferí corregir hacia adelante. No inicies el backend viejo automáticamente mientras existan órdenes pendientes.
- Si hubo tráfico nuevo: deja Caja/Venta en mantenimiento. Si el backend nuevo aún funciona, cobra o cancela todas las órdenes pendientes con él; verifica cero órdenes pendientes y cero filas `RESERVED`. Además, evalúa si hay perfiles de permisos explícitos; el backend viejo los ignoraría. Solo con ambas condiciones y una decisión aprobada se puede considerar el override `compose.rollback-template.yaml`.
- Si el backend nuevo no puede arrancar, conserva los servicios fuera de línea y no abras tráfico al backend viejo mientras haya órdenes pendientes, filas `RESERVED` o perfiles personalizados que requieran enforcement. Prioriza reparación hacia adelante. Restaurar el dump completo solo vuelve al punto del respaldo y descarta todas las operaciones posteriores; requiere una reconciliación aprobada y no es un rollback automático.
- Conserva las tablas 024/025 y sus datos. No hay downgrade SQL para publicación.

Para rollback condicionado, se conserva `$BACKUP_ROOT/config/rollback-images.env` junto con los tags de las imágenes capturadas. No guardar esos valores en el env de producción ni usar el override hasta pasar todas las condiciones anteriores. Solo si no hay órdenes pendientes, reservas `RESERVED` ni perfiles personalizados que necesiten enforcement:

```bash
ROLLBACK_ENV="$BACKUP_ROOT/config/rollback-images.env"
dc_rollback() {
  docker compose --project-name "$PROJECT" \
    --env-file "$ENV_FILE" --env-file "$ROLLBACK_ENV" \
    --file "$APP_DIR/compose.yaml" \
    --file "$APP_DIR/compose.production.yaml" \
    --file "$RELEASE_DIR/compose.rollback-template.yaml" "$@"
}
dc_rollback config --quiet
dc_rollback up -d --no-deps backend
# Confirmá running|healthy del backend anterior antes de continuar.
dc_rollback up -d --no-deps frontend
```

Si cualquiera de las condiciones falla, no ejecutes este bloque: mantené la aplicación fuera de línea y preferí reparación hacia adelante.

## Bloqueantes antes de autorizar la ejecución

1. Ejecutar el preflight de solo lectura y entregar el resultado sin secretos.
2. Resolver cualquier 023 presente, checksum incorrecto, esquema parcial, producto con exceso de órdenes pendientes o referencias a productos faltantes.
3. Completar la ventana de backup (frontend/backend detenidos), comprobar manifiesto/hashes y conservar la copia en destino privado cifrado.
4. Confirmar que el paquete transferido pasa `sha256sum -c` y que los Image IDs cargados son los indicados.
5. Acordar el plan operativo de recuperación, especialmente el tratamiento de perfiles personalizados y órdenes pendientes si falla el backend nuevo.

Hasta completar esos puntos, el veredicto es **NO LISTO PARA DESPLIEGUE**. No se realizó ningún paso productivo.
