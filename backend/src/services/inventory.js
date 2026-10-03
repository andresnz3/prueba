'use strict';
const { createHash } = require('node:crypto');
const { httpError } = require('../middleware/errors');
const { units, fixed } = require('./inventory-values');
const { normalize } = require('./product-images');
const columns = { barcode: 'barcode', name: 'name', category: 'category', cost: 'cost', marginRetail: 'retail_margin', marginWholesale: 'wholesale_margin', retailPrice: 'retail_price', wholesalePrice: 'wholesale_price', stock: 'stock', minStock: 'min_stock', taxRate: 'tax_rate', image: 'image', active: 'active' };
function publicProduct(row, catalog = false) {
  const result = { id: String(row.id), businessId: String(row.business_id), deleted: Boolean(row.deleted) };
  for (const [field, column] of Object.entries(columns)) {
    if (catalog && ['cost', 'marginRetail', 'marginWholesale', 'taxRate'].includes(field)) continue;
    result[field] = field === 'active' ? Boolean(row[column]) : row[column];
  }
  if (!catalog) result.revision = createHash('sha256').update(JSON.stringify({ ...result, updatedAt: row.updated_at })).digest('hex');
  return result;
}
function createInventoryService({ repo, auth, config }, imageStore) {
  async function permitted(current, module, db) {
    const [session] = await repo.rows(db, 'SELECT id FROM sessions WHERE business_id = ? AND id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(3) AND created_at > TIMESTAMPADD(SECOND, -?, UTC_TIMESTAMP(3))', [current.business_id, current.session_id, config.absoluteSeconds]);
    if (!session) throw httpError(401, 'INVALID_SESSION');
    if (!await auth.canAccess(current, module, db)) throw httpError(403, 'MODULE_FORBIDDEN');
  }
  async function work(session, module, action) {
    try {
      return await repo.tenant(session, async (db, current) => {
        await permitted(current, module, db);
        const result = await action(db, current);
        // Revalidar despues de esperar bloqueos y antes del commit.
        await permitted(current, module, db);
        return result;
      });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') throw httpError(409, 'BARCODE_EXISTS');
      if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code)) throw httpError(409, 'RETRY_OPERATION');
      throw error;
    }
  }
  async function find(db, current, id, lock = false) {
    const [row] = await repo.rows(db, 'SELECT * FROM products WHERE business_id = ? AND id = ?' + (lock ? ' FOR UPDATE' : ''), [current.business_id, id]);
    if (!row) throw httpError(404, 'PRODUCT_NOT_FOUND');
    return row;
  }
  async function record(db, current, row, type, quantity, reason) {
    const result = await repo.rows(db, 'INSERT INTO inventory_movements (business_id, product_id, user_id, type, quantity, stock_after, reason, unit_cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))', [current.business_id, String(row.id), current.user_id, type, quantity, row.stock, reason, row.cost]);
    await repo.audit(db, current, type, 'inventory_movements', result.insertId, { productId: String(row.id), quantity, stockAfter: row.stock, reason });
  }
  function list(session, options, catalog = false) {
    return work(session, catalog ? 'sales' : 'inventory', async (db, current) => {
      const search = '%' + (options.search || '') + '%';
      const data = await repo.rows(db, 'SELECT * FROM products WHERE business_id = ? AND deleted = FALSE' + (catalog ? ' AND active = TRUE' : '') + ' AND (name LIKE ? OR barcode LIKE ?) ORDER BY id LIMIT ? OFFSET ?', [current.business_id, search, search, options.limit, options.offset]);
      return data.map(row => publicProduct(row, catalog));
    });
  }
  function get(session, id) { return work(session, 'inventory', async (db, current) => publicProduct(await find(db, current, id))); }
  function create(session, data) {
    return work(session, 'inventory', async (db, current) => {
      await imageStore.assertOwned(current.business_id,data.image);
      const fields = Object.keys(columns);
      const result = await repo.rows(db, 'INSERT INTO products (business_id, ' + fields.map(field => columns[field]).join(', ') + ') VALUES (' + ['?', ...fields.map(() => '?')].join(', ') + ')', [current.business_id, ...fields.map(field => data[field])]);
      const row = await find(db, current, String(result.insertId));
      if (units(row.stock) !== 0n) await record(db, current, row, 'INITIAL', row.stock, 'Creacion de producto');
      await repo.audit(db, current, 'CREATE_PRODUCT', 'products', row.id, { barcode: row.barcode, name: row.name });
      return publicProduct(row);
    });
  }
  function update(session, id, data) {
    return work(session, 'inventory', async (db, current) => {
      const previous = await find(db, current, id, true);
      if (previous.deleted) throw httpError(409, 'PRODUCT_ARCHIVED');
      if (publicProduct(previous).revision !== data.revision) throw httpError(409, 'PRODUCT_CONFLICT');
      if (Object.hasOwn(data,'image')) await imageStore.assertOwned(current.business_id,data.image);
      const fields = Object.keys(data).filter(field => Object.hasOwn(columns, field));
      await repo.rows(db, 'UPDATE products SET ' + fields.map(field => columns[field] + ' = ?').join(', ') + ' WHERE business_id = ? AND id = ?', [...fields.map(field => data[field]), current.business_id, id]);
      const row = await find(db, current, id);
      const delta = units(row.stock) - units(previous.stock);
      if (delta !== 0n) await record(db, current, row, 'MANUAL_EDIT', fixed(delta, 3), 'Ajuste desde edicion');
      await repo.audit(db, current, 'UPDATE_PRODUCT', 'products', id, { fields });
      return publicProduct(row);
    });
  }
  function adjust(session, id, data) {
    return work(session, 'inventory', async (db, current) => {
      const row = await find(db, current, id, true);
      if (row.deleted) throw httpError(409, 'PRODUCT_ARCHIVED');
      const delta = units(data.quantity) * (data.type === 'WASTE' ? -1n : 1n);
      const stock = units(row.stock) + delta;
      if (stock < 0n) throw httpError(409, 'INSUFFICIENT_STOCK');
      if (stock >= 1000000000000n) throw httpError(400, 'STOCK_LIMIT');
      row.stock = fixed(stock, 3);
      await repo.rows(db, 'UPDATE products SET stock = ? WHERE business_id = ? AND id = ?', [row.stock, current.business_id, id]);
      await record(db, current, row, data.type, fixed(delta, 3), data.reason);
      return publicProduct(await find(db, current, id));
    });
  }
  function movements(session, options) {
    return work(session, 'inventory', async (db, current) => {
      if (options.productId) await find(db, current, options.productId);
      const data = await repo.rows(db, 'SELECT m.*, u.full_name AS responsible FROM inventory_movements m LEFT JOIN users u ON u.business_id = m.business_id AND u.id = m.user_id WHERE m.business_id = ?' + (options.productId ? ' AND m.product_id = ?' : '') + (options.maxId ? ' AND m.id <= ?' : '') + ' ORDER BY m.id DESC LIMIT ? OFFSET ?', [current.business_id, ...(options.productId ? [options.productId] : []), ...(options.maxId ? [options.maxId] : []), options.limit, options.offset]);
      return data.map(row => ({ id: String(row.id), businessId: String(row.business_id), productId: String(row.product_id), userId: row.user_id === null ? null : String(row.user_id), userName: row.responsible || 'Sistema', type: row.type, quantity: row.quantity, stockAfter: row.stock_after, unitCost: row.unit_cost, reason: row.reason || '', createdAt: row.created_at }));
    });
  }
  async function uploadImage(session, body, mime) {
    const buffer = await normalize(body,mime);
    let reference;
    try {
      return await work(session,'inventory',async(db,current) => {
        reference = await imageStore.save(current.business_id,buffer);
        await repo.audit(db,current,'UPLOAD_PRODUCT_IMAGE','businesses',current.business_id,{image:reference});
        return reference;
      });
    } catch (error) {
      if (reference) await imageStore.remove(session.business_id,reference).catch(() => {});
      throw error;
    }
  }
  function readImage(session, image) {
    return work(session,'sales',async(db,current) => {
      const [row] = await repo.rows(db,'SELECT id, active FROM products WHERE business_id = ? AND image = ? AND deleted = FALSE ORDER BY active DESC LIMIT 1',[current.business_id,image]);
      if (!row || (!row.active && !await auth.canAccess(current,'inventory',db))) throw httpError(404,'IMAGE_NOT_FOUND');
      return imageStore.read(current.business_id,image);
    });
  }
  return { list, get, create, update, adjust, movements, uploadImage, readImage };
}
module.exports = { createInventoryService };
