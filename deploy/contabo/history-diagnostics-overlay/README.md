# SoftVentaWeb: corrección aislada del runtime del historial

## Causa comprobada y alcance

La versión pública de `connected-sales.js` llama `window.PosRuntime.clearSalesSearchResults()` en la línea 178 cuando el campo de búsqueda está vacío. En la versión pública de `app.js`, `PosRuntime` solo expone `setSales` y `publishSale` en ese punto: no define `clearSalesSearchResults` ni `setSalesSearchResults`. La llamada genera `TypeError: ... is not a function` durante `history-search`, aunque las APIs respondan HTTP 200 y los IDs de negocio coincidan.

El overlay añade a `app.js` únicamente esos dos métodos de historial, con las mismas comprobaciones de `connectedMode` y `CONNECTED_EFFECTIVE_BUSINESS_ID` que usa la implementación local. Resultados de otros negocios se rechazan. También cambia `CACHE_NAME` para forzar al service worker a descargar los recursos de esta candidata. No cambia ventas, cobros, facturas, inventario, API, backend, MySQL ni datos.

Este paquete agrega diagnósticos de solo lectura activados únicamente cuando la URL del POS contiene `?diag=history`. No corrige ni altera las ventas, las validaciones, los permisos ni el aislamiento por negocio.

El transformador fue ajustado a las firmas servidas actualmente: `navigate(view)` en `connected-auth.js`, `loadHistoryOnce()` y `loadHistory({ refresh = false } = {})` en `connected-sales.js`, y el `catch` vigente de indicadores. El SelfTest reproduce que el antiguo anclaje `moduleLoadStates` tiene cero coincidencias. Antes de construir, el overlay vuelve a comprobar cada anclaje con coincidencia única sobre los archivos de la imagen frontend activa.

El lanzador crea el TAR con cabeceras USTAR y gzip normalizadas: nombres/orden allowlist, propietario y modo fijos, mtime TAR cero, mtime gzip cero y bloques DEFLATE almacenados para evitar variaciones del compresor. `-SelfTest` genera dos archivos desde los mismos miembros y exige bytes y SHA-256 idénticos. Por eso `PrepareCandidateOnly` y `Deploy` calculan el mismo identificador de paquete en ejecuciones separadas. El SHA de seguridad sigue verificando el archivo TAR completo.

El primer `-PrepareCandidateOnly` con esta revisión tendrá un SHA de payload nuevo respecto de los TAR anteriores. Puede construir una nueva candidata; las candidatas y estados anteriores se conservan. Ejecutar después `-Deploy` desde este mismo ZIP reconocerá la candidata nueva por su SHA reproducible y por los IDs de las imágenes activas.

## Alcance del overlay

- El transformador valida los diagnósticos publicados y cambia solo `app.js` y la revisión `CACHE_NAME` de `service-worker.js` cuando se aplica a la imagen actualmente servida. El allowlist continúa limitado a `api-client.js`, `app.js`, `connected-auth.js`, `connected-sales.js` y `service-worker.js`.
- El SelfTest reproduce el `TypeError` con la estructura de `PosRuntime` publicada, comprueba la carga sin búsqueda y la búsqueda con fixture en viewports de escritorio (1365×900) y móvil (390×844), y verifica el rechazo de ventas de otro negocio.
- Conserva el backend publicado sin construirlo ni recrearlo. Su imagen activa se usa únicamente como runtime Node de la fase de construcción.
- La fase de preparación fija como base la imagen frontend que esté activa en ese momento y guarda su ID, el ID del backend, la identidad de MySQL, el paquete y el ID candidato.
- La invalidación del service worker cambia solo `CACHE_NAME`; mantiene su prefijo, precache y estrategia.
- El transformador comprueba el árbol web completo y rechaza cambios fuera de los cuatro recursos allowlist.
- La transferencia conserva el `StrictHostKeyChecking=yes`; limita intentos de conexión a dos y agrupa `chmod`, preflight Bash y helper en una sola sesión SSH interactiva. El helper no se reintenta automáticamente si la sesión cae después de iniciar; se debe revisar el estado antes de repetir.
- No incluye categorías, Panel de Administración, landing, branding, archivos de negocio, backend, migraciones ni datos.

