'use strict';

const { expect } = require('@playwright/test');
const { randomUUID } = require('node:crypto');

const systemAdminPassword = 'Browser-fixture-password-123!';

async function api(page, method, ...args) {
  return page.evaluate(async ({ method, args }) => {
    const client = new window.PosApiClient(window.POS_API_BASE_URL);
    await client.me();
    return client[method](...args);
  }, { method, args });
}

function identityPackage(sourceId, sourceName, data, summary = {}) {
  const own = rows => (rows || []).map(row => ({ ...row, business_id: sourceId }));
  const completeData = {
    products: [], clients: [], suppliers: [], sales: [], purchases: [], cashSessions: [],
    inventoryMovements: [], abonos: [], expenses: [], auditLogs: [], saleOrders: [], syncQueue: [],
    categories: [], configuration: { name: sourceName, localBusinessId: sourceId, currency: 'C$' },
    ...data
  };
  for (const key of ['products', 'clients', 'suppliers', 'sales', 'purchases', 'cashSessions', 'inventoryMovements', 'abonos', 'expenses', 'auditLogs', 'saleOrders', 'syncQueue']) {
    completeData[key] = own(completeData[key]);
  }
  const counts = Object.fromEntries(['products', 'clients', 'suppliers', 'sales', 'purchases', 'cashSessions', 'inventoryMovements', 'abonos', 'expenses', 'auditLogs', 'saleOrders', 'syncQueue']
    .map(key => [key, completeData[key].length]));
  const recordCount = Object.values(counts).reduce((total, count) => total + count, 0);
  return {
    type: 'pos_local_migration_package', version: 2, exportedAt: '2026-10-15T12:00:00.000Z',
    source: { mode: 'local', scope: { idSource: 'config', localBusinessId: sourceId, idsFound: recordCount, legacyRecords: 0, excludedRecords: 0, missingStores: [] } },
    business: { id: sourceId, localBusinessId: sourceId, name: sourceName },
    summary: { ...counts, ...summary }, data: completeData
  };
}

async function signInSystemAdmin(page, context) {
  await context.addInitScript({ path: require.resolve('../tests/dexie-search-shim.js') });
  await page.route('https://**/*', route => route.abort());
  await page.goto('/?mode=connected');
  await page.locator('#loginUsername').fill('andres');
  await page.locator('#loginPassword').fill(systemAdminPassword);
  await page.locator('#loginForm button[type=submit]').click();
  await expect(page.locator('#app')).toBeVisible();
}

async function createDestinationAndAdmin(page, suffix, name) {
  await page.locator('#navSystemAdminBtn').click();
  await expect(page.locator('#systemAdminView')).toBeVisible();
  await page.locator('#systemAdminMigrationTab').click();
  await page.locator('#migrationTargetName').fill(name);
  await page.locator('#migrationTargetPlan').selectOption('CONECTADO_BASICO');
  const createdResponse = page.waitForResponse(response => response.url().endsWith('/system-admin/migration/targets') && response.request().method() === 'POST');
  await page.locator('#migrationTargetCreateBtn').click();
  expect((await createdResponse).status()).toBe(201);
  await expect(page.locator('#migrationTargetStatus')).toContainText('Negocio creado');
  const destination = page.locator('#migrationBusiness');
  await expect(destination.locator('option').filter({ hasText: name })).toHaveCount(1);
  const businessId = await destination.locator('option').filter({ hasText: name }).getAttribute('value');
  expect(businessId).not.toBe('1');
  await destination.selectOption(businessId);

  await page.locator('#systemAdminUsersTab').click();
  await expect(page.locator('#systemAdminUsersPanel')).toBeVisible();
  await page.locator('#systemAdminUserBusinessId').selectOption(businessId);
  await expect(page.locator('#systemAdminRole')).toHaveValue('');
  await page.locator('#systemAdminUsername').fill('migration_admin_' + suffix);
  await page.locator('#systemAdminFullName').fill('Cuenta nueva de migración');
  const newPassword = 'Fresh-migration-password-' + suffix + '!';
  await page.locator('#systemAdminPassword').fill(newPassword);
  await page.locator('#systemAdminUserForm button[type=submit]').click();
  await expect(page.locator('#systemAdminRole')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#systemAdminRole').selectOption('ADMIN');
  const createdUserResponse = page.waitForResponse(response => response.url().endsWith('/admin/businesses/' + businessId + '/users') && response.request().method() === 'POST');
  await page.locator('#systemAdminUserForm button[type=submit]').click();
  expect((await createdUserResponse).status()).toBe(201);
  await expect(page.locator('#systemAdminMessage')).toContainText('Usuario creado');
  await page.locator('#systemAdminMigrationTab').click();
  await page.locator('#migrationBusiness').selectOption(businessId);
  return { businessId, username: 'migration_admin_' + suffix, password: newPassword };
}

async function importCompletePackage(page, businessId, value, filename) {
  await page.locator('#migrationBusiness').selectOption(businessId);
  await page.locator('#migrationPackageFile').setInputFiles({ name: filename, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
  await expect(page.locator('#migrationPackageReview')).toBeVisible();
  await expect(page.locator('#migrationArchiveReview')).toBeVisible();
  await expect(page.locator('#migrationArchiveConfirm')).toBeEnabled();
  await page.locator('#migrationArchiveConfirm').check();
  await expect(page.locator('#migrationArchiveApplyBtn')).toBeEnabled();
  const archiveResponse = page.waitForResponse(response => response.url().endsWith('/system-admin/migration/archive') && response.request().method() === 'POST');
  const operationsResponse = page.waitForResponse(response => /\/project\/operations$/.test(response.url()) && response.request().method() === 'POST');
  await page.locator('#migrationArchiveApplyBtn').click();
  const archived = await archiveResponse;
  const archiveResult = await archived.json();
  expect(archived.status(), JSON.stringify(archiveResult)).toBe(201);
  const operationsResponseResult = await operationsResponse;
  const operationsResult = await operationsResponseResult.json();
  expect(operationsResponseResult.status(), JSON.stringify(operationsResult)).toBe(200);
  expect(operationsResult.reconciliation, JSON.stringify(operationsResult.reconciliation?.differences || [])).toMatchObject({ stageMatched: true });
  await expect(page.locator('#migrationArchiveStatus')).toContainText('Migración completada');
  return { batchId: archiveResult.batchId };
}

async function openDestinationPage(browser, target, initScriptPath) {
  const context = await browser.newContext();
  if (initScriptPath) await context.addInitScript({ path: initScriptPath });
  const page = await context.newPage();
  await page.route('https://**/*', route => route.abort());
  await page.goto('/?mode=connected');
  await page.locator('#loginUsername').fill(target.username);
  await page.locator('#loginPassword').fill(target.password);
  await page.locator('#loginForm button[type=submit]').click();
  await expect(page.locator('#app')).toBeVisible();
  return { context, page };
}

function uniqueSuffix() { return randomUUID().replaceAll('-', '').slice(0, 8); }

module.exports = { api, createDestinationAndAdmin, identityPackage, importCompletePackage, openDestinationPage, signInSystemAdmin, uniqueSuffix };
