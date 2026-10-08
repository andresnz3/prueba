# Fase 5.5: reportes conectados y fuentes para Dashboard

## Alcance implementado

Reportes en modo conectado consulta exclusivamente MySQL por medio de `GET /api/reports/connected`. El backend vuelve a validar la sesión y el permiso `reports` antes y después de la consulta, y todas las lecturas quedan limitadas al negocio autenticado. Las fechas del navegador se convierten de medianoche local a límites UTC, con fin exclusivo para incluir el día Hasta completo.

El reporte reúne:

- Ventas completadas por método y vendedor, productos más vendidos e historial de hasta 1,000 facturas del período. Las anuladas se identifican en el historial y quedan excluidas de las sumas.
- Movimientos y cierres de caja, más ventas agrupadas por medio de pago. Los estados pendientes se conservan como pendientes; no se presentan como efectivo confirmado.
- Inventario actual, productos activos, unidades, artículos con stock bajo o agotados y valor al costo calculado con importes de MySQL.
- Cuentas por cobrar actuales por cliente, saldo vencido y abonos del período.

La fecha Hoy/Semana/Mes/Todo y el rango personalizado se aplican a ventas, movimientos, cierres y abonos. Inventario y saldo CxC representan el estado actual, por lo que no se alteran con un filtro histórico. Las tablas conservan búsqueda general, filtros por columna, ordenamiento y exportación Excel filtrada. Se muestran como máximo 1,000 filas recientes para historial, movimientos, cierres y abonos; los agregados de ventas cubren todo el período. El reporte informa esos límites cuando se alcanzan.

Compras/CxP y gastos conectados muestran un estado pendiente explícito. Sus tarjetas no rellenan valores con datos locales. Dashboard continúa bloqueado como vista de métricas hasta que sus módulos conectados requeridos estén listos.

## Base de datos y Dashboard

No se añadieron migraciones ni columnas. El endpoint lee tablas existentes (`sales`, `sale_items`, `products`, `cash_sessions`, `cash_movements`, `clients` y `customer_payments`). Las tablas futuras del Dashboard pueden reutilizar este servicio/API para ventas, caja, inventario y CxC. Compras, proveedores/CxP y gastos todavía no tienen una fuente conectada completa en esta fase; no se estiman ni sustituyen por Dexie.

## Revisión visual

| Before | After | Why |
| --- | --- | --- |
| Reportes conectado quedaba bloqueado junto con Dashboard. | Reportes usa un endpoint de solo lectura, con métricas e historial desde el negocio autenticado. | Permite consultar datos existentes sin cruzar negocios ni permisos de otros módulos. |
| Compras, gastos y CxP podían confundirse con ceros o valores locales. | Cada apartado muestra el módulo conectado requerido y las tarjetas indican Pendiente. | Evita representar datos inexistentes como resultados financieros. |
| Las tablas de CxC y Caja no mostraban abonos ni detalle de movimientos en Reportes. | Se agregaron tablas de abonos, movimientos, cierres e inventario con filtros y exportación. | Facilita revisión y descarga de los registros disponibles. |

## Archivos de implementación

- `backend/src/services/connected-reports.js`, `backend/src/routes/reports.js`: lectura tenant-scoped y validación del rango.
- `backend/src/app.js`: monta la ruta sin alterar servicios de ventas o consecutivos.
- `api-client.js`, `connected-reports.js`, `connected-auth.js`: contrato y vista conectada.
- `app.js`, `index.html`, `data-tables.js`, `styles.css`: protección del modo local, controles, tablas y presentación.
- `tests-connected/reports.spec.cjs`, `backend/tests/integration/reports.test.cjs`, `backend/scripts/test-integration.cjs`, `backend/scripts/test-connected.cjs`: cobertura local y conectada.
- `scripts/build-static.cjs`, `dist`: lista y artefactos públicos.

No se inició la implementación de Compras conectadas. No se modificó `database/schema.sql`, no se ejecutaron migraciones en la base principal y no se hizo commit ni despliegue.

Skill visual aplicada: `.agents/skills/emil-design-eng/SKILL.md`.
