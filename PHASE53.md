# Fase 5.3: analisis y alcance

## Analisis previo a modificaciones funcionales

Revisados app.js, connected-auth.js, connected-inventory.js, api-client.js, esquema, migracion 001, repositorio de autenticacion, servicios y rutas del backend, ejecutores y suites existentes, y los ocho documentos de las fases anteriores.

El carrito local usa precios retail/wholesale, cantidades y descuento porcentual global. No agrega impuesto al total. La caja local calcula efectivo inicial + ventas de efectivo + entradas - salidas; las ventas quedan pendientes de confirmacion. Copiar esta formula a movimientos SQL de venta produciria ingresos duplicados. La fase conectada registrara exclusivamente movimientos confirmados, sumados una sola vez.

El esquema ya incluye sales, sale_items, cash_sessions, cash_movements, inventory_movements, document_sequences y audit_logs, con claves por negocio. Faltan claves de idempotencia y persistencia de efectivo recibido/cambio. Se añadiran en migracion 002 sin alterar schema.sql. La migracion principal no se ejecuta durante esta tarea.

Clientes, cuentas por cobrar, abonos, compras, gastos y movimientos manuales carecen de contratos completos: permanecen bloqueados. Contado no usa clientes Dexie. Apertura/cierre de caja requieren permiso cash; ventas requieren sales; historial/anulaciones requieren history. Una caja compartida por negocio evita elegir cajas desde el navegador. Todas las modalidades de contado requieren caja abierta para identificar el turno; tarjeta/transferencia no generan efectivo. Anular una venta en efectivo requiere su caja original abierta y fondos suficientes. Devoluciones posteriores al cierre requieren otra fase.

Los precios y los importes se obtienen/calculan en backend con enteros escalados. Para conservar la regla actual no se añade impuesto: se conserva tax_rate de producto en el detalle como informacion y tax=0; no se aplica configuracion fiscal local a SQL. El porcentaje de descuento global se valida 0..100 y se distribuye en lineas con redondeo determinista. Las facturas son consecutivas independientes por negocio.

La idempotencia debe persistir una clave aleatoria, huella del cuerpo y resultado dentro de la misma transaccion financiera. Consultar una clave despues de perder una respuesta no crea una factura. Reutilizarla con otro cuerpo se rechaza. El navegador conserva solo la referencia pendiente por negocio/origen/usuario, nunca cola de ventas ni credenciales.

## Skills e instrucciones

Leida emil-design-eng, aplicada a validacion accesible, foco, preservacion de campos y componentes del flujo conectado. AGENTS.md preserva esta preferencia para futuras tareas en el proyecto. No se invocan skills de sitios: este es un proyecto web existente.

## Validacion y entrega

Implementacion y validacion completadas; resultados exactos al final de este informe.

## Implementacion entregada

Ventas MySQL de contado con cotizacion previa, menudeo/mayoreo, cantidades fraccionarias, descuento global calculado en servidor, consecutivos por negocio, usuario, stock y Kardex, caja y anulaciones. La escritura financiera se confirma junto con su resultado idempotente. Credito y abonos quedan bloqueados; no se avanza a compras. Moneda conectada C$, sin conversiones; la configuracion monetaria por negocio sigue pendiente. Se conserva la formula actual sin impuesto adicional.

Se incorporan apertura/cierre de caja con arqueo. Solo efectivo genera ingresos de caja por el neto cobrado; tarjeta/transferencia no suman efectivo y requieren operacion bancaria externa. Anular efectivo requiere caja original abierta y suficiente saldo. Las devoluciones despues del cierre quedan bloqueadas.

Se incorpora Comprobar operacion: recupera una factura confirmada o descarta atomicamente una clave ausente, evitando que una solicitud tardia se cobre despues. El navegador guarda solo la clave/clase de operacion, con alcance de API/negocio/usuario. No guarda una cola de ventas ni credenciales. Una operacion pendiente bloquea nuevos cobros hasta su comprobacion.

## Archivos creados

