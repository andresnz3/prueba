'use strict';

const { createHash } = require('node:crypto');
const { httpError } = require('../middleware/errors');
const { packageForImport, normalizeName } = require('./basic-migration-values');

const MAX_SALES = 50000;
const MAX_ITEMS_PER_SALE = 500;
const MAX_MONEY_CENTS = 999999999999n;

class SaleDataError extends Error {}

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
  if (typeof value !== 'string' || value.length > max || [...value].some(character => character.charCodeAt(0) <= 0x1f)) throw new SaleDataError('texto inválido');
  return value.trim() || null;
}

function moneyCents(value, required = false) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new SaleDataError('importe faltante');
    return null;
  }
  let cents;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value > 9999999999.99) throw new SaleDataError('importe inválido');
    cents = BigInt(Math.round(value * 100));
  } else if (typeof value === 'string') {
    const normalized = value.trim();
    const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(normalized);
    if (!match) throw new SaleDataError('importe inválido');
    cents = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0') || '0');
  } else throw new SaleDataError('importe inválido');
  if (cents > MAX_MONEY_CENTS) throw new SaleDataError('importe fuera de rango');
  return cents;
}

function quantityMilli(value) {
  let milli;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0 || value > 999999999.999) throw new SaleDataError('cantidad inválida');
    milli = BigInt(Math.round(value * 1000));
  } else if (typeof value === 'string') {
    const match = /^(\d{1,9})(?:\.(\d{1,3}))?$/.exec(value.trim());
    if (!match) throw new SaleDataError('cantidad inválida');
    milli = BigInt(match[1]) * 1000n + BigInt((match[2] || '').padEnd(3, '0') || '0');
  } else throw new SaleDataError('cantidad inválida');
  if (milli <= 0n || milli >= 1000000000000n) throw new SaleDataError('cantidad fuera de rango');
  return milli;
}

function scaledNumber(value, scale, max, label) {
  if (value === null || value === undefined || value === '') return null;
  let text;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value > max) throw new SaleDataError(label + ' inválido');
    text = value.toFixed(scale);
  } else if (typeof value === 'string') text = value.trim();
  else throw new SaleDataError(label + ' inválido');
  const match = new RegExp('^(\\d{1,' + (scale === 4 ? '3' : '3') + '})(?:\\.(\\d{1,' + scale + '}))?$').exec(text);
  if (!match) throw new SaleDataError(label + ' inválido');
  const scaled = BigInt(match[1]) * (10n ** BigInt(scale)) + BigInt((match[2] || '').padEnd(scale, '0') || '0');
  if (Number(scaled) / (10 ** scale) > max) throw new SaleDataError(label + ' fuera de rango');
  return scaled;
}

function percentScaled(value) {
  const scaled = scaledNumber(value, 4, 100, 'descuento');
  if (scaled === null) return null;
  return scaled;
}

function rateScaled(value) {
  return scaledNumber(value, 4, 999.9999, 'impuesto');
}

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function packageForSalesImport(value) {
  const imported = packageForImport(value);
  if (!Array.isArray(value.data.sales) || value.data.sales.length > MAX_SALES) invalidPackage();

  const sourceProducts = value.data.products.map((raw, index) => {
    const product = imported.products[index];
    return {
      id: identifier(first(raw, ['id', 'productId', 'productoId', 'product_id'])),
      barcode: product.barcode,
      name: product.name,
      costCents: moneyCents(product.cost) ?? 0n,
      taxRate: rateScaled(first(raw, ['taxRate', 'tax_rate', 'tax']))
    };
  });
  const sourceClients = value.data.clients.map((raw, index) => ({
    id: identifier(first(raw, ['id', 'clientId', 'clienteId', 'client_id'])),
    name: imported.clients[index].name
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
    sourceClients,
    sourceClientsById: new Map(sourceClients.filter(item => item.id).map(item => [item.id, item])),
    sales: value.data.sales
  };
}

function sqlDate(value, required = false) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new SaleDataError('fecha de venta faltante');
    return null;
  }
  let date;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const epoch = Math.abs(value) < 100000000000 ? value * 1000 : value;
    date = new Date(epoch);
  } else if (typeof value === 'string') date = new Date(value);
  else throw new SaleDataError('fecha inválida');
  if (!Number.isFinite(date.getTime())) throw new SaleDataError('fecha inválida');
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

