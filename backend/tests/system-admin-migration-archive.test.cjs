'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildArchivePlan, canonical, scrub } = require('../src/services/system-admin-migration-archive');

function packageValue() {
  const value = {
    type: 'pos_local_migration_package', version: 2, exportedAt: '2026-10-21T10:00:00.000Z',
    source: { scope: { idSource: 'config', idsFound: 1, legacyRecords: 0, excludedRecords: 0, missingStores: [] } },
    business: { name: 'Tienda Uno', localBusinessId: 'local-01' },
    data: {
      products: [{ id: 'p1', name: 'Arroz', image: null, usuario: 'Ana', password: 'never-copy' }],
      clients: [{ id: 'c1', name: 'Cliente' }], suppliers: [{ id: 's1', name: 'Proveedor' }],
      sales: [{ id: 'v1', items: [{ productId: 'p1' }] }], purchases: [{ id: 'b1', items: [{ productId: 'p1' }] }],
      cashSessions: [{ id: 'cash1', movimientos: [{ id: 'm1' }] }], inventoryMovements: [{ id: 'i1', producto_id: 'p1' }],
      abonos: [{ id: 'a1', facturaId: 'v1' }], expenses: [{ id: 'g1', usuario: 'Ana' }], auditLogs: [{ id: 'l1', usuario: 'Ana' }],
      saleOrders: [{ id: 'o1', status: 'PENDING' }], syncQueue: [{ id: 'q1', data: '{"password":"bad","sale":{"id":"v2"}}' }],
      configuration: { name: 'Tienda Uno', logo: null }, categories: ['Granos']
    }
  };
  for (const key of ['products', 'clients', 'suppliers', 'sales', 'purchases', 'cashSessions', 'inventoryMovements', 'abonos', 'expenses', 'auditLogs', 'saleOrders', 'syncQueue']) {
    value.data[key] = value.data[key].map(row => ({ ...row, business_id: 'local-01' }));
  }
  return value;
}

test('archive manifest retains each v2 store and redacts credentials without losing actor labels', () => {
  const plan = buildArchivePlan(packageValue());
  assert.equal(plan.records.length, 14);
  assert.equal(plan.manifest.recordsExpected, 14);
  assert.equal(plan.records.find(row => row.entity === 'products').payload.usuario, 'Ana');
  assert.equal(Object.hasOwn(plan.records.find(row => row.entity === 'products').payload, 'password'), false);
  const queue = plan.records.find(row => row.entity === 'syncQueue');
  assert.equal(queue.status, 'PENDING');
  assert.equal(queue.payload.data.includes('bad'), false);
  assert.match(queue.payload.data, /"sale"/);
  assert.match(plan.manifest.blockers.join(' '), /pendientes/i);
});

test('archive marks duplicate or missing local identifiers pending and hashes records deterministically', () => {
  const value = packageValue();
  value.data.clients.push({ id: 'c1', name: 'Duplicado' });
  value.data.suppliers[0] = { name: 'Sin ID' };
  const first = buildArchivePlan(value);
  const second = buildArchivePlan(value);
  assert.equal(first.packageSha256, second.packageSha256);
  assert.equal(first.records.find(row => row.entity === 'clients' && row.key.includes('duplicate')).status, 'PENDING');
  assert.equal(first.records.find(row => row.entity === 'suppliers').status, 'PENDING');
  assert.notEqual(first.records.find(row => row.entity === 'suppliers').key, first.records.find(row => row.entity === 'clients').key);
});

test('archive flags missing source identity and omitted stores without trusting package counts', () => {
  const value = packageValue();
  delete value.business.localBusinessId;
  value.source.scope.legacyRecords = 2;
  value.source.scope.missingStores = ['gastos'];
  const plan = buildArchivePlan(value);
  assert.ok(plan.manifest.blockers.some(item => /identidad persistente del origen/.test(item)));
  assert.ok(plan.manifest.blockers.some(item => /tiendas locales/.test(item)));
  assert.ok(plan.manifest.securityBlockers.length > 0);
});

test('archive quarantines legacy rows, rejects mixed identities, and blocks false scope claims', () => {
  const legacy = packageValue();
  legacy.source.scope.legacyRecords = 0;
  legacy.data.products[0].business_id = '00000000-0000-0000-0000-000000000000';
  const legacyPlan = buildArchivePlan(legacy);
  assert.equal(legacyPlan.manifest.securityBlockers.length, 0);
  assert.equal(legacyPlan.manifest.identityReview.counts.legacy, 1);
  assert.equal(legacyPlan.records.find(row => row.entity === 'products').status, 'PENDING');
  assert.equal(legacyPlan.legacyIdentityConfirmationRequired, true);
  assert.equal(legacyPlan.bulkIdentityEligibleRecords, 1);
  assert.equal(legacyPlan.manifest.identityReview.records[0].identity, 'LEGACY');
  assert.equal(legacyPlan.manifest.identityReview.records[0].identityReason, 'SHARED_ID');
  assert.equal(legacyPlan.manifest.identityReview.records[0].bulkIdentityEligible, true);

  const ambiguous = packageValue();
  ambiguous.source.scope.idSource = 'ambiguous'; ambiguous.source.scope.idsFound = 2;
  assert.ok(buildArchivePlan(ambiguous).manifest.blockers.length > 0);
  const mismatchedScope = packageValue();
  mismatchedScope.source.scope.localBusinessId = 'another-local-id';
  assert.ok(buildArchivePlan(mismatchedScope).manifest.securityBlockers.length > 0);

  const foreignRow = packageValue();
  foreignRow.data.products[0].business_id = 'another-business';
  assert.ok(buildArchivePlan(foreignRow).manifest.securityBlockers.length > 0);
  const isolated = packageValue();
  isolated.source.scope.excludedRecords = 1;
  assert.ok(buildArchivePlan(isolated).manifest.securityBlockers.length > 0);
});

