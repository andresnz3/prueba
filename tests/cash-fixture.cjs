const { expect } = require('@playwright/test');
// Existing successful-sale tests now need an open session for every payment method.
async function openCash(page) {
  await page.locator('#navCajaBtn').click();
  await page.locator('#cajaEfectivoInicialInput').fill('0');
  await page.locator('#abrirCajaBtn').click();
  await expect(page.locator('#cajaAbiertaBox')).toBeVisible();
}
module.exports = { openCash };
