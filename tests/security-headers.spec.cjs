'use strict';

const { test, expect } = require('@playwright/test');

test('CSP del documento no bloquea login ni activos locales', async ({ page, request }) => {
  const response = await request.get('/?mode=local');
  expect(response.status()).toBe(200);
  const policy = response.headers()['content-security-policy'];
  expect(policy).toContain("default-src 'self'");
  expect(policy).toContain("script-src 'self'");
  expect(policy).toContain("script-src-attr 'unsafe-inline'");

  const violations = [];
  page.on('console', message => {
    if (message.type() === 'error' && /content security policy|refused to (?:execute|load|apply)/i.test(message.text())) {
      violations.push(message.text());
    }
  });
  await page.addInitScript(() => {
    window.__posCspViolations = [];
    document.addEventListener('securitypolicyviolation', event => {
      window.__posCspViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
    });
  });
  await page.goto('/?mode=local');
  await expect(page.locator('#loginScreen')).toBeVisible();
  expect(await page.locator('script[src]').count()).toBeGreaterThan(0);
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.__posCspViolations)).toEqual([]);
  expect(violations).toEqual([]);
});
