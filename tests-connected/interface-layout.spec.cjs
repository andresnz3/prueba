'use strict';
const { test, expect } = require('@playwright/test');
const os = require('node:os');
const path = require('node:path');

const modules = [
  ['navSalesBtn', 'salesView'], ['navInventoryBtn', 'inventoryView'], ['navPurchasesBtn', 'purchasesView'],
  ['navPayablesBtn', 'payablesView'], ['navClientsBtn', 'clientsView'], ['navSuppliersBtn', 'suppliersView'],
  ['navHistoryBtn', 'historyView'], ['navCajaBtn', 'cajaView'], ['navGastosBtn', 'gastosView'],
  ['navReportesBtn', 'reportesView'], ['navDashboardBtn', 'dashboardView'], ['navUsersBtn', 'usersView'], ['navConfigBtn', 'configView']
];

test('connected login stays compact and validation has no empty reserved blocks', async ({ page }) => {
  for (const { width, height } of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    await page.setViewportSize({ width, height });
    await page.goto('/?mode=connected');
    await expect(page.locator('#authMode')).toHaveValue('connected');
    const metrics = await page.evaluate(() => ({
      cardHeight: document.querySelector('.login-card').getBoundingClientRect().height,
      hiddenErrorDisplay: getComputedStyle(document.getElementById('loginError')).display,
      feedbackHeights: [...document.querySelectorAll('#loginForm .field-feedback')].map(slot => slot.getBoundingClientRect().height)
    }));
    expect(metrics.cardHeight).toBeLessThan(460);
    expect(metrics.hiddenErrorDisplay).toBe('none');
    expect(metrics.feedbackHeights).toEqual([0, 0]);
    await page.evaluate(() => window.PosValidation.field('loginUsername', 'El usuario necesita una corrección.', false));
    await expect(page.locator('#loginUsernameFeedback')).toHaveCSS('display', 'grid');
    expect(await page.locator('#loginUsernameFeedback').evaluate(slot => slot.getBoundingClientRect().height)).toBeLessThan(40);
    await page.screenshot({ path: path.join(os.tmpdir(), 'pos-connected-login-' + width + '.png'), fullPage: true });
  }
});

test('connected modules and global user form remain aligned across breakpoints', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/?mode=connected');
  await page.locator('#loginUsername').fill('andres');
  await page.locator('#loginPassword').fill('Browser-fixture-password-123!');
  await page.locator('#loginForm button[type="submit"]').click();
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });

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

    await page.locator('#navSystemAdminBtn').click();
    await expect(page.locator('#systemAdminView')).toBeVisible();
    await page.locator('#systemAdminUsersTab').click();
    const form = page.locator('#systemAdminUserForm');
    await expect(form).toBeVisible();
    await expect(page.locator('#systemAdminUsersCapacity')).toContainText('usuarios activos');
    const before = await form.evaluate(element => ({
      controls: [...element.querySelectorAll('input, select')].map(control => ({ top: control.getBoundingClientRect().top, height: control.getBoundingClientRect().height })),
      buttonTop: element.querySelector('button[type="submit"]').getBoundingClientRect().top,
      feedbackHeights: [...element.querySelectorAll('.field-feedback')].map(slot => slot.getBoundingClientRect().height)
    }));
    expect(before.controls.map(control => control.height)).toEqual([40, 40, 40, 40]);
    expect(before.feedbackHeights.filter(height => height > 0).length).toBe(1);
    await page.evaluate(() => window.PosValidation.field('systemAdminUsername', 'Ese nombre de usuario ya existe.', false));
    const after = await form.evaluate(element => ({
      controls: [...element.querySelectorAll('input, select')].map(control => ({ top: control.getBoundingClientRect().top, height: control.getBoundingClientRect().height })),
      buttonTop: element.querySelector('button[type="submit"]').getBoundingClientRect().top,
      overflow: document.documentElement.scrollWidth > innerWidth
    }));
    expect(after.controls.map(control => control.height)).toEqual([40, 40, 40, 40]);
    expect(after.controls[0].top).toBe(before.controls[0].top);
    if (width > 600) expect(after.buttonTop).toBe(before.buttonTop);
    else expect(after.buttonTop).toBeLessThanOrEqual(before.buttonTop + 20);
    expect(after.overflow).toBe(false);
    await page.screenshot({ path: path.join(os.tmpdir(), 'pos-connected-users-' + width + '.png'), fullPage: true });
  }
});
