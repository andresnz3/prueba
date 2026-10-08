const { test, expect } = require('@playwright/test');
const { randomUUID } = require('node:crypto');
const password = 'Browser-fixture-password-123!';
const business = process.env.POS_TEST_BUSINESS;
const errors = new WeakMap();
test.beforeEach(async ({page,context})=>{await context.addInitScript({path:require.resolve('../tests/dexie-search-shim.js')});const list=[];errors.set(page,list);page.on('pageerror',error=>list.push(error.message));});
test.afterEach(async ({page})=>{expect(errors.get(page)).toEqual([]);});
async function login(page) { await page.goto('/?mode=connected'); await page.locator('#loginBusinessId').fill(business); await page.locator('#loginUsername').fill('browseradmin'); await page.locator('#loginPassword').fill(password); await page.locator('#loginForm button').click(); await expect(page.locator('#app')).toBeVisible(); }
async function call(page,method,...args) { return page.evaluate(async({method,args})=>{const api=new window.PosApiClient(window.POS_API_BASE_URL);await api.me();return api[method](...args);},{method,args}); }
async function fixture(page) {
  await login(page); const current=await call(page,'currentCash',true); if(current) await call(page,'closeCash',current.id,{operationKey:randomUUID(),countedAmount:current.expectedAmount});
  const overview=await call(page,'cashOverview'); for(const order of [...overview.pendingOrders,...(overview.pendingHistoricalOrders||[])]) await call(page,'cancelOrder',order.id,{operationKey:randomUUID()}); if(overview.salesFlow!=='DIRECT') await call(page,'setSalesFlow','DIRECT');
  await call(page,'openCash',{operationKey:randomUUID(),openingAmount:'100'});
  const product=await call(page,'createProduct',{barcode:'CR-'+randomUUID(),name:'Credit '+randomUUID(),category:'General',cost:'8',marginRetail:'25',marginWholesale:'12.5',retailPrice:'10',wholesalePrice:'9',stock:'20',minStock:'0'});
  await page.locator('#navSalesBtn').click(); await expect(page.locator('#productGrid')).toContainText(product.name); return product;
}
async function createClient(page,name) {
  await page.locator('#navClientsBtn').click(); await page.locator('#addNewClientBtn').click();
  await page.locator('#clientName').fill(name); await page.locator('#clientPhone').fill('555-' + name.slice(-4)); await page.locator('#clientLimit').fill('100'); await page.locator('#clientCreditDays').fill('15');
  await page.locator('#clientForm button[type=submit]').click(); await expect(page.locator('#clientsTableBody')).toContainText(name);
  return (await call(page,'clients',0,name)).find(value=>value.name===name);
}
test('clientes MySQL: crear, editar, inactivar y excluir de la lista de credito',async({page})=>{
  await login(page); const name='Cliente '+randomUUID().slice(0,8); const client=await createClient(page,name); expect(client.creditDays).toBe(15);
  const clientTable=page.locator('#clientsTableBody').locator('xpath=parent::table'), row=page.locator('#clientsTableBody tr[data-client-id="'+client.id+'"]'); await expect(clientTable.locator('thead tr:first-child th').first()).toHaveText('Cliente'); await expect(clientTable.locator('thead tr:first-child th')).toHaveCount(7); await expect(row.locator('td')).toHaveCount(7); await expect(row.locator('td').first()).toHaveText(name); await row.getByRole('button',{name:'Editar'}).click(); await page.locator('#clientPhone').fill('555-EDIT'); await page.locator('#clientForm button[type=submit]').click(); await expect(row).toContainText('555-EDIT');
  await row.getByRole('button',{name:'Inactivar'}).click(); await expect(row).toContainText('Inactivo');
  await page.locator('#navSalesBtn').click(); await page.locator('input[name=paymentMethod][value=credit]').check(); await expect(page.locator('#creditClientSelect option')).not.toContainText(name);
  expect(await page.evaluate(async()=>({sales:await localDB.sales.count(),queue:await localDB.sync_queue.count()}))).toEqual({sales:0,queue:0});
});
test('venta a credito conectada factura, descuenta stock, crea CxC y abono tarjeta pendiente',async({page})=>{
  const product=await fixture(page), name='Cuenta '+randomUUID().slice(0,8), customer=await createClient(page,name);
  await page.locator('#navSalesBtn').click(); await page.locator('input[name=paymentMethod][value=credit]').check(); await page.locator('#creditClientSelect').selectOption(customer.id);
  await page.locator('#barcodeInput').fill(product.barcode); await page.locator('#addBarcodeBtn').click(); await page.locator('#processSaleBtn').click(); await expect(page.locator('#connectedCheckoutModal')).toBeVisible(); await expect(page.locator('#connectedCheckoutDetail')).toContainText(name); await expect(page.locator('#connectedCashGroup')).toHaveClass(/hidden/);
  await page.locator('#confirmConnectedSaleBtn').click(); await expect(page.locator('#ticketModal')).toBeVisible(); await expect(page.locator('#ticketContent')).toContainText('FACTURA DE CR');
  const sale=(await call(page,'sales')).find(value=>value.paymentMethod==='CREDIT'&&value.clientId===customer.id); expect(sale).toBeTruthy(); expect(Number((await call(page,'product',product.id)).stock)).toBe(19);
  expect((await call(page,'currentCash',true)).expectedAmount).toBe('100.00'); await expect(page.locator('#ticketContent')).toContainText('Saldo Pendiente');
  await page.locator('#newSaleBtn').click(); await page.locator('#navClientsBtn').click(); const receivablesTable=page.locator('#receivablesTableBody').locator('xpath=parent::table'), invoice=page.locator('#receivablesTableBody tr[data-sale-id="'+sale.id+'"]'); await expect(invoice).toContainText('10.00'); await expect(invoice).toContainText('Pendiente'); await expect(receivablesTable.locator('thead tr:first-child th')).toHaveCount(9); await expect(invoice.locator('td')).toHaveCount(9); await expect(invoice.locator('td').first()).toHaveText(name);
  const receivablesFilters=page.locator('#connectedReceivablesPanel .data-table-column-filter'); await expect(receivablesFilters).toHaveCount(8); await receivablesFilters.nth(0).fill(name); await page.locator('#connectedReceivablesPanel .data-table-toolbar .data-table-input').fill(sale.invoiceNumber); await expect(invoice).toBeVisible(); await expect(page.locator('#receivablesTableBody tr:visible:not(.data-table-no-results)')).toHaveCount(1); await page.locator('#connectedReceivablesPanel .data-table-clear').click(); await expect(invoice).toBeVisible();
  await invoice.getByRole('button',{name:'Abonar'}).click(); await page.locator('#paySaleAmount').fill('2'); await page.locator('#paySaleMethod').selectOption('tarjeta'); await page.locator('#paymentSaleForm button[type=submit]').click(); await expect(page.locator('#customAlertMessage')).toContainText('Tarjeta pendiente'); await page.locator('#customAlertModal .close-modal-btn').click();
  await expect(invoice).toContainText('Abono pendiente de confirmar'); await page.locator('#navCajaBtn').click(); const pending=page.locator('#cajaOperacionesBody tr').filter({hasText:'Abono factura #'+sale.invoiceNumber}); await expect(pending).toContainText('Tarjeta pendiente'); await pending.locator('button[data-action=confirm-payment]').click(); await expect(page.locator('#customAlertMessage')).toContainText('Tarjeta confirmado para la factura #'+sale.invoiceNumber); await page.locator('#customAlertModal .close-modal-btn').click();
  expect((await call(page,'currentCash',true)).expectedAmount).toBe('100.00'); const receivable=(await call(page,'receivables',0,name)).find(value=>value.id===sale.id); expect(receivable.paid).toBe('2.00'); expect(receivable.balance).toBe('8.00');
  const endingCash=await call(page,'currentCash',true); await call(page,'closeCash',endingCash.id,{operationKey:randomUUID(),countedAmount:endingCash.expectedAmount});
  expect(await page.evaluate(async()=>({sales:await localDB.sales.count(),queue:await localDB.sync_queue.count()}))).toEqual({sales:0,queue:0});
});
