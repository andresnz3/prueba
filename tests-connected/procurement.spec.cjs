const { test, expect } = require('@playwright/test');
const { randomBytes, randomUUID } = require('node:crypto');
const { readConfig } = require('../backend/src/config/environment');
const { createDatabasePool } = require('../backend/src/config/database');

const business = process.env.POS_TEST_BUSINESS, password = 'Browser-fixture-password-123!';
const pageErrors = new WeakMap();

test.beforeEach(async ({ page, context }) => {
  await context.addInitScript({ path: require.resolve('../tests/dexie-search-shim.js') });
  await page.addInitScript(() => {
    const col = index => { let value = index + 1, result = ''; while (value) { value--; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); } return result; };
    window.XLSX = { utils: { aoa_to_sheet(rows) { const sheet = { '!data': rows }; rows.forEach((row, y) => row.forEach((value, x) => { sheet[col(x) + (y + 1)] = { v: value, t: typeof value === 'number' ? 'n' : 's' }; })); return sheet; }, book_new() { return { SheetNames: [], Sheets: {} }; }, book_append_sheet(book, sheet, name) { book.SheetNames.push(name); book.Sheets[name] = sheet; } }, writeFile(book, filename) { const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify({ book, filename })])); link.download = filename; document.body.append(link); link.click(); link.remove(); } };
  });
  const errors = []; pageErrors.set(page, errors); page.on('pageerror', error => errors.push(error.message));
});
test.afterEach(async ({ page }) => { expect(pageErrors.get(page)).toEqual([]); });

async function login(page) {
  await page.route('https://**/*', route => route.abort());
  await page.goto('/?mode=connected');
  await expect(page.locator('#loginForm button[type=submit]')).toBeEnabled();
  await page.locator('#loginBusinessId').fill(business); await page.locator('#loginUsername').fill('browseradmin'); await page.locator('#loginPassword').fill(password);
  await page.locator('#loginForm button[type=submit]').click(); await expect(page.locator('#app')).toBeVisible();
}
async function closeAlert(page) {
  await expect(page.locator('#customAlertModal')).toBeVisible();
  await page.locator('#customAlertModal .close-modal-btn').click();
  await expect(page.locator('#customAlertModal')).toBeHidden();
}
async function downloadedWorkbook(download) {
  return JSON.parse(require('node:fs').readFileSync(await download.path(), 'utf8')).book;
}
async function call(page, method, ...args) {
  return page.evaluate(async ({ method, args }) => { const api = new window.PosApiClient(window.POS_API_BASE_URL); await api.me(); return api[method](...args); }, { method, args });
}
async function mysqlPurchase(invoiceNumber) {
  const database = process.env.POS_INTEGRATION_DATABASE;
  if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('La comprobación MySQL requiere una base aislada');
  const config = readConfig(), pool = createDatabasePool({ ...config.database, database, connectionLimit: 1 });
  try {
    const [rows] = await pool.execute('SELECT p.total,p.purchase_type,p.status,i.quantity,pr.stock,pr.cost,sp.payment_method,sp.status AS payment_status FROM purchases p JOIN purchase_items i ON i.business_id=p.business_id AND i.purchase_id=p.id JOIN products pr ON pr.business_id=i.business_id AND pr.id=i.product_id LEFT JOIN supplier_payments sp ON sp.business_id=p.business_id AND sp.purchase_id=p.id WHERE p.business_id=? AND p.invoice_number=?', [business, invoiceNumber]);
    return rows[0] || null;
  } finally { await pool.end(); }
}

