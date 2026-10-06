const { test, expect } = require('@playwright/test');

async function login(page) {
  await page.goto('/');
  await page.locator('#loginUsername').fill('andres');
  await page.locator('#loginPassword').fill('4321');
  await page.locator('#loginForm button[type=submit]').click();
  await expect(page.locator('#app')).toBeVisible();
}

async function createProduct(page, { barcode, name, active = true }) {
  await page.locator('#navInventoryBtn').click();
  await page.locator('#addNewProductBtn').click();
  await page.locator('#prodBarcode').fill(barcode);
  await page.locator('#prodName').fill(name);
  await page.locator('#prodCategory').selectOption('Bebidas');
  await page.locator('#prodCost').fill('5');
  await page.locator('#prodStock').fill('20');
  await page.locator('#prodMinStock').fill('1');
  await page.locator('#prodStatus').selectOption(String(active));
  await page.locator('#productForm button[type=submit]').click();
  await expect(page.locator('#customAlertModal')).toBeVisible();
  await page.locator('#customAlertModal .close-modal-btn').click();
  await expect(page.locator('#productModal')).toBeHidden();
}

test('búsqueda local encuentra por código en POS, inventario y compras sin perder nombre ni estado', async ({ page }) => {
  const barcode = '7501234567890';
  const name = 'Bebida De Prueba ' + Date.now();
  const inactiveBarcode = '7509999999999';
  const inactiveName = 'Bebida Inactiva ' + Date.now();
  await page.addInitScript({ path: require.resolve('./dexie-search-shim.js') });
  await login(page);
  await createProduct(page, { barcode, name });
  await createProduct(page, { barcode: inactiveBarcode, name: inactiveName, active: false });

  const inventoryRow = page.locator('#inventoryTableBody tr').filter({ hasText: name });
  await page.locator('#inventorySearchInput').fill(`  ${barcode}  `);
  await expect(inventoryRow).toHaveCount(1);
  await page.locator('#inventorySearchInput').fill(name.toUpperCase());
  await expect(inventoryRow).toHaveCount(1);
  await page.locator('#inventorySearchInput').fill('BEBIDAS');
  await expect(page.locator('#inventoryTableBody tr').filter({ hasText: name })).toHaveCount(1);

  await page.locator('#navSalesBtn').click();
  await page.locator('#searchProductInput').fill(`  ${barcode}  `);
  const resultCard = page.locator('.product-card').filter({ hasText: name });
  await expect(resultCard.first()).toBeVisible();
  await page.locator('#searchProductInput').fill(inactiveBarcode);
  await expect(page.locator('.product-card')).toHaveCount(0);
  await page.locator('#searchProductInput').fill(`  ${barcode}  `);
  await expect(resultCard.first()).toBeVisible();
  await page.locator('#searchProductInput').press('Enter');
  await expect(page.locator('#cartItems .cart-item-row')).toHaveCount(1);
  await expect(page.locator('#cartItems .cart-item-row input[type=number]')).toHaveValue('1');

  await page.locator('#barcodeInput').fill(` ${barcode} `);
  await page.locator('#barcodeInput').press('Enter');
  await expect(page.locator('#cartItems .cart-item-row')).toHaveCount(1);
  await expect(page.locator('#cartItems .cart-item-row input[type=number]')).toHaveValue('2');
  await page.locator('#searchProductInput').fill(name.toUpperCase());
  await expect(resultCard.first()).toBeVisible();

  await page.locator('#navPurchasesBtn').click();
  await page.locator('#addNewPurchaseBtn').click();
  await page.locator('#purchProductTemp').fill(`  ${barcode}  `);
  await page.locator('#purchQtyTemp').fill('3');
  await page.locator('#purchCostTemp').fill('5.25');
  await page.locator('#btnAddItemToPurch').click();
  await expect(page.locator('#purchCartBody tr')).toHaveCount(1);
  await expect(page.locator('#purchCartBody')).toContainText(name);
});
