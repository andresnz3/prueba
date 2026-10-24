'use strict';
const { createHash } = require('node:crypto');
const { httpError } = require('../middleware/errors');
const { fixed, units } = require('./inventory-values');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const modules = Object.freeze({ PURCHASE: 'purchases', CANCEL_PURCHASE: 'purchases', EXPENSE: 'expenses', CANCEL_EXPENSE: 'expenses', SUPPLIER_PAYMENT: 'payables', CUSTOMER_PAYMENT_VOID: 'clients', SUPPLIER_PAYMENT_VOID: 'payables', CASH_MANUAL: 'cash' });
function createFinancialService({ repo, auth, config }) {
  async function permitted(db, current, module) {
    const [valid] = await repo.rows(db, 'SELECT id FROM sessions WHERE business_id=? AND id=? AND revoked_at IS NULL AND expires_at>UTC_TIMESTAMP(3) AND created_at>TIMESTAMPADD(SECOND,-?,UTC_TIMESTAMP(3))', [current.business_id, current.session_id, config.absoluteSeconds]);
    if (!valid) throw httpError(401, 'INVALID_SESSION');
    if (!await auth.canAccess(current, module, db)) throw httpError(403, 'MODULE_FORBIDDEN');
  }
  const work = (session, module, action) => repo.tenant(session, async (db, current) => {
    await permitted(db, current, module);
    const result = await action(db, current);
    await permitted(db, current, module);
    return result;
  });
  async function once(db, current, kind, data, action) {
    const hash = digest(data);
    const [existing] = await repo.rows(db, 'SELECT * FROM pos_operations WHERE business_id=? AND operation_key=? FOR UPDATE', [current.business_id, data.operationKey]);
    if (existing) {
      if (String(existing.user_id) !== String(current.user_id) || existing.kind !== kind || existing.request_hash !== hash) throw httpError(409, 'OPERATION_CONFLICT');
      return typeof existing.result === 'string' ? JSON.parse(existing.result) : existing.result;
    }
    const result = await action();
    await repo.rows(db, 'INSERT INTO pos_operations (business_id,operation_key,user_id,kind,request_hash,result) VALUES (?,?,?,?,?,?)', [current.business_id, data.operationKey, current.user_id, kind, hash, JSON.stringify(result)]);
    return result;
  }
  async function openCash(db, current) {
    const list = await repo.rows(db, "SELECT * FROM cash_sessions WHERE business_id=? AND status='OPEN' ORDER BY id FOR UPDATE", [current.business_id]);
    if (list.length > 1) throw httpError(409, 'CASH_AMBIGUOUS');
    if (!list.length) throw httpError(409, 'CASH_CLOSED');
    return list[0];
  }
  async function cashBalance(db, current, cash) {
    const movements = await repo.rows(db, 'SELECT m.direction,m.amount,m.status,COALESCE(s.payment_method,cp.payment_method,sp.payment_method) AS method FROM cash_movements m LEFT JOIN sales s ON s.business_id=m.business_id AND s.id=m.sale_id LEFT JOIN customer_payments cp ON cp.business_id=m.business_id AND cp.id=m.customer_payment_id LEFT JOIN supplier_payments sp ON sp.business_id=m.business_id AND sp.id=m.supplier_payment_id WHERE m.business_id=? AND m.cash_session_id=? FOR UPDATE', [current.business_id, String(cash.id)]);
    return units(cash.opening_amount) + movements.filter(m => m.status === 'CONFIRMED' && (!m.method || m.method === 'CASH')).reduce((sum, m) => sum + units(m.amount) * (m.direction === 'IN' ? 1n : -1n), 0n);
  }
  const reversePayment = (session, type, id, data) => {
    // SQL identifiers come exclusively from this fixed selector, never from request fields.
    const customer = type === 'customer', table = customer ? 'customer_payments' : 'supplier_payments';
    const kind = customer ? 'CUSTOMER_PAYMENT_VOID' : 'SUPPLIER_PAYMENT_VOID', module = modules[kind];
    return work(session, module, (db, current) => once(db, current, kind, { paymentId: id, ...data }, async () => {
      const [payment] = await repo.rows(db, 'SELECT * FROM ' + table + ' WHERE business_id=? AND id=? FOR UPDATE', [current.business_id, id]);
      if (!payment) throw httpError(404, 'PAYMENT_NOT_FOUND');
      if (payment.status === 'VOID') throw httpError(409, 'PAYMENT_ALREADY_VOID');
      const parentTable = customer ? 'sales' : 'purchases', parentId = customer ? payment.sale_id : payment.purchase_id;
      const [parent] = parentId ? await repo.rows(db, 'SELECT * FROM ' + parentTable + ' WHERE business_id=? AND id=? FOR UPDATE', [current.business_id, String(parentId)]) : [];
      if (!parent || parent.status !== 'COMPLETED' || (customer ? parent.sale_type : parent.purchase_type) !== 'CREDIT' || Number(parent.is_historical) === 1 || Number(payment.is_historical) === 1) throw httpError(409, 'PAYMENT_NOT_REVERSIBLE');
      const paymentLink = customer ? 'customer_payment_id' : 'supplier_payment_id';
      const originalType = customer ? 'CUSTOMER_PAYMENT' : 'SUPPLIER_PAYMENT';
      const originalDirection = customer ? 'IN' : 'OUT';
      const [movement] = await repo.rows(db, 'SELECT * FROM cash_movements WHERE business_id=? AND ' + paymentLink + '=? AND type=? FOR UPDATE', [current.business_id, id, originalType]);
      let refundCash = null;
      if (payment.status === 'PENDING') {
        if (!movement || movement.status !== 'PENDING') throw httpError(409, 'CASH_INCONSISTENT');
        await repo.rows(db, "UPDATE cash_movements SET status='VOID' WHERE business_id=? AND id=?", [current.business_id, String(movement.id)]);
      } else if (payment.payment_method === 'CASH') {
        await permitted(db, current, 'cash');
        refundCash = await openCash(db, current);
        if (!movement || movement.status !== 'CONFIRMED' || movement.direction !== originalDirection || movement.amount !== payment.amount || String(movement.cash_session_id) !== String(payment.cash_session_id)) throw httpError(409, 'CASH_INCONSISTENT');
        const [reversed] = await repo.rows(db, 'SELECT id FROM cash_movements WHERE business_id=? AND reversal_of_movement_id=? LIMIT 1 FOR UPDATE', [current.business_id, String(movement.id)]);
        if (reversed) throw httpError(409, 'CASH_INCONSISTENT');
        if (customer && await cashBalance(db, current, refundCash) < units(payment.amount)) throw httpError(409, 'CASH_REFUND_INSUFFICIENT');
        await repo.rows(db, "INSERT INTO cash_movements (business_id,cash_session_id,user_id,type,direction,amount,reference_type,reference_id,reversal_of_movement_id,description,status) VALUES (?,?,?,'REVERSAL',?,?,?,?,?,?,'CONFIRMED')", [current.business_id, String(refundCash.id), current.user_id, customer ? 'OUT' : 'IN', payment.amount, table, id, String(movement.id), ('Reversión ' + table + ' #' + id + '; caja original #' + payment.cash_session_id + '; ' + data.reason).slice(0, 500)]);
      } else if (!data.externalRefundConfirmed) {
        throw httpError(409, 'EXTERNAL_REFUND_REQUIRED');
      }
      await repo.rows(db, "UPDATE " + table + " SET status='VOID',cancelled_at=UTC_TIMESTAMP(3),cancelled_by=?,cancel_reason=? WHERE business_id=? AND id=?", [current.user_id, data.reason, current.business_id, id]);
      const details = { amount: payment.amount, paymentMethod: payment.payment_method, previousStatus: payment.status, reason: data.reason, parentId: String(parentId), originalCashSessionId: payment.cash_session_id === null ? null : String(payment.cash_session_id), refundCashSessionId: refundCash ? String(refundCash.id) : null, externalRefundConfirmed: data.externalRefundConfirmed, operationKey: data.operationKey };
      await repo.audit(db, current, kind, table, id, details);
      if (refundCash) await permitted(db, current, 'cash');
      return { kind, payment: { id, businessId: String(current.business_id), amount: payment.amount, paymentMethod: payment.payment_method, status: 'VOID', cancelReason: data.reason, cancelledBy: String(current.user_id), ...details } };
    }));
  };
  const manualCash = (session, data) => work(session, 'cash', (db, current) => once(db, current, 'CASH_MANUAL', data, async () => {
    const cash = await openCash(db, current), balance = await cashBalance(db, current, cash);
    const expected = balance + units(data.amount) * (data.direction === 'IN' ? 1n : -1n);
    if (expected < 0n) throw httpError(409, 'CASH_BALANCE_INSUFFICIENT');
    if (expected >= 1000000000000n) throw httpError(409, 'CASH_BALANCE_LIMIT');
    const type = data.direction === 'IN' ? 'MANUAL_ENTRY' : 'MANUAL_EXIT';
    const inserted = await repo.rows(db, "INSERT INTO cash_movements (business_id,cash_session_id,user_id,type,direction,amount,description,status,confirmed_at,confirmed_by_user_id) VALUES (?,?,?,?,?,?,?,'CONFIRMED',UTC_TIMESTAMP(3),?)", [current.business_id, String(cash.id), current.user_id, type, data.direction, data.amount, data.reason, current.user_id]);
    const id = String(inserted.insertId);
    await repo.audit(db, current, type, 'cash_movements', id, { cashSessionId: String(cash.id), direction: data.direction, amount: data.amount, reason: data.reason, expectedAmount: fixed(expected, 2), operationKey: data.operationKey });
    const [actor] = await repo.rows(db, 'SELECT full_name FROM users WHERE business_id=? AND id=?', [current.business_id, current.user_id]);
    return { kind: 'CASH_MANUAL', movement: { id, businessId: String(current.business_id), cashSessionId: String(cash.id), type, direction: data.direction, amount: data.amount, description: data.reason, userName: actor.full_name, status: 'CONFIRMED', paymentMethod: 'CASH' }, expectedAmount: fixed(expected, 2) };
  }));
  const resolve = (session, key, kind) => {
    const module = typeof kind === 'string' && Object.hasOwn(modules, kind) ? modules[kind] : null;
    if (!module) throw httpError(400, 'INVALID_INPUT');
    return work(session, module, async (db, current) => {
      const [row] = await repo.rows(db, 'SELECT user_id,kind,result FROM pos_operations WHERE business_id=? AND operation_key=? FOR UPDATE', [current.business_id, key]);
      if (row) {
        const result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
        if (String(row.user_id) !== String(current.user_id) || (row.kind === 'ABANDONED' ? result.operationKind !== kind : row.kind !== kind)) throw httpError(404, 'OPERATION_NOT_FOUND');
        return result;
      }
      // Same business lock as all financial writers: a late request cannot commit after discard.
      const result = { kind: 'ABANDONED', operationKind: kind, businessId: String(current.business_id) };
      await repo.rows(db, 'INSERT INTO pos_operations (business_id,operation_key,user_id,kind,request_hash,result) VALUES (?,?,?,?,?,?)', [current.business_id, key, current.user_id, 'ABANDONED', createHash('sha256').update(JSON.stringify({ key, kind })).digest('hex'), JSON.stringify(result)]);
      await repo.audit(db, current, 'RESOLVE_FINANCIAL_OPERATION', 'businesses', current.business_id, { operationKey: key, kind });
      return result;
    });
  };
  return { resolve, reversePayment, manualCash };
}
module.exports = { createFinancialService, modules };
