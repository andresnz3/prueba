# Estado actual: fase 5.3

Ventas de contado, caja e historial conectados utilizan MySQL. Ver [PHASE53.md](PHASE53.md) y [contrato de ventas](backend/SALES.md). Las secciones de fases anteriores son historicas; sus bloqueos de ventas/caja quedan sustituidos por 5.3.

# Estado actualizado: fase 5.2

Productos, stock y Kardex conectados usan MySQL. Ventas, compras, caja y otras escrituras pendientes estan bloqueadas; no se usan los productos operativos de Dexie como respaldo ni se implementa sincronizacion. Ver [PHASE52.md](PHASE52.md) y [backend/INVENTORY.md](backend/INVENTORY.md) para el contrato, los limites y los resultados actuales. El contrato siguiente documenta la base de autenticacion de la fase 5.1; sus notas anteriores sobre persistencia operativa en Dexie en modo conectado quedan sustituidas por esta etapa.

# Fase 5.1: autenticacion conectada

## Cambios identificados antes de implementar

app.js autenticaba usando USERS, exponia currentUser con el usuario local, consultaba currentUser.role en el login y la navegacion, y usaba isAdmin() para acciones sensibles en configuracion, historial, inventario, clientes, proveedores, compras, caja y gastos. El formulario de gestor tomaba el primer usuario local administrador y unlockedModuleId permitia una vista; switchView revocaba ese acceso solo en memoria. La inicializacion cargaba POS_OfflineDB antes del login y posSystemConfig era compartido por todo el navegador.

Se mantuvo ese comportamiento en modalidad local. La conectada usa api-client.js para HTTP y connected-auth.js para identidad, navegacion, expiracion y usuarios. PosRuntime es un puente limitado al estado existente del POS; no concede permisos en el servidor. isAdmin(viewId) verifica el modulo de la accion cuando hay una concesion temporal conectada; no basta estar en cualquier modulo autorizado para modificar configuracion o caja.

## Dos modalidades

- Local: URL sin mode=connected. Mismos usuarios locales, Dexie POS_OfflineDB, configuracion posSystemConfig y flujos operativos existentes. No realiza llamadas de autenticacion ni usuarios a la API. Los 122 tests anteriores permanecen sin cambios.
- Conectada: URL con ?mode=connected o selector Modalidad en el login. Identidad y permisos provienen exclusivamente del backend. businessId se solicita antes del login; despues se fija al valor de la sesion. Al recargar se consulta /auth/me, sin almacenar una sesion en JS persistente. Cerrar sesion revoca la cookie en el servidor y recarga. Renovar sesion es explicito y regresa a Ventas porque el backend revoca concesiones.

La navegacion conectada verifica la identidad con /auth/me y el acceso con /auth/modules/:module/enter. Antes de salir de un permiso temporal solicita DELETE /auth/authorizations/:module. Solo se concede un modulo y la gestion de usuarios siempre usa los endpoints ADMIN. Cambiar el currentUser local, mostrar botones ocultos o manipular roles de la interfaz no cambia la identidad o autoridad de la API. Las contrasenas se limpian de los formularios; cookies HttpOnly son gestionadas por el navegador; CSRF vive solo en el cliente API en memoria.

## Aislamiento y decision sobre Dexie

Compartir POS_OfflineDB entre cuentas de empresas diferentes expondria datos locales aunque MySQL estuviera aislado. Se descarto esa alternativa. Se conserva el esquema Dexie v9 y los algoritmos de persistencia originales, seleccionando en modo conectado una base independiente POS_ConnectedDB_<API codificada>_<businessId de sesion>. La configuracion usa posConnectedConfig_<mismo alcance>. No se abre esa base antes de autenticar. No se copia ni migra contenido de POS_OfflineDB. Cada nueva empresa comienza con su cache local vacia. El API origen forma parte del nombre para separar tambien servidores de prueba y reales con IDs iguales.

El cambio de modalidad recarga la pagina. Cambiar de empresa tras autenticar tambien requiere recarga para no redirigir operaciones pendientes a otra base. No se permite seleccionar otro negocio en el panel autenticado. Las bases locales siguen siendo caches en un dispositivo; este cambio no cifra ni convierte IndexedDB en una frontera de seguridad frente a alguien con acceso al navegador/DevTools. La frontera real de las operaciones HTTP permanece en MySQL y la sesion del backend.

Ventas, compras, productos, inventario, caja, clientes y proveedores siguen guardandose en Dexie. No hay llamadas HTTP de esos modulos ni consumidor de sync_queue. La cola existente permanece local y separada por negocio para un futuro adaptador; no se envia nada a MySQL. Los datos del modo local no se fusionan con un negocio conectado.

## Probar en VS Code

