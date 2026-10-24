'use strict';

const { createHash } = require('node:crypto');
const { httpError } = require('../middleware/errors');
const { packageForImport, normalizeName } = require('./basic-migration-values');

const MAX_PURCHASES = 50000;
const MAX_ITEMS_PER_PURCHASE = 500;
const MAX_MONEY_CENTS = 999999999999n;

class PurchaseDataError extends Error {}

function invalidPackage() {
  throw httpError(400, 'MIGRATION_PACKAGE_INVALID');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function first(value, keys) {
  for (const key of keys) {
    if (value && value[key] !== undefined && value[key] !== null && value[key] !== '') return value[key];
  }
  return null;
}

function identifier(value) {
  if (value === null || value === undefined || value === '') return null;
  if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER))) invalidPackage();
  const result = String(value).trim();
  if (!result || result.length > 100 || [...result].some(character => character.charCodeAt(0) <= 0x1f)) invalidPackage();
  return result;
}

function sourceText(value, max = 180) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > max || [...value].some(character => character.charCodeAt(0) <= 0x1f)) throw new PurchaseDataError('texto inválido');
  return value.trim() || null;
}

function moneyCents(value, required = false) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new PurchaseDataError('importe faltante');
    return null;
  }
  let cents;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value > 9999999999.99) throw new PurchaseDataError('importe inválido');
    cents = BigInt(Math.round(value * 100));
  } else if (typeof value === 'string') {
    const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(value.trim());
    if (!match) throw new PurchaseDataError('importe inválido');
    cents = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0') || '0');
  } else throw new PurchaseDataError('importe inválido');
  if (cents > MAX_MONEY_CENTS) throw new PurchaseDataError('importe fuera de rango');
  return cents;
}

function quantityMilli(value) {
  let milli;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0 || value > 999999999.999) throw new PurchaseDataError('cantidad inválida');
    milli = BigInt(Math.round(value * 1000));
  } else if (typeof value === 'string') {
    const match = /^(\d{1,9})(?:\.(\d{1,3}))?$/.exec(value.trim());
    if (!match) throw new PurchaseDataError('cantidad inválida');
    milli = BigInt(match[1]) * 1000n + BigInt((match[2] || '').padEnd(3, '0') || '0');
  } else throw new PurchaseDataError('cantidad inválida');
  if (milli <= 0n || milli >= 1000000000000n) throw new PurchaseDataError('cantidad fuera de rango');
  return milli;
}

function percentScaled(value) {
  if (value === null || value === undefined || value === '') return null;
  let text;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new PurchaseDataError('descuento porcentual inválido');
    text = value.toFixed(4);
  } else if (typeof value === 'string') text = value.trim();
  else throw new PurchaseDataError('descuento porcentual inválido');
  const match = /^(\d{1,3})(?:\.(\d{1,4}))?$/.exec(text);
  if (!match) throw new PurchaseDataError('descuento porcentual inválido');
  const scaled = BigInt(match[1]) * 10000n + BigInt((match[2] || '').padEnd(4, '0') || '0');
  if (scaled > 1000000n) throw new PurchaseDataError('descuento porcentual fuera de rango');
  return scaled;
}

function formatMoney(cents) {
  const value = BigInt(cents);
  return (value / 100n).toString() + '.' + (value % 100n).toString().padStart(2, '0');
}

function formatQuantity(milli) {
  const value = BigInt(milli);
  return (value / 1000n).toString() + '.' + (value % 1000n).toString().padStart(3, '0');
}

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function packageForPurchasesImport(value) {
  const imported = packageForImport(value);
  if (!Array.isArray(value.data.purchases) || value.data.purchases.length > MAX_PURCHASES) invalidPackage();

  const sourceProducts = value.data.products.map((raw, index) => ({
    id: identifier(first(raw, ['id', 'productId', 'productoId', 'product_id'])),
    barcode: imported.products[index].barcode,
    name: imported.products[index].name
  }));
  const sourceSuppliers = value.data.suppliers.map((raw, index) => ({
    id: identifier(first(raw, ['id', 'supplierId', 'proveedorId', 'supplier_id', 'proveedor_id'])),
    name: imported.suppliers[index].name
  }));
  const business = value.business;
  const sourceBusinessId = identifier(first(business, ['localBusinessId', 'businessId', 'business_id', 'id', 'negocioId']));
  const normalizedSourceName = normalizeName(imported.sourceBusinessName);
  const sourceBusinessKey = hash((sourceBusinessId ? 'id:' + sourceBusinessId + '\n' : '') + 'name:' + normalizedSourceName);

  return {
    ...imported,
    sourceBusinessId,
    sourceBusinessKey,
    sourceProducts,
    sourceProductsById: new Map(sourceProducts.filter(item => item.id).map(item => [item.id, item])),
    sourceSuppliers,
    sourceSuppliersById: new Map(sourceSuppliers.filter(item => item.id).map(item => [item.id, item])),
    purchases: value.data.purchases
  };
}

