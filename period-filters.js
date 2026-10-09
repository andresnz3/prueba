'use strict';
(() => {
  const roots = new Map();
  const pad = value => String(value).padStart(2, '0');
  const stamp = value => `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  function parseDay(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3]) ? date : null;
  }
  function dateKey(value) {
    if (value === null || value === undefined || value === '') return '';
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const sqlDate = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?Z$/.exec(text);
    if (sqlDate) return sqlDate[1];
    const localDate = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(text.trim());
    if (localDate) {
      const day = Number(localDate[1]), month = Number(localDate[2]), year = Number(localDate[3]);
      const parsed = new Date(year, month - 1, day);
      if (parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day) return `${year}-${pad(month)}-${pad(day)}`;
    }
    if (window.PosTables?.dateKey) return window.PosTables.dateKey(value);
    const numeric = Number(value);
    const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(value);
    return Number.isNaN(date.getTime()) ? '' : stamp(date);
  }
  function format(day) {
    const date = parseDay(day);
    return date ? new Intl.DateTimeFormat('es-NI', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date) : 'sin límite';
  }
  function getRange(root) {
    const from = root.querySelector('[data-period-from]')?.value || '';
    const until = root.querySelector('[data-period-until]')?.value || '';
    if ((from && !parseDay(from)) || (until && !parseDay(until))) return { error: 'Ingresa fechas válidas.' };
    if (from && until && from > until) return { error: 'La fecha Desde no puede ser posterior a Hasta.' };
    return { from, until, preset: root.dataset.selectedPreset || 'custom' };
  }
  function matches(value, range) {
    if (range?.error) return false;
    if (!range?.from && !range?.until) return true;
    const key = dateKey(value);
    return Boolean(key) && (!range.from || key >= range.from) && (!range.until || key <= range.until);
  }
  function publish(root) {
    const range = getRange(root), message = root.querySelector('[data-period-message]');
    if (message) {
      message.textContent = range.error || '';
      message.classList.toggle('hidden', !range.error);
      message.classList.toggle('error', Boolean(range.error));
    }
    if (range.error) return;
    const label = root.querySelector('[data-period-label]');
    if (label) label.textContent = !range.from && !range.until ? 'Período: todo el historial' : `Período: ${format(range.from)} al ${format(range.until)}`;
    root.querySelectorAll('[data-period-preset]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.periodPreset === range.preset)));
    document.dispatchEvent(new CustomEvent('pos:period-changed', { detail: { id: root.dataset.periodFilter, range } }));
  }
  function choosePreset(root, name) {
    const fromInput = root.querySelector('[data-period-from]'), untilInput = root.querySelector('[data-period-until]');
    if (!fromInput || !untilInput) return;
    const today = new Date(), start = new Date(today.getFullYear(), today.getMonth(), today.getDate()), end = new Date(start);
    if (name === 'week') start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    else if (name === 'month') start.setDate(1);
    else if (name === 'all') { fromInput.value = ''; untilInput.value = ''; root.dataset.selectedPreset = 'all'; publish(root); return; }
    else if (name !== 'today') return;
    fromInput.value = stamp(start); untilInput.value = stamp(end); root.dataset.selectedPreset = name; publish(root);
  }
  function enableCalendarIcon(input) {
    input.addEventListener('click', event => {
      const bounds = input.getBoundingClientRect();
      if (event.clientX < bounds.right - 48 || event.clientX > bounds.right) return;
      if (typeof input.showPicker !== 'function') return;
      event.preventDefault();
      try { input.showPicker(); } catch { input.focus(); }
    });
  }
  function initialize() {
    document.querySelectorAll('input[type="date"]').forEach(enableCalendarIcon);
    document.querySelectorAll('[data-period-filter]').forEach(root => {
      const id = root.dataset.periodFilter;
      if (!id || roots.has(id)) return;
      roots.set(id, root);
      root.dataset.selectedPreset = root.dataset.periodDefault || 'month';
      root.querySelectorAll('[data-period-preset]').forEach(button => button.addEventListener('click', () => choosePreset(root, button.dataset.periodPreset)));
      for (const input of root.querySelectorAll('[data-period-from], [data-period-until]')) input.addEventListener('change', () => { root.dataset.selectedPreset = 'custom'; publish(root); });
      choosePreset(root, root.dataset.selectedPreset);
    });
  }
  function filterTable(bodyId, range) {
    const body = document.getElementById(bodyId);
    if (!body || range?.error) return;
    const rows = [...body.rows].filter(row => !row.classList.contains('period-filter-empty') && ![...row.cells].some(cell => cell.colSpan > 1));
    let visible = 0;
    for (const row of rows) {
      const key = row.dataset.periodDate || row.dataset.tableDate || row.cells[0]?.dataset.sortValue || row.cells[0]?.textContent;
      row.hidden = !matches(key, range);
      if (!row.hidden) visible += 1;
    }
    let empty = body.querySelector('.period-filter-empty');
    if (rows.length && !visible) {
      if (!empty) {
        empty = document.createElement('tr'); empty.className = 'period-filter-empty';
        const cell = document.createElement('td'); cell.colSpan = rows[0].cells.length; cell.className = 'text-center'; cell.textContent = 'No hay registros en este período.'; empty.append(cell);
      }
      body.append(empty); empty.hidden = false;
    } else if (empty) empty.hidden = true;
  }
  initialize();
  window.PosPeriodFilters = Object.freeze({ range(id) { const root = roots.get(id); return root ? getRange(root) : { from: '', until: '', preset: 'all' }; }, matches, dateKey, filterTable, refresh(id) { const root = roots.get(id); if (root) publish(root); } });
})();
