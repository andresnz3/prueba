/* global localDB, PosApiError */
const { test, expect } = require('@playwright/test');
const { checkCartCheckout } = require('./pos-layout-helper.cjs');
// HTTP fixtures exercise the real connected frontend without any MySQL writes.
async function connectedFixture(page, closed = false, loseResponse = false, productOverrides = {}, fixtureClients = []) {
  await page.addInitScript({ path: require.resolve('./dexie-search-shim.js') });
  const unexpected = [], errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  const user = {id:'1',businessId:'1',username:'fixture',fullName:'Fixture',role:'ADMIN',active:true};
  const product = {id:'1',businessId:'1',barcode:'VISUAL',name:'Producto visual',category:'Pruebas',active:true,deleted:false,image:null,retailPrice:'10.00',wholesalePrice:'9.00',stock:'20.000',minStock:'0.000',...productOverrides};
  let result;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let body;
    if(path === '/api/auth/me') body = {user,csrfToken:'a'.repeat(43),expiresAt:new Date(Date.now()+3600000).toISOString()};
    else if(path === '/api/auth/modules/sales/enter') body = {module:'sales',allowed:true};
    else if(path === '/api/auth/access/sales') body = {module:'sales',allowed:true};
    else if(path === '/api/business-settings/sales-flow') body = {businessId:'1',salesFlow:'DIRECT'};
    else if(path === '/api/sales/clients') { const offset=Number(new URL(route.request().url()).searchParams.get('offset')||0); body = {clients:fixtureClients.slice(offset,offset+100)}; }
    else if(path === '/api/auth/access/clients' || path === '/api/auth/modules/clients/enter') body = {module:'clients',allowed:true};
    else if(path === '/api/clients') body = {clients:fixtureClients};
    else if(path === '/api/receivables') body = {receivables:[]};
    else if(path === '/api/catalog/products') body = {products:[product]};
    else if(path === '/api/cash/sessions') body = {sessions:[]};
    else if(path === '/api/cash/overview') body = {overview:{businessId:'1',salesFlow:'DIRECT',salesByUser:[],pendingPayments:[],pendingOrders:[],movements:[],expectedAmount:'0.00',customerCollections:'0.00',lastDifference:'0.00'}};
    else if(path === '/api/sales/quote') {
      if(closed) return route.fulfill({status:409,json:{error:{code:'CASH_CLOSED'}}});
      body = {quote:{businessId:'1',quoteToken:'a'.repeat(64),paymentMethod:'CASH',subtotal:'10.00',discount:'1.00',total:'9.00',items:[{productId:'1',name:product.name,quantity:'1.000',total:'9.00'}]}};
    } else if(path === '/api/sales' && route.request().method() === 'POST') {
      writes.push(route.request().postDataJSON());
      result = {kind:'SALE',sale:{id:'1',businessId:'1',invoiceNumber:'000001',status:'COMPLETED',seller:'Fixture',createdAt:new Date().toISOString(),paymentMethod:'CASH',cashStatus:'CONFIRMED',priceType:'RETAIL',subtotal:'10.00',discount:'1.00',discountPercent:'10.0000',total:'9.00',tax:'0.00',cashReceived:'100.00',changeAmount:'91.00',cashSessionId:'1',items:[{productId:'1',name:product.name,barcode:product.barcode,quantity:'1.000',unitPrice:'10.00',subtotal:'10.00'}]}};
      if(loseResponse) return route.abort('failed');
      body=result;
    } else if(path.startsWith('/api/operations/') && path.endsWith('/resolve')) body=result;
    else {unexpected.push(path);return route.fulfill({status:500,json:{error:{code:'INTERNAL_ERROR'}}});}
    await route.fulfill({json:body});
  });
  await page.goto('/?mode=connected');
  await expect(page.locator('#app')).toBeVisible();
  await page.locator('#barcodeInput').fill(product.barcode);
  await page.locator('#addBarcodeBtn').click();
  if (product.active && Number(product.stock) > 0) await expect(page.locator('#cartItems')).toContainText(product.name);
  else await expect(page.locator('#cartItemCount')).toHaveText('0 productos');
  if (product.active && Number(product.stock) > 0) {
    await page.locator('input[name=descApplies][value=si]').check();
    await page.locator('#descuentoPct').fill('10');
  }
  return {writes,unexpected,errors};
}
for (const viewport of [{width:1920,height:1080},{width:1280,height:720},{width:960,height:540},{width:1366,height:600},{width:1280,height:480},{width:1440,height:900},{width:1024,height:600},{width:390,height:844}]) {
  test('frontend conectado HTTP: Cobrar accesible ' + viewport.width + 'x' + viewport.height, async ({page}) => {
    await page.setViewportSize(viewport);
    const fixture=await connectedFixture(page);
    if (viewport.width > 1024) {
      // Check before hover/click/scroll: those can conceal an offscreen action.
      expect(await page.locator('#processSaleBtn').evaluate(element => {
        const r = element.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight && element.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
      })).toBe(true);
    }
    await checkCartCheckout(page);
    await page.screenshot({path:test.info().outputPath('carrito.png')});
    await page.locator('#processSaleBtn').click();
    await expect(page.locator('#connectedCheckoutModal')).toBeVisible();
    await page.locator('#connectedCashReceived').fill('100');
    await page.evaluate(()=>{document.getElementById('confirmConnectedSaleBtn').click();document.getElementById('confirmConnectedSaleBtn').click();});
    await expect(page.locator('#ticketModal')).toBeVisible();
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.unexpected).toEqual([]);expect(fixture.errors).toEqual([]);
    expect(await page.evaluate(async()=>({sales:await localDB.sales.count(),queue:await localDB.sync_queue.count()}))).toEqual({sales:0,queue:0});
  });
}
test('frontend conectado HTTP: caja cerrada explica como abrirla sin enviar venta', async ({page}) => {
  const fixture=await connectedFixture(page,true);
  await page.locator('#processSaleBtn').click();
  await expect(page.locator('#customAlertMessage')).toHaveText('Debes abrir caja antes de facturar o cobrar');
  await expect(page.locator('#connectedCheckoutModal')).toBeHidden();
  expect(fixture.writes).toHaveLength(0);expect(fixture.unexpected).toEqual([]);expect(fixture.errors).toEqual([]);
});
test('frontend conectado HTTP: respuesta perdida bloquea otro cobro y recupera la factura', async ({page}) => {
  const fixture=await connectedFixture(page,false,true);
  await page.locator('#processSaleBtn').click();
  await page.locator('#connectedCashReceived').fill('100');
  await page.locator('#confirmConnectedSaleBtn').click();
  await expect(page.locator('#customAlertMessage')).toContainText('Comprueba el estado');
  await page.locator('#customAlertModal .close-modal-btn').click();
  await page.locator('#processSaleBtn').click();
  await expect(page.locator('#customAlertMessage')).toContainText('operaci\u00f3n pendiente');
  await page.locator('#customAlertModal .close-modal-btn').click();
  await page.locator('#recoverSaleBtn').click();
  await expect(page.locator('#ticketModal')).toBeVisible();
  expect(fixture.writes).toHaveLength(1);expect(fixture.unexpected).toEqual([]);expect(fixture.errors).toEqual([]);
});

