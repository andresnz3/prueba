'use strict';

const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const MIGRATIONS = [
  { version: '001', file: '001_authorization_grantor.sql', requires: [], checks: migration001 },
  { version: '002', file: '002_sales_operations.sql', requires: ['001'], checks: migration002 },
  { version: '003', file: '003_connected_cash_workflow.sql', requires: ['002'], checks: migration003 },
  { version: '004', file: '004_connected_credit_accounts.sql', requires: ['002', '003'], checks: migration004 },
  { version: '005', file: '005_supplier_payment_reconciliation.sql', requires: ['002', '003'], checks: migration005 },
  { version: '006', file: '006_system_admin_billing.sql', requires: [], checks: migration006 },
  { version: '007', file: '007_inventory_initial_migration.sql', requires: [], checks: migration007 },
  { version: '008', file: '008_local_sales_migration.sql', requires: ['002', '003'], checks: migration008 },
  { version: '009', file: '009_local_purchases_migration.sql', requires: [], checks: migration009 },
  { version: '010', file: '010_local_credit_migration.sql', requires: ['004', '008'], checks: migration010 },
  { version: '011', file: '011_business_settings_legal_name.sql', requires: [], checks: migration011 },
  { version: '012', file: '012_local_migration_archive.sql', requires: ['003', '008', '009', '010', '011'], checks: migration012 },
  { version: '013', file: '013_business_migration_gate.sql', requires: ['012'], checks: migration013 },
  { version: '014', file: '014_historical_migration_operations.sql', requires: ['013'], checks: migration014 },
  { version: '015', file: '015_historical_zero_inventory_events.sql', requires: ['014'], checks: migration015 },
  { version: '016', file: '016_historical_orders_without_price_snapshot.sql', requires: ['003', '015'], checks: migration016 },
  { version: '017', file: '017_connected_standard_plan.sql', requires: ['006'], checks: migration017 },
  { version: '018', file: '018_shared_login_rate_limits.sql', requires: ['017'], checks: migration018 },
  { version: '019', file: '019_local_perpetual_licenses.sql', requires: ['018'], checks: migration019 },
  { version: '020', file: '020_local_license_business_identity.sql', requires: ['019'], checks: migration020 }
];

const BASE_TABLES = [
  'businesses', 'users', 'business_settings', 'session_authorizations', 'sales', 'cash_movements', 'clients',
  'customer_payments', 'supplier_payments', 'purchases', 'purchase_items', 'inventory_movements'
];

const readMigration = migration => readFileSync(resolve(__dirname, '../../../database/migrations', migration.file), 'utf8');
const checksum = sql => createHash('sha256').update(sql).digest('hex');
const statements = sql => sql
  .split(/\r?\n/)
  .filter(line => !line.trimStart().startsWith('--'))
  .join('\n')
  .split(';')
  .map(statement => statement.trim())
  .filter(Boolean);

function parseArguments(args) {
  let mode = null, target = null, confirmation = null, allowPrincipal = false, installBase = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--apply' || arg === '--plan') {
      if (mode) throw new Error('Choose exactly one of --plan or --apply');
      mode = arg.slice(2);
    } else if (arg === '--target' || arg === '--confirm-target') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(arg + ' requires a database name');
      if (arg === '--target') {
        if (target !== null) throw new Error('Duplicate --target');
        target = value;
      } else {
        if (confirmation !== null) throw new Error('Duplicate --confirm-target');
        confirmation = value;
      }
    } else if (arg === '--allow-principal') {
      if (allowPrincipal) throw new Error('Duplicate --allow-principal');
      allowPrincipal = true;
    } else if (arg === '--install-base-schema') {
      if (installBase) throw new Error('Duplicate --install-base-schema');
      installBase = true;
    } else throw new Error('Unknown migration option: ' + arg);
  }
  if (!mode || !target || !confirmation || confirmation !== target) throw new Error('Use --plan or --apply with matching --target <database> and --confirm-target <database>');
  if (!/^[A-Za-z0-9_]{1,64}$/.test(target)) throw new Error('Database names may contain only letters, numbers, and underscores');
  if (target === 'pos_multitenant' && !allowPrincipal) throw new Error('The protected database requires explicit --allow-principal authorization');
  if (allowPrincipal && target !== 'pos_multitenant') throw new Error('--allow-principal is only valid with pos_multitenant');
  return { mode, target, allowPrincipal, installBase };
}

