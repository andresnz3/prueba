'use strict';
const { test, expect } = require('@playwright/test');
const os = require('node:os');
const path = require('node:path');

const modules = [
  ['navSalesBtn', 'salesView'], ['navInventoryBtn', 'inventoryView'], ['navPurchasesBtn', 'purchasesView'],
  ['navPayablesBtn', 'payablesView'], ['navClientsBtn', 'clientsView'], ['navSuppliersBtn', 'suppliersView'],
  ['navHistoryBtn', 'historyView'], ['navCajaBtn', 'cajaView'], ['navGastosBtn', 'gastosView'],
  ['navReportesBtn', 'reportesView'], ['navDashboardBtn', 'dashboardView'], ['navConfigBtn', 'configView']
];

test('login stays compact on desktop, tablet, and mobile with empty and visible validation', async ({ page }) => {
  for (const { width, height } of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await expect(page.locator('#loginScreen')).toBeVisible();
    const emptyState = await page.evaluate(() => ({
      cardHeight: document.querySelector('.login-card').getBoundingClientRect().height,
      hiddenErrorDisplay: getComputedStyle(document.getElementById('loginError')).display,
      feedbackHeights: [...document.querySelectorAll('#loginForm .field-feedback')].map(slot => slot.getBoundingClientRect().height),
      documentOverflow: document.documentElement.scrollHeight > innerHeight
    }));
    expect(emptyState.cardHeight).toBeLessThan(460);
    expect(emptyState.hiddenErrorDisplay).toBe('none');
    expect(emptyState.feedbackHeights).toEqual([0, 0]);
    expect(emptyState.documentOverflow).toBe(false);

    await page.evaluate(() => window.PosValidation.field('loginUsername', 'El usuario necesita una corrección.', false));
    const errorState = await page.locator('#loginUsernameFeedback').evaluate(slot => ({ height: slot.getBoundingClientRect().height, text: slot.innerText }));
    expect(errorState.height).toBeGreaterThan(0);
    expect(errorState.height).toBeLessThan(40);
    expect(errorState.text).toContain('necesita una corrección');
    await page.screenshot({ path: path.join(os.tmpdir(), 'pos-login-layout-' + width + '.png'), fullPage: true });
  }
});

test('local navigation keeps every module at the shared content start without a hidden top band', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/');
  await page.locator('#loginUsername').fill('andres');
  await page.locator('#loginPassword').fill('Prueba-Local-Propietario-2026!');
  await page.locator('#loginForm button[type="submit"]').click();
  await expect(page.locator('#app')).toBeVisible();

  for (const { width, height } of [{ width: 1440, height: 960 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    await page.setViewportSize({ width, height });
    for (const [buttonId, viewId] of modules) {
      await page.locator('#' + buttonId).click();
      const panel = page.locator('#' + viewId);
      await expect(panel).toBeVisible();
      const measurements = await panel.evaluate(element => {
        const main = element.parentElement;
        const firstContent = [...element.children].find(child => getComputedStyle(child).display !== 'none');
        return {
          panelOffset: element.getBoundingClientRect().top - main.getBoundingClientRect().top,
          contentOffset: firstContent ? firstContent.getBoundingClientRect().top - element.getBoundingClientRect().top : 0,
          operationNoticeHeight: document.getElementById('saleOperationMessage').getBoundingClientRect().height,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth
        };
      });
      expect(measurements.panelOffset).toBeLessThanOrEqual(1);
      expect(measurements.contentOffset).toBeLessThanOrEqual(28);
      expect(measurements.operationNoticeHeight).toBe(0);
      expect(measurements.horizontalOverflow).toBe(false);
    }
    await page.locator('#navSalesBtn').click();
    await expect(page.locator('#salesView')).toBeVisible();
    await page.screenshot({ path: path.join(os.tmpdir(), 'pos-local-layout-' + width + '.png'), fullPage: true });
  }
});
