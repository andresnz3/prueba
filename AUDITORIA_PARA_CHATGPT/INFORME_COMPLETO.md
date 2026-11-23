# Auditoría técnica independiente de SoftVentaWeb

**Fecha:** 2026-11-03 (America/Managua, UTC-06:00)  
**Alcance:** estado local real de `release/v1.0.0-rc.6`, comportamiento estático y pruebas seguras permitidas, más observación HTTP pública sin autenticación.  
**Restricción:** no se editó ningún archivo original, no se aplicaron migraciones a bases principales, no se accedió por SSH, no se ejecutó despliegue ni se hizo `fetch`.

## Resumen ejecutivo

El código local contiene una gestión de categorías por negocio utilizable en modo local y operaciones conectadas de consulta, creación y renombrado protegidas por sesión, módulo y rol ADMIN. En el backend se usa el negocio de la sesión y las operaciones quedan acotadas por `business_id`. Hay límites funcionales: el modo conectado no ofrece desactivación; el API de productos acepta texto de categoría que no se valida contra la tabla administrada, y hay dos riesgos de migración/compatibilidad que se detallan abajo.

La regla local del Panel de Administración coincide en frontend y backend con ADMIN + negocio 1. Sin embargo, quedó lógica de cuotas con la regla vieja `username='andres'`, una prueba de integración que espera el resultado viejo y el frontend público continúa con la regla antigua. No se demostró un bypass del guard backend local; la publicación backend no se pudo comprobar.

**Conclusión:** categorías **CON PROBLEMAS**; Panel de Administración **CON PROBLEMAS**. No se detectó evidencia suficiente para declarar un problema CRÍTICO o ALTO. Los hallazgos reproducibles y condicionales se clasifican abajo; “no detectado” no significa “funciona demostrado”.

| Gravedad | Cantidad |
|---|---:|
| CRÍTICO | 0 |
| ALTO | 0 |
| MEDIO | 4 |
| BAJO | 3 |

## Alcance y método

- Se leyó el árbol de trabajo completo para las rutas de las dos funciones, sesiones, compras, configuración de migraciones y cambios Git. La evidencia de código está dentro de `ARCHIVOS_RELEVANTES/`; los archivos de pruebas incluidos que contenían contraseñas de fixture tienen esos literales sustituidos en la copia por `[REDACTED_TEST_FIXTURE]`. Las fuentes originales no se sanitizaron ni modificaron.
- Se ejecutaron lint, unitarias backend e integración aislada de categorías, y también integración aislada de autenticación para verificar el guard. El ejecutor crea bases aleatorias `pos_auth_test_*` y las elimina al terminar; no se aplicó la migración a la base principal.
- No se ejecutó Playwright porque sus runners pueden crear/alterar `dist`, reportes o resultados fuera de la única carpeta autorizada para escritura. No se usó `npm audit` porque depende de red/estado de caché fuera de esa carpeta; la revisión de dependencias fue estática desde los manifiestos y lockfiles.
- La skill de auditoría de seguridad se consultó. Su flujo Strix monta el proyecto con capacidad de escritura, incompatible con el modo de solo lectura solicitado; **Strix no se ejecutó**. No se hizo escaneo dinámico externo ni se intentó explotar un servidor.
- Producción se observó únicamente con GET público. No se consultaron API autenticadas ni base de datos. Los resultados de producción no prueban el estado del backend ni de MySQL.

## Arquitectura relevante

- **Modo local:** `app.js` abre Dexie y declara `product_categories` en versión 12. Las categorías guardan `business_id`, nombre normalizado y `active`; la identidad local de negocio se obtiene del runtime local. En este modo no se requiere cuenta/rol conectado: el usuario local puede administrar sus datos.
- **Modo conectado:** frontend `app.js` → `connected-inventory.js` → `api-client.js` → rutas Express `/api/product-categories` y `/api/products` → servicio de inventario → repositorio de autenticación/tenant → MySQL. La identidad conectada proviene de la sesión validada por backend, no de Dexie.
- **Panel administrativo:** `connected-auth.js` solo controla navegación y presentación. El servidor monta las rutas de `system-admin` en `backend/src/app.js`; las rutas exigen sesión propia y la regla central se repite en los servicios. La autorización decisiva ocurre en servidor, por lo que ocultar botones no es la barrera de seguridad.
- **Persistencia:** migración 021 crea `product_categories`, índice único por `(business_id, normalized_name)`, clave foránea a `businesses`, las cuatro categorías iniciales y categorías observadas en productos previos. Productos conservan `category` como texto, sin FK a la tabla de categorías.

