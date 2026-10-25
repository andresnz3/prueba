# POS multiempresa en Docker

Esta guía prepara y ejecuta el POS localmente. No despliega en Contabo ni conecta con `pos_multitenant` de Windows. Compose crea una base nueva llamada `pos_docker_local` en el volumen `mysql_data`; el servicio MySQL no publica el puerto 3306. Las migraciones no se ejecutan al iniciar el backend.

## Arquitectura auditada

- El backend inicia desde `backend/server.js`, requiere Node.js 22 o superior y usa las dependencias de producción de `backend/package-lock.json`.
- El frontend se construye con la lista pública de `scripts/build-static.cjs`, se sirve con Nginx y usa `/api` en el mismo origen. Nginx reenvía `/api/` al backend.
- Las fotografías usan `IMAGE_STORAGE_DIR`; Compose las persiste en el volumen `product_images`.
- Compose usa Node `22.23.4-bookworm-slim`, MySQL `8.4.13` y Nginx `1.30.6-alpine`. La aplicación requiere MySQL 8.0.16 o posterior para aplicar restricciones `CHECK`; MySQL 8.4 satisface esa condición. Consulte las etiquetas oficiales de [Node](https://hub.docker.com/layers/library/node/22.23.4-bookworm-slim/images/sha256-75c58d07c05cc37d937ca3f0038deb3caf3bbfaf423ac8818637ed5b9642d667), [MySQL](https://hub.docker.com/_/mysql/tags) y [Nginx](https://hub.docker.com/layers/library/nginx/1.30.6-alpine/images/sha256-959ae6b898852db82e5b29b929388e59914f42be0a8f4d44c89a4c1f53b49208).
- El backend es no-root, tiene filesystem de solo lectura salvo volúmenes y `/tmp`, y ofrece healthcheck. `TRUST_PROXY_HOPS` se limita a 0–2. En el entorno local hay un salto Nginx; detrás del proxy TLS adicional de Contabo serían dos.
- Se mantienen las sesiones HttpOnly y Secure de producción, validación CSRF y CORS de orígenes exactos; Docker no introduce permisos multiempresa alternos ni deriva el `business_id` del navegador.
- `.dockerignore` específicos mantienen fuera de cada imagen los archivos privados, pruebas, respaldos y el resto del repositorio. La imagen pública solo contiene el build estático.

## Requisitos locales

Instale y arranque Docker Desktop para Windows con el motor Linux/WSL2. Compruebe en PowerShell:

```powershell
docker version
docker compose version
```

No ejecute comandos de inicio si alguno falla. Para que `docker compose config` no imprima contraseñas, use `docker compose config --quiet` después de preparar `.env`.

## Configuración privada en Windows

Desde la raíz del repositorio, copie `.env.example` a `.env`. Genere contraseñas aleatorias independientes y un secreto CSRF hexadecimal de 32 bytes; mantenga `.env` fuera de Git y no pegue sus valores en tickets o logs. El ejemplo no contiene credenciales utilizables. Complete también `CORS_ORIGINS` con los orígenes exactos que abrirá en el navegador.

```powershell
Copy-Item .env.example .env
function New-HexSecret {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes); [BitConverter]::ToString($bytes).Replace('-', '') }
  finally { $rng.Dispose() }
}
$mysqlRoot = New-HexSecret
$mysqlApp = New-HexSecret
$csrf = New-HexSecret
$privateEnv = @"
MYSQL_ROOT_PASSWORD=$mysqlRoot
MYSQL_APP_PASSWORD=$mysqlApp
CSRF_SECRET=$csrf
CORS_ORIGINS=http://localhost:8080,http://127.0.0.1:8080
POS_HTTP_PORT=8080
TRUST_PROXY_HOPS=1
"@
[IO.File]::WriteAllText((Join-Path (Get-Location) '.env'), $privateEnv, [Text.UTF8Encoding]::new($false))
Remove-Variable mysqlRoot,mysqlApp,csrf,privateEnv
```

Proteja el archivo `.env` con los permisos de su cuenta de Windows y no reutilice estos secretos en producción. Si el puerto 8080 está ocupado, ajuste `POS_HTTP_PORT` y los dos orígenes CORS a ese puerto.

## Primer arranque local

```powershell
docker compose config --quiet
docker compose build
# En la primera ejecución, deténgase si existe alguno de estos volúmenes.
$existingDockerVolumes = docker volume ls --quiet
if ($existingDockerVolumes -contains 'pos-docker-local_mysql_data' -or $existingDockerVolumes -contains 'pos-docker-local_product_images') { throw 'Ya existe un volumen con ese nombre; inspecciónelo sin borrarlo.' }
docker compose up -d mysql
docker compose ps
```

Espere hasta que MySQL indique `healthy`. Primero ejecute el plan de instalación, que verifica que el destino está vacío y lista 001–017 sin cambiar el esquema:

```powershell
docker compose --profile tools run --rm migrate --plan --target pos_docker_local --confirm-target pos_docker_local --install-base-schema
```

Revise que la salida diga base planificada y que todas las migraciones aparezcan pendientes. Aplique solo en esta base Docker nueva:

```powershell
docker compose --profile tools run --rm migrate --apply --target pos_docker_local --confirm-target pos_docker_local --install-base-schema
```

El backend no aplica SQL en cada reinicio. Para un despliegue posterior, respalde la base, ejecute primero `--plan` sin `--install-base-schema`, revise las pendientes y aplique mediante el mismo servicio `migrate` con `--apply`. Nunca agregue `pos_multitenant` como destino.

### Primer administrador

El procedimiento existente `init-business.cjs` crea el primer negocio y un administrador dentro de una transacción, solicita una contraseña oculta de al menos 12 caracteres y exige confirmación. El sistema actual reconoce al administrador general por la identidad reservada `andres`, rol `ADMIN`, negocio ID 1. En una instalación nueva, el primer negocio creado queda como ID 1; use `andres` como usuario de ese administrador y asigne una contraseña nueva, aleatoria y única. No cambie ni reutilice una contraseña de otra instalación.

```powershell
docker compose run --rm --no-deps -it --entrypoint node backend backend/scripts/init-business.cjs
```

Después de crear la cuenta:

```powershell
docker compose up -d backend frontend
docker compose ps
```

Abra `http://localhost:8080` o `http://127.0.0.1:8080` y compruebe `/api/health`, inicio/cierre de sesión y los permisos. El negocio ID 1 y la identidad de administración general permanecen protegidos por el backend. No cree registros de demostración en una base que después vaya a tratar como producción.

## Verificaciones locales realizadas con Docker (24 de octubre de 2026)

Se construyeron desde cero las imágenes temporales de backend y frontend, se aplicaron 001–017 únicamente a una base nueva de auditoría y el plan posterior las reportó aplicadas. En un proyecto temporal, MySQL 8.4.13, backend y frontend quedaron saludables; Nginx sirvió la aplicación y el healthcheck de API respondió 200 con servidor y base de datos disponibles. Tras reiniciar MySQL y la aplicación, los servicios volvieron a quedar saludables, las migraciones siguieron aplicadas y una marca de prueba persistió en el volumen de imágenes. El marcador se retiró después.

La suite MySQL completa se ejecutó dentro de la red privada temporal: no tuvo fallos; tres pruebas opcionales se omitieron porque requieren archivos JSON de cliente no disponibles en este checkout. Playwright conectado aprobó 128 pruebas y omitió dos casos opcionales; Playwright local había aprobado 195/195 y la comprobación específica de mensajes locales aprobó 1/1. Las pruebas de navegador conectado usaron una base aleatoria pos_auth_test_*, eliminada al finalizar; la inspección confirmó cero bases de pruebas restantes.

El respaldo anterior descrito durante la primera prueba correspondía a una instalación vacía: aunque su restauración pasó las verificaciones, no servía para recuperar el POS con el administrador creado. El 24 de octubre de 2026, el administrador confirmó la generación y restauración satisfactoria de un respaldo completo actualizado de `pos_docker_local`, guardado fuera del repositorio. Para una recuperación, usa esa copia reciente y verifica su manifiesto y SHA-256 antes de restaurar.

El proyecto principal `pos_docker_local` permaneció intacto; al cierre MySQL, backend y frontend siguen saludables, la página y `/api/health` responden 200, MySQL no está publicado al host y el único puerto publicado es el frontend en `127.0.0.1:8080`. La base principal `pos_multitenant` no fue utilizada. El administrador confirmó el respaldo actualizado y su restauración temporal satisfactoria. `npm audit` encontró cero vulnerabilidades en ambos lockfiles; Docker Scout no pudo escanear las imágenes porque requiere iniciar sesión, así que el estado de CVE del sistema operativo de las imágenes sigue pendiente. Contabo, dominio, TLS, firewall y monitoreo externo no se han configurado. Los pagos de suscripción se registran manualmente desde administración; no existe cobro recurrente integrado. La edición de compras conectadas quedó aceptada manualmente en estos escenarios: corrección de una compra a crédito sin abonos previos y actualización de inventario/CxP; bloqueo de edición después de abonos; aumento de compra al contado con el ajuste adicional correspondiente a la caja abierta; y rechazo de reducciones que requieren una devolución conciliada. Siguen pendientes un artefacto de lanzamiento revisado, la revisión de vulnerabilidades de imágenes y una prueba de carga.

## Iniciar, detener y actualizar sin borrar datos

```powershell
# Iniciar/parar procesos conservando los volúmenes
docker compose up -d
docker compose stop
docker compose start

# Reconstruir y volver a crear contenedores, conservando volúmenes con nombre
docker compose build
docker compose up -d

# Retirar contenedores/redes, conservando volúmenes con nombre
docker compose down
```

No use `docker compose down -v`, `docker volume rm`, `docker system prune --volumes` ni elimine los volúmenes `mysql_data` o `product_images`. Antes de actualizar código: genere y restaure/verifique un respaldo, detenga el servicio, obtenga el cambio aprobado, construya las imágenes, revise el plan oficial, aplique manualmente cualquier migración pendiente y vuelva a iniciar.

## Respaldos y recuperación

El respaldo requiere que el backend esté detenido para evitar cambios mientras se compara el inventario; MySQL permanece arriba. Use una carpeta externa al repositorio y conserve cada carpeta generada: el script crea un nombre único y nunca sobrescribe.

```powershell
$backupRoot = Join-Path $env:USERPROFILE 'Documents\POS-Docker-Backups'
docker compose stop backend frontend
node scripts/docker-backup.cjs --out $backupRoot
```

El resultado contiene un dump comprimido con estructura, datos, rutinas, triggers y eventos; un archivo de imágenes; hashes SHA-256; tamaños; conteos por tabla e inventario de objetos SQL. Para verificar una copia, el comprobador crea una red interna, volúmenes y un contenedor MySQL temporal con nombre `pos_auth_test_*`, restaura el dump, compara inventarios, ejecuta `CHECK TABLE` sobre cada tabla restaurada, comprueba el ledger 001–017 y restaura/compara imágenes. Luego elimina solo esos recursos temporales generados:

Los dos scripts requieren Node.js 22 y Docker CLI en el equipo de operaciones; el backend comercial sigue ejecutándose únicamente dentro de Docker. No requieren instalar MySQL en el host.

```powershell
$backupPath = Read-Host 'Ruta completa de la carpeta del respaldo'
node scripts/docker-restore-check.cjs --backup $backupPath
docker compose start backend frontend
```

La verificación no restaura sobre la base Docker de trabajo. Para recuperación real, detenga la aplicación y siga un procedimiento de incidente revisado; no improvise importando sobre una base con datos. Mantenga copias cifradas fuera del VPS, controle acceso y pruebe la restauración. No se automatiza la eliminación por antigüedad; acuerde una política antes.

## Preparación futura de Contabo (no ejecutada)

### VPS, red y sistema

Use Ubuntu 24.04 LTS actualizado. Como capacidad inicial de planificación (inferencia que debe validarse con carga real, no un plan de Contabo elegido), reserve 4 vCPU, 8 GB RAM y SSD/NVMe; ajuste con métricas de concurrencia, imágenes, datos y respaldos. La [documentación de Docker lista Ubuntu 24.04 LTS como compatible](https://docs.docker.com/engine/install/ubuntu/).

Instale Docker Engine y Compose desde el repositorio apt oficial:

```bash
sudo apt update
sudo apt install ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
```

Use SSH con claves. Pruebe una segunda sesión con la clave antes de desactivar login por contraseña o root. Limite SSH a IPs autorizadas y permita TCP 80/443:

```bash
sudo ufw default deny incoming
sudo ufw allow from <IP_ADMINISTRADOR>/32 to any port 22 proto tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw status verbose
sudo ufw enable
```

Añada reglas equivalentes para IPv6 si está habilitado. Docker advierte que puertos publicados pueden eludir reglas UFW; Compose limita este servicio a `127.0.0.1:8080` y no publica 3306. No añada un mapeo público de MySQL y revise las reglas de `DOCKER-USER`.

### Código y entorno

Obtenga un tag revisado desde GitHub; sustituya `vX.Y.Z` por el tag aprobado y no despliegue `main` sin revisión:

```bash
sudo install -d -o "$USER" -g "$(id -gn)" /opt/pos/releases
cd /opt/pos/releases
git clone --branch vX.Y.Z --depth 1 https://github.com/andresnz3/prueba.git vX.Y.Z
cd /opt/pos/releases/vX.Y.Z
sudo apt install --yes openssl
umask 077
cat > .env <<EOF
MYSQL_ROOT_PASSWORD=$(openssl rand -hex 32)
MYSQL_APP_PASSWORD=$(openssl rand -hex 32)
CSRF_SECRET=$(openssl rand -hex 32)
CORS_ORIGINS=https://pos.ejemplo.com
POS_HTTP_PORT=8080
TRUST_PROXY_HOPS=2
EOF
chmod 600 .env
node --version
```

Los comandos generan secretos nuevos directamente en `.env` sin imprimirlos; la herramienta de mantenimiento requiere Node.js 22 en el host, mientras que el servicio de aplicación sigue dentro de su contenedor. No copie el `.env` de desarrollo. Los datos MySQL e imágenes quedan en los volúmenes persistentes del Compose.

Configure A/AAAA del dominio al VPS. Instale Caddy mediante su [paquete oficial Debian/Ubuntu](https://caddyserver.com/docs/install):

```bash
sudo apt install --yes debian-keyring debian-archive-keyring apt-transport-https curl gnupg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

Use un sitio como:

```caddyfile
pos.ejemplo.com {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy puede obtener y renovar HTTPS automáticamente cuando DNS apunta al VPS y los puertos 80/443 están disponibles; consulte [HTTPS automático](https://caddyserver.com/docs/automatic-https) y [reverse proxy](https://caddyserver.com/docs/quick-starts/reverse-proxy). Escriba el archivo, valídelo y recargue:

```bash
sudo tee /etc/caddy/Caddyfile <<'EOF'
pos.ejemplo.com {
    reverse_proxy 127.0.0.1:8080
}
EOF
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Mantenga el puerto Compose enlazado a `127.0.0.1`, no a `0.0.0.0`. Revise cookies seguras, CORS, `TRUST_PROXY_HOPS=2`, DNS, firewall y renovación TLS antes de habilitar usuarios.

### Actualizaciones y operación

1. Detenga backend/frontend y cree/verifique un respaldo fuera del checkout.
2. En una ventana de mantenimiento, descargue un tag nuevo aprobado con `git fetch --tags origin` y `git checkout --detach vX.Y.Z` en el checkout de release.
3. Construya la versión nueva con `docker compose build backend frontend migrate`.
4. Ejecute el plan `docker compose --profile tools run --rm migrate --plan --target pos_docker_local --confirm-target pos_docker_local` y revise pendientes o estados parciales.
5. Aplique solo el plan aprobado con `--apply`; el ejecutor oficial detecta checksums, dependencias y migraciones parciales.
6. Inicie backend/frontend y revise healthcheck, logs, login, datos de dos empresas y operaciones controladas.
7. Ante fallo, conserve logs y respaldo, detenga tráfico y ejecute un procedimiento de restauración verificado.

Use `docker compose logs --since 15m backend frontend mysql` para diagnóstico; no publique logs que contengan datos personales. Añada monitoreo externo de HTTPS y espacio de disco, alertas de volumen/backup y revisión periódica de accesos. Un VPS real, dominio y certificados no se han contratado ni configurado aquí.

## Estado de esta entrega

El 24 de octubre de 2026 se verificó Docker Desktop 29.9.2 y MySQL 8.4.13. El respaldo aportado se restauró en recursos Docker temporales: las 34 tablas pasaron `CHECK TABLE`, coincidieron las 17 filas (solo historial de migraciones), la huella de rutinas/disparadores/eventos y el inventario de imágenes; el plan de lectura confirmó 001–017 aplicadas. Los recursos temporales se eliminaron y el respaldo original conservó sus checksums.
