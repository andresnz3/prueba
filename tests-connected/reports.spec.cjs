const { test, expect } = require('@playwright/test');
const { randomBytes, randomUUID } = require('node:crypto');
const { readConfig } = require('../backend/src/config/environment');
const { createDatabasePool } = require('../backend/src/config/database');

const business = process.env.POS_TEST_BUSINESS, password = 'Browser-fixture-password-123!';
const errors = new WeakMap();

test.beforeEach(async ({ page, context }) => {
  await context.addInitScript({ path: require.resolve('../tests/dexie-search-shim.js') });
  const list = []; errors.set(page, list); page.on('pageerror', error => list.push(error.message));
});
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });

async function login(page) {
  await page.route('https://**/*', route => route.abort());
  await page.addInitScript(() => {
    const col = index => { let value = index + 1, result = ''; while (value) { value -= 1; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); } return result; };
    window.XLSX = {
      utils: {
        aoa_to_sheet(rows) { const sheet = { '!data': rows }; rows.forEach((row, y) => row.forEach((value, x) => { sheet[`${col(x)}${y + 1}`] = { v: value, t: typeof value === 'number' ? 'n' : 's' }; })); return sheet; },
        book_new() { return { SheetNames: [], Sheets: {} }; },
        book_append_sheet(book, sheet, name) { book.SheetNames.push(name); book.Sheets[name] = sheet; }
      },
      writeFile(book, filename) {
        const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify({ book, filename })])); link.download = filename; document.body.append(link); link.click(); link.remove();
      }
    };
  });
  await page.goto('/?mode=connected'); await expect(page.locator('#loginForm button')).toBeEnabled();
  await page.locator('#loginBusinessId').fill(business); await page.locator('#loginUsername').fill('browseradmin'); await page.locator('#loginPassword').fill(password); await page.locator('#loginForm button').click();
  await expect(page.locator('#app')).toBeVisible();
}

async function call(page, method, ...args) {
  return page.evaluate(async ({ method, args }) => { const api = new window.PosApiClient(window.POS_API_BASE_URL); await api.me(); return api[method](...args); }, { method, args });
}
async function mysqlSalesSnapshot(invoiceNumber = null) {
  const database = process.env.POS_INTEGRATION_DATABASE;
  if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('La comprobación MySQL requiere una base de integración aislada');
  const config = readConfig(), pool = createDatabasePool({ ...config.database, database, connectionLimit: 1 });
  try {
    const [totals] = await pool.execute("SELECT COUNT(*) AS count, COALESCE(SUM(total), 0.00) AS total FROM sales WHERE business_id = ? AND status = 'COMPLETED'", [business]);
    const [saleRows] = invoiceNumber ? await pool.execute('SELECT s.id, s.created_at, i.id AS itemId, m.id AS movementId, im.id AS inventoryMovementId FROM sales s JOIN sale_items i ON i.business_id = s.business_id AND i.sale_id = s.id LEFT JOIN cash_movements m ON m.business_id = s.business_id AND m.sale_id = s.id LEFT JOIN inventory_movements im ON im.business_id = s.business_id AND im.reference_type = \'sales\' AND im.reference_id = s.id WHERE s.business_id = ? AND s.invoice_number = ?', [business, invoiceNumber]) : [[]];
    return { count: Number(totals[0].count), total: Number(totals[0].total), sale: saleRows[0] || null };
  } finally { await pool.end(); }
}

