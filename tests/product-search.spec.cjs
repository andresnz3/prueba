/* global clients */
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
  const inventorySuggestion = page.getByRole('option', { name: new RegExp(name) }).first();
  await expect(inventorySuggestion).toBeVisible();
  expect(await page.getByRole('listbox').evaluate(list => getComputedStyle(list).backgroundColor)).toBe('rgb(255, 255, 255)');
  expect(await page.locator('#inventorySearchInput').evaluate(input => getComputedStyle(input).backgroundColor)).toBe('rgb(255, 255, 255)');
  await inventorySuggestion.click();
  await expect(inventoryRow).toBeFocused();
  await page.locator('#inventorySearchInput').fill(name.toUpperCase());
  await expect(inventoryRow).toHaveCount(1);
  await page.locator('#inventorySearchInput').fill('BEBIDAS');
  await expect(page.locator('#inventoryTableBody tr').filter({ hasText: name })).toHaveCount(1);
  await expect(page.getByRole('option', { name: new RegExp(name) }).first()).toBeVisible();

  await page.locator('#navSalesBtn').click();
  await page.locator('#searchProductInput').fill('BEBIDAS');
  await expect(page.getByRole('option', { name: new RegExp(name) }).first()).toBeVisible();
  await page.locator('#searchProductInput').press('Escape');
  await page.locator('#searchProductInput').fill(`  ${barcode}  `);
  await expect(page.getByRole('option', { name: new RegExp(name) }).first()).toBeVisible();
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
  await expect(page.getByRole('option', { name: new RegExp(name) }).first()).toBeVisible();
  await page.locator('#searchProductInput').press('Escape');
  await expect(page.getByRole('listbox')).toBeHidden();
  await page.locator('#searchProductInput').fill(name.slice(0, 8));
  await page.locator('#searchProductInput').press('ArrowDown');
  await page.locator('#searchProductInput').press('Enter');
  await expect(page.locator('#cartItems .cart-item-row input[type=number]')).toHaveValue('3');

  await page.locator('#navSuppliersBtn').click();
  await page.locator('#addNewSupplierBtn').click();
  const supplierName = 'Proveedor Autocomplete ' + Date.now();
  await page.locator('#suppName').fill(supplierName);
  await page.locator('#suppContact').fill('Contacto de prueba');
  await page.locator('#suppPhone').fill('505-8888-4444');
  await page.locator('#suppRuc').fill('RUC-AUTO-4444');
  await page.locator('#supplierForm button[type=submit]').click();
  await expect(page.locator('#customAlertModal')).toBeVisible();
  await page.locator('#customAlertModal .close-modal-btn').click();
  await page.locator('#navPurchasesBtn').click();
  await page.locator('#addNewPurchaseBtn').click();
  await page.locator('#purchSupplier').fill('RUC-AUTO');
  await expect(page.getByRole('option', { name: new RegExp(supplierName) }).first()).toBeVisible();
  await page.locator('#purchInvoice').click();
  await expect(page.getByRole('listbox')).toBeHidden();
  await page.locator('#purchSupplier').fill('RUC-AUTO');
  await page.getByRole('option', { name: new RegExp(supplierName) }).first().click();
  await expect(page.locator('#purchSupplier')).toHaveValue(supplierName);
  await page.locator('#purchProductTemp').fill(`  ${barcode}  `);
  await expect(page.getByRole('option', { name: new RegExp(name) }).first()).toBeVisible();
  await page.locator('#purchQtyTemp').fill('3');
  await page.locator('#purchCostTemp').fill('5.25');
  await page.locator('#purchProductTemp').press('Enter');
  await expect(page.locator('#purchCartBody tr')).toHaveCount(1);
  await expect(page.locator('#purchCartBody')).toContainText(name);
  await expect(page.locator('#purchCartBody')).toContainText('15.75');
});

test('POS permite elegir una sugerencia con touch', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:5500/', hasTouch: true, viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await page.addInitScript({ path: require.resolve('./dexie-search-shim.js') });
    await login(page);
    const name = 'Producto Táctil ' + Date.now();
    await createProduct(page, { barcode: 'TOUCH-' + Date.now(), name });
    await page.locator('#navSalesBtn').click();
    await page.locator('#searchProductInput').fill(name.slice(0, 8));
    const suggestion = page.getByRole('option', { name: new RegExp(name) }).first();
    await expect(suggestion).toBeVisible();
    await suggestion.tap();
    await expect(page.locator('#cartItems .cart-item-row')).toContainText(name);
  } finally {
    await context.close();
  }
});

test('búsqueda local de cliente de crédito enlaza el id exacto y limpia la selección obsoleta', async ({ page }) => {
  await page.addInitScript({ path: require.resolve('./dexie-search-shim.js') });
  await login(page);
  await page.locator('#navClientsBtn').click();
  await page.locator('#addNewClientBtn').click();
  const clientName = 'Cliente Autocomplete ' + Date.now();
  const clientRuc = 'RUC-AUTO-' + Date.now();
  await page.locator('#clientName').fill(clientName);
  await page.locator('#clientRuc').fill(clientRuc);
  await page.locator('#clientPhone').fill('505-8800-2244');
  await page.locator('#clientLimit').fill('500');
  await page.locator('#clientDebt').fill('0');
  await page.locator('#clientForm button[type=submit]').click();
  await expect(page.locator('#clientModal')).toBeHidden();
  const clientId = await page.evaluate(name => String(clients.find(client => client.name === name).id), clientName);

  await page.locator('#navSalesBtn').click();
  await page.locator('input[name=paymentMethod][value=credit]').check();
  await page.locator('#creditDays').fill('45');
  await page.locator('#creditClientSearch').fill(clientRuc.slice(0, 8));
  const suggestion = page.locator('[role="listbox"] [role="option"]').filter({ hasText: clientName }).first();
  await expect(suggestion).toBeVisible();
  expect(await suggestion.evaluate(option => getComputedStyle(option).color)).toBe('rgb(15, 23, 42)');
  await page.locator('#creditClientSearch').press('ArrowDown');
  await page.locator('#creditClientSearch').press('Enter');
  await expect(page.locator('#creditClientSelect')).toHaveValue(clientId);
  await expect(page.locator('#creditClientSearch')).toHaveValue(clientName);
  await expect(page.locator('#creditDays')).toHaveValue('45');

  await page.locator('#creditClientSearch').fill('cliente sin coincidencias');
  await expect(page.locator('#creditClientSelect')).toHaveValue('');
  await expect(page.getByRole('listbox')).toBeHidden();
  await page.locator('#creditClientSearch').fill(clientId.slice(0, 5));
  const idSuggestion = page.locator('[role="listbox"] [role="option"]').filter({ hasText: clientName }).first();
  await expect(idSuggestion).toBeVisible();
  await idSuggestion.click();
  await expect(page.locator('#creditClientSelect')).toHaveValue(clientId);

  await page.locator('#quickAddClientBtn').click();
  await expect(page.locator('#clientModal')).toBeVisible();
});