async function scalar(db, sql, params = []) {
  const [rows] = await db.execute(sql, params);
  return rows[0];
}

async function tableExists(db, database, table) {
  const row = await scalar(db, 'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=? AND table_name=?', [database, table]);
  return Number(row.n) === 1;
}

async function columnsExist(db, database, table, names) {
  const placeholders = names.map(() => '?').join(',');
  const row = await scalar(db, 'SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name IN (' + placeholders + ')', [database, table, ...names]);
  return Number(row.n) === names.length;
}

async function constraintExists(db, database, table, name, type) {
  const row = await scalar(db, 'SELECT COUNT(*) AS n FROM information_schema.table_constraints WHERE constraint_schema=? AND table_name=? AND constraint_name=? AND constraint_type=?', [database, table, name, type]);
  return Number(row.n) === 1;
}

async function indexExists(db, database, table, name) {
  const row = await scalar(db, 'SELECT COUNT(*) AS n FROM information_schema.statistics WHERE table_schema=? AND table_name=? AND index_name=?', [database, table, name]);
  return Number(row.n) > 0;
}

async function enumColumn(db, database, table, column, expected, defaultValue) {
  const row = await scalar(db, 'SELECT column_type AS columnType, column_default AS columnDefault, is_nullable AS nullable FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name=?', [database, table, column]);
  if (!row || row.nullable !== 'NO' || row.columnDefault !== defaultValue) return false;
  const values = [...String(row.columnType).matchAll(/'((?:[^']|'')*)'/g)].map(match => match[1].replace(/''/g, "'"));
  return values.length === expected.length && expected.every(value => values.includes(value));
}