## Categorías por negocio

### Flujo conectado comprobado en código

1. `app.js:448-515` inicializa categorías locales y las opciones del formulario. `connected-inventory.js:106-118` obtiene/crea/renombra usando el negocio efectivo y verifica que el `businessId` devuelto corresponda a ese negocio. `api-client.js:459-470` envía `GET`, `POST` y `PATCH` a `/product-categories`.
2. `backend/src/routes/inventory.js:11-18` aplica autenticación, `Cache-Control: no-store`, permiso de módulo inventario y CSRF a las mutaciones. Las rutas `POST` y `PATCH` llevan además `m.admin` (`:31-39`).
3. `backend/src/services/inventory.js:54-82` consulta/crea/renombra con `current.business_id`. Crear y renombrar vuelven a comprobar `role === 'ADMIN'`; duplicados resultan en 409, un ID ajeno en renombrado resulta en 404. Al renombrar, actualiza productos del mismo negocio y registra auditoría en la misma transacción/flujo tenant.
4. `productCategoryName` (`backend/src/services/product-category-values.js:4-14`) exige string, trim/espacios, máximo 100 caracteres y rechaza controles C0/DEL; normaliza acentos, espacios y caja para unicidad. El índice SQL impone unicidad por negocio. Los errores inválidos se traducen a 400 y duplicados a 409.
5. `bootstrap.js:4,19` y `system-admin.js:488-514` siembran valores predeterminados al crear negocios; la migración siembra los negocios existentes y preserva nombres previos de productos.

### Creación, renombrado, eliminación y compatibilidad

- **Creación/edición:** crear y cambiar nombre están implementados en modo conectado. El renombrado preserva referencias actuales en `products.category` para coincidencias exactas y deja auditoría con cantidad actualizada.
- **Eliminación/desactivación:** en modo local sí existe `setLocalProductCategoryActive` (`app.js:500-511`); conserva los registros y evita seleccionar inactivos para nuevos productos. En conectado no se encontró endpoint de desactivación/eliminación; el API expone solo GET/POST/PATCH de nombre y el DTO omite `active`. La documentación de migración indica no eliminar categorías para preservar historial.
- **Integración con productos:** los formularios y el catálogo conectado cargan categorías; compras trabajan con productos y sus datos, sin relación propia a `product_categories`. No hay una clave foránea de `products.category` a la categoría.
- **Valores arbitrarios:** el validador de producto acepta `category` como texto genérico de hasta 100 (`inventory-values.js:26-44`); `POST/PATCH /products` lo persisten (`routes/inventory.js:44-45`, `inventory.js:86-108`) sin buscar categoría válida/activa en el negocio. Un cliente HTTP con permiso de inventario puede enviar un nombre que no está en la lista administrada. Esto no modifica la tabla de categorías, pero sí deja nombres fuera del catálogo administrado en productos.
- **Aislamiento:** las consultas CRUD de categoría incluyen `business_id` desde sesión. Los campos extra como `businessId` se rechazan en el cuerpo. La clave foránea evita negocios inexistentes; el índice único es compuesto por negocio. La integración verificó vendedor, negocio distinto y renombrado con intento de ID ajeno.
- **Datos existentes:** la migración inserta `TRIM(category)` como nombre de categoría. El rename posterior actualiza `products` solo cuando `category = previous.name` exacto. Si un producto histórico conserva espacios de borde, la categoría sembrada puede normalizarse pero el producto no se actualizará al renombrarla.
- **Errores:** las rutas rechazan entrada inválida, duplicados (409), categoría inexistente/ajena (404), no autenticado (401), permiso de módulo/rol insuficiente (403). La integración de categorías aprobó los casos ejecutados.

## Panel de Administración

### Regla y control por capas

