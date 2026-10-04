# Migracion 001: otorgante de autorizaciones

schema.sql no se modifica. Su session_authorizations identifica sesion/modulo/vencimiento pero no al administrador que proporciono la contrasena. Se agrega granted_by_user_id BIGINT UNSIGNED y FK (business_id, granted_by_user_id) -> users(business_id, id), con RESTRICT, usando la clave compuesta existente. No se crean tablas.

La columna admite NULL para conservar registros previos sin inventar un otorgante. El backend exige un otorgante activo ADMIN y solo acepta permisos con ese enlace, de modo que las concesiones anteriores sin otorgante quedan invalidadas. Toda nueva concesion del backend registra el ID y auditoria.

Aplicar una sola vez en la base seleccionada. Desde backend: npm.cmd run migrate:auth -- --apply. El script exige --apply, lee conexion desde el entorno y ejecuta solo este ALTER. Requiere permisos ALTER y no es idempotente: si la columna ya existe debe revisarse el estado, sin repetir ciegamente. Tambien puede ejecutarse el archivo SQL usando el cliente MySQL y seleccionando explicitamente la base. No existe endpoint HTTP de migracion.

Durante las pruebas la migracion se aplica solo a una base pos_auth_test_* aleatoria, que se elimina despues. No se ejecuto ALTER sobre pos_multitenant durante esta fase.

# Migracion 002: ventas e idempotencia

Crea pos_operations y agrega cash_received/change_amount a sales, con CHECK de efectivo y cambio. No modifica schema.sql ni 001. Ver [SALES.md](../../backend/SALES.md) para contrato, respaldo, aprobacion y comandos. Ejecutar desde raiz solo tras aprobacion: npm.cmd run migrate:sales --prefix backend -- --apply. DDL no es transaccional; una ejecucion parcial exige revision manual antes de repetir. Las pruebas aplican las migraciones necesarias solo en pos_auth_test_* temporales.

# Migracion 003: confirmacion y flujo de Caja central

Agrega ventas/cajero, actor y fecha de confirmacion de tarjeta/transferencia, la configuracion DIRECT/CENTRALIZED por negocio y las tablas de pedidos pendientes. Mantiene DIRECT como valor predeterminado. No altera schema.sql. Requiere 002. Para aplicarla a la base seleccionada hace falta aprobacion explicita: npm.cmd run migrate:cash-workflow --prefix backend -- --apply. El ejecutor rechaza estados parciales y DDL no transaccional; no repetir sin revisar information_schema. La integracion automatizada la aplica solo a su base pos_auth_test_* temporal y la elimina al finalizar.
