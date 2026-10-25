'use strict';

const { test, expect } = require('@playwright/test');

function packageFixture({ legacy = false } = {}) {
  const empty = [];
  const products = legacy ? [{ id: 'p1', name: 'Producto antiguo', business_id: '00000000-0000-0000-0000-000000000000' }] : empty;
  return {
    type: 'pos_local_migration_package', version: 2, exportedAt: '2026-10-21T15:00:00.000Z',
    source: { mode: 'local', scope: { localBusinessId: 'local-ui-01', idSource: 'config', idsFound: 1, legacyRecords: 0, excludedRecords: 0, missingStores: [] } },
    business: { name: 'Origen visual', localBusinessId: 'local-ui-01', currency: 'C$' },
    summary: { products: products.length, clients: 0, suppliers: 0, sales: 0, purchases: 0, cashSessions: 0, inventoryMovements: 0, abonos: 0, expenses: 0, auditLogs: 0, saleOrders: 0, syncQueue: 0 },
    data: { products, clients: empty, suppliers: empty, sales: empty, purchases: empty, cashSessions: empty, inventoryMovements: empty, abonos: empty, expenses: empty, auditLogs: empty, saleOrders: empty, syncQueue: empty, configuration: { name: 'Origen visual', currency: 'C$', logo: null }, categories: [] }
  };
}

