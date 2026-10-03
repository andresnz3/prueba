# Backend POS: autenticacion y multiusuario

Node.js >=22. Express 5, mysql2/promise, Helmet, CORS y Argon2 son las dependencias de ejecucion. Las pruebas usan node:test y fetch nativos. El frontend conserva el modo local y ofrece autenticacion conectada opcional; los datos operativos siguen en Dexie sin sincronizacion.

## Instalacion desde VS Code / PowerShell

Desde la raiz: cd backend, luego npm.cmd ci. Si todavia no existe .env, copiar .env.example a .env. No sobrescribir un .env existente. Completar DB_USER/DB_PASSWORD con credenciales MySQL locales y generar CSRF_SECRET de 32 bytes aleatorios (64 caracteres hexadecimales):

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Copiar el resultado exclusivamente a CSRF_SECRET en .env. .env no se versiona; .env.example no contiene secretos. La nueva clave es obligatoria para iniciar autenticacion. Rotarla invalida tokens CSRF; los clientes deben obtener otro mediante GET /api/auth/csrf.

Valores locales: DB_HOST=127.0.0.1, DB_PORT=3307, DB_NAME=pos_multitenant, HOST=127.0.0.1, PORT=3000. CORS_ORIGINS contiene origenes exactos HTTP(S), separados por comas, sin rutas ni barra final. Mantener el puerto del servidor fuera de los origenes permitidos salvo que se use realmente como cliente.

## Migracion y primer administrador (acciones explicitas)

Revisar database/migrations/001_authorization_grantor.sql. No se aplico sobre la base principal durante el desarrollo. Agrega solo granted_by_user_id y su indice/FK compuesta a session_authorizations; schema.sql permanece intacto. Antes de probar autorizaciones, ejecutar una sola vez con el usuario MySQL que tenga permisos ALTER:

```powershell
npm.cmd run migrate:auth -- --apply
npm.cmd run init-business
```

El segundo comando requiere una terminal interactiva y pide nombre del negocio, usuario, nombre completo y contrasena de al menos 12 caracteres con entrada oculta y confirmacion. No utiliza argumentos ni archivos para la contrasena. Requiere escribir CREAR. Registra negocio, administrador con Argon2id y auditoria en una transaccion. Solo funciona si no hay negocios; un bloqueo MySQL serializa ejecuciones concurrentes. No cambia registros existentes ni proporciona un endpoint de registro publico. Guardar el businessId mostrado para login. Los usuarios ADMIN adicionales se crean mediante la API autenticada. No se crean usuarios MySQL ni cuentas del frontend.

Para iniciar: npm.cmd run dev (recarga) o npm.cmd start. Ctrl+C realiza cierre ordenado. En produccion se podran inyectar variables y ejecutar node server.js, pero no se ha configurado Contabo.

## API y prueba local

Ver AUTH.md para el contrato completo, los permisos y un ejemplo PowerShell con cookies y CSRF. GET /api/health sigue respondiendo 200 con MySQL disponible y 503 si falla; ejecuta SELECT ? AS health sin leer ni modificar tablas. La autenticacion no modifica productos, ventas, compras ni inventario.

## Verificacion

```powershell
npm.cmd test
npm.cmd run test:integration
```

El primer comando no carga .env ni necesita MySQL; conserva intactas las 29 pruebas anteriores y agrega pruebas de seguridad. El segundo carga las credenciales MySQL locales SIN mostrarlas y requiere permiso CREATE/DROP para bases pos_auth_test_*. Genera un nombre aleatorio, crea las 20 tablas a partir de schema.sql omitiendo CREATE DATABASE/USE originales, aplica la migracion solo alli, ejecuta casos HTTP reales y elimina esa misma base al finalizar. Las pruebas se niegan a ejecutarse en el nombre de la base principal. No se escribe en pos_multitenant. Si el proceso es terminado de forma abrupta, puede quedar una base temporal cuyo nombre se imprime; no eliminar ninguna base sin verificar su nombre.

Resultados de esta etapa: 35 pruebas sin DB y 29 escenarios MySQL aprobados (node:test informa 30 al incluir el contenedor). Verificar frontend desde la raiz con su servidor en 127.0.0.1:5500 y npx.cmd playwright test --workers=2; sus archivos no cambian.

## Netlify y alcance

netlify.toml mantiene command=node scripts/build-static.cjs y publish=dist. Se copian solo index.html, app.js, styles.css, icons.js y 404.html. Backend, SQL, .env, pruebas y dependencias quedan fuera. No se publico ningun servicio. Para despliegues manuales generar dist y subir solamente esa carpeta. Nuevos assets publicos deben agregarse expresamente a la lista.

Esta etapa entrega autenticacion y permisos, no integracion del frontend. El backend no puede observar una navegacion que el cliente no comunica: la futura integracion debe invocar el endpoint de salida/entrada. El vencimiento de cinco minutos limita permisos abandonados por desconexion. El limitador de intentos vive en memoria de UN proceso y reinicia con el servicio; antes de usar varios procesos/instancias se necesita un almacen compartido. No se confia en X-Forwarded-For sin configurar un proxy conocido; actualmente se usa la IP del socket.

## Frontend fase 5.1

La integracion opcional de autenticacion esta descrita en ../FRONTEND_AUTH.md. Modo local conserva Dexie y login local; modo conectado usa cookies/CSRF y cuentas MySQL, con caches Dexie por negocio. No sincroniza operaciones. Desde la raiz: npm.cmd run test:frontend --prefix backend ejecuta Playwright contra una base temporal aislada.

## Fase 5.2: productos e inventario

Implementados en MySQL, con permisos inventory, CSRF, transacciones, movimientos y revisiones para ediciones concurrentes. Ver [INVENTORY.md](INVENTORY.md) para el contrato y [PHASE52.md](../PHASE52.md) para los archivos, pruebas y bloqueos temporales. No hay nuevas variables de entorno, dependencias ni migraciones SQL.

Fotografias conectadas: ver PRODUCT_IMAGES.md para carga binaria, almacenamiento privado, permisos, configuracion y pruebas. No requiere migracion SQL.