test('conectado: clic en tarjeta y codigo de barras comparten carrito y actualizan importes', async ({page}) => {
  const fixture=await connectedFixture(page);
  await page.locator('#productGrid .product-card').click();
  await expect(page.locator('#cartItemCount')).toHaveText('1 productos');
  await expect(page.locator('#cartItems input[type=number]')).toHaveValue('2');
  await expect(page.locator('#cartItems')).toContainText('C$20.00');
  await expect(page.locator('#subtotal')).toHaveText('C$20.00');
  await expect(page.locator('#total')).toHaveText('C$18.00');
  await expect(page.locator('#processSaleBtn')).toBeVisible();
  expect(await page.evaluate(()=>window.PosRuntime.salesInput().items)).toEqual([{productId:'1',quantity:'2'}]);
  expect(fixture.errors).toEqual([]);expect(fixture.unexpected).toEqual([]);
});
test('conectado: codigo de producto inactivo muestra un mensaje especifico', async ({page}) => {
  const {errors,unexpected}=await connectedFixture(page,false,false,{active:false});
  await expect(page.locator('#cartItemCount')).toHaveText('0 productos');
  await page.locator('#customAlertModal .close-modal-btn').click();
  await page.locator('#barcodeInput').fill('VISUAL');await page.locator('#addBarcodeBtn').click();
  await expect(page.locator('#customAlertMessage')).toHaveText('El producto est\u00e1 inactivo y no se puede agregar al carrito.');
  await expect(page.locator('#cartItemCount')).toHaveText('0 productos');
  expect(errors).toEqual([]);expect(unexpected).toEqual([]);
});
test('conectado: producto sin stock explica el bloqueo y mantiene el carrito vacio', async ({page}) => {
  const {errors,unexpected}=await connectedFixture(page,false,false,{stock:'0.000'});
  await expect(page.locator('#customAlertMessage')).toContainText('STOCK INSUFICIENTE');
  await expect(page.locator('#cartItemCount')).toHaveText('0 productos');
  expect(errors).toEqual([]);expect(unexpected).toEqual([]);
});
test('conectado: fallo de inventario informa que debe restablecerse la conexion', async ({page}) => {
  const fixture=await connectedFixture(page);
  await page.unroute('**/api/**');
  await page.route('**/api/**', async route => {
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/auth/me') return route.fulfill({json:{user:{id:'1',businessId:'1',username:'fixture',fullName:'Fixture',role:'ADMIN',active:true},csrfToken:'a'.repeat(43),expiresAt:new Date(Date.now()+3600000).toISOString()}});
    if(path==='/api/auth/access/inventory') return route.fulfill({json:{module:'inventory',allowed:true}});
    if(path==='/api/auth/modules/inventory/enter') return route.fulfill({json:{module:'inventory',allowed:true}});
    if(path==='/api/products') return route.abort('failed');
    return route.fulfill({json:{products:[]}});
  });
  await page.locator('#navInventoryBtn').click();
  await expect(page.locator('#connectedNotice')).toContainText('No se pudo conectar con el servidor');
  expect(fixture.writes).toHaveLength(0);expect(fixture.errors).toEqual([]);
});

