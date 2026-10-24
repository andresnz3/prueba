'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  packageForPurchasesImport, normalizePurchase, sourcePurchaseKey, fingerprintPurchase,
  formatMoney, formatQuantity
} = require('../src/services/system-admin-purchases-migration-values');

function packageValue(purchases) {
  return {
    type: 'pos_local_migration_package',
    version: 1,
    exportedAt: '2026-10-14T12:00:00.000Z',
    business: { id: 'local-business-7', name: 'Bodega Local' },
    data: {
      products: [{ id: 104, barcode: '00123', name: 'Arroz' }],
      clients: [],
      suppliers: [{ id: 9, name: 'Distribuidora Norte' }],
      purchases
    }
  };
}

const localPurchase = overrides => ({
  id: 501,
  fechaTS: 1750000000000,
  factura: 'FC-501',
  tipo: 'contado',
  proveedorId: 9,
  proveedor: 'Distribuidora Norte',
  total: 8.5,
  anulada: false,
  items: [{ productId: 104, producto: 'Arroz', cantidad: 2, costo: 4.25, total: 8.5 }],
  ...overrides
});

test('normaliza los campos reales del POS local sin sustituir costos ni relaciones locales', () => {
  const imported = packageForPurchasesImport(packageValue([localPurchase()]));
  const purchase = normalizePurchase(imported.purchases[0], 0, imported);
  assert.equal(purchase.localPurchaseId, '501');
  assert.equal(purchase.invoice, 'FC-501');
  assert.equal(purchase.purchaseType, 'CASH');
  assert.equal(purchase.status, 'COMPLETED');
  assert.equal(purchase.supplierName, 'Distribuidora Norte');
  assert.equal(purchase.items[0].sourceProductId, '104');
  assert.equal(purchase.items[0].name, 'Arroz');
  assert.equal(formatQuantity(purchase.items[0].quantity), '2.000');
  assert.equal(formatMoney(purchase.items[0].unitCost), '4.25');
  assert.equal(formatMoney(purchase.total), '8.50');
  assert.equal(purchase.createdAt, '2025-06-15 15:06:40.000');
});

test('conserva descuentos, impuestos, notas, vencimiento y estado cancelado coherentes', () => {
  const raw = localPurchase({
    tipo: 'crédito',
    fechaTS: '2025-06-15T15:06:40.000Z',
    vencimiento: '2025-07-15',
    anulada: true,
    subtotal: '20.00',
    descuentoMonto: '2.00',
    tax: '1.00',
    total: '19.00',
    observaciones: 'Compra histórica',
    items: [{ productId: 104, producto: 'Arroz', cantidad: '2.000', costo: '10.00', subtotal: '20.00', total: '19.00' }]
  });
  const imported = packageForPurchasesImport(packageValue([raw]));
  const purchase = normalizePurchase(imported.purchases[0], 0, imported);
  assert.equal(purchase.purchaseType, 'CREDIT');
  assert.equal(purchase.status, 'CANCELLED');
  assert.equal(purchase.dueAt, '2025-07-15 00:00:00.000');
  assert.equal(purchase.notes, 'Compra histórica');
  assert.equal(formatMoney(purchase.discount), '2.00');
  assert.equal(formatMoney(purchase.tax), '1.00');
  assert.equal(formatMoney(purchase.items[0].discount), '2.00');
  assert.equal(formatMoney(purchase.items[0].tax), '1.00');
  assert.equal(formatMoney(purchase.total), '19.00');
});

test('interpreta vencimientos D/M/A del POS local y valida su coherencia con fechaTS', () => {
  const rows = [
    localPurchase({ id: 601, tipo: 'credito', fechaTS: '2026-10-30T12:00:00.000Z', vencimientoTS: '', vencimiento: '6/11/2026' }),
    localPurchase({ id: 602, tipo: 'credito', fechaTS: '2026-10-30T12:00:00.000Z', vencimientoTS: '', vencimiento: '8/11/2026' }),
    localPurchase({ id: 603, tipo: 'credito', fechaTS: '2026-11-10T12:00:00.000Z', vencimientoTS: '', vencimiento: '8/11/2026' })
  ];
  const imported = packageForPurchasesImport(packageValue(rows));
  assert.equal(normalizePurchase(imported.purchases[0], 0, imported).dueAt, '2026-11-06 00:00:00.000');
  assert.equal(normalizePurchase(imported.purchases[1], 1, imported).dueAt, '2026-11-08 00:00:00.000');
  assert.match(normalizePurchase(imported.purchases[2], 2, imported).error, /anterior a fechaTS/);
});

