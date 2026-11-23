const { test, expect } = require('@playwright/test');

test('el propietario local crea y renombra categorías propias del negocio', async ({ page }) => {
  await page.goto('/?mode=local');
  await expect(page.locator('#manageProductCategoriesBtn')).toBeHidden();
  await page.locator('#loginUsername').fill('andres');
  await page.locator('#loginPassword').fill('Prueba-Local-Propietario-2026!');
  await page.locator('#loginForm button[type="submit"]').click();
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#manageProductCategoriesBtn')).toBeHidden();
  await page.locator('#navInventoryBtn').click();
  await expect(page.locator('#inventoryView')).toBeVisible();
  await page.locator('#addNewProductBtn').click();
  await expect(page.locator('#productModal')).toBeVisible();
  await expect(page.locator('#manageProductCategoriesBtn')).toBeVisible();

  await page.locator('#manageProductCategoriesBtn').click();
  await expect(page.locator('#productCategoriesModal')).toBeVisible();
  await page.locator('#newProductCategoryName').fill('Panadería');
  await page.locator('#addProductCategoryBtn').click();
  const categoryInput = page.getByRole('textbox', { name: 'Nombre de la categoría Panadería' });
  await expect(categoryInput).toHaveValue('Panadería');
  const row = page.locator('.product-category-row').filter({ has: categoryInput });
  await categoryInput.fill('Panadería Norte');
  await row.getByRole('button', { name: 'Guardar nombre' }).click();
  const renamedCategoryInput = page.getByRole('textbox', { name: 'Nombre de la categoría Panadería Norte' });
  await expect(renamedCategoryInput).toHaveValue('Panadería Norte');
  const renamedRow = page.locator('.product-category-row').filter({ has: renamedCategoryInput });
  await renamedRow.getByRole('button', { name: 'Desactivar' }).click();
  await expect(renamedRow.getByRole('button', { name: 'Activar' })).toBeVisible();
  await expect(page.locator('#prodCategory option[value="Panadería Norte"]')).toHaveCount(0);
  await renamedRow.getByRole('button', { name: 'Activar' }).click();
  await expect(renamedRow.getByRole('button', { name: 'Desactivar' })).toBeVisible();
  await expect(page.locator('#prodCategory option[value="Panadería Norte"]')).toHaveCount(1);
  await page.locator('#productCategoriesModal .close-modal-btn').click();

  await expect(page.locator('#prodCategory option[value="Panadería Norte"]')).toHaveCount(1);
  await expect(page.locator('#productCategoriesModal')).toBeHidden();
});