test('Compras conectadas actualizan stock, CxP, reportes, Dashboard y Excel', async ({ page }) => {
  await login(page);
  if (!await call(page, 'currentCash', true)) await call(page, 'openCash', { operationKey: randomUUID(), openingAmount: '100.00' });
  const suffix = randomBytes(4).toString('hex');
  const product = await call(page, 'createProduct', { barcode: 'BUY-' + suffix, name: 'Producto compra ' + suffix, category: 'General', cost: '4.00', marginRetail: '20.0000', marginWholesale: '10.0000', retailPrice: '4.80', wholesalePrice: '4.40', stock: '2.000', minStock: '1.000', taxRate: '0.0000', image: null, active: true });
  await call(page, 'createSupplier', { name: 'Proveedor inicial ' + suffix, contact: 'Contacto', phone: '5551000' + suffix, ruc: null, address: 'Managua' });
  const supplierName = 'Proveedor compras ' + suffix;

  await page.locator('#navPurchasesBtn').click(); await expect(page.locator('#purchasesView')).toBeVisible();
  const purchasesBeforeCancel = await call(page, 'purchases');
  await page.locator('#addNewPurchaseBtn').click(); await expect(page.locator('#purchaseModal')).toBeVisible();
  await expect(page.locator('#purchInternalNumber')).toHaveValue('Se asigna al guardar');
  await expect(page.locator('#purchInvoice')).not.toHaveJSProperty('required', true);
  await page.locator('#purchaseModal .modal-actions button[type="button"]').click();
  await expect(page.locator('#purchaseModal')).toBeHidden();
  expect((await call(page, 'purchases')).map(row => row.id)).toEqual(purchasesBeforeCancel.map(row => row.id));
  await page.locator('#addNewPurchaseBtn').click(); await expect(page.locator('#purchaseModal')).toBeVisible();
  await page.locator('#quickAddSupplierFromPurchBtn').click(); await expect(page.locator('#supplierModal')).toBeVisible();
  expect(await page.locator('#supplierModal').evaluate(node => Number(getComputedStyle(node).zIndex))).toBeGreaterThan(1000);
  await page.locator('#suppName').fill(supplierName); await page.locator('#suppContact').fill('Contacto'); await page.locator('#suppPhone').fill('555' + suffix); await page.locator('#suppAddress').fill('Managua');
  await page.locator('#supplierForm button[type=submit]').click(); await expect(page.locator('#supplierModal')).toBeHidden();
  await expect(page.locator('#customAlertMessage')).toContainText('Proveedor guardado'); await closeAlert(page);
  await expect(page.locator('#purchSupplier')).toHaveValue(supplierName);
  const cashInvoice = 'PC-' + suffix;
  await page.locator('#purchSupplier').fill(supplierName); await page.locator('#purchInvoice').fill(cashInvoice);
  await page.locator('#purchProductTemp').fill(product.name); await page.locator('#purchQtyTemp').fill('2.000'); await page.locator('#purchCostTemp').fill('4.00');
  await page.locator('#btnAddItemToPurch').click(); await expect(page.locator('#purchCartBody')).toContainText(product.name);
  await page.locator('#purchaseForm button[type=submit]').click(); await expect(page.locator('#purchaseModal')).toBeHidden({ timeout: 15000 });
  await expect(page.locator('#customAlertMessage')).toContainText(cashInvoice); await closeAlert(page);
  await expect(page.locator('#connectedPurchasesTableBody')).toContainText(cashInvoice);
  const [purchaseDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#connectedPurchasesControls .data-table-export').click()]);
  expect(purchaseDownload.suggestedFilename()).toMatch(/^compras_conectadas_\d{4}-\d{2}-\d{2}\.xlsx$/);
  const purchaseBook = await downloadedWorkbook(purchaseDownload);
  expect(JSON.stringify(purchaseBook.Sheets)).toContain(cashInvoice);
  expect(JSON.stringify(purchaseBook.Sheets)).not.toMatch(/supplierId|productId|businessId/);
  const cashRow = await mysqlPurchase(cashInvoice);
  expect(cashRow).toMatchObject({ total: '8.00', purchase_type: 'CASH', status: 'COMPLETED', quantity: '2.000', stock: '4.000', cost: '4.00', payment_method: 'CASH', payment_status: 'POSTED' });

  await page.locator('#navReportesBtn').click(); await expect(page.locator('#reportesView')).toBeVisible();
  const connectedDateStyle = await page.locator('#reporteDesdeInput').evaluate(input => ({ scheme: getComputedStyle(input).colorScheme, background: getComputedStyle(input).backgroundColor, calendar: getComputedStyle(input, '::-webkit-calendar-picker-indicator').display }));
  expect(connectedDateStyle).toEqual({ scheme: 'light', background: 'rgb(255, 255, 255)', calendar: 'block' });
  await expect(page.locator('.connected-report-only button[onclick="window.PosReports?.exportExcel()"]')).toHaveClass(/btn-export-excel/);
  await page.locator('.rep-subtab[data-target="repComprasBox"]').click();
  await expect(page.locator('#repComprasBody')).toContainText(cashInvoice);
  const [reportDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#repComprasBox .data-table-export').first().click()]);
  expect(reportDownload.suggestedFilename()).toMatch(/^reporte_compras_\d{4}-\d{2}-\d{2}\.xlsx$/);
  const reportBook = await downloadedWorkbook(reportDownload);
  expect(reportBook.SheetNames).toContain('Compras del período');
  expect(JSON.stringify(reportBook.Sheets)).toContain(cashInvoice);
  expect(JSON.stringify(reportBook.Sheets)).not.toMatch(/supplierId|productId|businessId/);

  await page.locator('#navSuppliersBtn').click(); await expect(page.locator('#suppliersView')).toBeVisible();
  await expect(page.locator('#connectedSuppliersTableBody')).toContainText(supplierName);
  const [supplierDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#connectedSuppliersControls .data-table-export').click()]);
  expect(supplierDownload.suggestedFilename()).toMatch(/^proveedores_conectados_\d{4}-\d{2}-\d{2}\.xlsx$/);
  const supplierBook = await downloadedWorkbook(supplierDownload);
  expect(JSON.stringify(supplierBook.Sheets)).toContain(supplierName);
  expect(JSON.stringify(supplierBook.Sheets)).not.toMatch(/supplierId|businessId/);

  await page.locator('#navPurchasesBtn').click(); await page.locator('#addNewPurchaseBtn').click();
  const creditInvoice = 'CR-' + suffix;
  await page.locator('#purchSupplier').fill(supplierName); await page.locator('#purchInvoice').fill(creditInvoice);
  await page.locator('#purchType').selectOption('credito'); await expect(page.locator('#purchDaysContainer')).toBeVisible();
  await page.locator('#purchProductTemp').fill(product.name); await page.locator('#purchQtyTemp').fill('1'); await page.locator('#purchCostTemp').fill('6.00'); await page.locator('#btnAddItemToPurch').click();
  await page.locator('#purchaseForm button[type=submit]').click(); await expect(page.locator('#purchaseModal')).toBeHidden({ timeout: 15000 });
  await expect(page.locator('#customAlertMessage')).toContainText(creditInvoice); await closeAlert(page);
  await page.locator('#navPayablesBtn').click(); await expect(page.locator('#payablesView')).toBeVisible();
  await expect(page.locator('#connectedPayablesTableBody')).toContainText(creditInvoice);
  const [payableDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#connectedPayablesControls .data-table-export').click()]);
  expect(payableDownload.suggestedFilename()).toMatch(/^cuentas_por_pagar_conectadas_\d{4}-\d{2}-\d{2}\.xlsx$/);
  const payableBook = await downloadedWorkbook(payableDownload);
  expect(JSON.stringify(payableBook.Sheets)).toContain(creditInvoice);
  expect(JSON.stringify(payableBook.Sheets)).not.toMatch(/supplierId|purchaseId|businessId/);
  const creditRow = page.locator('#connectedPayablesTableBody tr').filter({ hasText: creditInvoice });
  await creditRow.getByRole('button', { name: 'Abonar' }).click(); await expect(page.locator('#paymentInvoiceModal')).toBeVisible();
  await page.locator('#payInvoiceMethod').selectOption('tarjeta'); await page.locator('#payInvoiceAmount').fill('1.00'); await page.locator('#paymentInvoiceForm button[type=submit]').click();
  await expect(page.locator('#customAlertMessage')).toContainText('migración 005'); await closeAlert(page);
  await expect(page.locator('#paymentInvoiceModal')).toBeVisible();
  await page.locator('#payInvoiceMethod').selectOption('efectivo'); await page.locator('#payInvoiceAmount').fill('2.00'); await page.locator('#paymentInvoiceForm button[type=submit]').click();
  await expect(page.locator('#customAlertMessage')).toContainText('Pago registrado'); await closeAlert(page);
  await expect(page.locator('#connectedPayablesTableBody')).toContainText('C$4.00');
  await expect(page.locator('#connectedPayablesSummary')).toContainText('C$4.00');
  expect(await page.evaluate(async () => ({ sales: await localDB.sales.count(), queue: await localDB.sync_queue.count() }))).toEqual({ sales: 0, queue: 0 });

  await page.setViewportSize({ width: 390, height: 844 });
  const controls = await page.locator('#connectedPayablesControls').boundingBox();
  expect(controls.x).toBeGreaterThanOrEqual(0); expect(controls.x + controls.width).toBeLessThanOrEqual(391);
  await page.locator('#navDashboardBtn').click(); await expect(page.locator('#dashboardConnectedContent')).toBeVisible();
  const dashboardDateStyle = await page.locator('#dashboardFromInput').evaluate(input => ({ scheme: getComputedStyle(input).colorScheme, background: getComputedStyle(input).backgroundColor, calendar: getComputedStyle(input, '::-webkit-calendar-picker-indicator').display }));
  expect(dashboardDateStyle).toEqual(connectedDateStyle);
  const dashboardDateBox = await page.locator('#dashboardFromInput').boundingBox();
  expect(dashboardDateBox.x).toBeGreaterThanOrEqual(0); expect(dashboardDateBox.x + dashboardDateBox.width).toBeLessThanOrEqual(391);
  await expect(page.locator('#connectedDashPurchasesBody')).toContainText(cashInvoice);
  await expect(page.locator('#connectedDashPayablesBalance')).toHaveText('C$4.00');
  const [dashboardDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#dashboardView button[onclick="window.generarExcelDashboard()"]').click()]);
  const dashboardBook = await downloadedWorkbook(dashboardDownload);
  expect(dashboardBook.SheetNames).toContain('Compras del período'); expect(dashboardBook.SheetNames).toContain('Cuentas por pagar');
  expect(JSON.stringify(dashboardBook.Sheets)).toContain(cashInvoice); expect(JSON.stringify(dashboardBook.Sheets)).toContain(creditInvoice);

  await page.locator('#navPurchasesBtn').click(); await page.locator('#addNewPurchaseBtn').click();
  await expect(page.locator('#purchInternalNumber')).toHaveValue('Se asigna al guardar');
  await page.locator('#purchSupplier').fill(supplierName); await page.locator('#purchType').selectOption('credito');
  await page.locator('#purchProductTemp').fill(product.name); await page.locator('#purchQtyTemp').fill('1'); await page.locator('#purchCostTemp').fill('6.00');
  await page.locator('#btnAddItemToPurch').click(); await page.locator('#purchaseForm button[type=submit]').click();
  await expect(page.locator('#purchaseModal')).toBeHidden({ timeout: 15000 });
  await expect(page.locator('#customAlertMessage')).toContainText(/Compra COMP-\d{6,} registrada/);
  const noInvoiceNumber = (await page.locator('#customAlertMessage').textContent()).match(/COMP-\d{6,}/)[0];
  await closeAlert(page);
  await expect(page.locator('#connectedPurchasesTableBody')).toContainText(noInvoiceNumber);
  const noInvoiceRows = await call(page, 'purchases', 0, noInvoiceNumber);
  expect(noInvoiceRows).toHaveLength(1); expect(noInvoiceRows[0].purchaseNumber).toBe(noInvoiceNumber); expect(noInvoiceRows[0].supplierInvoiceNumber).toBe('');
  const noInvoiceRow = page.locator('#connectedPurchasesTableBody tr').filter({ hasText: noInvoiceNumber });
  await noInvoiceRow.getByRole('button', { name: 'Ver factura' }).click();
  await expect(page.locator('#ticketModal')).toBeVisible();
  await expect(page.locator('#ticketContent')).toContainText('N° compra interno: ' + noInvoiceNumber);
  await expect(page.locator('#ticketContent')).not.toContainText('Factura del proveedor:');
  await page.locator('#closeTicketBtn').click();

  await page.locator('#navReportesBtn').click(); await page.locator('.rep-subtab[data-target="repComprasBox"]').click();
  await expect(page.locator('#repComprasBody')).toContainText(noInvoiceNumber);
  const [noInvoiceReportDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#repComprasBox .data-table-export').first().click()]);
  expect(JSON.stringify((await downloadedWorkbook(noInvoiceReportDownload)).Sheets)).toContain(noInvoiceNumber);
  await page.locator('#navDashboardBtn').click(); await expect(page.locator('#connectedDashPurchasesBody')).toContainText(noInvoiceNumber);
  const [noInvoiceDashboardDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#dashboardView button[onclick="window.generarExcelDashboard()"]:visible').click()]);
  expect(JSON.stringify((await downloadedWorkbook(noInvoiceDashboardDownload)).Sheets)).toContain(noInvoiceNumber);
});
