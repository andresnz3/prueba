const { test, expect } = require('@playwright/test');
const password = '[REDACTED_TEST_FIXTURE]';
async function login(page, username = 'browseradmin') {
  await page.goto('/?mode=connected');
  await expect(page.locator('#loginForm button[type=submit]')).toBeEnabled();
  await page.locator('#loginUsername').fill(username);
  await page.locator('#loginPassword').fill(password);
  await page.locator('#loginForm button[type=submit]').click();
  await expect(page.locator('#app')).toBeVisible();
}

test('el administrador conectado administra categorías del negocio y las ve en productos', async ({ page }) => {
  await page.addInitScript({ path: require.resolve('../tests/dexie-search-shim.js') });
  await login(page);
  await expect(page.locator('#manageProductCategoriesBtn')).toBeHidden();
  await page.locator('#navInventoryBtn').click();
  await expect(page.locator('#inventoryView')).toBeVisible();
  await page.locator('#addNewProductBtn').click();
  await expect(page.locator('#productModal')).toBeVisible();
  await expect(page.locator('#manageProductCategoriesBtn')).toBeVisible();
  await page.locator('#manageProductCategoriesBtn').click();
  await expect(page.locator('#productCategoriesModal')).toBeVisible();
  await page.locator('#newProductCategoryName').fill('Panadería QA');
  await page.locator('#addProductCategoryBtn').click();
  const categoryInput = page.getByRole('textbox', { name: 'Nombre de la categoría Panadería QA' });
  await expect(categoryInput).toHaveValue('Panadería QA');
  const row = page.locator('.product-category-row').filter({ has: categoryInput });
  await categoryInput.fill('Panadería y Café QA');
  await row.getByRole('button', { name: 'Guardar nombre' }).click();
  await expect(page.getByRole('textbox', { name: 'Nombre de la categoría Panadería y Café QA' })).toHaveValue('Panadería y Café QA');
  await page.locator('#productCategoriesModal .close-modal-btn').click();
  await expect(page.locator('#prodCategory option[value="Panadería y Café QA"]')).toHaveCount(1);
});

test('un vendedor conectado no ve controles para administrar categorías', async ({ page }) => {
  await page.addInitScript({ path: require.resolve('../tests/dexie-search-shim.js') });
  await login(page, 'browserseller');
  await expect(page.locator('#manageProductCategoriesBtn')).toBeHidden();
});
