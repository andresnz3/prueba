'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MIGRATIONS, checksum, statements, parseArguments } = require('../src/services/schema-migrations');

test('migration CLI requires an exact target and explicit application mode', () => {
  assert.deepEqual(parseArguments(['--apply', '--target', 'pos_new_shop', '--confirm-target', 'pos_new_shop']), {
    mode: 'apply', target: 'pos_new_shop', allowPrincipal: false, installBase: false
  });
  assert.throws(() => parseArguments(['--apply', '--target', 'pos_multitenant', '--confirm-target', 'pos_multitenant']), /allow-principal/);
  assert.throws(() => parseArguments(['--apply', '--target', 'pos_new_shop', '--confirm-target', 'pos_other']), /matching/);
  assert.throws(() => parseArguments(['--plan', '--apply', '--target', 'pos_new_shop', '--confirm-target', 'pos_new_shop']), /exactly one/);
  assert.throws(() => parseArguments(['--apply', '--target', 'pos-new-shop', '--confirm-target', 'pos-new-shop']), /letters, numbers, and underscores/);
});

test('protected database requires a separate explicit switch', () => {
  assert.deepEqual(parseArguments(['--plan', '--target', 'pos_multitenant', '--confirm-target', 'pos_multitenant', '--allow-principal']), {
    mode: 'plan', target: 'pos_multitenant', allowPrincipal: true, installBase: false
  });
  assert.throws(() => parseArguments(['--apply', '--target', 'pos_new_shop', '--confirm-target', 'pos_new_shop', '--allow-principal']), /only valid/);
  assert.equal(parseArguments(['--plan', '--target', 'pos_new_shop', '--confirm-target', 'pos_new_shop', '--install-base-schema']).installBase, true);
  assert.equal(parseArguments(['--apply', '--target', 'pos_new_shop', '--confirm-target', 'pos_new_shop', '--install-base-schema']).installBase, true);
});

test('migration catalog covers 001 through 017 in dependency order', () => {
  assert.deepEqual(MIGRATIONS.map(migration => migration.version), ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013', '014', '015', '016', '017']);
  assert.deepEqual(MIGRATIONS.find(migration => migration.version === '002').requires, ['001']);
  assert.deepEqual(MIGRATIONS.find(migration => migration.version === '005').requires, ['002', '003']);
  assert.deepEqual(MIGRATIONS.find(migration => migration.version === '010').requires, ['004', '008']);
  assert.deepEqual(MIGRATIONS.find(migration => migration.version === '011').requires, []);
  assert.deepEqual(MIGRATIONS.find(migration => migration.version === '012').requires, ['003', '008', '009', '010', '011']);
  assert.deepEqual(MIGRATIONS.find(migration => migration.version === '013').requires, ['012']);
  assert.deepEqual(MIGRATIONS.find(migration => migration.version === '014').requires, ['013']);
  assert.deepEqual(MIGRATIONS.find(migration => migration.version === '015').requires, ['014']);
  assert.deepEqual(MIGRATIONS.find(migration => migration.version === '016').requires, ['003', '015']);
  assert.deepEqual(MIGRATIONS.find(migration => migration.version === '017').requires, ['006']);
});

test('SQL splitting removes comments and keeps each migration statement intact', () => {
  const sql = '-- comment\nALTER TABLE supplier_payments MODIFY status ENUM(\'POSTED\', \'VOID\', \'PENDING\');\n-- next\nCREATE TABLE audit_fixture (id INT);';
  assert.deepEqual(statements(sql), ["ALTER TABLE supplier_payments MODIFY status ENUM('POSTED', 'VOID', 'PENDING')", 'CREATE TABLE audit_fixture (id INT)']);
  assert.equal(checksum(sql).length, 64);
});
