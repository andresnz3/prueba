> Ventas/caja de fase 5.3 implementadas segun [SALES.md](SALES.md). sales permite cobrar contado; cash exige autorizacion para apertura/cierre y history para consultas/anulaciones. Los otros modulos financieros siguen pendientes.

# Contrato de autenticacion

Todas las rutas tienen prefijo /api. IDs BIGINT se envian como cadenas decimales. Los cuerpos aceptan solo los campos documentados: campos adicionales (incluido businessId en operaciones autenticadas) dan 400. Las escrituras usan Content-Type: application/json, incluso DELETE y operaciones con cuerpo vacio {}.

| Metodo y ruta | Permiso / cuerpo | Respuesta |
| --- | --- | --- |
| GET /health | Publico | 200 ok / 503 degraded |
| GET /auth/csrf | Publico o sesion | csrfToken; cookie inicial HttpOnly si no hay sesion |
| POST /auth/login | CSRF inicial; {username, password} | Usuario con businessId, businessName y businessStatus resueltos por el servidor; expiresAt, csrfToken y cookie de sesion |
| GET /auth/me | Sesion valida | Usuario, expiresAt, csrfToken |
| POST /auth/logout | Sesion + CSRF; {} | 204; revoca sesion, permisos y cookie |
| POST /auth/renew | Sesion + CSRF; {} | Rota token/cookie y CSRF, renueva expiracion; revoca permisos |
| GET /auth/access/:module | Sesion y acceso al modulo | 200 permitido / 403 denegado; sin operaciones de negocio |
| POST /auth/authorizations | VENDEDOR + CSRF; {module, adminUsername, adminPassword} | 201; permiso temporal y grantedByUserId |
| DELETE /auth/authorizations/:module | Sesion + CSRF; {} | 204; revoca permiso al salir |
| POST /auth/modules/:module/enter | Sesion + CSRF; {} | Revoca permisos de otros modulos; 200 o 403 |
| GET /users?limit=50&offset=0 | ADMIN | Usuarios propios, sin hashes; limite maximo 100 |
| POST /users | ADMIN + CSRF; {username, fullName, password, role} | 201; crea cuenta activa en el negocio de la sesion |
| PATCH /users/:id | ADMIN + CSRF; uno o mas de {fullName, role, active} | 200; actualiza cuenta propia del negocio |
| PUT /users/:id/password | ADMIN + CSRF; {password} | 204; cambia contrasena y revoca sesiones/permisos |

Roles exactos: ADMIN y VENDEDOR. ADMIN solo controla su negocio. VENDEDOR accede directamente a sales. Los modulos restringidos son inventory, purchases, payables, clients, suppliers, history, cash, expenses, reports, dashboard, settings. El mapeo futuro de UI es salesView->sales, inventoryView->inventory, purchasesView->purchases, payablesView->payables, clientsView->clients, suppliersView->suppliers, historyView->history, cajaView->cash, gastosView->expenses, reportesView->reports, dashboardView->dashboard, configView->settings. Se usa un administrador identificado por adminUsername porque puede haber varios y cada concesion debe identificar al otorgante. La autorizacion no incluye administracion de usuarios.

El otorgante debe ser ADMIN activo del mismo negocio; se comprueba su hash Argon2id. Se registra el otorgante en session_authorizations y audit_logs. Solo hay un modulo temporal por sesion, durante 300 s por defecto y nunca mas alla del vencimiento de la sesion. Renovar sesion obliga a solicitar de nuevo la autorizacion. Salir con DELETE o navegar usando enter revoca el permiso anterior. Un cambio de contrasena/rol/estado del otorgante elimina sus concesiones. Los permisos legacy con granted_by_user_id NULL no se aceptan. requireModule en middleware/authentication.js queda disponible para proteger futuros endpoints de operaciones; inventory se implementa en esta etapa segun INVENTORY.md; los demas modulos siguen pendientes.

## Seguridad

