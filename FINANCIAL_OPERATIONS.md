# Operaciones financieras conectadas — 20 de octubre de 2026

Las tres etapas se implementaron y verificaron en orden. Se conserva el modo local; sus handlers solo delegan al backend cuando `connectedMode` está activo. No se añadieron dependencias, migraciones ni modificaciones de `database/schema.sql`.

## Etapa 1: recuperación persistente

Compras, anulaciones de compras, gastos, anulaciones de gastos y pagos a proveedores utilizan el coordinador financiero de ventas. Antes de enviar se persiste únicamente `{key, kind}`, con alcance de URL de API, negocio y usuario. No se almacenan cuerpos financieros ni credenciales ni se crea una cola offline. Si falla el almacenamiento, no se envía la operación.

Una respuesta incierta bloquea nuevas operaciones del mismo coordinador y habilita **Comprobar operación**, visible fuera de los modales. Recargar conserva la referencia. El resolver requiere sesión, CSRF, propietario de la operación y permiso del módulo correspondiente. Recupera el resultado registrado o escribe un descarte bajo el mismo bloqueo transaccional por negocio que usan los escritores; una petición tardía con esa clave no puede registrar dinero después del descarte. Las respuestas inválidas conservan el bloqueo. Web Locks serializa el inicio entre pestañas cuando está disponible; se conserva la comprobación de la referencia persistente en navegadores sin esa API.

Los rechazos explícitos de esquema sin escrituras no se tratan como resultados inciertos. Por ejemplo, el rechazo existente de un pago bancario a proveedor por falta de 005 conserva su formulario para corregir el medio.

Verificación de etapa: 7/7 casos de navegador y 4/4 resultados de integración, sin fallos finales.

## Etapa 2: reversión auditada

Estados de cuenta de clientes y proveedores ofrecen **Revertir abono** / **Revertir pago**. Se exige motivo. El backend requiere permiso `clients` o `payables`, respectivamente, y también `cash` si hay compensación de efectivo. Sesión y autorización se revalidan antes y después de la transacción.

- El pago original se conserva como `VOID`, con fecha, actor y motivo. El saldo se recalcula desde los documentos y pagos vigentes; no se fabrican ajustes directos de deuda.
- Un abono pendiente se anula junto con su movimiento pendiente y libera la reserva de saldo, sin cambiar el efectivo.
- El efectivo de un abono de cliente sale de la caja actual. El efectivo devuelto por un proveedor entra en la caja actual. Se enlaza el movimiento `REVERSAL` al movimiento original; no se cambian cierres ni se elimina historial. Se requiere caja abierta y, para devolver al cliente, fondos suficientes.
- Para un pago no monetario ya registrado se exige confirmación expresa de devolución externa por el mismo medio. El POS registra la reversión contable y la declaración en auditoría; no opera la cuenta bancaria ni mueve efectivo físico.
- La misma clave/cuerpo devuelve el resultado previo. Otra reversión del pago ya anulado se rechaza. Una clave reutilizada con otro cuerpo se rechaza.
- Solo son reversibles pagos operativos de documentos de crédito vigentes. Históricos y pagos iniciales de compras de contado no se convierten en operaciones nuevas: para una compra de contado se conserva el flujo existente de anulación de compra.

Los estados de cuenta conservan el pago anulado, su motivo y el nombre de quien lo revirtió. La API también devuelve la fecha de anulación. Auditoría guarda importe, medio, estado anterior, documento, caja original/actual, motivo y clave.

Verificación de etapa: 10/10 casos de navegador y la integración específica aprobados. Incluye pérdida de respuesta al revertir, recarga, permisos, otro negocio, motivo vacío, cierre original intacto, saldo restituido, insuficiencia de efectivo, reversiones concurrentes, declaración bancaria y rollback por fallo de auditoría.

## Etapa 3: entradas y retiros manuales

Los controles existentes de Caja envían `IN`/`OUT`, importe y motivo. El servidor asigna negocio, turno y responsable desde la sesión, exige permiso `cash` y caja abierta y registra `MANUAL_ENTRY` / `MANUAL_EXIT` confirmados y auditados. El importe debe ser positivo y tener como máximo dos decimales; se rechazan retiros sin fondos y desbordamiento del saldo admitido.

El movimiento y su resultado idempotente se guardan en una sola transacción. Caja, efectivo esperado, reporte y cierre incluyen el movimiento. Se exponen motivo, actor y enlace de reversión en la API de reportes. Los controles conservan sus campos ante rechazo; tras confirmación o recuperación se limpian. La recuperación usa la misma referencia persistente de las etapas anteriores.

Se retiró exclusivamente el antiguo bloqueo de eventos para esos dos botones en `connected-inventory.js`; otros controles no integrados conservan su bloqueo.

## Contrato añadido

