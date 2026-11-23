# Corrección aislada de presentación SoftVentaWeb

Este paquete prepara una imagen candidata usando como base el ID del frontend activo de Contabo. No copia ni reemplaza el archivo index.html, CSS, JavaScript o los recursos completos del POS local. El overlay solo ajusta el título del login, retira el texto visible "POS Distribuidora" del login si existe, conserva el logo oficial y agrega un script local a /inicio/ para quitar parámetros utm_*.

La limpieza UTM conserva los demás parámetros, la ruta y el fragmento. Usa history.replaceState sin recargar la página. El overlay también renueva el precache del service worker para entregar la versión actualizada a usuarios que ya tenían la landing almacenada. La precondición del logo admite el selector genérico del POS o la regla exacta que instala el overlay publicado del logo, y registra cada comprobación por separado. No modifica enlaces externos ni configuraciones de ChatGPT.

El helper anterior exigía el selector `.login-logo img`, que no coincide con la regla `.login-softventa-logo` añadida por el overlay del logo. La versión corregida admite ese selector genérico o la regla CSS publicada exacta. Si una precondición falla, informa cada resultado como `BASE_CHECK=<nombre>|PASS/FAIL`, incluidos el HTML de la landing, el archivo WebP y ambas variantes conocidas del logo.

El marcado oficial del logo publicado es suficiente; el placeholder POS antiguo se conserva solo como alternativa para una base anterior y nunca es obligatorio. El helper imprime el hash efectivo del logo base como `BASE_LOGO_SHA256` y verifica que el hash del recurso no cambie en la candidata. No instala ni reemplaza el logo. El SHA-256 local verificado del archivo oficial es `b33d184e18283b064e60edb3da0bf60513e7d22b309ea8e81360f0b9c29c8f11`; un diagnóstico previo usó por error 65 caracteres en la expectativa.

## Verificar y preparar la candidata

Verifique primero el SHA-256 del ZIP que acompaña esta entrega. Extraiga el paquete y ejecute la autoprueba local y la preparación candidata:

    $zip = 'C:\ruta\RESTORE_SOFTVENTAWEB_PRESENTATION_20261105.zip'
    $expectedSha256 = '<SHA-256 entregado junto al paquete>'
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash -ne $expectedSha256) {
        throw 'El paquete no coincide con la entrega.'
    }
    $dst = Join-Path $env:TEMP ('softventa-presentation-' + [guid]::NewGuid().ToString('N'))
    Expand-Archive -LiteralPath $zip -DestinationPath $dst
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$dst\deploy\contabo\deploy-softventa-presentation.ps1" -SelfTest
    if ($LASTEXITCODE -ne 0) { throw 'Falló la autoprueba local.' }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$dst\deploy\contabo\deploy-softventa-presentation.ps1" -PrepareCandidateOnly
    if ($LASTEXITCODE -ne 0) { throw 'Falló la validación candidata. No continuar.' }

PrepareCandidateOnly construye y sirve la candidata temporalmente en loopback, valida los recursos y elimina el contenedor de prueba. No cambia los contenedores activos. La publicación requiere ejecutar Deploy por separado y confirmar PUBLICAR en Contabo.

## Publicación y rollback

Después de revisar la candidata y autorizar la publicación, ejecute:

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$dst\deploy\contabo\deploy-softventa-presentation.ps1" -Deploy

El helper crea una etiqueta pos-frontend:rollback-pre-presentation-... con el ID del frontend previo antes de recrear únicamente frontend. Si falla la publicación o el postcheck, intenta restaurar el frontend anterior y comprueba que backend y MySQL mantengan sus identidades y estado.

Para una reversión posterior, use la etiqueta exacta que informe DEPLOY=PASS:

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$dst\deploy\contabo\deploy-softventa-presentation.ps1" -Rollback -RollbackTag 'pos-frontend:rollback-pre-presentation-<fecha>-<id>'

## Allowlist

El archivo transferible para la construcción remota incluye únicamente Dockerfile, apply-presentation.sh y utm-cleanup.js. El ZIP agrega el lanzador PowerShell, este README, el helper remoto y CHECKSUMS.sha256. No contiene index.html completo, CSS, módulos del POS, landing completa, backend, SQL, configuración, usuarios ni datos comerciales.
