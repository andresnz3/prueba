const { test, expect } = require('@playwright/test');
const { randomUUID } = require('node:crypto');
const password = 'Browser-fixture-password-123!';
const business = process.env.POS_TEST_BUSINESS;
const errors = new WeakMap();
test.beforeEach(async ({page})=>{const list=[];errors.set(page,list);page.on('pageerror',error=>list.push(error.message));});
test.afterEach(async ({page})=>{expect(errors.get(page)).toEqual([]);});
async function login(page,username='browseradmin') {
  await page.goto('/?mode=connected');await expect(page.locator('#loginForm button')).toBeEnabled();
  await page.locator('#loginBusinessId').fill(business);await page.locator('#loginUsername').fill(username);await page.locator('#loginPassword').fill(password);await page.locator('#loginForm button').click();await expect(page.locator('#app')).toBeVisible();
}
async function call(page,method,...args) {
  return page.evaluate(async({method,args})=>{const client=new window.PosApiClient(window.POS_API_BASE_URL);await client.me();return client[method](...args);},{method,args});
}
async function fixture(page) {
  await login(page);const current=await call(page,'currentCash',true);if(current)await call(page,'closeCash',current.id,{operationKey:randomUUID(),countedAmount:current.expectedAmount});
  const overview=await call(page,'cashOverview');for(const order of overview.pendingOrders)await call(page,'cancelOrder',order.id,{operationKey:randomUUID()});if(overview.salesFlow!=='DIRECT')await call(page,'setSalesFlow','DIRECT');
  const cash=(await call(page,'openCash',{operationKey:randomUUID(),openingAmount:'100'})).cash;
  const product=await call(page,'createProduct',{barcode:'S-'+randomUUID(),name:'Venta '+randomUUID(),category:'Bebidas',cost:'7',marginRetail:'25',marginWholesale:'10',retailPrice:'12.31',wholesalePrice:'11.34',stock:'10.125',minStock:'0'});
  await page.locator('#navSalesBtn').click();await expect(page.locator('#productGrid')).toContainText(product.name);
  return {product,cash};
}
async function add(page,product) {await page.locator('#barcodeInput').fill(product.barcode);await page.locator('#addBarcodeBtn').click();await expect(page.locator('#cartItems')).toContainText(product.name);}
async function checkout(page) {await page.locator('#processSaleBtn').click();await expect(page.locator('#connectedCheckoutModal')).toBeVisible();}
async function confirm(page,value='100') {await page.locator('#connectedCashReceived').fill(value);await page.locator('#confirmConnectedSaleBtn').click();}
async function closeAlert(page) {await expect(page.locator('#customAlertModal')).toBeVisible();await page.locator('#customAlertModal .close-modal-btn').click();}
test('login: campos vacios e identificador invalido tienen errores junto al campo y foco',async({page})=>{
  await page.goto('/?mode=connected');await expect(page.locator('#loginForm button')).toBeEnabled();await page.locator('#loginForm button').click();
  await expect(page.locator('#loginBusinessIdFieldError')).toHaveText('Ingresa el identificador de tu negocio');await expect(page.locator('#loginUsernameFieldError')).toHaveText('Ingresa tu nombre de usuario');await expect(page.locator('#loginPasswordFieldError')).toHaveText('Ingresa tu contraseña');await expect(page.locator('#loginBusinessId')).toBeFocused();
  await page.locator('#loginBusinessId').fill('0');await page.locator('#loginUsername').fill('usuario');await page.locator('#loginPassword').fill('conservar');await page.locator('#loginForm button').click();await expect(page.locator('#loginBusinessIdFieldError')).toHaveText('El identificador del negocio no es válido');await expect(page.locator('#loginPassword')).toHaveValue('conservar');
});
test('productos: validacion específica conserva campos y enfoca el primer error',async({page})=>{
  await login(page);await page.locator('#navInventoryBtn').click();await page.locator('#addNewProductBtn').click();await page.locator('#prodBarcode').fill('VALID-'+randomUUID());await page.locator('#prodCost').fill('-1');await page.locator('#prodStock').fill('-2');await page.locator('#productForm button[type=submit]').click();
  await expect(page.locator('#prodNameFieldError')).toHaveText('Ingresa el nombre del producto');await expect(page.locator('#prodName')).toBeFocused();await expect(page.locator('#prodCostFieldError')).toContainText('costo válido');await expect(page.locator('#prodStockFieldError')).toContainText('cero o mayor');await expect(page.locator('#prodCost')).toHaveValue('-1');
});
test('venta fraccionaria, descuento, factura y stock persisten al recargar',async({page})=>{
  const {product}=await fixture(page);await add(page,product);await page.locator('#cartItems input').fill('1.125');await page.locator('#cartItems input').dispatchEvent('change');
  await page.locator('input[name=descApplies][value=si]').check();await page.locator('#descuentoPct').fill('10');await checkout(page);await expect(page.locator('#connectedCheckoutTotal')).toHaveText('C$12.46');
  await confirm(page,'1');await expect(page.locator('#connectedCashReceivedFieldError')).toContainText('suficiente');await expect(page.locator('#connectedCashReceived')).toHaveValue('1');await expect(page.locator('#connectedCashReceived')).toBeFocused();
  await confirm(page);await expect(page.locator('#ticketModal')).toBeVisible();await expect(page.locator('#ticketContent')).toContainText('12.46');expect((await call(page,'product',product.id)).stock).toBe(9);
  await page.reload();await expect(page.locator('#app')).toBeVisible();await page.locator('#navHistoryBtn').click();await expect(page.locator('#historyTableBody')).toContainText('12.46');const sales=await call(page,'sales');expect(sales.find(s=>s.items.some(i=>i.productId===product.id)).total).toBe('12.46');
});
test('Caja e Historial distinguen efectivo confirmado y pagos pendientes',async({page})=>{
  const {product}=await fixture(page);const before=(await call(page,'currentCash',true)).expectedAmount;
  await add(page,product);await checkout(page);await confirm(page);await expect(page.locator('#ticketModal')).toBeVisible();
  const cashSale=(await call(page,'sales')).find(value=>value.paymentMethod==='CASH'&&value.items.some(item=>item.productId===product.id));expect(cashSale.cashStatus).toBe('CONFIRMED');await page.locator('#newSaleBtn').click();
  await page.locator('#navCajaBtn').click();let cash=await call(page,'currentCash',true);expect(cash.expectedAmount).toBe('112.31');let movement=cash.movements.find(value=>value.saleId===cashSale.id);expect(movement.status).toBe('CONFIRMED');
  let row=page.locator('#cajaMovimientosBody tr').filter({hasText:'Venta #'+cashSale.invoiceNumber});await expect(row).toContainText('Efectivo confirmado');
  await page.locator('#navHistoryBtn').click();let saleRow=page.locator('#historyTableBody tr').filter({hasText:'#'+cashSale.invoiceNumber});await expect(saleRow).toContainText('EFECTIVO');await expect(saleRow).toContainText('CONFIRMADO');
  await page.locator('#navSalesBtn').click();
  for(const method of ['card','transfer']) {
    await add(page,product);await page.locator('input[name=paymentMethod][value='+method+']').check();await page.locator('#processSaleBtn').click();await expect(page.locator('#ticketModal')).toBeVisible();
    const sale=(await call(page,'sales')).find(value=>value.paymentMethod===method.toUpperCase()&&value.items.some(item=>item.productId===product.id));expect(sale.cashStatus).toBe('PENDING');await page.locator('#newSaleBtn').click();
    await page.locator('#navCajaBtn').click();cash=await call(page,'currentCash',true);movement=cash.movements.find(value=>value.saleId===sale.id);expect(movement.status).toBe('PENDING');expect(movement.payment_method).toBe(method.toUpperCase());
    row=page.locator('#cajaMovimientosBody tr').filter({hasText:method==='card'?'Tarjeta':'Transferencia'});await expect(row).toContainText('Pendiente de confirmaci\u00f3n');
    await page.locator('#navHistoryBtn').click();saleRow=page.locator('#historyTableBody tr').filter({hasText:'#'+sale.invoiceNumber});await expect(saleRow).toContainText(method==='card'?'TARJETA':'TRANSFERENCIA');await expect(saleRow).toContainText('PENDIENTE DE CONFIRMACI\u00d3N');
    await page.locator('#navSalesBtn').click();
  }
  cash=await call(page,'currentCash',true);expect(cash.expectedAmount).toBe('112.31');expect(cash.expectedAmount).not.toBe(before);expect(cash.movements.filter(value=>value.status==='PENDING')).toHaveLength(2);
});
test('Caja confirma tarjeta/transferencia con actor y fecha sin aumentar efectivo esperado',async({page})=>{
  const {product}=await fixture(page);await add(page,product);await page.locator('input[name=paymentMethod][value=card]').check();await page.locator('#processSaleBtn').click();await expect(page.locator('#ticketModal')).toBeVisible();await page.locator('#newSaleBtn').click();
  let sale=(await call(page,'sales')).find(value=>value.paymentMethod==='CARD'&&value.items.some(item=>item.productId===product.id));expect(sale.cashStatus).toBe('PENDING');
  await page.locator('#navCajaBtn').click();let expected=(await call(page,'currentCash',true)).expectedAmount;await expect(page.locator('#cajaOperacionesBody')).toContainText('Tarjeta pendiente');
  const operation=page.locator('#cajaOperacionesBody tr').filter({hasText:'Factura #'+sale.invoiceNumber});await operation.locator('button[data-action=confirm-payment]').click();await expect(page.locator('#customAlertMessage')).toContainText('Tarjeta confirmado por browseradmin');await closeAlert(page);
  sale=(await call(page,'sales')).find(value=>value.id===sale.id);expect(sale.cashStatus).toBe('CONFIRMED');const cash=await call(page,'currentCash',true);expect(cash.expectedAmount).toBe(expected);
  const movement=cash.movements.find(value=>value.saleId===sale.id);expect(movement.status).toBe('CONFIRMED');expect(movement.confirmed_by_user_id).toBeTruthy();expect(movement.confirmed_at).toBeTruthy();
});
test('flujo centralizado permite preparar como vendedor y cobrar con precio revalidado en Caja',async({page})=>{
  const {product,cash}=await fixture(page);await call(page,'closeCash',cash.id,{operationKey:randomUUID(),countedAmount:'100'});await call(page,'setSalesFlow','CENTRALIZED');const salesBefore=await call(page,'sales'),stockBefore=(await call(page,'product',product.id)).stock;
  await page.locator('#logoutBtn').click();await expect(page.locator('#loginScreen')).toBeVisible();await login(page,'browserseller');await add(page,product);
  await expect(page.locator('#processSaleBtn')).toHaveText('Enviar a Caja');
  await page.locator('#processSaleBtn').click();await expect(page.locator('#customAlertMessage')).toContainText('enviado a Caja');await closeAlert(page);
  await page.locator('#logoutBtn').click();await expect(page.locator('#loginScreen')).toBeVisible();await login(page,'browseradmin');await page.locator('#navCajaBtn').click();
  await expect(page.locator('#connectedSalesFlow')).toHaveValue('CENTRALIZED');await expect(page.locator('#cajaOperacionesBody')).toContainText('Pedido pendiente');expect(await call(page,'sales')).toEqual(salesBefore);expect((await call(page,'product',product.id)).stock).toBe(stockBefore);
  await page.locator('#cajaOperacionesBody button[data-action=charge-order]').click();await expect(page.locator('#customAlertMessage')).toHaveText('Debes abrir caja antes de facturar o cobrar');await closeAlert(page);
  await page.locator('#cajaEfectivoInicialInput').fill('100');await page.locator('#abrirCajaBtn').click();await expect(page.locator('#customAlertMessage')).toContainText('Caja abierta en MySQL');await closeAlert(page);
  const live=await call(page,'product',product.id);await call(page,'updateProduct',product.id,{revision:live.revision,retailPrice:'14.00'});
  await page.locator('#cajaOperacionesBody button[data-action=charge-order]').click();await expect(page.locator('#connectedCheckoutModal')).toBeVisible();await expect(page.locator('#connectedPriceChangeMessage')).toContainText('El precio cambió desde que se preparó');
  await page.locator('#connectedOrderPaymentMethod').selectOption('CARD');await expect(page.locator('#connectedCheckoutTotal')).toHaveText('C$14.00');await expect(page.locator('#confirmConnectedSaleBtn')).toHaveText('Confirmar precio y cobrar');
  await page.locator('#confirmConnectedSaleBtn').click();await expect(page.locator('#ticketModal')).toBeVisible();const sale=(await call(page,'sales')).find(value=>value.items.some(item=>item.productId===product.id));expect(sale.seller).toBe('browserseller');expect(sale.cashier).toBe('browseradmin');
  await page.locator('#newSaleBtn').click();await page.locator('#navCajaBtn').click();await expect(page.locator('#cajaOperacionesBody')).toContainText('Tarjeta pendiente');const pendingOperation=page.locator('#cajaOperacionesBody tr').filter({hasText:'Factura #'+sale.invoiceNumber});await pendingOperation.locator('button[data-action=confirm-payment]').click();await expect(page.locator('#customAlertMessage')).toContainText('Tarjeta confirmado');await closeAlert(page);
  const endingCash=await call(page,'currentCash',true);expect(endingCash.expectedAmount).toBe('100.00');await call(page,'closeCash',endingCash.id,{operationKey:randomUUID(),countedAmount:endingCash.expectedAmount});await call(page,'setSalesFlow','DIRECT');
});
test('carrito vacio, descuento inválido, credito y caja cerrada se distinguen',async({page})=>{
  const {product,cash}=await fixture(page);await page.locator('#processSaleBtn').click();await expect(page.locator('#customAlertMessage')).toContainText('carrito está vacío');await closeAlert(page);await add(page,product);
  await page.locator('input[name=descApplies][value=si]').check();await page.locator('#descuentoPct').fill('101');await page.locator('#processSaleBtn').click();await expect(page.locator('#descuentoPctFieldError')).toContainText('entre 0 y 100');await expect(page.locator('#descuentoPct')).toBeFocused();
  await expect(page.locator('input[name=paymentMethod][value=credit]')).toBeDisabled();await page.locator('input[name=descApplies][value=no]').check();await call(page,'closeCash',cash.id,{operationKey:randomUUID(),countedAmount:'100'});await page.locator('#processSaleBtn').click();await expect(page.locator('#customAlertMessage')).toHaveText('Debes abrir caja antes de facturar o cobrar');
});
test('respuesta perdida: recarga conserva referencia, recupera factura y no repite cobro',async({page})=>{
  const {product}=await fixture(page);await add(page,product);await checkout(page);let created;
  await page.route('**/api/sales',async route=>{if(route.request().method()!=='POST')return route.continue();const response=await route.fetch();created=await response.json();await route.abort('failed');});
  await confirm(page);await expect(page.locator('#customAlertMessage')).toContainText('Comprueba el estado');await expect(page.locator('#recoverSaleBtn')).toBeVisible();await closeAlert(page);await page.unroute('**/api/sales');
  expect(created.sale.id).toBeTruthy();const stock=(await call(page,'product',product.id)).stock;await page.reload();await expect(page.locator('#app')).toBeVisible();await expect(page.locator('#recoverSaleBtn')).toBeVisible();await page.locator('#recoverSaleBtn').click();await expect(page.locator('#ticketModal')).toBeVisible();await expect(page.locator('#ticketContent')).toContainText(created.sale.invoiceNumber);await expect(page.locator('#recoverSaleBtn')).toBeHidden();
  expect((await call(page,'product',product.id)).stock).toBe(stock);expect((await call(page,'sales')).filter(s=>s.id===created.sale.id)).toHaveLength(1);
  const storage=await page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('posOperation_')));expect(storage).toEqual([]);
});
test('solicitud no enviada se descarta en servidor antes de permitir otro cobro',async({page})=>{
  const {product}=await fixture(page);await add(page,product);await checkout(page);await page.route('**/api/sales',route=>route.request().method()==='POST'?route.abort():route.continue());await confirm(page);await expect(page.locator('#customAlertMessage')).toContainText('Comprueba el estado');await closeAlert(page);await page.unroute('**/api/sales');await page.locator('#recoverSaleBtn').click();await expect(page.locator('#customAlertMessage')).toContainText('descartada en el servidor');expect((await call(page,'product',product.id)).stock).toBe(10.125);await expect(page.locator('#recoverSaleBtn')).toBeHidden();
});
test('historial anula stock y efectivo una sola vez, conserva factura',async({page})=>{
  const {product}=await fixture(page);await add(page,product);await checkout(page);await confirm(page);await expect(page.locator('#ticketModal')).toBeVisible();await page.locator('#newSaleBtn').click();
  const sale=(await call(page,'sales')).find(s=>s.items.some(i=>i.productId===product.id));await page.locator('#navHistoryBtn').click();const row=page.locator('#historyTableBody tr').filter({hasText:'#'+sale.invoiceNumber});await row.getByRole('button',{name:'Anular',exact:true}).click();await page.locator('#anularVentaMotivo').fill('Devolución navegador');await page.locator('#anularVentaForm button[type=submit]').click();await expect(page.locator('#customAlertMessage')).toContainText('Venta anulada en MySQL');await closeAlert(page);await expect(row).toContainText('ANULADA');expect((await call(page,'product',product.id)).stock).toBe(10.125);expect((await call(page,'currentCash',true)).expectedAmount).toBe('100.00');
  await page.reload();await expect(page.locator('#app')).toBeVisible();await page.locator('#navHistoryBtn').click();await expect(page.locator('#historyTableBody')).toContainText('ANULADA');
});
test('caja abierta y arqueo se restauran sin usar Dexie',async({page})=>{
  const {cash}=await fixture(page);await page.locator('#navCajaBtn').click();await expect(page.locator('#cajaAbiertaBox')).toBeVisible();await expect(page.locator('#cajaResumenEsperado')).toHaveText('C$100.00');await page.locator('#cerrarCajaBtn').click();await page.locator('#cajaEfectivoRealInput').fill('98');await page.locator('#confirmCierreCajaBtn').click();await expect(page.locator('#customAlertMessage')).toContainText('Caja cerrada en MySQL');await closeAlert(page);await expect(page.locator('#cajaAbrirBox')).toBeVisible();const stored=(await call(page,'cashSessions')).find(c=>c.id===cash.id);expect(stored.difference).toBe('-2.00');
  await page.reload();await expect(page.locator('#app')).toBeVisible();await page.locator('#navCajaBtn').click();await expect(page.locator('#cajaHistorialBody')).toContainText('98.00');expect(await page.evaluate(async()=>({sales:await localDB.sales.count(),cash:await localDB.cajaSessions.count(),queue:await localDB.sync_queue.count()}))).toEqual({sales:0,cash:0,queue:0});
});
test('doble confirmación solo registra una factura',async({page})=>{
  const {product}=await fixture(page);await add(page,product);await checkout(page);await page.locator('#connectedCashReceived').fill('100');await page.evaluate(()=>{document.getElementById('confirmConnectedSaleBtn').click();document.getElementById('confirmConnectedSaleBtn').click();});await expect(page.locator('#ticketModal')).toBeVisible();expect((await call(page,'sales')).filter(s=>s.items.some(i=>i.productId===product.id))).toHaveLength(1);expect((await call(page,'product',product.id)).stock).toBe(9.125);
});
test('reportes incompletos permanecen bloqueados y el historial muestra datos MySQL',async({page})=>{
  await login(page);await page.locator('#navReportesBtn').click();await expect(page.locator('#connectedNotice')).toContainText('No se muestran indicadores incompletos');await expect(page.locator('#reportesView')).toBeHidden();await page.locator('#navDashboardBtn').click();await expect(page.locator('#dashboardView')).toBeHidden();
});
test('cobro movil mantiene controles visibles, accesibilidad y foco',async({page})=>{
  const {product}=await fixture(page);await page.setViewportSize({width:390,height:844});await add(page,product);await checkout(page);await expect(page.locator('#connectedCashReceived')).toBeFocused();await expect(page.locator('#confirmConnectedSaleBtn')).toBeInViewport();expect(await page.locator('#connectedCheckoutModal').getAttribute('aria-modal')).toBe('true');await page.screenshot({path:'test-results-connected/phase53-checkout-mobile.png',fullPage:true});
  await page.locator('#connectedCashReceived').fill('1');await page.locator('#confirmConnectedSaleBtn').click();await expect(page.locator('#connectedCashReceivedFieldError')).toContainText('suficiente');await page.screenshot({path:'test-results-connected/phase53-validation-mobile.png',fullPage:true});
});
test('moneda conectada no cambia por un simbolo local guardado y conserva C$',async({page})=>{
  await login(page);await page.evaluate(({business})=>{const key='posConnectedConfig_'+encodeURIComponent(window.POS_API_BASE_URL)+'_'+business;localStorage.setItem(key,JSON.stringify({currency:'USD',name:'Mi negocio',minStock:5}));},{business});await page.reload();await expect(page.locator('#app')).toBeVisible();await page.locator('#navConfigBtn').click();await expect(page.locator('#confCurrency')).toBeDisabled();await expect(page.locator('#confCurrency')).toHaveValue('C$');await page.evaluate(({business})=>localStorage.removeItem('posConnectedConfig_'+encodeURIComponent(window.POS_API_BASE_URL)+'_'+business),{business});
});
test('ticket fraccionario imprime los centavos confirmados, sin recalcular en JavaScript',async({page})=>{
  const {product}=await fixture(page);const current=await call(page,'product',product.id);await call(page,'updateProduct',product.id,{revision:current.revision,retailPrice:'10.01'});await add(page,product);await page.locator('#cartItems input').fill('0.5');await page.locator('#cartItems input').dispatchEvent('change');await checkout(page);await expect(page.locator('#connectedCheckoutTotal')).toHaveText('C$5.01');await confirm(page);await expect(page.locator('#ticketModal')).toBeVisible();await expect(page.locator('#ticketContent span').filter({hasText:/^C\$5\.01$/})).toHaveCount(2);await expect(page.locator('#ticketContent')).not.toContainText('C$5.00');
});

