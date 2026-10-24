'use strict';

const { test, expect } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');

async function showAdminUserForm(page, width) {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto('/');
  await page.evaluate(() => {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    document.querySelectorAll('.view-panel').forEach(panel => panel.classList.add('hidden'));
    document.getElementById('systemAdminView').classList.remove('hidden');
    document.querySelectorAll('.system-admin-panel').forEach(panel => panel.classList.add('hidden'));
    document.getElementById('systemAdminUsersPanel').classList.remove('hidden');
    document.getElementById('systemAdminUsersPanel').setAttribute('aria-hidden', 'false');
  });
  await expect(page.locator('#systemAdminUserForm')).toBeVisible();
}

async function userFormGeometry(page) {
  return page.locator('#systemAdminUserForm').evaluate(form => {
    const ids = ['systemAdminUsername', 'systemAdminFullName', 'systemAdminPassword', 'systemAdminRole'];
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { top: box.top, left: box.left, width: box.width, height: box.height };
    };
    return {
      labels: ids.map(id => rect(form.querySelector(`label[for="${id}"]`))),
      fields: ids.map(id => rect(document.getElementById(id))),
      button: rect(form.querySelector('button[type="submit"]')),
      form: { clientWidth: form.clientWidth, scrollWidth: form.scrollWidth }
    };
  });
}

function closeEnough(values, tolerance = 1) {
  return Math.max(...values) - Math.min(...values) <= tolerance;
}

