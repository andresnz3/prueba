'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
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

test('migration catalog covers 001 through 023 in dependency order and preserves 021 history', () => {
  assert.deepEqual(MIGRATIONS.map(migration => migration.version), ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023']);
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
  assert.deepEqual(MIGRATIONS.find(migration => migration.version === '018').requires, ['017']);
  assert.deepEqual(MIGRATIONS.find(migration => migration.version === '019').requires, ['018']);
  assert.deepEqual(MIGRATIONS.find(migration => migration.version === '020').requires, ['019']);
  assert.deepEqual(MIGRATIONS.find(migration => migration.version === '021').requires, ['020']);
  assert.deepEqual(MIGRATIONS.find(migration => migration.version === '022').requires, ['021']);
  assert.deepEqual(MIGRATIONS.find(migration => migration.version === '023').requires, ['004']);
  assert.deepEqual(MIGRATIONS.find(migration => migration.version === '021').legacyChecksums, [
    '3d8640d361526861789e9935aabb584f75ee1944ccf1aa4ecb3b37331b97a016',
    'dbd9fb61f5126e1c2da5313b536437332c40201d8646def7bdcddb529cbfe237'
  ]);
  const sql021 = readFileSync(resolve(__dirname, '../../database/migrations/021_business_product_categories.sql'), 'utf8');
  assert.match(sql021, /UNIQUE KEY uq_product_categories_business_name/);
  assert.match(sql021, /FOREIGN KEY \(business_id\) REFERENCES businesses/);
  assert.match(sql021, /INSERT IGNORE INTO product_categories/);
  assert.match(sql021, /active TINYINT\(1\) NOT NULL DEFAULT 1/);
  const sql022 = readFileSync(resolve(__dirname, '../../database/migrations/022_add_product_category_active.sql'), 'utf8');
  assert.match(sql022, /ADD COLUMN active TINYINT\(1\) NOT NULL DEFAULT 1/);
  assert.doesNotMatch(sql022, /\b(?:UPDATE|DELETE|DROP)\b/i);
  const sql020 = readFileSync(resolve(__dirname, '../../database/migrations/020_local_license_business_identity.sql'), 'utf8');
  assert.match(sql020, /local_business_id_hash CHAR\(64\).*NULL/s);
  assert.doesNotMatch(sql020, /\b(?:UPDATE|DELETE|DROP)\b/i);
});

test('SQL splitting removes comments and keeps each migration statement intact', () => {
  const sql = '-- comment\nALTER TABLE supplier_payments MODIFY status ENUM(\'POSTED\', \'VOID\', \'PENDING\');\n-- next\nCREATE TABLE audit_fixture (id INT);';
  assert.deepEqual(statements(sql), ["ALTER TABLE supplier_payments MODIFY status ENUM('POSTED', 'VOID', 'PENDING')", 'CREATE TABLE audit_fixture (id INT)']);
  assert.equal(checksum(sql).length, 64);
});
