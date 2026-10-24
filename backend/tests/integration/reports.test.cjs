'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { readConfig } = require('../../src/config/environment');
const { readAuthConfig } = require('../../src/config/auth');
const { createDatabasePool } = require('../../src/config/database');
const { createAuthRepository, rows } = require('../../src/repositories/auth');
const { createAuthService } = require('../../src/services/auth');
const { createUsersService } = require('../../src/services/users');
const { hashPassword } = require('../../src/services/passwords');
const { createApp } = require('../../src/app');

const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Use isolated runner');

function client(base) {
  const jar = new Map(); let csrf;
  async function request(path, method = 'GET', body) {
    const response = await fetch(base + '/api' + path, {
      method,
      headers: { Cookie: [...jar].map(([key, value]) => key + '=' + value).join('; '), ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf || '' }) },
      body: method === 'GET' ? undefined : JSON.stringify(body)
    });
    for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0], index = pair.indexOf('='); jar.set(pair.slice(0, index), pair.slice(index + 1)); }
    const data = response.status === 204 ? undefined : await response.json();
    if (data?.csrfToken) csrf = data.csrfToken;
    return { status: response.status, data };
  }
  async function login(_businessId, username, password) {
    await request('/auth/csrf');
    assert.equal((await request('/auth/login', 'POST', { username, password })).status, 200);
  }
  return { request, login };
}

