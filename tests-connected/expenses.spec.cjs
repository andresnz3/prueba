'use strict';
const { test, expect } = require('@playwright/test');
const { randomBytes } = require('node:crypto');

const business = process.env.POS_TEST_BUSINESS;
const password = 'Browser-fixture-password-123!';
const errors = new WeakMap();

test.beforeEach(async ({ page, context }) => {
  await context.addInitScript({ path: require.resolve('../tests/dexie-search-shim.js') });
  const list = [];
  errors.set(page, list);
  page.on('pageerror', error => list.push(error.message));
});

test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });

async function login(page) {
  await page.route('https://**/*', route => route.abort());
  await page.goto('/?mode=connected');
  await page.locator('#loginBusinessId').fill(business);
  await page.locator('#loginUsername').fill('browseradmin');
  await page.locator('#loginPassword').fill(password);
  await page.locator('#loginForm button[type=submit]').click();
  await expect(page.locator('#app')).toBeVisible();
}

async function expenses(page) {
  return page.evaluate(async () => {
    const api = new window.PosApiClient(window.POS_API_BASE_URL);
    await api.me();
    return api.expenses();
  });
}

test('Gastos conectados se registran y anulan en MySQL desde su vista', async ({ page }) => {
  await login(page);
  await page.locator('#navGastosBtn').click();
  await expect(page.locator('#gastosView')).toBeVisible();
  await expect(page.locator('#connectedExpenseStatus')).toContainText('MySQL');

  const description = 'Gasto UI ' + randomBytes(4).toString('hex');
  await page.locator('#gastoCategoria').selectOption('Otro');
  await page.locator('#gastoMetodo').selectOption('banco');
  await page.locator('#gastoDescripcion').fill(description);
  await page.locator('#gastoComprobante').fill('UI-EXP-01');
  await page.locator('#gastoMonto').fill('2.75');
  await page.locator('#formRegistrarGasto button[type=submit]').click();

  await expect(page.locator('#gastosTableBody')).toContainText(description);
  let result = await expenses(page);
  let record = result.expenses.find(item => item.description === description);
  expect(record).toMatchObject({ category: 'Otro', paymentMethod: 'BANK', receiptReference: 'UI-EXP-01', status: 'POSTED', userName: 'browseradmin' });

  await page.locator('#gastosTableBody').getByRole('button', { name: 'Anular' }).click();
  await expect(page.locator('#anularRegistroModal')).toBeVisible();
  await page.locator('#anularRegistroMotivo').fill('Prueba de anulación desde navegador');
  await page.locator('#anularRegistroForm button[type="submit"]').click();
  await expect(page.locator('#gastosTableBody')).toContainText('ANULADO');
  result = await expenses(page);
  record = result.expenses.find(item => item.description === description);
  expect(record).toMatchObject({ status: 'VOID', cancelReason: 'Prueba de anulación desde navegador' });
});
