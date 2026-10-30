'use strict';

const { test, expect } = require('@playwright/test');
const apiBase = process.env.POS_TEST_API;
const password = 'Browser-fixture-password-123!';
const errors = new WeakMap();
test.beforeEach(async ({ page, context }) => {
  await context.addInitScript({ path: require.resolve('../tests/dexie-search-shim.js') });
  errors.set(page, []);
  page.on('pageerror', error => errors.get(page).push(error.message));
});
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });
async function login(page, username) {
  await page.goto('/?mode=connected');
  await expect(page.locator('#loginForm button[type=submit]')).toBeEnabled();
  await page.locator('#loginUsername').fill(username);
  await page.locator('#loginPassword').fill(password);
  await page.locator('#loginForm button[type=submit]').click();
  await expect(page.locator('#app')).toBeVisible();
}

test('el administrador general puede generar y consultar licencias de un solo uso', async ({ page }) => {
  await login(page, 'andres');
  await expect(page.locator('#navSystemAdminBtn')).toBeVisible();
  await page.locator('#navSystemAdminBtn').click();
  await expect(page.locator('#systemAdminView')).toBeVisible();
  await page.locator('#systemAdminLicensesTab').click();
  await expect(page.locator('#systemAdminLicensesPanel')).toBeVisible();
  await expect(page.locator('#systemAdminActiveLocalBusinessesCount')).toHaveText('0');
  await expect(page.locator('#systemAdminLicensesPanel')).toContainText('no indica si está conectado en este momento');
  await page.setViewportSize({ width: 390, height: 844 });
  const summaryBox = await page.locator('.system-admin-license-summary article').boundingBox();
  expect(summaryBox).not.toBeNull();
  expect(summaryBox.x + summaryBox.width).toBeLessThanOrEqual(390);
  const customer = 'Cliente de navegador ' + Date.now();
  await page.locator('#systemAdminLicenseCustomer').fill(customer);
  await page.locator('#systemAdminLicenseReference').fill('TEST-BROWSER');
  await page.locator('#systemAdminLicenseGenerateBtn').click();
  await expect(page.locator('#systemAdminLicenseForm')).not.toContainText('Justificación');
  await expect(page.locator('#systemAdminLicenseIssued')).toBeVisible();
  await expect(page.locator('#systemAdminActiveLocalBusinessesCount')).toHaveText('0');
  await expect(page.locator('#systemAdminLicenseIssuedCode')).toHaveText(/^POSL-(?:[A-F0-9]{4}-){11}[A-F0-9]{4}$/);
  const row = page.locator('#systemAdminLicensesBody tr').filter({ hasText: customer });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Pendiente');
  await expect(page.locator('#systemAdminLicenseTransferBtn')).toBeDisabled();
  const licenseId = await page.locator('#systemAdminLicenseActionId option').nth(1).getAttribute('value');
  await page.locator('#systemAdminLicenseActionId').selectOption(licenseId);
  await expect(page.locator('#systemAdminLicenseActionReason')).toHaveValue('');
  await expect(page.locator('#systemAdminLicenseRevokeBtn')).toBeDisabled();
  await page.locator('#systemAdminLicenseActionReason').fill('Motivo de revocación de prueba');
  await expect(page.locator('#systemAdminLicenseRevokeBtn')).toBeEnabled();
  await expect(page.locator('#systemAdminLicenseTransferBtn')).toBeDisabled();
});

test('autorizar una transferencia no requiere una explicación y conserva el control de revocación', async ({ page }) => {
  let licenseStatus = 'ACTIVE';
  let transferBody;
  await page.route('**/system-admin/local-licenses**', async route => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        licenses: [{ id: '9001', customerName: 'Cliente ficticio', customerReference: null, status: licenseStatus, createdAt: '2026-10-28T10:00:00.000Z', activatedAt: '2026-10-28T10:05:00.000Z', revokedAt: null, transferCount: licenseStatus === 'PENDING' ? 1 : 0 }],
        activeLocalBusinessCount: licenseStatus === 'ACTIVE' ? 1 : 0
      }) });
      return;
    }
    if (request.method() === 'POST' && request.url().endsWith('/9001/transfer')) {
      transferBody = request.postDataJSON();
      licenseStatus = 'PENDING';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: '9001', status: 'PENDING', transferCount: 1 }) });
      return;
    }
    await route.continue();
  });

  await login(page, 'andres');
  await page.locator('#navSystemAdminBtn').click();
  await page.locator('#systemAdminLicensesTab').click();
  await expect(page.locator('#systemAdminLicensesPanel')).toBeVisible();
  await page.locator('#systemAdminLicenseActionId').selectOption('9001');
  await expect(page.locator('#systemAdminLicenseActionReason')).toHaveValue('');
  await expect(page.locator('#systemAdminLicenseTransferBtn')).toBeEnabled();
  await expect(page.locator('#systemAdminLicenseRevokeBtn')).toBeDisabled();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#systemAdminLicenseTransferBtn').click();
  await expect(page.locator('#systemAdminLicenseMessage')).toContainText('Transferencia autorizada');
  expect(transferBody).toEqual({});
  await expect(page.locator('#systemAdminLicenseActionReason')).toHaveAttribute('aria-describedby', 'systemAdminLicenseActionReasonHelp');
  await expect(page.locator('#systemAdminLicenseRevokeBtn')).toBeDisabled();
});

test('otro administrador de negocio no puede consultar licencias centrales', async ({ page }) => {
  await login(page, 'browseradmin');
  await expect(page.locator('#systemAdminActiveLocalBusinessesCount')).toBeHidden();
  const result = await page.evaluate(async url => {
    const response = await fetch(url + '/system-admin/local-licenses', { credentials: 'include', cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  }, apiBase);
  expect(result.status).toBe(403);
  expect(result.body.error.code).toBe('SYSTEM_ADMIN_REQUIRED');
});