- AGENTS.md: instrucciones persistentes y preferencia de skills.
- PHASE53.md: analisis previo, decisiones, archivos y entrega.
- backend/SALES.md: contrato de endpoints, importes, caja, idempotencia y prueba manual.
- database/migrations/002_sales_operations.sql: pos_operations y campos de efectivo/cambio.
- backend/scripts/migrate-sales.cjs: aplicacion explicita y deteccion de migracion existente/parcial.
- backend/src/services/sales-values.js: validacion y aritmetica exacta.
- backend/src/services/sales.js: transacciones, facturas, caja, stock, auditoria e idempotencia.
- backend/src/routes/sales.js: rutas protegidas de ventas/caja/operaciones.
- backend/tests/sales-values.test.cjs: nueve pruebas unitarias nuevas.
- backend/tests/integration/sales.test.cjs: 27 escenarios financieros nuevos.
- connected-sales.js: cobro, recuperacion, historial y caja conectados.
- validation.js: errores accesibles por campo, foco y conservacion de valores.
- tests-connected/sales.spec.cjs: catorce pruebas de navegador nuevas, incluido movil.

## Archivos modificados

- app.js: puente de ventas/caja, handlers conectados, cantidades y moneda; ramas locales conservadas.
- connected-auth.js: carga por modulo, mensajes y bloqueo de informes incompletos.
- connected-inventory.js: validacion de productos/ajustes y bloqueos de modulos restantes.
- api-client.js: ventas/caja/operaciones, validacion de respuestas, mensajes y Retry-After.
- index.html, styles.css: confirmacion conectada, recuperacion e indicacion accesible de errores, con iconos del sistema Lucide.
- backend/src/app.js: montaje de las nuevas rutas.
- backend/src/middleware/errors.js: campo publico de validacion, sin detalles internos.
- backend/src/middleware/auth-rate-limit.js: segundos restantes de bloqueo.
- backend/src/services/inventory-values.js: identificacion del campo invalidado.
- backend/package.json: script migrate:sales; ninguna dependencia nueva.
- backend/scripts/test-integration.cjs: migracion 002 y suite de ventas en bases temporales.
- backend/scripts/test-connected.cjs, scripts/build-static.cjs: lista publica ampliada con los dos nuevos scripts.
- tests-connected/inventory.spec.cjs: actualizacion justificada del caso de bloqueos de fase 5.2, conservando todas sus comprobaciones de aislamiento Dexie.
- FRONTEND_AUTH.md, PHASE52.md, backend/README.md, backend/AUTH.md, database/README.md, database/migrations/README.md: referencias al alcance actual, preservando informes historicos.
- dist: regenerado; solo 11 archivos publicos permitidos.

## Endpoints y migracion

Once rutas nuevas (prefijo /api): POST /sales/quote, POST /sales, GET /sales, GET /sales/:id, POST /sales/:id/cancel, GET /operations/:key, POST /operations/:key/resolve, GET /cash/current, GET /cash/sessions, POST /cash/sessions y POST /cash/sessions/:id/close. El contrato completo y los permisos estan en backend/SALES.md.

Migracion 002 independiente. No se modificaron schema.sql ni 001. No se aplico ninguna migracion sobre la base principal; hace falta aprobacion explicita antes de hacerlo. El script rechaza una migracion ya existente/parcial y las pruebas utilizan exclusivamente bases MySQL aleatorias verificadas y eliminadas al finalizar.

## Skills y revision de interfaz

Encontrada y leida la unica skill del proyecto: .agents/skills/emil-design-eng/SKILL.md. Aplicada a foco, errores junto a los campos, preservacion de entradas, accesibilidad, controles de confirmacion y comprobacion movil. No se agregaron animaciones a acciones repetidas. Revisado el catalogo de skills de la sesion; los workflows de Sites no corresponden a este proyecto existente. La preferencia se conserva en AGENTS.md para futuras sesiones del proyecto; no implica memoria global entre proyectos.

| Before | After | Why |
| --- | --- | --- |
| Errores genericos o validacion nativa sin contexto | Mensajes junto a los campos, aria-invalid, aria-describedby y primer foco | Identificar la correccion sin perder lo escrito |
| Cobrar conectado bloqueado en fase 5.2 | Confirmacion de importes verificados y efectivo recibido | Completar contado con autoridad del servidor |
| Respuesta perdida sin resultado consultable | Referencia persistente y Comprobar operacion | Evitar cobrar dos veces |
| Modal de cobro tapaba recuperacion tras fallo de red | Cerrar modal conservando sus campos y referencia | Acceso real al boton de comprobacion sin clicks forzados |
| Moneda local podia rotular distinto el mismo importe conectado | C$ coherente en conectado; moneda por negocio pendiente | No interpretar simbolos como conversiones |

