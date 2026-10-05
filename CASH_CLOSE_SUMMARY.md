# Resumen y detalles del cierre de caja — 4 de octubre de 2026

## Implementación

La preparación en modo Caja centralizada también exige una caja abierta. Con Caja cerrada, el botón de enviar/preparar muestra exactamente **“Debes abrir caja antes de facturar o cobrar”**, no crea pedido pendiente, no crea factura y no escribe en Dexie. La misma regla se aplica al endpoint conectado, antes de insertar el pedido en MySQL; abrir Caja y reintentar permite continuar normalmente.

Cerrar Caja abre **Resumen de cierre de caja**; no realiza una escritura. El resumen identifica apertura, hora prevista de cierre y gestor. El cierre definitivo conserva la fecha/hora real registrada. Cancelar y Escape descartan el conteo sin cerrar Caja. Confirmar cierre exige efectivo real no negativo con hasta dos decimales; cero es válido. La diferencia se actualiza con faltante/sobrante y texto accesible. Todos los importes del resumen, detalles e historial usan C$ 0.00 con separador de miles.

Historial de Cierres incorpora Acción → Detalles. El modal de detalles no tiene campos editables ni acción de guardar. El foco inicial permite revisar el encabezado y el desglose; conserva la navegación de teclado, Escape, foco de retorno y desplazamiento en móvil. No se agregaron animaciones.

La fórmula conserva las entradas y salidas efectivas existentes: inicial + ventas efectivo + abonos efectivo + otras entradas efectivo − gastos − salidas/pagos efectivo − compras registradas en Caja − devoluciones efectivo. Crédito, tarjeta y transferencia aparecen como control; nunca suman al físico, incluso al confirmar pagos bancarios. Las ventas efectivo conectadas se obtienen de movimientos confirmados; las anulaciones se muestran como devolución separada, evitando restarlas dos veces. Cada cifra se calcula en backend con aritmética exacta. No se implementaron operaciones nuevas de compras, gastos ni movimientos manuales conectados: compras conectadas muestra C$ 0.00.

Local guarda el desglose en cajaSessions.resumenCierre (Dexie). Las correcciones/anulaciones de registros de origen conservan el esperado/diferencia del arqueo guardado. Los cierres anteriores sin desglose se reconstruyen con los registros disponibles; no se promete recuperar un snapshot histórico que nunca se guardó. Las compras locales solo se incluyen si existe una salida vinculada en Caja; el flujo previo de compras no crea esa salida automáticamente y no se amplió en esta tarea.

Conectado obtiene importes y nombre del actor exclusivamente de la sesión backend. Al cerrar, el resultado idempotente ya persistido en pos_operations contiene cash.summary y los importes del corte. Historial recupera ese desglose y el esperado almacenado en cash_sessions. Una anulación posterior de tarjeta pendiente no reescribe el snapshot. La conservación depende de retener el registro CLOSE_CASH existente; no se agregó una política de purga. No hay escrituras operativas conectadas en Dexie ni cola offline.

## Migraciones y alcance

## Alcance de Caja por sesión

La vista de Caja abierta usa únicamente la sesión vigente. En local, ventas, abonos, gastos y movimientos guardan `cajaSessionId` o `sessionId`; los registros locales antiguos sin ese campo usan la fecha de apertura como compatibilidad. El resumen, el efectivo esperado, las tarjetas por usuario y la tabla de movimientos ya no recorren cierres anteriores. El historial de cierres conserva el detalle completo de cada turno.

En conectado, ventas, confirmaciones y movimientos se consultan por `business_id` y `cash_session_id`. `sale_orders` no tenía `cash_session_id` en el esquema existente, por lo que los pedidos pendientes se separan con `created_at` respecto de `opened_at`: los de la sesión actual aparecen en Operaciones para revisión y los anteriores en Pendientes de sesiones anteriores. Un pedido histórico todavía puede cobrarse; la factura y el movimiento que produce quedan asociados a la sesión actual. No se aplicó ninguna migración ni se modificó `database/schema.sql`.

No requiere una migración nueva. No se preparó ni aplicó migración para este cambio. database/schema.sql permanece intacto. Los ejecutores existentes prueban las migraciones de ese workspace únicamente en bases aleatorias validadas pos_auth_test_* y las eliminan; ninguna fue aplicada a la base principal. No se cambiaron cuentas reales, no se hicieron commits ni despliegues, y no se realizó una venta real.

## Skill y revisión de interfaz