test('detecta diferencias históricas de subtotal y total en vez de corregirlas', () => {
  const source = packageValue([localPurchase({ total: 9 })]);
  const imported = packageForPurchasesImport(source);
  assert.match(normalizePurchase(imported.purchases[0], 0, imported).error, /total histórico C\$9\.00 no coincide/);

  const badSubtotal = packageForPurchasesImport(packageValue([localPurchase({ subtotal: '9.00' })]));
  assert.match(normalizePurchase(badSubtotal.purchases[0], 0, badSubtotal).error, /subtotal histórico C\$9\.00 no coincide/);
});

test('asigna impuestos generales por encima del subtotal sin limitar el importe histórico', () => {
  const raw = localPurchase({ subtotal: '1.00', tax: '2.00', total: '3.00', items: [{ productId: 104, producto: 'Arroz', cantidad: 1, costo: '1.00' }] });
  const imported = packageForPurchasesImport(packageValue([raw]));
  const purchase = normalizePurchase(imported.purchases[0], 0, imported);
  assert.equal(formatMoney(purchase.items[0].tax), '2.00');
  assert.equal(formatMoney(purchase.total), '3.00');
});

test('acepta numero como referencia histórica de factura', () => {
  const imported = packageForPurchasesImport(packageValue([localPurchase({ factura: undefined, numero: 'FAC-LOCAL-7' })]));
  assert.equal(normalizePurchase(imported.purchases[0], 0, imported).invoice, 'FAC-LOCAL-7');
});

test('omite datos fundamentales faltantes, estados no representables y fechas ambiguas', () => {
  const rows = [
    localPurchase({ items: [{ productId: 104, cantidad: 1, producto: 'Arroz', total: 4.25 }] }),
    localPurchase({ estado: 'pendiente' }),
    localPurchase({ tipo: 'otro' }),
    localPurchase({ tipo: 'credito', vencimiento: '01/02/2025' })
  ];
  const imported = packageForPurchasesImport(packageValue(rows));
  const errors = imported.purchases.map((raw, index) => normalizePurchase(raw, index, imported).error);
  assert.match(errors[0], /sin costo histórico/);
  assert.match(errors[1], /estado original no compatible/);
  assert.match(errors[2], /tipo de compra no reconocido/);
  assert.match(errors[3], /anterior a fechaTS/);

  const shortYear = packageForPurchasesImport(packageValue([localPurchase({ tipo: 'credito', vencimiento: '01/02/25' })]));
  assert.match(normalizePurchase(shortYear.purchases[0], 0, shortYear).error, /fecha de vencimiento ambigua/);
});

test('los identificadores decimales se conservan y la huella distingue facturas legítimas del mismo monto', () => {
  const imported = packageForPurchasesImport(packageValue([
    localPurchase({ id: 123.75, factura: 'FC-A' }),
    localPurchase({ id: 123.76, factura: 'FC-B' })
  ]));
  const first = normalizePurchase(imported.purchases[0], 0, imported);
  const second = normalizePurchase(imported.purchases[1], 1, imported);
  assert.equal(first.localPurchaseId, '123.75');
  assert.equal(second.localPurchaseId, '123.76');
  assert.notEqual(sourcePurchaseKey(first, fingerprintPurchase(first, '1')), sourcePurchaseKey(second, fingerprintPurchase(second, '1')));
});

test('rechaza paquetes incompletos y excesivos', () => {
  assert.throws(() => packageForPurchasesImport({ type: 'wrong' }), { publicCode: 'MIGRATION_PACKAGE_INVALID' });
  assert.throws(() => packageForPurchasesImport(packageValue(Array(50001).fill(localPurchase()))), { publicCode: 'MIGRATION_PACKAGE_INVALID' });
});
