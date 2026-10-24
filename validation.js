'use strict';
(() => {
  const messages = { loginUsername: 'Ingresa tu nombre de usuario', loginPassword: 'Ingresa tu contraseña', prodName: 'Ingresa el nombre del producto', prodBarcode: 'Ingresa el código de barras', prodCategory: 'Selecciona una categoría', prodCost: 'Ingresa un costo válido, sin negativos y con hasta dos decimales', prodRetail: 'Ingresa un precio de menudeo válido', prodWholesale: 'Ingresa un precio de mayoreo válido', prodMargenRetail: 'Ingresa un margen válido, entre -999.9999 y 999.9999', prodMargenWholesale: 'Ingresa un margen válido, entre -999.9999 y 999.9999', prodStock: 'El stock debe ser cero o mayor, con hasta tres decimales', prodMinStock: 'Ingresa un stock mínimo válido', ajusteCantidad: 'Ingresa una cantidad mayor que cero, con hasta tres decimales', ajusteMotivo: 'Ingresa el motivo del movimiento', descuentoPct: 'El descuento debe estar entre 0 y 100, con hasta cuatro decimales' };
  const alwaysValidated = new Set(['systemAdminUsername', 'systemAdminFullName', 'systemAdminPassword', 'systemAdminRole', 'connectedCashReceived', 'localOrderReceived', 'descuentoPct']);
  function feedbackSlot(node) {
    const group = node.closest('.form-group');
    const host = group || node.parentElement;
    if (!host) return null;
    if (!group) host.classList.add('field-feedback-host');
    let slot = host.querySelector(':scope > .field-feedback');
    if (!slot) {
      slot = document.createElement('div');
      slot.className = 'field-feedback';
      slot.id = (node.id || 'formField') + 'Feedback';
      host.append(slot);
    }
    return slot;
  }
  function initializeFeedbackSlots(root = document) {
    for (const group of root.querySelectorAll('.form-group')) {
      const constrained = [...group.querySelectorAll('input, select, textarea')].some(node =>
        node.required || ['pattern', 'minlength', 'maxlength', 'min', 'max', 'step'].some(attr => node.hasAttribute(attr)) || alwaysValidated.has(node.id));
      if (!constrained) continue;
      group.classList.add('has-field-feedback');
      const control = group.querySelector('input, select, textarea');
      if (control) feedbackSlot(control);
    }
    for (const id of alwaysValidated) {
      const node = document.getElementById(id);
      if (node && !node.closest('.form-group')) feedbackSlot(node);
    }
  }
  function clear(form) {
    form.querySelectorAll('.field-error').forEach(node => {
      const input = document.getElementById(node.dataset.fieldId);
      if (input) {
        input.removeAttribute('aria-invalid');
        const describedBy = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== node.id);
        if (describedBy.length) input.setAttribute('aria-describedby', describedBy.join(' '));
        else input.removeAttribute('aria-describedby');
      }
      node.remove();
    });
    form.querySelectorAll('.field-help').forEach(node => { node.hidden = false; });
  }
  function field(id, message, focus = true) {
    const node = document.getElementById(id); if (!node) return;
    const errorId = id + 'FieldError'; let error = document.getElementById(errorId);
    const slot = feedbackSlot(node);
    if (!error) { error = document.createElement('small'); error.id = errorId; error.className = 'field-error'; error.dataset.fieldId = id; error.setAttribute('role', 'alert'); slot?.append(error); }
    if (slot) slot.removeAttribute('aria-hidden');
    slot?.querySelectorAll('.field-help').forEach(help => { help.hidden = true; });
    error.hidden = false;
    error.textContent = message; node.setAttribute('aria-invalid', 'true');
    const describedBy = (node.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    if (!describedBy.includes(errorId)) describedBy.push(errorId);
    node.setAttribute('aria-describedby', describedBy.join(' '));
    if (focus) node.focus();
  }
  function validate(form, connected = false) {
    initializeFeedbackSlots(form); clear(form); let first = null;
    for (const node of form.querySelectorAll('input, select, textarea')) {
      if (node.disabled || node.type === 'hidden') continue;
      let message = '';
      if (node.required && !node.value.trim()) message = messages[node.id] || 'Completa este campo';
      else if (connected && ['prodCost', 'prodRetail', 'prodWholesale', 'prodStock', 'prodMinStock', 'ajusteCantidad', 'prodMargenRetail', 'prodMargenWholesale', 'descuentoPct'].includes(node.id)) {
        const scale = ['prodStock', 'prodMinStock', 'ajusteCantidad'].includes(node.id) ? 3 : (node.id.includes('Margen') || node.id === 'descuentoPct' ? 4 : 2);
        const signed = node.id.includes('Margen');
        const pattern = new RegExp('^' + (signed ? '-?' : '') + '\\d+(?:\\.\\d{1,' + scale + '})?$');
        const value = Number(node.value);
        if (!pattern.test(node.value) || !Number.isFinite(value) || (signed && Math.abs(value) >= 1000) || (!signed && value < 0) || (node.id === 'ajusteCantidad' && value <= 0) || (node.id === 'descuentoPct' && value > 100)) message = messages[node.id];
      } else if (!node.validity.valid) message = messages[node.id] || 'Revisa el valor de este campo';
      if (message) { field(node.id, message, false); first ||= node; }
    }
    first?.focus(); return !first;
  }
  const login = document.getElementById('loginForm'); login.noValidate = true;
  login.addEventListener('submit', event => { if (!validate(login)) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  document.addEventListener('input', event => {
    const node = event.target; if (!node.id || node.getAttribute('aria-invalid') !== 'true') return;
    node.removeAttribute('aria-invalid');
    const error = document.getElementById(node.id + 'FieldError');
    const describedBy = (node.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== error?.id);
    if (describedBy.length) node.setAttribute('aria-describedby', describedBy.join(' '));
    else node.removeAttribute('aria-describedby');
    error?.remove();
    node.closest('.form-group, .field-feedback-host')?.querySelectorAll('.field-help').forEach(help => { help.hidden = false; });
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => initializeFeedbackSlots(), { once: true });
  else initializeFeedbackSlots();
  window.PosValidation = Object.freeze({ clear, field, validate });
})();
