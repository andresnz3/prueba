const { test, expect } = require('@playwright/test');
const { checkCartCheckout } = require('./pos-layout-helper.cjs');
for (const viewport of [{width:1920,height:1080},{width:1280,height:720},{width:960,height:540},{width:1366,height:600},{width:1280,height:480},{width:1440,height:900},{width:1024,height:600},{width:390,height:844}]) {
  test('Cobrar local accesible con descuento y credito ' + viewport.width + 'x' + viewport.height, async ({page}) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.locator('#loginUsername').fill('andres');
    await page.locator('#loginPassword').fill('4321');
    await page.locator('#loginForm button[type=submit]').click();
    await expect(page.locator('#app')).toBeVisible();
    await page.locator('input[name=descApplies][value=si]').check();
    await page.locator('#descuentoPct').fill('10');
    await page.locator('input[name=paymentMethod][value=credit]').check();
    await checkCartCheckout(page);
    await page.locator('#processSaleBtn').click();
    await expect(page.locator('#customAlertModal')).toBeVisible();
  });
}