function token(value) {
  return normalizeName(String(value)).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function normalizedPaymentMethod(value, saleTypeValue) {
  const saleType = token(saleTypeValue || '');
  if (value === null || value === undefined || value === '') return /CREDIT|CREDITO|FIADO/.test(saleType) ? 'CREDIT' : 'CASH';
  const method = token(value);
  if (/^(CASH|EFECTIVO|CONTADO)$/.test(method)) return 'CASH';
  if (/^(CARD|TARJETA|TARJETA_CREDITO|TARJETA_DEBITO|CREDIT_CARD|DEBIT_CARD|POS)$/.test(method)) return 'CARD';
  if (/^(TRANSFER|TRANSFERENCIA|BANK|BANCO|WIRE)$/.test(method)) return 'TRANSFER';
  if (/^(CREDIT|CREDITO|FIADO|CREDITO_CLIENTE)$/.test(method)) return 'CREDIT';
  throw new SaleDataError('método de pago no reconocido');
}

function normalizedStatus(value) {
  if (value === null || value === undefined || value === '') return 'COMPLETED';
  const status = token(value);
  if (/CANCEL|ANUL|VOID/.test(status)) return 'CANCELLED';
  if (/^(COMPLETED|COMPLETA|COMPLETADA|PAGADA|PAGADO|FINALIZADA|FINALIZADO|CONFIRMADA|CONFIRMADO|OK|ACTIVE|ACTIVA)$/.test(status)) return 'COMPLETED';
  throw new SaleDataError('estado de venta no reconocido');
}

function cancellationStatus(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value === true || value === 1) return 'ANULADA';
  if (value === false || value === 0) return null;
  if (typeof value === 'string') {
    const normalized = token(value);
    if (/^(TRUE|1|SI|S|ANULADA|CANCELADA|CANCELLED|VOID)$/.test(normalized)) return 'ANULADA';
    if (/^(FALSE|0|NO|N|ACTIVA|ACTIVE|COMPLETADA|COMPLETED)$/.test(normalized)) return null;
  }
  throw new SaleDataError('indicador de anulación no reconocido');
}

function inferredMoney(quantity, unitPriceCents) {
  const numerator = quantity * unitPriceCents;
  return (numerator + 500n) / 1000n;
}

