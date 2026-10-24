'use strict';

const { createHash } = require('node:crypto');
const { httpError } = require('../middleware/errors');
const { authorizeMigrationBatch } = require('./migration-batch-capability');
const { packageForSalesImport, normalizeSale } = require('./system-admin-sales-migration-values');
const { packageForPurchasesImport, normalizePurchase } = require('./system-admin-purchases-migration-values');

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const text = (value, max = 500) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null;
const first = (value, keys) => keys.map(key => value?.[key]).find(item => item !== undefined && item !== null && item !== '');
const identity = value => value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim();
const token = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const normalizeSourceName = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

function resolvePurchaseSupplierIdentities(packageData) {
  const suppliers = Array.isArray(packageData?.suppliers) ? packageData.suppliers : [];
  const payments = Array.isArray(packageData?.abonos) ? packageData.abonos : [];
  const supplierRows = new Map();
  for (const supplier of suppliers) {
    const id = identity(first(supplier, ['id', 'supplierId', 'proveedorId', 'supplier_id', 'proveedor_id']));
    if (id) supplierRows.set(id, [...(supplierRows.get(id) || []), supplier]);
  }
  const result = (Array.isArray(packageData?.purchases) ? packageData.purchases : []).map(purchase => ({ ...purchase }));
  const resolutions = [];
  for (const purchase of result) {
    const explicitSupplierId = identity(first(purchase, ['supplierId', 'proveedorId', 'supplier_id', 'proveedor_id']));
    if (explicitSupplierId) continue;
    const purchaseId = identity(first(purchase, ['id', 'purchaseId', 'compraId', 'purchase_id', 'compra_id']));
    const rawSupplierName = first(purchase, ['supplierName', 'proveedorNombre']) ?? first(purchase, ['supplier', 'proveedor']);
    const rawSupplierNameText = typeof rawSupplierName === 'object' && rawSupplierName
      ? first(rawSupplierName, ['name', 'nombre'])
      : rawSupplierName;
    const supplierName = normalizeSourceName(rawSupplierNameText);
    if (!purchaseId || !supplierName) continue;
    const exactNameMatches = suppliers.filter(supplier => {
      const candidate = first(supplier, ['name', 'nombre', 'supplierName', 'proveedor']);
      return typeof candidate === 'string' && candidate.trim() === String(rawSupplierNameText).trim();
    });
    if (exactNameMatches.length === 1) {
      const exactId = identity(first(exactNameMatches[0], ['id', 'supplierId', 'proveedorId', 'supplier_id', 'proveedor_id']));
      if (exactId && supplierRows.get(exactId)?.length === 1) {
        purchase.supplierId = exactId;
        resolutions.push({ purchaseId, supplierId: exactId, linkedPaymentIds: [], evidence: 'El nombre original de la compra coincide exactamente con un proveedor único del archivo.' });
        continue;
      }
    }
    const linkedPayments = payments.filter(payment => token(first(payment, ['type', 'tipo'])).includes('PROVEEDOR') &&
      identity(first(payment, ['purchaseId', 'compraId', 'purchase_id', 'compra_id', 'facturaId', 'invoiceId'])) === purchaseId);
    if (!linkedPayments.length) continue;
    const supplierIds = linkedPayments.map(payment => identity(first(payment, ['supplierId', 'proveedorId', 'supplier_id', 'proveedor_id', 'referenciaId'])));
    if (supplierIds.some(id => !id) || new Set(supplierIds).size !== 1) continue;
    const supplierId = supplierIds[0];
    const matchedRows = supplierRows.get(supplierId) || [];
    if (matchedRows.length !== 1 || normalizeSourceName(first(matchedRows[0], ['name', 'nombre', 'supplierName', 'proveedor'])) !== supplierName) continue;
    purchase.supplierId = supplierId;
    resolutions.push({ purchaseId, supplierId, linkedPaymentIds: linkedPayments.map(payment => identity(first(payment, ['id', 'paymentId', 'abonoId']))).filter(Boolean), evidence: 'Todos los abonos vinculados a esta compra identifican al mismo proveedor y el nombre coincide.' });
  }
  return { purchases: result, resolutions };
}

function dateSql(value) {
  if (value === null || value === undefined || value === '') return null;
  const epoch = typeof value === 'number' ? (Math.abs(value) < 100000000000 ? value * 1000 : value) : value;
  const date = new Date(epoch);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1000 || date.getUTCFullYear() > 9999) return null;
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

function scaled(value, scale, allowSigned = false) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const input = String(value).trim();
  if (!Number.isInteger(scale) || scale < 0 || scale > 6) return null;
  const integerDigits = 12 - scale;
  const matcher = new RegExp('^' + (allowSigned ? '-?' : '') + '(\\d{1,' + integerDigits + '})' + (scale ? '(?:\\.(\\d{1,' + scale + '}))?' : '') + '$');
  const match = matcher.exec(input);
  if (!match || (scale === 2 && match[2]?.length > 2)) return null;
  const negative = input.startsWith('-');
  const integer = input.replace(/^-/, '').split('.')[0];
  const fraction = (input.split('.')[1] || '').padEnd(scale, '0');
  if (fraction.length > scale) return null;
  const result = (BigInt(integer) * (10n ** BigInt(scale)) + BigInt(fraction || '0')) * (negative ? -1n : 1n);
  if (result > 999999999999n || result < -999999999999n) return null;
  return result;
}

function formatScaled(value, scale) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const divisor = 10n ** BigInt(scale);
  return (negative ? '-' : '') + (absolute / divisor).toString() + '.' + (absolute % divisor).toString().padStart(scale, '0');
}

function sourceIdFromKey(key) {
  const match = /^id:([^:]+)$/.exec(String(key || ''));
  return match?.[1] || null;
}

const OPERATIONAL_SCHEMA_014_REQUIRED = Object.freeze({
  cash_sessions: Object.freeze(['is_historical', 'source_opened_by', 'source_closed_by', 'source_status']),
  cash_movements: Object.freeze(['is_historical', 'source_actor', 'source_status', 'source_reference_type', 'source_reference_id', 'source_method']),
  inventory_movements: Object.freeze(['is_historical', 'source_actor', 'source_reference_type', 'source_reference_id']),
  expenses: Object.freeze(['is_historical', 'source_actor', 'source_cancelled_by', 'source_method']),
  supplier_payments: Object.freeze(['is_historical', 'source_actor', 'source_cancelled_by']),
  sales: Object.freeze(['source_actor', 'source_cancelled_by']),
  customer_payments: Object.freeze(['source_actor', 'source_cancelled_by']),
  purchases: Object.freeze(['source_actor', 'source_cancelled_by']),
  sale_orders: Object.freeze(['is_historical', 'source_actor', 'source_cancelled_by', 'source_completed_by']),
  migration_supplier_payment_references: Object.freeze(['business_id', 'source_business_key', 'source_payment_key', 'source_payment_id', 'fingerprint', 'supplier_payment_id'])
});

const ZERO_INVENTORY_SCHEMA_015_REQUIRED = Object.freeze({
  migration_zero_inventory_events: Object.freeze(['business_id', 'batch_id', 'source_record_key', 'product_id', 'quantity', 'stock_after', 'source_payload', 'occurred_at'])
});

const ORDER_PRICE_SNAPSHOT_SCHEMA_016_REQUIRED = Object.freeze({
  sale_order_items: Object.freeze(['estimated_unit_price', 'estimated_subtotal', 'price_snapshot_available'])
});

async function assertOperationalSchema(repo, db) {
  const required = { ...OPERATIONAL_SCHEMA_014_REQUIRED, ...ZERO_INVENTORY_SCHEMA_015_REQUIRED, ...ORDER_PRICE_SNAPSHOT_SCHEMA_016_REQUIRED };
  const names = Object.keys(required);
  const rows = await repo.rows(db, 'SELECT TABLE_NAME AS tableName,COLUMN_NAME AS columnName,IS_NULLABLE AS isNullable FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (' + names.map(() => '?').join(',') + ')', names);
  const found = new Map();
  for (const row of rows) found.set(row.tableName, [...(found.get(row.tableName) || []), row.columnName]);
  const missing = source => Object.entries(source).some(([table, columns]) => columns.some(column => !found.get(table)?.includes(column)));
  if (missing(OPERATIONAL_SCHEMA_014_REQUIRED)) throw httpError(503, 'MIGRATION_OPERATIONAL_SCHEMA_REQUIRED');
  if (missing(ZERO_INVENTORY_SCHEMA_015_REQUIRED)) throw httpError(503, 'MIGRATION_ZERO_INVENTORY_SCHEMA_REQUIRED');
  if (missing(ORDER_PRICE_SNAPSHOT_SCHEMA_016_REQUIRED) || !rows.some(row => row.tableName === 'sale_order_items' && row.columnName === 'estimated_unit_price' && row.isNullable === 'YES') || !rows.some(row => row.tableName === 'sale_order_items' && row.columnName === 'estimated_subtotal' && row.isNullable === 'YES')) throw httpError(503, 'MIGRATION_ORDER_SNAPSHOT_SCHEMA_REQUIRED');
}