## Pruebas anteriores y fallos corregidos

No se alteraron las 124 pruebas locales ni las suites backend/auth/fotografias existentes. Un caso conectado de 5.2 esperaba ventas y apertura de caja bloqueadas. Se actualizo por el cambio funcional solicitado: ahora comprueba caja cerrada antes del cobro, apertura SQL y ausencia de todos los registros operativos en Dexie. Las restricciones de compras y aislamiento permanecen comprobadas. El resto de las pruebas anteriores permanece intacto.

La prueba nueva de solicitud no enviada detecto que el modal tapaba el boton de recuperacion: se corrigio el producto, sin aumentar tiempos ni forzar clicks. Una edicion final de moneda introdujo temporalmente un error sintactico por sustitucion de cadenas; ESLint lo detecto, se reparo, se regenero dist y se repitieron las suites sobre el build corregido. La ejecucion interrumpida limpio su base temporal.

## Prueba de una venta y limites

Instrucciones detalladas en backend/SALES.md: aprobar/aplicar 002, reiniciar backend, generar/servir solo dist, abrir modo conectado, abrir caja con ADMIN, comprobar producto activo, agregarlo, elegir tarifa/descuento/pago y confirmar. Consultar Historial/Kardex tras recargar. Si la respuesta se pierde, usar Comprobar operacion antes de repetir el cobro.

Permanecen bloqueados credito, abonos, clientes/proveedores conectados, compras, gastos, entradas/retiros/correcciones/confirmaciones manuales de caja, reportes/dashboard completos, devoluciones de efectivo tras cierre y sincronizacion offline. No hay pasarela bancaria ni facturacion fiscal. Impuestos nuevos y multimoneda necesitan contratos propios. La numeracion actual es interna.

Limites operativos: bloqueo por negocio serializa operaciones; los movimientos de una caja se devuelven completos; las claves idempotentes se conservan y necesitan politica de retencion compatible con no duplicar operaciones. Fotografias sin referencia mantienen los limites y mantenimiento pendientes de la fase anterior. No se modificaron cuentas/credenciales existentes, ni se realizaron commits, despliegues o cambios en Contabo/Netlify.


## Validacion final (2 de octubre de 2026)

| Comprobacion | Resultado exacto |
| --- | --- |
| ESLint completo | 75 archivos, 0 errores, 0 advertencias |
| Backend unitario | 56/56 aprobadas: 47 existentes + 9 nuevas |
| Integracion MySQL temporal | 88/88 resultados aprobados: 29 auth + 20 inventario + 8 fotografias + 27 ventas/caja + 4 contenedores; 13.6 segundos |
| Frontend local | 124/124 aprobadas, todas las pruebas originales intactas; ultima ejecucion 8.0 minutos |
| Frontend conectado | 51/51 aprobadas: 37 anteriores (un caso actualizado por alcance) + 14 nuevas; 2.9 minutos |
| Impresion/reimpresion local despues de corregir centavos | 1/1 aprobada, 7.2 segundos |
| Build publico | 11 archivos permitidos, identicos a sus fuentes; sin backend, SQL, pruebas, documentacion privada ni secretos |
| Capturas de cobro/validacion movil | Revisadas visualmente; controles visibles, foco y errores accesibles |
| git diff --check | Sin errores de espacios; solo avisos LF/CRLF habituales de Windows |
| database/schema.sql | Sin diferencias |

Cero fallos, cancelados u omitidos en las ejecuciones finales. Las bases temporales de la tarea se eliminaron, incluida la ejecucion interrumpida. Datos reales y cuentas existentes intactos. No se realizo una venta real ni se aplico 002 en la base principal. El servidor de pruebas local se detiene tras la verificacion.

La correccion final de centavos se comprobo con 10.01 x 0.5: JavaScript al imprimir podia producir 5.00 mientras el servidor confirma 5.01. El ticket conectado ahora imprime el subtotal de linea persistido, y la regresion comprueba tanto la linea como el total. La rama local sigue calculando como antes y su impresion/reimpresion paso la prueba adicional.

Comandos utilizados:

~~~powershell
.\node_modules\.bin\eslint.cmd .
npm.cmd test --prefix backend
npm.cmd run test:integration --prefix backend
.\node_modules\.bin\playwright.cmd test --workers=1 --reporter=line
npm.cmd run test:frontend --prefix backend
node scripts/build-static.cjs
git diff --check
~~~