test('panel global alinea formularios y conserva posiciones con errores en escritorio, tablet y móvil', async ({ page }) => {
  await showAdminUserForm(page, 1440);
  const desktop = await userFormGeometry(page);
  expect(closeEnough(desktop.labels.map(item => item.top))).toBe(true);
  expect(closeEnough(desktop.fields.map(item => item.top))).toBe(true);
  expect(closeEnough(desktop.fields.map(item => item.height))).toBe(true);
  expect(Math.abs(desktop.button.top - desktop.fields[0].top)).toBeLessThanOrEqual(1);
  expect(desktop.button.height).toBe(desktop.fields[0].height);

  const positionsBefore = desktop.fields.map(item => item.top).concat(desktop.button.top);
  const apiMessagePositions = await page.evaluate(() => {
    const message = document.getElementById('systemAdminMessage');
    const read = () => ['systemAdminUsername', 'systemAdminFullName', 'systemAdminPassword', 'systemAdminRole'].map(id => document.getElementById(id).getBoundingClientRect().top).concat(document.querySelector('#systemAdminUserForm button[type="submit"]').getBoundingClientRect().top);
    const hiddenHeight = message.getBoundingClientRect().height;
    const before = read();
    message.textContent = 'Error de API: ' + 'respuesta extensa con detalle. '.repeat(30);
    message.classList.remove('hidden');
    const after = read();
    return { hiddenHeight, before, after, height: message.getBoundingClientRect().height, scrollable: message.scrollHeight > message.clientHeight };
  });
  expect(apiMessagePositions.hiddenHeight).toBe(0);
  expect(Math.max(...apiMessagePositions.after.map((position, index) => position - apiMessagePositions.before[index]))).toBeLessThanOrEqual(80);
  expect(apiMessagePositions.height).toBeLessThanOrEqual(55);
  expect(apiMessagePositions.scrollable).toBe(true);
  await page.locator('#systemAdminMessage').evaluate(message => { message.textContent = ''; message.classList.add('hidden'); });
  const validationStates = await page.evaluate(() => {
    const form = document.getElementById('systemAdminUserForm');
    const username = document.getElementById('systemAdminUsername');
    const fullName = document.getElementById('systemAdminFullName');
    const password = document.getElementById('systemAdminPassword');
    const role = document.getElementById('systemAdminRole');
    const positions = () => ['systemAdminUsername', 'systemAdminFullName', 'systemAdminPassword', 'systemAdminRole']
      .map(id => document.getElementById(id).getBoundingClientRect().top)
      .concat(form.querySelector('button[type="submit"]').getBoundingClientRect().top);
    const fillValidValues = () => {
      username.value = 'valid.user';
      fullName.value = 'Usuario de prueba';
      password.value = 'Valid-Password-123!';
      role.value = 'VENDEDOR';
    };

    window.PosValidation.clear(form);
    fillValidValues();
    const validDataAccepted = window.PosValidation.validate(form);
    const afterValid = positions();

    window.PosValidation.clear(form);
    username.value = '';
    fullName.value = '';
    password.value = '';
    const emptyFormRejected = !window.PosValidation.validate(form);
    const afterEmpty = positions();

    window.PosValidation.clear(form);
    fillValidValues();
    username.value = 'yo';
    const shortUsernameRejected = !window.PosValidation.validate(form);
    const shortUsernamePatternMismatch = username.validity.patternMismatch || username.validity.tooShort;
    const afterShortUsername = positions();

    window.PosValidation.clear(form);
    const apiErrorMessage = 'El servidor rechazó la solicitud: ' + 'Detalle de validación largo. '.repeat(30);
    window.PosValidation.field('systemAdminUsername', apiErrorMessage, false);
    const slot = username.closest('.form-group').querySelector('.field-feedback');
    const apiErrorVisible = slot.querySelector('.field-error')?.textContent === apiErrorMessage;
    const apiMessageScrollable = slot.scrollHeight > slot.clientHeight;
    const afterApiError = positions();

    window.PosValidation.clear(form);
    const validationErrorCleared = !slot.querySelector('.field-error') &&
      username.getAttribute('aria-invalid') === null &&
      username.getAttribute('aria-describedby') === 'systemAdminUsernameHelp' &&
      !slot.querySelector('.field-help').hidden;
    const afterClear = positions();
    return { validDataAccepted, emptyFormRejected, shortUsernameRejected, shortUsernamePatternMismatch, apiErrorVisible, apiMessageScrollable, validationErrorCleared, afterValid, afterEmpty, afterShortUsername, afterApiError, afterClear };
  });
  expect(validationStates.validDataAccepted).toBe(true);
  expect(validationStates.emptyFormRejected).toBe(true);
  expect(validationStates.shortUsernameRejected).toBe(true);
  expect(validationStates.shortUsernamePatternMismatch).toBe(true);
  expect(validationStates.apiErrorVisible).toBe(true);
  expect(validationStates.apiMessageScrollable).toBe(true);
  expect(validationStates.validationErrorCleared).toBe(true);
  for (const positions of [validationStates.afterValid, validationStates.afterEmpty, validationStates.afterShortUsername, validationStates.afterApiError, validationStates.afterClear]) {
    expect(positions).toEqual(positionsBefore);
  }
  const positionsAfter = await userFormGeometry(page);
  expect(positionsAfter.fields.map(item => item.top).concat(positionsAfter.button.top)).toEqual(positionsBefore);
  expect(await page.locator('#systemAdminUsername').getAttribute('aria-describedby')).toContain('systemAdminUsernameHelp');
  expect(await page.locator('#systemAdminUsername').getAttribute('aria-describedby')).not.toContain('systemAdminUsernameFieldError');
  await page.screenshot({ path: path.join(os.tmpdir(), 'admin-user-form-desktop.png'), fullPage: true });

  await showAdminUserForm(page, 900);
  const tablet = await userFormGeometry(page);
  expect(closeEnough(tablet.labels.slice(0, 2).map(item => item.top))).toBe(true);
  expect(closeEnough(tablet.fields.slice(0, 2).map(item => item.top))).toBe(true);
  expect(closeEnough(tablet.labels.slice(2).map(item => item.top))).toBe(true);
  expect(closeEnough(tablet.fields.slice(2).map(item => item.top))).toBe(true);
  expect(tablet.fields.every(item => item.height === 40)).toBe(true);
  expect(tablet.form.scrollWidth).toBe(tablet.form.clientWidth);

  await showAdminUserForm(page, 390);
  const mobile = await userFormGeometry(page);
  expect(mobile.fields.every(item => item.height === 40)).toBe(true);
  expect(mobile.labels.every((item, index) => item.top < mobile.fields[index].top)).toBe(true);
  expect(mobile.fields.every((item, index) => index === 0 || item.top > mobile.fields[index - 1].top)).toBe(true);
  expect(mobile.button.top).toBeGreaterThan(mobile.fields[3].top);
  expect(mobile.form.scrollWidth).toBe(mobile.form.clientWidth);
  await page.screenshot({ path: path.join(os.tmpdir(), 'admin-user-form-mobile.png'), fullPage: true });
});