function normalizeSale(raw, index, imported) {
  if (!isRecord(raw)) return { error: 'registro inválido' };
  try {
    const sourceProductIds = imported.sourceProductsById || new Map(imported.sourceProducts.filter(item => item.id).map(item => [item.id, item]));
    const sourceClientIds = imported.sourceClientsById || new Map(imported.sourceClients.filter(item => item.id).map(item => [item.id, item]));
    const rawItems = first(raw, ['items', 'detalleProductos', 'detalles', 'products', 'lineItems']);
    if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > MAX_ITEMS_PER_SALE) throw new SaleDataError('sin detalle de productos válido');
    const items = rawItems.map((line, lineIndex) => {
      if (!isRecord(line)) throw new SaleDataError('detalle ' + (lineIndex + 1) + ' inválido');
      const nestedProduct = first(line, ['product', 'producto']);
      const sourceProductId = identifier(first(line, ['productId', 'productoId', 'product_id', 'producto_id', 'id']) ?? (isRecord(nestedProduct) ? first(nestedProduct, ['id', 'productId']) : null));
      const sourceProduct = sourceProductId ? sourceProductIds.get(sourceProductId) : null;
      const barcode = sourceText(first(line, ['barcode', 'codigo', 'code']) ?? (isRecord(nestedProduct) ? first(nestedProduct, ['barcode', 'codigo', 'code']) : null) ?? sourceProduct?.barcode, 100);
      const name = sourceText(first(line, ['productName', 'nombreProducto', 'name', 'nombre', 'descripcion']) ?? (isRecord(nestedProduct) ? first(nestedProduct, ['name', 'nombre']) : null) ?? sourceProduct?.name, 180);
      if (!barcode && !name) throw new SaleDataError('detalle ' + (lineIndex + 1) + ' no identifica producto');
      const quantity = quantityMilli(first(line, ['quantity', 'cantidad', 'qty']));
      const salePriceType = first(raw, ['tarifa', 'priceType', 'tipoPrecio', 'sale_price_type']);
      const linePriceType = first(line, ['tarifa', 'priceType', 'tipoPrecio']);
      const priceKeys = /MAYOREO|MAYORISTA|WHOLESALE/.test(token(salePriceType ?? linePriceType ?? ''))
        ? ['wholesalePrice', 'precio2']
        : ['retailPrice', 'precio1'];
      const suppliedUnitPrice = moneyCents(first(line, ['unitPrice', 'precioUnitario', 'price', 'precio', 'precioVenta', ...priceKeys]));
      const suppliedLineTotal = moneyCents(first(line, ['total', 'importe', 'monto']));
      if (suppliedUnitPrice === null) throw new SaleDataError('detalle ' + (lineIndex + 1) + ' sin precio histórico');
      const unitPrice = suppliedUnitPrice;
      const calculatedSubtotal = inferredMoney(quantity, unitPrice);
      const suppliedSubtotal = moneyCents(first(line, ['subtotal', 'subTotal']));
      const subtotal = suppliedSubtotal ?? calculatedSubtotal;
      if (subtotal !== calculatedSubtotal) throw new SaleDataError('detalle ' + (lineIndex + 1) + ': subtotal histórico C$' + formatMoney(subtotal) + ' no coincide con cantidad × precio C$' + formatMoney(calculatedSubtotal));
      const rawLineDiscount = moneyCents(first(line, ['discount', 'descuento', 'discountAmount', 'descuentoMonto']));
      const lineDiscountPercent = percentScaled(first(line, ['discountPercent', 'descuentoPorcentaje', 'porcentajeDescuento', 'descuentoPct']));
      const percentLineDiscount = lineDiscountPercent === null ? null : (subtotal * lineDiscountPercent + 500000n) / 1000000n;
      if (rawLineDiscount !== null && percentLineDiscount !== null && (rawLineDiscount > percentLineDiscount + 1n || percentLineDiscount > rawLineDiscount + 1n)) throw new SaleDataError('detalle ' + (lineIndex + 1) + ': descuento en monto y porcentaje no coinciden');
      const discount = rawLineDiscount ?? percentLineDiscount ?? 0n;
      const taxValue = first(line, ['tax', 'impuesto']);
      const tax = moneyCents(taxValue) ?? 0n;
      const calculatedTotal = subtotal - discount + tax;
      if (suppliedLineTotal !== null && suppliedLineTotal !== calculatedTotal) throw new SaleDataError('detalle ' + (lineIndex + 1) + ': total histórico C$' + formatMoney(suppliedLineTotal) + ' no coincide con subtotal - descuento + impuesto C$' + formatMoney(calculatedTotal));
      const total = suppliedLineTotal ?? calculatedTotal;
      if (total < 0n || total > MAX_MONEY_CENTS || discount > subtotal + tax) throw new SaleDataError('detalle ' + (lineIndex + 1) + ' con importes inválidos');
      return {
        sourceProductId, barcode, name, quantity, unitPrice, discount, subtotal, total,
        costCents: moneyCents(first(line, ['costAtSale', 'cost', 'costo'])) ?? sourceProduct?.costCents ?? null,
        taxRate: rateScaled(first(line, ['taxRate', 'tax_rate', 'impuestoPorcentaje'])) ?? sourceProduct?.taxRate ?? null,
        tax, taxSpecified: taxValue !== null
      };
    });

    const createdAt = sqlDate(first(raw, ['createdAt', 'created_at', 'fechaTS', 'fecha', 'date', 'timestamp']), true);
    const rawLocalSaleId = first(raw, ['id', 'saleId', 'ventaId', 'sale_id', 'venta_id']);
    const localSaleId = identifier(rawLocalSaleId);
    const rawClientId = identifier(first(raw, ['clientId', 'clienteId', 'client_id', 'cliente_id']));
    const rawClient = first(raw, ['client', 'cliente', 'customer']);
    const explicitClientName = first(raw, ['clientName', 'clienteNombre', 'nombreCliente', 'customerName']) ?? (isRecord(rawClient) ? first(rawClient, ['name', 'nombre']) : (typeof rawClient === 'string' ? rawClient : null));
    const sourceClient = rawClientId ? sourceClientIds.get(rawClientId) : null;
    const clientName = sourceText(explicitClientName ?? sourceClient?.name, 180);
    if (rawClientId && !sourceClient && !clientName) throw new SaleDataError('cliente de origen no identificado');
    const isCashLabel = !rawClientId && clientName && /^(CONTADO|CONSUMIDOR FINAL|SIN CLIENTE|[-–—]|N\/A)$/i.test(clientName);
    const clientReference = isCashLabel ? null : (rawClientId || clientName ? (clientName || sourceClient?.name) : null);

    const lineSubtotal = items.reduce((sum, item) => sum + item.subtotal, 0n);
    const lineDiscount = items.reduce((sum, item) => sum + item.discount, 0n);
    const lineTax = items.reduce((sum, item) => sum + item.tax, 0n);
    const lineTotals = items.reduce((sum, item) => sum + item.total, 0n);
    const subtotalValue = moneyCents(first(raw, ['subtotal', 'subTotal', 'base']));
    const subtotal = subtotalValue ?? lineSubtotal;
    if (subtotal !== lineSubtotal) throw new SaleDataError('subtotal histórico C$' + formatMoney(subtotal) + ' no coincide con la suma de líneas C$' + formatMoney(lineSubtotal));
    const taxValue = first(raw, ['tax', 'impuesto']);
    const suppliedTax = moneyCents(taxValue);
    const tax = suppliedTax ?? lineTax;
    if (suppliedTax !== null && items.some(item => item.taxSpecified) && suppliedTax !== lineTax) throw new SaleDataError('impuesto histórico C$' + formatMoney(suppliedTax) + ' no coincide con la suma de líneas C$' + formatMoney(lineTax));
    const rawDiscount = moneyCents(first(raw, ['discount', 'descuento', 'discountAmount', 'descuentoMonto']));
    const discountPercent = percentScaled(first(raw, ['discountPercent', 'descuentoPorcentaje', 'porcentajeDescuento', 'descuentoPct']));
    const discount = rawDiscount ?? (discountPercent === null ? items.reduce((sum, item) => sum + item.discount, 0n) : (subtotal * discountPercent + 500000n) / 1000000n);
    const percentageDiscount = discountPercent === null ? null : (subtotal * discountPercent + 500000n) / 1000000n;
    if (rawDiscount !== null && percentageDiscount !== null && (rawDiscount > percentageDiscount + 1n || percentageDiscount > rawDiscount + 1n)) throw new SaleDataError('descuento histórico en monto y porcentaje no coinciden');
    const calculatedTotal = subtotal - discount + tax;
    const suppliedTotal = moneyCents(first(raw, ['total', 'grandTotal', 'totalVenta', 'montoTotal', 'importeTotal']));
    if (suppliedTotal !== null && suppliedTotal !== calculatedTotal) throw new SaleDataError('total histórico C$' + formatMoney(suppliedTotal) + ' no coincide con subtotal - descuento + impuesto C$' + formatMoney(calculatedTotal));
    const total = suppliedTotal ?? calculatedTotal;
    const expectedLineTotalDifference = discount - lineDiscount - (tax - lineTax);
    if (lineTotals - total !== expectedLineTotalDifference) throw new SaleDataError('total de líneas C$' + formatMoney(lineTotals) + ', descuentos C$' + formatMoney(discount) + ' y total histórico C$' + formatMoney(total) + ' no son coherentes');
    if (subtotal > MAX_MONEY_CENTS || tax > MAX_MONEY_CENTS || discount > MAX_MONEY_CENTS || total < 0n || total > MAX_MONEY_CENTS || discount > subtotal + tax) throw new SaleDataError('importes de venta inválidos');

    const rawSaleType = first(raw, ['saleType', 'tipoVenta', 'sale_type', 'tipo']);
    let paymentMethod = normalizedPaymentMethod(first(raw, ['paymentMethod', 'medioPago', 'medio_pago', 'metodoPago', 'payment_method', 'metodo']), rawSaleType);
    const typeToken = token(rawSaleType || '');
    let saleType = /CREDIT|CREDITO|FIADO/.test(typeToken) || paymentMethod === 'CREDIT' ? 'CREDIT' : 'CASH';
    const status = normalizedStatus(first(raw, ['status', 'estado', 'saleStatus']) ?? cancellationStatus(first(raw, ['anulada', 'cancelled', 'cancelado'])));
    const priceToken = token(first(raw, ['priceType', 'tipoPrecio', 'sale_price_type', 'tarifa']) || '');
    const priceType = /WHOLESALE|MAYOREO|MAYORISTA/.test(priceToken) ? 'WHOLESALE' : 'RETAIL';
    const detail = sourceText(first(raw, ['detail', 'nota', 'note']), 500);
    const rawLocalInvoice = first(raw, ['invoiceNumber', 'numeroFactura', 'factura', 'invoice', 'comprobante', 'numero']);
      const localInvoice = sourceText(rawLocalInvoice == null ? null : String(rawLocalInvoice), 100);
    const canceledAt = status === 'CANCELLED' ? sqlDate(first(raw, ['cancelledAt', 'fechaAnulacion', 'cancelDate']) || createdAt, true) : null;
    const cancelReason = status === 'CANCELLED' ? (sourceText(first(raw, ['cancelReason', 'motivoAnulacion']), 500) || 'Anulada en el paquete local') : null;
    // v2 keeps the canonical timestamp separately; vencimiento may be a
    // localized display string (for example "30 días") and is not a date.
    const dueAt = sqlDate(first(raw, ['dueAt', 'due_at', 'fechaVencimiento', 'fecha_vencimiento', 'vencimientoTS', 'vencimiento']), false);
    const discountPercentValue = discountPercent ?? (subtotal > 0n ? (discount * 1000000n + subtotal / 2n) / subtotal : 0n);
    const discountPercentText = (discountPercentValue / 10000n).toString() + '.' + (discountPercentValue % 10000n).toString().padStart(4, '0');

    return {
      localSaleId, localInvoice, createdAt, clientReference, clientName, saleType, paymentMethod, status,
      priceType, subtotal, discount, discountPercent: discountPercentText, tax, total, detail, canceledAt,
      cancelReason, dueAt, items, itemCount: items.length,
      sourceIndex: index
    };
  } catch (failure) {
    if (failure instanceof SaleDataError) return { error: failure.message };
    throw failure;
  }
}

