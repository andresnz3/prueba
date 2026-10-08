'use strict';
const { httpError } = require('../middleware/errors');
const { fixed, units } = require('./inventory-values');

const money = value => fixed(units(String(value ?? '0.00')), 2);
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
        const [salesSummary, methods, sellers, topProducts, historyCount, history, closures, movements, inventorySummary, products, receivableSummary, receivablePayments, receivableClients] = await Promise.all([
          repo.rows(db, "SELECT COUNT(*) AS count, COALESCE(SUM(total), 0.00) AS total FROM sales s WHERE s.business_id = ? AND s.status = 'COMPLETED'" + salesRange.sql, [current.business_id, ...salesRange.values]),
          repo.rows(db, "SELECT s.payment_method AS method, COUNT(*) AS count, COALESCE(SUM(s.total), 0.00) AS total FROM sales s WHERE s.business_id = ? AND s.status = 'COMPLETED'" + salesRange.sql + ' GROUP BY s.payment_method ORDER BY s.payment_method', [current.business_id, ...salesRange.values]),
          repo.rows(db, "SELECT u.full_name AS seller, COUNT(*) AS count, COALESCE(SUM(CASE WHEN s.payment_method = 'CASH' THEN s.total ELSE 0 END), 0.00) AS cash, COALESCE(SUM(CASE WHEN s.payment_method = 'CARD' THEN s.total ELSE 0 END), 0.00) AS card, COALESCE(SUM(CASE WHEN s.payment_method = 'TRANSFER' THEN s.total ELSE 0 END), 0.00) AS transfer, COALESCE(SUM(CASE WHEN s.payment_method = 'CREDIT' THEN s.total ELSE 0 END), 0.00) AS credit, COALESCE(SUM(s.total), 0.00) AS total FROM sales s JOIN users u ON u.business_id = s.business_id AND u.id = s.user_id WHERE s.business_id = ? AND s.status = 'COMPLETED'" + salesRange.sql + ' GROUP BY u.id, u.full_name ORDER BY total DESC, u.full_name', [current.business_id, ...salesRange.values]),
          repo.rows(db, "SELECT i.product_name AS name, SUM(i.quantity) AS quantity, SUM(i.total) AS total FROM sale_items i JOIN sales s ON s.business_id = i.business_id AND s.id = i.sale_id WHERE s.business_id = ? AND s.status = 'COMPLETED'" + salesRange.sql + ' GROUP BY i.product_name ORDER BY quantity DESC, total DESC LIMIT 15', [current.business_id, ...salesRange.values]),
          repo.rows(db, 'SELECT COUNT(*) AS count FROM sales s WHERE s.business_id = ?' + salesRange.sql, [current.business_id, ...salesRange.values]),
          repo.rows(db, 'SELECT s.invoice_number AS invoiceNumber, s.created_at AS createdAt, u.full_name AS seller, s.payment_method AS paymentMethod, s.total, s.status FROM sales s JOIN users u ON u.business_id = s.business_id AND u.id = s.user_id WHERE s.business_id = ?' + salesRange.sql + ' ORDER BY s.created_at DESC, s.id DESC LIMIT 1000', [current.business_id, ...salesRange.values]),
          repo.rows(db, "SELECT c.opened_at AS openedAt, c.closed_at AS closedAt, u.full_name AS closedBy, c.expected_amount AS expectedAmount, c.counted_amount AS countedAmount, c.difference FROM cash_sessions c LEFT JOIN users u ON u.business_id = c.business_id AND u.id = c.closed_by WHERE c.business_id = ? AND c.status = 'CLOSED'" + closureRange.sql + ' ORDER BY c.closed_at DESC, c.id DESC LIMIT 1000', [current.business_id, ...closureRange.values]),
          repo.rows(db, 'SELECT m.created_at AS createdAt, m.type, m.direction, m.amount, m.status, COALESCE(s.payment_method, p.payment_method) AS paymentMethod FROM cash_movements m LEFT JOIN sales s ON s.business_id = m.business_id AND s.id = m.sale_id LEFT JOIN customer_payments p ON p.business_id = m.business_id AND p.id = m.customer_payment_id WHERE m.business_id = ?' + cashRange.sql + ' ORDER BY m.created_at DESC, m.id DESC LIMIT 1000', [current.business_id, ...cashRange.values]),
          repo.rows(db, 'SELECT COUNT(*) AS totalProducts, COALESCE(SUM(CASE WHEN active = TRUE THEN 1 ELSE 0 END), 0) AS activeProducts, COALESCE(SUM(CASE WHEN active = TRUE THEN stock ELSE 0 END), 0.000) AS stockUnits, COALESCE(SUM(CASE WHEN active = TRUE AND stock <= 0 THEN 1 ELSE 0 END), 0) AS outOfStock, COALESCE(SUM(CASE WHEN active = TRUE AND stock > 0 AND stock <= min_stock THEN 1 ELSE 0 END), 0) AS lowStock, ROUND(COALESCE(SUM(CASE WHEN active = TRUE THEN stock * cost ELSE 0 END), 0.00), 2) AS stockCostValue FROM products WHERE business_id = ? AND deleted = FALSE', [current.business_id]),
          repo.rows(db, 'SELECT name, stock, cost, ROUND(stock * cost, 2) AS stockValue, min_stock AS minStock, active FROM products WHERE business_id = ? AND deleted = FALSE ORDER BY name', [current.business_id]),
          repo.rows(db, "SELECT COUNT(*) AS indebtedClients, COALESCE(SUM(balance), 0.00) AS balance, COALESCE(SUM(overdue), 0.00) AS overdue FROM (SELECT c.id, SUM(s.total - COALESCE(p.paid, 0.00)) AS balance, SUM(CASE WHEN s.due_at < UTC_TIMESTAMP(3) THEN s.total - COALESCE(p.paid, 0.00) ELSE 0.00 END) AS overdue FROM clients c JOIN sales s ON s.business_id = c.business_id AND s.client_id = c.id AND s.sale_type = 'CREDIT' AND s.status = 'COMPLETED' LEFT JOIN (SELECT business_id, sale_id, SUM(CASE WHEN status = 'POSTED' THEN amount ELSE 0.00 END) AS paid FROM customer_payments GROUP BY business_id, sale_id) p ON p.business_id = s.business_id AND p.sale_id = s.id WHERE c.business_id = ? GROUP BY c.id HAVING balance > 0.00) debt", [current.business_id]),
          repo.rows(db, "SELECT p.created_at AS createdAt, c.name AS clientName, s.invoice_number AS invoiceNumber, p.payment_method AS paymentMethod, p.status, p.amount FROM customer_payments p JOIN clients c ON c.business_id = p.business_id AND c.id = p.client_id LEFT JOIN sales s ON s.business_id = p.business_id AND s.id = p.sale_id WHERE p.business_id = ? AND p.status <> 'VOID'" + period('p.created_at', range).sql + ' ORDER BY p.created_at DESC, p.id DESC LIMIT 1000', [current.business_id, ...period('p.created_at', range).values]),
          repo.rows(db, "SELECT c.name AS clientName, c.credit_limit AS creditLimit, SUM(s.total - COALESCE(p.paid, 0.00)) AS balance, SUM(CASE WHEN s.due_at < UTC_TIMESTAMP(3) THEN s.total - COALESCE(p.paid, 0.00) ELSE 0.00 END) AS overdue FROM clients c JOIN sales s ON s.business_id = c.business_id AND s.client_id = c.id AND s.sale_type = 'CREDIT' AND s.status = 'COMPLETED' LEFT JOIN (SELECT business_id, sale_id, SUM(CASE WHEN status = 'POSTED' THEN amount ELSE 0.00 END) AS paid FROM customer_payments GROUP BY business_id, sale_id) p ON p.business_id = s.business_id AND p.sale_id = s.id WHERE c.business_id = ? GROUP BY c.id, c.name, c.credit_limit HAVING balance > 0.00 ORDER BY overdue DESC, balance DESC, c.name", [current.business_id])
        ]);
        await permitted(db, current);

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
        const inventory = inventorySummary[0] || {};
        const receivables = receivableSummary[0] || {};
        return {
          businessId: String(current.business_id),
          sales: {
            total: money(summary.total), count: Number(summary.count || 0), historyCount: Number(historyCount[0]?.count || 0), historyLimited: Number(historyCount[0]?.count || 0) > history.length,
            paymentMethods: methods.map(row => ({ method: row.method, count: Number(row.count), total: money(row.total) })),
            sellers: sellers.map(row => ({ seller: row.seller, count: Number(row.count), cash: money(row.cash), card: money(row.card), transfer: money(row.transfer), credit: money(row.credit), total: money(row.total) })),
            topProducts: topProducts.map(row => ({ name: row.name, quantity: Number(Number(row.quantity).toFixed(3)), total: money(row.total) })),
            history: history.map(row => ({ invoiceNumber: row.invoiceNumber, createdAt: row.createdAt, seller: row.seller, paymentMethod: row.paymentMethod, total: money(row.total), status: row.status }))
          },
          cash: {
            closures: closures.map(row => ({ openedAt: row.openedAt, closedAt: row.closedAt, closedBy: row.closedBy || '—', expectedAmount: money(row.expectedAmount), countedAmount: money(row.countedAmount), difference: money(row.difference) })),
            movements: movements.map(row => ({ createdAt: row.createdAt, type: row.type, direction: row.direction, amount: money(row.amount), status: row.status, paymentMethod: row.paymentMethod }))
          },
          inventory: { totalProducts: Number(inventory.totalProducts || 0), activeProducts: Number(inventory.activeProducts || 0), stockUnits: Number(Number(inventory.stockUnits || 0).toFixed(3)), outOfStock: Number(inventory.outOfStock || 0), lowStock: Number(inventory.lowStock || 0), stockCostValue: money(inventory.stockCostValue), products: productRows },
          receivables: { indebtedClients: Number(receivables.indebtedClients || 0), balance: money(receivables.balance), overdue: money(receivables.overdue), clients: clientRows, payments: receivablePayments.map(row => ({ createdAt: row.createdAt, clientName: row.clientName, invoiceNumber: row.invoiceNumber, paymentMethod: row.paymentMethod, status: row.status, amount: money(row.amount) })) }
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
