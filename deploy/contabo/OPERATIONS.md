# Operación del POS conectado en Contabo

## Estado real verificado

Instantánea operativa del 31 de octubre de 2026; confirmar los valores antes de cada cambio:

- VPS `31.220.84.51`, Ubuntu 24.04.5 LTS; proyecto en `/opt/pos/app`, Compose project `pos-production`.
- POS conectado con frontend RC6, backend RC5 y MySQL. Base configurada: `pos_contabo_prod_20261029`; migraciones 001–020 aplicadas.
- Volúmenes persistentes del proyecto: `pos-production_mysql_data` y `pos-production_product_images`; conservar ambos durante cambios de aplicación.
- El acceso actual es privado por túnel SSH. En Windows, abrir el túnel con `ssh -N -L 18080:127.0.0.1:8080 posadmin@31.220.84.51` y usar `http://127.0.0.1:18080` en el navegador. No sustituir esta vía durante la activación pública.
- Docker Compose enlaza el frontend solo a `127.0.0.1:8080`. MySQL no declara `ports`; el backend solo declara `expose: 3000` dentro de Docker. La red de base de datos es interna.
- La lectura de sockets en el VPS encontró SSH en 22 y el frontend en loopback 8080; no encontró listeners en 80, 443, 3000 ni 3306. Caddy no está instalado ni activo. La consulta directa de `docker ps` requiere sudo y no se ejecutó; la topología de puertos se verificó en Compose.
- La última auditoría informó que UFW permite 22, 80 y 443. No se modificó. Aunque 80/443 no tenían un listener en esta revisión, esos permisos permitirían tráfico al instalar y activar un servicio.
- El dominio aún no está comprado. Caddy, HTTPS público, respaldos automáticos externos y Restic están pendientes por decisión del propietario. Se conservan los respaldos existentes.

No es una instalación futura: no repetir la instalación inicial, la importación del esquema ni el alta del primer negocio. No ejecutar `down -v`, `prune` ni inicializadores contra esta base.

## Topología y límites de exposición

Flujo público previsto: navegador → Caddy en el host (80/443) → Nginx del frontend en `127.0.0.1:8080` → backend Express en la red Docker. MySQL permanece únicamente en la red interna de Compose. Caddy no debe publicar ni redirigir directamente a 3000 o 3306.

El acceso de recuperación seguirá siendo el túnel SSH hacia `127.0.0.1:8080`; no requiere Caddy. Mantener el enlace del frontend enlazado a loopback y no reemplazarlo por `0.0.0.0`. La cuenta SSH usa claves; conservar una sesión de recuperación abierta durante cualquier cambio de SSH o firewall.

La inspección en vivo de puertos Docker requiere privilegios. Antes de publicar el dominio, desde una sesión SSH segura, confirmar también `sudo docker ps --format '{{.Names}}|{{.Ports}}'` y `sudo ss -lntp`; el resultado debe mostrar el puerto 8080 solo en loopback, sin 3000 ni 3306 publicados.

## Orígenes, cookies y proxies

- `CORS_ORIGINS` acepta una lista separada por comas de orígenes exactos, sin rutas ni `/` final. Al habilitar el dominio, incluir tanto `https://<dominio>` como `http://127.0.0.1:18080` para conservar el acceso de recuperación. No usar `*`. Actualmente el acceso privado se configura mediante los archivos privados del stack de prueba; antes del cambio, trasladar los dos orígenes al archivo de entorno de producción y validar Compose sin imprimir la configuración.
- En producción, el backend marca las cookies como `Secure`, `HttpOnly`, `SameSite=Lax` y `Path=/`, y usa el prefijo `__Host-` sin atributo `Domain`. Mantener este comportamiento. La aplicación es del mismo origen detrás de Caddy; no cambiar a `SameSite=None` para hacer funcionar CORS.
- El Compose de producción configura `TRUST_PROXY_HOPS=2`, correcto para la ruta pública exacta Caddy → Nginx → Express. No agregar CDN, proxy adicional ni una ruta pública directa a Nginx sin revisar el conteo y probar encabezados falsificados. Express advierte que un conteo de saltos incorrecto o rutas de distinta longitud puede hacer confiables encabezados enviados por clientes. Caddy sobrescribe/normaliza los encabezados `X-Forwarded-*` por defecto; conservar ese comportamiento.
- El túnel SSH no es un proxy HTTP adicional y no se cuenta como salto en Express.

## Activación futura del dominio y HTTPS

No ejecutar esta sección hasta comprar el dominio, elegir el nombre final y autorizar la publicación. No hay que reinstalar el POS ni migrar la base para conectar el dominio.

