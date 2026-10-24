'use strict';
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { createSystemAdminCreditPreview } = require('../backend/src/services/system-admin-credit-preview');
const { requireSystemAdmin } = require('../backend/src/services/system-admin');
const realPath = path.resolve(__dirname, '../prueba-compras.json');
function fixture() {
  return { type: 'pos_local_migration_package', version: 1, business: { name: 'Origen local' }, summary: { products: 1, clients: 1, suppliers: 0, sales: 1, purchases: 0, abonos: 1 },
    data: { products: [{ id: 1, name: 'Producto', barcode: 'P1', cost: 1 }], clients: [{ id: 2, name: 'Diana', debt: 60, deudaSinFactura: 0 }], suppliers: [], purchases: [],
      sales: [{ id: '1791566528809.0999', numero: 14, clienteId: 2, cliente: 'Diana', metodo: 'Crédito', medioPago: 'credit', fechaTS: 1791566528809, vencimientoTS: 1794158528782, total: 100, anulada: false, items: [{ id: 1, name: 'Producto', cantidad: 1, retailPrice: 100 }] }],
      abonos: [{ id: '1791589247499.125', tipo: 'cliente', referenciaId: 2, facturaId: '1791566528809.0999', monto: 40, estado: 'pendiente', metodoPago: 'efectivo', fechaTS: 1791589247499, anulado: false }] } };
}
async function setup(page, { otherOrigin = false, fail = false, delayed = false, missingSchema = false, targetClients = [{ id: 22, name: 'Diana', opening_balance: '0.00' }] } = {}) {
  const requests = [], errors = []; page.on('pageerror', error => errors.push(error.message));
  let finish;
  const repo = { pool: {}, async rows(_db, sql, args) {
    expect(sql).toMatch(/^SELECT /);
    if (!sql.includes('INFORMATION_SCHEMA')) expect(['5', '6']).toContain(args[0]);
    if (sql.includes('INFORMATION_SCHEMA')) {
      if (missingSchema) return [];
      if (sql.includes('.COLUMNS')) return [
        { tableName: 'sales', columnName: 'is_historical' },
        { tableName: 'customer_payments', columnName: 'is_historical' },
        { tableName: 'customer_payments', columnName: 'source_status' },
        { tableName: 'migration_sales_references', columnName: 'source_client_id' },
        { tableName: 'migration_sales_references', columnName: 'source_invoice_number' },
        { tableName: 'migration_credit_payment_references', columnName: 'source_client_id' }
      ];
      return [{ tableName: 'migration_sales_references' }, { tableName: 'migration_credit_payment_references' }];
    }
    if (sql.includes('FROM businesses')) return [{ id: args[0], name: 'Destino de revisión', status: 'ACTIVE' }];
    if (sql.includes('FROM clients')) return targetClients;
    if (sql.includes('FROM audit_logs') && otherOrigin) return [{ details: { sourceBusinessName: 'Otro origen' } }];
    return [];
  }, transaction() { throw Error('No writes'); } };
  const service = createSystemAdminCreditPreview({ repo, requireSystemAdmin });
  await page.route('**/api/auth/me', route => route.fulfill({ json: { csrfToken: 'A'.repeat(43), expiresAt: '2030-01-01T00:00:00Z', user: { id: '7', businessId: '1', username: 'andres', fullName: 'Admin', role: 'ADMIN', active: true } } }));
  await page.route('**/api/system-admin/migration/**', async route => {
    const request = route.request(); requests.push(request.url());
    expect(request.url()).toMatch(/\/credit\/preview$/);
    if (fail) return route.fulfill({ status: 503, json: { error: { code: 'DATABASE_UNAVAILABLE', message: 'Destino no disponible' } } });
    const body = request.postDataJSON();
    const result = await service.preview({ username: 'andres', role: 'ADMIN', business_id: '1' }, body.targetBusinessId, body.package);
    result.gates = { schema: !missingSchema };
    if (missingSchema) result.issues.push({ code: 'MIGRATION_CREDIT_SCHEMA_REQUIRED', message: 'Falta la migración SQL 010 de créditos históricos.', blocking: true });
    if (delayed && body.targetBusinessId === '5') await new Promise(resolve => { finish = resolve; });
    await route.fulfill({ json: result });
  });
  await page.goto('/');
  await page.evaluate(async () => {
    document.getElementById('loginScreen').classList.add('hidden'); document.getElementById('app').classList.remove('hidden');
    document.querySelectorAll('.view-panel').forEach(panel => panel.classList.add('hidden'));
    document.getElementById('systemAdminView').classList.remove('hidden');
    const panel = document.getElementById('systemAdminMigrationPanel'); panel.classList.remove('hidden'); panel.setAttribute('aria-hidden', 'false');
    const api = new window.PosApiClient(location.origin + '/api'); await api.me();
    window.PosMigrationPreview.show({ canAccess: () => true, businesses: [{ id: '5', name: 'Destino de revisión', status: 'ACTIVE' }, { id: '6', name: 'Otro destino', status: 'ACTIVE' }], previewCredit: (id, pkg) => api.previewCreditMigration(id, pkg) });
  });
  await page.locator('#migrationBusiness').selectOption('5');
  return { requests, errors, finish: () => finish?.() };
}
function requestedCreditFixture() {
  const invoice = (id, number, clientId, clientName, total, date) => ({ id, numero: number, clienteId: clientId, cliente: clientName, metodo: 'Crédito', medioPago: 'credit', fechaTS: date, total, anulada: false, items: [{ id: 1, name: 'Producto', cantidad: 1, retailPrice: total }] });
  const payment = (id, saleId, clientId, amount, date) => ({ id, tipo: 'cliente', referenciaId: clientId, facturaId: saleId, monto: amount, estado: 'pendiente', metodoPago: 'efectivo', fechaTS: date, anulado: false });
  return { type: 'pos_local_migration_package', version: 1, business: { name: 'Origen local' }, summary: { products: 1, clients: 2, suppliers: 0, sales: 4, purchases: 0, abonos: 3 },
    data: { products: [{ id: 1, name: 'Producto', barcode: 'P1', cost: 1 }], clients: [{ id: 2, name: 'Diana', debt: 0, deudaSinFactura: 0 }, { id: 4, name: 'Anderson', debt: 74.8, deudaSinFactura: 0 }], suppliers: [], purchases: [],
      sales: [invoice('sale-diana-14-original', 14, 2, 'Diana', 25, 1791566528809), invoice('sale-diana-15-original', 15, 2, 'Diana', 43.7, 1791568268165), invoice('sale-diana-16-original', 16, 2, 'Diana', 37.4, 1791568270913), invoice('sale-anderson-28-original', 28, 4, 'Anderson', 74.8, 1791569000000)],
      abonos: [payment('payment-diana-14-original', 'sale-diana-14-original', 2, 25, 1791589247499), payment('payment-diana-15-original', 'sale-diana-15-original', 2, 43.7, 1791589262785), payment('payment-diana-16-original', 'sale-diana-16-original', 2, 37.4, 1791589274443)] } };
}
async function upload(page, value) {
  await page.locator('#migrationPackageFile').setInputFiles({ name: 'creditos.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
}
for (const width of [1440, 390]) test('real package credit preview, decimal IDs and paid invoices at ' + width, async ({ page }) => {
  test.skip(!fs.existsSync(realPath), 'Local real package is unavailable');
  await page.setViewportSize({ width, height: 1000 });
  const { requests, errors } = await setup(page);
  await upload(page, JSON.parse(fs.readFileSync(realPath, 'utf8')));
  await expect(page.locator('#migrationCreditStatus')).toContainText('sin diferencias');
  await expect(page.locator('#migrationCreditTotals')).toHaveText('3 facturas · 3 abonos · Total C$106.10 · Aplicado C$106.10 · Saldo C$0.00');
  await expect(page.locator('#migrationCreditInvoices tr')).toHaveCount(3);
  for (const id of ['1791566528809.0999', '1791568268165.8977', '1791568270913.1567']) await expect(page.locator('#migrationCreditInvoices')).toContainText(id);
  await expect(page.locator('#migrationCreditInvoices td').filter({ hasText: /^Pagada$/ })).toHaveCount(3);
  await page.getByText('Ver abonos y su distribución', { exact: true }).click();
  await expect(page.locator('#migrationCreditPayments tr')).toHaveCount(3);
  await expect(page.locator('#migrationCreditPayments')).toContainText('pendiente');
  await expect(page.locator('#migrationCreditPayments')).toContainText('Aplicado históricamente');
  await expect(page.locator('#migrationCreditImportBtn')).toBeDisabled();
  await page.locator('#migrationCreditRefreshBtn').click(); await expect(page.locator('#migrationCreditStatus')).toContainText('sin diferencias');
  expect(requests).toHaveLength(2); expect(errors).toEqual([]);
  const region = page.getByRole('region', { name: 'Facturas de crédito históricas', exact: true });
  await region.focus(); await expect(region).toBeFocused();
  const size = await region.evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
  if (width === 390) expect(size.scroll).toBeGreaterThan(size.client);
  await page.locator('#migrationCreditSummary').screenshot({ path: path.join(require('node:os').tmpdir(), 'pos-credit-preview-' + width + '.png') });
});
test('financial errors and other origin remain blocked; source text is rendered safely', async ({ page }) => {
  const { requests, errors } = await setup(page, { otherOrigin: true });
  const p = fixture(); p.data.clients[0].debt = 0; p.data.sales[0].numero = '<img src=x onerror=alert(1)>';
  await upload(page, p);
  await expect(page.locator('#migrationCreditStatus')).toContainText('bloqueada');
  await expect(page.locator('#migrationCreditIssues')).toContainText('no coinciden');
  await expect(page.locator('#migrationCreditIssues')).toContainText('otro origen');
  await expect(page.locator('#migrationCreditImportBtn')).toBeDisabled();
  await expect(page.locator('#migrationCreditInvoices img')).toHaveCount(0);
  expect(requests).toHaveLength(1); expect(errors).toEqual([]);
});
for (const width of [1440, 768, 390]) test('groups historical payment notices and preserves requested credit reconciliation at ' + width, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : width === 768 ? 1024 : 960 });
  const { errors } = await setup(page, { missingSchema: true, targetClients: [{ id: 22, name: 'Diana', opening_balance: '0.00' }, { id: 23, name: 'Anderson', opening_balance: '0.00' }] });
  const packageValue = requestedCreditFixture();
  await upload(page, packageValue);
  await expect(page.locator('#migrationCreditStatus')).toHaveAttribute('data-state', 'blocked');
  await expect(page.locator('#migrationCreditStatus')).toContainText('falta SQL 010');
  await expect(page.getByText(/SQL 010/)).toHaveCount(1);
  await expect(page.locator('#migrationCreditTotals')).toHaveText('4 facturas · 3 abonos · Total C$180.90 · Aplicado C$106.10 · Saldo C$74.80');
  await expect(page.locator('#migrationCreditInvoices tr')).toHaveCount(4);
  await expect(page.locator('#migrationCreditInvoices')).toContainText('Diana');
  await expect(page.locator('#migrationCreditInvoices')).toContainText('Anderson');
  await expect(page.locator('#migrationCreditInvoices')).toContainText('28');
  await expect(page.locator('#migrationCreditInvoices tr').filter({ hasText: 'Diana' }).locator('td').filter({ hasText: /^Pagada$/ })).toHaveCount(3);
  await expect(page.locator('#migrationCreditInvoices tr').filter({ hasText: 'Anderson' })).toContainText('C$74.80');
  await expect(page.locator('#migrationCreditInvoices tr').filter({ hasText: 'Anderson' })).toContainText('Pendiente');
  await expect(page.locator('#migrationCreditIssues > li')).toHaveCount(1);
  await expect(page.locator('#migrationCreditIssues')).toContainText('3 abonos históricos pendientes en caja local ya están aplicados a la deuda');
  const groupedDetails = page.locator('#migrationCreditIssues .migration-credit-issue-details');
  expect(await groupedDetails.evaluate(details => details.open)).toBe(false);
  await groupedDetails.locator('summary').click();
  for (const id of ['payment-diana-14-original', 'payment-diana-15-original', 'payment-diana-16-original']) await expect(groupedDetails).toContainText(id);
  await expect(groupedDetails).toContainText('Estado original: pendiente');
  await expect(page.locator('#migrationCreditImportBtn')).toBeDisabled();
  await page.getByText('Ver abonos y su distribución', { exact: true }).click();
  await expect(page.locator('#migrationCreditPayments tr')).toHaveCount(3);
  await expect(page.locator('#migrationCreditPayments')).toContainText('pendiente');
  await page.getByText('Ver conciliación por cliente', { exact: true }).click();
  await expect(page.locator('#migrationCreditClients tr')).toHaveCount(2);
  await expect(page.locator('#migrationCreditClients')).toContainText('Anderson');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(errors).toEqual([]);
  await page.locator('#migrationCreditSummary').screenshot({ path: path.join(require('node:os').tmpdir(), 'pos-credit-reconciliation-' + width + '.png') });
});
test('destination read failure never enables import or retains results', async ({ page }) => {
  await setup(page, { fail: true }); await upload(page, fixture());
  await expect(page.locator('#migrationCreditStatus')).toHaveAttribute('data-state', 'invalid');
  await expect(page.locator('#migrationCreditInvoices tr')).toHaveCount(0);
  await expect(page.locator('#migrationCreditImportBtn')).toBeDisabled();
});
test('stale response cannot restore an old destination after selection change or reset', async ({ page }) => {
  const state = await setup(page, { delayed: true }); await upload(page, fixture());
  await expect.poll(() => state.requests.length).toBe(1);
  await page.locator('#migrationBusiness').selectOption('6');
  await expect(page.locator('#migrationCreditInvoices tr')).toHaveCount(0);
  state.finish();
  await expect(page.locator('#migrationCreditStatus')).toContainText('sin diferencias');
  expect(state.requests).toHaveLength(2);
  await page.evaluate(() => window.PosMigrationPreview.reset());
  state.finish();
  await expect(page.locator('#migrationCreditSummary')).toBeHidden();
});
