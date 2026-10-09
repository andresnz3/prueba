'use strict';
const { createHash } = require('node:crypto');
const { httpError } = require('../middleware/errors');
const { fixed, units } = require('./inventory-values');

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const money = value => fixed(units(String(value || '0.00')), 2);

function createExpenseService({ repo, auth, config }) {
  async function permitted(db, current) {
    const [valid] = await repo.rows(db, 'SELECT id FROM sessions WHERE business_id = ? AND id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(3) AND created_at > TIMESTAMPADD(SECOND, -?, UTC_TIMESTAMP(3))', [current.business_id, current.session_id, config.absoluteSeconds]);
    if (!valid) throw httpError(401, 'INVALID_SESSION');
    if (!await auth.canAccess(current, 'expenses', db)) throw httpError(403, 'MODULE_FORBIDDEN');
  }

  async function work(session, action) {
    return repo.tenant(session, async (db, current) => {
      await permitted(db, current);
      const result = await action(db, current);
      await permitted(db, current);
      return result;
    });
  }

  async function once(db, current, kind, data, action) {
    const hash = digest(data);
    const [existing] = await repo.rows(db, 'SELECT * FROM pos_operations WHERE business_id = ? AND operation_key = ? FOR UPDATE', [current.business_id, data.operationKey]);
    if (existing) {
      if (String(existing.user_id) !== String(current.user_id) || existing.kind !== kind || existing.request_hash !== hash) throw httpError(409, 'OPERATION_CONFLICT');
      return typeof existing.result === 'string' ? JSON.parse(existing.result) : existing.result;
    }
    const result = await action();
    await repo.rows(db, 'INSERT INTO pos_operations (business_id, operation_key, user_id, kind, request_hash, result) VALUES (?, ?, ?, ?, ?, ?)', [current.business_id, data.operationKey, current.user_id, kind, hash, JSON.stringify(result)]);
    return result;
  }

  async function openCash(db, current) {
    const rows = await repo.rows(db, "SELECT * FROM cash_sessions WHERE business_id = ? AND status = 'OPEN' ORDER BY id DESC FOR UPDATE", [current.business_id]);
    if (rows.length > 1) throw httpError(409, 'CASH_AMBIGUOUS');
    if (!rows[0]) throw httpError(409, 'EXPENSE_CASH_CLOSED');
    return rows[0];
  }

  async function cashBalance(db, current, cash) {
    const rows = await repo.rows(db, 'SELECT m.direction, m.amount, m.status, COALESCE(s.payment_method, cp.payment_method, sp.payment_method, e.payment_method) AS payment_method FROM cash_movements m LEFT JOIN sales s ON s.business_id=m.business_id AND s.id=m.sale_id LEFT JOIN customer_payments cp ON cp.business_id=m.business_id AND cp.id=m.customer_payment_id LEFT JOIN supplier_payments sp ON sp.business_id=m.business_id AND sp.id=m.supplier_payment_id LEFT JOIN expenses e ON e.business_id=m.business_id AND e.id=m.expense_id WHERE m.business_id=? AND m.cash_session_id=? FOR UPDATE', [current.business_id, String(cash.id)]);
    let balance = units(cash.opening_amount);
    for (const movement of rows) if (movement.status === 'CONFIRMED' && (!movement.payment_method || movement.payment_method === 'CASH')) balance += units(movement.amount) * (movement.direction === 'IN' ? 1n : -1n);
    return balance;
  }

  function publicExpense(row) {
    return { id: String(row.id), businessId: String(row.business_id), category: row.category, description: row.description, receiptReference: row.receipt_reference || '', amount: money(row.amount), paymentMethod: row.payment_method, status: row.status, createdAt: row.created_at, userName: row.user_name, cancelReason: row.cancel_reason || null, cancelledAt: row.cancelled_at || null };
  }

  const list = (session, options) => work(session, async (db, current) => {
    const pattern = options.q ? '%' + options.q.replace(/[\\%_]/g, '\\$&') + '%' : null;
    const [rows, totals, today] = await Promise.all([
      repo.rows(db, 'SELECT e.*, u.full_name AS user_name FROM expenses e JOIN users u ON u.business_id=e.business_id AND u.id=e.user_id WHERE e.business_id=? AND (? IS NULL OR e.category LIKE ? OR e.description LIKE ? OR COALESCE(e.receipt_reference, \'\') LIKE ?) ORDER BY e.created_at DESC,e.id DESC LIMIT ? OFFSET ?', [current.business_id, pattern, pattern, pattern, pattern, options.limit, options.offset]),
      repo.rows(db, "SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN status='POSTED' THEN amount ELSE 0.00 END),0.00) AS total FROM expenses WHERE business_id=?", [current.business_id]),
      repo.rows(db, "SELECT COALESCE(SUM(amount),0.00) AS total FROM expenses WHERE business_id=? AND status='POSTED' AND created_at >= UTC_DATE() AND created_at < UTC_DATE()+INTERVAL 1 DAY", [current.business_id])
    ]);
    return { expenses: rows.map(publicExpense), summary: { businessId: String(current.business_id), count: Number(totals[0]?.count || 0), total: money(totals[0]?.total), today: money(today[0]?.total) } };
  });

  const create = (session, data) => work(session, (db, current) => once(db, current, 'EXPENSE', data, async () => {
    let cash = null;
    if (data.paymentMethod === 'CASH') {
      if (!await auth.canAccess(current, 'cash', db)) throw httpError(403, 'MODULE_FORBIDDEN');
      cash = await openCash(db, current);
      if (await cashBalance(db, current, cash) < units(data.amount)) throw httpError(409, 'CASH_BALANCE_INSUFFICIENT');
    }
    const result = await repo.rows(db, 'INSERT INTO expenses (business_id,user_id,cash_session_id,description,category,amount,payment_method,receipt_reference,status,created_at) VALUES (?,?,?,?,?,?,?, ?,\'POSTED\',UTC_TIMESTAMP(3))', [current.business_id, current.user_id, cash ? String(cash.id) : null, data.description, data.category, data.amount, data.paymentMethod, data.receiptReference]);
    const id = String(result.insertId);
    if (cash) await repo.rows(db, "INSERT INTO cash_movements (business_id,cash_session_id,user_id,type,direction,amount,expense_id,reference_type,reference_id,description,status,created_at) VALUES (?,?,?,'EXPENSE','OUT',?,?,'expenses',?,?,'CONFIRMED',UTC_TIMESTAMP(3))", [current.business_id, String(cash.id), current.user_id, data.amount, id, id, 'Gasto: ' + data.category + ' · ' + data.description]);
    await repo.audit(db, current, 'CREATE_EXPENSE', 'expenses', id, { category: data.category, amount: data.amount, paymentMethod: data.paymentMethod, operationKey: data.operationKey });
    const [row] = await repo.rows(db, 'SELECT e.*,u.full_name AS user_name FROM expenses e JOIN users u ON u.business_id=e.business_id AND u.id=e.user_id WHERE e.business_id=? AND e.id=?', [current.business_id, id]);
    return { kind: 'EXPENSE', expense: publicExpense(row) };
  }));

  const cancel = (session, id, data) => work(session, (db, current) => once(db, current, 'CANCEL_EXPENSE', { expenseId: id, ...data }, async () => {
    const [expense] = await repo.rows(db, 'SELECT * FROM expenses WHERE business_id=? AND id=? FOR UPDATE', [current.business_id, id]);
    if (!expense) throw httpError(404, 'EXPENSE_NOT_FOUND');
    if (expense.status !== 'POSTED') throw httpError(409, 'EXPENSE_CANCELLED');
    let movement = null;
    if (expense.payment_method === 'CASH') {
      const [cashMovement] = await repo.rows(db, "SELECT * FROM cash_movements WHERE business_id=? AND expense_id=? AND type='EXPENSE' AND status='CONFIRMED' FOR UPDATE", [current.business_id, id]);
      if (!cashMovement) throw httpError(409, 'EXPENSE_CASH_MOVEMENT_MISSING');
      movement = cashMovement;
    }
    await repo.rows(db, "UPDATE expenses SET status='VOID',cancelled_at=UTC_TIMESTAMP(3),cancelled_by=?,cancel_reason=? WHERE business_id=? AND id=? AND status='POSTED'", [current.user_id, data.reason, current.business_id, id]);
    if (movement) await repo.rows(db, "INSERT INTO cash_movements (business_id,cash_session_id,user_id,type,direction,amount,expense_id,reference_type,reference_id,reversal_of_movement_id,description,status,created_at) VALUES (?,?,?,'REVERSAL','IN',?,?,'expenses',?,?,?,'CONFIRMED',UTC_TIMESTAMP(3))", [current.business_id, String(movement.cash_session_id), current.user_id, expense.amount, id, id, String(movement.id), 'Anulación de gasto · ' + data.reason]);
    await repo.audit(db, current, 'CANCEL_EXPENSE', 'expenses', id, { amount: expense.amount, reason: data.reason, operationKey: data.operationKey });
    const [row] = await repo.rows(db, 'SELECT e.*,u.full_name AS user_name FROM expenses e JOIN users u ON u.business_id=e.business_id AND u.id=e.user_id WHERE e.business_id=? AND e.id=?', [current.business_id, id]);
    return { kind: 'EXPENSE', expense: publicExpense(row) };
  }));

  return { list, create, cancel };
}

module.exports = { createExpenseService };