1. Crear un registro DNS `A` para el hostname elegido hacia `31.220.84.51`. Crear `AAAA` únicamente si el VPS tiene IPv6 funcional y reglas IPv6 verificadas; de lo contrario, no publicar un `AAAA` incorrecto. Desde Windows verificar con `Resolve-DnsName <dominio> -Type A` y, si corresponde, `Resolve-DnsName <dominio> -Type AAAA`.
2. Confirmar desde el VPS que 80/443 están libres y revisar el estado efectivo de UFW/IPv6. La última auditoría ya reportó reglas UFW para 80/443; no agregar reglas duplicadas. Si cambiaron, detenerse y aprobar el cambio de firewall por separado. Docker puede gestionar reglas de publicación fuera del recorrido simple de UFW; mantener el binding de loopback y revisar `DOCKER-USER`.
3. Actualizar `CORS_ORIGINS` en la configuración privada efectiva a `https://<dominio>,http://127.0.0.1:18080`. No poner el dominio en producción hasta que exista y resuelva al VPS. Validar el stack con `docker compose ... config --quiet`; nunca mostrar la salida resuelta.
4. Confirmar que el backend conserva `TRUST_PROXY_HOPS=2`. La cadena pública debe tener exactamente los dos proxies documentados y el backend/MySQL no deben aceptar conexiones desde Internet.
5. Instalar Caddy desde el repositorio oficial estable de Ubuntu, no desde un binario de origen desconocido. La instalación oficial crea un servicio systemd y puede iniciarlo; por eso preparar primero `/etc/caddy/Caddyfile` con el dominio real y el upstream loopback, y ejecutar este paso solo durante la activación autorizada:

```caddyfile
<dominio-real> {
    encode zstd gzip
    tls {
        issuer acme https://acme-v02.api.letsencrypt.org/directory
    }
    reverse_proxy 127.0.0.1:8080
}
```

Caddy obtiene y renueva certificados ACME de Let's Encrypt automáticamente y sirve el redirect HTTP→HTTPS cuando DNS apunta al VPS y los puertos requeridos son alcanzables. La configuración anterior fija el issuer de Let's Encrypt; no se necesitan certificados ni claves TLS manuales. Mantener persistente y sin borrar el directorio de datos de Caddy (`/var/lib/caddy` en el paquete systemd oficial). Para probar antes de producción, usar el endpoint de staging de Let's Encrypt en una configuración de prueba separada; no solicitar certificados repetidamente al endpoint productivo.

Primero, una vez elegido el hostname, crear el archivo de Caddy con el valor real antes de instalar el paquete. Así el servicio no arranca con una configuración de ejemplo:

```bash
sudo install -d -o root -g root -m 0755 /etc/caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
<dominio-real> {
    encode zstd gzip
    tls {
        issuer acme https://acme-v02.api.letsencrypt.org/directory
    }
    reverse_proxy 127.0.0.1:8080
}
EOF
```

Luego instalar desde el repositorio oficial estable (requiere sudo y acceso a Internet; no ejecutar ahora). El paquete inicia un servicio systemd; por eso solo ejecutar después de confirmar DNS, Caddyfile, entorno backend y firewall:

