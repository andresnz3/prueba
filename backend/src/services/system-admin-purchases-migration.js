'use strict';

const { httpError } = require('../middleware/errors');
const {
  packageForPurchasesImport, normalizePurchase, normalizeName, fingerprintPurchase,
  sourcePurchaseKey, formatMoney, formatQuantity, labelPurchase
} = require('./system-admin-purchases-migration-values');
const { migrationBatchContext, applySourceBusinessKey } = require('./migration-batch-capability');

const MAX_WARNING_DETAILS = 50;

function detailsObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function matchesBasicImport(rows, imported) {
  return rows.some(row => {
    const details = detailsObject(row.details);
    if (!details || normalizeName(details.sourceBusinessName) !== normalizeName(imported.sourceBusinessName)) return false;
    return imported.exportedAt === null || details.packageExportedAt === imported.exportedAt;
  });
}

function indexTargets(rows, barcodeField = 'barcode') {
  const barcodes = new Map();
  const names = new Map();
  const exactNames = new Map();
  for (const row of rows) {
    const barcode = normalizeName(row[barcodeField]);
    if (barcode) {
      const matches = barcodes.get(barcode) || [];
      matches.push(row);
      barcodes.set(barcode, matches);
    }
    const name = normalizeName(row.name);
    if (name) {
      const matches = names.get(name) || [];
      matches.push(row);
      names.set(name, matches);
    }
    if (typeof row.name === 'string' && row.name.trim()) {
      const exact = row.name.trim();
      const matches = exactNames.get(exact) || [];
      matches.push(row);
      exactNames.set(exact, matches);
    }
  }
  return { barcodes, names, exactNames };
}

function resolveSupplier(purchase, indexes) {
  const exact = typeof purchase.supplierName === 'string' ? indexes.exactNames?.get(purchase.supplierName.trim()) || [] : [];
  if (exact.length === 1) return { supplier: exact[0], evidence: 'exact source name' };
  if (exact.length > 1) return { error: 'proveedor ambiguo (' + purchase.supplierName + ')' };
  const key = normalizeName(purchase.supplierName);
  const matches = key ? indexes.names.get(key) || [] : [];
  if (!key || matches.length === 0) return { error: 'proveedor sin correspondencia (' + (purchase.supplierName || 'sin nombre') + ')' };
  if (matches.length > 1) return { error: 'proveedor ambiguo (' + purchase.supplierName + ')' };
  return { supplier: matches[0] };
}

function resolveProduct(item, indexes) {
  const barcode = normalizeName(item.barcode);
  const key = barcode || normalizeName(item.name);
  const matches = barcode ? (indexes.barcodes.get(key) || []) : (indexes.names.get(key) || []);
  if (!key) return { error: 'detalle sin código ni nombre de producto' };
  if (matches.length === 0) return { error: 'producto sin correspondencia (' + (item.barcode || item.name) + ')' };
  if (matches.length > 1) return { error: 'producto ambiguo (' + (item.barcode || item.name) + ')' };
  return { product: matches[0] };
}

function appendWarning(state, message) {
  state.warningCount++;
  if (state.warnings.length < MAX_WARNING_DETAILS) state.warnings.push(message);
}

function warningResult(state) {
  if (state.warningCount > state.warnings.length) state.warnings.push('Se omitieron ' + (state.warningCount - state.warnings.length) + ' advertencias adicionales.');
  return state.warnings;
}

function createDiagnostics() {
  return {
    suppliersUnmatched: 0,
    suppliersAmbiguous: 0,
    productsUnmatched: 0,
    productsAmbiguous: 0,
    duplicateInvoices: 0,
    missingCosts: 0,
    inconsistentTotals: 0,
    unsupportedStatuses: 0
  };
}

function countNormalizationIssue(diagnostics, message) {
  if (/sin costo histórico|costo histórico faltante/.test(message)) diagnostics.missingCosts++;
  if (/total histórico|subtotal histórico|descuento general|impuesto general|importes de compra|subtotal - descuento/.test(message)) diagnostics.inconsistentTotals++;
  if (/estado original no compatible|tipo de compra no reconocido/.test(message)) diagnostics.unsupportedStatuses++;
}

