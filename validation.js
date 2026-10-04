'use strict';
(() => {
  const messages = { loginUsername: 'Ingresa tu nombre de usuario', loginPassword: 'Ingresa tu contraseña', loginBusinessId: 'Ingresa el identificador de tu negocio', prodName: 'Ingresa el nombre del producto', prodBarcode: 'Ingresa el código de barras', prodCategory: 'Selecciona una categoría', prodCost: 'Ingresa un costo válido, sin negativos y con hasta dos decimales', prodRetail: 'Ingresa un precio de menudeo válido', prodWholesale: 'Ingresa un precio de mayoreo válido', prodMargenRetail: 'Ingresa un margen válido, entre -999.9999 y 999.9999', prodMargenWholesale: 'Ingresa un margen válido, entre -999.9999 y 999.9999', prodStock: 'El stock debe ser cero o mayor, con hasta tres decimales', prodMinStock: 'Ingresa un stock mínimo válido', ajusteCantidad: 'Ingresa una cantidad mayor que cero, con hasta tres decimales', ajusteMotivo: 'Ingresa el motivo del movimiento', descuentoPct: 'El descuento debe estar entre 0 y 100, con hasta cuatro decimales' };
  function clear(form) {
    form.querySelectorAll('[aria-invalid="true"]').forEach(node => { node.removeAttribute('aria-invalid'); node.removeAttribute('aria-describedby'); });
    form.querySelectorAll('.field-error').forEach(node => node.remove());
  }
  function field(id, message, focus = true) {
    const node = document.getElementById(id); if (!node) return;
    const errorId = id + 'FieldError'; let error = document.getElementById(errorId);
    if (!error) { error = document.createElement('small'); error.id = errorId; error.className = 'field-error'; error.setAttribute('role', 'alert'); node.insertAdjacentElement('afterend', error); }
    error.textContent = message; node.setAttribute('aria-invalid', 'true'); node.setAttribute('aria-describedby', errorId);
    if (focus) node.focus();
  }
  function validate(form, connected = false) {
    clear(form); let first = null;
    for (const node of form.querySelectorAll('input, select, textarea')) {
      if (node.disabled || node.type === 'hidden') continue;
      let message = '';
      if (node.required && !node.value.trim()) message = messages[node.id] || 'Completa este campo';
      else if (node.id === 'loginBusinessId' && node.value && (!/^[1-9]\d{0,19}$/.test(node.value.trim()) || BigInt(node.value.trim()) > 18446744073709551615n)) message = 'El identificador del negocio no es válido';
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
    node.removeAttribute('aria-invalid'); node.removeAttribute('aria-describedby'); document.getElementById(node.id + 'FieldError')?.remove();
  });
  window.PosValidation = Object.freeze({ clear, field, validate });
})();
