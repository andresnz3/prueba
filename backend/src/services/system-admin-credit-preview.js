'use strict';
const { httpError } = require('../middleware/errors');
const { packageForSalesImport, normalizeSale, normalizeName, sourceSaleKey, fingerprintSale, formatMoney } = require('./system-admin-sales-migration-values');
const { sourceKeyFromAudit } = require('./migration-sales-origin');
const signedMoney = value => value < 0n ? '-' + formatMoney(-value) : formatMoney(value);
const record = v => v && typeof v === 'object' && !Array.isArray(v);
const first = (v, keys) => keys.map(k => v?.[k]).find(v => v !== undefined && v !== null && v !== '');
function identity(v) {
  if (!['string', 'number'].includes(typeof v) || (typeof v === 'number' && !Number.isFinite(v))) return null;
  const text = String(v).trim();
  return text && text.length <= 100 ? text : null;
}
function cents(v) {
  const m = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(String(v ?? ''));
  if (!m) throw new Error('Importe inválido o con más de dos decimales');
  return BigInt(m[1]) * 100n + BigInt((m[2] || '').padEnd(2, '0') || '0');
}
function dateOf(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'number' && (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(v))) throw new Error('Fecha ambigua; se requiere fechaTS o fecha ISO');
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) throw new Error('Fecha inválida');
  return d.toISOString();
}
const credit = s => ['saleType', 'tipoVenta', 'sale_type', 'tipo', 'paymentMethod', 'metodoPago', 'metodo', 'payment_method', 'medioPago'].some(k => /^(credito|credit|fiado)$/.test(normalizeName(String(s?.[k] || ''))));

