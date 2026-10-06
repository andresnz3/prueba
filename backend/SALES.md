# Ventas y caja conectadas: fase 5.3

## Alcance y dependencias

Contado con productos MySQL, lector/busqueda existentes, menudeo/mayoreo, cantidades de hasta tres decimales, descuento porcentual global, consecutivos independientes por negocio, stock, costo historico, actor, movimientos de efectivo confirmados y anulaciones auditables. No se usa Dexie para estas operaciones.

Clientes, cuentas por cobrar, abonos, compras, gastos, movimientos manuales y correcciones de caja no tienen backend completo. Sus escrituras permanecen bloqueadas. Reportes y Dashboard conectados no muestran agregados incompletos. Configuracion conserva el alcance local por negocio de la fase anterior; no es una fuente de precios ni impuestos para MySQL.

En esta fase la moneda conectada es C$; no hay conversiones ni multimoneda. El simbolo de la configuracion local no cambia los importes MySQL y se deshabilita en conectado. Configuracion monetaria por negocio requiere un contrato posterior.

Una unica caja compartida por negocio identifica el turno. Todas las ventas de contado, incluso tarjeta/transferencia, requieren caja abierta. La API la elige desde la sesion; el navegador no puede asignar una caja o negocio a la venta. La cotizacion contiene el ID de caja como precondicion: si se cierra/reabre el turno, hay que comprobar el cobro nuevamente. Apertura y cierre requieren permiso cash. Vendedores cobran con sales; historial y anulaciones requieren history. Una autorizacion temporal no concede otro modulo.

## Endpoints (prefijo /api)

| Metodo y ruta | Permiso | Contrato |
| --- | --- | --- |
| POST /sales/quote | sales + CSRF | items, priceType, paymentMethod, discountPercent; devuelve quote con importes, caja y quoteToken |
| GET /sales/next-invoice | sales | Devuelve el siguiente numero visible como vista previa; leerlo no reserva ni incrementa la secuencia |
| POST /sales | sales + CSRF | Los campos anteriores mas operationKey, quoteToken, cashReceived y detail; devuelve kind=SALE y sale |
| GET /sales | history | limit/offset, maxId opcional; devuelve sales |
| GET /sales/:id | history | Factura propia, snapshots e informacion de anulacion |
| POST /sales/:id/cancel | history + CSRF | operationKey, reason; devuelve kind=CANCEL y sale |
| GET /operations/:key | sales | Resultado de la operacion del mismo negocio y usuario; 404 si ausente |
| POST /operations/:key/resolve | sales + CSRF | {}; recupera resultado o descarta atomicamente una clave ausente |
| GET /cash/current | sales | Caja abierta y resumen; null si no hay caja |
| GET /cash/current?full=true | cash | Incluye movimientos de esa caja |
| GET /cash/sessions | cash | limit/offset; sesiones con arqueo y movimientos |
| POST /cash/sessions | cash + CSRF | operationKey, openingAmount; apertura idempotente |
| POST /cash/sessions/:id/close | cash + CSRF | operationKey, countedAmount; cierre y diferencia idempotentes |

En flujo centralizado, `sale_orders.id` identifica una orden pendiente y no es un numero de factura. Crear, consultar o cancelar una orden no modifica `document_sequences`; `/cash/orders/:id/charge` la incrementa una sola vez al crear la venta y asignar su factura. La cabecera muestra la vista previa del siguiente numero; una anulacion conserva el numero de la factura emitida y no consume otro.

IDs BIGINT y DECIMAL viajan como cadenas. Los listados admiten limit=1..100 y offset=0..9999999. maxId fija un corte del historial ante ventas nuevas; el frontend recorre todas las paginas. Cuerpos estrictos: se rechazan businessId/business_id, userId, precios, importes calculados, impuestos y campos desconocidos. Se exige JSON en escrituras y CSRF ligado a la sesion. Todas las respuestas son no-store.

items es una lista de 1..100 elementos {productId, quantity}, sin IDs repetidos. priceType es RETAIL o WHOLESALE; paymentMethod es CASH, CARD o TRANSFER. discountPercent admite 0..100 con cuatro decimales. cashReceived tiene dos decimales y es obligatorio para CASH; para otros medios debe ser null. detail admite hasta 500 caracteres sin controles. operationKey es UUID v4 aleatorio. reason es obligatorio, hasta 500 caracteres.

## Calculo y dinero

Los precios vigentes vienen de products.retail_price/wholesale_price, nunca del navegador. Cantidades usan enteros escalados a milesimas; dinero a centavos y porcentaje a cuatro decimales. Cada subtotal de linea se redondea al centavo, mitad hacia arriba. Se calcula el descuento sobre el subtotal global y se distribuye por acumulados para que la suma de lineas concilie exactamente con la factura. El precio manual del producto se respeta; no se deriva nuevamente del margen.

