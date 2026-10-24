'use strict';

const { test, expect } = require('@playwright/test');

function purchase(id, invoice, quantity, total) {
  return {
    id, fechaTS: 1750000000000 + id, factura: invoice, tipo: 'contado', proveedorId: 9,
    proveedor: 'Distribuidora Norte', total, anulada: false,
    items: [{ productId: 104, producto: 'Arroz', cantidad: quantity, costo: 4.25, total }]
  };
}

test('la vista previa de compras se actualiza y pide confirmación explícita antes de importar una sola vez', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    document.getElementById('systemAdminView').classList.remove('hidden');
    const panel = document.getElementById('systemAdminMigrationPanel');
    panel.classList.remove('hidden');
    panel.setAttribute('aria-hidden', 'false');
    window.__purchaseImportCount = 0;
    window.PosMigrationPreview.show({
      canAccess: () => true,
      businesses: [{ id: '5', name: 'Destino de prueba', status: 'ACTIVE' }],
      migrateBasic: async () => ({ created: {}, skipped: {}, warnings: [] }),
      previewPurchases: async (_targetBusinessId, packageValue) => ({
        ok: true, eligible: true,
        gates: { basic: true, schema: true, targetUser: true },
        purchases: { detected: packageValue.data.purchases.length, couldMigrate: packageValue.data.purchases.length, toSkip: 0 },
        diagnostics: { suppliersUnmatched: 0, suppliersAmbiguous: 0, productsUnmatched: 0, productsAmbiguous: 0, duplicateInvoices: 0, missingCosts: 0, inconsistentTotals: 0, unsupportedStatuses: 0 },
        warnings: []
      }),
      migratePurchases: async () => {
        window.__purchaseImportCount++;
        await new Promise(resolve => { window.__finishPurchaseImport = resolve; });
        return { ok: true, created: { purchases: 4 }, skipped: { purchases: 0 }, warnings: [] };
      }
    });
  });

  await page.locator('#migrationBusiness').selectOption('5');
  const purchases = [
    purchase(1750000000001, 'FC-501', 2, 8.5), purchase(1750000000002, 'FC-502', 1, 4.25),
    purchase(1750000000003, 'FC-503', 2, 8.5), purchase(1750000000004, 'FC-504', 1, 4.25)
  ];
  const file = {
    type: 'pos_local_migration_package', version: 1, exportedAt: '2026-10-14T12:00:00.000Z',
    business: { name: 'POS local de prueba' },
    summary: { products: 1, clients: 0, suppliers: 1, sales: 0, purchases: 4, cashSessions: 0, inventoryMovements: 0, abonos: 0 },
    data: {
      products: [{ id: 104, barcode: '00123', name: 'Arroz', category: 'Abarrotes' }],
      clients: [], suppliers: [{ id: 9, name: 'Distribuidora Norte' }], purchases, sales: [], categories: ['Abarrotes']
    }
  };
  await page.locator('#migrationPackageFile').setInputFiles({ name: 'compras-fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });

  await expect(page.locator('#migrationPurchasesSummary')).toBeVisible();
  await expect(page.locator('#migrationPurchasesDetected')).toHaveText('4');
  await expect(page.locator('#migrationPurchasesCanMigrate')).toHaveText('4');
  await expect(page.locator('#migrationPurchasesToSkip')).toHaveText('0');
  await expect(page.locator('#migrationPurchasesStartBtn')).toBeEnabled();
  await page.locator('#migrationPurchasesStartBtn').click();
  await expect(page.locator('#migrationPurchasesConfirmModal')).toBeVisible();
  await expect(page.locator('#migrationPurchasesConfirmDescription')).toContainText('No aumentarán inventario');
  await page.locator('#migrationPurchasesConfirmBtn').click();
  await expect(page.locator('#migrationPurchasesConfirmBtn')).toBeDisabled();
  await expect(page.locator('#migrationPurchasesCancelBtn')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.__purchaseImportCount)).toBe(1);
  await page.evaluate(() => window.__finishPurchaseImport());
  await expect(page.locator('#migrationPurchasesConfirmModal')).toBeHidden();
  await expect(page.locator('#migrationPurchasesCreated')).toHaveText('4');
  await expect(page.locator('#migrationPurchasesSkipped')).toHaveText('0');
  await expect(page.locator('#migrationPurchasesStartBtn')).toBeDisabled();
  expect(await page.evaluate(() => window.__purchaseImportCount)).toBe(1);
});
