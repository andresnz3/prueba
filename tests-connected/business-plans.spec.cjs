'use strict';

const { test, expect } = require('@playwright/test');
const { randomUUID } = require('node:crypto');

test('el panel crea un negocio con plan y muestra cupos; el sistema permite cambiarlo', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript({ path: require.resolve('../tests/dexie-search-shim.js') });
  await page.route('https://**/*', route => route.fulfill({
    status: 200,
    contentType: route.request().url().includes('fonts.googleapis.com') ? 'text/css' : 'application/javascript',
    body: ''
  }));
  await page.goto('/?mode=connected');
  await page.locator('#loginUsername').fill('andres');
  await page.locator('#loginPassword').fill('Browser-fixture-password-123!');
  const loginResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/auth/login'));
  await page.locator('#loginForm button[type="submit"]').click();
  expect((await loginResponse).status()).toBe(200);
  await expect(page.locator('#app')).toBeVisible();
  await page.locator('#navSystemAdminBtn').click();
  const name = 'Plan UI ' + randomUUID().slice(0, 8);
  await page.locator('#systemAdminBusinessName').fill(name);
  await page.locator('#systemAdminBusinessPlan').selectOption('CONECTADO_BASICO');
  const createdResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/admin/businesses'));
  await page.locator('#systemAdminBusinessForm button[type="submit"]').click();
  expect((await createdResponse).status()).toBe(201);
  const businessId = await page.locator('#systemAdminBusinessesBody tr').filter({ hasText: name }).getAttribute('data-business-id');
  expect(businessId).toBeTruthy();

  const adminUsername = 'owner_' + randomUUID().replaceAll('-', '').slice(0, 12);
  await page.evaluate(async ({ id, username }) => {
    const api = new window.PosApiClient(window.POS_API_BASE_URL); await api.me();
    await api.createAdminUser(id, { username, fullName: 'Administrador del negocio', password: 'Synthetic-plan-owner-123!', role: 'ADMIN' });
  }, { id: businessId, username: adminUsername });
  await page.locator('#systemAdminUsersTab').click();
  await page.locator('#systemAdminUserBusinessId').selectOption(businessId);
  await expect(page.locator('#systemAdminUsersCapacity')).toContainText('1 de 3 usuarios activos');
  await expect(page.locator('#systemAdminUsersCapacity')).toContainText('1 de 1 administrador');

  await page.locator('#systemAdminBillingTab').click();
  const billingRow = page.locator('#systemAdminBillingBody tr[data-business-id="' + businessId + '"]');
  await billingRow.locator('select').selectOption('CONECTADO_ESTANDAR');
  await expect(billingRow.locator('small').first()).toContainText('M\u00e1ximo 5 usuarios activos');
  await billingRow.getByRole('button', { name: 'Guardar plan y fecha' }).click();
  await expect(page.locator('#systemAdminMessage')).toContainText('Plan y fecha actualizados');
  await page.locator('#systemAdminUsersTab').click();
  await page.locator('#systemAdminUserBusinessId').selectOption(businessId);
  await expect(page.locator('#systemAdminUsersCapacity')).toContainText('1 de 5 usuarios activos');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#systemAdminUsersCapacity')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const deletionPreview = await page.evaluate(async id => {
    const api = new window.PosApiClient(window.POS_API_BASE_URL); await api.me();
    return api.adminBusinessDeletionPreview(id);
  }, businessId);
  await page.evaluate(async ({ id, previewToken }) => {
    const api = new window.PosApiClient(window.POS_API_BASE_URL); await api.me();
    await api.deleteAdminBusiness(id, 'ELIMINAR', previewToken);
  }, { id: businessId, previewToken: deletionPreview.previewToken });
});
