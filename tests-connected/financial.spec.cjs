'use strict';
const { test, expect } = require('@playwright/test');
const { randomUUID } = require('node:crypto');
const password = 'Browser-fixture-password-123!';
test.beforeEach(async ({ page, context }) => {
  await context.addInitScript({ path: require.resolve('../tests/dexie-search-shim.js') });
  await page.route('https://**/*', route => route.abort());
  await page.goto('/?mode=connected');
  await page.locator('#loginUsername').fill('browseradmin'); await page.locator('#loginPassword').fill(password);
  await page.locator('#loginForm button[type=submit]').click(); await expect(page.locator('#app')).toBeVisible();
});
async function call(page, method, ...args) {
  return page.evaluate(async ({ method, args }) => { const api = new window.PosApiClient(window.POS_API_BASE_URL); await api.me(); return api[method](...args); }, { method, args });
}
async function closeAlert(page) {
  await page.locator('#customAlertModal .close-modal-btn').click(); await expect(page.locator('#customAlertModal')).toBeHidden();
}
async function setup(page) {
  const suffix = randomUUID().slice(0, 8);
  if (!await call(page, 'currentCash', true)) await call(page, 'openCash', { operationKey: randomUUID(), openingAmount: '100.00' });
  const supplier = await call(page, 'createSupplier', { name: 'Recovery supplier ' + suffix, contact: 'Test', phone: suffix, address: null, ruc: null });
  const product = await call(page, 'createProduct', { barcode: suffix, name: 'Recovery product ' + suffix, category: 'General', cost: '2.00', retailPrice: '5.00', wholesalePrice: '4.00', marginRetail: '0', marginWholesale: '0', stock: '10.000', minStock: '0.000', taxRate: '0', image: null, active: true });
  return { supplier, product };
}
async function submitPurchase(page, supplier, product) {
  await page.locator('#navPurchasesBtn').click(); await expect(page.locator('#purchasesView')).toBeVisible();
  await page.locator('#addNewPurchaseBtn').click(); await page.locator('#purchSupplier').fill(supplier.name); await page.locator('#purchType').selectOption('credito');
  await page.locator('#purchDays').fill('30'); await page.locator('#purchProductTemp').fill(product.name); await page.locator('#purchQtyTemp').fill('1'); await page.locator('#purchCostTemp').fill('2');
  await page.locator('#btnAddItemToPurch').click(); await page.locator('#purchaseForm button[type=submit]').click();
}
for (const kind of ['PURCHASE', 'EXPENSE', 'SUPPLIER_PAYMENT']) test('persistent recovery after committed response loss: ' + kind, async ({ page }) => {
  const { supplier, product } = await setup(page);
  let purchase;
  if (kind === 'SUPPLIER_PAYMENT') purchase = await call(page, 'createPurchase', { operationKey: randomUUID(), supplierId: supplier.id, supplierInvoiceNumber: null, purchaseType: 'CREDIT', dueDays: 30, items: [{ productId: product.id, quantity: '1.000', unitCost: '2.00' }] });
  const path = kind === 'PURCHASE' ? '/purchases' : kind === 'EXPENSE' ? '/expenses' : '/payables/' + purchase.id + '/payments';
  const url = process.env.POS_TEST_API + path; let writes = 0, committed;
  await page.route(url, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    writes++; const response = await route.fetch(); expect(response.status()).toBe(201); committed = await response.json(); await route.abort();
  });
  if (kind === 'PURCHASE') await submitPurchase(page, supplier, product);
  if (kind === 'EXPENSE') {
    await page.locator('#navGastosBtn').click(); await expect(page.locator('#gastosView')).toBeVisible();
    await page.locator('#gastoCategoria').selectOption('Otro'); await page.locator('#gastoMetodo').selectOption('banco');
    await page.locator('#gastoDescripcion').fill('Lost expense ' + supplier.id); await page.locator('#gastoMonto').fill('1'); await page.locator('#formRegistrarGasto button[type=submit]').click();
  }
  if (kind === 'SUPPLIER_PAYMENT') {
    await page.locator('#navPayablesBtn').click(); await expect(page.locator('#payablesView')).toBeVisible();
    await page.evaluate(id => window.PosPurchases.openInvoicePayment(id), purchase.id);
    await page.locator('#payInvoiceMethod').selectOption('efectivo'); await page.locator('#payInvoiceAmount').fill('1'); await page.locator('#paymentInvoiceForm button[type=submit]').click();
  }
  await expect(page.locator('#customAlertMessage')).toContainText('Comprueba'); await closeAlert(page);
  const marker = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('posOperation_')));
  expect(marker).toHaveLength(1); expect(Object.keys(JSON.parse(marker[0][1])).sort()).toEqual(['key', 'kind']); expect(JSON.parse(marker[0][1]).kind).toBe(kind);
  await page.reload(); await expect(page.locator('#app')).toBeVisible(); await expect(page.locator('#recoverSaleBtn')).toBeVisible();
  // Even a different financial action must not issue a second write until recovery.
  await page.evaluate(() => window.PosSales.performFinancial('EXPENSE', {}, api => api.createExpense({})));
  await expect(page.locator('#customAlertMessage')).toContainText('pendiente'); await closeAlert(page); expect(writes).toBe(1);
  await page.locator('#recoverSaleBtn').click(); await expect(page.locator('#recoverSaleBtn')).toBeHidden(); await expect(page.locator('#customAlertModal')).toBeVisible();
  expect(writes).toBe(1);
  if (kind === 'PURCHASE') expect((await call(page, 'purchases')).filter(value => value.id === committed.purchase.id)).toHaveLength(1);
  if (kind === 'EXPENSE') expect((await call(page, 'expenses')).expenses.filter(value => value.id === committed.expense.id)).toHaveLength(1);
  if (kind === 'SUPPLIER_PAYMENT') expect((await call(page, 'payable', purchase.id)).balance).toBe('1.00');
  expect(await page.evaluate(() => localDB)).toBeNull();
});
test('discard unsent expense survives reload and prevents a late write', async ({ page }) => {
  const url = process.env.POS_TEST_API + '/expenses'; let body;
  await page.route(url, route => { body = route.request().postDataJSON(); return route.abort(); });
  await page.evaluate(() => window.PosSales.performFinancial('EXPENSE', { category: 'Otro', description: 'Unsent', amount: '1', paymentMethod: 'BANK', receiptReference: '' }, async (api, input) => ({ kind: 'EXPENSE', expense: await api.createExpense(input) })));
  await closeAlert(page); await page.reload(); await expect(page.locator('#app')).toBeVisible(); await page.locator('#recoverSaleBtn').click();
  await expect(page.locator('#customAlertMessage')).toContainText('descartada'); await expect(page.locator('#recoverSaleBtn')).toBeHidden();
  await page.unroute(url);
  expect(await page.evaluate(async body => { const api = new window.PosApiClient(window.POS_API_BASE_URL); await api.me(); try { await api.createExpense(body); } catch (error) { return error.code; } }, body)).toBe('OPERATION_CONFLICT');
});
test('customer cash reversal requires reason, recovers a lost response and preserves its receipt', async ({ page }) => {
  const { product, supplier } = await setup(page);
  const client = await call(page, 'createClient', { name: 'Reversal client ' + supplier.id, phone: '555' + supplier.id, ruc: null, address: null, creditLimit: '100.00', creditDays: 30 });
  const input = { items: [{ productId: product.id, quantity: '1.000' }], priceType: 'RETAIL', discountPercent: '0', paymentMethod: 'CREDIT', clientId: client.id };
  const quote = await call(page, 'quoteSale', input);
  const sale = (await call(page, 'createSale', { ...input, operationKey: randomUUID(), quoteToken: quote.quoteToken, cashReceived: null, detail: 'Reversal browser' })).sale;
  const paid = (await call(page, 'payReceivable', sale.id, { operationKey: randomUUID(), amount: '1.00', paymentMethod: 'CASH' })).payment;
  const before = await call(page, 'currentCash', true);
  await page.locator('#navClientsBtn').click(); await expect(page.locator('#clientsView')).toBeVisible();
  const row = page.locator('#clientsTableBody tr').filter({ hasText: client.name }); await row.getByRole('button', { name: 'Historial', exact: true }).click();
  await page.locator('#statementTableBody').getByRole('button', { name: 'Revertir abono' }).click();
  await page.locator('#anularRegistroForm button[type=submit]').click();
  await expect(page.locator('#anularRegistroModal')).toBeVisible();
  // Existing dialog may use native required validation; no financial request has been sent.
  expect((await call(page, 'clientStatement', client.id)).payments.find(p => p.id === paid.id).status).toBe('POSTED');
  await page.locator('#anularRegistroMotivo').fill('Abono duplicado en captura');
  let reversals = 0;
  const url = process.env.POS_TEST_API + '/financial/customer-payments/' + paid.id + '/reverse';
  await page.route(url, async route => { reversals++; const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort(); });
  await page.locator('#anularRegistroForm button[type=submit]').click(); await expect(page.locator('#customAlertMessage')).toContainText('Comprueba'); await closeAlert(page);
  await page.reload(); await expect(page.locator('#app')).toBeVisible(); await page.locator('#recoverSaleBtn').click(); await expect(page.locator('#customAlertMessage')).toContainText('Abono revertido');
  expect(reversals).toBe(1); expect(Number((await call(page, 'currentCash', true)).expectedAmount)).toBe(Number(before.expectedAmount) - 1);
  const statement = await call(page, 'clientStatement', client.id); expect(statement.client.debt).toBe(sale.total); expect(statement.payments.find(p => p.id === paid.id)).toMatchObject({ status: 'VOID', cancelReason: 'Abono duplicado en captura', cancelledByName: 'browseradmin' });
});
test('supplier payment reversal from statement restores invoice debt and cash', async ({ page }) => {
  const { supplier, product } = await setup(page);
  const purchase = await call(page, 'createPurchase', { operationKey: randomUUID(), supplierId: supplier.id, supplierInvoiceNumber: null, purchaseType: 'CREDIT', dueDays: 30, items: [{ productId: product.id, quantity: '1.000', unitCost: '2.00' }] });
  await call(page, 'paySupplierInvoice', purchase.id, { operationKey: randomUUID(), amount: '1.00', paymentMethod: 'CASH' }); const before = await call(page, 'currentCash', true);
  await page.locator('#navSuppliersBtn').click(); await expect(page.locator('#suppliersView')).toBeVisible();
  await page.evaluate(id => window.PosPurchases.supplierStatement(id), supplier.id); await expect(page.locator('#statementModal')).toBeVisible();
  await page.locator('#statementTableBody').getByRole('button', { name: 'Revertir pago' }).click(); await page.locator('#anularRegistroMotivo').fill('Pago duplicado'); await page.locator('#anularRegistroForm button[type=submit]').click();
  await expect(page.locator('#customAlertMessage')).toContainText('Pago a proveedor revertido');
  expect((await call(page, 'payable', purchase.id)).balance).toBe('2.00'); expect(Number((await call(page, 'currentCash', true)).expectedAmount)).toBe(Number(before.expectedAmount) + 1);
  await closeAlert(page); await page.evaluate(id => window.PosPurchases.supplierStatement(id), supplier.id);
  await expect(page.locator('#statementTableBody')).toContainText('Anulado: Pago duplicado'); await expect(page.locator('#statementTableBody').getByRole('button', { name: 'Revertir pago' })).toHaveCount(0);
});
test('manual cash validates fields and reconciles entries, withdrawals and a recovered response', async ({ page }) => {
  await setup(page); const initial = await call(page, 'currentCash', true);
  await page.locator('#navCajaBtn').click(); await expect(page.locator('#cajaAbiertaBox')).toBeVisible();
  await page.locator('#registrarEntradaBtn').click(); await expect(page.locator('#cajaMovimientoMonto')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#cajaMovimientoMonto').fill('10.01'); await page.locator('#registrarEntradaBtn').click(); await expect(page.locator('#cajaMovimientoConcepto')).toHaveAttribute('aria-invalid', 'true');
  const reason = 'Fondo de cambio ' + randomUUID().slice(0, 8);
  await page.locator('#cajaMovimientoConcepto').fill(reason); await page.locator('#registrarEntradaBtn').click(); await expect(page.locator('#customAlertMessage')).toContainText('Entrada de efectivo registrado'); await closeAlert(page);
  await expect(page.locator('#cajaResumenEsperado')).toHaveText('C$' + (Number(initial.expectedAmount) + 10.01).toFixed(2));
  await expect(page.locator('#cajaMovimientosBody tr').filter({ hasText: reason })).toContainText('browseradmin'); await expect(page.locator('#cajaMovimientoMonto')).toHaveValue('');
  await page.locator('#cajaMovimientoMonto').fill('0.01'); await page.locator('#cajaMovimientoConcepto').fill('Retiro de efectivo'); await page.locator('#registrarSalidaBtn').click(); await expect(page.locator('#customAlertMessage')).toContainText('Retiro de efectivo registrado'); await closeAlert(page);
  expect(Number((await call(page, 'currentCash', true)).expectedAmount)).toBe(Number(initial.expectedAmount) + 10);
  const url = process.env.POS_TEST_API + '/financial/cash/movements'; let writes = 0;
  await page.route(url, async route => { writes++; const response = await route.fetch(); expect(response.status()).toBe(201); await route.abort(); });
  await page.locator('#cajaMovimientoMonto').fill('1.00'); await page.locator('#cajaMovimientoConcepto').fill('Entrada con respuesta perdida'); await page.locator('#registrarEntradaBtn').click();
  await expect(page.locator('#customAlertMessage')).toContainText('Comprueba'); await closeAlert(page); await page.reload(); await expect(page.locator('#app')).toBeVisible(); await page.locator('#recoverSaleBtn').click();
  await expect(page.locator('#customAlertMessage')).toContainText('Entrada de efectivo registrado'); expect(writes).toBe(1); await closeAlert(page);
  const current = await call(page, 'currentCash', true); expect(Number(current.expectedAmount)).toBe(Number(initial.expectedAmount) + 11);
  const report = await call(page, 'connectedReport'); expect(report.cash.currentExpected).toBe(current.expectedAmount); expect(report.cash.movements.some(row => row.description === reason && row.userName === 'browseradmin')).toBe(true);
  await page.locator('#navCajaBtn').click(); await expect(page.locator('#cajaAbiertaBox')).toBeVisible();
  await page.locator('#cajaMovimientoMonto').fill('1'); await page.locator('#cajaMovimientoConcepto').fill('Cerrar antes de enviar');
  await call(page, 'closeCash', current.id, { operationKey: randomUUID(), countedAmount: current.expectedAmount });
  await page.unroute(url); await page.locator('#registrarSalidaBtn').click(); await expect(page.locator('#customAlertMessage')).toContainText('Debes abrir caja');
  await expect(page.locator('#cajaMovimientoMonto')).toHaveValue('1'); await expect(page.locator('#recoverSaleBtn')).toBeHidden();
  const history = await call(page, 'cashSessions'); expect(history.find(c => c.id === current.id).difference).toBe('0.00');
  expect(await page.evaluate(() => localDB)).toBeNull();
});
test('storage failure prevents sending and malformed recovery preserves the pending reference', async ({ page }) => {
  let writes = 0;
  const url = process.env.POS_TEST_API + '/expenses';
  await page.route(url, route => { writes++; return route.abort(); });
  await page.evaluate(() => {
    window.originalStorageSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key.startsWith('posOperation_')) throw new Error('Storage unavailable'); return window.originalStorageSetItem.call(this, key, value); };
  });
  const data = { category: 'Otro', description: 'Storage safety', amount: '1.00', paymentMethod: 'BANK', receiptReference: '' };
  await page.evaluate(data => window.PosSales.performFinancial('EXPENSE', data, async (api, input) => ({ kind: 'EXPENSE', expense: await api.createExpense(input) })), data);
  await expect(page.locator('#customAlertMessage')).toContainText('No se pudo guardar'); expect(writes).toBe(0); await closeAlert(page);
  await page.evaluate(() => { Storage.prototype.setItem = window.originalStorageSetItem; });
  await page.evaluate(data => window.PosSales.performFinancial('EXPENSE', data, async (api, input) => ({ kind: 'EXPENSE', expense: await api.createExpense(input) })), data);
  await closeAlert(page); expect(writes).toBe(1);
  const businessId = await page.evaluate(() => window.PosRuntime.salesInput().businessId);
  await page.route('**/financial/operations/*/resolve', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ kind: 'EXPENSE', expense: { businessId } }) }));
  await page.locator('#recoverSaleBtn').click(); await expect(page.locator('#recoverSaleBtn')).toBeVisible();
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('posOperation_')).length)).toBe(1);
});
test('another tab cannot send a second operation while the first response is in flight', async ({ page, context }) => {
  const other = await context.newPage(); await other.goto('/?mode=connected'); await expect(other.locator('#app')).toBeVisible();
  let release; const held = new Promise(resolve => { release = resolve; });
  let started; const entered = new Promise(resolve => { started = resolve; }); let writes = 0;
  const url = process.env.POS_TEST_API + '/expenses';
  await page.route(url, async route => { writes++; started(); await held; await route.abort(); });
  const data = { category: 'Otro', description: 'Cross tab safety', amount: '1.00', paymentMethod: 'BANK', receiptReference: '' };
  const first = page.evaluate(data => window.PosSales.performFinancial('EXPENSE', data, async (api, input) => ({ kind: 'EXPENSE', expense: await api.createExpense(input) })), data);
  try {
    await entered;
    await other.evaluate(data => window.PosSales.performFinancial('EXPENSE', data, async (api, input) => ({ kind: 'EXPENSE', expense: await api.createExpense(input) })), data);
    await expect(other.locator('#customAlertMessage')).toContainText('otra pestaña'); expect(writes).toBe(1);
  } finally { release(); await first; await other.close(); }
});