Skill utilizada: [.agents/skills/emil-design-eng/SKILL.md](.agents/skills/emil-design-eng/SKILL.md).

| Before | After | Why |
| --- | --- | --- |
| Cierre mostraba solo efectivo esperado y conteo. | Desglose por medio y origen con fechas y gestor antes de confirmar. | Revisar el corte sin confundir pagos bancarios con efectivo. |
| Confirmación vacía dependía de un aviso posterior. | Botón deshabilitado sin conteo válido y diferencia automática anunciada. | Evitar cierres incompletos e indicar faltante o sobrante. |
| Cancelar abría otra confirmación genérica. | Cancelar/Escape cierran el resumen sin cerrar Caja. | Cumplir el flujo de revisión sin escrituras. |
| Historial carecía de detalle del corte. | Acción Detalles abre el resumen guardado de solo lectura. | Revisar cierres ya realizados sin modificarlos. |
| Enfocar conteo desplazaba el encabezado fuera del modal. | El foco inicial se sitúa en el título; el contenido admite desplazamiento. | Leer el resumen desde su inicio en escritorio y móvil. |
| Aviso de apertura aparecía antes de terminar de actualizar Caja. | El aviso aparece después de completar la carga. | Permitir cobrar una orden después de abrir sin chocar con la operación todavía ocupada. |

## Alcance actual de las secciones de Caja

Operaciones para revisión y Movimientos de efectivo cambian de alcance según el estado de Caja. Con una sesión abierta muestran únicamente ventas, pagos, confirmaciones, órdenes y movimientos asociados a su `cash_session_id` (o identificador de sesión local). Sin una sesión abierta muestran el historial general almacenado para el negocio, incluidos movimientos y operaciones de cierres anteriores; sus títulos indican “historial general”. La sección Historial de Cierres y sus detalles no se modifican. En conectado, los pendientes históricos se separan solo mientras existe una sesión abierta; al cerrar pasan al historial general de las dos secciones.

## Archivos de esta tarea

- app.js: resumen local, desglose compartido, diferencia, detalles, formato y conservación de arqueos.
- local-cash-flow.js: valida Caja abierta antes de preparar una orden centralizada, sin crear registros parciales.
- api-client.js: conserva el mensaje público común para Caja cerrada.
- connected-sales.js: puente del resumen backend y aviso de apertura/cierre después de actualizar Caja.
- backend/src/services/sales.js: desglose exacto, actor autenticado y recuperación del snapshot idempotente.
- index.html, styles.css: modal, historial con acción, detalle y adaptación a móvil.
- tests/cash-close-summary.spec.cjs: regresiones nuevas locales DIRECT/CENTRALIZED, móvil, recarga, cancelación, validación, cálculo y solo lectura.
- tests-connected/sales.spec.cjs: regresiones nuevas de ambos flujos, recarga, snapshot tras anulación y aislamiento Dexie.
- tests/local-cash-flow.spec.cjs y tests-connected/sales.spec.cjs: aislamiento de Caja nueva, movimientos por sesión y pendientes de sesiones anteriores.
- backend/tests/integration/sales.test.cjs: comprobaciones ampliadas de cierre idempotente, desglose, reconciliación y conservación en historial.
- tests/login.spec.cjs: mismas pruebas previas; expectativas actualizadas del formato, botón deshabilitado e inmutabilidad del arqueo.
- dist: build público regenerado. PHASE53.md y este informe: documentación.

## Cambios justificados de expectativas

La petición exige C$ 0.00, conteo obligatorio y cierres de solo lectura. Se sustituyeron únicamente las expectativas previas de C$0.00, clic inválido seguido de alert y recálculo del arqueo tras correcciones/anulaciones de origen. Los escenarios siguen comprobando la corrección/anulación de sus movimientos y saldos; ahora también exigen conservar los valores originales del corte. No se eliminaron pruebas, no se ampliaron tiempos ni se forzaron clics.

## Validación previa del workspace

