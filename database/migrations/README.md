# Migracion 008: referencias de ventas historicas locales

Crea migration_sales_references para guardar el negocio origen, la referencia de venta local (o su huella cuando no exista ID) y la venta conectada creada. Las claves unicas por negocio hacen idempotente la importacion y la FK conserva la correspondencia con sales. No modifica schema.sql ni aplica cambios automaticamente a la base principal. La importacion requiere 002, 003 y 008 existentes; las pruebas automatizadas aplican 008 solo a una base aleatoria pos_auth_test_* y la eliminan. Para usarla en una base real, revisar y aplicar este archivo SQL manualmente despues de autorizacion explicita.

# Migracion 001: otorgante de autorizaciones

schema.sql no se modifica. Su session_authorizations identifica sesion/modulo/vencimiento pero no al administrador que proporciono la contrasena. Se agrega granted_by_user_id BIGINT UNSIGNED y FK (business_id, granted_by_user_id) -> users(business_id, id), con RESTRICT, usando la clave compuesta existente. No se crean tablas.

La columna admite NULL para conservar registros previos sin inventar un otorgante. El backend exige un otorgante activo ADMIN y solo acepta permisos con ese enlace, de modo que las concesiones anteriores sin otorgante quedan invalidadas. Toda nueva concesion del backend registra el ID y auditoria.

Aplicar una sola vez en la base seleccionada. Desde backend: npm.cmd run migrate:auth -- --apply. El script exige --apply, lee conexion desde el entorno y ejecuta solo este ALTER. Requiere permisos ALTER y no es idempotente: si la columna ya existe debe revisarse el estado, sin repetir ciegamente. Tambien puede ejecutarse el archivo SQL usando el cliente MySQL y seleccionando explicitamente la base. No existe endpoint HTTP de migracion.

Durante las pruebas la migracion se aplica solo a una base pos_auth_test_* aleatoria, que se elimina despues. No se ejecuto ALTER sobre pos_multitenant durante esta fase.

# Migracion 002: ventas e idempotencia

Crea pos_operations y agrega cash_received/change_amount a sales, con CHECK de efectivo y cambio. No modifica schema.sql ni 001. Ver [SALES.md](../../backend/SALES.md) para contrato, respaldo, aprobacion y comandos. Ejecutar desde raiz solo tras aprobacion: npm.cmd run migrate:sales --prefix backend -- --apply. DDL no es transaccional; una ejecucion parcial exige revision manual antes de repetir. Las pruebas aplican las migraciones necesarias solo en pos_auth_test_* temporales.

# Migracion 003: confirmacion y flujo de Caja central

Agrega ventas/cajero, actor y fecha de confirmacion de tarjeta/transferencia, la configuracion DIRECT/CENTRALIZED por negocio y las tablas de pedidos pendientes. Mantiene DIRECT como valor predeterminado. No altera schema.sql. Requiere 002. Para aplicarla a la base seleccionada hace falta aprobacion explicita: npm.cmd run migrate:cash-workflow --prefix backend -- --apply. El ejecutor rechaza estados parciales y DDL no transaccional; no repetir sin revisar information_schema. La integracion automatizada la aplica solo a su base pos_auth_test_* temporal y la elimina al finalizar.
Migration 004: clientes, credito y cuentas por cobrar

Agrega el plazo de credito por cliente, la referencia opcional de cliente/plazo para pedidos centralizados y el estado PENDING para abonos bancarios en conciliacion. No modifica schema.sql; requiere migraciones 002 y 003. Las cuentas se calculan desde ventas de credito completadas y abonos POSTED. Abonos PENDING reservan saldo de factura para evitar doble pago, pero solo se aplican a deuda al confirmar en Caja.

Para aplicar manualmente tras aprobacion explicita: npm.cmd run migrate:credit --prefix backend -- --apply. El ejecutor comprueba prerrequisitos y rechaza una aplicacion previa/parcial. DDL no es transaccional: una interrupcion requiere revisar information_schema antes de continuar. Las pruebas automatizadas aplican 004 solo a su base aleatoria pos_auth_test_* y la eliminan.

Migracion 007: tipo de movimiento para inventario inicial