async function migration001(db, database) {
  return [
    await columnsExist(db, database, 'session_authorizations', ['granted_by_user_id']),
    await indexExists(db, database, 'session_authorizations', 'idx_authorizations_grantor'),
    await constraintExists(db, database, 'session_authorizations', 'fk_authorizations_grantor', 'FOREIGN KEY')
  ];
}
async function migration002(db, database) {
  return [
    await tableExists(db, database, 'pos_operations'),
    await columnsExist(db, database, 'pos_operations', ['business_id', 'operation_key', 'user_id', 'kind', 'request_hash', 'result', 'created_at']),
    await constraintExists(db, database, 'pos_operations', 'fk_pos_operations_user', 'FOREIGN KEY'),
    await columnsExist(db, database, 'sales', ['cash_received', 'change_amount']),
    await constraintExists(db, database, 'sales', 'chk_sales_tender', 'CHECK')
  ];
}
async function migration003(db, database) {
  return [
    await enumColumn(db, database, 'businesses', 'sales_flow', ['DIRECT', 'CENTRALIZED'], 'DIRECT'),
    await columnsExist(db, database, 'sales', ['cashier_user_id']),
    await constraintExists(db, database, 'sales', 'fk_sales_cashier', 'FOREIGN KEY'),
    await columnsExist(db, database, 'cash_movements', ['confirmed_by_user_id', 'confirmed_at']),
    await constraintExists(db, database, 'cash_movements', 'fk_cash_movement_confirmed_by', 'FOREIGN KEY'),
    await tableExists(db, database, 'sale_orders'),
    await columnsExist(db, database, 'sale_orders', ['id', 'business_id', 'created_by_user_id', 'status', 'sale_id', 'price_type', 'discount_percent', 'estimated_subtotal', 'estimated_discount', 'estimated_total', 'detail', 'created_at', 'completed_at', 'completed_by_user_id', 'cancelled_at', 'cancelled_by_user_id']),
    await tableExists(db, database, 'sale_order_items'),
    await columnsExist(db, database, 'sale_order_items', ['business_id', 'order_id', 'line_number', 'product_id', 'product_name', 'barcode', 'quantity', 'estimated_unit_price', 'estimated_subtotal']),
    await indexExists(db, database, 'sale_orders', 'ix_sale_orders_queue'),
    await constraintExists(db, database, 'sale_orders', 'fk_sale_orders_creator', 'FOREIGN KEY'),
    await constraintExists(db, database, 'sale_orders', 'fk_sale_orders_sale', 'FOREIGN KEY'),
    await constraintExists(db, database, 'sale_order_items', 'fk_sale_order_items_order', 'FOREIGN KEY'),
    await constraintExists(db, database, 'sale_order_items', 'fk_sale_order_items_product', 'FOREIGN KEY')
  ];
}
async function migration004(db, database) {
  return [
    await columnsExist(db, database, 'clients', ['credit_days']),
    await columnsExist(db, database, 'sale_orders', ['client_id', 'credit_days']),
    await constraintExists(db, database, 'clients', 'chk_clients_credit_days', 'CHECK'),
    await constraintExists(db, database, 'sale_orders', 'chk_sale_orders_credit_client', 'CHECK'),
    await constraintExists(db, database, 'sale_orders', 'fk_sale_orders_client', 'FOREIGN KEY'),
    await enumColumn(db, database, 'customer_payments', 'status', ['PENDING', 'POSTED', 'VOID'], 'POSTED')
  ];
}
async function migration005(db, database) {
  return [await enumColumn(db, database, 'supplier_payments', 'status', ['POSTED', 'VOID', 'PENDING'], 'POSTED')];
}
async function migration006(db, database) {
  return [
    await columnsExist(db, database, 'business_subscriptions', ['business_id', 'plan_code', 'next_due_date', 'created_at', 'updated_at']),
    await constraintExists(db, database, 'business_subscriptions', 'chk_business_subscriptions_plan', 'CHECK'),
    await constraintExists(db, database, 'business_subscriptions', 'chk_business_subscriptions_local_due', 'CHECK'),
    await constraintExists(db, database, 'business_subscriptions', 'fk_business_subscriptions_business', 'FOREIGN KEY'),
    await columnsExist(db, database, 'business_subscription_payments', ['id', 'business_id', 'amount', 'payment_date', 'created_by_user_id', 'created_at']),
    await indexExists(db, database, 'business_subscription_payments', 'idx_business_subscription_payments_history'),
    await constraintExists(db, database, 'business_subscription_payments', 'chk_business_subscription_payments_amount', 'CHECK'),
    await constraintExists(db, database, 'business_subscription_payments', 'fk_business_subscription_payments_business', 'FOREIGN KEY')
  ];
}
async function migration007(db, database) {
  const row = await scalar(db, 'SELECT column_type AS columnType FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name=?', [database, 'inventory_movements', 'type']);
  return [Boolean(row && String(row.columnType).includes("'MIGRACION_INICIAL'"))];
}
async function migration008(db, database) {
  return [
    await tableExists(db, database, 'migration_sales_references'),
    await columnsExist(db, database, 'migration_sales_references', ['business_id', 'source_business_key', 'source_sale_key', 'source_sale_id', 'fingerprint', 'sale_id', 'created_at']),
    await indexExists(db, database, 'migration_sales_references', 'uq_migration_sales_sale'),
    await indexExists(db, database, 'migration_sales_references', 'idx_migration_sales_fingerprint'),
    await constraintExists(db, database, 'migration_sales_references', 'fk_migration_sales_reference_business', 'FOREIGN KEY'),
    await constraintExists(db, database, 'migration_sales_references', 'fk_migration_sales_reference_sale', 'FOREIGN KEY')
  ];
}
async function migration009(db, database) {
  return [
    await columnsExist(db, database, 'purchases', ['discount', 'notes', 'is_historical']),
    await columnsExist(db, database, 'purchase_items', ['discount', 'tax']),
    await tableExists(db, database, 'migration_purchase_references'),
    await columnsExist(db, database, 'migration_purchase_references', ['business_id', 'source_business_key', 'source_purchase_key', 'source_purchase_id', 'fingerprint', 'purchase_id', 'created_at']),
    await constraintExists(db, database, 'purchases', 'chk_purchases_discount', 'CHECK'),
    await constraintExists(db, database, 'purchase_items', 'chk_purchase_items_history_amounts', 'CHECK'),
    await indexExists(db, database, 'migration_purchase_references', 'uq_migration_purchases_purchase'),
    await indexExists(db, database, 'migration_purchase_references', 'idx_migration_purchases_fingerprint'),
    await constraintExists(db, database, 'migration_purchase_references', 'fk_migration_purchases_reference_business', 'FOREIGN KEY'),
    await constraintExists(db, database, 'migration_purchase_references', 'fk_migration_purchases_reference_purchase', 'FOREIGN KEY')
  ];
}
async function migration010(db, database) {
  return [
    await columnsExist(db, database, 'sales', ['is_historical']),
    await columnsExist(db, database, 'customer_payments', ['is_historical', 'source_status']),
    await columnsExist(db, database, 'migration_sales_references', ['source_client_id', 'source_invoice_number']),
    await tableExists(db, database, 'migration_credit_payment_references'),
    await columnsExist(db, database, 'migration_credit_payment_references', ['business_id', 'source_business_key', 'source_payment_key', 'source_payment_id', 'source_client_id', 'source_sale_key', 'fingerprint', 'customer_payment_id', 'created_at']),
    await indexExists(db, database, 'sales', 'idx_sales_business_historical_credit'),
    await indexExists(db, database, 'customer_payments', 'idx_customer_payments_business_historical'),
    await indexExists(db, database, 'migration_credit_payment_references', 'uq_migration_credit_payment'),
    await indexExists(db, database, 'migration_credit_payment_references', 'idx_migration_credit_payment_source'),
    await constraintExists(db, database, 'migration_credit_payment_references', 'fk_migration_credit_payment_business', 'FOREIGN KEY'),
    await constraintExists(db, database, 'migration_credit_payment_references', 'fk_migration_credit_payment_record', 'FOREIGN KEY')
  ];
}
async function migration011(db, database) {
  return [await tableExists(db, database, 'business_settings') && await columnsExist(db, database, 'business_settings', ['legal_name'])];
}
async function migration012(db, database) {
  return [
    await tableExists(db, database, 'migration_import_batches'),
    await columnsExist(db, database, 'migration_import_batches', ['id', 'business_id', 'source_business_key', 'source_business_name', 'package_sha256', 'package_version', 'status', 'current_stage', 'actor_business_id', 'actor_user_id', 'manifest', 'stage_results', 'created_at', 'updated_at', 'completed_at']),
    await indexExists(db, database, 'migration_import_batches', 'uq_migration_import_source'),
    await constraintExists(db, database, 'migration_import_batches', 'fk_migration_import_business', 'FOREIGN KEY'),
    await constraintExists(db, database, 'migration_import_batches', 'fk_migration_import_actor', 'FOREIGN KEY'),
    await tableExists(db, database, 'migration_source_records'),
    await columnsExist(db, database, 'migration_source_records', ['business_id', 'batch_id', 'entity_type', 'source_record_key', 'source_fingerprint', 'record_status', 'target_table', 'target_record_id', 'source_actor', 'pending_reason', 'source_payload', 'created_at', 'updated_at']),
    await indexExists(db, database, 'migration_source_records', 'idx_migration_source_record_status'),
    await constraintExists(db, database, 'migration_source_records', 'fk_migration_source_record_batch', 'FOREIGN KEY')
  ];
}
async function migration013(db, database) {
  return [
    await tableExists(db, database, 'business_migration_controls'),
    await columnsExist(db, database, 'business_migration_controls', ['business_id', 'state', 'source_business_key', 'batch_id', 'actor_business_id', 'actor_user_id', 'created_at', 'completed_at']),
    await enumColumn(db, database, 'business_migration_controls', 'state', ['PENDING', 'COMPLETE'], 'PENDING'),
    await indexExists(db, database, 'business_migration_controls', 'idx_business_migration_control_state'),
    await constraintExists(db, database, 'business_migration_controls', 'chk_business_migration_control_state', 'CHECK'),
    await constraintExists(db, database, 'business_migration_controls', 'fk_business_migration_control_business', 'FOREIGN KEY'),
    await constraintExists(db, database, 'business_migration_controls', 'fk_business_migration_control_actor', 'FOREIGN KEY'),
    await constraintExists(db, database, 'business_migration_controls', 'fk_business_migration_control_batch', 'FOREIGN KEY')
  ];
}
async function migration014(db, database) {
  return [
    await columnsExist(db, database, 'cash_sessions', ['is_historical', 'source_opened_by', 'source_closed_by', 'source_status']),
      await columnsExist(db, database, 'cash_movements', ['is_historical', 'source_actor', 'source_status', 'source_reference_type', 'source_reference_id', 'source_method']),
    await columnsExist(db, database, 'inventory_movements', ['is_historical', 'source_actor', 'source_reference_type', 'source_reference_id']),
      await columnsExist(db, database, 'expenses', ['is_historical', 'source_actor', 'source_cancelled_by', 'source_method']),
    await columnsExist(db, database, 'supplier_payments', ['is_historical', 'source_actor', 'source_cancelled_by']),
    await columnsExist(db, database, 'sales', ['source_actor', 'source_cancelled_by']),
    await columnsExist(db, database, 'customer_payments', ['source_actor', 'source_cancelled_by']),
    await columnsExist(db, database, 'purchases', ['source_actor', 'source_cancelled_by']),
      await columnsExist(db, database, 'sale_orders', ['is_historical', 'source_actor', 'source_cancelled_by', 'source_completed_by']),
    await tableExists(db, database, 'migration_supplier_payment_references'),
    await columnsExist(db, database, 'migration_supplier_payment_references', ['business_id', 'source_business_key', 'source_payment_key', 'source_payment_id', 'fingerprint', 'supplier_payment_id', 'created_at']),
    await indexExists(db, database, 'migration_supplier_payment_references', 'uq_migration_supplier_payment_target'),
    await constraintExists(db, database, 'migration_supplier_payment_references', 'fk_migration_supplier_payment_reference_business', 'FOREIGN KEY'),
    await constraintExists(db, database, 'migration_supplier_payment_references', 'fk_migration_supplier_payment_reference_payment', 'FOREIGN KEY')
  ];
}
async function migration015(db, database) {
  return [
    await tableExists(db, database, 'migration_zero_inventory_events'),
    await columnsExist(db, database, 'migration_zero_inventory_events', ['id', 'business_id', 'batch_id', 'source_record_key', 'product_id', 'source_type', 'quantity', 'stock_after', 'unit_cost', 'reason', 'source_actor', 'source_reference_type', 'source_reference_id', 'source_payload', 'occurred_at', 'created_at']),
    await indexExists(db, database, 'migration_zero_inventory_events', 'uq_migration_zero_inventory_source'),
    await indexExists(db, database, 'migration_zero_inventory_events', 'idx_migration_zero_inventory_kardex'),
    await constraintExists(db, database, 'migration_zero_inventory_events', 'chk_migration_zero_inventory_quantity', 'CHECK'),
    await constraintExists(db, database, 'migration_zero_inventory_events', 'fk_migration_zero_inventory_batch', 'FOREIGN KEY'),
    await constraintExists(db, database, 'migration_zero_inventory_events', 'fk_migration_zero_inventory_product', 'FOREIGN KEY')
  ];
}
async function migration016(db, database) {
  const nullable = async column => {
    const row = await scalar(db, 'SELECT is_nullable AS nullable FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name=?', [database, 'sale_order_items', column]);
    return row?.nullable === 'YES';
  };
  const defaultAvailable = await scalar(db, 'SELECT column_default AS columnDefault FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name=?', [database, 'sale_order_items', 'price_snapshot_available']);
  return [
    await nullable('estimated_unit_price'),
    await nullable('estimated_subtotal'),
    await columnsExist(db, database, 'sale_order_items', ['price_snapshot_available']),
    Number(defaultAvailable?.columnDefault) === 1,
    await constraintExists(db, database, 'sale_order_items', 'chk_sale_order_item_price_snapshot', 'CHECK')
  ];
}
async function migration017(db, database) {
  const row = await scalar(db,
    'SELECT cc.check_clause AS checkClause FROM information_schema.check_constraints cc JOIN information_schema.table_constraints tc ON tc.constraint_schema=cc.constraint_schema AND tc.constraint_name=cc.constraint_name WHERE cc.constraint_schema=? AND tc.table_name=? AND tc.constraint_name=? AND tc.constraint_type=\'CHECK\'',
    [database, 'business_subscriptions', 'chk_business_subscriptions_plan']);
  const clause = String(row?.checkClause || '').toUpperCase();
  return [Boolean(row && ['LOCAL', 'CONECTADO_BASICO', 'CONECTADO_ESTANDAR', 'CONECTADO_PREMIUM'].every(code => clause.includes(code)))];
}
async function migration018(db, database) {
  return [
    await tableExists(db, database, 'auth_login_rate_limits'),
    await columnsExist(db, database, 'auth_login_rate_limits', ['bucket_hash', 'attempts', 'window_started_at', 'updated_at']),
    await indexExists(db, database, 'auth_login_rate_limits', 'idx_auth_login_rate_limits_updated'),
    await constraintExists(db, database, 'auth_login_rate_limits', 'chk_auth_login_rate_limits_attempts', 'CHECK')
  ];
}

