# Commits y diferencias Git

## Estado de referencia auditado

- Rama: `release/v1.0.0-rc.6`; HEAD `6c25b3aa8a617dfedcf7d67549308775391e4146`.
- El árbol antes de crear esta carpeta tenía índice vacío, 19 archivos versionados modificados y 15 rutas sin seguimiento. La auditoría agregó únicamente `AUDITORIA_PARA_CHATGPT/` al estado no versionado.
- `git diff HEAD --stat`: 19 archivos, 242 inserciones y 109 eliminaciones. No había cambios staged.
- La rama no muestra upstream configurado. La referencia local en caché `origin/release/v1.0.0-rc.6` apunta a `ff098283b904e849be6ebe23ac3bbc08443ca733`; la comparación local es 7 commits por delante y 0 por detrás. La etiqueta local `v1.0.0-rc.6` también apunta a `ff098...`. No se hizo fetch: la frescura de esas referencias y el estado actual de GitHub son desconocidos.
- Comparación por refs locales solamente: `origin/main` apunta a `139c4c2`; no se usa para afirmar qué está publicado.

## Últimos 20 commits locales

```text
6c25b3a Agrega columna active a la migración de categorías
170ccba Agrega administración de categorías por negocio y restringe el panel de admin a ADMIN del negocio 1
15a2e3e Adapta prueba de Caddy al dominio de ejemplo
a9127c3 Siembra categorías predeterminadas al crear un negocio
78e3445 Centraliza autorización de administración
33d7477 Restringe el panel de administración a ADMIN del negocio 1
dbff972 Endurece cabeceras de seguridad del frontend y API
ff09828 Improve connected module navigation
249c353 Optimize connected module navigation
f80ebf9 Optimize connected navigation performance
4014b4d Allow optional local licensing in production Compose
b546a34 Prepare POS v1.0.0-rc.2
f54ca21 Prepare POS v1.0.0-rc.1
139c4c2 feat: estabilizar POS, migracion, reportes y planes
8a8afe4 Agregar migracion de ventas historicas locales
485b35f Agregar migracion inicial de inventario
744bd14 Agregar migracion basica desde paquete local
05e8356 Agregar importacion de paquete de migracion
9ad327f Agregar exportacion segura de paquete de migracion
0feda41 Mejorar claridad de migracion local
```

## Siete commits posteriores a la referencia local de release

| Hash corto | Fecha local | Mensaje | Archivos cambiados |
|---|---|---|---|
| `dbff972` | 2026-11-03 13:46:45 -06 | Endurece cabeceras de seguridad del frontend y API | `backend/src/app.js`, `backend/tests/security-headers.test.cjs`, `deploy/contabo/Caddyfile.example`, `docker/nginx/default.conf`, `tests/helpers/security-headers.cjs`, `tests/security-headers.spec.cjs` |
| `33d7477` | 2026-11-03 13:52:06 -06 | Restringe el panel de administración a ADMIN del negocio 1 | `backend/src/middleware/authentication.js`, `backend/src/repositories/auth.js`, `backend/src/routes/system-admin.js`, `backend/src/services/system-admin-access.js`, `backend/tests/system-admin-access.test.cjs`, `connected-auth.js` |
| `78e3445` | 2026-11-03 14:12:53 -06 | Centraliza autorización de administración | `api-client.js`, `backend/scripts/migrate-categories-test.cjs`, `backend/scripts/test-connected.cjs`, `backend/src/services/product-category-values.js`, `backend/src/services/system-admin.js`, `backend/tests/basic-migration.test.cjs`, `backend/tests/integration/local-licenses.test.cjs`, `backend/tests/integration/product-categories.test.cjs`, `backend/tests/inventory-migration.test.cjs`, `backend/tests/product-category-values.test.cjs`, `database/migrations/021_business_product_categories.sql`, `tests-connected/admin.spec.cjs`, `tests-connected/product-categories.spec.cjs`, `tests/product-categories.spec.cjs` |
| `a9127c3` | 2026-11-03 14:21:43 -06 | Siembra categorías predeterminadas al crear un negocio | `backend/src/services/bootstrap.js` |
| `15a2e3e` | 2026-11-03 14:21:51 -06 | Adapta prueba de Caddy al dominio de ejemplo | `backend/tests/security-headers.test.cjs` |
| `170ccba` | 2026-11-03 16:03:26 -06 | Agrega administración de categorías por negocio y restringe el panel de admin a ADMIN del negocio 1 | `api-client.js`, `app.js`, `backend/scripts/test-connected.cjs`, `backend/scripts/test-integration.cjs`, `backend/src/routes/inventory.js`, `backend/src/services/inventory-values.js`, `backend/src/services/inventory.js`, `backend/src/services/schema-migrations.js`, `backend/src/services/system-admin.js`, `backend/tests/integration/schema-migrations.test.cjs`, `backend/tests/schema-migrations.test.cjs`, `connected-auth.js`, `connected-inventory.js`, `index.html`, `styles.css`, `tests-connected/admin.spec.cjs`, `tests/product-categories.spec.cjs` |
| `6c25b3a` | 2026-11-03 16:15:39 -06 | Agrega columna active a la migración de categorías | `database/migrations/021_business_product_categories.sql` |