test('conectado: codigo desconocido indica que no existe en el inventario conectado', async ({page}) => {
  const {errors,unexpected}=await connectedFixture(page);
  await page.locator('#barcodeInput').fill('NO-EXISTE');await page.locator('#addBarcodeBtn').click();
  await expect(page.locator('#customAlertMessage')).toHaveText('Producto no encontrado en el inventario conectado.');
  await expect(page.locator('#cartItemCount')).toHaveText('1 productos');
  expect(errors).toEqual([]);expect(unexpected).toEqual([]);
});

test('cliente conectado sugiere por teléfono e id, conserva plazo y limpia id obsoleto', async ({page}) => {
  const client={id:'123456',businessId:'1',name:'Cliente conectado',phone:'505-7777-1212',ruc:'RUC-CONECTADO-88',active:true,creditLimit:'600.00',debt:'100.00',availableCredit:'500.00',pendingPayments:'0.00',creditDays:21};
  const fixture=await connectedFixture(page,false,false,{},[client]);
  await page.locator('input[name=paymentMethod][value=credit]').check();
  await expect(page.locator('#creditClientSelect option[value="123456"]')).toHaveCount(1);
  await page.locator('#creditClientSearch').fill('505-7777');
  const suggestion=page.locator('[role="listbox"] [role="option"]').filter({hasText:'Cliente conectado'}).first();
  await expect(suggestion).toBeVisible();
  await page.locator('#creditClientSearch').press('ArrowDown');
  await page.locator('#creditClientSearch').press('Enter');
  await expect(page.locator('#creditClientSelect')).toHaveValue('123456');
  await expect(page.locator('#creditDays')).toHaveValue('21');
  await page.locator('#creditClientSearch').fill('sin coincidencias');
  await expect(page.locator('#creditClientSelect')).toHaveValue('');
  await expect(page.locator('#creditDays')).toHaveValue('30');
  await page.locator('#creditClientSearch').fill('12345');
  const idSuggestion=page.locator('[role="listbox"] [role="option"]').filter({hasText:'Cliente conectado'}).first();
  await expect(idSuggestion).toBeVisible();
  await idSuggestion.click();
  await expect(page.locator('#creditClientSelect')).toHaveValue('123456');
  expect(await page.evaluate(()=>new PosApiError('CANCEL_REQUIRES_OPEN_CASH').message)).toBe('Para anular esta venta debe abrir una caja, porque la devolución se registra en la caja actual.');
  await page.locator('#clearCartBtn').click();
  await expect(page.locator('#customConfirmModal')).toBeVisible();
  await page.locator('#customConfirmBtn').click();
  await page.locator('#quickAddClientBtn').click();
  await expect(page.locator('#clientModal')).toBeVisible();
  expect(await page.evaluate(async()=>({sales:await localDB.sales.count(),queue:await localDB.sync_queue.count()}))).toEqual({sales:0,queue:0});
  expect(fixture.unexpected).toEqual([]);expect(fixture.errors).toEqual([]);
});