Agrega MIGRACION_INICIAL al ENUM de inventory_movements para registrar saldos importados. No modifica schema.sql ni datos existentes. La API de inventario inicial requiere esta migracion. No se aplica a la base principal durante el desarrollo; la integracion automatizada la aplica solo en una base pos_auth_test_* aleatoria y la elimina al finalizar. Aplicarla a una base real requiere autorizacion explicita y revision de la base destino.

Migracion 006: planes y pagos del panel privado

Crea business_subscriptions y business_subscription_payments para asignar planes, vencimientos y guardar importes/fechas de pago en USD. Deja libre la migración 005 de pagos a proveedores. No modifica schema.sql ni datos existentes; los negocios permanecen sin plan asignado hasta que el administrador elija uno. Las tablas se eliminan en cascada junto con un negocio vacío. Para aplicar a la base seleccionada tras autorizacion explicita: npm.cmd run migrate:system-admin-billing --prefix backend -- --apply. El ejecutor rechaza estados previos/parciales. DDL no es transaccional: inspeccionar information_schema antes de reintentar. Las pruebas solo aplican 006 a una base temporal pos_auth_test_* y la eliminan.

# Migracion 009: compras historicas locales

Agrega descuentos, notas y la marca `is_historical` a compras y detalles, y crea `migration_purchase_references` para idempotencia por negocio origen y compra local. Los registros marcados como históricos no crean movimientos operativos; las consultas de cuentas por pagar los excluyen y el endpoint de pagos los rechaza. Las compras ordinarias conservan `is_historical = 0`. No se modifica `schema.sql` ni se aplica esta migracion a `pos_multitenant` durante el desarrollo. La integracion la ejecuta solo en su base temporal `pos_auth_test_*` aleatoria y la elimina. Para uso real, revisar y aplicar este SQL manualmente solo después de autorización explícita; la vista previa y la importación quedan bloqueadas hasta que la migración y sus columnas existan.

## Migracion 005: pagos a proveedores con tarjeta y transferencia

Amplia supplier_payments.status con PENDING al final del ENUM y conserva POSTED como valor predeterminado. No agrega filas, no reescribe el estado de pagos actuales y no modifica database/schema.sql. Requiere 002 y 003 para idempotencia y metadatos de confirmacion de Caja. Los pagos CARD/TRANSFER reservan saldo en estado PENDING; Caja permite confirmarlos y guarda actor/fecha en el movimiento y auditoria, sin sumar ni restar efectivo fisico.

## Ejecutor ordenado 001-020

Para una instalacion nueva en MySQL o Contabo, crea una base vacia y configura DB_NAME para ese destino. Revisa el plan de solo lectura y aplica la instalacion completa:

npm.cmd run migrate:all --prefix backend -- --plan --target pos_nueva --confirm-target pos_nueva --install-base-schema
npm.cmd run migrate:all --prefix backend -- --apply --target pos_nueva --confirm-target pos_nueva --install-base-schema

El plan comprueba MySQL 8.0.16+ y que la base este vacia, sin ejecutar DDL. La aplicacion importa solo las instrucciones CREATE TABLE de schema.sql, omite su CREATE DATABASE/USE fijo a pos_multitenant y ejecuta las migraciones incrementales en orden. Para una base existente, omite --install-base-schema y usa --plan/--apply. El destino debe coincidir exactamente con DB_NAME. Se validan dependencias, firmas de esquema y checksums, y el estado queda en schema_migrations. Las migraciones previas sin ledger se adoptan solo si todas las firmas coinciden. Ante esquema parcial, drift o interrupcion, el ejecutor se detiene para revision; el DDL no es transaccional. Requiere respaldo reciente y privilegios CREATE/ALTER. En Contabo se ejecuta desde el backend con un usuario limitado a la base destino. pos_multitenant requiere --allow-principal y autorizacion expresa; esta auditoria no modifico esa base.

## Migración 019: licencias permanentes locales

La migración 019 crea únicamente tablas globales para licencias locales, instalaciones autorizadas, eventos administrativos, desafíos de un solo uso y límites compartidos de activación. No modifica las tablas operativas del POS ni contiene datos de ventas. No se ha aplicado a las bases principales como parte de este cambio; debe ejecutarse posteriormente con el plan oficial, respaldo y autorización para cada destino. El servicio permanece deshabilitado si faltan `LOCAL_LICENSE_CODE_PEPPER`, `LOCAL_LICENSE_SIGNING_KEY_ID` o `LOCAL_LICENSE_SIGNING_PRIVATE_KEY`. El pepper y la clave privada son secretos del backend central y no deben incluirse en el frontend, imágenes públicas, archivos `.env.example` con valores ni el repositorio. La clave pública identificada por el mismo ID se agrega a `local-license-config.js` al preparar una publicación. No generar una clave privada de producción durante desarrollo.