- `connected-auth.js:26` implementa exactamente `identity.role === 'ADMIN' && String(identity.businessId) === '1'`; `canAccessSystemAdmin()` exige además que la vista haya cargado (`:43`). La lista identifica cuenta protegida por rol y negocio (`:475`), sin username.
- `backend/src/services/system-admin-access.js:5-10` usa `auth.role === 'ADMIN' && String(auth.business_id) === '1'`; `requireSystemAdmin` responde 403 cuando no se cumple.
- `backend/src/repositories/auth.js:32,42,46,51` deriva identidad de filas de sesión/usuario/negocio y limita por hash del token, sesión, negocio, usuario activo, negocio activo, expiración y edad absoluta. Para acciones, vuelve a consultar la sesión actual; no toma el negocio de un campo arbitrario de la petición.
- `backend/src/middleware/authentication.js:14-43` valida sesión y exige al ADMIN del sistema para aceptar cookie de soporte; la sesión de soporte también valida sesión/negocio/rol ADMIN de destino. Las mutaciones comprueban CSRF (`:45-53`).
- `backend/src/routes/system-admin.js:16-30` coloca guard de sesión y regla central delante de `/admin` y `/system-admin`. Las operaciones de servicio vuelven a llamar `requireSystemAdmin` (por ejemplo `system-admin.js:647-700`). Las mutaciones llevan CSRF. Los endpoints de licencias administrativas se montan bajo `/system-admin` y reciben el mismo guard.
- `backend/src/repositories/auth.js:56-65` inserta `business_id` y `user_id` del actor en `audit_logs`; operaciones administrativas como negocio, usuarios y pagos llaman `repo.audit` (por ejemplo `system-admin.js:356,386,499,577,613,673,700`). En soporte registra actor y usuario/negocio operado.
- **Conclusión local de autorización:** no se identificó una ruta directa en el árbol local que salte el guard común. Los controles de frontend son adicionales; la seguridad principal está en el backend.

### Identidad, cuotas y prueba

La regla de acceso cambió, pero `backend/src/services/business-plans.js:28-30,54,69` todavía excluye o exime únicamente a `business_id=1 AND username='andres' AND role='ADMIN'`. Esto no abre `/admin` a otra identidad: sí deja la lógica de cuota/protección de usuarios con una política distinta a la del panel. Además, `backend/tests/integration/auth.test.cjs:184-186` todavía espera 403 para un ADMIN no llamado andres del negocio 1; la integración de autenticación falla con 200 en esa aserción. La falla corresponde a expectativa de prueba obsoleta respecto de la regla requerida, no evidencia de bypass.

## Diferencias entre local y producción

**Producción: frontend estático observado; backend y base: NO VERIFICADO.** En 2026-11-03 se obtuvo HTTP 200 sin autenticar:

- `/?mode=connected`: cuerpo SHA-256 `9ab84efbd8c5dda4364435b52b0dfacccb31e248528ec72b21fb7256596f1000`, `Cache-Control: no-store`, ETag `"6ae81f71-30c1b"`. El HTML público no contiene botón ni modal de categorías.
- `/connected-auth.js`: SHA-256 `b8a78a1ac49ccfef590fc7635f37a3f1702f5b2345e1f3ba70d7cc6436614b96`, `Cache-Control: no-cache`, ETag `"6ae7c328-1624f"`. El cuerpo contiene `identity.username === 'andres'` y la lista protege por el username.
- `/app.js`: SHA-256 `8a5b7e1f17e3b993b1adce7545af6d96554553ab8a299c085ee976ac52796bdf`; no contiene versión Dexie 12 ni `ensureLocalProductCategories`.
- `/connected-inventory.js`: SHA-256 `8c242c98ca13a23dafd4fd9ac4be5e4a274c8e9a98cc25428d7e0d6bfcab5564`; sin funciones conectadas de categorías.
- `/api-client.js`: SHA-256 `828f1223fc1d92482b6a23450424a14a0d32b47ac51989038d450b2613f035d1`; sin ruta `/product-categories`.

Esto demuestra que el frontend público observado no coincide con el código local actual. Las cabeceras indican revalidación/no-cache, pero no identifican por qué se está sirviendo ese contenido (origen, overlay de despliegue, contenedor o caché intermedia). No se revisó Caddy/Contabo ni se hicieron solicitudes contra el backend/API. GitHub tampoco se consultó; `origin/*` es solo referencia local en caché.

## Regresiones revisadas

