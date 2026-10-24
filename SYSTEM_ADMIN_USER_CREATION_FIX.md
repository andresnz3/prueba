# Correccion de alta de usuarios desde Administracion del sistema

18 de octubre de 2026. Skill aplicada: `.agents/skills/emil-design-eng/SKILL.md` para errores accesibles, foco y conservacion de campos.

## Causa reproducida

El caso comunicado usa `yo` como usuario y `yo2` como nombre completo. `yo` tiene dos caracteres; la regla existente tanto de alta como de inicio de sesion exige entre 3 y 100 caracteres ASCII permitidos. El nombre completo `yo2` es valido y el rechazo se produce antes de consultar o insertar usuarios en MySQL. Cambiar entre ADMIN y VENDEDOR no elimina esa restriccion.

La API devuelve exactamente **HTTP 400, INVALID_INPUT**. Antes del arreglo no identificaba el campo. El formulario dependia de la validacion nativa con el patron `[A-Za-z0-9_.-]{3,100}`: Chromium rechaza ese patron bajo las reglas actuales de `pattern` (flag v) por el guion sin escapar y omite esa comprobacion. En una pagina aislada el patron original acepta `yo`, mientras el corregido lo rechaza. El navegador registra `Invalid character in character class`. El panel no mostraba una explicacion junto al campo y el error generico podia quedar lejos del formulario.

Se reprodujo el fallo con usuario/nombre del ejemplo y una contrasena sintetica. No se copio ni uso la contrasena compartida por el usuario. Una alta con nombre de usuario valido dio HTTP 201 incluso antes del arreglo: no era una falla general de insercion, autenticacion o asignacion SQL.

## Cambios

- `index.html`: patron de usuario compatible con Chromium, minimo explicito de tres caracteres y ayuda visible. El formulario usa validacion controlada para evitar depender solo del aviso nativo.
- `connected-auth.js`: mensajes junto a cada campo, `aria-invalid`, descripcion accesible y foco en el primer error; valida usuario, nombre, rol y limites existentes de contrasena (12 caracteres como minimo, 256 bytes como maximo). Los errores conservan usuario, nombre y rol; los duplicados se explican junto al usuario. Los errores de la API se asocian al campo correspondiente. La contrasena se limpia tras un intento de envio al servidor. Se captura el destino y los datos antes de esperar la verificacion de sesion y se desactiva la seleccion de negocio durante el envio.
- `backend/src/middleware/validation.js`: agrega `newUser`, con las mismas reglas existentes y metadato `field` en los errores. Rechaza campos extras como businessId o active.
- `backend/src/routes/system-admin.js`: usa esa validacion en POST `/api/admin/businesses/:id/users`; mantiene autenticacion del propietario del sistema, CSRF y el ID de destino validado en la ruta.
- `api-client.js`: comprueba ID de negocio y respuesta completa (identidad, activo, rol y negocio), reutilizando el validador de usuario.
- `backend/tests/system-admin-users-validation.test.cjs`: 12 casos unitarios nuevos de validacion, limites y rechazo de autoridad inyectada.
- `tests-connected/system-admin-users.spec.cjs`: cinco casos nuevos por navegador/API/MySQL: altas ADMIN y VENDEDOR con login/permisos; `yo` rechazado con error visible para ambos roles; validaciones, sesion y CSRF.
- `dist`: regenerado exclusivamente con los 22 archivos publicos permitidos.

No se cambio la politica de nombres para aceptar dos caracteres. Un usuario como `yo2` satisface el minimo; debe estar libre en todos los negocios. No se modifico el servicio de alta SQL ni el algoritmo de contrasenas porque funcionaban correctamente.

| Before | After | Why |
| --- | --- | --- |
| Patron HTML invalido en Chromium dejaba pasar un usuario de dos caracteres | Guion escapado y validacion explicita antes del envio | Aplicar en pantalla la misma regla que usa el servidor |
| Rechazo generico sin campo visible | Mensaje junto a Usuario, aria-invalid y foco | Explicar la correccion sin aparentar un reinicio del formulario |
| Duplicado mostrado solo como aviso general | Explicacion junto al usuario y datos no sensibles conservados | Permitir elegir otro nombre sin repetir todo |
| Destino leido despues de esperar la sesion | Destino capturado al enviar; selector temporalmente desactivado | Mantener la asignacion al negocio elegido para ese intento |

