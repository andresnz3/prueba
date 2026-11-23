# Overlay del logo del login SoftVentaWeb

Este overlay se construye sobre la imagen frontend que esté activa en Contabo al ejecutarlo. Cambia únicamente el bloque antiguo del login en `index.html` y agrega una regla acotada a `.login-softventa-logo` en `styles.css`. No empaqueta ni reemplaza el `index.html` local, scripts del POS, landing, configuración Nginx, backend, API ni datos.

La imagen `/assets/pwa/softventaweb-logo.webp` debe existir en la imagen activa; el helper detiene el proceso si falta. La etiqueta y el CSS mantienen 220 × 56 px, centrado por el contenedor `.login-logo`, y ancho máximo responsive.

## Preparación y publicación

Extraiga el ZIP a una carpeta temporal de Windows y ejecute primero `-PrepareCandidateOnly`. El wrapper comprueba la sintaxis Bash del helper en Contabo antes de ejecutarlo. Esto construye una candidata desde el ID de imagen frontend activo, conserva una etiqueta base y valida el HTML para modo conectado/local, CSS, tipo WebP y la landing sin cambiar los contenedores activos.

Si la preparación termina con código 0, ejecute `-Deploy`. El script pide `sudo` interactivamente y luego solicita escribir `PUBLICAR`. Antes de recrear solo `frontend`, crea una etiqueta única `pos-frontend:rollback-pre-login-logo-...`. Si falla la publicación o las comprobaciones públicas, intenta restaurar la imagen previa. Backend y MySQL deben mantener sus IDs y estado healthy.

## Preparar la candidata

Este comando solo prepara y valida la imagen candidata; no publica cambios:

    $zip = 'C:\ruta\RESTORE_SOFTVENTAWEB_LOGIN_LOGO_20261105.zip'
    $dst = Join-Path $env:TEMP ('softventa-login-logo-' + [guid]::NewGuid().ToString('N'))
    Expand-Archive -LiteralPath $zip -DestinationPath $dst
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$dst\deploy\contabo\deploy-softventa-login-logo.ps1" -PrepareCandidateOnly
    if ($LASTEXITCODE -ne 0) { throw 'Falló la candidata; no se debe publicar.' }

## Publicar después de revisar la candidata

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$dst\deploy\contabo\deploy-softventa-login-logo.ps1" -Deploy

Para revertir después de una publicación exitosa, use la etiqueta exacta que informó `DEPLOY=PASS`:

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$dst\deploy\contabo\deploy-softventa-login-logo.ps1" -Rollback -RollbackTag 'pos-frontend:rollback-pre-login-logo-<fecha>-<id>'

El wrapper usa SSH con la clave y `known_hosts` ya configurados. No incluye contraseñas, variables de entorno ni archivos de producción.
