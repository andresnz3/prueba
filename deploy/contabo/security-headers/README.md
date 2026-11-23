# SoftVentaWeb: encabezados de seguridad en Caddy

Este paquete configura los encabezados en el borde público Caddy. No construye ni modifica imágenes, Nginx, frontend, backend, MySQL o volúmenes. No ejecuta migraciones.

## Alcance y política

El parcheador cambia únicamente los sitios públicos separados `softventaweb.com` y `www.softventaweb.com`. Mantiene la redirección de `www`, el proxy al frontend `127.0.0.1:8080`, `encode` y el listener de recuperación `127.0.0.1:8443`. Rechaza imports, rutas/hosts no aprobados, reglas de encabezados fuera de los sitios públicos y encabezados administrados que no coincidan con la política.

Cada sitio público recibe un solo valor de CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy` y `X-Frame-Options`. Caddy usa reemplazo diferido para normalizar valores que vengan del upstream. HSTS es `max-age=31536000` y no incluye subdominios ni preload. El listener privado queda fuera del parche y no recibe HSTS/CSP.

La CSP de mismo origen permite los scripts del sitio, atributos de evento existentes, estilos inline, imágenes `data:`/`blob:`, vista previa local de cámara, workers blob y recursos del mismo origen. No permite CDNs ni `unsafe-eval`.

## Modos

El script de PowerShell copia solo el helper Bash y el parcheador a un staging temporal privado, verifica SHA-256 y permisos, valida sintaxis y autopruebas local/remota y elimina ese staging al terminar. Las opciones son mutuamente excluyentes:

- `-SelfTest`: sintaxis, autopruebas del parcheador, scope Caddy-only, transporte y sintaxis del wrapper remoto. No usa sudo ni consulta los servicios/configuración activa; crea y limpia únicamente un staging temporal privado.
- `-DiagnoseOnly`: con sudo interactivo, inspecciona el Caddyfile activo y la configuración cargada, valida la topología y los endpoints, crea y verifica una copia temporal SHA-256, compara salud e imágenes de los tres servicios y sale sin recargar Caddy.
- `-Deploy`: vuelve a ejecutar las mismas precondiciones, genera respaldo root-only con manifiesto y SHA-256, valida la candidata con `caddy validate`, instala el Caddyfile atómicamente, recarga solamente Caddy y verifica los encabezados, HTTPS, API, redirecciones, CORS, recuperación privada y que los contenedores/volumen MySQL sigan iguales. Si una verificación posterior falla, restaura el Caddyfile respaldado (previa verificación de hash/permisos), valida y recarga Caddy.

El acceso sudo se solicita en la terminal SSH interactiva. La contraseña no pasa por argumentos, archivos ni logs. El helper no hace `docker compose`, build, restart, Nginx, ni operaciones de escritura sobre bases o volúmenes.

## Comandos PowerShell

Desde cualquier directorio de PowerShell, primero ejecutar el diagnóstico:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Proyectos\proyecto 1\deploy\contabo\security-headers\deploy-security-headers.ps1" -DiagnoseOnly
```

Después de revisar y aprobar expresamente el resultado del diagnóstico, el despliegue se inicia con:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Proyectos\proyecto 1\deploy\contabo\security-headers\deploy-security-headers.ps1" -Deploy
```

No ejecutar `-Deploy` sin autorización. El respaldo queda en `/root/pos-caddy-headers-rollback/<run-id>`; el helper informa la ruta y su integridad. El rollback automático solo restaura `/etc/caddy/Caddyfile` y recarga Caddy. No toca imágenes, contenedores ni datos.

## Validación local

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Proyectos\proyecto 1\deploy\contabo\security-headers\deploy-security-headers.ps1" -SelfTest
```

El diagnóstico y el despliegue son pasos distintos. Un `-DiagnoseOnly=PASS` no implica que se haya aplicado ningún cambio.
