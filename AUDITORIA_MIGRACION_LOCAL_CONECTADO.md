# Auditoría de migración de POS local a conectado

**Fecha:** 2026-10-21

**Resultado:** no se puede declarar completa ni autorizar todavía la migración del primer negocio real.

**Alcance:** auditoría estática del código y esquema; pruebas enfocadas en bases temporales `pos_auth_test_*`. No se abrió ni exportó la IndexedDB de un negocio real.

## Resumen ejecutivo

El migrador actual cubre varias etapas útiles: catálogo básico, una apertura de inventario basada en existencias actuales, ventas históricas de contado, ventas y abonos de crédito y compras históricas. Las etapas de ventas, compras y crédito tienen controles de validación e idempotencia más sólidos que la carga inicial del catálogo. Aun así, la cobertura general es **PARCIAL**: ningún componente del negocio completo cumple un criterio verificable de conservación del 100 %.

Hay brechas decisivas para una migración fiel: caja, gastos, pagos a proveedores, auditoría local, órdenes pendientes, imágenes y parte de la configuración no se importan. Las compras no cargan abonos a proveedores; el catálogo inicial no conserva límites de crédito ni IDs de origen; el historial de inventario se reduce a un movimiento de apertura; y varios datos de anulación, responsables y estados cambian o se pierden. El paquete tampoco incluye un manifiesto integral de registros y hashes para probar que cada fila de origen terminó importada o excluida con motivo aprobado.