1. En backend/.env conservar las credenciales ya configuradas y CSRF_SECRET; no copiar secretos a archivos publicos. La migracion y los usuarios de MySQL deben existir, como en la fase anterior.
2. Verificar CORS_ORIGINS=http://127.0.0.1:5500 (puede contener otros origenes exactos separados por comas). Reiniciar el backend si cambia .env.
3. Desde la raiz: npm.cmd run dev --prefix backend. El API queda en http://127.0.0.1:3000/api.
4. En otra terminal de la raiz: node scripts/build-static.cjs y luego npx.cmd http-server dist -a 127.0.0.1 -p 5500 -c-1. Si se cambia el frontend, regenerar dist. Esta carpeta contiene solo los archivos publicos.
5. Abrir http://127.0.0.1:5500/, seleccionar Modo conectado e ingresar identificador del negocio, usuario MySQL y contrasena. Tambien puede abrirse http://127.0.0.1:5500/?mode=connected.
6. ADMIN ve Usuarios: crear VENDEDOR por defecto, listar por paginas de 100, cambiar contrasenas, activar/desactivar y asignar ADMIN/VENDEDOR. Cambiar la propia contrasena/rol/estado revoca la sesion y obliga a autenticar otra vez. Los errores del ultimo administrador se muestran sin ignorar el rechazo del servidor.
7. VENDEDOR entra directamente a Ventas. Para otro modulo debe escribir usuario y contrasena de un administrador activo del mismo negocio. Al volver a Ventas/cambiar modulo se revoca la concesion anterior. No aparece Usuarios y una concesion no lo habilita.

api-config.js contiene solamente la URL PUBLICA del API. Si se usa localhost, cambiar tanto esa URL como la URL del navegador y CORS al mismo hostname; mezclar localhost y 127.0.0.1 puede impedir cookies SameSite. credentials=include necesita cookies/CORS configurados correctamente. Nunca agregar secretos a api-config.js. No se configuraron endpoints remotos ni Contabo.

## Pruebas

Desde la raiz:

```powershell
npm.cmd test --prefix backend
npm.cmd run test:integration --prefix backend
npm.cmd run test:frontend --prefix backend
node_modules/.bin/eslint.cmd app.js api-config.js api-client.js connected-auth.js
```

Para los tests locales (122 originales y dos regresiones de enfoque): iniciar el servidor del punto 4 y ejecutar npx.cmd playwright test --workers=1. tests-connected tiene una configuracion separada, por lo que no cambia la suite local.

El ejecutor conectado crea una base aleatoria pos_auth_test_*, importa las 20 tablas y la migracion existente, crea fixtures ADMIN/VENDEDOR en dos negocios y abre dos servidores en puertos temporales. El navegador recibe una configuracion API temporal desde ese servidor de pruebas. No llama al backend real ni modifica los usuarios registrados manualmente. La base temporal se elimina al terminar. Requiere permisos MySQL CREATE/DROP para ese prefijo. Las credenciales MySQL se quedan en el proceso de pruebas, nunca llegan a archivos publicos ni al navegador. Las capturas de formularios se guardan en test-results-connected, ignorado por Git.

## Limites de esta etapa

El modo conectado necesita conectividad para autenticar y verificar permisos; no utiliza credenciales locales como respaldo. Revalida cada 15 segundos y al recuperar foco. Una expiracion/revocacion obliga a login; una respuesta tardia no debe reabrir la interfaz. Los errores de navegacion ocultan los paneles; no se concede un permiso por un error de red. Si logout falla por red, se informa y la sesion no se considera cerrada hasta que el servidor lo confirme.

El cierre de una pestana solo puede intentar revocar de forma best effort: no se garantiza entrega. El vencimiento del backend sigue siendo la garantia para concesiones abandonadas. Dos pestanas comparten cookies: renovar/cerrar desde una puede invalidar la otra, que detecta el cambio y vuelve a autenticar/verificar CSRF. No hay sincronizacion, migracion de caches, restauracion de operaciones entre dispositivos ni acceso offline autenticado por el servidor.

Netlify sigue publicando solo dist. La lista publica agrega api-config.js, api-client.js y connected-auth.js; backend, pruebas, .env y SQL quedan excluidos. No se realizo ningun despliegue ni commit, ni se modifico el esquema SQL en esta fase.

Resultados de la revision final: 124 pruebas locales (122 originales sin cambios y dos regresiones de enfoque), 17 pruebas de navegador conectado, 36 pruebas de seguridad/salud sin MySQL y 29 escenarios de integracion MySQL aprobados (30 contando su contenedor). ESLint completo: 49 archivos, cero errores y cero advertencias. Bases temporales eliminadas; datos reales intactos.

Referencia del comportamiento de cookies/CORS: https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch#including_credentials

Estabilidad revisada: el enfoque diferido del escaner a los 100 ms podia interrumpir la escritura en la autorizacion o en otro campo de Ventas. El enfoque inicial del modal tambien podia sobrescribir un foco ya elegido. Dos pruebas con reloj controlado reprodujeron los fallos antes de corregirlos. Ahora se cancela el enfoque pendiente al cambiar de vista, se respetan los modales y campos activos, y no se enfoca el formulario de autorizacion cuando esta cerrado. Las dos regresiones y los dos casos anteriormente intermitentes pasaron tres repeticiones cada uno (12/12); la suite completa posterior paso 124/124. No se ampliaron tiempos de espera ni se modificaron expectativas de las pruebas originales.