function formatMoney(cents) {
  const value = BigInt(cents);
  return (value / 100n).toString() + '.' + (value % 100n).toString().padStart(2, '0');
}

function formatQuantity(milli) {
  const value = BigInt(milli);
  return (value / 1000n).toString() + '.' + (value % 1000n).toString().padStart(3, '0');
}

function formatRate(scaled) {
  if (scaled === null || scaled === undefined) return '0.0000';
  const value = BigInt(scaled);
  return (value / 10000n).toString() + '.' + (value % 10000n).toString().padStart(4, '0');
}

function fingerprintSale(sale, targetClientId) {
  const client = targetClientId ? 'client:' + targetClientId : 'cash';
  const value = {
    createdAt: sale.createdAt,
    client,
    localInvoice: sale.localInvoice,
    saleType: sale.saleType,
    paymentMethod: sale.paymentMethod,
    status: sale.status,
    priceType: sale.priceType,
    subtotal: sale.subtotal.toString(),
    discount: sale.discount.toString(),
    discountPercent: sale.discountPercent,
    tax: sale.tax.toString(),
    total: sale.total.toString(),
    detail: sale.detail,
    canceledAt: sale.canceledAt,
    cancelReason: sale.cancelReason,
    dueAt: sale.dueAt,
    items: sale.items.map(item => ({
      productId: item.productId,
      quantity: item.quantity.toString(),
      unitPrice: item.unitPrice.toString(),
      discount: item.discount.toString(),
      subtotal: item.subtotal.toString(),
      total: item.total.toString(),
      taxRate: item.taxRate?.toString() ?? null,
      cost: (item.costCents ?? item.cost)?.toString() ?? null
    }))
  };
  return hash(JSON.stringify(value));
}

function sourceSaleKey(sale, fingerprint, occurrence = 0) {
  return hash(sale.localSaleId
    ? 'local-id:' + sale.localSaleId
    : 'fallback:' + fingerprint + ':occurrence:' + occurrence);
}

function migrationInvoice(sourceBusinessKey, sourceSaleKey, localInvoice) {
  const readable = String(localInvoice || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 18);
  return 'MIG-' + (readable ? readable + '-' : '') + sourceBusinessKey.slice(0, 8) + sourceSaleKey.slice(0, 20);
}

function labelSale(sale, index) {
  return sale.localInvoice || sale.localSaleId || 'venta #' + (index + 1);
}

module.exports = {
  MAX_SALES, packageForSalesImport, normalizeSale, normalizeName, hash, fingerprintSale,
  sourceSaleKey, migrationInvoice, formatMoney, formatQuantity, formatRate, labelSale
};