## Continuacion minima segura: 3 de octubre de 2026

### Causa comprobada de Cobrar ausente

El boton processSaleBtn ya existia en index.html y tenia el handler conectado en app.js. No faltaba el evento ni dependia de una venta guardada. El aviso connectedNotice se inserta antes de salesView; main-container media 100vh y recortaba overflow:hidden, mientras salesView, workspace-layout y cart-panel conservaban otros 100vh. En 1280x720, el aviso y su margen desplazaban el carrito 77.59375 px: el boton comenzaba en y=741.59375 y terminaba en y=781.59375, fuera de la pantalla. La prueba anterior hacia hover/desplazamiento antes de comprobar el boton y podia ocultar este problema.

Se cambio main-container a columna flex y la vista a flex:1/min-height:0; el espacio de los avisos se descuenta automaticamente. Workspace y carrito usan la altura disponible. Cobrar tiene un contenedor cart-checkout al pie, sticky, separado de los controles desplazables. En movil se conserva el flujo de pagina y el acceso al carrito; se comprobaron controles sin superposicion en las capturas.

### Regla de caja y alcance

Mensaje unificado: "Debes abrir caja antes de facturar o cobrar".

El modo local exige cajaActual.estado abierta antes de iniciar cualquier venta, antes de confirmar efectivo y dentro de registrarVenta. Los dos flujos de cobro a clientes (general y por factura) exigen caja abierta para efectivo, tarjeta y transferencia. Se mantienen sus reglas de saldo y solo efectivo genera movimientos de efectivo. Las pruebas comprueban que un rechazo no cambia las tablas Dexie, stock ni consecutivo. Se conserva el credito local existente; el credito conectado sigue bloqueado.

En conectado se conserva sin cambios el servicio transaccional de ventas: revalida caja dentro de la transaccion. Tres regresiones cierran caja despues de cotizar y antes de confirmar CASH/CARD/TRANSFER; las tres rechazan sin cambiar venta, producto ni caja y sin escribir ventas/cola en Dexie. Se conserva idempotencia, historial y recuperacion de resultados inciertos.

Siguen fuera de esta entrega y no se habilitan en conectado: caja separada, credito, abonos, compras, gastos, sincronizacion offline, planes comerciales, rubros especiales, importacion local a conectado. Planes, plantillas, categorias avanzadas, unidades por rubro y panel del dueno quedan para fases posteriores. Los modulos operativos incompletos mantienen los bloqueos existentes. No se agregaron tablas, migraciones, dependencias ni rutas comerciales.

### Archivos de esta continuacion

- app.js: validacion local de caja para ventas y cobros de clientes, mensaje comun.
- api-client.js: mensaje CASH_CLOSED solicitado.
- index.html: contenedor propio de Cobrar y type=button.
- styles.css: altura disponible, desplazamiento y franja de cobro.
- backend/scripts/test-connected.cjs: servir los archivos publicados desde dist; api-config de pruebas sigue generado con la URL temporal.
- tests/cash-open-rule.spec.cjs (nuevo): siete casos locales para medios de pago, escritor final, cierre previo a confirmacion y los dos flujos de cobro.
- tests/cash-fixture.cjs (nuevo): apertura de caja de prueba desde la interfaz.
- tests/pos-connected-layout.spec.cjs: verificar posicion antes de hover/click/scroll; mensaje actualizado.
- tests-connected/sales.spec.cjs: mensaje actualizado y tres regresiones de cierre entre cotizacion y confirmacion.
- tests-connected/inventory.spec.cjs: texto exacto de caja cerrada, conservando bloqueo de compras y aislamiento Dexie.
- tests/configuration.spec.cjs, tests/dashboard.spec.cjs, tests/history.spec.cjs, tests/login.spec.cjs, tests/reports.spec.cjs: abrir caja en los casos de venta que previamente no la requerian y adaptar mensajes.
- PHASE53.md: este informe. dist regenerado con los once archivos publicos permitidos.

Se conservaron los cambios previos del workspace. La lista anterior identifica esta continuacion; git status incluye trabajo anterior no confirmado.

### Skill y revision de interfaz

Skill aplicada: .agents/skills/emil-design-eng/SKILL.md, ya leida en esta conversacion. Se preservan foco, controles accesibles y respuesta inmediata, sin nuevas animaciones.

