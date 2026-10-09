/* global connectedMode, blockPendingConnected, showAlert, showConfirm, escapeHtml */
'use strict';
(() => {
  if (!connectedMode) return;
  const el = id => document.getElementById(id);
  el('productForm').noValidate = true; el('ajusteInventarioForm').noValidate = true;
  let rows = [], editing = null, busy = false, uncertain = false;
  let photoFile = null, photoPreview = null, photoError = null, uploadedPhoto = null;
  const imageInput = el('prodImageInput');
  imageInput.accept = 'image/jpeg,image/png,image/webp';
  function resetPhoto() {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    photoFile = photoPreview = photoError = uploadedPhoto = null;
  }
  function selectImage(file) {
    resetPhoto();
    if (file && !['image/jpeg','image/png','image/webp'].includes(file.type)) photoError = new window.PosApiError('IMAGE_FORMAT_INVALID');
    else if (file && file.size > 8 * 1024 * 1024) photoError = new window.PosApiError('IMAGE_TOO_LARGE');
    else if (file && !file.size) photoError = new window.PosApiError('IMAGE_INVALID');
    const preview = el('prodImagePreview');
    if (photoError) {
      window.PosValidation.field('prodImageInput', photoError.message);
      imageInput.value = ''; window.PosRuntime.setProductImage(editing?.image || null);
      preview.src = editing?.image || ''; preview.style.display = editing?.image ? 'block' : 'none';
      showAlert(photoError.message); return;
    }
    if (!file) return;
    photoFile = file; photoPreview = URL.createObjectURL(file);
    window.PosRuntime.setProductImage(photoPreview);
    preview.src = photoPreview; preview.style.display = 'block';
  }
  const blockedForms = new Set(['paymentForm', 'payablePaymentForm']);
  const blockedButtons = new Set(['confirmCashBtn', 'confirmCashCorrectionBtn', 'registrarEntradaBtn', 'registrarSalidaBtn']);
  // Capture impide ejecutar los handlers locales cuando el modulo aun no tiene API.
  document.addEventListener('submit', event => {
    if (!blockedForms.has(event.target.id)) return;
    event.preventDefault(); event.stopImmediatePropagation(); blockPendingConnected();
  }, true);
  document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || (!blockedButtons.has(button.id) && !(button.type === 'submit' && blockedForms.has(button.closest('form')?.id)))) return;
    event.preventDefault(); event.stopImmediatePropagation(); blockPendingConnected();
  }, true);
  el('refreshInventoryBtn').classList.remove('hidden');
  // El proveedor pendiente no participa en validacion ni en escrituras conectadas.
  const supplier = el('prodSupplier');
  supplier.required = false; supplier.setCustomValidity(''); supplier.value = '';
  supplier.disabled = true; supplier.closest('.form-group').classList.add('hidden');
  supplier.title = 'Opcional; disponible cuando se integre el modulo de proveedores.';
  for (const id of ['prodStock', 'prodMinStock', 'ajusteCantidad']) { el(id).step = '0.001'; el(id).min = id === 'ajusteCantidad' ? '0.001' : '0'; }
  for (const id of ['prodMargenRetail', 'prodMargenWholesale']) el(id).step = '0.0001';
  function closePanels() {
    resetPhoto(); window.PosRuntime.setProductImage(null);
    const modal = el('productModal'); if (modal) delete modal.dataset.purchaseContext;
    el('prodStock').disabled = false; imageInput.disabled = false;
    for (const id of ['productModal', 'ajusteInventarioModal', 'kardexModal']) el(id).classList.add('hidden');
    editing = null;
  }
  function ensureBusiness(value, business) {
    if (value.businessId !== business) throw new window.PosApiError('INVALID_SESSION', 401);
    return value;
  }
  async function all(fetchPage, business) {
    const result = [];
    for (let offset = 0; ; offset += 100) {
      const page = await fetchPage(offset);
      for (const value of page) result.push(ensureBusiness(value, business));
      if (page.length < 100) return result;
    }
  }
  function publish(product) {
    const index = rows.findIndex(row => row.id === product.id);
    if (index < 0) rows.push(product); else rows[index] = product;
    window.PosRuntime.setProducts(rows);
  }
  async function load(view) {
    if (!['inventoryView', 'salesView'].includes(view)) { closePanels(); return; }
    const result = await window.PosConnected.inventoryOperation((api, business) => all(offset => api.products(view === 'salesView', offset), business));
    rows = result; window.PosRuntime.setProducts(rows);
    if (view !== 'inventoryView') closePanels();
  }
  async function fail(failure) {
    if (failure.code === 'STALE_REQUEST') return;
    if (failure.code === 'INVALID_SESSION') { window.PosConnected.handleError(failure); return; }
    if (failure.code === 'MODULE_FORBIDDEN') { closePanels(); await window.PosConnected.navigate('inventoryView'); return; }
    if (failure.status >= 500 || ['NETWORK_ERROR', 'DATABASE_UNAVAILABLE', 'INVALID_RESPONSE'].includes(failure.code)) {
      uncertain = true; rows = []; window.PosRuntime.setProducts(rows);
      showAlert(failure.message + '\nActualiza el inventario y comprueba el Kardex antes de reintentar una escritura; una respuesta perdida no confirma si se guardo.');
    } else {
      const fields = { barcode: 'prodBarcode', name: 'prodName', category: 'prodCategory', cost: 'prodCost', marginRetail: 'prodMargenRetail', marginWholesale: 'prodMargenWholesale', retailPrice: 'prodRetail', wholesalePrice: 'prodWholesale', stock: 'prodStock', minStock: 'prodMinStock', quantity: 'ajusteCantidad', reason: 'ajusteMotivo' };
      const input = failure.code === 'BARCODE_EXISTS' ? 'prodBarcode' : failure.code === 'INSUFFICIENT_STOCK' ? 'ajusteCantidad' : fields[failure.field];
      if (input) window.PosValidation.field(input, failure.code === 'INVALID_INPUT' ? 'Revisa el valor de este campo; respeta su límite y precisión.' : failure.message);
      showAlert(failure.message);
    }
  }
  async function run(operation) {
    if (busy) return;
    busy = true;
    const buttons = [...document.querySelectorAll('#productForm button[type=submit], #ajusteInventarioForm button[type=submit], #refreshInventoryBtn')];
    buttons.push(imageInput);
    buttons.forEach(button => { button.disabled = true; });
    try { await operation(); } catch (failure) { await fail(failure); }
    finally { busy = false; buttons.forEach(button => { button.disabled = false; }); }
  }
  async function refresh() { return run(async () => { await load('inventoryView'); uncertain = false; closePanels(); }); }
  el('refreshInventoryBtn').addEventListener('click', refresh);
  el('addNewProductBtn').addEventListener('click', () => { resetPhoto(); editing = null; });
  async function detail(id) {
    return window.PosConnected.inventoryOperation(async (api, business) => ensureBusiness(await api.product(id), business));
  }
  async function edit(id) { return run(async () => { resetPhoto(); editing = await detail(id); imageInput.value = ''; publish(editing); window.PosRuntime.openProductEditor(editing); }); }
  function checkWrite() { if (uncertain) throw new window.PosApiError('RETRY_OPERATION'); }
  async function save() {
    if (!window.PosValidation.validate(el('productForm'), true)) return;
    return run(async () => {
      checkWrite();
      const id = el('prodId').value;
      if (id && (!editing || editing.id !== id)) throw new window.PosApiError('PRODUCT_CONFLICT');
      const data = {};
      for (const [field, input] of Object.entries({ barcode: 'prodBarcode', name: 'prodName', category: 'prodCategory', cost: 'prodCost', marginRetail: 'prodMargenRetail', marginWholesale: 'prodMargenWholesale', retailPrice: 'prodRetail', wholesalePrice: 'prodWholesale', stock: 'prodStock', minStock: 'prodMinStock' })) data[field] = el(input).value;
      data.active = el('prodStatus').value === 'true';
      if (photoError) throw photoError;
      if (!id) data.image = null;
      data.taxRate = editing ? editing.taxRate.toFixed(4) : '0.0000';
      if (id) data.revision = editing.revision;
      const purchaseContext = el('productModal').dataset.purchaseContext === 'true';
      if (purchaseContext && id) throw new window.PosApiError('PRODUCT_CONFLICT');
      if (purchaseContext && photoFile) throw new window.PosApiError('PURCHASE_PRODUCT_IMAGE_UNAVAILABLE');
      if (purchaseContext) data.stock = '0.000';
      const product = await window.PosConnected.inventoryOperation(async (api, business) => {
        if (purchaseContext) {
          const created = await api.createPurchaseProduct(data);
          if (created.businessId !== business) throw new window.PosApiError('INVALID_SESSION', 401);
          return created;
        }
        if (photoFile) {
          if (!uploadedPhoto) uploadedPhoto = await api.uploadImage(photoFile);
          data.image = uploadedPhoto;
        }
        return ensureBusiness(await (id ? api.updateProduct(id,data) : api.createProduct(data)),business);
      });
      if (purchaseContext) await window.PosPurchases?.productCreated(product);
      else publish(product);
      window.detenerProdCamara(); closePanels(); showAlert('Producto guardado.');
    });
  }
  async function toggle(id) {
    return run(async () => {
      checkWrite(); const product = await detail(id);
      showConfirm('Deseas ' + (product.active ? 'inactivar' : 'activar') + ' ' + product.name + '? El historial se conserva.', () => run(async () => {
        checkWrite(); const updated = await window.PosConnected.inventoryOperation(async (api, business) => ensureBusiness(await api.updateProduct(id, { revision: product.revision, active: !product.active }), business));
        publish(updated); showAlert('Estado actualizado.');
      }));
    });
  }
  async function openAdjustment(id) {
    return run(async () => {
      const product = await detail(id); publish(product);
      el('ajusteInventarioForm').reset(); el('ajusteProductoId').value = product.id;
      el('ajusteProductoNombre').textContent = product.name + ' (Stock actual: ' + product.stock + ')';
      el('ajusteInventarioModal').classList.remove('hidden');
    });
  }
  async function adjust() {
    if (!window.PosValidation.validate(el('ajusteInventarioForm'), true)) return;
    return run(async () => {
      checkWrite(); const id = el('ajusteProductoId').value;
      const data = { type: el('ajusteTipo').value === 'MERMA' ? 'WASTE' : 'ADJUSTMENT', quantity: el('ajusteCantidad').value, reason: el('ajusteMotivo').value.trim() };
      const product = await window.PosConnected.inventoryOperation(async (api, business) => ensureBusiness(await api.adjustProduct(id, data), business));
      publish(product); closePanels(); showAlert('Movimiento guardado.');
    });
  }
  async function kardex(id) {
    return run(async () => {
      const result = await window.PosConnected.inventoryOperation(async (api, business) => {
        const product = ensureBusiness(await api.product(id), business);
        let maxId = null;
        const movements = await all(async offset => {
          const page = await api.movements(id, offset, maxId);
          if (!maxId && page.length) maxId = page[0].id;
          return page;
        }, business);
        return { product, movements };
      });
      publish(result.product);
      el('kardexModalTitle').textContent = 'Kardex: ' + result.product.name;
      el('kardexModalSubtitle').textContent = 'Codigo: ' + result.product.barcode + ' | Stock actual: ' + result.product.stock;
      el('kardexTableBody').innerHTML = result.movements.length ? result.movements.map(item => '<tr data-table-date="' + window.PosTables.dateKey(item.createdAt) + '"><td>' + escapeHtml(new Date(item.createdAt).toLocaleString()) + '</td><td>' + escapeHtml(item.type) + '</td><td>' + item.quantity + '</td><td>' + item.unitCost.toFixed(2) + '</td><td>' + (item.stockAfter ?? '-') + '</td><td>' + escapeHtml(item.reason) + '</td><td>' + escapeHtml(item.userName) + '</td></tr>').join('') : '<tr><td colspan="7">No hay movimientos.</td></tr>';
      window.PosTables.setupDataTable(el('kardexTableBody'), { label: 'Kardex', fileName: 'kardex', dateColumn: 0, rebuild: true });
      el('kardexModal').classList.remove('hidden');
    });
  }
  function openPurchaseProduct() {
    el('productForm').reset(); resetPhoto(); editing = null; el('prodId').value = ''; el('prodStock').value = '0'; el('prodStock').disabled = true; imageInput.disabled = true;
    el('prodMinStock').value = '5'; el('prodMargenRetail').value = '10'; el('prodMargenWholesale').value = '10'; el('prodStatus').value = 'true';
    el('productModal').dataset.purchaseContext = 'true'; el('productModal').classList.remove('hidden'); el('prodBarcode').focus();
  }
  window.PosInventory = Object.freeze({ selectImage, load, refresh, save, edit, toggle, openAdjustment, adjust, kardex, closePanels, openPurchaseProduct });
})();
