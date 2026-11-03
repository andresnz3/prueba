'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_PRODUCT_CATEGORIES, normalizeProductCategory, productCategoryName, seedDefaultProductCategories } = require('../src/services/product-category-values');
const { productCategoryName: validateRouteCategory } = require('../src/services/inventory-values');

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