| Before | After | Why |
| --- | --- | --- |
| Cobrar debajo del viewport conectado por alturas 100vh acumuladas | La vista usa el alto restante y el boton tiene una franja al pie | Poder cobrar sin que el aviso recorte la accion |
| La prueba desplazaba antes de inspeccionar | Comprobacion inicial de geometria e impacto visual sin hover ni scroll en escritorio | Detectar el fallo real que ve el usuario |
| Caja obligatoria solo para efectivo local | Caja abierta para cualquier venta y cobro de clientes | No emitir documentos ni alterar saldos con caja cerrada |

### Cambios justificados en pruebas anteriores

Se conserva cada prueba y sus aserciones financieras. Diez casos ahora abren caja como preparacion: uno de configuracion, uno de dashboard, tres de historial, tres de clientes y dos de reportes. Su supuesto anterior (tarjeta/transferencia/credito sin caja) queda expresamente sustituido por la regla solicitada. Dos aserciones locales y las conectadas usan el mensaje nuevo. Los pagos a proveedores y gastos locales conservan su comportamiento existente; esta continuacion modifica facturacion y cobros a clientes, no integra compras/gastos conectados.

La primera ejecucion completa local se detuvo tras identificar cinco fallos esperados por esa preparacion antigua. Despues de adaptarla, la ejecucion completa final paso sin fallos. No se eliminaron casos ni se ampliaron tiempos ni se forzaron clicks para ocultar errores.

### Verificacion de esta continuacion

| Comprobacion | Resultado |
| --- | --- |
| ESLint completo | Aprobado, 0 errores y 0 advertencias |
| Backend unitario | 56/56, 0 fallos/omitidos/cancelados |
| Integracion MySQL aislada | 88/88 resultados (incluye 4 contenedores), 14.4 segundos; base temporal eliminada |
| Regresiones especificas de caja y layout | 30/30, 1.1 minutos |
| Suite frontend completa | 154/154, 5.3 minutos, dos workers; incluye 139 casos locales y 15 fixtures HTTP conectados |
| Navegador conectado con MySQL temporal | 62/62, 3.0 minutos; base temporal eliminada |
| Build publico | Regenerado y verificado: 11 archivos permitidos identicos a las fuentes, sin carpetas ni archivos privados |
| Capturas | Antes/despues en escritorio y movil inspeccionados visualmente |
| git diff --check | Sin errores; avisos LF/CRLF de Windows |
| database/schema.sql | Sin diferencias |

Comandos finales: eslint .; npm test --prefix backend; npm run test:integration --prefix backend; playwright test --workers=2 --reporter=line --output=test-results-phase53-final; npm run test:frontend --prefix backend; node scripts/build-static.cjs; git diff --check. Todos se ejecutaron con las herramientas locales instaladas; las pruebas sirven solamente dist.

### Prueba real disponible, aun no realizada

Una consulta de solo lectura a information_schema encontro granted_by_user_id (001), cash_received/change_amount y las columnas consultadas de pos_operations (002) en la base principal configurada. Es un estado encontrado, no una migracion aplicada en esta tarea. La API existente se inicio y GET /api/health respondio HTTP 200, server up, database up y CORS para http://127.0.0.1:5500.

Quedaron activos el servidor de dist en 127.0.0.1:5500 y la API en puerto 3000 para la prueba manual. Abrir http://127.0.0.1:5500/?mode=connected, recargar para tomar el build nuevo, entrar con la cuenta existente, abrir Caja y vender un producto activo con stock. Confirmar Historial, Kardex y saldo de Caja. Si el resultado es incierto, usar Comprobar operacion antes de repetir. Las pruebas automatizadas no sustituyen esta validacion con el negocio real.

No se realizo una venta real, no se cambiaron cuentas existentes, no se aplicaron migraciones a la base principal, no se modifico schema.sql, no se hicieron commits ni despliegues. No se avanzo a compras conectadas.


## Continuación 5.3: confirmación de pagos no efectivos

La venta conectada conserva el flujo de Venta local: el botón **Procesar / Cobrar Venta** aparece bajo el método de pago cuando hay productos; efectivo abre su captura de monto y tarjeta/transferencia procesan la venta tras la cotización, sin un diálogo visual adicional. El servidor vuelve a exigir caja abierta dentro de la transacción para todos los medios.

