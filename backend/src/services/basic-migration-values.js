'use strict';
const { httpError } = require('../middleware/errors');
const { decimal } = require('./inventory-values');

const MAX_RECORDS_PER_TYPE = 50000;
const text = value => typeof value === 'string' ? value.trim() : '';
const first = (record, fields) => {
  for (const field of fields) if (record[field] !== undefined && record[field] !== null) return record[field];
  return undefined;
};
const normalizeName = value => text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ');

function invalidPackage() {
  throw httpError(400, 'MIGRATION_PACKAGE_INVALID');
}

function sourceText(value, max, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) invalidPackage();
    return null;
  }
  if (typeof value !== 'string' || value.trim().length > max || [...value].some(character => character.charCodeAt(0) <= 0x1f)) invalidPackage();
  const result = value.trim();
  if (!result && required) invalidPackage();
  return result || null;
}

function sourceDecimal(value, scale, digits) {
  if (value === undefined || value === null || value === '') return decimal(0, scale, digits);
  try {
    return decimal(value, scale, digits);
  } catch {
    invalidPackage();
  }
}

function sourceMargin(value) {
  if (value === undefined || value === null || value === '') return decimal(0, 4, 3, true);
  try {
    return decimal(value, 4, 3, true);
  } catch {
    invalidPackage();
  }
}

function records(data, key) {
  const list = data[key];
  if (!Array.isArray(list) || list.length > MAX_RECORDS_PER_TYPE) invalidPackage();
  return list;
}

function product(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidPackage();
  const barcode = sourceText(first(value, ['barcode', 'codigo', 'code']), 100);
  const category = sourceText(first(value, ['category', 'categoria']), 100) || 'General';
  return {
    barcode,
    name: sourceText(first(value, ['name', 'nombre']), 180, true),
    category,
    cost: sourceDecimal(value.cost, 2, 10),
    marginRetail: sourceMargin(first(value, ['marginRetail', 'retailMargin', 'retail_margin'])),
    marginWholesale: sourceMargin(first(value, ['marginWholesale', 'wholesaleMargin', 'wholesale_margin'])),
    retailPrice: sourceDecimal(first(value, ['retailPrice', 'retail_price', 'retail']), 2, 10),
    wholesalePrice: sourceDecimal(first(value, ['wholesalePrice', 'wholesale_price', 'wholesale']), 2, 10),
    stock: sourceDecimal(value.stock, 3, 9),
    minStock: sourceDecimal(first(value, ['minStock', 'min_stock']), 3, 9),
    taxRate: sourceDecimal(first(value, ['taxRate', 'tax_rate']), 4, 3),
    active: value.active !== false,
    deleted: value.deleted === true,
    hasImage: typeof value.image === 'string' && value.image.length > 0
  };
}

function client(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidPackage();
  return {
    name: sourceText(first(value, ['name', 'nombre']), 180, true),
    phone: sourceText(value.phone, 40),
    ruc: sourceText(value.ruc, 64),
    address: sourceText(value.address, 255),
    active: value.active !== false
  };
}

function supplier(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidPackage();
  return {
    name: sourceText(first(value, ['name', 'nombre']), 180, true),
    contact: sourceText(value.contact, 160),
    phone: sourceText(value.phone, 40),
    ruc: sourceText(value.ruc, 64),
    address: sourceText(value.address, 255),
    active: value.active !== false
  };
}

function packageForImport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.type !== 'pos_local_migration_package' || ![1, 2].includes(value.version) ||
      !value.data || typeof value.data !== 'object' || Array.isArray(value.data) ||
      !value.business || typeof value.business !== 'object' || Array.isArray(value.business)) invalidPackage();
  const products = records(value.data, 'products').map(product);
  const clients = records(value.data, 'clients').map(client);
  const suppliers = records(value.data, 'suppliers').map(supplier);
  const categories = new Set(products.filter(item => !item.deleted).map(item => normalizeName(item.category)).filter(Boolean));
  const sourceBusinessName = sourceText(value.business.name, 160) || 'No especificado';
  const exportedAt = value.exportedAt === undefined || value.exportedAt === null ? null : value.exportedAt;
  if (exportedAt !== null && (typeof exportedAt !== 'string' || !Number.isFinite(Date.parse(exportedAt)))) invalidPackage();
  return {
    products, clients, suppliers, categoriesDetected: categories.size,
    sourceBusinessName, exportedAt,
    deletedProducts: products.filter(item => item.deleted).length,
    productsWithImage: products.filter(item => item.hasImage && !item.deleted).length
  };
}

function packageForInventoryImport(value) {
  const imported = packageForImport(value);
  if (!Array.isArray(value.data.inventoryMovements) || value.data.inventoryMovements.length > MAX_RECORDS_PER_TYPE) invalidPackage();
  return imported;
}

module.exports = { packageForImport, packageForInventoryImport, normalizeName };
