'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const salesFixturePath = path.join(__dirname, '..', 'prueba de ventas.json');

test('el JSON real muestra origen distinto y exige consentimiento antes de importar ventas históricas', async ({ page }) => {
  test.skip(!fs.existsSync(salesFixturePath), 'Se necesita el JSON local real de ventas para esta prueba.');
  await page.goto('/');
  await page.evaluate(() => {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    document.getElementById('systemAdminView').classList.remove('hidden');
    const panel = document.getElementById('systemAdminMigrationPanel');
    panel.classList.remove('hidden');
    panel.setAttribute('aria-hidden', 'false');
    window.PosMigrationPreview.show({
      canAccess: () => true,
      businesses: [{ id: '5', name: 'Destino de prueba', status: 'ACTIVE' }],
      migrateBasic: async () => ({ created: {}, skipped: {}, warnings: [] }),
      previewInventory: async () => ({
        ok: true,
        eligible: true,
        products: {
          productsWithStock: 1,
          productsWithoutStock: 0,
          productsToSkip: 1,
          inventoryMovementsToCreate: 0
        },
        warnings: ['Se omitió 1 producto porque el stock destino no coincide con el stock local; no se modificó el producto.']
      }),
      migrateInventory: async () => ({ created: { inventoryMovements: 0 }, skipped: { inventoryMovements: 1 }, warnings: [] }),
      previewSales: async (_targetBusinessId, packageValue) => {
        window.__salesPreviewCallCount = (window.__salesPreviewCallCount || 0) + 1;
        window.__salesPreviewReceivedHistoricalPrices = packageValue.data.sales.length === 4 &&
          packageValue.data.sales.every(sale => sale.items[0].retailPrice === 12.1 && sale.items[0].wholesalePrice === 12.1);
        return {
          ok: true,
          eligible: true,
          gates: { basic: true, inventory: true, schema: true, targetUser: true },
          sales: { detected: packageValue.data.sales.length, couldMigrate: packageValue.data.sales.length, toSkip: 0 },
          sourceOriginConflict: {
            required: true,
            incomingSourceBusinessName: packageValue.business.name,
            incomingSourceBusinessKey: 'b'.repeat(64),
            existingSources: [{ sourceBusinessKey: 'a'.repeat(64), sourceBusinessName: 'Paquete anterior', saleCount: 4 }]
          },
          warnings: []
        };
      },
      migrateSales: async (_targetBusinessId, _packageValue, confirmDifferentSource) => {
        window.__differentSourceConsent = confirmDifferentSource;
        return { created: { sales: 1 }, skipped: { sales: 0 }, warnings: [] };
      }
    });
  });

  await page.locator('#migrationBusiness').selectOption('5');
  await page.locator('#migrationPackageFile').setInputFiles({
    name: 'prueba de ventas.json',
    mimeType: 'application/json',
    buffer: fs.readFileSync(salesFixturePath)
  });

  await expect(page.locator('#migrationPackageStatus')).toHaveText('Paquete válido. Listo para revisión.');
  await expect(page.locator('#migrationInventorySummary')).toBeVisible();
  await expect(page.locator('#migrationInventoryStatus')).toContainText('stock destino no coincide');
  await expect(page.locator('#migrationSalesSummary')).toBeVisible();
  await expect(page.locator('#migrationSalesSummaryTitle')).toHaveText('Ventas históricas');
  await expect(page.locator('#migrationSalesDetected')).toHaveText('4');
  await expect(page.locator('#migrationSalesCanMigrate')).toHaveText('4');
  await expect(page.locator('#migrationSalesToSkip')).toHaveText('0');
  await expect(page.locator('#migrationSalesStartBtn')).toBeEnabled();
  const previewEvidence = await page.evaluate(() => ({ calls: window.__salesPreviewCallCount, pricesPreserved: window.__salesPreviewReceivedHistoricalPrices }));
  expect(previewEvidence.calls).toBeGreaterThan(0);
  expect(previewEvidence.pricesPreserved).toBe(true);
  await page.locator('#migrationSalesStartBtn').click();
  await expect(page.locator('#migrationSalesOriginWarning')).toBeVisible();
  await expect(page.locator('#migrationSalesOriginMessage')).toContainText('Paquete anterior');
  await expect(page.locator('#migrationSalesOriginMessage')).toContainText('Las facturas locales podrían repetirse');
  await expect(page.locator('#migrationSalesConfirmBtn')).toBeDisabled();
  await page.locator('#migrationSalesOriginConfirm').check();
  await expect(page.locator('#migrationSalesConfirmBtn')).toBeEnabled();
  await page.locator('#migrationSalesConfirmBtn').click();
  await expect(page.locator('#migrationSalesConfirmModal')).toBeHidden();
  expect(await page.evaluate(() => window.__differentSourceConsent)).toBe(true);
});