test('Integración MySQL reportes conectados de solo lectura', async t => {
  const config = readConfig(), authConfig = readAuthConfig({ CSRF_SECRET: randomBytes(32).toString('hex'), AUTH_RATE_MAX: '100' });
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 20 }); t.after(() => pool.end());
  const business = String((await rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['Reports A'])).insertId);
  const businessOther = String((await rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['Reports B'])).insertId);
  const password = 'Reports-fixture-password-123!', passwordHash = await hashPassword(password);
  const adminId = String((await rows(pool, 'INSERT INTO users (business_id, username, full_name, password_hash, role) VALUES (?, ?, ?, ?, ?)', [business, 'reportsadmin', 'Reportes Admin', passwordHash, 'ADMIN'])).insertId);
  await rows(pool, 'INSERT INTO users (business_id, username, full_name, password_hash, role) VALUES (?, ?, ?, ?, ?)', [business, 'reportsseller', 'Reportes Vendedor', passwordHash, 'VENDEDOR']);
  await rows(pool, 'INSERT INTO users (business_id, username, full_name, password_hash, role) VALUES (?, ?, ?, ?, ?)', [businessOther, 'reportsadminb', 'Otro negocio', passwordHash, 'ADMIN']);
  const repo = createAuthRepository(pool, authConfig), auth = createAuthService(repo, authConfig);
  const server = createApp({ config, checkDatabase: async () => {}, authentication: { repo, auth, config: authConfig, users: createUsersService(repo) } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const admin = client(base), seller = client(base), other = client(base), anonymous = client(base);
  await admin.login(business, 'reportsadmin', password); await seller.login(business, 'reportsseller', password); await other.login(businessOther, 'reportsadminb', password);

  const productId = String((await rows(pool, 'INSERT INTO products (business_id, barcode, name, category, cost, retail_price, wholesale_price, stock, min_stock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [business, 'REPORTS-PRODUCT', 'Producto de reportes', 'General', '2.00', '10.00', '9.00', '7.500', '1.000'])).insertId);
  const inventoryBatchId = randomUUID();
  await rows(pool, "INSERT INTO migration_import_batches (id,business_id,source_business_key,source_business_name,package_sha256,package_version,status,actor_business_id,actor_user_id,manifest,stage_results) VALUES (?,?,?,?,?,2,'COMPLETED',?,?,JSON_OBJECT(),JSON_OBJECT())", [inventoryBatchId, business, 'e'.repeat(64), 'Paquete Kardex', 'f'.repeat(64), business, adminId]);
  await rows(pool, 'INSERT INTO migration_zero_inventory_events (business_id,batch_id,source_record_key,product_id,source_type,quantity,stock_after,unit_cost,reason,source_actor,source_payload,occurred_at) VALUES (?,?,?,?,?,0.000,?,?,?,?,?,?)', [business, inventoryBatchId, 'id:inventory-zero-report', productId, 'INITIAL', '7.500', '2.00', 'Evento inicial sin cambio', 'Responsable histórico', JSON.stringify({ quantity: '0.000' }), '2026-10-07 09:00:00.000']);
  const clientId = String((await rows(pool, 'INSERT INTO clients (business_id, name, credit_limit) VALUES (?, ?, ?)', [business, 'Cliente con deuda', '100.00'])).insertId);
  const cashId = String((await rows(pool, "INSERT INTO cash_sessions (business_id, opened_by, opening_amount, opened_at, status, closed_by, counted_amount, expected_amount, difference, closed_at) VALUES (?, ?, '50.00', '2026-10-07 08:00:00.000', 'CLOSED', ?, '75.00', '74.00', '-1.00', '2026-10-07 18:00:00.000')", [business, adminId, adminId])).insertId);
  await rows(pool, "INSERT INTO expenses (business_id, user_id, cash_session_id, description, category, amount, payment_method, receipt_reference, status, created_at) VALUES (?, ?, NULL, 'Internet del local', 'Servicios Básicos', '5.00', 'BANK', 'R-5', 'POSTED', '2026-10-07 15:00:00.000')", [business, adminId]);
  async function sale({ invoice, amount, method, date, status = 'COMPLETED', credit = false, quantity = '1.000' }) {
    const result = await rows(pool, 'INSERT INTO sales (business_id, user_id, client_id, cash_session_id, invoice_number, sale_type, payment_method, subtotal, total, status, cash_status, sale_price_type, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [business, adminId, credit ? clientId : null, cashId, invoice, credit ? 'CREDIT' : 'CASH', method, amount, amount, status, credit ? 'NOT_APPLICABLE' : method === 'CASH' ? 'CONFIRMED' : 'PENDING', 'RETAIL', credit ? '2020-01-01 00:00:00.000' : null, date]);
    const id = String(result.insertId);
    await rows(pool, 'INSERT INTO sale_items (business_id, sale_id, product_id, product_name, barcode, quantity, unit_price, subtotal, total, cost_at_sale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [business, id, productId, 'Producto de reportes', 'REPORTS-PRODUCT', quantity, amount, amount, amount, '2.00']);
    return id;
  }
  const selectedCard = await sale({ invoice: '900001', amount: '15.00', method: 'CARD', date: '2026-10-07 12:00:00.000', quantity: '2.000' });
  const selectedCredit = await sale({ invoice: '900002', amount: '20.00', method: 'CREDIT', date: '2026-10-07 13:00:00.000', credit: true, quantity: '3.000' });
  await sale({ invoice: '900003', amount: '50.00', method: 'CASH', date: '2026-10-07 14:00:00.000', status: 'CANCELLED' });
  await sale({ invoice: '900004', amount: '9.00', method: 'CASH', date: '2026-10-06 12:00:00.000' });
  const historicalSourceKey = 'a'.repeat(64), historicalSaleKey = 'b'.repeat(64), historicalInvoice = 'MIG-900005-' + 'c'.repeat(28);
  const historicalSaleId = String((await rows(pool, "INSERT INTO sales (business_id,user_id,client_id,cash_session_id,invoice_number,sale_type,payment_method,subtotal,discount,discount_percent,tax,total,status,cash_status,sale_price_type,detail,due_at,created_at) VALUES (?, ?, NULL, NULL, ?, 'CASH', 'CASH', '40.00', '0.00', '0.0000', '0.00', '40.00', 'COMPLETED', 'NOT_APPLICABLE', 'RETAIL', ?, NULL, '2026-10-07 17:00:00.000')", [business, adminId, historicalInvoice, 'Factura local: 900005 · Fixture histórica'])).insertId);
  await rows(pool, 'INSERT INTO sale_items (business_id,sale_id,product_id,product_name,barcode,quantity,unit_price,subtotal,total,cost_at_sale) VALUES (?,?,?,?,?,?,?,?,?,?)', [business, historicalSaleId, productId, 'Producto de reportes', 'REPORTS-PRODUCT', '2.000', '20.00', '40.00', '40.00', '2.00']);
  await rows(pool, 'INSERT INTO migration_sales_references (business_id,source_business_key,source_sale_key,source_sale_id,fingerprint,sale_id) VALUES (?,?,?,?,?,?)', [business, historicalSourceKey, historicalSaleKey, 'venta-local-900005', 'd'.repeat(64), historicalSaleId]);
  await rows(pool, 'INSERT INTO migration_source_records (business_id,batch_id,entity_type,source_record_key,source_fingerprint,record_status,target_table,target_record_id,source_payload) VALUES (?,?,?,?,?,\'PROJECTED\',\'sales\',?,?)', [business, inventoryBatchId, 'sales', 'id:venta-local-900005', 'c'.repeat(64), historicalSaleId, JSON.stringify({ id: 'venta-local-900005', metodo: 'Contado', medioPago: 'Tarjeta de crédito' })]);
  await rows(pool, 'INSERT INTO audit_logs (business_id,user_id,action,entity,entity_id,details,created_at) VALUES (?,NULL,?,?,?,?,UTC_TIMESTAMP(3))', [business, 'MIGRATION_SALES_IMPORT', 'businesses', business, JSON.stringify({ sourceBusinessKey: historicalSourceKey, sourceBusinessName: 'Paquete histórico de reportes', summary: { created: { sales: 1 }, skipped: { sales: 0 } } })]);
  await rows(pool, "INSERT INTO cash_movements (business_id,cash_session_id,user_id,type,direction,amount,sale_id,description,status,source_method,created_at) VALUES (?,?,?,'SALE','IN','40.00',?,'Venta histórica tarjeta','CONFIRMED','CARD','2026-10-07 17:01:00.000')", [business, cashId, adminId, historicalSaleId]);
  const paymentId = String((await rows(pool, "INSERT INTO customer_payments (business_id, user_id, client_id, sale_id, cash_session_id, amount, payment_method, status, created_at) VALUES (?, ?, ?, ?, ?, '5.00', 'CASH', 'POSTED', '2026-10-07 15:00:00.000')", [business, adminId, clientId, selectedCredit, cashId])).insertId);
  await rows(pool, "INSERT INTO cash_movements (business_id, cash_session_id, user_id, type, direction, amount, sale_id, description, status, created_at) VALUES (?, ?, ?, 'SALE', 'IN', '15.00', ?, 'Pago con tarjeta', 'PENDING', '2026-10-07 12:01:00.000')", [business, cashId, adminId, selectedCard]);
  await rows(pool, "INSERT INTO cash_movements (business_id, cash_session_id, user_id, type, direction, amount, customer_payment_id, description, status, created_at) VALUES (?, ?, ?, 'CUSTOMER_PAYMENT', 'IN', '5.00', ?, 'Abono', 'CONFIRMED', '2026-10-07 15:00:00.000')", [business, cashId, adminId, paymentId]);
  const openCashId = String((await rows(pool, "INSERT INTO cash_sessions (business_id, opened_by, opening_amount, opened_at, status) VALUES (?, ?, '30.00', '2026-10-07 08:00:00.000', 'OPEN')", [business, adminId])).insertId);
  await rows(pool, "INSERT INTO cash_movements (business_id, cash_session_id, user_id, type, direction, amount, description, status, created_at) VALUES (?, ?, ?, 'MANUAL_ENTRY', 'IN', '4.00', 'Entrada confirmada', 'CONFIRMED', '2026-10-07 16:00:00.000')", [business, openCashId, adminId]);
  await rows(pool, "INSERT INTO cash_movements (business_id, cash_session_id, user_id, type, direction, amount, description, status, created_at) VALUES (?, ?, ?, 'MANUAL_EXIT', 'OUT', '2.00', 'Salida confirmada', 'CONFIRMED', '2026-10-07 16:30:00.000')", [business, openCashId, adminId]);
  await rows(pool, "INSERT INTO cash_movements (business_id, cash_session_id, user_id, type, direction, amount, description, status, created_at) VALUES (?, ?, ?, 'MANUAL_ENTRY', 'IN', '99.00', 'Entrada pendiente', 'PENDING', '2026-10-07 16:40:00.000')", [business, openCashId, adminId]);
  await rows(pool, "INSERT INTO cash_movements (business_id, cash_session_id, user_id, type, direction, amount, sale_id, description, status, created_at) VALUES (?, ?, ?, 'SALE', 'IN', '15.00', ?, 'Venta con tarjeta', 'CONFIRMED', '2026-10-07 16:50:00.000')", [business, openCashId, adminId, selectedCard]);

  await t.test('rango, método, productos, cierres, caja y CxC usan solo el negocio conectado', async () => {
    const path = '/reports/connected?from=2026-10-07T00%3A00%3A00.000Z&until=2026-10-08T00%3A00%3A00.000Z';
    const response = await admin.request(path); assert.equal(response.status, 200, JSON.stringify(response.data));
    const report = response.data.report;
    assert.equal(report.businessId, business);
    assert.equal(report.sales.total, '75.00'); assert.equal(report.sales.cost, '14.00'); assert.equal(report.sales.grossProfit, '61.00'); assert.equal(report.sales.netProfit, '56.00'); assert.equal(report.expenses.total, '5.00'); assert.equal(report.expenses.count, 1); assert.deepEqual(report.expenses.byCategory.map(row => [row.category, row.count, row.total]), [['Servicios Básicos', 1, '5.00']]); assert.equal(report.expenses.history[0].description, 'Internet del local'); assert.equal(report.sales.count, 3); assert.equal(report.sales.historyCount, 4);
    assert.deepEqual(report.sales.paymentMethods.map(row => [row.method, row.count, row.total]), [['CARD', 2, '55.00'], ['CREDIT', 1, '20.00']]);
    assert.equal(report.sales.sellers[0].seller, 'Reportes Admin'); assert.equal(report.sales.sellers[0].total, '75.00');
    assert.deepEqual(report.sales.topProducts.map(row => [row.name, row.quantity, row.total]), [['Producto de reportes', 7, '75.00']]); assert.equal(report.sales.unitsSold, 7);
    assert.deepEqual(report.sales.history.map(row => row.invoiceNumber).sort(), ['900001', '900002', '900003', '900005']);
    const historical = report.sales.history.find(row => row.isHistorical);
    assert.deepEqual({ invoiceNumber: historical.invoiceNumber, sourceBusinessName: historical.sourceBusinessName }, { invoiceNumber: '900005', sourceBusinessName: 'Paquete histórico de reportes' });
    assert.equal(historical.paymentMethod, 'CARD');
    assert.ok(report.sales.history.every(row => row.invoiceNumber !== historicalInvoice));
    const salesHistoryResponse = await admin.request('/sales?limit=100&offset=0'); assert.equal(salesHistoryResponse.status, 200);
    const historicalSale = salesHistoryResponse.data.sales.find(row => row.id === historicalSaleId);
    assert.equal(historicalSale.paymentMethod, 'CARD'); assert.equal(historicalSale.businessId, business);
    const otherSalesHistory = await other.request('/sales?limit=100&offset=0'); assert.equal(otherSalesHistory.status, 200);
    assert.ok(otherSalesHistory.data.sales.every(row => row.id !== historicalSaleId));
    assert.equal(report.cash.closures.length, 1); assert.equal(report.cash.closures[0].difference, '-1.00');
    assert.equal(report.cash.movements.length, 7); assert.ok(report.cash.movements.some(row => row.paymentMethod === 'CARD' && row.status === 'PENDING'));
    assert.equal(report.cash.movements.find(row => row.description === 'Venta histórica tarjeta').paymentMethod, 'CARD');
    assert.equal(report.cash.periodIn, '9.00'); assert.equal(report.cash.periodOut, '2.00'); assert.equal(report.cash.currentExpected, '32.00');
    assert.equal(report.inventory.activeProducts, 1); assert.equal(report.inventory.stockUnits, 7.5); assert.equal(report.inventory.stockCostValue, '15.00');
    assert.ok(report.inventory.movements.some(row => row.historicalEvent && row.type === 'INITIAL' && row.quantity === 0 && row.stockAfter === 7.5), 'el evento histórico de cantidad cero debe aparecer en Kardex sin alterar el stock del reporte');
    assert.equal(report.receivables.indebtedClients, 1); assert.equal(report.receivables.balance, '15.00'); assert.equal(report.receivables.overdue, '15.00');
    assert.equal(report.receivables.clients[0].clientName, 'Cliente con deuda'); assert.equal(report.receivables.clients[0].balance, '15.00');
    assert.doesNotMatch(JSON.stringify(report), /"(?:id|clientId|productId|cashSessionId|userId)"\s*:/i);
    const allData = await admin.request('/reports/connected'); assert.equal(allData.status, 200); assert.ok(allData.data.report.sales.count >= 3);
  });
  await t.test('una venta MySQL recién creada aparece en Reportes y en los rangos Hoy y Todo', async () => {
    const beforeResponse = await admin.request('/reports/connected'); assert.equal(beforeResponse.status, 200);
    const before = beforeResponse.data.report.sales;
    const [dbBefore] = await rows(pool, "SELECT COUNT(*) AS count, COALESCE(SUM(s.total), 0.00) AS total FROM sales s WHERE s.business_id = ? AND s.status = 'COMPLETED'", [business]);
    assert.equal(Number(dbBefore.count), before.count); assert.equal(Number(dbBefore.total), Number(before.total));
    const input = { items: [{ productId, quantity: '1.000' }], priceType: 'RETAIL', discountPercent: '0', paymentMethod: 'CARD' };
    const quote = await admin.request('/sales/quote', 'POST', input); assert.equal(quote.status, 200, JSON.stringify(quote.data));
    const created = await admin.request('/sales', 'POST', { ...input, detail: 'Venta nueva para verificar reportes', quoteToken: quote.data.quote.quoteToken, operationKey: randomUUID(), cashReceived: null });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const sale = created.data.sale;
    assert.equal(sale.businessId, business); assert.equal(sale.status, 'COMPLETED');
    const [stored] = await rows(pool, 'SELECT s.created_at AS createdAt, i.id AS itemId, m.id AS movementId, im.id AS inventoryMovementId FROM sales s JOIN sale_items i ON i.business_id = s.business_id AND i.sale_id = s.id LEFT JOIN cash_movements m ON m.business_id = s.business_id AND m.sale_id = s.id LEFT JOIN inventory_movements im ON im.business_id = s.business_id AND im.reference_type = \'sales\' AND im.reference_id = s.id WHERE s.business_id = ? AND s.id = ?', [business, sale.id]);
    assert.ok(stored.itemId); assert.ok(stored.movementId); assert.ok(stored.inventoryMovementId);
    assert.equal(new Date(sale.createdAt).toISOString(), new Date(stored.createdAt).toISOString());
    const all = await admin.request('/reports/connected'); assert.equal(all.status, 200);
    assert.equal(all.data.report.businessId, business);
    assert.equal(all.data.report.sales.count, before.count + 1);
    assert.equal(Number(all.data.report.sales.total), Number(before.total) + Number(sale.total));
    const [dbAfter] = await rows(pool, "SELECT COUNT(*) AS count, COALESCE(SUM(s.total), 0.00) AS total FROM sales s WHERE s.business_id = ? AND s.status = 'COMPLETED'", [business]);
    assert.equal(all.data.report.sales.count, Number(dbAfter.count)); assert.equal(Number(all.data.report.sales.total), Number(dbAfter.total));
    assert.ok(all.data.report.sales.history.some(row => row.invoiceNumber === sale.invoiceNumber));
    const today = new Date(), fromDate = new Date(today.getFullYear(), today.getMonth(), today.getDate()), untilDate = new Date(fromDate);
    untilDate.setDate(untilDate.getDate() + 1);
    const todayQuery = new URLSearchParams({ from: fromDate.toISOString(), until: untilDate.toISOString() });
    const todayReport = await admin.request('/reports/connected?' + todayQuery); assert.equal(todayReport.status, 200);
    assert.ok(todayReport.data.report.sales.history.some(row => row.invoiceNumber === sale.invoiceNumber));
    assert.ok(all.data.report.sales.history.some(row => row.invoiceNumber === sale.invoiceNumber), 'Todo debe incluir la venta nueva');
  });
  await t.test('permiso, sesión, rango y aislamiento por negocio son obligatorios', async () => {
    assert.equal((await anonymous.request('/reports/connected')).status, 401);
    assert.equal((await seller.request('/reports/connected')).status, 403);
    const otherReport = (await other.request('/reports/connected?from=2026-10-07T00%3A00%3A00.000Z&until=2026-10-08T00%3A00%3A00.000Z')).data.report;
    assert.equal(otherReport.sales.count, 0); assert.equal(otherReport.inventory.totalProducts, 0); assert.equal(otherReport.receivables.balance, '0.00');
    assert.equal((await admin.request('/reports/connected?from=not-a-date')).status, 400);
    assert.equal((await admin.request('/reports/connected?from=2026-10-08T00%3A00%3A00.000Z&until=2026-10-07T00%3A00%3A00.000Z')).status, 400);
  });
});
