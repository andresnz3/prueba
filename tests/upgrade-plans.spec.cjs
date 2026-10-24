const { test, expect } = require('@playwright/test');

test('la vista local muestra los tres planes con las mismas funciones en escritorio y móvil', async ({ page }) => {
  await page.addInitScript({ path: require.resolve('./dexie-search-shim.js') });
  await page.route('https://**/*', route => route.fulfill({
    status: 200,
    contentType: route.request().url().includes('fonts.googleapis.com') ? 'text/css' : 'application/javascript',
    body: ''
  }));
  await page.goto('/?mode=local');
  await page.locator('#loginUsername').fill('andres');
  await page.locator('#loginPassword').fill('4321');
  await page.locator('#loginForm button[type="submit"]').click();
  await expect(page.locator('#app')).toBeVisible();
  await page.locator('#navUpgradeBtn').click();
  const cards = page.locator('.upgrade-plan-card');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText('Hasta 3 usuarios: 1 administrador y 2 vendedores');
  await expect(cards.nth(1)).toContainText('Hasta 5 usuarios: 1 administrador y 4 vendedores');
  await expect(cards.nth(2)).toContainText('Hasta 10 usuarios: 1 administrador y 9 vendedores');
  for (let index = 0; index < 3; index++) {
    await expect(cards.nth(index).locator('li').nth(1)).toHaveText('Todos los módulos conectados');
    await expect(cards.nth(index).locator('li').nth(2)).toHaveText('Acceso desde varios dispositivos');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#upgradeView')).toBeVisible();
  await expect(cards.nth(2)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
