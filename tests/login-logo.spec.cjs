const { test, expect } = require('@playwright/test');

test('el logo del login carga en modo local y conectado', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const page = await context.newPage();
  try {
    for (const mode of ['local', 'connected']) {
      const response = await page.goto('/?mode=' + mode);
      expect(response.status()).toBe(200);
      await expect(page).toHaveTitle('SoftVentaWeb');
      const logo = page.locator('#loginScreen img[src="/assets/pwa/softventaweb-logo.webp"]');
      await expect(logo).toBeVisible();
      await expect.poll(() => logo.evaluate(image => ({ complete: image.complete, naturalWidth: image.naturalWidth })))
        .toEqual({ complete: true, naturalWidth: 1440 });
      await expect(page.locator('#loginScreen .login-logo + .login-subtitle')).toHaveText('Inicia sesi\u00f3n para continuar');
      expect(await page.locator('#loginScreen').innerText()).not.toContain('POS Distribuidora');
      expect(await page.locator('.login-logo .logo-icon').count()).toBe(0);
      const logoBox = await logo.boundingBox();
      expect(logoBox.width).toBeLessThanOrEqual(260);
      expect(logoBox.height).toBeLessThanOrEqual(66);
    }
  } finally {
    await context.close();
  }
});
