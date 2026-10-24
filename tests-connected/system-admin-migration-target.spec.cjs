'use strict';

const { test, expect } = require('@playwright/test');
const { randomUUID } = require('node:crypto');
const { createDatabasePool } = require('../backend/src/config/database');
const { readConfig } = require('../backend/src/config/environment');

const password = 'Browser-fixture-password-123!';

test('destino pendiente permanece bloqueado y puede retomarse desde el panel del sistema', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.context().addInitScript({ path: require.resolve('../tests/dexie-search-shim.js') });
  await page.route('https://**/*', route => route.abort());
  await page.goto('/?mode=connected');
  await page.locator('#loginUsername').fill('andres');
  await page.locator('#loginPassword').fill(password);
  await page.locator('#loginForm button[type=submit]').click();
  await expect(page.locator('#app')).toBeVisible();
  await page.locator('#navSystemAdminBtn').click();
  await expect(page.locator('#systemAdminView')).toBeVisible();

  const target = await page.evaluate(async name => {
    const api = new window.PosApiClient(window.POS_API_BASE_URL);
    const session = await api.me();
    const business = await api.createMigrationTarget(name, 'CONECTADO_BASICO');
    return { business, session };
  }, 'Destino bloqueado UI ' + randomUUID());
  expect(target.business).toMatchObject({ status: 'INACTIVE', migrationState: 'PENDING' });
  expect(target.session.user.businessId).toBe('1');

  await page.locator('#systemAdminRefreshBtn').click();
  const row = page.locator('#systemAdminBusinessesBody tr[data-business-id="' + target.business.id + '"]');
  await expect(row.locator('td').nth(2)).toHaveText('Migración pendiente');
  await expect(row.getByRole('button', { name: 'Activar' })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Administrar negocio' })).toHaveCount(0);
  await row.getByRole('button', { name: 'Continuar migración' }).click();
  await expect(page.locator('#systemAdminMigrationPanel')).toBeVisible();
  await expect(page.locator('#migrationBusiness')).toHaveValue(target.business.id);

  const businessesRefresh = page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith('/admin/businesses'));
  await page.locator('#systemAdminBusinessesTab').click();
  expect((await businessesRefresh).status()).toBe(200);
  await page.locator('#systemAdminBillingTab').click();
  const billingRow = page.locator('#systemAdminBillingBody tr[data-business-id="' + target.business.id + '"]');
  await expect(billingRow.locator('td').first()).toContainText('Migración pendiente');
  await expect(billingRow.getByRole('button', { name: 'Activar' })).toHaveCount(0);
  await expect(billingRow.getByRole('button', { name: 'Administrar negocio' })).toHaveCount(0);
  await billingRow.getByRole('button', { name: 'Continuar migración' }).click();
  await expect(page.locator('#systemAdminMigrationPanel')).toBeVisible();
  await expect(page.locator('#migrationBusiness')).toHaveValue(target.business.id);

  const sourceId = randomUUID();
  const packageValue = {
    type: 'pos_local_migration_package',
    version: 2,
    exportedAt: '2026-10-22T12:00:00.000Z',
    source: { mode: 'local', scope: { idSource: 'config', localBusinessId: sourceId, idsFound: 0, legacyRecords: 0, excludedRecords: 0, missingStores: [] } },
    business: { name: target.business.name, localBusinessId: sourceId },
    summary: { products: 0, clients: 0, suppliers: 0, sales: 0, purchases: 0, cashSessions: 0, inventoryMovements: 0, abonos: 0, expenses: 0, auditLogs: 0, saleOrders: 0, syncQueue: 0 },
    data: { products: [], clients: [], suppliers: [], sales: [], purchases: [], cashSessions: [], inventoryMovements: [], abonos: [], expenses: [], auditLogs: [], saleOrders: [], syncQueue: [], configuration: { name: target.business.name, currency: 'C$', logo: null }, categories: [] }
  };
  await page.locator('#migrationPackageFile').setInputFiles({ name: 'paquete-ficticio.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(packageValue)) });
  await expect(page.locator('#migrationArchiveReview')).toBeVisible({ timeout: 30_000 });
  await page.locator('#migrationArchiveConfirm').check();
  await expect(page.getByRole('button', { name: 'Migrar datos', exact: true })).toBeEnabled();

  const urlBeforeActivationAttempt = page.url();
  const activation = await page.evaluate(async businessId => {
    const api = new window.PosApiClient(window.POS_API_BASE_URL);
    await api.me();
    try {
      await api.setAdminBusinessStatus(businessId, 'ACTIVE');
      return { allowed: true };
    } catch (failure) {
      window.PosConnected.handleError(failure, 'systemAdminMessage');
      return { allowed: false, code: failure.code, status: failure.status, message: failure.message };
    }
  }, target.business.id);
  expect(activation).toEqual({
    allowed: false,
    code: 'MIGRATION_RECONCILIATION_REQUIRED',
    status: 409,
    message: 'No se puede activar todavía. Completa la migración y la conciliación desde «Migración local».'
  });
  await expect(page.locator('#systemAdminMessage')).toHaveText(activation.message);
  expect(page.url()).toBe(urlBeforeActivationAttempt);

  const database = process.env.POS_INTEGRATION_DATABASE;
  const config = readConfig();
  if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === config.database.database) throw new Error('Base temporal de migración insegura');
  const pool = createDatabasePool({ ...config.database, database });
  try {
    const [rows] = await pool.execute('SELECT b.status, c.state FROM businesses b JOIN business_migration_controls c ON c.business_id=b.id WHERE b.id=?', [target.business.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ status: 'INACTIVE', state: 'PENDING' });
  } finally {
    await pool.end();
  }
  expect(pageErrors).toEqual([]);
});
