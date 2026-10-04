> Informe historico de fase 5.2. El alcance actual de ventas y caja esta en [PHASE53.md](PHASE53.md).

# Informe de la fase 5.2

Productos, existencias, ajustes, mermas y Kardex usan MySQL en modo conectado. Modo local conserva Dexie, sus usuarios, formulas y operaciones. La autenticacion y administracion de usuarios siguen siendo del backend en modo conectado.

## Fuentes de datos y bloqueos

Los productos conectados se consultan al iniciar/restaurar sesion, al entrar a Ventas o Inventario, al abrir una edicion/ajuste/Kardex y mediante Actualizar inventario. Solo se mantienen en memoria; no se guardan ni se recuperan de Dexie. El negocio de cada respuesta se compara con la identidad autenticada. Las respuestas de una sesion vencida se descartan. La recuperacion de CSRF comprueba que la identidad no haya cambiado en otra pestana.

La base Dexie conectada anterior sigue aislada por origen API y negocio, pero sus datos operativos anteriores no se cargan ni se importan a MySQL. No hay migracion de datos de POS_OfflineDB ni de caches anteriores.

Estan bloqueadas las escrituras conectadas de ventas (incluidas anulaciones), compras (incluidas anulaciones y productos rapidos desde Compras), caja (apertura, movimientos, correcciones, confirmaciones y cierre), cobros, pagos, gastos y formularios locales de clientes/proveedores. Los handlers de documentos y stock incluyen guardas; los eventos de formularios y botones pendientes se interceptan antes de los handlers Dexie. Eliminar producto se sustituye por Inactivar en conectado, conservando el historial. Los endpoints correspondientes a esos otros modulos siguen sin implementarse.

El catalogo de Ventas permite consultar productos y preparar un carrito, pero cobrar permanece bloqueado. Los reportes, dashboard e historiales financieros anteriores no estan integrados y no constituyen informes MySQL; esta etapa solo integra productos e inventario. Configuracion conserva su almacenamiento local separado por negocio. No hay sincronizacion offline ni escrituras SQL de ventas, compras o caja.

## Endpoints y limites

Contrato completo en backend/INVENTORY.md: GET /api/catalog/products, GET/POST /api/products, GET/PATCH /api/products/:id, GET /api/products/:id/stock, POST /api/products/:id/movements y GET /api/inventory/movements.

No se modifico database/schema.sql y no se requiere una migracion nueva. El proveedor opcional esta pendiente porque products no tiene esa relacion. Fotografias con archivos privados independientes y referencias en TEXT; contrato y requisitos de infraestructura en backend/PRODUCT_IMAGES.md.

## Archivos

Creados:

- backend/src/routes/inventory.js
- backend/src/services/inventory.js
- backend/src/services/inventory-values.js
- backend/tests/inventory-values.test.cjs
- backend/tests/integration/inventory.test.cjs
- connected-inventory.js
- tests-connected/inventory.spec.cjs
- backend/INVENTORY.md
- PHASE52.md

Modificados:

- api-client.js, app.js, connected-auth.js, index.html
- backend/src/app.js, backend/src/middleware/errors.js
- backend/scripts/test-integration.cjs, backend/scripts/test-connected.cjs
- eslint.config.mjs, scripts/build-static.cjs
- backend/AUTH.md, backend/README.md, FRONTEND_AUTH.md, database/README.md

No se modifican server.js, las pruebas locales existentes, las pruebas de autenticacion existentes, las credenciales ni el esquema. No se agregan dependencias, despliegues ni commits.

## Como probar localmente

Desde PowerShell en la raiz del proyecto, tras disponer del backend/.env privado de la etapa anterior:

~~~powershell
npm.cmd run dev --prefix backend
~~~

En otra terminal, generar un directorio exclusivamente publico y servirlo en localhost:

~~~powershell
node scripts/build-static.cjs
.\node_modules\.bin\http-server.cmd dist -a 127.0.0.1 -p 5500 -c-1
~~~

Abrir http://127.0.0.1:5500/?mode=connected, utilizar el businessId y las cuentas reales previamente creadas, entrar a Productos y crear/editar productos o consultar Kardex. La API publica se configura en api-config.js; su origen debe estar permitido por CORS_ORIGINS del backend. Para modo local abrir la URL sin mode=connected. No hay copias automaticas entre modalidades.

Las pruebas usan usuarios sinteticos y bases MySQL aleatorias pos_auth_test_*, protegidas contra seleccionar la base principal y eliminadas en finally. Integracion se ejecuta con un solo archivo a la vez para respetar el fixture de bootstrap existente.

~~~powershell
.\node_modules\.bin\eslint.cmd .
npm.cmd test --prefix backend
npm.cmd run test:integration --prefix backend
.\node_modules\.bin\playwright.cmd test --workers=1 --reporter=line
npm.cmd run test:frontend --prefix backend
~~~

## Validacion final

Validacion final completada; cero fallos, cancelados u omitidos.

| Comprobacion | Resultado |
| --- | --- |
| ESLint completo | 64 archivos, 0 errores, 0 advertencias |
| Backend unitario | 47/47 aprobadas (41 anteriores y 6 de fotografias) |
| MySQL temporal | 60/60 resultados aprobados: 29 escenarios auth + 20 inventario + 8 fotografias + 3 contenedores |
| Frontend local | 124/124 aprobadas (122 originales y 2 regresiones existentes), 4.0 minutos |
| Frontend conectado | 37/37 aprobadas (17 de autenticacion + 15 de inventario + 5 de fotografias), 1.0 minuto |
| Build publico | 9 archivos permitidos, sin backend, SQL, pruebas ni .env |
| git diff --check | Sin errores de espacios; avisos habituales LF/CRLF en Windows |

Las bases temporales de ambas ejecuciones MySQL se eliminaron al finalizar. No se modificaron pruebas existentes ni datos reales. Los limites funcionales pendientes estan documentados arriba y en backend/INVENTORY.md.

## Correccion posterior: proveedor opcional

connected-inventory.js excluye expresamente el proveedor de validacion (required=false, mensaje personalizado vacio, valor vacio y control deshabilitado) y oculta su grupo con la clase hidden del proyecto, solo en modo conectado. Las escrituras siguen omitiendo ese campo. No se cambia HTML compartido, validaciones locales, esquema ni endpoints. Se regenera dist. La nueva prueba en tests-connected/inventory.spec.cjs crea y edita un producto sin proveedor, comprueba los cuerpos POST/PATCH y verifica persistencia tras recargar. La tabla de validacion refleja la ejecucion posterior a esta correccion; se mantienen intactas las pruebas anteriores.

## Correccion posterior: fotografias conectadas

Se sustituye Base64 en el JSON por carga binaria autenticada y almacenamiento privado fuera del repositorio. products.image conserva una referencia corta; no requiere SQL nuevo. El JSON general conserva 16 KiB por defecto. El modo local sigue con Base64 y Dexie. Contrato, archivos creados/modificados, limites y operacion en backend/PRODUCT_IMAGES.md. La tabla anterior muestra los resultados actuales. La limpieza de fotografias sin referencia y el aprovisionamiento/respaldo del volumen de Contabo quedan pendientes; no se desplego nada.