Se conserva la regla del POS actual: total=subtotal-descuento, tax=0. No se añade impuesto local. El tax_rate de cada producto se conserva en sale_items como informacion; cualquier cambio fiscal requiere su propio contrato, revision y pruebas. Los descuentos hasta 100% siguen disponibles como en modo local. Una factura gratuita descuenta stock pero no crea un movimiento de importe cero, incompatible con el CHECK existente.

Efectivo: una entrada SALE CONFIRMED por el total cobrado, no por el efectivo recibido. cash_received y change_amount preservan el cambio. Tarjeta y transferencia crean también un movimiento SALE IN con estado PENDING y método visible, dentro de la misma transacción que factura y descuenta stock. Los estados pendientes no aumentan el efectivo esperado: solo se suman movimientos CONFIRMED. No existe todavía una interfaz conectada para confirmar tarjeta/transferencia; por eso permanecen pendientes y nunca se confirman automáticamente. Estos medios registran pagos declarados por el operador: no se integró una pasarela bancaria ni se procesa un cargo/refund externo.

Cierre: persiste contado, esperado y diferencia, actor y fecha. No incluye gastos/abonos/entradas manuales futuros. Para anular una venta de efectivo con importe positivo debe haber una caja abierta actualmente y saldo suficiente en ella. La devolución se registra como salida REVERSAL en la caja actual, vinculada al movimiento SALE original; el movimiento, caja y cierre originales quedan intactos. Sin caja abierta se devuelve `CANCEL_REQUIRES_OPEN_CASH` con el mensaje «Para anular esta venta debe abrir una caja, porque la devolución se registra en la caja actual». La anulación repone stock una sola vez y conserva el número de factura. Una venta de total cero no crea movimiento de efectivo. Tarjeta/transferencia anulan el registro y marcan VOID su movimiento pendiente; una venta ya confirmada no se anula hasta registrar el reembolso externo. Las ventas a crédito solo se anulan si no tienen abonos aplicados.

## Integridad, concurrencia e idempotencia

Se reutiliza repo.tenant: transaccion y bloqueo del negocio, sesion/usuario activo y negocio autentico. Productos, caja y secuencia se leen con FOR UPDATE; la factura unica existente y el bloqueo serializan ventas. Venta, lineas, costo al vender, Kardex, ingreso de caja, auditoria, consecutivo y resultado idempotente se confirman juntos. Una excepcion revierte todo, incluida la secuencia. Sesion y permiso se revalidan al inicio y justo antes del commit.

Referencia de los bloqueos: https://dev.mysql.com/doc/refman/8.0/en/innodb-locking-reads.html . El bloqueo por negocio favorece integridad y limita el rendimiento bajo alta concurrencia; debe revisarse antes de una escala mayor.

pos_operations conserva clave unica por negocio, usuario, clase de operacion, SHA256 del cuerpo canonico y resultado JSON. Repetir la misma clave/cuerpo/usuario devuelve el resultado, sin cobrar ni descontar otra vez; cambiar cualquier dato o usuario devuelve OPERATION_CONFLICT. Las claves no son credenciales. Otra empresa/usuario no puede consultar resultados ajenos. GET/resolve recuperan el estado actual de la factura si fue anulada despues de la respuesta original.

El navegador guarda solo {key, kind} por origen API/negocio/usuario en localStorage ANTES de enviar. No persiste carrito, precios, efectivo, credenciales ni una cola offline. Si no puede guardar esa referencia, no envia el cobro. La referencia sobrevive recargas. Mientras existe, se bloquea otra mutacion financiera de ese usuario en esa pagina y se ofrece Comprobar operacion. No se reintenta por fallos de red. La recuperacion CSRF anterior se conserva solo ante rechazo explicito CSRF_FAILED, que no procesa la escritura.

Un 404 de consulta no basta para permitir otra venta: podria haber una solicitud tardia. El resolver POST toma el mismo bloqueo. Si existe resultado, lo recupera; si no existe, crea una marca ABANDONED que impide confirmar cualquier solicitud posterior con esa clave. Si se pierde la respuesta del resolver, se vuelve a comprobar la misma clave. Las claves/marcas no se borran automaticamente: eliminarlas permitiria reutilizacion peligrosa. Su retencion y crecimiento requieren una politica operativa futura.

## Migracion 002

Archivo database/migrations/002_sales_operations.sql. Crea pos_operations y agrega cash_received/change_amount con CHECK a sales. No cambia database/schema.sql, las 20 tablas originales ni la migracion 001. No introduce dependencias.

