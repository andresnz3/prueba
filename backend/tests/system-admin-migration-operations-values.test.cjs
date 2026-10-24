'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePurchaseSupplierIdentities } = require('../src/services/system-admin-migration-operations');

test('purchase supplier identity resolves only from a unique exact name or consistent linked supplier payments', () => {
  const source = {
    suppliers: [
      { id: 'supplier-a', name: 'Coca Cola' },
      { id: 'supplier-b', name: 'coca  cola' }
    ],
    purchases: [
      { id: 'purchase-exact-a', proveedor: 'Coca Cola' },
      { id: 'purchase-exact-b', proveedor: 'coca  cola' },
      { id: 'purchase-payment-evidence', proveedor: 'COCA COLA' },
      { id: 'purchase-conflicting-evidence', proveedor: 'COCA COLA' }
    ],
    abonos: [
      { id: 'payment-1', tipo: 'proveedor', referenciaId: 'supplier-a', facturaId: 'purchase-payment-evidence' },
      { id: 'payment-2', tipo: 'proveedor', referenciaId: 'supplier-a', facturaId: 'purchase-conflicting-evidence' },
      { id: 'payment-3', tipo: 'proveedor', referenciaId: 'supplier-b', facturaId: 'purchase-conflicting-evidence' }
    ]
  };
  const result = resolvePurchaseSupplierIdentities(source);
  assert.equal(result.purchases[0].supplierId, 'supplier-a');
  assert.equal(result.purchases[1].supplierId, 'supplier-b');
  assert.equal(result.purchases[2].supplierId, 'supplier-a');
  assert.equal(result.purchases[3].supplierId, undefined);
  assert.deepEqual(result.resolutions.map(row => row.purchaseId), ['purchase-exact-a', 'purchase-exact-b', 'purchase-payment-evidence']);
  assert.deepEqual(source.purchases.map(row => row.supplierId), [undefined, undefined, undefined, undefined]);
});