Las instalaciones nuevas requieren activación antes de configurar al propietario. Las instalaciones anteriores con acceso configurado o registros comerciales se reconocen como heredadas y pueden seguir utilizándose mientras completan la activación; esa transición protege el acceso a los datos existentes y no equivale a una comprobación de pago. La licencia no expira por tiempo. Revocación y transferencia se conocen al reconectar; no son inmediatas sin conexión. El navegador no proporciona una identidad física fiable del equipo, y un atacante con acceso al perfil o al código cliente puede manipular la aplicación; una licencia web evita activaciones casuales, no constituye DRM irrompible.

### Migración 018: limitador compartido de inicio de sesión

Crea `auth_login_rate_limits`, que conserva contadores por dirección de origen mediante un HMAC, sin guardar nombres de usuario ni direcciones IP en claro. Requiere 017. El backend limita los inicios de sesión antes de verificar la contraseña y comparte los contadores a través de MySQL entre sus instancias. Las filas con más de 24 horas se eliminan por lotes. No modifica cuentas, sesiones, permisos ni datos comerciales. La tabla es requisito del nuevo backend; desplegar el código antes de aplicar 018 hará que el login falle cerrado con un mensaje temporal. No se aplica automáticamente al iniciar el servidor ni se aplicó en esta tarea a ninguna base principal.

### Migracion 017: plan conectado Estandar

Amplia la restriccion de `business_subscriptions.plan_code` para aceptar `CONECTADO_ESTANDAR`, con hasta 5 usuarios activos por negocio. No reescribe suscripciones, pagos, usuarios ni otros datos y requiere la migracion 006. La prueba de compatibilidad conserva una suscripcion y un pago previos, admite el nuevo codigo y sigue rechazando codigos invalidos. Se aplica solo mediante el ejecutor oficial en bases nuevas o destinos autorizados; no se ha aplicado a `pos_multitenant` en esta tarea.

### Migracion 015: eventos historicos de inventario con cantidad cero

Conserva eventos de Kardex con cantidad cero en una tabla historica separada. No genera deltas ni altera existencias. Requiere que la consulta del Kardex combine ledger y eventos historicos.

### Migracion 016: ordenes historicas sin precio por linea

Permite representar como desconocidos, con `NULL` y `price_snapshot_available=0`, los precios por linea que el POS local nunca guardo. Los valores previos no nulos permanecen intactos; el CHECK impide combinar el indicador de precio ausente con importes inventados. Requiere 003 y 015. Se verifico en bases temporales; el plan oficial de solo lectura del 23 de octubre de 2026 confirmó 001–015 `APPLIED` y 016 `PENDING` en `pos_multitenant`, sin ejecutar DDL. Posteriormente, con autorización explícita y después de respaldo restaurable verificado, se aplicó solo 016; el plan posterior confirmó 001–016 `APPLIED`. El proyector historico requiere esta migracion para conservar ordenes canceladas cuyos precios originales no existen. Respaldo: `C:\Users\andre\Documents\POS-Backups\pos_multitenant-pre-016-20261023T182140.392Z-58fce0ff.sql`.
## Inventario y dependencias revisadas

| Version | Estado del archivo y esquema | Dependencias |
| --- | --- | --- |
| 001 | Presente: otorgante de autorizaciones | Base |
| 002 | Presente: operaciones idempotentes y valores de efectivo/cambio | 001 |
| 003 | Presente: flujo de Caja y pedidos centralizados | 002 |
| 004 | Presente: credito de clientes y conciliacion de abonos | 002, 003 |
| 005 | Implementada: estado PENDING para conciliacion de pagos de proveedores | 002, 003 |
| 006 | Presente: planes y pagos de suscripcion | Base |
| 007 | Presente: tipo de movimiento de inventario inicial | Base |
| 008 | Presente: referencias idempotentes de ventas locales | 002, 003 |
| 009 | Presente: referencias e importacion de compras historicas | Base |
| 010 | Presente: referencias de credito historico | 004, 008 |
| 011 | Presente: razon social en configuracion comercial | Base |
| 012 | Nueva: archivo reanudable por negocio de los registros locales de origen | 003, 008, 009, 010, 011 |
| 013 | Nueva: control de acceso hasta conciliar la importacion | 012 |
| 014 | Nueva: marcas y referencias para consultar operaciones locales historicas sin alterar saldos actuales | 013 |