## Seguridad y aislamiento comprobados

Se revisaron el formulario, cliente, rutas, middleware de sesion/CSRF, servicio de alta, consultas parametrizadas, indices, auditoria y hash. La autoridad sigue procediendo de la sesion autenticada de `andres`, ADMIN del negocio 1. El negocio destino se toma exclusivamente del parametro de ruta validado para esa operacion administrativa; un businessId adicional en el cuerpo se rechaza.

Las pruebas crean usuarios solo en bases aleatorias `pos_auth_test_*`, verificadas contra el nombre configurado de la principal y eliminadas al terminar. Para cada rol comprueban HTTP 201, active=true, rol exacto, una sola fila y business_id del destino. El hash almacenado es Argon2id, verifica la contrasena sintetica y difiere de ella. La API no expone password_hash. No se cambian contrasenas ni usuarios reales.

Los duplicados, incluso con distinta capitalizacion, se rechazan con HTTP 409 USERNAME_EXISTS en el mismo negocio y en otro, segun la politica global existente del panel. El esquema tiene unicidad por negocio; el servicio global agrega su comprobacion entre negocios. No se introdujo una nueva garantia o indice global ni se cambio el flujo ordinario de gestion de usuarios de cada negocio.

Los usuarios nuevos inician sesion en el negocio destino. ADMIN puede consultar sus usuarios; VENDEDOR recibe 403 en esa consulta. Ambos reciben 403 en administracion del sistema y al intentar crear usuarios en otro negocio. Se verifica que el listado del administrador destino no contenga al propietario del negocio 1. Solicitudes anonimas reciben 401 y sin CSRF reciben 403.

Se comparan conteos de ventas, compras, productos, Kardex y sesiones/movimientos de caja antes y despues de las pruebas enfocadas: no cambian. Las suites generales ejercitan sus propios fixtures operativos exclusivamente en bases de prueba descartables.

## Verificacion

- Reproduccion anterior: alta valida HTTP 201; caso `yo` HTTP 400 INVALID_INPUT sin field y prueba de mensaje junto al campo fallida.
- Reproduccion de concurrencia anterior: seis altas simultaneas entre negocios dieron HTTP 201; no se encontro un fallo de concurrencia que explique este caso y no se modifico SQL para ese supuesto.
- Patron HTML aislado: el original acepta `yo` al ignorar el patron invalido; el corregido lo rechaza.
- ESLint completo: 0 errores y 0 advertencias.
- Backend unitario: 145 aprobadas, 0 fallos, 1 omitida por archivo historico ausente (12 pruebas nuevas).
- Integracion MySQL completa: 109 aprobadas, 0 fallos, 1 omitida por el mismo archivo ausente; base temporal eliminada.
- Pruebas enfocadas de navegador/API/MySQL: cinco aprobadas en la ejecución final; capturas revisadas y patrón HTML comprobado. Regresión completa: Conectado completo: 61 aprobadas y 34 fallidas; los cinco casos nuevos pasan también dentro de la suite completa y los 34 fallos coinciden exactamente con la línea base de etapa 3. Local completo: 174 aprobadas, 33 fallidas y 1 omitida de 208. Comparadas por archivo y título con la etapa 3: 0 fallos nuevos; 1 fallo histórico no reapareció.
- Build publico: 22 archivos permitidos, identicos a fuentes, sin extras.
- `database/schema.sql`: sin cambios. No se creo ningun archivo de migracion nuevo; el runner solo usa las migraciones ya existentes para construir sus bases temporales. No se ejecuto ninguna migracion en la principal.
- `git diff --check`: sin errores; avisos habituales LF/CRLF.

Los cambios funcionales de esta tarea se limitan a los cinco archivos indicados, los dos archivos nuevos de pruebas y el build publico. Se preservaron los cambios que ya habia en el workspace.

No se accedio a la principal para crear ni modificar registros. No se crearon usuarios de prueba en `pos_multitenant`, no se modificaron usuarios reales ni operaciones reales, no se hizo commit ni despliegue. La solucion no requiere cambios de esquema ni autorizacion de escritura sobre la base principal.
