'use strict';

const { test, expect } = require('@playwright/test');

async function trackDocumentLoads(page) {
  await page.addInitScript(() => {
    const key = '__pos_url_cleanup_document_loads__';
    const count = Number(sessionStorage.getItem(key) || '0') + 1;
    sessionStorage.setItem(key, String(count));
  });
}

test('quita UTM y clics publicitarios sin recargar ni cambiar parámetros funcionales del modo local', async ({ page }) => {
  await trackDocumentLoads(page);
  await page.goto('/?mode=local&utm_source=chatgpt.com&utm_campaign=release&ref=partner&x=one%2Btwo&x=2&gclid=ad-click#report');
  await expect(page.locator('#loginScreen')).toBeVisible();
  await expect.poll(() => page.url()).toBe('http://127.0.0.1:5501/?mode=local&ref=partner&x=one%2Btwo&x=2#report');
  await expect(page.locator('#authMode')).toHaveValue('local');
  expect(await page.evaluate(() => Number(sessionStorage.getItem('__pos_url_cleanup_document_loads__')))).toBe(1);
});

test('quita rastreo sin afectar modo conectado, estado funcional ni fragmento de URL', async ({ page }) => {
  await trackDocumentLoads(page);
  await page.goto('/?utm_medium=email&mode=connected&state=a%2Fb&state=c&utm_source=chatgpt.com&fbclid=social-click#login');
  await expect(page.locator('#loginScreen')).toBeVisible();
  await expect.poll(() => page.url()).toBe('http://127.0.0.1:5501/?mode=connected&state=a%2Fb&state=c#login');
  await expect(page.locator('#authMode')).toHaveValue('connected');
  expect(await page.evaluate(() => Number(sessionStorage.getItem('__pos_url_cleanup_document_loads__')))).toBe(1);
});
