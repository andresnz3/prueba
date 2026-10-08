'use strict';
(() => {
  const el = id => document.getElementById(id);
  const fromInput = el('dashboardFromInput'), untilInput = el('dashboardUntilInput');
  if (!fromInput || !untilInput) return;
  const stamp = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  function validDay(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3]) ? date : null;
  }
  function range() {
    const from = fromInput.value || '', until = untilInput.value || '';
    if ((from && !validDay(from)) || (until && !validDay(until))) return { error: 'Ingresa fechas válidas.' };
    if (from && until && from > until) return { error: 'La fecha Desde no puede ser posterior a Hasta.' };
    return { from, until, preset: selectedPreset };
  }
  function label(value) {
    if (!value.from && !value.until) return 'Período: todos los registros';
    const show = day => {
      const date = validDay(day);
      return date ? new Intl.DateTimeFormat('es-NI', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date) : 'sin límite';
    };
    return `Período: ${show(value.from)}${value.until ? ` al ${show(value.until)}` : ''}`;
  }
  let selectedPreset = 'month';
  function publish() {
    const selected = range(), status = el('dashboardStatus');
    if (selected.error) { if (status) { status.textContent = selected.error; status.classList.remove('hidden'); } return false; }
    if (status) { status.textContent = ''; status.classList.add('hidden'); }
    const labelNode = el('dashboardPeriodLabel');
    if (labelNode) labelNode.textContent = label(selected);
    document.querySelectorAll('[data-dashboard-preset]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.dashboardPreset === selectedPreset));
    });
    document.dispatchEvent(new CustomEvent('dashboard:period-changed', { detail: selected }));
    return true;
  }
  function preset(name) {
    const today = new Date(), from = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    let until = new Date(from);
    if (name === 'week') from.setDate(from.getDate() - ((from.getDay() + 6) % 7));
    else if (name === 'month') from.setDate(1);
    else if (name === 'all') { fromInput.value = ''; untilInput.value = ''; selectedPreset = 'all'; publish(); return; }
    else if (name !== 'today') return;
    selectedPreset = name;
    fromInput.value = stamp(from); untilInput.value = stamp(until);
    publish();
  }
  document.querySelectorAll('[data-dashboard-preset]').forEach(button => button.addEventListener('click', () => preset(button.dataset.dashboardPreset)));
  el('dashboardApplyBtn')?.addEventListener('click', () => { selectedPreset = 'custom'; publish(); });
  for (const input of [fromInput, untilInput]) input.addEventListener('input', () => { selectedPreset = 'custom'; document.querySelectorAll('[data-dashboard-preset]').forEach(button => button.setAttribute('aria-pressed', 'false')); });
  window.PosDashboardPeriod = Object.freeze({ range, preset, label, dateKey: value => validDay(value) ? stamp(validDay(value)) : '' });
  preset('month');
})();
