/* global localDB, products, actualizarCatalogo, cajaActual */
const { test, expect } = require('@playwright/test');
const { openCash } = require('./cash-fixture.cjs');
const message = 'Debes abrir caja antes de facturar o cobrar';
const pageErrors = new WeakMap();
test.beforeEach(({page}) => { const errors=[];pageErrors.set(page,errors);page.on('pageerror',e=>errors.push(e.message)); });
test.afterEach(({page}) => { expect(pageErrors.get(page)).toEqual([]); });
async function login(page) {
  await page.goto('/'); await page.locator('#loginUsername').fill('andres'); await page.locator('#loginPassword').fill('4321'); await page.locator('#loginForm button[type=submit]').click(); await expect(page.locator('#app')).toBeVisible();
}
async function fixture(page, central=false) {
  await login(page);
  await page.evaluate(async () => {
    const p={id:'local-flow-product',business_id:'00000000-0000-0000-0000-000000000000',barcode:'FLOW',name:'Producto flujo',category:'Prueba',cost:5,retailPrice:10,wholesalePrice:9,stock:10,minStock:0,active:true,deleted:false};
    await localDB.products.put(p); products.push(p); actualizarCatalogo();
  });
  if(central) { await page.locator('#navCajaBtn').click(); await page.locator('#connectedSalesFlow').selectOption('CENTRALIZED'); await page.locator('#saveConnectedSalesFlow').click(); await expect(page.locator('#connectedSalesFlowMessage')).toContainText('Caja centralizada local'); }
}
async function add(page) { await page.locator('#navSalesBtn').click();await page.locator('#barcodeInput').fill('FLOW');await page.locator('#addBarcodeBtn').click();await expect(page.locator('#cartItems')).toContainText('Producto flujo'); }
async function dismiss(page) { await page.locator('#customAlertModal .close-modal-btn').click(); }
async function snapshot(page) { return page.evaluate(async()=>({stock:(await localDB.products.get('local-flow-product')).stock,sales:await localDB.sales.toArray(),orders:await localDB.saleOrders.toArray(),cash:await localDB.cajaSessions.toArray()})); }
async function prepare(page) { await add(page);await expect(page.locator('#processSaleBtn')).toHaveText('Enviar a Caja');await page.locator('#processSaleBtn').click();await expect(page.locator('#customAlertMessage')).toContainText('Orden enviada');await dismiss(page);await page.locator('#navCajaBtn').click();await expect(page.locator('#cajaOperacionesBody')).toContainText('Orden pendiente'); }
async function charge(page,method='cash') { await page.locator('#cajaOperacionesBody button').filter({hasText:'Cobrar'}).click();await expect(page.locator('#localOrderCheckoutModal')).toBeVisible();await page.locator('#localOrderMethod').selectOption(method);if(method==='cash')await page.locator('#localOrderReceived').fill('10');await page.locator('#localOrderConfirmBtn').click();await expect(page.locator('#ticketModal')).toBeVisible();await page.locator('#newSaleBtn').click(); }
for(const method of ['cash','card','transfer']) {
  test('venta directa local '+method+' registra turno y solo efectivo suma',async({page})=>{
    await fixture(page);await openCash(page);await add(page);await page.locator('input[name=paymentMethod][value='+method+']').check();await page.locator('#processSaleBtn').click();
    if(method==='cash'){await page.locator('#cashReceivedInput').fill('10');await page.locator('#confirmCashBtn').click();}
    await expect(page.locator('#ticketModal')).toBeVisible();const data=await snapshot(page);expect(data.stock).toBe(9);expect(data.sales).toHaveLength(1);expect(data.sales[0].estadoCaja).toBe(method==='cash'?'confirmado':'pendiente');expect(data.cash[0].movimientos).toHaveLength(1);expect(data.sales[0].cajaSessionId).toBe(data.cash[0].id);
    await page.locator('#newSaleBtn').click();await page.locator('#navCajaBtn').click();await expect(page.locator('#cajaResumenEsperado')).toHaveText(method==='cash'?'C$10.00':'C$0.00');
    if(method!=='cash'){await page.locator('#cajaOperacionesBody button').filter({hasText:'Confirmar'}).click();await expect(page.locator('#cajaOperacionesBody')).toContainText('Confirmado');const after=await snapshot(page);expect(after.sales[0].estadoCaja).toBe('confirmado');expect(after.cash[0].movimientos[0].estado).toBe('confirmado');expect(after.cash[0].movimientos[0].usuarioConfirmacion).toBeTruthy();await expect(page.locator('#cajaResumenEsperado')).toHaveText('C$0.00');}
  });
}
test('orden local persiste sin factura ni stock y caja cerrada bloquea cobro',async({page})=>{
  await fixture(page,true);await prepare(page);const before=await snapshot(page);expect(before.stock).toBe(10);expect(before.sales).toHaveLength(0);expect(before.cash).toHaveLength(0);expect(before.orders).toHaveLength(1);
  await page.locator('#cajaOperacionesBody button').filter({hasText:'Cobrar'}).click();await expect(page.locator('#customAlertMessage')).toHaveText(message);await dismiss(page);expect(await snapshot(page)).toEqual(before);
  await page.reload();await page.locator('#loginUsername').fill('andres');await page.locator('#loginPassword').fill('4321');await page.locator('#loginForm button[type=submit]').click();await page.locator('#navCajaBtn').click();await expect(page.locator('#connectedSalesFlow')).toHaveValue('CENTRALIZED');await expect(page.locator('#cajaCentralVentas')).toHaveText('C$0.00');await expect(page.locator('#cajaOperacionesBody tr[data-local-order]')).toHaveCount(1);
});
for(const method of ['cash','card','transfer']) {
  test('cobro central local '+method+' factura una vez y confirma sin inflar efectivo',async({page})=>{
    await fixture(page,true);await prepare(page);await page.locator('#cajaEfectivoInicialInput').fill('0');await page.locator('#abrirCajaBtn').click();await charge(page,method);const data=await snapshot(page);expect(data.stock).toBe(9);expect(data.sales).toHaveLength(1);expect(data.orders[0].status).toBe('COMPLETED');expect(data.orders[0].saleId).toBe(data.sales[0].id);expect(data.sales[0].cajero).toBeTruthy();
    await expect(page.locator('#cajaOperacionesBody tr[data-local-order]')).toHaveCount(0);await expect(page.locator('#cajaResumenEsperado')).toHaveText(method==='cash'?'C$10.00':'C$0.00');
    if(method!=='cash'){await page.locator('#cajaOperacionesBody button').filter({hasText:'Confirmar'}).click();await expect(page.locator('#cajaOperacionesBody')).toContainText('Confirmado');await expect(page.locator('#cajaResumenEsperado')).toHaveText('C$0.00');}
    const result=await page.evaluate(async data=>{try{await window.PosLocalFlow.record({}, {orderId:data.orders[0].id,paymentMethod:'cash',received:10});return 'unexpected';}catch(e){return e.message;}},data);expect(result).toContain('ya fue cobrada');expect((await snapshot(page)).stock).toBe(9);
  });
}
test('cancelar orden local no afecta ventas ni stock y permite desactivar centralizada',async({page})=>{
  await fixture(page,true);await prepare(page);await page.locator('#cajaOperacionesBody button').filter({hasText:'Cancelar'}).click();await page.locator('#customConfirmBtn').click();await expect(page.locator('#cajaOperacionesBody tr[data-local-order]')).toHaveCount(0);const data=await snapshot(page);expect(data.stock).toBe(10);expect(data.sales).toHaveLength(0);expect(data.orders[0].status).toBe('CANCELLED');await page.locator('#connectedSalesFlow').selectOption('DIRECT');await page.locator('#saveConnectedSalesFlow').click();await expect(page.locator('#connectedSalesFlowMessage')).toContainText('Venta directa local');await page.locator('#navSalesBtn').click();await expect(page.locator('#processSaleBtn')).toHaveText('Procesar / Cobrar Venta');
});
test('precio cambia antes del cobro local: caja muestra el vigente y exige revisión si cambia otra vez',async({page})=>{
  await fixture(page,true);await prepare(page);await page.locator('#cajaEfectivoInicialInput').fill('0');await page.locator('#abrirCajaBtn').click();await page.evaluate(async()=>{const p=await localDB.products.get('local-flow-product');p.retailPrice=12;await localDB.products.put(p);});await page.locator('#cajaOperacionesBody button').filter({hasText:'Cobrar'}).click();await expect(page.locator('#localOrderPriceNotice')).toContainText('El precio cambió');await expect(page.locator('#localOrderSummary')).toContainText('12.00');await page.locator('#localOrderReceived').fill('12');await page.evaluate(async()=>{const p=await localDB.products.get('local-flow-product');p.retailPrice=13;await localDB.products.put(p);});await page.locator('#localOrderConfirmBtn').click();await expect(page.locator('#customAlertMessage')).toContainText('El precio cambió');const data=await snapshot(page);expect(data.sales).toHaveLength(0);expect(data.stock).toBe(10);expect(data.orders[0].status).toBe('PENDING');
});
test('caja se cierra despues de revisar orden: ningún medio cobra',async({page})=>{
  await fixture(page,true);await prepare(page);await page.locator('#cajaEfectivoInicialInput').fill('0');await page.locator('#abrirCajaBtn').click();await page.locator('#cajaOperacionesBody button').filter({hasText:'Cobrar'}).click();await page.evaluate(()=>{cajaActual.estado='cerrada';});const before=await snapshot(page);
  for(const method of ['cash','card','transfer']){await page.locator('#localOrderMethod').selectOption(method);if(method==='cash')await page.locator('#localOrderReceived').fill('10');await page.locator('#localOrderConfirmBtn').click();await expect(page.locator('#customAlertMessage')).toHaveText(message);await dismiss(page);expect(await snapshot(page)).toEqual(before);}
});
test('dos cobros concurrentes de una orden local solo generan una factura',async({page})=>{
  await fixture(page,true);await prepare(page);await page.locator('#cajaEfectivoInicialInput').fill('0');await page.locator('#abrirCajaBtn').click();const results=await page.evaluate(async()=>{const [o]=await localDB.saleOrders.toArray();return Promise.all([1,2].map(async()=>{try{await window.PosLocalFlow.record(o.input,{orderId:o.id,paymentMethod:'cash',received:10});return 'ok';}catch(e){return e.message;}}));});expect(results.filter(r=>r==='ok')).toHaveLength(1);const data=await snapshot(page);expect(data.sales).toHaveLength(1);expect(data.stock).toBe(9);expect(data.cash[0].movimientos).toHaveLength(1);
});
test('fallo al guardar auditoria revierte factura, inventario, caja y orden local',async({page})=>{
  await fixture(page,true);await prepare(page);await page.locator('#cajaEfectivoInicialInput').fill('0');await page.locator('#abrirCajaBtn').click();const before=await snapshot(page);
  const result=await page.evaluate(async()=>{const [o]=await localDB.saleOrders.toArray(),save=localDB.audit_logs.add;localDB.audit_logs.add=()=>{throw new Error('Fallo de prueba');};try{await window.PosLocalFlow.record(o.input,{orderId:o.id,paymentMethod:'cash',received:10});return 'unexpected';}catch(e){return e.message;}finally{localDB.audit_logs.add=save;}});expect(result).toBe('Fallo de prueba');expect(await snapshot(page)).toEqual(before);
});
test('Caja carga una orden preparada desde otra pestaña local',async({page})=>{
  await fixture(page,true);const seller=await page.context().newPage();await login(seller);await add(seller);await seller.locator('#processSaleBtn').click();await expect(seller.locator('#customAlertMessage')).toContainText('Orden enviada');await page.locator('#navSalesBtn').click();await page.locator('#navCajaBtn').click();await expect(page.locator('#cajaOperacionesBody tr[data-local-order]')).toHaveCount(1);await seller.close();
});
for(const viewport of [{width:1280,height:720},{width:390,height:844}]) {
  test('revision y campos de cobro local accesibles '+viewport.width,async({page})=>{
    await page.setViewportSize(viewport);await fixture(page,true);await prepare(page);await page.locator('#cajaEfectivoInicialInput').fill('0');await page.locator('#abrirCajaBtn').click();await page.locator('#cajaOperacionesBody button').filter({hasText:'Cobrar'}).click();await expect(page.locator('#localOrderReceived')).toBeFocused();await page.locator('#localOrderConfirmBtn').click();await expect(page.locator('#localOrderReceived')).toHaveAttribute('aria-invalid','true');await expect(page.locator('#localOrderReceivedFieldError')).toContainText('suficiente');await expect(page.locator('#localOrderReceived')).toBeFocused();const bounds=await page.locator('#localOrderCheckoutModal .modal-card').boundingBox();expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(viewport.width+1);await page.screenshot({path:'test-results/local-order-'+viewport.width+'.png'});
  });
}