async function migration019(db, database) {
  const tables = ['local_licenses', 'local_license_installations', 'local_license_events', 'local_license_challenges', 'local_license_rate_limits'];
  const tableChecks = await Promise.all(tables.map(table => tableExists(db, database, table)));
  const columns = await Promise.all([
    columnsExist(db, database, 'local_licenses', ['code_hash', 'customer_name', 'customer_reference', 'status', 'active_installation_hash', 'active_public_key', 'issued_by_user_id', 'issued_by_username', 'created_at', 'activated_at', 'revoked_at', 'revocation_reason', 'transfer_count']),
    columnsExist(db, database, 'local_license_installations', ['license_id', 'installation_hash', 'public_key', 'public_key_hash', 'state', 'activated_at', 'last_seen_at', 'ended_at']),
    columnsExist(db, database, 'local_license_events', ['license_id', 'event_type', 'actor_user_id', 'actor_username', 'reason', 'details', 'created_at']),
    columnsExist(db, database, 'local_license_challenges', ['challenge_id', 'challenge_hash', 'purpose', 'expires_at', 'used_at']),
    columnsExist(db, database, 'local_license_rate_limits', ['bucket_hash', 'attempts', 'window_started_at', 'updated_at'])
  ]);
  const indexes = await Promise.all([
    indexExists(db, database, 'local_licenses', 'uq_local_licenses_code_hash'),
    indexExists(db, database, 'local_licenses', 'idx_local_licenses_status_created'),
    indexExists(db, database, 'local_licenses', 'idx_local_licenses_customer'),
    indexExists(db, database, 'local_license_installations', 'uq_local_license_installation'),
    indexExists(db, database, 'local_license_installations', 'idx_local_license_installation_state'),
    indexExists(db, database, 'local_license_events', 'idx_local_license_events_license_date'),
    indexExists(db, database, 'local_license_challenges', 'idx_local_license_challenges_expiry'),
    indexExists(db, database, 'local_license_rate_limits', 'idx_local_license_rate_limits_updated')
  ]);
  const foreignKeys = await Promise.all([
    constraintExists(db, database, 'local_license_installations', 'fk_local_license_installation_license', 'FOREIGN KEY'),
    constraintExists(db, database, 'local_license_events', 'fk_local_license_event_license', 'FOREIGN KEY')
  ]);
  const checks = await Promise.all([
    constraintExists(db, database, 'local_license_rate_limits', 'chk_local_license_rate_limits_attempts', 'CHECK')
  ]);
  return [...tableChecks, ...columns, ...indexes, ...foreignKeys, ...checks];
}