**Recomendación:** no migrar un negocio real hasta completar las prioridades P0 de la sección [Plan de cierre](#plan-de-cierre), ejecutar una vista previa sin bloqueos sobre una copia de un paquete real y reconciliar campos, relaciones, historiales y saldos.

## Alcance, evidencia y límites

Se revisaron las tiendas Dexie declaradas en `app.js`, las estructuras embebidas producidas por los flujos locales, el exportador `local-migration-export.js`, la vista previa local, los servicios de migración bajo `backend/src/services/`, las tablas base de `database/schema.sql`, las migraciones 005 y 007–011, los tests de unidad, integración y navegador relacionados.

El inventario describe **estructuras que el código puede guardar**, no el contenido concreto de una instalación local. Por la restricción de no leer ni migrar datos reales, no se comprobó cuántos registros o variantes antiguas existen en el navegador de ningún cliente. Los tests usan paquetes de fixture. Dos pruebas que esperan un JSON local de referencia se omitieron porque ese archivo no está presente en este checkout. Por ello no es posible certificar una migración concreta ni afirmar “100 %” para una base local no inspeccionada.

## Inventario de datos locales y correspondencia

Dexie declara `POS_OfflineDB` con estas tiendas: `products`, `clients`, `suppliers`, `sales`, `purchases`, `sync_queue`, `cajaSessions`, `gastos`, `abonos`, `inventory_movements`, `audit_logs` y, desde la versión 10, `saleOrders`. No existe una tienda separada de categorías: el nombre de categoría vive en el producto. Las ventas y compras contienen arrays `items`; las sesiones de caja contienen `movimientos`; las órdenes conservan el `input` preparado.

| Datos locales | Contenido persistente observado | Destino conectado / cobertura actual |
|---|---|---|
| Productos | ID local, código de barras, nombre, categoría, costo, márgenes, precios menudeo/mayoreo, existencia, mínimo, tasa de impuesto, activo/eliminado e imagen | `products`. La importación básica conserva la mayoría de campos comerciales y existencia; omite productos marcados eliminados e imagen. Deduplica por código o, si falta, por nombre. **PARCIAL**. |
| Categorías | Texto dentro de cada producto y lista derivada `categories` en el paquete | No hay tabla local o importación independiente de categorías. La lista del paquete no es aplicada. **PARCIAL**. |
| Clientes | ID local, nombre, teléfono, RUC, dirección, activo, límite de crédito, deuda y deuda sin factura | `clients`; la carga básica copia identidad/contacto, pero fija `credit_limit` y `opening_balance` en cero. La deuda sin factura bloquea la importación de crédito. **PARCIAL**. |
| Ventas | ID/número local, fecha, cliente, tipo/medio de pago, subtotal, descuento, impuesto, total, tarifa, detalle, plazo/vencimiento, estado, datos de caja, vendedor/cajero, anulaciones y `items` con producto, cantidad, precio, costo al vender, descuento e impuesto | `sales`, `sale_items`, referencias 008/010. Las ventas no crédito se importan en etapa separada; las de crédito en otra. Se validan totales y relaciones, pero se genera número interno de factura, no se conserva como número principal el comprobante original; se pierde el responsable local y no se reconstruye la sesión ni liquidación de caja. **PARCIAL**. |
| Crédito y abonos de clientes | `abonos` incluye tipo, cliente/factura, monto, medio, estado, fecha y datos de anulación/confirmación | `sales`, `customer_payments`, referencias 010. Facturas y abonos de clientes conciliables se importan; abonos generales se distribuyen por antigüedad de facturas. Deuda de apertura sin factura bloquea. El estado local `pendiente` se registra como `POSTED` (el original queda en `source_status`); la identidad y caja originales no se conservan. **PARCIAL**. |
| Proveedores | ID local, nombre, contacto, teléfono, RUC, dirección y activo | `suppliers`. Carga básica con deduplicación por nombre y sin mapa durable ID local → ID MySQL. **PARCIAL**. |
| Compras | ID/factura, proveedor, tipo contado/crédito, fechas y vencimiento, estado/anulación, subtotal, descuentos, impuesto, total, notas y `items` con producto, cantidad, costo y valores de línea | `purchases`, `purchase_items`, referencias 009. Compra histórica y líneas se importan con verificaciones; no mueven existencias ni caja. Se conserva el estado cancelado pero el importador escribe `cancelled_at`, `cancelled_by` y `cancel_reason` como `NULL`. **PARCIAL**. |
| Cuentas por pagar y pagos a proveedores | Las compras a crédito más abonos locales `tipo=proveedor` determinan saldos | La tabla `supplier_payments` existe y migración 005 permite el estado `PENDING`, pero el preview de crédito descarta filas de proveedor y el importador de compras no crea pagos. Compras con abonos parciales o completos pueden reaparecer como saldo pendiente. **AUSENTE**. |
| Caja | Apertura/cierre, cajero, importes inicial/real/esperado/diferencia, timestamps, estado; `movimientos` embebidos con tipo, monto, método, referencia, estado, anulación y responsable | El paquete exporta `cashSessions`, pero no hay etapa que los convierta a `cash_sessions`/`cash_movements`. Las ventas, pagos y compras históricas se insertan sin `cash_session_id` ni movimiento de caja. **AUSENTE**. |
| Gastos | Tienda `gastos`: fecha, categoría, sesión, importe, método/concepto, responsable y eventual anulación según el flujo | No se exporta ni se importa. Aunque existen tablas `expenses` y `cash_movements`, no hay correspondencia implementada. **AUSENTE**. |
| Historial de inventario | Ajustes/ventas/entradas con producto, tipo, cantidad, costo, stock resultante, fecha, motivo y usuario | El paquete incluye `inventoryMovements`, pero el importador no los reproduce. Importa el stock actual en producto y, para stock positivo, crea un único movimiento sintético `MIGRACION_INICIAL` con fecha/usuario de migración. **PARCIAL**. |
| Devoluciones, anulaciones y correcciones | La anulación de venta puede registrar movimiento inverso en caja y actualizar inventario; también se guardan referencias a operación original | Ventas anuladas pueden conservar estado, fecha y razón, pero no usuario original, caja ni reversión exacta. Compras omiten fecha, actor y motivo de anulación. Historial de movimientos y auditoría no se reconstruye. **PARCIAL**. |
| Auditoría local | `audit_logs`: fecha/timestamp, usuario, módulo, acción y detalle | No se exporta. Sí se crea auditoría nueva de cada etapa de importación, que no reemplaza la auditoría de origen. **AUSENTE**. |
| Usuarios y permisos locales | No existe tienda de usuarios en Dexie; `app.js` contiene cuentas locales codificadas y los flujos guardan nombres de responsables | No se importan roles ni responsables. Las credenciales locales no deben migrarse. El exportador elimina campos de usuario/contraseña; las filas históricas quedan atribuidas al usuario de importación o sin actor. **NO APLICA** para credenciales; historial de responsables **AUSENTE**. |
| Configuración comercial | `localStorage.posSystemConfig`: nombre, razón social, RUC, dirección, teléfono, moneda, cabecera/pie, impuesto, mínimo de stock, flujo de ventas y logo | El paquete solo incluye nombre y C$ dentro de `business`, además de RUC/dirección/teléfono/cabecera/pie/impuesto/mínimo/flujo en `configuration`; no incluye `legalName` ni `logo`. La importación básica no aplica `configuration`. Hay una recuperación separada de ciertos campos de `localStorage`, no ligada al paquete completo. **PARCIAL**. |
| Logo e imágenes de productos | Logo en configuración local y fotografía embebida en producto, normalmente como datos de imagen | El logo no se importa en la etapa del paquete; producto conserva el campo imagen en el JSON exportado, pero el parser básico lo convierte a indicador y el `INSERT` escribe `image=NULL`. La plataforma conectada dispone de almacenamiento de archivos para imágenes, pero falta la ruta de migración desde el contenido local. **AUSENTE**. |
| Órdenes preparadas | `saleOrders`: número visible, caja, estado PENDING/COMPLETED/CANCELLED, `input`, total estimado y fechas | No se exportan ni importan. Las órdenes completadas pueden tener venta asociada; las pendientes/canceladas quedan fuera. **AUSENTE**. |
| Cola local de sincronización | `sync_queue`: operaciones INSERT/UPDATE pendientes serializadas | Se excluye deliberadamente del paquete y no se interpreta. Puede contener operaciones pendientes cuyo estado y orden no se concilian con la instantánea exportada; hay que diagnosticar la cola antes de migrar. **AUSENTE**. |
| Preferencias y bloqueo de inicio local | `localStorage` también guarda configuración y estado de intentos fallidos | Preferencias de negocio parcialmente recuperables; el bloqueo local no se transfiere y no debe convertirse en autoridad conectada. **NO APLICA** para el estado de bloqueo. |

### Alcance del paquete de exportación

`local-migration-export.js` lee IndexedDB mediante transacción `readonly` y no actualiza las tiendas. Exporta ocho tiendas (`products`, `clients`, `suppliers`, `sales`, `purchases`, `cajaSessions`, `inventory_movements`, `abonos`), una configuración limitada y categorías derivadas. No exporta `gastos`, `audit_logs`, `sync_queue` ni `saleOrders`.

El exportador intenta seleccionar negocio usando el ID configurado o el único `business_id` encontrado. Si no puede determinarlo, incluye filas sin ID/ID legado y advierte que podría tratarse de registros heredados; si hay IDs ambiguos excluye filas identificadas de otros negocios. No es una prueba de propiedad suficiente para migrar sin revisar esa advertencia. El resumen del archivo cuenta filas y algunas anomalías, pero no incluye hash por fila/tienda, sumas de control financieras ni una lista exhaustiva de cada fila excluida.

La función `scrub()` elimina campos que parecen credenciales, sesión y responsables. Es una protección para la transferencia de secretos, pero elimina evidencia histórica (quién vendió, abrió caja, anuló o confirmó). No cifra el JSON y no elimina el campo de imagen de producto del archivo, aunque el importador lo descarta. El archivo debe tratarse como información confidencial de clientes y del negocio.

## Cobertura del migrador y dependencias

| Etapa | Requisitos y transformación | Estado |
|---|---|---|
| Catálogo básico | `migrateBasic()` requiere administrador de sistema y negocio destino activo. Inserta productos/clientes/proveedores en una transacción y crea `MIGRATION_BASIC_IMPORT`. | Parcial. No persiste mapa de IDs de esas entidades; cliente/proveedor deduplican por nombre y producto por código o nombre sin código. Omite imágenes/productos eliminados y límites/saldos de crédito. Reintento basado en valores puede fusionar entidades distintas. |
| Inventario | Requiere catálogo básico, destino compatible con 007 y misma existencia actual en origen/destino. | Parcial. Solo abre el saldo; no conserva movimientos originales. Omite producto sin mapeo, ambiguo, con historia incompatible o discrepancia de stock. No altera el stock destino al crear el movimiento, pero añade un evento sintético en fecha de migración. |
| Ventas no crédito | Requiere catálogo, inventario, esquema 008 y usuario activo destino. Valida importes, líneas, producto/cliente y estados. | Parcial. Inserta ventas y líneas históricas con `cash_session_id=NULL`, `cash_status=NOT_APPLICABLE`, usuario destino como responsable y referencia de origen. No genera operaciones comerciales nuevas en caja/inventario. Número local se guarda como referencia/detalle, mientras la factura del POS usa un número interno de migración. |
| Crédito y abonos de clientes | Usa ventas locales a crédito, referencia de venta y crédito 010; concilia saldos antes de importar. | Parcial. Valida saldo, cliente, fecha, importe, pagos anulados y asignación. Bloquea deuda sin factura. Solo trata abonos de cliente; `tipo=proveedor` se descarta. Los pagos pendientes locales reducen el saldo y se guardan como `POSTED` con estado original separado. |
| Compras | Requiere catálogo básico, esquema 009 y usuario destino activo; mapea producto/proveedor; evita factura duplicada por proveedor. | Parcial. Valida cantidades/valores y puede repartir descuento/impuesto general entre líneas preservando total. Es una transacción histórica, sin inventario/caja/pagos. Cancelación conserva estado, no metadatos de cancelación. |
| Caja y gastos | No existe etapa; la presencia de datos en el paquete no implica importación. | Ausente. |
| Configuración | `business-settings` actualiza settings del negocio mediante API autenticada; `importLegacy` recupera determinados valores antiguos en una ruta aparte. | Parcial para la migración local completa. La moneda conectada está fijada a C$; el flujo legacy no transporta logo ni es una importación transaccional de toda la configuración del paquete. |

Dependencias de esquema existentes en el repositorio: 007 amplía inventario; 008 crea referencias de venta; 009 añade campos históricos de compra y referencias; 010 añade campos históricos de venta/pago, estado original y referencias de crédito; 011 agrega razón social a configuración. La migración 005 solo amplía el enum de `supplier_payments.status` con `PENDING`; no implementa importación de pagos a proveedores.

## Integridad y riesgos encontrados

### Relaciones e identidad

- Las filas del paquete conservan muchos IDs locales, incluso IDs numéricos decimales o UUID. Las referencias de ventas, compras y abonos guardan IDs/claves de origen; la carga básica de producto, cliente y proveedor no mantiene un mapa durable de IDs origen → IDs destino.
- Para empatar entidades se usan códigos de barras o nombres normalizados. Cuando el nombre local se repite, una carga básica puede saltarse una entidad como “duplicada”; en etapas posteriores los matches ambiguos se bloquean, pero no se puede recuperar la entidad ya colapsada. Una colisión de nombres o producto sin código puede vincular una operación al registro equivocado si la vista previa no detecta ambigüedad.
- Las tablas SQL y los servicios conectados aplican `business_id` en las relaciones operativas. Las importaciones prueban consultas del destino por negocio, pero el operador de sistema selecciona un `targetBusinessId`; la revisión del nombre/ID destino y del negocio de origen sigue siendo una barrera operativa necesaria.

### Valores, fechas y estados

- Los parsers de ventas/crédito y compras trabajan con centavos e importes decimales de cantidad y validan que encabezados y líneas reconcilien; datos inconsistentes se bloquean o se omiten. La compra puede distribuir descuentos/impuestos del total entre renglones que no los detallaban: el total de factura se valida, pero la distribución por línea puede no ser la original.
- Las fechas en ISO/epoch se pueden preservar. Las pruebas rechazan fechas de factura ambiguas; el parser de vencimientos de compra admite formatos locales explícitos, pero fecha/hora antigua representada solo como texto depende del parser de JavaScript y puede normalizarse con zona horaria distinta. Se necesita comparar las fechas concretas de un paquete de origen antes de aceptar.
- Ventas canceladas pueden guardar estado, hora y razón, pero no actor local. En compras el importador asigna `CANCELLED` y no persiste hora, usuario ni motivo. Abonos locales `pendiente` se aplican al saldo y pasan a `POSTED`; el estado de caja pendiente queda únicamente en `source_status`. Es necesario confirmar que esa equivalencia semántica coincide con las reglas de cierre del negocio.
- La deuda inicial sin factura no tiene representación completa en el flujo actual; el preview la bloquea en lugar de inventar facturas. Los límites de crédito de cliente, sin embargo, se inicializan a cero y necesitan tratamiento explícito.

### Caja e inventario

- Se diseñaron las etapas históricas para no producir efectos actuales: las pruebas comprueban que no aumentan caja, stock ni cuentas por pagar. Esa protección evita inventar ventas/pagos actuales, pero también significa que los movimientos financieros y el Kardex originales no estarán disponibles en reportes conectados.
- El movimiento `MIGRACION_INICIAL` es sintético y tiene usuario nulo y fecha de importación. No representa los cambios históricos de inventario ni permite auditar su secuencia. El saldo de producto se carga antes; el movimiento no lo vuelve a modificar.
- Sin sesiones y movimientos de caja importados no se preservan cierres, diferencias, cobros en tarjeta/transferencia, gastos ni reversos. No debe intentar reconstruirse caja creando movimientos operativos falsos.

### Reintentos, interrupciones y origen

- Las etapas se ejecutan por separado, no como una transacción de migración completa. Un fallo puede dejar etapas anteriores confirmadas mientras la siguiente no inicia. Las importaciones de ventas/compras/crédito guardan referencias y tienen cobertura de reintento; pruebas SQL de ventas/crédito verifican reversión de falla y que no queden referencias huérfanas.
- El catálogo básico tiene transacción y un reintento aproximado por valores, no una identidad duradera por fila de origen. La auditoría de etapa identifica paquete por negocio/nombre/fecha de exportación, no por hash completo de contenido. El mismo nombre/fecha con archivo alterado no es una identidad suficiente para recuperación segura.
- El origen local no se modifica: exportación de solo lectura y pruebas de inmutabilidad del paquete. No se borra ni actualiza Dexie al importarlo. La cola local excluida puede contener operaciones pendientes cuyo estado y orden no se concilian con la instantánea exportada; debe revisarse antes de migrar.

### Credenciales y transporte

El código local incluye usuarios y claves de acceso sencillas codificadas en el cliente. No deben copiarse a MySQL ni al paquete. El exportador elimina campos de usuario y contraseña, pero por eso no conserva atribución histórica. Las cuentas conectadas deben crearse independientemente: verificar al administrador del negocio, crear cuenta con rol revisado y enviar un enlace de activación/cambio de contraseña de un solo uso y vencimiento; almacenar únicamente hash de contraseña del mecanismo conectado. El paquete JSON contiene datos personales y financieros sin cifrado propio y debe transportarse/guardarse mediante un canal autorizado y con acceso limitado.

## Pruebas ejecutadas

Todas las pruebas funcionales e integración se ejecutaron contra bases con nombre aleatorio `pos_auth_test_<24 hex>`; cada base temporal usada se eliminó al final. No se ejecutó ninguna migración ni operación sobre `pos_multitenant`. Las pruebas Playwright sirvieron archivos de `dist` y usaron Edge instalado; no se sirvió una copia de datos real.

| Suite enfocada | Resultado | Qué prueba y qué no cubre |
|---|---:|---|
| Unidad backend: carga básica, inventario, ventas, compras, crédito y referencias de origen | 54 aprobadas, 0 fallidas, 1 omitida | Incluye autorización, deduplicación, validación de datos, deuda, estados, fechas, referencias, reintentos/rollback y preservación del origen. Se omitió un caso que requiere JSON local no incluido en este checkout. |
| Integración MySQL: migración de inventario, ventas, compras y crédito | 8 aprobadas, 0 fallidas, 1 omitida | Base temporal restaurada desde esquema + migraciones 001–011. Prueba relaciones, referencias, estados, idempotencia, reversión de una falla y que las importaciones históricas no muevan caja/stock. Se omitió un caso de JSON local ausente. |
| Playwright conectado: `historical-credit-migration` y `historical-purchases-migration` | 2 aprobadas | Confirma el flujo de interfaz/importación, conciliación, segundo intento y ausencia de efectos operativos/caja/inventario en fixtures. No prueba un perfil real de IndexedDB, gastos, pagos a proveedores, caja histórica ni imágenes. |

El primer intento de Playwright con el ejecutor general no encontró Chromium; un segundo intento con Edge expuso que esas dos specs exigen que el negocio de prueba tenga ID `1`, mientras el ejecutor general inserta primero un fixture de preservación 005 y entrega ID `2`. Para completar la verificación, se ejecutaron las mismas specs en una base temporal limpia, instalada con el ejecutor oficial de esquema pero sin ese fixture auxiliar; ambas pasaron. Este desacople de fixtures del runner debe corregirse para que las specs no dependan del ID autoincremental `1`.

No se repitió la suite general de 570 tests. No se probaron imágenes, gastos, pagos a proveedor, ni cierre histórico de caja: no existe una ruta de importación que ejercite esas funciones. Por esta razón, esos datos no se consideran verificados.

## Plan de cierre

### Prioridad P0 — antes de migrar un negocio real

1. **Definir el manifiesto de origen y alcance.** Versión de paquete con ID/hash del negocio local, hash SHA-256 del archivo, conteos de todas las tiendas y detalle por fila: importable, excluida con razón o requiere decisión. Bloquear exportación si hay `business_id` ambiguos, cola pendiente sin revisar o filas sin clasificación.
2. **Agregar identidad estable y reanudación.** Una tabla de lotes de importación con destino, identidad/hash del paquete, actor, fase, estado y checkpoints; mapa por tienda de `source_business_key + entity_type + source_id` a ID destino con unicidad y huella. Reintentar el mismo archivo no puede crear o fusionar registros diferentes.
3. **Importar todas las entidades financieras faltantes.** Diseñar importadores de caja/sesiones y movimientos, gastos, pagos a proveedores y sus asignaciones a compras. Revisar `abonos` de tipo proveedor. Etiquetarlos como históricos y evitar que afecten efectivo actual o cambien resultados operativos.
4. **Conservar la secuencia de inventario.** Importar movimientos locales originales con fechas, cantidades, costo, razón y estado; reconciliar que el stock final coincida con el de origen sin aplicar las salidas/entradas otra vez. Si no se puede recuperar el historial, mostrar esa pérdida como exclusión que el cliente debe aceptar.
5. **Completar relaciones y datos maestros.** Persistir IDs de origen para productos/clientes/proveedores; no deduplicar cliente/proveedor solo por nombre; resolver por RUC/teléfono/código con vista previa de coincidencias. Importar límites de crédito y representar deudas sin factura en una estructura histórica aprobada.
6. **Preservar estado y metadatos.** Decidir modelo para fecha/razón/actor de cancelación, estado original de ventas/compras/abonos, caja confirmada/pendiente/anulada, reversos y responsables. No convertir automáticamente un registro cancelado o pendiente en uno válido sin conservar su semántica completa.
7. **Configuración y medios.** Integrar en un mismo lote los campos comerciales actuales, comprobantes, configuración de flujo/impuestos, logo y fotos de productos. Validar formato/tamaño, escribir archivos de modo persistente y comparar hashes del origen/destino. Mantener C$ y no importar preferencias técnicas ni contraseñas.
8. **Vistas previas con reconciliación.** Bloquear ante diferencias de total, clientes, facturas, abonos, saldo CxC/CxP, saldo de inventario, caja, gastos, anulaciones o filas sin vínculo. Mostrar explícitamente cada exclusión antes de confirmar.

### Prioridad P1 — robustez y operación

- Hacer las etapas reanudables después de desconexión con estado durable y resultados por entidad; retener el paquete original sin alterarlo.
- Tratar el archivo de exportación como confidencial, protegerlo en tránsito y definir retención/borrado después de la aceptación del cliente.
- Corregir las pruebas Playwright para que tomen el business ID dinámicamente y añadir fixtures temporales para IDs duplicados/antiguos, fallos por etapa, proveedores, gastos, cierres de caja, medios de pago, reversos y archivos de imagen.
- Añadir comparación determinista origen/destino por datos normalizados, además de conteos: totales monetarios por estado/medio, saldos por tercero, secuencia y saldo final de inventario, cierres de caja, referencias y hashes de medios.

## Posibles migraciones SQL futuras

No se creó ni ejecutó ninguna migración nueva. La migración 005 existente habilita el estado de pago `PENDING`, no el traslado de pagos históricos. Las migraciones 008–010 ya dan referencias específicas a ventas, compras y abonos de crédito, pero no un manifiesto de paquete ni mapas de entidades maestras/caja/gastos.

Una migración aditiva futura —candidato de siguiente número después de verificar el estado de todos los entornos, no creada en esta auditoría— podría añadir:

- tablas `migration_import_batches` y `migration_entity_references` con claves por negocio destino, negocio fuente, tienda e ID local, huellas de contenido, fase y estado;
- referencias idempotentes para entidades base, sesiones, gastos, pagos de proveedor y movimientos históricos;
- solo los campos/tablas históricos que el modelo actual no pueda representar (p. ej., estado original, actor de origen, anulaciones y bandera histórica para movimientos que no deben afectar caja/stock actual).

Antes de diseñarla hay que mapear columnas disponibles y reportes que interpretan cada estado. Debe ser aditiva, preservar filas existentes y probarse únicamente con bases temporales. `database/schema.sql` debe permanecer sin cambios; el esquema nuevo se expresaría en migraciones versionadas separadas.

## Procedimiento seguro propuesto para el primer cliente

1. Crear una copia de respaldo del perfil/navegador y conservar el negocio local intacto. Verificar qué perfil/origen contiene `POS_OfflineDB`; el almacenamiento IndexedDB no se comparte automáticamente entre navegadores o dispositivos.
2. Exportar desde ese perfil en modo lectura. Detenerse si el paquete indica identidad de negocio ambigua, cola pendiente, filas omitidas sin explicar o advertencias no resueltas. Calcular y registrar SHA-256 del archivo original.
3. Crear negocio conectado y cuenta nueva del administrador. Confirmar por un canal independiente el RUC/nombre del origen y destino; enviar activación de credenciales segura. Nunca reutilizar clave local.
4. Cargar el mismo paquete en una vista previa en el destino temporal/seleccionado. Revisar cada asociación de ID y cada exclusión; comparar detalle y agregados por estado, fecha, método de pago, saldos e historial.
5. Aplicar las fases con un ID/hash de paquete durable. Ante corte, reanudar con el mismo archivo y revisar checkpoint; no crear un segundo lote con una copia cambiada.
6. Ejecutar una conciliación final de registros, sumas, relaciones, fechas, estados, imágenes, caja, inventario, CxC/CxP y reportes. Obtener aceptación del cliente por cada exclusión o diferencia permitida.
7. Mantener el POS local y su respaldo disponibles hasta aceptación escrita y acceso satisfactorio desde un segundo navegador. No borrar datos locales automáticamente.

## Criterios para declarar una migración completa

- Cada registro de cada tienda local está representado en destino o figura como exclusión individual con motivo, valor y aceptación explícitos; ningún registro queda sin clasificar.
- Cada entidad y relación conserva su ID de origen en un mapa estable; no hay referencias huérfanas ni asociaciones ambiguas entre negocios.
- Conteos, valores de detalle y agregados de ventas/compras/créditos/pagos/gastos/caja se reconcilian por fecha, estado y método; saldos abiertos coinciden al centavo.
- El saldo actual de cada producto coincide y el historial conserva eventos/fechas/costos o documenta una exclusión aceptada; no se aplican movimientos históricos como operaciones nuevas.
- Anulaciones, reversos, estados y responsables se conservan o tienen una traducción aprobada y reversible; ningún cancelado se convierte en operación válida inadvertidamente.
- Configuración y archivos se leen desde otro navegador y sobreviven al reinicio; tamaños y hashes de imágenes coinciden.
- Repetir la misma importación produce cero duplicados; simular caída en cada fase permite reanudar y el paquete local permanece sin cambios.
- Dos negocios con datos parecidos no cruzan registros; tests de aislamiento comprueban que no se puede leer ni alterar el destino equivocado.
- La auditoría registra paquete/hash, operador, destino, fases, creados/omitidos, diferencias y aprobación sin almacenar contraseñas locales.

## Archivos examinados y estado de cambios

Se revisaron principalmente `app.js`, `local-cash-flow.js`, `local-migration-export.js`, `local-migration-preview.js`, `backend/src/services/system-admin.js`, `system-admin-inventory-migration.js`, `system-admin-sales-migration.js`, `system-admin-sales-migration-values.js`, `system-admin-credit-preview.js`, `system-admin-credit-migration.js`, `system-admin-purchases-migration.js`, `system-admin-purchases-migration-values.js`, `business-settings.js`, `database/schema.sql` (solo lectura), `database/migrations/005_supplier_payment_reconciliation.sql` y `007`–`011`, además de sus tests relacionados.

**Cambios hechos por esta auditoría:** únicamente este informe Markdown. No se cambió lógica funcional, interfaz, esquema, datos locales ni archivos de migración. No se hizo commit/reset/clean; `stash@{0}` se conservó. No se conectó ni modificó `pos_multitenant`.

---

## Implementación segura del archivo de origen — 2026-10-21

Esta actualización reemplaza la descripción histórica anterior cuando difiera. Se implementó una etapa de **conservación del paquete** que precede a las importaciones operativas existentes. No se declara completa la migración de un negocio real.

### Funciones implementadas

- El exportador local v2 lee en modo `readonly` las doce tiendas Dexie conocidas: `products`, `clients`, `suppliers`, `sales`, `purchases`, `cajaSessions`, `inventory_movements`, `abonos`, `gastos`, `audit_logs`, `saleOrders` y `sync_queue`. También agrega `configuration` y categorías derivadas de productos. Mantiene la configuración comercial y las imágenes como contenido del paquete.
- El exportador clasifica el negocio por ID configurado o inferido, informa tiendas ausentes, filas heredadas y filas de otros negocios, y no escribe ni elimina datos de IndexedDB. El paquete v2 conserva etiquetas legibles de responsables; no transporta contraseñas, tokens ni credenciales.
- El endpoint autenticado del administrador de sistema valida origen/destino, alcance de negocio, tamaño, estructura y confirmación CSRF. Rechaza IDs locales ausentes/ambiguos, filas heredadas sin atribución, discrepancias entre el ID del paquete y su alcance, y cualquier fila incluida que declare otro negocio.
- La migración SQL **012** agrega `migration_import_batches` y `migration_source_records`, con FK por negocio, huella SHA-256, actor operador, estado, motivo de pendiente y payload histórico depurado. El guardado por lotes es reanudable y repetir el mismo paquete no duplica filas ni auditorías de finalización; si cambia su contenido para el mismo origen, se rechaza.
- Los estados `BLOCKED`/`ARCHIVED` describen únicamente la conservación del archivo. No existe ruta para marcarlos `COMPLETED`; el panel informa que guardar el paquete no equivale a importar las etapas comerciales. La cola local queda `PENDING` y nunca se ejecuta. Las órdenes pendientes mantienen su estado y no crean ventas.
- El payload JSON conserva importes, fechas, estados, IDs y relaciones de origen sin convertirlos en operaciones activas. Imágenes JPEG/PNG/WebP con formato `data:` se conservan solo como fuente histórica; cada imagen está limitada a 8 MiB y el cuerpo HTTP a 32 MiB. No se publica contenido como archivo de producto/logo.

### Matriz de cobertura actual

La columna “archivo íntegro” indica si los registros de origen se pueden retener en el lote 012; **no** significa que ya estén operativos en el POS conectado.

| Componente | Archivo íntegro del origen | Proyección operativa conectada | Estado global y límite |
| --- | --- | --- | --- |
| Productos, categorías, códigos, costos, precios y márgenes | Sí, con imagen incluida en el payload | Importador básico existente, con deduplicación por valores y sin mapa durable completo de IDs | **PARCIAL**: la copia íntegra permanece; revisar colisiones y asociaciones antes de usar las etapas existentes |
| Fotografías de productos y logo | Sí, si el paquete no supera sus límites | No se carga desde la migración al almacenamiento privado de imágenes ni a configuración conectada | **PARCIAL**: contenido retenido pero no presentado en el POS conectado |
| Existencias actuales | Sí | Etapa de inventario inicial existente, condicionada a producto/stock equivalente | **PARCIAL**: la etapa inicial no sustituye el historial |
| Ajustes y Kardex | Sí, se conservan eventos originales | No se reproducen en `inventory_movements` | **PARCIAL**: no se crean movimientos sintéticos adicionales desde el archivo |
| Clientes, límites de crédito y deuda inicial | Sí | Carga básica y crédito histórico existentes; deuda sin factura/límites no tienen proyección completa | **PARCIAL**: verificar deuda y límite cliente por cliente |
| Ventas, detalles, descuentos, medios, estados y anulaciones | Sí | Importador histórico de contado existente | **PARCIAL**: referencias/historial mejoraron, pero actor/caja/reversiones y estados no tienen cobertura total |
| Ventas a crédito, saldos y abonos de clientes | Sí | Importador de crédito existente con conciliación, sujeto a validaciones y referencias disponibles | **PARCIAL**: requiere conciliación integral por factura y estado |
| Proveedores y datos de compra | Sí | Carga básica e importador histórico de compras existentes | **PARCIAL**: metadatos de anulación y relaciones pueden no proyectarse por completo |
| Cuentas por pagar y pagos a proveedores | Sí, incluidos pagos con referencias, fecha y estado local | No hay proyector local de pagos a proveedores; 005 solo permite `PENDING` en el esquema conectado | **PARCIAL**: no usar este archivo como saldo operativo; necesita etapa y conciliación propias |
| Caja, aperturas, cierres, conteos y movimientos | Sí, incluidos movimientos embebidos | No se importan sesiones ni caja histórica | **PARCIAL**: no afecta efectivo actual ni crea movimientos ficticios |
| Gastos y anulaciones | Sí | No hay importador operativo | **PARCIAL**: retención histórica únicamente |
| Reversiones y correcciones | Sí como registros fuente; algunos estados se representan en importadores existentes | No hay proyección completa reversible a operación original | **PARCIAL**: ninguna fila cancelada del archivo se ejecuta |
| Órdenes pendientes y detalles | Sí | No se crean ventas conectadas | **PARCIAL**: queda pendiente hasta definir su tratamiento comercial |
| Auditoría y responsables originales | Sí, con etiquetas legibles y payload depurado | No se vincula a usuarios conectados; IDs/credenciales de usuario se eliminan del payload | **PARCIAL**: responsabilidad histórica retenida como texto, no como identidad autenticada |
| Usuarios, roles y permisos | No hay tienda de usuarios Dexie que sea segura para importar | No se importan cuentas ni hashes locales | **NO APLICA** para las credenciales locales; crear usuarios conectados por el flujo seguro de alta/activación |
| Configuración comercial | Sí como payload fuente | No se aplica automáticamente a `business_settings` | **PARCIAL**: requiere etapa de configuración con comparación previa y sin sobrescritura |
| Cola local `sync_queue` | Sí, marcada `PENDING` | Nunca se reproduce ni se combina con operaciones conectadas | **PARCIAL**: cada operación exige revisión; migración bloqueada si queda pendiente |
| Preferencias de interfaz/bloqueo local | No forman parte de los datos comerciales exportados | No aplican al inicio de sesión conectado | **NO APLICA**: no transferir bloqueos ni autoridad local |

### Pruebas de esta implementación

| Prueba enfocada | Resultado | Alcance |
| --- | ---: | --- |
| ESLint completo del repositorio | Aprobado | Sin errores de lint |
| Backend unitario | 162 aprobadas, 0 fallidas, 1 omitida | La omitida necesita un JSON local de ejemplo no disponible; se actualizó la expectativa de `basic-migration` para aceptar el paquete v2 además de v1 |
| Integración MySQL aislada | 3 aprobadas, 0 fallidas | Ejecuta el esquema y 001–012 en `pos_auth_test_*`; verifica retención de importes/fechas/estados/relaciones/imágenes, redacción de credenciales, queue no ejecutada, reintento, interrupción, aislamiento y cero filas comerciales operativas nuevas |
| Playwright conectado — archivo | 4 aprobadas | Edge, escritorios 1440 px y móvil 390 px, confirmación explícita, alcance no elegible, respuesta tardía y reinicio |
| Playwright local — exportador | 1 aprobada | Paquete v2 con todas las tiendas, configuración e imágenes; compara todas las filas antes/después y confirma que Dexie no cambia |
| Playwright local — compras históricas | 1 aprobada | Vista previa, confirmación, una sola invocación |
| Build público | Aprobado | `dist` regenerado desde los archivos públicos |
| `git diff --check` | Aprobado | Sin errores de espacios; Git mostró advertencias habituales de conversión LF/CRLF |

No se repitieron las 570 pruebas generales. Las comprobaciones de integración usan bases temporales aleatorias que el ejecutor eliminó al finalizar. No se aplicó 012 a `pos_multitenant`, no se tocó `database/schema.sql` y no se utilizó una IndexedDB real.

La ejecución local con Playwright imprimió los resultados `ok` para el exportador y la vista previa de compras, pero el proceso no cerró después de terminar los casos y fue interrumpido manualmente; por eso se reportan como casos aprobados con advertencia del runner, no como una suite con cierre limpio. La suite conectada aislada sí terminó con código cero.

### Procedimiento permitido y bloqueos antes de un cliente real

1. Mantener respaldo verificado del POS local y revisar identidad/alcance del origen. Un paquete con filas legadas, negocio ambiguo o IDs de otro negocio se detiene.
2. Generar y descargar el paquete v2 desde el perfil local; revisar los conteos y advertencias. No borrar ni alterar el POS local.
3. Crear el negocio destino y un administrador conectado con credenciales nuevas. No importar contraseñas ni cuentas locales.
4. Revisar y autorizar la migración 012 en el esquema del entorno destino con el ejecutor oficial, respaldo previo y ventana aprobada. Esta auditoría solo probó 012 en bases temporales.
5. Guardar el paquete en el destino y ejecutar las etapas existentes de catálogo, stock inicial, ventas, crédito y compras con sus vistas previas, en el orden indicado por cada bloqueo. Reintentar siempre con el mismo paquete.
6. **No migrar un cliente real aún.** Antes deben implementarse y conciliarse las proyecciones de movimientos de inventario, pagos a proveedores/CxP, caja/cierres, gastos, anulaciones/reversiones, órdenes, configuración e imágenes; también hace falta mapa durable de IDs para el catálogo y enlace controlado de responsables.
7. Añadir un orquestador durable que registre el resultado de cada proyección y una conciliación final independiente. Hoy no existe ruta para pasar un lote a `COMPLETED`, por lo que `ARCHIVED` no es aceptación de migración.

### Riesgos y estado de bases

- El JSON transferido no está firmado por el navegador local. Su SHA-256 da identidad y detecta cambios entre vista previa/reintento, pero no autentica quién generó el archivo; el administrador debe verificar el negocio de origen por un canal independiente.
- Datos personales, financieros e imágenes se almacenan dentro del archivo histórico MySQL, con acceso restringido a administrador de sistema. Falta definir caducidad/retención y tamaño para despliegues productivos.
- Los límites actuales del endpoint (32 MiB por paquete y 8 MiB por imagen) excluyen paquetes mayores; se necesita transporte por fragmentos antes de aceptar negocios que excedan ese tamaño.
- El importador básico existente todavía puede deduplicar por nombre/código sin relación durable de origen. La etapa 012 preserva filas originales, pero no resuelve por sí sola esa asociación operativa.
- **Base principal `pos_multitenant`: sin cambios en esta tarea.** No se abrió para lectura/escritura ni se ejecutaron migraciones. La 012 queda preparada únicamente en código y probada en bases temporales. `database/schema.sql` permanece intacto; no se hizo commit/reset/clean y no se modificó `stash@{0}`.

## Consulta de archivo en módulos y conciliación parcial — 2026-10-22

### Cambios realizados

- Se agregó `GET /api/migration-history/:module`, de solo lectura. El negocio se obtiene exclusivamente de la sesión autenticada; el cliente no puede seleccionar el `business_id`. El servicio exige el permiso del módulo correspondiente, valida que el esquema 012 esté completo, limita páginas a 100 registros y no guarda ni cambia estados.
- Se muestran los registros archivados desde Inventario/Kardex, Compras, Cuentas por pagar, Clientes/Créditos, Historial de ventas, Caja, Gastos, Reportes y Configuración. Los estados originales, responsables como texto, importes, fechas y detalles disponibles permanecen visibles como referencia. Las imágenes no se devuelven como bytes al navegador.
- Cada módulo aclara que la copia no afecta existencias, caja, saldos ni reportes actuales. Un registro archivado no se presenta como operativo.
- La conciliación de esta capa compara el conteo completo conservado con el manifiesto del archivo y los conteos por entidad del módulo. Devuelve diferencias con origen, entidad, esperado y encontrado. Como los importadores existentes todavía no enlazan cada fila del lote 012 con un destino, `operationalComparison` permanece `NOT_RUN` y `complete` siempre es `false`.
- Si falta una tabla o columna requerida de 012, la consulta responde como no disponible. No se creó una migración 013: esta capa reutiliza 012.

### Matriz de cobertura verificable al 2026-10-22

| Área | Archivo 012 | Disponible en módulo conectado | Proyección operacional conciliada | Estado global |
| --- | --- | --- | --- | --- |
| Productos, categorías, códigos, costos, precios y márgenes | Conservado | Resumen de origen en Inventario | El importador básico previo no aporta un mapa durable completo desde el lote | **PARCIAL** |
| Imágenes de productos y logo | Bytes retenidos en el JSON | Se indica que existe imagen | No se crea archivo persistente ni referencia servida por el almacén de imágenes | **PARCIAL** |
| Existencia inicial | Conservada | Producto de origen visible | Existe etapa previa de stock inicial; conciliación integral con paquete 012 no implementada | **PARCIAL** |
| Ajustes y Kardex | Conservados con cantidades, fechas y texto | Consulta de solo lectura en Inventario | No se enlazan a movimientos operativos ni se vuelven a aplicar | **PARCIAL** |
| Clientes, límites y deuda | Conservados | Consulta en Clientes | La representación total de límites/deudas no se compara contra el destino en esta capa | **PARCIAL** |
| Ventas, líneas, descuentos, estados y anulaciones | Conservados | Consulta en Historial | Hay importador previo de ventas; faltan enlace 012 y conciliación completa de cada campo/estado | **PARCIAL** |
| Créditos y abonos de clientes | Conservados | Consulta en Clientes/Historial | Hay importador previo de crédito; falta enlace del archivo 012 y conciliación integral | **PARCIAL** |
| Compras y proveedores | Conservados | Consulta en Compras | La proyección histórica existente no queda coordinada por el lote 012; no se avanzó el flujo de compras | **PARCIAL** |
| Cuentas por pagar y pagos a proveedores | Conservados | Consulta por módulo | No hay proyección desde 012 ni conciliación de saldo/método | **PARCIAL** |
| Caja, aperturas, cierres y movimientos | Conservados, incluso movimientos embebidos | Consulta en Caja | Solo archivo; no se crean sesiones ni movimientos conectados | **PARCIAL** |
| Gastos y anulaciones | Conservados | Consulta en Gastos | Solo archivo; no se contabilizan como egreso nuevo | **PARCIAL** |
| Reversiones y correcciones | Conservadas como fuente | Visibles en los módulos asociados | No hay enlace reversible a la operación conectada | **PARCIAL** |
| Órdenes pendientes | Conservadas con estado y detalles | Visibles en Historial | No se transforman en ventas ni se enlazan a órdenes conectadas | **PARCIAL** |
| Auditoría y responsables | Conservados como etiqueta depurada | Consulta desde Reportes | No se vinculan automáticamente a usuarios conectados | **PARCIAL** |
| Usuarios, roles, permisos y credenciales locales | Se descartan credenciales sensibles; no existe tienda Dexie segura que importar | No se muestran como cuentas | Alta de cuenta conectada debe seguir el flujo seguro de usuarios | **NO APLICA** para credenciales locales |
| Configuración comercial | Conservada, incluidas referencias de logo | Consulta desde Configuración | No se aplica desde el archivo 012 ni se coteja con `business_settings` | **PARCIAL** |
| `sync_queue` | Conservada como pendiente | No se ejecuta | Cada operación exige revisión manual; no se reproduce | **PARCIAL / BLOQUEANTE** |

### Pruebas enfocadas de esta continuación

| Prueba | Resultado | Verificación |
| --- | ---: | --- |
| ESLint completo | Aprobado | Sin errores ni advertencias |
| Pruebas unitarias backend | 165 aprobadas, 0 fallidas, 1 omitida | La omitida requiere un JSON local de ejemplo no disponible |
| Pruebas unitarias nuevas de historial | 3/3 | Alcance por módulo, eliminación de bytes de imagen y esquema anterior a 012 |
| Integración MySQL temporal `--migration-history-only` | 4/4 | Instalación 001–012, consulta por negocio, rechazo sin permiso, paginación, lectura sin escrituras y detección de diferencia de conteos |
| Playwright conectado enfocado | 1/1 | Historial visible en móvil, conciliación pendiente explícita, bytes de imagen no enviados, cero escrituras operativas; una segunda página local confirma paneles ocultos y cero llamadas al endpoint |
| Playwright local independiente | Inconcluso | El runner raíz quedó detenido tras iniciar el caso y fue interrumpido; la verificación del modo local sí pasó en la página local de la prueba conectada aislada |
| Build público | Aprobado | Incluye `connected-migration-history.js` desde `dist` |

La primera ejecución de Playwright falló por una diferencia de mayúsculas en la expectativa del mensaje, no por la aplicación. Se corrigió la expectativa y la segunda ejecución terminó aprobada. Una integración intermedia detectó que faltaba trasladar a la respuesta el total del lote; se corrigió y la ejecución final fue 4/4. Las bases de integración temporales fueron creadas con nombres `pos_auth_test_*` aleatorios y eliminadas por el ejecutor. No se ejecutaron operaciones comerciales en `pos_multitenant`.

### Revisión de interfaz

Se aplicó la skill del proyecto `.agents/skills/emil-design-eng/SKILL.md` para jerarquía, accesibilidad, foco, mensajes y adaptación móvil.

| Before | After | Why |
| --- | --- | --- |
| Los datos del lote 012 solo se podían consultar desde el panel del administrador de sistema | Cada módulo muestra su sección de historial de origen al usuario autenticado con permiso para ese módulo | El dato queda localizable donde el cliente espera encontrarlo y conserva el control por negocio |
| Un archivo conservado podía confundirse con una importación completa | Se informan por separado la integridad del archivo, los registros sin enlace y que la conciliación operativa sigue pendiente | No se sugiere que las tablas o los cálculos actuales ya incluyan esos datos |
| Las imágenes estaban incrustadas en el archivo de origen | La interfaz indica su presencia sin transmitir los bytes al navegador | Evita publicar contenido antes de validar y guardar el archivo de forma persistente |

### Bloqueos pendientes y conclusión

- **No es posible trasladar un negocio completo sin pérdida funcional todavía.** El historial ahora se consulta en los módulos, pero sigue siendo una vista de referencia del JSON. Caja, gastos, pagos a proveedores, Kardex completo, órdenes, anulaciones, configuración, imágenes y auditoría no cuentan con proyección y conciliación operativa desde el lote 012.
- No se implementó un orquestador durable de etapas ni enlaces fuente→destino desde cada importador. Tampoco existe conciliación por importes, relaciones, saldos, fechas, responsables e imágenes; por eso el lote nunca puede declararse completo.
- Las imágenes siguen en el payload JSON: no están almacenadas como archivos persistentes. La configuración comercial tampoco se aplica automáticamente para no sobrescribir datos ya existentes.
- La comparación de conteos detecta inconsistencias del archivo, pero no demuestra igualdad con las tablas operativas. Los abonos por tipo requieren una comparación de origen específica porque el manifiesto actual no separa pagos a clientes de pagos a proveedores.
- El visor y la API requieren 012. Como 012 no está aplicada en la base principal, `pos_multitenant` no obtiene esta capacidad hasta una autorización independiente y una aplicación aprobada de esa migración.
- **Base principal `pos_multitenant`: sin modificaciones.** No fue consultada ni escrita, no se ejecutó 012/013, `database/schema.sql` quedó intacto y no se alteraron el stash ni cambios existentes.


## Aclaracion obligatoria del flujo local a conectado - 2026-10-22

### Flujo implementado y limites

1. El POS local conserva su exportador: genera y descarga un paquete JSON de solo lectura. No se agrego conexion directa a MySQL ni sincronizacion continua.
2. El administrador general crea el destino desde el panel de migracion con estado INACTIVE/PENDING, carga el archivo entregado por el cliente y revisa el origen y el destino.
3. El resumen del panel conectado usa solo el JSON seleccionado. Se retiraron de esa pantalla las lecturas de Dexie, IndexedDB y localStorage.
4. El archivo solo se acepta en un destino creado para migracion. El nombre normalizado del negocio debe coincidir con el origen del paquete; una segunda identidad de origen se rechaza. El lote conserva huellas, claves locales y su aislamiento por business_id; los reintentos usan el mismo lote.
5. El estado PENDING bloquea login, sesiones y activacion desde administracion. El lote archivado no se marca como completo ni activa el negocio.

La migracion 013 crea el control persistente por negocio y referencia el lote 012 y al administrador actor. Solo agrega una tabla y claves foraneas; no altera filas existentes ni database/schema.sql. Se agrego al catalogo del ejecutor oficial. Se aplico unicamente en la base temporal de integracion, que el ejecutor elimino al terminar. No existe aun una operacion que pase el control a COMPLETE: falta completar las proyecciones operativas y la conciliacion independiente. Por seguridad, los nuevos destinos no se pueden usar comercialmente.

### Cobertura actual tras esta continuacion

| Componente | Estado | Motivo |
| --- | --- | --- |
| Descarga del paquete local JSON | PARCIAL | Se conserva el exportador; la prueba automatizada local quedo inconclusa por bloqueo del runner de Playwright. |
| Carga exclusiva por administrador general | PARCIAL | El panel admite el archivo y guarda un lote seguro; aun no importa toda la informacion a tablas operativas. |
| Identidad del origen y aislamiento del destino | PARCIAL | Se valida el nombre, origen estable, huellas y scope; el archivo no esta firmado y requiere verificacion del administrador. |
| Catalogo, clientes y proveedores | PARCIAL | Se preservan; falta proyeccion integral coordinada por el lote con mapa durable de IDs. |
| Ventas, compras, creditos y abonos | PARCIAL | Hay importadores anteriores por etapa; no estan coordinados con el lote unico ni con una conciliacion integral. |
| Kardex, caja, cierres, gastos, CxP, pagos a proveedores y reversiones | PARCIAL | El archivo conserva historial, pero no se proyecta a una representacion operativa conciliada. |
| Ordenes pendientes y auditoria | PARCIAL | Se conservan como origen; no tienen enlaces operativos verificados. |
| Imagenes y logo | PARCIAL | Permanecen en el JSON historico; falta publicacion en almacenamiento persistente y comprobar referencias. |
| Configuracion comercial | PARCIAL | Se conserva como origen; falta aplicarla de forma segura al destino y cotejarla. |
| Usuarios y credenciales locales | NO APLICA | No se copian contrasenas; las cuentas conectadas se crean con credenciales nuevas. |
| Activacion del negocio | BLOQUEADA | No hay conciliacion completa ni transicion autorizada a COMPLETE. |

### Pruebas de esta continuacion

| Verificacion | Resultado |
| --- | --- |
| ESLint de todo el repositorio | Aprobado, sin errores ni advertencias. |
| Pruebas unitarias backend | 166 aprobadas, 0 fallidas, 1 omitida por falta del JSON local de ejemplo. |
| Integracion MySQL --migration-archive-only | 4/4 aprobadas; migraciones 001-013, archivado idempotente, reanudacion, origen unico y destino bloqueado. La base temporal pos_auth_test_* se elimino. |
| Playwright conectado del panel de migracion | 6/6 aprobadas en Edge; escritorio, movil, confirmacion, nombre/origen, creacion de destino bloqueado y cero lecturas de IndexedDB/configuracion local. Base temporal eliminada. |
| Playwright local del exportador | Inconcluso: el runner quedo detenido despues de iniciar el caso y se interrumpio. Solo usa Dexie sintetico en prueba; no se abrio la IndexedDB real. |
| Build publico | Aprobado con node scripts/build-static.cjs. |
| git diff --check | Aprobado; Git solo reporto avisos habituales LF/CRLF. |

### Estado de produccion

No se puede migrar un negocio real sin riesgo de perdida funcional. Se puede validar y archivar el JSON desde el panel del administrador general, pero todavia no se transforma y concilia el 100 por ciento del historial en los modulos operativos. Antes del primer cliente hacen falta: orquestador reanudable de todas las etapas, mapas de IDs de origen a MySQL, proyecciones de caja/gastos/CxP/Kardex/anulaciones/ordenes/configuracion, almacenamiento persistente de imagenes y conciliacion por valores, relaciones, saldos, fechas y estados. Solo la conciliacion aprobada debe permitir cambiar el control a COMPLETE y activar el negocio.

La base principal pos_multitenant no fue consultada ni modificada; no se aplico 012 ni 013. database/schema.sql permanece sin cambios. No se hicieron commit, reset ni clean, y no se alteraron el stash ni las modificaciones existentes.

### Secuencia visible del panel de administrador general

El panel presenta primero la creacion del negocio destino, luego su seleccion y despues la carga del JSON recibido del cliente. El selector solo muestra destinos `INACTIVE/PENDING`; no ofrece negocios activos para esta importacion. La confirmacion guarda el paquete historico y comunica que la importacion operativa y la conciliacion siguen pendientes. El destino permanece bloqueado.

## Selección segura de negocios existentes y auditoría UTF-8 - 2026-10-22

### Política de destinos existentes

- El panel del administrador general ofrece **Seleccionar negocio existente** y **Crear negocio nuevo**. Ambos caminos producen un destino `INACTIVE/PENDING`; el selector final solo contiene destinos pendientes y excluye el negocio de sistema con ID `1`.
- La inspección es de solo lectura. El servidor consulta todas las tablas base que tienen `business_id`; cualquier fila comercial bloquea el destino. También bloquean filas de tablas nuevas que no tengan una clasificación conocida. Se informan los módulos y cantidades detectados.
- Antes de preparar el destino se vuelve a inspeccionar dentro de una transacción con bloqueo de la fila del negocio. Si aparece una operación, la transacción no cambia el estado, los usuarios ni los ajustes.
- Con confirmación explícita, el negocio activo pasa a `INACTIVE`, se revocan sus sesiones y permisos de sesión, y se crea el control `PENDING` en la misma transacción. Se conserva el mismo `business_id`, nombre, usuarios, configuración, auditoría, suscripción y datos de contacto. El sistema no borra usuarios ni ajustes y no activa el negocio al terminar.
- El endpoint requiere administrador general autenticado; la preparación usa CSRF. Una inspección o preparación para el ID `1`, una cuenta de negocio ordinaria, un destino ya reservado o un destino con operaciones se rechaza.
- La selección/preparación no importa el JSON ni declara completa la migración. La proyección operativa, conciliación total y transición a `COMPLETE` continúan pendientes según la matriz anterior.

### Requisito de esquema y mensaje de protección

La creación y la inspección segura verifican la presencia de las tablas necesarias de archivo y bloqueo de las migraciones 012 y 013, además del esquema operativo requerido. Si falta alguna, la API responde con HTTP 503 y el mensaje: **“Para usar la importación segura deben aplicarse las migraciones 012 y 013 en el servidor. No se modificó ningún negocio.”** La validación no se oculta ni se omite. Según el contexto confirmado por el propietario, 012 y 013 no están aplicadas en `pos_multitenant`; no consulté ni ejecuté cambios en esa base. Por tanto, el nuevo flujo no puede habilitarse allí hasta una autorización y aplicación separada de esas migraciones.

### Codificación

El problema observado estaba en literales de texto fuente con UTF-8 doblemente decodificado y en dos textos con el carácter de reemplazo Unicode; no se encontró una causa de transporte en Express. El HTML declara UTF-8, `res.json()` sirve JSON como UTF-8 y el paquete local JSON y CSV declaran UTF-8. Se repararon los literales afectados sin reescribir datos guardados por clientes. El CSV existente mantiene BOM; Excel usa cadenas Unicode de SheetJS y el contenido del ticket se pasa al generador PDF como HTML del navegador.

Se añadió `npm run check:encoding`. Recorre archivos de texto del proyecto con decodificación UTF-8 estricta y detecta patrones de doble codificación, signos de apertura/comillas tipográficas y emojis mal decodificados, U+FFFD y sustituciones españolas comunes con `?`. Los directorios de compilación y resultados de pruebas se omiten. El detector no imprime fragmentos de líneas para evitar filtrar texto de archivos inspeccionados. Las pruebas cubren caracteres españoles válidos, consultas con `?` ordinarias y patrones dañados.

### Revisión visual

| Antes | Después | Motivo |
| --- | --- | --- |
| Solo se podía crear un destino nuevo. | Se puede revisar un negocio existente o crear uno nuevo; las dos opciones dejan un destino bloqueado. | Acepta clientes con negocio conectado ya creado, conservando su identidad. |
| El selector final mezclaba la decisión del destino con la preparación. | El panel separa selección, revisión, confirmación y elección del destino ya preparado. | Hace visible el estado de seguridad antes de cargar el JSON. |
| El error mencionaba una protección sin indicar el requisito. | El mensaje enumera las migraciones 012 y 013 y dice que no se modificó ningún negocio. | Permite al administrador resolver el requisito sin retirar controles. |

### Pruebas enfocadas de esta corrección

| Verificación | Resultado |
| --- | --- |
| ESLint completo | Aprobado. |
| Pruebas unitarias backend | 174 aprobadas, 0 fallidas y 1 omitida por falta del JSON local de ejemplo. |
| Integración MySQL de migraciones/archivo/destinos | 7/7 aprobadas en una base temporal `pos_auth_test_*`; el runner eliminó la base. Incluye destino existente con usuarios/ajustes, rechazo de operaciones, ID estable, sesiones revocadas, CSRF y respuesta JSON UTF-8. |
| Playwright conectado | 5/5 aprobadas en Edge con MySQL temporal; incluye negocio existente en 1440 px y 390 px, bloqueo por operaciones, mensaje 012/013 y creación de negocio nuevo. La base temporal se eliminó. |
| Playwright local | 3 pruebas enfocadas aprobadas: descarga del JSON sin modificar Dexie, configuración/ticket/PDF y CSV UTF-8; además se verificó el exportador XLSX. El navegador usó estado de prueba aislado. |
| Detector de codificación | Aprobado; 233 archivos de texto UTF-8 revisados, sin patrones dañados. |
| Compilación pública | Aprobada mediante `node scripts/build-static.cjs`. |
| `git diff --check` | Aprobado. |

### Estado de datos y producción

No se consultó ni modificó `pos_multitenant`; tampoco se ejecutaron migraciones ni operaciones comerciales en bases reales. `database/schema.sql` sigue intacto. No se creó una nueva migración SQL. Las migraciones 012 y 013 siguen pendientes en la base principal de acuerdo con el contexto proporcionado.

El flujo de selección y reserva de destino está implementado y probado en MySQL temporal. El POS todavía **no está preparado para trasladar un negocio real completo**: las proyecciones operativas y la conciliación detallada del JSON siguen pendientes. No debe activarse ningún destino hasta que esas funciones y la conciliación pasen sus pruebas.

## Investigación del identificador local compartido (2026-10-22)

### Causa comprobada antes de cambiar el comportamiento

`app.js` crea las bases Dexie locales en las versiones 9 y 10. La versión 10 agrega `saleOrders`; no hay una versión que asigne una identidad local exclusiva. Al crear productos, clientes, proveedores, ventas, compras, abonos, sesiones de caja, gastos, movimientos de inventario y auditoría, los flujos locales escriben el mismo valor fijo `00000000-0000-0000-0000-000000000000` en `business_id` (`DEFAULT_BUSINESS_ID`). Por separado, la configuración comercial se guarda en `localStorage.posSystemConfig`, pero el esquema de configuración anterior no genera ni persiste `localBusinessId`.

`local-migration-export.js` lee la configuración y todas las tiendas Dexie en modo `readonly`. Descarta el UUID cero al buscar identificadores de negocio únicos. Si no hay otro ID ni uno configurado, deja `businessId` vacío y cuenta como `legacyRecords` cada fila cuyo `business_id` falta o es el UUID cero. `makeWarnings()` usa ese conteo para producir “No se pudo confirmar un ID local exclusivo”. Por tanto, el mensaje no indica un error de lectura ni una fila con ID numérico 127: `127` es la cantidad agregada de filas heredadas exportadas.

Los conteos informados para el paquete dan exactamente 127: productos 4, clientes 4, proveedores 4, ventas 28, compras 6, caja 5, movimientos de inventario 69 y abonos 7. La suma coincide con el algoritmo y con los conteos comunicados, pero no se inspeccionó el JSON real ni la IndexedDB del cliente. El código disponible no aporta evidencia suficiente para afirmar que esas filas pertenecen todas a la misma empresa, ni evidencia de que estén mezcladas: los IDs compartidos no distinguen entre esos escenarios. La configuración actual entrega datos comerciales del negocio, pero esos datos no están asociados individualmente a las filas y un nombre coincidente no prueba pertenencia.

El exportador actual conserva filas sin ID o con el UUID fijo dentro del paquete y marca el conteo agregado como advertencia; no muestra distribución por módulo ni referencias para su revisión. Filas con otro ID concreto se excluyen del conjunto principal y solo se cuenta su número. La previsualización administrativa muestra las advertencias, y `system-admin-migration-archive.js` bloquea el archivo de cualquier paquete con filas heredadas o identificadores de otro negocio. No hay una revisión de procedencia por fila ni una decisión de inclusión/exclusión registrada. Ese bloqueo evita la mezcla automática, pero deja los 127 registros sin un flujo de resolución.

### Alcance de las versiones locales observadas

En el código actual, Dexie declara solamente `version(9)` para las tiendas comerciales y `version(10)` para `saleOrders`. No hay callbacks de upgrade que reconstruyan identidad histórica. Las instalaciones que ya tienen la base en esas versiones conservan sus filas y el UUID cero; al introducir una identidad estable futura no se debe reescribir ese historial para hacer desaparecer la advertencia.

## Identidad local y revisión de registros antiguos - 2026-10-22

### Causa y alcance confirmado

El aviso sobre los 127 registros era un conteo, no un identificador numérico de fila. La lógica anterior sumaba cada registro que tenía `business_id` vacío o el UUID compartido `00000000-0000-0000-0000-000000000000`. Las cantidades comunicadas (4 productos, 4 clientes, 4 proveedores, 28 ventas, 6 compras, 5 sesiones de caja, 69 movimientos de inventario y 7 abonos) suman 127. No se recibió ni abrió el JSON real y no se accedió al navegador del cliente; por ello no se puede afirmar que esos registros pertenezcan todos a un negocio, ni que estén mezclados. La identidad compartida no permite distinguirlo.

### Cambios realizados

- En una instalación local sin identidad persistente, el POS genera un UUID con Web Crypto y lo conserva en `localStorage.posSystemConfig.localBusinessId`. Las escrituras locales ya existentes usan `DEFAULT_BUSINESS_ID`, que ahora toma ese valor estable. Las exportaciones posteriores conservan el mismo ID. Si el navegador no permite persistirlo, el POS no presenta un ID temporal como identidad estable y los registros quedan sujetos a revisión.
- No se modifican IDs de filas existentes. Los registros con UUID compartido o sin ID permanecen intactos y se incluyen en el JSON. La exportación muestra conteos y referencias por módulo, identificadores repetidos, relaciones sin correspondencia y filas con otro ID concreto.
- La revisión de paquetes antiguos calcula esa información a partir de las filas cuando falta el resumen nuevo. El servidor vuelve a calcularla y no confía en los conteos de `source.scope` enviados por el navegador. Solo se usan los campos explícitos `localBusinessId` del paquete; un `business.id` genérico no se toma como identidad del POS local.
- Las relaciones de líneas de venta/compra contemplan los formatos observados del POS, incluido `items[].id` como referencia de producto cuando no existe `productId`.
- Las filas con identidad compartida quedan pendientes y no pasan a operaciones comerciales. La vista del administrador muestra el módulo, referencia y contexto disponible. Después de guardar el paquete como archivo pendiente, una decisión individual queda registrada con usuario, hora y referencia documental. Para incluir una fila se requieren tanto una referencia escrita como una confirmación explícita del administrador; excluirla también requiere indicar el motivo. Si la fila tiene ID duplicado o relación inconsistente, la decisión de pertenencia no elimina esos otros bloqueos.
- Los IDs concretos de otro negocio y un alcance que declara filas excluidas activan un bloqueo de seguridad; el servidor no permite guardar el paquete junto al destino como si fuera un único origen. El nombre comercial ayuda a la revisión, pero no acredita identidad. El mismo archivo canónico repetido se reconoce mediante su huella y reanuda el lote sin duplicar sus filas.
- El JSON que entrega el cliente no se reescribe. El servidor conserva un archivo histórico sanitizado y una huella canónica; no almacena una copia byte por byte del archivo recibido. El administrador debe conservar el JSON original fuera del POS junto con la evidencia documental. Las decisiones ingresadas son una constancia del administrador, no una verificación automática de documentos externos.

### Cobertura de esta corrección

| Caso | Estado | Evidencia / límite |
| --- | --- | --- |
| ID persistente en futuras operaciones locales | COMPLETO | El ID se genera una vez, se conserva en la configuración local y se usa en `DEFAULT_BUSINESS_ID`; navegador de prueba y recarga comprobados. |
| Registros antiguos con ID compartido o ausente | PARCIAL | Se conservan y desglosan; permanecen pendientes hasta revisión. No se reasignan automáticamente. |
| Dos IDs concretos en un mismo archivo | BLOQUEADO | El paquete no se archiva junto al destino mientras existan identidades mezcladas o excluidas. La separación/procedencia debe resolverse antes. |
| Relaciones, IDs locales repetidos y referencias faltantes | PARCIAL | Se detectan y muestran; las referencias inconsistentes mantienen el registro pendiente. |
| Reintento del mismo archivo | COMPLETO para archivo | Huella estable, lote por `business_id` y claves de origen evitan duplicados en el archivo. No equivale a idempotencia de una importación operativa aún no implementada. |
| Proyección a ventas, compras, caja, inventario y saldos | AUSENTE en este flujo | Esta corrección solo identifica y archiva de forma segura; no completa la migración operativa ni la conciliación financiera. |
| JSON real reportado con 127 filas | PENDIENTE DE REVISIÓN | Sin el archivo y evidencia del negocio no se puede decidir su pertenencia. No debe aprobarse a ciegas ni declararse completo. |

### Pruebas enfocadas

| Verificación | Resultado |
| --- | --- |
| ESLint de todo el repositorio | Aprobado, sin errores. |
| Pruebas unitarias backend | 176 aprobadas, 0 fallidas y 1 omitida porque el JSON local de ejemplo no está disponible en este checkout. |
| Pruebas unitarias de archivo/API | 14/14 aprobadas; clasificación de identidad, IDs duplicados/faltantes, aislamiento, redacción de credenciales y confirmación explícita. |
| MySQL `--migration-archive-only` | 8/8 aprobadas en `pos_auth_test_*`; incluye lote antiguo, revisión individual, aislamiento, reintento y ausencia de filas comerciales. El ejecutor eliminó la base temporal. |
| Playwright local de exportación | 3/3 aprobadas en Edge con Dexie sintético; comprueba UUID estable tras recargar, conserva los 127 registros de prueba con desglose por módulo y confirma que la generación no modifica Dexie. |
| Playwright conectado del panel de migración | 11/11 aprobadas en Edge con MySQL temporal; escritorio/móvil, selección de destino, paquete heredado, evidencia y confirmación para incluir, errores y protecciones. Base temporal eliminada. |
| Detector de codificación UTF-8 | Aprobado; 233 archivos de texto revisados, sin patrones sospechosos. |
| Build público | Aprobado con `node scripts/build-static.cjs`. |
| `git diff --check` | Aprobado antes de los últimos cambios; se vuelve a ejecutar al cierre. |

### Revisión de interfaz

Se usó la skill del proyecto `.agents/skills/emil-design-eng/SKILL.md` para revisar jerarquía, accesibilidad y diseño móvil.

| Before | After | Why |
| --- | --- | --- |
| Un número agregado advertía sobre los registros sin mostrar dónde estaban. | Se ven cantidades por módulo, referencias y relaciones dudosas en el exportador y el panel administrativo. | Permite revisar evidencia concreta sin reasignar filas históricas. |
| La inclusión podía registrarse solo con una nota escrita. | Para incluir una fila, el administrador anota la referencia documental y marca una confirmación explícita; el servidor vuelve a validar la confirmación y la registra en auditoría. | Reduce inclusiones accidentales y deja la responsabilidad revisable. |
| Un paquete histórico podía confundirse con datos listos para operar. | Los registros ambiguos quedan pendientes y el negocio permanece bloqueado; las diferencias de relación/duplicidad siguen pendientes después de revisar pertenencia. | Evita presentar el archivo como migración completa. |

### Pendientes y estado de bases

- El archivo reportado con 127 filas no fue proporcionado. No puedo establecer si esas filas pertenecen al mismo negocio; se requiere que el administrador contraste RUC, documentos y referencias visibles antes de cualquier decisión por registro.
- Si existen IDs concretos de otro negocio, la importación del paquete completo se bloquea. El JSON actual del cliente debe exportarse nuevamente con el exportador actualizado para que la distribución y el alcance de identidad queden declarados; aun así, esos datos no se convierten automáticamente en operaciones.
- El almacenamiento histórico de la migración 012/013 no está habilitado en la base principal según el contexto del proyecto. Esta tarea no consultó ni modificó `pos_multitenant`, no aplicó migraciones y no cambió `database/schema.sql`.
- La importación operativa integral, la conciliación financiera y la activación comercial siguen pendientes. La corrección de identidad no demuestra conservación de saldos ni completa la migración de negocio.
- No se hicieron commit, reset ni clean; no se alteró `stash@{0}` ni se descartaron modificaciones existentes.

## Proyección operativa parcial del paquete local — 2026-10-22

### Resultado implementado

El panel del administrador general tiene ahora una etapa que proyecta a tablas usadas por los módulos conectados los registros aprobados de productos, clientes y proveedores, junto con los ajustes comerciales. La ruta es exclusiva del administrador general, valida el negocio y lote enlazados, rechaza el negocio del sistema y solo opera sobre un destino INACTIVE con control PENDING. No activa el negocio ni cambia el estado del control de migración.

Los productos quedan en `products` con código de barras (o una referencia determinística si el origen no tenía código), categoría, costo, márgenes, precios, existencias actuales, mínimo, impuesto, estado e imagen persistente. Las imágenes y el logo pasan por validación MIME/contenido, normalización, límites de tamaño y almacenamiento privado por negocio. La referencia de archivo es determinística por lote y registro, por lo que el reintento usa el mismo archivo.

Clientes y proveedores quedan en sus tablas operativas, con los campos comerciales representables y referencias de origen enlazadas a sus IDs nuevos dentro de `migration_source_records`. Se conserva el límite de crédito. No se copia ningún usuario ni credencial del paquete. La configuración central inserta o completa campos vacíos del destino; los valores ya existentes se conservan y cualquier diferencia deja la conciliación pendiente. La moneda continúa en C$.

El panel informa catálogo disponible, imágenes guardadas, conteos por módulo que siguen archivados, registros pendientes de identidad/validación y diferencias de conciliación. La conciliación valida por campo los enlaces operativos y los valores del catálogo, configuración e imágenes; una diferencia de valor se informa aunque coincidan las cantidades. Las filas fuente mantienen su huella, identidad y enlace al ID MySQL. La etapa no declara completa la migración; el destino sigue inactivo y bloqueado.

Las ventas, compras, sesiones y movimientos de caja, Kardex, abonos, gastos, auditoría y órdenes pendientes del paquete continúan preservados como filas del archivo histórico. Esta etapa no las reproduce en módulos operativos ni genera salidas/entradas financieras o de inventario. Los saldos iniciales de clientes sin factura equivalente quedan pendientes y no alteran el saldo. Categorías sin productos asociados también quedan pendientes porque no existe una tabla operativa de categorías independiente.

### Matriz de cobertura actual

| Módulo | Estado | Resultado verificable / pendiente |
| --- | --- | --- |
| Productos y precios | PARCIAL | Filas aprobadas y campos comerciales visibles en `products`; falta integrar referencias de operaciones históricas y conciliación integral. |
| Existencias actuales | PARCIAL | Se copia el saldo inicial del producto sin crear un movimiento artificial; falta el Kardex histórico. |
| Categorías | PARCIAL | La categoría del producto queda operativa; categorías vacías no tienen entidad conectada y bloquean conciliación. |
| Clientes | PARCIAL | Campos y límite de crédito quedan operativos; saldo inicial no respaldado por facturas queda pendiente. |
| Proveedores | PARCIAL | Datos operativos básicos quedan disponibles; faltan compras y pagos enlazados. |
| Configuración, comprobantes y logo | PARCIAL | Datos representables y archivos persistentes; conflictos con datos existentes se informan y no se sobrescriben. |
| Ventas y detalles | PARCIAL | Se conservan en el archivo histórico; no se proyectan desde este flujo ni se concilian contra ventas operativas. |
| Créditos y abonos de clientes | PARCIAL | Se conservan en el archivo; falta enlazar facturas, saldos, pagos y estados en las tablas operativas desde el lote. |
| Compras, cuentas por pagar y pagos | PARCIAL / BLOQUEADO | Solo archivados en este flujo. La fase de compras conectadas permanece detenida hasta la revisión de PHASE53 y la validación requerida por AGENTS.md. |
| Caja, cierres y gastos | PARCIAL | Solo archivados. No se generan movimientos artificiales ni se altera efectivo. |
| Kardex, ajustes y anulaciones | PARCIAL | Solo archivados; las existencias actuales no se modifican después de la proyección del catálogo. |
| Órdenes pendientes | PARCIAL | Solo archivadas; no se convierten en ventas cobradas. |
| Usuarios, roles y contraseñas locales | AUSENTE | No se importan. Requiere creación/activación segura de credenciales en el destino; contraseñas del origen se descartan. |
| Conciliación integral y activación | AUSENTE | No hay cierre de lote que compare todos los módulos y pase el control de `PENDING` a `COMPLETE`; el negocio no se puede activar por esta importación. |

### UI review

Se aplicó `.agents/skills/emil-design-eng/SKILL.md` a la modificación de interfaz, preservando el panel y sus controles existentes.

| Before | After | Why |
| --- | --- | --- |
| El resultado mostraba los conteos del catálogo y una cantidad de registros por revisar. | También enumera ventas, compras, caja, inventario, abonos, gastos, auditoría y órdenes que siguen esperando una etapa operativa; informa las diferencias de conciliación. | Distingue los datos disponibles en los módulos normales de los que solo están archivados. |
| Un catálogo podía coincidir por cantidad aunque un campo hubiese cambiado. | La conciliación compara valores por campo y devuelve origen, módulo, campo esperado y encontrado. | No permite que una igualdad de conteos oculte un cambio de precio, existencia o dato comercial. |

### Pruebas de esta etapa

| Verificación | Resultado |
| --- | --- |
| ESLint completo | Aprobado. |
| Pruebas unitarias backend | 178 aprobadas, 0 fallidas y 1 omitida por falta del JSON local de ejemplo. |
| Integración MySQL de migraciones, archivo, destino y proyección | 10/10 aprobadas en `pos_auth_test_*` temporal. El lote ficticio incluía ventas, compras, abonos, caja, inventario, gastos, auditoría y órdenes; se comprobó que no crearan operaciones financieras/inventario, que el reintento no duplicara y que una diferencia de existencias se detectara. La base temporal se eliminó. |
| Playwright conectado del panel | 2/2 aprobadas en Microsoft Edge, escritorio y móvil; comprobaron el resumen de catálogo y etapas pendientes. La base temporal se eliminó. Chromium de Playwright no está instalado; Edge disponible se usó como navegador. |
| Playwright local del exportador | Los 3 casos reportaron `ok` (exportación sin modificar Dexie, identidad persistente y exportación antigua), pero el proceso quedó esperando el cierre del servidor local y se interrumpió después de esos resultados; por ello no se considera una ejecución limpia de la suite. |
| Build público | Aprobado con `node scripts/build-static.cjs`; `dist` contiene los archivos públicos del POS. |
| Detector UTF-8 | Aprobado: 235 archivos revisados, sin patrones sospechosos. |
| `git diff --check` | Aprobado; Git mostró únicamente avisos de conversión de finales LF/CRLF en archivos modificados. |

### Pendientes para una migración real

1. La migración integral sigue sin estar lista. El catálogo aprobado sí puede proyectarse a un negocio ficticio bloqueado, pero no debe usarse para activar o migrar un cliente real.
2. Falta implementar y probar la proyección por lote de ventas, créditos/abonos, movimientos históricos de inventario, compras/cuentas por pagar/pagos, caja, gastos, anulaciones, órdenes, responsables y auditoría, enlazando IDs locales con las referencias persistentes del archivo.
3. La etapa de compras conectadas no se inició; debe esperar la revisión de PHASE53 y la validación requerida por las instrucciones del proyecto.
4. Falta conciliación global con totales, saldos, estados, fechas, relaciones y archivos; también falta el flujo que cambie el control a `COMPLETE` y habilite una activación explícita solo después de aprobar la conciliación.
5. Datos heredados, saldos iniciales sin factura, categorías sin producto, referencias rotas, IDs duplicados y decisiones de exclusión deben resolverse explícitamente. No se debe aprobarlos en bloque.
6. Las migraciones 012 y 013 son dependencias del archivo y el bloqueo. Este turno no consultó ni modificó `pos_multitenant`; de acuerdo con el contexto del proyecto, siguen sin aplicarse allí. No se creó una migración adicional y `database/schema.sql` no se modificó.
7. No se modificaron instalaciones Dexie reales, no se hicieron operaciones comerciales contra bases reales y no se realizó commit, reset, clean ni cambio del stash.

**Conclusión:** catálogo y configuración aprobados ya pueden quedar en las tablas operativas de un destino ficticio y aislado. La información financiera e histórica restante continúa solo en el archivo. No está demostrado que un negocio completo pueda migrarse sin pérdidas y el negocio conectado debe permanecer bloqueado.


## Actualización: integración operativa por lote JSON (22 de octubre de 2026)

Esta sección actualiza las conclusiones anteriores sobre la etapa de archivo. Se reutilizan los importadores existentes de ventas, compras, crédito, abonos e inventario desde la etapa administrativa del lote; no se reescribieron los servicios comerciales. La proyección requiere que el destino esté `INACTIVE` y en `PENDING`, un lote y una revisión de identidad aprobados, y que la etapa de catálogo haya conciliado. El bypass de validación se limita a una capacidad interna del lote y no habilita operaciones comerciales normales mientras el destino permanezca bloqueado.

La migración 014, `database/migrations/014_historical_migration_operations.sql`, agrega marcas históricas, referencias de pagos a proveedores y campos de procedencia. Es incremental y deja los registros existentes con `is_historical=FALSE`; no reescribe operaciones. Se ejecutó solo en bases de prueba nuevas. `database/schema.sql` no se modificó.

La etapa operativa proyecta ventas y compras mediante los importadores históricos existentes, incluyendo ventas anuladas y compras anuladas; enlaza ventas, compras, productos, clientes, proveedores y abonos con el mapa persistente de IDs locales; registra pagos a proveedores y deja sus referencias y métodos de pago; incorpora movimientos de caja, sesiones, gastos, Kardex, órdenes pendientes y eventos de auditoría. Las facturas locales se muestran como referencia de origen junto a una numeración protegida contra colisiones del negocio destino. El archivo original sigue inmutable y el archivo histórico conserva sus filas, huellas y decisiones.

Los registros históricos quedan marcados como tales y las etapas no crean movimientos comerciales actuales. El stock final proviene del catálogo importado; el Kardex se agrega como historia sin alterar ese stock. Los pagos, gastos y movimientos históricos no generan una segunda entrada o salida de efectivo. Las órdenes quedan en `sale_orders` como pendientes y no se convierten en ventas. Una sesión local todavía abierta se representa en el destino como sesión histórica cerrada para que nunca funcione como caja activa; `source_status` y la respuesta del módulo conservan el estado original (`OPEN`). La conciliación compara ese estado, las fechas, los actores y los importes de apertura/cierre.

La conciliación del lote compara conteos e importes de ventas, compras, abonos, pagos a proveedores y gastos; estado, importe y fecha de cada venta y compra; saldos de clientes y proveedores; cantidades positivas, negativas y netas de Kardex; conteos y totales de sesiones y movimientos de caja por dirección; detalles y totales de órdenes; y referencias de auditoría. Cualquier fila que no se pueda enlazar, cuyo valor tenga precisión o estado no representable, o que permanezca pendiente impide la conciliación completa. Al pasar una prueba sintética completa, el control puede cambiar a `COMPLETE`, pero el negocio permanece `INACTIVE`; la activación es una acción administrativa separada posterior.

Los eventos importados conservan un `sourcePayload` saneado, el actor y la acción originales dentro del detalle de auditoría. Las contraseñas, tokens, nombres de usuario de origen e IDs de sesión se eliminan durante el archivo. No se crean usuarios conectados a partir de credenciales locales; si el paquete contiene identidades de usuario que el sistema no puede conciliar de forma segura, el registro queda pendiente en vez de copiar credenciales.

### Cobertura actualizada

| Módulo | Funcionalidad conectada | Migración JSON | Conciliación de lote |
| --- | --- | --- | --- |
| Productos, precios, costos, existencias actuales, categorías asociadas e imágenes | IMPLEMENTADO | IMPLEMENTADO | IMPLEMENTADO para los campos representables, valores de producto e integridad de archivos |
| Clientes y límite de crédito | IMPLEMENTADO | IMPLEMENTADO | IMPLEMENTADO para datos operativos y saldos derivados; saldos iniciales sin facturas equivalentes continúan bloqueando |
| Proveedores | IMPLEMENTADO | IMPLEMENTADO | IMPLEMENTADO para sus datos y relaciones disponibles |
| Ventas, detalles, descuentos, métodos de pago, estados y cancelaciones | IMPLEMENTADO | IMPLEMENTADO mediante el importador de ventas existente | IMPLEMENTADO para conteo, importe, estado, fecha, referencias y saldo en la prueba integral |
| Facturas de crédito y abonos | IMPLEMENTADO | IMPLEMENTADO mediante el importador de crédito existente | IMPLEMENTADO para importes, referencias y saldos sintéticos |
| Compras y detalles históricos | IMPLEMENTADO en el módulo conectado existente; no se inició desarrollo de compras normales adicional | IMPLEMENTADO en contexto de lote mediante el importador existente | IMPLEMENTADO para conteo, importe, estado, fecha y deuda sintética |
| Cuentas por pagar y pagos a proveedores | IMPLEMENTADO | IMPLEMENTADO como datos históricos enlazados | IMPLEMENTADO para importes y saldo derivado de facturas y pagos sintéticos |
| Caja, cierres, conteos y movimientos | IMPLEMENTADO | IMPLEMENTADO como historial; no se habilitan sesiones locales abiertas | IMPLEMENTADO para estado fuente, actores, apertura/cierre, conteos, movimientos y dirección |
| Gastos | IMPLEMENTADO | IMPLEMENTADO como historial, sin egresos actuales artificiales | IMPLEMENTADO para conteo e importe sintéticos |
| Inventario y Kardex | IMPLEMENTADO | IMPLEMENTADO como historial, sin mutar el stock final | IMPLEMENTADO para conteo y cantidades de entrada, salida y netas |
| Órdenes pendientes | IMPLEMENTADO | IMPLEMENTADO como órdenes históricas, sin factura ni cobro | IMPLEMENTADO para conteo, detalles y total sintético |
| Auditoría histórica | IMPLEMENTADO | IMPLEMENTADO con actor y payload saneado | IMPLEMENTADO para cantidad de eventos y referencias sintéticas |
| Configuración del negocio, comprobantes y logo | IMPLEMENTADO | IMPLEMENTADO por la etapa de catálogo; conserva valores no vacíos del destino | IMPLEMENTADO por campo e integridad de imagen en pruebas previas de catálogo |
| Usuarios, roles y credenciales | IMPLEMENTADO para cuentas conectadas creadas por los flujos administrativos vigentes | PARCIAL: conserva actores históricos; no traslada cuentas ni credenciales locales | PARCIAL: las referencias no representables siguen pendientes |

La cobertura de la fila sintética no demuestra que todo JSON real sea migrable. Paquetes incompletos, identidad heredada ambigua, datos fuera del esquema, pagos sin factura/proveedor, sesiones sin estado reconocido, saldos iniciales no respaldados, categorías independientes y usuarios locales continúan como bloqueos de conciliación cuando corresponda. No se declara cobertura universal del 100 %.

### PHASE53 y alcance de compras

PHASE53 y `AGENTS.md` siguen deteniendo el avance de la fase normal de compras conectadas hasta la revisión solicitada y la validación de una venta real. Ese límite aplica al desarrollo/activación del módulo comercial normal; la importación administrativa de compras históricas se ejecuta solo dentro del lote JSON autorizado, sobre un negocio `INACTIVE/PENDING`, marcadas como históricas y sin alterar existencias ni caja. No se añadió ni modificó el flujo de compras normales.

### Pruebas de esta actualización

| Verificación | Resultado |
| --- | --- |
| ESLint completo | 0 errores y 0 advertencias. |
| Pruebas unitarias de backend | 178 aprobadas, 0 fallidas; 1 omitida porque el fixture JSON local no está disponible en este checkout. |
| Integración MySQL del lote, catálogo, archivo, bloqueo y proyección completa | 11/11 aprobadas en una base aleatoria `pos_auth_test_*`; incluyó reintento tras una interrupción y segunda importación sin duplicados; la base se eliminó. |
| Playwright conectado: archivo, revisión de identidad, destino, mensajes y diseño adaptable | 14/14 aprobadas con Microsoft Edge en una base temporal; la base se eliminó. Chromium de Playwright no está instalado en este equipo. |
| Playwright local: exportador JSON | Los tres casos finalizaron `ok` con Edge, incluidos preservación de Dexie e identidad persistente; el runner quedó vivo después del resultado porque reutilizó el servidor local existente y se interrumpió manualmente. No se considera cierre limpio. |
| Detector UTF-8 | 238 archivos revisados, sin patrones de codificación dañada. |
| Build público | Aprobado desde la lista explícita de recursos públicos; el servidor de prueba lee solo `dist`. |
| `git diff --check` | Sin errores de whitespace; aparecen avisos habituales de normalización LF/CRLF. |
| Integración MySQL global no segmentada | 96 aprobadas, 32 fallidas y 1 omitida. El ejecutor mezcló suites sobre una única base temporal y el seed de preservación de 005 contaminó pruebas que requieren negocio vacío o datos aislados (por ejemplo, bootstrap y reportes). La base temporal se eliminó. El subconjunto aislado de migración sí pasó 11/11. |
| Pruebas históricas de crédito/compras en navegador | 2 fallidas porque las pruebas antiguas intentan elegir el negocio protegido ID 1, que el panel correctamente excluye como destino. Las 14 pruebas restantes de esas suites seleccionadas aprobaron. Esas dos pruebas requieren fixture/destino válido antes de considerarse regresión del flujo nuevo. |

El ejecutor de pruebas ahora omite el seed específico de migración 005 al iniciar el modo de navegador para que el negocio del sistema conserve el ID 1 esperado por el fixture. El seed sigue presente en la integración MySQL normal para verificar que 005 preserva pagos preexistentes.

### Pendientes antes de trasladar un cliente real

1. Aplicar 012, 013 y 014 en la base de despliegue con el ejecutor oficial después de revisar compatibilidad y respaldos; no se aplicaron en esta tarea. Según el contexto previo, 001–011 están aplicadas y 012–014 siguen pendientes en `pos_multitenant`.
2. Actualizar las dos pruebas Playwright históricas para que no seleccionen el negocio protegido y comprueben un destino real elegible, o retirarlas si ya fueron reemplazadas por el flujo de lote.
3. Separar cada archivo de integración MySQL en un destino aislado para que la suite completa no comparta semillas y datos entre módulos.
4. Definir un proceso para crear o activar usuarios conectados con credenciales nuevas. Las contraseñas locales no se migran.
5. Probar un paquete real representativo con sus datos ambiguos ya revisados. Los 127 registros heredados u otros registros sin procedencia confirmada no pueden aprobarse en bloque.
6. Ejecutar la conciliación en destino y revisar cada diferencia. El sistema debe dejar el negocio inactivo ante cualquier pendiente; solo un administrador puede activarlo después del estado `COMPLETE`.

**Estado de la base principal:** no se conectó ni modificó `pos_multitenant`, no se ejecutó ninguna migración allí y no se hicieron escrituras comerciales reales. `database/schema.sql` sigue sin cambios. No se realizaron commit, reset, clean ni cambios al stash. El modo Dexie real no fue alterado.

**Conclusión actualizada:** el lote sintético se importa a tablas operativas usando los importadores existentes y se concilia sin crear movimientos comerciales actuales; el destino queda bloqueado y no se activa automáticamente. El sistema todavía no está listo para prometer la migración completa de cualquier cliente real: los registros ambiguos o no representables, los usuarios, las diferencias detectadas y las migraciones 012–014 pendientes en la base de despliegue requieren resolverse primero.

## Preparación de pruebas de migración y aislamiento MySQL — 22 de octubre de 2026

Esta actualización reemplaza los resultados antiguos de 96 aprobadas y 32 fallidas para la ejecución MySQL conjunta, y el resultado anterior de Playwright local que no cerraba limpiamente el servidor.

### Investigación de las 32 fallas anteriores

Las fallas no se debían todas al ejecutor:

- El ejecutor anterior compartía un esquema y fixtures entre archivos. La suite de autenticación necesita comenzar sin negocios y usuarios de prueba; los reportes también asumían datos propios. La semilla de preservación de la migración 005 y los datos de otras suites contaminaban esos resultados. Ahora cada archivo recibe una base aleatoria independiente con prefijo validado `pos_auth_test_`; la suite de autenticación empieza vacía y cada base se elimina en `finally`.
- El catálogo de suites intentaba ejecutar dos rutas de pruebas inexistentes. Se retiraron esas referencias; no se crearon pruebas vacías para simular cobertura.
- Se detectó un defecto real en la cuenta corriente de compras: una compra histórica se sumaba como cargo y alteraba el saldo acumulado. Las compras y pagos históricos ya no generan cargos, abonos ni saldos operativos en ese estado de cuenta. La prueba de integración ahora verifica que el saldo acumulado permanezca en `0.00`.
- Se detectó una fuga real en el reporte público de caja: la respuesta exponía el identificador interno del usuario aunque la prueba exigía no devolverlo. Se retiró `userId` del contrato público; el nombre del actor y la referencia de reversión se conservan.
- Las pruebas de lote identificaron una diferencia real de conciliación: en Dexie, un abono `pendiente` de confirmación en Caja ya reduce la deuda local. La migración conserva el estado fuente `pendiente`, lo aplica a la conciliación histórica de saldos de cliente/proveedor y no crea movimientos de caja. Los saldos históricos de proveedores se muestran por separado de la deuda operativa.

Las dos pruebas históricas de navegador que intentaban escoger el negocio protegido ID 1 se rehicieron para crear un destino bloqueado mediante la interfaz administrativa, confirmar la identidad del paquete y crear antes una cuenta con contraseña nueva y rol elegido. No se debilitó la protección del negocio 1. La lista de negocios del panel de usuarios se actualiza al abrirla, de modo que también incluya un destino recién creado.

### Cuentas del negocio migrado

El formulario exige una contraseña nueva y que el administrador general seleccione explícitamente `ADMIN` o `VENDEDOR`; no hay un rol preseleccionado. El backend sigue restringiendo la operación al administrador general y guarda la contraseña mediante Argon2id. El lote no importa usuarios, nombres de usuario ni contraseñas locales. La prueba de integración confirma que el paquete con credenciales locales no crea esas cuentas y que el negocio sigue `INACTIVE` mientras el lote está pendiente.

La creación de una cuenta no activa por sí sola el negocio. El acceso comercial continúa bloqueado hasta que la conciliación del lote termine correctamente y el administrador general realice la activación explícita.

### Resultados de verificación

| Verificación | Resultado actual |
| --- | --- |
| Integración MySQL conjunta | 19 archivos de suite; 130 casos, 129 aprobados, 0 fallidos y 1 omitido. El omitido requiere el JSON local de referencia que no está disponible en este checkout. Cada suite utilizó una base `pos_auth_test_<24 hex>` nueva y el ejecutor la eliminó al terminar. |
| Importación sintética integral, reintento e interrupción | Aprobada en MySQL temporal. El archivo histórico se reanuda sin duplicados; la proyección completa conserva referencias, estados y valores; la conciliación impide activar con diferencias. |
| Inventario, efectivo y saldos | Aprobado en pruebas de integración y Playwright. Compras históricas no mutan stock/Kardex/caja/CxP; ventas históricas y abonos no crean movimientos comerciales nuevos; el Kardex histórico no altera la existencia final. El abono local pendiente queda trazado y concilia con deuda cero cuando corresponde. |
| Compras y crédito históricos en Playwright conectado | 2/2 aprobadas con Edge y una base MySQL temporal. Se verificaron filas en los módulos de compra y estado de cuenta, saldo histórico de proveedor separado del CxP operativo, ausencia de operaciones locales de origen y negocio distinto de ID 1. |
| Usuarios de destino | Aprobado en integración: se crea una cuenta con rol explícito y contraseña nueva; las credenciales del JSON se ignoran y el destino permanece bloqueado. |
| Pruebas unitarias backend | 178 aprobadas, 0 fallidas y 1 omitida por falta del mismo JSON real de referencia. No se repitió la batería general de 570 pruebas. |
| Playwright local del exportador | 3/3 aprobadas en 3.3 segundos con salida `0`. El nuevo ejecutor administra el servidor estático en el mismo proceso y lo cierra en `finally`; al terminar, el puerto 5501 quedó sin escucha. |
| ESLint completo | Aprobado, 0 errores y 0 advertencias. |
| Build público | Aprobado con `node scripts/build-static.cjs`; el ejecutor local sirve solamente `dist`. |
| Detector de codificación | Aprobado: 241 archivos revisados, sin patrones sospechosos. |
| `git diff --check` | Aprobado; Git mostró avisos habituales de normalización LF/CRLF, sin errores de whitespace. |

Durante la corrección también hubo fallos de fixture de navegador: faltaba la evidencia de identidad que el flujo exige; el paquete de prueba omitía el alcance persistente que emite el exportador v2; y una prueba esperaba ver una factura pagada dentro de CxC. Se ajustaron los fixtures para usar el formato v2 real, confirmar explícitamente el origen y consultar la factura pagada en el historial del cliente. La conciliación del abono pendiente sí reveló el defecto de saldo descrito arriba y se corrigió sin ocultar la diferencia ni cambiar el estado histórico.

### Archivos de esta actualización

- `backend/scripts/test-integration.cjs`: base limpia por suite, fixtures controlados, limpieza y lista de pruebas existentes.
- `backend/src/services/procurement.js` y `backend/src/services/system-admin-migration-operations.js`: separación de saldos operativos e históricos y conciliación de abonos locales pendientes.
- `backend/src/services/connected-reports.js`: retiro del identificador interno de usuario del reporte público.
- `connected-auth.js`, `index.html` y `connected-purchases.js`: refresco de negocios para la provisión, rol sin selección predeterminada y presentación separada del saldo histórico del proveedor.
- `backend/tests/integration/system-admin-migration-onboarding.test.cjs`, `backend/tests/integration/system-admin-purchases-migration.test.cjs` y `tests-connected/historical-{credit,purchases}-migration.spec.cjs`, `tests-connected/local-migration-flow.helper.cjs`: cobertura de cuentas, saldos, visibilidad de historial y flujo administrativo con un destino válido.
- `playwright.config.cjs`, `scripts/run-local-playwright.cjs` y `package.json`: servidor local de pruebas gestionado y cierre verificable.
- `AUDITORIA_MIGRACION_LOCAL_CONECTADO.md`: este reporte de resultados.

### Preparación real y bloqueos

El recorrido sintético integral pasó, pero **todavía no se debe activar un negocio migrado real**. No hay un JSON real de cliente disponible en este checkout; por eso una prueba que depende de ese archivo quedó omitida tanto en las pruebas unitarias como en integración. El siguiente ensayo debe usar el paquete original inmutable en una base temporal o entorno de staging, revisar individualmente las identidades antiguas/compartidas y exigir conciliación completa antes de considerar la activación.

Según el estado proporcionado para esta tarea, `pos_multitenant` conserva las migraciones 001–011 y 012–014 siguen pendientes. El flujo de archivo/bloqueo/procedencia depende de esas migraciones; deben aplicarse a la base de despliegue únicamente después de una revisión de esquema, respaldo verificado y autorización específica. Esta tarea no se conectó a `pos_multitenant` ni aplicó ninguna migración. Tampoco modificó `database/schema.sql`.

PHASE53 y `AGENTS.md` siguen impidiendo avanzar el desarrollo normal del módulo de compras hasta revisión de fase y validación de una venta real. Las pruebas aquí cubren exclusivamente la lectura y proyección histórica del lote y el módulo existente; no se inició una nueva fase de compras comerciales.

**Estado final:** preparado para un ensayo controlado de un JSON real en staging/base temporal cuando el archivo esté disponible. No listo para importar en `pos_multitenant` ni para activar un negocio real. No se crearon movimientos comerciales reales, no se modificó Dexie real, no se alteró `stash@{0}` y no se hicieron commit, reset ni clean.

## Autorización administrativa por paquete para identidad heredada — 22 de octubre de 2026

Esta sección actualiza la revisión anterior de identidad individual para filas que solo usan el identificador antiguo compartido. El administrador general puede confirmar de una vez la procedencia de ese paquete completo para un destino concreto. La confirmación **no** resuelve ni omite problemas de integridad.

### Alcance y controles

- El flujo exige confirmar la reserva del destino y una sola casilla para autorizar la procedencia del paquete completo. No solicita una explicación escrita para aceptar filas con identidad compartida.
- La autorización queda ligada al negocio destino y al SHA-256 de la representación canónica del objeto JSON recibido. El hash normaliza el orden de las claves JSON, por lo que identifica el contenido semántico del paquete, no los bytes originales del archivo ni sus espacios/formato.
- Se registra en el lote el administrador autenticado, fecha UTC del servidor, `business_id` de destino, hash, alcance, texto confirmado y cantidades. También se crea el evento de auditoría `LOCAL_MIG_LEGACY_CONFIRM`.
- La autorización solo elimina el bloqueo de identidad compartida. Duplicados de IDs, referencias ausentes o ambiguas, identidad concreta de otro negocio, IDs ausentes/inferidos, errores de imagen y datos incompletos siguen sin importarse o bloquean la conciliación. Las filas con otro problema no se vuelven importables por confirmar el paquete.
- Un paquete con contenido distinto no reutiliza la autorización; tampoco puede usarse en otro destino. Reintentar el mismo paquete y destino conserva el lote y la confirmación existentes. Los puntos de entrada de proyección e importación vuelven a validar hash, alcance, destino y actor/fecha; el destino se mantiene `INACTIVE/PENDING` hasta completar la conciliación y una activación explícita.
- No se alteró el archivo JSON original. El checksum del archivo antes y después de la prueba real fue idéntico.

### Simulación del JSON real

El paquete real v1 se procesó solo en una base MySQL temporal `pos_auth_test_*`, que el ejecutor eliminó al finalizar. El análisis encontró 127 filas con el ID compartido y sin otra alerta, por lo que la confirmación administrativa resolvió exactamente esas 127 incertidumbres. La prueba detectó y mantuvo como bloqueos los módulos ausentes del paquete v1 (`expenses`, `auditLogs`, `saleOrders`, `syncQueue`); el lote quedó `BLOCKED` y el negocio siguió `INACTIVE/PENDING`. Se rechazó la activación. Por eso esta prueba demuestra autorización y archivado seguros, **no** la migración operativa completa del cliente.

El paquete incluía 4 productos, 4 clientes, 4 proveedores, 28 ventas, 6 compras, 5 sesiones de caja, 69 movimientos de inventario y 7 abonos. El análisis temporal no encontró IDs duplicados, referencias rotas ni identificadores concretos de otro negocio; la prueba comprobó la repetición idempotente del mismo lote/hash/fecha y que el archivo fuente no cambiara. No se aprobó ningún registro de otro paquete ni destino.

### Verificaciones de esta actualización

| Comprobación | Resultado |
| --- | --- |
| Unitarias enfocadas de archivo y API | 17/17 aprobadas. Duplicados (incluida la primera fila repetida), referencias ambiguas y relaciones rotas siguen pendientes tras autorizar identidad. |
| Unitarias backend completas | 180 aprobadas, 0 fallidas, 1 omitida; la omitida depende de un fixture local no disponible para esa suite. |
| Integración MySQL temporal de esquema, archivo, proyección y onboarding | 15/15 aprobadas; la suite opcional del JSON real se ejecutó. Las bases `pos_auth_test_*` fueron eliminadas. |
| Playwright enfocado, confirmación por paquete | 1/1 aprobada en Edge y MySQL temporal; se verificaron las dos confirmaciones, destino/hash y diseño móvil. Base temporal eliminada. |
| ESLint completo, build público y `git diff --check` | Aprobados. El `git diff --check` solo reportó avisos de normalización LF/CRLF. |
| Intento accidental de ejecutar toda la suite de navegador (122 casos) | Interrumpido antes de completar para no repetir pruebas generales; la base temporal que dejó el proceso fue detectada y eliminada. No se considera resultado de pruebas. |

### Estado y pendientes

El cliente real **todavía no está listo para una migración completa ni activación**: su paquete v1 carece de los módulos indicados, así que el archivo queda archivado y bloqueado para continuar con la importación operativa y conciliación global. Debe obtenerse un paquete v2 con esos módulos o definirse y probarse una representación equivalente; luego se requiere ejecutar el flujo operacional y comprobar todos los saldos, relaciones, inventario e historiales antes de activarlo.

La confirmación protege únicamente la incertidumbre de identidad heredada para el contenido canónico exacto y destino indicados. La huella no es el SHA-256 byte por byte del JSON descargado; si el proceso administrativo exige evidencia criptográfica sobre esos bytes exactos, hará falta transportar y validar el hash de los bytes del archivo en la capa de carga.

**Estado de seguridad:** no se conectó ni escribió en `pos_multitenant`; no se aplicaron migraciones; `database/schema.sql` no se modificó. No hubo cambios a commit/reset/clean ni al stash. La base principal y los datos locales reales permanecen intactos.

## Interfaz de migración JSON con una acción integral — 22 de octubre de 2026

### Causa de los controles deshabilitados

Los controles no estaban deshabilitados únicamente por archivos estáticos antiguos. El HTML fuente conservaba las acciones separadas de importación y un botón de continuación deliberadamente inactivo; el JavaScript también devolvía un mensaje de “solo datos básicos”. El panel servido desde `dist` reflejaba ese flujo. Se reemplazó la interfaz visible por una sola acción y se regeneró el build público.

### Flujo integrado

- Al seleccionar un paquete y un destino se ejecuta la vista previa existente. El administrador revisa el resumen, registra la referencia de procedencia y confirma expresamente que el archivo completo corresponde al destino seleccionado.
- Para identidad antigua compartida, esa misma confirmación administrativa por paquete se pasa al servicio de archivo existente. La autorización sigue ligada al actor, destino y huella del paquete; no aprueba duplicados, referencias rotas, registros incompatibles ni otros problemas.
- El botón **Migrar datos** guarda o reanuda el lote y llama al endpoint de proyección operativa existente. Ese flujo invoca las proyecciones de catálogo e historial y la conciliación; la interfaz ya no obliga a pulsar importadores separados ni vuelve a ejecutar la proyección de catálogo por su cuenta.
- El panel presenta el avance por etapa y agrupa diferencias y bloqueos por módulo. Solo presenta “Migración completada” cuando el servidor confirma conciliación completa, sin diferencias ni bloqueos. Aun así, el destino sigue `INACTIVE`; la activación continúa siendo una acción administrativa explícita y separada.
- Se mantienen los controles de duplicados, hash/destino, aislamiento y reanudación del backend. Para un paquete v1, los módulos ausentes `expenses`, `auditLogs`, `saleOrders` y `syncQueue` siguen bloqueando el cierre porque el paquete no demuestra que estuvieran vacíos.

### Ensayo con el JSON real del cliente

El archivo se leyó sin modificarlo y se ejecutó desde el navegador contra una base MySQL temporal `pos_auth_test_*`; el ejecutor eliminó esa base al finalizar. La prueba comprobó que la confirmación cubrió las 127 filas heredadas elegibles para autorización por paquete, llamó al endpoint operativo, consultó las tablas destino y verificó que el hash del archivo original no cambiara.

La integración real **no concilió**. La vista de conciliación detectó, entre otros, estos faltantes operativos frente al contenido del paquete: 2 ventas no vinculadas de 28, compras con 3 de 6 representadas, pagos a proveedores con 1 de 4, sesiones de caja con 0 de 5 y movimientos de inventario con 0 de 69. También quedaron diferencias de movimientos de caja y saldos de proveedores, además de los módulos ausentes del formato v1. Los registros conservados en el archivo histórico no se contaron como equivalentes a operaciones consultables desde sus módulos normales.

El servidor mantuvo el destino como `INACTIVE/PENDING`; el intento de activarlo fue rechazado por conciliación pendiente. La prueba no declaró la migración completa. Se debe corregir la proyección operativa y conciliar cada módulo, y obtener una exportación que represente gastos, auditoría, órdenes pendientes y cola de sincronización —o evidencia verificable de que esos stores estaban vacíos— antes de volver a probar el cierre.

### Verificaciones de esta actualización

| Comprobación | Resultado |
| --- | --- |
| Playwright enfocado de la interfaz y flujo completo con el JSON real | 7/7 aprobadas. Incluye escritorio/móvil, resumen, confirmación de identidad heredada en bloque, selección/creación de destino, llamada de importación y conciliación real incompleta. |
| JSON real y destino | Solo base temporal aleatoria validada `pos_auth_test_*`; destino continuó `INACTIVE/PENDING`; activación bloqueada. SHA-256 del archivo fuente sin cambios. |
| Pruebas unitarias del backend | 180 aprobadas, 0 fallidas y 1 omitida por ausencia de un fixture JSON local distinto. |
| ESLint completo y build público | Aprobados; el panel de prueba sirvió el build generado desde `dist`. |
| `git diff --check` | Sin errores de whitespace; Git emitió avisos informativos de normalización LF/CRLF. |
| `database/schema.sql` | Sin diferencias. No se usó `pos_multitenant` ni se aplicaron migraciones principales. |

**Conclusión:** la interfaz ya inicia el proceso integral con una sola acción y el ensayo demuestra que llega a los importadores operativos y la conciliación. El JSON v1 del cliente no puede declararse migrado íntegramente ni activarse: las diferencias concretas anteriores y los stores ausentes lo mantienen bloqueado. No se modificaron el JSON original, `pos_multitenant`, `database/schema.sql` ni `stash@{0}`; tampoco se hizo commit, reset ni clean.

## Simplificación de confirmación de procedencia — 22 de octubre de 2026

- Se eliminó el campo de referencia escrita y las reglas de longitud, palabras y datos comerciales para autorizar el paquete. La casilla obligatoria inicia desmarcada y usa el texto: «Confirmo que este archivo pertenece al negocio seleccionado y autorizo su migración».
- El administrador autenticado confirma el paquete completo. La autorización de las 127 filas con identificador heredado queda ligada a ese paquete y destino; la auditoría registra administrador, fecha UTC, destino, huella SHA-256 y texto de confirmación.
- Se quitaron dos validaciones antiguas en proyección y operaciones que seguían exigiendo la nota retirada. Las comprobaciones de destino, hash, referencias, duplicados, relaciones, saldos y conciliación siguen vigentes. Las decisiones excepcionales de filas no compartidas conservan una confirmación contextual, sin campo de texto.
- La prueba Playwright cargó el JSON v1 proporcionado, marcó solo la casilla del paquete y pulsó «Migrar datos». Los importadores operativos y la conciliación se ejecutaron en `pos_auth_test_*`; se confirmaron las 127 filas heredadas, se registró la autorización y el negocio continuó `INACTIVE/PENDING` por los módulos v1 ausentes y una diferencia de inventario. La activación siguió bloqueada.
- Verificaciones: 29 pruebas unitarias/API enfocadas aprobadas; 16 integraciones MySQL enfocadas aprobadas en cuatro bases temporales creadas y eliminadas por el ejecutor; 1 Playwright integral con el paquete real aprobado; la suite enfocada del panel/destino suma 14/14 casos aprobados entre la primera corrida y la repetición del caso con expectativa corregida; exportación local, 3/3 aprobada; ESLint, build público y `git diff --check` aprobados. SHA-256 crudo del archivo antes y después: `CEC2C3FCCC5F1D3235136F7DF921886890F60819265D42C470163976B6ADFDA8`. La huella guardada es la SHA-256 canónica del objeto recibido por la API, estable frente al orden de las claves.
- La regresión local completa (223 casos) se detuvo manualmente tras sus primeros seis casos, que demoraban hasta el límite de 30 segundos; de esos seis, dos pasaron y cuatro agotaron el tiempo en pruebas antiguas no relacionadas. La prueba local enfocada del exportador sí terminó 3/3. No se completó la suite local completa.
- No se modificaron `pos_multitenant`, `database/schema.sql`, el JSON original ni `stash@{0}`; tampoco se hizo commit, reset ni clean. Esta prueba verifica autorización e importación disponible, pero no declara completa la migración del cliente.

## Conciliación del inventario inicial en cero y paquete v2 — 22 de octubre de 2026

### Diferencias encontradas en el JSON real v1

La reproducción con el JSON original en una base MySQL temporal devolvió exactamente tres diferencias, con dos asociadas a una misma fila:

| Origen | Campo | Esperado | Encontrado | Causa |
| --- | --- | --- | --- | --- |
| `inventoryMovements`, `id:1791253127965.8538` | `zeroQuantity` | Conservar evento de cantidad `0.000` | No había fila operativa equivalente | El ledger normal rechaza cantidad cero porque no es un movimiento de existencias. |
| Mismo registro | `recordStatus` | `PROJECTED` | `PENDING` | El proyector anterior dejaba el evento cero pendiente por la misma limitación del ledger. |
| Lote del archivo | `recordCount` | 69 movimientos de origen | 68 importados | El conteo no contemplaba el evento cero que no entró al ledger. |

No eran tres movimientos distintos ni se encontró evidencia de pérdida de stock. Dos diferencias describían una sola fila; la tercera era el total agregado. Se conserva el ID local original como clave de origen.

### Implementación

- Se añadió la migración aditiva `015_historical_zero_inventory_events.sql`. Almacena los eventos de cantidad cero en `migration_zero_inventory_events`, ligada al lote y al producto del mismo negocio, con clave de origen única, fecha, stock resultante, costo, responsable, referencias y payload original. La restricción SQL acepta exclusivamente cantidad cero. El evento no se inserta en `inventory_movements` y no modifica producto, caja ni saldos.
- El proyector procesa el evento archivado y puede reanudar el caso que una ejecución previa había dejado `PENDING` por cantidad cero. Al proyectarlo, conserva el registro de origen y lo marca como proyectado a la tabla histórica. La conciliación cuenta los 68 movimientos operativos más el evento cero (69), comprueba campos históricos de cada fila y compara existencias finales con el catálogo de origen. Si hay otras diferencias o módulos ausentes, no permite `COMPLETE`.
- El Kardex de Inventario y el Kardex de Reportes unen los eventos cero con el ledger normal, marcándolos como históricos. Mantienen cantidad cero y su stock resultante original; no se inventan deltas. Las consultas siguen limitadas al `business_id` autenticado.
- El exportador v2 ya emite todas las colecciones reconocidas, incluidas `expenses`, `auditLogs`, `saleOrders`, `syncQueue` y `categories` cuando están vacías; conserva `missingStores` como señal explícita si Dexie no contiene una tienda. La prueba comprueba además que exportar no modifica Dexie.

### Verificación

| Prueba | Resultado |
| --- | --- |
| Exportador local v2 en Edge: datos, todas las colecciones vacías/pobladas, relectura Dexie e identidad estable | 3/3 aprobadas. |
| JSON real v1 en Playwright y MySQL temporal | 1/1 aprobada. Se verificaron 69/69 eventos de inventario (68 del ledger operativo + 1 evento cero), sin diferencias de inventario y con stock final intacto. Los módulos ausentes del paquete v1 siguen bloqueando `COMPLETE`; el negocio continúa inactivo. Hash del JSON original: `CEC2C3FCCC5F1D3235136F7DF921886890F60819265D42C470163976B6ADFDA8`. |
| Migración v2 ficticia completa en MySQL temporal | 4/4 pruebas de proyección aprobadas; el evento cero se comprobó en Kardex junto al delta no cero, stock final idéntico, interrupción transaccional y reintento sin duplicados; el negocio de prueba quedó `INACTIVE/COMPLETE`, sin activación automática. |
| Integración MySQL completa | 19 suites ejecutadas en bases `pos_auth_test_*` separadas y eliminadas; 0 fallidas. Se omitieron 2 casos opcionales por fixtures JSON ausentes (una prueba real dedicada sí se ejecutó aparte). |
| Prueba MySQL de regresión de Reportes | 4/4 aprobadas; el endpoint incluye el evento cero con `historicalEvent=true`, cantidad 0 y stock final sin cambio. |
| Backend unitarias / ESLint / comprobación de codificación | 183 aprobadas, 0 fallidas, 1 omitida / aprobados / 245 archivos UTF-8 revisados sin texto sospechoso. |
| `git diff --check` / build público | Sin errores de whitespace / build regenerado correctamente. |

### Estado de migración y seguridad

El JSON real del cliente sigue siendo v1 y no demuestra el contenido de las tiendas ausentes. La conciliación del inventario ahora es satisfactoria, pero el lote completo debe permanecer `PENDING` y el negocio `INACTIVE`; no se declara completa ni se activa. Para la prueba definitiva, generar un paquete v2 desde el POS local actualizado que informe todas las colecciones, revisar su vista previa y ejecutar **Migrar datos** en un destino temporal o previamente aprobado. La activación solo puede considerarse después de que todas las etapas y conciliaciones, no solo inventario, estén completas.

La migración 015 fue aplicada a pos_multitenant en el corte posterior documentado abajo. No se modificaron database/schema.sql, el JSON original ni stash@{0}; tampoco se hicieron commit, reset o clean.

## Corrección de detección y aplicación de migración 015 — 22 de octubre de 2026

### Causa del mensaje de migración 014

El backend estaba conectado efectivamente a `pos_multitenant` en `127.0.0.1:3307`. El historial y el esquema confirmaron que 014 ya estaba aplicada, con su checksum esperado y las tablas y columnas requeridas presentes. La tabla `migration_zero_inventory_events` de 015 todavía no existía.

`assertOperationalSchema` agrupaba los requisitos de 014 y 015 y emitía `MIGRATION_OPERATIONAL_SCHEMA_REQUIRED` para cualquiera de las dos ausencias. El cliente traducía ese código a un mensaje fijo de 014. Por eso se informó incorrectamente que faltaba 014, aunque en realidad faltaba 015.

### Corrección y base principal

- Se separaron los requisitos y códigos de error: 014 sigue usando `MIGRATION_OPERATIONAL_SCHEMA_REQUIRED`; la tabla de eventos con cantidad cero ahora usa `MIGRATION_ZERO_INVENTORY_SCHEMA_REQUIRED` y un mensaje explícito de 015.
- Antes de aplicar 015 se volvió a comprobar el respaldo `C:\Users\andre\Documents\POS-Backups\pos_multitenant-pre-015-20261023T050852.540Z-b39845ed87.sql`. SHA-256: `D6B4FB5693DB2FFA3E0F9803AB81540F45A9741762277AA1811CD73DED5F01CF`. La restauración e integridad del respaldo se verificaron previamente en una base temporal independiente.
- El plan oficial mostró 001–014 aplicadas y solo 015 pendiente. El ejecutor oficial omitió 001–014 y aplicó únicamente 015. No se volvió a ejecutar 014.
- El plan posterior reporta 001–015 como aplicadas. 014 conservó su checksum; 015 quedó registrada con checksum `2df76963f195db29d8ecec72363702accc1b66d7afce46f7e0ca0a13a9d4ad89`.
- La comprobación de las 33 tablas existentes no encontró variaciones de conteo. `schema_migrations` aumentó de 14 a 15 y la tabla nueva contiene 0 eventos. No se importó nuevamente el JSON ni se ejecutaron operaciones comerciales.

### Pruebas y operación

- 4/4 pruebas unitarias enfocadas: validación de esquema completo, detección de faltantes de 014, detección específica de 015 y texto de respuesta API.
- Backend unitario: 187 aprobadas, 0 fallidas, 1 omitida por ausencia de un paquete JSON de fixture.
- Integración de migración en cuatro bases `pos_auth_test_*` temporales: 15 aprobadas, 0 fallidas, 1 caso opcional omitido; las bases temporales fueron eliminadas por el ejecutor.
- ESLint aprobado. `git diff --check` terminó con código 0; Git mostró únicamente avisos de conversión LF/CRLF en archivos existentes.
- Se actualizó únicamente `dist/api-client.js` para reflejar el mensaje de 015. El archivo coincide por SHA-256 con `api-client.js`.
- Se reinició el proceso Node que atendía `127.0.0.1:3000`; la API volvió a responder `health=ok`, `database=up`.

La importación del JSON no se reintentó. Tras recargar la interfaz, el guard de esquema ya pasa y la interfaz distingue correctamente una futura ausencia de 014 frente a 015.

## Continuación completa v1 → v2 con los paquetes reales — 23 de octubre de 2026

Esta sección registra la verificación más reciente y prevalece sobre las conclusiones anteriores que solo cubrían el paquete v1. Los archivos originales se leyeron sin modificarlos:

- v1: `C:\Users\andre\OneDrive\Documents\POS-Backups\migration-review\cliente-real.json`, SHA-256 `CEC2C3FCCC5F1D3235136F7DF921886890F60819265D42C470163976B6ADFDA8`.
- v2: `C:\Users\andre\Downloads\paquete-migracion-pos-distribuidora-2026-10-23.json`, SHA-256 `7992D101B1B1C3BB03EED0311892EC486BA1D128628E39147A1F4AFEE963D550`.

### Continuación e integridad

- El flujo administrativo retomó el origen v1 con el paquete v2. Comprobó identidad estable del negocio, origen y referencias locales ya guardadas. Las referencias de contenido coincidente se conservaron; los conflictos de contenido distinto siguen siendo bloqueantes. Cada archivo mantuvo su lote y SHA-256. Repetir el archivo o la proyección reutilizó las referencias existentes.
- La autorización de procedencia del v1 cubrió sus 127 registros con identidad heredada. La vista previa del v2 calculó y registró su propia autorización por paquete. No se solicitaron notas escritas ni decisiones individuales para el ID compartido.
- La proyección v1 quedó INACTIVE/PENDING. El v2 completó los módulos ausentes sin reiniciar saldos ni reinsertar ventas y compras ya importadas. Sus 356 filas `sync_queue` se conservaron para auditoría y ninguna se ejecutó.
- Los 69 eventos de inventario quedaron representados por 68 movimientos del Kardex operativo y un evento histórico de cantidad cero. El evento cero no generó delta ni alteró existencias.
- La orden cancelada `34cc1140-3432-42d9-b462-720c1d44434b` conservó estado, fecha, total C$67.10 y dos líneas. El origen no contenía precios por línea, así que no se usaron precios actuales: la migración 016 guarda ambos snapshots como desconocidos (`NULL`, `price_snapshot_available=0`). El historial muestra «Precio histórico no disponible».
- Los datos financieros e inventario importados permanecieron históricos: no generaron movimientos comerciales actuales. La conciliación comparó contenidos, importes, fechas, estados, cantidades, relaciones, saldos, imágenes y configuración.

### Resultado de la simulación real en MySQL temporal

| Módulo | Resultado conciliado |
| --- | --- |
| Productos, clientes y proveedores | 4, 4 y 4; configuración del negocio C$; las cuatro imágenes siguieron legibles al reabrir el almacenamiento temporal. |
| Ventas y compras históricas | 28 y 6; conservaron detalles y referencias sin movimientos actuales duplicados. |
| Caja | 5 sesiones y sus movimientos históricos; no se crearon movimientos actuales de efectivo. |
| Inventario | 68 movimientos más 1 evento cero; stock final idéntico al origen. |
| Abonos | 7 en total: 3 pagos de clientes y 4 a proveedores; relaciones y saldos conciliados. |
| Gastos y auditoría | 1 gasto y 177 eventos conservados con las referencias históricas. |
| Órdenes y cola | 29 órdenes, incluidos estados originales, y 356 filas de cola archivadas/no ejecutadas. |

La continuación produjo **cero diferencias**. El negocio ficticio terminó INACTIVE/COMPLETE y se activó después, solo dentro de la base temporal, para probar acceso y consulta del historial de 29 órdenes desde el panel. Se interrumpió una proyección de prueba: el snapshot permaneció igual al de v1; el reintento reusó el lote v2 y no duplicó filas.

### Pruebas de esta actualización

| Comprobación | Resultado |
| --- | --- |
| Compatibilidad SQL 016: importes previos intactos, snapshots ausentes explícitos, CHECK e idempotencia | 1/1 aprobada en `pos_auth_test_*`; base temporal eliminada por el ejecutor. |
| Continuación de servicios v1→v2 con los dos archivos reales | Aprobada en bases temporales separadas para esquema y continuidad. Versiones `[1,2]`, 29 órdenes, 2 precios no disponibles, COMPLETE, cero diferencias. |
| Playwright de Administración, interrupción/reintento, consulta y activación ficticia | 1/1 aprobada con Edge y MySQL temporal; base eliminada. El Chromium administrado no estaba instalado, por lo que se usó Edge instalado. |
| Exportador local con Dexie de prueba | 3/3 aprobadas; todas las colecciones presentes y ningún registro de Dexie modificado. |
| Backend unitario | 189 aprobadas, 0 fallidas, 1 omitida por fixture JSON opcional ausente. |
| ESLint | Aprobado. |
| Auditoría UTF-8 | Se corrigió un texto mojibake detectado en `system-admin-migration-archive.js`; la comprobación final se ejecutó de nuevo. |
| `git diff --check` y `database/schema.sql` | Sin errores de whitespace; sin cambios en `database/schema.sql`. Avisos de LF/CRLF informativos. |

### Base principal y prueba manual

El plan oficial de solo lectura contra `pos_multitenant` confirmó 001–015 como `APPLIED` y 016 como `PENDING`; el plan terminó indicando que no ejecutó DDL. Las integraciones de importación crearon y eliminaron únicamente bases aleatorias `pos_auth_test_*`. La migración 016 se aplicó solo en esas bases temporales. No se consultaron ni modificaron registros comerciales de la principal, no se importó allí el paquete v2 y no se activó ningún negocio. El estado actual de `PRUEBA MIGRACION JSON` no se volvió a consultar. `stash@{0}` se conservó; no hubo commit, reset ni clean.

La prueba manual requiere antes un respaldo completo verificable y autorización para aplicar 016 mediante el ejecutor oficial si un plan actualizado confirma que es la única pendiente. Es necesaria para conservar, sin inventar importes, las dos líneas de la orden cancelada sin snapshot de precio. Después se debe desplegar/reiniciar el backend y servir el build público actualizado. En Administración del sistema → Migración local, seleccionar `PRUEBA MIGRACION JSON`, cargar `paquete-migracion-pos-distribuidora-2026-10-23.json`, marcar la casilla «Confirmo que este archivo pertenece al negocio seleccionado y autorizo su migración» y pulsar «Migrar datos». Se espera INACTIVE/COMPLETE, «Migración completada» y cero diferencias. Revisar ventas, compras, pagos y saldos, caja, existencias/Kardex, gastos y órdenes históricas; luego activar explícitamente el negocio e iniciar sesión para verificar el POS normal. La migración real todavía no se ejecutó y no se declara completada en `pos_multitenant`.

## Aplicación autorizada de la migración 016 — 23 de octubre de 2026

Esta sección supersede el estado principal descrito en la sección anterior. La autorización explícita se recibió para aplicar únicamente 016.

- El plan oficial previo mostró 001–015 `APPLIED` y solo 016 `PENDING`. Se repitió el plan antes de aplicar, con la misma salida. La comprobación inmediata previa encontró 0 transacciones abiertas, 0 consultas activas y 0 bloqueos de metadatos pendientes sobre `sale_order_items`.
- Se creó un respaldo nuevo, sin sobrescribir anteriores: `C:\Users\andre\Documents\POS-Backups\pos_multitenant-pre-016-20261023T182140.392Z-58fce0ff.sql`. Tamaño: 43,280,712 bytes. SHA-256: `a23302aae8e2684ed08936e67aadfc1c78dd5f18cef3498431baaaca56573773`. El informe de verificación está junto al respaldo con extensión `.verification.json`.
- El respaldo incluye los 34 objetos de tabla y se restauró en `pos_auth_test_dcb2fd2cc69972c9b8decd64`, que luego fue eliminado. El contenido de 2,714 filas tuvo hashes idénticos; columnas, rutinas, vistas, triggers y eventos coincidieron. En esta base no había vistas, rutinas, triggers ni eventos. Los contadores `AUTO_INCREMENT` brutos diferían porque algunos estaban por debajo de `MAX(id)+1`; se comparó el próximo ID efectivo y coincidió en todas las tablas.
- El ejecutor oficial aplicó únicamente 016. El plan posterior reporta 001–016 `APPLIED`; no volvió a ejecutar ninguna migración anterior.
- La verificación posterior comparó las huellas de las 34 tablas y 2,714 filas existentes contra el respaldo; no encontró cambios en datos comerciales. La única fila adicional esperada es la de versión 016 en `schema_migrations`. Se verificaron las columnas nuevas y el CHECK de `sale_order_items`; todos los renglones previos conservaron sus dos valores de precio y `price_snapshot_available=1`.
- No se importó el JSON v2 ni se activó ningún negocio. `database/schema.sql`, los paquetes originales y `stash@{0}` permanecen sin cambios; no hubo commit, reset ni clean.

**Estado:** la estructura de `pos_multitenant` ya satisface el requisito 016. El administrador puede ejecutar la migración del JSON desde la interfaz cuando el backend actualizado esté activo. Primero debe confirmar en la vista previa que el paquete v2 continúa el lote v1 del mismo origen, luego marcar la casilla única y pulsar «Migrar datos». Debe esperar `INACTIVE/COMPLETE` y cero diferencias antes de activar manualmente el negocio. La prueba de ese JSON real se completó solo en bases temporales; su importación en `pos_multitenant` sigue pendiente de la acción manual del administrador.
