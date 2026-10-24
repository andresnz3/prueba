'use strict';

const capabilityKey = Symbol('trusted local migration batch');

function authorizeMigrationBatch(batchId, sourceBusinessKey, catalogReady) {
  return Object.freeze({
    batchId,
    sourceBusinessKey,
    catalogReady: catalogReady === true,
    [capabilityKey]: true
  });
}

function migrationBatchContext(options) {
  const value = options?.batchContext;
  if (!value || value[capabilityKey] !== true ||
      typeof value.batchId !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.batchId) ||
      typeof value.sourceBusinessKey !== 'string' || !/^[0-9a-f]{64}$/i.test(value.sourceBusinessKey) ||
      value.catalogReady !== true) return null;
  return value;
}

function applySourceBusinessKey(imported, context) {
  if (context) imported.sourceBusinessKey = context.sourceBusinessKey;
  return imported;
}

module.exports = { authorizeMigrationBatch, migrationBatchContext, applySourceBusinessKey };
