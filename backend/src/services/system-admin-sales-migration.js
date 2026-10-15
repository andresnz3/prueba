'use strict';

const { httpError } = require('../middleware/errors');
const {
  packageForSalesImport, normalizeSale, normalizeName, fingerprintSale, sourceSaleKey,
  migrationInvoice, formatMoney, formatQuantity, formatRate, labelSale
} = require('./system-admin-sales-migration-values');

const MAX_WARNING_DETAILS = 50;

function detailsObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function matchesPriorImport(rows, imported, requireSameExport = true) {
  return rows.some(row => {
    const details = detailsObject(row.details);
    if (!details || normalizeName(details.sourceBusinessName) !== normalizeName(imported.sourceBusinessName)) return false;
    return !requireSameExport || imported.exportedAt === null || details.packageExportedAt === imported.exportedAt;
  });
}

function indexTargets(rows, barcodeField = 'barcode') {
  const barcodes = new Map();
  const names = new Map();
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
  }
  return { barcodes, names };
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

function resolveClient(sale, indexes) {
  if (!sale.clientReference) return { client: null };
  const key = normalizeName(sale.clientReference);
  const matches = indexes.names.get(key) || [];
  if (!key || matches.length === 0) return { error: 'cliente sin correspondencia (' + sale.clientReference + ')' };
  if (matches.length > 1) return { error: 'cliente ambiguo (' + sale.clientReference + ')' };
  return { client: matches[0] };
}

function appendWarning(state, message) {
  state.warningCount++;
  if (state.warnings.length < MAX_WARNING_DETAILS) state.warnings.push(message);
}

function warningResult(state) {
  if (state.warningCount > state.warnings.length) state.warnings.push('Se omitieron ' + (state.warningCount - state.warnings.length) + ' advertencias adicionales.');
  return state.warnings;
}

function toCents(value) {
  if (value === null || value === undefined) return 0n;
  const text = String(value);
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return 0n;
  return BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0') || '0');
}

function formatPercent(value) {
  return String(value ?? '0.0000');
}

