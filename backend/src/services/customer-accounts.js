'use strict';
const { createHash } = require('node:crypto');
const { httpError } = require('../middleware/errors');
const { units, fixed } = require('./inventory-values');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalized = value => String(value || '').trim().toLocaleLowerCase('es').replace(/[\s\p{P}\p{S}]/gu, '');
function publicClient(row, businessId) {
  const debt = units(row.debt || '0.00') > 0n ? units(row.debt || '0.00') : 0n;
  const limit = units(row.credit_limit || '0.00');
  return { id: String(row.id), businessId: String(businessId), name: row.name, phone: row.phone, ruc: row.ruc, address: row.address,
    creditLimit: row.credit_limit, creditDays: Number(row.credit_days), active: Boolean(row.active), debt: fixed(debt, 2),
    availableCredit: fixed(limit - debt, 2), pendingPayments: row.pending_payments || '0.00' };
}
function createCustomerService({ repo, auth, config }) {
  async function permitted(db, current, module) {
    const [valid] = await repo.rows(db, 'SELECT id FROM sessions WHERE business_id = ? AND id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(3) AND created_at > TIMESTAMPADD(SECOND, -?, UTC_TIMESTAMP(3))', [current.business_id, current.session_id, config.absoluteSeconds]);
    if (!valid) throw httpError(401, 'INVALID_SESSION');
    if (!await auth.canAccess(current, module, db)) throw httpError(403, 'MODULE_FORBIDDEN');
  }
  async function work(session, module, action) {
    try { return await repo.tenant(session, async (db, current) => { await permitted(db, current, module); const value = await action(db, current); await permitted(db, current, module); return value; }); }
    catch (error) {
      if (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_FIELD_ERROR') throw httpError(503, 'CREDIT_MIGRATION_REQUIRED');
      if (error.code === 'ER_LOCK_DEADLOCK' || error.code === 'ER_LOCK_WAIT_TIMEOUT') throw httpError(409, 'RETRY_OPERATION');
      throw error;
    }
  }
  async function once(db, current, kind, data, action) {
    const hash = digest(data);
    const [existing] = await repo.rows(db, 'SELECT * FROM pos_operations WHERE business_id = ? AND operation_key = ? FOR UPDATE', [current.business_id, data.operationKey]);
    if (existing) {
      if (String(existing.user_id) !== String(current.user_id) || existing.kind !== kind || existing.request_hash !== hash) throw httpError(409, 'OPERATION_CONFLICT');
      return typeof existing.result === 'string' ? JSON.parse(existing.result) : existing.result;
    }
    const value = await action();
    await repo.rows(db, 'INSERT INTO pos_operations (business_id, operation_key, user_id, kind, request_hash, result) VALUES (?, ?, ?, ?, ?, ?)', [current.business_id, data.operationKey, current.user_id, kind, hash, JSON.stringify(value)]);
    return value;
  }
  async function snapshot(db, current, id, amount = '0.00') {
    const [client] = await repo.rows(db, 'SELECT * FROM clients WHERE business_id = ? AND id = ? FOR UPDATE', [current.business_id, id]);
    if (!client) throw httpError(404, 'CLIENT_NOT_FOUND');
    if (!client.active) throw httpError(409, 'CLIENT_INACTIVE');
    const [[sales], [payments]] = await Promise.all([
      repo.rows(db, "SELECT COALESCE(SUM(total), 0) AS amount FROM sales WHERE business_id = ? AND client_id = ? AND sale_type = 'CREDIT' AND status = 'COMPLETED'", [current.business_id, id]),
      repo.rows(db, "SELECT COALESCE(SUM(amount), 0) AS amount FROM customer_payments WHERE business_id = ? AND client_id = ? AND status = 'POSTED'", [current.business_id, id])
    ]);
    const debtUnits = units(client.opening_balance) + units(sales.amount) - units(payments.amount);
    const debt = debtUnits > 0n ? debtUnits : 0n;
    if (amount !== '0.00' && debt + units(amount) > units(client.credit_limit)) throw httpError(409, 'CREDIT_LIMIT_EXCEEDED');
    return { client, debt, available: units(client.credit_limit) - debt };
  }
  const clientQuery = 'SELECT c.*, c.opening_balance + COALESCE((SELECT SUM(s.total) FROM sales s WHERE s.business_id = c.business_id AND s.client_id = c.id AND s.sale_type = \'CREDIT\' AND s.status = \'COMPLETED\'), 0) - COALESCE((SELECT SUM(p.amount) FROM customer_payments p WHERE p.business_id = c.business_id AND p.client_id = c.id AND p.status = \'POSTED\'), 0) AS debt, COALESCE((SELECT SUM(p.amount) FROM customer_payments p WHERE p.business_id = c.business_id AND p.client_id = c.id AND p.status = \'PENDING\'), 0) AS pending_payments FROM clients c WHERE c.business_id = ? AND (? IS NULL OR c.name LIKE ? OR c.phone LIKE ? OR c.ruc LIKE ? OR CAST(c.id AS CHAR) LIKE ?) ORDER BY c.active DESC, c.name, c.id LIMIT ? OFFSET ?';
  const clientByIdQuery = "SELECT c.*, c.opening_balance + COALESCE((SELECT SUM(s.total) FROM sales s WHERE s.business_id = c.business_id AND s.client_id = c.id AND s.sale_type = 'CREDIT' AND s.status = 'COMPLETED'), 0) - COALESCE((SELECT SUM(p.amount) FROM customer_payments p WHERE p.business_id = c.business_id AND p.client_id = c.id AND p.status = 'POSTED'), 0) AS debt, COALESCE((SELECT SUM(p.amount) FROM customer_payments p WHERE p.business_id = c.business_id AND p.client_id = c.id AND p.status = 'PENDING'), 0) AS pending_payments FROM clients c WHERE c.business_id = ? AND c.id = ?";
  async function clientRow(db, current, id) { return (await repo.rows(db, clientByIdQuery, [current.business_id, id]))[0]; }
  const clientOptions = (session, options) => work(session, 'sales', async (db, current) => {
    const query = options.q ? '%' + options.q + '%' : null;
    const rows = await repo.rows(db, clientQuery.replace(' WHERE c.business_id = ?', ' WHERE c.business_id = ? AND c.active = TRUE'), [current.business_id, query, query, query, query, query, options.limit, options.offset]);
    return rows.map(row => publicClient(row, current.business_id));
  });
  const listClients = (session, options) => work(session, 'clients', async (db, current) => {
    const query = options.q ? '%' + options.q + '%' : null;
    const rows = await repo.rows(db, clientQuery, [current.business_id, query, query, query, query, query, options.limit, options.offset]);
    return rows.map(row => publicClient(row, current.business_id));
  });
  async function ensureUnique(db, businessId, values, exceptId = null) {
    const rows = await repo.rows(db, 'SELECT id, name, phone, ruc FROM clients WHERE business_id = ? FOR UPDATE', [businessId]);
    for (const row of rows) {
      if (exceptId && String(row.id) === String(exceptId)) continue;
      const sameName = normalized(row.name) === normalized(values.name);
      const samePhone = values.phone && row.phone && normalized(row.phone) === normalized(values.phone);
      const sameRuc = values.ruc && row.ruc && normalized(row.ruc) === normalized(values.ruc);
      if (sameName || samePhone || sameRuc) throw httpError(409, 'CLIENT_DUPLICATE');
    }
  }
  const createClient = (session, data) => work(session, 'clients', async (db, current) => {
    await ensureUnique(db, current.business_id, data);
    const result = await repo.rows(db, 'INSERT INTO clients (business_id, name, phone, ruc, address, credit_limit, credit_days) VALUES (?, ?, ?, ?, ?, ?, ?)', [current.business_id, data.name, data.phone, data.ruc, data.address, data.creditLimit, data.creditDays]);
    await repo.audit(db, current, 'CREATE_CLIENT', 'clients', result.insertId, { name: data.name, creditLimit: data.creditLimit, creditDays: data.creditDays });
    const [row] = await repo.rows(db, 'SELECT c.*, c.opening_balance AS debt, 0.00 AS pending_payments FROM clients c WHERE c.business_id = ? AND c.id = ?', [current.business_id, String(result.insertId)]);
    return { client: publicClient(row, current.business_id) };
  });
  const updateClient = (session, id, data) => work(session, 'clients', async (db, current) => {
    const [old] = await repo.rows(db, 'SELECT * FROM clients WHERE business_id = ? AND id = ? FOR UPDATE', [current.business_id, id]);
    if (!old) throw httpError(404, 'CLIENT_NOT_FOUND');
    const next = { name: data.name ?? old.name, phone: Object.hasOwn(data, 'phone') ? data.phone : old.phone, ruc: Object.hasOwn(data, 'ruc') ? data.ruc : old.ruc, address: Object.hasOwn(data, 'address') ? data.address : old.address, creditLimit: data.creditLimit ?? old.credit_limit, creditDays: data.creditDays ?? Number(old.credit_days) };
    await ensureUnique(db, current.business_id, next, id);
    await repo.rows(db, 'UPDATE clients SET name = ?, phone = ?, ruc = ?, address = ?, credit_limit = ?, credit_days = ? WHERE business_id = ? AND id = ?', [next.name, next.phone, next.ruc, next.address, next.creditLimit, next.creditDays, current.business_id, id]);
    await repo.audit(db, current, 'UPDATE_CLIENT', 'clients', id, { name: next.name, creditLimit: next.creditLimit, creditDays: next.creditDays });
    return { client: publicClient(await clientRow(db, current, id), current.business_id) };
  });
  const setClientActive = (session, id, active) => work(session, 'clients', async (db, current) => {
    const [row] = await repo.rows(db, 'SELECT id FROM clients WHERE business_id = ? AND id = ? FOR UPDATE', [current.business_id, id]);
    if (!row) throw httpError(404, 'CLIENT_NOT_FOUND');
    await repo.rows(db, 'UPDATE clients SET active = ? WHERE business_id = ? AND id = ?', [active, current.business_id, id]);
    await repo.audit(db, current, active ? 'ACTIVATE_CLIENT' : 'DEACTIVATE_CLIENT', 'clients', id, {});
    return { id: String(id), businessId: String(current.business_id), active };
  });
  const receivableQuery = 'SELECT s.id, s.business_id, s.client_id, c.name AS client_name, s.invoice_number, s.created_at, s.due_at, s.total, s.status AS sale_status, COALESCE(SUM(CASE WHEN p.status = \'POSTED\' THEN p.amount ELSE 0 END), 0) AS paid, COALESCE(SUM(CASE WHEN p.status = \'PENDING\' THEN p.amount ELSE 0 END), 0) AS pending FROM sales s JOIN clients c ON c.business_id = s.business_id AND c.id = s.client_id LEFT JOIN customer_payments p ON p.business_id = s.business_id AND p.sale_id = s.id WHERE s.business_id = ? AND s.sale_type = \'CREDIT\' AND (? IS NULL OR c.name LIKE ? OR s.invoice_number LIKE ? OR CAST(c.id AS CHAR) LIKE ?) GROUP BY s.id, s.business_id, s.client_id, c.name, s.invoice_number, s.created_at, s.due_at, s.total, s.status ORDER BY (s.status = \'COMPLETED\' AND s.due_at < UTC_TIMESTAMP(3)) DESC, s.created_at DESC, s.id DESC LIMIT ? OFFSET ?';
  function formatReceivable(row) {
    const grossBalance = units(row.total) - units(row.paid), pending = units(row.pending);
    const balance = row.sale_status === 'CANCELLED' ? 0n : grossBalance;
    const remaining = balance - pending;
    const status = row.sale_status === 'CANCELLED' ? 'CANCELLED' : balance <= 0n ? 'PAID' : pending > 0n ? 'PENDING_CONFIRMATION' : row.due_at && new Date(row.due_at).getTime() < Date.now() ? 'OVERDUE' : 'OPEN';
    return { id: String(row.id), businessId: String(row.business_id), clientId: String(row.client_id), clientName: row.client_name, invoiceNumber: row.invoice_number,
      date: row.created_at, dueAt: row.due_at, total: row.total, paid: row.paid, pending: row.pending,
      balance: fixed(balance > 0n ? balance : 0n, 2), remaining: fixed(remaining > 0n ? remaining : 0n, 2), status };
  }
  const receivables = (session, options) => work(session, 'clients', async (db, current) => {
    const query = options.q ? '%' + options.q + '%' : null;
    return (await repo.rows(db, receivableQuery, [current.business_id, query, query, query, query, options.limit, options.offset])).map(formatReceivable);
  });
  const statement = (session, id, options) => work(session, 'clients', async (db, current) => {
    const client = await clientRow(db, current, id);
    if (!client) throw httpError(404, 'CLIENT_NOT_FOUND');
    const invoiceQuery = receivableQuery.replace(' AND (? IS NULL OR c.name LIKE ? OR s.invoice_number LIKE ? OR CAST(c.id AS CHAR) LIKE ?)', ' AND s.client_id = ?').replace(' LIMIT ? OFFSET ?', '');
    const invoices = (await repo.rows(db, invoiceQuery, [current.business_id, id])).map(formatReceivable);
    const payments = await repo.rows(db, 'SELECT p.id, p.sale_id, p.amount, p.payment_method, p.status, p.created_at, s.invoice_number, u.full_name AS user_name FROM customer_payments p JOIN sales s ON s.business_id = p.business_id AND s.id = p.sale_id JOIN users u ON u.business_id = p.business_id AND u.id = p.user_id WHERE p.business_id = ? AND p.client_id = ? ORDER BY p.id DESC LIMIT ? OFFSET ?', [current.business_id, id, options.limit, options.offset]);
    return { client: publicClient(client, current.business_id), invoices, payments: payments.map(item => ({ id: String(item.id), saleId: String(item.sale_id), invoiceNumber: item.invoice_number, amount: item.amount, paymentMethod: item.payment_method, status: item.status, createdAt: item.created_at, userName: item.user_name })) };
  });
  const pay = (session, saleId, data) => work(session, 'cash', (db, current) => once(db, current, 'CUSTOMER_PAYMENT', { saleId, ...data }, async () => {
    const [cash] = await repo.rows(db, "SELECT * FROM cash_sessions WHERE business_id = ? AND status = 'OPEN' ORDER BY id DESC LIMIT 1 FOR UPDATE", [current.business_id]);
    if (!cash) throw httpError(409, 'CASH_CLOSED');
    const [sale] = await repo.rows(db, 'SELECT * FROM sales WHERE business_id = ? AND id = ? FOR UPDATE', [current.business_id, saleId]);
    if (!sale) throw httpError(404, 'SALE_NOT_FOUND');
    if (sale.sale_type !== 'CREDIT' || !sale.client_id) throw httpError(409, 'RECEIVABLE_NOT_CREDIT');
    if (sale.status !== 'COMPLETED') throw httpError(409, 'SALE_CANCELLED');
    const [sum] = await repo.rows(db, "SELECT COALESCE(SUM(CASE WHEN status = 'POSTED' THEN amount ELSE 0 END),0) AS paid, COALESCE(SUM(CASE WHEN status = 'PENDING' THEN amount ELSE 0 END),0) AS pending FROM customer_payments WHERE business_id = ? AND sale_id = ?", [current.business_id, saleId]);
    const paid = units(sum.paid), pending = units(sum.pending), total = units(sale.total);
    if (paid >= total) throw httpError(409, 'RECEIVABLE_ALREADY_PAID');
    const available = total - paid - pending;
    if (available <= 0n) throw httpError(409, 'PAYMENT_CONFIRMATION_PENDING');
    if (units(data.amount) > total - paid) throw httpError(409, 'PAYMENT_EXCEEDS_BALANCE');
    if (units(data.amount) > available) throw httpError(409, 'PAYMENT_CONFIRMATION_PENDING');
    const status = data.paymentMethod === 'CASH' ? 'POSTED' : 'PENDING';
    const result = await repo.rows(db, 'INSERT INTO customer_payments (business_id, user_id, client_id, sale_id, cash_session_id, amount, payment_method, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))', [current.business_id, current.user_id, sale.client_id, saleId, String(cash.id), data.amount, data.paymentMethod, status]);
    const paymentId = String(result.insertId);
    await repo.rows(db, "INSERT INTO cash_movements (business_id, cash_session_id, user_id, type, direction, amount, customer_payment_id, reference_type, reference_id, description, status, created_at) VALUES (?, ?, ?, 'CUSTOMER_PAYMENT', 'IN', ?, ?, 'customer_payments', ?, ?, ?, UTC_TIMESTAMP(3))", [current.business_id, String(cash.id), current.user_id, data.amount, paymentId, paymentId, 'Abono factura #' + sale.invoice_number + ' · ' + data.paymentMethod, status === 'POSTED' ? 'CONFIRMED' : 'PENDING']);
    await repo.audit(db, current, 'POST_CUSTOMER_PAYMENT', 'customer_payments', paymentId, { saleId: String(saleId), clientId: String(sale.client_id), amount: data.amount, paymentMethod: data.paymentMethod, status, operationKey: data.operationKey });
    return { kind: 'CUSTOMER_PAYMENT', payment: { id: paymentId, businessId: String(current.business_id), saleId: String(saleId), clientId: String(sale.client_id), invoiceNumber: sale.invoice_number, amount: data.amount, paymentMethod: data.paymentMethod, status, createdAt: new Date().toISOString() } };
  }));
  return { listClients, clientOptions, createClient, updateClient, setClientActive, receivables, statement, pay, creditSnapshot: snapshot };
}
module.exports = { createCustomerService };
