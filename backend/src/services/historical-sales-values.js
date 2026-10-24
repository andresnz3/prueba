'use strict';

const METHOD_ALIASES = new Map([
  ['CASH', 'CASH'], ['EFECTIVO', 'CASH'], ['CONTADO', 'CASH'],
  ['CARD', 'CARD'], ['TARJETA', 'CARD'], ['TARJETA_CREDITO', 'CARD'], ['TARJETA_DE_CREDITO', 'CARD'], ['TARJETA_DEBITO', 'CARD'], ['TARJETA_DE_DEBITO', 'CARD'], ['CREDIT_CARD', 'CARD'], ['DEBIT_CARD', 'CARD'], ['POS', 'CARD'],
  ['TRANSFER', 'TRANSFER'], ['TRANSFERENCIA', 'TRANSFER'], ['TRANSFERENCIA_BANCARIA', 'TRANSFER'], ['BANK', 'TRANSFER'], ['BANK_TRANSFER', 'TRANSFER'], ['BANCO', 'TRANSFER'], ['WIRE', 'TRANSFER'], ['WIRE_TRANSFER', 'TRANSFER'],
  ['CREDIT', 'CREDIT'], ['CREDITO', 'CREDIT'], ['FIADO', 'CREDIT'], ['CREDITO_CLIENTE', 'CREDIT'], ['CLIENT_CREDIT', 'CREDIT']
]);

function normalizeHistoricalPaymentMethod(value) {
  if (typeof value !== 'string') return null;
  const key = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return METHOD_ALIASES.get(key) || null;
}

function historicalPaymentMethodSql(saleAlias = 's') {
  const sourceValue = "COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(source_record.source_payload, '$.medioPago')), 'null'), NULLIF(JSON_UNQUOTE(JSON_EXTRACT(source_record.source_payload, '$.medio_pago')), 'null'), NULLIF(JSON_UNQUOTE(JSON_EXTRACT(source_record.source_payload, '$.paymentMethod')), 'null'), NULLIF(JSON_UNQUOTE(JSON_EXTRACT(source_record.source_payload, '$.payment_method')), 'null'), NULLIF(JSON_UNQUOTE(JSON_EXTRACT(source_record.source_payload, '$.metodoPago')), 'null'))";
  const sourceToken = `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(UPPER(TRIM(${sourceValue})), 'Á', 'A'), 'É', 'E'), 'Í', 'I'), 'Ó', 'O'), 'Ú', 'U'), ' ', '_'), '-', '_')`;
  return `COALESCE((SELECT CASE ${sourceToken} WHEN 'CASH' THEN 'CASH' WHEN 'EFECTIVO' THEN 'CASH' WHEN 'CONTADO' THEN 'CASH' WHEN 'CARD' THEN 'CARD' WHEN 'TARJETA' THEN 'CARD' WHEN 'TARJETA_CREDITO' THEN 'CARD' WHEN 'TARJETA_DE_CREDITO' THEN 'CARD' WHEN 'TARJETA_DEBITO' THEN 'CARD' WHEN 'TARJETA_DE_DEBITO' THEN 'CARD' WHEN 'CREDIT_CARD' THEN 'CARD' WHEN 'DEBIT_CARD' THEN 'CARD' WHEN 'POS' THEN 'CARD' WHEN 'TRANSFER' THEN 'TRANSFER' WHEN 'TRANSFERENCIA' THEN 'TRANSFER' WHEN 'TRANSFERENCIA_BANCARIA' THEN 'TRANSFER' WHEN 'BANK' THEN 'TRANSFER' WHEN 'BANK_TRANSFER' THEN 'TRANSFER' WHEN 'BANCO' THEN 'TRANSFER' WHEN 'WIRE' THEN 'TRANSFER' WHEN 'WIRE_TRANSFER' THEN 'TRANSFER' WHEN 'CREDIT' THEN 'CREDIT' WHEN 'CREDITO' THEN 'CREDIT' WHEN 'FIADO' THEN 'CREDIT' WHEN 'CREDITO_CLIENTE' THEN 'CREDIT' WHEN 'CLIENT_CREDIT' THEN 'CREDIT' ELSE NULL END FROM migration_source_records source_record JOIN migration_import_batches source_batch ON source_batch.business_id = source_record.business_id AND source_batch.id = source_record.batch_id WHERE source_record.business_id = ${saleAlias}.business_id AND source_record.target_record_id = CAST(${saleAlias}.id AS CHAR) AND source_record.entity_type = 'sales' AND source_record.target_table = 'sales' AND source_record.record_status = 'PROJECTED' AND source_batch.status = 'COMPLETED' ORDER BY source_batch.package_version DESC, source_batch.completed_at DESC, source_record.updated_at DESC LIMIT 1), ${saleAlias}.payment_method)`;
}

async function loadHistoricalPaymentMethods(repo, db, businessId, saleIds) {
  const ids = [...new Set((saleIds || []).map(String).filter(id => /^[1-9]\d{0,19}$/.test(id)))];
  if (!ids.length) return new Map();
  const columns = await repo.rows(db, "SELECT TABLE_NAME AS tableName,COLUMN_NAME AS columnName FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND ((TABLE_NAME='migration_source_records' AND COLUMN_NAME IN ('business_id','batch_id','entity_type','target_record_id','record_status','target_table','source_payload','updated_at')) OR (TABLE_NAME='migration_import_batches' AND COLUMN_NAME IN ('business_id','id','package_version','status','completed_at')))", []);
  const present = new Set(columns.map(row => row.tableName + '.' + row.columnName));
  const required = ['business_id','batch_id','entity_type','target_record_id','record_status','target_table','source_payload','updated_at'].map(column => 'migration_source_records.' + column)
    .concat(['business_id','id','package_version','status','completed_at'].map(column => 'migration_import_batches.' + column));
  if (!required.every(column => present.has(column))) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = await repo.rows(db, "SELECT ranked.saleId,ranked.sourceMethod FROM (SELECT source_record.target_record_id AS saleId,COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(source_record.source_payload,'$.medioPago')),'null'),NULLIF(JSON_UNQUOTE(JSON_EXTRACT(source_record.source_payload,'$.medio_pago')),'null'),NULLIF(JSON_UNQUOTE(JSON_EXTRACT(source_record.source_payload,'$.paymentMethod')),'null'),NULLIF(JSON_UNQUOTE(JSON_EXTRACT(source_record.source_payload,'$.payment_method')),'null'),NULLIF(JSON_UNQUOTE(JSON_EXTRACT(source_record.source_payload,'$.metodoPago')),'null')) AS sourceMethod,ROW_NUMBER() OVER (PARTITION BY source_record.business_id,source_record.target_record_id ORDER BY source_batch.package_version DESC,source_batch.completed_at DESC,source_record.updated_at DESC) AS sourceRank FROM migration_source_records source_record JOIN migration_import_batches source_batch ON source_batch.business_id=source_record.business_id AND source_batch.id=source_record.batch_id WHERE source_record.business_id=? AND source_record.entity_type='sales' AND source_record.target_table='sales' AND source_record.record_status='PROJECTED' AND source_batch.status='COMPLETED' AND source_record.target_record_id IN (" + placeholders + ')) ranked WHERE ranked.sourceRank=1', [businessId, ...ids]);
  const methods = new Map();
  for (const row of rows) {
    const method = normalizeHistoricalPaymentMethod(row.sourceMethod);
    if (method) methods.set(String(row.saleId), method);
  }
  return methods;
}

module.exports = { normalizeHistoricalPaymentMethod, historicalPaymentMethodSql, loadHistoricalPaymentMethods };