function sqlDate(value, required = false) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new PurchaseDataError('fecha original faltante');
    return null;
  }
  let date;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const epoch = Math.abs(value) < 100000000000 ? value * 1000 : value;
    date = new Date(epoch);
  } else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value.trim())) {
    date = new Date(value);
  } else throw new PurchaseDataError('fecha ambigua o inválida');
  if (!Number.isFinite(date.getTime())) throw new PurchaseDataError('fecha inválida');
  const year = date.getUTCFullYear();
  if (year < 1000 || year > 9999) throw new PurchaseDataError('fecha fuera del rango del esquema');
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

function coherentDueDate(dueAt, createdAt) {
  if (createdAt && dueAt.slice(0, 10) < createdAt.slice(0, 10)) {
    throw new PurchaseDataError('fecha de vencimiento anterior a fechaTS');
  }
  return dueAt;
}

function sourceDueDate(value, createdAt) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return coherentDueDate(sqlDate(value), createdAt);
  if (typeof value !== 'string') throw new PurchaseDataError('fecha de vencimiento inválida');
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(text)) return coherentDueDate(sqlDate(text), createdAt);
  const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (!match) throw new PurchaseDataError('fecha de vencimiento ambigua o inválida');
  const day = Number(match[1]), month = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new PurchaseDataError('fecha de vencimiento inválida');
  const date = new Date(Date.UTC(Number(match[3]), month - 1, day));
  if (date.getUTCFullYear() !== Number(match[3]) || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new PurchaseDataError('fecha de vencimiento inválida');
  return coherentDueDate(date.toISOString().slice(0, 23).replace('T', ' '), createdAt);
}

