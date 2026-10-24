'use strict';
const { httpError } = require('../middleware/errors');
const { fixed, units } = require('./inventory-values');
const { loadSourceBusinessNames, originalInvoiceNumber } = require('./migration-sales-origin');
const { historicalPaymentMethodSql } = require('./historical-sales-values');

const money = value => fixed(units(String(value ?? '0.00')), 2);
const purchaseNumber = id => 'COMP-' + String(id).padStart(6, '0');
const supplierInvoiceNumber = row => String(row.invoiceNumber || '') === purchaseNumber(row.purchaseId || row.id) ? null : row.invoiceNumber || null;
const period = (column, range) => {
  const clauses = [];
  const values = [];
  if (range.from) { clauses.push(column + ' >= ?'); values.push(range.from); }
  if (range.until) { clauses.push(column + ' < ?'); values.push(range.until); }
  return { sql: clauses.length ? ' AND ' + clauses.join(' AND ') : '', values };
};

function createConnectedReportService({ repo, auth, config }) {
  async function permitted(db, current) {
    const [valid] = await repo.rows(db, 'SELECT id FROM sessions WHERE business_id = ? AND id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(3) AND created_at > TIMESTAMPADD(SECOND, -?, UTC_TIMESTAMP(3))', [current.business_id, current.session_id, config.absoluteSeconds]);
    if (!valid) throw httpError(401, 'INVALID_SESSION');
    if (!await auth.canAccess(current, 'reports', db)) throw httpError(403, 'MODULE_FORBIDDEN');
  }

  async function report(session, range) {
    try {
      return await repo.tenant(session, async (db, current) => {
        await permitted(db, current);
        const salesRange = period('s.created_at', range), cashRange = period('m.created_at', range), closureRange = period('c.closed_at', range);
        const salesHistorySchema = await repo.rows(db, "SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND ((TABLE_NAME = 'migration_sales_references' AND COLUMN_NAME IN ('sale_id', 'source_business_key', 'source_invoice_number')) OR (TABLE_NAME = 'migration_source_records' AND COLUMN_NAME IN ('business_id','batch_id','entity_type','target_record_id','record_status','target_table','source_payload','updated_at')) OR (TABLE_NAME = 'migration_import_batches' AND COLUMN_NAME IN ('business_id','id','package_version','status','completed_at')) OR (TABLE_NAME = 'cash_movements' AND COLUMN_NAME = 'source_method'))", []);
        const salesHistoryColumns = new Set(salesHistorySchema.map(row => row.tableName + '.' + row.columnName));
        const hasSalesReferences = salesHistoryColumns.has('migration_sales_references.sale_id') && salesHistoryColumns.has('migration_sales_references.source_business_key');
        const hasSourceInvoiceNumber = salesHistoryColumns.has('migration_sales_references.source_invoice_number');
        const hasSalesArchive = ['business_id','batch_id','entity_type','target_record_id','record_status','target_table','source_payload','updated_at'].every(column => salesHistoryColumns.has('migration_source_records.' + column))
          && ['business_id','id','package_version','status','completed_at'].every(column => salesHistoryColumns.has('migration_import_batches.' + column));
        const salesPaymentMethod = hasSalesArchive ? historicalPaymentMethodSql('s') : 's.payment_method';
        const cashSourceMethod = salesHistoryColumns.has('cash_movements.source_method') ? 'm.source_method' : 'NULL';
        const cashPaymentMethod = 'COALESCE(' + salesPaymentMethod + ', p.payment_method, sp.payment_method, e.payment_method, ' + cashSourceMethod + ')';
        const historySourceJoin = hasSalesReferences ? ' LEFT JOIN migration_sales_references r ON r.business_id = s.business_id AND r.sale_id = s.id' : '';
        const historySourceKey = hasSalesReferences ? 'r.source_business_key' : 'NULL';
        const historySourceInvoice = hasSourceInvoiceNumber ? 'r.source_invoice_number' : 'NULL';
        const [zeroInventorySchema] = await repo.rows(db, "SELECT COUNT(*) AS available FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='migration_zero_inventory_events'", []);
        const inventoryMovementRange = period('createdAt', range);
        const inventoryMovementQuery = Number(zeroInventorySchema.available) > 0
          ? {
              sql: 'SELECT * FROM (SELECT m.business_id,m.created_at AS createdAt,m.type,m.quantity,m.stock_after AS stockAfter,m.unit_cost AS unitCost,m.reason,p.name AS productName,COALESCE(m.source_actor,u.full_name) AS userName,FALSE AS historicalEvent,m.id AS ledgerId FROM inventory_movements m JOIN products p ON p.business_id=m.business_id AND p.id=m.product_id LEFT JOIN users u ON u.business_id=m.business_id AND u.id=m.user_id WHERE m.business_id=? UNION ALL SELECT z.business_id,z.occurred_at AS createdAt,z.source_type AS type,z.quantity,z.stock_after AS stockAfter,z.unit_cost AS unitCost,z.reason,p.name AS productName,z.source_actor AS userName,TRUE AS historicalEvent,z.id AS ledgerId FROM migration_zero_inventory_events z JOIN products p ON p.business_id=z.business_id AND p.id=z.product_id WHERE z.business_id=?) ledger WHERE business_id=?' + inventoryMovementRange.sql + ' ORDER BY createdAt DESC,ledgerId DESC LIMIT 1000',
              values: [current.business_id, current.business_id, current.business_id, ...inventoryMovementRange.values]
            }
          : {
              sql: 'SELECT m.created_at AS createdAt,m.type,m.quantity,m.stock_after AS stockAfter,m.unit_cost AS unitCost,m.reason,p.name AS productName,COALESCE(m.source_actor,u.full_name) AS userName,FALSE AS historicalEvent FROM inventory_movements m JOIN products p ON p.business_id=m.business_id AND p.id=m.product_id LEFT JOIN users u ON u.business_id=m.business_id AND u.id=m.user_id WHERE m.business_id=?' + period('m.created_at', range).sql + ' ORDER BY m.created_at DESC,m.id DESC LIMIT 1000',
              values: [current.business_id, ...period('m.created_at', range).values]
            };
        const [salesSummary, salesCost, methods, sellers, topProducts, historyCount, history, closures, movements, cashPeriod, currentCash, inventorySummary, products, receivableSummary, receivablePayments, receivableClients] = await Promise.all([
          repo.rows(db, "SELECT COUNT(*) AS count, COALESCE(SUM(total), 0.00) AS total FROM sales s WHERE s.business_id = ? AND s.status = 'COMPLETED'" + salesRange.sql, [current.business_id, ...salesRange.values]),
          repo.rows(db, "SELECT ROUND(COALESCE(SUM(i.cost_at_sale * i.quantity), 0.00), 2) AS total, COALESCE(SUM(i.quantity), 0.000) AS unitsSold FROM sale_items i JOIN sales s ON s.business_id = i.business_id AND s.id = i.sale_id WHERE s.business_id = ? AND s.status = 'COMPLETED'" + salesRange.sql, [current.business_id, ...salesRange.values]),
          repo.rows(db, 'SELECT paymentMethod AS method,COUNT(*) AS count,COALESCE(SUM(total),0.00) AS total FROM (SELECT s.payment_method,' + salesPaymentMethod + ' AS paymentMethod,s.total FROM sales s WHERE s.business_id=? AND s.status=\'COMPLETED\'' + salesRange.sql + ') completed_sales GROUP BY paymentMethod ORDER BY paymentMethod', [current.business_id, ...salesRange.values]),
          repo.rows(db, 'SELECT seller,COUNT(*) AS count,COALESCE(SUM(CASE WHEN paymentMethod=\'CASH\' THEN total ELSE 0 END),0.00) AS cash,COALESCE(SUM(CASE WHEN paymentMethod=\'CARD\' THEN total ELSE 0 END),0.00) AS card,COALESCE(SUM(CASE WHEN paymentMethod=\'TRANSFER\' THEN total ELSE 0 END),0.00) AS transfer,COALESCE(SUM(CASE WHEN paymentMethod=\'CREDIT\' THEN total ELSE 0 END),0.00) AS credit,COALESCE(SUM(total),0.00) AS total FROM (SELECT s.user_id,u.full_name AS seller,s.total,' + salesPaymentMethod + ' AS paymentMethod FROM sales s JOIN users u ON u.business_id=s.business_id AND u.id=s.user_id WHERE s.business_id=? AND s.status=\'COMPLETED\'' + salesRange.sql + ') completed_sales GROUP BY user_id,seller ORDER BY total DESC,seller', [current.business_id, ...salesRange.values]),
          repo.rows(db, "SELECT i.product_name AS name, SUM(i.quantity) AS quantity, SUM(i.total) AS total FROM sale_items i JOIN sales s ON s.business_id = i.business_id AND s.id = i.sale_id WHERE s.business_id = ? AND s.status = 'COMPLETED'" + salesRange.sql + ' GROUP BY i.product_name ORDER BY quantity DESC, total DESC LIMIT 15', [current.business_id, ...salesRange.values]),
          repo.rows(db, 'SELECT COUNT(*) AS count FROM sales s WHERE s.business_id = ?' + salesRange.sql, [current.business_id, ...salesRange.values]),
          repo.rows(db, 'SELECT s.invoice_number AS internalInvoiceNumber, s.detail, s.created_at AS createdAt, u.full_name AS seller, ' + salesPaymentMethod + ' AS paymentMethod, s.total, s.status, ' + historySourceKey + ' AS sourceBusinessKey, ' + historySourceInvoice + ' AS sourceInvoiceNumber FROM sales s JOIN users u ON u.business_id = s.business_id AND u.id = s.user_id' + historySourceJoin + ' WHERE s.business_id = ?' + salesRange.sql + ' ORDER BY s.created_at DESC, s.id DESC LIMIT 1000', [current.business_id, ...salesRange.values]),
          repo.rows(db, "SELECT c.opened_at AS openedAt, c.closed_at AS closedAt, u.full_name AS closedBy, c.expected_amount AS expectedAmount, c.counted_amount AS countedAmount, c.difference FROM cash_sessions c LEFT JOIN users u ON u.business_id = c.business_id AND u.id = c.closed_by WHERE c.business_id = ? AND c.status = 'CLOSED'" + closureRange.sql + ' ORDER BY c.closed_at DESC, c.id DESC LIMIT 1000', [current.business_id, ...closureRange.values]),
          repo.rows(db, 'SELECT m.created_at AS createdAt, m.confirmed_at AS confirmedAt, confirmer.full_name AS confirmedBy, m.description, actor.full_name AS userName, m.reversal_of_movement_id AS reversalOfMovementId, m.type, m.direction, m.amount, m.status, ' + cashPaymentMethod + ' AS paymentMethod, supplier.name AS supplierName, purchase.id AS purchaseId, purchase.invoice_number AS invoiceNumber FROM cash_movements m JOIN users actor ON actor.business_id=m.business_id AND actor.id=m.user_id LEFT JOIN users confirmer ON confirmer.business_id=m.business_id AND confirmer.id=m.confirmed_by_user_id LEFT JOIN sales s ON s.business_id = m.business_id AND s.id = m.sale_id LEFT JOIN customer_payments p ON p.business_id = m.business_id AND p.id = m.customer_payment_id LEFT JOIN supplier_payments sp ON sp.business_id = m.business_id AND sp.id = m.supplier_payment_id LEFT JOIN expenses e ON e.business_id = m.business_id AND e.id = m.expense_id LEFT JOIN purchases purchase ON purchase.business_id = sp.business_id AND purchase.id = sp.purchase_id LEFT JOIN suppliers supplier ON supplier.business_id = sp.business_id AND supplier.id = sp.supplier_id WHERE m.business_id = ?' + cashRange.sql + ' ORDER BY m.created_at DESC, m.id DESC LIMIT 1000', [current.business_id, ...cashRange.values]),
          repo.rows(db, "SELECT COALESCE(SUM(CASE WHEN m.direction = 'IN' THEN m.amount ELSE 0.00 END), 0.00) AS cashIn, COALESCE(SUM(CASE WHEN m.direction = 'OUT' THEN m.amount ELSE 0.00 END), 0.00) AS cashOut FROM cash_movements m LEFT JOIN sales s ON s.business_id = m.business_id AND s.id = m.sale_id LEFT JOIN customer_payments p ON p.business_id = m.business_id AND p.id = m.customer_payment_id LEFT JOIN supplier_payments sp ON sp.business_id = m.business_id AND sp.id = m.supplier_payment_id LEFT JOIN expenses e ON e.business_id = m.business_id AND e.id = m.expense_id WHERE m.business_id = ? AND m.status = 'CONFIRMED' AND (" + cashPaymentMethod + " IS NULL OR " + cashPaymentMethod + " = 'CASH')" + cashRange.sql, [current.business_id, ...cashRange.values]),
          repo.rows(db, "SELECT c.opening_amount AS openingAmount, COALESCE(SUM(CASE WHEN m.status = 'CONFIRMED' AND (" + cashPaymentMethod + " IS NULL OR " + cashPaymentMethod + " = 'CASH') THEN CASE WHEN m.direction = 'IN' THEN m.amount ELSE -m.amount END ELSE 0.00 END), 0.00) AS movementNet FROM cash_sessions c LEFT JOIN cash_movements m ON m.business_id = c.business_id AND m.cash_session_id = c.id LEFT JOIN sales s ON s.business_id = m.business_id AND s.id = m.sale_id LEFT JOIN customer_payments p ON p.business_id = m.business_id AND p.id = m.customer_payment_id LEFT JOIN supplier_payments sp ON sp.business_id = m.business_id AND sp.id = m.supplier_payment_id LEFT JOIN expenses e ON e.business_id = m.business_id AND e.id = m.expense_id WHERE c.business_id = ? AND c.status = 'OPEN' GROUP BY c.id, c.opening_amount ORDER BY c.id DESC LIMIT 1", [current.business_id]),
          repo.rows(db, 'SELECT COUNT(*) AS totalProducts, COALESCE(SUM(CASE WHEN active = TRUE THEN 1 ELSE 0 END), 0) AS activeProducts, COALESCE(SUM(CASE WHEN active = TRUE THEN stock ELSE 0 END), 0.000) AS stockUnits, COALESCE(SUM(CASE WHEN active = TRUE AND stock <= 0 THEN 1 ELSE 0 END), 0) AS outOfStock, COALESCE(SUM(CASE WHEN active = TRUE AND stock > 0 AND stock <= min_stock THEN 1 ELSE 0 END), 0) AS lowStock, ROUND(COALESCE(SUM(CASE WHEN active = TRUE THEN stock * cost ELSE 0 END), 0.00), 2) AS stockCostValue FROM products WHERE business_id = ? AND deleted = FALSE', [current.business_id]),
          repo.rows(db, 'SELECT name, stock, cost, ROUND(stock * cost, 2) AS stockValue, min_stock AS minStock, active FROM products WHERE business_id = ? AND deleted = FALSE ORDER BY name', [current.business_id]),
          repo.rows(db, "SELECT COUNT(*) AS indebtedClients, COALESCE(SUM(balance), 0.00) AS balance, COALESCE(SUM(overdue), 0.00) AS overdue FROM (SELECT c.id, SUM(s.total - COALESCE(p.paid, 0.00)) AS balance, SUM(CASE WHEN s.due_at < UTC_TIMESTAMP(3) THEN s.total - COALESCE(p.paid, 0.00) ELSE 0.00 END) AS overdue FROM clients c JOIN sales s ON s.business_id = c.business_id AND s.client_id = c.id AND s.sale_type = 'CREDIT' AND s.status = 'COMPLETED' LEFT JOIN (SELECT business_id, sale_id, SUM(CASE WHEN status = 'POSTED' THEN amount ELSE 0.00 END) AS paid FROM customer_payments GROUP BY business_id, sale_id) p ON p.business_id = s.business_id AND p.sale_id = s.id WHERE c.business_id = ? GROUP BY c.id HAVING balance > 0.00) debt", [current.business_id]),
          repo.rows(db, "SELECT p.created_at AS createdAt, c.name AS clientName, s.invoice_number AS invoiceNumber, p.payment_method AS paymentMethod, p.status, p.amount FROM customer_payments p JOIN clients c ON c.business_id = p.business_id AND c.id = p.client_id LEFT JOIN sales s ON s.business_id = p.business_id AND s.id = p.sale_id WHERE p.business_id = ? AND p.status <> 'VOID'" + period('p.created_at', range).sql + ' ORDER BY p.created_at DESC, p.id DESC LIMIT 1000', [current.business_id, ...period('p.created_at', range).values]),
          repo.rows(db, "SELECT c.name AS clientName, c.credit_limit AS creditLimit, SUM(s.total - COALESCE(p.paid, 0.00)) AS balance, SUM(CASE WHEN s.due_at < UTC_TIMESTAMP(3) THEN s.total - COALESCE(p.paid, 0.00) ELSE 0.00 END) AS overdue FROM clients c JOIN sales s ON s.business_id = c.business_id AND s.client_id = c.id AND s.sale_type = 'CREDIT' AND s.status = 'COMPLETED' LEFT JOIN (SELECT business_id, sale_id, SUM(CASE WHEN status = 'POSTED' THEN amount ELSE 0.00 END) AS paid FROM customer_payments GROUP BY business_id, sale_id) p ON p.business_id = s.business_id AND p.sale_id = s.id WHERE c.business_id = ? GROUP BY c.id, c.name, c.credit_limit HAVING balance > 0.00 ORDER BY overdue DESC, balance DESC, c.name", [current.business_id])
        ]);
        const expenseRange = period('e.created_at', range);
        const [expenseSummary, expenseCount, expenseCategories, expenseHistory] = await Promise.all([
          repo.rows(db, "SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0.00) AS total FROM expenses e WHERE e.business_id = ? AND e.status = 'POSTED'" + expenseRange.sql, [current.business_id, ...expenseRange.values]),
          repo.rows(db, 'SELECT COUNT(*) AS count FROM expenses e WHERE e.business_id = ?' + expenseRange.sql, [current.business_id, ...expenseRange.values]),
          repo.rows(db, "SELECT e.category, COUNT(*) AS count, COALESCE(SUM(e.amount), 0.00) AS total FROM expenses e WHERE e.business_id = ? AND e.status = 'POSTED'" + expenseRange.sql + ' GROUP BY e.category ORDER BY total DESC, e.category', [current.business_id, ...expenseRange.values]),
          repo.rows(db, 'SELECT e.created_at AS createdAt, e.category, e.description, e.receipt_reference AS receiptReference, e.amount, e.payment_method AS paymentMethod, e.status, u.full_name AS userName FROM expenses e JOIN users u ON u.business_id = e.business_id AND u.id = e.user_id WHERE e.business_id = ?' + expenseRange.sql + ' ORDER BY e.created_at DESC, e.id DESC LIMIT 1000', [current.business_id, ...expenseRange.values])
        ]);
        const purchaseRange = period('p.created_at', range), supplierPaymentRange = period('sp.created_at', range);
        const historyColumns = await repo.rows(db, "SELECT COLUMN_NAME AS columnName FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchases' AND COLUMN_NAME IN ('is_historical','discount','notes')", []);
        const hasPurchaseHistorySchema = ['is_historical', 'discount', 'notes'].every(name => historyColumns.some(column => column.columnName === name));
        const historyFields = hasPurchaseHistorySchema ? 'p.is_historical AS isHistorical,p.discount,p.notes' : 'FALSE AS isHistorical,0.00 AS discount,NULL AS notes';
        const currentPurchasesOnly = hasPurchaseHistorySchema ? ' AND p.is_historical=FALSE' : '';
        const currentPaidPurchasesOnly = hasPurchaseHistorySchema ? ' AND paid_purchase.is_historical=FALSE' : '';
        const [purchaseSummary, purchaseHistory, payableInvoices, payableTotals, supplierRows, supplierPayments, inventoryMovements] = await Promise.all([
          repo.rows(db, "SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN status='COMPLETED' THEN total ELSE 0.00 END),0.00) AS total FROM purchases p WHERE p.business_id=?" + purchaseRange.sql, [current.business_id, ...purchaseRange.values]),
          repo.rows(db, 'SELECT p.id,p.invoice_number AS invoiceNumber,p.supplier_name AS supplierName,p.purchase_type AS purchaseType,p.total,p.status,' + historyFields + ',p.tax,p.due_at AS dueAt,p.created_at AS createdAt,(SELECT COUNT(*) FROM purchase_items i WHERE i.business_id=p.business_id AND i.purchase_id=p.id) AS itemCount FROM purchases p WHERE p.business_id=?' + purchaseRange.sql + ' ORDER BY p.created_at DESC,p.id DESC LIMIT 1000', [current.business_id, ...purchaseRange.values]),
          repo.rows(db, "SELECT p.id,p.invoice_number AS invoiceNumber,p.supplier_name AS supplierName,p.total,p.due_at AS dueAt,p.created_at AS createdAt,(SELECT COALESCE(SUM(CASE WHEN sp.status='POSTED' THEN sp.amount ELSE 0.00 END),0.00) FROM supplier_payments sp WHERE sp.business_id=p.business_id AND sp.purchase_id=p.id) AS paid,(SELECT COALESCE(SUM(CASE WHEN sp.status='PENDING' THEN sp.amount ELSE 0.00 END),0.00) FROM supplier_payments sp WHERE sp.business_id=p.business_id AND sp.purchase_id=p.id) AS pending FROM purchases p WHERE p.business_id=? AND p.purchase_type='CREDIT' AND p.status='COMPLETED'" + currentPurchasesOnly + " AND p.total>(SELECT COALESCE(SUM(CASE WHEN sp.status='POSTED' THEN sp.amount ELSE 0.00 END),0.00) FROM supplier_payments sp WHERE sp.business_id=p.business_id AND sp.purchase_id=p.id) ORDER BY (p.due_at IS NULL),p.due_at,p.created_at DESC,p.id DESC LIMIT 1000", [current.business_id]),
          repo.rows(db, "SELECT COALESCE(SUM(balance),0.00) AS balance,COALESCE(SUM(pending),0.00) AS pendingPayments FROM (SELECT p.total-(SELECT COALESCE(SUM(CASE WHEN sp.status='POSTED' THEN sp.amount ELSE 0.00 END),0.00) FROM supplier_payments sp WHERE sp.business_id=p.business_id AND sp.purchase_id=p.id) AS balance,(SELECT COALESCE(SUM(CASE WHEN sp.status='PENDING' THEN sp.amount ELSE 0.00 END),0.00) FROM supplier_payments sp WHERE sp.business_id=p.business_id AND sp.purchase_id=p.id) AS pending FROM purchases p WHERE p.business_id=? AND p.purchase_type='CREDIT' AND p.status='COMPLETED'" + currentPurchasesOnly + ") current_payables", [current.business_id]),
          repo.rows(db, "SELECT s.id,s.name,s.contact,s.phone,s.active,(SELECT COALESCE(SUM(p.total),0.00) FROM purchases p WHERE p.business_id=s.business_id AND p.supplier_id=s.id AND p.status='COMPLETED') AS totalPurchased,(SELECT COALESCE(SUM(p.total),0.00) FROM purchases p WHERE p.business_id=s.business_id AND p.supplier_id=s.id AND p.purchase_type='CREDIT' AND p.status='COMPLETED'" + currentPurchasesOnly + ")-(SELECT COALESCE(SUM(sp.amount),0.00) FROM supplier_payments sp JOIN purchases paid_purchase ON paid_purchase.business_id=sp.business_id AND paid_purchase.id=sp.purchase_id WHERE sp.business_id=s.business_id AND sp.supplier_id=s.id AND paid_purchase.purchase_type='CREDIT'" + currentPaidPurchasesOnly + " AND sp.status='POSTED') AS debt FROM suppliers s WHERE s.business_id=? ORDER BY s.active DESC,s.name,s.id LIMIT 1000", [current.business_id]),
          repo.rows(db, "SELECT sp.created_at AS createdAt,m.confirmed_at AS confirmedAt,confirmer.full_name AS confirmedBy,s.name AS supplierName,p.id AS purchaseId,p.invoice_number AS invoiceNumber,sp.payment_method AS paymentMethod,sp.status,sp.amount FROM supplier_payments sp JOIN suppliers s ON s.business_id=sp.business_id AND s.id=sp.supplier_id LEFT JOIN purchases p ON p.business_id=sp.business_id AND p.id=sp.purchase_id LEFT JOIN cash_movements m ON m.business_id=sp.business_id AND m.supplier_payment_id=sp.id LEFT JOIN users confirmer ON confirmer.business_id=m.business_id AND confirmer.id=m.confirmed_by_user_id WHERE sp.business_id=? AND sp.status<>'VOID'" + supplierPaymentRange.sql + ' ORDER BY sp.created_at DESC,sp.id DESC LIMIT 1000', [current.business_id, ...supplierPaymentRange.values]),
          repo.rows(db, inventoryMovementQuery.sql, inventoryMovementQuery.values)
        ]);
        await permitted(db, current);

        const historyOrigins = history.some(row => row.sourceBusinessKey) ? await loadSourceBusinessNames(repo, db, current.business_id) : new Map();
        const salesHistory = history.map(row => {
          const isHistorical = Boolean(row.sourceBusinessKey);
          const originalNumber = isHistorical ? (row.sourceInvoiceNumber || originalInvoiceNumber(row.detail)) : null;
          return {
            invoiceNumber: isHistorical ? originalNumber || 'Factura original no disponible' : row.internalInvoiceNumber,
            createdAt: row.createdAt,
            seller: row.seller,
            paymentMethod: row.paymentMethod,
            total: money(row.total),
            status: row.status,
            isHistorical,
            sourceBusinessName: row.sourceBusinessKey ? historyOrigins.get(row.sourceBusinessKey) || null : null
          };
        });

        const productRows = products.map(row => {
          const stock = Number(row.stock), minStock = Number(row.minStock), active = Boolean(row.active);
          const status = !active ? 'Inactivo' : stock <= 0 ? 'Agotado' : stock <= minStock ? 'Bajo stock' : 'Normal';
          return { name: row.name, stock: Number(stock.toFixed(3)), cost: money(row.cost), value: money(row.stockValue), status };
        });
        const clientRows = receivableClients.map(row => ({
          clientName: row.clientName, creditLimit: money(row.creditLimit), balance: money(row.balance),
          status: Number(row.overdue) > 0 ? 'Vencida' : Number(row.balance) > Number(row.creditLimit) ? 'Excedida' : 'Al día'
        }));
        const summary = salesSummary[0] || {};
        const cashTotals = cashPeriod[0] || {};
        const openCash = currentCash[0] || null;
        const inventory = inventorySummary[0] || {};
        const receivables = receivableSummary[0] || {};
        return {
          businessId: String(current.business_id),
          sales: {
            total: money(summary.total), cost: money(salesCost[0]?.total), unitsSold: Number(Number(salesCost[0]?.unitsSold || 0).toFixed(3)), grossProfit: fixed(units(String(summary.total || '0.00')) - units(String(salesCost[0]?.total || '0.00')), 2), netProfit: fixed(units(String(summary.total || '0.00')) - units(String(salesCost[0]?.total || '0.00')) - units(String(expenseSummary[0]?.total || '0.00')), 2), count: Number(summary.count || 0), historyCount: Number(historyCount[0]?.count || 0), historyLimited: Number(historyCount[0]?.count || 0) > history.length,
            paymentMethods: methods.map(row => ({ method: row.method, count: Number(row.count), total: money(row.total) })),
            sellers: sellers.map(row => ({ seller: row.seller, count: Number(row.count), cash: money(row.cash), card: money(row.card), transfer: money(row.transfer), credit: money(row.credit), total: money(row.total) })),
            topProducts: topProducts.map(row => ({ name: row.name, quantity: Number(Number(row.quantity).toFixed(3)), total: money(row.total) })),
            history: salesHistory
          },
          cash: {
            periodIn: money(cashTotals.cashIn), periodOut: money(cashTotals.cashOut), currentExpected: openCash ? fixed(units(String(openCash.openingAmount || '0.00')) + units(String(openCash.movementNet || '0.00')), 2) : null,
            closures: closures.map(row => ({ openedAt: row.openedAt, closedAt: row.closedAt, closedBy: row.closedBy || '—', expectedAmount: money(row.expectedAmount), countedAmount: money(row.countedAmount), difference: money(row.difference) })),
             movements: movements.map(row => ({ createdAt: row.createdAt, confirmedAt: row.confirmedAt, confirmedBy: row.confirmedBy || null, description: row.description, userName: row.userName, reversalOfMovementId: row.reversalOfMovementId === null ? null : String(row.reversalOfMovementId), type: row.type, direction: row.direction, amount: money(row.amount), status: row.status, paymentMethod: row.paymentMethod, supplierName: row.supplierName, purchaseNumber: row.purchaseId ? purchaseNumber(row.purchaseId) : null, supplierInvoiceNumber: row.purchaseId ? supplierInvoiceNumber(row) : null, invoiceNumber: row.invoiceNumber }))
          },
          inventory: { totalProducts: Number(inventory.totalProducts || 0), activeProducts: Number(inventory.activeProducts || 0), stockUnits: Number(Number(inventory.stockUnits || 0).toFixed(3)), outOfStock: Number(inventory.outOfStock || 0), lowStock: Number(inventory.lowStock || 0), stockCostValue: money(inventory.stockCostValue), products: productRows, movements: inventoryMovements.map(row => ({ createdAt: row.createdAt, type: row.type, productName: row.productName, quantity: Number(Number(row.quantity).toFixed(3)), stockAfter: row.stockAfter === null ? null : Number(Number(row.stockAfter).toFixed(3)), unitCost: row.unitCost === null ? null : money(row.unitCost), reason: row.reason || '', userName: row.userName || '—', isHistorical: Boolean(row.historicalEvent), historicalEvent: Boolean(row.historicalEvent) })) },
          receivables: { indebtedClients: Number(receivables.indebtedClients || 0), balance: money(receivables.balance), overdue: money(receivables.overdue), clients: clientRows, payments: receivablePayments.map(row => ({ createdAt: row.createdAt, clientName: row.clientName, invoiceNumber: row.invoiceNumber, paymentMethod: row.paymentMethod, status: row.status, amount: money(row.amount) })) },
          expenses: { count: Number(expenseSummary[0]?.count || 0), historyCount: Number(expenseCount[0]?.count || 0), historyLimited: Number(expenseCount[0]?.count || 0) > expenseHistory.length, total: money(expenseSummary[0]?.total), byCategory: expenseCategories.map(row => ({ category: row.category, count: Number(row.count), total: money(row.total) })), history: expenseHistory.map(row => ({ createdAt: row.createdAt, category: row.category, description: row.description, receiptReference: row.receiptReference || '', amount: money(row.amount), paymentMethod: row.paymentMethod, status: row.status, userName: row.userName || '—' })) },
          purchases: { total: money(purchaseSummary[0]?.total), count: Number(purchaseSummary[0]?.count || 0), historyCount: Number(purchaseSummary[0]?.count || 0), historyLimited: Number(purchaseSummary[0]?.count || 0) > purchaseHistory.length, history: purchaseHistory.map(row => ({ purchaseNumber: purchaseNumber(row.id), supplierInvoiceNumber: supplierInvoiceNumber(row) || '', invoiceNumber: row.invoiceNumber, supplierName: row.supplierName, purchaseType: row.purchaseType, total: money(row.total), discount: money(row.discount), tax: money(row.tax), notes: row.notes || null, isHistorical: Boolean(row.isHistorical), status: row.status, dueAt: row.dueAt, createdAt: row.createdAt, itemCount: Number(row.itemCount || 0) })) },
          payables: { balance: money(payableTotals[0]?.balance), pendingPayments: money(payableTotals[0]?.pendingPayments), invoices: payableInvoices.map(row => {
            const balance = units(row.total) - units(row.paid || '0.00');
             return { purchaseNumber: purchaseNumber(row.id), supplierInvoiceNumber: supplierInvoiceNumber(row) || '', invoiceNumber: row.invoiceNumber, supplierName: row.supplierName, total: money(row.total), paid: money(row.paid), pendingPayments: money(row.pending), balance: fixed(balance, 2), dueAt: row.dueAt, createdAt: row.createdAt, status: units(row.pending || '0.00') > 0n ? 'PENDING_CONFIRMATION' : balance <= 0n ? 'PAID' : units(row.paid || '0.00') > 0n ? 'PARTIAL' : row.dueAt && new Date(row.dueAt).getTime() < Date.now() ? 'OVERDUE' : 'OPEN' };
          }) },
           suppliers: { count: supplierRows.length, activeCount: supplierRows.filter(row => Boolean(row.active)).length, totalPurchased: fixed(supplierRows.reduce((sum, row) => sum + units(row.totalPurchased || '0.00'), 0n), 2), debt: fixed(supplierRows.reduce((sum, row) => sum + units(row.debt || '0.00'), 0n), 2), list: supplierRows.map(row => ({ name: row.name, contact: row.contact || '', phone: row.phone || '', active: Boolean(row.active), totalPurchased: money(row.totalPurchased), debt: money(row.debt) })), payments: supplierPayments.map(row => ({ createdAt: row.createdAt, confirmedAt: row.confirmedAt, confirmedBy: row.confirmedBy || null, supplierName: row.supplierName, purchaseNumber: row.purchaseId ? purchaseNumber(row.purchaseId) : null, supplierInvoiceNumber: row.purchaseId ? supplierInvoiceNumber(row) || '' : '', invoiceNumber: row.invoiceNumber, paymentMethod: row.paymentMethod, status: row.status, amount: money(row.amount) })) }
        };
      });
    } catch (error) {
      if (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_FIELD_ERROR') throw httpError(503, 'REPORTS_UNAVAILABLE');
      throw error;
    }
  }
  return { report };
}

module.exports = { createConnectedReportService };
