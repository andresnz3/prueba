'use strict';
const { httpError } = require('../middleware/errors');
const { normalize } = require('./product-images');

const logoReference = businessId => new RegExp('^/api/product-images/' + businessId + '/[a-f0-9]{32}\\.jpg$');
function createBusinessSettingsService({ repo, imageStore }) {
  async function read(db, current) {
    const select = legalName => 'SELECT b.id AS business_id,b.name AS fallback_name,b.phone AS fallback_phone,b.address AS fallback_address,s.id AS settings_id,s.business_name,' + (legalName ? 's.legal_name,' : "'' AS legal_name,") + 's.ruc,s.phone,s.address,s.currency,s.logo,s.invoice_prefix,s.retail_margin_default,s.wholesale_margin_default,s.min_stock_default,s.tax_rate_default,s.ticket_header,s.ticket_footer,s.updated_at FROM businesses b LEFT JOIN business_settings s ON s.business_id=b.id WHERE b.id=?';
    let row, legalNameSupported = true;
    try { [row] = await repo.rows(db, select(true), [current.business_id]); }
    catch (error) {
      if (error.code !== 'ER_BAD_FIELD_ERROR' || !/legal_name/i.test(error.sqlMessage || error.message || '')) throw error;
      legalNameSupported = false;
      [row] = await repo.rows(db, select(false), [current.business_id]);
    }
    if (!row) throw httpError(404, 'BUSINESS_NOT_FOUND');
    const businessId = String(row.business_id), matchesBusiness = logoReference(businessId).test(row.logo || '');
    return {
      businessId,
      businessName: row.business_name || row.fallback_name,
      legalName: row.legal_name || '',
      ruc: row.ruc || '',
      phone: row.phone ?? row.fallback_phone ?? '',
      address: row.address ?? row.fallback_address ?? '',
      currency: 'C$',
      logo: matchesBusiness ? row.logo : null,
      invoicePrefix: row.invoice_prefix || '',
      retailMarginDefault: Number(row.retail_margin_default || 0),
      wholesaleMarginDefault: Number(row.wholesale_margin_default || 0),
      minStockDefault: Number(row.min_stock_default ?? 5),
      taxRateDefault: Number(row.tax_rate_default || 0),
      ticketHeader: row.ticket_header || '',
      ticketFooter: row.ticket_footer || '¡Gracias por su compra!',
      hasStoredSettings: row.settings_id !== null,
      schemaReady: legalNameSupported,
      updatedAt: row.updated_at || null
    };
  }
  function admin(current) { if (current.role !== 'ADMIN') throw httpError(403, 'ADMIN_REQUIRED'); }
  async function readBusiness(db, current) {
    const [business] = await repo.rows(db, 'SELECT id,name,phone,address FROM businesses WHERE id=? FOR UPDATE', [current.business_id]);
    if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
    return business;
  }
  async function get(session) {
    try { return await repo.tenant(session, (db, current) => read(db, current)); }
    catch (error) { if (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_FIELD_ERROR') throw httpError(503, 'BUSINESS_SETTINGS_MIGRATION_REQUIRED'); throw error; }
  }
  async function save(session, data) {
    try {
      return await repo.tenant(session, async (db, current) => {
        admin(current);
        await readBusiness(db, current);
        const [existing] = await repo.rows(db, 'SELECT id FROM business_settings WHERE business_id=? FOR UPDATE', [current.business_id]);
        await repo.rows(db, 'UPDATE businesses SET name=?,phone=?,address=? WHERE id=?', [data.businessName, data.phone, data.address, current.business_id]);
        if (existing) {
          await repo.rows(db, 'UPDATE business_settings SET business_name=?,legal_name=?,ruc=?,phone=?,address=?,currency=\'C$\',min_stock_default=?,ticket_header=?,ticket_footer=? WHERE business_id=?', [data.businessName, data.legalName, data.ruc, data.phone, data.address, data.minStockDefault, data.ticketHeader, data.ticketFooter, current.business_id]);
        } else {
          await repo.rows(db, 'INSERT INTO business_settings (business_id,business_name,legal_name,ruc,phone,address,currency,min_stock_default,ticket_header,ticket_footer) VALUES (?,?,?,?,?, ?,\'C$\',?,?,?)', [current.business_id, data.businessName, data.legalName, data.ruc, data.phone, data.address, data.minStockDefault, data.ticketHeader, data.ticketFooter]);
        }
        await repo.audit(db, current, 'UPDATE_BUSINESS_SETTINGS', 'business_settings', current.business_id, { fields: ['businessName','legalName','ruc','phone','address','currency','minStockDefault','ticketHeader','ticketFooter'] });
        return read(db, current);
      });
    } catch (error) { if (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_FIELD_ERROR') throw httpError(503, 'BUSINESS_SETTINGS_MIGRATION_REQUIRED'); throw error; }
  }
  async function importLegacy(session, data) {
    try {
      return await repo.tenant(session, async (db, current) => {
        admin(current);
        const business = await readBusiness(db, current);
        if (data.sourceBusinessName.trim().toLocaleLowerCase() !== String(business.name).trim().toLocaleLowerCase()) throw httpError(409, 'LEGACY_SETTINGS_BUSINESS_MISMATCH');
        const [existing] = await repo.rows(db, 'SELECT id FROM business_settings WHERE business_id=? FOR UPDATE', [current.business_id]);
        if (existing) throw httpError(409, 'BUSINESS_SETTINGS_EXISTS');
        const phone = business.phone || data.phone, address = business.address || data.address;
        await repo.rows(db, 'UPDATE businesses SET phone=COALESCE(NULLIF(phone,\'\'),?),address=COALESCE(NULLIF(address,\'\'),?) WHERE id=?', [data.phone, data.address, current.business_id]);
        await repo.rows(db, 'INSERT INTO business_settings (business_id,business_name,legal_name,ruc,phone,address,currency,min_stock_default,ticket_header,ticket_footer) VALUES (?,?,?,?,?, ?,\'C$\',?,?,?)', [current.business_id, business.name, data.legalName, data.ruc, phone, address, data.minStockDefault, data.ticketHeader, data.ticketFooter]);
        await repo.audit(db, current, 'IMPORT_LEGACY_BUSINESS_SETTINGS', 'business_settings', current.business_id, { fields: ['legalName','ruc','phone','address','minStockDefault','ticketHeader','ticketFooter'], source: 'browser-local-storage' });
        return read(db, current);
      });
    } catch (error) {
      if (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_FIELD_ERROR') throw httpError(503, 'BUSINESS_SETTINGS_MIGRATION_REQUIRED');
      throw error;
    }
  }
  async function uploadLogo(session, buffer, mime) {
    const normalized = await normalize(buffer, mime);
    let businessId = null, previous = null, saved = null, completed = false;
    try {
      const result = await repo.tenant(session, async (db, current) => {
        admin(current);
        const business = await readBusiness(db, current);
        if (!(await read(db, current)).schemaReady) throw httpError(503, 'BUSINESS_SETTINGS_MIGRATION_REQUIRED');
        businessId = String(current.business_id);
        const [existing] = await repo.rows(db, 'SELECT id,logo FROM business_settings WHERE business_id=? FOR UPDATE', [current.business_id]);
        previous = existing?.logo || null;
        if (!existing) await repo.rows(db, 'INSERT INTO business_settings (business_id,business_name,phone,address,currency) VALUES (?,?,?,?,\'C$\')', [current.business_id, business.name, business.phone, business.address]);
        saved = await imageStore.save(current.business_id, normalized);
        await repo.rows(db, 'UPDATE business_settings SET logo=? WHERE business_id=?', [saved, current.business_id]);
        await repo.audit(db, current, 'UPDATE_BUSINESS_LOGO', 'business_settings', current.business_id, { changed: true });
        return read(db, current);
      });
      completed = true;
      if (previous && previous !== result.logo && logoReference(businessId).test(previous)) await imageStore.remove(previous).catch(() => {});
      return result;
    } catch (error) {
      if (saved && !completed) await imageStore.remove(saved).catch(() => {});
      if (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_FIELD_ERROR') throw httpError(503, 'BUSINESS_SETTINGS_MIGRATION_REQUIRED');
      throw error;
    }
  }
  return { get, save, importLegacy, uploadLogo };
}
module.exports = { createBusinessSettingsService };