test('Reportes conectados muestra fuentes MySQL, filtra hoy y conserva el modo local aislado', async ({ page }) => {
  await login(page);
  const cash = await call(page, 'currentCash', true);
  if (!cash) await call(page, 'openCash', { operationKey: randomUUID(), openingAmount: '100.00' });
  const suffix = randomBytes(4).toString('hex');
  const product = await call(page, 'createProduct', { barcode: 'RPT-' + suffix, name: 'Producto informe ' + suffix, category: 'General', cost: '8.00', marginRetail: '25', marginWholesale: '10', retailPrice: '10.00', wholesalePrice: '9.00', stock: '8.000', minStock: '1.000', taxRate: '0.0000', image: null, active: true });
  const saleInput = { items: [{ productId: product.id, quantity: '2.000' }], priceType: 'RETAIL', discountPercent: '0', paymentMethod: 'CARD' };
  const quote = await call(page, 'quoteSale', saleInput);
  const sale = await call(page, 'createSale', { ...saleInput, detail: 'Prueba de Reportes', operationKey: randomUUID(), quoteToken: quote.quoteToken, cashReceived: null });
  const clientName = 'Cliente informe ' + suffix;
  const customer = await call(page, 'createClient', { name: clientName, phone: '555' + suffix.slice(0, 6), ruc: null, address: 'Centro', creditLimit: '100.00', creditDays: 15 });
  const creditInput = { items: [{ productId: product.id, quantity: '1.000' }], priceType: 'RETAIL', discountPercent: '0', paymentMethod: 'CREDIT', clientId: customer.id };
  const creditQuote = await call(page, 'quoteSale', creditInput);
  const creditSale = await call(page, 'createSale', { ...creditInput, detail: 'Crédito para Reportes', operationKey: randomUUID(), quoteToken: creditQuote.quoteToken, cashReceived: null });
  await call(page, 'payReceivable', creditSale.sale.id, { operationKey: randomUUID(), amount: '1.00', paymentMethod: 'CASH' });

  await page.locator('#navReportesBtn').click(); await expect(page.locator('#reportesView')).toBeVisible();
  await expect(page.locator('#repVentas')).toHaveText(/C\$\d+\.\d{2}/);
  await expect(page.locator('#repVentasMetodoBody')).toContainText('Tarjeta');
  await expect(page.locator('#repVentasHistorialBody')).toContainText(sale.sale.invoiceNumber);
  await expect(page.locator('#repTopProductosBody')).toContainText(product.name);
  await expect(page.locator('#repCxCBody')).toContainText(clientName);
  await expect(page.locator('#repVentasHistorialBody tr').filter({ hasText: sale.sale.invoiceNumber }).locator('td')).toHaveCount(6);
  await expect(page.locator('#connectedReportScope')).toContainText('estado actual del negocio');
  await expect(page.locator('#repComprasPending')).toContainText('Reporte disponible cuando compras conectadas esté implementado.');

  await page.locator('#filtroHoyBtn').click();
  await expect(page.locator('#repVentasHistorialBody')).toContainText(sale.sale.invoiceNumber);
  const historyToolbar = page.locator('#repVentasHistorialBody').locator('xpath=ancestor::table').locator('xpath=..').locator('xpath=preceding-sibling::*[contains(@class,"data-table-toolbar")]');
  await historyToolbar.locator('.data-table-input').fill(sale.sale.invoiceNumber);
  await page.locator('#repVentasHistorialBody').locator('xpath=ancestor::table').locator('.data-table-filter-row input').nth(2).fill('browseradmin');
  await expect(page.locator('#repVentasHistorialBody tr:visible:not(.data-table-no-results)')).toHaveCount(1);
  await page.locator('#repVentasHistorialBody').locator('xpath=ancestor::table').locator('.data-table-filter-row input').nth(2).fill('no coincide');
  await expect(page.locator('#repVentasHistorialBody tr:visible:not(.data-table-no-results)')).toHaveCount(0);
  await historyToolbar.locator('.data-table-clear').click();
  await expect(page.locator('#repVentasHistorialBody')).toContainText(sale.sale.invoiceNumber);

  await page.locator('.rep-subtab[data-target="repCajaBox"]').click();
  await expect(page.locator('#repCajaMovimientosBody')).toContainText('Pendiente');
  await expect(page.locator('#repCajaMovimientosBody')).toContainText('Tarjeta');
  const [cashDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#repCajaBox .data-table-export').nth(1).click()]);
  expect(cashDownload.suggestedFilename()).toMatch(/^reporte_movimientos_caja_\d{4}-\d{2}-\d{2}\.xlsx$/);
  await page.locator('.rep-subtab[data-target="repInventarioBox"]').click();
  const [inventoryDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#repInventarioBox .data-table-export').click()]);
  expect(inventoryDownload.suggestedFilename()).toMatch(/^reporte_inventario_\d{4}-\d{2}-\d{2}\.xlsx$/);
  await page.locator('.rep-subtab[data-target="repCxCBox"]').click();
  const [receivableDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#repCxCBox .data-table-export').first().click()]);
  expect(receivableDownload.suggestedFilename()).toMatch(/^reporte_cuentas_por_cobrar_\d{4}-\d{2}-\d{2}\.xlsx$/);
  await expect(page.locator('#repCxCPagosBody')).toContainText(clientName);
  const [paymentDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#repCxCBox .data-table-export').nth(1).click()]);
  expect(paymentDownload.suggestedFilename()).toMatch(/^abonos_cuentas_por_cobrar_\d{4}-\d{2}-\d{2}\.xlsx$/);
  await page.locator('.rep-subtab[data-target="repComprasBox"]').click();
  await expect(page.locator('#repComprasPending')).toBeVisible();

  expect(await page.evaluate(async () => ({ sales: await localDB.sales.count(), queue: await localDB.sync_queue.count() }))).toEqual({ sales: 0, queue: 0 });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.rep-subtab[data-target="repVentasBox"]').click();
  const toolbarBounds = await page.locator('#repVentasHistorialBody').locator('xpath=ancestor::table').locator('xpath=..').locator('xpath=preceding-sibling::*[contains(@class,"data-table-toolbar")]').boundingBox();
  expect(toolbarBounds.x).toBeGreaterThanOrEqual(0); expect(toolbarBounds.x + toolbarBounds.width).toBeLessThanOrEqual(391);

  await page.locator('#navDashboardBtn').click(); await expect(page.locator('#dashboardView')).toBeVisible();
  await expect(page.locator('#dashboardConnectedContent')).toBeVisible(); await expect(page.locator('#dashboardLocalContent')).toBeHidden();
  await expect(page.locator('#connectedDashHistoryBody')).toContainText(sale.sale.invoiceNumber);
  const dashboardTotal = await page.locator('#connectedDashSalesTotal').innerText();
  const dashboardCount = Number(await page.locator('#connectedDashSalesCount').innerText());
  expect(Number(dashboardTotal.replace('C$', ''))).toBeGreaterThanOrEqual(Number(sale.sale.total) + Number(creditSale.sale.total));
  expect(dashboardCount).toBeGreaterThanOrEqual(2);
  expect(Number((await page.locator('#connectedDashTicketAverage').innerText()).replace('C$', ''))).toBeCloseTo(Number(dashboardTotal.replace('C$', '')) / dashboardCount, 2);
  await expect(page.locator('#connectedDashGrossProfit')).toHaveText(/C\$\d+\.\d{2}/);
  await expect(page.locator('#connectedDashCashExpected')).toHaveText(/C\$\d+\.\d{2}/);
  expect(Number(await page.locator('#connectedDashActiveProducts').innerText())).toBeGreaterThan(0);
  expect(Number((await page.locator('#connectedDashStockValue').innerText()).replace('C$', ''))).toBeGreaterThan(0);
  await expect(page.locator('#connectedDashReceivableBalance')).toHaveText(/C\$\d+\.\d{2}/);
  await expect(page.locator('#connectedDashReceivableOverdue')).toHaveText('C$0.00');
  await expect(page.locator('#connectedDashMethodsBody')).toContainText('Tarjeta');
  await expect(page.locator('#connectedDashSellersBody')).toContainText('browseradmin');
  await expect(page.locator('#connectedDashProductsBody')).toContainText(product.name);
  await expect(page.locator('#connectedDashHistoryBody')).toContainText(sale.sale.invoiceNumber);
  await expect(page.locator('#connectedDashDebtorsBody')).toContainText(clientName);
  expect((await page.locator('#dashboardConnectedContent .summary-card').allTextContents()).join(' ')).not.toContain('Cuentas por pagar');
  expect(await page.evaluate(async () => ({ sales: await localDB.sales.count(), queue: await localDB.sync_queue.count() }))).toEqual({ sales: 0, queue: 0 });

  await page.locator('#dashboardFromInput').fill('2000-01-01'); await page.locator('#dashboardUntilInput').fill('2000-01-01'); await page.locator('#dashboardApplyBtn').click();
  await expect(page.locator('#connectedDashSalesTotal')).toHaveText('C$0.00');
  await expect(page.locator('#connectedDashHistoryBody')).not.toContainText(sale.sale.invoiceNumber);
  await page.locator('[data-dashboard-preset="all"]').click();
  await expect(page.locator('#connectedDashSalesTotal')).toHaveText(dashboardTotal);

  const [dashboardDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#dashboardView button[onclick="window.generarExcelDashboard()"]').click()]);
  expect(dashboardDownload.suggestedFilename()).toMatch(/^dashboard_conectado_\d{4}-\d{2}-\d{2}\.xlsx$/);
  const dashboardBook = JSON.parse(require('node:fs').readFileSync(await dashboardDownload.path(), 'utf8')).book;
  expect(dashboardBook.SheetNames).toContain('Resumen'); expect(dashboardBook.SheetNames).toContain('Ventas del período');
  expect(JSON.stringify(dashboardBook.Sheets)).toContain(sale.sale.invoiceNumber);
  expect(JSON.stringify(dashboardBook.Sheets)).not.toMatch(/businessId|supplierId|productId/);
  const bounds = await page.locator('.dashboard-period-panel').boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(391);
});

test('venta nueva desde el POS se refleja en Reportes, Dashboard, Hoy, Todo y Excel', async ({ page }) => {
  await login(page);
  const cash = await call(page, 'currentCash', true);
  if (!cash) await call(page, 'openCash', { operationKey: randomUUID(), openingAmount: '100.00' });
  const suffix = randomBytes(4).toString('hex');
  const product = await call(page, 'createProduct', { barcode: 'LIVE-' + suffix, name: 'Venta recién creada ' + suffix, category: 'General', cost: '4.00', marginRetail: '25', marginWholesale: '10', retailPrice: '10.00', wholesalePrice: '9.00', stock: '8.000', minStock: '1.000', taxRate: '0.0000', image: null, active: true });
  const now = new Date(), monthStart = new Date(now.getFullYear(), now.getMonth(), 1), todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()), tomorrow = new Date(todayStart);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const allBefore = await call(page, 'connectedReport');
  const monthBefore = await call(page, 'connectedReport', monthStart.toISOString(), tomorrow.toISOString());
  const todayBefore = await call(page, 'connectedReport', todayStart.toISOString(), tomorrow.toISOString());
  const mysqlBefore = await mysqlSalesSnapshot();
  expect(mysqlBefore.count).toBe(allBefore.sales.count); expect(mysqlBefore.total).toBe(Number(allBefore.sales.total));

  await page.locator('#navSalesBtn').click(); await expect(page.locator('#productGrid')).toContainText(product.name);
  await page.locator('#productGrid .product-card').filter({ hasText: product.name }).click(); await expect(page.locator('#cartItems')).toContainText(product.name);
  await page.locator('#processSaleBtn').click(); await expect(page.locator('#connectedCheckoutModal')).toBeVisible();
  await page.locator('#connectedCashReceived').fill('100.00'); await page.locator('#confirmConnectedSaleBtn').click(); await expect(page.locator('#ticketModal')).toBeVisible();
  const sale = (await call(page, 'sales')).find(value => value.items.some(item => item.productId === product.id));
  expect(sale).toBeTruthy(); expect(sale.status).toBe('COMPLETED');
  const mysqlAfter = await mysqlSalesSnapshot(sale.invoiceNumber);
  expect(mysqlAfter.count).toBe(mysqlBefore.count + 1); expect(mysqlAfter.total).toBe(mysqlBefore.total + Number(sale.total));
  expect(mysqlAfter.sale.id).toBe(sale.id);
  expect(mysqlAfter.sale.itemId).toBeTruthy(); expect(mysqlAfter.sale.movementId).toBeTruthy(); expect(mysqlAfter.sale.inventoryMovementId).toBeTruthy();
  const allAfter = await call(page, 'connectedReport');
  const monthAfter = await call(page, 'connectedReport', monthStart.toISOString(), tomorrow.toISOString());
  const todayAfter = await call(page, 'connectedReport', todayStart.toISOString(), tomorrow.toISOString());
  expect(Number(monthAfter.sales.total)).toBe(Number(monthBefore.sales.total) + Number(sale.total));
  expect(Number(todayAfter.sales.total)).toBe(Number(todayBefore.sales.total) + Number(sale.total));
  expect(todayAfter.sales.history.some(row => row.invoiceNumber === sale.invoiceNumber)).toBe(true);
  expect(allAfter.sales.history.some(row => row.invoiceNumber === sale.invoiceNumber)).toBe(true);

  let reportFetches = 0;
  await page.route('**/api/reports/connected*', async route => { reportFetches++; await route.continue(); });
  await page.locator('#newSaleBtn').click(); await page.locator('#navReportesBtn').click();
  await expect(page.locator('#repVentasHistorialBody')).toContainText(sale.invoiceNumber);
  await expect(page.locator('#repVentas')).toHaveText('C$' + Number(monthAfter.sales.total).toFixed(2));
  const reportFetchesBeforeInvalidation = reportFetches;
  await page.evaluate(() => document.dispatchEvent(new Event('connected:report-data-changed')));
  await expect.poll(() => reportFetches).toBeGreaterThan(reportFetchesBeforeInvalidation);
  await page.locator('#filtroHoyBtn').click(); await expect(page.locator('#repVentasHistorialBody')).toContainText(sale.invoiceNumber);
  await page.locator('#filtroTodoBtn').click(); await expect(page.locator('#repVentasHistorialBody')).toContainText(sale.invoiceNumber);
  const [reportDownload] = await Promise.all([page.waitForEvent('download'), page.locator('button[onclick*="ventas"]').click()]);
  const reportWorkbook = JSON.parse(require('node:fs').readFileSync(await reportDownload.path(), 'utf8')).book;
  expect(JSON.stringify(reportWorkbook.Sheets)).toContain(sale.invoiceNumber);

  await page.locator('#navDashboardBtn').click(); await expect(page.locator('#connectedDashHistoryBody')).toContainText(sale.invoiceNumber);
  await expect(page.locator('#connectedDashSalesTotal')).toHaveText('C$' + Number(monthAfter.sales.total).toFixed(2));
  const dashboardFetchesBeforeInvalidation = reportFetches;
  await page.evaluate(() => document.dispatchEvent(new Event('connected:report-data-changed')));
  await expect.poll(() => reportFetches).toBeGreaterThan(dashboardFetchesBeforeInvalidation);
  await page.locator('[data-dashboard-preset="today"]').click(); await expect(page.locator('#connectedDashHistoryBody')).toContainText(sale.invoiceNumber);
  await page.locator('[data-dashboard-preset="all"]').click(); await expect(page.locator('#connectedDashHistoryBody')).toContainText(sale.invoiceNumber);
  const [dashboardDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#dashboardView button[onclick="window.generarExcelDashboard()"]').click()]);
  const dashboardWorkbook = JSON.parse(require('node:fs').readFileSync(await dashboardDownload.path(), 'utf8')).book;
  expect(JSON.stringify(dashboardWorkbook.Sheets)).toContain(sale.invoiceNumber);
  expect(await page.evaluate(async () => ({ sales: await localDB.sales.count(), queue: await localDB.sync_queue.count() }))).toEqual({ sales: 0, queue: 0 });
});

test('Reportes conectados exporta Excel filtrado y avisa cuando el rango no tiene ventas', async ({ page }) => {
  await login(page);
  const current = await call(page, 'currentCash', true);
  if (!current) await call(page, 'openCash', { operationKey: randomUUID(), openingAmount: '100.00' });
  const suffix = randomBytes(4).toString('hex');
  const product = await call(page, 'createProduct', { barcode: 'RPT-' + suffix, name: 'Exportado ' + suffix, category: 'General', cost: '4.00', marginRetail: '25', marginWholesale: '10', retailPrice: '5.00', wholesalePrice: '4.50', stock: '8.000', minStock: '1.000', taxRate: '0.0000', image: null, active: true });
  const input = { items: [{ productId: product.id, quantity: '1.000' }], priceType: 'RETAIL', discountPercent: '0', paymentMethod: 'CARD' };
  const quote = await call(page, 'quoteSale', input);
  const sale = await call(page, 'createSale', { ...input, detail: 'Exportación de prueba', operationKey: randomUUID(), quoteToken: quote.quoteToken, cashReceived: null });
  await page.locator('#navReportesBtn').click(); await expect(page.locator('#repVentasHistorialBody')).toContainText(sale.sale.invoiceNumber);
  const salesToolbar = page.locator('#repVentasHistorialBody').locator('xpath=ancestor::table').locator('xpath=..').locator('xpath=preceding-sibling::*[contains(@class,"data-table-toolbar")]');
  await salesToolbar.locator('.data-table-input').fill(sale.sale.invoiceNumber);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button[onclick*="ventas"]').click()]);
  expect(download.suggestedFilename()).toMatch(/^ventas_conectado_\d{4}-\d{2}-\d{2}\.xlsx$/);
  const workbook = JSON.parse(require('node:fs').readFileSync(await download.path(), 'utf8')).book;
  expect(workbook.SheetNames.length).toBe(3);
  expect(JSON.stringify(workbook.Sheets)).toContain('Factura');
  expect(JSON.stringify(workbook.Sheets)).toContain(sale.sale.invoiceNumber);
  expect(workbook.Sheets['Historial de ventas']['!data'][0]).toEqual(['Fecha', 'Factura', 'Vendedor', 'Medio de pago', 'Total', 'Estado']);
  expect(workbook.Sheets['Historial de ventas']['!autofilter']).toBeTruthy();

  const oldDate = '2000-01-01';
  await page.locator('#reporteDesdeInput').fill(oldDate); await page.locator('#reporteHastaInput').fill(oldDate); await page.locator('#aplicarFiltroReporteBtn').click();
  await expect(page.locator('#repVentas')).toHaveText('C$0.00');
  await expect(page.locator('#repVentasBox .data-table-export').first()).toBeHidden();
  await page.locator('button[onclick*="ventas"]').click(); await expect(page.locator('#customAlertModal')).toBeVisible();
  await expect(page.locator('#customAlertMessage')).toContainText('No hay ventas visibles');
});
