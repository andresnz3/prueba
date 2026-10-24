# Estado actual de fase 5.3

Ventas, lineas, stock, caja, secuencias y auditoria conectadas utilizan MySQL. [Migracion 002](migrations/002_sales_operations.sql) agrega idempotencia y efectivo/cambio, y [003](migrations/003_connected_cash_workflow.sql) agrega confirmacion no monetaria y pedidos opcionales para Caja central, sin modificar schema.sql. Las pruebas aplican migraciones solo en bases temporales; cualquier aplicacion a la base principal requiere aprobacion explicita. Ver [contrato](../backend/SALES.md). Las notas de compatibilidad originales son historicas.

# POS database schema

`schema.sql` creates an empty MySQL 8.0+ database named `pos_multitenant` and its tables. It does not create a business, users, or example operational data. The backend must create the initial business and administrator using a securely generated password hash.

## Tables

- `businesses`, `users`, `sessions`, `session_authorizations`: tenants, tenant-scoped users, backend authentication sessions, and temporary module grants.
- `products`, `clients`, `suppliers`, `business_settings`, `document_sequences`: tenant catalog, counterparties, migrated settings, and concurrency-safe numbering state.
- `sales`, `sale_items`, `purchases`, `purchase_items`: operational documents and normalized line items. Sale lines preserve `cost_at_sale`; item names and barcodes are snapshots for historical display.
- `customer_payments`, `supplier_payments`: customer receivables and supplier payables, including optional invoice allocation and cash-session association.
- `cash_sessions`, `cash_movements`, `expenses`: cash register lifecycle, auditable cash entries/exits, and expense records.
- `inventory_movements`: stock ledger with quantity deltas, stock-after snapshots, reason and optional source document reference.
- `audit_logs`: append-oriented backend activity log; it does not replace operational records.
- `business_subscriptions`, `business_subscription_payments`: owner-only plan metadata, monthly due dates, and USD payment history added by migration 006; these billing records are separate from POS financial operations and are not added to `schema.sql`.

## Tenant and history safeguards

Operational rows carry `business_id`. Composite foreign keys include the tenant key so a document cannot reference a user, product, customer, supplier, or cash session from another business. Backend queries must still authorize every tenant-scoped operation using the authenticated session; accepting a client-supplied `business_id` is not sufficient authorization.

Foreign keys use `RESTRICT` for operational/history relationships. Sales, purchases, payments, expenses, and cash movements are voided or cancelled by status rather than physically deleted. Session authorizations may be deleted when their authentication session is removed. Product, client, supplier and user records should be deactivated instead of deleted once referenced by history.

## Frontend compatibility notes

The current Dexie schema (`POS_OfflineDB`, version 9) has `products`, `clients`, `suppliers`, `sales`, `purchases`, `sync_queue`, `cajaSessions`, `gastos`, `abonos`, `inventory_movements`, and `audit_logs`. The frontend uses camelCase and Spanish property names, numeric millisecond timestamps, and often `Date.now()` identifiers. It embeds sale/purchase lines in `items`, payment records in a mixed `abonos` collection, and cash movements in `cajaSessions.movimientos`. The SQL schema deliberately normalizes those structures; a future backend migration/adapter must map names, IDs, date/time values, payment kinds, cancellations, confirmation states, and document sequence values.

The frontend accepts a free-text supplier name for a cash purchase, so `purchases.supplier_id` is nullable and `supplier_name` preserves the entered historical name. Purchase invoice numbers are unique per business and supplier name; credit purchases should resolve or create a supplier before insertion.

Other mappings to preserve in a migration include `products.marginRetail` / `marginWholesale`, `retailPrice` / `wholesalePrice`, `active` and soft-delete `deleted`; client `creditLimit`, `debt`, and `deudaSinFactura`; supplier `debt`; and local config keys including `name`, `ruc`, `currency`, `header`, `footer`, `tax`, `minStock`, and `logo`. The SQL stores receivable/payable balances as derived operational data, not mutable columns on clients or suppliers; opening debt can be represented by `opening_balance` and ledger entries in the backend migration.

The browser currently uses one fixed `DEFAULT_BUSINESS_ID` and has no authenticated server-side tenant boundary. This schema prepares tenant relationships but does not itself provide authorization or convert the current frontend into a multi-tenant application.

## Estado tras la fase 5.2

En modo conectado products e inventory_movements utilizan los IDs BIGINT y business_id de la sesion MySQL. El modo local conserva Dexie y su identificador anterior. schema.sql no se modifica: uniqueness, CHECK y claves compuestas existentes se reutilizan. El campo supplier del formulario Dexie no tiene equivalente en products; esta deshabilitado en conectado mientras se define la futura relacion de proveedores. El resto de las operaciones financieras no esta integrado.

## Ejecutor de migraciones para MySQL y Contabo

Para una nueva base, crea una base vacia y configura DB_NAME del backend para ese destino. Revisa el plan de solo lectura y aplica la instalacion completa:

npm.cmd run migrate:all --prefix backend -- --plan --target pos_nueva --confirm-target pos_nueva --install-base-schema
npm.cmd run migrate:all --prefix backend -- --apply --target pos_nueva --confirm-target pos_nueva --install-base-schema

El plan verifica que el destino MySQL 8.0.16+ este vacio, sin ejecutar DDL. La aplicacion importa solo las tablas de schema.sql (omite su CREATE DATABASE/USE fijo a pos_multitenant) y ejecuta 001-017. Para bases existentes, omite --install-base-schema. El destino debe coincidir exactamente con DB_NAME. El ejecutor conserva checksums y estados en schema_migrations y se detiene ante dependencias faltantes, esquema parcial o drift. Adopta migraciones previas sin ledger solo si las firmas completas coinciden. En Contabo se usa el mismo proceso desde backend con un usuario limitado al destino y respaldo reciente. pos_multitenant requiere --allow-principal y autorizacion expresa. La migracion 017 amplia el plan conectado Estandar; su aplicacion en una base existente requiere autorizacion explicita y no se realizo durante esta tarea.

La migracion 015 almacena eventos historicos de inventario con cantidad cero sin cambiar el stock. La 016 permite conservar ordenes historicas cuando el origen no guardo el precio de cada linea, marcandolo como desconocido en lugar de inferir precios actuales. La 016 se probo solo en bases temporales durante la continuacion real v1→v2; su aplicacion en una base principal requiere un plan y autorizacion propios.

El 23 de octubre de 2026, tras autorización explícita, respaldo completo con restauración temporal verificada y plan que mostró 001–015 aplicadas/solo 016 pendiente, se aplicó 016 a `pos_multitenant` con el ejecutor oficial. La verificación posterior confirmó 001–016 aplicadas y 34 tablas con 2,714 filas previas intactas. Respaldo: `C:\Users\andre\Documents\POS-Backups\pos_multitenant-pre-016-20261023T182140.392Z-58fce0ff.sql` (SHA-256 `a23302aae8e2684ed08936e67aadfc1c78dd5f18cef3498431baaaca56573773`).
