# Operación del POS conectado en Contabo

Este procedimiento está preparado para una instalación futura. No implica que exista un VPS, dominio o despliegue activo. Sustituya `vX.Y.Z` por una etiqueta revisada y aprobada; no despliegue una rama de trabajo sin publicar y revisar.

## Topología prevista

- DNS del dominio hacia el VPS; Caddy en el host termina HTTPS y reenvía a Nginx en `127.0.0.1:8080`.
- Compose publica solo ese puerto de loopback. MySQL permanece en la red interna de Compose, sin `ports`; el backend solo expone `3000` dentro de Docker.
- Use siempre el proyecto `pos-production`. Sus volúmenes quedan separados de `pos-docker-local` como `pos-production_mysql_data` y `pos-production_product_images`.
- Configure `CORS_ORIGINS=https://<dominio-real>` y `TRUST_PROXY_HOPS=2` solo cuando el flujo real sea Caddy → Nginx → backend.

## Requisitos y secretos

Use Ubuntu Server 24.04 LTS, Docker Engine y el complemento oficial Docker Compose. Cree `/etc/pos/production.env` fuera del checkout, propietario `root`, modo `600`; nunca copie el `.env` de Windows ni imprima `docker compose config` sin `--quiet`. El archivo de ejemplo del repositorio no contiene credenciales utilizables.

Configure contraseñas distintas para MySQL root y la cuenta de aplicación, un `CSRF_SECRET` aleatorio y las variables de licencias solo con el material de producción protegido. No guarde claves privadas en Git ni en el frontend. Antes de configurar el dominio, defina DNS A/AAAA, nombre canónico y el acceso administrativo SSH.

## Primera instalación

Desde el checkout de una etiqueta aprobada:

```bash
docker compose -p pos-production --env-file /etc/pos/production.env -f compose.yaml -f compose.production.yaml config --quiet
docker compose -p pos-production --env-file /etc/pos/production.env -f compose.yaml -f compose.production.yaml build backend frontend migrate
docker compose -p pos-production --env-file /etc/pos/production.env -f compose.yaml -f compose.production.yaml up -d --wait mysql
docker compose -p pos-production --env-file /etc/pos/production.env -f compose.yaml -f compose.production.yaml --profile tools run --rm migrate --plan --target pos_production --confirm-target pos_production --install-base-schema
```

Revise que el plan sea una instalación vacía y liste las migraciones 001–020 como pendientes. Solo con aprobación operativa aplique el mismo comando cambiando `--plan` por `--apply`. No use `--install-base-schema` al actualizar una base existente. Después, inicialice el negocio y administrador de esa instalación con el inicializador oficial; introduzca la contraseña directamente en su prompt interactivo.

## Dominio, TLS y firewall

Configure DNS al VPS y Caddy en el host con una regla equivalente a:

```caddyfile
pos.<dominio-real> {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8080
}
```