## Diagnósticos en Brave o Edge

1. Abra el POS agregando `?diag=history` a la URL. Si la URL ya contiene `?`, agregue `&diag=history`.
2. Abra DevTools con F12 y seleccione **Console**.
3. En el menú **Default levels / Niveles predeterminados**, active **Info**, **Warnings/Advertencias** y **Errors/Errores**. Quite filtros de nivel y escriba `[SoftVentaWeb diagnostic]` en el filtro de texto.
4. Inicie sesión y abra Historial. Copie únicamente las líneas `[SoftVentaWeb diagnostic]`.

Las líneas incluyen fase, método/ruta sin query, estado HTTP, código, ubicación JavaScript y comparación de IDs de negocio. No incluyen cuerpo de respuesta, datos de factura, nombres de clientes, cookies, tokens ni credenciales. Sin `diag=history` no se generan estos registros.

En Windows, `-SelfTest` verifica los bytes LF y puede ejecutar `bash -n` si hay Bash local. En todos los casos, antes de ejecutar el helper remoto el lanzador exige que Contabo ejecute `sudo /bin/bash -n`; si falla, no inicia ninguna preparación ni despliegue.

## Verificar y preparar

Verifique el SHA-256 antes de extraer. Reemplace el valor esperado con el hash entregado junto al ZIP:

```powershell
$zip = 'C:\Proyectos\proyecto 1\DEPLOY_SOFTVENTAWEB_HISTORY_RUNTIME_FIX_20261108_R2.zip'
$expected = 'PEGAR_SHA256_DEL_ZIP'
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant() -ne $expected.ToLowerInvariant()) { throw 'SHA-256 del paquete incorrecto.' }
$dst = Join-Path $env:TEMP ('softventa-history-diag-' + [guid]::NewGuid().ToString('N'))
Expand-Archive -LiteralPath $zip -DestinationPath $dst
$launcher = Join-Path $dst 'deploy-softventa-history-diagnostics.ps1'
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
& $powershell -NoProfile -ExecutionPolicy Bypass -File $launcher -SelfTest
if ($LASTEXITCODE -ne 0) { throw 'Falló SelfTest. No continuar.' }
```

Prepare la candidata. Este paso usa sudo interactivo y Docker en Contabo para construir y probar una imagen temporal sobre la imagen frontend activa; no recrea ni publica servicios:

```powershell
& $powershell -NoProfile -ExecutionPolicy Bypass -File $launcher -PrepareCandidateOnly
if ($LASTEXITCODE -ne 0) { throw 'Falló PrepareCandidateOnly. No publicar.' }
```

La preparación hace `nginx -t`, prueba los recursos estáticos, verifica `/api/health` y confirma que las rutas protegidas respondan 401/403 sin sesión. Guarda estado protegido para una ejecución posterior y muestra `PREPARE_ONLY=PASS`. No crea ventas ni ejecuta migraciones.

## Publicación posterior

No ejecutar hasta revisar `PREPARE_ONLY=PASS` y autorizar expresamente la publicación:

```powershell
& $powershell -NoProfile -ExecutionPolicy Bypass -File $launcher -Deploy
if ($LASTEXITCODE -ne 0) { throw 'Falló el despliegue controlado.' }
```

El helper solicita confirmar `PUBLICAR DIAGNOSTICOS HISTORIAL`, respalda la imagen frontend anterior y recrea solo `frontend`. Si la validación falla, intenta restaurar esa imagen automáticamente. MySQL y backend deben conservar sus IDs.

## Rollback

Use el token `ROLLBACK_TOKEN` impreso por el despliegue, después de revisar el estado real:

```powershell
& $powershell -NoProfile -ExecutionPolicy Bypass -File $launcher -Rollback -RollbackTag 'YYYYMMDDTHHMMSSZ-aaaaaaaaaaaa'
if ($LASTEXITCODE -ne 0) { throw 'Falló el rollback controlado.' }
```

El helper verifica que el frontend activo sea la candidata registrada y que backend/MySQL no hayan cambiado. Pide confirmar `ROLLBACK <token>` y restaura únicamente frontend.