async function migration020(db, database) {
  const businessHashColumn = async table => {
    const row = await scalar(db, 'SELECT data_type AS dataType,character_maximum_length AS maxLength,is_nullable AS nullable,column_default AS columnDefault,character_set_name AS characterSet,collation_name AS collationName FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name=\'local_business_id_hash\'', [database, table]);
    return Boolean(row && row.dataType === 'char' && Number(row.maxLength) === 64 && row.nullable === 'YES' && row.columnDefault === null && row.characterSet === 'ascii' && row.collationName === 'ascii_bin');
  };
  const columns = await Promise.all([
    businessHashColumn('local_licenses'),
    businessHashColumn('local_license_installations')
  ]);
  const businessHashIndex = async (table, index) => {
    const row = await scalar(db, 'SELECT column_name AS columnName,non_unique AS nonUnique FROM information_schema.statistics WHERE table_schema=? AND table_name=? AND index_name=? AND seq_in_index=1', [database, table, index]);
    return Boolean(row && row.columnName === 'local_business_id_hash' && Number(row.nonUnique) === 1);
  };
  const indexes = await Promise.all([
    businessHashIndex('local_licenses', 'idx_local_licenses_business_id_hash'),
    businessHashIndex('local_license_installations', 'idx_local_license_installations_business_id_hash')
  ]);
  return [...columns, ...indexes];
}

