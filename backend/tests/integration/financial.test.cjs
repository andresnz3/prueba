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

test('financial operations use only the isolated database', async t => {
  const config = readConfig(), authConfig = readAuthConfig({ CSRF_SECRET: randomBytes(32).toString('hex'), AUTH_RATE_MAX: '100' });
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 10 }); t.after(() => pool.end());
  const repo = createAuthRepository(pool, authConfig), auth = createAuthService(repo, authConfig);
  const business = String((await rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['Financial fixture'])).insertId);
  const password = 'Financial-test-password-123!', hash = await hashPassword(password), prefix = randomBytes(5).toString('hex');
  for (const [name, role] of [['admin', 'ADMIN'], ['second', 'ADMIN'], ['seller', 'VENDEDOR']]) await rows(pool, 'INSERT INTO users (business_id,username,full_name,password_hash,role) VALUES (?,?,?,?,?)', [business, prefix + name, name, hash, role]);
  const otherBusiness = String((await rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['Financial isolated business'])).insertId);
  await rows(pool, 'INSERT INTO users (business_id,username,full_name,password_hash,role) VALUES (?,?,?,?,?)', [otherBusiness, prefix + 'other', 'Other admin', hash, 'ADMIN']);
  const server = createApp({ config, checkDatabase: async () => {}, authentication: { repo, auth, config: authConfig, users: createUsersService(repo) } }).listen(0, '127.0.0.1');
  await new Promise(ok => server.once('listening', ok)); t.after(() => new Promise(ok => { server.close(ok); server.closeAllConnections(); }));
  async function client(name) {
    const jar = new Map(); let csrf;
    async function request(path, method = 'GET', body) {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/api' + path, { method, headers: { Cookie: [...jar].map(([key, value]) => key + '=' + value).join('; '), ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf || '' }) }, body: method === 'GET' ? undefined : JSON.stringify(body) });
      for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0], pos = pair.indexOf('='); jar.set(pair.slice(0, pos), pair.slice(pos + 1)); }
      const data = response.status === 204 ? null : await response.json(); if (data?.csrfToken) csrf = data.csrfToken;
      return { status: response.status, data };
    }
    await request('/auth/csrf'); assert.equal((await request('/auth/login', 'POST', { username: prefix + name, password })).status, 200);
    return request;
  }
  const admin = await client('admin'), second = await client('second'), seller = await client('seller'), other = await client('other');
  const cash = (await admin('/cash/sessions', 'POST', { operationKey: randomUUID(), openingAmount: '100.00' })).data.cash;
  const supplier = (await admin('/suppliers', 'POST', { name: 'Financial supplier ' + prefix, contact: 'Test', phone: '555', address: null, ruc: null })).data.supplier;
  const product = (await admin('/products', 'POST', { barcode: prefix, name: 'Financial product', category: 'General', cost: '2', retailPrice: '5', wholesalePrice: '4', marginRetail: '0', marginWholesale: '0', stock: '10', minStock: '0', taxRate: '0', image: null, active: true })).data.product;
  const resolve = (key, kind, who = admin) => who('/financial/operations/' + key + '/resolve', 'POST', { kind });
  const purchaseInput = () => ({ operationKey: randomUUID(), supplierId: supplier.id, supplierInvoiceNumber: null, purchaseType: 'CREDIT', dueDays: 30, items: [{ productId: product.id, quantity: '1.000', unitCost: '2.00' }] });
  let purchase, supplierPayment;
  await t.test('purchase, expense and supplier payment results recover without repeated writes', async () => {
    const data = purchaseInput(), created = await admin('/purchases', 'POST', data); assert.equal(created.status, 201, JSON.stringify(created.data)); purchase = created.data.purchase;
    assert.deepEqual((await resolve(data.operationKey, 'PURCHASE')).data, created.data);
    assert.deepEqual((await admin('/purchases', 'POST', data)).data, created.data);
    assert.equal((await resolve(data.operationKey, 'PURCHASE', second)).status, 404);
    assert.equal((await resolve(data.operationKey, 'PURCHASE', other)).data.kind, 'ABANDONED');
    assert.equal((await resolve(data.operationKey, 'PURCHASE', seller)).status, 403);
    assert.equal((await resolve(data.operationKey, 'EXPENSE')).status, 404);
    const expense = { operationKey: randomUUID(), category: 'Otro', description: 'Recovery fixture', amount: '1.00', paymentMethod: 'CASH', receiptReference: '' };
    const savedExpense = await admin('/expenses', 'POST', expense); assert.equal(savedExpense.status, 201, JSON.stringify(savedExpense.data));
    assert.deepEqual((await resolve(expense.operationKey, 'EXPENSE')).data, savedExpense.data);
    assert.deepEqual((await admin('/expenses', 'POST', expense)).data, savedExpense.data);
    const payment = { operationKey: randomUUID(), amount: '1.00', paymentMethod: 'CASH' };
    const savedPayment = await admin('/payables/' + purchase.id + '/payments', 'POST', payment); assert.equal(savedPayment.status, 201, JSON.stringify(savedPayment.data)); supplierPayment = savedPayment.data.payment;
    assert.deepEqual((await resolve(payment.operationKey, 'SUPPLIER_PAYMENT')).data, savedPayment.data);
    assert.deepEqual((await admin('/payables/' + purchase.id + '/payments', 'POST', payment)).data, savedPayment.data);
    assert.equal((await admin('/cash/current?full=true')).data.cash.expectedAmount, '98.00');
  });
  await t.test('discard is idempotent, scoped, and rejects delayed writes for every kind', async () => {
    const inputs = [
      ['PURCHASE', '/purchases', purchaseInput()],
      ['EXPENSE', '/expenses', { operationKey: randomUUID(), category: 'Otro', description: 'Must never commit', amount: '1.00', paymentMethod: 'CASH', receiptReference: '' }],
      ['SUPPLIER_PAYMENT', '/payables/' + purchase.id + '/payments', { operationKey: randomUUID(), amount: '0.50', paymentMethod: 'CASH' }]
    ];
    for (const [kind, path, data] of inputs) {
      const discarded = await resolve(data.operationKey, kind); assert.equal(discarded.data.kind, 'ABANDONED');
      assert.deepEqual((await resolve(data.operationKey, kind)).data, discarded.data);
      assert.equal((await admin(path, 'POST', data)).data.error.code, 'OPERATION_CONFLICT');
    }
    const [count] = await rows(pool, 'SELECT COUNT(*) AS count FROM purchases WHERE business_id=?', [business]); assert.equal(Number(count.count), 1);
  });
  await t.test('resolver racing a writer either recovers one commit or atomically discards it', async () => {
    const input = purchaseInput();
    const [write, recovered] = await Promise.all([admin('/purchases', 'POST', input), resolve(input.operationKey, 'PURCHASE')]);
    if (write.status === 201) assert.equal(recovered.data.purchase.id, write.data.purchase.id);
    else { assert.equal(write.data.error.code, 'OPERATION_CONFLICT'); assert.equal(recovered.data.kind, 'ABANDONED'); }
  });
  await t.test('cash payment reversals preserve closed sessions, restore debts and compensate once', async () => {
    const customer = (await admin('/clients', 'POST', { name: 'Financial customer ' + prefix, phone: '5551', ruc: null, address: null, creditLimit: '100.00', creditDays: 30 })).data.client;
    assert.ok(customer?.id);
    const input = { items: [{ productId: product.id, quantity: '1.000' }], priceType: 'RETAIL', discountPercent: '0', paymentMethod: 'CREDIT', clientId: customer.id };
    const quote = (await admin('/sales/quote', 'POST', input)).data.quote;
    const saved = await admin('/sales', 'POST', { ...input, operationKey: randomUUID(), quoteToken: quote.quoteToken, cashReceived: null, detail: 'Reversal fixture' }); assert.equal(saved.status, 201, JSON.stringify(saved.data));
    const sale = saved.data.sale;
    const received = await admin('/receivables/' + sale.id + '/payments', 'POST', { operationKey: randomUUID(), amount: '2.00', paymentMethod: 'CASH' }); assert.equal(received.status, 201); const payment = received.data.payment;
    assert.equal((await other('/financial/customer-payments/' + payment.id + '/reverse', 'POST', { operationKey: randomUUID(), reason: 'Wrong business' })).status, 404);
    assert.equal((await seller('/financial/customer-payments/' + payment.id + '/reverse', 'POST', { operationKey: randomUUID(), reason: 'No permission' })).status, 403);
    assert.equal((await admin('/financial/customer-payments/' + payment.id + '/reverse', 'POST', { operationKey: randomUUID(), reason: '   ' })).status, 400);
    const beforeClose = (await admin('/cash/current?full=true')).data.cash;
    assert.equal((await admin('/cash/sessions/' + beforeClose.id + '/close', 'POST', { operationKey: randomUUID(), countedAmount: beforeClose.expectedAmount })).status, 200);
    const [closedBefore] = await rows(pool, 'SELECT * FROM cash_sessions WHERE business_id=? AND id=?', [business, beforeClose.id]);
    assert.equal((await admin('/financial/customer-payments/' + payment.id + '/reverse', 'POST', { operationKey: randomUUID(), reason: 'Closed' })).data.error.code, 'CASH_CLOSED');
    await admin('/cash/sessions', 'POST', { operationKey: randomUUID(), openingAmount: '10.00' });
    const data = { operationKey: randomUUID(), reason: 'Wrong customer payment' }, path = '/financial/customer-payments/' + payment.id + '/reverse';
    const reversed = await admin(path, 'POST', data); assert.equal(reversed.status, 200, JSON.stringify(reversed.data)); assert.equal(reversed.data.payment.status, 'VOID');
    assert.deepEqual((await admin(path, 'POST', data)).data, reversed.data);
    assert.deepEqual((await resolve(data.operationKey, 'CUSTOMER_PAYMENT_VOID')).data, reversed.data);
    assert.equal((await admin(path, 'POST', { ...data, reason: 'Different body' })).data.error.code, 'OPERATION_CONFLICT');
    assert.equal((await admin(path, 'POST', { ...data, operationKey: randomUUID() })).data.error.code, 'PAYMENT_ALREADY_VOID');
    assert.equal((await admin('/cash/current?full=true')).data.cash.expectedAmount, '8.00');
    const statement = (await admin('/clients/' + customer.id + '/statement')).data;
    assert.equal(statement.client.debt, sale.total); assert.equal(statement.payments.find(p => p.id === payment.id).cancelReason, data.reason);
    const supplierReversal = await admin('/financial/supplier-payments/' + supplierPayment.id + '/reverse', 'POST', { operationKey: randomUUID(), reason: 'Returned supplier payment' }); assert.equal(supplierReversal.status, 200, JSON.stringify(supplierReversal.data));
    assert.equal((await admin('/cash/current?full=true')).data.cash.expectedAmount, '9.00');
    assert.equal((await admin('/payables/' + purchase.id)).data.purchase.balance, '2.00');
    const [closedAfter] = await rows(pool, 'SELECT * FROM cash_sessions WHERE business_id=? AND id=?', [business, beforeClose.id]); assert.deepEqual(closedAfter, closedBefore);
    const [count] = await rows(pool, "SELECT COUNT(*) AS count FROM cash_movements WHERE business_id=? AND reference_type='customer_payments' AND reference_id=? AND type='REVERSAL'", [business, payment.id]); assert.equal(Number(count.count), 1);
    const [audit] = await rows(pool, "SELECT details FROM audit_logs WHERE business_id=? AND action='CUSTOMER_PAYMENT_VOID' AND entity_id=?", [business, payment.id]); assert.equal((typeof audit.details === 'string' ? JSON.parse(audit.details) : audit.details).reason, data.reason);
    // Pending payments reserve debt; reversal releases it without changing physical cash.
    const pending = (await admin('/receivables/' + sale.id + '/payments', 'POST', { operationKey: randomUUID(), amount: '1.00', paymentMethod: 'CARD' })).data.payment;
    assert.equal((await admin('/financial/customer-payments/' + pending.id + '/reverse', 'POST', { operationKey: randomUUID(), reason: 'Cancel pending card' })).status, 200);
    assert.equal((await admin('/cash/current?full=true')).data.cash.expectedAmount, '9.00');
    const bank = (await admin('/receivables/' + sale.id + '/payments', 'POST', { operationKey: randomUUID(), amount: '1.00', paymentMethod: 'TRANSFER' })).data.payment;
    const overview = (await admin('/cash/overview')).data.overview;
    const bankMovement = overview.pendingPayments.find(p => p.kind === 'CUSTOMER_PAYMENT' && p.saleId === sale.id);
    assert.equal((await admin('/cash/payments/' + bankMovement.id + '/confirm', 'POST', { operationKey: randomUUID() })).status, 200);
    const bankPath = '/financial/customer-payments/' + bank.id + '/reverse';
    assert.equal((await admin(bankPath, 'POST', { operationKey: randomUUID(), reason: 'Bank refund' })).data.error.code, 'EXTERNAL_REFUND_REQUIRED');
    assert.equal((await admin(bankPath, 'POST', { operationKey: randomUUID(), reason: 'Bank refund', externalRefundConfirmed: true })).status, 200);
    assert.equal((await admin('/cash/current?full=true')).data.cash.expectedAmount, '9.00');
    // Failure after financial writes must roll back status, money, and operation key.
    const rollbackPayment = (await admin('/receivables/' + sale.id + '/payments', 'POST', { operationKey: randomUUID(), amount: '1.00', paymentMethod: 'CASH' })).data.payment;
    const originalAudit = repo.audit;
    repo.audit = async (...args) => { if (args[2] === 'CUSTOMER_PAYMENT_VOID') throw new Error('Injected audit failure'); return originalAudit(...args); };
    const rollbackKey = randomUUID();
    try { assert.equal((await admin('/financial/customer-payments/' + rollbackPayment.id + '/reverse', 'POST', { operationKey: rollbackKey, reason: 'Rollback' })).status, 500); }
    finally { repo.audit = originalAudit; }
    const [stillPosted] = await rows(pool, 'SELECT status FROM customer_payments WHERE business_id=? AND id=?', [business, rollbackPayment.id]); assert.equal(stillPosted.status, 'POSTED');
    assert.equal((await admin('/cash/current?full=true')).data.cash.expectedAmount, '10.00');
    assert.equal((await rows(pool, 'SELECT * FROM pos_operations WHERE business_id=? AND operation_key=?', [business, rollbackKey])).length, 0);
    const expense = await admin('/expenses', 'POST', { operationKey: randomUUID(), category: 'Otro', description: 'Drain for insufficient refund test', amount: '10.00', paymentMethod: 'CASH', receiptReference: '' });
    assert.equal(expense.status, 201);
    assert.equal((await admin('/financial/customer-payments/' + rollbackPayment.id + '/reverse', 'POST', { operationKey: randomUUID(), reason: 'Insufficient cash' })).data.error.code, 'CASH_REFUND_INSUFFICIENT');
    assert.equal((await admin('/expenses/' + expense.data.expense.id + '/cancel', 'POST', { operationKey: randomUUID(), reason: 'Restore fixture' })).status, 200);
    const refundInput = { operationKey: randomUUID(), reason: 'Concurrent reversal' };
    const refundPath = '/financial/customer-payments/' + rollbackPayment.id + '/reverse';
    const concurrent = await Promise.all([admin(refundPath, 'POST', refundInput), admin(refundPath, 'POST', { ...refundInput, operationKey: randomUUID() })]);
    assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]);
    assert.equal((await admin('/cash/current?full=true')).data.cash.expectedAmount, '9.00');
    const noncash = await admin('/payables/' + purchase.id + '/payments', 'POST', { operationKey: randomUUID(), amount: '0.50', paymentMethod: 'OTHER' });
    assert.equal(noncash.status, 201);
    const externalPath = '/financial/supplier-payments/' + noncash.data.payment.id + '/reverse';
    assert.equal((await admin(externalPath, 'POST', { operationKey: randomUUID(), reason: 'External refund' })).data.error.code, 'EXTERNAL_REFUND_REQUIRED');
    assert.equal((await admin(externalPath, 'POST', { operationKey: randomUUID(), reason: 'External refund', externalRefundConfirmed: true })).status, 200);
    assert.equal((await admin('/cash/current?full=true')).data.cash.expectedAmount, '9.00');
  });
  await t.test('manual cash validates permissions and balances, is idempotent, audited and included in close', async () => {
    const endpoint = '/financial/cash/movements', initial = (await admin('/cash/current?full=true')).data.cash;
    const data = { operationKey: randomUUID(), direction: 'IN', amount: '10.01', reason: 'Fondo adicional' };
    assert.equal((await seller(endpoint, 'POST', data)).status, 403);
    for (const invalid of [{ ...data, reason: '' }, { ...data, amount: '-1' }, { ...data, amount: '0' }, { ...data, amount: '1.001' }, { ...data, businessId: otherBusiness }]) assert.equal((await admin(endpoint, 'POST', invalid)).status, 400);
    const entry = await admin(endpoint, 'POST', data); assert.equal(entry.status, 201, JSON.stringify(entry.data));
    assert.equal(entry.data.expectedAmount, (Number(initial.expectedAmount) + 10.01).toFixed(2));
    assert.equal(entry.data.movement.userName, 'admin');
    assert.deepEqual((await admin(endpoint, 'POST', data)).data, entry.data);
    assert.deepEqual((await resolve(data.operationKey, 'CASH_MANUAL')).data, entry.data);
    assert.equal((await admin(endpoint, 'POST', { ...data, reason: 'Other body' })).data.error.code, 'OPERATION_CONFLICT');
    const beforeRejected = (await admin('/cash/current?full=true')).data.cash;
    assert.equal((await admin(endpoint, 'POST', { operationKey: randomUUID(), direction: 'OUT', amount: '9999.00', reason: 'Too much' })).data.error.code, 'CASH_BALANCE_INSUFFICIENT');
    assert.deepEqual((await admin('/cash/current?full=true')).data.cash, beforeRejected);
    const withdrawal = await admin(endpoint, 'POST', { operationKey: randomUUID(), direction: 'OUT', amount: '0.01', reason: 'Retiro de prueba' }); assert.equal(withdrawal.status, 201);
    const originalAudit = repo.audit;
    repo.audit = async (...args) => { if (args[2] === 'MANUAL_ENTRY') throw new Error('Injected cash audit failure'); return originalAudit(...args); };
    try { assert.equal((await admin(endpoint, 'POST', { ...data, operationKey: randomUUID() })).status, 500); }
    finally { repo.audit = originalAudit; }
    const current = (await admin('/cash/current?full=true')).data.cash;
    assert.equal(current.expectedAmount, (Number(initial.expectedAmount) + 10).toFixed(2));
    assert.ok(current.movements.some(m => String(m.id) === entry.data.movement.id && m.type === 'MANUAL_ENTRY' && m.description === data.reason && m.user_name === 'admin'));
    const [audit] = await rows(pool, "SELECT details FROM audit_logs WHERE business_id=? AND entity_id=? AND action='MANUAL_ENTRY'", [business, entry.data.movement.id]); assert.equal((typeof audit.details === 'string' ? JSON.parse(audit.details) : audit.details).amount, '10.01');
    const reportResponse = await admin('/reports/connected'); assert.equal(reportResponse.status, 200, JSON.stringify(reportResponse.data));
    const report = reportResponse.data.report;
    assert.ok(JSON.stringify(report).includes(data.reason));
    const closed = await admin('/cash/sessions/' + current.id + '/close', 'POST', { operationKey: randomUUID(), countedAmount: current.expectedAmount }); assert.equal(closed.status, 200); assert.equal(closed.data.cash.difference, '0.00');
    const [closedRow] = await rows(pool, 'SELECT * FROM cash_sessions WHERE business_id=? AND id=?', [business, current.id]);
    assert.equal((await admin(endpoint, 'POST', { ...data, operationKey: randomUUID() })).data.error.code, 'CASH_CLOSED');
    const newCash = await admin('/cash/sessions', 'POST', { operationKey: randomUUID(), openingAmount: '10.00' }); assert.equal(newCash.status, 201);
    // Two simultaneous full withdrawals cannot spend the same physical funds twice.
    const withdrawals = await Promise.all([1, 2].map(() => admin(endpoint, 'POST', { operationKey: randomUUID(), direction: 'OUT', amount: '10.00', reason: 'Concurrent cash exit' })));
    assert.deepEqual(withdrawals.map(r => r.status).sort(), [201, 409]);
    assert.equal((await admin('/cash/current?full=true')).data.cash.expectedAmount, '0.00');
    assert.deepEqual((await rows(pool, 'SELECT * FROM cash_sessions WHERE business_id=? AND id=?', [business, current.id]))[0], closedRow);
    // Simulate a close between entering the form and sending the movement.
    const active = (await admin('/cash/current?full=true')).data.cash;
    await admin('/cash/sessions/' + active.id + '/close', 'POST', { operationKey: randomUUID(), countedAmount: '0.00' });
    const late = await admin(endpoint, 'POST', { ...data, operationKey: randomUUID() }); assert.equal(late.data.error.code, 'CASH_CLOSED');
  });
  assert.ok(cash.id && supplierPayment.id);
});
