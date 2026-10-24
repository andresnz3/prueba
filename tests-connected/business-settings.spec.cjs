'use strict';
const { test, expect } = require('@playwright/test');
const { photo } = require('../backend/tests/helpers/image-fixtures.cjs');

const password = 'Browser-fixture-password-123!';
const businessA = process.env.POS_TEST_BUSINESS, businessB = process.env.POS_TEST_BUSINESS_B, apiBase = process.env.POS_TEST_API;
const errors = new WeakMap();
test.setTimeout(180000);
test.beforeEach(async ({ page }) => { errors.set(page, []); });
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });

async function login(page, username = 'browseradmin') {
  await page.context().addInitScript({ path: require.resolve('../tests/dexie-search-shim.js') });
  const pageErrors = errors.get(page) || []; errors.set(page, pageErrors); page.on('pageerror', error => pageErrors.push(error.message));
  await page.route(/https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)\//, route => route.abort());
  await page.goto('/?mode=connected', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#loginForm button[type=submit]')).toBeEnabled();
  await page.locator('#loginUsername').fill(username);
  await page.locator('#loginPassword').fill(password);
  await page.locator('#loginForm button[type=submit]').click();
  await expect(page.locator('#app')).toBeVisible();
}

async function openSettings(page) {
  await page.locator('#navConfigBtn').click();
  await expect(page.locator('#configView')).toBeVisible();
}

test('ajustes centrales por negocio, permisos de lectura, ticket y transición local explícita', async ({ page, browser }) => {
  expect(businessA).toMatch(/^[1-9]\d{0,19}$/); expect(businessB).toMatch(/^[1-9]\d{0,19}$/);
  await login(page);
  await openSettings(page);
  await expect(page.locator('#legacyBusinessSettings')).toBeHidden();
  await page.locator('#confName').fill('Comercial Navegador A');
  await page.locator('#confLegalName').fill('Comercial Navegador A S.A.');
  await page.locator('#confRuc').fill('RUC-NAVEGADOR-A');
  await page.locator('#confAddress').fill('Managua');
  await page.locator('#confPhone').fill('2255-1000');
  await page.locator('#confHeader').fill('Sucursal Norte');
  await page.locator('#confFooter').fill('Gracias, vuelva pronto');
  await page.locator('#confMinStock').fill('7.5');
  await page.locator('#confLogoInput').setInputFiles({ name: 'business-logo.png', mimeType: 'image/png', buffer: await photo() });
  await page.locator('#saveConfigBtn').click();
  await expect(page.locator('#businessSettingsMessage')).toContainText('Información guardada correctamente');
  await expect(page.locator('#businessSettingsMessage')).toContainText('logo');
  await expect(page.locator('#confName')).toHaveValue('Comercial Navegador A');
  await expect(page.locator('#confCurrency')).toHaveValue('C$');
  const logoReference = await page.evaluate(async () => {
    const response = await fetch(window.POS_API_BASE_URL + '/business-settings', { credentials: 'include' });
    return (await response.json()).logo;
  });
  expect(logoReference).toMatch(new RegExp('^/api/product-images/' + businessA + '/[a-f0-9]{32}\\.jpg$'));

  await page.evaluate(() => window.generarVisualizacionTicket({
    items: [{ id: '1', name: 'Artículo prueba', cantidad: 1, retailPrice: 15 }], subtotal: 15, total: 15,
    metodo: 'Contado', medioPago: 'card', numero: 1, numeroVisual: '000001', fecha: '2026-10-21', vendedor: 'browseradmin'
  }, 0, 0, false));
  await expect(page.locator('#ticketContent')).toContainText('Comercial Navegador A S.A.');
  await expect(page.locator('#ticketContent')).toContainText('RUC-NAVEGADOR-A');
  await expect(page.locator('#ticketContent img.invoice-logo')).toHaveAttribute('src', new RegExp('product-images/' + businessA));

  const secondContext = await browser.newContext();
  await secondContext.addInitScript({ path: require.resolve('../tests/dexie-search-shim.js') });
  const secondBrowser = await secondContext.newPage();
  try {
    await login(secondBrowser);
    await openSettings(secondBrowser);
    await expect(secondBrowser.locator('#confName')).toHaveValue('Comercial Navegador A');
    await expect(secondBrowser.locator('#confLegalName')).toHaveValue('Comercial Navegador A S.A.');
    await expect(secondBrowser.locator('#confLogoPreview')).toBeVisible();
    await expect(secondBrowser.locator('#confLogoPreview')).toHaveJSProperty('naturalWidth', 256);
  } finally { await secondContext.close(); }

  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  try {
    await login(other, 'otheradmin'); await openSettings(other);
    await expect(other.locator('#confName')).toHaveValue('Browser fixture B');
    const forged = await other.evaluate(async businessId => {
      try {
        await window.PosConnected.updateBusinessSettings({ businessId, businessName: 'Cambio ajeno', legalName: '', ruc: '', phone: '', address: '', ticketHeader: '', ticketFooter: '', minStockDefault: 5 });
        return 'allowed';
      } catch (error) { return error.code; }
    }, businessA);
    expect(forged).toBe('INVALID_INPUT');
    expect(await other.evaluate(async reference => {
      const response = await fetch(new URL(reference, window.POS_API_BASE_URL), { credentials: 'include' });
      return response.status;
    }, logoReference)).toBe(404);
  } finally { await otherContext.close(); }

  const existingLegacyKey = 'posConnectedConfig_' + encodeURIComponent(apiBase) + '_' + businessA;
  const existingContext = await browser.newContext();
  await existingContext.addInitScript({ path: require.resolve('../tests/dexie-search-shim.js') });
  const existingPage = await existingContext.newPage();
  try {
    await existingPage.addInitScript(({ key }) => localStorage.setItem(key, JSON.stringify({
      name: 'Comercial Navegador A', legalName: 'No debe reemplazar la razón social', ruc: 'RUC-NO-DEBE-CAMBIAR'
    })), { key: existingLegacyKey });
    await login(existingPage); await openSettings(existingPage);
    await expect(existingPage.locator('#legacyBusinessSettings')).toBeVisible();
    await expect(existingPage.locator('#legacySettingsServerConflict')).toBeVisible();
    await expect(existingPage.locator('#importLegacySettingsBtn')).toBeHidden();
    await expect(existingPage.locator('#confLegalName')).toHaveValue('Comercial Navegador A S.A.');
    expect(await existingPage.evaluate(key => localStorage.getItem(key), existingLegacyKey)).not.toBeNull();
    await existingPage.setViewportSize({ width: 375, height: 812 });
    await expect(existingPage.locator('#exportLegacySettingsBtn')).toBeVisible();
    const recoveryWidth = await existingPage.locator('#legacyBusinessSettings').evaluate(element => element.scrollWidth <= element.clientWidth + 1);
    expect(recoveryWidth).toBe(true);
  } finally { await existingContext.close(); }

  const mismatchedKey = 'posConnectedConfig_' + encodeURIComponent(apiBase) + '_' + businessB;
  const mismatchContext = await browser.newContext();
  await mismatchContext.addInitScript({ path: require.resolve('../tests/dexie-search-shim.js') });
  const mismatchPage = await mismatchContext.newPage();
  try {
    await mismatchPage.addInitScript(({ key }) => localStorage.setItem(key, JSON.stringify({
      name: 'Comercial Navegador A', legalName: 'Información de otro negocio', ruc: 'RUC-A'
    })), { key: mismatchedKey });
    await login(mismatchPage, 'otheradmin'); await openSettings(mismatchPage);
    await expect(mismatchPage.locator('#legacyBusinessSettings')).toBeHidden();
    expect(await mismatchPage.evaluate(key => localStorage.getItem(key), mismatchedKey)).not.toBeNull();
  } finally { await mismatchContext.close(); }

  const legacyKey = 'posConnectedConfig_' + encodeURIComponent(apiBase) + '_' + businessB;
  const legacyContext = await browser.newContext(); await legacyContext.addInitScript({ path: require.resolve('../tests/dexie-search-shim.js') });
  const legacyPage = await legacyContext.newPage();
  try {
    await legacyPage.addInitScript(({ key }) => localStorage.setItem(key, JSON.stringify({
      name: 'Browser fixture B', legalName: 'Importación explícita B', ruc: 'RUC-B', phone: '', address: 'León', header: 'Local B', footer: 'Cierre B', minStock: 8, currency: 'USD'
    })), { key: legacyKey });
    await login(legacyPage, 'otheradmin'); await openSettings(legacyPage);
    await expect(legacyPage.locator('#legacyBusinessSettings')).toBeVisible();
    await expect(legacyPage.locator('#legacyBusinessSettingsTitle')).toHaveText('Recuperar información anterior');
    await expect(legacyPage.locator('#legacyBusinessSettingsDescription')).toHaveText('Encontramos información de tu negocio guardada anteriormente, como el nombre comercial, RUC, dirección y configuración de comprobantes. Puedes recuperarla para seguir utilizándola desde cualquier dispositivo.');
    await expect(legacyPage.locator('#legacyImportConfirmWrap')).toContainText('Confirmo que esta información pertenece a mi negocio');
    await expect(legacyPage.locator('#importLegacySettingsBtn')).toHaveText('Guardar información');
    await expect(legacyPage.locator('#exportLegacySettingsBtn')).toHaveText('Descargar copia');
    await expect(legacyPage.locator('#importLegacySettingsBtn')).toBeDisabled();
    await legacyPage.locator('#legacyImportConfirm').check();
    await legacyPage.locator('#importLegacySettingsBtn').click();
    await expect(legacyPage.locator('#businessSettingsMessage')).toContainText('Información guardada correctamente');
    await expect(legacyPage.locator('#businessSettingsMessage')).toContainText('configuración de comprobantes');
    await expect(legacyPage.locator('#businessSettingsMessage')).not.toContainText('logo');
    await expect(legacyPage.locator('#confName')).toHaveValue('Browser fixture B');
    await expect(legacyPage.locator('#confLegalName')).toHaveValue('Importación explícita B');
    expect(await legacyPage.evaluate(key => localStorage.getItem(key), legacyKey)).not.toBeNull();
    await expect(legacyPage.locator('#legacySettingsServerConflict')).toBeVisible();
    await expect(legacyPage.locator('#importLegacySettingsBtn')).toBeHidden();
  } finally { await legacyContext.close(); }

  const sellerContext = await browser.newContext();
  const seller = await sellerContext.newPage();
  try {
    await login(seller, 'browserseller'); await openSettings(seller);
    await expect(seller.locator('#confName')).toHaveValue('Comercial Navegador A');
    await expect(seller.locator('#confName')).toBeDisabled();
    await expect(seller.locator('#saveConfigBtn')).toBeHidden();
    expect(await seller.evaluate(async () => {
      try { await window.PosConnected.updateBusinessSettings({ businessName: 'No autorizado', legalName: '', ruc: '', phone: '', address: '', ticketHeader: '', ticketFooter: '', minStockDefault: 5 }); return 'allowed'; }
      catch (error) { return error.code; }
    })).toBe('ADMIN_REQUIRED');
  } finally { await sellerContext.close(); }
});
