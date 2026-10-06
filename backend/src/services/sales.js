'use strict';
const { createHash } = require('node:crypto');
const { httpError } = require('../middleware/errors');
const { fixed, units } = require('./inventory-values');
const { calculate } = require('./sales-values');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function createSalesService({ repo, auth, config, creditSnapshot }) {
  async function permitted(db, current, module) {
    const [valid] = await repo.rows(db, 'SELECT id FROM sessions WHERE business_id = ? AND id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(3) AND created_at > TIMESTAMPADD(SECOND, -?, UTC_TIMESTAMP(3))', [current.business_id, current.session_id, config.absoluteSeconds]);
    if (!valid) throw httpError(401, 'INVALID_SESSION');
    if (!await auth.canAccess(current, module, db)) throw httpError(403, 'MODULE_FORBIDDEN');
  }
  async function work(session, module, action) {
    try {
      return await repo.tenant(session, async (db, current) => {
        await permitted(db, current, module);
        const result = await action(db, current);
        await permitted(db, current, module);
        return result;
      });
    } catch (error) {
      if (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_FIELD_ERROR') throw httpError(503, 'SALES_MIGRATION_REQUIRED');
      if (error.code === 'ER_DUP_ENTRY') throw httpError(409, 'INVOICE_DUPLICATE');
      if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code)) throw httpError(409, 'RETRY_OPERATION');
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
    const result = await action();
    await repo.rows(db, 'INSERT INTO pos_operations (business_id, operation_key, user_id, kind, request_hash, result) VALUES (?, ?, ?, ?, ?, ?)', [current.business_id, data.operationKey, current.user_id, kind, hash, JSON.stringify(result)]);
    return result;
  }
  async function cashRow(db, current, id) {
    const data = await repo.rows(db, 'SELECT c.*, u.full_name AS opened_by_name, z.full_name AS closed_by_name FROM cash_sessions c JOIN users u ON u.business_id = c.business_id AND u.id = c.opened_by LEFT JOIN users z ON z.business_id = c.business_id AND z.id = c.closed_by WHERE c.business_id = ?' + (id ? ' AND c.id = ?' : " AND c.status = 'OPEN'") + ' ORDER BY c.id DESC FOR UPDATE', [current.business_id, ...(id ? [id] : [])]);
    if (!id && data.length > 1) throw httpError(409, 'CASH_AMBIGUOUS');
    return data[0];
  }
  async function cashPublic(db, current, row, full = true) {
    if (!row) return null;
    const movements = await repo.rows(db, 'SELECT m.id, m.business_id, m.type, m.direction, m.amount, m.sale_id, m.customer_payment_id, m.reversal_of_movement_id, m.description, m.status, m.created_at, m.confirmed_at, m.confirmed_by_user_id, u.full_name AS user_name, z.full_name AS confirmed_by_name, COALESCE(s.payment_method, p.payment_method) AS payment_method, s.invoice_number, p.sale_id AS payment_sale_id FROM cash_movements m JOIN users u ON u.business_id = m.business_id AND u.id = m.user_id LEFT JOIN users z ON z.business_id = m.business_id AND z.id = m.confirmed_by_user_id LEFT JOIN sales s ON s.business_id = m.business_id AND s.id = m.sale_id LEFT JOIN customer_payments p ON p.business_id = m.business_id AND p.id = m.customer_payment_id WHERE m.business_id = ? AND m.cash_session_id = ? ORDER BY m.id', [current.business_id, String(row.id)]);
    const balance = units(row.opening_amount) + movements.filter(m => m.status === 'CONFIRMED' && (!m.payment_method || m.payment_method === 'CASH')).reduce((sum, m) => sum + units(m.amount) * (m.direction === 'IN' ? 1n : -1n), 0n);
    const result = { id: String(row.id), businessId: String(row.business_id), status: row.status, openingAmount: row.opening_amount, expectedAmount: fixed(balance, 2), countedAmount: row.counted_amount, difference: row.difference, openedAt: row.opened_at, closedAt: row.closed_at, openedBy: row.opened_by_name, closedBy: row.closed_by_name };
    if (row.status === 'CLOSED') result.expectedAmount = row.expected_amount;
    if (full) {
      const sales = await repo.rows(db, "SELECT payment_method, total FROM sales WHERE business_id = ? AND cash_session_id = ? AND status <> 'CANCELLED'", [current.business_id, String(row.id)]);
      const total = list => fixed(list.reduce((sum, item) => sum + units(item.amount ?? item.total), 0n), 2);
      const physical = movements.filter(m => m.status === 'CONFIRMED' && (!m.payment_method || m.payment_method === 'CASH'));
      const out = type => total(physical.filter(m => m.direction === 'OUT' && m.type === type));
      const [actor] = await repo.rows(db, 'SELECT full_name FROM users WHERE business_id = ? AND id = ?', [current.business_id, row.closed_by || current.user_id]);
      result.closingBy = actor?.full_name || row.closed_by_name || null;
      result.summary = { cashSales: total(physical.filter(m => m.direction === 'IN' && m.type === 'SALE')), creditSales: total(sales.filter(s => s.payment_method === 'CREDIT')), cardSales: total(sales.filter(s => s.payment_method === 'CARD')), transferSales: total(sales.filter(s => s.payment_method === 'TRANSFER')), expenses: out('EXPENSE'), purchases: out('PURCHASE'), withdrawals: total(physical.filter(m => m.direction === 'OUT' && !['EXPENSE','PURCHASE','REVERSAL'].includes(m.type))), cashReturns: out('REVERSAL'), cashCollections: total(physical.filter(m => m.direction === 'IN' && m.customer_payment_id)), otherCash: total(physical.filter(m => m.direction === 'IN' && !m.customer_payment_id && m.type !== 'SALE')) };
      if (row.status === 'CLOSED') {
        const [saved] = await repo.rows(db, "SELECT result FROM pos_operations WHERE business_id = ? AND kind = 'CLOSE_CASH' AND JSON_UNQUOTE(JSON_EXTRACT(result, '$.cash.id')) = ? ORDER BY created_at DESC LIMIT 1", [current.business_id, String(row.id)]);
        if (saved) { const value = typeof saved.result === 'string' ? JSON.parse(saved.result) : saved.result; if (value.cash?.summary) result.summary = value.cash.summary; }
      }
    }
    if (full) result.movements = movements.map(m => ({ ...m, id: String(m.id), businessId: String(m.business_id), saleId: m.sale_id === null ? null : String(m.sale_id) }));
    return result;
  }
  async function getSale(db, current, id) {
    const [row] = await repo.rows(db, 'SELECT s.*, s.cash_received, s.change_amount, u.full_name AS seller, c.full_name AS cashier, cl.name AS client_name FROM sales s JOIN users u ON u.business_id = s.business_id AND u.id = s.user_id LEFT JOIN users c ON c.business_id = s.business_id AND c.id = s.cashier_user_id LEFT JOIN clients cl ON cl.business_id = s.business_id AND cl.id = s.client_id WHERE s.business_id = ? AND s.id = ?', [current.business_id, id]);
    if (!row) throw httpError(404, 'SALE_NOT_FOUND');
    const items = await repo.rows(db, 'SELECT product_id, product_name, barcode, quantity, unit_price, tax_rate, discount, subtotal, total FROM sale_items WHERE business_id = ? AND sale_id = ? ORDER BY id', [current.business_id, id]);
    return { id: String(row.id), businessId: String(row.business_id), userId: String(row.user_id), seller: row.seller, cashier: row.cashier || row.seller, cashSessionId: String(row.cash_session_id), invoiceNumber: row.invoice_number, clientId: row.client_id === null ? null : String(row.client_id), clientName: row.client_name, dueAt: row.due_at, saleType: row.sale_type, priceType: row.sale_price_type, paymentMethod: row.payment_method, cashStatus: row.cash_status, subtotal: row.subtotal, discount: row.discount, discountPercent: row.discount_percent, tax: row.tax, total: row.total, cashReceived: row.cash_received, changeAmount: row.change_amount, status: row.status, detail: row.detail || '', createdAt: row.created_at, cancelledAt: row.cancelled_at, cancelReason: row.cancel_reason, items: items.map(i => ({ productId: String(i.product_id), name: i.product_name, barcode: i.barcode, quantity: i.quantity, unitPrice: i.unit_price, discount: i.discount, subtotal: i.subtotal, total: i.total, taxRate: i.tax_rate })) };
  }
  async function flow(db, current) {
    const [row] = await repo.rows(db, 'SELECT sales_flow FROM businesses WHERE id = ? FOR UPDATE', [current.business_id]);
    return row?.sales_flow || 'DIRECT';
  }
  async function getOrder(db, current, id) {
    const [row] = await repo.rows(db, 'SELECT o.*, u.full_name AS seller, z.full_name AS cashier, c.name AS client_name FROM sale_orders o JOIN users u ON u.business_id = o.business_id AND u.id = o.created_by_user_id LEFT JOIN users z ON z.business_id = o.business_id AND z.id = o.completed_by_user_id LEFT JOIN clients c ON c.business_id = o.business_id AND c.id = o.client_id WHERE o.business_id = ? AND o.id = ?', [current.business_id, id]);
    if (!row) throw httpError(404, 'ORDER_NOT_FOUND');
    const items = await repo.rows(db, 'SELECT product_id, product_name, barcode, quantity, estimated_unit_price, estimated_subtotal FROM sale_order_items WHERE business_id = ? AND order_id = ? ORDER BY line_number', [current.business_id, id]);
    return { id: String(row.id), businessId: String(row.business_id), seller: row.seller, cashier: row.cashier || null, status: row.status, saleId: row.sale_id === null ? null : String(row.sale_id), clientId: row.client_id === null ? null : String(row.client_id), clientName: row.client_name, creditDays: row.credit_days, priceType: row.price_type, discountPercent: row.discount_percent, estimatedSubtotal: row.estimated_subtotal, estimatedDiscount: row.estimated_discount, estimatedTotal: row.estimated_total, detail: row.detail, createdAt: row.created_at, completedAt: row.completed_at, items: items.map(item => ({ productId: String(item.product_id), name: item.product_name, barcode: item.barcode, quantity: item.quantity, estimatedUnitPrice: item.estimated_unit_price, estimatedSubtotal: item.estimated_subtotal })) };
  }
  async function prepare(db, current, data, centralized = false) {
    await repo.rows(db, 'SELECT operation_key FROM pos_operations WHERE business_id = ? LIMIT 0', [current.business_id]);
    await repo.rows(db, 'SELECT cash_received, change_amount FROM sales WHERE business_id = ? LIMIT 0', [current.business_id]);
    if (await flow(db, current) !== (centralized ? 'CENTRALIZED' : 'DIRECT')) throw httpError(409, 'SALES_FLOW_CHANGED');
    const cash = await cashRow(db, current);
    if (!cash) throw httpError(409, 'CASH_CLOSED');
    const products = [];
    for (const item of data.items) {
      const [product] = await repo.rows(db, 'SELECT * FROM products WHERE business_id = ? AND id = ? FOR UPDATE', [current.business_id, item.productId]);
      if (product) products.push(product);
    }
    const calc = calculate(products, data);
    const credit = data.paymentMethod === 'CREDIT' ? await creditSnapshot(db, current, data.clientId, calc.total) : null;
    let dueAt = null;
    if (credit) { const [term] = await repo.rows(db, 'SELECT DATE_ADD(UTC_DATE(), INTERVAL ? DAY) AS due_at', [credit.client.credit_days]); dueAt = term.due_at; }
    const preview = { businessId: String(current.business_id), cashSessionId: String(cash.id), priceType: data.priceType, paymentMethod: data.paymentMethod, clientId: credit ? String(credit.client.id) : null, clientName: credit?.client.name || null, dueAt, creditAvailable: credit ? fixed(credit.available, 2) : null, discountPercent: data.discountPercent, subtotal: calc.subtotal, discount: calc.discount, tax: calc.tax, total: calc.total, items: calc.lines.map(l => ({ productId: l.productId, name: l.product.name, quantity: l.quantity, unitPrice: l.unitPrice, subtotal: l.subtotal, discount: l.discount, total: l.total, taxRate: l.product.tax_rate })) };
    return { cash, calc, credit, dueAt, preview: { ...preview, quoteToken: digest(preview) } };
  }
  const quote = (session, data) => work(session, 'sales', async (db, current) => (await prepare(db, current, data)).preview);
  const nextInvoiceNumber = session => work(session, 'sales', async (db, current) => {
    const [sequence] = await repo.rows(db, "SELECT current_number FROM document_sequences WHERE business_id = ? AND document_type = 'SALE'", [current.business_id]);
    const number = BigInt(sequence?.current_number || '0') + 1n;
    if (number > 18446744073709551615n) throw httpError(409, 'INVOICE_LIMIT');
    return { businessId: String(current.business_id), invoiceNumber: number.toString().padStart(6, '0') };
  });
  async function recordSale(db, current, data, prepared, sellerId = current.user_id, orderId = null) {
    const { cash, calc, credit, dueAt } = prepared;
    const isCredit = data.paymentMethod === 'CREDIT';
    if (data.paymentMethod === 'CASH' && units(data.cashReceived) < units(calc.total)) throw httpError(400, 'CASH_INSUFFICIENT');
    const cashBalance = isCredit ? null : await cashPublic(db, current, cash, false);
    if (data.paymentMethod === 'CASH' && units(cashBalance.expectedAmount) + units(calc.total) >= 1000000000000n) throw httpError(409, 'TOTAL_LIMIT');
    await repo.rows(db, "INSERT INTO document_sequences (business_id, document_type) VALUES (?, 'SALE') ON DUPLICATE KEY UPDATE id = id", [current.business_id]);
    const [sequence] = await repo.rows(db, "SELECT current_number FROM document_sequences WHERE business_id = ? AND document_type = 'SALE' FOR UPDATE", [current.business_id]);
    const number = BigInt(sequence.current_number) + 1n;
    if (number > 18446744073709551615n) throw httpError(409, 'INVOICE_LIMIT');
    const invoice = number.toString().padStart(6, '0');
    await repo.rows(db, "UPDATE document_sequences SET current_number = ? WHERE business_id = ? AND document_type = 'SALE'", [number.toString(), current.business_id]);
    const change = data.paymentMethod === 'CASH' ? fixed(units(data.cashReceived) - units(calc.total), 2) : null;
    const paymentStatus = isCredit ? 'NOT_APPLICABLE' : data.paymentMethod === 'CASH' ? 'CONFIRMED' : units(calc.total) > 0n ? 'PENDING' : 'NOT_APPLICABLE';
    const result = await repo.rows(db, "INSERT INTO sales (business_id, user_id, cashier_user_id, client_id, cash_session_id, invoice_number, sale_type, payment_method, subtotal, discount, discount_percent, tax, total, cash_status, sale_price_type, detail, cash_received, change_amount, due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [current.business_id, sellerId, current.user_id, isCredit ? String(credit.client.id) : null, String(cash.id), invoice, isCredit ? 'CREDIT' : 'CASH', data.paymentMethod, calc.subtotal, calc.discount, data.discountPercent, calc.tax, calc.total, paymentStatus, data.priceType, data.detail, data.cashReceived, change, dueAt]);
    const id = String(result.insertId);
    for (const line of calc.lines) {
      await repo.rows(db, 'INSERT INTO sale_items (business_id, sale_id, product_id, product_name, barcode, quantity, unit_price, tax_rate, discount, subtotal, total, cost_at_sale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [current.business_id, id, line.productId, line.product.name, line.product.barcode, line.quantity, line.unitPrice, line.product.tax_rate, line.discount, line.subtotal, line.total, line.product.cost]);
      await stock(db, current, line.product, -units(line.quantity), 'SALE', id, 'Venta #' + invoice);
    }
    if (!isCredit && units(calc.total) > 0n) {
      const movementStatus = data.paymentMethod === 'CASH' ? 'CONFIRMED' : 'PENDING';
      const methodLabel = data.paymentMethod === 'CASH' ? 'Efectivo confirmado' : (data.paymentMethod === 'CARD' ? 'Tarjeta pendiente' : 'Transferencia pendiente');
      await repo.rows(db, "INSERT INTO cash_movements (business_id, cash_session_id, user_id, type, direction, amount, sale_id, reference_type, reference_id, description, status) VALUES (?, ?, ?, 'SALE', 'IN', ?, ?, 'sales', ?, ?, ?)", [current.business_id, String(cash.id), current.user_id, calc.total, id, id, 'Venta #' + invoice + ' \u00b7 ' + methodLabel, movementStatus]);
    }
    if (orderId) await repo.rows(db, "UPDATE sale_orders SET status = 'COMPLETED', sale_id = ?, completed_at = UTC_TIMESTAMP(3), completed_by_user_id = ? WHERE business_id = ? AND id = ? AND status = 'PENDING'", [id, current.user_id, current.business_id, orderId]);
    await repo.audit(db, current, 'CREATE_SALE', 'sales', id, { invoice, total: calc.total, paymentMethod: data.paymentMethod, clientId: isCredit ? String(credit.client.id) : null, operationKey: data.operationKey });
    return { kind: 'SALE', sale: await getSale(db, current, id) };
  }
  const create = (session, data) => work(session, 'sales', (db, current) => once(db, current, 'SALE', data, async () => {
    const prepared = await prepare(db, current, data);
    if (prepared.preview.quoteToken !== data.quoteToken) throw httpError(409, 'QUOTE_CHANGED');
    return recordSale(db, current, data, prepared);
  }));
  async function stock(db, current, product, delta, type, saleId, reason) {
    const quantity = units(product.stock) + delta;
    if (quantity < 0n) throw httpError(409, 'INSUFFICIENT_STOCK');
    if (quantity >= 1000000000000n) throw httpError(409, 'STOCK_LIMIT');
    const after = fixed(quantity, 3);
    await repo.rows(db, 'UPDATE products SET stock = ? WHERE business_id = ? AND id = ?', [after, current.business_id, String(product.id)]);
    await repo.rows(db, 'INSERT INTO inventory_movements (business_id, product_id, user_id, type, quantity, stock_after, unit_cost, reference_type, reference_id, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [current.business_id, String(product.id), current.user_id, type, fixed(delta, 3), after, product.cost, 'sales', saleId, reason]);
  }
  const cancel = (session, id, data) => work(session, 'history', (db, current) => once(db, current, 'CANCEL', { saleId: id, ...data }, async () => {
    const sale = await getSale(db, current, id);
    if (sale.status !== 'COMPLETED') throw httpError(409, 'SALE_CANCELLED');
    if (sale.paymentMethod === 'CREDIT') {
      const [payment] = await repo.rows(db, "SELECT id FROM customer_payments WHERE business_id = ? AND sale_id = ? AND status <> 'VOID' LIMIT 1 FOR UPDATE", [current.business_id, id]);
      if (payment) throw httpError(409, 'CREDIT_HAS_PAYMENTS');
    }
    if (sale.paymentMethod !== 'CASH' && sale.cashStatus === 'CONFIRMED') throw httpError(409, 'PAYMENT_ALREADY_CONFIRMED');
    let refundCash = null;
    let originalMovement = null;
    if (sale.paymentMethod === 'CASH') {
      const [movement] = await repo.rows(db, "SELECT * FROM cash_movements WHERE business_id = ? AND sale_id = ? AND type = 'SALE' AND status = 'CONFIRMED' FOR UPDATE", [current.business_id, id]);
      originalMovement = movement || null;
      if (units(sale.total) > 0n) {
        refundCash = await cashRow(db, current);
        if (!refundCash) throw httpError(409, 'CANCEL_REQUIRES_OPEN_CASH');
        if (!movement || movement.amount !== sale.total || String(movement.cash_session_id) !== sale.cashSessionId) throw httpError(409, 'CASH_INCONSISTENT');
        const [existingReversal] = await repo.rows(db, "SELECT id FROM cash_movements WHERE business_id = ? AND sale_id = ? AND type = 'REVERSAL' LIMIT 1 FOR UPDATE", [current.business_id, id]);
        if (existingReversal) throw httpError(409, 'CASH_INCONSISTENT');
        const balance = await cashPublic(db, current, refundCash, false);
        if (units(balance.expectedAmount) < units(sale.total)) throw httpError(409, 'CASH_REFUND_INSUFFICIENT');
        const description = `Devolución Factura #${sale.invoiceNumber}; caja original #${sale.cashSessionId}; caja actual #${refundCash.id}; motivo: ${data.reason}`.slice(0, 500);
        await repo.rows(db, "INSERT INTO cash_movements (business_id, cash_session_id, user_id, type, direction, amount, sale_id, reversal_of_movement_id, description) VALUES (?, ?, ?, 'REVERSAL', 'OUT', ?, ?, ?, ?)", [current.business_id, String(refundCash.id), current.user_id, sale.total, id, String(movement.id), description]);
      }
    }
    if (sale.cashStatus === 'PENDING') {
      await repo.rows(db, "UPDATE cash_movements SET status = 'VOID' WHERE business_id = ? AND sale_id = ? AND type = 'SALE' AND status = 'PENDING'", [current.business_id, id]);
    }
    for (const line of sale.items) {
      const [product] = await repo.rows(db, 'SELECT * FROM products WHERE business_id = ? AND id = ? FOR UPDATE', [current.business_id, line.productId]);
      if (!product) throw httpError(404, 'PRODUCT_NOT_FOUND');
      await stock(db, current, product, units(line.quantity), 'SALE_CANCEL', id, data.reason);
    }
    await repo.rows(db, "UPDATE sales SET status = 'CANCELLED', cash_status = IF(cash_status = 'PENDING', 'NOT_APPLICABLE', cash_status), cancelled_at = UTC_TIMESTAMP(3), cancelled_by = ?, cancel_reason = ? WHERE business_id = ? AND id = ?", [current.user_id, data.reason, current.business_id, id]);
    await repo.audit(db, current, 'CANCEL_SALE', 'sales', id, {
      reason: data.reason,
      operationKey: data.operationKey,
      invoiceNumber: sale.invoiceNumber,
      paymentMethod: sale.paymentMethod,
      originalCashSessionId: sale.cashSessionId,
      refundCashSessionId: refundCash ? String(refundCash.id) : null,
      originalCashMovementId: originalMovement ? String(originalMovement.id) : null,
      products: sale.items.map(item => ({ productId: item.productId, quantity: item.quantity }))
    });
    return { kind: 'CANCEL', sale: await getSale(db, current, id), refundCashSessionId: refundCash ? String(refundCash.id) : null };
  }));
  const getSalesFlow = session => work(session, 'sales', async (db, current) => ({ salesFlow: await flow(db, current), businessId: String(current.business_id) }));
  const setSalesFlow = (session, salesFlow) => work(session, 'sales', async (db, current) => {
    if (current.role !== 'ADMIN') throw httpError(403, 'ADMIN_REQUIRED');
    const currentFlow = await flow(db, current);
    if (currentFlow !== salesFlow) {
      const [open] = await repo.rows(db, "SELECT id FROM cash_sessions WHERE business_id = ? AND status = 'OPEN' LIMIT 1 FOR UPDATE", [current.business_id]);
      const [orders] = await repo.rows(db, "SELECT id FROM sale_orders WHERE business_id = ? AND status = 'PENDING' LIMIT 1 FOR UPDATE", [current.business_id]);
      if (open) throw httpError(409, 'CASH_OPEN');
      if (orders) throw httpError(409, 'PENDING_ORDERS_EXIST');
      await repo.rows(db, 'UPDATE businesses SET sales_flow = ? WHERE id = ?', [salesFlow, current.business_id]);
      await repo.audit(db, current, 'CHANGE_SALES_FLOW', 'businesses', current.business_id, { from: currentFlow, to: salesFlow });
    }
    return { salesFlow, businessId: String(current.business_id) };
  });
  const createOrder = (session, data) => work(session, 'sales', (db, current) => once(db, current, 'PREPARE_ORDER', data, async () => {
    if (await flow(db, current) !== 'CENTRALIZED') throw httpError(409, 'DIRECT_MODE_ACTIVE');
    if (!await cashRow(db, current)) throw httpError(409, 'CASH_CLOSED');
    const products = [];
    for (const item of data.items) {
      const [product] = await repo.rows(db, 'SELECT * FROM products WHERE business_id = ? AND id = ? FOR UPDATE', [current.business_id, item.productId]);
      if (product) products.push(product);
    }
    const calc = calculate(products, { ...data, paymentMethod: 'CASH' });
    let creditDays = null;
    if (data.clientId) creditDays = Number((await creditSnapshot(db, current, data.clientId)).client.credit_days);
    const result = await repo.rows(db, "INSERT INTO sale_orders (business_id, created_by_user_id, client_id, credit_days, price_type, discount_percent, estimated_subtotal, estimated_discount, estimated_total, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [current.business_id, current.user_id, data.clientId, creditDays, data.priceType, data.discountPercent, calc.subtotal, calc.discount, calc.total, data.detail]);
    const id = String(result.insertId);
    for (const [index, line] of calc.lines.entries()) await repo.rows(db, 'INSERT INTO sale_order_items (business_id, order_id, line_number, product_id, product_name, barcode, quantity, estimated_unit_price, estimated_subtotal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [current.business_id, id, index + 1, line.productId, line.product.name, line.product.barcode, line.quantity, line.unitPrice, line.subtotal]);
    await repo.audit(db, current, 'PREPARE_SALE_ORDER', 'sale_orders', id, { estimatedTotal: calc.total, operationKey: data.operationKey });
    return { kind: 'ORDER', order: await getOrder(db, current, id) };
  }));
  const quoteOrder = (session, id, data) => work(session, 'cash', async (db, current) => {
    if (await flow(db, current) !== 'CENTRALIZED') throw httpError(409, 'DIRECT_MODE_ACTIVE');
    const [row] = await repo.rows(db, "SELECT * FROM sale_orders WHERE business_id = ? AND id = ? FOR UPDATE", [current.business_id, id]);
    if (!row) throw httpError(404, 'ORDER_NOT_FOUND');
    if (row.status !== 'PENDING') throw httpError(409, 'ORDER_NOT_PENDING');
    const order = await getOrder(db, current, id);
    if ((order.clientId && data.paymentMethod !== 'CREDIT') || (!order.clientId && data.paymentMethod === 'CREDIT')) throw httpError(409, 'ORDER_PAYMENT_CHANGED');
    const input = { items: order.items.map(item => ({ productId: item.productId, quantity: item.quantity })), priceType: order.priceType, discountPercent: order.discountPercent, paymentMethod: data.paymentMethod, clientId: order.clientId };
    const prepared = await prepare(db, current, input, true);
    const quoteToken = digest({ preview: prepared.preview.quoteToken, orderId: String(id), estimatedTotal: order.estimatedTotal });
    const priceChanged = prepared.calc.total !== order.estimatedTotal || prepared.calc.lines.some(line => order.items.find(item => item.productId === line.productId)?.estimatedUnitPrice !== line.unitPrice);
    return { ...prepared.preview, quoteToken, orderId: String(id), estimatedTotal: order.estimatedTotal, priceChanged, priceDelta: fixed(units(prepared.calc.total) - units(order.estimatedTotal), 2), seller: order.seller };
  });
  const chargeOrder = (session, id, data) => work(session, 'cash', (db, current) => once(db, current, 'CHARGE_ORDER', { orderId: id, ...data }, async () => {
    if (await flow(db, current) !== 'CENTRALIZED') throw httpError(409, 'DIRECT_MODE_ACTIVE');
    const [row] = await repo.rows(db, "SELECT * FROM sale_orders WHERE business_id = ? AND id = ? FOR UPDATE", [current.business_id, id]);
    if (!row) throw httpError(404, 'ORDER_NOT_FOUND');
    if (row.status !== 'PENDING') throw httpError(409, 'ORDER_NOT_PENDING');
    const order = await getOrder(db, current, id);
    if ((order.clientId && data.paymentMethod !== 'CREDIT') || (!order.clientId && data.paymentMethod === 'CREDIT')) throw httpError(409, 'ORDER_PAYMENT_CHANGED');
    const input = { items: order.items.map(item => ({ productId: item.productId, quantity: item.quantity })), priceType: order.priceType, discountPercent: order.discountPercent, paymentMethod: data.paymentMethod, clientId: order.clientId };
    const prepared = await prepare(db, current, input, true);
    const expectedToken = digest({ preview: prepared.preview.quoteToken, orderId: String(id), estimatedTotal: order.estimatedTotal });
    if (expectedToken !== data.quoteToken) throw httpError(409, 'QUOTE_CHANGED');
    const saleData = { ...input, operationKey: data.operationKey, quoteToken: data.quoteToken, cashReceived: data.cashReceived, detail: order.detail };
    const result = await recordSale(db, current, saleData, prepared, String(row.created_by_user_id), String(id));
    return { ...result, order: await getOrder(db, current, id) };
  }));
  const cancelOrder = (session, id, data) => work(session, 'cash', (db, current) => once(db, current, 'CANCEL_ORDER', { orderId: id, ...data }, async () => {
    const [row] = await repo.rows(db, 'SELECT * FROM sale_orders WHERE business_id = ? AND id = ? FOR UPDATE', [current.business_id, id]);
    if (!row) throw httpError(404, 'ORDER_NOT_FOUND');
    if (row.status !== 'PENDING') throw httpError(409, 'ORDER_NOT_PENDING');
    await repo.rows(db, "UPDATE sale_orders SET status = 'CANCELLED', cancelled_at = UTC_TIMESTAMP(3), cancelled_by_user_id = ? WHERE business_id = ? AND id = ?", [current.user_id, current.business_id, id]);
    await repo.audit(db, current, 'CANCEL_SALE_ORDER', 'sale_orders', id, { operationKey: data.operationKey });
    return { kind: 'CANCEL_ORDER', order: await getOrder(db, current, id) };
  }));
  const confirmPayment = (session, id, data) => work(session, 'cash', (db, current) => once(db, current, 'CONFIRM_PAYMENT', { movementId: id, ...data }, async () => {
    const [row] = await repo.rows(db, "SELECT m.*, m.type AS movement_type, s.payment_method AS sale_payment_method, s.cash_status, s.status AS sale_status, p.id AS payment_id, p.sale_id AS payment_sale_id, p.client_id, p.payment_method AS customer_payment_method, p.status AS payment_status, COALESCE(s.invoice_number, ps.invoice_number) AS invoice_number FROM cash_movements m LEFT JOIN sales s ON s.business_id = m.business_id AND s.id = m.sale_id LEFT JOIN customer_payments p ON p.business_id = m.business_id AND p.id = m.customer_payment_id LEFT JOIN sales ps ON ps.business_id = p.business_id AND ps.id = p.sale_id WHERE m.business_id = ? AND m.id = ? AND m.type IN ('SALE', 'CUSTOMER_PAYMENT') FOR UPDATE", [current.business_id, id]);
    if (!row) throw httpError(404, 'PAYMENT_NOT_FOUND');
    const isCustomerPayment = row.movement_type === 'CUSTOMER_PAYMENT';
    const method = isCustomerPayment ? row.customer_payment_method : row.sale_payment_method;
    if (!['CARD', 'TRANSFER'].includes(method)) throw httpError(409, 'PAYMENT_METHOD_NOT_CONFIRMABLE');
    if (row.status !== 'PENDING' || (isCustomerPayment ? row.payment_status !== 'PENDING' : row.cash_status !== 'PENDING' || row.sale_status !== 'COMPLETED')) throw httpError(409, 'PAYMENT_NOT_PENDING');
    await repo.rows(db, "UPDATE cash_movements SET status = 'CONFIRMED', confirmed_by_user_id = ?, confirmed_at = UTC_TIMESTAMP(3) WHERE business_id = ? AND id = ? AND status = 'PENDING'", [current.user_id, current.business_id, id]);
    if (isCustomerPayment) await repo.rows(db, "UPDATE customer_payments SET status = 'POSTED' WHERE business_id = ? AND id = ? AND status = 'PENDING'", [current.business_id, row.payment_id]);
    else await repo.rows(db, "UPDATE sales SET cash_status = 'CONFIRMED' WHERE business_id = ? AND id = ? AND cash_status = 'PENDING'", [current.business_id, row.sale_id]);
    const [confirmed] = await repo.rows(db, 'SELECT m.confirmed_at, u.full_name FROM cash_movements m JOIN users u ON u.business_id = m.business_id AND u.id = m.confirmed_by_user_id WHERE m.business_id = ? AND m.id = ?', [current.business_id, id]);
    const saleId = isCustomerPayment ? row.payment_sale_id : row.sale_id;
    await repo.audit(db, current, 'CONFIRM_NONCASH_PAYMENT', 'cash_movements', id, { saleId: saleId === null ? null : String(saleId), customerPaymentId: isCustomerPayment ? String(row.payment_id) : null, paymentMethod: method, amount: row.amount, operationKey: data.operationKey });
    const movement = { id: String(id), businessId: String(current.business_id), saleId: saleId === null ? null : String(saleId), paymentMethod: method, amount: row.amount, status: 'CONFIRMED', confirmedBy: confirmed.full_name, confirmedAt: confirmed.confirmed_at };
    if (isCustomerPayment) return { kind: 'CONFIRM_PAYMENT', movement, payment: { id: String(row.payment_id), businessId: String(current.business_id), saleId: String(saleId), clientId: String(row.client_id), invoiceNumber: row.invoice_number, amount: row.amount, paymentMethod: method, status: 'POSTED', createdAt: row.created_at } };
    return { kind: 'CONFIRM_PAYMENT', movement, sale: await getSale(db, current, String(row.sale_id)) };
  }));

  const cashOverview = (session) => work(session, 'cash', async (db, current) => {
    const salesFlow = await flow(db, current);
    const openCash = await cashRow(db, current);
    const sessionId = openCash ? String(openCash.id) : null;
    const openedAt = openCash?.opened_at || null;
    const currentSession = openCash ? [String(openCash.id)] : [];
    const historicalSession = openCash ? [String(openCash.id)] : [];
    const [grouped, operationSales, operationCollections, collections, pendingSales, pendingAbonos, historicalPendingSales, historicalPendingAbonos, orderRows, historicalOrderRows, movements] = await Promise.all([
      openCash ? repo.rows(db, "SELECT u.id AS user_id, u.full_name, COUNT(*) AS sale_count, SUM(CASE WHEN s.payment_method = 'CASH' THEN s.total ELSE 0 END) AS cash_total, SUM(CASE WHEN s.payment_method = 'CARD' THEN s.total ELSE 0 END) AS card_total, SUM(CASE WHEN s.payment_method = 'TRANSFER' THEN s.total ELSE 0 END) AS transfer_total, SUM(CASE WHEN s.payment_method = 'CREDIT' THEN s.total ELSE 0 END) AS credit_total, SUM(s.total) AS total_sales FROM sales s JOIN users u ON u.business_id = s.business_id AND u.id = s.user_id WHERE s.business_id = ? AND s.cash_session_id = ? AND s.status = 'COMPLETED' GROUP BY u.id, u.full_name ORDER BY u.full_name", [current.business_id, ...currentSession]) : Promise.resolve([]),
      repo.rows(db, openCash ? "SELECT s.id, s.cash_session_id, s.invoice_number, s.payment_method, s.total, s.cash_status, s.created_at, u.full_name AS seller FROM sales s JOIN users u ON u.business_id = s.business_id AND u.id = s.user_id WHERE s.business_id = ? AND s.cash_session_id = ? AND s.status = 'COMPLETED' AND s.cash_status <> 'PENDING' ORDER BY s.id DESC LIMIT 200" : "SELECT s.id, s.cash_session_id, s.invoice_number, s.payment_method, s.total, s.cash_status, s.created_at, u.full_name AS seller FROM sales s JOIN users u ON u.business_id = s.business_id AND u.id = s.user_id WHERE s.business_id = ? AND s.status = 'COMPLETED' AND s.cash_status <> 'PENDING' ORDER BY s.id DESC LIMIT 200", openCash ? [current.business_id, ...currentSession] : [current.business_id]),
      repo.rows(db, openCash ? "SELECT p.id, p.cash_session_id, p.sale_id, p.amount, p.payment_method, p.status, p.created_at, u.full_name AS seller, s.invoice_number, c.name AS client_name FROM customer_payments p JOIN sales s ON s.business_id = p.business_id AND s.id = p.sale_id JOIN clients c ON c.business_id = p.business_id AND c.id = p.client_id JOIN users u ON u.business_id = p.business_id AND u.id = p.user_id WHERE p.business_id = ? AND p.cash_session_id = ? AND p.status = 'POSTED' ORDER BY p.id DESC LIMIT 200" : "SELECT p.id, p.cash_session_id, p.sale_id, p.amount, p.payment_method, p.status, p.created_at, u.full_name AS seller, s.invoice_number, c.name AS client_name FROM customer_payments p JOIN sales s ON s.business_id = p.business_id AND s.id = p.sale_id JOIN clients c ON c.business_id = p.business_id AND c.id = p.client_id JOIN users u ON u.business_id = p.business_id AND u.id = p.user_id WHERE p.business_id = ? AND p.status = 'POSTED' ORDER BY p.id DESC LIMIT 200", openCash ? [current.business_id, ...currentSession] : [current.business_id]),
      openCash ? repo.rows(db, "SELECT p.user_id, SUM(p.amount) AS total FROM customer_payments p WHERE p.business_id = ? AND p.cash_session_id = ? AND p.status = 'POSTED' GROUP BY p.user_id", [current.business_id, ...currentSession]) : Promise.resolve([]),
      openCash ? repo.rows(db, "SELECT m.id, m.cash_session_id, m.sale_id, m.amount, m.created_at, s.invoice_number, s.payment_method, seller.full_name AS seller, NULL AS client_name, 'SALE' AS kind FROM cash_movements m JOIN sales s ON s.business_id = m.business_id AND s.id = m.sale_id JOIN users seller ON seller.business_id = s.business_id AND seller.id = s.user_id WHERE m.business_id = ? AND m.cash_session_id = ? AND m.type = 'SALE' AND m.status = 'PENDING' AND s.status = 'COMPLETED' ORDER BY m.id DESC LIMIT 100", [current.business_id, ...currentSession]) : Promise.resolve([]),
      openCash ? repo.rows(db, "SELECT m.id, m.cash_session_id, p.sale_id, m.amount, m.created_at, s.invoice_number, p.payment_method, u.full_name AS seller, c.name AS client_name, 'CUSTOMER_PAYMENT' AS kind FROM cash_movements m JOIN customer_payments p ON p.business_id = m.business_id AND p.id = m.customer_payment_id JOIN sales s ON s.business_id = p.business_id AND s.id = p.sale_id JOIN clients c ON c.business_id = p.business_id AND c.id = p.client_id JOIN users u ON u.business_id = p.business_id AND u.id = p.user_id WHERE m.business_id = ? AND m.cash_session_id = ? AND m.type = 'CUSTOMER_PAYMENT' AND m.status = 'PENDING' AND p.status = 'PENDING' ORDER BY m.id DESC LIMIT 100", [current.business_id, ...currentSession]) : Promise.resolve([]),
      openCash ? repo.rows(db, "SELECT m.id, m.cash_session_id, m.sale_id, m.amount, m.created_at, s.invoice_number, s.payment_method, seller.full_name AS seller, NULL AS client_name, 'SALE' AS kind FROM cash_movements m JOIN sales s ON s.business_id = m.business_id AND s.id = m.sale_id JOIN users seller ON seller.business_id = s.business_id AND seller.id = s.user_id WHERE m.business_id = ? AND (m.cash_session_id IS NULL OR m.cash_session_id <> ?) AND m.type = 'SALE' AND m.status = 'PENDING' AND s.status = 'COMPLETED' ORDER BY m.id DESC LIMIT 100", [current.business_id, ...historicalSession]) : repo.rows(db, "SELECT m.id, m.cash_session_id, m.sale_id, m.amount, m.created_at, s.invoice_number, s.payment_method, seller.full_name AS seller, NULL AS client_name, 'SALE' AS kind FROM cash_movements m JOIN sales s ON s.business_id = m.business_id AND s.id = m.sale_id JOIN users seller ON seller.business_id = s.business_id AND seller.id = s.user_id WHERE m.business_id = ? AND m.type = 'SALE' AND m.status = 'PENDING' AND s.status = 'COMPLETED' ORDER BY m.id DESC LIMIT 100", [current.business_id]),
      openCash ? repo.rows(db, "SELECT m.id, m.cash_session_id, p.sale_id, m.amount, m.created_at, s.invoice_number, p.payment_method, u.full_name AS seller, c.name AS client_name, 'CUSTOMER_PAYMENT' AS kind FROM cash_movements m JOIN customer_payments p ON p.business_id = m.business_id AND p.id = m.customer_payment_id JOIN sales s ON s.business_id = p.business_id AND s.id = p.sale_id JOIN clients c ON c.business_id = p.business_id AND c.id = p.client_id JOIN users u ON u.business_id = p.business_id AND u.id = p.user_id WHERE m.business_id = ? AND (m.cash_session_id IS NULL OR m.cash_session_id <> ?) AND m.type = 'CUSTOMER_PAYMENT' AND m.status = 'PENDING' AND p.status = 'PENDING' ORDER BY m.id DESC LIMIT 100", [current.business_id, ...historicalSession]) : repo.rows(db, "SELECT m.id, m.cash_session_id, p.sale_id, m.amount, m.created_at, s.invoice_number, p.payment_method, u.full_name AS seller, c.name AS client_name, 'CUSTOMER_PAYMENT' AS kind FROM cash_movements m JOIN customer_payments p ON p.business_id = m.business_id AND p.id = m.customer_payment_id JOIN sales s ON s.business_id = p.business_id AND s.id = p.sale_id JOIN clients c ON c.business_id = p.business_id AND c.id = p.client_id JOIN users u ON u.business_id = p.business_id AND u.id = p.user_id WHERE m.business_id = ? AND m.type = 'CUSTOMER_PAYMENT' AND m.status = 'PENDING' AND p.status = 'PENDING' ORDER BY m.id DESC LIMIT 100", [current.business_id]),
      openCash ? repo.rows(db, "SELECT id FROM sale_orders WHERE business_id = ? AND status = 'PENDING' AND created_at >= ? ORDER BY id LIMIT 100", [current.business_id, openedAt]) : Promise.resolve([]),
      openCash ? repo.rows(db, "SELECT id FROM sale_orders WHERE business_id = ? AND status = 'PENDING' AND created_at < ? ORDER BY id LIMIT 100", [current.business_id, openedAt]) : repo.rows(db, "SELECT id FROM sale_orders WHERE business_id = ? AND status = 'PENDING' ORDER BY id LIMIT 100", [current.business_id]),
      repo.rows(db, openCash ? 'SELECT m.id, m.cash_session_id, m.type, m.direction, m.amount, m.sale_id, m.customer_payment_id, m.description, m.status, m.created_at, m.confirmed_at, u.full_name AS user_name, z.full_name AS confirmed_by_name, COALESCE(s.payment_method, p.payment_method) AS payment_method, s.invoice_number, p.sale_id AS payment_sale_id, c.name AS client_name FROM cash_movements m JOIN users u ON u.business_id = m.business_id AND u.id = m.user_id LEFT JOIN users z ON z.business_id = m.business_id AND z.id = m.confirmed_by_user_id LEFT JOIN sales s ON s.business_id = m.business_id AND s.id = m.sale_id LEFT JOIN customer_payments p ON p.business_id = m.business_id AND p.id = m.customer_payment_id LEFT JOIN clients c ON c.business_id = p.business_id AND c.id = p.client_id WHERE m.business_id = ? AND m.cash_session_id = ? ORDER BY m.id DESC LIMIT 100' : 'SELECT m.id, m.cash_session_id, m.type, m.direction, m.amount, m.sale_id, m.customer_payment_id, m.description, m.status, m.created_at, m.confirmed_at, u.full_name AS user_name, z.full_name AS confirmed_by_name, COALESCE(s.payment_method, p.payment_method) AS payment_method, s.invoice_number, p.sale_id AS payment_sale_id, c.name AS client_name FROM cash_movements m JOIN users u ON u.business_id = m.business_id AND u.id = m.user_id LEFT JOIN users z ON z.business_id = m.business_id AND z.id = m.confirmed_by_user_id LEFT JOIN sales s ON s.business_id = m.business_id AND s.id = m.sale_id LEFT JOIN customer_payments p ON p.business_id = m.business_id AND p.id = m.customer_payment_id LEFT JOIN clients c ON c.business_id = p.business_id AND c.id = p.client_id WHERE m.business_id = ? ORDER BY m.id DESC LIMIT 200', openCash ? [current.business_id, ...currentSession] : [current.business_id])
    ]);
    const collectionMap = new Map(collections.map(row => [String(row.user_id), row.total || '0.00']));
    const salesByUser = grouped.map(row => ({ userId: String(row.user_id), userName: row.full_name, saleCount: Number(row.sale_count), cash: row.cash_total || '0.00', card: row.card_total || '0.00', transfer: row.transfer_total || '0.00', credit: row.credit_total || '0.00', collections: collectionMap.get(String(row.user_id)) || '0.00', total: row.total_sales || '0.00' }));
    const currentSummary = openCash ? await cashPublic(db, current, openCash, false) : null;
    const mapPending = rows => rows.map(row => ({ id: String(row.id), cashSessionId: row.cash_session_id === null ? null : String(row.cash_session_id), saleId: String(row.sale_id), invoiceNumber: row.invoice_number, clientName: row.client_name, paymentMethod: row.payment_method, amount: row.amount, seller: row.seller, createdAt: row.created_at, status: 'PENDING', kind: row.kind }));
    const mapOperationSales = rows => rows.map(row => ({ id: String(row.id), cashSessionId: row.cash_session_id === null ? null : String(row.cash_session_id), invoiceNumber: row.invoice_number, paymentMethod: row.payment_method, amount: row.total, cashStatus: row.cash_status, seller: row.seller, createdAt: row.created_at, status: 'COMPLETED', kind: 'SALE' }));
    const mapOperationCollections = rows => rows.map(row => ({ id: String(row.id), cashSessionId: row.cash_session_id === null ? null : String(row.cash_session_id), saleId: String(row.sale_id), invoiceNumber: row.invoice_number, clientName: row.client_name, paymentMethod: row.payment_method, amount: row.amount, seller: row.seller, createdAt: row.created_at, status: row.status, kind: 'CUSTOMER_PAYMENT' }));
    const pendingPayments = mapPending(openCash ? [...pendingSales, ...pendingAbonos] : [...historicalPendingSales, ...historicalPendingAbonos]);
    const pendingHistoricalPayments = openCash ? mapPending([...historicalPendingSales, ...historicalPendingAbonos]) : [];
    const pendingOrders = [];
    for (const row of orderRows) pendingOrders.push(await getOrder(db, current, String(row.id)));
    const pendingHistoricalOrders = [];
    for (const row of historicalOrderRows) pendingHistoricalOrders.push(await getOrder(db, current, String(row.id)));
    if (!openCash) { pendingOrders.push(...pendingHistoricalOrders); pendingHistoricalOrders.length = 0; }
    return { businessId: String(current.business_id), salesFlow, salesByUser, operationSales: mapOperationSales(operationSales), operationCollections: mapOperationCollections(operationCollections), pendingPayments, pendingOrders,
      pendingHistoricalPayments, pendingHistoricalOrders, currentCashSessionId: sessionId, currentSessionOpenedAt: openedAt,
      movements: movements.map(row => ({ id: String(row.id), cashSessionId: row.cash_session_id === null ? null : String(row.cash_session_id), type: row.type, direction: row.direction, amount: row.amount, saleId: row.payment_sale_id ? String(row.payment_sale_id) : row.sale_id === null ? null : String(row.sale_id), customerPaymentId: row.customer_payment_id === null ? null : String(row.customer_payment_id), clientName: row.client_name, description: row.description, status: row.status, paymentMethod: row.payment_method, invoiceNumber: row.invoice_number, userName: row.user_name, confirmedBy: row.confirmed_by_name, createdAt: row.created_at, confirmedAt: row.confirmed_at })),
      expectedAmount: currentSummary?.expectedAmount || '0.00', customerCollections: collections.reduce((sum, row) => sum + Number(row.total || 0), 0).toFixed(2), lastDifference: '0.00' };
  });

  const currentCash = (session, full = false) => work(session, full ? 'cash' : 'sales', async (db, current) => cashPublic(db, current, await cashRow(db, current), full));
  const cashHistory = (session, options) => work(session, 'cash', async (db, current) => {
    const rows = await repo.rows(db, 'SELECT id FROM cash_sessions WHERE business_id = ? ORDER BY id DESC LIMIT ? OFFSET ?', [current.business_id, options.limit, options.offset]);
    const result = []; for (const row of rows) result.push(await cashPublic(db, current, await cashRow(db, current, String(row.id)))); return result;
  });
  const openCash = (session, data) => work(session, 'cash', (db, current) => once(db, current, 'OPEN_CASH', data, async () => {
    if (await cashRow(db, current)) throw httpError(409, 'CASH_ALREADY_OPEN');
    const result = await repo.rows(db, 'INSERT INTO cash_sessions (business_id, opened_by, opening_amount) VALUES (?, ?, ?)', [current.business_id, current.user_id, data.openingAmount]);
    await repo.audit(db, current, 'OPEN_CASH', 'cash_sessions', result.insertId, { openingAmount: data.openingAmount });
    return { kind: 'OPEN_CASH', cash: await cashPublic(db, current, await cashRow(db, current, String(result.insertId))) };
  }));
  const closeCash = (session, id, data) => work(session, 'cash', (db, current) => once(db, current, 'CLOSE_CASH', { cashId: id, ...data }, async () => {
    const cash = await cashRow(db, current, id);
    if (!cash || cash.status !== 'OPEN') throw httpError(409, 'CASH_CLOSED');
    const summary = await cashPublic(db, current, cash);
    const difference = fixed(units(data.countedAmount) - units(summary.expectedAmount), 2);
    await repo.rows(db, "UPDATE cash_sessions SET status = 'CLOSED', closed_by = ?, counted_amount = ?, expected_amount = ?, difference = ?, closed_at = UTC_TIMESTAMP(3) WHERE business_id = ? AND id = ?", [current.user_id, data.countedAmount, summary.expectedAmount, difference, current.business_id, id]);
    await repo.audit(db, current, 'CLOSE_CASH', 'cash_sessions', id, { expectedAmount: summary.expectedAmount, countedAmount: data.countedAmount, difference });
    return { kind: 'CLOSE_CASH', cash: await cashPublic(db, current, await cashRow(db, current, id)) };
  }));
  async function recoverResult(db, current, row) {
    const result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
    if (result.sale) result.sale = await getSale(db, current, result.sale.id);
    if (result.order) result.order = await getOrder(db, current, result.order.id);
    return result;
  }
  const operation = (session, key) => work(session, 'sales', async (db, current) => {
    const [row] = await repo.rows(db, 'SELECT user_id, result FROM pos_operations WHERE business_id = ? AND operation_key = ?', [current.business_id, key]);
    if (!row || String(row.user_id) !== String(current.user_id)) throw httpError(404, 'OPERATION_NOT_FOUND');
    return recoverResult(db, current, row);
  });
  const list = (session, options) => work(session, 'history', async (db, current) => {
    const rows = await repo.rows(db, 'SELECT id FROM sales WHERE business_id = ?' + (options.maxId ? ' AND id <= ?' : '') + ' ORDER BY id DESC LIMIT ? OFFSET ?', [current.business_id, ...(options.maxId ? [options.maxId] : []), options.limit, options.offset]);
    const result = []; for (const row of rows) result.push(await getSale(db, current, String(row.id))); return result;
  });
  const get = (session, id) => work(session, 'history', (db, current) => getSale(db, current, id));
  const resolveOperation = (session, key) => work(session, 'sales', async (db, current) => {
    const [row] = await repo.rows(db, 'SELECT user_id, result FROM pos_operations WHERE business_id = ? AND operation_key = ? FOR UPDATE', [current.business_id, key]);
    if (row) { if (String(row.user_id) !== String(current.user_id)) throw httpError(404, 'OPERATION_NOT_FOUND'); return recoverResult(db, current, row); }
    const result = { kind: 'ABANDONED', businessId: String(current.business_id) };
    await repo.rows(db, 'INSERT INTO pos_operations (business_id, operation_key, user_id, kind, request_hash, result) VALUES (?, ?, ?, ?, ?, ?)', [current.business_id, key, current.user_id, 'ABANDONED', digest({ key }), JSON.stringify(result)]);
    await repo.audit(db, current, 'RESOLVE_OPERATION', 'businesses', current.business_id, { operationKey: key, kind: 'ABANDONED' });
    return result;
  });
  return { quote, nextInvoiceNumber, create, cancel, currentCash, cashHistory, openCash, closeCash, cashOverview, confirmPayment, getSalesFlow, setSalesFlow, createOrder, quoteOrder, chargeOrder, cancelOrder, operation, resolveOperation, list, get };
}
module.exports = { createSalesService };