| Comprobación | Resultado exacto |
| --- | --- |
| ESLint completo final | 0 errores y 0 advertencias |
| Backend unitario | 57/57 aprobadas; 0 fallos, omitidas o canceladas |
| Integración MySQL aislada | 91/91 aprobadas; base temporal eliminada |
| Frontend local y fixtures HTTP, suite completa | 177/177 aprobadas en 5.9 minutos; incluye la preparación centralizada bloqueada con Caja cerrada |
| Repetición exclusiva de los dos fallos CDN | 2/2 aprobadas en 8.9 segundos, sin cambiar aserciones ni modificar el producto para resolver los fallos de red |
| Casos distintos frontend local/fixtures finalmente validados | 177/177 (162 locales y 15 fixtures HTTP) |
| Frontend conectado API/MySQL | 69/69 aprobadas en 3.5 minutos; incluye el rechazo antes de insertar pedidos con Caja cerrada; base temporal eliminada |
| Regresiones locales antiguas adaptadas | 15/15 aprobadas dentro de la suite completa |
| Resumen y teclado, última verificación escritorio/móvil | 2/2 aprobadas en 10.9 segundos |
| Resumen y fixtures HTTP específicos | 17/17 aprobadas en 39.3 segundos |
| Build público final | 13 archivos permitidos, idénticos byte por byte a sus fuentes; sin SQL, backend, documentación privada ni secretos |
| Capturas | Resumen y detalle inspeccionados en escritorio y móvil; importes completos y contenido desplazable |
| git diff --check final | 0 errores de espacios; solo avisos habituales LF/CRLF |
| database/schema.sql | Sin diferencias |

Validación adicional del alcance por sesión: backend unitario 57/57, integración MySQL 92/92, navegador conectado 70/70 y navegador local 179/179. La expectativa anterior que mostraba movimientos cerrados en la tabla central de Caja se actualizó para comprobar que los movimientos antiguos permanecen en Historial y no se mezclan con una sesión activa.

La suite completa encontró net::ERR_CONNECTION_RESET en html2pdf, html5-qrcode, Dexie y XLSX. Los dos casos afectados fueron “compra a crédito guarda proveedor, factura y vencimiento” y “GASTOS: valida descripción y monto obligatorios, rechaza cero, negativos y solo espacios”. Su repetición con --last-failed pasó; no se ocultaron errores ni se ampliaron tiempos. Las ejecuciones previas también detectaron la confirmación genérica al cancelar, las expectativas anteriores de moneda/arqueo y la carrera de apertura; se corrigieron antes de estas validaciones. Una ejecución previa iniciada antes de editar los títulos de pruebas se descartó como verificación final: su worker conservaba títulos anteriores.

El último ajuste de teclado evita que Mayús+Tab desde el título (tabindex=-1) salga del modal; tiene comprobaciones en escritorio y móvil. Después se volvieron a comprobar ESLint, build público y git diff --check.

Comandos utilizados:

~~~powershell
.\node_modules\.bin\eslint.cmd .
npm.cmd test --prefix backend
npm.cmd run test:integration --prefix backend
npm.cmd run test:frontend --prefix backend
node scripts/build-static.cjs
.\node_modules\.bin\playwright.cmd test --workers=2 --reporter=line --output=test-results-cash-summary-complete
.\node_modules\.bin\playwright.cmd test --last-failed --workers=1 --reporter=line --output=test-results-cash-summary-complete
.\node_modules\.bin\playwright.cmd test tests/cash-close-summary.spec.cjs --workers=1 --reporter=line --output=test-results-cash-summary-accessibility
git diff --check
git diff --exit-code -- database/schema.sql
~~~

## Prueba manual

1. Servir únicamente dist e iniciar sesión en la modalidad elegida. Para conectado, reiniciar la API para cargar el código nuevo y usar la configuración backend ya autorizada; no ejecutar migraciones como parte de esta prueba.
2. Abrir Caja con C$ 100.00.
3. Registrar una venta efectivo de C$ 10.00, una tarjeta de C$ 20.00 y una transferencia de C$ 30.00. En centralizada, preparar como vendedor y cobrar cada pedido desde Caja.
4. Abrir Caja → Cerrar Caja. Verificar apertura, hora prevista, gestor y desglose. El esperado debe ser C$ 110.00 si no hay otros movimientos; tarjeta y transferencia no lo incrementan.
5. Cancelar y comprobar que Caja continúa abierta. Reabrir el resumen; confirmar debe estar deshabilitado sin conteo.
6. Ingresar C$ 108.00: debe indicar faltante C$ -2.00. Ingresar C$ 112.00: sobrante +C$ 2.00. Confirmar cierre con el conteo real elegido.
7. Abrir Historial de Cierres → Detalles; verificar fecha real de cierre, esperado, real y diferencia. No debe haber campos editables.
8. Recargar y volver al historial (en local, iniciar sesión de nuevo). Verificar el mismo corte. Comprobar que tarjeta/transferencia pendientes conservan su control separado y que confirmarlas no genera efectivo.