function createSystemAdminMigrationOperations({ repo, requireSystemAdmin, salesMigration, creditMigration, purchasesMigration, migrationProjection }) {
  function validateIds(businessId, batchId) {
    if (typeof businessId !== 'string' || !/^[1-9]\d{0,19}$/.test(businessId) || BigInt(businessId) > 18446744073709551615n ||
        typeof batchId !== 'string' || !/^[0-9a-f-]{36}$/i.test(batchId)) throw httpError(400, 'INVALID_INPUT');
    if (businessId === '1') throw httpError(409, 'MIGRATION_TARGET_PROTECTED');
  }

  async function targetAndBatch(db, businessId, batchId, lock = false) {
    const suffix = lock ? ' FOR UPDATE' : '';
    const [business] = await repo.rows(db, 'SELECT b.id,b.name,b.status,c.state AS migrationState,c.source_business_key AS sourceBusinessKey,c.batch_id AS batchId FROM businesses b JOIN business_migration_controls c ON c.business_id=b.id WHERE b.id=?' + suffix, [businessId]);
    if (!business) throw httpError(404, 'MIGRATION_TARGET_REQUIRED');
    if (business.status !== 'INACTIVE' || business.migrationState !== 'PENDING' || String(business.batchId) !== batchId) throw httpError(409, 'MIGRATION_TARGET_REQUIRED');
    const [batch] = await repo.rows(db, 'SELECT id,status,source_business_key AS sourceBusinessKey,source_business_name AS sourceBusinessName,package_sha256 AS packageSha256,manifest,stage_results AS stageResults FROM migration_import_batches WHERE business_id=? AND id=?' + suffix, [businessId, batchId]);
    if (!batch || !['ARCHIVED', 'BLOCKED', 'PROJECTING'].includes(batch.status)) throw httpError(409, 'MIGRATION_BATCH_CONFLICT');
    const manifest = objectJson(batch.manifest), stageResults = objectJson(batch.stageResults);
    const sourceBusinessKey = manifest.continuation?.canonicalSourceBusinessKey || batch.sourceBusinessKey;
    if (sourceBusinessKey !== business.sourceBusinessKey ||
        (batch.sourceBusinessKey !== business.sourceBusinessKey && manifest.continuation?.mode !== 'V1_TO_V2_CONTINUATION')) throw httpError(409, 'MIGRATION_BATCH_CONFLICT');
    if (Array.isArray(manifest.securityBlockers) && manifest.securityBlockers.length) throw httpError(409, 'MIGRATION_SOURCE_SCOPE_REQUIRED');
    if (Number(manifest.identityReview?.counts?.sharedId || 0) > 0) {
      const confirmation = manifest.identityReview?.batchConfirmation;
      if (confirmation?.confirmed !== true || !['SHARED_LEGACY_BUSINESS_ID_ROWS_ONLY', 'PACKAGE_PROVENANCE_WITH_AUDIT_ONLY_QUEUE'].includes(confirmation.scope) || confirmation.packageSha256 !== batch.packageSha256 || String(confirmation.targetBusinessId) !== String(businessId) || !confirmation.adminIdentity?.userId || !confirmation.confirmedAt) {
        throw httpError(409, 'MIGRATION_LEGACY_IDENTITY_CONFIRMATION_REQUIRED');
      }
    }
    if (!stageResults.catalog?.complete || stageResults.catalog?.complete !== true) throw httpError(409, 'MIGRATION_CATALOG_RECONCILIATION_REQUIRED');
    return { business, batch, manifest, sourceBusinessKey, stageResults };
  }

  function objectJson(value) {
    if (value && typeof value === 'object') return value;
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; }
    catch { return {}; }
  }

  async function loadRecords(db, businessId, batchId, lock = false) {
    const rows = await repo.rows(db, 'SELECT entity_type AS entityType,source_record_key AS sourceRecordKey,source_fingerprint AS fingerprint,record_status AS recordStatus,target_table AS targetTable,target_record_id AS targetRecordId,source_actor AS sourceActor,pending_reason AS pendingReason,source_payload AS payload FROM migration_source_records WHERE business_id=? AND batch_id=? ORDER BY entity_type,source_record_key' + (lock ? ' FOR UPDATE' : ''), [businessId, batchId]);
    return rows.map(row => ({ ...row, payload: objectJson(row.payload), targetRecordId: row.targetRecordId === null ? null : String(row.targetRecordId) }));
  }

  function packageFromRecords(name, records, packageVersion, includeProjectedOperations = false) {
    const fields = { products: 'products', clients: 'clients', suppliers: 'suppliers', sales: 'sales', purchases: 'purchases', cashSessions: 'cashSessions', inventoryMovements: 'inventoryMovements', abonos: 'abonos', expenses: 'expenses', auditLogs: 'auditLogs', saleOrders: 'saleOrders', syncQueue: 'syncQueue' };
    const data = Object.fromEntries(Object.values(fields).map(field => [field, []]));
    for (const row of records) {
      const field = fields[row.entityType];
      if (!field || !['ARCHIVED', 'PROJECTED'].includes(row.recordStatus)) continue;
      if (row.entityType === 'syncQueue') continue;
      if (!['products', 'clients', 'suppliers'].includes(row.entityType) && row.recordStatus === 'PROJECTED' && !includeProjectedOperations) continue;
      const payload = { ...row.payload };
      if (row.sourceActor) payload.__sourceActor = row.sourceActor;
      const cancelledBy = first(payload, ['cancelledByName', 'cancelled_by_name', 'cancelledBy', 'anuladoPor', 'usuarioAnulacion']);
      if (typeof cancelledBy === 'string') payload.__sourceCancelledBy = cancelledBy.slice(0, 180);
      const completedBy = first(payload, ['completedByName', 'completed_by_name', 'usuarioCierre', 'cajero']);
      if (typeof completedBy === 'string') payload.__sourceCompletedBy = completedBy.slice(0, 180);
      data[field].push(payload);
    }
    const configuration = records.find(row => row.entityType === 'configuration' && ['ARCHIVED', 'PROJECTED'].includes(row.recordStatus));
    const categories = records.find(row => row.entityType === 'categories' && ['ARCHIVED', 'PROJECTED'].includes(row.recordStatus));
    data.configuration = configuration?.payload || {};
    data.categories = Array.isArray(categories?.payload) ? categories.payload : [];
    return { type: 'pos_local_migration_package', version: packageVersion, business: { name }, data };
  }

  function mappingIndex(records) {
    const index = new Map();
    for (const row of records) {
      const sourceId = sourceIdFromKey(row.sourceRecordKey);
      if (!sourceId || !row.targetRecordId || row.recordStatus !== 'PROJECTED') continue;
      index.set(row.entityType + ':' + sourceId, row.targetRecordId);
    }
    return index;
  }

  async function linkImporterResults(db, businessId, batchId, sourceBusinessKey, records) {
    const sourceMap = new Map(records.map(row => [row.entityType + ':' + sourceIdFromKey(row.sourceRecordKey), row]));
    let mappedSales = 0, mappedPurchases = 0, mappedCustomerPayments = 0;
    const sales = await repo.rows(db, 'SELECT source_sale_id AS sourceId,sale_id AS targetId FROM migration_sales_references WHERE business_id=? AND source_business_key=?', [businessId, sourceBusinessKey]);
    for (const ref of sales) {
      const row = sourceMap.get('sales:' + String(ref.sourceId));
      if (!row) continue;
      await repo.rows(db, "UPDATE migration_source_records SET record_status='PROJECTED',target_table='sales',target_record_id=?,pending_reason=NULL,updated_at=UTC_TIMESTAMP(3) WHERE business_id=? AND batch_id=? AND entity_type='sales' AND source_record_key=? AND record_status IN ('ARCHIVED','PROJECTED')", [String(ref.targetId), businessId, batchId, row.sourceRecordKey]);
      mappedSales++;
    }
    const purchases = await repo.rows(db, 'SELECT source_purchase_id AS sourceId,purchase_id AS targetId FROM migration_purchase_references WHERE business_id=? AND source_business_key=?', [businessId, sourceBusinessKey]);
    for (const ref of purchases) {
      const row = sourceMap.get('purchases:' + String(ref.sourceId));
      if (!row) continue;
      await repo.rows(db, "UPDATE migration_source_records SET record_status='PROJECTED',target_table='purchases',target_record_id=?,pending_reason=NULL,updated_at=UTC_TIMESTAMP(3) WHERE business_id=? AND batch_id=? AND entity_type='purchases' AND source_record_key=? AND record_status IN ('ARCHIVED','PROJECTED')", [String(ref.targetId), businessId, batchId, row.sourceRecordKey]);
      mappedPurchases++;
    }
    const payments = await repo.rows(db, 'SELECT source_payment_id AS sourceId,customer_payment_id AS targetId FROM migration_credit_payment_references WHERE business_id=? AND source_business_key=? ORDER BY source_payment_id,customer_payment_id', [businessId, sourceBusinessKey]);
    for (const ref of payments) {
      const row = sourceMap.get('abonos:' + String(ref.sourceId));
      if (!row) continue;
      if (row.recordStatus !== 'PROJECTED') await repo.rows(db, "UPDATE migration_source_records SET record_status='PROJECTED',target_table='customer_payments',target_record_id=?,pending_reason=NULL,updated_at=UTC_TIMESTAMP(3) WHERE business_id=? AND batch_id=? AND entity_type='abonos' AND source_record_key=? AND record_status='ARCHIVED'", [String(ref.targetId), businessId, batchId, row.sourceRecordKey]);
      mappedCustomerPayments++;
    }
    return { sales: mappedSales, purchases: mappedPurchases, customerPayments: mappedCustomerPayments };
  }

  async function enrichHistoricalProvenance(db, businessId, records) {
    const differences = [];
    const targets = {
      sales: { table: 'sales', fields: ['source_actor', 'source_cancelled_by'] },
      purchases: { table: 'purchases', fields: ['source_actor', 'source_cancelled_by'] },
      cashSessions: { table: 'cash_sessions', fields: ['source_opened_by', 'source_closed_by', 'source_status'] },
      expenses: { table: 'expenses', fields: ['source_actor', 'source_cancelled_by', 'source_method'] },
      inventoryMovements: { table: null, fields: ['source_actor'] },
      saleOrders: { table: 'sale_orders', fields: ['source_actor', 'source_cancelled_by', 'source_completed_by'] },
      abonos: { table: null, fields: ['source_actor', 'source_cancelled_by'] }
    };
    const aliases = {
      source_actor: ['__sourceActor', 'usuario', 'userName', 'user_name', 'vendedor', 'seller', 'cajero', 'cashier', 'responsible'],
      source_cancelled_by: ['__sourceCancelledBy', 'cancelledByName', 'cancelled_by_name', 'cancelledBy', 'anuladoPor', 'usuarioAnulacion'],
      source_completed_by: ['__sourceCompletedBy', 'completedByName', 'completed_by_name', 'usuarioCierre'],
      source_opened_by: ['openedByName', 'opened_by_name', 'usuarioApertura', 'openedBy'],
      source_closed_by: ['closedByName', 'closed_by_name', 'usuarioCierre', 'closedBy'],
      source_status: ['status', 'estado'],
      source_method: ['paymentMethod', 'payment_method', 'metodoPago', 'medioPago', 'method']
    };
    for (const row of records) {
      if (row.recordStatus !== 'PROJECTED' || !row.targetRecordId) continue;
      const config = targets[row.entityType];
      if (!config) continue;
      let table = row.entityType === 'inventoryMovements'
        ? (['inventory_movements', 'migration_zero_inventory_events'].includes(row.targetTable) ? row.targetTable : null)
        : row.entityType === 'abonos'
          ? (['customer_payments', 'supplier_payments'].includes(row.targetTable) ? row.targetTable : null)
          : config.table;
      if (!table || (config.table && row.targetTable !== config.table)) continue;
      const selectedFields = config.fields.filter(field => aliases[field]);
      const [target] = await repo.rows(db, 'SELECT ' + selectedFields.map(field => '`' + field + '`').join(',') + ' FROM `' + table + '` WHERE business_id=? AND id=? FOR UPDATE', [businessId, row.targetRecordId]);
      if (!target) continue;
      const updates = [], values = [];
      for (const field of selectedFields) {
        const sourceValue = text(first(row.payload, aliases[field]) ?? (field === 'source_actor' ? row.sourceActor : null), 180);
        if (sourceValue === null) continue;
        if (target[field] === null || target[field] === undefined || target[field] === '') {
          updates.push('`' + field + '`=?'); values.push(sourceValue);
        } else if (String(target[field]) !== sourceValue) {
          differences.push(difference(row, row.entityType, field, 'El responsable o estado histórico difiere del dato ya conservado; no se sobrescribió.', sourceValue, String(target[field])));
        }
      }
      if (updates.length) await repo.rows(db, 'UPDATE `' + table + '` SET ' + updates.join(',') + ' WHERE business_id=? AND id=?', [...values, businessId, row.targetRecordId]);
    }
    return differences;
  }

  function sourceStatus(value, cancelled = false) {
    if (cancelled || /CANCEL|ANUL|VOID/.test(token(value))) return 'VOID';
    const status = token(value);
    if (!status || /^(POSTED|CONFIRMED|CONFIRMADO|APROBADO|COMPLETED|PAGADO|PAGADA|OK|ACTIVO|ACTIVA)$/.test(status)) return 'POSTED';
    if (/^(PENDING|PENDIENTE|EN_REVISION|POR_CONFIRMAR)$/.test(status)) return 'PENDING';
    return null;
  }

  function paymentMethod(value) {
    const method = token(value);
    if (/^(CASH|EFECTIVO|CONTADO)$/.test(method)) return 'CASH';
    if (/^(CARD|TARJETA|POS|DEBIT_CARD|CREDIT_CARD|TARJETA_CREDITO|TARJETA_DEBITO)$/.test(method)) return 'CARD';
    if (/^(TRANSFER|TRANSFERENCIA|TRANSF|WIRE|BANK|BANCO)$/.test(method)) return 'TRANSFER';
    if (/^(OTHER|OTRO|CHEQUE)$/.test(method)) return 'OTHER';
    return null;
  }

  function cashType(value) {
    const type = token(value);
    if (/^(SALE|VENTA)$/.test(type)) return ['SALE', 'IN'];
    if (/^(CUSTOMER_PAYMENT|ABONO|COBRO|COBRO_CLIENTE|CLIENT_PAYMENT)$/.test(type)) return ['CUSTOMER_PAYMENT', 'IN'];
    if (/^(SUPPLIER_PAYMENT|PAGO_PROVEEDOR|ABONO_PROVEEDOR)$/.test(type)) return ['SUPPLIER_PAYMENT', 'OUT'];
    if (/^(EXPENSE|GASTO|EGRESO)$/.test(type)) return ['EXPENSE', 'OUT'];
    if (/^(MANUAL_ENTRY|INGRESO|ENTRADA)$/.test(type)) return ['MANUAL_ENTRY', 'IN'];
    if (/^(MANUAL_EXIT|RETIRO|SALIDA)$/.test(type)) return ['MANUAL_EXIT', 'OUT'];
    if (/^(REVERSAL|REVERSA|ANULACION|DEVOLUCION)$/.test(type)) return ['REVERSAL', null];
    return null;
  }

  function inventoryType(value) {
    const type = token(value);
    if (/^(PURCHASE|COMPRA|ENTRADA_COMPRA)$/.test(type)) return 'PURCHASE';
    if (/^(SALE|VENTA)$/.test(type)) return 'SALE';
    if (/^(WASTE|MERMA|PERDIDA)$/.test(type)) return 'WASTE';
    if (/^(SALE_CANCEL|CANCELACION_VENTA|ANULACION_VENTA)$/.test(type)) return 'SALE_CANCEL';
    if (/^(PURCHASE_CANCEL|CANCELACION_COMPRA|ANULACION_COMPRA)$/.test(type)) return 'PURCHASE_CANCEL';
    if (/^(INITIAL|INICIAL|MIGRACION_INICIAL)$/.test(type)) return 'MIGRACION_INICIAL';
    if (/^(ADJUSTMENT|AJUSTE)$/.test(type)) return 'ADJUSTMENT';
    if (/^(MANUAL_EDIT|EDICION_MANUAL|MANUAL)$/.test(type)) return 'MANUAL_EDIT';
    return null;
  }

  async function projectArchivedAuxiliary(auth, businessId, batchId, sourceBusinessKey, records, userId) {
    const changes = { supplierPayments: 0, cashSessions: 0, cashMovements: 0, expenses: 0, inventoryMovements: 0, zeroQuantityInventoryEvents: 0, saleOrders: 0, auditLogs: 0, syncQueueArchived: 0 };
    const issues = [];
    return repo.transaction(async db => {
      await assertOperationalSchema(repo, db);
      const current = await loadRecords(db, businessId, batchId, true);
      const links = mappingIndex(current);
      const sourceRow = (entity, id) => current.find(row => row.entityType === entity && sourceIdFromKey(row.sourceRecordKey) === String(id));
      const targetId = (entity, id) => links.get(entity + ':' + String(id)) || null;
      const [existingPaymentRefs] = [await repo.rows(db, 'SELECT source_payment_key AS sourcePaymentKey,source_payment_id AS sourcePaymentId,fingerprint,supplier_payment_id AS targetId FROM migration_supplier_payment_references WHERE business_id=? AND source_business_key=? FOR UPDATE', [businessId, sourceBusinessKey])];
      const supplierPayments = new Map(existingPaymentRefs.map(row => [String(row.sourcePaymentId), String(row.targetId)]));

      for (const row of current.filter(item => item.entityType === 'syncQueue' && item.recordStatus === 'ARCHIVED')) {
        await mapRecord(db, businessId, batchId, row, 'migration_source_records', hash('archive-only-syncQueue:' + row.sourceRecordKey));
        changes.syncQueueArchived++;
      }

      const sessionTargets = new Map();
      for (const row of current.filter(item => item.entityType === 'cashSessions' && item.recordStatus === 'PROJECTED' && item.targetRecordId)) sessionTargets.set(sourceIdFromKey(row.sourceRecordKey), row.targetRecordId);
      const sessionPlans = [];
      for (const row of current.filter(item => item.entityType === 'cashSessions' && item.recordStatus === 'ARCHIVED')) {
        const raw = row.payload;
        const openedAt = dateSql(first(raw, ['openedAt', 'opened_at', 'fechaAperturaTS', 'fechaApertura', 'fecha_apertura', 'createdAt', 'fechaTS']));
        const opening = scaled(first(raw, ['openingAmount', 'opening_amount', 'montoInicial', 'efectivoInicial', 'apertura', 'initialCash']), 2);
        const sourceSessionStatusRaw = first(raw, ['status', 'estado']);
        const closedAtForInference = dateSql(first(raw, ['closedAt', 'closed_at', 'fechaCierreTS', 'fechaCierre', 'fecha_cierre']));
        const hasCloseTotals = first(raw, ['countedAmount', 'counted_amount', 'closingAmount', 'montoReal', 'efectivoReal', 'montoCierre', 'montoFinal', 'cierre']) !== undefined && first(raw, ['expectedAmount', 'expected_amount', 'montoEsperado', 'efectivoEsperado']) !== undefined;
        const sourceSessionStatus = token(sourceSessionStatusRaw) || (closedAtForInference && hasCloseTotals ? 'CLOSED' : '');
        const storedSessionStatus = sourceSessionStatusRaw === undefined ? (sourceSessionStatus ? 'INFERRED_CLOSED' : null) : text(String(sourceSessionStatusRaw), 20);
        const recognizedOpen = /^(OPEN|ABIERTA|ABIERTO|ACTIVA|ACTIVO)$/.test(sourceSessionStatus);
        const recognizedClosed = /^(CLOSED|CLOSE|CERRADA|CERRADO|FINALIZADA|FINALIZADO)$/.test(sourceSessionStatus);
        if ((!recognizedOpen && !recognizedClosed) || (sourceSessionStatusRaw !== undefined && !storedSessionStatus)) {
          issues.push(difference(row, 'cashSessions', 'status', 'No se pudo identificar el estado original de la caja; la sesión queda pendiente.'));
          continue;
        }
        if (!openedAt || opening === null || opening < 0n || !sourceIdFromKey(row.sourceRecordKey)) {
          issues.push(difference(row, 'cashSessions', 'session', 'Valores de apertura o fecha incompletos; la sesión queda pendiente.'));
          continue;
        }
        const rawMovements = Array.isArray(raw.movimientos) ? raw.movimientos : Array.isArray(raw.movements) ? raw.movements : [];
        const movementPlans = [];
        let invalid = false;
        for (let index = 0; index < rawMovements.length; index++) {
          const movement = rawMovements[index] || {};
          const mappedType = cashType(first(movement, ['type', 'tipo', 'kind', 'concepto']));
          const amount = scaled(first(movement, ['amount', 'monto', 'total', 'importe']), 2);
          const originalDirection = token(first(movement, ['direction', 'direccion', 'tipoMovimiento']));
          const direction = mappedType?.[1] || (/^(IN|ENTRADA|INGRESO)$/.test(originalDirection) ? 'IN' : /^(OUT|SALIDA|EGRESO)$/.test(originalDirection) ? 'OUT' : null);
          if (!mappedType || amount === null || amount <= 0n || !direction) {
            issues.push(difference(row, 'cashMovements', 'movement[' + index + ']', 'El movimiento de caja tiene un tipo, importe o dirección que no se puede representar con seguridad.'));
            invalid = true;
            break;
          }
          const paymentReferenceId = identity(first(movement, ['customerPaymentId', 'supplierPaymentId', 'paymentId', 'abonoId', 'facturaAbonoId', 'referenciaAbonoId']));
          const referencedPayment = paymentReferenceId ? sourceRow('abonos', paymentReferenceId)?.payload : null;
          const isSupplierPayment = token(referencedPayment?.tipo).includes('PROVEEDOR');
          const paymentType = isSupplierPayment ? ['SUPPLIER_PAYMENT', 'OUT'] : referencedPayment ? ['CUSTOMER_PAYMENT', 'IN'] : null;
          const resolvedType = paymentType || mappedType;
          const method = paymentMethod(first(movement, ['paymentMethod', 'payment_method', 'medioPago', 'metodoPago', 'metodo', 'method'])) ||
            (referencedPayment ? paymentMethod(first(referencedPayment, ['paymentMethod', 'payment_method', 'medioPago', 'metodoPago', 'metodo', 'method'])) : null);
          const statusRaw = first(movement, ['status', 'estado']);
          const status = sourceStatus(statusRaw, first(movement, ['cancelled', 'anulado']) === true);
          const storedStatus = statusRaw === undefined ? null : text(String(statusRaw), 32);
          if (!status || (statusRaw !== undefined && !storedStatus)) { issues.push(difference(row, 'cashMovements', 'movement[' + index + '].status', 'El estado original del movimiento no es compatible.')); invalid = true; break; }
          movementPlans.push({ raw: movement, index, type: resolvedType[0], direction: resolvedType[1] || direction, amount: formatScaled(amount, 2), method, status, sourceStatus: storedStatus, paymentReferenceId, isSupplierPayment });
        }
        if (invalid) continue;
        let referencesReady = true;
        const availableSessionIds = new Set(current.filter(item => item.entityType === 'cashSessions' && item.recordStatus === 'ARCHIVED').map(item => sourceIdFromKey(item.sourceRecordKey)).filter(Boolean));
        for (const movementPlan of movementPlans) {
          const movement = movementPlan.raw;
          const linkedIds = [
            ['sales', identity(first(movement, ['saleId', 'sale_id', 'ventaId', 'venta_id', 'referenciaVentaId']))],
            ['purchases', identity(first(movement, ['purchaseId', 'purchase_id', 'compraId', 'compra_id', 'referenciaCompraId']))]
          ].filter(([, id]) => id);
          if (linkedIds.some(([entity, id]) => !links.has(entity + ':' + id))) referencesReady = false;
          const paymentId = movementPlan.paymentReferenceId && !movementPlan.isSupplierPayment ? movementPlan.paymentReferenceId : null;
          if (paymentId) {
            const [paymentRef] = await repo.rows(db, 'SELECT COUNT(*) AS total FROM migration_credit_payment_references WHERE business_id=? AND source_business_key=? AND source_payment_id=?', [businessId, sourceBusinessKey, paymentId]);
            if (Number(paymentRef.total) !== 1) referencesReady = false;
          }
          const supplierPaymentId = movementPlan.paymentReferenceId && movementPlan.isSupplierPayment ? movementPlan.paymentReferenceId : null;
          if (supplierPaymentId) {
            const paymentRow = sourceRow('abonos', supplierPaymentId), payment = paymentRow?.payload || {};
            const supplierId = identity(first(payment, ['supplierId', 'proveedorId', 'supplier_id', 'proveedor_id', 'referenciaId']));
            const purchaseId = identity(first(payment, ['purchaseId', 'compraId', 'purchase_id', 'compra_id', 'facturaId', 'invoiceId']));
            const paymentAmount = scaled(first(payment, ['amount', 'monto', 'importe']), 2);
          if (!paymentRow || !token(payment.tipo).includes('PROVEEDOR') || !supplierId || !links.has('suppliers:' + supplierId) || (purchaseId && !links.has('purchases:' + purchaseId)) || paymentAmount === null || paymentAmount <= 0n || !dateSql(first(payment, ['createdAt', 'created_at', 'fechaTS', 'fecha', 'date'])) || !paymentMethod(first(payment, ['paymentMethod', 'payment_method', 'medioPago', 'metodoPago', 'metodo', 'method'])) || !sourceStatus(first(payment, ['status', 'estado']), first(payment, ['cancelled', 'cancelado', 'anulado']) === true)) referencesReady = false;
            const paymentSessionId = identity(first(payment, ['cashSessionId', 'cajaSessionId', 'sessionId']));
            if (paymentSessionId && !availableSessionIds.has(paymentSessionId)) referencesReady = false;
          }
          const expenseId = identity(first(movement, ['expenseId', 'gastoId']));
          if (expenseId) {
            const expenseRow = sourceRow('expenses', expenseId), expense = expenseRow?.payload || {};
            const expenseStatus = sourceStatus(first(expense, ['status', 'estado']), first(expense, ['cancelled', 'cancelado', 'anulado']) === true);
            const methodValue = token(first(expense, ['paymentMethod', 'payment_method', 'metodoPago', 'metodo', 'method'])) || 'CASH';
           const supportedMethod = /^(CASH|EFECTIVO|CONTADO|CAJA)$/.test(methodValue) || /^(PENDING|PENDIENTE)$/.test(methodValue) || /^(BANK|BANCO|CARD|TARJETA|TRANSFER|TRANSFERENCIA)$/.test(methodValue);
            if (!expenseRow || !['POSTED', 'VOID'].includes(expenseStatus) || !supportedMethod || scaled(first(expense, ['amount', 'monto', 'importe', 'total']), 2) === null || !dateSql(first(expense, ['createdAt', 'created_at', 'fechaTS', 'fecha', 'date'])) || !text(first(expense, ['description', 'descripcion', 'concepto', 'detail', 'detalle']), 500) || !text(first(expense, ['category', 'categoria', 'tipo']), 100)) referencesReady = false;
            const expenseSessionId = identity(first(expense, ['sessionId', 'cashSessionId', 'cajaSessionId', 'caja_session_id']));
            if (expenseSessionId && !availableSessionIds.has(expenseSessionId)) referencesReady = false;
          }
        }
        if (!referencesReady) {
          issues.push(difference(row, 'cashSessions', 'references', 'La sesión tiene movimientos con relaciones incompletas; no se creó una caja parcial y los registros siguen pendientes.'));
          continue;
        }
        const sourceClosedAt = dateSql(first(raw, ['closedAt', 'closed_at', 'fechaCierreTS', 'fechaCierre', 'fecha_cierre']));
        const countedAmount = scaled(first(raw, ['countedAmount', 'counted_amount', 'closingAmount', 'montoReal', 'efectivoReal', 'montoCierre', 'montoFinal', 'cierre']), 2);
        const expectedAmount = scaled(first(raw, ['expectedAmount', 'expected_amount', 'montoEsperado', 'efectivoEsperado']), 2);
        const isSourceClosed = recognizedClosed;
        if (isSourceClosed && (!sourceClosedAt || countedAmount === null || expectedAmount === null)) {
          issues.push(difference(row, 'cashSessions', 'closingTotals', 'La caja figura cerrada, pero faltan la fecha o los importes del cierre; no se creó una sesión parcial.'));
          continue;
        }
        sessionPlans.push({ row, raw, openedAt, opening: formatScaled(opening, 2), sourceStatus: storedSessionStatus, movementPlans });
      }

      for (const plan of sessionPlans) {
        const raw = plan.raw;
        const closedAt = dateSql(first(raw, ['closedAt', 'closed_at', 'fechaCierreTS', 'fechaCierre', 'fecha_cierre']));
        const counted = scaled(first(raw, ['countedAmount', 'counted_amount', 'closingAmount', 'montoReal', 'efectivoReal', 'montoCierre', 'montoFinal', 'cierre']), 2);
        const expected = scaled(first(raw, ['expectedAmount', 'expected_amount', 'montoEsperado', 'efectivoEsperado']), 2);
        const differenceValue = scaled(first(raw, ['difference', 'diferencia']), 2, true);
        const openedBy = text(first(raw, ['openedBy', 'opened_by', 'usuarioApertura', 'cajeroApertura']), 180);
        const closedBy = text(first(raw, ['closedBy', 'closed_by', 'usuarioCierre', 'cajeroCierre']), 180);
        const result = await repo.rows(db, 'INSERT INTO cash_sessions (business_id,opened_by,opening_amount,opened_at,closed_by,counted_amount,expected_amount,difference,closed_at,status,is_historical,source_opened_by,source_closed_by,source_status) VALUES (?,?,?,?,NULL,?,?,?,?,\'CLOSED\',TRUE,?,?,?)',
            [businessId, userId, plan.opening, plan.openedAt, counted === null ? null : formatScaled(counted, 2), expected === null ? null : formatScaled(expected, 2), differenceValue === null ? null : formatScaled(differenceValue, 2), closedAt, openedBy || plan.row.sourceActor, closedBy, plan.sourceStatus]);
        const id = String(result.insertId);
        sessionTargets.set(sourceIdFromKey(plan.row.sourceRecordKey), id);
        plan.targetId = id;
      }

      const expenseTargets = new Map(current.filter(row => row.entityType === 'expenses' && row.recordStatus === 'PROJECTED' && row.targetRecordId).map(row => [sourceIdFromKey(row.sourceRecordKey), row.targetRecordId]));
      for (const row of current.filter(item => item.entityType === 'expenses' && item.recordStatus === 'ARCHIVED')) {
        const raw = row.payload;
        const amount = scaled(first(raw, ['amount', 'monto', 'importe', 'total']), 2);
        const createdAt = dateSql(first(raw, ['createdAt', 'created_at', 'fechaTS', 'fecha', 'date']));
        const description = text(first(raw, ['description', 'descripcion', 'concepto', 'detail', 'detalle']), 500);
        const category = text(first(raw, ['category', 'categoria', 'tipo']), 100);
        const methodRaw = token(first(raw, ['paymentMethod', 'payment_method', 'metodoPago', 'metodo', 'method'])) || 'CASH';
        const method = /^(CASH|EFECTIVO|CONTADO|CAJA)$/.test(methodRaw) ? 'CASH' : /^(PENDING|PENDIENTE)$/.test(methodRaw) ? 'PENDING' : /^(BANK|BANCO|CARD|TARJETA|TRANSFER|TRANSFERENCIA)$/.test(methodRaw) ? 'BANK' : null;
        const status = sourceStatus(first(raw, ['status', 'estado']), first(raw, ['cancelled', 'cancelado', 'anulado', 'anulada']) === true);
        if (!['POSTED', 'VOID'].includes(status)) {
          issues.push(difference(row, 'expenses', 'status', 'El estado original del gasto no puede representarse sin cambiar su significado; queda pendiente.'));
          continue;
        }
        const cancelled = status === 'VOID';
        const sessionSourceId = identity(first(raw, ['sessionId', 'cashSessionId', 'cajaSessionId', 'caja_session_id']));
        const sessionId = sessionSourceId ? sessionTargets.get(sessionSourceId) : null;
        if (amount === null || amount <= 0n || !createdAt || !description || !category || !method || (sessionSourceId && !sessionId)) {
          issues.push(difference(row, 'expenses', 'requiredFields', 'El gasto tiene campos incompletos o referencias que no se han importado; se conserva pendiente.'));
          continue;
        }
        const sourceMethod = method === 'BANK' ? methodRaw : null;
        const inserted = await repo.rows(db, 'INSERT INTO expenses (business_id,user_id,cash_session_id,description,category,amount,payment_method,receipt_reference,status,created_at,cancelled_at,cancelled_by,cancel_reason,is_historical,source_actor,source_cancelled_by,source_method) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?,TRUE,?,?,?)',
          [businessId, userId, sessionId || null, description, category, formatScaled(amount, 2), method, text(first(raw, ['receiptReference', 'receipt_reference', 'factura', 'referencia']), 100), status, createdAt,
            cancelled ? dateSql(first(raw, ['cancelledAt', 'cancelled_at', 'fechaAnulacion'])) : null, cancelled ? text(first(raw, ['cancelReason', 'cancel_reason', 'motivoAnulacion', 'razon']), 500) : null,
            row.sourceActor, text(first(raw, ['cancelledByName', 'cancelled_by_name', 'anuladoPor', 'usuarioAnulacion']), 180), sourceMethod]);
        const id = String(inserted.insertId);
        expenseTargets.set(sourceIdFromKey(row.sourceRecordKey), id);
        await mapRecord(db, businessId, batchId, row, 'expenses', id);
        changes.expenses++;
      }

      for (const row of current.filter(item => item.entityType === 'abonos' && item.recordStatus === 'ARCHIVED' && token(item.payload.tipo).includes('PROVEEDOR'))) {
        const raw = row.payload;
        const sourcePaymentId = sourceIdFromKey(row.sourceRecordKey);
        const sourceKey = sourcePaymentId ? hash('local-id:' + sourcePaymentId) : hash(row.sourceRecordKey);
        const supplierSourceId = identity(first(raw, ['supplierId', 'proveedorId', 'supplier_id', 'proveedor_id', 'referenciaId']));
        const supplierId = supplierSourceId ? targetId('suppliers', supplierSourceId) : null;
        const purchaseSourceId = identity(first(raw, ['purchaseId', 'compraId', 'purchase_id', 'compra_id', 'facturaId', 'invoiceId']));
        const purchaseId = purchaseSourceId ? targetId('purchases', purchaseSourceId) : null;
        const cashSourceId = identity(first(raw, ['cashSessionId', 'cajaSessionId', 'sessionId']));
        const cashId = cashSourceId ? sessionTargets.get(cashSourceId) : null;
        const amount = scaled(first(raw, ['amount', 'monto', 'importe']), 2);
        const createdAt = dateSql(first(raw, ['createdAt', 'created_at', 'fechaTS', 'fecha', 'date']));
        const method = paymentMethod(first(raw, ['paymentMethod', 'payment_method', 'medioPago', 'metodoPago', 'metodo', 'method']));
        const cancelled = first(raw, ['cancelled', 'cancelado', 'anulado', 'anulada']) === true || /CANCEL|ANUL|VOID/.test(token(first(raw, ['status', 'estado'])));
        const status = sourceStatus(first(raw, ['status', 'estado']), cancelled);
        if (!supplierId || !sourcePaymentId || amount === null || amount <= 0n || !createdAt || !method || !status || (purchaseSourceId && !purchaseId) || (cashSourceId && !cashId)) {
          issues.push(difference(row, 'supplierPayments', 'requiredFields', 'El pago a proveedor tiene referencias o valores que no pueden validarse; se conserva pendiente.'));
          continue;
        }
        const [prior] = await repo.rows(db, 'SELECT source_payment_key AS sourcePaymentKey,fingerprint,supplier_payment_id AS targetId FROM migration_supplier_payment_references WHERE business_id=? AND source_business_key=? AND source_payment_key=? FOR UPDATE', [businessId, sourceBusinessKey, sourceKey]);
        if (prior) {
          if (prior.fingerprint !== row.fingerprint) throw httpError(409, 'MIGRATION_RECORD_CONFLICT');
          await mapRecord(db, businessId, batchId, row, 'supplier_payments', prior.targetId);
          changes.supplierPayments++;
          continue;
        }
        const cancelledAt = cancelled ? dateSql(first(raw, ['cancelledAt', 'cancelled_at', 'fechaAnulacion'])) : null;
        const cancelReason = cancelled ? text(first(raw, ['cancelReason', 'cancel_reason', 'motivoAnulacion', 'razon']), 500) : null;
        const cancelledBy = cancelled ? text(first(raw, ['cancelledByName', 'cancelled_by_name', 'anuladoPor', 'usuarioAnulacion']), 180) : null;
        const inserted = await repo.rows(db, 'INSERT INTO supplier_payments (business_id,user_id,supplier_id,purchase_id,cash_session_id,amount,payment_method,status,created_at,cancelled_at,cancelled_by,cancel_reason,is_historical,source_actor,source_cancelled_by) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,TRUE,?,?)',
          [businessId, userId, supplierId, purchaseId || null, cashId || null, formatScaled(amount, 2), method, status, createdAt, cancelledAt, cancelReason, row.sourceActor, cancelledBy]);
        const targetPaymentId = String(inserted.insertId);
        await repo.rows(db, 'INSERT INTO migration_supplier_payment_references (business_id,source_business_key,source_payment_key,source_payment_id,fingerprint,supplier_payment_id,created_at) VALUES (?,?,?,?,?,?,?)',
          [businessId, sourceBusinessKey, sourceKey, sourcePaymentId, row.fingerprint, targetPaymentId, createdAt]);
        await mapRecord(db, businessId, batchId, row, 'supplier_payments', targetPaymentId, purchaseId ? null : 'UNALLOCATED_SUPPLIER_PAYMENT');
        supplierPayments.set(sourcePaymentId, targetPaymentId);
        changes.supplierPayments++;
      }

      for (const row of current.filter(item => item.entityType === 'inventoryMovements' && (item.recordStatus === 'ARCHIVED' || (item.recordStatus === 'PENDING' && /^Este registro inicial conserva cantidad cero/i.test(item.pendingReason || '') && scaled(first(item.payload, ['quantity', 'cantidad', 'qty']), 3, true) === 0n)))) {
        const raw = row.payload;
        const productSourceId = identity(first(raw, ['productId', 'productoId', 'producto_id', 'product_id']));
        const productId = productSourceId ? targetId('products', productSourceId) : null;
        const type = inventoryType(first(raw, ['type', 'tipo', 'movementType', 'movimiento']));
        const quantity = scaled(first(raw, ['quantity', 'cantidad', 'qty']), 3, true);
        const stockAfterValue = first(raw, ['stockAfter', 'stock_after', 'existenciaFinal', 'stockResultante', 'stock_nuevo']);
        const stockAfter = stockAfterValue === undefined || stockAfterValue === null ? null : scaled(stockAfterValue, 3, true);
        const unitCostValue = first(raw, ['unitCost', 'unit_cost', 'cost', 'costo', 'costoUnitario', 'costo_unitario']);
        const unitCost = unitCostValue === undefined || unitCostValue === null ? null : scaled(unitCostValue, 2);
        const createdAt = dateSql(first(raw, ['createdAt', 'created_at', 'fechaTS', 'fecha', 'date']));
        if (!productId || !type || quantity === null || !createdAt || (stockAfterValue !== undefined && stockAfterValue !== null && stockAfter === null) || (unitCostValue !== undefined && unitCostValue !== null && (unitCost === null || unitCost < 0n))) {
          issues.push(difference(row, 'inventoryMovements', 'requiredFields', 'El movimiento de inventario requiere producto, tipo, cantidad y fecha compatibles; se conserva pendiente.'));
          continue;
        }
        const sourceReferenceType = text(first(raw, ['referenceType', 'reference_type', 'tipoReferencia', 'referenciaTipo']), 40) || (first(raw, ['referenciaVentaId']) ? 'VENTA' : first(raw, ['referenciaCompraId']) ? 'COMPRA' : null);
        const sourceReferenceId = identity(first(raw, ['referenceId', 'reference_id', 'referenciaId', 'referencia_id', 'referenciaVentaId', 'referenciaCompraId']));
        if (quantity === 0n) {
          const sourceType = text(first(raw, ['type', 'tipo', 'movementType', 'movimiento']), 40);
          const reason = text(first(raw, ['reason', 'motivo', 'description', 'descripcion']), 500);
          const actor = text(first(raw, ['userName', 'usuario', 'actorName', 'responsible']), 180) || row.sourceActor;
          const inserted = await repo.rows(db, 'INSERT INTO migration_zero_inventory_events (business_id,batch_id,source_record_key,product_id,source_type,quantity,stock_after,unit_cost,reason,source_actor,source_reference_type,source_reference_id,source_payload,occurred_at) VALUES (?,?,?,?,?,0.000,?,?,?,?,?,?,?,?)',
            [businessId, batchId, row.sourceRecordKey, productId, sourceType || type, stockAfter === null ? null : formatScaled(stockAfter, 3), unitCost === null ? null : formatScaled(unitCost, 2), reason, actor, sourceReferenceType, sourceReferenceId, JSON.stringify(raw), createdAt]);
          await mapRecord(db, businessId, batchId, row, 'migration_zero_inventory_events', inserted.insertId, null, true);
          changes.inventoryMovements++;
          changes.zeroQuantityInventoryEvents++;
          continue;
        }
        const referenceEntity = /SALE|VENTA/i.test(sourceReferenceType || '') ? 'sales' : /PURCHASE|COMPRA/i.test(sourceReferenceType || '') ? 'purchases' : null;
        const mappedReference = referenceEntity && sourceReferenceId ? targetId(referenceEntity, sourceReferenceId) : null;
        const reason = text(first(raw, ['reason', 'motivo', 'description', 'descripcion']), 500);
        const inserted = await repo.rows(db, 'INSERT INTO inventory_movements (business_id,product_id,user_id,type,quantity,stock_after,reference_type,reference_id,reason,unit_cost,created_at,is_historical,source_actor,source_reference_type,source_reference_id) VALUES (?,?,NULL,?,?,?,?,?,?,?,?,TRUE,?,?,?)',
          [businessId, productId, type, formatScaled(quantity, 3), stockAfter === null ? null : formatScaled(stockAfter, 3), mappedReference ? referenceEntity : null, mappedReference, reason, unitCost === null ? null : formatScaled(unitCost, 2), createdAt, row.sourceActor, sourceReferenceType, sourceReferenceId]);
        await mapRecord(db, businessId, batchId, row, 'inventory_movements', inserted.insertId, sourceReferenceId && !mappedReference ? 'SOURCE_REFERENCE_UNRESOLVED' : null);
        if (sourceReferenceId && !mappedReference) issues.push(difference(row, 'inventoryMovements', 'reference', 'Se conservó la referencia original, pero no se pudo enlazar con una operación importada.'));
        changes.inventoryMovements++;
      }

      const orderTargets = new Map(current.filter(row => row.entityType === 'saleOrders' && row.recordStatus === 'PROJECTED' && row.targetRecordId).map(row => [sourceIdFromKey(row.sourceRecordKey), row.targetRecordId]));
      for (const row of current.filter(item => item.entityType === 'saleOrders' && item.recordStatus === 'ARCHIVED')) {
        const raw = row.payload, input = raw.input && typeof raw.input === 'object' ? raw.input : {};
        let sourceItems = Array.isArray(raw.items) ? raw.items : Array.isArray(input.items) ? input.items : [];
        const statusToken = token(first(raw, ['status', 'estado']));
        const status = /CANCEL|ANUL|VOID/.test(statusToken) ? 'CANCELLED' : /COMPLETE|COMPLET|FINALIZ/.test(statusToken) ? 'COMPLETED' : /PEND|OPEN|ABIER/.test(statusToken) ? 'PENDING' : null;
        const createdAt = dateSql(first(raw, ['createdAt', 'created_at', 'fechaTS', 'fecha']));
        const priceType = /WHOLESALE|MAYOREO|MAYORISTA/.test(token(first(raw, ['priceType', 'price_type', 'tarifa']) ?? first(input, ['priceType', 'price_type', 'tarifa', 'buyerType']))) ? 'WHOLESALE' : 'RETAIL';
        const localSaleId = identity(first(raw, ['saleId', 'sale_id', 'ventaId', 'venta_id']));
        const saleId = localSaleId ? targetId('sales', localSaleId) : null;
        const linkedSale = localSaleId ? sourceRow('sales', localSaleId)?.payload : null;
        let subtotalRaw = first(raw, ['estimatedSubtotal', 'subtotal', 'subtotalEstimado']) ?? first(input, ['estimatedSubtotal', 'subtotal']);
        let discountRaw = first(raw, ['estimatedDiscount', 'discount', 'descuento']) ?? first(input, ['estimatedDiscount', 'discount']);
        const totalRaw = first(raw, ['estimatedTotal', 'total', 'totalEstimado']) ?? first(input, ['estimatedTotal', 'total']);
        const suppliedTotal = scaled(totalRaw, 2);
        const rawDiscountPercent = first(raw, ['discountPercent', 'discount_percent', 'descuentoPorcentaje']) ?? first(input, ['discountPercent']);
        const checkedDiscountPercent = rawDiscountPercent === undefined ? 0n : scaled(rawDiscountPercent, 4);
        if ((subtotalRaw === undefined || subtotalRaw === null) && (discountRaw === undefined || discountRaw === null) && suppliedTotal !== null && checkedDiscountPercent === 0n) {
          subtotalRaw = totalRaw;
          discountRaw = '0';
        }
        if (status === 'COMPLETED' && saleId && linkedSale) {
          const linkedItems = Array.isArray(linkedSale.items) ? linkedSale.items : Array.isArray(linkedSale.detalles) ? linkedSale.detalles : [];
          const orderReferences = sourceItems.map(item => ({
            productId: identity(first(item, ['productId', 'product_id', 'productoId', 'producto_id', 'id'])),
            quantity: scaled(first(item, ['quantity', 'cantidad', 'qty']), 3)
          }));
          const saleReferences = linkedItems.map(item => ({
            productId: identity(first(item, ['productId', 'product_id', 'productoId', 'producto_id', 'id'])),
            quantity: scaled(first(item, ['quantity', 'cantidad', 'qty']), 3)
          }));
          const sameItems = orderReferences.length > 0 && orderReferences.length === saleReferences.length && orderReferences.every((item, index) =>
            item.productId && item.productId === saleReferences[index].productId && item.quantity !== null && item.quantity === saleReferences[index].quantity);
          const linkedTotal = scaled(first(linkedSale, ['total', 'totalVenta', 'montoTotal', 'importeTotal']), 2);
          const orderPriceType = /WHOLESALE|MAYOREO|MAYORISTA/.test(token(first(raw, ['priceType', 'price_type', 'tarifa']) ?? first(input, ['priceType', 'price_type', 'tarifa', 'buyerType']))) ? 'WHOLESALE' : 'RETAIL';
          const salePriceType = /WHOLESALE|MAYOREO|MAYORISTA/.test(token(first(linkedSale, ['tarifa', 'priceType', 'tipoPrecio']))) ? 'WHOLESALE' : 'RETAIL';
          if (!sameItems || suppliedTotal === null || linkedTotal !== suppliedTotal || orderPriceType !== salePriceType) {
            issues.push(difference(row, 'saleOrders', 'saleReference', 'La orden completada no coincide en productos, cantidades, tarifa o total con su venta vinculada; queda pendiente.'));
            continue;
          }
          sourceItems = linkedItems.map(item => ({
            ...item,
            estimatedUnitPrice: first(item, orderPriceType === 'WHOLESALE' ? ['wholesalePrice', 'precio2', 'unitPrice', 'precioUnitario'] : ['retailPrice', 'precio1', 'unitPrice', 'precioUnitario'])
          }));
          const linkedSubtotal = first(linkedSale, ['subtotal', 'subtotalVenta', 'subTotal']);
          const linkedDiscount = first(linkedSale, ['descuentoMonto', 'discount', 'descuento', 'estimatedDiscount']) ?? '0';
          if (subtotalRaw === undefined || subtotalRaw === null || subtotalRaw === '') subtotalRaw = linkedSubtotal;
          if (discountRaw === undefined || discountRaw === null || discountRaw === '') discountRaw = linkedDiscount;
        }
        const subtotal = scaled(subtotalRaw, 2);
        const discount = scaled(discountRaw, 2);
        const total = suppliedTotal;
        const lines = [];
        let invalid = !status || !createdAt || subtotal === null || discount === null || total === null || !sourceItems.length || (localSaleId && !saleId) || (status === 'COMPLETED' && !saleId);
        for (const item of sourceItems) {
          const productSourceId = identity(first(item, ['productId', 'product_id', 'productoId', 'producto_id', 'id']));
          const productId = productSourceId ? targetId('products', productSourceId) : null;
          const quantity = scaled(first(item, ['quantity', 'cantidad', 'qty']), 3);
          const priceRaw = first(item, ['estimatedUnitPrice', 'unitPrice', 'price', 'precioUnitario', 'priceAtOrder', 'retailPrice', 'wholesalePrice', 'precio']);
          const lineSubtotalRaw = first(item, ['estimatedSubtotal', 'subtotal', 'importe']);
          const hasNoPriceSnapshot = priceRaw === undefined && lineSubtotalRaw === undefined;
          const price = hasNoPriceSnapshot ? null : scaled(priceRaw, 2);
          const providedLineSubtotal = hasNoPriceSnapshot ? null : scaled(lineSubtotalRaw, 2);
          const lineSubtotal = hasNoPriceSnapshot ? null : providedLineSubtotal ?? (quantity !== null && price !== null ? (quantity * price + 500n) / 1000n : null);
          if (!productId || quantity === null || quantity <= 0n || (!hasNoPriceSnapshot && (price === null || lineSubtotal === null)) || (hasNoPriceSnapshot && (status !== 'CANCELLED' || saleId))) { invalid = true; break; }
          const [product] = await repo.rows(db, 'SELECT id,name,barcode FROM products WHERE business_id=? AND id=?', [businessId, productId]);
          if (!product) { invalid = true; break; }
          lines.push({ product, quantity, price, lineSubtotal, priceSnapshotAvailable: !hasNoPriceSnapshot });
        }
        if (invalid) { issues.push(difference(row, 'saleOrders', 'requiredFields', 'La orden tiene importes, estado o productos incompletos; se conserva pendiente y no se convierte en venta.')); continue; }
        const clientSourceId = identity(first(raw, ['clientId', 'client_id', 'clienteId', 'cliente_id']) ?? first(input, ['clientId', 'clienteId']));
        const clientId = clientSourceId ? targetId('clients', clientSourceId) : null;
        const itemSubtotal = lines.reduce((sum, line) => sum + (line.lineSubtotal ?? 0n), 0n);
        const hasMissingPriceSnapshot = lines.some(line => !line.priceSnapshotAvailable);
        if (checkedDiscountPercent === null || subtotal < 0n || discount < 0n || discount > subtotal || total !== subtotal - discount || checkedDiscountPercent < 0n || checkedDiscountPercent > 1000000n || (!hasMissingPriceSnapshot && itemSubtotal !== subtotal)) {
          issues.push(difference(row, 'saleOrders', 'amounts', 'Los importes de la orden o sus detalles no coinciden; se conserva pendiente.'));
          continue;
        }
        const creditDaysRaw = first(raw, ['creditDays', 'credit_days']) ?? first(input, ['creditDays', 'credit_days']);
        const creditDaysNumber = creditDaysRaw === undefined || creditDaysRaw === null || creditDaysRaw === '' ? null : Number(creditDaysRaw);
        if (clientSourceId && (!Number.isInteger(creditDaysNumber) || creditDaysNumber < 1 || creditDaysNumber > 3650)) {
          issues.push(difference(row, 'saleOrders', 'creditDays', 'La orden vinculada a un cliente no tiene un plazo de crédito válido; queda pendiente.'));
          continue;
        }
        // Older local POS serializes the default credit term even on cash orders.
        // Without a customer it has no balance semantics; keep the raw value in
        // the immutable source payload and leave the operational column NULL.
        if (clientSourceId && !clientId) { issues.push(difference(row, 'saleOrders', 'client', 'No se encontró el cliente relacionado.')); continue; }
        const discountPercent = checkedDiscountPercent || 0n;
        const detail = text(first(raw, ['detail', 'description', 'descripcion']) ?? first(input, ['detail', 'description']), 500) || '';
        const cancelledAt = status === 'CANCELLED' ? dateSql(first(raw, ['cancelledAt', 'cancelled_at', 'fechaAnulacion'])) : null;
        const completedAt = status === 'COMPLETED' ? dateSql(first(raw, ['completedAt', 'completed_at', 'fechaCompletada'])) || createdAt : null;
        const inserted = await repo.rows(db, 'INSERT INTO sale_orders (business_id,created_by_user_id,client_id,credit_days,status,sale_id,price_type,discount_percent,estimated_subtotal,estimated_discount,estimated_total,detail,created_at,completed_at,completed_by_user_id,cancelled_at,cancelled_by_user_id,is_historical,source_actor,source_cancelled_by,source_completed_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,TRUE,?,?,?)',
          [businessId, userId, clientId, clientId ? creditDaysNumber : null, status, saleId, priceType, formatScaled(discountPercent, 4), formatScaled(subtotal, 2), formatScaled(discount, 2), formatScaled(total, 2), detail, createdAt, completedAt, status === 'COMPLETED' ? userId : null, cancelledAt, status === 'CANCELLED' ? userId : null, row.sourceActor, text(first(raw, ['cancelledByName', 'cancelled_by_name', 'anuladoPor']), 180), text(first(raw, ['completedByName', 'completed_by_name', 'usuarioCierre']), 180)]);
        const orderId = String(inserted.insertId);
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index], sourceItem = sourceItems[index];
          await repo.rows(db, 'INSERT INTO sale_order_items (business_id,order_id,line_number,product_id,product_name,barcode,quantity,estimated_unit_price,estimated_subtotal,price_snapshot_available) VALUES (?,?,?,?,?,?,?,?,?,?)',
            [businessId, orderId, index + 1, line.product.id, String(first(sourceItem, ['productName', 'product_name', 'name', 'nombre']) || line.product.name).slice(0, 160), line.product.barcode, formatScaled(line.quantity, 3), line.price === null ? null : formatScaled(line.price, 2), line.lineSubtotal === null ? null : formatScaled(line.lineSubtotal, 2), line.priceSnapshotAvailable ? 1 : 0]);
        }
        await mapRecord(db, businessId, batchId, row, 'sale_orders', orderId);
        orderTargets.set(sourceIdFromKey(row.sourceRecordKey), orderId);
        changes.saleOrders++;
      }

      for (const plan of sessionPlans) {
        const cashId = sessionTargets.get(sourceIdFromKey(plan.row.sourceRecordKey));
        let invalid = false;
        for (const movementPlan of plan.movementPlans) {
          const raw = movementPlan.raw;
          const saleSourceId = identity(first(raw, ['saleId', 'sale_id', 'ventaId', 'venta_id', 'referenciaVentaId']));
          const purchaseSourceId = identity(first(raw, ['purchaseId', 'purchase_id', 'compraId', 'compra_id', 'referenciaCompraId']));
          const paymentReferenceId = movementPlan.paymentReferenceId;
          const customerPaymentSourceId = paymentReferenceId && !movementPlan.isSupplierPayment ? paymentReferenceId : null;
          const supplierPaymentSourceId = paymentReferenceId && movementPlan.isSupplierPayment ? paymentReferenceId : null;
          const expenseSourceId = identity(first(raw, ['expenseId', 'gastoId']));
          const saleTarget = saleSourceId ? targetId('sales', saleSourceId) : null;
          const purchaseTarget = purchaseSourceId ? targetId('purchases', purchaseSourceId) : null;
          const expenseTarget = expenseSourceId ? expenseTargets.get(expenseSourceId) : null;
          const customerPaymentTargets = customerPaymentSourceId ? await repo.rows(db, 'SELECT customer_payment_id AS targetId FROM migration_credit_payment_references WHERE business_id=? AND source_business_key=? AND source_payment_id=? ORDER BY customer_payment_id', [businessId, sourceBusinessKey, customerPaymentSourceId]) : [];
          const customerPaymentTarget = customerPaymentTargets.length === 1 ? String(customerPaymentTargets[0].targetId) : null;
          const supplierPaymentTarget = supplierPaymentSourceId ? supplierPayments.get(supplierPaymentSourceId) : null;
          if ((saleSourceId && !saleTarget) || (purchaseSourceId && !purchaseTarget) || (expenseSourceId && !expenseTarget) || (customerPaymentSourceId && !customerPaymentTarget) || (supplierPaymentSourceId && !supplierPaymentTarget)) {
            issues.push(difference(plan.row, 'cashMovements', 'movement[' + movementPlan.index + '].reference', 'El movimiento conserva su referencia original, pero no se pudo enlazar sin ambigüedad.'));
            invalid = true;
            break;
          }
          const method = movementPlan.method;
          const status = movementPlan.status;
          const originalDirection = token(first(raw, ['direction', 'direccion']));
          const direction = /^(IN|ENTRADA|INGRESO)$/.test(originalDirection) ? 'IN' : /^(OUT|SALIDA|EGRESO)$/.test(originalDirection) ? 'OUT' : movementPlan.direction;
          const createdAt = dateSql(first(raw, ['createdAt', 'created_at', 'fechaTS', 'fecha'])) || plan.openedAt;
          const desc = text(first(raw, ['description', 'descripcion', 'detail', 'concepto']), 500) || ('Movimiento local ' + token(first(raw, ['type', 'tipo'])));
          const sourceReferenceType = text(first(raw, ['referenceType', 'reference_type', 'tipoReferencia']), 40) || (saleSourceId ? 'VENTA' : purchaseSourceId ? 'COMPRA' : paymentReferenceId ? (movementPlan.isSupplierPayment ? 'ABONO_PROVEEDOR' : 'ABONO_CLIENTE') : null);
          const sourceReferenceId = identity(first(raw, ['referenceId', 'reference_id', 'referenciaId', 'referenciaVentaId', 'referenciaCompraId', 'referenciaAbonoId'])) || saleSourceId || purchaseSourceId || paymentReferenceId;
          const linkedType = saleTarget ? 'sales' : purchaseTarget ? 'purchases' : expenseTarget ? 'expenses' : null;
          const linkedId = saleTarget || purchaseTarget || expenseTarget || null;
          const targetStatus = status === 'POSTED' ? 'CONFIRMED' : status;
          await repo.rows(db, 'INSERT INTO cash_movements (business_id,cash_session_id,user_id,type,direction,amount,sale_id,customer_payment_id,supplier_payment_id,expense_id,reference_type,reference_id,description,status,created_at,is_historical,source_actor,source_reference_type,source_reference_id,source_method,source_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [businessId, cashId, userId, movementPlan.type, direction, movementPlan.amount, saleTarget, customerPaymentTarget, supplierPaymentTarget, expenseTarget, linkedType, linkedId, desc, targetStatus, createdAt, true, plan.row.sourceActor, sourceReferenceType, sourceReferenceId, method, movementPlan.sourceStatus]);
          changes.cashMovements++;
        }
        if (invalid) throw httpError(409, 'MIGRATION_CASH_SESSION_REFERENCE_UNRESOLVED');
        await mapRecord(db, businessId, batchId, plan.row, 'cash_sessions', cashId, plan.movementPlans.some(item => !item.method && ['SALE','CUSTOMER_PAYMENT','SUPPLIER_PAYMENT'].includes(item.type)) ? 'PAYMENT_METHOD_UNCONFIRMED' : null);
        changes.cashSessions++;
        for (const movement of plan.movementPlans) {
          const raw = movement.raw;
          const localSaleId = identity(first(raw, ['saleId', 'sale_id', 'ventaId', 'venta_id']));
          const localPaymentId = identity(first(raw, ['customerPaymentId', 'paymentId', 'abonoId']));
          if (localSaleId) {
            const saleId = targetId('sales', localSaleId);
            if (saleId) await repo.rows(db, 'UPDATE sales SET cash_session_id=? WHERE business_id=? AND id=? AND is_historical=TRUE', [cashId, businessId, saleId]);
          }
          if (localPaymentId) {
            const payments = await repo.rows(db, 'SELECT customer_payment_id AS id FROM migration_credit_payment_references WHERE business_id=? AND source_business_key=? AND source_payment_id=?', [businessId, sourceBusinessKey, localPaymentId]);
            if (payments.length === 1) await repo.rows(db, 'UPDATE customer_payments SET cash_session_id=? WHERE business_id=? AND id=? AND is_historical=TRUE', [cashId, businessId, String(payments[0].id)]);
          }
        }
      }

      for (const row of current.filter(item => item.entityType === 'auditLogs' && item.recordStatus === 'ARCHIVED')) {
        const raw = row.payload;
        const createdAt = dateSql(first(raw, ['createdAt', 'created_at', 'timestamp', 'fechaTS'])) || dateSql(raw.timestamp);
        const originalAction = text(first(raw, ['action', 'accion', 'type']), 40);
        const originalEntity = text(first(raw, ['entity', 'entidad', 'module', 'modulo']), 64) || 'local_history';
        const originalEntityId = identity(first(raw, ['entity_id', 'entityId', 'recordId', 'id']));
        if (!createdAt) { issues.push(difference(row, 'auditLogs', 'createdAt', 'La fecha original no es válida; el evento queda pendiente.')); continue; }
        const details = { originBatchId: batchId, sourceRecordKey: row.sourceRecordKey, sourceActor: row.sourceActor || null, sourceAction: originalAction, sourceEntityId: originalEntityId, sourceDetails: raw.details ?? raw.detalle ?? null, sourcePayload: raw };
        const inserted = await repo.rows(db, 'INSERT INTO audit_logs (business_id,user_id,action,entity,entity_id,details,created_at) VALUES (?,NULL,\'LOCAL_HISTORY\',?,?,?,?)',
          [businessId, originalEntity, originalEntityId, JSON.stringify(details), createdAt]);
        await mapRecord(db, businessId, batchId, row, 'audit_logs', inserted.insertId);
        changes.auditLogs++;
      }

      return { changes, issues, sessionTargets: Object.fromEntries(sessionTargets), expenseTargets: Object.fromEntries(expenseTargets), orderTargets: Object.fromEntries(orderTargets), supplierPayments: Object.fromEntries(supplierPayments) };
    });
  }

  async function mapRecord(db, businessId, batchId, row, table, id, pendingReason = null, allowPending = false) {
    const statuses = allowPending ? "('ARCHIVED','PROJECTED','PENDING')" : "('ARCHIVED','PROJECTED')";
    await repo.rows(db, "UPDATE migration_source_records SET record_status='PROJECTED',target_table=?,target_record_id=?,pending_reason=?,updated_at=UTC_TIMESTAMP(3) WHERE business_id=? AND batch_id=? AND entity_type=? AND source_record_key=? AND record_status IN " + statuses, [table, String(id), pendingReason, businessId, batchId, row.entityType, row.sourceRecordKey]);
  }

  function difference(row, module, field, reason, expected = null, found = null) {
    return { origin: row.sourceRecordKey, module, field, expected, found, reason };
  }

  async function reconcileOperationalModules(db, businessId, batchId, sourceKey, records, sourcePackage = null) {
    const differences = [];
    const byEntity = entity => records.filter(row => row.entityType === entity);
    const sumSource = (rows, aliases, scale, module, field) => {
      let sum = 0n;
      for (const row of rows) {
        const raw = first(row.payload, aliases);
        const parsed = scaled(raw, scale, true);
        if (parsed === null) differences.push(difference(row, module, field, 'El valor original no se puede comparar con precisión.', raw, null));
        else sum += parsed;
      }
      return formatScaled(sum, scale);
    };
    const compare = (module, field, expected, found, reason) => {
      if (String(expected) !== String(found)) differences.push({ origin: batchId, module, field, expected: String(expected), found: String(found), reason });
    };
    const firstRow = async (sql, values) => (await repo.rows(db, sql, values))[0] || {};
    const compareTransactionRows = async (entity, table, amountAliases, dateAliases, statusAliases, cancelAliases) => {
      const targetRows = await repo.rows(db, 'SELECT r.source_record_key AS sourceRecordKey,t.status,t.total,DATE_FORMAT(t.created_at,\'%Y-%m-%d %H:%i:%s.%f\') AS createdAt FROM migration_source_records r JOIN ' + table + ' t ON t.business_id=r.business_id AND t.id=r.target_record_id WHERE r.business_id=? AND r.batch_id=? AND r.entity_type=? AND r.target_table=? AND r.record_status=\'PROJECTED\'', [businessId, batchId, entity, table]);
      const targets = new Map(targetRows.map(row => [row.sourceRecordKey, row]));
      for (const source of byEntity(entity)) {
        if (source.recordStatus !== 'PROJECTED' || source.targetTable !== table) continue;
        const target = targets.get(source.sourceRecordKey);
        if (!target) {
          differences.push(difference(source, entity, 'targetRecord', 'No se encontró el registro operativo enlazado para conciliar.'));
          continue;
        }
        const rawStatus = token(first(source.payload, statusAliases));
        const cancelValue = first(source.payload, cancelAliases);
        const cancelled = cancelValue === true || cancelValue === 1 || /^(TRUE|1|SI|S|ANULADA|CANCELADA|CANCELLED|VOID)$/.test(token(cancelValue));
        const expectedStatus = cancelled || /CANCEL|ANUL|VOID/.test(rawStatus) ? 'CANCELLED' : (!rawStatus || /^(COMPLETED|COMPLETE|COMPLETA|COMPLETADA|PAGADA|PAGADO|FINALIZADA|FINALIZADO|CONFIRMADA|CONFIRMADO|OK|ACTIVE|ACTIVA)$/.test(rawStatus) ? 'COMPLETED' : rawStatus);
        compare(entity, source.sourceRecordKey + '.status', expectedStatus, target.status, 'El estado histórico no coincide con el paquete original.');
        const expectedAmount = scaled(first(source.payload, amountAliases), 2);
        if (expectedAmount === null) differences.push(difference(source, entity, 'total', 'El importe original no se puede conciliar con precisión.'));
        else compare(entity, source.sourceRecordKey + '.total', formatScaled(expectedAmount, 2), String(target.total), 'El importe del registro no coincide con el paquete original.');
        const expectedDate = dateSql(first(source.payload, dateAliases));
        if (!expectedDate) differences.push(difference(source, entity, 'createdAt', 'La fecha original no se puede conciliar.'));
        else compare(entity, source.sourceRecordKey + '.createdAt', expectedDate, String(target.createdAt).slice(0, 23), 'La fecha histórica no coincide con el paquete original.');
      }
    };
    const sales = byEntity('sales');
    const purchases = byEntity('purchases');
    const customerPayments = byEntity('abonos').filter(row => !token(first(row.payload, ['tipo', 'type'])).includes('PROVEEDOR'));
    const supplierPayments = byEntity('abonos').filter(row => token(first(row.payload, ['tipo', 'type'])).includes('PROVEEDOR'));
    const expenses = byEntity('expenses');
    const inventory = byEntity('inventoryMovements');
    const sessions = byEntity('cashSessions');
    const orders = byEntity('saleOrders');
    const auditRows = byEntity('auditLogs');
    const salesTarget = await firstRow('SELECT COUNT(*) AS count,COALESCE(SUM(s.total),0.00) AS total FROM migration_source_records r JOIN sales s ON s.business_id=r.business_id AND s.id=r.target_record_id AND s.is_historical=TRUE WHERE r.business_id=? AND r.batch_id=? AND r.entity_type=\'sales\' AND r.target_table=\'sales\' AND r.record_status=\'PROJECTED\'', [businessId, batchId]);
    const purchasesTarget = await firstRow('SELECT COUNT(*) AS count,COALESCE(SUM(p.total),0.00) AS total FROM migration_source_records r JOIN purchases p ON p.business_id=r.business_id AND p.id=r.target_record_id AND p.is_historical=TRUE WHERE r.business_id=? AND r.batch_id=? AND r.entity_type=\'purchases\' AND r.target_table=\'purchases\' AND r.record_status=\'PROJECTED\'', [businessId, batchId]);
    compare('sales', 'recordCount', sales.length, Number(salesTarget.count), 'La cantidad de ventas operativas no coincide con el paquete.');
    compare('sales', 'total', sumSource(sales, ['total', 'totalVenta', 'montoTotal', 'importeTotal'], 2, 'sales', 'total'), String(salesTarget.total), 'El total de ventas no coincide con el paquete.');
    await compareTransactionRows('sales', 'sales', ['total', 'totalVenta', 'montoTotal', 'importeTotal'], ['createdAt', 'created_at', 'fechaTS', 'fecha', 'timestamp', 'date'], ['status', 'estado', 'saleStatus'], ['cancelled', 'cancelado', 'anulado', 'anulada']);
    compare('purchases', 'recordCount', purchases.length, Number(purchasesTarget.count), 'La cantidad de compras operativas no coincide con el paquete.');
    compare('purchases', 'total', sumSource(purchases, ['total', 'totalCompra', 'montoTotal', 'importeTotal'], 2, 'purchases', 'total'), String(purchasesTarget.total), 'El total de compras no coincide con el paquete.');
    await compareTransactionRows('purchases', 'purchases', ['total', 'totalCompra', 'montoTotal', 'importeTotal'], ['createdAt', 'created_at', 'fechaTS', 'fecha', 'timestamp', 'date'], ['status', 'estado', 'purchaseStatus'], ['cancelled', 'cancelado', 'anulado', 'anulada']);

    const productLinksForDetails = mappingIndex(records);
    const lineDiff = (row, module, field, expected, found, reason) => {
      const normalizedExpected = expected === null || expected === undefined ? null : String(expected);
      const normalizedFound = found === null || found === undefined ? null : String(found);
      if (normalizedExpected !== normalizedFound) differences.push(difference(row, module, field, reason, normalizedExpected, normalizedFound));
    };
    if (sourcePackage) {
      let salesImportPackage = null, purchaseImportPackage = null;
      try { salesImportPackage = packageForSalesImport(sourcePackage); }
      catch { differences.push({ origin: batchId, module: 'sales', field: 'sourceNormalization', expected: 'Detalles válidos', found: 'No normalizables', reason: 'No se pudieron normalizar los detalles originales para verificar las líneas operativas.' }); }
      try { purchaseImportPackage = packageForPurchasesImport(sourcePackage); }
      catch { differences.push({ origin: batchId, module: 'purchases', field: 'sourceNormalization', expected: 'Detalles válidos', found: 'No normalizables', reason: 'No se pudieron normalizar los detalles originales para verificar las líneas operativas.' }); }

      if (salesImportPackage) {
        const targetLines = await repo.rows(db, `SELECT r.source_record_key AS sourceRecordKey,si.product_id AS productId,p.name AS targetProductName,p.barcode AS targetBarcode,si.product_name AS productName,si.barcode,si.quantity,si.unit_price AS unitPrice,si.tax_rate AS taxRate,si.discount,si.subtotal,si.total,si.cost_at_sale AS costAtSale FROM migration_source_records r JOIN sales s ON s.business_id=r.business_id AND s.id=r.target_record_id AND s.is_historical=TRUE JOIN sale_items si ON si.business_id=s.business_id AND si.sale_id=s.id JOIN products p ON p.business_id=si.business_id AND p.id=si.product_id WHERE r.business_id=? AND r.batch_id=? AND r.entity_type='sales' AND r.target_table='sales' AND r.record_status='PROJECTED' ORDER BY r.source_record_key,si.id`, [businessId, batchId]);
        const targetBySale = new Map();
        for (const line of targetLines) targetBySale.set(line.sourceRecordKey, [...(targetBySale.get(line.sourceRecordKey) || []), line]);
        for (const row of sales.filter(item => item.recordStatus === 'PROJECTED' && item.targetTable === 'sales')) {
          const sourceId = sourceIdFromKey(row.sourceRecordKey);
          const index = salesImportPackage.sales.findIndex(item => String(item.id) === String(sourceId));
          const normalized = normalizeSale(row.payload, index < 0 ? 0 : index, salesImportPackage);
          if (normalized.error) { differences.push(difference(row, 'sales', 'items', 'Los detalles originales no se pudieron normalizar: ' + normalized.error)); continue; }
          const actual = targetBySale.get(row.sourceRecordKey) || [];
          if (actual.length !== normalized.items.length) differences.push(difference(row, 'sales', 'items.count', 'La cantidad de detalles de la venta no coincide.', normalized.items.length, actual.length));
          for (let line = 0; line < Math.min(normalized.items.length, actual.length); line++) {
            const expected = normalized.items[line], found = actual[line];
            const targetProductId = expected.sourceProductId ? productLinksForDetails.get('products:' + expected.sourceProductId) : null;
            const expectedProductName = expected.name || found.targetProductName;
            const expectedBarcode = expected.barcode || found.targetBarcode || null;
            const expectedTaxRate = expected.taxRate === null ? found.taxRate : formatScaled(expected.taxRate, 4);
            const expectedCost = expected.costCents === null ? found.costAtSale : formatScaled(expected.costCents, 2);
            lineDiff(row, 'sales', line + '.productId', targetProductId || null, found.productId, 'El producto del detalle de venta no coincide con su referencia local.');
            lineDiff(row, 'sales', line + '.productName', expectedProductName, found.productName, 'El nombre del producto en el detalle de venta cambió.');
            lineDiff(row, 'sales', line + '.barcode', expectedBarcode, found.barcode, 'El código de barras del detalle de venta cambió.');
            lineDiff(row, 'sales', line + '.quantity', formatScaled(expected.quantity, 3), found.quantity, 'La cantidad del detalle de venta no coincide.');
            lineDiff(row, 'sales', line + '.unitPrice', formatScaled(expected.unitPrice, 2), found.unitPrice, 'El precio del detalle de venta no coincide.');
            lineDiff(row, 'sales', line + '.taxRate', expectedTaxRate, found.taxRate, 'La tasa de impuesto del detalle de venta no coincide.');
            lineDiff(row, 'sales', line + '.discount', formatScaled(expected.discount, 2), found.discount, 'El descuento del detalle de venta no coincide.');
            lineDiff(row, 'sales', line + '.subtotal', formatScaled(expected.subtotal, 2), found.subtotal, 'El subtotal del detalle de venta no coincide.');
            lineDiff(row, 'sales', line + '.total', formatScaled(expected.total, 2), found.total, 'El total del detalle de venta no coincide.');
            lineDiff(row, 'sales', line + '.costAtSale', expectedCost, found.costAtSale, 'El costo histórico del detalle de venta no coincide.');
          }
        }
      }

      if (purchaseImportPackage) {
        const targetLines = await repo.rows(db, `SELECT r.source_record_key AS sourceRecordKey,pi.product_id AS productId,pi.product_name AS productName,pi.quantity,pi.unit_cost AS unitCost,pi.subtotal,pi.discount,pi.tax,pi.total FROM migration_source_records r JOIN purchases p ON p.business_id=r.business_id AND p.id=r.target_record_id AND p.is_historical=TRUE JOIN purchase_items pi ON pi.business_id=p.business_id AND pi.purchase_id=p.id WHERE r.business_id=? AND r.batch_id=? AND r.entity_type='purchases' AND r.target_table='purchases' AND r.record_status='PROJECTED' ORDER BY r.source_record_key,pi.id`, [businessId, batchId]);
        const targetByPurchase = new Map();
        for (const line of targetLines) targetByPurchase.set(line.sourceRecordKey, [...(targetByPurchase.get(line.sourceRecordKey) || []), line]);
        for (const row of purchases.filter(item => item.recordStatus === 'PROJECTED' && item.targetTable === 'purchases')) {
          const sourceId = sourceIdFromKey(row.sourceRecordKey);
          const index = purchaseImportPackage.purchases.findIndex(item => String(item.id) === String(sourceId));
          const normalized = normalizePurchase(row.payload, index < 0 ? 0 : index, purchaseImportPackage);
          if (normalized.error) { differences.push(difference(row, 'purchases', 'items', 'Los detalles originales no se pudieron normalizar: ' + normalized.error)); continue; }
          const actual = targetByPurchase.get(row.sourceRecordKey) || [];
          if (actual.length !== normalized.items.length) differences.push(difference(row, 'purchases', 'items.count', 'La cantidad de detalles de la compra no coincide.', normalized.items.length, actual.length));
          for (let line = 0; line < Math.min(normalized.items.length, actual.length); line++) {
            const expected = normalized.items[line], found = actual[line];
            const targetProductId = expected.sourceProductId ? productLinksForDetails.get('products:' + expected.sourceProductId) : null;
            lineDiff(row, 'purchases', line + '.productId', targetProductId || null, found.productId, 'El producto del detalle de compra no coincide con su referencia local.');
            lineDiff(row, 'purchases', line + '.productName', expected.name, found.productName, 'El nombre del producto en el detalle de compra cambió.');
            lineDiff(row, 'purchases', line + '.quantity', formatScaled(expected.quantity, 3), found.quantity, 'La cantidad del detalle de compra no coincide.');
            lineDiff(row, 'purchases', line + '.unitCost', formatScaled(expected.unitCost, 2), found.unitCost, 'El costo del detalle de compra no coincide.');
            lineDiff(row, 'purchases', line + '.subtotal', formatScaled(expected.subtotal, 2), found.subtotal, 'El subtotal del detalle de compra no coincide.');
            lineDiff(row, 'purchases', line + '.discount', formatScaled(expected.discount, 2), found.discount, 'El descuento del detalle de compra no coincide.');
            lineDiff(row, 'purchases', line + '.tax', formatScaled(expected.tax, 2), found.tax, 'El impuesto del detalle de compra no coincide.');
            lineDiff(row, 'purchases', line + '.total', formatScaled(expected.total, 2), found.total, 'El total del detalle de compra no coincide.');
          }
        }
      }
    }

    const customerPaymentsTarget = await firstRow('SELECT COUNT(DISTINCT r.source_payment_id) AS count,COALESCE(SUM(p.amount),0.00) AS amount FROM migration_credit_payment_references r JOIN customer_payments p ON p.business_id=r.business_id AND p.id=r.customer_payment_id AND p.is_historical=TRUE WHERE r.business_id=? AND r.source_business_key=?', [businessId, sourceKey]);
    const supplierPaymentsTarget = await firstRow('SELECT COUNT(*) AS count,COALESCE(SUM(p.amount),0.00) AS amount FROM migration_supplier_payment_references r JOIN supplier_payments p ON p.business_id=r.business_id AND p.id=r.supplier_payment_id AND p.is_historical=TRUE WHERE r.business_id=? AND r.source_business_key=?', [businessId, sourceKey]);
    compare('customerPayments', 'recordCount', customerPayments.length, Number(customerPaymentsTarget.count), 'La cantidad de abonos de clientes no coincide con el paquete.');
    compare('customerPayments', 'amount', sumSource(customerPayments, ['amount', 'monto', 'importe'], 2, 'customerPayments', 'amount'), String(customerPaymentsTarget.amount), 'El total de abonos de clientes no coincide con el paquete.');
    compare('supplierPayments', 'recordCount', supplierPayments.length, Number(supplierPaymentsTarget.count), 'La cantidad de pagos a proveedores no coincide con el paquete.');
    compare('supplierPayments', 'amount', sumSource(supplierPayments, ['amount', 'monto', 'importe'], 2, 'supplierPayments', 'amount'), String(supplierPaymentsTarget.amount), 'El total de pagos a proveedores no coincide con el paquete.');

    const expensesTarget = await firstRow('SELECT COUNT(*) AS count,COALESCE(SUM(e.amount),0.00) AS amount FROM migration_source_records r JOIN expenses e ON e.business_id=r.business_id AND e.id=r.target_record_id AND e.is_historical=TRUE WHERE r.business_id=? AND r.batch_id=? AND r.entity_type=\'expenses\' AND r.target_table=\'expenses\' AND r.record_status=\'PROJECTED\'', [businessId, batchId]);
    compare('expenses', 'recordCount', expenses.length, Number(expensesTarget.count), 'La cantidad de gastos no coincide con el paquete.');
    compare('expenses', 'amount', sumSource(expenses, ['amount', 'monto', 'importe', 'total'], 2, 'expenses', 'amount'), String(expensesTarget.amount), 'El total de gastos no coincide con el paquete.');

    const inventoryTarget = await firstRow('SELECT COUNT(*) AS count,COALESCE(SUM(m.quantity),0.000) AS quantity,COALESCE(SUM(CASE WHEN m.quantity>0 THEN m.quantity ELSE 0 END),0.000) AS positiveQuantity,COALESCE(SUM(CASE WHEN m.quantity<0 THEN m.quantity ELSE 0 END),0.000) AS negativeQuantity FROM migration_source_records r JOIN inventory_movements m ON m.business_id=r.business_id AND m.id=r.target_record_id AND m.is_historical=TRUE WHERE r.business_id=? AND r.batch_id=? AND r.entity_type=\'inventoryMovements\' AND r.target_table=\'inventory_movements\' AND r.record_status=\'PROJECTED\'', [businessId, batchId]);
    const zeroInventoryTarget = await firstRow('SELECT COUNT(*) AS count FROM migration_source_records r JOIN migration_zero_inventory_events z ON z.business_id=r.business_id AND z.id=r.target_record_id AND z.source_record_key=r.source_record_key WHERE r.business_id=? AND r.batch_id=? AND r.entity_type=\'inventoryMovements\' AND r.target_table=\'migration_zero_inventory_events\' AND r.record_status=\'PROJECTED\' AND z.quantity=0.000', [businessId, batchId]);
    const inventoryPositive = sumSource(inventory.filter(row => scaled(first(row.payload, ['quantity', 'cantidad', 'qty']), 3, true) > 0n), ['quantity', 'cantidad', 'qty'], 3, 'inventoryMovements', 'positiveQuantity');
    const inventoryNegative = sumSource(inventory.filter(row => scaled(first(row.payload, ['quantity', 'cantidad', 'qty']), 3, true) < 0n), ['quantity', 'cantidad', 'qty'], 3, 'inventoryMovements', 'negativeQuantity');
    const zeroInventory = inventory.filter(row => scaled(first(row.payload, ['quantity', 'cantidad', 'qty']), 3, true) === 0n);
    compare('inventoryMovements', 'recordCount', inventory.length, Number(inventoryTarget.count) + Number(zeroInventoryTarget.count), 'La cantidad de eventos Kardex no coincide con el paquete.');
    compare('inventoryMovements', 'zeroQuantityEvents', zeroInventory.length, Number(zeroInventoryTarget.count), 'Los eventos históricos de cantidad cero no coinciden con el paquete.');
    compare('inventoryMovements', 'quantity', sumSource(inventory, ['quantity', 'cantidad', 'qty'], 3, 'inventoryMovements', 'quantity'), String(inventoryTarget.quantity), 'La variación total del Kardex no coincide con el paquete.');
    compare('inventoryMovements', 'positiveQuantity', inventoryPositive, String(inventoryTarget.positiveQuantity), 'Las entradas de Kardex no coinciden con el paquete.');
    compare('inventoryMovements', 'negativeQuantity', inventoryNegative, String(inventoryTarget.negativeQuantity), 'Las salidas de Kardex no coinciden con el paquete.');
    const inventoryDetails = await repo.rows(db, 'SELECT r.source_record_key AS sourceRecordKey,m.product_id AS productId,m.type,m.quantity,m.stock_after AS stockAfter,m.unit_cost AS unitCost,DATE_FORMAT(m.created_at,\'%Y-%m-%d %H:%i:%s.%f\') AS createdAt FROM migration_source_records r LEFT JOIN inventory_movements m ON m.business_id=r.business_id AND m.id=r.target_record_id AND m.is_historical=TRUE WHERE r.business_id=? AND r.batch_id=? AND r.entity_type=\'inventoryMovements\' AND r.target_table=\'inventory_movements\' AND r.record_status=\'PROJECTED\'', [businessId, batchId]);
    const inventoryByKey = new Map(inventoryDetails.map(row => [row.sourceRecordKey, row]));
    const productLinks = mappingIndex(records);
    for (const source of inventory.filter(row => scaled(first(row.payload, ['quantity', 'cantidad', 'qty']), 3, true) !== 0n)) {
      const target = inventoryByKey.get(source.sourceRecordKey);
      if (!target) continue;
      const sourceProductId = identity(first(source.payload, ['productId', 'productoId', 'producto_id', 'product_id']));
      compare('inventoryMovements', source.sourceRecordKey + '.productId', productLinks.get('products:' + sourceProductId) || null, target.productId === null ? null : String(target.productId), 'El producto enlazado en el Kardex no coincide con su referencia de origen.');
      compare('inventoryMovements', source.sourceRecordKey + '.type', inventoryType(first(source.payload, ['type', 'tipo', 'movementType', 'movimiento'])), target.type, 'El tipo de movimiento no coincide con el original.');
      const quantity = scaled(first(source.payload, ['quantity', 'cantidad', 'qty']), 3, true);
      compare('inventoryMovements', source.sourceRecordKey + '.quantity', quantity === null ? null : formatScaled(quantity, 3), String(target.quantity), 'La cantidad del movimiento no coincide con el original.');
      const sourceStockAfter = first(source.payload, ['stockAfter', 'stock_after', 'existenciaFinal', 'stockResultante', 'stock_nuevo']);
      const expectedStockAfter = sourceStockAfter === undefined || sourceStockAfter === null ? null : scaled(sourceStockAfter, 3, true);
      compare('inventoryMovements', source.sourceRecordKey + '.stockAfter', expectedStockAfter === null ? null : formatScaled(expectedStockAfter, 3), target.stockAfter === null ? null : String(target.stockAfter), 'La existencia resultante del movimiento no coincide con el original.');
      const sourceUnitCost = first(source.payload, ['unitCost', 'unit_cost', 'cost', 'costo', 'costoUnitario', 'costo_unitario']);
      const expectedUnitCost = sourceUnitCost === undefined || sourceUnitCost === null ? null : scaled(sourceUnitCost, 2);
      compare('inventoryMovements', source.sourceRecordKey + '.unitCost', expectedUnitCost === null ? null : formatScaled(expectedUnitCost, 2), target.unitCost === null ? null : String(target.unitCost), 'El costo unitario del movimiento no coincide con el original.');
      const expectedDate = dateSql(first(source.payload, ['createdAt', 'created_at', 'fechaTS', 'fecha', 'date']));
      compare('inventoryMovements', source.sourceRecordKey + '.createdAt', expectedDate, target.createdAt === null ? null : String(target.createdAt).slice(0, 23), 'La fecha del movimiento no coincide con el original.');
    }
    const zeroInventoryDetails = await repo.rows(db, 'SELECT r.source_record_key AS sourceRecordKey,z.product_id AS productId,z.source_type AS sourceType,z.quantity,z.stock_after AS stockAfter,z.unit_cost AS unitCost,z.reason,DATE_FORMAT(z.occurred_at,\'%Y-%m-%d %H:%i:%s.%f\') AS occurredAt FROM migration_source_records r LEFT JOIN migration_zero_inventory_events z ON z.business_id=r.business_id AND z.id=r.target_record_id AND z.source_record_key=r.source_record_key WHERE r.business_id=? AND r.batch_id=? AND r.entity_type=\'inventoryMovements\' AND r.target_table=\'migration_zero_inventory_events\' AND r.record_status=\'PROJECTED\'', [businessId, batchId]);
    const zeroInventoryByKey = new Map(zeroInventoryDetails.map(row => [row.sourceRecordKey, row]));
    for (const source of zeroInventory) {
      const target = zeroInventoryByKey.get(source.sourceRecordKey);
      if (!target) continue;
      const sourceProductId = identity(first(source.payload, ['productId', 'productoId', 'producto_id', 'product_id']));
      compare('inventoryMovements', source.sourceRecordKey + '.zeroProductId', productLinks.get('products:' + sourceProductId) || null, target.productId === null ? null : String(target.productId), 'El evento cero no conserva el producto relacionado.');
      compare('inventoryMovements', source.sourceRecordKey + '.zeroQuantity', '0.000', String(target.quantity), 'El evento histórico debe conservar cantidad cero.');
      compare('inventoryMovements', source.sourceRecordKey + '.zeroType', String(first(source.payload, ['type', 'tipo', 'movementType', 'movimiento']) ?? inventoryType(first(source.payload, ['type', 'tipo', 'movementType', 'movimiento']))), target.sourceType, 'El evento cero no conserva su tipo original.');
      const sourceStockAfter = first(source.payload, ['stockAfter', 'stock_after', 'existenciaFinal', 'stockResultante', 'stock_nuevo']);
      const expectedStockAfter = sourceStockAfter === undefined || sourceStockAfter === null ? null : scaled(sourceStockAfter, 3, true);
      compare('inventoryMovements', source.sourceRecordKey + '.zeroStockAfter', expectedStockAfter === null ? null : formatScaled(expectedStockAfter, 3), target.stockAfter === null ? null : String(target.stockAfter), 'El stock informado por el evento cero no coincide con el original.');
      const sourceUnitCost = first(source.payload, ['unitCost', 'unit_cost', 'cost', 'costo', 'costoUnitario', 'costo_unitario']);
      const expectedUnitCost = sourceUnitCost === undefined || sourceUnitCost === null ? null : scaled(sourceUnitCost, 2);
      compare('inventoryMovements', source.sourceRecordKey + '.zeroUnitCost', expectedUnitCost === null ? null : formatScaled(expectedUnitCost, 2), target.unitCost === null ? null : String(target.unitCost), 'El costo del evento cero no coincide con el original.');
      const expectedDate = dateSql(first(source.payload, ['createdAt', 'created_at', 'fechaTS', 'fecha', 'date']));
      compare('inventoryMovements', source.sourceRecordKey + '.zeroCreatedAt', expectedDate, target.occurredAt === null ? null : String(target.occurredAt).slice(0, 23), 'La fecha del evento cero no coincide con el original.');
    }
    const sourceProducts = byEntity('products');
    const stockRows = await repo.rows(db, 'SELECT r.source_record_key AS sourceRecordKey,p.stock FROM migration_source_records r JOIN products p ON p.business_id=r.business_id AND p.id=r.target_record_id WHERE r.business_id=? AND r.batch_id=? AND r.entity_type=\'products\' AND r.target_table=\'products\' AND r.record_status=\'PROJECTED\'', [businessId, batchId]);
    const stockByKey = new Map(stockRows.map(row => [row.sourceRecordKey, String(row.stock)]));
    for (const source of sourceProducts) {
      const expectedStockValue = first(source.payload, ['stock', 'existencia', 'cantidadDisponible']);
      if (expectedStockValue === undefined || expectedStockValue === null) continue;
      const expectedStock = scaled(expectedStockValue, 3, true);
      compare('inventoryStock', source.sourceRecordKey, expectedStock === null ? null : formatScaled(expectedStock, 3), stockByKey.get(source.sourceRecordKey) ?? null, 'Las existencias finales no coinciden con las del POS local. Los eventos históricos no deben recalcularlas.');
    }

    const sessionsTarget = await firstRow('SELECT COUNT(*) AS count,COUNT(s.counted_amount) AS countedCount,COUNT(s.expected_amount) AS expectedCount,COALESCE(SUM(s.opening_amount),0.00) AS openingAmount,COALESCE(SUM(COALESCE(s.counted_amount,0.00)),0.00) AS countedAmount,COALESCE(SUM(COALESCE(s.expected_amount,0.00)),0.00) AS expectedAmount,COALESCE(SUM(COALESCE(s.difference,0.00)),0.00) AS difference FROM migration_source_records r JOIN cash_sessions s ON s.business_id=r.business_id AND s.id=r.target_record_id AND s.is_historical=TRUE WHERE r.business_id=? AND r.batch_id=? AND r.entity_type=\'cashSessions\' AND r.target_table=\'cash_sessions\' AND r.record_status=\'PROJECTED\'', [businessId, batchId]);
    const sessionDetailRows = await repo.rows(db, 'SELECT r.source_record_key AS sourceRecordKey,s.status,s.source_status AS sourceStatus,DATE_FORMAT(s.opened_at,\'%Y-%m-%d %H:%i:%s.%f\') AS openedAt,DATE_FORMAT(s.closed_at,\'%Y-%m-%d %H:%i:%s.%f\') AS closedAt,s.source_opened_by AS sourceOpenedBy,s.source_closed_by AS sourceClosedBy,s.counted_amount AS countedAmount,s.expected_amount AS expectedAmount,s.difference FROM migration_source_records r JOIN cash_sessions s ON s.business_id=r.business_id AND s.id=r.target_record_id AND s.is_historical=TRUE WHERE r.business_id=? AND r.batch_id=? AND r.entity_type=\'cashSessions\' AND r.target_table=\'cash_sessions\' AND r.record_status=\'PROJECTED\'', [businessId, batchId]);
    const sessionDetails = new Map(sessionDetailRows.map(row => [row.sourceRecordKey, row]));
    for (const source of sessions.filter(row => row.recordStatus === 'PROJECTED' && row.targetTable === 'cash_sessions')) {
      const target = sessionDetails.get(source.sourceRecordKey);
      if (!target) continue;
      const rawStatus = first(source.payload, ['status', 'estado']);
      const rawClosedAt = dateSql(first(source.payload, ['closedAt', 'closed_at', 'fechaCierreTS', 'fechaCierre', 'fecha_cierre']));
      const hasCloseTotals = first(source.payload, ['countedAmount', 'counted_amount', 'closingAmount', 'montoReal', 'efectivoReal', 'montoCierre', 'montoFinal', 'cierre']) !== undefined && first(source.payload, ['expectedAmount', 'expected_amount', 'montoEsperado', 'efectivoEsperado']) !== undefined;
      const expectedSourceStatus = rawStatus === undefined ? (rawClosedAt && hasCloseTotals ? 'INFERRED_CLOSED' : null) : text(String(rawStatus), 20);
      compare('cashSessions', source.sourceRecordKey + '.operationalStatus', 'CLOSED', target.status, 'Una sesión local se conserva solo como historial cerrado para no crear una caja activa en el destino.');
      compare('cashSessions', source.sourceRecordKey + '.sourceStatus', expectedSourceStatus, target.sourceStatus, 'El estado original de la caja no coincide con el paquete.');
      const openedAt = dateSql(first(source.payload, ['openedAt', 'opened_at', 'fechaAperturaTS', 'fechaApertura', 'fecha_apertura', 'createdAt', 'fechaTS']));
      compare('cashSessions', source.sourceRecordKey + '.openedAt', openedAt, target.openedAt === null ? null : String(target.openedAt).slice(0, 23), 'La fecha de apertura no coincide con el paquete.');
      compare('cashSessions', source.sourceRecordKey + '.closedAt', rawClosedAt, target.closedAt === null ? null : String(target.closedAt).slice(0, 23), 'La fecha de cierre no coincide con el paquete.');
      const openedBy = text(first(source.payload, ['openedBy', 'opened_by', 'usuarioApertura', 'cajeroApertura']), 180) || source.sourceActor || null;
      const closedBy = text(first(source.payload, ['closedBy', 'closed_by', 'usuarioCierre', 'cajeroCierre']), 180);
      compare('cashSessions', source.sourceRecordKey + '.openedBy', openedBy, target.sourceOpenedBy, 'La persona que abrió la caja no coincide con el paquete.');
      compare('cashSessions', source.sourceRecordKey + '.closedBy', closedBy, target.sourceClosedBy, 'La persona que cerró la caja no coincide con el paquete.');
    }
    const sessionOpening = sumSource(sessions, ['openingAmount', 'opening_amount', 'montoInicial', 'efectivoInicial', 'apertura', 'initialCash'], 2, 'cashSessions', 'openingAmount');
    compare('cashSessions', 'recordCount', sessions.length, Number(sessionsTarget.count), 'La cantidad de aperturas y cierres no coincide con el paquete.');
    compare('cashSessions', 'openingAmount', sessionOpening, String(sessionsTarget.openingAmount), 'El efectivo inicial no coincide con el paquete.');
    const countedSessions = sessions.filter(row => first(row.payload, ['countedAmount', 'counted_amount', 'closingAmount', 'montoReal', 'efectivoReal', 'montoCierre', 'montoFinal', 'cierre']) !== undefined);
    const expectedSessions = sessions.filter(row => first(row.payload, ['expectedAmount', 'expected_amount', 'montoEsperado', 'efectivoEsperado']) !== undefined);
    const differenceSessions = sessions.filter(row => first(row.payload, ['difference', 'diferencia']) !== undefined);
    compare('cashSessions', 'countedCount', countedSessions.length, Number(sessionsTarget.countedCount), 'La cantidad de conteos reales no coincide con el paquete.');
    compare('cashSessions', 'countedAmount', sumSource(countedSessions, ['countedAmount', 'counted_amount', 'closingAmount', 'montoReal', 'efectivoReal', 'montoCierre', 'montoFinal', 'cierre'], 2, 'cashSessions', 'countedAmount'), String(sessionsTarget.countedAmount), 'El efectivo contado al cierre no coincide con el paquete.');
    compare('cashSessions', 'expectedCount', expectedSessions.length, Number(sessionsTarget.expectedCount), 'La cantidad de cierres esperados no coincide con el paquete.');
    compare('cashSessions', 'expectedAmount', sumSource(expectedSessions, ['expectedAmount', 'expected_amount', 'montoEsperado', 'efectivoEsperado'], 2, 'cashSessions', 'expectedAmount'), String(sessionsTarget.expectedAmount), 'El efectivo esperado al cierre no coincide con el paquete.');
    compare('cashSessions', 'difference', sumSource(differenceSessions, ['difference', 'diferencia'], 2, 'cashSessions', 'difference'), String(sessionsTarget.difference), 'La diferencia del cierre no coincide con el paquete.');
    const cashMovements = sessions.flatMap(row => Array.isArray(row.payload.movimientos) ? row.payload.movimientos : Array.isArray(row.payload.movements) ? row.payload.movements : []);
    const cashMovementTotal = sumSource(cashMovements.map(payload => ({ sourceRecordKey: 'cash-movement', payload })), ['amount', 'monto', 'total', 'importe'], 2, 'cashMovements', 'amount');
    const cashMovementsTarget = await firstRow('SELECT COUNT(*) AS count,COALESCE(SUM(m.amount),0.00) AS amount,COALESCE(SUM(CASE WHEN m.direction=\'IN\' THEN m.amount ELSE 0 END),0.00) AS amountIn,COALESCE(SUM(CASE WHEN m.direction=\'OUT\' THEN m.amount ELSE 0 END),0.00) AS amountOut FROM migration_source_records r JOIN cash_sessions s ON s.business_id=r.business_id AND s.id=r.target_record_id AND s.is_historical=TRUE JOIN cash_movements m ON m.business_id=s.business_id AND m.cash_session_id=s.id AND m.is_historical=TRUE WHERE r.business_id=? AND r.batch_id=? AND r.entity_type=\'cashSessions\' AND r.target_table=\'cash_sessions\' AND r.record_status=\'PROJECTED\'', [businessId, batchId]);
    compare('cashMovements', 'recordCount', cashMovements.length, Number(cashMovementsTarget.count), 'La cantidad de movimientos de caja no coincide con el paquete.');
    compare('cashMovements', 'amount', cashMovementTotal, String(cashMovementsTarget.amount), 'El total de movimientos de caja no coincide con el paquete.');
    let expectedIn = 0n, expectedOut = 0n;
    for (const movement of cashMovements) {
      const amount = scaled(first(movement, ['amount', 'monto', 'total', 'importe']), 2, true);
      const direction = token(first(movement, ['direction', 'direccion'])) || cashType(first(movement, ['type', 'tipo', 'kind', 'concepto']))?.[1];
      if (amount !== null && direction === 'IN') expectedIn += amount;
      else if (amount !== null && direction === 'OUT') expectedOut += amount;
      else differences.push({ origin: batchId, module: 'cashMovements', field: 'direction', expected: 'IN/OUT', found: String(direction), reason: 'No se pudo conciliar la dirección de un movimiento de caja.' });
    }
    compare('cashMovements', 'amountIn', formatScaled(expectedIn, 2), String(cashMovementsTarget.amountIn), 'Los ingresos históricos de caja no coinciden con el paquete.');
    compare('cashMovements', 'amountOut', formatScaled(expectedOut, 2), String(cashMovementsTarget.amountOut), 'Los egresos históricos de caja no coinciden con el paquete.');

    const ordersTarget = await firstRow('SELECT COUNT(*) AS count,COALESCE(SUM(o.estimated_total),0.00) AS total FROM migration_source_records r JOIN sale_orders o ON o.business_id=r.business_id AND o.id=r.target_record_id AND o.is_historical=TRUE WHERE r.business_id=? AND r.batch_id=? AND r.entity_type=\'saleOrders\' AND r.target_table=\'sale_orders\' AND r.record_status=\'PROJECTED\'', [businessId, batchId]);
    const orderTotal = sumSource(orders, ['estimatedTotal', 'total', 'totalEstimado'], 2, 'saleOrders', 'total');
    compare('saleOrders', 'recordCount', orders.length, Number(ordersTarget.count), 'La cantidad de órdenes pendientes e históricas no coincide con el paquete.');
    compare('saleOrders', 'total', orderTotal, String(ordersTarget.total), 'El total de órdenes no coincide con el paquete.');
    const orderItemCount = orders.reduce((sum, row) => sum + (Array.isArray(row.payload.items) ? row.payload.items.length : Array.isArray(row.payload.input?.items) ? row.payload.input.items.length : 0), 0);
    const orderItemsTarget = await firstRow('SELECT COUNT(*) AS count,COALESCE(SUM(i.quantity),0.000) AS quantity,COALESCE(SUM(i.estimated_subtotal),0.00) AS subtotal FROM migration_source_records r JOIN sale_orders o ON o.business_id=r.business_id AND o.id=r.target_record_id AND o.is_historical=TRUE JOIN sale_order_items i ON i.business_id=o.business_id AND i.order_id=o.id WHERE r.business_id=? AND r.batch_id=? AND r.entity_type=\'saleOrders\' AND r.target_table=\'sale_orders\' AND r.record_status=\'PROJECTED\'', [businessId, batchId]);
    compare('saleOrders', 'itemCount', orderItemCount, Number(orderItemsTarget.count), 'La cantidad de detalles de órdenes no coincide con el paquete.');
    const orderHeaders = await repo.rows(db, 'SELECT r.source_record_key AS sourceRecordKey,o.id,o.status,o.sale_id AS saleId,o.client_id AS clientId,o.discount_percent AS discountPercent,o.estimated_subtotal AS subtotal,o.estimated_discount AS discount,o.estimated_total AS total,DATE_FORMAT(o.created_at,\'%Y-%m-%d %H:%i:%s.%f\') AS createdAt,DATE_FORMAT(o.cancelled_at,\'%Y-%m-%d %H:%i:%s.%f\') AS cancelledAt,o.detail,o.source_cancelled_by AS cancelledBy FROM migration_source_records r JOIN sale_orders o ON o.business_id=r.business_id AND o.id=r.target_record_id AND o.is_historical=TRUE WHERE r.business_id=? AND r.batch_id=? AND r.entity_type=\'saleOrders\' AND r.target_table=\'sale_orders\' AND r.record_status=\'PROJECTED\'', [businessId, batchId]);
    const orderHeaderByKey = new Map(orderHeaders.map(row => [row.sourceRecordKey, row]));
    const orderItemRows = await repo.rows(db, 'SELECT r.source_record_key AS sourceRecordKey,i.product_id AS productId,i.product_name AS productName,i.quantity,i.estimated_unit_price AS unitPrice,i.estimated_subtotal AS subtotal,i.price_snapshot_available AS priceSnapshotAvailable FROM migration_source_records r JOIN sale_orders o ON o.business_id=r.business_id AND o.id=r.target_record_id AND o.is_historical=TRUE JOIN sale_order_items i ON i.business_id=o.business_id AND i.order_id=o.id WHERE r.business_id=? AND r.batch_id=? AND r.entity_type=\'saleOrders\' AND r.target_table=\'sale_orders\' AND r.record_status=\'PROJECTED\' ORDER BY r.source_record_key,i.line_number', [businessId, batchId]);
    const orderItemRowsByKey = new Map();
    for (const item of orderItemRows) orderItemRowsByKey.set(item.sourceRecordKey, [...(orderItemRowsByKey.get(item.sourceRecordKey) || []), item]);
    const sourceSalesById = new Map(sales.map(row => [String(sourceIdFromKey(row.sourceRecordKey)), row.payload]));
    for (const source of orders) {
      if (source.recordStatus !== 'PROJECTED' || source.targetTable !== 'sale_orders') continue;
      const target = orderHeaderByKey.get(source.sourceRecordKey);
      if (!target) { differences.push(difference(source, 'saleOrders', 'targetRecord', 'No se encontró la orden operativa para revisar sus datos.')); continue; }
      const raw = source.payload, input = raw.input && typeof raw.input === 'object' ? raw.input : {};
      const sourceStatus = token(first(raw, ['status', 'estado']));
      const expectedStatus = /CANCEL|ANUL|VOID/.test(sourceStatus) ? 'CANCELLED' : /COMPLETE|COMPLET|FINALIZ/.test(sourceStatus) ? 'COMPLETED' : /PEND|OPEN|ABIER/.test(sourceStatus) ? 'PENDING' : null;
      compare('saleOrders', source.sourceRecordKey + '.status', expectedStatus, target.status, 'El estado histórico de la orden no coincide.');
      const expectedCreatedAt = dateSql(first(raw, ['createdAt', 'created_at', 'fechaTS', 'fecha']));
      compare('saleOrders', source.sourceRecordKey + '.createdAt', expectedCreatedAt, String(target.createdAt).slice(0, 23), 'La fecha original de la orden no coincide.');
      const expectedTotal = scaled(first(raw, ['estimatedTotal', 'total', 'totalEstimado']) ?? first(input, ['estimatedTotal', 'total']), 2);
      if (expectedTotal !== null) compare('saleOrders', source.sourceRecordKey + '.total', formatScaled(expectedTotal, 2), String(target.total), 'El total estimado original de la orden no coincide.');
      const percentRaw = first(raw, ['discountPercent', 'discount_percent', 'descuentoPorcentaje']) ?? first(input, ['discountPercent']);
      const expectedPercent = percentRaw === undefined ? 0n : scaled(percentRaw, 4);
      if (expectedPercent !== null) compare('saleOrders', source.sourceRecordKey + '.discountPercent', formatScaled(expectedPercent, 4), String(target.discountPercent), 'El porcentaje de descuento de la orden no coincide.');
      let expectedSubtotal = scaled(first(raw, ['estimatedSubtotal', 'subtotal', 'subtotalEstimado']) ?? first(input, ['estimatedSubtotal', 'subtotal']), 2);
      let expectedDiscount = scaled(first(raw, ['estimatedDiscount', 'discount', 'descuento']) ?? first(input, ['estimatedDiscount', 'discount']), 2);
      if (expectedSubtotal === null && expectedDiscount === null && expectedTotal !== null && expectedPercent === 0n) { expectedSubtotal = expectedTotal; expectedDiscount = 0n; }
      if (expectedSubtotal !== null) compare('saleOrders', source.sourceRecordKey + '.subtotal', formatScaled(expectedSubtotal, 2), String(target.subtotal), 'El subtotal original de la orden no coincide.');
      if (expectedDiscount !== null) compare('saleOrders', source.sourceRecordKey + '.discount', formatScaled(expectedDiscount, 2), String(target.discount), 'El descuento original de la orden no coincide.');
      const expectedCancelledAt = expectedStatus === 'CANCELLED' ? dateSql(first(raw, ['cancelledAt', 'cancelled_at', 'fechaAnulacion'])) : null;
      if (expectedCancelledAt) compare('saleOrders', source.sourceRecordKey + '.cancelledAt', expectedCancelledAt, target.cancelledAt === null ? null : String(target.cancelledAt).slice(0, 23), 'La fecha de anulación de la orden no coincide.');
      const localSaleId = identity(first(raw, ['saleId', 'sale_id', 'ventaId', 'venta_id']));
      if (localSaleId) compare('saleOrders', source.sourceRecordKey + '.saleId', mappingIndex(records).get('sales:' + localSaleId) || null, target.saleId === null ? null : String(target.saleId), 'La venta relacionada con la orden no coincide.');
      const clientSourceId = identity(first(raw, ['clientId', 'client_id', 'clienteId', 'cliente_id']) ?? first(input, ['clientId', 'clienteId']));
      if (clientSourceId) compare('saleOrders', source.sourceRecordKey + '.clientId', productLinksForDetails.get('clients:' + clientSourceId) || null, target.clientId === null ? null : String(target.clientId), 'El cliente relacionado con la orden no coincide.');
      let expectedItems = Array.isArray(raw.items) ? raw.items : Array.isArray(input.items) ? input.items : [];
      if (expectedStatus === 'COMPLETED' && localSaleId && sourceSalesById.has(String(localSaleId))) {
        const linkedSale = sourceSalesById.get(String(localSaleId));
        const linkedItems = Array.isArray(linkedSale.items) ? linkedSale.items : Array.isArray(linkedSale.detalles) ? linkedSale.detalles : [];
        if (linkedItems.length) {
          const wholesale = /WHOLESALE|MAYOREO|MAYORISTA/.test(token(first(raw, ['priceType', 'price_type', 'tarifa']) ?? first(input, ['priceType', 'price_type', 'tarifa', 'buyerType'])));
          expectedItems = linkedItems.map(item => ({ ...item, estimatedUnitPrice: first(item, wholesale ? ['wholesalePrice', 'precio2', 'unitPrice', 'precioUnitario'] : ['retailPrice', 'precio1', 'unitPrice', 'precioUnitario']) }));
        }
      }
      const foundItems = orderItemRowsByKey.get(source.sourceRecordKey) || [];
      if (expectedItems.length === foundItems.length) for (let index = 0; index < expectedItems.length; index++) {
        const item = expectedItems[index], found = foundItems[index];
        const sourceProductId = identity(first(item, ['productId', 'product_id', 'productoId', 'producto_id', 'id']));
        const targetProductId = sourceProductId ? productLinksForDetails.get('products:' + sourceProductId) : null;
        compare('saleOrders', source.sourceRecordKey + '.items[' + index + '].productId', targetProductId || null, String(found.productId), 'El producto relacionado con la orden no coincide.');
        const expectedQuantity = scaled(first(item, ['quantity', 'cantidad', 'qty']), 3);
        if (expectedQuantity !== null) compare('saleOrders', source.sourceRecordKey + '.items[' + index + '].quantity', formatScaled(expectedQuantity, 3), String(found.quantity), 'La cantidad del producto en la orden no coincide.');
        const itemPrice = first(item, ['estimatedUnitPrice', 'unitPrice', 'price', 'precioUnitario', 'priceAtOrder', 'retailPrice', 'wholesalePrice', 'precio']);
        const itemSubtotal = first(item, ['estimatedSubtotal', 'subtotal', 'importe']);
        const snapshotExpected = itemPrice !== undefined || itemSubtotal !== undefined || expectedStatus === 'COMPLETED';
        compare('saleOrders', source.sourceRecordKey + '.items[' + index + '].priceSnapshotAvailable', snapshotExpected, Boolean(found.priceSnapshotAvailable), 'La disponibilidad del precio histórico no coincide con el paquete.');
        if (itemPrice !== undefined) {
          const expectedPrice = scaled(itemPrice, 2);
          if (expectedPrice !== null) compare('saleOrders', source.sourceRecordKey + '.items[' + index + '].unitPrice', formatScaled(expectedPrice, 2), found.unitPrice === null ? null : String(found.unitPrice), 'El precio original del producto en la orden no coincide.');
        }
        if (itemSubtotal !== undefined) {
          const expectedLineSubtotal = scaled(itemSubtotal, 2);
          if (expectedLineSubtotal !== null) compare('saleOrders', source.sourceRecordKey + '.items[' + index + '].subtotal', formatScaled(expectedLineSubtotal, 2), found.subtotal === null ? null : String(found.subtotal), 'El subtotal original del producto en la orden no coincide.');
        }
      }
    }

    const auditTarget = await firstRow('SELECT COUNT(*) AS count FROM migration_source_records r JOIN audit_logs a ON a.business_id=r.business_id AND a.id=r.target_record_id AND a.action=\'LOCAL_HISTORY\' WHERE r.business_id=? AND r.batch_id=? AND r.entity_type=\'auditLogs\' AND r.target_table=\'audit_logs\' AND r.record_status=\'PROJECTED\'', [businessId, batchId]);
    compare('auditLogs', 'recordCount', auditRows.length, Number(auditTarget.count), 'La cantidad de eventos de auditoría no coincide con el paquete.');

    const syncQueue = byEntity('syncQueue');
    const syncQueueArchived = syncQueue.filter(row => row.recordStatus === 'PROJECTED' && row.targetTable === 'migration_source_records' && row.targetRecordId === hash('archive-only-syncQueue:' + row.sourceRecordKey)).length;
    compare('syncQueue', 'archiveOnlyRecordCount', syncQueue.length, syncQueueArchived, 'La cola local debe conservarse íntegra solo para auditoría y nunca ejecutarse.');

    const sourceClientBalances = new Map();
    for (const sale of sales) {
      const clientId = identity(first(sale.payload, ['clientId', 'client_id', 'clienteId', 'cliente_id']));
      const saleKind = token(first(sale.payload, ['saleType', 'sale_type', 'tipoVenta', 'tipo', 'paymentMethod', 'medioPago', 'metodoPago']));
      const status = sourceStatus(first(sale.payload, ['status', 'estado']), first(sale.payload, ['cancelled', 'cancelado', 'anulado', 'anulada']) === true);
      if (!clientId || !/CREDIT|CREDITO|FIADO/.test(saleKind) || status !== 'POSTED') continue;
      const amount = scaled(first(sale.payload, ['total', 'totalVenta', 'montoTotal', 'importeTotal']), 2);
      if (amount !== null) sourceClientBalances.set(clientId, (sourceClientBalances.get(clientId) || 0n) + amount);
    }
    for (const payment of customerPayments) {
      const clientId = identity(first(payment.payload, ['clientId', 'client_id', 'clienteId', 'cliente_id', 'referenciaId']));
      const status = sourceStatus(first(payment.payload, ['status', 'estado']), first(payment.payload, ['cancelled', 'cancelado', 'anulado']) === true);
      // En el POS local, un abono pendiente de confirmación en Caja ya reduce
      // el saldo de la factura; conservarlo como histórico no debe reabrir esa deuda.
      if (!clientId || !['POSTED', 'PENDING'].includes(status)) continue;
      const amount = scaled(first(payment.payload, ['amount', 'monto', 'importe']), 2);
      if (amount !== null) sourceClientBalances.set(clientId, (sourceClientBalances.get(clientId) || 0n) - amount);
    }
    const clients = byEntity('clients');
    const sourceKeys = clients.map(row => row.sourceRecordKey);
    const [clientBalanceRows] = sourceKeys.length ? [await repo.rows(db, 'SELECT r.source_record_key AS sourceRecordKey,c.opening_balance+COALESCE((SELECT SUM(s.total) FROM sales s WHERE s.business_id=c.business_id AND s.client_id=c.id AND s.sale_type=\'CREDIT\' AND s.status=\'COMPLETED\'),0.00)-COALESCE((SELECT SUM(p.amount) FROM customer_payments p WHERE p.business_id=c.business_id AND p.client_id=c.id AND p.status=\'POSTED\'),0.00) AS debt FROM migration_source_records r JOIN clients c ON c.business_id=r.business_id AND c.id=r.target_record_id WHERE r.business_id=? AND r.batch_id=? AND r.entity_type=\'clients\' AND r.record_status=\'PROJECTED\'', [businessId, batchId])] : [[]];
    const targetClientBalances = new Map(clientBalanceRows.map(row => [row.sourceRecordKey, String(row.debt)]));
    for (const client of clients) {
      const localClientId = sourceIdFromKey(client.sourceRecordKey);
      const expectedFromLedger = scaled(first(client.payload, ['openingBalance', 'opening_balance']), 2) || 0n;
      const expectedDebt = expectedFromLedger + (sourceClientBalances.get(String(localClientId)) || 0n);
      const nonNegativeExpectedDebt = expectedDebt > 0n ? expectedDebt : 0n;
      const targetDebt = targetClientBalances.get(client.sourceRecordKey);
      if (targetDebt !== undefined) compare('clientBalances', client.sourceRecordKey, formatScaled(nonNegativeExpectedDebt, 2), targetDebt, 'El saldo del cliente no coincide con sus facturas y abonos históricos.');
      const sourceDebt = first(client.payload, ['debt', 'deuda', 'saldo', 'currentDebt']);
      if (sourceDebt !== undefined) compare('clientBalances', client.sourceRecordKey, String(formatScaled(nonNegativeExpectedDebt, 2)), String(formatScaled(scaled(sourceDebt, 2) ?? 0n, 2)), 'El saldo declarado por el POS local no coincide con el saldo derivado de su historial.');
    }

    const sourceSupplierBalances = new Map();
    const supplierResolutionByPurchase = new Map((sourcePackage?.data?.purchases || []).map(purchase => [
      identity(first(purchase, ['id', 'purchaseId', 'compraId', 'purchase_id', 'compra_id'])),
      identity(first(purchase, ['supplierId', 'supplier_id', 'proveedorId', 'proveedor_id']))
    ]).filter(([purchaseId, supplierId]) => purchaseId && supplierId));
    for (const purchase of purchases) {
      const localPurchaseId = sourceIdFromKey(purchase.sourceRecordKey);
      const supplierId = identity(first(purchase.payload, ['supplierId', 'supplier_id', 'proveedorId', 'proveedor_id'])) || supplierResolutionByPurchase.get(String(localPurchaseId));
      const type = token(first(purchase.payload, ['purchaseType', 'purchase_type', 'tipo']));
      const status = sourceStatus(first(purchase.payload, ['status', 'estado']), first(purchase.payload, ['cancelled', 'cancelado', 'anulado', 'anulada']) === true);
      if (!supplierId || !/CREDIT|CREDITO|FIADO/.test(type) || status !== 'POSTED') continue;
      const amount = scaled(first(purchase.payload, ['total', 'totalCompra', 'montoTotal', 'importeTotal']), 2);
      if (amount !== null) sourceSupplierBalances.set(supplierId, (sourceSupplierBalances.get(supplierId) || 0n) + amount);
    }
    for (const payment of supplierPayments) {
      const supplierId = identity(first(payment.payload, ['supplierId', 'supplier_id', 'proveedorId', 'proveedor_id', 'referenciaId']));
      const status = sourceStatus(first(payment.payload, ['status', 'estado']), first(payment.payload, ['cancelled', 'cancelado', 'anulado']) === true);
      // El saldo local descuenta los abonos pendientes; estos siguen sin crear
      // movimientos de caja porque la proyección es exclusivamente histórica.
      if (!supplierId || !['POSTED', 'PENDING'].includes(status)) continue;
      const amount = scaled(first(payment.payload, ['amount', 'monto', 'importe']), 2);
      if (amount !== null) sourceSupplierBalances.set(supplierId, (sourceSupplierBalances.get(supplierId) || 0n) - amount);
    }
    const suppliers = byEntity('suppliers');
    const [supplierBalanceRows] = suppliers.length ? [await repo.rows(db, 'SELECT r.source_record_key AS sourceRecordKey,COALESCE((SELECT SUM(p.total) FROM purchases p WHERE p.business_id=s.business_id AND p.supplier_id=s.id AND p.purchase_type=\'CREDIT\' AND p.status=\'COMPLETED\' AND p.is_historical=TRUE),0.00)-COALESCE((SELECT SUM(sp.amount) FROM supplier_payments sp JOIN purchases p ON p.business_id=sp.business_id AND p.id=sp.purchase_id WHERE sp.business_id=s.business_id AND sp.supplier_id=s.id AND p.purchase_type=\'CREDIT\' AND p.is_historical=TRUE AND sp.is_historical=TRUE AND sp.status IN (\'POSTED\',\'PENDING\')),0.00) AS debt FROM migration_source_records r JOIN suppliers s ON s.business_id=r.business_id AND s.id=r.target_record_id WHERE r.business_id=? AND r.batch_id=? AND r.entity_type=\'suppliers\' AND r.record_status=\'PROJECTED\'', [businessId, batchId])] : [[]];
    const targetSupplierBalances = new Map(supplierBalanceRows.map(row => [row.sourceRecordKey, String(row.debt)]));
    for (const supplier of suppliers) {
      const localSupplierId = sourceIdFromKey(supplier.sourceRecordKey);
      const expectedDebt = sourceSupplierBalances.get(String(localSupplierId)) || 0n;
      const targetDebt = targetSupplierBalances.get(supplier.sourceRecordKey);
      if (targetDebt !== undefined) compare('supplierBalances', supplier.sourceRecordKey, formatScaled(expectedDebt > 0n ? expectedDebt : 0n, 2), targetDebt, 'El saldo histórico del proveedor no coincide con sus compras y pagos.');
      const sourceDebt = first(supplier.payload, ['debt', 'deuda', 'saldo', 'currentDebt']);
      if (sourceDebt !== undefined) compare('supplierBalances', supplier.sourceRecordKey, String(formatScaled(expectedDebt > 0n ? expectedDebt : 0n, 2)), String(formatScaled(scaled(sourceDebt, 2) ?? 0n, 2)), 'El saldo declarado por el POS local no coincide con el saldo derivado de su historial.');
    }

    const operational = {
      sales: { source: sales.length, imported: Number(salesTarget.count), total: String(salesTarget.total) },
      purchases: { source: purchases.length, imported: Number(purchasesTarget.count), total: String(purchasesTarget.total) },
      customerPayments: { source: customerPayments.length, imported: Number(customerPaymentsTarget.count), total: String(customerPaymentsTarget.amount) },
      supplierPayments: { source: supplierPayments.length, imported: Number(supplierPaymentsTarget.count), total: String(supplierPaymentsTarget.amount) },
      expenses: { source: expenses.length, imported: Number(expensesTarget.count), total: String(expensesTarget.amount) },
      inventoryMovements: { source: inventory.length, imported: Number(inventoryTarget.count) + Number(zeroInventoryTarget.count), operationalMovements: Number(inventoryTarget.count), zeroQuantityEvents: Number(zeroInventoryTarget.count), quantity: String(inventoryTarget.quantity) },
      cashSessions: { source: sessions.length, imported: Number(sessionsTarget.count), openingAmount: String(sessionsTarget.openingAmount) },
      cashMovements: { source: cashMovements.length, imported: Number(cashMovementsTarget.count), amountIn: String(cashMovementsTarget.amountIn), amountOut: String(cashMovementsTarget.amountOut) },
      saleOrders: { source: orders.length, imported: Number(ordersTarget.count), sourceItems: orderItemCount, importedItems: Number(orderItemsTarget.count), total: String(ordersTarget.total) },
      auditLogs: { source: auditRows.length, imported: Number(auditTarget.count) },
      syncQueue: { source: syncQueue.length, archived: syncQueueArchived, executed: 0 }
    };
    return { differences, operational };
  }

  async function reconcile(db, businessId, batchId, sourceKey, manifest, records, issues) {
    const fresh = await loadRecords(db, businessId, batchId);
    const statusCounts = {};
    for (const row of fresh) statusCounts[row.recordStatus] = (statusCounts[row.recordStatus] || 0) + 1;
    const differences = [...issues];
    for (const row of fresh) {
      if (row.recordStatus !== 'PROJECTED' || row.pendingReason) {
        differences.push(difference(row, row.entityType, 'recordStatus', row.pendingReason || 'El registro todavía no está disponible en su módulo del POS.', 'PROJECTED', row.recordStatus));
      }
    }
    const [salesTotals] = await repo.rows(db, 'SELECT COUNT(*) AS count,COALESCE(SUM(s.total),0.00) AS total FROM migration_sales_references r JOIN sales s ON s.business_id=r.business_id AND s.id=r.sale_id WHERE r.business_id=? AND r.source_business_key=?', [businessId, sourceKey]);
    const [purchaseTotals] = await repo.rows(db, 'SELECT COUNT(*) AS count,COALESCE(SUM(p.total),0.00) AS total,COALESCE(SUM(CASE WHEN p.purchase_type=\'CREDIT\' AND p.status=\'COMPLETED\' THEN p.total ELSE 0 END),0.00) AS creditTotal FROM migration_purchase_references r JOIN purchases p ON p.business_id=r.business_id AND p.id=r.purchase_id WHERE r.business_id=? AND r.source_business_key=?', [businessId, sourceKey]);
    const expectedSales = records.filter(row => row.entityType === 'sales').reduce((sum, row) => sum + (scaled(first(row.payload, ['total', 'totalVenta', 'montoTotal', 'importeTotal']), 2) || 0n), 0n);
    const expectedPurchases = records.filter(row => row.entityType === 'purchases').reduce((sum, row) => sum + (scaled(first(row.payload, ['total', 'totalCompra', 'montoTotal', 'importeTotal']), 2) || 0n), 0n);
    const sourceSalesComplete = records.filter(row => row.entityType === 'sales').every(row => fresh.find(item => item.entityType === row.entityType && item.sourceRecordKey === row.sourceRecordKey)?.recordStatus === 'PROJECTED');
    const sourcePurchasesComplete = records.filter(row => row.entityType === 'purchases').every(row => fresh.find(item => item.entityType === row.entityType && item.sourceRecordKey === row.sourceRecordKey)?.recordStatus === 'PROJECTED');
    if (sourceSalesComplete && formatScaled(expectedSales, 2) !== String(salesTotals.total)) differences.push({ origin: batchId, module: 'sales', field: 'total', expected: formatScaled(expectedSales, 2), found: String(salesTotals.total), reason: 'El importe global de ventas no coincide.' });
    if (sourcePurchasesComplete && formatScaled(expectedPurchases, 2) !== String(purchaseTotals.total)) differences.push({ origin: batchId, module: 'purchases', field: 'total', expected: formatScaled(expectedPurchases, 2), found: String(purchaseTotals.total), reason: 'El importe global de compras no coincide.' });
    const [cashTotals] = await repo.rows(db, 'SELECT COUNT(*) AS sessions,COALESCE(SUM(CASE WHEN is_historical=TRUE THEN 1 ELSE 0 END),0) AS historicalSessions FROM cash_sessions WHERE business_id=?', [businessId]);
    const [historicTotals] = await repo.rows(db, 'SELECT (SELECT COUNT(*) FROM inventory_movements WHERE business_id=? AND is_historical=TRUE) AS inventoryMovements,(SELECT COUNT(*) FROM expenses WHERE business_id=? AND is_historical=TRUE) AS expenses,(SELECT COUNT(*) FROM supplier_payments WHERE business_id=? AND is_historical=TRUE) AS supplierPayments,(SELECT COUNT(*) FROM sale_orders WHERE business_id=? AND is_historical=TRUE) AS orders,(SELECT COUNT(*) FROM audit_logs WHERE business_id=? AND action=\'LOCAL_HISTORY\') AS auditLogs,(SELECT COUNT(*) FROM cash_movements WHERE business_id=? AND is_historical=TRUE) AS cashMovements', [businessId,businessId,businessId,businessId,businessId,businessId]);
    const operational = { sales: { source: Number(manifest.sourceCounts?.sales || 0), imported: Number(salesTotals.count), total: String(salesTotals.total) }, purchases: { source: Number(manifest.sourceCounts?.purchases || 0), imported: Number(purchaseTotals.count), total: String(purchaseTotals.total), creditTotal: String(purchaseTotals.creditTotal) }, cashSessions: { imported: Number(cashTotals.historicalSessions) }, ...Object.fromEntries(Object.entries(historicTotals).map(([key, value]) => [key, Number(value)])) };
    const unresolved = fresh.length !== Number(manifest.recordsExpected) || fresh.some(row => row.recordStatus !== 'PROJECTED' || row.pendingReason) || differences.length > 0 || Boolean(manifest.blockers?.length);
    const blockers = Array.isArray(manifest.blockers) ? [...manifest.blockers] : [];
    if (unresolved && !blockers.length) blockers.push('Hay información pendiente de importar o conciliar; el negocio permanece inactivo.');
    return { complete: false, fullMigrationComplete: false, stageMatched: differences.length === 0 && !unresolved, unresolved, recordsExpected: Number(manifest.recordsExpected), recordsArchived: fresh.length, recordStatuses: statusCounts, operational, differences, blockers };
  }

  async function projectWithLock(auth, businessId, batchId) {
    requireSystemAdmin(auth);
    validateIds(businessId, batchId);
    const { business, batch, manifest, sourceBusinessKey, stageResults } = await repo.transaction(async db => {
      await assertOperationalSchema(repo, db);
      return targetAndBatch(db, businessId, batchId, true);
    });
    const initialRecords = await loadRecords(repo.pool, businessId, batchId);
    const pkg = packageFromRecords(batch.sourceBusinessName, initialRecords, Number(batch.manifest?.packageVersion || 2));
    const sourcePackage = packageFromRecords(batch.sourceBusinessName, initialRecords, Number(batch.manifest?.packageVersion || 2), true);
    sourcePackage.data.purchases = resolvePurchaseSupplierIdentities(sourcePackage.data).purchases;
    const batchContext = authorizeMigrationBatch(batchId, sourceBusinessKey, true);
    const importResults = {};
    try {
      if (pkg.data.sales.length) importResults.sales = await salesMigration.migrate(auth, businessId, pkg, { batchContext, confirmDifferentSource: true });
      if (pkg.data.sales.length || pkg.data.abonos.some(row => !/PROVEEDOR/i.test(String(row.tipo || '')))) importResults.credit = await creditMigration.migrate(auth, businessId, pkg, { batchContext, confirmDifferentSource: true });
      if (pkg.data.purchases.length) {
        const supplierResolution = resolvePurchaseSupplierIdentities(pkg.data);
        pkg.data.purchases = supplierResolution.purchases;
        importResults.purchases = await purchasesMigration.migrate(auth, businessId, pkg, { batchContext, confirmDifferentSource: true });
        importResults.purchases.supplierResolution = supplierResolution.resolutions;
      }
    } catch (error) {
      await repo.rows(repo.pool, "UPDATE migration_import_batches SET status='BLOCKED',current_stage='OPERATIONAL_IMPORT_REVIEW',updated_at=UTC_TIMESTAMP(3) WHERE business_id=? AND id=? AND status<>'COMPLETED'", [businessId, batchId]);
      throw error;
    }
    await repo.transaction(async db => linkImporterResults(db, businessId, batchId, sourceBusinessKey, initialRecords));
    const provenanceDifferences = await repo.transaction(async db => enrichHistoricalProvenance(db, businessId, await loadRecords(db, businessId, batchId)));
    const recordsAfterImport = await loadRecords(repo.pool, businessId, batchId);
    const [user] = await repo.rows(repo.pool, 'SELECT id FROM users WHERE business_id=? AND active=TRUE ORDER BY CASE WHEN role=\'ADMIN\' THEN 0 ELSE 1 END,id LIMIT 1', [businessId]);
    if (!user) throw httpError(409, 'MIGRATION_TARGET_USER_REQUIRED');
    const auxiliary = await projectArchivedAuxiliary(auth, businessId, batchId, sourceBusinessKey, recordsAfterImport, String(user.id));
    auxiliary.issues.push(...provenanceDifferences);
    const reconciliation = await repo.transaction(async db => {
      const freshRecords = await loadRecords(db, businessId, batchId, true);
      const result = await reconcile(db, businessId, batchId, sourceBusinessKey, manifest, freshRecords, auxiliary.issues);
      const moduleReconciliation = await reconcileOperationalModules(db, businessId, batchId, sourceBusinessKey, freshRecords, sourcePackage);
      result.differences.push(...moduleReconciliation.differences);
      result.operational = moduleReconciliation.operational;
      result.unresolved = result.unresolved || moduleReconciliation.differences.length > 0;
      result.stageMatched = result.differences.length === 0 && !result.unresolved;
      if (result.unresolved && !result.blockers.length) result.blockers = ['Hay información pendiente de importar o conciliar; el negocio permanece inactivo.'];
      const stageResultsNext = { ...stageResults, operational: { ranAt: new Date().toISOString(), importResults, changes: auxiliary.changes, reconciliation: result } };
      const complete = result.stageMatched && !result.unresolved;
      const status = complete ? 'COMPLETED' : result.unresolved ? 'BLOCKED' : 'PROJECTING';
      await repo.rows(db, 'UPDATE migration_import_batches SET status=?,current_stage=?,stage_results=?,completed_at=?,updated_at=UTC_TIMESTAMP(3) WHERE business_id=? AND id=?', [status, complete ? 'RECONCILED' : 'OPERATIONAL_HISTORY', JSON.stringify(stageResultsNext), complete ? new Date() : null, businessId, batchId]);
      if (complete) await repo.rows(db, 'UPDATE business_migration_controls SET state=\'COMPLETE\',completed_at=UTC_TIMESTAMP(3) WHERE business_id=? AND state=\'PENDING\' AND batch_id=? AND source_business_key=?', [businessId, batchId, sourceBusinessKey]);
      await repo.rows(db, 'INSERT INTO audit_logs (business_id,user_id,action,entity,entity_id,details,created_at) VALUES (?,NULL,\'LOCAL_MIGRATION_OPERATIONAL_STAGE\',?,?,?,UTC_TIMESTAMP(3))', [businessId, 'migration_import_batches', batchId, JSON.stringify({ actorUserId: String(auth.user_id), actorBusinessId: String(auth.business_id), batchId, changes: auxiliary.changes, differences: result.differences.length, complete })]);
      return { ...result, complete, fullMigrationComplete: complete, stage: 'OPERATIONAL_AND_HISTORICAL', importResults, changes: auxiliary.changes, businessStatus: business.status, migrationState: complete ? 'COMPLETE' : 'PENDING', businessActivated: false };
    });
    return { ok: true, businessId, batchId, businessStatus: business.status, reconciliation };
  }

  async function project(auth, businessId, batchId) {
    requireSystemAdmin(auth);
    validateIds(businessId, batchId);
    if (!migrationProjection || typeof migrationProjection.projectCatalog !== 'function') throw httpError(503, 'MIGRATION_CATALOG_RECONCILIATION_REQUIRED');
    const catalog = await migrationProjection.projectCatalog(auth, businessId, batchId);
    if (!catalog.reconciliation?.stageMatched) throw httpError(409, 'MIGRATION_CATALOG_RECONCILIATION_REQUIRED');
    const connection = await repo.pool.getConnection();
    const lockName = 'POS-MIG:' + businessId + ':' + hash(batchId).slice(0, 32);
    let acquired = false;
    try {
      const [rows] = await connection.query('SELECT GET_LOCK(?,0) AS acquired', [lockName]);
      acquired = Number(rows[0]?.acquired) === 1;
      if (!acquired) throw httpError(409, 'MIGRATION_STAGE_IN_PROGRESS');
      return await projectWithLock(auth, businessId, batchId);
    } finally {
      if (acquired) {
        try { await connection.query('SELECT RELEASE_LOCK(?)', [lockName]); } catch { /* The connection close releases the advisory lock. */ }
      }
      connection.release();
    }
  }

  return { project };
}

module.exports = { createSystemAdminMigrationOperations, dateSql, scaled, formatScaled, sourceIdFromKey, resolvePurchaseSupplierIdentities, assertOperationalSchema, OPERATIONAL_SCHEMA_014_REQUIRED, ZERO_INVENTORY_SCHEMA_015_REQUIRED, ORDER_PRICE_SNAPSHOT_SCHEMA_016_REQUIRED };