## Diferencias funcionales relevantes

- `33d7477` agrega el helper compartido y cambia el frontend/middleware/repositorio a rol + negocio, sin nombre de usuario.
- `78e3445` introduce normalizador/siembra/migración 021 y cambia también lógica de autorización dentro de `system-admin.js`; por eso su contenido mezcla categorías y administración pese al mensaje de centralización.
- `a9127c3` siembra categorías al crear negocio; `170ccba` añade CRUD/API/UI, verificación tenant y pruebas. Ese commit vuelve a combinar categorías y regla de administración y contiene el cambio de categoría en `system-admin.js`.
- `6c25b3a` agrega `active TINYINT(1) NOT NULL DEFAULT 1` a la misma migración 021. El servicio de migraciones compara checksum contra el archivo actual, por lo que cualquier instalación previa que registrara el checksum anterior sería incompatible.
- `dbff972` es seguridad de cabeceras; es independiente de las dos funciones salvo que pertenece al mismo tramo local posterior al tag.
- No se incluyen parches crudos porque diffs generales pueden arrastrar datos de fixture u otros valores no necesarios; los archivos de código para revisión están copiados completos en `ARCHIVOS_RELEVANTES/` (pruebas sanitizadas).

## Cambios pendientes del árbol de trabajo (pre-auditoría)

### Modificados (19)

```text
assets/pwa/pos-icon-192.png
assets/pwa/pos-icon-512.png
assets/pwa/pos-icon.svg
backend/scripts/test-connected.cjs
database/migrations/README.md
deploy/contabo/OPERATIONS.md
index.html
manifest.webmanifest
offline.html
scripts/build-static.cjs
scripts/check-vendored-assets.cjs
scripts/run-local-playwright.cjs
skills-lock.json
styles.css
tests-connected/local-licenses.spec.cjs
tests-connected/user-facing-errors.spec.cjs
tests/interface-layout.spec.cjs
tests/local-license.spec.cjs
tests/pwa-offline.spec.cjs
```

### Sin seguimiento (15, antes de crear esta evidencia)

```text
.agents/skills/find-security-vulnerabilities-in-code/
assets/pwa/favicon-16.png
assets/pwa/favicon-32.png
assets/pwa/favicon-48.png
assets/pwa/softventaweb-logo.webp
deploy/contabo/deploy-softventa-landing.ps1
deploy/contabo/deploy-softventa-logo.ps1
deploy/contabo/landing-overlay.Dockerfile
deploy/contabo/remote-softventa-landing.sh
deploy/contabo/security-headers/
inicio/
robots.txt
sitemap.xml
tests/landing-page.spec.cjs
tests/softventa-brand.spec.cjs
```

`database/migrations/README.md` incluye documentación local sobre 021. `backend/scripts/test-connected.cjs` tiene un ajuste de CSP para el servidor de prueba. Los cambios restantes corresponden por nombre y contenido revisado a landing/marca/logo, PWA, licencias locales, errores/UI, scripts y documentación operativa. Se describen como ajenos al alcance; el diff no permite afirmar que fueran accidentales. Ningún cambio de esas rutas se incluyó en los commits de las categorías de evidencia, salvo las rutas de categorías/auth ya explicadas.

## Estado Git después de crear evidencia

`AUDITORIA_PARA_CHATGPT/` queda como nueva ruta no versionada autorizada. No se alteraron los 19 archivos modificados ni las rutas previas sin seguimiento. La creación del ZIP agrega el único archivo raíz adicional autorizado: `AUDITORIA_SOFTVENTAWEB.zip`.