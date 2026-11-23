# SoftVentaWeb: detalle de factura y verificacion de favicon

## Alcance

La candidata se construye sobre las imagenes activas y requiere pasar de nuevo todas las precondiciones remotas. El delta de codigo de esta revision modifica unicamente `app.js` y `connected-sales.js`: el comprobante usa el primer campo de detalle no vacio, y el checkout conectado conserva una captura estable del detalle entre cotizacion y cobro. El campo no se incluye en la cotizacion; se envia con la venta usando `sales.detail` existente.

La API ya valida, persiste y devuelve `sales.detail`. `backend.patch` solo declara las dos rutas revisadas y no contiene hunks; no cambia codigo backend ni esquema. La busqueda del historial y el favicon ya publicados se comprueban y se conservan. Los seis iconos versionados quedan en el paquete para verificar integridad; si una ruta activa contiene bytes distintos, la preparacion se detiene.

No se modifican categorias, Panel de Administracion, landing, permisos, datos, inventario, caja, pagos, consecutivos ni migraciones. No se crean ventas reales. `-PrepareCandidateOnly` prepara una candidata sin reemplazar los servicios activos; `-Deploy` requiere una ejecucion posterior autorizada.
## Archivos incluidos

- `deploy-softventa-billing-favicon.ps1`: valida hashes y ejecuta una sola modalidad.
- `remote-deploy-softventa-billing-favicon.sh`: inspección, construcción de candidata, despliegue controlado y rollback.
- `payload/frontend.patch`: dos cambios incrementales en `app.js` y `connected-sales.js`; la busqueda publicada se verifica sin reescribirla.
- `payload/backend.patch`: valida las dos rutas allowlisted sin hunks de codigo; el backend no cambia.
- `payload/apply-softventa-overlay.cjs`: aplica los hunks y las rutas versionadas con protección contra sobrescrituras.
- `payload/Dockerfile.frontend` y `payload/Dockerfile.backend`: construyen sobre las imágenes activas.
- `payload/softventaweb-favicon-20261106-16.png`, `...-32.png`, `...-48.png`, `...-20261106.svg`, `softventaweb-touch-20261106-192.png` y `softventaweb-pwa-20261106-512.png`.
- `payload/MANIFEST.sha256` y `PACKAGE_CONTENTS.sha256`: manifiestos internos SHA-256.

## Verificar el ZIP y preparar la candidata

```powershell
$zip = 'C:\Proyectos\proyecto 1\DEPLOY_SOFTVENTAWEB_BILLING_FAVICON_20261107_INVOICE_DETAIL_FIX_R3.zip'
$expected = ((Get-Content -LiteralPath ($zip + '.sha256') -Raw).Trim() -split '\s+')[0].ToUpperInvariant()
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash -ne $expected) {
    throw 'El ZIP no coincide con el paquete verificado.'
}
$dst = Join-Path $env:TEMP ('softventa-billing-favicon-' + [guid]::NewGuid().ToString('N'))
Expand-Archive -LiteralPath $zip -DestinationPath $dst
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$dst\deploy-softventa-billing-favicon.ps1" -SelfTest
if ($LASTEXITCODE -ne 0) { throw 'Falló la validación local del paquete.' }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$dst\deploy-softventa-billing-favicon.ps1" -PrepareCandidateOnly
if ($LASTEXITCODE -ne 0) { throw 'Falló PrepareCandidateOnly. No continuar.' }
```