- **Login/sesiones/roles:** autenticación busca usuario por nombre, comprueba contraseña, rechaza usernames ambiguos, negocio inactivo, usuario inactivo y sesión caducada. La integración probó los guards; una aserción heredada hace fallar el suite de auth.
- **Inventario/productos:** la categoría sigue siendo campo del producto; el rename actualiza productos del mismo negocio. La validación de categoría por catálogo no está en el backend (CAT-01).
- **Compras/ventas/clientes/proveedores/caja/cuentas:** los commits de categorías/autorización no añaden rutas de cobro ni modifican módulos de ventas, caja, clientes/proveedores o cuentas. `connected-purchases.js` no consulta `product_categories`; no se hizo flujo de compra/venda por navegador durante esta auditoría.
- **Licencias:** sus operaciones administrativas están detrás de `/system-admin`; no se modificaron usuarios ni licencias. No se verificó una operación de licencia en navegador.
- **Auditoría y separación:** categorías crean/renombran con actor y negocio del tenant; las operaciones admin guardadas registran actor. La auditoría depende de que sus llamadas y transacción completen; no se inspeccionó una base real.
- **Dependencias:** se revisaron los manifiestos/lockfiles empaquetados. No se hizo consulta actualizada a una base de vulnerabilidades; resultado de seguridad de dependencias: **NO VERIFICABLE**.

## Hallazgos clasificados

### MEDIO

**CAT-01 — Categoría de producto no se valida contra el catálogo del negocio**  
1. **Archivo/línea:** `ARCHIVOS_RELEVANTES/backend/src/services/inventory-values.js:26-44`; `backend/src/routes/inventory.js:44-45`; `backend/src/services/inventory.js:86-90`.  
2. **Descripción/evidencia:** `category` solo pasa por validación de texto genérica y se inserta/actualiza como texto. No se verifica que exista y esté activa en `product_categories` para el negocio de la sesión.  
3. **Consecuencia:** una solicitud directa puede crear/editar producto con categoría no administrada, incluso cuando el usuario no tiene permiso para crear/renombrar filas de categoría.  
4. **Recomendación:** validar en servidor por `business_id` y estado activo al guardar producto; definir expresamente compatibilidad con categorías heredadas.

**CAT-02 — Inmutabilidad/checksum de migración 021**  
1. **Archivo/línea:** `backend/src/services/schema-migrations.js:415-424`; `database/migrations/021_business_product_categories.sql:1-26`; commits `78e3445` y `6c25b3a`.  
2. **Descripción/evidencia:** la migración 021 se agregó en `78e3445` y su SQL se cambió después en `6c25b3a` para añadir `active`. El lector del ledger compara el checksum registrado con el contenido actual y aborta cuando difiere.  
3. **Consecuencia:** cualquier base que hubiera registrado/aplicado la versión anterior de 021 no podrá pasar el lector de migraciones con el archivo editado. No hay evidencia de que la base principal la haya aplicado; las bases de integración temporales se eliminan.  
4. **Recomendación:** antes de cualquier aplicación, confirmar el estado de todos los entornos; si existe una aplicación anterior, usar una migración correctiva nueva y conservar inmutable 021.

**AUTH-01 — Regla de cuota todavía vinculada a andres**  
1. **Archivo/línea:** `ARCHIVOS_RELEVANTES/backend/src/services/business-plans.js:28-30,54,68-70`.  
2. **Descripción/evidencia:** conteo y exenciones de usuario/admin siguen usando username, aunque el guard del panel ya usa rol y negocio.  
3. **Consecuencia:** dos ADMIN del negocio 1 con mismo rol y business_id reciben tratamiento diferente al contar cupos, crear/reactivar usuarios y proteger cuentas. No se encontró que esto permita acceso al panel; es contradicción de identidad/permisos.  
4. **Recomendación:** derivar exclusión/protección de la misma regla central de identidad, o quitar esa excepción de cuotas tras definir el plan del negocio sistema.

**DEPLOY-01 — Frontend público no contiene las funciones locales auditadas**  
1. **Archivo/línea:** evidencia pública descrita arriba; versión local en `connected-auth.js:26`, `app.js` categorías y `api-client.js:459-470`.  
2. **Descripción/evidencia:** el archivo público conserva comprobación por username y los assets de categorías no aparecen.  
3. **Consecuencia:** usuarios ADMIN distintos de andres podrían no ver el panel en frontend; gestión de categorías no está disponible en la web observada. El backend público sigue **NO VERIFICADO**.  
4. **Recomendación:** revisar artefacto y ruta de publicación de forma autorizada antes de declarar disponible la versión; no asumir que el commit local está desplegado.

### BAJO

**CAT-03 — Verificación de la migración no exige la columna `active`**  
1. **Archivo/línea:** `backend/src/services/schema-migrations.js:350-355`; migración `:1-8`.  
2. **Descripción/evidencia:** `migration021` valida otras columnas, índice único y FK, pero no incluye `active` entre columnas requeridas.  
3. **Consecuencia:** un esquema compatible incompleto sin `active` puede ser adoptado como aplicado por la comprobación de estructura, aunque el SQL canónico la define. No se encontró un esquema de producción que esté así.  
4. **Recomendación:** incluir `active` en la verificación y en la prueba de esquema.