No se aplico a la base principal. El ejecutor de pruebas la aplica exclusivamente en pos_auth_test_* aleatorias, y elimina esas bases al terminar. Ventas/cobro informan SALES_MIGRATION_REQUIRED si falta alguna parte.

Despues de revision, respaldo y aprobacion explicita para la base seleccionada:

~~~powershell
npm.cmd run migrate:sales --prefix backend -- --apply
~~~

El script exige --apply y verifica que no existan la tabla/columnas antes de ejecutar. DDL no es transaccional: si la ejecucion se interrumpe, revisar information_schema y completar conscientemente; no repetir ciegamente ni borrar registros. No ejecutar schema.sql sobre una base existente. Mantener las credenciales en backend/.env sin exponerlas.

## Prueba manual desde el navegador

1. Aplicar 002 solo tras aprobacion, despues de 001, en la base seleccionada. Reiniciar npm.cmd run dev --prefix backend.
2. node scripts/build-static.cjs; servir SOLO dist: .\node_modules\.bin\http-server.cmd dist -a 127.0.0.1 -p 5500 -c-1.
3. Abrir http://127.0.0.1:5500/?mode=connected. Entrar con el negocio y cuentas existentes. Conservar api-config.js y CORS con origenes compatibles.
4. Un ADMIN entra a Caja y abre con el efectivo inicial real. Un vendedor necesita autorizacion cash para abrir/cerrar.
5. Productos: crear/verificar un producto activo con stock y precios. No se exige proveedor conectado; fotos mantienen carga binaria privada.
6. Ventas: buscar o escanear, ajustar cantidades, elegir tarifa, descuento y medio de pago. Cobrar muestra el total calculado por MySQL. En efectivo ingresar recibido suficiente y Confirmar venta. Tarjeta/transferencia conservan el flujo directo del modo local y quedan como pendientes visibles en Caja e Historial; aun no tienen accion de confirmacion.
7. Verificar ticket, Historial y Kardex tras recargar. El historial/anulacion de vendedor requiere autorizacion history.
8. Si hay resultado desconocido, pulsar Comprobar operacion antes de cobrar otra vez. No borrar manualmente la referencia pendiente.
9. Caja: confirmar que solo efectivo aumenta esperado; cerrar con el conteo real. Probar una devolución después del cierre: sin caja actual se bloquea; al abrir otra caja con saldo suficiente, la salida se registra ahí y el cierre original permanece intacto.

## Validaciones y limites pendientes

Login muestra mensajes junto a negocio/usuario/contrasena, enfoca el primer campo, conserva entradas ante validacion y expresa errores de conexion. Credenciales incorrectas no distinguen usuario inexistente de contrasena incorrecta. El bloqueo HTTP 429 informa segundos desde Retry-After. No se cambiaron las cuentas locales. Los secretos siguen borrandose de los formularios despues de intentos enviados.

Productos/ajustes mantienen valores y muestran errores por campo, duplicado, decimales, stock y fotografia. Las fotografias siguen normalizadas en almacenamiento privado; no hay Base64 conectado. Carrito, stock, descuento, caja, autorizacion, sesion, precio cambiado, importe y resultado desconocido tienen errores diferentes. No se muestran errores SQL/JS internos.

Quedan pendientes las validaciones conectadas de clientes, limites de credito, saldos/abonos, proveedores, facturas de compra, pagos, gastos, retiros, correcciones, cierre central y conciliacion bancaria. Se integraran con sus contratos, no con persistencia local. La numeracion actual es comercial interna; no se integro un proveedor de facturacion fiscal.

Una caja muy grande devuelve sus movimientos completos: paginacion de movimientos/resumen SQL y retencion de pos_operations requieren trabajo para gran escala. Varias pestanas comparten cookies; los cambios de identidad se verifican antes de escribir y las respuestas vencidas se descartan. Sesiones, precios y stock pueden cambiar durante un formulario: el servidor decide y conserva los campos para volver a comprobar.

Pruebas y resultados finales: ../PHASE53.md.

## Continuación: conciliación y Caja central opcional

Esta sección actualiza el alcance anterior de pagos no efectivos. Tarjeta y transferencia continúan como movimientos PENDING al facturar. Desde Caja, un usuario con permiso `cash` (o ADMIN) puede confirmarlos una sola vez. Se guardan `confirmed_by_user_id` y `confirmed_at`, se actualiza `sales.cash_status` y se audita el actor. El efectivo esperado excluye CARD y TRANSFER incluso después de confirmarlos. Si la venta se anula antes, su movimiento queda VOID y la confirmación se rechaza. La anulación conectada de un pago ya confirmado queda bloqueada hasta que exista una fase de reembolsos; el cargo/reembolso bancario ocurre fuera del POS.

