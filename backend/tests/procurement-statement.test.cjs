'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProcurementService } = require('../src/services/procurement');

test('estado de cuenta calcula saldos por factura y reserva pagos pendientes', async () => {
  const supplier = {
    id: '10', business_id: '7', name: 'Proveedor', contact: '', phone: '', ruc: '', address: '', active: 1,
    total_purchased: '10.00', purchase_count: 5, debt: '5.00', pending_payments: '3.00', next_due_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'), updated_at: new Date('2026-01-01T00:00:00Z')
  };
  const purchases = [
    { id: '101', created_at: new Date('2026-01-01T00:00:00Z'), total: '1.00', paid: '1.00', pending: '0.00', purchase_type: 'CREDIT', status: 'COMPLETED' },
    { id: '102', created_at: new Date('2026-01-02T00:00:00Z'), total: '3.00', paid: '0.50', pending: '2.50', purchase_type: 'CREDIT', status: 'COMPLETED' },
    { id: '103', created_at: new Date('2026-01-03T00:00:00Z'), total: '4.00', paid: '1.00', pending: '0.50', purchase_type: 'CREDIT', status: 'COMPLETED' },
    { id: '104', created_at: new Date('2026-01-04T00:00:00Z'), total: '2.00', paid: '0.00', pending: '0.00', purchase_type: 'CASH', status: 'COMPLETED' },
    { id: '105', created_at: new Date('2026-01-05T00:00:00Z'), total: '2.00', paid: '0.00', pending: '0.00', purchase_type: 'CREDIT', status: 'CANCELLED' }
  ];
  const repo = {
    tenant: async (_session, action) => action('tenant-db', { business_id: '7', user_id: '8', session_id: '9' }),
    rows: async (_db, sql) => {
      if (sql.includes('FROM sessions')) return [{ id: '9' }];
      if (sql.includes('FROM suppliers s WHERE')) return [supplier];
      if (sql.includes('FROM purchases p LEFT JOIN suppliers s')) return purchases;
      if (sql.includes('FROM supplier_payments sp LEFT JOIN purchases p')) return [];
      throw new Error('Consulta inesperada: ' + sql);
    }
  };
  const service = createProcurementService({ repo, auth: { canAccess: async () => true }, config: { absoluteSeconds: 3600 } });
  const result = await service.statement({ business_id: '7', session_id: '9' }, '10', { limit: 100, offset: 0 });
  const entries = new Map(result.entries.filter(row => row.kind === 'PURCHASE').map(row => [row.purchaseId, row]));

  assert.deepEqual({ total: entries.get('101').total, paidConfirmed: entries.get('101').paidConfirmed, balance: entries.get('101').balance, availableBalance: entries.get('101').availableBalance, canPay: entries.get('101').canPay }, {
    total: '1.00', paidConfirmed: '1.00', balance: '0.00', availableBalance: '0.00', canPay: false
  });
  assert.deepEqual({ paidConfirmed: entries.get('102').paidConfirmed, pendingPayments: entries.get('102').pendingPayments, balance: entries.get('102').balance, availableBalance: entries.get('102').availableBalance, canPay: entries.get('102').canPay }, {
    paidConfirmed: '0.50', pendingPayments: '2.50', balance: '2.50', availableBalance: '0.00', canPay: false
  });
  assert.deepEqual({ paidConfirmed: entries.get('103').paidConfirmed, pendingPayments: entries.get('103').pendingPayments, balance: entries.get('103').balance, availableBalance: entries.get('103').availableBalance, canPay: entries.get('103').canPay }, {
    paidConfirmed: '1.00', pendingPayments: '0.50', balance: '3.00', availableBalance: '2.50', canPay: true
  });
  assert.equal(entries.get('104').canPay, false);
  assert.equal(entries.get('105').canPay, false);
});
