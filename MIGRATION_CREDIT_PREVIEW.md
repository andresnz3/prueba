# Etapa 1: vista previa de créditos y abonos históricos

16 de octubre de 2026. Solo revisión y conciliación. No hay implementación de importación de créditos/abonos, ruta de escritura ni migración SQL nueva. No se consultó ni modificó la base principal. Se preservaron los cambios que ya existían en el workspace.

## Uso y resultado

En Administración del sistema → Migraciones, seleccionar el destino y cargar el paquete JSON. Aparece Créditos y abonos históricos · Vista previa. Revisar créditos y abonos vuelve a consultar el destino. Las tablas muestran facturas originales, identificadores locales completos, cliente, fechas/vencimiento, total, aplicado, saldo y estado. Los detalles desplegables contienen abonos, distribuciones y conciliación por cliente. Las fechas se muestran en America/Managua.

El paquete local prueba-compras.json contiene 27 ventas y 7 abonos. Se reconocen tres ventas de Diana: factura 14 C$25.00, factura 15 C$43.70 y factura 16 C$37.40. Las tres están pagadas; total C$106.10, aplicado C$106.10, saldo C$0.00. Sus tres abonos figuran pendientes en caja local pero ya reducen deuda. Los otros cuatro abonos son de proveedores y quedan fuera de esta etapa.

## Contrato y seguridad

POST /api/system-admin/migration/credit/preview acepta targetBusinessId y package. Exige la sesión propietaria de administración del sistema, CSRF y cuerpo estricto. El destino debe existir y estar activo. El JSON no concede autoridad; se mantiene la política administrativa existente para elegir destinos. Cada lectura operativa se filtra por business_id; la consulta de disponibilidad de tabla se restringe al esquema actual.

El servicio ejecuta exclusivamente SELECT, sin transacción de escritura, FOR UPDATE ni auditoría persistida. Lee clientes, créditos, abonos, referencias y auditorías existentes. No llama servicios de venta/cobro y no toca inventario, Kardex, caja ni Dexie. La tabla de referencias existente se consulta solo si está disponible; no se aplica SQL para habilitar la vista previa.

La respuesta siempre declara previewOnly=true y canImport=false. No existe endpoint de importación de créditos. El botón permanece deshabilitado incluso si todo concilia. Las importaciones existentes mantienen sus contratos y su lógica.

## Reglas de conciliación

- Cálculos en centavos enteros; IDs de origen conservados como texto, incluidos decimales.
- Abonos vigentes a factura primero; abonos generales distribuidos por antigüedad, con desempate por ID. Se preserva la fecha original de cada pago.
- Abonos anulados se muestran sin reducir deuda. Estado de caja pendiente se conserva como evidencia y se distingue de su efecto en la deuda local.
- Sobresaldos, pagos huérfanos, clientes ambiguos, referencias repetidas, coincidencias de contenido, importes inválidos, fechas ambiguas, deuda sin factura y diferencias de saldo bloquean la revisión.
- Deuda sin factura ausente no se infiere. Si hay remanentes de abonos generales sin factura, quedan pendientes de conciliación: no se vuelve a descontar automáticamente la deuda inicial actual.
- Historia financiera o saldo inicial existente para el cliente destino se trata conservadoramente como posible duplicación, sin concluir que toda coincidencia sea un duplicado confirmado.
- Referencias ya importadas y otros orígenes históricos se advierten y bloquean para revisión. No se corrigen ni sobrescriben datos.
- Cambios de archivo, destino y cierre de sesión invalidan resultados anteriores. Errores de lectura dejan las tablas vacías y la importación bloqueada. Los textos del paquete se renderizan con textContent.

## Revisión de interfaz

Skill aplicada: .agents/skills/emil-design-eng/SKILL.md.

| Before | After | Why |
| --- | --- | --- |
| Créditos excluidos del importador sin conciliación propia | Panel de facturas, abonos y saldos por cliente | Revisar deuda histórica antes de habilitar escrituras |
| Pendiente podía confundirse con deuda sin pagar | Estado original y efecto en deuda separados | Respetar la semántica local sin inventar ingresos de caja |
| Datos extensos e IDs decimales difíciles de revisar en móvil | Tablas con desplazamiento horizontal accesible y detalles desplegables | Conservar referencias completas y controles utilizables |
| Sin estados específicos para esta revisión | Carga, errores, bloqueos e importación siempre deshabilitada | Evitar interpretar una vista previa como autorización de importación |

## Verificación

Pruebas nuevas de cálculo, servicio de lectura, API y HTTP: abonos parciales, pagados, generales y anulados; errores financieros; duplicados; aislamiento; permisos/CSRF; repetición sin escrituras; transporte compacto del paquete real; signo de diferencias. Pruebas Chromium sobre dist en 1440 y 390 píxeles, con paquete real y destino simulado: resultados, accesibilidad del desplazamiento, errores, otro origen, texto no ejecutable y respuestas tardías. Regresión de importación de compras existente incluida. Las pruebas anteriores no se modificaron.