function createSystemAdminSalesMigration({ repo, requireSystemAdmin }) {
  async function assertTarget(db, targetBusinessId, lock = false) {
    const rows = await repo.rows(db,
      'SELECT id, name, status FROM businesses WHERE id = ?' + (lock ? ' FOR UPDATE' : ''),
      [targetBusinessId]);
    const business = rows[0];
    if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
    if (business.status !== 'ACTIVE') throw httpError(409, 'MIGRATION_TARGET_INACTIVE');
    return business;
  }

  async function schemaAvailable(db) {
    const tables = await repo.rows(db,
      "SELECT TABLE_NAME AS tableName FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'migration_sales_references'",
      []);
    return tables.length === 1;
  }

  async function hasPriorStage(db, targetBusinessId, action, imported, requireSameExport = true) {
    const audits = await repo.rows(db,
      'SELECT details FROM audit_logs WHERE business_id = ? AND action = ? ORDER BY id DESC LIMIT 100',
      [targetBusinessId, action]);
    return matchesPriorImport(audits, imported, requireSameExport);
  }

  async function loadMappings(db, targetBusinessId) {
    const [products, clients, users] = await Promise.all([
      repo.rows(db, 'SELECT id, barcode, name, cost, tax_rate FROM products WHERE business_id = ?', [targetBusinessId]),
      repo.rows(db, 'SELECT id, name FROM clients WHERE business_id = ?', [targetBusinessId]),
      repo.rows(db, "SELECT id, full_name FROM users WHERE business_id = ? AND active = TRUE ORDER BY CASE WHEN role = 'ADMIN' THEN 0 ELSE 1 END, id LIMIT 1", [targetBusinessId])
    ]);
    return {
      products: indexTargets(products.map(row => ({ ...row, id: String(row.id), costCents: toCents(row.cost) }))),
      clients: indexTargets(clients.map(row => ({ ...row, id: String(row.id) })), ''),
      user: users[0] || null
    };
  }

  function prepareSale(raw, index, imported, mappings, state, fingerprintOccurrences) {
    const sale = normalizeSale(raw, index, imported);
    const label = sale.error ? 'venta #' + (index + 1) : labelSale(sale, index);
    if (sale.error) {
      appendWarning(state, 'Venta ' + label + ': ' + sale.error + '; se omitirá.');
      return null;
    }
    if (sale.saleType === 'CREDIT' || sale.paymentMethod === 'CREDIT') {
      appendWarning(state, 'Venta ' + label + ': venta a crédito omitida porque importarla podría alterar saldos operativos; requiere una decisión explícita.');
      return null;
    }
    const clientResult = resolveClient(sale, mappings.clients);
    if (clientResult.error) {
      appendWarning(state, 'Venta ' + label + ': ' + clientResult.error + '; se omitirá.');
      return null;
    }
    sale.clientId = clientResult.client ? String(clientResult.client.id) : null;

    const mappedItems = [];
    for (let line = 0; line < sale.items.length; line++) {
      const item = sale.items[line];
      const productResult = resolveProduct(item, mappings.products);
      if (productResult.error) {
        appendWarning(state, 'Venta ' + label + ': ' + productResult.error + '; se omitirá completa.');
        return null;
      }
      const product = productResult.product;
      mappedItems.push({
        productId: String(product.id),
        productName: item.name || product.name,
        barcode: item.barcode || product.barcode || null,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        taxRate: item.taxRate ?? rateFromTarget(product.tax_rate),
        discount: item.discount,
        subtotal: item.subtotal,
        total: item.total,
        cost: item.costCents ?? BigInt(product.costCents || 0)
      });
    }
    sale.items = mappedItems;
    sale.fingerprint = fingerprintSale(sale, sale.clientId);
    const occurrence = fingerprintOccurrences.get(sale.fingerprint) || 0;
    fingerprintOccurrences.set(sale.fingerprint, occurrence + 1);
    sale.sourceSaleKey = sourceSaleKey(sale, sale.fingerprint, occurrence);
    return sale;
  }

  function rateFromTarget(value) {
    const match = /^(\d{1,3})(?:\.(\d{1,4}))?$/.exec(String(value ?? '0'));
    if (!match) return 0n;
    return BigInt(match[1]) * 10000n + BigInt((match[2] || '').padEnd(4, '0') || '0');
  }

  async function existingReferences(db, targetBusinessId, imported) {
    const rows = await repo.rows(db,
      'SELECT source_sale_key AS sourceSaleKey FROM migration_sales_references WHERE business_id = ? AND source_business_key = ? FOR UPDATE',
      [targetBusinessId, imported.sourceBusinessKey]);
    return new Set(rows.map(row => String(row.sourceSaleKey)));
  }

  async function assess(db, targetBusinessId, imported, options = {}) {
    const state = { warnings: [], warningCount: 0 };
    const [basicReady, inventoryReady, schemaReady] = await Promise.all([
      hasPriorStage(db, targetBusinessId, 'MIGRATION_BASIC_IMPORT', imported),
      hasPriorStage(db, targetBusinessId, 'MIGRATION_INVENTORY_IMPORT', imported, false),
      schemaAvailable(db)
    ]);
    const mappings = await loadMappings(db, targetBusinessId);
    const eligible = basicReady && inventoryReady && schemaReady && Boolean(mappings.user);
    if (!basicReady) appendWarning(state, 'Primero completa la migración básica de productos y clientes para este paquete.');
    if (!inventoryReady) appendWarning(state, 'Completa la migración de inventario inicial o su revisión para este paquete antes de migrar ventas.');
    if (!schemaReady) appendWarning(state, 'Falta aplicar la migración SQL 008 de referencias de ventas históricas.');
    if (!mappings.user) appendWarning(state, 'El negocio destino no tiene un usuario activo para registrar estas ventas.');

    const existing = options.readReferences && schemaReady ? await existingReferences(db, targetBusinessId, imported) : new Set();
    const seen = new Set();
    const fingerprintOccurrences = new Map();
    let possible = 0;
    let skipped = 0;
    if (eligible) {
      for (let index = 0; index < imported.sales.length; index++) {
        const sale = prepareSale(imported.sales[index], index, imported, mappings, state, fingerprintOccurrences);
        if (!sale) { skipped++; continue; }
        if (existing.has(sale.sourceSaleKey) || seen.has(sale.sourceSaleKey)) {
          appendWarning(state, 'Venta ' + labelSale(sale, index) + ': referencia local ya migrada o repetida; se omitirá.');
          skipped++;
          continue;
        }
        seen.add(sale.sourceSaleKey);
        possible++;
      }
    } else skipped = imported.sales.length;

    return {
      eligible,
      gates: { basic: basicReady, inventory: inventoryReady, schema: schemaReady, targetUser: Boolean(mappings.user) },
      counts: { detected: imported.sales.length, couldMigrate: possible, toSkip: skipped },
      warnings: warningResult(state),
      mappings,
      existing,
      source: imported
    };
  }

  async function preview(auth, targetBusinessId, packageValue) {
    requireSystemAdmin(auth);
    if (typeof targetBusinessId !== 'string' || !/^[1-9]\d{0,19}$/.test(targetBusinessId)) throw httpError(400, 'INVALID_INPUT');
    const imported = packageForSalesImport(packageValue);
    const business = await assertTarget(repo.pool, targetBusinessId);
    const result = await assess(repo.pool, targetBusinessId, imported, { readReferences: true });
    return {
      ok: true,
      eligible: result.eligible,
      sourceBusinessName: imported.sourceBusinessName,
      targetBusinessName: business.name,
      gates: result.gates,
      sales: result.counts,
      warnings: result.warnings
    };
  }

  async function migrate(auth, targetBusinessId, packageValue) {
    requireSystemAdmin(auth);
    if (typeof targetBusinessId !== 'string' || !/^[1-9]\d{0,19}$/.test(targetBusinessId)) throw httpError(400, 'INVALID_INPUT');
    const imported = packageForSalesImport(packageValue);
    if (!await schemaAvailable(repo.pool)) throw httpError(503, 'MIGRATION_SALES_SCHEMA_REQUIRED');

    return repo.transaction(async db => {
      const business = await assertTarget(db, targetBusinessId, true);
      const result = await assess(db, targetBusinessId, imported, { readReferences: true });
      if (!result.gates.schema) throw httpError(503, 'MIGRATION_SALES_SCHEMA_REQUIRED');
      if (!result.gates.basic) throw httpError(409, 'MIGRATION_BASIC_REQUIRED');
      if (!result.gates.inventory) throw httpError(409, 'MIGRATION_INVENTORY_REQUIRED');
      if (!result.gates.targetUser) throw httpError(409, 'MIGRATION_TARGET_USER_REQUIRED');

      const created = { sales: 0 };
      const skipped = { sales: 0 };
      const state = { warnings: [], warningCount: 0 };
      const seen = new Set();
      const fingerprintOccurrences = new Map();
      for (let index = 0; index < imported.sales.length; index++) {
        const sale = prepareSale(imported.sales[index], index, imported, result.mappings, state, fingerprintOccurrences);
        if (!sale) { skipped.sales++; continue; }
        if (result.existing.has(sale.sourceSaleKey) || seen.has(sale.sourceSaleKey)) {
          appendWarning(state, 'Venta ' + labelSale(sale, index) + ': referencia local ya migrada o repetida; se omitirá.');
          skipped.sales++;
          continue;
        }
        seen.add(sale.sourceSaleKey);
        const invoice = migrationInvoice(imported.sourceBusinessKey, sale.sourceSaleKey, sale.localInvoice);
        const sourceDetail = sale.detail || '';
        const detail = sale.localInvoice ? ('Factura local: ' + sale.localInvoice + (sourceDetail ? ' · ' + sourceDetail : '')).slice(0, 500) : (sourceDetail || null);
        const inserted = await repo.rows(db,
          "INSERT INTO sales (business_id, user_id, client_id, cash_session_id, invoice_number, sale_type, payment_method, subtotal, discount, discount_percent, tax, total, status, cash_status, sale_price_type, detail, due_at, cancelled_at, cancelled_by, cancel_reason, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NOT_APPLICABLE', ?, ?, ?, ?, NULL, ?, ?)",
          [targetBusinessId, String(result.mappings.user.id), sale.clientId, invoice, sale.saleType, sale.paymentMethod,
            formatMoney(sale.subtotal), formatMoney(sale.discount), formatPercent(sale.discountPercent), formatMoney(sale.tax), formatMoney(sale.total),
            sale.status, sale.priceType, detail, sale.dueAt, sale.canceledAt, sale.cancelReason, sale.createdAt]);
        const saleId = String(inserted.insertId);
        for (const item of sale.items) {
          await repo.rows(db,
            'INSERT INTO sale_items (business_id, sale_id, product_id, product_name, barcode, quantity, unit_price, tax_rate, discount, subtotal, total, cost_at_sale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [targetBusinessId, saleId, item.productId, item.productName, item.barcode, formatQuantity(item.quantity), formatMoney(item.unitPrice), formatRate(item.taxRate), formatMoney(item.discount), formatMoney(item.subtotal), formatMoney(item.total), formatMoney(item.cost)]);
        }
        await repo.rows(db,
          'INSERT INTO migration_sales_references (business_id, source_business_key, source_sale_key, source_sale_id, fingerprint, sale_id, created_at) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))',
          [targetBusinessId, imported.sourceBusinessKey, sale.sourceSaleKey, sale.localSaleId, sale.fingerprint, saleId]);
        created.sales++;
      }

      const warnings = warningResult(state);
      const summary = { created, skipped };
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
        [targetBusinessId, 'MIGRATION_SALES_IMPORT', 'businesses', targetBusinessId, JSON.stringify(auditDetails)]);
      return { ok: true, created, skipped, warnings };
    });
  }

  return { preview, migrate };
}

module.exports = { createSystemAdminSalesMigration, matchesPriorImport, indexTargets, resolveProduct, resolveClient };
