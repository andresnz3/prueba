'use strict';
const { createHash } = require('node:crypto');
const { httpError } = require('../middleware/errors');
const { fixed, units } = require('./inventory-values');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const textSearch = value => '%' + value.replace(/[\\%_]/g, '\\$&') + '%';

function createProcurementService({ repo, auth, config }) {
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
      if (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_FIELD_ERROR' || error.code === 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD') throw httpError(503, 'PROCUREMENT_MIGRATION_REQUIRED');
      if (error.code === 'ER_DUP_ENTRY') throw httpError(409, 'PURCHASE_DUPLICATE');
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
  const openCash = async (db, current) => {
    const rows = await repo.rows(db, "SELECT * FROM cash_sessions WHERE business_id = ? AND status = 'OPEN' ORDER BY id DESC FOR UPDATE", [current.business_id]);
    if (rows.length > 1) throw httpError(409, 'CASH_AMBIGUOUS');
    return rows[0] || null;
  };
  async function cashBalance(db, current, cash) {
    const rows = await repo.rows(db, 'SELECT m.direction, m.amount, m.status, COALESCE(s.payment_method, cp.payment_method, sp.payment_method) AS payment_method FROM cash_movements m LEFT JOIN sales s ON s.business_id = m.business_id AND s.id = m.sale_id LEFT JOIN customer_payments cp ON cp.business_id = m.business_id AND cp.id = m.customer_payment_id LEFT JOIN supplier_payments sp ON sp.business_id = m.business_id AND sp.id = m.supplier_payment_id WHERE m.business_id = ? AND m.cash_session_id = ? FOR UPDATE', [current.business_id, String(cash.id)]);
    let balance = units(cash.opening_amount);
    for (const movement of rows) if (movement.status === 'CONFIRMED' && (!movement.payment_method || movement.payment_method === 'CASH')) balance += units(movement.amount) * (movement.direction === 'IN' ? 1n : -1n);
    return balance;
  }
  async function requirePendingPaymentMigration(db) {
    const [column] = await repo.rows(db, "SELECT COLUMN_TYPE AS columnType FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='supplier_payments' AND COLUMN_NAME='status'");
    if (!column || !String(column.columnType).includes("'PENDING'")) throw httpError(503, 'SUPPLIER_PAYMENT_MIGRATION_REQUIRED');
  }
  const money = value => value || '0.00';
  const purchaseNumber = id => 'COMP-' + String(id).padStart(6, '0');
  const supplierInvoiceNumber = row => String(row.invoice_number || '') === purchaseNumber(row.id) ? '' : String(row.invoice_number || '');
  const purchaseReference = row => purchaseNumber(row.id) + (supplierInvoiceNumber(row) ? ' · Factura proveedor ' + supplierInvoiceNumber(row) : '');
  function publicSupplier(row) {
    return { id: String(row.id), businessId: String(row.business_id), name: row.name, contact: row.contact || '', phone: row.phone || '', ruc: row.ruc || '', address: row.address || '', active: Boolean(row.active), totalPurchased: money(row.total_purchased), purchaseCount: Number(row.purchase_count || 0), debt: money(row.debt), pendingPayments: money(row.pending_payments), nextDueAt: row.next_due_at || null, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  function publicPurchase(row) {
    const balance = units(row.total) - units(row.paid || '0.00');
    const pending = units(row.pending || '0.00');
    const status = row.status === 'CANCELLED' ? 'CANCELLED' : pending > 0n ? 'PENDING_CONFIRMATION' : balance <= 0n ? 'PAID' : units(row.paid || '0.00') > 0n ? 'PARTIAL' : row.due_at && new Date(row.due_at).getTime() < Date.now() ? 'OVERDUE' : row.purchase_type === 'CREDIT' ? 'OPEN' : 'PAID';
    return { id: String(row.id), businessId: String(row.business_id), supplierId: row.supplier_id === null ? null : String(row.supplier_id), supplierName: row.supplier_name, supplierPhone: row.supplier_phone || '', purchaseNumber: purchaseNumber(row.id), supplierInvoiceNumber: supplierInvoiceNumber(row), invoiceNumber: row.invoice_number, purchaseType: row.purchase_type, subtotal: row.subtotal, tax: row.tax, total: row.total, paid: fixed(units(row.paid || '0.00'), 2), pendingPayments: fixed(pending, 2), balance: fixed(balance > 0n ? balance : 0n, 2), dueAt: row.due_at, status, createdAt: row.created_at, itemCount: Number(row.item_count || 0) };
  }
  const purchaseSelect = `SELECT p.*, s.phone AS supplier_phone,
    (SELECT COUNT(*) FROM purchase_items i WHERE i.business_id=p.business_id AND i.purchase_id=p.id) AS item_count,
    (SELECT COALESCE(SUM(CASE WHEN sp.status='POSTED' THEN sp.amount ELSE 0 END),0.00) FROM supplier_payments sp WHERE sp.business_id=p.business_id AND sp.purchase_id=p.id) AS paid,
    (SELECT COALESCE(SUM(CASE WHEN sp.status='PENDING' THEN sp.amount ELSE 0 END),0.00) FROM supplier_payments sp WHERE sp.business_id=p.business_id AND sp.purchase_id=p.id) AS pending
    FROM purchases p LEFT JOIN suppliers s ON s.business_id=p.business_id AND s.id=p.supplier_id`;
  async function getPurchase(db, current, id) {
    const [row] = await repo.rows(db, purchaseSelect + ' WHERE p.business_id = ? AND p.id = ?', [current.business_id, id]);
    if (!row) throw httpError(404, 'PURCHASE_NOT_FOUND');
    const items = await repo.rows(db, 'SELECT product_id, product_name, quantity, unit_cost, subtotal, total FROM purchase_items WHERE business_id = ? AND purchase_id = ? ORDER BY id', [current.business_id, id]);
    const payments = await repo.rows(db, 'SELECT id, amount, payment_method, status, created_at FROM supplier_payments WHERE business_id = ? AND purchase_id = ? ORDER BY id', [current.business_id, id]);
    return { ...publicPurchase(row), cancelReason: row.cancel_reason, cancelledAt: row.cancelled_at, items: items.map(item => ({ productId: String(item.product_id), name: item.product_name, quantity: item.quantity, unitCost: item.unit_cost, subtotal: item.subtotal, total: item.total })), payments: payments.map(item => ({ id: String(item.id), amount: item.amount, paymentMethod: item.payment_method, status: item.status, createdAt: item.created_at })) };
  }
  const suppliersBase = `SELECT s.*,
    (SELECT COALESCE(SUM(p.total),0.00) FROM purchases p WHERE p.business_id=s.business_id AND p.supplier_id=s.id AND p.status='COMPLETED') AS total_purchased,
    (SELECT COUNT(*) FROM purchases p WHERE p.business_id=s.business_id AND p.supplier_id=s.id AND p.status='COMPLETED') AS purchase_count,
    (SELECT COALESCE(SUM(p.total),0.00) FROM purchases p WHERE p.business_id=s.business_id AND p.supplier_id=s.id AND p.purchase_type='CREDIT' AND p.status='COMPLETED') -
    (SELECT COALESCE(SUM(sp.amount),0.00) FROM supplier_payments sp JOIN purchases paid_purchase ON paid_purchase.business_id=sp.business_id AND paid_purchase.id=sp.purchase_id WHERE sp.business_id=s.business_id AND sp.supplier_id=s.id AND paid_purchase.purchase_type='CREDIT' AND sp.status='POSTED') AS debt,
    (SELECT COALESCE(SUM(sp.amount),0.00) FROM supplier_payments sp JOIN purchases pending_purchase ON pending_purchase.business_id=sp.business_id AND pending_purchase.id=sp.purchase_id WHERE sp.business_id=s.business_id AND sp.supplier_id=s.id AND pending_purchase.purchase_type='CREDIT' AND sp.status='PENDING') AS pending_payments,
    (SELECT MIN(p.due_at) FROM purchases p WHERE p.business_id=s.business_id AND p.supplier_id=s.id AND p.purchase_type='CREDIT' AND p.status='COMPLETED' AND p.due_at IS NOT NULL AND p.total > (SELECT COALESCE(SUM(sp.amount),0.00) FROM supplier_payments sp WHERE sp.business_id=p.business_id AND sp.purchase_id=p.id AND sp.status='POSTED')) AS next_due_at
    FROM suppliers s`;
  const listSuppliers = (session, options, module = 'suppliers') => work(session, module, async (db, current) => {
    const query = options.q ? textSearch(options.q) : null;
    const rows = await repo.rows(db, suppliersBase + ' WHERE s.business_id = ? AND (? IS NULL OR s.name LIKE ? OR COALESCE(s.contact,\'\') LIKE ? OR COALESCE(s.phone,\'\') LIKE ? OR COALESCE(s.ruc,\'\') LIKE ?) ORDER BY s.active DESC, s.name, s.id LIMIT ? OFFSET ?', [current.business_id, query, query, query, query, query, options.limit, options.offset]);
    return rows.map(publicSupplier);
  });
  const getSupplier = (session, id) => work(session, 'suppliers', async (db, current) => {
    const [row] = await repo.rows(db, suppliersBase + ' WHERE s.business_id = ? AND s.id = ?', [current.business_id, id]);
    if (!row) throw httpError(404, 'SUPPLIER_NOT_FOUND');
    return publicSupplier(row);
  });
  const createSupplier = (session, data, module = 'suppliers') => work(session, module, async (db, current) => {
    await repo.rows(db, 'SELECT id FROM businesses WHERE id = ? FOR UPDATE', [current.business_id]);
    const [duplicate] = await repo.rows(db, 'SELECT id FROM suppliers WHERE business_id = ? AND LOWER(name) = LOWER(?) LIMIT 1 FOR UPDATE', [current.business_id, data.name]);
    if (duplicate) throw httpError(409, 'SUPPLIER_DUPLICATE');
    const result = await repo.rows(db, 'INSERT INTO suppliers (business_id, name, contact, phone, ruc, address, active) VALUES (?, ?, ?, ?, ?, ?, TRUE)', [current.business_id, data.name, data.contact, data.phone, data.ruc, data.address]);
    const [row] = await repo.rows(db, suppliersBase + ' WHERE s.business_id = ? AND s.id = ?', [current.business_id, String(result.insertId)]);
    await repo.audit(db, current, 'CREATE_SUPPLIER', 'suppliers', result.insertId, { name: data.name });
    return { supplier: publicSupplier(row) };
  });
  const updateSupplier = (session, id, data) => work(session, 'suppliers', async (db, current) => {
    const [row] = await repo.rows(db, 'SELECT * FROM suppliers WHERE business_id = ? AND id = ? FOR UPDATE', [current.business_id, id]);
    if (!row) throw httpError(404, 'SUPPLIER_NOT_FOUND');
    if (data.name && data.name.toLocaleLowerCase('es') !== row.name.toLocaleLowerCase('es')) {
      const [duplicate] = await repo.rows(db, 'SELECT id FROM suppliers WHERE business_id = ? AND LOWER(name) = LOWER(?) AND id <> ? LIMIT 1', [current.business_id, data.name, id]);
      if (duplicate) throw httpError(409, 'SUPPLIER_DUPLICATE');
    }
    const fields = Object.keys(data), columns = { name: 'name', contact: 'contact', phone: 'phone', ruc: 'ruc', address: 'address' };
    await repo.rows(db, 'UPDATE suppliers SET ' + fields.map(field => columns[field] + ' = ?').join(', ') + ' WHERE business_id = ? AND id = ?', [...fields.map(field => data[field]), current.business_id, id]);
    const [updated] = await repo.rows(db, suppliersBase + ' WHERE s.business_id = ? AND s.id = ?', [current.business_id, id]);
    await repo.audit(db, current, 'UPDATE_SUPPLIER', 'suppliers', id, { fields });
    return { supplier: publicSupplier(updated) };
  });
  const setSupplierActive = (session, id, active) => work(session, 'suppliers', async (db, current) => {
    const [row] = await repo.rows(db, 'SELECT id FROM suppliers WHERE business_id = ? AND id = ? FOR UPDATE', [current.business_id, id]);
    if (!row) throw httpError(404, 'SUPPLIER_NOT_FOUND');
    await repo.rows(db, 'UPDATE suppliers SET active = ? WHERE business_id = ? AND id = ?', [active, current.business_id, id]);
    const [updated] = await repo.rows(db, suppliersBase + ' WHERE s.business_id = ? AND s.id = ?', [current.business_id, id]);
    await repo.audit(db, current, active ? 'ACTIVATE_SUPPLIER' : 'DEACTIVATE_SUPPLIER', 'suppliers', id, {});
    return publicSupplier(updated);
  });
  const purchaseProducts = (session, options) => work(session, 'purchases', async (db, current) => {
    const search = options.q ? textSearch(options.q) : null;
    const rows = await repo.rows(db, 'SELECT id,business_id,barcode,name,category,cost,retail_margin,wholesale_margin,retail_price,wholesale_price,stock,min_stock,tax_rate,image,active,deleted FROM products WHERE business_id=? AND deleted=FALSE AND active=TRUE AND (? IS NULL OR name LIKE ? OR barcode LIKE ? OR category LIKE ?) ORDER BY name,id LIMIT ? OFFSET ?', [current.business_id, search, search, search, search, options.limit, options.offset]);
    return rows.map(row => ({ id: String(row.id), businessId: String(row.business_id), business_id: String(row.business_id), barcode: row.barcode, name: row.name, category: row.category, cost: Number(row.cost), marginRetail: Number(row.retail_margin), marginWholesale: Number(row.wholesale_margin), retailPrice: Number(row.retail_price), wholesalePrice: Number(row.wholesale_price), stock: Number(row.stock), minStock: Number(row.min_stock), taxRate: Number(row.tax_rate), image: row.image, active: Boolean(row.active), deleted: Boolean(row.deleted) }));
  });
  const createPurchaseProduct = (session, data) => work(session, 'purchases', async (db, current) => {
    const [duplicate] = await repo.rows(db, 'SELECT id FROM products WHERE business_id = ? AND barcode = ? LIMIT 1 FOR UPDATE', [current.business_id, data.barcode]);
    if (duplicate) throw httpError(409, 'BARCODE_EXISTS');
    const values = { ...data, stock: '0.000' };
    const columns = ['barcode', 'name', 'category', 'cost', 'retail_margin', 'wholesale_margin', 'retail_price', 'wholesale_price', 'stock', 'min_stock', 'tax_rate', 'image', 'active'];
    const props = ['barcode', 'name', 'category', 'cost', 'marginRetail', 'marginWholesale', 'retailPrice', 'wholesalePrice', 'stock', 'minStock', 'taxRate', 'image', 'active'];
    const result = await repo.rows(db, 'INSERT INTO products (business_id,' + columns.join(',') + ') VALUES (' + ['?', ...columns.map(() => '?')].join(',') + ')', [current.business_id, ...props.map(key => values[key])]);
    const id = String(result.insertId);
    const [row] = await repo.rows(db, 'SELECT id,business_id,barcode,name,category,cost,retail_margin,wholesale_margin,retail_price,wholesale_price,stock,min_stock,tax_rate,image,active,deleted FROM products WHERE business_id=? AND id=?', [current.business_id, id]);
    await repo.audit(db, current, 'CREATE_PRODUCT_FROM_PURCHASE', 'products', id, { barcode: data.barcode, name: data.name });
    return { product: { id, businessId: String(row.business_id), barcode: row.barcode, name: row.name, category: row.category, cost: row.cost, marginRetail: row.retail_margin, marginWholesale: row.wholesale_margin, retailPrice: row.retail_price, wholesalePrice: row.wholesale_price, stock: row.stock, minStock: row.min_stock, taxRate: row.tax_rate, image: row.image, active: Boolean(row.active), deleted: Boolean(row.deleted) } };
  });
  const listPurchases = (session, options) => work(session, 'purchases', async (db, current) => {
    const search = options.q ? textSearch(options.q) : null;
    const rows = await repo.rows(db, purchaseSelect + ' WHERE p.business_id=? AND (? IS NULL OR p.invoice_number LIKE ? OR CONCAT(\'COMP-\',LPAD(p.id,6,\'0\')) LIKE ? OR p.supplier_name LIKE ? OR COALESCE(s.phone,\'\') LIKE ?) ORDER BY p.created_at DESC,p.id DESC LIMIT ? OFFSET ?', [current.business_id, search, search, search, search, search, options.limit, options.offset]);
    return rows.map(publicPurchase);
  });
  const getPurchaseForView = (session, id) => work(session, 'purchases', async (db, current) => getPurchase(db, current, id));
  const getPayableForView = (session, id) => work(session, 'payables', async (db, current) => {
    const purchase = await getPurchase(db, current, id);
    if (purchase.purchaseType !== 'CREDIT') throw httpError(404, 'PAYABLE_NOT_FOUND');
    return purchase;
  });
  const listPayables = (session, options) => work(session, 'payables', async (db, current) => {
    const search = options.q ? textSearch(options.q) : null;
    const rows = await repo.rows(db, purchaseSelect + " WHERE p.business_id=? AND p.purchase_type='CREDIT' AND p.status='COMPLETED' AND p.total > (SELECT COALESCE(SUM(sp.amount),0.00) FROM supplier_payments sp WHERE sp.business_id=p.business_id AND sp.purchase_id=p.id AND sp.status='POSTED') AND (? IS NULL OR p.invoice_number LIKE ? OR CONCAT('COMP-',LPAD(p.id,6,'0')) LIKE ? OR p.supplier_name LIKE ? OR COALESCE(s.phone,'') LIKE ?) ORDER BY (p.due_at IS NULL) ASC,p.due_at ASC,p.created_at DESC,p.id DESC LIMIT ? OFFSET ?", [current.business_id, search, search, search, search, search, options.limit, options.offset]);
    return rows.map(publicPurchase);
  });
  const statement = (session, id, options) => work(session, 'suppliers', async (db, current) => {
    const [supplier] = await repo.rows(db, suppliersBase + ' WHERE s.business_id=? AND s.id=?', [current.business_id, id]);
    if (!supplier) throw httpError(404, 'SUPPLIER_NOT_FOUND');
    const purchases = await repo.rows(db, purchaseSelect + ' WHERE p.business_id=? AND p.supplier_id=? ORDER BY p.created_at,p.id LIMIT ? OFFSET ?', [current.business_id, id, options.limit, options.offset]);
    const payments = await repo.rows(db, 'SELECT sp.id,sp.purchase_id,sp.amount,sp.payment_method,sp.status,sp.created_at,p.id AS purchase_id_ref,p.invoice_number FROM supplier_payments sp LEFT JOIN purchases p ON p.business_id=sp.business_id AND p.id=sp.purchase_id WHERE sp.business_id=? AND sp.supplier_id=? ORDER BY sp.created_at,sp.id LIMIT ? OFFSET ?', [current.business_id, id, options.limit, options.offset]);
    const ledger = [
      ...purchases.map(row => {
        const total = units(row.total || '0.00');
        const paidConfirmed = units(row.paid || '0.00');
        const pendingPayments = units(row.pending || '0.00');
        const balance = total > paidConfirmed ? total - paidConfirmed : 0n;
        const availableBalance = balance > pendingPayments ? balance - pendingPayments : 0n;
        return {
          date: row.created_at,
          kind: 'PURCHASE',
          reference: purchaseReference(row),
          supplierInvoiceNumber: supplierInvoiceNumber(row) || null,
          description: row.status === 'CANCELLED' ? 'Factura de compra anulada' : row.purchase_type === 'CREDIT' ? 'Factura de compra a crédito' : 'Factura de compra al contado',
          charge: row.status === 'CANCELLED' ? '0.00' : row.total,
          paid: '0.00',
          status: row.status,
          purchaseId: String(row.id),
          purchaseType: row.purchase_type,
          total: fixed(total, 2),
          paidConfirmed: fixed(paidConfirmed, 2),
          pendingPayments: fixed(pendingPayments, 2),
          balance: fixed(balance, 2),
          availableBalance: fixed(availableBalance, 2),
          canPay: row.purchase_type === 'CREDIT' && row.status !== 'CANCELLED' && balance > 0n && availableBalance > 0n
        };
      }),
      ...payments.map(row => {
        const supplierInvoice = row.purchase_id_ref === null ? '' : supplierInvoiceNumber({ id: row.purchase_id_ref, invoice_number: row.invoice_number });
        return { date: row.created_at, kind: 'PAYMENT', reference: row.purchase_id_ref === null ? 'Pago a proveedor' : 'Pago ' + purchaseNumber(row.purchase_id_ref) + (supplierInvoice ? ' · Factura proveedor ' + supplierInvoice : ''), supplierInvoiceNumber: supplierInvoice || null, description: row.payment_method, charge: '0.00', paid: row.status === 'POSTED' ? row.amount : '0.00', pending: row.status === 'PENDING' ? row.amount : '0.00', status: row.status, purchaseId: row.purchase_id === null ? null : String(row.purchase_id) };
      })
    ].sort((a, b) => new Date(a.date) - new Date(b.date));
    let balance = 0n;
    for (const entry of ledger) {
      balance += units(entry.charge) - units(entry.paid);
      entry.runningBalance = fixed(balance, 2);
    }
    return { supplier: publicSupplier(supplier), entries: ledger };
  });
  const recordPurchase = (session, data) => work(session, 'purchases', (db, current) => once(db, current, 'PURCHASE', data, async () => {
    const [supplier] = await repo.rows(db, 'SELECT * FROM suppliers WHERE business_id=? AND id=? FOR UPDATE', [current.business_id, data.supplierId]);
    if (!supplier) throw httpError(404, 'SUPPLIER_NOT_FOUND');
    if (!supplier.active) throw httpError(409, 'SUPPLIER_INACTIVE');
    const externalInvoice = data.supplierInvoiceNumber || data.invoiceNumber || null;
    if (externalInvoice) {
      const [duplicate] = await repo.rows(db, 'SELECT id FROM purchases WHERE business_id=? AND supplier_id=? AND invoice_number=? LIMIT 1 FOR UPDATE', [current.business_id, String(supplier.id), externalInvoice]);
      if (duplicate) throw httpError(409, 'PURCHASE_DUPLICATE');
    }
    const lines = [], products = [];
    let total = 0n;
    for (const item of data.items) {
      const [product] = await repo.rows(db, 'SELECT * FROM products WHERE business_id=? AND id=? FOR UPDATE', [current.business_id, item.productId]);
      if (!product || product.deleted) throw httpError(404, 'PRODUCT_NOT_FOUND');
      if (!product.active) throw httpError(409, 'PRODUCT_INACTIVE');
      const quantity = units(item.quantity), unitCost = units(item.unitCost);
      const subtotal = (quantity * unitCost + 500n) / 1000n;
      total += subtotal;
      lines.push({ product, item, quantity, unitCost, subtotal }); products.push(product);
    }
    if (total <= 0n || total >= 1000000000000n) throw httpError(409, 'TOTAL_LIMIT');
    let cash = null;
    if (data.purchaseType === 'CASH' && ['CASH', 'CARD', 'TRANSFER'].includes(data.paymentMethod)) {
      if (!await auth.canAccess(current, 'cash', db)) throw httpError(403, 'MODULE_FORBIDDEN');
      cash = await openCash(db, current);
      if (!cash) throw httpError(409, 'SUPPLIER_CASH_CLOSED');
      if (data.paymentMethod === 'CASH') {
        const availableCash = await cashBalance(db, current, cash);
        if (availableCash < total) throw httpError(409, 'CASH_BALANCE_INSUFFICIENT');
      }
      if (['CARD', 'TRANSFER'].includes(data.paymentMethod)) await requirePendingPaymentMigration(db);
    }
    let dueAt = null;
    if (data.purchaseType === 'CREDIT') {
      const [due] = await repo.rows(db, 'SELECT DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? DAY) AS due_at', [data.dueDays]); dueAt = due.due_at;
    }
    const subtotal = fixed(total, 2);
    const pendingReference = 'PENDING-' + data.operationKey;
    const result = await repo.rows(db, 'INSERT INTO purchases (business_id,user_id,supplier_id,supplier_name,invoice_number,purchase_type,subtotal,tax,total,due_at,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,\'COMPLETED\',UTC_TIMESTAMP(3))', [current.business_id, current.user_id, String(supplier.id), supplier.name, externalInvoice || pendingReference, data.purchaseType, subtotal, '0.00', subtotal, dueAt]);
    const purchaseId = String(result.insertId);
    const internalNumber = purchaseNumber(purchaseId);
    if (!externalInvoice) await repo.rows(db, 'UPDATE purchases SET invoice_number=? WHERE business_id=? AND id=?', [internalNumber, current.business_id, purchaseId]);
    const reference = internalNumber + (externalInvoice ? ' · Factura proveedor ' + externalInvoice : '');
    for (const line of lines) {
      const quantity = fixed(line.quantity, 3), unitCost = fixed(line.unitCost, 2), lineTotal = fixed(line.subtotal, 2);
      await repo.rows(db, 'INSERT INTO purchase_items (business_id,purchase_id,product_id,product_name,quantity,unit_cost,subtotal,total) VALUES (?,?,?,?,?,?,?,?)', [current.business_id, purchaseId, String(line.product.id), line.product.name, quantity, unitCost, lineTotal, lineTotal]);
      const stockUnits = units(line.product.stock) + line.quantity;
      if (stockUnits >= 1000000000000n) throw httpError(409, 'STOCK_LIMIT');
      const stockAfter = fixed(stockUnits, 3);
      const cost = fixed(line.unitCost, 2);
      const retailMargin = units(line.product.retail_margin), wholesaleMargin = units(line.product.wholesale_margin);
      const retailPrice = fixed(units(cost) + (units(cost) * retailMargin + 500000n) / 1000000n, 2);
      const wholesalePrice = fixed(units(cost) + (units(cost) * wholesaleMargin + 500000n) / 1000000n, 2);
      await repo.rows(db, 'UPDATE products SET stock=?,cost=?,retail_price=?,wholesale_price=? WHERE business_id=? AND id=?', [stockAfter, cost, retailPrice, wholesalePrice, current.business_id, String(line.product.id)]);
      await repo.rows(db, 'INSERT INTO inventory_movements (business_id,product_id,user_id,type,quantity,stock_after,reference_type,reference_id,reason,unit_cost,created_at) VALUES (?,?,?,\'PURCHASE\',?,?,\'purchases\',?,?,?,UTC_TIMESTAMP(3))', [current.business_id, String(line.product.id), current.user_id, quantity, stockAfter, purchaseId, 'Compra ' + reference, cost]);
    }
    if (data.purchaseType === 'CASH') {
      const status = data.paymentMethod === 'CASH' || data.paymentMethod === 'OTHER' ? 'POSTED' : 'PENDING';
      const cashSessionId = cash ? String(cash.id) : null;
      const paymentResult = await repo.rows(db, 'INSERT INTO supplier_payments (business_id,user_id,supplier_id,purchase_id,cash_session_id,amount,payment_method,status,created_at) VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))', [current.business_id, current.user_id, String(supplier.id), purchaseId, cashSessionId, subtotal, data.paymentMethod, status]);
      if (cash) await repo.rows(db, 'INSERT INTO cash_movements (business_id,cash_session_id,user_id,type,direction,amount,supplier_payment_id,reference_type,reference_id,description,status,created_at) VALUES (?,?,?,\'SUPPLIER_PAYMENT\',\'OUT\',?,?,\'purchases\',?,?,?,UTC_TIMESTAMP(3))', [current.business_id, cashSessionId, current.user_id, subtotal, String(paymentResult.insertId), purchaseId, 'Compra ' + reference + ' · ' + (data.paymentMethod === 'CASH' ? 'Efectivo' : data.paymentMethod === 'CARD' ? 'Tarjeta pendiente' : 'Transferencia pendiente'), status === 'POSTED' ? 'CONFIRMED' : 'PENDING']);
    }
    await repo.audit(db, current, 'CREATE_PURCHASE', 'purchases', purchaseId, { supplierId: String(supplier.id), purchaseNumber: internalNumber, supplierInvoiceNumber: externalInvoice, purchaseType: data.purchaseType, total: subtotal, itemCount: lines.length, operationKey: data.operationKey });
    return { kind: 'PURCHASE', purchase: await getPurchase(db, current, purchaseId) };
  }));
  const cancelPurchase = (session, id, data) => work(session, 'purchases', (db, current) => once(db, current, 'CANCEL_PURCHASE', { purchaseId: id, ...data }, async () => {
    const [purchase] = await repo.rows(db, 'SELECT * FROM purchases WHERE business_id=? AND id=? FOR UPDATE', [current.business_id, id]);
    if (!purchase) throw httpError(404, 'PURCHASE_NOT_FOUND');
    if (purchase.status !== 'COMPLETED') throw httpError(409, 'PURCHASE_CANCELLED');
    const items = await repo.rows(db, 'SELECT i.*,p.stock,p.name AS current_name FROM purchase_items i JOIN products p ON p.business_id=i.business_id AND p.id=i.product_id WHERE i.business_id=? AND i.purchase_id=? ORDER BY i.product_id FOR UPDATE', [current.business_id, id]);
    for (const item of items) if (units(item.stock) < units(item.quantity)) throw httpError(409, 'PURCHASE_CANCEL_STOCK_INSUFFICIENT');
    const paymentRows = await repo.rows(db, 'SELECT sp.*,m.id AS movement_id,m.status AS movement_status FROM supplier_payments sp LEFT JOIN cash_movements m ON m.business_id=sp.business_id AND m.supplier_payment_id=sp.id WHERE sp.business_id=? AND sp.purchase_id=? FOR UPDATE', [current.business_id, id]);
    const posted = paymentRows.filter(row => row.status === 'POSTED');
    const pending = paymentRows.filter(row => row.status === 'PENDING');
    let refund = null;
    if (posted.length) {
      if (purchase.purchase_type !== 'CASH' || posted.length !== 1 || posted[0].payment_method !== 'CASH' || !posted[0].movement_id) throw httpError(409, 'PAYMENT_ALREADY_CONFIRMED');
      refund = posted[0];
      const [sessionRow] = await repo.rows(db, "SELECT * FROM cash_sessions WHERE business_id=? AND id=? AND status='OPEN' FOR UPDATE", [current.business_id, String(refund.cash_session_id)]);
       if (!sessionRow) throw httpError(409, 'PURCHASE_CANCEL_REQUIRES_OPEN_CASH');
    }
    if (pending.length) {
      for (const payment of pending) {
        await repo.rows(db, "UPDATE supplier_payments SET status='VOID',cancelled_at=UTC_TIMESTAMP(3),cancelled_by=?,cancel_reason=? WHERE business_id=? AND id=? AND status='PENDING'", [current.user_id, data.reason, current.business_id, String(payment.id)]);
        if (payment.movement_id) await repo.rows(db, "UPDATE cash_movements SET status='VOID' WHERE business_id=? AND id=? AND status='PENDING'", [current.business_id, String(payment.movement_id)]);
      }
    }
    if (refund) {
       await repo.rows(db, 'INSERT INTO cash_movements (business_id,cash_session_id,user_id,type,direction,amount,reference_type,reference_id,reversal_of_movement_id,description,status,created_at) VALUES (?,?,?,\'REVERSAL\',\'IN\',?,\'purchases\',?,?,?,\'CONFIRMED\',UTC_TIMESTAMP(3))', [current.business_id, String(refund.cash_session_id), current.user_id, refund.amount, String(id), String(refund.movement_id), 'Devolución de compra ' + purchaseReference(purchase) + ' · ' + data.reason]);
      await repo.rows(db, "UPDATE supplier_payments SET status='VOID',cancelled_at=UTC_TIMESTAMP(3),cancelled_by=?,cancel_reason=? WHERE business_id=? AND id=? AND status='POSTED'", [current.user_id, data.reason, current.business_id, String(refund.id)]);
    }
    for (const item of items) {
      const stockAfter = fixed(units(item.stock) - units(item.quantity), 3);
      await repo.rows(db, 'UPDATE products SET stock=? WHERE business_id=? AND id=?', [stockAfter, current.business_id, String(item.product_id)]);
       await repo.rows(db, 'INSERT INTO inventory_movements (business_id,product_id,user_id,type,quantity,stock_after,reference_type,reference_id,reason,unit_cost,created_at) VALUES (?,?,?,\'PURCHASE_CANCEL\',?,?,\'purchases\',?,?,?,UTC_TIMESTAMP(3))', [current.business_id, String(item.product_id), current.user_id, fixed(-units(item.quantity), 3), stockAfter, String(id), 'Anulación ' + purchaseReference(purchase) + ' · ' + data.reason, item.unit_cost]);
    }
    await repo.rows(db, "UPDATE purchases SET status='CANCELLED',cancelled_at=UTC_TIMESTAMP(3),cancelled_by=?,cancel_reason=? WHERE business_id=? AND id=? AND status='COMPLETED'", [current.user_id, data.reason, current.business_id, id]);
    await repo.audit(db, current, 'CANCEL_PURCHASE', 'purchases', id, { reason: data.reason, operationKey: data.operationKey });
    return { kind: 'CANCEL_PURCHASE', purchase: await getPurchase(db, current, id) };
  }));
  const payInvoice = (session, id, data) => work(session, 'payables', (db, current) => once(db, current, 'SUPPLIER_PAYMENT', { purchaseId: id, ...data }, async () => {
    const [purchase] = await repo.rows(db, 'SELECT * FROM purchases WHERE business_id=? AND id=? FOR UPDATE', [current.business_id, id]);
    if (!purchase || purchase.purchase_type !== 'CREDIT') throw httpError(404, 'PAYABLE_NOT_FOUND');
    if (purchase.status !== 'COMPLETED') throw httpError(409, 'PURCHASE_CANCELLED');
    const [sum] = await repo.rows(db, "SELECT COALESCE(SUM(CASE WHEN status='POSTED' THEN amount ELSE 0 END),0.00) AS paid,COALESCE(SUM(CASE WHEN status='PENDING' THEN amount ELSE 0 END),0.00) AS pending FROM supplier_payments WHERE business_id=? AND purchase_id=?", [current.business_id, id]);
    const balance = units(purchase.total) - units(sum.paid), available = balance - units(sum.pending), amount = units(data.amount);
    if (available <= 0n) throw httpError(409, units(sum.pending) > 0n ? 'PAYMENT_CONFIRMATION_PENDING' : 'PAYABLE_ALREADY_PAID');
    if (amount > available) throw httpError(409, 'PAYMENT_EXCEEDS_BALANCE');
    const needsCash = ['CASH', 'CARD', 'TRANSFER'].includes(data.paymentMethod);
    let cash = null;
    if (needsCash) {
      if (!await auth.canAccess(current, 'cash', db)) throw httpError(403, 'MODULE_FORBIDDEN');
      cash = await openCash(db, current);
       if (!cash) throw httpError(409, 'SUPPLIER_CASH_CLOSED');
    }
    if (data.paymentMethod === 'CASH' && await cashBalance(db, current, cash) < amount) throw httpError(409, 'CASH_BALANCE_INSUFFICIENT');
    if (['CARD', 'TRANSFER'].includes(data.paymentMethod)) await requirePendingPaymentMigration(db);
    const status = ['CARD', 'TRANSFER'].includes(data.paymentMethod) ? 'PENDING' : 'POSTED';
    const result = await repo.rows(db, 'INSERT INTO supplier_payments (business_id,user_id,supplier_id,purchase_id,cash_session_id,amount,payment_method,status,created_at) VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))', [current.business_id, current.user_id, String(purchase.supplier_id), id, cash ? String(cash.id) : null, data.amount, data.paymentMethod, status]);
    const paymentId = String(result.insertId);
     const reference = purchaseReference(purchase);
     if (cash) await repo.rows(db, 'INSERT INTO cash_movements (business_id,cash_session_id,user_id,type,direction,amount,supplier_payment_id,reference_type,reference_id,description,status,created_at) VALUES (?,?,?,\'SUPPLIER_PAYMENT\',\'OUT\',?,?,\'supplier_payments\',?,?,?,UTC_TIMESTAMP(3))', [current.business_id, String(cash.id), current.user_id, data.amount, paymentId, paymentId, 'Pago ' + reference + ' · ' + (status === 'PENDING' ? data.paymentMethod + ' pendiente' : 'Efectivo'), status === 'PENDING' ? 'PENDING' : 'CONFIRMED']);
    await repo.audit(db, current, 'POST_SUPPLIER_PAYMENT', 'supplier_payments', paymentId, { purchaseId: String(id), amount: data.amount, paymentMethod: data.paymentMethod, status, operationKey: data.operationKey });
    const [user] = await repo.rows(db, 'SELECT full_name FROM users WHERE business_id=? AND id=?', [current.business_id, current.user_id]);
     return { kind: 'SUPPLIER_PAYMENT', payment: { id: paymentId, businessId: String(current.business_id), purchaseId: String(id), supplierId: String(purchase.supplier_id), purchaseNumber: purchaseNumber(id), supplierInvoiceNumber: supplierInvoiceNumber(purchase), invoiceNumber: purchase.invoice_number, amount: data.amount, paymentMethod: data.paymentMethod, status, createdAt: new Date().toISOString(), userName: user.full_name } };
  }));
  const payablesSummary = session => work(session, 'payables', async (db, current) => {
    const [summary] = await repo.rows(db, "SELECT COALESCE(SUM(p.total-(SELECT COALESCE(SUM(sp.amount),0.00) FROM supplier_payments sp WHERE sp.business_id=p.business_id AND sp.purchase_id=p.id AND sp.status='POSTED')),0.00) AS balance,COALESCE(SUM((SELECT COALESCE(SUM(sp.amount),0.00) FROM supplier_payments sp WHERE sp.business_id=p.business_id AND sp.purchase_id=p.id AND sp.status='PENDING')),0.00) AS pending FROM purchases p WHERE p.business_id=? AND p.purchase_type='CREDIT' AND p.status='COMPLETED'", [current.business_id]);
    return { businessId: String(current.business_id), balance: summary.balance || '0.00', pendingPayments: summary.pending || '0.00' };
  });
  return { listSuppliers, getSupplier, createSupplier, updateSupplier, setSupplierActive, purchaseProducts, createPurchaseProduct, listPurchases, getPurchase: getPurchaseForView, getPayable: getPayableForView, listPayables, statement, recordPurchase, cancelPurchase, payInvoice, payablesSummary };
}
module.exports = { createProcurementService };
