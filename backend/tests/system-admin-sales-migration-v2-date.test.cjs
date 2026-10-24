'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { packageForSalesImport, normalizeSale } = require('../src/services/system-admin-sales-migration-values');

test('prefers canonical vencimientoTS over a localized v2 due-date label', () => {
  const value = {
    type: 'pos_local_migration_package',
    version: 2,
    business: { name: 'Local ficticio' },
    data: {
      products: [{ id: 'product-1', name: 'Producto', barcode: 'P-1', cost: '2.50' }],
      clients: [],
      suppliers: [],
      sales: [{
        id: 'sale-1', fechaTS: Date.parse('2025-04-10T15:30:00.000Z'),
        fecha: 'fecha local no interpretable', numero: 'F-100', tipo: 'crédito', metodo: 'crédito',
        vencimientoTS: Date.parse('2025-05-10T15:30:00.000Z'), vencimiento: '30 días',
        subtotal: '30.00', descuentoMonto: '0.00', impuesto: '0.00', total: '30.00',
        items: [{ productId: 'product-1', nombreProducto: 'Producto', cantidad: '2.000', precioUnitario: '15.00', subtotal: '30.00', total: '30.00' }]
      }]
    }
  };
  const imported = packageForSalesImport(value);
  const sale = normalizeSale(value.data.sales[0], 0, imported);

  assert.equal(sale.error, undefined);
  assert.equal(sale.saleType, 'CREDIT');
  assert.equal(sale.dueAt, '2025-05-10 15:30:00.000');
});
