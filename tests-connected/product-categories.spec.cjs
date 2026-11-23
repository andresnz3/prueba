const { test, expect } = require('@playwright/test');
const { randomBytes } = require('node:crypto');

const api = process.env.POS_TEST_API;
const password = 'Browser-fixture-password-123!';
const errors = new WeakMap();

test.beforeEach(async ({ page, context }) => {
  await context.addInitScript({ path: require.resolve('../tests/dexie-search-shim.js') });
  const pageErrors = [];
  errors.set(page, pageErrors);
  page.on('pageerror', error => pageErrors.push(error.message));
});

test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
});

async function loginAsAdmin(page) {
  await page.goto('/?mode=connected');
  await expect(page.locator('#loginForm button[type=submit]')).toBeEnabled();
  await page.locator('#loginUsername').fill('browseradmin');
  await page.locator('#loginPassword').fill(password);
  await page.locator('#loginForm button[type=submit]').click();
  await expect(page.locator('#app')).toBeVisible();
  await page.locator('#navInventoryBtn').click();
  await expect(page.locator('#inventoryView')).toBeVisible();
}

test('administra categorías conectadas: listar, crear, validar duplicados y renombrar', async ({ page }) => {
  await loginAsAdmin(page);
  await page.locator('#addNewProductBtn').click();
  const manage = page.locator('#manageProductCategoriesBtn');
  await expect(manage).toBeVisible();
  await manage.click();
  const dialog = page.locator('#productCategoriesModal');
  await expect(dialog).toBeVisible();

  const input = page.locator('#newProductCategoryName');
  const add = page.locator('#addProductCategoryBtn');
  const status = page.locator('#productCategoryStatus');
  await input.fill('   ');
  await add.click();
  await expect(status).toContainText('nombre de categoría');

  const categoryName = 'Prueba categoría ' + randomBytes(5).toString('hex');
  await input.fill(categoryName);
  await add.click();
  await expect(status).toContainText('Categoría agregada a este negocio.');
  const categoryInput = page.getByRole('textbox', { name: 'Nombre de la categoría ' + categoryName });
  await expect(categoryInput).toHaveValue(categoryName);

  await input.fill(categoryName.toUpperCase());
  await add.click();
  await expect(status).toContainText('Ya existe una categoría con ese nombre en este negocio.');

  const renamed = categoryName + ' renombrada';
  const row = categoryInput.locator('xpath=..');
  await categoryInput.fill(renamed);
  await row.getByRole('button', { name: 'Guardar nombre' }).click();
  await expect(status).toContainText('El nombre de la categoría se actualizó.');
  await expect(page.getByRole('textbox', { name: 'Nombre de la categoría ' + renamed })).toHaveValue(renamed);

  const client = await page.evaluate(async apiUrl => {
    const apiClient = new window.PosApiClient(apiUrl);
    await apiClient.me();
    return apiClient.productCategories();
  }, api);
  expect(client.some(category => category.name === renamed)).toBe(true);
  expect(await page.evaluate(() => localDB)).toBeNull();
});
