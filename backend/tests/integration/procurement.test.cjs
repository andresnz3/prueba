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
const password = 'Procurement-fixture-password-123!';
function client(base) {
  const jar = new Map(); let csrf;
  async function request(path, method = 'GET', body) {
    const response = await fetch(base + '/api' + path, { method, headers: { Cookie: [...jar].map(([key, value]) => key + '=' + value).join('; '), ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf || '' }) }, body: method === 'GET' ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0], pos = pair.indexOf('='); jar.set(pair.slice(0, pos), pair.slice(pos + 1)); }
    const data = response.status === 204 ? undefined : await response.json(); if (data?.csrfToken) csrf = data.csrfToken;
    return { status: response.status, data };
  }
  async function login(_businessId, username) { await request('/auth/csrf'); assert.equal((await request('/auth/login', 'POST', { username, password })).status, 200); }
  return { request, login };
}

test('Integración MySQL fase 5.6: proveedores, compras conectadas y CxP', async t => {
  const config = readConfig(), authConfig = readAuthConfig({ CSRF_SECRET: randomBytes(32).toString('hex'), AUTH_RATE_MAX: '100' });
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 20 }); t.after(() => pool.end());
  const business = String((await rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['Procurement A'])).insertId);
  const otherBusiness = String((await rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['Procurement B'])).insertId);
  const hash = await hashPassword(password);
  await rows(pool, 'INSERT INTO users (business_id, username, full_name, password_hash, role) VALUES (?, ?, ?, ?, ?)', [business, 'procurementadmin', 'Procurement Admin', hash, 'ADMIN']);
  await rows(pool, 'INSERT INTO users (business_id, username, full_name, password_hash, role) VALUES (?, ?, ?, ?, ?)', [business, 'procurementvendor', 'Procurement Vendor', hash, 'VENDEDOR']);
  await rows(pool, 'INSERT INTO users (business_id, username, full_name, password_hash, role) VALUES (?, ?, ?, ?, ?)', [otherBusiness, 'procurementother', 'Other Admin', hash, 'ADMIN']);
  const repo = createAuthRepository(pool, authConfig), auth = createAuthService(repo, authConfig);
  const server = createApp({ config, checkDatabase: async () => {}, authentication: { repo, auth, config: authConfig, users: createUsersService(repo) } }).listen(0, '127.0.0.1');
  await new Promise(ok => server.once('listening', ok)); t.after(() => new Promise(ok => { server.close(ok); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port, admin = client(base), seller = client(base), other = client(base);
  await admin.login(business, 'procurementadmin'); await seller.login(business, 'procurementvendor'); await other.login(otherBusiness, 'procurementother');
  const sellerPurchases = await seller.request('/purchases?limit=100');
  assert.equal(sellerPurchases.status, 403); assert.equal(sellerPurchases.data.error.code, 'MODULE_FORBIDDEN');
  const sellerSupplierWrite = await seller.request('/suppliers', 'POST', { name: 'No autorizado', contact: 'Vendedor', phone: '5550000', ruc: null, address: 'Managua' });
  assert.equal(sellerSupplierWrite.status, 403); assert.equal(sellerSupplierWrite.data.error.code, 'MODULE_FORBIDDEN');
  const productResponse = await admin.request('/products', 'POST', { barcode: 'P-' + randomUUID(), name: 'Procurement product', category: 'General', cost: '5.00', marginRetail: '20.0000', marginWholesale: '10.0000', retailPrice: '7.00', wholesalePrice: '6.00', stock: '3.000', minStock: '1.000', taxRate: '0.0000', image: null, active: true });
  assert.equal(productResponse.status, 201, JSON.stringify(productResponse.data));
  const product = productResponse.data.product;
  const supplierResponse = await admin.request('/purchases/suppliers', 'POST', { name: 'Proveedor ' + randomUUID().slice(0, 8), contact: 'Contacto', phone: '5551000', ruc: null, address: 'Managua' });
  assert.equal(supplierResponse.status, 201, JSON.stringify(supplierResponse.data));
  const supplier = supplierResponse.data.supplier;
  assert.equal((await admin.request('/suppliers?limit=100')).data.suppliers.some(row => row.id === supplier.id), true);
  assert.equal((await admin.request('/purchases/suppliers?limit=100')).data.suppliers.some(row => row.id === supplier.id), true);
  assert.equal((await admin.request('/suppliers', 'POST', { name: supplier.name })).data.error.code, 'SUPPLIER_DUPLICATE');
  assert.equal((await other.request('/suppliers/' + supplier.id)).status, 404);
  const noCash = await admin.request('/purchases', 'POST', { operationKey: randomUUID(), supplierId: supplier.id, invoiceNumber: 'NO-CASH', purchaseType: 'CASH', paymentMethod: 'CASH', items: [{ productId: product.id, quantity: '1.000', unitCost: '6.00' }] });
  assert.equal(noCash.data.error.code, 'SUPPLIER_CASH_CLOSED');

  const opened = await admin.request('/cash/sessions', 'POST', { operationKey: randomUUID(), openingAmount: '100.00' });
  assert.equal(opened.status, 201, JSON.stringify(opened.data));
  const purchaseData = (overrides = {}) => ({ operationKey: randomUUID(), supplierId: supplier.id, invoiceNumber: 'INV-' + randomUUID().slice(0, 8), purchaseType: 'CASH', paymentMethod: 'CASH', items: [{ productId: product.id, quantity: '4.000', unitCost: '6.00' }], ...overrides });
  const insufficientCash = await admin.request('/purchases', 'POST', purchaseData({ invoiceNumber: 'LOW-CASH', items: [{ productId: product.id, quantity: '1.000', unitCost: '101.00' }] }));
  assert.equal(insufficientCash.status, 409); assert.equal(insufficientCash.data.error.code, 'CASH_BALANCE_INSUFFICIENT');
  const supplierEdit = await admin.request('/suppliers/' + supplier.id, 'PATCH', { contact: 'Contacto actualizado' });
  assert.equal(supplierEdit.status, 200); assert.equal(supplierEdit.data.supplier.contact, 'Contacto actualizado');
  await admin.request('/suppliers/' + supplier.id + '/active', 'PATCH', { active: false });
  const inactiveSupplier = await admin.request('/purchases', 'POST', purchaseData({ invoiceNumber: 'INACTIVE-SUPPLIER' }));
  assert.equal(inactiveSupplier.data.error.code, 'SUPPLIER_INACTIVE');
  await admin.request('/suppliers/' + supplier.id + '/active', 'PATCH', { active: true });
  const productOff = await admin.request('/products/' + product.id, 'PATCH', { revision: product.revision, active: false });
  assert.equal(productOff.status, 200);
  const inactiveProduct = await admin.request('/purchases', 'POST', purchaseData({ invoiceNumber: 'INACTIVE-PRODUCT' }));
  assert.equal(inactiveProduct.data.error.code, 'PRODUCT_INACTIVE');
  const productOn = await admin.request('/products/' + product.id, 'PATCH', { revision: productOff.data.product.revision, active: true });
  assert.equal(productOn.status, 200);
  const firstPurchaseInput = purchaseData();
  const firstPurchaseResponse = await admin.request('/purchases', 'POST', firstPurchaseInput);
  assert.equal(firstPurchaseResponse.status, 201, JSON.stringify(firstPurchaseResponse.data));
  const firstPurchase = firstPurchaseResponse.data.purchase;
  assert.equal(firstPurchase.total, '24.00'); assert.equal(firstPurchase.purchaseType, 'CASH');
  assert.match(firstPurchase.purchaseNumber, /^COMP-\d{6,}$/);
  assert.equal(firstPurchase.supplierInvoiceNumber, firstPurchaseInput.invoiceNumber);
  assert.equal((await admin.request('/purchases', 'POST', firstPurchaseInput)).data.purchase.id, firstPurchase.id, 'operation key makes a retried purchase idempotent');
  let updatedProduct = (await admin.request('/products/' + product.id)).data.product;
  assert.equal(updatedProduct.stock, '7.000'); assert.equal(updatedProduct.cost, '6.00');
  assert.equal(updatedProduct.retailPrice, '7.20'); assert.equal(updatedProduct.wholesalePrice, '6.60');
  assert.equal((await admin.request('/cash/current?full=true')).data.cash.expectedAmount, '76.00');
  assert.equal(Number((await rows(pool, 'SELECT COUNT(*) AS n FROM purchase_items WHERE business_id=? AND purchase_id=?', [business, firstPurchase.id]))[0].n), 1);
  assert.equal(Number((await rows(pool, "SELECT COUNT(*) AS n FROM inventory_movements WHERE business_id=? AND reference_type='purchases' AND reference_id=? AND type='PURCHASE'", [business, firstPurchase.id]))[0].n), 1);
  assert.equal(Number((await rows(pool, "SELECT COUNT(*) AS n FROM cash_movements WHERE business_id=? AND reference_type='purchases' AND reference_id=?", [business, firstPurchase.id]))[0].n), 1);

  const creditInput = purchaseData({ invoiceNumber: 'CREDIT-' + randomUUID().slice(0, 8), purchaseType: 'CREDIT', paymentMethod: undefined, dueDays: 30, items: [{ productId: product.id, quantity: '2.000', unitCost: '6.00' }] });
  delete creditInput.paymentMethod;
  const creditResponse = await admin.request('/purchases', 'POST', creditInput);
  assert.equal(creditResponse.status, 201, JSON.stringify(creditResponse.data));
  const creditPurchase = creditResponse.data.purchase;
  assert.equal(creditPurchase.total, '12.00'); assert.equal((await admin.request('/payables/' + creditPurchase.id)).data.purchase.id, creditPurchase.id);
  let payables = await admin.request('/payables?limit=100');
  assert.equal(payables.status, 200); assert.equal(payables.data.payables[0].balance, '12.00');
  assert.equal((await admin.request('/payables/summary')).data.summary.balance, '12.00');
  const overpay = await admin.request('/payables/' + creditPurchase.id + '/payments', 'POST', { operationKey: randomUUID(), amount: '12.01', paymentMethod: 'CASH' });
  assert.equal(overpay.status, 409); assert.equal(overpay.data.error.code, 'PAYMENT_EXCEEDS_BALANCE');
  const cardPaymentInput = { operationKey: randomUUID(), amount: '1.00', paymentMethod: 'CARD' };
  const cardPayment = await admin.request('/payables/' + creditPurchase.id + '/payments', 'POST', cardPaymentInput);
  assert.equal(cardPayment.status, 201, JSON.stringify(cardPayment.data)); assert.equal(cardPayment.data.payment.status, 'PENDING');
  assert.deepEqual((await admin.request('/payables/' + creditPurchase.id + '/payments', 'POST', cardPaymentInput)).data, cardPayment.data, 'reintentar el mismo abono no crea un segundo pago');
  assert.equal(Number((await rows(pool, "SELECT COUNT(*) AS n FROM supplier_payments WHERE business_id=? AND purchase_id=? AND payment_method='CARD'", [business, creditPurchase.id]))[0].n), 1);
  assert.equal(Number((await rows(pool, "SELECT COUNT(*) AS n FROM cash_movements WHERE business_id=? AND supplier_payment_id=?", [business, cardPayment.data.payment.id]))[0].n), 1);
  let partial = (await admin.request('/payables?limit=100')).data.payables.find(row => row.id === creditPurchase.id);
  assert.equal(partial.status, 'PENDING_CONFIRMATION'); assert.equal(partial.paid, '0.00'); assert.equal(partial.balance, '12.00'); assert.equal(partial.pendingPayments, '1.00'); assert.equal(partial.availableBalance, '11.00');
  const pendingOverpay = await admin.request('/payables/' + creditPurchase.id + '/payments', 'POST', { operationKey: randomUUID(), amount: '11.01', paymentMethod: 'TRANSFER' });
  assert.equal(pendingOverpay.status, 409); assert.equal(pendingOverpay.data.error.code, 'PAYMENT_EXCEEDS_BALANCE');
  const expectedBeforeCardConfirmation = (await admin.request('/cash/current?full=true')).data.cash.expectedAmount;
  const overviewBeforeCardConfirmation = (await admin.request('/cash/overview')).data.overview;
  const pendingCard = overviewBeforeCardConfirmation.pendingPayments.find(row => row.kind === 'SUPPLIER_PAYMENT' && row.purchaseId === creditPurchase.id);
  assert.ok(pendingCard); assert.equal(pendingCard.paymentMethod, 'CARD');
  const cardConfirmation = { operationKey: randomUUID() };
  const confirmedCard = await admin.request('/cash/payments/' + pendingCard.id + '/confirm', 'POST', cardConfirmation);
  assert.equal(confirmedCard.status, 200, JSON.stringify(confirmedCard.data)); assert.equal(confirmedCard.data.supplierPayment.status, 'POSTED');
  assert.deepEqual((await admin.request('/cash/payments/' + pendingCard.id + '/confirm', 'POST', cardConfirmation)).data, confirmedCard.data);
  assert.equal((await admin.request('/cash/current?full=true')).data.cash.expectedAmount, expectedBeforeCardConfirmation);
  partial = (await admin.request('/payables?limit=100')).data.payables.find(row => row.id === creditPurchase.id);
  assert.equal(partial.paid, '1.00'); assert.equal(partial.pendingPayments, '0.00'); assert.equal(partial.balance, '11.00');
  const firstCashPayInput = { operationKey: randomUUID(), amount: '5.00', paymentMethod: 'CASH' };
  const firstCashPay = await admin.request('/payables/' + creditPurchase.id + '/payments', 'POST', firstCashPayInput);
  assert.equal(firstCashPay.status, 201, JSON.stringify(firstCashPay.data)); assert.equal(firstCashPay.data.payment.status, 'POSTED');
  assert.deepEqual((await admin.request('/payables/' + creditPurchase.id + '/payments', 'POST', firstCashPayInput)).data, firstCashPay.data, 'reintentar el mismo abono en efectivo no duplica pago ni salida de caja');
  assert.equal(Number((await rows(pool, "SELECT COUNT(*) AS n FROM supplier_payments WHERE business_id=? AND purchase_id=? AND payment_method='CASH' AND amount='5.00'", [business, creditPurchase.id]))[0].n), 1);
  assert.equal(Number((await rows(pool, 'SELECT COUNT(*) AS n FROM cash_movements WHERE business_id=? AND supplier_payment_id=?', [business, firstCashPay.data.payment.id]))[0].n), 1);
  partial = (await admin.request('/payables?limit=100')).data.payables.find(row => row.id === creditPurchase.id);
  assert.equal(partial.status, 'PARTIAL'); assert.equal(partial.paid, '6.00'); assert.equal(partial.balance, '6.00');
  const overpayAfterPartial = await admin.request('/payables/' + creditPurchase.id + '/payments', 'POST', { operationKey: randomUUID(), amount: '6.01', paymentMethod: 'CASH' });
  assert.equal(overpayAfterPartial.status, 409); assert.equal(overpayAfterPartial.data.error.code, 'PAYMENT_EXCEEDS_BALANCE');
  const transferPayment = await admin.request('/payables/' + creditPurchase.id + '/payments', 'POST', { operationKey: randomUUID(), amount: '6.00', paymentMethod: 'TRANSFER' });
  assert.equal(transferPayment.status, 201, JSON.stringify(transferPayment.data)); assert.equal(transferPayment.data.payment.status, 'PENDING');
  const overviewBeforeTransferConfirmation = (await admin.request('/cash/overview')).data.overview;
  const pendingTransfer = overviewBeforeTransferConfirmation.pendingPayments.find(row => row.kind === 'SUPPLIER_PAYMENT' && row.purchaseId === creditPurchase.id);
  assert.ok(pendingTransfer); assert.equal(pendingTransfer.paymentMethod, 'TRANSFER');
  const expectedBeforeTransferConfirmation = (await admin.request('/cash/current?full=true')).data.cash.expectedAmount;
  const transferConfirmation = { operationKey: randomUUID() };
  const confirmedTransfer = await admin.request('/cash/payments/' + pendingTransfer.id + '/confirm', 'POST', transferConfirmation);
  assert.equal(confirmedTransfer.status, 200, JSON.stringify(confirmedTransfer.data)); assert.equal(confirmedTransfer.data.supplierPayment.status, 'POSTED');
  assert.equal((await admin.request('/cash/current?full=true')).data.cash.expectedAmount, expectedBeforeTransferConfirmation);
  assert.equal((await admin.request('/payables/' + creditPurchase.id)).data.purchase.status, 'PAID');
  assert.equal((await admin.request('/payables/summary')).data.summary.balance, '0.00');
  assert.equal((await admin.request('/payables/summary')).data.summary.pendingPayments, '0.00');
  const statement = await admin.request('/suppliers/' + supplier.id + '/statement?limit=100&offset=0');
  assert.equal(statement.status, 200); assert.ok(statement.data.entries.some(row => row.kind === 'PAYMENT' && row.paid === '5.00'));
  assert.equal((await admin.request('/cash/current?full=true')).data.cash.expectedAmount, '71.00');

  const cashOnlyInput = purchaseData({ invoiceNumber: 'NO-005-CASH-' + randomUUID().slice(0, 8), items: [{ productId: product.id, quantity: '1.000', unitCost: '6.00' }] });
  const cashOnly = await admin.request('/purchases', 'POST', cashOnlyInput);
  assert.equal(cashOnly.status, 201, 'el pago de compra en efectivo no requiere la migración 005');
  assert.equal(cashOnly.data.purchase.status, 'PAID');
  const cashOnlyDetail = (await admin.request('/purchases/' + cashOnly.data.purchase.id)).data.purchase;
  assert.deepEqual({ paid: cashOnlyDetail.paid, pendingPayments: cashOnlyDetail.pendingPayments, balance: cashOnlyDetail.balance }, { paid: cashOnlyDetail.total, pendingPayments: '0.00', balance: '0.00' });
  const cashOnlyStatement = (await admin.request('/suppliers/' + supplier.id + '/statement?limit=100&offset=0')).data.entries.filter(row => row.purchaseId === cashOnlyDetail.id);
  assert.equal(cashOnlyStatement.find(row => row.kind === 'PURCHASE').charge, cashOnlyDetail.total);
  assert.equal(cashOnlyStatement.filter(row => row.kind === 'PAYMENT' && row.status === 'POSTED').reduce((sum, row) => sum + Number(row.paid), 0), Number(cashOnlyDetail.total));
  assert.equal(cashOnlyStatement.at(-1).runningBalance, '0.00', 'la compra y su pago al contado se compensan en el estado de cuenta del proveedor');
  const cashEditProduct = await fixtureProduct('Cash purchase edit fixture');
  const cashBeforePurchase = (await admin.request('/cash/current?full=true')).data.cash.expectedAmount;
  const cashEditResponse = await admin.request('/purchases', 'POST', { operationKey: randomUUID(), supplierId: supplier.id, invoiceNumber: 'CASH-EDIT-' + randomUUID().slice(0, 8), purchaseType: 'CASH', paymentMethod: 'CASH', items: [{ productId: cashEditProduct.id, quantity: '2.000', unitCost: '2.00' }] });
  assert.equal(cashEditResponse.status, 201, JSON.stringify(cashEditResponse.data));
  const cashEditPurchase = cashEditResponse.data.purchase;
  const cashEditDetail = (await admin.request('/purchases/' + cashEditPurchase.id)).data.purchase;
  assert.equal(cashEditDetail.editability.allowed, true);
  const cashEditInput = { operationKey: randomUUID(), revision: cashEditDetail.revision, supplierInvoiceNumber: 'CASH-EDIT-CORRECTED-' + randomUUID().slice(0, 8), items: [{ productId: cashEditProduct.id, quantity: '3.000', unitCost: '3.00' }] };
  const cashBeforeCorrection = (await admin.request('/cash/current?full=true')).data.cash.expectedAmount;
  const cashEdited = await admin.request('/purchases/' + cashEditPurchase.id, 'PATCH', cashEditInput);
  assert.equal(cashEdited.status, 200, JSON.stringify(cashEdited.data));
  assert.equal(cashEdited.data.purchase.total, '9.00');
  assert.equal((await admin.request('/cash/current?full=true')).data.cash.expectedAmount, (Number(cashBeforeCorrection) - 5).toFixed(2));
  assert.equal((await admin.request('/products/' + cashEditProduct.id)).data.product.stock, '3.000');
  const [cashEditPayments] = await rows(pool, "SELECT COUNT(*) AS count,SUM(CASE WHEN status='POSTED' THEN amount ELSE 0 END) AS paid FROM supplier_payments WHERE business_id=? AND purchase_id=?", [business, cashEditPurchase.id]);
  assert.equal(Number(cashEditPayments.count), 2); assert.equal(String(cashEditPayments.paid), '9.00');
  const [cashEditMovements] = await rows(pool, "SELECT COUNT(*) AS count,SUM(amount) AS total FROM cash_movements WHERE business_id=? AND reference_type='purchases' AND reference_id=? AND direction='OUT' AND status='CONFIRMED'", [business, cashEditPurchase.id]);
  assert.equal(Number(cashEditMovements.count), 2); assert.equal(String(cashEditMovements.total), '9.00');
  assert.deepEqual((await admin.request('/purchases/' + cashEditPurchase.id, 'PATCH', cashEditInput)).data, cashEdited.data, 'repetir la corrección no repite el pago adicional ni la salida de caja');
  const cashEditCurrent = (await admin.request('/purchases/' + cashEditPurchase.id)).data.purchase;
  const cashReduction = await admin.request('/purchases/' + cashEditPurchase.id, 'PATCH', { operationKey: randomUUID(), revision: cashEditCurrent.revision, items: [{ productId: cashEditProduct.id, quantity: '1.000', unitCost: '3.00' }] });
  assert.equal(cashReduction.status, 409); assert.equal(cashReduction.data.error.code, 'PURCHASE_CASH_REFUND_REQUIRED');
  assert.equal((await admin.request('/purchases/' + cashEditPurchase.id)).data.purchase.total, '9.00', 'no reduce el comprobante ni el pago sin un flujo conciliado de devolución');
  const cashEditCancel = await admin.request('/purchases/' + cashEditPurchase.id + '/cancel', 'POST', { operationKey: randomUUID(), reason: 'Revertir fixture de corrección al contado' });
  assert.equal(cashEditCancel.status, 200, JSON.stringify(cashEditCancel.data));
  assert.equal((await admin.request('/cash/current?full=true')).data.cash.expectedAmount, cashBeforePurchase);
  assert.equal((await admin.request('/products/' + cashEditProduct.id)).data.product.stock, '0.000');
  const [cashEditAfterCancel] = await rows(pool, "SELECT COUNT(*) AS payments,SUM(CASE WHEN status='VOID' THEN 1 ELSE 0 END) AS voids FROM supplier_payments WHERE business_id=? AND purchase_id=?", [business, cashEditPurchase.id]);
  assert.equal(Number(cashEditAfterCancel.payments), 2); assert.equal(Number(cashEditAfterCancel.voids), 2);
  const cardPurchaseInput = purchaseData({ invoiceNumber: 'NO-005-CARD-' + randomUUID().slice(0, 8), paymentMethod: 'CARD', items: [{ productId: product.id, quantity: '1.000', unitCost: '6.00' }] });
  const cardPurchase = await admin.request('/purchases', 'POST', cardPurchaseInput);
  assert.equal(cardPurchase.status, 201, JSON.stringify(cardPurchase.data)); assert.equal(cardPurchase.data.purchase.status, 'PENDING_CONFIRMATION');
  const cancelledPendingCardPurchase = await admin.request('/purchases/' + cardPurchase.data.purchase.id + '/cancel', 'POST', { operationKey: randomUUID(), reason: 'Pago bancario cancelado antes de conciliar' });
  assert.equal(cancelledPendingCardPurchase.status, 200, JSON.stringify(cancelledPendingCardPurchase.data));
  assert.equal(cancelledPendingCardPurchase.data.purchase.status, 'CANCELLED');
  const transferPurchaseInput = purchaseData({ invoiceNumber: 'NO-005-TRANSFER-' + randomUUID().slice(0, 8), paymentMethod: 'TRANSFER', items: [{ productId: product.id, quantity: '1.000', unitCost: '6.00' }] });
  const transferPurchase = await admin.request('/purchases', 'POST', transferPurchaseInput);
  assert.equal(transferPurchase.status, 201, JSON.stringify(transferPurchase.data)); assert.equal(transferPurchase.data.purchase.status, 'PENDING_CONFIRMATION');
  const transferPurchaseBeforeConfirmation = (await admin.request('/purchases/' + transferPurchase.data.purchase.id)).data.purchase;
  assert.deepEqual({ paid: transferPurchaseBeforeConfirmation.paid, pendingPayments: transferPurchaseBeforeConfirmation.pendingPayments, balance: transferPurchaseBeforeConfirmation.balance }, { paid: '0.00', pendingPayments: transferPurchaseBeforeConfirmation.total, balance: transferPurchaseBeforeConfirmation.total });
  const transferStatementBeforeConfirmation = (await admin.request('/suppliers/' + supplier.id + '/statement?limit=100&offset=0')).data.entries.filter(row => row.purchaseId === transferPurchase.data.purchase.id);
  assert.equal(transferStatementBeforeConfirmation.find(row => row.kind === 'PURCHASE').charge, transferPurchaseBeforeConfirmation.total);
  assert.equal(transferStatementBeforeConfirmation.find(row => row.kind === 'PAYMENT').pending, transferPurchaseBeforeConfirmation.total);
  assert.equal(transferStatementBeforeConfirmation.at(-1).runningBalance, transferPurchaseBeforeConfirmation.total, 'un pago bancario pendiente no reduce el saldo confirmado');
  const transferPurchasePending = (await admin.request('/cash/overview')).data.overview.pendingPayments.find(row => row.kind === 'SUPPLIER_PAYMENT' && row.purchaseId === transferPurchase.data.purchase.id);
  assert.ok(transferPurchasePending);
  const expectedBeforeTransferPurchaseConfirmation = (await admin.request('/cash/current?full=true')).data.cash.expectedAmount;
  const transferPurchaseConfirmation = await admin.request('/cash/payments/' + transferPurchasePending.id + '/confirm', 'POST', { operationKey: randomUUID() });
  assert.equal(transferPurchaseConfirmation.status, 200, JSON.stringify(transferPurchaseConfirmation.data)); assert.equal(transferPurchaseConfirmation.data.supplierPayment.status, 'POSTED');
  assert.equal((await admin.request('/cash/current?full=true')).data.cash.expectedAmount, expectedBeforeTransferPurchaseConfirmation);
  const transferPurchaseAfterConfirmation = (await admin.request('/purchases/' + transferPurchase.data.purchase.id)).data.purchase;
  assert.deepEqual({ paid: transferPurchaseAfterConfirmation.paid, pendingPayments: transferPurchaseAfterConfirmation.pendingPayments, balance: transferPurchaseAfterConfirmation.balance }, { paid: transferPurchaseAfterConfirmation.total, pendingPayments: '0.00', balance: '0.00' });
  const transferStatementAfterConfirmation = (await admin.request('/suppliers/' + supplier.id + '/statement?limit=100&offset=0')).data.entries.filter(row => row.purchaseId === transferPurchase.data.purchase.id);
  assert.equal(transferStatementAfterConfirmation.filter(row => row.kind === 'PAYMENT' && row.status === 'POSTED').reduce((sum, row) => sum + Number(row.paid), 0), Number(transferPurchaseAfterConfirmation.total));
  assert.equal(transferStatementAfterConfirmation.at(-1).runningBalance, '0.00', 'la confirmación cierra el saldo del pago bancario de contado');

  const cancelCash = await admin.request('/purchases/' + firstPurchase.id + '/cancel', 'POST', { operationKey: randomUUID(), reason: 'Factura duplicada' });
  assert.equal(cancelCash.status, 200, JSON.stringify(cancelCash.data)); assert.equal(cancelCash.data.purchase.status, 'CANCELLED');
  const [productAfterCancel] = await rows(pool, 'SELECT stock FROM products WHERE business_id=? AND id=?', [business, product.id]);
  assert.equal(productAfterCancel.stock, '7.000', 'la anulación revierte solo las cuatro unidades de esa compra');
  const cancelMovements = await rows(pool, "SELECT type,COUNT(*) AS n,SUM(quantity) AS quantity FROM inventory_movements WHERE business_id=? AND reference_type='purchases' AND reference_id=? GROUP BY type", [business, firstPurchase.id]);
  assert.deepEqual(Object.fromEntries(cancelMovements.map(row => [row.type, [Number(row.n), String(row.quantity)]])), { PURCHASE: [1, '4.000'], PURCHASE_CANCEL: [1, '-4.000'] });
  const [cashReversal] = await rows(pool, "SELECT COUNT(*) AS n,SUM(CASE WHEN direction='OUT' THEN amount ELSE -amount END) AS net FROM cash_movements WHERE business_id=? AND reference_type='purchases' AND reference_id=?", [business, firstPurchase.id]);
  assert.equal(Number(cashReversal.n), 2); assert.equal(String(cashReversal.net), '0.00', 'la reversión compensa la salida sin borrar el historial');
  const [cancelledPayment] = await rows(pool, 'SELECT status FROM supplier_payments WHERE business_id=? AND purchase_id=?', [business, firstPurchase.id]);
  assert.equal(cancelledPayment.status, 'VOID');
  const reports = await admin.request('/reports/connected');
  assert.equal(reports.status, 200, JSON.stringify(reports.data));
  assert.equal(reports.data.report.purchases.total, '24.00');
  assert.equal(reports.data.report.purchases.history.some(row => row.invoiceNumber === firstPurchase.invoiceNumber && row.status === 'CANCELLED'), true);
  assert.equal(reports.data.report.payables.balance, '0.00');
  assert.equal(reports.data.report.suppliers.list.find(row => row.name === supplier.name).totalPurchased, '24.00');
  assert.ok(reports.data.report.suppliers.payments.some(row => row.invoiceNumber === creditPurchase.invoiceNumber && row.status === 'POSTED'));
  assert.equal(reports.data.report.cash.currentExpected, '89.00');
  const reportCard = reports.data.report.suppliers.payments.find(row => row.invoiceNumber === creditPurchase.invoiceNumber && row.paymentMethod === 'CARD');
  const reportTransfer = reports.data.report.suppliers.payments.find(row => row.invoiceNumber === creditPurchase.invoiceNumber && row.paymentMethod === 'TRANSFER');
  assert.equal(reportCard.status, 'POSTED'); assert.equal(reportCard.confirmedBy, 'Procurement Admin'); assert.ok(reportCard.confirmedAt);
  assert.equal(reportTransfer.status, 'POSTED'); assert.equal(reportTransfer.confirmedBy, 'Procurement Admin'); assert.ok(reportTransfer.confirmedAt);
  const reportCashPurchaseTransfer = reports.data.report.suppliers.payments.find(row => row.invoiceNumber === transferPurchase.data.purchase.invoiceNumber && row.paymentMethod === 'TRANSFER');
  assert.equal(reportCashPurchaseTransfer.status, 'POSTED'); assert.equal(reportCashPurchaseTransfer.confirmedBy, 'Procurement Admin'); assert.ok(reportCashPurchaseTransfer.confirmedAt);
  const [confirmationAudit] = await rows(pool, "SELECT details FROM audit_logs WHERE business_id=? AND action='CONFIRM_NONCASH_PAYMENT' AND entity_id=?", [business, pendingTransfer.id]);
  assert.ok(confirmationAudit);
  const confirmationDetails = typeof confirmationAudit.details === 'string' ? JSON.parse(confirmationAudit.details) : confirmationAudit.details;
  assert.equal(confirmationDetails.supplierPaymentId, transferPayment.data.payment.id); assert.equal(confirmationDetails.paymentMethod, 'TRANSFER');
  const cashRaceProduct = await fixtureProduct('Cash purchase concurrent edit fixture');
  const cashRaceResponse = await admin.request('/purchases', 'POST', { operationKey: randomUUID(), supplierId: supplier.id, invoiceNumber: 'CASH-RACE-' + randomUUID().slice(0, 8), purchaseType: 'CASH', paymentMethod: 'CASH', items: [{ productId: cashRaceProduct.id, quantity: '1.000', unitCost: '2.00' }] });
  assert.equal(cashRaceResponse.status, 201, JSON.stringify(cashRaceResponse.data));
  const cashRacePurchase = cashRaceResponse.data.purchase, cashRaceRevision = (await admin.request('/purchases/' + cashRacePurchase.id)).data.purchase.revision;
  const competingEdits = await Promise.all([
    admin.request('/purchases/' + cashRacePurchase.id, 'PATCH', { operationKey: randomUUID(), revision: cashRaceRevision, items: [{ productId: cashRaceProduct.id, quantity: '2.000', unitCost: '2.00' }] }),
    admin.request('/purchases/' + cashRacePurchase.id, 'PATCH', { operationKey: randomUUID(), revision: cashRaceRevision, items: [{ productId: cashRaceProduct.id, quantity: '3.000', unitCost: '2.00' }] })
  ]);
  assert.deepEqual(competingEdits.map(response => response.status).sort(), [200, 409]);
  assert.equal(competingEdits.find(response => response.status === 409).data.error.code, 'PURCHASE_REVISION_CONFLICT');
  const [cashRaceTotals] = await rows(pool, "SELECT p.total,COALESCE(SUM(CASE WHEN sp.status='POSTED' THEN sp.amount ELSE 0 END),0.00) AS paid,COUNT(sp.id) AS payments,COUNT(m.id) AS movements,COALESCE(SUM(CASE WHEN m.status='CONFIRMED' AND m.direction='OUT' THEN m.amount ELSE 0 END),0.00) AS cash_out FROM purchases p LEFT JOIN supplier_payments sp ON sp.business_id=p.business_id AND sp.purchase_id=p.id LEFT JOIN cash_movements m ON m.business_id=sp.business_id AND m.supplier_payment_id=sp.id WHERE p.business_id=? AND p.id=? GROUP BY p.id", [business, cashRacePurchase.id]);
  assert.equal(String(cashRaceTotals.total), String(cashRaceTotals.paid)); assert.equal(Number(cashRaceTotals.payments), 2); assert.equal(Number(cashRaceTotals.movements), 2); assert.equal(String(cashRaceTotals.cash_out), String(cashRaceTotals.total));
  const lowCashProduct = await fixtureProduct('Insufficient purchase correction fixture');
  const availableBeforeLowPurchase = Number((await admin.request('/cash/current?full=true')).data.cash.expectedAmount);
  const lowCashPurchaseAmount = (availableBeforeLowPurchase - 1).toFixed(2);
  assert.ok(Number(lowCashPurchaseAmount) > 0);
  const lowCashPurchaseResponse = await admin.request('/purchases', 'POST', { operationKey: randomUUID(), supplierId: supplier.id, invoiceNumber: 'LOW-CASH-EDIT-' + randomUUID().slice(0, 8), purchaseType: 'CASH', paymentMethod: 'CASH', items: [{ productId: lowCashProduct.id, quantity: '1.000', unitCost: lowCashPurchaseAmount }] });
  assert.equal(lowCashPurchaseResponse.status, 201, JSON.stringify(lowCashPurchaseResponse.data));
  const lowCashPurchase = lowCashPurchaseResponse.data.purchase, lowCashDetail = (await admin.request('/purchases/' + lowCashPurchase.id)).data.purchase;
  const lowCashEdit = await admin.request('/purchases/' + lowCashPurchase.id, 'PATCH', { operationKey: randomUUID(), revision: lowCashDetail.revision, items: [{ productId: lowCashProduct.id, quantity: '1.000', unitCost: (Number(lowCashPurchaseAmount) + 2).toFixed(2) }] });
  assert.equal(lowCashEdit.status, 409); assert.equal(lowCashEdit.data.error.code, 'PURCHASE_CASH_BALANCE_INSUFFICIENT');
  assert.equal((await admin.request('/purchases/' + lowCashPurchase.id)).data.purchase.total, lowCashPurchaseAmount);
  assert.equal((await admin.request('/products/' + lowCashProduct.id)).data.product.cost, lowCashPurchaseAmount);
  assert.equal(Number((await rows(pool, 'SELECT COUNT(*) AS count FROM supplier_payments WHERE business_id=? AND purchase_id=?', [business, lowCashPurchase.id]))[0].count), 1, 'un aumento sin efectivo suficiente no crea un abono parcial ni altera la factura');
  const costOnlyProduct = await fixtureProduct('Purchase cost only correction fixture');
  const costOnlyResponse = await admin.request('/purchases', 'POST', { operationKey: randomUUID(), supplierId: supplier.id, invoiceNumber: 'COST-ONLY-' + randomUUID().slice(0, 8), purchaseType: 'CREDIT', dueDays: 30, items: [{ productId: costOnlyProduct.id, quantity: '2.000', unitCost: '5.00' }] });
  const costOnlyPurchase = costOnlyResponse.data.purchase, costOnlyDetail = (await admin.request('/purchases/' + costOnlyPurchase.id)).data.purchase;
  const costOnlyEdit = await admin.request('/purchases/' + costOnlyPurchase.id, 'PATCH', { operationKey: randomUUID(), revision: costOnlyDetail.revision, items: [{ productId: costOnlyProduct.id, quantity: '2.000', unitCost: '6.00' }] });
  assert.equal(costOnlyEdit.status, 200, JSON.stringify(costOnlyEdit.data)); assert.equal(costOnlyEdit.data.purchase.total, '12.00');
  const [costOnlyMovement] = await rows(pool, "SELECT COUNT(*) AS count,MIN(quantity) AS quantity,MIN(unit_cost) AS min_cost,MAX(unit_cost) AS max_cost FROM inventory_movements WHERE business_id=? AND product_id=? AND reference_type='purchases' AND reference_id=?", [business, costOnlyProduct.id, costOnlyPurchase.id]);
  assert.equal(Number(costOnlyMovement.count), 1); assert.equal(String(costOnlyMovement.quantity), '2.000'); assert.equal(String(costOnlyMovement.min_cost), '6.00'); assert.equal(String(costOnlyMovement.max_cost), '6.00', 'la corrección de costo no crea unidades ni conserva un costo de Kardex obsoleto');
  assert.ok(reports.data.report.inventory.movements.some(row => row.type === 'PURCHASE'));
  assert.equal((await other.request('/purchases?limit=100')).data.purchases.some(row => row.supplierName === supplier.name), false);

  const noInvoiceInput = { operationKey: randomUUID(), supplierId: supplier.id, supplierInvoiceNumber: null, purchaseType: 'CREDIT', dueDays: 30, items: [{ productId: product.id, quantity: '1.000', unitCost: '6.00' }] };
  const noInvoiceResponse = await admin.request('/purchases', 'POST', noInvoiceInput);
  assert.equal(noInvoiceResponse.status, 201, JSON.stringify(noInvoiceResponse.data));
  const noInvoicePurchase = noInvoiceResponse.data.purchase;
  assert.match(noInvoicePurchase.purchaseNumber, /^COMP-\d{6,}$/);
  assert.equal(noInvoicePurchase.supplierInvoiceNumber, '');
  assert.equal((await admin.request('/purchases/' + noInvoicePurchase.id)).data.purchase.purchaseNumber, noInvoicePurchase.purchaseNumber);
  assert.ok((await admin.request('/purchases?limit=100&q=' + encodeURIComponent(noInvoicePurchase.purchaseNumber))).data.purchases.some(row => row.purchaseNumber === noInvoicePurchase.purchaseNumber));
  assert.ok((await admin.request('/payables?limit=100&q=' + encodeURIComponent(noInvoicePurchase.purchaseNumber))).data.payables.some(row => row.purchaseNumber === noInvoicePurchase.purchaseNumber));
  const supplierLedger = await admin.request('/suppliers/' + supplier.id + '/statement?limit=100&offset=0');
  assert.ok(supplierLedger.data.entries.some(row => row.reference.includes(noInvoicePurchase.purchaseNumber)));
  const reportsWithInternalNumber = await admin.request('/reports/connected');
  assert.ok(reportsWithInternalNumber.data.report.purchases.history.some(row => row.purchaseNumber === noInvoicePurchase.purchaseNumber && row.supplierInvoiceNumber === ''));
  assert.ok(reportsWithInternalNumber.data.report.payables.invoices.some(row => row.purchaseNumber === noInvoicePurchase.purchaseNumber && row.supplierInvoiceNumber === ''));

  const [adminAccount] = await rows(pool, 'SELECT id FROM users WHERE business_id=? AND username=?', [business, 'procurementadmin']);
  const createCreditPurchase = async (invoiceNumber, total) => {
    const response = await admin.request('/purchases', 'POST', purchaseData({
      invoiceNumber,
      purchaseType: 'CREDIT',
      paymentMethod: undefined,
      dueDays: 30,
      items: [{ productId: product.id, quantity: '1.000', unitCost: total }]
    }));
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data.purchase;
  };
  const seedPostedPayments = async (purchaseId, amount, count = 1) => {
    const valuesSql = Array(count).fill('(?,?,?,?,NULL,?,?,?,UTC_TIMESTAMP(3))').join(',');
    const values = Array.from({ length: count }, () => [business, adminAccount.id, supplier.id, purchaseId, amount, 'OTHER', 'POSTED']).flat();
    await rows(pool, 'INSERT INTO supplier_payments (business_id,user_id,supplier_id,purchase_id,cash_session_id,amount,payment_method,status,created_at) VALUES ' + valuesSql, values);
  };
  const paymentPagePurchase = await createCreditPurchase('STATEMENT-PAGE-FILLER', '1.00');
  await seedPostedPayments(paymentPagePurchase.id, '0.01', 100);
  const paidOffPage = await createCreditPurchase('STATEMENT-PAID-OFF-PAGE', '1.00');
  const paidOffPagePayment = await admin.request('/payables/' + paidOffPage.id + '/payments', 'POST', { operationKey: randomUUID(), amount: '1.00', paymentMethod: 'CASH' });
  assert.equal(paidOffPagePayment.status, 201, JSON.stringify(paidOffPagePayment.data));

  const authoritativeStatement = await admin.request('/suppliers/' + supplier.id + '/statement?limit=100&offset=0');
  assert.equal(authoritativeStatement.status, 200, JSON.stringify(authoritativeStatement.data));
  const statementEntries = authoritativeStatement.data.entries;
  const purchaseEntry = purchaseId => statementEntries.find(row => row.kind === 'PURCHASE' && row.purchaseId === purchaseId);
  const paidEntry = purchaseEntry(paidOffPage.id);
  assert.equal(statementEntries.some(row => row.kind === 'PAYMENT' && row.purchaseId === paidOffPage.id), false, 'el pago confirmado queda fuera de las primeras 100 filas visibles');
  assert.deepEqual({
    total: paidEntry.total,
    paidConfirmed: paidEntry.paidConfirmed,
    pendingPayments: paidEntry.pendingPayments,
    balance: paidEntry.balance,
    availableBalance: paidEntry.availableBalance,
    canPay: paidEntry.canPay
  }, { total: '1.00', paidConfirmed: '1.00', pendingPayments: '0.00', balance: '0.00', availableBalance: '0.00', canPay: false });

  async function fixtureProduct(name) {
    const response = await admin.request('/products', 'POST', { barcode: 'P-' + randomUUID(), name, category: 'Correcciones', cost: '5.00', marginRetail: '20.0000', marginWholesale: '10.0000', retailPrice: '6.00', wholesalePrice: '5.50', stock: '0.000', minStock: '0.000', taxRate: '0.0000', image: null, active: true });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data.product;
  }
  const editableProduct = await fixtureProduct('Purchase edit fixture');
  const editableResponse = await admin.request('/purchases', 'POST', { operationKey: randomUUID(), supplierId: supplier.id, invoiceNumber: 'EDIT-' + randomUUID().slice(0, 8), purchaseType: 'CREDIT', dueDays: 30, items: [{ productId: editableProduct.id, quantity: '2.000', unitCost: '6.00' }] });
  assert.equal(editableResponse.status, 201, JSON.stringify(editableResponse.data));
  const editablePurchase = editableResponse.data.purchase;
  let editableDetail = await admin.request('/purchases/' + editablePurchase.id);
  assert.equal(editableDetail.status, 200); assert.equal(editableDetail.data.purchase.editability.allowed, true); assert.match(editableDetail.data.purchase.revision, /^[a-f0-9]{64}$/);
  const editInput = { operationKey: randomUUID(), revision: editableDetail.data.purchase.revision, supplierInvoiceNumber: 'EDIT-CORRECTED-' + randomUUID().slice(0, 8), items: [{ productId: editableProduct.id, quantity: '3.000', unitCost: '7.00' }] };
  const edited = await admin.request('/purchases/' + editablePurchase.id, 'PATCH', editInput);
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.kind, 'EDIT_PURCHASE'); assert.equal(edited.data.purchase.total, '21.00'); assert.equal(edited.data.purchase.balance, '21.00');
  assert.equal(edited.data.purchase.createdAt, editablePurchase.createdAt, 'se conserva la fecha original');
  assert.equal(edited.data.purchase.items[0].quantity, '3.000'); assert.equal(edited.data.purchase.items[0].unitCost, '7.00');
  const productAfterEdit = (await admin.request('/products/' + editableProduct.id)).data.product;
  assert.equal(productAfterEdit.stock, '3.000'); assert.equal(productAfterEdit.cost, '7.00'); assert.equal(productAfterEdit.retailPrice, '8.40'); assert.equal(productAfterEdit.wholesalePrice, '7.70');
  const repeatedEdit = await admin.request('/purchases/' + editablePurchase.id, 'PATCH', editInput);
  assert.equal(repeatedEdit.status, 200); assert.equal(repeatedEdit.data.purchase.total, '21.00');
  const [editMovements] = await rows(pool, "SELECT COUNT(*) AS count, SUM(quantity) AS quantity,MIN(unit_cost) AS min_cost,MAX(unit_cost) AS max_cost FROM inventory_movements WHERE business_id=? AND product_id=? AND reference_type='purchases' AND reference_id=?", [business, editableProduct.id, editablePurchase.id]);
  assert.equal(Number(editMovements.count), 2); assert.equal(String(editMovements.quantity), '3.000', 'reintentar la edición no repite el ajuste de inventario'); assert.equal(String(editMovements.min_cost), '7.00'); assert.equal(String(editMovements.max_cost), '7.00', 'el Kardex muestra el costo de compra corregido');
  const editAudits = await rows(pool, "SELECT details FROM audit_logs WHERE business_id=? AND entity='purchases' AND entity_id=? AND action='EDIT_PURCHASE'", [business, editablePurchase.id]);
  assert.equal(editAudits.length, 1);
  const editAuditDetails = typeof editAudits[0].details === 'string' ? JSON.parse(editAudits[0].details) : editAudits[0].details;
  assert.equal(editAuditDetails.before.inventoryMovements[0].unitCost, '6.00'); assert.equal(editAuditDetails.after.inventoryMovements[0].unitCost, '7.00', 'auditoría conserva el costo anterior y el corregido del Kardex');
  const staleEdit = await admin.request('/purchases/' + editablePurchase.id, 'PATCH', { ...editInput, operationKey: randomUUID() });
  assert.equal(staleEdit.status, 409); assert.equal(staleEdit.data.error.code, 'PURCHASE_REVISION_CONFLICT');
  const lockedProduct = await fixtureProduct('Purchase movement lock fixture');
  const lockedResponse = await admin.request('/purchases', 'POST', { operationKey: randomUUID(), supplierId: supplier.id, invoiceNumber: 'LOCK-' + randomUUID().slice(0, 8), purchaseType: 'CREDIT', dueDays: 30, items: [{ productId: lockedProduct.id, quantity: '2.000', unitCost: '4.00' }] });
  const lockedPurchase = lockedResponse.data.purchase;
  await admin.request('/products/' + lockedProduct.id + '/movements', 'POST', { type: 'ADJUSTMENT', quantity: '1.000', reason: 'Prueba de movimiento posterior' });
  const lockedDetail = (await admin.request('/purchases/' + lockedPurchase.id)).data.purchase;
  assert.equal(lockedDetail.editability.allowed, false); assert.equal(lockedDetail.editability.reason, 'PURCHASE_HAS_SUBSEQUENT_MOVEMENTS');
  const lockedEdit = await admin.request('/purchases/' + lockedPurchase.id, 'PATCH', { operationKey: randomUUID(), revision: lockedDetail.revision, items: [{ productId: lockedProduct.id, quantity: '3.000', unitCost: '4.00' }] });
  assert.equal(lockedEdit.status, 409); assert.equal(lockedEdit.data.error.code, 'PURCHASE_HAS_SUBSEQUENT_MOVEMENTS');
  const paidProduct = await fixtureProduct('Purchase payment lock fixture');
  const paidResponse = await admin.request('/purchases', 'POST', { operationKey: randomUUID(), supplierId: supplier.id, invoiceNumber: 'PAID-' + randomUUID().slice(0, 8), purchaseType: 'CREDIT', dueDays: 30, items: [{ productId: paidProduct.id, quantity: '2.000', unitCost: '5.00' }] });
  const paidPurchase = paidResponse.data.purchase;
  assert.equal((await admin.request('/payables/' + paidPurchase.id + '/payments', 'POST', { operationKey: randomUUID(), amount: '1.00', paymentMethod: 'OTHER' })).status, 201);
  const paidDetail = (await admin.request('/purchases/' + paidPurchase.id)).data.purchase;
  assert.equal(paidDetail.editability.allowed, false); assert.equal(paidDetail.editability.reason, 'PURCHASE_HAS_PAYMENT_HISTORY');
  const paidEdit = await admin.request('/purchases/' + paidPurchase.id, 'PATCH', { operationKey: randomUUID(), revision: paidDetail.revision, items: [{ productId: paidProduct.id, quantity: '3.000', unitCost: '5.00' }] });
  assert.equal(paidEdit.status, 409); assert.equal(paidEdit.data.error.code, 'PURCHASE_HAS_PAYMENT_HISTORY');
  const crossBusinessEdit = await other.request('/purchases/' + editablePurchase.id, 'PATCH', editInput);
  assert.equal(crossBusinessEdit.status, 404);
  const sellerEdit = await seller.request('/purchases/' + editablePurchase.id, 'PATCH', editInput);
  assert.equal(sellerEdit.status, 403);

  const concurrentProduct = await fixtureProduct('Concurrent payable fixture');
  const concurrentPurchaseResponse = await admin.request('/purchases', 'POST', { operationKey: randomUUID(), supplierId: supplier.id, invoiceNumber: 'RACE-' + randomUUID().slice(0, 8), purchaseType: 'CREDIT', dueDays: 30, items: [{ productId: concurrentProduct.id, quantity: '1.000', unitCost: '10.00' }] });
  const concurrentPurchase = concurrentPurchaseResponse.data.purchase;
  const concurrentPayments = await Promise.all([
    admin.request('/payables/' + concurrentPurchase.id + '/payments', 'POST', { operationKey: randomUUID(), amount: '6.00', paymentMethod: 'OTHER' }),
    admin.request('/payables/' + concurrentPurchase.id + '/payments', 'POST', { operationKey: randomUUID(), amount: '6.00', paymentMethod: 'OTHER' })
  ]);
  assert.deepEqual(concurrentPayments.map(response => response.status).sort(), [201, 409]);
  const [raceRows] = await rows(pool, "SELECT COUNT(*) AS count,COALESCE(SUM(amount),0.00) AS amount FROM supplier_payments WHERE business_id=? AND purchase_id=? AND status='POSTED'", [business, concurrentPurchase.id]);
  assert.equal(Number(raceRows.count), 1); assert.equal(String(raceRows.amount), '6.00');
  const [raceInvoice] = await rows(pool, 'SELECT total FROM purchases WHERE business_id=? AND id=?', [business, concurrentPurchase.id]);
  assert.equal(String(raceInvoice.total), '10.00', 'la carrera no sobrepagó ni modificó el saldo original');

  const inconsistentPurchaseResponse = await admin.request('/purchases', 'POST', { operationKey: randomUUID(), supplierId: supplier.id, invoiceNumber: 'CASH-CHECK-' + randomUUID().slice(0, 8), purchaseType: 'CASH', paymentMethod: 'CARD', items: [{ productId: product.id, quantity: '1.000', unitCost: '1.00' }] });
  assert.equal(inconsistentPurchaseResponse.status, 201, JSON.stringify(inconsistentPurchaseResponse.data));
  const inconsistentPurchase = inconsistentPurchaseResponse.data.purchase;
  const [inconsistentPayment] = await rows(pool, 'SELECT id FROM supplier_payments WHERE business_id=? AND purchase_id=?', [business, inconsistentPurchase.id]);
  const [inconsistentMovement] = await rows(pool, 'SELECT id FROM cash_movements WHERE business_id=? AND supplier_payment_id=?', [business, inconsistentPayment.id]);
  assert.ok(inconsistentMovement);
  await rows(pool, "UPDATE cash_movements SET direction='IN' WHERE business_id=? AND id=?", [business, inconsistentMovement.id]);
  const inconsistentCancel = await admin.request('/purchases/' + inconsistentPurchase.id + '/cancel', 'POST', { operationKey: randomUUID(), reason: 'Prueba de relación de caja alterada' });
  assert.equal(inconsistentCancel.status, 409); assert.equal(inconsistentCancel.data.error.code, 'CASH_INCONSISTENT');
  const [unchangedPurchase] = await rows(pool, 'SELECT status FROM purchases WHERE business_id=? AND id=?', [business, inconsistentPurchase.id]);
  const [unchangedPayment] = await rows(pool, 'SELECT status FROM supplier_payments WHERE business_id=? AND id=?', [business, inconsistentPayment.id]);
  const [unchangedMovement] = await rows(pool, 'SELECT status,direction FROM cash_movements WHERE business_id=? AND id=?', [business, inconsistentMovement.id]);
  assert.equal(unchangedPurchase.status, 'COMPLETED'); assert.equal(unchangedPayment.status, 'PENDING'); assert.equal(unchangedMovement.status, 'PENDING'); assert.equal(unchangedMovement.direction, 'IN', 'la transacción no oculta el dato de caja inconsistente');

  const [audit] = await rows(pool, "SELECT COUNT(*) AS count FROM audit_logs a JOIN users u ON u.business_id=a.business_id AND u.id=a.user_id WHERE a.business_id=? AND u.username='procurementadmin' AND a.action IN ('CREATE_PURCHASE','EDIT_PURCHASE','CANCEL_PURCHASE','POST_SUPPLIER_PAYMENT','CREATE_SUPPLIER')", [business]);
  assert.ok(Number(audit.count) >= 7, 'compras, proveedores y pagos a proveedores registran auditoría');
});
