'use strict';

const mysql = require('/app/backend/node_modules/mysql2/promise');

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    charset: 'utf8mb4',
    supportBigNumbers: true,
    bigNumberStrings: true
  });
  const failures = [];
  const tenants = [];
  try {
    const [businesses] = await db.execute('SELECT id FROM businesses ORDER BY id');
    for (const business of businesses) {
      const businessId = String(business.id);
      const [[product]] = await db.execute('SELECT id, stock FROM products WHERE business_id = ? ORDER BY id LIMIT 1', [businessId]);
      const [[sales]] = await db.execute('SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS total FROM sales WHERE business_id = ?', [businessId]);
      const [[operations]] = await db.execute("SELECT COUNT(*) AS count FROM pos_operations WHERE business_id = ? AND kind = 'SALE'", [businessId]);
      const [[cash]] = await db.execute("SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total FROM cash_movements WHERE business_id = ? AND type = 'SALE' AND status = 'CONFIRMED'", [businessId]);
      const [[inventory]] = await db.execute("SELECT COUNT(*) AS count, COALESCE(SUM(quantity), 0) AS quantity FROM inventory_movements WHERE business_id = ? AND type = 'SALE'", [businessId]);
      const [[duplicateCash]] = await db.execute("SELECT COUNT(*) AS count FROM (SELECT sale_id FROM cash_movements WHERE business_id = ? AND type = 'SALE' AND sale_id IS NOT NULL GROUP BY sale_id HAVING COUNT(*) > 1) duplicates", [businessId]);
      const [[duplicateInvoices]] = await db.execute('SELECT COUNT(*) AS count FROM (SELECT invoice_number FROM sales WHERE business_id = ? GROUP BY invoice_number HAVING COUNT(*) > 1) duplicates', [businessId]);
      const [[cashSession]] = await db.execute("SELECT opening_amount + COALESCE((SELECT SUM(CASE WHEN direction = 'IN' THEN amount ELSE -amount END) FROM cash_movements WHERE business_id = ? AND cash_session_id = cs.id AND status = 'CONFIRMED'), 0) AS expected FROM cash_sessions cs WHERE cs.business_id = ? AND cs.status = 'OPEN' ORDER BY cs.id DESC LIMIT 1", [businessId, businessId]);
      const stock = Number(product?.stock ?? 0);
      const expectedStock = 1000000 + Number(inventory.quantity);
      const hasErrors = Number(sales.count) !== Number(operations.count)
        || Number(sales.count) !== Number(cash.count)
        || Number(sales.count) !== Number(inventory.count)
        || Math.abs(Number(sales.total) - Number(cash.total)) > 0.001
        || Math.abs(stock - expectedStock) > 0.001
        || Number(duplicateCash.count) !== 0
        || Number(duplicateInvoices.count) !== 0
        || stock < 0;
      if (hasErrors) failures.push(businessId);
      tenants.push({
        businessId,
        productId: product ? String(product.id) : null,
        sales: Number(sales.count),
        saleOperations: Number(operations.count),
        cashMovements: Number(cash.count),
        inventoryMovements: Number(inventory.count),
        salesTotal: String(sales.total),
        cashTotal: String(cash.total),
        stock,
        expectedStock,
        openCashExpected: cashSession ? String(cashSession.expected) : null,
        duplicateSaleCashMovements: Number(duplicateCash.count),
        duplicateInvoices: Number(duplicateInvoices.count),
        consistent: !hasErrors
      });
    }
    const [orphans] = await db.execute('SELECT COUNT(*) AS count FROM sale_items si LEFT JOIN sales s ON s.business_id = si.business_id AND s.id = si.sale_id WHERE s.id IS NULL');
    if (Number(orphans[0].count) !== 0) failures.push('sale_items_orphan');
    process.stdout.write(JSON.stringify({ businesses: tenants.length, tenants, orphanSaleItems: Number(orphans[0].count), consistent: failures.length === 0 }) + '\n');
    if (failures.length) process.exitCode = 1;
  } finally {
    await db.end();
  }
}

main().catch(error => {
  process.stderr.write('Load integrity verification failed (' + (error.code || 'unknown') + ').\n');
  process.exitCode = 1;
});
