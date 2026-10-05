'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { plan, inspect, validateData, main } = require('../scripts/repair-credit.cjs');
function baseline() {
  const columns = [];
  const add = (table_name, column_name, column_type = 'bigint unsigned', is_nullable = 'YES', column_default = null) => columns.push({ table_name, column_name, column_type, is_nullable, column_default });
  for (const table of ['clients', 'customer_payments', 'cash_movements', 'sale_orders', 'sale_order_items', 'pos_operations']) add(table, 'business_id');
  for (const name of ['customer_payment_id', 'confirmed_by_user_id', 'confirmed_at']) add('cash_movements', name);
  add('cash_movements', 'status', "enum('PENDING','CONFIRMED','VOID')", 'NO', 'CONFIRMED');
  add('customer_payments', 'status', "enum('POSTED','VOID')", 'NO', 'POSTED');
  const keys = [
    { table_name: 'cash_movements', constraint_name: 'fk_payment', column_name: 'business_id', referenced_table_name: 'customer_payments', referenced_column_name: 'business_id' },
    { table_name: 'cash_movements', constraint_name: 'fk_payment', column_name: 'customer_payment_id', referenced_table_name: 'customer_payments', referenced_column_name: 'id' },
    { table_name: 'pos_operations', constraint_name: 'PRIMARY', column_name: 'business_id' },
    { table_name: 'pos_operations', constraint_name: 'PRIMARY', column_name: 'operation_key' }
  ];
  return { columns, keys, constraints: [] };
}
function repaired() {
  const schema = baseline();
  schema.columns.push({ table_name: 'clients', column_name: 'credit_days', column_type: 'smallint unsigned', is_nullable: 'NO', column_default: '30' },
    { table_name: 'sale_orders', column_name: 'client_id', column_type: 'bigint unsigned', is_nullable: 'YES', column_default: null },
    { table_name: 'sale_orders', column_name: 'credit_days', column_type: 'smallint unsigned', is_nullable: 'YES', column_default: null });
  schema.columns.find(c => c.table_name === 'customer_payments' && c.column_name === 'status').column_type = "enum('POSTED','VOID','PENDING')";
  schema.constraints.push({ table_name: 'clients', constraint_name: 'chk_clients_credit_days', constraint_type: 'CHECK', enforced: 'YES', check_clause: '(`credit_days` between 1 and 3650)' },
    { table_name: 'sale_orders', constraint_name: 'chk_sale_orders_credit_client', constraint_type: 'CHECK', enforced: 'YES', check_clause: '((`client_id` is null and `credit_days` is null) or (`client_id` is not null and `credit_days` between 1 and 3650))' });
  schema.keys.push({ table_name: 'sale_orders', constraint_name: 'fk_sale_orders_client', column_name: 'business_id', referenced_table_name: 'clients', referenced_column_name: 'business_id', delete_rule: 'RESTRICT', update_rule: 'RESTRICT' }, { table_name: 'sale_orders', constraint_name: 'fk_sale_orders_client', column_name: 'client_id', referenced_table_name: 'clients', referenced_column_name: 'id', delete_rule: 'RESTRICT', update_rule: 'RESTRICT' });
  return schema;
}
test('repair: esquema observado genera solo siete DDL aditivos y conserva ordinales del ENUM', () => {
  const result = plan(baseline()); assert.deepEqual(result.blockers, []); assert.equal(result.statements.length, 7);
  assert.match(result.statements.at(-1), /ENUM\('POSTED', 'VOID', 'PENDING'\)/);
  assert.ok(result.statements.every(s => s.startsWith('ALTER TABLE ')));
  assert.ok(result.statements.every(s => !/^(DROP|DELETE|TRUNCATE|UPDATE)\b/.test(s)));
});
test('repair: ya completado es no-op, con el orden de ENUM original o reparado', () => {
  for (const type of ["enum('POSTED','VOID','PENDING')", "enum('PENDING','POSTED','VOID')"]) {
    const schema = repaired(); schema.columns.find(c => c.table_name === 'customer_payments' && c.column_name === 'status').column_type = type;
    assert.deepEqual(plan(schema), { statements: [], blockers: [] });
  }
});
test('repair: reanuda columnas y CHECK existentes sin repetirlos', () => {
  const schema = repaired(); schema.columns = schema.columns.filter(c => !(c.table_name === 'sale_orders' && c.column_name === 'credit_days')); schema.constraints = schema.constraints.filter(c => c.table_name !== 'sale_orders');
  const result = plan(schema); assert.deepEqual(result.blockers, []); assert.equal(result.statements.length, 2); assert.match(result.statements[0], /ADD COLUMN credit_days/); assert.match(result.statements[1], /ADD CONSTRAINT chk_sale_orders/);
});
test('repair: bloquea tipos, restricciones y claves tenant incompatibles', () => {
  const schema = repaired(); schema.columns.find(c => c.table_name === 'clients' && c.column_name === 'credit_days').column_type = 'varchar(10)'; schema.constraints[0].enforced = 'NO'; schema.keys.find(k => k.column_name === 'customer_payment_id').constraint_name = 'otra_fk'; schema.keys = schema.keys.filter(k => k.table_name !== 'pos_operations');
  assert.equal(plan(schema).blockers.length, 4);
});
test('repair: inspección normaliza claves de information_schema y solo usa SELECT parametrizados', async () => {
  const calls = [], db = { execute: async (sql, values) => { calls.push({ sql, values }); return [[{ TABLE_NAME: 'clients', COLUMN_NAME: 'credit_days' }]]; } };
  const schema = await inspect(db, 'example'); assert.equal(schema.columns[0].table_name, 'clients'); assert.equal(calls.length, 3); assert.ok(calls.every(c => c.sql.startsWith('SELECT ') && c.values[0] === 'example'));
});
test('repair: revisión de datos informa problemas sin ejecutar escrituras', async () => {
  const queries = [], db = { query: async sql => { queries.push(sql); return [[{ n: 1 }]]; } };
  const issues = await validateData(db, repaired()); assert.ok(issues.length > 0); assert.ok(queries.every(sql => sql.startsWith('SELECT '))); assert.ok(issues.some(i => /superiores/.test(i.issue)));
});
test('repair: rechaza apply sin repair y argumentos ambiguos antes de abrir conexión', async () => {
  for (const args of [[], ['--apply'], ['--inspect', '--apply'], ['--repair', '--verify'], ['--unknown']]) await assert.rejects(main(args), /Uso:/);
});
