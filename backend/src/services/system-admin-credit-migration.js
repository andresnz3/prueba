'use strict';
const { createHash } = require('node:crypto');
const { httpError } = require('../middleware/errors');
const { reconcileCreditPackage } = require('./system-admin-credit-preview');
const { packageForSalesImport, normalizeSale, normalizeName, fingerprintSale, sourceSaleKey, migrationInvoice, formatMoney, formatQuantity, formatRate } = require('./system-admin-sales-migration-values');
const { sourceKeyFromAudit } = require('./migration-sales-origin');
const { migrationBatchContext, applySourceBusinessKey } = require('./migration-batch-capability');
const digest = value => createHash('sha256').update(value).digest('hex');
const identity = value => value === undefined || value === null || value === '' ? null : String(value);
function cents(value) {
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(String(value ?? ''));
  if (!match) throw httpError(409, 'MIGRATION_CREDIT_DATA_CONFLICT');
  return BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0') || '0');
}
function targetIndexes(rows) {
  const names = new Map(), barcodes = new Map();
  for (const row of rows) {
    const name = normalizeName(row.name), barcode = normalizeName(row.barcode);
    if (name) names.set(name, [...(names.get(name) || []), row]);
    if (barcode) barcodes.set(barcode, [...(barcodes.get(barcode) || []), row]);
  }
  return { names, barcodes };
}
function resolveTargetProduct(item, indexes) {
  const barcode = normalizeName(item.barcode);
  const name = normalizeName(item.name);
  const matches = barcode ? indexes.barcodes.get(barcode) || [] : indexes.names.get(name) || [];
  if (!matches.length) return { error: 'producto sin correspondencia (' + (item.barcode || item.name || 'sin identificar') + ')' };
  if (matches.length > 1) return { error: 'producto ambiguo (' + (item.barcode || item.name) + ')' };
  return { product: matches[0] };
}
function paymentMethod(value) {
  const token = normalizeName(String(value || '')).toUpperCase();
  if (/^(CASH|EFECTIVO)$/.test(token)) return 'CASH';
  if (/^(CARD|TARJETA|POS)$/.test(token)) return 'CARD';
  if (/^(TRANSFER|TRANSFERENCIA|TRANSF)$/.test(token)) return 'TRANSFER';
  if (/^(OTHER|OTRO)$/.test(token)) return 'OTHER';
  return null;
}
function paymentStatus(value, cancelled) {
  if (cancelled) return 'VOID';
  const status = value === null ? '' : String(value).trim().toLocaleLowerCase('es-NI');
  if (status && !['pendiente', 'confirmado', 'confirmed'].includes(status)) throw httpError(409, 'MIGRATION_CREDIT_DATA_CONFLICT');
  return 'POSTED';
}
function sqlDate(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw httpError(409, 'MIGRATION_CREDIT_DATA_CONFLICT');
  return parsed.toISOString().slice(0, 23).replace('T', ' ');
}
const details = value => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
};
function matchesStage(rows, imported, exactExport) {
  return rows.some(row => {
    const d = details(row.details);
    if (!d || normalizeName(d.sourceBusinessName) !== normalizeName(imported.sourceBusinessName)) return false;
    if (d.sourceBusinessKey && d.sourceBusinessKey !== imported.sourceBusinessKey) return false;
    return !exactExport || imported.exportedAt === null || d.packageExportedAt === imported.exportedAt;
  });
}
function issue(list, code, message, blocking = true) { list.push({ code, message, blocking }); }

