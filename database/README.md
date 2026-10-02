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

## Tenant and history safeguards

Operational rows carry `business_id`. Composite foreign keys include the tenant key so a document cannot reference a user, product, customer, supplier, or cash session from another business. Backend queries must still authorize every tenant-scoped operation using the authenticated session; accepting a client-supplied `business_id` is not sufficient authorization.

Foreign keys use `RESTRICT` for operational/history relationships. Sales, purchases, payments, expenses, and cash movements are voided or cancelled by status rather than physically deleted. Session authorizations may be deleted when their authentication session is removed. Product, client, supplier and user records should be deactivated instead of deleted once referenced by history.

## Frontend compatibility notes

The current Dexie schema (`POS_OfflineDB`, version 9) has `products`, `clients`, `suppliers`, `sales`, `purchases`, `sync_queue`, `cajaSessions`, `gastos`, `abonos`, `inventory_movements`, and `audit_logs`. The frontend uses camelCase and Spanish property names, numeric millisecond timestamps, and often `Date.now()` identifiers. It embeds sale/purchase lines in `items`, payment records in a mixed `abonos` collection, and cash movements in `cajaSessions.movimientos`. The SQL schema deliberately normalizes those structures; a future backend migration/adapter must map names, IDs, date/time values, payment kinds, cancellations, confirmation states, and document sequence values.

The frontend accepts a free-text supplier name for a cash purchase, so `purchases.supplier_id` is nullable and `supplier_name` preserves the entered historical name. Purchase invoice numbers are unique per business and supplier name; credit purchases should resolve or create a supplier before insertion.

Other mappings to preserve in a migration include `products.marginRetail` / `marginWholesale`, `retailPrice` / `wholesalePrice`, `active` and soft-delete `deleted`; client `creditLimit`, `debt`, and `deudaSinFactura`; supplier `debt`; and local config keys including `name`, `ruc`, `currency`, `header`, `footer`, `tax`, `minStock`, and `logo`. The SQL stores receivable/payable balances as derived operational data, not mutable columns on clients or suppliers; opening debt can be represented by `opening_balance` and ledger entries in the backend migration.

The browser currently uses one fixed `DEFAULT_BUSINESS_ID` and has no authenticated server-side tenant boundary. This schema prepares tenant relationships but does not itself provide authorization or convert the current frontend into a multi-tenant application.
