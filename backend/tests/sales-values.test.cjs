'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const values = require('../src/services/sales-values');
const product = (id, price = '12.31', stock = '10.125') => ({ id, name: 'Producto', retail_price: price, wholesale_price: '11.34', cost: '10.50', tax_rate: '1.5000', stock, active: true, deleted: false });
const cart = changes => ({ items: [{ productId: '1', quantity: '1.125' }], priceType: 'RETAIL', paymentMethod: 'CASH', discountPercent: '10', ...changes });
test('ventas: precios de MySQL, cantidades fraccionarias y descuento exacto', () => {
  const result = values.calculate([product('1')], values.quote(cart()));
  assert.equal(result.subtotal, '13.85'); assert.equal(result.discount, '1.39'); assert.equal(result.total, '12.46'); assert.equal(result.tax, '0.00');
  assert.equal(result.lines[0].unitPrice, '12.31');
});
test('ventas: mayoreo se obtiene del producto y no del navegador', () => {
  const result = values.calculate([product('1')], values.quote(cart({ priceType: 'WHOLESALE', discountPercent: '0' })));
  assert.equal(result.total, '12.76');
  assert.throws(() => values.quote(cart({ unitPrice: '0.01' })), { publicCode: 'INVALID_INPUT' });
});
test('ventas: distribucion del descuento reconcilia lineas, incluso centavos y 100%', () => {
  for (const discountPercent of ['0', '33.3333', '99.9999', '100']) {
    const data = values.quote(cart({ items: Array.from({length: 7}, (_, i) => ({productId: String(i+1), quantity: '1'})), discountPercent }));
    const result = values.calculate(Array.from({length: 7}, (_, i) => product(String(i+1), '0.01')), data);
    assert.equal(result.lines.reduce((sum, l) => sum + l.discountUnits, 0n), BigInt(result.discount.replace('.', '')));
    assert.equal(result.lines.reduce((sum, l) => sum + l.totalUnits, 0n), BigInt(result.total.replace('.', '')));
    assert.ok(result.lines.every(l => l.totalUnits >= 0n));
  }
});
test('ventas: mensajes distintos para carrito, cantidades, descuento y pago', () => {
  for (const [change, code] of [[{items:[]},'CART_EMPTY'], [{items:[{productId:'1',quantity:'0'}]},'QUANTITY_INVALID'], [{items:[{productId:'1',quantity:'1.0001'}]},'QUANTITY_INVALID'], [{discountPercent:'101'},'DISCOUNT_INVALID'], [{discountPercent:'-1'},'DISCOUNT_INVALID'], [{paymentMethod:''},'PAYMENT_METHOD_REQUIRED'], [{paymentMethod:'CREDIT'},'CREDIT_CLIENT_REQUIRED']]) assert.throws(() => values.quote(cart(change)), {publicCode: code});
});
test('ventas: producto inexistente, inactivo y stock insuficiente se distinguen', () => {
  const data=values.quote(cart());
  for(const [products,code] of [[[], 'PRODUCT_NOT_FOUND'], [[{...product('1'),active:false}],'PRODUCT_INACTIVE'], [[product('1','12.31','1.124')],'INSUFFICIENT_STOCK']]) assert.throws(()=>values.calculate(products,data),{publicCode:code});
});
test('ventas: rechazo de autoridad, precios y campos no documentados', () => {
  for(const field of ['businessId','business_id','userId','subtotal','total','tax','discount']) assert.throws(()=>values.quote(cart({[field]:'1'})),{publicCode:'INVALID_INPUT'});
  assert.throws(()=>values.quote(cart({items:[{productId:'1',quantity:'1',price:'1'}]})),{publicCode:'INVALID_INPUT'});
});
test('ventas: idempotencia valida UUID v4 y preserva canonizacion', () => {
  assert.equal(values.operationKey(randomUUID()).length,36);
  assert.throws(()=>values.operationKey('repeat'),{publicCode:'OPERATION_KEY_INVALID'});
  const data=values.sale({...cart(),operationKey:randomUUID(),quoteToken:'a'.repeat(64),cashReceived:'20',detail:' Venta '});
  assert.equal(data.cashReceived,'20.00'); assert.equal(data.items[0].quantity,'1.125'); assert.equal(data.detail,'Venta');
});
test('caja: importes, razon y controles tienen validaciones propias', () => {
  assert.throws(()=>values.cash({operationKey:randomUUID(),openingAmount:'-1'}),{publicCode:'CASH_INVALID'});
  assert.throws(()=>values.cash({operationKey:randomUUID(),countedAmount:'1.001'},true),{publicCode:'CASH_INVALID'});
  assert.throws(()=>values.cancel({operationKey:randomUUID(),reason:' '}),{publicCode:'REASON_REQUIRED'});
  assert.throws(()=>values.sale({...cart(),operationKey:randomUUID(),quoteToken:'a'.repeat(64),cashReceived:'20',detail:'bad\n'}),{publicCode:'DETAIL_INVALID'});
});
test('caja central: pedidos, flujo y confirmacion tienen cuerpos estrictos', () => {
  const order = values.order({ items: cart().items, priceType: 'RETAIL', discountPercent: '10', detail: ' Pedido ', operationKey: randomUUID() });
  assert.equal(order.detail, 'Pedido'); assert.equal(order.items[0].productId, '1');
  assert.equal(values.orderQuote({ paymentMethod: 'CARD' }).paymentMethod, 'CARD');
  assert.equal(values.orderCharge({ operationKey: randomUUID(), quoteToken: 'a'.repeat(64), paymentMethod: 'TRANSFER', cashReceived: null }).cashReceived, null);
  assert.equal(values.salesFlow({ salesFlow: 'CENTRALIZED' }), 'CENTRALIZED');
  assert.equal(values.paymentConfirmation({ operationKey: randomUUID() }).operationKey.length, 36);
  assert.equal(values.orderQuote({ paymentMethod: 'CREDIT' }).paymentMethod, 'CREDIT');
  assert.throws(() => values.salesFlow({ salesFlow: 'OTHER' }), { publicCode: 'INVALID_INPUT' });
  assert.throws(() => values.order({ items: cart().items, priceType: 'RETAIL', discountPercent: '10', detail: '', operationKey: randomUUID(), total: '1.00' }), { publicCode: 'INVALID_INPUT' });
});
test('ventas: limite del total impide desbordar DECIMAL', () => {
  assert.throws(()=>values.calculate([product('1','9999999999.99','10.125')],values.quote(cart({items:[{productId:'1',quantity:'2'}]}))),{publicCode:'TOTAL_LIMIT'});
});
