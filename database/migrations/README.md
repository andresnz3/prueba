# Migracion 001: otorgante de autorizaciones

schema.sql no se modifica. Su session_authorizations identifica sesion/modulo/vencimiento pero no al administrador que proporciono la contrasena. Se agrega granted_by_user_id BIGINT UNSIGNED y FK (business_id, granted_by_user_id) -> users(business_id, id), con RESTRICT, usando la clave compuesta existente. No se crean tablas.

La columna admite NULL para conservar registros previos sin inventar un otorgante. El backend exige un otorgante activo ADMIN y solo acepta permisos con ese enlace, de modo que las concesiones anteriores sin otorgante quedan invalidadas. Toda nueva concesion del backend registra el ID y auditoria.

Aplicar una sola vez en la base seleccionada. Desde backend: npm.cmd run migrate:auth -- --apply. El script exige --apply, lee conexion desde el entorno y ejecuta solo este ALTER. Requiere permisos ALTER y no es idempotente: si la columna ya existe debe revisarse el estado, sin repetir ciegamente. Tambien puede ejecutarse el archivo SQL usando el cliente MySQL y seleccionando explicitamente la base. No existe endpoint HTTP de migracion.

Durante las pruebas la migracion se aplica solo a una base pos_auth_test_* aleatoria, que se elimina despues. No se ejecuto ALTER sobre pos_multitenant durante esta fase.
