'use strict';
const { test, expect } = require('@playwright/test');
const { Buffer } = require('node:buffer');

test('la configuración local permanece en este navegador y se refleja en el comprobante', async ({ page, context }) => {
  await context.addInitScript({ path: require.resolve('./dexie-search-shim.js') });
  await page.route('http://127.0.0.1:5500/**', async route => {
    const response = await route.fetch();
    const html = (await response.text()).replace(/\s+integrity="[^"]*"/g, '');
    await route.fulfill({ response, body: html });
  });
  await page.route('https://**/*', route => route.fulfill({ status: 200, contentType: route.request().url().includes('fonts.googleapis.com') ? 'text/css' : 'application/javascript', body: '' }));
  page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?mode=local', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#loginScreen')).toBeVisible();
  await page.locator('#loginUsername').fill('andres'); await page.locator('#loginPassword').fill('Prueba-Local-Propietario-2026!');
  await page.locator('#loginForm button[type=submit]').click(); await expect(page.locator('#app')).toBeVisible();
  await page.locator('#navConfigBtn').click(); await expect(page.locator('#configView')).toBeVisible();
  await page.locator('#confName').fill('Tienda local aislada');
  await page.locator('#confLegalName').fill('Tienda local S.A.');
  await page.locator('#confCurrency').fill('$');
  await page.locator('#confLogoInput').setInputFiles({
    name: 'logo.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p7sAAAAASUVORK5CYII=', 'base64')
  });
  await expect(page.locator('#confLogoPreview')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await page.locator('#saveConfigBtn').click(); await expect(page.locator('#customAlertModal')).toBeVisible();
  await page.locator('#customAlertModal .close-modal-btn').click();
  await page.evaluate(() => window.generarVisualizacionTicket({
    items: [{ id: 'local-1', name: 'Artículo local', cantidad: 1, retailPrice: 15 }], subtotal: 15, total: 15,
    metodo: 'Contado', medioPago: 'card', numero: 1, numeroVisual: '000001', fecha: '2026-10-21', vendedor: 'andres'
  }, 0, 0, false));
  await expect(page.locator('#ticketContent')).toContainText('Tienda local S.A.');
  await expect(page.locator('#ticketContent')).toContainText('$15.00');
  await expect(page.locator('#ticketContent')).toContainText('Artículo local');
  await expect(page.locator('#ticketContent img.invoice-logo')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await page.evaluate(() => {
    window.__pdfTicketCapture = {};
    window.html2pdf = () => ({
      set(options) { window.__pdfTicketCapture.options = options; return this; },
      from(element) { window.__pdfTicketCapture.text = element.innerText; return this; },
      save() { window.__pdfTicketCapture.saved = true; return Promise.resolve(); }
    });
  });
  await page.locator('#pdfTicketBtn').click();
  await expect.poll(() => page.evaluate(() => window.__pdfTicketCapture.saved)).toBe(true);
  const pdfText = await page.evaluate(() => window.__pdfTicketCapture.text);
  expect(pdfText).toContain('Tienda local S.A.');
  expect(pdfText).toContain('Artículo local');
  const csvExport = await page.evaluate(() => {
    const fixture = document.createElement('section'); fixture.id = 'utf8CsvFixture';
    fixture.innerHTML = '<table><thead><tr><th>Categoría</th><th>Nombre</th></tr></thead><tbody><tr><td>Frutas</td><td>Peña, café</td></tr></tbody></table>';
    document.body.append(fixture);
    let captured;
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { captured = { href: this.href, filename: this.download }; };
    const xlsx = window.XLSX;
    window.XLSX = undefined;
    try { window.exportarTablaCSV('utf8CsvFixture', 'prueba_utf8'); }
    finally { window.XLSX = xlsx; HTMLAnchorElement.prototype.click = originalClick; fixture.remove(); }
    return captured;
  });
  expect(csvExport.filename).toMatch(/^prueba_utf8_.*\.csv$/);
  expect(csvExport.href).toMatch(/^data:text\/csv;charset=utf-8,/);
  const csvText = await page.evaluate(href => decodeURIComponent(href.slice(href.indexOf(',') + 1)), csvExport.href);
  expect(csvText.charCodeAt(0)).toBe(0xfeff);
  expect(csvText).toContain('Categoría');
  expect(csvText).toContain('Peña, café');
  expect(csvText).toContain('"Peña, café"');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#loginScreen')).toBeVisible();
  await page.locator('#loginUsername').fill('andres'); await page.locator('#loginPassword').fill('Prueba-Local-Propietario-2026!');
  await page.locator('#loginForm button[type=submit]').click(); await expect(page.locator('#app')).toBeVisible();
  await page.locator('#navConfigBtn').click(); await expect(page.locator('#configView')).toBeVisible();
  await expect(page.locator('#confName')).toHaveValue('Tienda local aislada');
  await expect(page.locator('#confLegalName')).toHaveValue('Tienda local S.A.');
  await expect(page.locator('#confCurrency')).toHaveValue('$');
  expect(errors).toEqual([]);
});