function token(value) {
  return normalizeName(String(value)).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function normalizedPurchaseType(value) {
  const kind = token(value || '');
  if (/^(CASH|CONTADO|EFECTIVO)$/.test(kind)) return 'CASH';
  if (/^(CREDIT|CREDITO|CREDITO_PROVEEDOR|FIADO)$/.test(kind)) return 'CREDIT';
  throw new PurchaseDataError('tipo de compra no reconocido; no se convertirá a contado');
}

function normalizedStatus(value, annulled) {
  if (annulled !== null && annulled !== undefined) {
    if (annulled === true || annulled === 1 || (typeof annulled === 'string' && /^(TRUE|1|SI|S|ANULADA|CANCELADA|CANCELLED|VOID)$/i.test(annulled.trim()))) return 'CANCELLED';
    if (annulled !== false && annulled !== 0 && !(typeof annulled === 'string' && /^(FALSE|0|NO|N)$/i.test(annulled.trim()))) throw new PurchaseDataError('indicador de anulación no reconocido');
  }
  if (value === null || value === undefined || value === '') return 'COMPLETED';
  const status = token(value);
  if (/CANCEL|ANUL|VOID/.test(status)) return 'CANCELLED';
  if (/^(COMPLETED|COMPLETE|COMPLETA|COMPLETADA|PAGADA|PAGADO|FINALIZADA|FINALIZADO|OK|ACTIVE|ACTIVA)$/.test(status)) return 'COMPLETED';
  throw new PurchaseDataError('estado original no compatible con el esquema; se omitirá');
}

function inferredLineSubtotal(quantity, unitCost) {
  return (quantity * unitCost + 500n) / 1000n;
}

function allocateCents(amount, items, purpose) {
  const eligible = items.map((item, index) => ({ item, index, weight: item.subtotal }));
  const totalWeight = eligible.reduce((sum, entry) => sum + entry.weight, 0n);
  if (amount === 0n) return items.map(() => 0n);
  if (totalWeight === 0n || (purpose === 'discount' && amount > totalWeight)) throw new PurchaseDataError('descuento excede subtotales disponibles');
  let assigned = 0n;
  const shares = eligible.map(entry => {
    const numerator = amount * entry.weight;
    const share = numerator / totalWeight;
    assigned += share;
    return { index: entry.index, share, remainder: numerator % totalWeight };
  });
  shares.sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (let rest = amount - assigned, index = 0; rest > 0n; rest--, index++) shares[index].share++;
  shares.sort((a, b) => a.index - b.index);
  return shares.map(entry => entry.share);
}

function normalizePurchase(raw, index, imported) {
  if (!isRecord(raw)) return { error: 'registro inválido' };
  try {
    const sourceProductIds = imported.sourceProductsById || new Map(imported.sourceProducts.filter(item => item.id).map(item => [item.id, item]));
    const sourceSupplierIds = imported.sourceSuppliersById || new Map(imported.sourceSuppliers.filter(item => item.id).map(item => [item.id, item]));
    const rawItems = first(raw, ['items', 'detalles', 'detalleProductos', 'products', 'lineItems']);
    if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > MAX_ITEMS_PER_PURCHASE) throw new PurchaseDataError('sin detalle de productos válido');
    const items = rawItems.map((line, lineIndex) => {
      if (!isRecord(line)) throw new PurchaseDataError('detalle ' + (lineIndex + 1) + ' inválido');
      const nestedProduct = first(line, ['product', 'producto']);
      const sourceProductId = identifier(first(line, ['productId', 'productoId', 'product_id', 'producto_id', 'id']) ?? (isRecord(nestedProduct) ? first(nestedProduct, ['id', 'productId']) : null));
      const sourceProduct = sourceProductId ? sourceProductIds.get(sourceProductId) : null;
      const barcode = sourceText(first(line, ['barcode', 'codigo', 'code']) ?? (isRecord(nestedProduct) ? first(nestedProduct, ['barcode', 'codigo', 'code']) : null) ?? sourceProduct?.barcode, 100);
      const explicitName = first(line, ['productName', 'nombreProducto', 'name', 'nombre', 'descripcion']);
      const nestedName = typeof nestedProduct === 'string' ? nestedProduct : (isRecord(nestedProduct) ? first(nestedProduct, ['name', 'nombre']) : null);
      const name = sourceText(explicitName ?? nestedName ?? sourceProduct?.name, 180);
      if (!barcode && !name) throw new PurchaseDataError('detalle ' + (lineIndex + 1) + ' no identifica producto');
      const quantity = quantityMilli(first(line, ['quantity', 'cantidad', 'qty']));
      const rawUnitCost = first(line, ['unitCost', 'unit_cost', 'cost', 'costo', 'costoUnitario', 'precioCosto']);
      if (rawUnitCost === null) throw new PurchaseDataError('detalle ' + (lineIndex + 1) + ' sin costo histórico');
      const unitCost = moneyCents(rawUnitCost, true);
      const calculatedSubtotal = inferredLineSubtotal(quantity, unitCost);
      const suppliedSubtotal = moneyCents(first(line, ['subtotal', 'subTotal']));
      const subtotal = suppliedSubtotal ?? calculatedSubtotal;
      if (subtotal !== calculatedSubtotal) throw new PurchaseDataError('detalle ' + (lineIndex + 1) + ': subtotal histórico C$' + formatMoney(subtotal) + ' no coincide con cantidad × costo C$' + formatMoney(calculatedSubtotal));
      const discountValue = first(line, ['discount', 'descuento', 'discountAmount', 'descuentoMonto']);
      const discountPercent = percentScaled(first(line, ['discountPercent', 'descuentoPorcentaje', 'porcentajeDescuento', 'descuentoPct']));
      const suppliedDiscount = moneyCents(discountValue);
      const percentDiscount = discountPercent === null ? null : (subtotal * discountPercent + 500000n) / 1000000n;
      if (suppliedDiscount !== null && percentDiscount !== null && (suppliedDiscount > percentDiscount + 1n || percentDiscount > suppliedDiscount + 1n)) throw new PurchaseDataError('detalle ' + (lineIndex + 1) + ': descuento en monto y porcentaje no coinciden');
      const rawTax = first(line, ['tax', 'impuesto', 'taxAmount', 'impuestoMonto']);
      const tax = moneyCents(rawTax) ?? 0n;
      const suppliedTotal = moneyCents(first(line, ['total', 'importe', 'monto']));
      return {
        sourceProductId, barcode, name, quantity, unitCost, subtotal,
        discount: suppliedDiscount ?? percentDiscount ?? 0n,
        discountSpecified: suppliedDiscount !== null || discountPercent !== null,
        tax, taxSpecified: rawTax !== null,
        suppliedTotal
      };
    });

    const createdAt = sqlDate(first(raw, ['createdAt', 'created_at', 'fechaTS', 'fecha', 'date', 'timestamp']), true);
    const localPurchaseId = identifier(first(raw, ['id', 'purchaseId', 'compraId', 'purchase_id', 'compra_id']));
    const invoice = sourceText(first(raw, ['supplierInvoiceNumber', 'invoiceNumber', 'invoice_number', 'factura', 'facturaNumero', 'numeroFactura', 'numero', 'comprobante', 'referencia']), 100);
    if (!invoice) throw new PurchaseDataError('factura o referencia del proveedor faltante');
    const supplierId = identifier(first(raw, ['supplierId', 'proveedorId', 'supplier_id', 'proveedor_id']));
    const supplierObject = first(raw, ['supplier', 'proveedor']);
    const sourceSupplier = supplierId ? sourceSupplierIds.get(supplierId) : null;
    const explicitSupplierName = first(raw, ['supplierName', 'proveedorNombre']);
    const nestedSupplierName = typeof supplierObject === 'string' ? supplierObject : (isRecord(supplierObject) ? first(supplierObject, ['name', 'nombre']) : null);
    const supplierName = sourceText(explicitSupplierName ?? nestedSupplierName ?? sourceSupplier?.name, 180);
    if (supplierId && !sourceSupplier && !supplierName) throw new PurchaseDataError('proveedor de origen no identificado');
    if (!supplierName) throw new PurchaseDataError('proveedor sin nombre');
    const purchaseType = normalizedPurchaseType(first(raw, ['purchaseType', 'purchase_type', 'tipoCompra', 'tipo_compra', 'tipo']));
    const status = normalizedStatus(first(raw, ['status', 'estado']), first(raw, ['anulada', 'cancelled', 'cancelado']));
    const notes = sourceText(first(raw, ['notes', 'note', 'detail', 'observaciones', 'nota']), 500);
    const cancelledAtRaw = first(raw, ['cancelledAt', 'cancelled_at', 'anuladaTS', 'fechaAnulacion', 'cancelDate']);
    const cancelledAt = status === 'CANCELLED' && cancelledAtRaw !== null ? sqlDate(cancelledAtRaw) : null;
    const cancelReason = status === 'CANCELLED' ? sourceText(first(raw, ['cancelReason', 'cancel_reason', 'motivoAnulacion', 'razonAnulacion']), 500) : null;
    const dueAtRaw = first(raw, ['vencimientoTS', 'dueAt', 'due_at', 'vencimiento', 'fechaVencimiento', 'fecha_vencimiento']);
    const dueAt = purchaseType === 'CREDIT' ? sourceDueDate(dueAtRaw, createdAt) : null;

    const lineSubtotal = items.reduce((sum, item) => sum + item.subtotal, 0n);
    const rawSubtotal = moneyCents(first(raw, ['subtotal', 'subTotal', 'base']));
    if (rawSubtotal !== null && rawSubtotal !== lineSubtotal) throw new PurchaseDataError('subtotal histórico C$' + formatMoney(rawSubtotal) + ' no coincide con suma de líneas C$' + formatMoney(lineSubtotal));

    const lineDiscountSpecified = items.every(item => item.discountSpecified);
    const lineTaxSpecified = items.every(item => item.taxSpecified);
    const hasLineDiscountValues = items.some(item => item.discountSpecified);
    const hasLineTaxValues = items.some(item => item.taxSpecified);
    const lineDiscount = items.reduce((sum, item) => sum + item.discount, 0n);
    const lineTax = items.reduce((sum, item) => sum + item.tax, 0n);
    const rawDiscountAmount = moneyCents(first(raw, ['discount', 'descuento', 'discountAmount', 'descuentoMonto']));
    const discountPercent = percentScaled(first(raw, ['discountPercent', 'descuentoPorcentaje', 'porcentajeDescuento', 'descuentoPct']));
    const percentDiscount = discountPercent === null ? null : (lineSubtotal * discountPercent + 500000n) / 1000000n;
    if (rawDiscountAmount !== null && percentDiscount !== null && (rawDiscountAmount > percentDiscount + 1n || percentDiscount > rawDiscountAmount + 1n)) throw new PurchaseDataError('descuento general en monto y porcentaje no coinciden');
    const expectedDiscount = rawDiscountAmount ?? percentDiscount ?? lineDiscount;
    if (lineDiscountSpecified && expectedDiscount !== lineDiscount) throw new PurchaseDataError('descuento general no coincide con descuentos de líneas');
    if (hasLineDiscountValues && !lineDiscountSpecified && (rawDiscountAmount !== null || discountPercent !== null)) throw new PurchaseDataError('descuentos parciales por línea no permiten validar el descuento general');
    if (expectedDiscount < lineDiscount) throw new PurchaseDataError('descuento general menor que la suma de descuentos de líneas');
    if (expectedDiscount > lineSubtotal) throw new PurchaseDataError('descuento general excede el subtotal');
    const rawTax = moneyCents(first(raw, ['tax', 'impuesto', 'taxAmount', 'impuestoMonto']));
    const expectedTax = rawTax ?? lineTax;
    if (lineTaxSpecified && expectedTax !== lineTax) throw new PurchaseDataError('impuesto general no coincide con impuestos de líneas');
    if (hasLineTaxValues && !lineTaxSpecified && rawTax !== null) throw new PurchaseDataError('impuestos parciales por línea no permiten validar el impuesto general');
    if (expectedTax < lineTax) throw new PurchaseDataError('impuesto general menor que la suma de impuestos de líneas');

    if (!lineDiscountSpecified && expectedDiscount !== lineDiscount) {
      const shares = allocateCents(expectedDiscount - lineDiscount, items, 'discount');
      for (let itemIndex = 0; itemIndex < items.length; itemIndex++) items[itemIndex].discount += shares[itemIndex];
    }
    if (!lineTaxSpecified && expectedTax !== lineTax) {
      const shares = allocateCents(expectedTax - lineTax, items, 'tax');
      for (let itemIndex = 0; itemIndex < items.length; itemIndex++) items[itemIndex].tax += shares[itemIndex];
    }
    const discount = items.reduce((sum, item) => sum + item.discount, 0n);
    const tax = items.reduce((sum, item) => sum + item.tax, 0n);
    const total = lineSubtotal - discount + tax;
    const suppliedTotal = moneyCents(first(raw, ['total', 'grandTotal', 'totalCompra', 'montoTotal', 'importeTotal']), true);
    if (suppliedTotal !== total) throw new PurchaseDataError('total histórico C$' + formatMoney(suppliedTotal) + ' no coincide con subtotal - descuento + impuesto C$' + formatMoney(total));
    for (let lineIndex = 0; lineIndex < items.length; lineIndex++) {
      const item = items[lineIndex];
      const lineTotal = item.subtotal - item.discount + item.tax;
      if (item.discount > item.subtotal || lineTotal < 0n || lineTotal > MAX_MONEY_CENTS) throw new PurchaseDataError('detalle ' + (lineIndex + 1) + ' con importes inválidos');
      if (item.suppliedTotal !== null && item.suppliedTotal !== lineTotal) throw new PurchaseDataError('detalle ' + (lineIndex + 1) + ': total histórico C$' + formatMoney(item.suppliedTotal) + ' no coincide con subtotal - descuento + impuesto C$' + formatMoney(lineTotal));
      item.total = lineTotal;
      delete item.discountSpecified;
      delete item.taxSpecified;
      delete item.suppliedTotal;
    }
    if (lineSubtotal > MAX_MONEY_CENTS || discount > MAX_MONEY_CENTS || tax > MAX_MONEY_CENTS || total < 0n || total > MAX_MONEY_CENTS) throw new PurchaseDataError('importes de compra fuera de rango');

    return {
      localPurchaseId, invoice, createdAt, supplierId, supplierName, purchaseType, status,
      subtotal: lineSubtotal, discount, tax, total, dueAt, notes, items, cancelledAt, cancelReason, sourceIndex: index
    };
  } catch (failure) {
    if (failure instanceof PurchaseDataError) return { error: failure.message };
    throw failure;
  }
}