Cada negocio inicia con `sales_flow=DIRECT`. En ese modo, Venta conectada conserva su flujo actual. ADMIN puede elegir `CENTRALIZED` desde Caja, únicamente con la caja cerrada y sin pedidos pendientes. Los vendedores autorizados para Venta guardan un pedido en MySQL: todavía no crea factura, no reserva/descuenta stock y no mueve efectivo. Caja requiere permiso `cash`; al cotizar y cobrar vuelve a validar caja abierta, producto activo, stock, precio vigente, descuento y total. La interfaz compara el estimado del pedido con el precio actual y exige la confirmación explícita del cajero si hubo cambio. La venta final guarda al vendedor original y al cajero que factura. Un pedido cancelado o ya cobrado no se puede procesar otra vez. La preparación online no usa Dexie ni cola offline.

| Metodo y ruta | Permiso | Contrato |
| --- | --- | --- |
| GET /business-settings/sales-flow | sales | Modo DIRECT/CENTRALIZED del negocio autenticado |
| PUT /business-settings/sales-flow | ADMIN + CSRF | `{salesFlow}`; requiere caja cerrada y cero pedidos pendientes |
| POST /sales/orders | sales + CSRF | Items, tarifa, descuento, detalle y operationKey; prepara sin factura ni cambio de stock |
| POST /cash/orders/:id/quote | cash + CSRF | paymentMethod; revalida precio, disponibilidad y caja abierta |
| POST /cash/orders/:id/charge | cash + CSRF | quoteToken, medio, efectivo recibido si CASH, operationKey |
| POST /cash/orders/:id/cancel | cash + CSRF | operationKey; cancela pedido pendiente |
| GET /cash/overview | cash | Totales por vendedor, cierres, movimientos, pagos pendientes y pedidos pendientes |
| POST /cash/payments/:id/confirm | cash + CSRF | operationKey UUID v4; confirma CARD/TRANSFER pendientes de una venta completa |

El módulo Caja presenta ventas por vendedor, efectivo esperado y diferencia de último cierre. “Cobros de clientes” y crédito permanecen en cero y declarados como no integrados; no se crean abonos falsos. Los movimientos de medios no monetarios mantienen método, estado, factura, usuario que confirmó y hora. La cola de pedidos distingue pedidos pendientes de facturas.

## Migración 003

`database/migrations/003_connected_cash_workflow.sql` agrega la configuración del flujo, los pedidos centralizados, el cajero de la venta y los datos de confirmación de pagos. Es necesaria para esta continuación y requiere 002 previamente. No modifica `database/schema.sql`. Se dejó un ejecutor separado que valida estados parciales y exige el argumento explícito `--apply`; no se ejecutó sobre la base principal. Solo después de revisión y aprobación explícita se puede aplicar con:

~~~powershell
npm.cmd run migrate:cash-workflow --prefix backend -- --apply
~~~

Las pruebas de integración aplican 001, 002 y 003 únicamente a bases `pos_auth_test_*` aleatorias, verificadas y eliminadas al terminar. No usar esos comandos contra una base real hasta recibir aprobación.

## Prueba manual después de aprobar y aplicar 003

1. Respaldar y confirmar explícitamente la base objetivo; aplicar 003 allí y reiniciar el backend. Regenerar el build público y servir únicamente `dist`.
2. Probar `DIRECT` (predeterminado): ADMIN abre Caja, agregar producto y hacer ventas de efectivo, tarjeta y transferencia. Efectivo debe aumentar el esperado. Los otros medios deben facturar y descontar stock, quedar pendientes y no aumentar efectivo.
3. Desde Caja, confirmar cada pago pendiente. Comprobar que cambia su estado y muestra actor/hora, mientras efectivo esperado permanece idéntico. Anular un pago pendiente y comprobar estado VOID; intentar confirmarlo otra vez debe rechazarse.
4. ADMIN cierra Caja, cambia el negocio a CENTRALIZED y un vendedor prepara un pedido con Caja cerrada. Verificar que no exista factura, movimiento ni descuento de stock. ADMIN vuelve a Caja, abre turno y revisa el pedido.
5. Cambiar un precio antes de cobrar: Caja debe mostrar estimado y precio vigente, y solicitar confirmación del nuevo precio. Cobrar y verificar factura, stock, vendedor original, cajero y movimiento en Caja. Tarjeta/transferencia siguen pendientes hasta confirmación.
6. Intentar preparar factura directa en modo CENTRALIZED, cobrar con caja cerrada, cambiar de modo con Caja abierta/pedidos pendientes y confirmar un pago anulado; cada caso debe rechazarse sin escrituras financieras.

Compras conectadas, gastos conectados, crédito, abonos, sincronización offline, planes comerciales, rubros especiales y migración local a conectado continúan bloqueados. No se crearon roles nuevos: ADMIN o un usuario con autorización `cash` puede operar Caja.