### Migracion 012: archivo de origen local

Crea `migration_import_batches` y `migration_source_records`, cada una aislada por `business_id`. El endpoint de administrador de sistema valida el paquete local v2, su identidad y huella, conserva el contenido historico depurado por bloques reintentables y deja en estado pendiente las filas ambiguas, sin ID o que no pueden proyectarse sin riesgo. No crea ventas, compras, pagos, movimientos de caja ni stock, y no elimina ni actualiza Dexie. Los secretos y credenciales se omiten; se retienen etiquetas legibles de responsables. El archivo de imagen original puede permanecer en el JSON historico, pero aun no se publica en el almacenamiento de imagenes del negocio. El guardado del paquete no declara completa la migracion operativa.

El servicio requiere confirmacion explicita, destino INACTIVE creado para importacion, origen identificable y que las filas incluidas no declaren otro negocio. Si hay identidad ambigua, filas legadas sin negocio o alcance inconsistente, rechaza el guardado. Repetir el mismo paquete reanuda el lote por huella sin duplicar filas ni auditorias de finalizacion; un paquete distinto para el mismo origen se rechaza. Aplicar la 012 solo despues de respaldo y autorizacion para la base destino, con `npm.cmd run migrate:all --prefix backend -- --plan --target <base> --confirm-target <base>` y luego `--apply` sobre esa misma base. Las pruebas la aplican exclusivamente a bases temporales `pos_auth_test_*`.

Los archivos 001-004 y 006-010 ya existian en el arbol de trabajo; 005 era la migracion pendiente. El ejecutor verifica sus huellas completas antes de adoptar una aplicacion previa sin ledger. Estas notas describen el codigo local; no implican que se haya aplicado a la base principal.

## Migracion 020: identidad estable de negocios locales

Agrega una identidad local hasheada a las licencias y a sus instalaciones, sin depender del nombre del cliente y sin guardar el identificador local en claro en MySQL. No modifica ni rellena filas existentes. Las licencias antiguas siguen aceptando autorizaciones firmadas y pueden funcionar sin conexion; cuando una version actualizada vuelva a comunicarse, un estado firmado puede asociar su identidad persistida. El contador solo incluye negocios con identidad confirmada y licencia activa, sin revocar, y una instalacion activa coincidente. Las licencias antiguas que aun no se hayan conectado quedan fuera del conteo exacto hasta completar esa asociacion. La migracion requiere 019 y no se aplica automaticamente ni se ha aplicado a bases principales.

### Migracion 013: bloqueo hasta conciliar una importacion

Crea `business_migration_controls`, ligada al negocio, al administrador que inicia el proceso y al lote 012. El endpoint exclusivo de administrador general crea destinos INACTIVE con estado PENDING; el paquete solo puede asociarse a ese destino y su primer origen queda fijado para impedir mezclar otro negocio. El login, las sesiones y el cambio de estado a ACTIVE se bloquean mientras el control permanezca PENDING. La migracion no activa el destino y no cambia `schema.sql` ni filas existentes. Hoy no hay una proyeccion completa ni un verificador que pueda cambiar el control a COMPLETE; por tanto, los destinos quedan bloqueados hasta que se implemente y pruebe la conciliacion operativa.

### Migracion 014: operaciones historicas locales

Adiciona marcas historicas y nombres de responsables/estados originales en Caja, gastos, pagos a proveedores, inventario, ventas, compras y ordenes. Crea `migration_supplier_payment_references` para conservar la relacion de abonos locales con pagos MySQL y hacer seguros los reintentos. Los valores por omision dejan los registros actuales como operativos y la migracion no crea movimientos ni altera saldos. El importador administrativo la requiere para consultar operaciones historicas desde los modulos normales; solo se aplica automaticamente en las bases temporales del ejecutor. No se ha aplicado a `pos_multitenant`.
