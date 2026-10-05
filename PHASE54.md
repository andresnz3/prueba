# Fase 5.4: clientes, crédito y cuentas por cobrar conectadas

## Estado

Implementación y verificación completadas para el flujo conectado. La migración 004 está preparada, pero **no se aplicó a la base principal**. No se creó ningún commit ni se desplegó el sitio. `database/schema.sql` permanece intacto. Compras conectadas siguen fuera de alcance.

## Implementación

- Se añadió gestión conectada de clientes: listado y búsqueda desde MySQL, alta, edición, activación/inactivación y selección de clientes activos desde Venta. La validación de duplicados se aplica por negocio; un cliente inactivo no puede financiar una venta.
- La venta a crédito exige cliente activo, caja abierta, crédito disponible y stock suficiente. Al facturar descuenta inventario y genera una factura con vencimiento y saldo. No crea movimiento de efectivo.
- Cuentas por cobrar muestra cliente, factura, fecha, total, abonado, saldo, vencimiento y estado. El estado de cuenta reúne facturas y abonos. Los pagos se asocian a una factura; se rechazan saldo insuficiente, factura pagada/anulada y caja cerrada.
- El efectivo confirmado aumenta el esperado de caja. Tarjeta y transferencia quedan pendientes y aparecen en Caja para confirmación; al confirmarse no aumentan el efectivo físico. Los abonos pendientes reservan el saldo de esa factura para impedir sobreabonos antes de conciliarlos.
- La venta local con Dexie/localStorage se conservó. La autoridad de negocio y las escrituras conectadas permanecen en el backend autenticado; no se crean ventas conectadas en Dexie ni en una cola offline.
- Caja centralizada conserva el cliente y la modalidad de crédito del pedido hasta el cobro y la factura.

## Revisión de UI

| Antes | Después | Por qué |
|---|---|---|
| Clientes y abonos conectados no tenían una vista de cuentas por cobrar por factura. | Clientes muestra búsqueda/gestión, facturas pendientes, estado de cuenta y acción de abono por factura. | El saldo y el pago corresponden al documento correcto y se pueden conciliar. |
| Venta conectada no ofrecía un flujo de crédito ligado a un cliente activo. | Al elegir Crédito se selecciona cliente y la confirmación muestra vencimiento y saldo, sin control de efectivo. | Evita emitir crédito sin titular o representarlo como efectivo cobrado. |
| Caja mostraba confirmaciones de cobros de venta, pero no de abonos a factura. | Abonos de tarjeta/transferencia aparecen como operaciones pendientes confirmables desde Caja. | Mantiene la conciliación de abonos junto al resto de pagos pendientes. |

## Migración

Se añadió `database/migrations/004_connected_credit_accounts.sql`, más el ejecutor explícito `backend/scripts/migrate-credit.cjs`. La migración agrega el plazo de crédito y los vínculos de cliente/plazo para pedidos centralizados, y permite registrar abonos bancarios pendientes. No modifica `database/schema.sql`.

Para una base seleccionada, el comando documentado es `npm.cmd run migrate:credit --prefix backend -- --apply`. **No se ejecutó** contra la base principal; solo la integración aplicó 004 a su base aleatoria `pos_auth_test_*`, que fue eliminada al finalizar.

## Verificación ejecutada

- `npx.cmd eslint .`: aprobado.
- `npm.cmd test --prefix backend`: 57/57 aprobadas.
- `npm.cmd run test:integration --prefix backend`: 91/91 aprobadas, incluida la integración de clientes/crédito; base temporal eliminada.
- `npm.cmd run test:frontend --prefix backend`: 67/67 conectadas aprobadas, base temporal eliminada.
- `npx.cmd playwright test --config=playwright.config.cjs --grep-invert "conectado"`: 160/160 pruebas locales aprobadas.
- `node scripts/build-static.cjs`: build público generado desde la lista de archivos públicos.
- `git diff --check`: aprobado. `database/schema.sql` no tiene diff.

Los tests de ventas que antes rechazaban toda forma de pago `CREDIT` se actualizaron al comportamiento solicitado: crédito permitido con cliente activo y saldo disponible, y rechazo si falta el cliente.

## Prueba manual

Una vez revisada y aprobada la migración para la base conectada elegida:

1. Inicia backend y sirve únicamente el directorio público `dist`; entra con una cuenta conectada existente.
2. En Clientes crea un cliente activo con límite y plazo de crédito. Luego abre Caja.
3. En Venta selecciona Crédito, elige ese cliente, agrega un producto y factura. Comprueba que baja el stock, aparece la factura/saldo en Cuentas por cobrar y el efectivo esperado no cambia.
4. Desde la factura registra un abono en efectivo y confirma que aumenta el esperado. Registra otro abono con tarjeta o transferencia; debe quedar pendiente y Caja debe permitir confirmarlo sin sumar efectivo.
5. Repite con cliente inactivo, límite excedido y caja cerrada: no debe facturar ni aceptar el abono. En modo local verifica la venta local y sus cuentas existentes.

## Archivos y cambios

Se añadieron la migración 004, su ejecutor, validaciones y servicio de clientes/cuentas, vista conectada de clientes y pruebas de crédito. Se ampliaron API, rutas y servicios de ventas/caja, integración de Caja y build público. Los cambios que ya estaban presentes al comenzar en `app.js`, `index.html` y `tests/configuration.spec.cjs` se conservaron.

Skill de UI aplicada: `.agents/skills/emil-design-eng/SKILL.md`.
