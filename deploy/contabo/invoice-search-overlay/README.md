# SoftVentaWeb: overlay aislado de facturación

Este paquete aplica sobre las imágenes que estén activas en Contabo. No reemplaza archivos enteros de ventas ni el HTML activo: aplica hunks verificados a tres JS del frontend y dos del backend, e inserta el campo de búsqueda en el HTML activo. Si el contexto publicado no coincide, se detiene.

## Alcance exacto

- Frontend: app.js, connected-sales.js y api-client.js; añade el campo de búsqueda al historial y rota el nombre de caché del service worker solo si cambian recursos del frontend.
- Backend: backend/src/routes/sales.js y backend/src/services/sales.js.
- No se incluyen ni sobrescriben landing, logo, favicon, manifiesto, CSS, categorías, Panel de Administración, datos, usuarios, licencias, migraciones ni esquema.

## Qué comprueba PrepareCandidateOnly

- Identidad y salud de los contenedores activos, configuración Compose y base productiva.
- Favicon, título, logo, landing y hashes de los recursos existentes; exige que sigan iguales en la candidata.
- Categorías: compara código activo/candidato para listar/crear/renombrar, guard ADMIN, aislamiento por negocio, columnas e índice único. La base se consulta solo con SELECT sobre metadata, antes y después; no se crea ni renombra una categoría en producción para evitar escribir datos durante esta validación. La prueba funcional de crear/renombrar se hizo en MySQL aislado local.
- Búsqueda: valida límite de consulta, aislamiento por business_id, join de cliente por negocio y paginación maxId.
- Construye imágenes candidatas sobre las imágenes activas; verifica Nginx y rutas estáticas de la candidata en un puerto loopback temporal. No recrea servicios ni ejecuta el servicio migrate.

## Preparación

Extraé el ZIP y verificá su SHA-256 antes de ejecutar:

~~~powershell
$zip = 'C:\Proyectos\proyecto 1\DEPLOY_SOFTVENTAWEB_INVOICE_SEARCH_20261106.zip'
$expected = 'PEGAR_EL_SHA256_INFORMADO_CON_EL_PAQUETE'
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash -ne $expected) {
    throw 'El ZIP no coincide con el paquete verificado.'
}
$dst = Join-Path $env:TEMP ('softventa-invoice-' + [guid]::NewGuid().ToString('N'))
Expand-Archive -LiteralPath $zip -DestinationPath $dst
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$dst\deploy-softventa-invoice-search.ps1" -PrepareCandidateOnly
if ($LASTEXITCODE -ne 0) { throw 'Falló PrepareCandidateOnly. No continuar.' }
~~~

PrepareCandidateOnly requiere sudo interactivo remoto para comprobaciones de solo lectura y Docker. No publica imágenes ni cambia contenedores activos. Si informa NO_CHANGES_REQUIRED=PASS, el código ya está publicado y no se debe volver a desplegar.

## Publicación futura

Solo después de revisar que PrepareCandidateOnly pasó y autorizar expresamente el cambio:

~~~powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$dst\deploy-softventa-invoice-search.ps1" -Deploy
if ($LASTEXITCODE -ne 0) { throw 'Falló el despliegue controlado.' }
~~~

El helper exige escribir PUBLICAR FACTURACION, crea respaldo de ambas imágenes y recrea únicamente backend y frontend. MySQL y el servicio migrate no se inician ni modifican.

## Rollback futuro

El despliegue imprimirá ROLLBACK_TOKEN. Para revertir ambas imágenes:

~~~powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$dst\deploy-softventa-invoice-search.ps1" -Rollback -RollbackTag 'TOKEN_INFORMADO'
if ($LASTEXITCODE -ne 0) { throw 'Falló el rollback controlado.' }
~~~

El helper verifica que las imágenes y la identidad MySQL sigan correspondiendo al despliegue registrado y pide escribir ROLLBACK TOKEN_INFORMADO.