```bash
sudo apt install --yes debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

Después de instalar Caddy, validar la configuración antes de recargarla:

```bash
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
systemctl is-active caddy
sudo ss -lntp
```

No abrir ni modificar puertos durante la preparación. En el día de activación, confirmar que las reglas UFW existentes son las aprobadas; si hace falta cambiarlas, hacerlo como una intervención separada. No abrir 3000, 3306 ni 8080.

## Cambio de entorno sin reinstalar el POS

La configuración privada actual del stack debe tratarse con cuidado. Antes de retirar el override de prueba, comprobar su contenido sin imprimir secretos y confirmar que su única diferencia funcional es la configuración temporal de CORS. Poner ambos orígenes en `/etc/pos/production.env` con `sudoedit` (no copiar el archivo al repositorio), dejar intactas las claves y demás secretos, y validar con la misma combinación de archivos Compose que usa el servicio.

Después de aprobar la configuración, recrear solo el backend para que lea el nuevo origen; no reiniciar MySQL ni cambiar imágenes. Usar el conjunto de archivos de Compose del servicio activo, `config --quiet`, y `up -d --no-deps backend`. Mantener el frontend en `127.0.0.1:8080`; no hay que reconstruirlo para añadir un hostname si sigue sirviendo la misma app y el proxy mantiene el mismo origen `/api`.

## Comprobaciones finales para activar el dominio

Ejecutar antes y después del cambio, sin hacer operaciones comerciales reales:

```bash
docker compose -p pos-production --env-file /etc/pos/production.env -f compose.yaml -f compose.production.yaml config --quiet
docker compose -p pos-production --env-file /etc/pos/production.env -f compose.yaml -f compose.production.yaml ps
curl --fail --silent --show-error --write-out '\nHTTP %{http_code} TTFB %{time_starttransfer}s TLS %{time_appconnect}s\n' https://<dominio-real>/api/health
curl --fail --silent --show-error --head https://<dominio-real>/
```

Si el servicio activo usa además un override, añadir el mismo `--env-file` y `-f` a todos los comandos hasta que el cambio de entorno se haya validado. `config --quiet` debe terminar con código 0 y no mostrar valores.

Checklist de navegador:

- Login con una cuenta de prueba autorizada; verificar cookie de sesión `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` y sin `Domain`, sin copiar el valor de la cookie.
- Verificar autorización de módulos con ADMIN y VENDEDOR de prueba; comprobar que una sesión vencida vuelve al login y que el backend deniega rutas no autorizadas.
- Navegar por Ventas, Inventario, Compras, Caja, Reportes y Dashboard; comprobar que no haya llamadas fallidas ni filtración de datos entre negocios.
- Repetir el acceso privado por túnel SSH y confirmar que el dominio público y el túnel funcionan a la vez.
- Probar ventas simultáneas, caja, stock, créditos, compras y abonos solo en un entorno temporal aislado. En producción, limitarse a health, login autorizado y lecturas no destructivas.
- Comprobar respuesta HTTP 200 de `/api/health`, certificado válido y redirect HTTP→HTTPS. Una respuesta 403 de un origen no permitido es esperada; no ampliar CORS para ocultarla.

## Migraciones y datos actuales

La base `pos_contabo_prod_20261029` tiene las migraciones 001–020 aplicadas según las verificaciones anteriores. Conectar un dominio y habilitar HTTPS no requiere migraciones. No ejecutar `--install-base-schema` ni el inicializador de negocio como parte de la activación del dominio.

Las escrituras de prueba deben ir a un stack y una base temporal. No usar los negocios actuales para pruebas de ventas, pagos, inventario o concurrencia.

## Respaldos y restauración

Se conservaron respaldos existentes y se verificó anteriormente una restauración aislada. Por decisión del propietario, todavía no hay Restic, Backblaze, timer diario ni alertas externas; no afirmar que existe un respaldo automático off-site. El respaldo externo automatizado sigue siendo un pendiente importante antes de operar comercialmente. No borrar ni sobrescribir copias anteriores.

El script oficial incluye MySQL e imágenes y requiere detener backend/frontend durante la captura consistente; MySQL permanece arriba. Acordar una ventana de mantenimiento antes de usarlo. Tras generar una copia, verificar manifiesto y hashes, ejecutar `docker-restore-check.cjs` en un entorno aislado y guardar una copia cifrada fuera del VPS. Nunca restaurar sobre la base de producción como prueba.

## Actualizaciones y rollback

1. Descargar una etiqueta publicada y verificar el commit exacto y árbol limpio.
2. Capturar un respaldo nuevo y restaurarlo en aislamiento; conservar las imágenes activas para rollback.
3. Validar Compose con `config --quiet`; ejecutar el plan oficial de migraciones en solo lectura.
4. Aplicar migraciones únicamente con autorización explícita y después de revisar el destino. No se ejecuta DDL al reiniciar el backend.
5. Actualizar en el orden requerido por el contrato frontend/backend; comprobar health, login, permisos y modo privado.
6. Si el código falla sin cambios de esquema, volver a las imágenes previas. No revertir DDL manualmente ni restaurar sobre una base que ya recibió nuevas escrituras; preservar estado, logs y respaldos, y definir recuperación antes de actuar.

No usar `docker compose down -v`, `docker volume prune` ni comandos de limpieza en el proyecto existente.

## Pendientes antes de publicación comercial

- Comprar y elegir el hostname, publicar DNS y decidir si el acceso público está autorizado.
- Activar Caddy/ACME, validar TLS y confirmar el acceso privado de recuperación.
- Completar respaldo externo cifrado, verificación periódica de restauración y alertas; pospuesto por decisión del propietario.
- Ejecutar la checklist manual de roles y navegación, más pruebas concurrentes en aislamiento.
- Acordar proceso operativo de mensualidades y atención a incidentes.

La medición local previa de carga no garantiza la capacidad del VPS. No anunciar capacidad concurrente hasta medir el servidor Contabo con datos ficticios y un perfil de carga acordado.