Efectivo genera factura, descuenta stock y crea movimiento de caja **Confirmado**, que suma al efectivo esperado. Tarjeta y transferencia generan factura, descuentan stock y crean cada una un movimiento asociado al turno en estado **Pendiente**. Ese importe no suma al efectivo esperado. Caja e Historial muestran el medio y **Pendiente de confirmación**. La interfaz conectada todavía no ofrece confirmar estos movimientos: no se confirman automáticamente. Al anular una venta no monetaria, el movimiento pendiente queda **Anulado (VOID)** y el stock se repone.

No se requiere migración: el esquema ya admite los estados PENDING, CONFIRMED y VOID en movimientos y PENDING en el estado de caja de la venta. No se aplicó migración ni se tocó database/schema.sql.

Siguen bloqueados: caja separada, crédito, abonos, compras conectadas, gastos conectados, sincronización offline, planes comerciales, rubros especiales y migración local a conectado. Planes, plantillas, categorías avanzadas, unidades por rubro y panel del dueño quedan para fases posteriores.

| Before | After | Why |
| --- | --- | --- |
| Tarjeta y transferencia no tenían movimiento identificable en Caja. | Cada medio genera un movimiento PENDING, visible por medio en Caja e Historial. | Dejar rastro contable sin inflar efectivo ni afirmar una confirmación inexistente. |
| El botón de conectado abría una confirmación distinta para los medios no monetarios. | Tarjeta y transferencia siguen el flujo directo de Venta local; efectivo mantiene captura del recibido. | Mantener equivalente la interacción de la caja. |

### Verificación de esta continuación

| Comprobación | Resultado |
| --- | --- |
| ESLint completo | Aprobado, 0 errores y 0 advertencias |
| Backend unitario | 56/56, 0 fallos |
| Integración MySQL aislada | 88/88, base temporal aleatoria eliminada |
| Frontend local | 154/154, 0 fallos |
| Frontend conectado con MySQL | 60/60, base temporal aleatoria eliminada |
| Build público | dist regenerado con el contenido público permitido |
| git diff --check | Sin errores |
| database/schema.sql | Sin cambios; no se aplicaron migraciones |

No se hicieron commits ni se ejecutó una venta en el negocio real. La referencia publicada de Netlify no estuvo disponible para inspección automatizada en esta sesión; el flujo se cotejó con el comportamiento local del repositorio.


## Continuación: conciliación y Caja central opcional (3 de octubre de 2026)

Esta sección actualiza la limitación anterior que decía que no había confirmación para tarjeta/transferencia. Se agregó confirmación desde Caja: tarjeta y transferencia nacen pendientes, conservan factura/stock y referencia de caja, y solo pasan a confirmadas por una acción de ADMIN o un usuario con permiso `cash`. MySQL registra actor y fecha; la auditoría conserva método e importe. La confirmación no aumenta el efectivo físico esperado. Un pago pendiente anulado queda VOID y no se confirma; una venta no monetaria ya confirmada no se puede anular hasta que se integre el reembolso externo.

La sección conectada **Caja central** ya no se oculta. Muestra ventas por usuario, importes por medio, esperado físico, último arqueo, operaciones pendientes y los movimientos recientes. Cobros de clientes/crédito muestran C$0.00 y texto de no integrado: no se crean abonos ficticios. En el flujo predeterminado DIRECT, el botón y la experiencia existente de venta siguen iguales.

Se agregó configuración por negocio, predeterminada a DIRECT. En CENTRALIZED, un vendedor prepara un pedido en MySQL sin factura, movimiento ni descuento/reserva de stock, incluso si Caja está cerrada. ADMIN o un usuario con permiso cash revisa el pedido en Caja. El servidor comprueba turno, estado de producto, disponibilidad, tarifa, descuento y total actuales. Si cambió el precio desde la preparación, Caja muestra el estimado y el precio vigente, y exige confirmación antes de facturar/cobrar. El cargo conserva la atribución del vendedor y registra al cajero. Cambiar el modo exige Caja cerrada y sin pedidos pendientes.

