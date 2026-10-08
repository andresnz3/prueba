const { test, expect } = require('@playwright/test');
const { randomBytes, randomUUID } = require('node:crypto');

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