function createSystemAdminCreditMigration({ repo, requireSystemAdmin }) {
  async function prepare(db, targetBusinessId, value, options = {}) {
    const result = reconcileCreditPackage(value);
    const batchContext = options.batchContext || null;
    const imported = applySourceBusinessKey(packageForSalesImport(value), batchContext);
    result.sourceBusinessKey = imported.sourceBusinessKey;
    const findings = [...result.issues];
    const schemaTables = await repo.rows(db, "SELECT TABLE_NAME AS tableName FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('migration_sales_references', 'migration_credit_payment_references')", []);
    const schemaColumns = await repo.rows(db, "SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND ((TABLE_NAME='sales' AND COLUMN_NAME='is_historical') OR (TABLE_NAME='customer_payments' AND COLUMN_NAME IN ('is_historical','source_status')) OR (TABLE_NAME='migration_sales_references' AND COLUMN_NAME IN ('source_client_id','source_invoice_number')) OR (TABLE_NAME='migration_credit_payment_references' AND COLUMN_NAME='source_client_id'))", []);
    const hasTables = new Set(schemaTables.map(row => row.tableName));
    const hasColumns = new Set(schemaColumns.map(row => row.tableName + '.' + row.columnName));
    const schemaReady = hasTables.has('migration_sales_references') && hasTables.has('migration_credit_payment_references') && ['sales.is_historical', 'customer_payments.is_historical', 'customer_payments.source_status', 'migration_sales_references.source_client_id', 'migration_sales_references.source_invoice_number', 'migration_credit_payment_references.source_client_id'].every(key => hasColumns.has(key));
    const historicalSalesFlag = hasColumns.has('sales.is_historical') ? 'is_historical' : '0 AS is_historical';
    const historicalPaymentsFlag = hasColumns.has('customer_payments.is_historical') ? 'is_historical' : '0 AS is_historical';
    const businesses = await repo.rows(db, 'SELECT b.id,b.name,b.status,c.state AS migrationState,c.batch_id AS batchId,c.source_business_key AS sourceBusinessKey FROM businesses b LEFT JOIN business_migration_controls c ON c.business_id=b.id WHERE b.id = ?' + (options.lock ? ' FOR UPDATE' : ''), [targetBusinessId]);
    const targetClients = await repo.rows(db, 'SELECT id, name, opening_balance FROM clients WHERE business_id = ?', [targetBusinessId]);
    const products = await repo.rows(db, 'SELECT id, name, barcode, cost, tax_rate FROM products WHERE business_id = ?', [targetBusinessId]);
    const targetSales = await repo.rows(db, "SELECT id, client_id, sale_type, " + historicalSalesFlag + " FROM sales WHERE business_id = ? AND sale_type = 'CREDIT'", [targetBusinessId]);
    const targetPayments = await repo.rows(db, 'SELECT id, client_id, ' + historicalPaymentsFlag + ' FROM customer_payments WHERE business_id = ?', [targetBusinessId]);
    const audits = await repo.rows(db, "SELECT action, details FROM audit_logs WHERE business_id = ? AND action IN ('MIGRATION_BASIC_IMPORT','MIGRATION_INVENTORY_IMPORT','MIGRATION_SALES_IMPORT','MIGRATION_PURCHASES_IMPORT','MIGRATION_CREDIT_IMPORT') ORDER BY id DESC LIMIT 500", [targetBusinessId]);
    const targetUsers = await repo.rows(db, "SELECT id FROM users WHERE business_id = ? AND active = TRUE ORDER BY CASE WHEN role='ADMIN' THEN 0 ELSE 1 END, id LIMIT 1", [targetBusinessId]);
    const business = businesses[0];
    if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
    if (batchContext) {
      if (business.status !== 'INACTIVE' || business.migrationState !== 'PENDING' || String(business.batchId) !== batchContext.batchId || business.sourceBusinessKey !== batchContext.sourceBusinessKey) throw httpError(409, 'MIGRATION_TARGET_REQUIRED');
    } else if (business.status !== 'ACTIVE') throw httpError(409, 'MIGRATION_TARGET_INACTIVE');
    const basic = batchContext ? batchContext.catalogReady === true : matchesStage(audits.filter(row => row.action === 'MIGRATION_BASIC_IMPORT'), imported, true);
    const inventory = batchContext ? batchContext.catalogReady === true : matchesStage(audits.filter(row => row.action === 'MIGRATION_INVENTORY_IMPORT'), imported, false);
    const gates = { basic, inventory, schema: schemaReady, targetUser: Boolean(targetUsers[0]), targetClients: true, targetProducts: true };
    if (!basic) issue(findings, 'MIGRATION_BASIC_REQUIRED', 'Completa primero la importación básica del mismo paquete.');
    if (!inventory) issue(findings, 'MIGRATION_INVENTORY_REQUIRED', 'Completa primero el inventario inicial del mismo origen.');
    if (!schemaReady) issue(findings, 'MIGRATION_CREDIT_SCHEMA_REQUIRED', 'Falta la migración SQL 010 de créditos históricos.');
    if (!targetUsers[0]) issue(findings, 'MIGRATION_TARGET_USER_REQUIRED', 'El negocio destino no tiene un usuario activo para atribuir las facturas históricas.');
    const sourceKey = imported.sourceBusinessKey;
    const salesRefs = schemaReady ? await repo.rows(db, 'SELECT source_business_key, source_sale_key, source_sale_id, fingerprint, sale_id FROM migration_sales_references WHERE business_id = ?', [targetBusinessId]) : [];
    const paymentRefs = hasTables.has('migration_credit_payment_references') ? await repo.rows(db, 'SELECT source_business_key, source_payment_key, source_payment_id, source_sale_key, fingerprint, customer_payment_id FROM migration_credit_payment_references WHERE business_id = ?', [targetBusinessId]) : [];
    const origins = new Set(salesRefs.map(row => row.source_business_key));
    for (const row of audits) { const key = sourceKeyFromAudit(row.details); if (key) origins.add(key); }
    const otherOrigins = [...origins].filter(key => key !== sourceKey);
    if (otherOrigins.length) issue(findings, 'OTHER_ORIGIN', 'El destino contiene historial importado desde otro origen; confirma expresamente antes de continuar.', false);

    const clientTargets = new Map();
    for (const client of result.clients) {
      const matches = targetClients.filter(row => normalizeName(row.name) === normalizeName(client.clientName));
      if (matches.length !== 1) { gates.targetClients = false; issue(findings, 'TARGET_CLIENT', client.clientName + ': cliente destino inexistente o ambiguo'); continue; }
      const target = matches[0]; client.targetClientId = String(target.id); clientTargets.set(String(client.sourceClientId), target);
      if (cents(target.opening_balance) !== 0n) issue(findings, 'TARGET_OPENING_BALANCE', client.clientName + ': el negocio ya tiene deuda inicial; no se modificará ni mezclará con la importación.');
    }
    const productIndexes = targetIndexes(products);
    const sourceSales = new Map(imported.sales.map((sale, index) => [identity(sale?.id ?? sale?.saleId ?? sale?.ventaId ?? sale?.sale_id ?? sale?.venta_id), { raw: sale, index }]));
    const preparedInvoices = new Map();
    for (const invoice of result.invoices) {
      const source = sourceSales.get(invoice.sourceSaleId);
      if (!source || !invoice.clientId || !clientTargets.has(invoice.clientId)) continue;
        const rawDueAt = source.raw.vencimientoTS ?? source.raw.dueAt ?? source.raw.due_at ?? source.raw.fechaVencimiento ?? source.raw.fecha_vencimiento ?? source.raw.vencimiento;
        const normalized = normalizeSale({ ...source.raw, ...(rawDueAt !== undefined ? { dueAt: rawDueAt } : {}) }, source.index, imported);
      if (normalized.error) continue;
      const mappedItems = [];
      for (const item of normalized.items) {
        const match = resolveTargetProduct(item, productIndexes);
        if (match.error) { gates.targetProducts = false; issue(findings, 'TARGET_PRODUCT', 'Factura ' + invoice.invoiceNumber + ': ' + match.error); break; }
        const product = match.product;
        mappedItems.push({ productId: String(product.id), productName: item.name || product.name, barcode: item.barcode || product.barcode || null,
          quantity: item.quantity, unitPrice: item.unitPrice, taxRate: item.taxRate ?? 0n, discount: item.discount, subtotal: item.subtotal, total: item.total,
          cost: item.costCents ?? 0n });
      }
      if (mappedItems.length !== normalized.items.length) continue;
      normalized.items = mappedItems;
      const targetClient = clientTargets.get(invoice.clientId);
      const fingerprint = fingerprintSale(normalized, String(targetClient.id));
      const key = sourceSaleKey(normalized, fingerprint);
      invoice.sourceSaleKey = key;
      invoice.alreadyImported = false;
      const foundByKey = salesRefs.find(row => row.source_business_key === sourceKey && row.source_sale_key === key);
      const foundById = salesRefs.find(row => row.source_business_key === sourceKey && row.source_sale_id !== null && String(row.source_sale_id) === invoice.sourceSaleId);
      if (foundByKey || foundById) {
        const existing = foundByKey || foundById;
        if (existing.source_sale_key !== key || existing.fingerprint !== fingerprint) issue(findings, 'SOURCE_CONFLICT', 'Factura ' + invoice.invoiceNumber + ': el identificador de origen ya existe con datos diferentes.');
        else invoice.alreadyImported = true;
      }
      const otherCredit = targetSales.some(row => String(row.client_id) === String(targetClient.id) && !row.is_historical && !salesRefs.some(ref => String(ref.sale_id) === String(row.id)));
      const otherPayments = targetPayments.some(row => String(row.client_id) === String(targetClient.id) && !row.is_historical && !paymentRefs.some(ref => String(ref.customer_payment_id) === String(row.id)));
      if (otherCredit || otherPayments) issue(findings, 'TARGET_FINANCIAL_HISTORY', invoice.clientName + ': el destino ya tiene créditos o abonos operativos; concilia antes de importar.');
      preparedInvoices.set(invoice.sourceSaleId, { normalized, targetClient, fingerprint, key, existing: foundByKey || foundById || null });
    }
    const preparedPayments = [];
    for (const payment of result.payments) {
      const raw = value.data.abonos.find(row => identity(row?.id) === payment.sourcePaymentId && (row?.tipo === 'cliente' || row?.tipo === 'factura'));
      if (!raw || !payment.clientId || !clientTargets.has(payment.clientId)) continue;
      const allocations = payment.allocations.map(allocation => {
        const invoice = preparedInvoices.get(allocation.sourceSaleId);
        if (!invoice) return null;
        return { invoice, sourceSaleKey: invoice.key, amount: allocation.amount };
      });
      const saleId = identity(raw.facturaId);
      if (saleId && payment.cancelled) {
        const invoice = preparedInvoices.get(saleId);
        if (invoice) allocations.push({ invoice, sourceSaleKey: invoice.key, amount: payment.amount, voidOnly: true });
      }
      if (allocations.some(row => row === null)) { issue(findings, 'PAYMENT_ALLOCATION', 'Abono ' + payment.sourcePaymentId + ': falta la factura importable de su distribución.'); continue; }
      if (!payment.cancelled && allocations.reduce((sum, row) => sum + cents(row.amount), 0n) !== cents(payment.amount)) { issue(findings, 'PAYMENT_ALLOCATION', 'Abono ' + payment.sourcePaymentId + ': su distribución no coincide con el monto original.'); continue; }
      const method = paymentMethod(payment.paymentMethod);
      if (!method) { issue(findings, 'PAYMENT_METHOD', 'Abono ' + payment.sourcePaymentId + ': medio de pago no reconocido.'); continue; }
      if (payment.originalStatus !== null && payment.originalStatus.length > 100) { issue(findings, 'PAYMENT_STATUS', 'Abono ' + payment.sourcePaymentId + ': el estado original excede 100 caracteres.'); continue; }
      const sourcePaymentKey = digest('local-id:' + payment.sourcePaymentId);
      const payFingerprint = digest(JSON.stringify({ id: payment.sourcePaymentId, client: payment.clientId, amount: payment.amount, method, date: payment.date, status: payment.originalStatus, cancelled: payment.cancelled,
        allocations: allocations.map(row => [row.sourceSaleKey, row.amount, row.voidOnly === true]) }));
      const effectiveAllocations = allocations.length ? allocations : [{ invoice: null, sourceSaleKey: '', amount: payment.amount, voidOnly: true }];
      for (const allocation of effectiveAllocations) preparedPayments.push({ sourcePaymentId: payment.sourcePaymentId, sourcePaymentKey, payFingerprint, payment, targetClient: clientTargets.get(payment.clientId), allocation, method });
    }
    for (const payment of result.payments) {
      const rows = preparedPayments.filter(row => row.sourcePaymentId === payment.sourcePaymentId);
      if (!rows.length) continue;
      const existing = paymentRefs.filter(row => row.source_business_key === sourceKey && row.source_payment_key === rows[0].sourcePaymentKey);
      const expected = rows.map(row => row.allocation.sourceSaleKey).sort();
      if (existing.length) {
        const found = existing.map(row => row.source_sale_key).sort();
        const changed = JSON.stringify(found) !== JSON.stringify(expected) || existing.some(row => row.fingerprint !== rows[0].payFingerprint || String(row.source_payment_id) !== payment.sourcePaymentId);
        if (changed) issue(findings, 'PAYMENT_SOURCE_CONFLICT', 'Abono ' + payment.sourcePaymentId + ': el identificador de origen ya existe con datos o distribución diferentes.');
        else payment.alreadyImported = true;
      }
      const targetClientId = rows[0].targetClient.id;
      const importedPaymentIds = new Set(existing.map(row => String(row.customer_payment_id)));
      const otherPayments = targetPayments.some(row => String(row.client_id) === String(targetClientId) && !row.is_historical && !importedPaymentIds.has(String(row.id)));
      const mappedSaleIds = new Set(salesRefs.map(ref => String(ref.sale_id)));
      const otherSales = targetSales.some(row => String(row.client_id) === String(targetClientId) && !row.is_historical && !mappedSaleIds.has(String(row.id)));
      if (otherPayments || otherSales) issue(findings, 'TARGET_FINANCIAL_HISTORY', rows[0].payment.clientName + ': el destino ya tiene operaciones financieras; concilia antes de importar.');
    }
    const resultOrigins = [...new Set([...origins])];
    const blocking = findings.some(row => row.blocking);
    return { result: { ...result, previewOnly: true, financiallyConsistent: !blocking, eligible: !blocking && Object.values(gates).every(Boolean), canImport: !blocking && Object.values(gates).every(Boolean), gates,
      issues: findings, otherOrigins, sourceOriginConflict: { required: otherOrigins.length > 0, incomingSourceBusinessName: imported.sourceBusinessName, incomingSourceBusinessKey: sourceKey, existingSources: resultOrigins.filter(key => key !== sourceKey).map(key => ({ sourceBusinessKey: key, sourceBusinessName: null })) }, targetBusinessName: business.name,
      importable: { invoices: preparedInvoices.size, payments: preparedPayments.length, invoicesAlreadyImported: result.invoices.filter(row => row.alreadyImported).length, paymentGroupsAlreadyImported: result.payments.filter(row => row.alreadyImported).length } }, imported, preparedInvoices, preparedPayments, salesRefs, paymentRefs, business, targetUser: targetUsers[0], findings, gates, sourceKey };
  }
  async function preview(auth, targetBusinessId, value) {
    requireSystemAdmin(auth);
    if (typeof targetBusinessId !== 'string' || !/^[1-9]\d{0,19}$/.test(targetBusinessId)) throw httpError(400, 'INVALID_INPUT');
    return (await prepare(repo.pool, targetBusinessId, value)).result;
  }
  async function migrate(auth, targetBusinessId, value, options = {}) {
    requireSystemAdmin(auth);
    if (typeof targetBusinessId !== 'string' || !/^[1-9]\d{0,19}$/.test(targetBusinessId)) throw httpError(400, 'INVALID_INPUT');
    const batchContext = migrationBatchContext(options);
    return repo.transaction(async db => {
      await repo.rows(db, 'SELECT id FROM businesses WHERE id = ? FOR UPDATE', [targetBusinessId]);
      const prepared = await prepare(db, targetBusinessId, value, { lock: true, batchContext });
      const { result, imported, preparedInvoices, preparedPayments, targetUser, sourceKey } = prepared;
      if (!result.eligible) throw httpError(409, 'MIGRATION_CREDIT_BLOCKED');
      const otherOrigins = result.sourceOriginConflict.required;
      if (otherOrigins && options.confirmDifferentSource !== true) throw httpError(409, 'MIGRATION_CREDIT_ORIGIN_CONFIRMATION_REQUIRED');
      let createdInvoices = 0, skippedInvoices = 0, createdPayments = 0, skippedPayments = 0;
      const insertedSaleIds = new Map();
      for (const invoice of result.invoices) {
        const plan = preparedInvoices.get(invoice.sourceSaleId);
        if (!plan) continue;
        if (plan.existing) { skippedInvoices++; insertedSaleIds.set(invoice.sourceSaleId, String(plan.existing.sale_id)); continue; }
        const sale = plan.normalized, localInvoice = sale.localInvoice;
        const internalInvoice = migrationInvoice(sourceKey, plan.key, localInvoice);
        const sourceDetail = sale.detail || '';
        const detail = localInvoice ? ('Factura local: ' + localInvoice + (sourceDetail ? ' · ' + sourceDetail : '')).slice(0, 500) : sourceDetail || null;
        const sourceSale = imported.sales.find(item => identity(item?.id ?? item?.saleId ?? item?.ventaId ?? item?.sale_id ?? item?.venta_id) === String(invoice.sourceSaleId)) || {};
        const insertSql = batchContext
          ? "INSERT INTO sales (business_id,user_id,client_id,cash_session_id,invoice_number,sale_type,payment_method,subtotal,discount,discount_percent,tax,total,status,is_historical,cash_status,sale_price_type,detail,due_at,cancelled_at,cancelled_by,cancel_reason,source_actor,source_cancelled_by,created_at) VALUES (?,?,?,NULL,?,'CREDIT','CREDIT',?,?,?,?,?,?,TRUE,'NOT_APPLICABLE',?,?,?,?,NULL,?,?,?,?)"
          : "INSERT INTO sales (business_id,user_id,client_id,cash_session_id,invoice_number,sale_type,payment_method,subtotal,discount,discount_percent,tax,total,status,is_historical,cash_status,sale_price_type,detail,due_at,cancelled_at,cancelled_by,cancel_reason,created_at) VALUES (?,?,?,NULL,?,'CREDIT','CREDIT',?,?,?,?,?,?,TRUE,'NOT_APPLICABLE',?,?,?,?,NULL,?,?)";
        const saleValues = [targetBusinessId, String(targetUser.id), String(plan.targetClient.id), internalInvoice, formatMoney(sale.subtotal), formatMoney(sale.discount), sale.discountPercent, formatMoney(sale.tax), formatMoney(sale.total), sale.status, sale.priceType, detail, sale.dueAt, sale.canceledAt, sale.cancelReason];
        if (batchContext) saleValues.push(typeof sourceSale.__sourceActor === 'string' ? sourceSale.__sourceActor.slice(0, 180) : null,
          typeof sourceSale.__sourceCancelledBy === 'string' ? sourceSale.__sourceCancelledBy.slice(0, 180) : null);
        saleValues.push(sale.createdAt);
        const inserted = await repo.rows(db, insertSql, saleValues);
        const saleId = String(inserted.insertId); insertedSaleIds.set(invoice.sourceSaleId, saleId);
        for (const item of sale.items) await repo.rows(db, 'INSERT INTO sale_items (business_id,sale_id,product_id,product_name,barcode,quantity,unit_price,tax_rate,discount,subtotal,total,cost_at_sale) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          [targetBusinessId, saleId, item.productId, item.productName, item.barcode, formatQuantity(item.quantity), formatMoney(item.unitPrice), formatRate(item.taxRate), formatMoney(item.discount), formatMoney(item.subtotal), formatMoney(item.total), formatMoney(item.cost)]);
        await repo.rows(db, 'INSERT INTO migration_sales_references (business_id,source_business_key,source_sale_key,source_sale_id,source_client_id,fingerprint,sale_id,source_invoice_number,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          [targetBusinessId, sourceKey, plan.key, sale.localSaleId, invoice.clientId, plan.fingerprint, saleId, localInvoice, sale.createdAt]);
        createdInvoices++;
      }
      for (const entry of preparedPayments) {
        const sourceRows = prepared.paymentRefs.filter(row => row.source_business_key === sourceKey && row.source_payment_key === entry.sourcePaymentKey);
        if (sourceRows.length) { skippedPayments++; continue; }
        const sourceSaleId = entry.allocation.invoice?.normalized.localSaleId ? String(entry.allocation.invoice.normalized.localSaleId) : null;
        let saleId = sourceSaleId ? insertedSaleIds.get(sourceSaleId) : null;
        if (sourceSaleId && !saleId) {
          const ref = prepared.salesRefs.find(row => row.source_business_key === sourceKey && String(row.source_sale_id) === sourceSaleId);
          saleId = ref ? String(ref.sale_id) : null;
        }
        const method = entry.method, payment = entry.payment, rowStatus = paymentStatus(payment.originalStatus, payment.cancelled);
        const sourcePayment = value.data.abonos.find(row => identity(row?.id) === entry.sourcePaymentId) || {};
        const paymentSql = batchContext
          ? 'INSERT INTO customer_payments (business_id,user_id,client_id,sale_id,cash_session_id,amount,payment_method,status,is_historical,source_status,source_actor,source_cancelled_by,created_at) VALUES (?,?,?,?,NULL,?,?,?,TRUE,?,?,?,?)'
          : 'INSERT INTO customer_payments (business_id,user_id,client_id,sale_id,cash_session_id,amount,payment_method,status,is_historical,source_status,created_at) VALUES (?,?,?,?,NULL,?,?,?,TRUE,?,?)';
        const paymentValues = [targetBusinessId, String(targetUser.id), String(entry.targetClient.id), saleId, entry.allocation.amount, method, rowStatus, payment.originalStatus];
        if (batchContext) paymentValues.push(typeof sourcePayment.__sourceActor === 'string' ? sourcePayment.__sourceActor.slice(0, 180) : null,
          typeof sourcePayment.__sourceCancelledBy === 'string' ? sourcePayment.__sourceCancelledBy.slice(0, 180) : null);
        paymentValues.push(sqlDate(payment.date));
        const inserted = await repo.rows(db, paymentSql, paymentValues);
        const paymentId = String(inserted.insertId);
        await repo.rows(db, 'INSERT INTO migration_credit_payment_references (business_id,source_business_key,source_payment_key,source_payment_id,source_client_id,source_sale_key,fingerprint,customer_payment_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          [targetBusinessId, sourceKey, entry.sourcePaymentKey, entry.sourcePaymentId, payment.clientId, entry.allocation.sourceSaleKey, entry.payFingerprint, paymentId, sqlDate(payment.date)]);
        createdPayments++;
      }
      const audit = { actor: { userId: String(auth.user_id), username: auth.username, role: auth.role, businessId: String(auth.business_id) }, targetBusinessId, targetBusinessName: prepared.business.name,
        sourceBusinessName: imported.sourceBusinessName, sourceBusinessId: imported.sourceBusinessId, sourceBusinessKey: sourceKey, packageExportedAt: imported.exportedAt,
        confirmedDifferentSource: otherOrigins && options.confirmDifferentSource === true, created: { invoices: createdInvoices, payments: createdPayments }, skipped: { invoices: skippedInvoices, payments: skippedPayments } };
      await repo.rows(db, 'INSERT INTO audit_logs (business_id,user_id,action,entity,entity_id,details,created_at) VALUES (?,NULL,?,?,?,?,UTC_TIMESTAMP(3))',
        [targetBusinessId, 'MIGRATION_CREDIT_IMPORT', 'businesses', targetBusinessId, JSON.stringify(audit)]);
      return { ok: true, created: { invoices: createdInvoices, payments: createdPayments }, skipped: { invoices: skippedInvoices, payments: skippedPayments }, financial: result.totals, warnings: result.issues.filter(row => !row.blocking).map(row => row.message) };
    });
  }
  return { preview, migrate };
}
module.exports = { createSystemAdminCreditMigration };