test('clientes conectados sugiere la búsqueda de la tabla por teléfono', async ({page}) => {
  const client={id:'123456',businessId:'1',name:'Cliente conectado',phone:'505-7777-1212',ruc:'RUC-CONECTADO-88',active:true,creditLimit:'600.00',debt:'100.00',availableCredit:'500.00',pendingPayments:'0.00',creditDays:21};
  const fixture=await connectedFixture(page,false,false,{},[client]);
  await page.locator('#clearCartBtn').click();
  await expect(page.locator('#customConfirmModal')).toBeVisible();
  await page.locator('#customConfirmBtn').click();
  await page.locator('#navClientsBtn').click();
  await expect(page.locator('#clientsView')).toBeVisible();
  await page.locator('#clientSearchInput').fill('505-7777');
  const clientSearchSuggestion=page.locator('[role="listbox"] [role="option"]').filter({hasText:'Cliente conectado'}).first();
  await expect(clientSearchSuggestion).toBeVisible();
  await page.locator('#clientSearchInput').press('ArrowDown');
  await page.locator('#clientSearchInput').press('Enter');
  await expect(page.locator('#clientSearchInput')).toHaveValue('Cliente conectado');
  await expect(page.locator('#clientsTableBody tr')).toHaveCount(1);
  expect(await page.evaluate(async()=>({sales:await localDB.sales.count(),queue:await localDB.sync_queue.count()}))).toEqual({sales:0,queue:0});
  expect(fixture.unexpected).toEqual([]);expect(fixture.errors).toEqual([]);
});

test('credit client picker stays readable in a narrow checkout panel', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  const client={id:'123456',businessId:'1',name:'Cliente conectado',phone:'505-7777-1212',ruc:'RUC-CONECTADO-88',active:true,creditLimit:'600.00',debt:'100.00',availableCredit:'500.00',pendingPayments:'0.00',creditDays:21};
  const fixture=await connectedFixture(page,false,false,{},[client]);
  await page.locator('input[name=paymentMethod][value=credit]').check();
  await page.locator('#creditClientSearch').fill('505-7777');
  const suggestion=page.locator('[role="listbox"] [role="option"]').filter({hasText:'Cliente conectado'}).first();
  await expect(suggestion).toBeVisible();
  const listId=await page.locator('#creditClientSearch').getAttribute('aria-controls');
  const list=page.locator(`#${listId}`);
  await expect(list).toBeVisible();
  const inspectGeometry=async()=>{
    const geometry=await page.evaluate(()=>{
      const getRect=selector=>{
        const {left,right,top,bottom,width,height}=document.querySelector(selector).getBoundingClientRect();
        return {left,right,top,bottom,width,height};
      };
      return {
        container:getRect('#creditClientContainer'),
        search:getRect('#creditClientSearch'),
        select:getRect('#creditClientSelect'),
        add:getRect('#quickAddClientBtn'),
        list:getRect(`#${document.querySelector('#creditClientSearch').getAttribute('aria-controls')}`),
        viewportWidth:innerWidth
      };
    });
    expect(geometry.container.width).toBeLessThan(400);
    expect(geometry.search.width).toBeGreaterThanOrEqual(260);
    expect(geometry.select.width).toBeGreaterThanOrEqual(160);
    expect(geometry.add.width).toBeGreaterThanOrEqual(80);
    expect(geometry.list.width).toBeGreaterThanOrEqual(260);
    expect(geometry.list.left).toBeGreaterThanOrEqual(0);
    expect(geometry.list.right).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(Math.abs(geometry.select.top-geometry.add.top)).toBeLessThanOrEqual(4);
  };
  await inspectGeometry();
  await page.screenshot({path:test.info().outputPath('credit-client-mobile.png')});
  await page.setViewportSize({width:1100,height:844});
  await inspectGeometry();
  await page.screenshot({path:test.info().outputPath('credit-client-narrow-panel.png')});
  expect(fixture.unexpected).toEqual([]);expect(fixture.errors).toEqual([]);
});