async function migrationState(migration, db, database) {
  const checks = await migration.checks(db, database);
  const present = checks.filter(Boolean).length;
  if (present === 0) return 'pending';
  if (present === checks.length) return 'applied';
  return 'partial';
}

async function inspectMysql(db, database) {
  const row = await scalar(db, 'SELECT DATABASE() AS databaseName, VERSION() AS version');
  if (!row || row.databaseName !== database) throw new Error('Connected database does not match the confirmed target');
  if (/mariadb/i.test(row.version)) throw new Error('This migration set requires MySQL, not MariaDB');
  const version = String(row.version).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!version || Number(version[1]) < 8 || (Number(version[1]) === 8 && Number(version[2]) === 0 && Number(version[3]) < 16)) throw new Error('MySQL 8.0.16 or newer is required for enforced CHECK constraints');
}

async function inspectEnvironment(db, database) {
  await inspectMysql(db, database);
  const placeholders = BASE_TABLES.map(() => '?').join(',');
  const [rows] = await db.execute('SELECT table_name AS tableName FROM information_schema.tables WHERE table_schema=? AND table_name IN (' + placeholders + ')', [database, ...BASE_TABLES]);
  const found = new Set(rows.map(item => item.tableName));
  const missing = BASE_TABLES.filter(table => !found.has(table));
  if (missing.length) throw new Error('The base schema is incomplete: ' + missing.join(', '));
}

