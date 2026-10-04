const { test, expect } = require('@playwright/test');
for (const currency of [undefined,null,'','undefined','null']) {
  test('configuracion antigua con moneda '+typeof currency+':'+String(currency)+' recupera C$ sin perder negocio ni flujo',async({page})=>{
    const saved={name:'Negocio conservado',phone:'88887777',salesFlow:'CENTRALIZED',...(currency===undefined?{}:{currency})};
    await page.addInitScript(value=>{if(!localStorage.getItem('currencyFixtureSeeded')){localStorage.setItem('posSystemConfig',JSON.stringify(value));localStorage.setItem('currencyFixtureSeeded','true');}},saved);
    await page.goto('/');await page.locator('#loginUsername').fill('andres');await page.locator('#loginPassword').fill('4321');await page.locator('#loginForm button[type=submit]').click();await expect(page.locator('#app')).toBeVisible();await expect(page.locator('#total')).toHaveText('C$0.00');
    await page.locator('#navCajaBtn').click();await expect(page.locator('#cajaCentralVentas')).toHaveText('C$0.00');await expect(page.locator('#connectedSalesFlow')).toHaveValue('CENTRALIZED');
    const config=await page.evaluate(()=>JSON.parse(localStorage.getItem('posSystemConfig')));expect(config.currency).toBe('C$');expect(config.name).toBe(saved.name);expect(config.phone).toBe(saved.phone);expect(config.salesFlow).toBe('CENTRALIZED');
    await page.reload();await page.locator('#loginUsername').fill('andres');await page.locator('#loginPassword').fill('4321');await page.locator('#loginForm button[type=submit]').click();await expect(page.locator('#total')).toHaveText('C$0.00');await page.locator('#navConfigBtn').click();await expect(page.locator('#confName')).toHaveValue(saved.name);await expect(page.locator('#confPhone')).toHaveValue(saved.phone);await expect(page.locator('#confCurrency')).toHaveValue('C$');
  });
}
test('la reparacion conserva una moneda personalizada valida',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('posSystemConfig',JSON.stringify({name:'Moneda propia',currency:'US$',salesFlow:'DIRECT'})));await page.goto('/');await page.locator('#loginUsername').fill('andres');await page.locator('#loginPassword').fill('4321');await page.locator('#loginForm button[type=submit]').click();await expect(page.locator('#total')).toHaveText('US$0.00');expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('posSystemConfig')).currency)).toBe('US$');
});