// Pure calculation: no database connection, mutation of source records, or Dexie.
function reconcileCreditPackage(value, now = Date.now()) {
  const imported = packageForSalesImport(value);
  if (!Array.isArray(value.data.abonos) || value.data.abonos.length > 50000) throw httpError(400, 'MIGRATION_PACKAGE_INVALID');
  const issues = [];
  const issue = (code, message, blocking = true) => issues.push({ code, message, blocking });
  const clients = value.data.clients.map((raw, i) => ({ id: identity(first(raw, ['id', 'clientId', 'clienteId', 'client_id'])), name: imported.clients[i].name, raw, invoices: [], payments: [], relevant: false }));
  const clientIds = new Map(), clientNames = new Map();
  for (const c of clients) {
    for (const [map, key] of [[clientIds, c.id], [clientNames, normalizeName(c.name)]]) {
      if (key) map.set(key, [...(map.get(key) || []), c]);
    }
  }
  function resolveClient(id, name, label) {
    const matches = id ? clientIds.get(id) : clientNames.get(normalizeName(String(name || '')));
    if (matches?.length !== 1) { issue('CLIENT_REFERENCE', label + ': cliente inexistente o ambiguo'); return null; }
    const c = matches[0]; c.relevant = true;
    if (name && normalizeName(String(name)) !== normalizeName(c.name)) issue('CLIENT_MISMATCH', label + ': ID y nombre de cliente no coinciden');
    return c;
  }
  const invoices = [], saleIds = new Map(), signatures = new Set();
  value.data.sales.forEach((raw, index) => {
    if (!credit(raw)) return;
    const id = identity(first(raw, ['id', 'saleId', 'ventaId', 'sale_id', 'venta_id']));
    const invoiceNumber = identity(first(raw, ['invoiceNumber', 'numeroFactura', 'factura', 'invoice', 'comprobante', 'numero']));
    const label = 'Factura ' + (invoiceNumber || id || '#' + (index + 1));
    if (!id) issue('SALE_ID_MISSING', label + ': falta identificador estable');
    const rawName = first(raw, ['clientName', 'clienteNombre', 'nombreCliente', 'customerName', 'cliente', 'client']);
    const client = resolveClient(identity(first(raw, ['clientId', 'clienteId', 'client_id', 'cliente_id'])), record(rawName) ? rawName.name : rawName, label);
    const row = { sourceSaleId: id, invoiceNumber, clientId: client?.id || null, clientName: client?.name || String(rawName || ''), total: '0.00', paid: '0.00', balance: '0.00', status: 'INVALID', date: null, dueAt: null, payments: [], _total: 0n, _paid: 0n, _client: client };
    invoices.push(row);
    if (id) {
      if (saleIds.has(id)) issue('DUPLICATE_SALE_ID', label + ': identificador local repetido');
      saleIds.set(id, [...(saleIds.get(id) || []), row]);
    }
    try {
      const due = first(raw, ['vencimientoTS', 'dueAt', 'due_at', 'vencimiento', 'fechaVencimiento']);
      const createdAt = dateOf(first(raw, ['createdAt', 'created_at', 'fechaTS', 'fecha', 'date', 'timestamp']));
      const n = normalizeSale({ ...raw, createdAt, dueAt: due === undefined ? null : dateOf(due), vencimiento: undefined }, index, imported);
      if (n.error) throw new Error(n.error);
      if (n.saleType !== 'CREDIT') throw new Error('Medio y tipo de venta contradictorios');
      row._total = n.total; row.total = formatMoney(n.total);
      row.date = dateOf(n.createdAt.replace(' ', 'T') + 'Z');
      row.dueAt = due === undefined ? null : dateOf(due);
      row._cancelled = n.status === 'CANCELLED';
      row.status = row._cancelled ? 'CANCELLED' : 'OPEN';
      if (raw.anulada !== undefined && typeof raw.anulada !== 'boolean') issue('SALE_STATUS', label + ': anulación inválida');
      row.sourceSaleKey = sourceSaleKey(n, fingerprintSale(n, null));
      const signature = (client?.id || client?.name || '') + ':' + invoiceNumber;
      if (!invoiceNumber) issue('INVOICE_MISSING', label + ': falta factura original');
      else if (signatures.has(signature)) issue('POSSIBLE_DUPLICATE_INVOICE', label + ': posible factura duplicada');
      signatures.add(signature);
      if (client) client.invoices.push(row);
    } catch (e) { issue('INVALID_SALE', label + ': ' + e.message); }
  });
  const payments = [], paymentIds = new Set(), paymentSignatures = new Set();
  for (const raw of value.data.abonos) {
    if (!record(raw)) { issue('INVALID_PAYMENT', 'Abono no válido'); continue; }
    if (raw.tipo === 'proveedor') continue;
    if (!['cliente', 'factura'].includes(raw.tipo)) { issue('PAYMENT_TYPE', 'Tipo de abono desconocido'); continue; }
    const id = identity(raw.id), saleId = identity(raw.facturaId), label = 'Abono ' + (id || '(sin ID)');
    const client = resolveClient(identity(raw.referenciaId), null, label);
    const row = { sourcePaymentId: id, sourceSaleId: saleId, clientId: client?.id || null, clientName: client?.name || '', amount: '0.00', date: null, originalStatus: raw.estado == null ? null : String(raw.estado), paymentMethod: raw.metodoPago == null ? null : String(raw.metodoPago), cancelled: raw.anulado === true, general: !saleId, appliesToDebt: false, allocations: [], _amount: 0n };
    payments.push(row);
    if (client) client.payments.push(row);
    if (!id) issue('PAYMENT_ID_MISSING', label + ': falta identificador estable');
    else if (paymentIds.has(id)) issue('DUPLICATE_PAYMENT_ID', label + ': identificador repetido');
    paymentIds.add(id);
    if (raw.facturaId !== undefined && raw.facturaId !== null && raw.facturaId !== '' && !saleId) issue('PAYMENT_REFERENCE', label + ': referencia de factura inválida');
    if (raw.anulado !== undefined && typeof raw.anulado !== 'boolean') issue('PAYMENT_STATUS', label + ': anulación inválida');
    try {
      row._amount = cents(raw.monto);
      if (row._amount <= 0n) throw new Error('El monto debe ser mayor que cero');
      row.amount = formatMoney(row._amount);
      row.date = dateOf(first(raw, ['fechaTS', 'createdAt', 'fecha']));
      if (!row.date) throw new Error('Falta fecha');
      const signature = [row.clientId, saleId, row.amount, row.date, row.paymentMethod].join(':');
      if (paymentSignatures.has(signature)) issue('POSSIBLE_DUPLICATE_PAYMENT', label + ': coincide con otro abono');
      paymentSignatures.add(signature);
      if (row.cancelled) issue('VOID_PAYMENT', label + ': anulado; no reduce deuda', false);
      if (row.general) issue('GENERAL_PAYMENT', label + ': abono general; distribución por antigüedad', false);
      if (row.originalStatus === 'pendiente' && !row.cancelled) issue('LOCAL_PENDING_APPLIED', label + ': pendiente en caja local, ya aplicado a la deuda', false);
      if (saleId) {
        const matches = saleIds.get(saleId);
        if (matches?.length !== 1) throw new Error('Factura inexistente, no crediticia o ambigua');
        const invoice = matches[0];
        if (!client || invoice._client !== client) throw new Error('El abono y la factura pertenecen a clientes diferentes');
        if (!row.cancelled && invoice._cancelled) throw new Error('Abono vigente sobre factura anulada');
        if (!row.cancelled && invoice.status === 'INVALID') throw new Error('Factura inválida');
        invoice.payments.push(id);
        if (!row.cancelled) {
          invoice._paid += row._amount; row.appliesToDebt = true;
          row.allocations.push({ sourceSaleId: saleId, invoiceNumber: invoice.invoiceNumber, amount: row.amount });
        }
      } else if (!row.cancelled && client) row.appliesToDebt = true;
    } catch (e) { row.appliesToDebt = false; issue('INVALID_PAYMENT', label + ': ' + e.message); }
  }
  const reconciliations = [];
  for (const c of clients) {
    let opening = null, declared = null;
    try { if (c.raw.deudaSinFactura !== undefined) opening = cents(c.raw.deudaSinFactura); }
    catch { issue('INVALID_OPENING_DEBT', c.name + ': deuda sin factura inválida'); }
    try { if (c.raw.debt !== undefined) declared = cents(c.raw.debt); }
    catch { issue('INVALID_CLIENT_DEBT', c.name + ': saldo declarado inválido'); }
    if (opening > 0n || declared > 0n) c.relevant = true;
    if (!c.relevant) continue;
    if (!c.id || clientIds.get(c.id)?.length !== 1 || clientNames.get(normalizeName(c.name))?.length !== 1) issue('AMBIGUOUS_CLIENT', c.name + ': identidad incompleta o repetida');
    const sorted = c.invoices.filter(r => !r._cancelled && r.status !== 'INVALID').sort((a, b) => a.date.localeCompare(b.date) || String(a.sourceSaleId).localeCompare(String(b.sourceSaleId), 'en'));
    for (const payment of c.payments.filter(r => r.general && r.appliesToDebt).sort((a, b) => a.date.localeCompare(b.date) || String(a.sourcePaymentId).localeCompare(String(b.sourcePaymentId), 'en'))) {
      let rest = payment._amount;
      for (const invoice of sorted) {
        const balance = invoice._total - invoice._paid, applied = balance < rest ? balance : rest;
        if (applied <= 0n) continue;
        invoice._paid += applied; rest -= applied;
        invoice.payments.push(payment.sourcePaymentId);
        payment.allocations.push({ sourceSaleId: invoice.sourceSaleId, invoiceNumber: invoice.invoiceNumber, amount: formatMoney(applied) });
      }
      if (rest > 0n) issue('UNALLOCATED_GENERAL_PAYMENT', c.name + ': C$' + formatMoney(rest) + ' de abono general sin factura; conciliar deuda inicial');
    }
    let balance = 0n;
    for (const invoice of c.invoices) {
      if (invoice.status === 'INVALID') continue;
      if (invoice._paid > invoice._total) issue('OVERPAYMENT', 'Factura ' + invoice.invoiceNumber + ': abonos superiores al total');
      invoice.paid = formatMoney(invoice._paid);
      const remaining = invoice._total - invoice._paid;
      invoice.balance = formatMoney(invoice._cancelled || remaining < 0n ? 0n : remaining);
      invoice.status = invoice._cancelled ? 'CANCELLED' : remaining <= 0n ? 'PAID' : invoice.dueAt && new Date(invoice.dueAt).getTime() < now ? 'OVERDUE' : 'OPEN';
      balance += invoice._cancelled || remaining < 0n ? 0n : remaining;
    }
    if (opening === null) issue('OPENING_DEBT_UNKNOWN', c.name + ': falta deudaSinFactura; no se inferirá automáticamente');
    else if (opening > 0n) issue('OPENING_DEBT', c.name + ': deuda sin factura C$' + formatMoney(opening) + ' pendiente de representación histórica');
    if (declared === null) issue('CLIENT_DEBT_UNKNOWN', c.name + ': falta saldo local declarado');
    const calculated = balance + (opening || 0n);
    if (declared !== null && declared !== calculated) issue('BALANCE_MISMATCH', c.name + ': saldo local C$' + formatMoney(declared) + ' y reconstruido C$' + formatMoney(calculated) + ' no coinciden');
    reconciliations.push({ sourceClientId: c.id, clientName: c.name, declaredDebt: declared === null ? null : formatMoney(declared), openingDebt: opening === null ? null : formatMoney(opening), invoiceBalance: formatMoney(balance), calculatedDebt: formatMoney(calculated), difference: declared === null ? null : signedMoney(declared - calculated), consistent: declared !== null && opening !== null && declared === calculated });
  }
  const publicRow = row => Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('_')));
  return { ok: true, previewOnly: true, canImport: false, financiallyConsistent: !issues.some(r => r.blocking), sourceBusinessName: imported.sourceBusinessName, sourceBusinessKey: imported.sourceBusinessKey, invoices: invoices.map(publicRow), payments: payments.map(publicRow), clients: reconciliations, issues,
    totals: { invoices: invoices.length, payments: payments.length, total: formatMoney(invoices.filter(r => !r._cancelled && r.status !== 'INVALID').reduce((sum, r) => sum + r._total, 0n)), paid: formatMoney(invoices.reduce((sum, r) => sum + r._paid, 0n)), balance: formatMoney(invoices.reduce((sum, r) => sum + cents(r.balance), 0n)) } };
}
function createSystemAdminCreditPreview({ repo, requireSystemAdmin }) {
  async function preview(auth, targetBusinessId, value) {
    requireSystemAdmin(auth);
    if (typeof targetBusinessId !== 'string' || !/^[1-9]\d{0,19}$/.test(targetBusinessId)) throw httpError(400, 'INVALID_INPUT');
    const result = reconcileCreditPackage(value);
    const [business] = await repo.rows(repo.pool, 'SELECT id, name, status FROM businesses WHERE id = ?', [targetBusinessId]);
    if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
    if (business.status !== 'ACTIVE') throw httpError(409, 'MIGRATION_TARGET_INACTIVE');
    const [clients, sales, payments, audits, tables] = await Promise.all([
      repo.rows(repo.pool, 'SELECT id, name, opening_balance FROM clients WHERE business_id = ?', [targetBusinessId]),
      repo.rows(repo.pool, "SELECT id, client_id, invoice_number, total, created_at, status FROM sales WHERE business_id = ? AND sale_type = 'CREDIT'", [targetBusinessId]),
      repo.rows(repo.pool, 'SELECT id, client_id, sale_id, amount, created_at, status FROM customer_payments WHERE business_id = ?', [targetBusinessId]),
      repo.rows(repo.pool, "SELECT details FROM audit_logs WHERE business_id = ? AND action IN ('MIGRATION_BASIC_IMPORT', 'MIGRATION_INVENTORY_IMPORT', 'MIGRATION_SALES_IMPORT', 'MIGRATION_PURCHASES_IMPORT') ORDER BY id DESC", [targetBusinessId]),
      repo.rows(repo.pool, "SELECT TABLE_NAME AS tableName FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'migration_sales_references'", [])
    ]);
    const references = tables.length ? await repo.rows(repo.pool, 'SELECT source_business_key, source_sale_key, source_sale_id, sale_id FROM migration_sales_references WHERE business_id = ?', [targetBusinessId]) : [];
    const add = (code, message, blocking = true) => result.issues.push({ code, message, blocking });
    const origins = new Set(references.map(r => r.source_business_key));
    for (const row of audits) { const key = sourceKeyFromAudit(row.details); if (key) origins.add(key); }
    result.otherOrigins = [...origins].filter(key => key !== result.sourceBusinessKey);
    if (result.otherOrigins.length) add('OTHER_ORIGIN', 'El destino contiene importaciones históricas de otro origen; requiere revisión explícita.');
    for (const client of result.clients) {
      const matches = clients.filter(r => normalizeName(r.name) === normalizeName(client.clientName));
      client.targetClientId = matches.length === 1 ? String(matches[0].id) : null;
      if (matches.length !== 1) { add('TARGET_CLIENT', client.clientName + ': cliente destino inexistente o ambiguo'); continue; }
      const id = client.targetClientId;
      if (cents(matches[0].opening_balance) > 0n) add('TARGET_OPENING_BALANCE', client.clientName + ': ya tiene saldo inicial; posible deuda duplicada');
      if (sales.some(r => String(r.client_id) === id) || payments.some(r => String(r.client_id) === id)) add('TARGET_FINANCIAL_HISTORY', client.clientName + ': ya tiene créditos o abonos en destino; conciliar posibles duplicados');
    }
    for (const invoice of result.invoices) {
      const existing = references.find(r => r.source_business_key === result.sourceBusinessKey && (String(r.source_sale_id) === invoice.sourceSaleId || r.source_sale_key === invoice.sourceSaleKey));
      invoice.alreadyImported = Boolean(existing);
      if (existing) add('ALREADY_IMPORTED', 'Factura ' + invoice.invoiceNumber + ': referencia de origen ya importada; revisar sus abonos');
    }
    result.targetBusinessName = business.name;
    result.financiallyConsistent = !result.issues.some(r => r.blocking);
    result.eligible = false;
    return result;
  }
  return { preview };
}
module.exports = { reconcileCreditPackage, createSystemAdminCreditPreview };
