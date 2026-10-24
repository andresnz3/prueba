'use strict';

const { hash, normalizeName } = require('./system-admin-sales-migration-values');

function parseDetails(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function sourceKeyFromAudit(value) {
  const details = parseDetails(value);
  if (!details) return null;
  if (/^[a-f0-9]{64}$/.test(details.sourceBusinessKey || '')) return details.sourceBusinessKey;
  const name = normalizeName(details.sourceBusinessName);
  if (!name) return null;
  const id = details.sourceBusinessId === null || details.sourceBusinessId === undefined || details.sourceBusinessId === ''
    ? null
    : String(details.sourceBusinessId).trim();
  return hash((id ? 'id:' + id + '\n' : '') + 'name:' + name);
}

async function loadSourceBusinessNames(repo, db, businessId) {
  const rows = await repo.rows(db,
    "SELECT details FROM audit_logs WHERE business_id = ? AND action = 'MIGRATION_SALES_IMPORT' ORDER BY id DESC",
    [businessId]);
  const names = new Map();
  for (const row of rows) {
    const details = parseDetails(row.details);
    const key = sourceKeyFromAudit(details);
    const name = typeof details?.sourceBusinessName === 'string' ? details.sourceBusinessName.trim() : '';
    if (key && name && !names.has(key)) names.set(key, name);
  }
  return names;
}

async function loadSourceOrigins(repo, db, businessId) {
  const [references, names] = await Promise.all([
    repo.rows(db,
      'SELECT source_business_key AS sourceBusinessKey, COUNT(*) AS saleCount FROM migration_sales_references WHERE business_id = ? GROUP BY source_business_key ORDER BY source_business_key',
      [businessId]),
    loadSourceBusinessNames(repo, db, businessId)
  ]);
  return references.map(row => ({
    sourceBusinessKey: row.sourceBusinessKey,
    sourceBusinessName: names.get(row.sourceBusinessKey) || null,
    saleCount: Number(row.saleCount)
  }));
}

function originalInvoiceNumber(detail) {
  const prefix = 'Factura local:';
  if (typeof detail !== 'string' || !detail.startsWith(prefix)) return null;
  const sourceInvoice = detail.slice(prefix.length).split(' · ')[0].trim();
  return sourceInvoice || null;
}

module.exports = { loadSourceBusinessNames, loadSourceOrigins, originalInvoiceNumber, sourceKeyFromAudit };