`-SelfTest` rechaza cualquier byte CR en los scripts `.sh` del paquete. Antes de `sudo` o de preparar una candidata, el lanzador compara el SHA-256 remoto con el local, vuelve a detectar CR en el archivo transferido y ejecuta `/bin/bash -n`. `scp` transfiere el helper sin reescribir sus bytes.
`-SelfTest` tambien valida que `compose_fields` pase la ruta del JSON como argumento a `python3 -c`. Si encuentra Python local funcional, ejecuta el fragmento con un fixture: confirma el `IndexError` al omitir la ruta y las cinco salidas esperadas al pasarla. Si no hay Python local funcional, la comprobacion estructural obligatoria sigue detectando la perdida del argumento antes de la transferencia.
`-SelfTest` valida que las diez comprobaciones de categorias conserven sus diagnósticos individuales y que las comillas simples internas sobrevivan al parseo Bash. El helper ejecuta los chequeos de categorías en una imagen efímera, de solo lectura y sin red; imprime `CATEGORY_SOURCE_<check>=PASS|FAIL` por cada patrón.
`-SelfTest` reproduces the two blank lines between the POS manifest link and stylesheet and the corresponding landing icon gap. It accepts blank-only lines only at head gaps bracketed by retained elements around favicon-only lines found in the active/candidate HTML; it still rejects blank lines elsewhere and changes to meta, script, form, or other content with an active/candidate unified diff. Manifest and service-worker fixtures verify their narrow cache/icon exceptions.
`-SelfTest` checks the exact protected-resource exceptions for the numbered favicon PNGs, standalone SVG, touch icon, and PWA icon. Existing logo, CSS, landing CSS, and Nginx files stay protected. The standalone SVG is listed explicitly because its name does not match the numbered PNG pattern. Hash failures print each path with old and new SHA-256; no broad `assets/pwa` exclusion is used.
The permission failure was reproduced from the actual Windows TAR packaging mode: source icons were stored as 0666, then the helper's `umask 077` plus `--no-same-permissions` extracts them as 0600. Docker `COPY` preserves source file permissions, leaving no read bit for the Nginx worker regardless of final ownership. The overlay now applies mode 0644 only to the six allowlisted, versioned favicon files after verifying regular files and matching bytes; it rejects symlinks and hard links. It does not change icon bytes or any existing resources.
HTTP probes explicitly bypass proxy environment variables and report the HTTP status, remote IP, loopback origin, selected response headers, candidate file and parent-directory modes, relevant Nginx directives, and matching container log errors. Every static/favicon route still requires 2xx; 403 is rejected. The existing anonymous protected-API check continues to treat 401/403 as the expected authorization denial.
`-SelfTest` runs a Node fixture against both new and already-present icon paths and verifies that all six receive `chmod 0644` without changing their bytes. It also checks the HTTP diagnostics, direct-proxy bypass, strict status requirements, and post-deployment loopback probes.
The VPS host does not need Node.js installed. Docker applies the overlay using the active backend image as its Node runtime, and JavaScript syntax checks run inside isolated candidate backend containers with networking disabled.
`-SelfTest` reproduces the old gzip timestamp drift by creating two legacy archives and confirming their SHA-256 values differ. It then creates two normalized USTAR/GZipStream archives and requires identical SHA-256 values and a zero gzip timestamp. This makes the archive hash used for Docker candidate labels and tags stable across separate `-PrepareCandidateOnly` and `-Deploy` runs.
After all candidate validations pass, `-PrepareCandidateOnly` persists two `billing-favicon-prepared-*` Docker tags. Each marker points to the validated immutable image, whose labels bind the package archive hash to the active frontend and backend image IDs. `-Deploy` requires both marker tags and candidate aliases to point to those same image IDs, checks all labels against the current active images, and reruns candidate validations before asking for the publish phrase. A missing marker, wrong alias, missing image, or changed active base produces a separate diagnostic and stops before deployment; rerun `-PrepareCandidateOnly` with this ZIP before `-Deploy`.
`-PrepareCandidateOnly` compara contenedores, imágenes, recursos activos y candidata; valida Docker Compose, Nginx, rutas, MIME, título, manifiesto, iconos, health del API y rechazo de historial sin sesión. Comprueba estáticamente el permiso `history`, el aislamiento y la paginación. La metadata de MySQL se consulta con `SELECT`; no se crean ventas ni se escriben datos. Construye imágenes candidatas y un contenedor frontend temporal ligado solo a loopback, que elimina al terminar. No recrea frontend/backend activos. Si informa `NO_CHANGES_REQUIRED=PASS`, la candidata ya coincide con la versión activa y no se debe desplegar.

El informe identifica los archivos que difieren entre imagen activa y candidata. Detiene el proceso si el código activo no coincide con los contextos esperados, o si hay cambios ajenos en landing, configuración Nginx, categorías, administración, migraciones o recursos protegidos.

## Despliegue posterior, cuando se autorice

Después de revisar la candidata y acordar ventana de mantenimiento, ejecutar:

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$dst\deploy-softventa-billing-favicon.ps1" -Deploy
if ($LASTEXITCODE -ne 0) { throw 'Falló el despliegue controlado.' }
```

El helper pide escribir `PUBLICAR FACTURACION`. Antes de recrear solo frontend y backend, conserva las imágenes actuales con tags de rollback y guarda sus identidades, el hash del paquete y la identidad/volumen MySQL en `/opt/pos/backups/softventa-billing-favicon-<token>` con permisos `0600`. No respalda ni modifica datos porque no hay migración ni cambio de esquema. Verifica health, rutas y las imágenes en uso; MySQL debe conservar contenedor, imagen y volumen.

## Rollback

El despliegue informa `ROLLBACK_TOKEN`. Con el mismo ZIP y paquete verificado, ejecutar:

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$dst\deploy-softventa-billing-favicon.ps1" -Rollback -RollbackTag 'TOKEN_INFORMADO'
if ($LASTEXITCODE -ne 0) { throw 'Falló el rollback controlado.' }
```

El rollback comprueba hash del paquete, imágenes esperadas, identidad MySQL y que las imágenes activas sigan siendo las publicadas por este despliegue. Pide escribir `ROLLBACK TOKEN_INFORMADO` y restaura solo frontend/backend. No restaura MySQL. Si esas identidades cambiaron, se detiene para evitar revertir sobre una versión posterior.