function countMappingIssue(diagnostics, message) {
  if (/proveedor sin correspondencia/.test(message)) diagnostics.suppliersUnmatched++;
  if (/proveedor ambiguo/.test(message)) diagnostics.suppliersAmbiguous++;
  if (/producto sin correspondencia/.test(message)) diagnostics.productsUnmatched++;
  if (/producto ambiguo/.test(message)) diagnostics.productsAmbiguous++;
}

function createSystemAdminPurchasesMigration({ repo, requireSystemAdmin }) {
  async function assertTarget(db, targetBusinessId, lock = false, batchContext = null) {
    const rows = await repo.rows(db,
      'SELECT b.id,b.name,b.status,c.state AS migrationState,c.batch_id AS batchId,c.source_business_key AS sourceBusinessKey FROM businesses b LEFT JOIN business_migration_controls c ON c.business_id=b.id WHERE b.id = ?' + (lock ? ' FOR UPDATE' : ''), [targetBusinessId]);
    const business = rows[0];
    if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
    if (batchContext) {
      if (business.status !== 'INACTIVE' || business.migrationState !== 'PENDING' || String(business.batchId) !== batchContext.batchId || business.sourceBusinessKey !== batchContext.sourceBusinessKey) throw httpError(409, 'MIGRATION_TARGET_REQUIRED');
    } else if (business.status !== 'ACTIVE') throw httpError(409, 'MIGRATION_TARGET_INACTIVE');
    return business;
  }

  async function schemaAvailable(db) {
    const [tables, columns] = await Promise.all([
      repo.rows(db,
        "SELECT TABLE_NAME AS tableName FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'migration_purchase_references'", []),
      repo.rows(db,
        "SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND ((TABLE_NAME = 'purchases' AND COLUMN_NAME IN ('is_historical', 'discount', 'notes')) OR (TABLE_NAME = 'purchase_items' AND COLUMN_NAME IN ('discount', 'tax'))) ", [])
    ]);
    const available = new Set(columns.map(row => String(row.tableName) + '.' + String(row.columnName)));
    return tables.length === 1 && [
      'purchases.is_historical', 'purchases.discount', 'purchases.notes',
      'purchase_items.discount', 'purchase_items.tax'
    ].every(name => available.has(name));
  }

  async function hasBasicImport(db, targetBusinessId, imported) {
    const audits = await repo.rows(db,
      "SELECT details FROM audit_logs WHERE business_id = ? AND action = 'MIGRATION_BASIC_IMPORT' ORDER BY id DESC LIMIT 100",
      [targetBusinessId]);
    return matchesBasicImport(audits, imported);
  }

  async function loadMappings(db, targetBusinessId, lock = false, batchContext = null) {
    const suffix = lock ? ' FOR UPDATE' : '';
    const [products, suppliers, users] = await Promise.all([
      repo.rows(db, 'SELECT id, barcode, name FROM products WHERE business_id = ?' + suffix, [targetBusinessId]),
      repo.rows(db, 'SELECT id, name FROM suppliers WHERE business_id = ?' + suffix, [targetBusinessId]),
      repo.rows(db, "SELECT id, full_name FROM users WHERE business_id = ? AND active = TRUE ORDER BY CASE WHEN role = 'ADMIN' THEN 0 ELSE 1 END, id LIMIT 1" + (lock ? ' FOR UPDATE' : ''), [targetBusinessId])
    ]);
    const suppliersBySourceId = new Map();
    if (batchContext?.batchId) {
      const refs = await repo.rows(db,
        "SELECT source_record_key AS sourceRecordKey,target_record_id AS targetRecordId FROM migration_source_records WHERE business_id=? AND batch_id=? AND entity_type='suppliers' AND target_table='suppliers' AND record_status='PROJECTED'",
        [targetBusinessId, batchContext.batchId]);
      for (const ref of refs) {
        const match = /^id:([^:]+)$/.exec(String(ref.sourceRecordKey || ''));
        const target = suppliers.find(row => String(row.id) === String(ref.targetRecordId));
        if (match && target) suppliersBySourceId.set(match[1], { ...target, id: String(target.id) });
      }
    }
    return {
      products: indexTargets(products.map(row => ({ ...row, id: String(row.id) }))),
      suppliers: indexTargets(suppliers.map(row => ({ ...row, id: String(row.id) })), ''),
      suppliersBySourceId,
      user: users[0] || null
    };
  }

  async function existingReferences(db, targetBusinessId, imported) {
    const rows = await repo.rows(db,
      'SELECT source_purchase_key AS sourcePurchaseKey FROM migration_purchase_references WHERE business_id = ? AND source_business_key = ? FOR UPDATE',
      [targetBusinessId, imported.sourceBusinessKey]);
    return new Set(rows.map(row => String(row.sourcePurchaseKey)));
  }

  async function existingInvoices(db, targetBusinessId) {
    const rows = await repo.rows(db,
      'SELECT supplier_name AS supplierName, invoice_number AS invoiceNumber FROM purchases WHERE business_id = ? FOR UPDATE',
      [targetBusinessId]);
    return new Set(rows.map(row => normalizeName(row.supplierName) + '\n' + normalizeName(row.invoiceNumber)));
  }

  function preparePurchase(raw, index, imported, mappings, state) {
    const purchase = normalizePurchase(raw, index, imported);
    const label = purchase.error ? 'compra #' + (index + 1) : labelPurchase(purchase, index);
    if (purchase.error) {
      countNormalizationIssue(state.diagnostics, purchase.error);
      appendWarning(state, 'Compra ' + label + ': ' + purchase.error + '; se omitirá completa.');
      return null;
    }
    const sourceMappedSupplier = purchase.supplierId ? mappings.suppliersBySourceId?.get(String(purchase.supplierId)) : null;
    const supplierResult = sourceMappedSupplier
      ? normalizeName(sourceMappedSupplier.name) === normalizeName(purchase.supplierName)
        ? { supplier: sourceMappedSupplier, evidence: 'source relationship' }
        : { error: 'el proveedor relacionado no coincide con el nombre original (' + purchase.supplierName + ')' }
      : resolveSupplier(purchase, mappings.suppliers);
    if (supplierResult.error) {
      countMappingIssue(state.diagnostics, supplierResult.error);
      appendWarning(state, 'Compra ' + label + ': ' + supplierResult.error + '; se omitirá completa.');
      return null;
    }
    const mappedItems = [];
    for (let line = 0; line < purchase.items.length; line++) {
      const item = purchase.items[line];
      const productResult = resolveProduct(item, mappings.products);
      if (productResult.error) {
        countMappingIssue(state.diagnostics, productResult.error);
        appendWarning(state, 'Compra ' + label + ': ' + productResult.error + '; se omitirá completa.');
        return null;
      }
      mappedItems.push({
        productId: String(productResult.product.id),
        productName: item.name || productResult.product.name,
        quantity: item.quantity,
        unitCost: item.unitCost,
        subtotal: item.subtotal,
        discount: item.discount,
        tax: item.tax,
        total: item.total
      });
    }
    purchase.items = mappedItems;
    purchase.supplierId = String(supplierResult.supplier.id);
    purchase.supplierName = supplierResult.supplier.name;
    purchase.fingerprint = fingerprintPurchase(purchase, purchase.supplierId);
    return purchase;
  }

  async function assess(db, targetBusinessId, imported, options = {}) {
    const state = { warnings: [], warningCount: 0, diagnostics: createDiagnostics() };
    const [basicReady, schemaReady] = await Promise.all([
      options.batchContext ? Promise.resolve(options.batchContext.catalogReady === true) : hasBasicImport(db, targetBusinessId, imported),
      schemaAvailable(db)
    ]);
    const mappings = await loadMappings(db, targetBusinessId, options.lock === true, options.batchContext || null);
    const eligible = basicReady && schemaReady && Boolean(mappings.user);
    if (!basicReady) appendWarning(state, 'Primero completa la migración básica de productos y proveedores para este paquete.');
    if (!schemaReady) appendWarning(state, 'Falta aplicar la migración SQL 009 para referencias y aislamiento de compras históricas.');
    if (!mappings.user) appendWarning(state, 'El negocio destino no tiene un usuario activo para registrar estas compras.');

    const existing = options.readReferences && schemaReady ? await existingReferences(db, targetBusinessId, imported) : new Set();
    const invoices = options.readReferences ? await existingInvoices(db, targetBusinessId) : new Set();
    const candidates = [];
    let invalidCount = 0;
    for (let index = 0; index < imported.purchases.length; index++) {
      const purchase = preparePurchase(imported.purchases[index], index, imported, mappings, state);
      if (!purchase) { invalidCount++; continue; }
      candidates.push({ purchase, index });
    }

    const invoiceCounts = new Map();
    for (const { purchase } of candidates) {
      const key = normalizeName(purchase.supplierName) + '\n' + normalizeName(purchase.invoice);
      invoiceCounts.set(key, (invoiceCounts.get(key) || 0) + 1);
    }
    const duplicatePackageInvoices = new Set([...invoiceCounts].filter(([, count]) => count > 1).map(([key]) => key));
    const prepared = [];
    const seen = new Set();
    const seenInvoices = new Set();
    let skipped = invalidCount;
    for (const { purchase, index } of candidates) {
      const fingerprint = purchase.fingerprint;
      const sourceKey = sourcePurchaseKey(purchase, fingerprint);
      purchase.sourcePurchaseKey = sourceKey;
      const label = labelPurchase(purchase, index);
      if (existing.has(sourceKey) || seen.has(sourceKey)) {
        appendWarning(state, 'Compra ' + label + ': referencia local ya migrada o repetida; se omitirá.');
        skipped++;
        continue;
      }
      seen.add(sourceKey);
      const invoiceKey = normalizeName(purchase.supplierName) + '\n' + normalizeName(purchase.invoice);
      if (duplicatePackageInvoices.has(invoiceKey) || seenInvoices.has(invoiceKey) || invoices.has(invoiceKey)) {
        state.diagnostics.duplicateInvoices++;
        appendWarning(state, 'Compra ' + label + ': factura duplicada para el proveedor relacionado; se omitirá.');
        skipped++;
        continue;
      }
      seenInvoices.add(invoiceKey);
      if (eligible) prepared.push(purchase);
    }
    if (!eligible) skipped = imported.purchases.length;
    return {
      eligible,
      gates: { basic: basicReady, schema: schemaReady, targetUser: Boolean(mappings.user) },
      counts: { detected: imported.purchases.length, couldMigrate: prepared.length, toSkip: skipped },
      diagnostics: state.diagnostics,
      warnings: warningResult(state),
      mappings,
      prepared,
      source: imported
    };
  }

  async function preview(auth, targetBusinessId, packageValue) {
    requireSystemAdmin(auth);
    if (typeof targetBusinessId !== 'string' || !/^[1-9]\d{0,19}$/.test(targetBusinessId)) throw httpError(400, 'INVALID_INPUT');
    const imported = packageForPurchasesImport(packageValue);
    const business = await assertTarget(repo.pool, targetBusinessId);
    const result = await assess(repo.pool, targetBusinessId, imported, { readReferences: true });
    return {
      ok: true,
      eligible: result.eligible,
      sourceBusinessName: imported.sourceBusinessName,
      targetBusinessName: business.name,
      gates: result.gates,
      purchases: result.counts,
      diagnostics: result.diagnostics,
      warnings: result.warnings
    };
  }

  async function migrate(auth, targetBusinessId, packageValue, options = {}) {
    requireSystemAdmin(auth);
    if (typeof targetBusinessId !== 'string' || !/^[1-9]\d{0,19}$/.test(targetBusinessId)) throw httpError(400, 'INVALID_INPUT');
    const batchContext = migrationBatchContext(options);
    const imported = applySourceBusinessKey(packageForPurchasesImport(packageValue), batchContext);
    if (!await schemaAvailable(repo.pool)) throw httpError(503, 'MIGRATION_PURCHASES_SCHEMA_REQUIRED');

    return repo.transaction(async db => {
      const business = await assertTarget(db, targetBusinessId, true, batchContext);
      const result = await assess(db, targetBusinessId, imported, { readReferences: true, lock: true, batchContext });
      if (!result.gates.schema) throw httpError(503, 'MIGRATION_PURCHASES_SCHEMA_REQUIRED');
      if (!result.gates.basic) throw httpError(409, 'MIGRATION_BASIC_REQUIRED');
      if (!result.gates.targetUser) throw httpError(409, 'MIGRATION_TARGET_USER_REQUIRED');

      const created = { purchases: 0 };
      const skipped = { purchases: result.counts.toSkip };
      for (const purchase of result.prepared) {
        const source = imported.purchases[purchase.sourceIndex] || {};
        const inserted = batchContext
          ? await repo.rows(db,
            'INSERT INTO purchases (business_id, user_id, supplier_id, supplier_name, invoice_number, purchase_type, subtotal, discount, tax, total, due_at, status, cancelled_at, cancelled_by, cancel_reason, notes, is_historical, source_actor, source_cancelled_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, TRUE, ?, ?, ?)',
            [targetBusinessId, String(result.mappings.user.id), purchase.supplierId, purchase.supplierName, purchase.invoice,
              purchase.purchaseType, formatMoney(purchase.subtotal), formatMoney(purchase.discount), formatMoney(purchase.tax), formatMoney(purchase.total),
              purchase.dueAt, purchase.status, purchase.cancelledAt, purchase.cancelReason, purchase.notes,
              typeof source.__sourceActor === 'string' ? source.__sourceActor.slice(0, 180) : null,
              typeof source.__sourceCancelledBy === 'string' ? source.__sourceCancelledBy.slice(0, 180) : null, purchase.createdAt])
          : await repo.rows(db,
            'INSERT INTO purchases (business_id, user_id, supplier_id, supplier_name, invoice_number, purchase_type, subtotal, discount, tax, total, due_at, status, cancelled_at, cancelled_by, cancel_reason, notes, is_historical, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, TRUE, ?)',
            [targetBusinessId, String(result.mappings.user.id), purchase.supplierId, purchase.supplierName, purchase.invoice,
              purchase.purchaseType, formatMoney(purchase.subtotal), formatMoney(purchase.discount), formatMoney(purchase.tax), formatMoney(purchase.total),
              purchase.dueAt, purchase.status, purchase.cancelledAt, purchase.cancelReason, purchase.notes, purchase.createdAt]);
        const purchaseId = String(inserted.insertId);
        for (const item of purchase.items) {
          await repo.rows(db,
            'INSERT INTO purchase_items (business_id, purchase_id, product_id, product_name, quantity, unit_cost, subtotal, discount, tax, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [targetBusinessId, purchaseId, item.productId, item.productName, formatQuantity(item.quantity), formatMoney(item.unitCost),
              formatMoney(item.subtotal), formatMoney(item.discount), formatMoney(item.tax), formatMoney(item.total)]);
        }
        await repo.rows(db,
          'INSERT INTO migration_purchase_references (business_id, source_business_key, source_purchase_key, source_purchase_id, fingerprint, purchase_id, created_at) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))',
          [targetBusinessId, imported.sourceBusinessKey, purchase.sourcePurchaseKey, purchase.localPurchaseId, purchase.fingerprint, purchaseId]);
        created.purchases++;
      }

      const warnings = result.warnings;
      const summary = { created, skipped, diagnostics: result.diagnostics };
      const auditDetails = {
        actor: { userId: String(auth.user_id), username: auth.username, role: auth.role, businessId: String(auth.business_id) },
        targetBusinessId,
        targetBusinessName: business.name,
        sourceBusinessName: imported.sourceBusinessName,
        sourceBusinessId: imported.sourceBusinessId,
        packageExportedAt: imported.exportedAt,
        summary,
        warnings
      };
      await repo.rows(db,
        'INSERT INTO audit_logs (business_id, user_id, action, entity, entity_id, details, created_at) VALUES (?, NULL, ?, ?, ?, ?, UTC_TIMESTAMP(3))',
        [targetBusinessId, 'MIGRATION_PURCHASES_IMPORT', 'businesses', targetBusinessId, JSON.stringify(auditDetails)]);
      return { ok: true, created, skipped, diagnostics: result.diagnostics, warnings };
    });
  }

  return { preview, migrate };
}

module.exports = { createSystemAdminPurchasesMigration, matchesBasicImport, resolveSupplier, resolveProduct };
