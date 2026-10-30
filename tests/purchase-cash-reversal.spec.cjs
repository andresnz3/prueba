/* global localDB, products, suppliers, DEFAULT_BUSINESS_ID, actualizarCatalogo */
const { test, expect } = require('@playwright/test');
const { openCash } = require('./cash-fixture.cjs');

async function fixture(page) {
  await page.goto('/');
  await page.locator('#loginUsername').fill('andres');
  await page.locator('#loginPassword').fill('Prueba-Local-Propietario-2026!');
  await page.locator('#loginForm button[type=submit]').click();
  await expect(page.locator('#app')).toBeVisible();
  await page.evaluate(async () => {
    const product = { id: 'refund-product', business_id: DEFAULT_BUSINESS_ID, barcode: 'REFUND', name: 'Refund product', cost: 10, retailPrice: 15, wholesalePrice: 12, stock: 5, minStock: 0, active: true };
    const supplier = { id: 'refund-supplier', business_id: DEFAULT_BUSINESS_ID, name: 'Refund supplier', contact: 'Test', phone: '555', debt: 0, active: true };
    await localDB.products.put(product); await localDB.suppliers.put(supplier);
    products.push(product); suppliers.push(supplier); actualizarCatalogo();
  });
  await page.locator('#navCajaBtn').click();
  await page.locator('#cajaEfectivoInicialInput').fill('100');
  await page.locator('#abrirCajaBtn').click();
  await page.locator('#navPurchasesBtn').click();
  await page.locator('#addNewPurchaseBtn').click();
  await page.locator('#purchSupplier').fill('Refund supplier');
  await page.locator('#purchInvoice').fill('REFUND-001');
  await page.locator('#purchType').selectOption('contado');
  await page.locator('#purchProductTemp').fill('Refund product');
  await page.locator('#purchQtyTemp').fill('1');
  await page.locator('#purchCostTemp').fill('10');
  await page.locator('#btnAddItemToPurch').click();
  await page.locator('#purchaseForm button[type=submit]').click();
  await page.locator('#customAlertModal .close-modal-btn').click();
}
async function annul(page) {
  await page.locator('#navPurchasesBtn').click();
  await page.locator('#purchasesTableBody tr').filter({ hasText: 'REFUND-001' }).getByRole('button', { name: 'Anular' }).click();
  await page.locator('#anularRegistroMotivo').fill('Duplicate purchase');
  await page.locator('#anularRegistroForm button[type=submit]').click();
}
async function state(page) {
  return page.evaluate(async () => ({ product: await localDB.products.get('refund-product'), purchases: await localDB.purchases.toArray(), sessions: await localDB.cajaSessions.toArray() }));
}
for (const afterClose of [false, true]) test('anular compra contado devuelve una vez y preserva cierres: ' + afterClose, async ({ page }) => {
  await fixture(page);
  await page.locator('#navCajaBtn').click();
  await expect(page.locator('#cajaResumenEsperado')).toHaveText('C$90.00');
  if (afterClose) {
    await page.locator('#cerrarCajaBtn').click(); await page.locator('#cajaEfectivoRealInput').fill('90');
    await page.locator('#confirmCierreCajaBtn').click(); await page.locator('#customAlertModal .close-modal-btn').click();
    await openCash(page);
  }
  const before = await state(page);
  await annul(page);
  await expect(page.locator('#customAlertMessage')).toContainText('Factura de compra anulada.');
  await page.locator('#customAlertModal .close-modal-btn').click();
  const after = await state(page), purchase = after.purchases[0];
  expect(purchase.anulada).toBe(true); expect(after.product.stock).toBe(5);
  const refunds = after.sessions.flatMap(session => session.movimientos).filter(movement => String(movement.reversalOfPurchaseId) === String(purchase.id));
  expect(refunds).toHaveLength(1); expect(refunds[0].monto).toBe(10);
  if (afterClose) expect(after.sessions.find(session => session.estado === 'cerrada')).toEqual(before.sessions.find(session => session.estado === 'cerrada'));
  await page.evaluate(id => window.eliminarCompra(id), purchase.id);
  expect((await state(page)).sessions).toEqual(after.sessions);
  await page.locator('#navCajaBtn').click();
  await expect(page.locator('#cajaResumenEsperado')).toHaveText(afterClose ? 'C$10.00' : 'C$100.00');
  await page.reload();
  await page.locator('#loginUsername').fill('andres'); await page.locator('#loginPassword').fill('Prueba-Local-Propietario-2026!');
  await page.locator('#loginForm button[type=submit]').click(); await expect(page.locator('#app')).toBeVisible();
  expect((await state(page)).sessions).toEqual(after.sessions);
});

test('fallo de auditoria revierte anulacion de compra, stock y devolucion de Caja', async ({ page }) => {
  await fixture(page); const before = await state(page);
  await page.evaluate(() => {
    const put = localDB.audit_logs.put.bind(localDB.audit_logs);
    localDB.audit_logs.put = row => row.modulo === 'COMPRAS' && row.accion === 'ANULACION' ? Promise.reject(new Error('Injected audit failure')) : put(row);
  });
  await annul(page);
  await expect(page.locator('#customAlertMessage')).toContainText('No se guardaron cambios');
  expect(await state(page)).toEqual(before);
});