# SoftVentaWeb: overlay seguro de cobro conectado

## Alcance

El paquete se aplica a la imagen frontend activa de Contabo y crea una candidata sin publicarla. El helper fija los IDs de frontend, backend y MySQL observados durante la preparación; el transformador además exige los SHA-256 exactos de los cuatro recursos publicados al preparar este paquete:

| Recurso activo | SHA-256 esperado |
| --- | --- |
| `app.js` | `5197bb68bd0fb47a255d1f777b7da29e81d6974dc3425f0073e13faf8614c91e` |
| `connected-sales.js` | `b2f2b76f22aee4c68a74406926fc17202c52d40e58f373f3dd19190b6efa6384` |
| `api-client.js` | `1d5771a412b16caf938c36eb27818a5568b7cec6f3522689c979737bf2de4535` |
| `service-worker.js` | `4b6e7b4d0398d39548928dc0c06ff0702969ab506f60d22a97187f6f1f9f8525` |

Si la imagen activa contiene cualquier otra revisión, si un anclaje aparece cero o varias veces, o si cambia cualquier archivo fuera del allowlist, la construcción se detiene antes de usar la candidata.

Cambios permitidos en los recursos web:

- `app.js`: agrega `clearSaleDetail(value)` al `PosRuntime` publicado. Conserva la limpieza condicionada al valor confirmado.
- `connected-sales.js`: evita depender de que ese método exista, separa la respuesta de API del renderizado, bloquea la orden al confirmar, limpia el detalle guardado, conserva la clave ante respuestas ambiguas y reconcilia `ORDER_NOT_PENDING` actualizando Caja e Historial.
- `api-client.js`: valida que cobro, venta completada y orden correspondan entre sí y al ID solicitado.
- `service-worker.js`: cambia únicamente `CACHE_NAME` a una revisión derivada del SHA-256 del payload. El worker actual usa precarga cache-first; sin una nueva revisión los clientes podrían seguir ejecutando los JavaScript anteriores. La estrategia, rutas precargadas y demás código del worker no cambian.

El transformador compara los SHA-256 de origen y resultado, muestra cada hunk agregado o reemplazado y verifica que el árbol web solo tenga esos cuatro archivos cambiados. También compara la firma de diagnósticos de historial antes y después. El marcador `SOFTVENTAWEB_HISTORY_DIAGNOSTICS_V1` y las líneas `[SoftVentaWeb diagnostic]` deben conservarse íntegros.

El TAR contiene exactamente `Dockerfile.frontend`, `MANIFEST.sha256` y `apply-connected-charge-fix.cjs`. El TAR es reproducible y su SHA-256 se transmite al helper. La imagen candidata se construye con red deshabilitada, usando la imagen frontend activa como base y la imagen backend activa solo para ejecutar Node; no se instala Node en el VPS.

## Autopruebas locales

`-SelfTest` comprueba hashes del paquete, sintaxis PowerShell, LF y `bash -n` del helper cuando Bash está disponible, sintaxis del transformador, anclajes únicos, rechazo de anclajes ausentes/duplicados, rechazo de otra imagen activa, preservación de diagnósticos y reproducibilidad byte-a-byte del TAR.

Pruebas de navegador conectadas ejecutadas localmente contra bases aleatorias `pos_auth_test_*` que el harness elimina al terminar:

- runtime sin `clearSaleDetail`, cobro confirmado y campo limpiado;
- respuesta ambigua y resolución con la clave original;
- `ORDER_NOT_PENDING` sin segunda venta;
- detalle en comprobante, impresión, PDF y búsqueda;
- historial en escritorio y móvil.

No se ejecuta ninguna operación comercial contra Contabo. `PrepareCandidateOnly` valida únicamente metadatos de producción, la candidata temporal, recursos GET, salud de API y rutas protegidas sin sesión.

## Verificar el ZIP y ejecutar SelfTest

Después de extraer el ZIP en una carpeta local, establecer `$zip` a su ruta y `$expected` al SHA-256 entregado junto al paquete:

```powershell
$zip = 'C:\Proyectos\proyecto 1\DEPLOY_SOFTVENTAWEB_CONNECTED_CHARGE_FIX_20261108.zip'
$expected = 'PEGAR_SHA256_DEL_ZIP'
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant() -ne $expected.ToLowerInvariant()) { throw 'SHA-256 del ZIP incorrecto.' }
$root = Join-Path $env:TEMP ('softventa-charge-fix-' + [guid]::NewGuid().ToString('N'))
Expand-Archive -LiteralPath $zip -DestinationPath $root
$launcher = Join-Path $root 'deploy-softventa-connected-charge-fix.ps1'
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
& $powershell -NoProfile -ExecutionPolicy Bypass -File $launcher -SelfTest
if ($LASTEXITCODE -ne 0) { throw 'Falló SelfTest. No continuar.' }
```

## Preparar candidata en Contabo, sin publicarla

Este comando transfiere el TAR allowlist y el helper con SHA-256 verificados. El helper requiere sudo interactivo, ejecuta `bash -n`, verifica Nginx/Compose e identidades de producción, construye la candidata, prueba HTTP desde un contenedor temporal y persiste el estado protegido de preparación. No recrea servicios activos, no modifica MySQL y no ejecuta migraciones.

```powershell
& $powershell -NoProfile -ExecutionPolicy Bypass -File $launcher -PrepareCandidateOnly
if ($LASTEXITCODE -ne 0) { throw 'Falló PrepareCandidateOnly. No publicar.' }
```

Revisar como mínimo `PREPARE_ONLY=PASS`, `FRONTEND_BASE`, `CANDIDATE_FRONTEND`, `BACKEND_UNCHANGED`, `MYSQL_IDENTITY` y los cuatro diffs con SHA-256 anterior/nuevo. Si la sesión SSH se corta, revisar primero el estado y staging informados por el helper; no repetir la preparación a ciegas.

## Publicación futura y rollback

No ejecutar publicación hasta recibir autorización explícita y comprobar que el estado de preparación sigue vinculado a la imagen frontend, backend y MySQL actuales. El launcher admite `-Deploy`, pero este paquete no lo ejecuta automáticamente.

Si una publicación autorizada fallara las comprobaciones posteriores, el helper restaura automáticamente el ID frontend capturado inmediatamente antes de cambiar la referencia Compose. Para un rollback manual, usar el `ROLLBACK_TOKEN` emitido por esa publicación, después de verificar el estado real de producción:

```powershell
& $powershell -NoProfile -ExecutionPolicy Bypass -File $launcher -Rollback -RollbackTag 'YYYYMMDDTHHMMSSZ-aaaaaaaaaaaa'
if ($LASTEXITCODE -ne 0) { throw 'Falló el rollback controlado.' }
```

El rollback valida que la candidata sea el frontend activo registrado y que backend y MySQL sigan en sus IDs originales; restaura solo el frontend desde el respaldo Docker exacto. No elimina respaldos anteriores.
