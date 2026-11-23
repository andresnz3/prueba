'use strict';
const DEFAULT_PRODUCT_CATEGORIES = Object.freeze(['Abarrotes', 'Bebidas', 'Snacks', 'Limpieza']);

function normalizeProductCategory(value) {
  return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function productCategoryName(value) {
  if (typeof value !== 'string') throw new TypeError('Invalid product category');
  if ([...value].some(character => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)) throw new TypeError('Invalid product category');
  const name = value.trim().replace(/\s+/g, ' ');
  const normalizedName = normalizeProductCategory(name);
  if (!name || [...name].length > 100 || [...normalizedName].length > 100 || !normalizedName) throw new TypeError('Invalid product category');
  return { name, normalizedName };
}

async function seedDefaultProductCategories(db, businessId) {
  for (const value of DEFAULT_PRODUCT_CATEGORIES) {
    const { name, normalizedName } = productCategoryName(value);
    await db.execute('INSERT IGNORE INTO product_categories (business_id, name, normalized_name) VALUES (?, ?, ?)', [String(businessId), name, normalizedName]);
  }
}

async function ensureProductCategory(repo, db, businessId, value) {
  const { normalizedName } = productCategoryName(value);
  await repo.rows(db, 'INSERT IGNORE INTO product_categories (business_id, name, normalized_name) VALUES (?, ?, ?)', [String(businessId), value.trim(), normalizedName]);
}

module.exports = { DEFAULT_PRODUCT_CATEGORIES, normalizeProductCategory, productCategoryName, seedDefaultProductCategories, ensureProductCategory };