async function openMigration(page, { eligible = true, delayed = false, existingEligible = true, missingProtection = false, legacy = false } = {}) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript({ path: require.resolve('../tests/dexie-search-shim.js') });
  await page.goto('/');
  await page.evaluate(({ eligible, delayed, existingEligible, missingProtection, legacy }) => {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    document.querySelectorAll('.view-panel').forEach(panel => panel.classList.add('hidden'));
    document.getElementById('systemAdminView').classList.remove('hidden');
    const panel = document.getElementById('systemAdminMigrationPanel');
    panel.classList.remove('hidden'); panel.setAttribute('aria-hidden', 'false');
    window.__archiveCalls = [];
    window.__catalogProjectionCalls = [];
    window.__operationsProjectionCalls = [];
    window.__existingTargetCalls = [];
    window.__identityReviewCalls = [];
    window.PosMigrationPreview.show({
      canAccess: () => true,
      businesses: [
        { id: '1', name: 'Sistema', status: 'ACTIVE', migrationState: 'NOT_REQUIRED' },
        { id: '7', name: 'Negocio activo', status: 'ACTIVE', migrationState: 'NOT_REQUIRED' },
        { id: '10', name: 'Negocio con historial', status: 'ACTIVE', migrationState: 'NOT_REQUIRED' },
        { id: '8', name: 'Origen visual', status: 'INACTIVE', migrationState: 'PENDING' }
      ],
      createMigrationTarget: async name => ({ id: '9', name, status: 'INACTIVE', migrationState: 'PENDING' }),
      inspectExistingMigrationTarget: async businessId => {
        window.__existingTargetCalls.push(['inspect', businessId]);
        if (missingProtection) throw new window.PosApiError('MIGRATION_GATE_SCHEMA_REQUIRED', 503);
        const eligible = businessId === '7' ? existingEligible : false;
        return { business: { id: businessId, name: businessId === '7' ? 'Negocio activo' : 'Negocio con historial', status: 'ACTIVE', migrationState: 'NOT_REQUIRED' }, eligible, blockers: eligible ? [] : ['Productos e inventario: 2 registro(s)'], warnings: ['Se conservarán 1 usuario(s).', 'El negocio está activo.'], preserved: { users: 1, settings: 1, auditLogs: 0, sessions: 1, subscriptions: 0, businessPhone: false, businessAddress: false }, accessChanges: { activeSessions: 1, sessionsToRevoke: 1, authorizationsToRemove: 0 } };
      },
      prepareExistingMigrationTarget: async (businessId, confirmed) => {
        window.__existingTargetCalls.push(['prepare', businessId, confirmed]);
        return { business: { id: businessId, name: businessId === '7' ? 'Negocio activo' : 'Negocio con historial', status: 'INACTIVE', migrationState: 'PENDING' }, preserved: { users: 1, settings: 1, auditLogs: 0, sessions: 1, subscriptions: 0, businessPhone: false, businessAddress: false }, accessChanges: { activeSessions: 1, sessionsToRevoke: 1, authorizationsToRemove: 0 }, accessSuspended: true, sessionsRevoked: 1, authorizationsRemoved: 0 };
      },
      previewArchive: async (target, value, fileSha256) => {
        window.__archiveCalls.push(['preview', target]);
        if (delayed) await new Promise(resolve => { window.__finishArchivePreview = resolve; });
        return { ok: true, targetBusinessId: target, targetBusinessName: 'Origen visual', targetStatus: 'INACTIVE', targetMigrationState: 'PENDING', sourceBusinessKey: 'a'.repeat(64), packageSha256: 'b'.repeat(64), fileSha256, packageVersion: 2, counts: { products: legacy ? 1 : 0 }, recordsExpected: legacy ? 3 : 2, missingStores: [], sensitiveFieldsRemoved: 0, blockers: eligible ? [] : ['La identidad del paquete no coincide con el alcance declarado.'], eligibleToArchive: eligible, legacyIdentityConfirmationRequired: legacy, bulkIdentityEligibleRecords: legacy ? 1 : 0, identityReview: { counts: { legacy: legacy ? 1 : 0, sharedId: legacy ? 1 : 0, otherBusiness: 0, duplicates: 0, inconsistentReferences: 0 }, records: legacy ? [{ entity: 'products', key: 'id:p1', reference: 'p1', identity: 'LEGACY', identityReason: 'SHARED_ID', bulkIdentityEligible: true, context: { name: 'Producto antiguo' } }] : [] }, priorBatch: null };
      },
      archiveFull: async (target, value, confirmed, fileSha256) => {
        window.__archiveCalls.push(['archive', target, confirmed, value.business.localBusinessId]);
        return { ok: true, batchId: '11223344-5566-7788-9900-aabbccddeeff', status: legacy ? 'BLOCKED' : 'ARCHIVED', recordsArchived: legacy ? 3 : 2, pendingRecords: legacy ? 1 : 0, blockers: legacy ? ['Revisión pendiente'] : [], packageSha256: 'b'.repeat(64), fileSha256, counts: { products: legacy ? 1 : 0 }, identityConfirmation: legacy ? { confirmed: true, packageSha256: 'b'.repeat(64), targetBusinessId: target, confirmedAt: '2026-10-22T00:00:00.000Z' } : null, identityConfirmationApplied: legacy ? 1 : 0, identityConfirmedImportableRecords: legacy ? 1 : 0 };
      },
      archiveStatus: async () => ({ batch: { manifest: { identityReviewDecisions: [] } } }),
      reviewIdentityRecord: async (...args) => {
        window.__identityReviewCalls.push(args);
        return { ok: true, batchId: args[1], businessId: args[0], entity: args[2], sourceRecordKey: args[3], decision: args[4], recordStatus: args[4] === 'EXCLUDE' ? 'EXCLUDED' : 'ARCHIVED', businessStatus: 'INACTIVE', migrationState: 'PENDING' };
      },
      projectMigrationCatalog: async (businessId, batchId) => {
        window.__catalogProjectionCalls.push([businessId, batchId]);
        return { ok: true, batchId, businessId, businessStatus: 'INACTIVE', migrationState: 'PENDING', reconciliation: { totals: { products: 1, clients: 0, suppliers: 0, productImages: 1, logo: 1 }, pending: { identityOrValidation: 0 }, differences: [], recordsByModule: { sales: { archived: 2 }, purchases: { archived: 1 }, inventoryMovements: { archived: 4 } }, stageMatched: false, fullMigrationComplete: false } };
      },
      projectMigrationOperations: async (businessId, batchId) => {
        window.__operationsProjectionCalls.push([businessId, batchId]);
        return { ok: true, batchId, businessId, businessStatus: 'INACTIVE', reconciliation: { complete: false, fullMigrationComplete: false, unresolved: true, differences: [], blockers: ['Hay información pendiente para conciliar.'], operational: { sales: { imported: 0 }, purchases: { imported: 0 } } } };
      }
    });
  }, { eligible, delayed, existingEligible, missingProtection, legacy });
  await page.locator('#migrationBusiness').selectOption('8');
  await expect(page.locator('#migrationBusiness option')).toHaveCount(2);
  await expect(page.locator('#migrationBusiness option[value="7"]')).toHaveCount(0);
  await page.locator('#migrationPackageFile').setInputFiles({ name: 'paquete-local.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(packageFixture({ legacy }))) });
  return errors;
}

for (const width of [1440, 390]) test('archivo histórico local con confirmación y diseño adaptable a ' + width + ' px', async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const errors = await openMigration(page);
  await expect(page.locator('#migrationArchiveCard')).toBeVisible();
  await expect(page.locator('#migrationArchiveReview')).toBeVisible();
  await expect(page.locator('#migrationArchiveApplyBtn')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Migrar datos' })).toHaveCount(1);
  await expect(page.getByText('Conservar el paquete completo')).toHaveCount(0);
  await expect(page.getByText('Migración completa (fases posteriores)')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Validar paquete completo' })).toHaveCount(0);
  await page.locator('#migrationArchiveConfirm').check();
  await page.locator('#migrationArchiveApplyBtn').click();
  await expect(page.locator('#migrationArchiveStatus')).toContainText('Migración pendiente de revisión.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const archiveCalls = await page.evaluate(() => window.__archiveCalls.filter(call => call[0] === 'archive'));
  expect(archiveCalls[0].slice(0, 4)).toEqual(['archive', '8', true, 'local-ui-01']);
  expect(await page.evaluate(() => window.__operationsProjectionCalls)).toEqual([['8', '11223344-5566-7788-9900-aabbccddeeff']]);
  expect(errors).toEqual([]);
});

for (const width of [1440, 390]) test('muestra qué datos ya están disponibles y qué módulos siguen pendientes en ' + width + ' px', async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await openMigration(page);
  await page.locator('#migrationArchiveConfirm').check();
  await page.locator('#migrationArchiveApplyBtn').click();
  await expect(page.locator('#migrationArchiveStatus')).toContainText('Migración pendiente de revisión.');
  await expect(page.locator('#migrationFullDifferences')).toBeVisible();
  await expect(page.locator('#migrationFullStages [data-stage="archive"]')).toHaveAttribute('data-state', 'complete');
  await expect(page.locator('#migrationFullStages [data-stage="projection"]')).toHaveAttribute('data-state', 'pending');
  await expect(page.locator('#migrationFullStages [data-stage="reconciliation"]')).toHaveAttribute('data-state', 'pending');
  expect(await page.evaluate(() => window.__operationsProjectionCalls)).toEqual([['8','11223344-5566-7788-9900-aabbccddeeff']]);
  expect(await page.evaluate(() => window.__catalogProjectionCalls)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('confirma en bloque la procedencia heredada con una sola confirmación del archivo', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openMigration(page, { legacy: true });
  await expect(page.locator('#migrationLegacyIdentityConfirmationGroup')).toBeVisible();
  await expect(page.locator('#migrationLegacyIdentityNotice')).toContainText('identificador antiguo compartido');
  await page.locator('#migrationArchiveConfirm').check();
  await expect(page.locator('#migrationArchiveApplyBtn')).toBeEnabled();
  await page.locator('#migrationArchiveApplyBtn').click();
  await expect(page.locator('#migrationArchiveStatus')).toContainText('Migración pendiente de revisión.');
  await expect(page.locator('#migrationArchiveIdentityDetails')).toBeHidden();
  expect(await page.evaluate(() => window.__identityReviewCalls)).toEqual([]);
  expect(await page.evaluate(() => window.__archiveCalls.filter(call => call[0] === 'archive').map(call => call.slice(1)))).toEqual([['8', true, 'local-ui-01']]);
  expect(await page.evaluate(() => window.__operationsProjectionCalls)).toEqual([['8', '11223344-5566-7788-9900-aabbccddeeff']]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const width of [1440, 390]) test('reserva un negocio existente vacío con confirmación y conserva su ID en ' + width + ' px', async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await openMigration(page);
  await expect(page.locator('#migrationExistingBusiness option[value="1"]')).toHaveCount(0);
  await page.locator('#migrationExistingBusiness').selectOption('7');
  await page.locator('#migrationExistingInspectBtn').click();
  await expect(page.locator('#migrationExistingReviewTitle')).toContainText('puede prepararse');
  await expect(page.locator('#migrationExistingConfirm')).toBeEnabled();
  await expect(page.locator('#migrationExistingPrepareBtn')).toBeDisabled();
  await page.locator('#migrationExistingConfirm').check();
  await page.locator('#migrationExistingPrepareBtn').click();
  await expect(page.locator('#migrationBusiness')).toHaveValue('7');
  await expect(page.locator('#migrationBusiness option[value="7"]')).toContainText('pendiente de importación');
  await expect(page.locator('#migrationExistingStatus')).toContainText('bloqueado como destino');
  expect(await page.evaluate(() => window.__existingTargetCalls)).toEqual([['inspect', '7'], ['prepare', '7', true]]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('no permite preparar un negocio existente con operaciones previas', async ({ page }) => {
  await openMigration(page, { existingEligible: false });
  await page.locator('#migrationExistingBusiness').selectOption('10');
  await page.locator('#migrationExistingInspectBtn').click();
  await expect(page.locator('#migrationExistingBlockers')).toContainText('Productos e inventario');
  await expect(page.locator('#migrationExistingConfirm')).toBeDisabled();
  await expect(page.locator('#migrationExistingPrepareBtn')).toBeDisabled();
  expect(await page.evaluate(() => window.__existingTargetCalls)).toEqual([['inspect', '10']]);
});

test('explica que faltan las migraciones de protección y muestra los signos españoles', async ({ page }) => {
  await openMigration(page, { missingProtection: true });
  await page.locator('#migrationExistingBusiness').selectOption('7');
  await page.locator('#migrationExistingInspectBtn').click();
  await expect(page.locator('#migrationExistingStatus')).toContainText('La importación todavía no está disponible');
  const rendered = await page.evaluate(() => {
    const target = document.createElement('p');
    target.textContent = new window.PosApiError('MIGRATION_GATE_SCHEMA_REQUIRED', 503).message;
    document.body.append(target);
    return target.textContent;
  });
  expect(rendered).toBe('La importación todavía no está disponible. Contacta al administrador del sistema; no se modificó ningún negocio.');
});

test('el administrador crea un destino y queda bloqueado hasta la conciliación', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openMigration(page);
  await page.locator('#migrationTargetName').fill('Origen visual');
  await page.locator('#migrationTargetPlan').selectOption('CONECTADO_BASICO');
  await page.locator('#migrationTargetCreateBtn').click();
  await expect(page.locator('#migrationTargetStatus')).toContainText('Permanecerá bloqueado');
  await expect(page.locator('#migrationBusiness')).toHaveValue('9');
  await expect(page.locator('#migrationArchiveReview')).toBeVisible();
  await expect(page.locator('#migrationArchiveConfirm')).toBeEnabled();
  await expect(page.locator('#migrationArchiveApplyBtn')).toBeDisabled();
  expect(await page.evaluate(() => window.__archiveCalls.filter(call => call[0] === 'preview').map(call => call[1]))).toContain('9');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('un paquete con identidad no verificable nunca habilita la confirmación', async ({ page }) => {
  await openMigration(page, { eligible: false });
  await expect(page.locator('#migrationArchiveConfirm')).toBeDisabled();
  await expect(page.locator('#migrationArchiveApplyBtn')).toBeDisabled();
  await expect(page.locator('#migrationArchiveStatus')).toContainText('No se guardará información');
});

test('una respuesta de validación tardía no reaparece después de cerrar el flujo', async ({ page }) => {
  await openMigration(page, { delayed: true });
  await expect.poll(() => page.evaluate(() => window.__archiveCalls.filter(call => call[0] === 'preview').length)).toBeGreaterThan(0);
  await page.evaluate(() => window.PosMigrationPreview.reset());
  await page.evaluate(() => window.__finishArchivePreview?.());
  await expect(page.locator('#migrationArchiveCard')).toBeHidden();
  await expect(page.locator('#migrationArchiveReview')).toBeHidden();
});

test('the source summary reads only the uploaded JSON, not the browser POS database', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openMigration(page);
  await page.evaluate(() => {
    const nativeIndexedDB = window.indexedDB;
    window.__indexedDBReads = 0;
    Object.defineProperty(window, 'indexedDB', { configurable: true, get() { window.__indexedDBReads++; return nativeIndexedDB; } });
    window.__localStorageReads = 0;
    const originalGet = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) { if (key === 'posSystemConfig') window.__localStorageReads++; return originalGet.call(this, key); };
  });
  await page.locator('.migration-direct-source > summary').click();
  await page.locator('#migrationRefreshBtn').click();
  await expect(page.locator('#migrationStatus')).toContainText('No se consulto el POS local');
  expect(await page.evaluate(() => [window.__indexedDBReads, window.__localStorageReads])).toEqual([0, 0]);
});
