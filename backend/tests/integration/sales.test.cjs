'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { readConfig } = require('../../src/config/environment');
const { readAuthConfig } = require('../../src/config/auth');
const { createDatabasePool } = require('../../src/config/database');
const { createAuthRepository, rows } = require('../../src/repositories/auth');
const { createAuthService } = require('../../src/services/auth');
const { createUsersService } = require('../../src/services/users');
const { hashPassword } = require('../../src/services/passwords');
const { createApp } = require('../../src/app');
const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Use isolated runner');
const password = 'Sales-fixture-password-123!';
function client(base) {
  const jar = new Map(); let csrf;
  async function request(path, method = 'GET', body, headers = {}) {
    const response = await fetch(base + '/api' + path, { method, headers: { Cookie: [...jar].map(([key,value]) => key+'='+value).join('; '), ...(method === 'GET' ? {} : {'Content-Type':'application/json','X-CSRF-Token':csrf || ''}), ...headers }, body: method === 'GET' ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0], pos = pair.indexOf('='); jar.set(pair.slice(0,pos),pair.slice(pos+1)); }
    const data = response.status === 204 ? undefined : await response.json(); if (data?.csrfToken) csrf = data.csrfToken;
    return {status:response.status,data};
  }
  async function login(businessId,username) { await request('/auth/csrf'); assert.equal((await request('/auth/login','POST',{businessId,username,password})).status,200); }
  return {request,login};
}
test('Integracion MySQL ventas y caja fase 5.3', async t => {
  const config=readConfig(), authConfig=readAuthConfig({CSRF_SECRET:randomBytes(32).toString('hex'),AUTH_RATE_MAX:'100'});
  const pool=createDatabasePool({...config.database,database,connectionLimit:20}); t.after(()=>pool.end());
  const business=String((await rows(pool,'INSERT INTO businesses (name) VALUES (?)',['Sales A'])).insertId), businessB=String((await rows(pool,'INSERT INTO businesses (name) VALUES (?)',['Sales B'])).insertId);
  const hash=await hashPassword(password);
  for (const [tenant,username,role] of [[business,'salesadmin','ADMIN'],[business,'salesone','VENDEDOR'],[business,'salestwo','VENDEDOR'],[businessB,'salesadmin','ADMIN']]) await rows(pool,'INSERT INTO users (business_id, username, full_name, password_hash, role) VALUES (?, ?, ?, ?, ?)',[tenant,username,username,hash,role]);
  const repo=createAuthRepository(pool,authConfig),auth=createAuthService(repo,authConfig);
  const server=createApp({config,checkDatabase:async()=>{},authentication:{repo,auth,config:authConfig,users:createUsersService(repo)}}).listen(0,'127.0.0.1');
  await new Promise(ok=>server.once('listening',ok)); t.after(()=>new Promise(ok=>{server.close(ok);server.closeAllConnections();}));
  const base='http://127.0.0.1:'+server.address().port;
  const admin=client(base),one=client(base),two=client(base),other=client(base),anon=client(base);
  await admin.login(business,'salesadmin'); await one.login(business,'salesone'); await two.login(business,'salestwo'); await other.login(businessB,'salesadmin');
  const productInput=overrides=>({barcode:randomUUID(),name:'Producto ventas',category:'Bebidas',cost:'7.00',marginRetail:'25',marginWholesale:'10',retailPrice:'12.31',wholesalePrice:'11.34',stock:'100.000',minStock:'0',...overrides});
  const createProduct=async(overrides={},owner=admin)=>(await owner.request('/products','POST',productInput(overrides))).data.product;
  const product=await createProduct(); let cash,firstSale;
  const cart=changes=>({items:[{productId:product.id,quantity:'1.125'}],priceType:'RETAIL',discountPercent:'10',paymentMethod:'CASH',...changes});
  async function body(owner=one,changes={},extra={}) { const data=cart(changes), q=await owner.request('/sales/quote','POST',data); assert.equal(q.status,200); return {...data,operationKey:randomUUID(),quoteToken:q.data.quote.quoteToken,cashReceived:data.paymentMethod==='CASH'?'100.00':null,detail:'Venta de prueba',...extra}; }
  const stock=async id=>(await admin.request('/products/'+id)).data.product.stock;
  const count=async table=>Number((await rows(pool,'SELECT COUNT(*) AS n FROM '+table+' WHERE business_id = ?',[business]))[0].n);
  await t.test('anonimo y CSRF invalidos no escriben',async()=>{
    assert.equal((await anon.request('/sales','POST',{})).status,401);
    assert.equal((await admin.request('/cash/sessions','POST',{operationKey:randomUUID(),openingAmount:'10'},{'X-CSRF-Token':'bad'})).status,403);
  });
  await t.test('caja ausente impide cotizar y cobrar incluso con tarjeta',async()=>{
    for(const paymentMethod of ['CASH','CARD','TRANSFER']) assert.equal((await one.request('/sales/quote','POST',cart({paymentMethod}))).data.error.code,'CASH_CLOSED');
  });
  await t.test('vendedor no abre caja ni obtiene historial sin permiso',async()=>{
    assert.equal((await one.request('/cash/sessions','POST',{operationKey:randomUUID(),openingAmount:'10'})).status,403);
    assert.equal((await one.request('/sales')).status,403);
  });
  await t.test('apertura idempotente y caja unica por negocio',async()=>{
    const data={operationKey:randomUUID(),openingAmount:'10.00'}, results=await Promise.all([admin.request('/cash/sessions','POST',data),admin.request('/cash/sessions','POST',data)]);
    assert.ok(results.every(r=>r.status===201)); assert.equal(results[0].data.cash.id,results[1].data.cash.id); cash=results[0].data.cash;
    assert.equal((await admin.request('/cash/sessions','POST',{...data,operationKey:randomUUID()})).data.error.code,'CASH_ALREADY_OPEN'); assert.equal(await count('cash_sessions'),1);
  });
  await t.test('venta calcula importes exactos, usuario, factura, stock y efectivo sin duplicar',async()=>{
    const input=await body(); const response=await one.request('/sales','POST',input); assert.equal(response.status,201); firstSale=response.data.sale;
    assert.equal(firstSale.invoiceNumber,'000001'); assert.equal(firstSale.subtotal,'13.85'); assert.equal(firstSale.discount,'1.39'); assert.equal(firstSale.total,'12.46'); assert.equal(firstSale.changeAmount,'87.54'); assert.equal(firstSale.seller,'salesone'); assert.equal(await stock(product.id),'98.875');
    assert.equal((await admin.request('/cash/current?full=true')).data.cash.expectedAmount,'22.46');
    assert.equal(await count('cash_movements'),1); assert.equal(firstSale.items[0].unitPrice,'12.31');
    const [item]=await rows(pool,'SELECT cost_at_sale FROM sale_items WHERE business_id = ? AND sale_id = ?',[business,firstSale.id]); assert.equal(item.cost_at_sale,'7.00');
    const [movement]=await rows(pool,"SELECT quantity, stock_after FROM inventory_movements WHERE business_id = ? AND reference_id = ? AND type = 'SALE'",[business,firstSale.id]); assert.equal(movement.quantity,'-1.125'); assert.equal(movement.stock_after,'98.875');
  });
  await t.test('misma operacion simultanea solo crea una venta, factura y movimiento',async()=>{
    const input=await body(), before=await count('sales');
    const results=await Promise.all([one.request('/sales','POST',input),one.request('/sales','POST',input)]);
    assert.ok(results.every(r=>r.status===201)); assert.equal(results[0].data.sale.id,results[1].data.sale.id); assert.equal(await count('sales'),before+1);
    assert.equal((await one.request('/sales','POST',{...input,detail:'Otro cuerpo'})).data.error.code,'OPERATION_CONFLICT');
  });
  await t.test('respuesta perdida se consulta con la misma clave sin otro descuento de stock',async()=>{
    const input=await body(); const sent=await one.request('/sales','POST',input); const before=await stock(product.id);
    const lookup=await one.request('/operations/'+input.operationKey); assert.equal(lookup.status,200); assert.equal(lookup.data.sale.id,sent.data.sale.id);
    const resolve=await one.request('/operations/'+input.operationKey+'/resolve','POST',{}); assert.equal(resolve.data.sale.id,sent.data.sale.id); assert.equal(await stock(product.id),before);
  });
  await t.test('resolver operacion ausente bloquea solicitudes tardias de esa clave',async()=>{
    const input=await body(), before=await stock(product.id), n=await count('sales');
    assert.equal((await one.request('/operations/'+input.operationKey+'/resolve','POST',{})).data.kind,'ABANDONED');
    assert.equal((await one.request('/sales','POST',input)).data.error.code,'OPERATION_CONFLICT'); assert.equal(await stock(product.id),before); assert.equal(await count('sales'),n);
  });
  await t.test('efectivo insuficiente revierte toda la transaccion y no consume factura',async()=>{
    const before=await count('sales'), input=await body(one,{}, {cashReceived:'0.01'}); assert.equal((await one.request('/sales','POST',input)).data.error.code,'CASH_INSUFFICIENT'); assert.equal(await count('sales'),before);
    assert.equal((await one.request('/operations/'+input.operationKey)).status,404);
  });
  await t.test('tarjeta y transferencia registran turno sin aumentar efectivo',async()=>{
    const before=(await admin.request('/cash/current?full=true')).data.cash.expectedAmount, movements=await count('cash_movements'), movementMax=(await rows(pool,'SELECT COALESCE(MAX(id),0) AS id FROM cash_movements WHERE business_id = ?',[business]))[0].id;
    for(const paymentMethod of ['CARD','TRANSFER']) {const r=await one.request('/sales','POST',await body(one,{paymentMethod,priceType:'WHOLESALE'}));assert.equal(r.status,201);assert.equal(r.data.sale.total,'11.48');assert.equal(r.data.sale.cashReceived,null);assert.equal(r.data.sale.cashSessionId,cash.id);assert.equal(r.data.sale.cashStatus,'PENDING');}
    const added=await rows(pool,"SELECT s.payment_method, m.status, m.amount FROM cash_movements m JOIN sales s ON s.business_id=m.business_id AND s.id=m.sale_id WHERE m.business_id = ? AND m.id > ? ORDER BY m.id",[business,movementMax]);assert.deepEqual(added.map(m=>[m.payment_method,m.status,m.amount]),[['CARD','PENDING','11.48'],['TRANSFER','PENDING','11.48']]);
    assert.equal((await admin.request('/cash/current?full=true')).data.cash.expectedAmount,before);assert.equal(await count('cash_movements'),movements+2);
  });
  await t.test('precios cambiados requieren confirmar nueva cotizacion',async()=>{
    const input=await body(); const p=(await admin.request('/products/'+product.id)).data.product;
    await admin.request('/products/'+product.id,'PATCH',{revision:p.revision,retailPrice:'14.00'});
    assert.equal((await one.request('/sales','POST',input)).data.error.code,'QUOTE_CHANGED');
    const updated=(await admin.request('/products/'+product.id)).data.product;await admin.request('/products/'+product.id,'PATCH',{revision:updated.revision,retailPrice:'12.31'});
  });
  await t.test('dos vendedores compiten por ultima unidad: uno gana, stock nunca negativo',async()=>{
    const last=await createProduct({stock:'1.000'}), data={items:[{productId:last.id,quantity:'1'}]};
    const [a,b]=await Promise.all([body(one,data),body(two,data)]);const responses=await Promise.all([one.request('/sales','POST',a),two.request('/sales','POST',b)]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);assert.equal(await stock(last.id),'0.000');
  });
  await t.test('carrito, cantidad, descuento, pago y autoridad devuelven errores específicos',async()=>{
    for(const [change,code] of [[{items:[]},'CART_EMPTY'],[{items:[{productId:product.id,quantity:'0'}]},'QUANTITY_INVALID'],[{discountPercent:'101'},'DISCOUNT_INVALID'],[{paymentMethod:'CREDIT'},'PAYMENT_METHOD_REQUIRED'],[{business_id:businessB},'INVALID_INPUT'],[{total:'0.01'},'INVALID_INPUT']]) assert.equal((await one.request('/sales/quote','POST',cart(change))).data.error.code,code);
    const inactive=await createProduct({active:false});assert.equal((await one.request('/sales/quote','POST',cart({items:[{productId:inactive.id,quantity:'1'}]}))).data.error.code,'PRODUCT_INACTIVE');
    assert.equal((await one.request('/sales/quote','POST',cart({items:[{productId:'18446744073709551615',quantity:'1'}]}))).data.error.code,'PRODUCT_NOT_FOUND');
  });
  await t.test('negocios separados tienen secuencia propia y no consultan ventas ajenas',async()=>{
    const bProduct=await createProduct({},other);await other.request('/cash/sessions','POST',{operationKey:randomUUID(),openingAmount:'0'});
    const bSale=await other.request('/sales','POST',await body(other,{items:[{productId:bProduct.id,quantity:'1'}]}));assert.equal(bSale.data.sale.invoiceNumber,'000001');
    assert.equal((await other.request('/sales/'+firstSale.id)).status,404);assert.equal((await other.request('/sales/'+firstSale.id+'/cancel','POST',{operationKey:randomUUID(),reason:'Ajena'})).status,404);
    const invalid=await body(one);invalid.items=[{productId:bProduct.id,quantity:'1'}];assert.equal((await one.request('/sales','POST',invalid)).data.error.code,'PRODUCT_NOT_FOUND');
    for(const paymentMethod of ['CASH','CARD','TRANSFER']) {
      const input={items:[{productId:bProduct.id,quantity:'1'}],priceType:'RETAIL',discountPercent:'0',paymentMethod};
      const quote=await other.request('/sales/quote','POST',input);assert.equal(quote.status,200);
      const open=(await other.request('/cash/current?full=true')).data.cash;
      await other.request('/cash/sessions/'+open.id+'/close','POST',{operationKey:randomUUID(),countedAmount:open.expectedAmount});
      const sale=await other.request('/sales','POST',{...input,operationKey:randomUUID(),quoteToken:quote.data.quote.quoteToken,cashReceived:paymentMethod==='CASH'?'100.00':null,detail:'Caja cerrada'});
      assert.equal(sale.status,409);assert.equal(sale.data.error.code,'CASH_CLOSED');
      await other.request('/cash/sessions','POST',{operationKey:randomUUID(),openingAmount:'0'});
    }
  });
  await t.test('operaciones son aisladas por negocio y usuario',async()=>{
    const input=await body();await one.request('/sales','POST',input);
    assert.equal((await other.request('/operations/'+input.operationKey)).status,404);assert.equal((await two.request('/operations/'+input.operationKey)).status,404);
    assert.equal((await two.request('/sales','POST',input)).data.error.code,'OPERATION_CONFLICT');
  });
  await t.test('anulacion exige permiso real, resta efectivo y repone stock una sola vez',async()=>{
    const beforeStock=Number(await stock(product.id)), beforeCash=Number((await admin.request('/cash/current?full=true')).data.cash.expectedAmount), data={operationKey:randomUUID(),reason:'Devolucion'};
    assert.equal((await one.request('/sales/'+firstSale.id+'/cancel','POST',data)).status,403);
    assert.equal((await one.request('/auth/authorizations','POST',{module:'history',adminUsername:'salesadmin',adminPassword:password})).status,201);
    const [a,b]=await Promise.all([one.request('/sales/'+firstSale.id+'/cancel','POST',data),one.request('/sales/'+firstSale.id+'/cancel','POST',data)]);assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(a.data.sale.status,'CANCELLED');
    assert.equal(Number(await stock(product.id)),beforeStock+1.125);assert.equal(Number((await admin.request('/cash/current?full=true')).data.cash.expectedAmount),Number((beforeCash-12.46).toFixed(2)));
    assert.equal((await admin.request('/sales/'+firstSale.id+'/cancel','POST',{...data,operationKey:randomUUID()})).data.error.code,'SALE_CANCELLED');
    const movements=await rows(pool,"SELECT * FROM cash_movements WHERE business_id = ? AND sale_id = ? AND type = 'REVERSAL'",[business,firstSale.id]);assert.equal(movements.length,1);assert.ok(movements[0].reversal_of_movement_id);
    await one.request('/auth/modules/sales/enter','POST',{});assert.equal((await one.request('/sales')).status,403);
  });
  await t.test('facturas consecutivas, historial paginado y anulacion preservan documentos',async()=>{
    const documents=await rows(pool,'SELECT invoice_number FROM sales WHERE business_id = ? ORDER BY id',[business]);assert.deepEqual(documents.map(s=>s.invoice_number),documents.map((_,i)=>String(i+1).padStart(6,'0')));
    const page=await admin.request('/sales?limit=2');assert.equal(page.data.sales.length,2);assert.ok(page.data.sales.every(s=>s.businessId===business));
    const id=page.data.sales[0].id, before=(await admin.request('/sales?limit=2&offset=2&maxId='+id)).data.sales.map(s=>s.id);await one.request('/sales','POST',await body());assert.deepEqual((await admin.request('/sales?limit=2&offset=2&maxId='+id)).data.sales.map(s=>s.id),before);
    assert.equal((await admin.request('/sales/'+firstSale.id)).data.sale.status,'CANCELLED');
  });
  await t.test('cierre idempotente persiste arqueo y bloquea ventas y devoluciones originales',async()=>{
    const latest=(await admin.request('/sales?limit=1')).data.sales[0], before=await count('sales');const expected=(await admin.request('/cash/current?full=true')).data.cash.expectedAmount, data={operationKey:randomUUID(),countedAmount:expected};
    const a=await admin.request('/cash/sessions/'+cash.id+'/close','POST',data),b=await admin.request('/cash/sessions/'+cash.id+'/close','POST',data);assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(a.data.cash.status,'CLOSED');assert.equal(a.data.cash.difference,'0.00');
    assert.deepEqual(a.data.cash.summary,b.data.cash.summary);
    assert.equal(a.data.cash.closedBy,'salesadmin'); assert.ok(a.data.cash.openedAt); assert.ok(a.data.cash.closedAt);
    const breakdown=a.data.cash.summary; assert.equal(breakdown.purchases,'0.00');
    assert.equal((Number(a.data.cash.openingAmount)+Number(breakdown.cashSales)+Number(breakdown.cashCollections)+Number(breakdown.otherCash)-Number(breakdown.expenses)-Number(breakdown.withdrawals)-Number(breakdown.purchases)-Number(breakdown.cashReturns)).toFixed(2),a.data.cash.expectedAmount);
    const saved=(await admin.request('/cash/sessions')).data.sessions.find(s=>s.id===cash.id); assert.deepEqual(saved.summary,breakdown); assert.equal(saved.expectedAmount,expected);
    assert.equal((await one.request('/sales/quote','POST',cart())).data.error.code,'CASH_CLOSED');
    assert.equal((await admin.request('/sales/'+latest.id+'/cancel','POST',{operationKey:randomUUID(),reason:'Caja cerrada'})).data.error.code,'CASH_ORIGINAL_CLOSED');assert.equal(await count('sales'),before);
    assert.equal((await admin.request('/cash/sessions')).data.sessions[0].status,'CLOSED');
  });
  await t.test('cotizacion no permite registrar venta en otro turno',async()=>{
    await admin.request('/cash/sessions','POST',{operationKey:randomUUID(),openingAmount:'0'});const input=await body(), current=(await admin.request('/cash/current?full=true')).data.cash;
    await admin.request('/cash/sessions/'+current.id+'/close','POST',{operationKey:randomUUID(),countedAmount:'0'});await admin.request('/cash/sessions','POST',{operationKey:randomUUID(),openingAmount:'0'});
    assert.equal((await one.request('/sales','POST',input)).data.error.code,'QUOTE_CHANGED');
  });
  await t.test('fallo del movimiento financiero revierte factura, stock, secuencia y operacion', async () => {
    const input=await body(), beforeStock=await stock(product.id), before=await count('sales'), original=repo.rows;
    repo.rows=(db,sql,args)=>{if(sql.startsWith('INSERT INTO cash_movements'))throw new Error('Injected financial failure');return original(db,sql,args);};
    let response;try{response=await one.request('/sales','POST',input);}finally{repo.rows=original;}
    assert.equal(response.status,500);assert.equal(response.data.error.code,'INTERNAL_ERROR');assert.equal(await stock(product.id),beforeStock);assert.equal(await count('sales'),before);assert.equal((await one.request('/operations/'+input.operationKey)).status,404);
  });
  await t.test('sesion se revalida despues de escribir y antes de commit', async () => {
    const input=await body(), before=await count('sales'), original=repo.audit;
    repo.audit=async(db,current,action,...args)=>{await original(db,current,action,...args);if(action==='CREATE_SALE')await rows(db,'UPDATE sessions SET expires_at = TIMESTAMPADD(SECOND, -1, UTC_TIMESTAMP(3)) WHERE business_id = ? AND id = ?',[current.business_id,current.session_id]);};
    let response;try{response=await one.request('/sales','POST',input);}finally{repo.audit=original;}
    assert.equal(response.status,401);assert.equal(await count('sales'),before);
  });
  await t.test('anulacion sin efectivo no genera reversion en caja', async () => {
    const before=await count('cash_movements'), response=await one.request('/sales','POST',await body(one,{paymentMethod:'CARD'}));
    assert.equal(response.data.sale.cashStatus,'PENDING');assert.equal((await admin.request('/sales/'+response.data.sale.id+'/cancel','POST',{operationKey:randomUUID(),reason:'Devolucion tarjeta'})).status,200);assert.equal(await count('cash_movements'),before+1);
    const [movement]=await rows(pool,"SELECT status FROM cash_movements WHERE business_id = ? AND sale_id = ? AND type = 'SALE'",[business,response.data.sale.id]);assert.equal(movement.status,'VOID');
  });
  await t.test('descuento completo produce total cero sin movimientos de efectivo ficticios', async () => {
    const before=await count('cash_movements'), input=await body(one,{discountPercent:'100'},{cashReceived:'0'});const response=await one.request('/sales','POST',input);assert.equal(response.status,201);assert.equal(response.data.sale.total,'0.00');assert.equal(response.data.sale.changeAmount,'0.00');assert.equal(await count('cash_movements'),before);
  });
  await t.test('recuperar respuesta perdida refleja una anulacion posterior', async () => {
    const input=await body();const sale=(await one.request('/sales','POST',input)).data.sale;await admin.request('/sales/'+sale.id+'/cancel','POST',{operationKey:randomUUID(),reason:'Anulacion posterior'});
    assert.equal((await one.request('/operations/'+input.operationKey)).data.sale.status,'CANCELLED');assert.equal((await one.request('/operations/'+input.operationKey+'/resolve','POST',{})).data.sale.status,'CANCELLED');
  });
  await t.test('migracion ausente bloquea el cobro con mensaje publico, sin escrituras', async () => {
    const before=await count('sales');await pool.query('RENAME TABLE pos_operations TO pos_operations_unavailable');
    try{const response=await one.request('/sales/quote','POST',cart());assert.equal(response.status,503);assert.equal(response.data.error.code,'SALES_MIGRATION_REQUIRED');assert.equal(await count('sales'),before);}finally{await pool.query('RENAME TABLE pos_operations_unavailable TO pos_operations');}
  });
  await t.test('sesion expirada mientras espera bloqueo no confirma venta ni factura',async()=>{
    const input=await body(two), before=await count('sales'), blocker=await pool.getConnection();await blocker.beginTransaction();await rows(blocker,'SELECT id FROM businesses WHERE id = ? FOR UPDATE',[business]);
    let reached; const requested=new Promise(ok=>{reached=ok;}); const originalTenant=repo.tenant;
    repo.tenant=(session,work)=>{reached();return originalTenant(session,work);};
    const promise=two.request('/sales','POST',input);
    await requested;
    await rows(pool,"UPDATE sessions SET expires_at = TIMESTAMPADD(SECOND, -1, UTC_TIMESTAMP(3)) WHERE business_id = ? AND user_id IN (SELECT id FROM users WHERE business_id = ? AND username = 'salestwo')",[business,business]);
    await blocker.commit();blocker.release();const response=await promise;repo.tenant=originalTenant;
    assert.equal(response.status,401);assert.equal(await count('sales'),before);
  });
  await t.test('tarjeta y transferencia se confirman con actor y fecha sin sumar efectivo, ni doble confirmar o confirmar anuladas',async()=>{
    const before=(await admin.request('/cash/current?full=true')).data.cash.expectedAmount;
    for(const paymentMethod of ['CARD','TRANSFER']) {
      const sale=(await one.request('/sales','POST',await body(one,{paymentMethod}))).data.sale;
      const overview=(await admin.request('/cash/overview')).data.overview, pending=overview.pendingPayments.find(item=>item.saleId===sale.id);
      assert.ok(pending);assert.equal(pending.paymentMethod,paymentMethod);assert.equal(pending.status,'PENDING');
      const data={operationKey:randomUUID()}, confirmed=await admin.request('/cash/payments/'+pending.id+'/confirm','POST',data);
      assert.equal(confirmed.status,200);assert.equal(confirmed.data.sale.cashStatus,'CONFIRMED');assert.equal(confirmed.data.movement.status,'CONFIRMED');assert.equal(confirmed.data.movement.paymentMethod,paymentMethod);assert.equal((await admin.request('/cash/current?full=true')).data.cash.expectedAmount,before);
      const [stored]=await rows(pool,'SELECT m.status, m.confirmed_at, u.username FROM cash_movements m JOIN users u ON u.business_id=m.business_id AND u.id=m.confirmed_by_user_id WHERE m.business_id = ? AND m.id = ?',[business,pending.id]);
      assert.equal(stored.status,'CONFIRMED');assert.ok(stored.confirmed_at);assert.equal(stored.username,'salesadmin');
      assert.equal((await admin.request('/cash/payments/'+pending.id+'/confirm','POST',{operationKey:randomUUID()})).data.error.code,'PAYMENT_NOT_PENDING');
    }
    const cancelled=(await one.request('/sales','POST',await body(one,{paymentMethod:'CARD'}))).data.sale;
    const [pending]=await rows(pool,"SELECT id FROM cash_movements WHERE business_id = ? AND sale_id = ? AND type = 'SALE'",[business,cancelled.id]);
    await admin.request('/sales/'+cancelled.id+'/cancel','POST',{operationKey:randomUUID(),reason:'Venta anulada antes de confirmar'});
    assert.equal((await admin.request('/cash/payments/'+pending.id+'/confirm','POST',{operationKey:randomUUID()})).data.error.code,'PAYMENT_NOT_PENDING');
  });
  await t.test('flujo centralizado prepara, revalida y cobra pedidos sin ventas, stock ni caja previos',async()=>{
    let current=(await admin.request('/cash/current?full=true')).data.cash;
    assert.equal((await admin.request('/business-settings/sales-flow','PUT',{salesFlow:'CENTRALIZED'})).data.error.code,'CASH_OPEN');
    await admin.request('/cash/sessions/'+current.id+'/close','POST',{operationKey:randomUUID(),countedAmount:current.expectedAmount});
    assert.equal((await admin.request('/business-settings/sales-flow','PUT',{salesFlow:'CENTRALIZED'})).status,200);
    assert.equal((await one.request('/sales/quote','POST',cart())).data.error.code,'SALES_FLOW_CHANGED');
    const beforeStock=await stock(product.id), beforeSales=await count('sales'), beforeMovements=await count('cash_movements');
    const orderInput={items:[{productId:product.id,quantity:'1.125'}],priceType:'RETAIL',discountPercent:'0',detail:'Pedido de caja',operationKey:randomUUID()};
    const rejected=await one.request('/sales/orders','POST',orderInput);assert.equal(rejected.status,409);assert.equal(rejected.data.error.code,'CASH_CLOSED');
    assert.equal(await count('sales'),beforeSales);assert.equal(await count('cash_movements'),beforeMovements);
    await admin.request('/cash/sessions','POST',{operationKey:randomUUID(),openingAmount:'5.00'});
    const created=await one.request('/sales/orders','POST',orderInput);assert.equal(created.status,201);assert.equal(created.data.order.status,'PENDING');
    assert.equal((await one.request('/sales/orders','POST',orderInput)).data.order.id,created.data.order.id);
    current=(await admin.request('/cash/current?full=true')).data.cash;await admin.request('/cash/sessions/'+current.id+'/close','POST',{operationKey:randomUUID(),countedAmount:current.expectedAmount});
    assert.equal((await stock(product.id)),beforeStock);assert.equal(await count('sales'),beforeSales);assert.equal(await count('cash_movements'),beforeMovements);
    assert.equal((await one.request('/cash/orders/'+created.data.order.id+'/quote','POST',{paymentMethod:'CASH'})).status,403);
    assert.equal((await admin.request('/cash/orders/'+created.data.order.id+'/quote','POST',{paymentMethod:'CASH'})).data.error.code,'CASH_CLOSED');
    assert.equal((await admin.request('/business-settings/sales-flow','PUT',{salesFlow:'DIRECT'})).data.error.code,'PENDING_ORDERS_EXIST');
    await admin.request('/cash/sessions','POST',{operationKey:randomUUID(),openingAmount:'5.00'});
    const second=(await one.request('/sales/orders','POST',{...orderInput,operationKey:randomUUID(),detail:'Pedido para cancelar'})).data.order;
    assert.equal((await admin.request('/cash/orders/'+second.id+'/cancel','POST',{operationKey:randomUUID()})).data.order.status,'CANCELLED');
    const live=await admin.request('/products/'+product.id);await admin.request('/products/'+product.id,'PATCH',{revision:live.data.product.revision,retailPrice:'15.00'});
    const quoteResponse=await admin.request('/cash/orders/'+created.data.order.id+'/quote','POST',{paymentMethod:'CARD'}), q=quoteResponse.data.quote;
    assert.equal(quoteResponse.status,200);assert.equal(q.priceChanged,true);assert.equal(q.estimatedTotal,created.data.order.estimatedTotal);assert.equal(q.total,'16.88');
    const priceNow=await admin.request('/products/'+product.id);await admin.request('/products/'+product.id,'PATCH',{revision:priceNow.data.product.revision,retailPrice:'16.00'});
    assert.equal((await admin.request('/cash/orders/'+created.data.order.id+'/charge','POST',{operationKey:randomUUID(),quoteToken:q.quoteToken,paymentMethod:'CARD',cashReceived:null})).data.error.code,'QUOTE_CHANGED');
    const q2=(await admin.request('/cash/orders/'+created.data.order.id+'/quote','POST',{paymentMethod:'CARD'})).data.quote;
    const charged=await admin.request('/cash/orders/'+created.data.order.id+'/charge','POST',{operationKey:randomUUID(),quoteToken:q2.quoteToken,paymentMethod:'CARD',cashReceived:null});
    assert.equal(charged.status,201);assert.equal(charged.data.sale.seller,'salesone');assert.equal(charged.data.sale.cashier,'salesadmin');assert.equal(charged.data.order.status,'COMPLETED');
    assert.equal(await stock(product.id),(Number(beforeStock)-1.125).toFixed(3));
    assert.equal((await admin.request('/cash/current?full=true')).data.cash.expectedAmount,'5.00');
    current=(await admin.request('/cash/current?full=true')).data.cash;
    await admin.request('/cash/sessions/'+current.id+'/close','POST',{operationKey:randomUUID(),countedAmount:current.expectedAmount});
    const overview=(await admin.request('/cash/overview')).data.overview,payment=[...overview.pendingPayments,...(overview.pendingHistoricalPayments||[])].find(item=>item.saleId===charged.data.sale.id);
    assert.ok(payment);assert.equal((await admin.request('/cash/payments/'+payment.id+'/confirm','POST',{operationKey:randomUUID()})).status,200);
    assert.equal((await admin.request('/cash/overview')).data.overview.expectedAmount,'0.00');
    assert.equal((await admin.request('/business-settings/sales-flow','PUT',{salesFlow:'DIRECT'})).status,200);
  });
  await t.test('resumen de Caja solo incluye la sesión abierta y separa pendientes históricos', async () => {
    const previous = (await admin.request('/cash/sessions','POST',{operationKey:randomUUID(),openingAmount:'1.00'})).data.cash;
    const oldCard = (await one.request('/sales','POST',await body(one,{paymentMethod:'CARD'}))).data.sale;
    const oldSummary = (await admin.request('/cash/current?full=true')).data.cash;
    await admin.request('/cash/sessions/'+previous.id+'/close','POST',{operationKey:randomUUID(),countedAmount:oldSummary.expectedAmount});
    const current = (await admin.request('/cash/sessions','POST',{operationKey:randomUUID(),openingAmount:'2.00'})).data.cash;
    const currentSale = (await one.request('/sales','POST',await body(one,{paymentMethod:'CASH'}))).data.sale;
    const overview = (await admin.request('/cash/overview')).data.overview;
    assert.equal(overview.currentCashSessionId,current.id);
    assert.equal(overview.salesByUser.reduce((sum,item)=>sum+Number(item.total),0).toFixed(2),currentSale.total);
    assert.ok(overview.movements.length > 0);
    assert.ok(overview.movements.every(item=>item.cashSessionId===current.id));
    assert.equal(overview.pendingPayments.some(item=>item.saleId===oldCard.id),false);
    assert.equal(overview.pendingHistoricalPayments.some(item=>item.saleId===oldCard.id),true);
    assert.equal(overview.expectedAmount,(2+Number(currentSale.total)).toFixed(2));
     await admin.request('/cash/sessions/'+current.id+'/close','POST',{operationKey:randomUUID(),countedAmount:overview.expectedAmount});
     const closedOverview = (await admin.request('/cash/overview')).data.overview;
     assert.equal(closedOverview.currentCashSessionId,null);
     assert.ok(closedOverview.operationSales.some(item=>item.id===currentSale.id));
     assert.ok(closedOverview.movements.some(item=>item.saleId===currentSale.id));
     assert.ok(closedOverview.pendingPayments.some(item=>item.saleId===oldCard.id));
    await admin.request('/sales/'+oldCard.id+'/cancel','POST',{operationKey:randomUUID(),reason:'Limpiar pendiente histórico'});
  });
  await t.test('auditoria contiene operaciones y nunca contrasenas ni tokens',async()=>{
    const records=await rows(pool,'SELECT action, details FROM audit_logs WHERE business_id = ?',[business]);for(const action of ['CREATE_SALE','CANCEL_SALE','OPEN_CASH','CLOSE_CASH','RESOLVE_OPERATION','CONFIRM_NONCASH_PAYMENT','PREPARE_SALE_ORDER','CANCEL_SALE_ORDER','CHANGE_SALES_FLOW'])assert.ok(records.some(r=>r.action===action));
    assert.ok(!JSON.stringify(records).includes(password));
  });
});