Valide y recargue Caddy mediante su servicio. Exponga públicamente solo TCP 80/443 y SSH restringido a direcciones administrativas; habilite las reglas IPv6 correspondientes. Mantenga `POS_HTTP_PORT` ligado a `127.0.0.1`. No publique 3000 ni 3306. Revise también la cadena `DOCKER-USER`: publicar puertos Docker puede saltarse reglas simples de UFW, según la [documentación oficial de Docker](https://docs.docker.com/engine/install/ubuntu/).

## Verificación después de instalar o actualizar

```bash
docker compose -p pos-production --env-file /etc/pos/production.env -f compose.yaml -f compose.production.yaml ps
curl --fail --silent --show-error https://pos.<dominio-real>/api/health
```

Compruebe que MySQL, backend y frontend estén sanos, que solo Nginx tenga puerto de host y que `/api/health` responda 200. Después revise desde el navegador el acceso administrativo, el aislamiento entre dos negocios de prueba y las pantallas comerciales con datos ficticios antes de permitir operaciones reales. Las comprobaciones que escriban datos deben hacerse en un entorno temporal.

## Respaldo y restauración

Los scripts oficiales respaldan dump, estructura, datos, rutinas, disparadores, eventos e imágenes, y comparan inventarios. El respaldo actual requiere detener backend y frontend mientras MySQL continúa arriba; esto produce una ventana de mantenimiento. No automatice una tarea diaria sin acordar primero la hora y la interrupción tolerable.

Ejemplo, ejecutado desde el checkout que creó las imágenes:

```bash
docker compose -p pos-production --env-file /etc/pos/production.env -f compose.yaml -f compose.production.yaml stop backend frontend
node scripts/docker-backup.cjs --out /var/backups/pos --project pos-production --env-file /etc/pos/production.env --file compose.yaml --file compose.production.yaml --database pos_production --backend-image pos-backend:production
node scripts/docker-restore-check.cjs --backup /var/backups/pos/<carpeta-generada> --backend-image pos-backend:production
docker compose -p pos-production --env-file /etc/pos/production.env -f compose.yaml -f compose.production.yaml start backend frontend
```

El verificador restaura solo en una red y volúmenes aleatorios temporales, comprueba `CHECK TABLE`, objetos SQL, conteos, hashes de imágenes y el estado de todas las migraciones disponibles en la imagen.

### Política propuesta (no instalada)

- Frecuencia: respaldo completo diario, en una ventana nocturna acordada. El script detiene backend y frontend; medir primero cuánto dura esa interrupción. Objetivo inicial a aprobar: RPO de hasta 24 horas y RTO de hasta 4 horas, sujeto a un simulacro cronometrado.
- Copia externa: repositorio Restic cifrado del lado del cliente en almacenamiento de objetos compatible con S3, en una cuenta separada del VPS. No se eligió ni contrató proveedor. Proteger las credenciales del repositorio y limitar su acceso a la tarea de respaldo.
- Retención inicial: 7 copias diarias, 4 semanales y 12 mensuales. Conservar como máximo 2 copias locales recientes; retirar una copia local solo después de verificar que la instantánea externa terminó y es legible. No aplicar `forget`/`prune` automáticamente hasta probar la política con una réplica.
- Cifrado del staging: el respaldo que genera el script contiene datos legibles. Antes de automatizarlo en un VPS, usar un volumen temporal cifrado y de acceso `root` solamente, o modificar y verificar el flujo para cifrar el paquete antes de persistirlo. Restic cifra el repositorio externo, pero no cifra retroactivamente el staging local.
- Alertas: una tarea `systemd` debe fallar si el dump, la copia externa, la verificación de integridad o la limpieza controlada falla; un monitor externo debe alertar al administrador si `/api/health` no responde, si queda poco espacio o si la última copia válida supera 26 horas. Destinatario y canal quedan por elegir.
- Restauración: mensualmente, restaurar la última copia en un proyecto Docker aislado y ejecutar `docker-restore-check.cjs`; trimestralmente, hacer un simulacro de inicio y consulta con datos ficticios. Nunca probar la restauración encima de producción.

La retención, el destino externo, el canal de alertas y el mecanismo para cifrar staging requieren decisión antes de habilitar el timer. No hay automatización de respaldos desplegada.

## Actualización segura

1. Descargue una etiqueta aprobada y compruebe su origen. No actualice desde `main` sin revisión.
2. Detenga backend/frontend, cree un respaldo nuevo y ejecute `docker-restore-check.cjs`.
3. Valide Compose con `config --quiet`, construya las imágenes y ejecute el plan oficial `--plan` sin `--install-base-schema`.
4. Revise checksums, dependencias, estados parciales y la lista exacta de migraciones pendientes.
5. Aplique únicamente el conjunto aprobado con el ejecutor oficial. No se ejecuta DDL al reiniciar backend.
6. Inicie backend/frontend y verifique salud, inicio administrativo, separación de negocios y módulos principales.

No revierta manualmente DDL ni restaure encima de una base que recibió escrituras después del respaldo. Si falla el binario después de una migración, detenga tráfico, preserve logs y respaldo, y prefiera corregir hacia adelante. La restauración requiere un procedimiento de incidente y una ventana aprobada.

## Respaldos automáticos y monitoreo pendientes

No se instaló un timer de backups porque todavía faltan destino off-site, retención, cifrado y destinatario de alertas; guardar copias ilimitadas en el único disco acabaría llenándolo. Además, el respaldo consistente actual detiene backend/frontend. Antes de producción, acuerde el RPO/RTO, el tamaño esperado, la frecuencia y una ventana de mantenimiento, y pruebe restauraciones periódicas. Añada monitoreo externo de HTTPS, salud de `/api/health`, espacio libre y última copia validada. Compose ya ofrece healthchecks locales, pero no envía alertas externas.

## Plan, precio y capacidad

El backend impone el máximo de usuarios del plan Básico (3: un administrador y dos vendedores) y los límites se verifican al crear/reactivar usuarios. El catálogo no fija el precio de USD 20 ni existe cobro recurrente integrado: los pagos mensuales se registran manualmente desde administración. Defina el proceso de facturación, seguimiento de vencimientos y suspensión antes de vender suscripciones.

Para arrancar, presupuestaría al menos 4 vCPU y 8 GB RAM, con 100–150 GB de almacenamiento; elegir NVMe si el costo lo permite. Es una recomendación de planificación, no capacidad garantizada. Contabo describe Cloud VPS 4 con 4 vCPU, 8 GB RAM y 100 GB SSD, y Cloud VPS Plus 4 con 4 vCPU, 8 GB y 150 GB NVMe; su documentación advierte que las vCPU son compartidas. Valide la carga, espacio de imágenes, respaldos y latencias en el VPS contratado antes de anunciar un número de usuarios soportados. Consulte [precios y recursos actuales de Contabo](https://contabo.com/en-us/pricing/) y [documentación de sus VPS](https://docs.contabo.com/docs/products/cloud-vps/).

Las pruebas locales previas llegaron a 50 usuarios simultáneos en esta computadora. Eso no equivale a una garantía para un VPS. No existe todavía una medición del servidor Contabo real.