test('package authorization cannot clear duplicate IDs or ambiguous and broken relationships', () => {
  const duplicate = packageValue();
  duplicate.data.products[0].business_id = '00000000-0000-0000-0000-000000000000';
  duplicate.data.products.push({ ...duplicate.data.products[0], name: 'Duplicado' });
  const duplicatePlan = buildArchivePlan(duplicate);
  const productRows = duplicatePlan.records.filter(row => row.entity === 'products');
  assert.equal(productRows.length, 2);
  assert.ok(productRows.every(row => row.status === 'PENDING' && !row.bulkIdentityEligible));
  assert.ok(duplicatePlan.manifest.identityReview.counts.duplicates >= 2);
  assert.ok(duplicatePlan.records.find(row => row.entity === 'sales').reason.includes('INCONSISTENT_REFERENCES'));

  const broken = packageValue();
  broken.data.products[0].business_id = '00000000-0000-0000-0000-000000000000';
  broken.data.sales[0].items = [{ productId: 'missing-product' }];
  const brokenPlan = buildArchivePlan(broken);
  assert.equal(brokenPlan.records.find(row => row.entity === 'products').bulkIdentityEligible, true);
  assert.equal(brokenPlan.records.find(row => row.entity === 'sales').status, 'PENDING');
  assert.equal(brokenPlan.records.find(row => row.entity === 'sales').reason.includes('INCONSISTENT_REFERENCES'), true);
});

test('archive distinguishes missing business IDs and checks historic embedded product IDs without rewriting rows', () => {
  const value = packageValue();
  delete value.data.clients[0].business_id;
  value.data.sales[0].items = [{ id: 'p1', quantity: '1.000' }];
  const plan = buildArchivePlan(value);
  assert.equal(plan.manifest.identityReview.counts.legacy, 1);
  assert.equal(plan.manifest.identityReview.counts.missingId, 1);
  assert.equal(plan.manifest.identityReview.counts.sharedId, 0);
  assert.equal(plan.records.find(row => row.entity === 'clients').status, 'PENDING');
  assert.equal(plan.records.find(row => row.entity === 'clients').payload.business_id, undefined);
  assert.equal(plan.manifest.identityReview.counts.inconsistentReferences, 0);

  value.data.sales[0].items = [{ id: 'missing-product' }];
  const brokenReference = buildArchivePlan(value);
  assert.equal(brokenReference.manifest.identityReview.counts.inconsistentReferences, 1);
  assert.ok(brokenReference.manifest.blockers.some(message => /relaciones entre registros/.test(message)));
});

test('inferred local identity remains usable when the exporter records it in source scope', () => {
  const value = packageValue();
  delete value.business.localBusinessId;
  value.source.scope.idSource = 'inferred';
  value.source.scope.localBusinessId = 'local-01';
  const plan = buildArchivePlan(value);
  assert.equal(plan.sourceBusinessId, 'local-01');
  assert.equal(plan.manifest.securityBlockers.length, 0);
});

test('archive accepts old package only as an explicitly incomplete snapshot', () => {
  const value = packageValue();
  value.version = 1;
  delete value.business.localBusinessId;
  value.business.id = 'not-a-local-identity';
  for (const key of ['expenses', 'auditLogs', 'saleOrders', 'syncQueue']) delete value.data[key];
  const plan = buildArchivePlan(value);
  assert.equal(plan.sourceBusinessId, null);
  assert.ok(plan.manifest.blockers.some(item => /versión 1/.test(item)));
  assert.ok(plan.manifest.missingStores.includes('expenses'));
});

test('canonical JSON is key-order stable and recursive scrub strips serialized local credentials', () => {
  assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
  const clean = scrub({ usuario: 'Carlos', data: '{"token":"x","venta":{"total":3}}' });
  assert.equal(clean.usuario, 'Carlos');
  assert.equal(clean.data.includes('token'), false);
  assert.throws(() => buildArchivePlan({ type: 'wrong', version: 2, data: {}, business: { name: 'X' } }), { publicCode: 'MIGRATION_PACKAGE_INVALID' });
});

test('scrub preserves fractional numeric local IDs and references as exact text for MySQL JSON', () => {
  const value = packageValue();
  value.data.products[0].id = 1791563606129.8687;
  value.data.sales[0].id = 1791566528809.0999;
  value.data.sales[0].items = [{ productId: 1791563606129.8687, quantity: '1.000' }];
  value.data.cashSessions[0].movimientos = [{ saleId: 1791566528809.0999, amount: 1 }];

  const plan = buildArchivePlan(value);
  const product = plan.records.find(row => row.entity === 'products').payload;
  const sale = plan.records.find(row => row.entity === 'sales').payload;
  const cash = plan.records.find(row => row.entity === 'cashSessions').payload;

  assert.equal(product.id, '1791563606129.8687');
  assert.equal(sale.id, '1791566528809.0999');
  assert.equal(sale.items[0].productId, '1791563606129.8687');
  assert.equal(cash.movimientos[0].saleId, '1791566528809.0999');
  assert.equal(plan.records.find(row => row.entity === 'sales').key, 'id:1791566528809.0999');
});

test('package preview leaves source authorization to the explicit checkbox', () => {
  const plan = buildArchivePlan(packageValue());
  assert.equal(plan.manifest.securityBlockers.length, 0);
  assert.equal(plan.manifest.identityReview.counts.sharedId, 0);
});