La migración necesaria está aislada en `database/migrations/003_connected_cash_workflow.sql`; agrega el selector por negocio, pedidos y sus líneas, cajero y confirmador/fecha. No se aplicó a la base principal. La integración la ejecuta solamente en bases `pos_auth_test_*` aleatorias que elimina. Hace falta aprobación explícita para usar `npm.cmd run migrate:cash-workflow --prefix backend -- --apply` contra la base real. Hasta entonces el build nuevo conectado no se debe usar para una venta en esa base: aún no contiene las columnas/tablas 003.

| Before | After | Why |
| --- | --- | --- |
| Caja central conectada estaba oculta y no resumía ventas por vendedor. | Caja renderiza resúmenes, revisiones, pagos pendientes y movimientos por sesión/factura. | Dar al cajero contexto y permitir revisar operaciones no monetarias. |
| Tarjeta/transferencia quedaban pendientes sin acción de conciliación. | Acción Confirmar recibido con actor y fecha; el efectivo esperado las excluye aun confirmadas. | Registrar recepción sin afirmar efectivo físico ni permitir confirmación doble. |
| Todos los vendedores cobraban directamente. | Modo CENTRALIZED opcional; los vendedores preparan pedidos y Caja vuelve a cotizar antes de facturar. | Permitir centralizar el cobro por negocio sin cambiar el flujo DIRECT predeterminado. |
| Pedido podía prepararse con un precio que cambió antes del cobro. | La interfaz compara total estimado/vigente y requiere confirmar cuando cambia; el servidor recalcula al cobrar. | Evitar facturar inadvertidamente un importe distinto. |

Skill aplicada: `.agents/skills/emil-design-eng/SKILL.md`; revisé controles claros, confirmación explícita, estados accesibles y contenido de tablas que se adapta con desplazamiento horizontal. No se agregaron animaciones a acciones de cobro.

Archivos funcionales de esta continuación: `backend/src/services/sales.js`, `backend/src/routes/sales.js`, `backend/src/services/sales-values.js`, `backend/scripts/migrate-cash-workflow.cjs`, `backend/scripts/test-integration.cjs`, `backend/scripts/test-connected.cjs`, `backend/package.json`, `database/migrations/003_connected_cash_workflow.sql`, `database/migrations/README.md`, `database/README.md`, `backend/SALES.md`, `api-client.js`, `connected-sales.js`, `app.js`, `index.html` y `styles.css`. Regresiones: `backend/tests/sales-values.test.cjs`, `backend/tests/integration/sales.test.cjs`, `tests-connected/sales.spec.cjs` y `tests/pos-connected-layout.spec.cjs`. Se regeneró `dist` con la lista pública fija de 11 archivos.

| Comprobación final | Resultado |
| --- | --- |
| ESLint completo | 0 errores, 0 advertencias |
| Backend unitario | 57/57 aprobadas |
| Integración backend/MySQL temporal | 90/90 aprobadas; migraciones aplicadas y base temporal eliminada |
| Frontend local | 154/154 aprobadas (3.3 min) |
| Frontend conectado/API/MySQL | 62/62 aprobadas (1.8 min); base temporal eliminada |
| Build público | 11 archivos allowlist, sin artefactos backend/SQL/secretos |
| `git diff --check` | Sin errores de espacios; avisos LF/CRLF habituales |
| `database/schema.sql` | Sin cambios |
| Venta en el negocio principal | No realizada; migración 003 pendiente de aprobación |

Pasos manuales después de aprobar 003: (1) respaldar y aplicar solo la migración 003 sobre la base seleccionada; reiniciar backend y regenerar el build; (2) servir únicamente `dist` y abrir `http://127.0.0.1:5500/?mode=connected`; (3) probar en DIRECT efectivo, tarjeta y transferencia, confirmar pagos desde Caja y comparar efectivo esperado; (4) probar modo centralizado: cerrar Caja, habilitarlo, preparar como vendedor, abrir Caja como ADMIN/usuario cash, revisar cualquier cambio de precio, cobrar y validar factura, vendedor, cajero, Kardex y movimiento; (5) anular un pago antes de confirmarlo y verificar VOID. No se realizó ninguna venta real durante esta tarea.

Compras conectadas, gastos conectados, crédito, abonos, sincronización offline, planes comerciales, rubros especiales y migración local a conectado permanecen bloqueados. Planes, plantillas, categorías avanzadas, unidades por rubro y panel del dueño corresponden a fases posteriores. No se agregó rol CAJERO: el acceso de Caja sigue dependiendo de ADMIN o autorización temporal `cash`.