También se ejecutan ESLint completo, suite unitaria backend, verificación del build público y git diff --check. Los casos anteriores que dependen de prueba de ventas.json se omiten porque ese archivo no está disponible; el paquete prueba-compras.json sí se verificó en las pruebas nuevas. No se ejecuta el runner MySQL en esta etapa: aplica migraciones SQL al preparar sus bases y el alcance aprobado pide pruebas enfocadas sin ejecutar nuevas migraciones.

Pendiente para una etapa posterior: implementación de escrituras, referencias persistentes de abonos y tratamiento aprobado de saldos iniciales/remanentes. La aprobación de esta etapa no autoriza importaciones sobre la base principal.


## Etapa 2: importación transaccional, solo aislada

La importación reutiliza la conciliación de la etapa 1 y vuelve a validar dentro de una transacción. Bloquea inconsistencias financieras, correspondencias ausentes o ambiguas, deuda inicial existente y operaciones financieras de destino. La advertencia por historial de origen que no coincide o no puede verificarse requiere confirmación explícita; también queda en la auditoría.

La migración SQL nueva es `database/migrations/010_local_credit_migration.sql`. Añade marcas históricas a ventas y abonos, guarda el estado local original del abono y crea referencias idempotentes con negocio, origen, identificadores locales completos y huellas de contenido. Cada abono aplicado queda `POSTED` y conserva `source_status`; los cancelados quedan `VOID`. Las facturas y líneas mantienen cliente, número original, fechas e importes. Los abonos generales se dividen entre facturas según la distribución conciliada.

La transacción crea facturas, detalles, abonos, referencias y auditoría con actor. Un reintento con el mismo contenido omite filas ya importadas; si cambia el contenido asociado al mismo ID de origen, se bloquea. Las ventas y abonos llevan `cash_session_id` nulo: no se crean movimientos, sesiones ni registros de inventario. La vista de Caja omite únicamente filas con `is_historical=TRUE` cuando existe la columna de la migración 010; las operaciones existentes mantienen su comportamiento. La anulación de ventas históricas se rechaza y los abonos importados no son pagos pendientes que puedan confirmarse.

El paquete real concilia las tres facturas de Diana: factura 14, C$25.00; factura 15, C$43.70; factura 16, C$37.40. Total C$106.10, abonos aplicados C$106.10, saldo final C$0.00. Los tres IDs de venta, incluidos sus decimales, se conservan. Sus abonos locales con estado `pendiente` se importaron como `POSTED` con ese estado guardado como metadato.

## Verificación de etapa 2

La suite unitaria backend termina con 133 aprobadas, 0 fallos y 1 omitida por ausencia del JSON histórico de ventas. La integración completa de MySQL aislada termina con 109 aprobadas, 0 fallos y la misma prueba omitida; el runner valida y elimina la base temporal `pos_auth_test_*`. Incluye el paquete real, deudas pendientes, parciales y pagadas, abonos generales, anulaciones, inconsistencias, conflicto de contenido, reintentos, rollback, aislamiento y que Caja no liste facturas/abonos importados. No se ejecutó SQL contra `pos_multitenant` y `database/schema.sql` permanece intacto.

Chromium enfocado: vista previa de etapa 1, 5/5; flujo conectado de importación/idempotencia, 1/1. Las suites generales también se ejecutaron: local, 170 aprobadas / 37 fallos / 1 omitida; conectada, 57 aprobadas / 33 fallos. Esas corridas generales reportaron problemas preexistentes fuera del flujo enfocado, como expectativas antiguas de mensajes/estructura, recursos CDN bloqueados y timeouts bajo concurrencia. Se corrigieron los fallos del panel de créditos y se repitieron sus pruebas enfocadas; el resto de fallos generales sigue pendiente de su propia revisión.

No se importaron datos reales a la base principal. No se hizo commit ni se avanzó a CxP o caja histórica.

## Resultados finales de etapa 1

| Comprobación | Resultado |
| --- | --- |
| Pruebas nuevas backend/cálculo/API/HTTP | 29 aprobadas |
| Suite unitaria backend completa | 133 aprobadas, 0 fallos, 1 omitida anterior por archivo ausente |
| Chromium enfocado final | 6/6 aprobadas: 5 nuevas + 1 regresión de compras |
| Caso anterior de origen de ventas | Omitido por ausencia de prueba de ventas.json; no se alteró su prueba |
| ESLint completo | 0 errores, 0 advertencias |
| Build público | 22 archivos idénticos a fuentes públicas; servido exclusivamente desde dist |
| Capturas de escritorio/móvil | Revisadas visualmente; tablas desplazables y detalles legibles |
| git diff --check | Sin errores; avisos habituales LF/CRLF |
| database/schema.sql | Sin cambios |
| SQL nuevo, importación real, commit | No ejecutados |

Archivos de esta etapa: backend/src/services/system-admin-credit-preview.js (nuevo), backend/src/services/system-admin.js, backend/src/routes/system-admin.js, api-client.js, connected-auth.js, local-migration-preview.js, index.html, styles.css, backend/tests/credit-preview.test.cjs (nuevo), tests/migration-credit-preview.spec.cjs (nuevo) y este informe. Se regeneró dist, que conserva únicamente los archivos públicos permitidos. No se modificaron los importadores existentes ni sus pruebas; los cambios previos del workspace permanecen.