function baseSchemaStatements() {
  const schema = readFileSync(resolve(__dirname, '../../../database/schema.sql'), 'utf8');
  const start = schema.indexOf('CREATE TABLE businesses');
  if (start < 0) throw new Error('Base schema does not contain the expected first table');
  const createStatements = statements(schema.slice(start));
  if (!createStatements.length || createStatements.some(statement => !/^CREATE TABLE\s/i.test(statement))) throw new Error('Base schema contains an unsupported statement; no automatic import was attempted');
  return createStatements;
}

async function inspectEmptyTarget(db, database) {
  await inspectMysql(db, database);
  const [existing] = await db.execute('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=?', [database]);
  if (Number(existing[0].n) !== 0) throw new Error('Base-schema installation requires an empty database; no tables were changed');
}

async function planNewInstall(db, database) {
  await inspectEmptyTarget(db, database);
  return { baseTables: baseSchemaStatements().length, migrations: MIGRATIONS.map(migration => ({ version: migration.version, status: 'pending', action: 'planned' })) };
}

async function installBaseSchema(db, database) {
  await inspectEmptyTarget(db, database);
  const createStatements = baseSchemaStatements();
  for (const statement of createStatements) await db.execute(statement);
  const placeholders = BASE_TABLES.map(() => '?').join(',');
  const [rows] = await db.execute('SELECT table_name AS tableName FROM information_schema.tables WHERE table_schema=? AND table_name IN (' + placeholders + ')', [database, ...BASE_TABLES]);
  const found = new Set(rows.map(row => row.tableName));
  const missing = BASE_TABLES.filter(table => !found.has(table));
  if (missing.length) throw new Error('Base schema import was incomplete: ' + missing.join(', ') + '; inspect the empty target before retrying');
  return createStatements.length;
}

async function readMigrationRecords(db, database, hasLedger) {
  if (!hasLedger) return new Map();
  const [rows] = await db.execute('SELECT version, file_name AS fileName, checksum, status FROM schema_migrations ORDER BY version');
  const known = new Map(MIGRATIONS.map(migration => [migration.version, migration]));
  const records = new Map();
  for (const row of rows) {
    const migration = known.get(row.version);
    if (!migration || migration.file !== row.fileName) throw new Error('Unknown migration ledger entry: ' + row.version);
    if (row.checksum !== checksum(readMigration(migration))) throw new Error('Migration file checksum changed after application: ' + row.version);
    if (!['RUNNING', 'APPLIED'].includes(row.status)) throw new Error('Invalid migration ledger state: ' + row.version);
    records.set(row.version, row);
  }
  return records;
}