function sale(id, invoice) {
  return {
    id, numero: invoice, tipo: 'contado', metodo: 'efectivo', fechaTS: 1750000000000 + id,
    total: 10, anulada: false, items: [{ productId: 1, producto: 'Arroz', cantidad: 1, costo: 10, total: 10 }]
  };
}

test('vista previa y resultado resumen ventas; omisiones conservan factura y razón en detalles expandibles', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    document.querySelectorAll('.view-panel').forEach(panel => panel.classList.add('hidden'));
    document.getElementById('systemAdminView').classList.remove('hidden');
    const panel = document.getElementById('systemAdminMigrationPanel');
    panel.classList.remove('hidden');
    panel.setAttribute('aria-hidden', 'false');
    const omissionWarnings = [
      'Venta 14: producto sin correspondencia (P-404); se omitirá completa.',
      'Venta 15: cliente ambiguo (Diana); se omitirá.'
    ];
    window.PosMigrationPreview.show({
      canAccess: () => true,
      businesses: [{ id: '5', name: 'Destino visual de prueba', status: 'ACTIVE' }],
      migrateBasic: async () => ({ created: {}, skipped: {}, warnings: [] }),
      previewInventory: async () => ({ ok: true, eligible: true, products: { productsWithStock: 1, productsWithoutStock: 0, productsToSkip: 0, inventoryMovementsToCreate: 0 }, warnings: [] }),
      migrateInventory: async () => ({ created: { inventoryMovements: 0 }, skipped: { inventoryMovements: 0 }, warnings: [] }),
      previewSales: async () => ({ ok: true, eligible: true, gates: { basic: true, inventory: true, schema: true, targetUser: true }, sales: { detected: 4, couldMigrate: 2, toSkip: 2 }, warnings: omissionWarnings }),
      migrateSales: async () => ({ ok: true, created: { sales: 2 }, skipped: { sales: 2 }, warnings: omissionWarnings })
    });
  });
  await page.locator('#migrationBusiness').selectOption('5');
  const packageValue = {
    type: 'pos_local_migration_package', version: 1, exportedAt: '2026-10-15T12:00:00.000Z',
    business: { name: 'Origen visual de prueba' },
    summary: { products: 1, clients: 1, suppliers: 0, sales: 4, purchases: 0, cashSessions: 0, inventoryMovements: 0, abonos: 0 },
    data: { products: [{ id: 1, barcode: 'RICE-1', name: 'Arroz', category: 'Abarrotes' }], clients: [{ id: 3, name: 'Diana' }], suppliers: [], sales: [sale(14, '14'), sale(15, '15'), sale(16, '16'), sale(17, '17')], purchases: [], categories: ['Abarrotes'] }
  };
  await page.locator('#migrationPackageFile').setInputFiles({ name: 'ventas-ui.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(packageValue)) });
  await expect(page.locator('#migrationSalesStatus')).toContainText('4 detectadas, 2 preparadas y 2 omitidas');
  await expect(page.locator('#migrationSalesDetected')).toHaveText('4');
  await expect(page.locator('#migrationSalesCanMigrate')).toHaveText('2');
  await expect(page.locator('#migrationSalesToSkip')).toHaveText('2');
  await expect(page.locator('#migrationSalesPreviewSkippedDetails')).toBeVisible();
  await expect(page.locator('#migrationSalesPreviewSkippedDetails')).not.toHaveAttribute('open', '');
  await page.locator('#migrationSalesPreviewSkippedDetails > summary').click();
  await expect(page.locator('#migrationSalesPreviewSkippedWarnings')).toContainText('Venta 14: producto sin correspondencia (P-404); se omitirá completa.');
  await expect(page.locator('#migrationSalesPreviewSkippedWarnings')).toContainText('Venta 15: cliente ambiguo (Diana); se omitirá.');
  await page.locator('#migrationSalesStartBtn').click();
  await page.locator('#migrationSalesConfirmBtn').click();
  await expect(page.locator('#migrationSalesResult')).toBeVisible();
  await expect(page.locator('#migrationSalesResultDetected')).toHaveText('4');
  await expect(page.locator('#migrationSalesCreated')).toHaveText('2');
  await expect(page.locator('#migrationSalesSkipped')).toHaveText('2');
  await expect(page.locator('#migrationSalesSkippedDetails')).toBeVisible();
  await page.locator('#migrationSalesSkippedDetails > summary').click();
  await expect(page.locator('#migrationSalesWarnings')).toContainText('Venta 14: producto sin correspondencia (P-404); se omitirá completa.');
  await expect(page.locator('#migrationSalesWarnings')).toContainText('Venta 15: cliente ambiguo (Diana); se omitirá.');
  await page.screenshot({ path: path.join(os.tmpdir(), 'migration-sales-result-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#migrationSalesResult')).toBeVisible();
  const overflow = await page.locator('#migrationSalesResult').evaluate(element => element.scrollWidth > element.clientWidth);
  expect(overflow).toBe(false);
  const buttonOverflow = await page.locator('#migrationSalesStartBtn').evaluate(element => element.getBoundingClientRect().right > innerWidth);
  expect(buttonOverflow).toBe(false);
  await page.screenshot({ path: path.join(os.tmpdir(), 'migration-sales-result-mobile.png'), fullPage: true });
});

test('vista previa identifica la falta real de SQL 010 como bloqueo de esquema y conserva el modo lectura', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    document.querySelectorAll('.view-panel').forEach(panel => panel.classList.add('hidden'));
    document.getElementById('systemAdminView').classList.remove('hidden');
    const panel = document.getElementById('systemAdminMigrationPanel');
    panel.classList.remove('hidden');
    panel.setAttribute('aria-hidden', 'false');
    window.__creditWriteCalls = 0;
    window.PosMigrationPreview.show({
      canAccess: () => true,
      businesses: [{ id: '5', name: 'Destino de prueba', status: 'ACTIVE' }],
      previewCredit: async () => ({
        ok: true, previewOnly: true, canImport: false, financiallyConsistent: true, eligible: false,
        gates: { basic: true, inventory: true, schema: false, targetUser: true },
        invoices: [], payments: [], clients: [], totals: { invoices: 0, payments: 0, total: '0.00', paid: '0.00', balance: '0.00' },
        issues: [{ code: 'MIGRATION_CREDIT_SCHEMA_REQUIRED', blocking: true, message: 'Falta la migración SQL 010 de créditos históricos.' }]
      }),
      migrateCredit: async () => { window.__creditWriteCalls++; throw new Error('No debe llamarse'); }
    });
  });
  await page.locator('#migrationBusiness').selectOption('5');
  const packageValue = {
    type: 'pos_local_migration_package', version: 1, exportedAt: '2026-10-15T12:00:00.000Z', business: { name: 'Origen de prueba' },
    summary: { products: 1, clients: 1, suppliers: 0, sales: 1, purchases: 0, cashSessions: 0, inventoryMovements: 0, abonos: 0 },
    data: { products: [{ id: 1, barcode: 'P-1', name: 'Producto' }], clients: [{ id: 3, name: 'Diana', debt: 0 }], suppliers: [], sales: [sale(14, '14')], purchases: [], abonos: [], categories: [] }
  };
  await page.locator('#migrationPackageFile').setInputFiles({ name: 'credit-schema-ui.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(packageValue)) });
  await expect(page.locator('#migrationCreditStatus')).toHaveAttribute('data-state', 'blocked');
  await expect(page.locator('#migrationCreditStatus')).toContainText('Bloqueo real del destino');
  await expect(page.locator('#migrationCreditStatus')).toContainText('SQL 010');
  await expect(page.getByText(/SQL 010/)).toHaveCount(1);
  await expect(page.locator('#migrationCreditIssues li')).toHaveCount(0);
  await expect(page.locator('#migrationCreditImportBtn')).toBeDisabled();
  expect(await page.evaluate(() => window.__creditWriteCalls)).toBe(0);
  await page.screenshot({ path: path.join(os.tmpdir(), 'migration-credit-schema-blocked.png'), fullPage: true });
});