Todas las rutas usan el prefijo `/api`, autenticación, CSRF y JSON; todas las consultas se limitan al negocio autenticado.

| Ruta POST | Cuerpo |
| --- | --- |
| `/financial/operations/:key/resolve` | `{kind}` |
| `/financial/customer-payments/:id/reverse` | `{operationKey, reason, externalRefundConfirmed?}` |
| `/financial/supplier-payments/:id/reverse` | `{operationKey, reason, externalRefundConfirmed?}` |
| `/financial/cash/movements` | `{operationKey, direction, amount, reason}` |

Tipos recuperables: `PURCHASE`, `CANCEL_PURCHASE`, `EXPENSE`, `CANCEL_EXPENSE`, `SUPPLIER_PAYMENT`, `CUSTOMER_PAYMENT_VOID`, `SUPPLIER_PAYMENT_VOID`, `CASH_MANUAL`. La recuperación requiere la clave del mismo usuario, negocio y tipo; el descarte devuelve `ABANDONED`.

## Revisión de interfaz

Skill utilizada: `.agents/skills/emil-design-eng/SKILL.md`. No se agregaron animaciones.

| Before | After | Why |
| --- | --- | --- |
| Compra, gasto o pago sin referencia recuperable tras recargar | Referencia persistente y Comprobar operación fuera de los modales | Evitar repetir una operación ya confirmada |
| Abonos y pagos sin corrección independiente conectada | Acción de reversión con motivo y estado anulado visible | Corregir saldos sin borrar trazabilidad |
| Entradas y retiros conectados bloqueados | Controles existentes operativos, errores accesibles junto a campos y conservación de valores rechazados | Registrar efectivo con contexto y sin perder lo escrito |

## Verificación final relacionada

| Comprobación | Resultado |
| --- | --- |
| Navegador financiero, crédito, gastos, compras/CxP y reportes | 17/17 aprobadas, 26.2 s |
| Regresiones conectadas de ventas, recuperación, confirmación y cierre | 8/8 aprobadas, 22.0 s |
| Regresiones locales de caja, cierre y reversión de compras | 12/12 aprobadas, 16.0 s |
| Backend unitario | 146 aprobadas, 0 fallidas, 1 omisión anterior por JSON externo ausente |
| Integración MySQL específica | 6/6 resultados aprobados (5 subcasos y su contenedor) |
| ESLint completo | Sin errores ni advertencias |
| Build público y git diff --check | Verificados al cierre de la entrega |

La integración específica incluye recuperación de las tres clases, descarte y solicitud tardía, carrera resolver/escritor, reversiones y fondos, rollback de auditoría, entradas/retiros, retiro simultáneo, arqueo, cierre y aislamiento del cierre anterior. La prueba de valores cubre importes, precisión, dirección, motivo, clave y rechazo de negocio inyectado. Navegador cubre recarga, respuestas perdidas, respuesta inválida, almacenamiento inaccesible, exclusión entre pestañas, controles reales y ausencia de escrituras operativas en Dexie.

No se repitió la auditoría completa de 570 aprobadas. Logs y artefactos: `test-results/financial-stage*`, `financial-verified-browser.log`, `financial-sales-regression.log`, `financial-local-regression.log`, `financial-final-unit.log`, `financial-final-integration.log`, `financial-final-lint.log`.

## Restricciones y límites

No hubo bloqueos de esquema para estas tres etapas: se reutilizaron `pos_operations`, los campos de anulación de pagos y los tipos de movimiento ya existentes. La integración aplicó las migraciones existentes únicamente dentro de bases aleatorias validadas `pos_auth_test_*`, eliminadas al finalizar cada corrida. No se modificó `pos_multitenant` ni se aplicó una migración a la base principal.

El registro de nuevos pagos de proveedores con tarjeta/transferencia sigue sujeto al bloqueo anterior de migración 005 ausente. Esta entrega no lo habilita ni crea esa migración. Las devoluciones bancarias requieren ejecución externa y confirmación del operador. Los registros históricos se mantienen protegidos.

No hubo commits, reset, clean, cambios de cuentas existentes ni despliegues. Se conservan los cambios anteriores y `stash@{0}` con identificador `d95b74a2c7ae7b9eaa3055248982d340386392ed`.

## Seguimiento: conciliacion de pagos a proveedores

Actualizacion posterior a la verificacion de las etapas anteriores: la migracion 005 ya esta implementada en `database/migrations/005_supplier_payment_reconciliation.sql`. Tarjeta y transferencia generan pagos `PENDING`, reservan el saldo de CxP y aparecen en Caja para confirmacion. La confirmacion registra actor y fecha, conserva auditoria y excluye el movimiento no monetario del efectivo fisico. Los reportes incluyen el estado de conciliacion. El cambio no se aplica a ninguna base real en esta fase.