async function ensureLedger(db, database) {
  if (await tableExists(db, database, 'schema_migrations')) {
    const [columns] = await db.execute('SELECT column_name AS columnName FROM information_schema.columns WHERE table_schema=? AND table_name=\'schema_migrations\'', [database]);
    const found = new Set(columns.map(row => row.columnName));
    if (!['version', 'file_name', 'checksum', 'status', 'started_at', 'applied_at'].every(name => found.has(name))) throw new Error('schema_migrations exists with an incompatible layout');
    return;
  }
  await db.execute("CREATE TABLE schema_migrations (version CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, file_name VARCHAR(255) NOT NULL, checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, status ENUM('RUNNING','APPLIED') NOT NULL, started_at DATETIME(3) NOT NULL, applied_at DATETIME(3) NULL, PRIMARY KEY (version)) ENGINE=InnoDB");
}

async function migrate(db, database, mode = 'plan', options = {}) {
  if (!['plan', 'apply'].includes(mode)) throw new Error('Invalid migration mode');
  const throughVersion = options.throughVersion || null;
  if (throughVersion && !MIGRATIONS.some(item => item.version === throughVersion)) throw new Error('Invalid migration version boundary');
  await inspectEnvironment(db, database);
  let hasLedger = await tableExists(db, database, 'schema_migrations');
  if (mode === 'apply') {
    await ensureLedger(db, database);
    hasLedger = true;
  } else if (hasLedger) await ensureLedger(db, database);
  const records = await readMigrationRecords(db, database, hasLedger);
  const results = [], completed = new Set();
  const migrations = throughVersion ? MIGRATIONS.filter(item => item.version <= throughVersion) : MIGRATIONS;
  for (const migration of migrations) {
    const state = await migrationState(migration, db, database);
    const record = records.get(migration.version);
    if (state === 'partial') throw new Error('Migration ' + migration.version + ' is partially present; inspect information_schema before continuing');
    if (record?.status === 'APPLIED' && state !== 'applied') throw new Error('Migration ' + migration.version + ' is recorded as applied but its schema is incomplete');
    if (record?.status === 'RUNNING' && state !== 'applied') throw new Error('Migration ' + migration.version + ' was interrupted; inspect information_schema before continuing');
    for (const dependency of migration.requires) if (!completed.has(dependency) && !(records.get(dependency)?.status === 'APPLIED' && await migrationState(MIGRATIONS.find(item => item.version === dependency), db, database) === 'applied')) {
      throw new Error('Migration ' + migration.version + ' requires migration ' + dependency);
    }
    if (state === 'applied') {
      completed.add(migration.version);
      if (mode === 'apply' && !record) {
        const sql = readMigration(migration);
        await db.execute("INSERT INTO schema_migrations (version,file_name,checksum,status,started_at,applied_at) VALUES (?,?,?,'APPLIED',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [migration.version, migration.file, checksum(sql)]);
        results.push({ version: migration.version, status: 'applied', action: 'adopted' });
      } else if (mode === 'apply' && record?.status === 'RUNNING') {
        await db.execute("UPDATE schema_migrations SET status='APPLIED', applied_at=UTC_TIMESTAMP(3) WHERE version=? AND status='RUNNING'", [migration.version]);
        results.push({ version: migration.version, status: 'applied', action: 'recovered' });
      } else results.push({ version: migration.version, status: 'applied', action: record ? 'skipped' : 'would-adopt' });
      continue;
    }
    results.push({ version: migration.version, status: 'pending', action: mode === 'plan' ? 'planned' : 'pending' });
    if (mode === 'plan') {
      completed.add(migration.version);
      continue;
    }
    const sql = readMigration(migration), hash = checksum(sql);
    await db.execute("INSERT INTO schema_migrations (version,file_name,checksum,status,started_at) VALUES (?,?,?,'RUNNING',UTC_TIMESTAMP(3))", [migration.version, migration.file, hash]);
    for (const statement of statements(sql)) await db.execute(statement);
    if (await migrationState(migration, db, database) !== 'applied') throw new Error('Migration ' + migration.version + ' finished without reaching its expected schema');
    await db.execute("UPDATE schema_migrations SET status='APPLIED', applied_at=UTC_TIMESTAMP(3) WHERE version=? AND status='RUNNING'", [migration.version]);
    completed.add(migration.version);
    results[results.length - 1] = { version: migration.version, status: 'applied', action: 'applied' };
  }
  return results;
}

module.exports = { MIGRATIONS, BASE_TABLES, checksum, statements, parseArguments, migrationState, planNewInstall, installBaseSchema, migrate };
