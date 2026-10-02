const { test, expect } = require('@playwright/test');
const { monitorRequests } = require('./browser-diagnostics.cjs');
const browserErrors = new WeakMap();

test.beforeEach(async ({ page }) => {
  const errors = [];
  browserErrors.set(page, errors);
  monitorRequests(page, errors);
  await page.clock.install({ time: new Date('2026-10-02T11:59:00Z') });
  await page.clock.pauseAt(new Date('2026-10-02T12:00:00Z'));
  await page.goto('/');
});
test.afterEach(async ({ page }) => { expect(browserErrors.get(page)).toEqual([]); });

async function login(page, username, password) {
  await page.locator('#loginUsername').fill(username);
  await page.locator('#loginPassword').fill(password);
  await page.locator('#loginForm button[type=submit]').click();
  await expect(page.locator('#salesView')).toBeVisible();
}

test('enfoque pendiente de Ventas no interrumpe la contrasena de autorizacion', async ({ page }) => {
  await login(page, 'vendedor1', '1234');
  await page.clock.runFor(50);
  await page.locator('#navConfigBtn').click();
  await expect(page.locator('#authModal')).toBeVisible();
  await page.locator('#gestorPassword').fill('43');
  await page.clock.runFor(50);
  await expect(page.locator('#gestorPassword')).toBeFocused();
  await page.keyboard.type('21');
  await expect(page.locator('#gestorPassword')).toHaveValue('4321');
  await expect(page.locator('#barcodeInput')).toHaveValue('');
  await page.locator('#authForm button[type=submit]').click();
  await expect(page.locator('#configView')).toBeVisible();
});

test('enfoque pendiente del escaner no interrumpe otro campo de Ventas', async ({ page }) => {
  await login(page, 'andres', '4321');
  await page.locator('input[name=descApplies][value=si]').check();
  await page.locator('#descuentoPct').fill('2');
  await page.clock.runFor(100);
  await expect(page.locator('#descuentoPct')).toBeFocused();
  await page.keyboard.type('0');
  await expect(page.locator('#descuentoPct')).toHaveValue('20');
  await expect(page.locator('#barcodeInput')).toHaveValue('');
});
