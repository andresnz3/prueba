'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_PRODUCT_CATEGORIES, normalizeProductCategory, productCategoryName, seedDefaultProductCategories, ensureProductCategory } = require('../src/services/product-category-values');
const { productCategoryName: validateRouteCategory, resolveProductCategory } = require('../src/services/inventory-values');

test('normaliza categorías para evitar duplicados por mayúsculas, acentos y espacios', () => {
  assert.equal(normalizeProductCategory('  Panadería   Norte '), 'panaderia norte');
  assert.deepEqual(productCategoryName('  Panadería   Norte '), { name: 'Panadería Norte', normalizedName: 'panaderia norte' });
  assert.deepEqual(validateRouteCategory('  Panadería   Norte '), { name: 'Panadería Norte', normalizedName: 'panaderia norte' });
});

test('rechaza categorías vacías, con controles o fuera de los límites', () => {
  for (const value of ['', '   ', 'nombre\ninválido', 'x'.repeat(101), '\uFB03'.repeat(34)]) {
    assert.throws(() => productCategoryName(value), TypeError);
    assert.throws(() => validateRouteCategory(value));
  }
  assert.throws(() => productCategoryName(null), TypeError);
});

test('siembra solo categorías predeterminadas en el negocio indicado', async () => {
  const calls = [];
  const db = { execute: async (sql, params) => { calls.push({ sql, params }); return [[], []]; } };
  await seedDefaultProductCategories(db, '42');
  assert.equal(calls.length, DEFAULT_PRODUCT_CATEGORIES.length);
  assert.ok(calls.every(call => call.sql.includes('INSERT IGNORE INTO product_categories')));
  assert.ok(calls.every(call => call.params[0] === '42'));
});

test('registra categorías importadas sin cambiar el texto histórico del producto', async () => {
  const calls = [];
  const repo = { rows: async (_db, sql, params) => { calls.push({ sql, params }); return []; } };
  await ensureProductCategory(repo, {}, 42, '  Panadería   Norte  ');
  assert.deepEqual(calls, [{
    sql: 'INSERT IGNORE INTO product_categories (business_id, name, normalized_name) VALUES (?, ?, ?)',
    params: ['42', 'Panadería   Norte', 'panaderia norte']
  }]);
});

test('resuelve categorías por negocio y conserva el nombre histórico normalizado', async () => {
  const calls = [];
  const repo = { rows: async (_db, sql, params) => {
    calls.push({ sql, params });
    return params[0] === '42' && params[1] === 'panaderia norte' ? [{ name: 'Panadería Norte' }] : [];
  } };
  assert.deepEqual(await resolveProductCategory(repo, {}, 42, '  PANADERÍA   NORTE  '), { name: 'Panadería Norte', normalizedName: 'panaderia norte' });
  assert.match(calls[0].sql, /business_id = \? AND normalized_name = \?.*FOR SHARE/);
  assert.deepEqual(calls[0].params, ['42', 'panaderia norte']);
  await assert.rejects(resolveProductCategory(repo, {}, 43, 'Panadería Norte'), error => error.publicStatus === 400 && error.publicCode === 'PRODUCT_CATEGORY_NOT_FOUND');
  await assert.rejects(resolveProductCategory(repo, {}, 42, '   '), error => error.publicStatus === 400 && error.publicCode === 'PRODUCT_CATEGORY_NOT_FOUND');
});
