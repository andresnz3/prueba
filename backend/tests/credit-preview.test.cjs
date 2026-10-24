'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { reconcileCreditPackage, createSystemAdminCreditPreview } = require('../src/services/system-admin-credit-preview');
const { requireSystemAdmin } = require('../src/services/system-admin');
const realPath = path.resolve(__dirname, '../../prueba-compras.json');
function fixture() {
  return { type: 'pos_local_migration_package', version: 1, business: { name: 'Origen local' },
    data: { products: [{ id: 1, name: 'Producto', barcode: 'P1', cost: 1 }], clients: [{ id: 2, name: 'Diana', debt: 60, deudaSinFactura: 0 }], suppliers: [],
      sales: [{ id: '1791566528809.0999', numero: '14', clienteId: 2, cliente: 'Diana', metodo: 'Crédito', medioPago: 'credit', fechaTS: 1791566528809, vencimientoTS: 1794158528782, total: 100, anulada: false, items: [{ id: 1, name: 'Producto', cantidad: 1, retailPrice: 100 }] }],
      abonos: [{ id: '1791589247499.125', tipo: 'cliente', referenciaId: 2, facturaId: '1791566528809.0999', monto: 40, estado: 'pendiente', metodoPago: 'efectivo', fechaTS: 1791589247499, anulado: false }] } };
}
const codes = r => r.issues.filter(i => i.blocking).map(i => i.code);
function readOnlyRepo(overrides = {}) {
  const queries = [];
  return { pool: {}, queries, transaction() { throw Error('No transactions allowed'); }, audit() { throw Error('No audit writes'); },
    async rows(_db, sql, args) {
      queries.push({ sql, args });
      assert.match(sql, /^SELECT /);
      assert.doesNotMatch(sql, /FOR UPDATE|INSERT|UPDATE |DELETE|ALTER|CREATE/);
      if (!sql.includes('INFORMATION_SCHEMA')) assert.equal(args[0], '5', 'Every operational read is scoped to the authorized target');
      if (sql.includes('FROM businesses')) return overrides.business ?? [{ id: 5, name: 'Destino', status: 'ACTIVE' }];
      if (sql.includes('FROM clients')) return overrides.clients ?? [{ id: 22, name: 'Diana', opening_balance: '0.00' }];
      if (sql.includes('FROM products')) return overrides.products ?? [];
      if (sql.includes('FROM sales')) return overrides.sales ?? [];
      if (sql.includes('FROM customer_payments')) return overrides.payments ?? [];
      if (sql.includes('FROM audit_logs')) return overrides.audits ?? [];
      if (sql.includes('FROM users')) return overrides.users ?? [];
      if (sql.includes('INFORMATION_SCHEMA')) return overrides.tables ?? [{ tableName: 'migration_sales_references' }];
      if (sql.includes('FROM migration_sales_references')) return overrides.references ?? [];
      throw Error('Unexpected SELECT');
    } };
}
const admin = { username: 'andres', role: 'ADMIN', business_id: '1' };
test('partial payment applies despite pending cash state, preserves decimal IDs and dates, source immutable', () => {
  const p = fixture(), before = JSON.stringify(p), r = reconcileCreditPackage(p);
  assert.equal(r.financiallyConsistent, true);
  assert.deepEqual(r.totals, { invoices: 1, payments: 1, total: '100.00', paid: '40.00', balance: '60.00' });
  assert.equal(r.invoices[0].sourceSaleId, p.data.sales[0].id);
  assert.equal(r.payments[0].sourcePaymentId, p.data.abonos[0].id);
  assert.equal(r.invoices[0].dueAt, new Date(p.data.sales[0].vencimientoTS).toISOString());
  assert.equal(r.payments[0].originalStatus, 'pendiente');
  assert.equal(r.payments[0].appliesToDebt, true);
  assert.equal(r.canImport, false);
  assert.equal(JSON.stringify(p), before);
});
test('real package: Diana invoices 14/15/16 paid, total 106.10, no supplier payments', { skip: !fs.existsSync(realPath) }, () => {
  const r = reconcileCreditPackage(JSON.parse(fs.readFileSync(realPath, 'utf8')));
  assert.deepEqual(r.totals, { invoices: 3, payments: 3, total: '106.10', paid: '106.10', balance: '0.00' });
  assert.deepEqual(r.invoices.map(i => [i.invoiceNumber, i.clientName, i.status]), [['14', 'Diana', 'PAID'], ['15', 'Diana', 'PAID'], ['16', 'Diana', 'PAID']]);
  assert.equal(r.financiallyConsistent, true);
});
test('general payments allocate oldest invoices first independent of package order', () => {
  const p = fixture(); p.data.abonos[0].facturaId = undefined; p.data.abonos[0].monto = 120;
  p.data.sales.unshift({ ...p.data.sales[0], id: 'new.25', numero: '15', fechaTS: 1791566528810 }); p.data.clients[0].debt = 80;
  const r = reconcileCreditPackage(p);
  assert.equal(r.financiallyConsistent, true);
  assert.deepEqual(r.invoices.map(i => i.balance), ['80.00', '0.00']);
  assert.deepEqual(r.payments[0].allocations.map(i => i.amount), ['100.00', '20.00']);
});
test('void payments do not reduce debt and cancelled invoices do not create debt', () => {
  const p = fixture(); p.data.abonos[0].anulado = true; p.data.clients[0].debt = 100;
  let r = reconcileCreditPackage(p); assert.equal(r.totals.paid, '0.00'); assert.equal(r.financiallyConsistent, true);
  p.data.sales[0].anulada = true; p.data.clients[0].debt = 0;
  r = reconcileCreditPackage(p); assert.equal(r.invoices[0].status, 'CANCELLED'); assert.equal(r.totals.balance, '0.00'); assert.equal(r.financiallyConsistent, true);
});
for (const [label, change, code] of [
  ['overpayment', p => { p.data.abonos[0].monto = 101; }, 'OVERPAYMENT'],
  ['debt mismatch', p => { p.data.clients[0].debt = 0; }, 'BALANCE_MISMATCH'],
  ['opening debt', p => { p.data.clients[0].deudaSinFactura = 10; p.data.clients[0].debt = 70; }, 'OPENING_DEBT'],
  ['missing opening debt', p => { delete p.data.clients[0].deudaSinFactura; }, 'OPENING_DEBT_UNKNOWN'],
  ['duplicate invoice ID', p => { p.data.sales.push(structuredClone(p.data.sales[0])); }, 'DUPLICATE_SALE_ID'],
  ['duplicate invoice number', p => { p.data.sales.push({ ...p.data.sales[0], id: 'other.5' }); }, 'POSSIBLE_DUPLICATE_INVOICE'],
  ['duplicate payment ID', p => { p.data.abonos.push(structuredClone(p.data.abonos[0])); }, 'DUPLICATE_PAYMENT_ID'],
  ['duplicate payment content', p => { p.data.abonos.push({ ...p.data.abonos[0], id: 'other.25' }); }, 'POSSIBLE_DUPLICATE_PAYMENT'],
  ['orphan payment', p => { p.data.abonos[0].facturaId = 'missing'; }, 'INVALID_PAYMENT'],
  ['wrong client', p => { p.data.abonos[0].referenciaId = 3; }, 'CLIENT_REFERENCE'],
  ['bad amount', p => { p.data.abonos[0].monto = '1.001'; }, 'INVALID_PAYMENT'],
  ['negative amount', p => { p.data.abonos[0].monto = -1; }, 'INVALID_PAYMENT'],
  ['bad date', p => { p.data.abonos[0].fechaTS = 'invalid'; }, 'INVALID_PAYMENT'],
  ['bad sale total', p => { p.data.sales[0].total = 99; }, 'INVALID_SALE'],
  ['unallocated general payment', p => { delete p.data.abonos[0].facturaId; p.data.abonos[0].monto = 101; }, 'UNALLOCATED_GENERAL_PAYMENT']
]) test('blocks ' + label, () => { const p = fixture(); change(p); const r = reconcileCreditPackage(p); assert.ok(codes(r).includes(code), JSON.stringify(r.issues)); assert.equal(r.financiallyConsistent, false); assert.equal(r.canImport, false); });
test('unknown or absent payment collection fails closed', () => {
  const p = fixture(); delete p.data.abonos; assert.throws(() => reconcileCreditPackage(p), { publicCode: 'MIGRATION_PACKAGE_INVALID' });
});
test('destination inspection uses only scoped SELECTs and never writes even on repeated preview', async () => {
  const repo = readOnlyRepo(), service = createSystemAdminCreditPreview({ repo, requireSystemAdmin });
  const one = await service.preview(admin, '5', fixture()), two = await service.preview(admin, '5', fixture());
  assert.deepEqual(one, two); assert.equal(one.financiallyConsistent, true); assert.equal(one.clients[0].targetClientId, '22'); assert.ok(repo.queries.length > 0);
});
test('destination history, opening debt, imported references and other origins block for review', async () => {
  const p = fixture(), r = reconcileCreditPackage(p);
  const repo = readOnlyRepo({ clients: [{ id: 22, name: 'Diana', opening_balance: '60.00' }], sales: [{ client_id: 22 }], references: [{ source_business_key: r.sourceBusinessKey, source_sale_id: p.data.sales[0].id }], audits: [{ details: { sourceBusinessName: 'Otro negocio' } }] });
  const result = await createSystemAdminCreditPreview({ repo, requireSystemAdmin }).preview(admin, '5', p);
  for (const code of ['OTHER_ORIGIN', 'TARGET_OPENING_BALANCE', 'TARGET_FINANCIAL_HISTORY', 'ALREADY_IMPORTED']) assert.ok(codes(result).includes(code));
  assert.equal(result.invoices[0].alreadyImported, true); assert.equal(result.canImport, false);
});
test('missing reference table requires no SQL migration for preview', async () => {
  const repo = readOnlyRepo({ tables: [] });
  assert.equal((await createSystemAdminCreditPreview({ repo, requireSystemAdmin }).preview(admin, '5', fixture())).previewOnly, true);
  assert.equal(repo.queries.some(q => q.sql.includes('FROM migration_sales_references')), false);
});
test('permissions, destination activity and ambiguous clients fail closed', async () => {
  const repo = readOnlyRepo(), service = createSystemAdminCreditPreview({ repo, requireSystemAdmin });
  await assert.rejects(service.preview({ ...admin, business_id: '5' }, '5', fixture()), { publicCode: 'SYSTEM_ADMIN_REQUIRED' });
  assert.equal(repo.queries.length, 0);
  await assert.rejects(service.preview(admin, '5 OR 1', fixture()), { publicCode: 'INVALID_INPUT' });
  await assert.rejects(createSystemAdminCreditPreview({ repo: readOnlyRepo({ business: [] }), requireSystemAdmin }).preview(admin, '5', fixture()), { publicCode: 'BUSINESS_NOT_FOUND' });
  await assert.rejects(createSystemAdminCreditPreview({ repo: readOnlyRepo({ business: [{ status: 'INACTIVE' }] }), requireSystemAdmin }).preview(admin, '5', fixture()), { publicCode: 'MIGRATION_TARGET_INACTIVE' });
  assert.ok(codes(await createSystemAdminCreditPreview({ repo: readOnlyRepo({ clients: [{ id: 1, name: 'Diana' }, { id: 2, name: 'Diana' }] }), requireSystemAdmin }).preview(admin, '5', fixture())).includes('TARGET_CLIENT'));
});
test('API compaction preserves credit evidence, decimal identifiers, dates and debts, strips images, fits body limit', async () => {
  const p = fs.existsSync(realPath) ? JSON.parse(fs.readFileSync(realPath, 'utf8')) : fixture(), before = JSON.stringify(p);
  const requests = [];
  const sandbox = { window: {}, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, fetch: async (url, options) => {
    if (url.endsWith('/auth/me')) return { ok: true, status: 200, json: async () => ({ csrfToken: 'A'.repeat(43), expiresAt: '2030-01-01T00:00:00Z', user: { id: '7', businessId: '1', username: 'andres', fullName: 'Admin', role: 'ADMIN', active: true } }) };
    assert.equal(url, 'https://example.test/api/system-admin/migration/credit/preview');
    const body = JSON.parse(options.body); requests.push(body);
    assert.ok(Buffer.byteLength(options.body) < 16384, 'body bytes ' + Buffer.byteLength(options.body));
    const r = await createSystemAdminCreditPreview({ repo: readOnlyRepo(), requireSystemAdmin }).preview(admin, body.targetBusinessId, body.package);
    return { ok: true, status: 200, json: async () => r };
  } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../api-client.js'), 'utf8'), sandbox);
  const client = new sandbox.window.PosApiClient('https://example.test/api'); await client.me();
  const r = await client.previewCreditMigration('5', p), expected = reconcileCreditPackage(p);
  assert.deepEqual(r.totals, expected.totals); assert.deepEqual(r.invoices.map(i => i.dueAt), expected.invoices.map(i => i.dueAt));
  assert.deepEqual(r.invoices.map(i => i.sourceSaleId), expected.invoices.map(i => i.sourceSaleId));
  assert.equal(r.canImport, false); assert.equal(JSON.stringify(p), before);
  assert.equal(JSON.stringify(requests[0]).includes('data:image'), false);
});

test('HTTP preview endpoint enforces owner session, system admin, CSRF and strict body', async t => {
  const express = require('../node_modules/express');
  const { systemAdminRoutes } = require('../src/routes/system-admin');
  const { errorHandler } = require('../src/middleware/errors');
  const { hashToken, sessionCsrf } = require('../src/services/tokens');
  const repo = readOnlyRepo(), token = 'B'.repeat(43), secret = 'C'.repeat(64);
  let owner = { ...admin, user_id: '7', token_hash: hashToken(token) };
  repo.session = async hash => hash === hashToken(token) ? owner : null;
  const app = express(); app.use(express.json({ limit: 16384 }));
  app.use('/api', systemAdminRoutes({ repo, config: { cookieName: 'pos_session', supportCookieName: 'pos_support', secret, production: true } }));
  app.use((_req, res) => res.sendStatus(404)); app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port + '/api/system-admin/migration/credit';
  const headers = { 'Content-Type': 'application/json', Cookie: 'pos_session=' + token, 'X-CSRF-Token': sessionCsrf(secret, hashToken(token)) };
  const request = (suffix, body, nextHeaders = headers) => fetch(base + suffix, { method: 'POST', headers: nextHeaders, body: JSON.stringify(body) });
  const body = { targetBusinessId: '5', package: fixture() };
  let res = await request('/preview', body); assert.equal(res.status, 200); assert.equal((await res.json()).canImport, false);
  assert.equal((await request('', body)).status, 500, 'la ruta de importación existe, pero el repositorio de esta prueba no permite transacciones');
  assert.equal((await request('/preview', body, { 'Content-Type': 'application/json' })).status, 401);
  assert.equal((await request('/preview', body, { ...headers, 'X-CSRF-Token': 'invalid' })).status, 403);
  assert.equal((await request('/preview', { ...body, confirmImport: true })).status, 400);
  owner = { ...owner, business_id: '5' }; const before = repo.queries.length;
  assert.equal((await request('/preview', body)).status, 403); assert.equal(repo.queries.length, before);
});

test('invoice dates reject ambiguous locale strings, bad payment references and cross-client links block', () => {
  const p = fixture(); p.data.sales[0].fechaTS = '9/10/2026';
  assert.ok(codes(reconcileCreditPackage(p)).includes('INVALID_SALE'));
  const q = fixture(); q.data.abonos[0].facturaId = { invalid: true };
  assert.ok(codes(reconcileCreditPackage(q)).includes('PAYMENT_REFERENCE'));
  const r = fixture(); r.data.clients.push({ id: 3, name: 'Otro', debt: 0, deudaSinFactura: 0 }); r.data.abonos[0].referenciaId = 3;
  assert.ok(codes(reconcileCreditPackage(r)).includes('INVALID_PAYMENT'));
});
test('a client with only opening debt is included and blocked for historical representation', () => {
  const p = fixture(); p.data.sales = []; p.data.abonos = []; p.data.clients[0].debt = 60; p.data.clients[0].deudaSinFactura = 60;
  const r = reconcileCreditPackage(p); assert.equal(r.clients[0].calculatedDebt, '60.00'); assert.ok(codes(r).includes('OPENING_DEBT')); assert.equal(r.canImport, false);
});

test('negative reconciliation differences retain sign for cent amounts', () => {
  const p = fixture(); p.data.clients[0].debt = '59.99';
  assert.equal(reconcileCreditPackage(p).clients[0].difference, '-0.01');
});