**CAT-04 — Renombre no actualiza texto heredado con espacios de borde**  
1. **Archivo/línea:** `database/migrations/021_business_product_categories.sql:23-26`; `backend/src/services/inventory.js:74-81`.  
2. **Descripción/evidencia:** la migración crea nombre de categoría con `TRIM(category)`; rename actualiza productos solo con igualdad exacta al nombre sin espacios.  
3. **Consecuencia:** para una fila heredada `" Abarrotes "`, se siembra `"Abarrotes"` pero el cambio de nombre no actualiza esa fila. Depende de que existan datos históricos con espacios; no se encontró uno en una base comercial porque no se consultó.  
4. **Recomendación:** normalizar datos previos de forma controlada o actualizar también por la regla de normalización, respetando tenant y colisiones.

**AUTH-02 — Prueba de integración de autenticación conserva expectativa anterior**  
1. **Archivo/línea:** `backend/tests/integration/auth.test.cjs:184-186`.  
2. **Descripción/evidencia:** el test dice “requiere andres ADMIN del negocio 1” y espera 403 para el ADMIN de negocio 1; el backend devuelve 200 bajo la regla vigente. La ejecución aislada falló precisamente con esperado 403/recibido 200.  
3. **Consecuencia:** el suite de integración auth no está verde y una aserción reporta como fallo el comportamiento solicitado.  
4. **Recomendación:** actualizar esa prueba para aceptar cualquier ADMIN del negocio 1 y mantener casos negativos para vendedores y otros negocios.

## Pruebas y resultados

| Prueba/comprobación | Resultado | Evidencia |
|---|---|---|
| `npm.cmd run lint` | **PASÓ** | salida limpia, exit code 0 |
| `npm.cmd --prefix backend test` | **PASÓ** | 250 pasaron, 0 fallaron, 1 omitida |
| `npm.cmd --prefix backend run test:integration -- --product-categories-only` | **PASÓ** | migración/esquema 1/1 y categorías 7/7; bases temporales `pos_auth_test_*` eliminadas |
| `npm.cmd --prefix backend run test:integration -- --auth-only` | **FALLÓ** | una expectativa antigua: esperaba 403, recibió 200; el runner informa el fallo anidado y su contenedor |
| Playwright modo local | **NO EJECUTADA** | runner puede escribir resultados/build fuera de carpeta autorizada |
| Playwright modo conectado | **NO EJECUTADA** | mismo motivo; no se desplegó ni reinició servicio |
| Tests de producción/API/DB | **NO EJECUTADA** | no se usaron credenciales ni endpoints autenticados; backend/DB de Contabo no consultados |
| Auditoría actual de CVE/dependencias | **NO VERIFICABLE** | no se conectó a feeds ni se alteró caché de npm |
| GET público de HTML/JS | **PASÓ como observación HTTP** | HTTP 200; hashes y contenido descritos en “Diferencias entre local y producción” |

## Estado final por funcionalidad

- **Categorías: CON PROBLEMAS.** Modo local incluye gestión y desactivación. Modo conectado incluye listar/crear/renombrar con tenant y rol; no desactiva, y el guardado de producto permite texto fuera del catálogo. La migración 021 contiene `active`, pero su validador de estructura no la comprueba y el frontend público no muestra la función.
- **Panel de Administración: CON PROBLEMAS.** El guard frontend/backend local es el correcto para ADMIN + negocio 1 y la revisión no probó una ruta backend local que lo eluda. La política de cuotas sigue anclada a username, un test cubre regla vieja y el frontend público todavía usa andres. No se verificó el backend de producción.

## Lo no verificado

- Código actualmente instalado en GitHub/Contabo aparte del contenido estático entregado por GET público; no se hizo `fetch` ni SSH.
- Reglas reales en el backend/DB de producción, esquema 021 aplicado allí, datos históricos con categorías irregulares, permisos de MySQL en producción y operaciones con cuentas reales.
- Navegación y UX real de navegador durante este turno, integridad de compras/ventas con datos vivos y vulnerabilidades de dependencias consultando fuentes actualizadas.
- Causa técnica exacta de que los archivos públicos sigan antiguos (origen de build, contenedor, overlay o caché). Cabeceras/ETag solos no la identifican.