- Argon2id: 19 MiB, dos iteraciones y paralelismo uno; sal aleatoria. Contrasenas nuevas: 12 caracteres minimo, maximo 256 bytes, sin truncado ni conversion silenciosa. El login busca el username, verifica la contrasena y deriva negocio desde users.business_id. Usuario inexistente, contrasena incorrecta, usuario inactivo y negocio inactivo tienen errores claros; usernames repetidos entre negocios devuelven USERNAME_AMBIGUOUS para que se corrijan sin seleccionar una cuenta arbitrariamente.
- Tokens de sesion: 32 bytes criptograficamente aleatorios. Solo SHA256(token) llega a MySQL; el token se entrega exclusivamente en la cookie HttpOnly. Ningun hash de contrasena o token de sesion aparece en las respuestas.
- Cookie sin Domain, Path=/, SameSite=Lax por defecto y Secure en produccion. En produccion usa prefijo __Host-. COOKIE_SAME_SITE admite lax, strict y none; none requiere produccion/Secure. El futuro despliegue en dominios diferentes requiere HTTPS y revisar SameSite/CORS antes de conectar el frontend. No se confia automaticamente en headers de proxy.
- CSRF: el login requiere un token inicial firmado, cookie HttpOnly y header X-CSRF-Token coincidentes (vence en 10 minutos). Las escrituras autenticadas requieren un token HMAC ligado al hash de esa sesion. Se compara en tiempo constante. CORS solo permite origenes exactos, credenciales y el header CSRF; JSON impide formularios simples. Clientes sin Origin pueden usar la API con cookies y CSRF, como PowerShell/Postman.
- Sesion: 30 minutos, renovacion explicita y tope absoluto de ocho horas. Usuarios y negocio se verifican en cada peticion. No hay renovacion automatica en GET. Token y CSRF anteriores dejan de funcionar tras renovar. Logout no borra el historial de sesiones.
- Limites: diez intentos por identidad por 15 minutos y cincuenta por IP, tanto login como concesion de permisos. Cuenta antes de verificar, incluyendo exitos, para acotar trabajo de Argon2. HTTP 429 incluye Retry-After. Almacen acotado de un proceso; reinicios reinician los contadores. No es un limitador distribuido.
- Todas las consultas con datos externos son parametrizadas. Login no acepta businessId. Tras autenticar, negocios/usuarios/permisos se toman de la sesion. Las claves compuestas impiden referencias entre negocios. Transacciones y bloqueo del negocio serializan cambios sensibles y protegen al ultimo administrador activo incluso contra carreras. Desactivar o degradar al ultimo ADMIN devuelve 409 LAST_ACTIVE_ADMIN.
- Cambios de rol, estado o contrasena revocan las sesiones del usuario y sus autorizaciones. Cambiar solo fullName no revoca sesiones. Al modificar la propia contrasena/rol hay que iniciar sesion nuevamente. Usuarios se desactivan, no se borran.
- Errores publicos: 400 validacion, 401 contrasena incorrecta/usuario inexistente/sesion, 403 usuario o negocio inactivo/permisos/CSRF/origen, 409 username ambiguo/duplicado/ultimo ADMIN, 429 intentos y 500 error interno. Sin SQL, stack ni credenciales. La auditoria registra acciones exitosas y otorgantes, sin contrasenas, tokens o CSRF.

## Ejemplo PowerShell (sin frontend)

Crear el primer negocio siguiendo README.md e iniciar npm.cmd run dev en otra terminal. El login conectado solo necesita usuario y contrasena; el backend obtiene business_id desde users:

```powershell
$posApi = 'http://127.0.0.1:3000/api'
$posHttp = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$posCsrf = Invoke-RestMethod "$posApi/auth/csrf" -WebSession $posHttp
$posUsername = Read-Host 'Usuario'
$posPassword = Read-Host 'Contrasena' -AsSecureString
$posLoginBody = @{
  username = $posUsername
  password = ([System.Net.NetworkCredential]::new('', $posPassword)).Password
} | ConvertTo-Json
$posLogin = Invoke-RestMethod "$posApi/auth/login" -Method Post -WebSession $posHttp -ContentType 'application/json' -Headers @{'X-CSRF-Token' = $posCsrf.csrfToken} -Body $posLoginBody
Remove-Variable posPassword, posLoginBody
$posHeaders = @{'X-CSRF-Token' = $posLogin.csrfToken}
Invoke-RestMethod "$posApi/auth/me" -WebSession $posHttp
Invoke-RestMethod "$posApi/users" -WebSession $posHttp
$posRenew = Invoke-RestMethod "$posApi/auth/renew" -Method Post -WebSession $posHttp -ContentType 'application/json' -Headers $posHeaders -Body '{}'
$posHeaders = @{'X-CSRF-Token' = $posRenew.csrfToken}
Invoke-RestMethod "$posApi/auth/logout" -Method Post -WebSession $posHttp -ContentType 'application/json' -Headers $posHeaders -Body '{}'
```

Para crear VENDEDOR, mientras se mantiene la sesion ADMIN, POST /users con username, fullName, password y role=VENDEDOR (usar lectura oculta de la contrasena, como arriba). Iniciar sesion con el vendedor en un WebRequestSession separado. GET /auth/access/inventory debe dar 403; POST /auth/authorizations con module=inventory, adminUsername y adminPassword permite ese modulo. DELETE /auth/authorizations/inventory con {} lo revoca; GET de acceso vuelve a 403. No imprimir ni guardar contrasenas/cookies/CSRF en archivos de ejemplos. En Postman usar su cookie jar, obtener csrfToken y copiarlo a X-CSRF-Token. Cerrar sesion antes de iniciar con otra cuenta en el mismo cookie jar.