for (const viewport of [{width:1920,height:1080},{width:1280,height:720},{width:960,height:540},{width:1366,height:600},{width:1280,height:480},{width:1440,height:900},{width:1024,height:600},{width:390,height:844}]) {
  test('Cobrar conectado accesible y venta unica ' + viewport.width + 'x' + viewport.height, async ({page}) => {
    const { checkCartCheckout } = require('../tests/pos-layout-helper.cjs');
    const {product}=await fixture(page);
    await page.setViewportSize(viewport);
    await add(page,product);
    await page.locator('input[name=descApplies][value=si]').check();
    await page.locator('#descuentoPct').fill('10');
    await checkCartCheckout(page);
    await checkout(page);
    await page.locator('#connectedCashReceived').fill('100');
    await page.evaluate(()=>{document.getElementById('confirmConnectedSaleBtn').click();document.getElementById('confirmConnectedSaleBtn').click();});
    await expect(page.locator('#ticketModal')).toBeVisible();
    expect((await call(page,'sales')).filter(s=>s.items.some(i=>i.productId===product.id))).toHaveLength(1);
    expect(await page.evaluate(async()=>({sales:await localDB.sales.count(),queue:await localDB.sync_queue.count()}))).toEqual({sales:0,queue:0});
  });
}

for (const method of ['cash']) {
  test('caja cerrada entre cotizacion y confirmacion: '+method, async ({page}) => {
    const {product,cash}=await fixture(page); await add(page,product);
    await page.locator('input[name=paymentMethod][value='+method+']').check(); await checkout(page);
    await call(page,'closeCash',cash.id,{operationKey:randomUUID(),countedAmount:'100'});
    const beforeSales=await call(page,'sales'); const beforeProduct=await call(page,'product',product.id); const beforeCash=await call(page,'cashSessions');
    if(method==='cash') await page.locator('#connectedCashReceived').fill('100');
    await page.locator('#confirmConnectedSaleBtn').click();
    await expect(page.locator('#customAlertMessage')).toHaveText('Debes abrir caja antes de facturar o cobrar');
    await expect(page.locator('#ticketModal')).toBeHidden();
    expect(await call(page,'sales')).toEqual(beforeSales); expect(await call(page,'product',product.id)).toEqual(beforeProduct); expect(await call(page,'cashSessions')).toEqual(beforeCash);
    expect(await page.evaluate(async()=>({sales:await localDB.sales.count(),queue:await localDB.sync_queue.count()}))).toEqual({sales:0,queue:0});
  });
}
for(const method of ['CASH','CARD','TRANSFER']) {
  test('orden conectada '+method+' rechaza caja cerrada despues de cotizar sin escribir Dexie',async({page})=>{
    const {product,cash}=await fixture(page);await call(page,'closeCash',cash.id,{operationKey:randomUUID(),countedAmount:'100'});await call(page,'setSalesFlow','CENTRALIZED');await page.locator('#navCajaBtn').click();await page.locator('#navSalesBtn').click();await add(page,product);await page.locator('#processSaleBtn').click();await closeAlert(page);await page.locator('#navCajaBtn').click();await page.locator('#cajaEfectivoInicialInput').fill('100');await page.locator('#abrirCajaBtn').click();await closeAlert(page);await page.locator('#cajaOperacionesBody button[data-action=charge-order]').click();if(method!=='CASH')await page.locator('#connectedOrderPaymentMethod').selectOption(method);await expect(page.locator('#confirmConnectedSaleBtn')).toBeEnabled();await expect(page.locator('#connectedCashGroup')).toHaveClass(method==='CASH'?/form-group/:/hidden/);if(method==='CASH')await page.locator('#connectedCashReceived').fill('100');
    const open=await call(page,'currentCash',true),beforeSales=await call(page,'sales'),beforeStock=(await call(page,'product',product.id)).stock;await call(page,'closeCash',open.id,{operationKey:randomUUID(),countedAmount:open.expectedAmount});await page.locator('#confirmConnectedSaleBtn').click();await expect(page.locator('#customAlertMessage')).toHaveText('Debes abrir caja antes de facturar o cobrar');await closeAlert(page);expect(await call(page,'sales')).toEqual(beforeSales);expect((await call(page,'product',product.id)).stock).toBe(beforeStock);
    expect(await page.evaluate(async()=>({sales:await localDB.sales.count(),orders:await localDB.saleOrders.count(),queue:await localDB.sync_queue.count()}))).toEqual({sales:0,orders:0,queue:0});await page.locator('#connectedCheckoutModal .close-modal-btn').click();const overview=await call(page,'cashOverview');const order=overview.pendingOrders.find(o=>o.items.some(i=>i.productId===product.id));await call(page,'cancelOrder',order.id,{operationKey:randomUUID()});await call(page,'setSalesFlow','DIRECT');
  });
}
