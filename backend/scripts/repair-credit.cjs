'use strict';
const { readConfig } = require('../src/config/environment');
const { createDatabasePool } = require('../src/config/database');

const tables = ['clients', 'customer_payments', 'cash_movements', 'sale_orders', 'sale_order_items', 'pos_operations'];
async function inspect(db, database) {
  const [columns] = await db.execute('SELECT table_name, column_name, column_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = ? AND table_name IN (?, ?, ?, ?, ?, ?) ORDER BY table_name, ordinal_position', [database, ...tables]);
  const [constraints] = await db.execute('SELECT t.table_name, t.constraint_name, t.constraint_type, c.check_clause, t.enforced FROM information_schema.table_constraints t LEFT JOIN information_schema.check_constraints c ON c.constraint_schema = t.constraint_schema AND c.constraint_name = t.constraint_name WHERE t.constraint_schema = ? AND t.table_name IN (?, ?, ?, ?, ?, ?)', [database, ...tables]);
  const [keys] = await db.execute('SELECT k.table_name, k.constraint_name, k.column_name, k.referenced_table_name, k.referenced_column_name, k.ordinal_position, r.delete_rule, r.update_rule FROM information_schema.key_column_usage k LEFT JOIN information_schema.referential_constraints r ON r.constraint_schema = k.constraint_schema AND r.constraint_name = k.constraint_name AND r.table_name = k.table_name WHERE k.table_schema = ? AND k.table_name IN (?, ?, ?, ?, ?, ?) ORDER BY k.table_name, k.constraint_name, k.ordinal_position', [database, ...tables]);
  const lowerKeys = rows => rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value])));
  return { columns: lowerKeys(columns), constraints: lowerKeys(constraints), keys: lowerKeys(keys) };
}
const normalize = value => String(value).toLowerCase().replace(/[`\s()]/g, '');
function plan(schema) {
  const statements = [], blockers = [];
  const column = (table, name) => schema.columns.find(c => c.table_name === table && c.column_name === name);
  for (const table of tables) if (!schema.columns.some(c => c.table_name === table)) blockers.push('Falta tabla requerida: ' + table);
  for (const [table, name] of [['cash_movements', 'customer_payment_id'], ['cash_movements', 'confirmed_by_user_id'], ['cash_movements', 'confirmed_at'], ['customer_payments', 'status']]) if (!column(table, name)) blockers.push('Falta prerrequisito: ' + table + '.' + name);
  function addColumn(table, name, type, nullable, defaultValue) {
    const existing = column(table, name);
    if (!existing) statements.push('ALTER TABLE ' + table + ' ADD COLUMN ' + name + ' ' + type + (nullable ? ' NULL' : ' NOT NULL DEFAULT ' + defaultValue));
    else if (existing.column_type.toLowerCase() !== type.toLowerCase() || existing.is_nullable !== (nullable ? 'YES' : 'NO') || (!nullable && String(existing.column_default) !== String(defaultValue))) blockers.push('Columna existente incompatible: ' + table + '.' + name);
  }
  addColumn('clients', 'credit_days', 'SMALLINT UNSIGNED', false, 30);
  addColumn('sale_orders', 'client_id', 'BIGINT UNSIGNED', true);
  addColumn('sale_orders', 'credit_days', 'SMALLINT UNSIGNED', true);
  function check(table, name, clause) {
    const existing = schema.constraints.find(c => c.table_name === table && c.constraint_name === name);
    if (!existing) statements.push('ALTER TABLE ' + table + ' ADD CONSTRAINT ' + name + ' CHECK (' + clause + ')');
    else if (existing.constraint_type !== 'CHECK' || existing.enforced !== 'YES' || normalize(existing.check_clause) !== normalize(clause)) blockers.push('CHECK existente incompatible: ' + name);
  }
  check('clients', 'chk_clients_credit_days', 'credit_days BETWEEN 1 AND 3650');
  check('sale_orders', 'chk_sale_orders_credit_client', '(client_id IS NULL AND credit_days IS NULL) OR (client_id IS NOT NULL AND credit_days BETWEEN 1 AND 3650)');
  const fk = schema.keys.filter(k => k.table_name === 'sale_orders' && k.constraint_name === 'fk_sale_orders_client');
  if (!fk.length) statements.push('ALTER TABLE sale_orders ADD CONSTRAINT fk_sale_orders_client FOREIGN KEY (business_id, client_id) REFERENCES clients (business_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT');
  else if (fk.length !== 2 || fk[0].column_name !== 'business_id' || fk[1].column_name !== 'client_id' || fk.some(k => k.referenced_table_name !== 'clients' || !['RESTRICT', 'NO ACTION'].includes(k.delete_rule) || !['RESTRICT', 'NO ACTION'].includes(k.update_rule)) || fk[0].referenced_column_name !== 'business_id' || fk[1].referenced_column_name !== 'id') blockers.push('FK existente incompatible: fk_sale_orders_client');
  const paymentStatus = column('customer_payments', 'status');
  if (paymentStatus) {
    if (paymentStatus.column_type.toLowerCase() === "enum('posted','void')" && paymentStatus.is_nullable === 'NO' && paymentStatus.column_default === 'POSTED') statements.push("ALTER TABLE customer_payments MODIFY COLUMN status ENUM('POSTED', 'VOID', 'PENDING') NOT NULL DEFAULT 'POSTED'");
    else if (!["enum('pending','posted','void')", "enum('posted','void','pending')"].includes(paymentStatus.column_type.toLowerCase()) || paymentStatus.is_nullable !== 'NO' || paymentStatus.column_default !== 'POSTED') blockers.push('ENUM de customer_payments.status incompatible; no convertir estados automáticamente');
  }
  const movementStatus = column('cash_movements', 'status');
  if (!movementStatus || movementStatus.column_type.toLowerCase() !== "enum('pending','confirmed','void')") blockers.push('cash_movements.status requiere migración 003');
  const paymentFk = schema.keys.filter(k => k.table_name === 'cash_movements' && k.referenced_table_name === 'customer_payments');
  if (!paymentFk.some(k => k.column_name === 'customer_payment_id' && k.referenced_column_name === 'id' && paymentFk.some(b => b.constraint_name === k.constraint_name && b.column_name === 'business_id' && b.referenced_column_name === 'business_id'))) blockers.push('Falta relación de cash_movements a customer_payments por negocio; inspeccionar antes de reparar');
  const operationKey = schema.keys.filter(k => k.table_name === 'pos_operations' && k.constraint_name === 'PRIMARY');
  if (operationKey.length !== 2 || operationKey[0].column_name !== 'business_id' || operationKey[1].column_name !== 'operation_key') blockers.push('Falta clave de idempotencia por negocio en pos_operations');
  return { statements, blockers };
}
async function validateData(db, schema) {
  const issues = [];
  const has = (t, c) => schema.columns.some(x => x.table_name === t && x.column_name === c);
  async function count(label, sql) { const [rows] = await db.query(sql); if (Number(rows[0].n)) issues.push({ issue: label, count: Number(rows[0].n) }); }
  if (has('clients', 'credit_days')) await count('Plazos de clientes inválidos', 'SELECT COUNT(*) AS n FROM clients WHERE credit_days IS NULL OR credit_days NOT BETWEEN 1 AND 3650');
  if (has('sale_orders', 'client_id') && !has('sale_orders', 'credit_days')) await count('Órdenes con cliente cuyo plazo falta; requieren revisión manual', 'SELECT COUNT(*) AS n FROM sale_orders WHERE client_id IS NOT NULL');
  if (!has('sale_orders', 'client_id') && has('sale_orders', 'credit_days')) await count('Órdenes con plazo cuyo cliente falta; requieren revisión manual', 'SELECT COUNT(*) AS n FROM sale_orders WHERE credit_days IS NOT NULL');
  if (has('sale_orders', 'client_id') && has('sale_orders', 'credit_days')) {
    await count('Órdenes con cliente/plazo inconsistentes', 'SELECT COUNT(*) AS n FROM sale_orders WHERE (client_id IS NULL AND credit_days IS NOT NULL) OR (client_id IS NOT NULL AND (credit_days IS NULL OR credit_days NOT BETWEEN 1 AND 3650))');
    await count('Órdenes con cliente inexistente o de otro negocio', 'SELECT COUNT(*) AS n FROM sale_orders o LEFT JOIN clients c ON c.business_id = o.business_id AND c.id = o.client_id WHERE o.client_id IS NOT NULL AND c.id IS NULL');
  }
  await count('Abonos con más de un movimiento de ingreso', "SELECT COUNT(*) AS n FROM (SELECT business_id, customer_payment_id FROM cash_movements WHERE type = 'CUSTOMER_PAYMENT' AND direction = 'IN' AND customer_payment_id IS NOT NULL GROUP BY business_id, customer_payment_id HAVING COUNT(*) > 1) d");
  await count('Facturas con abonos registrados/reservados superiores al total', "SELECT COUNT(*) AS n FROM (SELECT s.business_id, s.id FROM sales s JOIN customer_payments p ON p.business_id = s.business_id AND p.sale_id = s.id WHERE p.status IN ('POSTED','PENDING') GROUP BY s.business_id, s.id, s.total HAVING SUM(p.amount) > s.total) d");
  await count('Abonos con estado inválido', "SELECT COUNT(*) AS n FROM customer_payments WHERE status IS NULL OR status NOT IN ('POSTED','VOID','PENDING')");
  await count('Abonos y movimientos de Caja inconsistentes', "SELECT COUNT(*) AS n FROM customer_payments p JOIN cash_movements m ON m.business_id = p.business_id AND m.customer_payment_id = p.id AND m.type = 'CUSTOMER_PAYMENT' AND m.direction = 'IN' WHERE m.amount <> p.amount OR (p.status = 'POSTED' AND m.status <> 'CONFIRMED') OR (p.status = 'PENDING' AND (m.status <> 'PENDING' OR p.payment_method NOT IN ('CARD','TRANSFER'))) OR (p.status = 'VOID' AND m.status <> 'VOID')");
  return issues;
}
async function main(args = process.argv.slice(2)) {
  const modes = ['--inspect', '--repair', '--verify'];
  const targets = args.filter(a => /^--expected-database=[a-zA-Z0-9_]+$/.test(a));
  if (!args.length || args.some(a => ![...modes, '--apply', ...targets].includes(a)) || args.filter(a => modes.includes(a)).length !== 1 || args.filter(a => a === '--apply').length > 1 || targets.length > 1 || (args.includes('--apply') && (!args.includes('--repair') || targets.length !== 1))) throw new Error('Uso: --inspect | --repair [--apply --expected-database=NOMBRE] | --verify');
  const config = readConfig(), pool = createDatabasePool(config.database);
  let db, locked = false;
  try {
    if (targets.length && targets[0].slice('--expected-database='.length) !== config.database.database) throw new Error('La base configurada no coincide con la aprobada');
    db = await pool.getConnection();
    const database = config.database.database;
    const schema = await inspect(db, database);
    if (args.includes('--inspect')) { console.log(JSON.stringify({ database, ...schema }, null, 2)); return; }
    const repair = plan(schema);
    if (!repair.blockers.length) repair.dataIssues = await validateData(db, schema);
    else repair.dataIssues = [];
    console.log(JSON.stringify({ database, mode: args.includes('--apply') ? 'APPLY' : 'READ_ONLY', ...repair }, null, 2));
    if (repair.blockers.length || repair.dataIssues.length) throw new Error('Reparación bloqueada: revisar incompatibilidades o datos; no se corrigieron automáticamente');
    if (args.includes('--verify')) { if (repair.statements.length) throw new Error('Esquema incompleto'); return; }
    if (!args.includes('--apply')) return;
    const [lock] = await db.execute('SELECT GET_LOCK(?, 0) AS acquired', ['pos_credit_repair_' + require('node:crypto').createHash('sha256').update(database).digest('hex').slice(0, 40)]);
    if (Number(lock[0].acquired) !== 1) throw new Error('Otra reparación está en ejecución');
    locked = true;
    await db.query('SET SESSION lock_wait_timeout = 5');
    // Reinspeccionar antes de cada DDL permite retomar un fallo parcial sin repetir columnas.
    for (;;) {
      const current = await inspect(db, database), next = plan(current);
      if (next.blockers.length || (await validateData(db, current)).length) throw new Error('El esquema o los datos cambiaron; detener y revisar');
      if (!next.statements.length) break;
      console.log('Aplicando: ' + next.statements[0]);
      await db.query(next.statements[0]);
    }
    console.log('Reparación verificada. DDL no transaccional; no se reescribieron abonos ni ventas.');
  } finally {
    try { if (locked) await db.query('DO RELEASE_ALL_LOCKS()'); }
    finally { if (db) db.release(); await pool.end(); }
  }
}
if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { inspect, plan, validateData, main };
