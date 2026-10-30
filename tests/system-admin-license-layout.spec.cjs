'use strict';

const { test, expect } = require('@playwright/test');
const os = require('node:os');
const path = require('node:path');

test('license actions align on desktop and stack without overflow on mobile', async ({ page }) => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/?mode=connected');
    await page.evaluate(() => {
      const source = document.getElementById('systemAdminLicenseActionForm');
      const host = document.createElement('section');
      host.className = 'system-admin-panel';
      host.dataset.testid = 'licenseActionVisualFixture';
      host.style.display = 'block';
      host.style.width = '100%';
      host.style.maxWidth = '1100px';
      host.style.margin = '0 auto';
      const preview = source.cloneNode(true);
      preview.id = 'licenseActionLayoutPreview';
      host.append(preview);
      document.body.append(host);
    });

    const fixture = page.locator('[data-testid="licenseActionVisualFixture"]');
    const measure = async () => fixture.evaluate(host => {
      const form = host.querySelector('#licenseActionLayoutPreview');
      const rect = selector => {
        const { x, y, width, height, right, bottom } = form.querySelector(selector).getBoundingClientRect();
        return { x, y, width, height, right, bottom };
      };
      return {
        form: form.getBoundingClientRect().toJSON(),
        licenseLabel: rect('label[for="systemAdminLicenseActionId"]'),
        reasonLabel: rect('label[for="systemAdminLicenseActionReason"]'),
        license: rect('#systemAdminLicenseActionId'),
        reason: rect('#systemAdminLicenseActionReason'),
        help: rect('#systemAdminLicenseActionReasonHelp'),
        transfer: rect('#systemAdminLicenseTransferBtn'),
        revoke: rect('#systemAdminLicenseRevokeBtn'),
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth
      };
    });
    const layout = await measure();
    expect(layout.horizontalOverflow).toBe(false);
    expect(layout.license.height).toBe(40);
    expect(layout.reason.height).toBe(40);
    expect(layout.transfer.height).toBe(40);
    expect(layout.revoke.height).toBe(40);
    expect(layout.help.y).toBeGreaterThanOrEqual(layout.reason.bottom);

    if (viewport.width > 820) {
      expect(Math.abs(layout.licenseLabel.y - layout.reasonLabel.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(layout.license.y - layout.reason.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(layout.license.y - layout.transfer.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(layout.transfer.y - layout.revoke.y)).toBeLessThanOrEqual(1);
      expect(layout.reason.right).toBeLessThanOrEqual(layout.transfer.x);
    } else {
      expect(layout.reasonLabel.y).toBeGreaterThan(layout.licenseLabel.y);
      expect(layout.reason.y).toBeGreaterThan(layout.license.y);
      expect(layout.help.y).toBeGreaterThan(layout.reason.y);
      expect(layout.transfer.y).toBeGreaterThanOrEqual(layout.help.bottom);
      expect(layout.revoke.y).toBeGreaterThanOrEqual(layout.transfer.bottom);
      for (const item of [layout.license, layout.reason, layout.transfer, layout.revoke]) {
        expect(item.x).toBeGreaterThanOrEqual(layout.form.x);
        expect(item.right).toBeLessThanOrEqual(layout.form.right);
      }
    }
    await fixture.screenshot({ path: path.join(os.tmpdir(), 'pos-license-action-layout-' + viewport.width + '.png') });
  }
});
