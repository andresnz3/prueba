/* global localDB, products, clients, salesHistory, actualizarCatalogo, refrescarSelectClientesCredito, registrarVenta, saleNumber, cajaActual */
const { test, expect } = require('@playwright/test');
const message = 'Debes abrir caja antes de facturar o cobrar';
async function fixture(page) {
  await page.goto('/');
  await page.locator('#loginUsername').fill('andres');
  await page.locator('#loginPassword').fill('4321');
  await page.locator('#loginForm button[type=submit]').click();
  await expect(page.locator('#app')).toBeVisible();
  await page.evaluate(async () => {
    const product = {id:'cash-rule-product',business_id:'00000000-0000-0000-0000-000000000000',barcode:'CASH-RULE',name:'Caja obligatoria',category:'Prueba',cost:5,retailPrice:10,wholesalePrice:9,stock:10,minStock:0,active:true,deleted:false};
    const client = {id:'cash-rule-client',business_id:product.business_id,name:'Cliente prueba',creditLimit:100,debt:20,deudaSinFactura:10};
    const sale = {id:'cash-rule-sale',business_id:product.business_id,numero:1,metodo:'Crédito',clienteId:client.id,cliente:client.name,total:10,fechaTS:Date.now(),items:[],anulada:false};
    await localDB.products.put(product); products.push(product);
    await localDB.clients.put(client); clients.push(client);
    await localDB.sales.put(sale); salesHistory.push(sale);
    actualizarCatalogo(); refrescarSelectClientesCredito();
  });
}
async function snapshot(page) {
  return page.evaluate(async () => ({number:saleNumber,tables:await Promise.all(localDB.tables.map(async table => [table.name,await table.toArray()]))}));
}
async function dismiss(page) { await page.locator('#customAlertModal .close-modal-btn').click(); }
for (const method of ['cash','card','transfer','credit']) {
  test('caja cerrada: venta local ' + method + ' no cambia factura, stock ni registros', async ({page}) => {
    await fixture(page);
    await page.locator('#barcodeInput').fill('CASH-RULE'); await page.locator('#addBarcodeBtn').click();
    await page.locator('input[name=paymentMethod][value='+method+']').check();
    if(method==='credit') await page.locator('#creditClientSelect').selectOption('cash-rule-client');
    const before=await snapshot(page);
    await page.locator('#processSaleBtn').click();
    await expect(page.locator('#customAlertMessage')).toHaveText(message);
    await expect(page.locator('#ticketModal')).toBeHidden();
    await expect(page.locator('#cashModal')).toBeHidden();
    expect(await snapshot(page)).toEqual(before);
    await dismiss(page);
    // The final writer also rejects calls that bypass the button.
    await page.evaluate(() => registrarVenta(10,10,0));
    await expect(page.locator('#customAlertMessage')).toHaveText(message);
    expect(await snapshot(page)).toEqual(before);
  });
}
test('cerrar caja despues de abrir el modal local impide confirmar efectivo', async ({page}) => {
  await fixture(page);
  await page.locator('#navCajaBtn').click(); await page.locator('#cajaEfectivoInicialInput').fill('0'); await page.locator('#abrirCajaBtn').click();
  await expect(page.locator('#cajaAbiertaBox')).toBeVisible();
  await page.locator('#navSalesBtn').click(); await page.locator('#barcodeInput').fill('CASH-RULE'); await page.locator('#addBarcodeBtn').click(); await page.locator('#processSaleBtn').click();
  await expect(page.locator('#cashModal')).toBeVisible();
  // Simulate a closed session before the final callback, without hiding the modal.
  await page.evaluate(() => { cajaActual.estado = "cerrada"; });
  const before=await snapshot(page);
  await page.locator('#cashReceivedInput').fill('10'); await page.locator('#confirmCashBtn').click();
  await expect(page.locator('#customAlertMessage')).toHaveText(message);
  await expect(page.locator('#ticketModal')).toBeHidden(); expect(await snapshot(page)).toEqual(before);
});
for (const invoice of [false,true]) {
  test('caja cerrada: abono local '+(invoice?'de factura':'general')+' bloquea todos los medios', async ({page}) => {
    await fixture(page);
    await page.evaluate(invoice => invoice ? window.abrirAbonoVenta('cash-rule-sale') : window.abrirAbono('cash-rule-client'),invoice);
    const before=await snapshot(page);
    for(const method of ['efectivo','tarjeta','transferencia']) {
      await page.locator(invoice?'#paySaleAmount':'#payAmount').fill('1');
      await page.locator(invoice?'#paySaleMethod':'#payMethod').selectOption(method);
      await page.locator((invoice?'#paymentSaleForm':'#paymentForm')+' button[type=submit]').click();
      await expect(page.locator('#customAlertMessage')).toHaveText(message);
      expect(await snapshot(page)).toEqual(before); await dismiss(page);
    }
  });
}