function fingerprintPurchase(purchase, supplierId) {
  return hash(JSON.stringify({
    invoice: purchase.invoice,
    createdAt: purchase.createdAt,
    supplierId,
    purchaseType: purchase.purchaseType,
    status: purchase.status,
    subtotal: purchase.subtotal.toString(),
    discount: purchase.discount.toString(),
    tax: purchase.tax.toString(),
    total: purchase.total.toString(),
    dueAt: purchase.dueAt,
    notes: purchase.notes,
    items: purchase.items.map(item => ({ productId: item.productId, quantity: item.quantity.toString(), unitCost: item.unitCost.toString(), subtotal: item.subtotal.toString(), discount: item.discount.toString(), tax: item.tax.toString(), total: item.total.toString() }))
  }));
}

function sourcePurchaseKey(purchase, fingerprint, occurrence = 0) {
  return hash(purchase.localPurchaseId ? 'local-id:' + purchase.localPurchaseId : 'fallback:' + fingerprint + ':occurrence:' + occurrence);
}

function labelPurchase(purchase, index) {
  return purchase.invoice || purchase.localPurchaseId || 'compra #' + (index + 1);
}

module.exports = {
  MAX_PURCHASES, packageForPurchasesImport, normalizePurchase, normalizeName, hash,
  fingerprintPurchase, sourcePurchaseKey, formatMoney, formatQuantity, sqlDate, labelPurchase
};
