'use strict';
(() => {
  const states = new WeakMap();
  const moneyFormat = '"C$" #,##0.00;[Red]("C$" #,##0.00)';
  const dateHeader = /fecha|apertura|cierre|vencimiento|date/i;
  const moneyHeader = /total|costo|precio|deuda|saldo|monto|efectivo|tarjeta|transferencia|cr[eé]dito|disponible|l[ií]mite|abonado|valor|diferencia|esperado|real|inicial|comprado|gasto/i;
  const sumHeader = /total|monto|deuda|saldo|pendiente|abonado/i;
  const countHeader = /^#|cantidad|stock|n[uú]mero|ventas\b|compras\b|productos\b|transacciones/i;
  const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().trim();
  const dateStamp = date => {
    const value = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(value.getTime())) return '';
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  };
  function dateKey(value) {
    const text = String(value || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const numeric = Number(value);
    const date = value !== null && value !== undefined && Number.isFinite(numeric) ? new Date(numeric) : new Date(text);
    return dateStamp(date);
  }
  const localDateValue = stamp => {
    const match = String(stamp || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
  };
  function parseDate(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const iso = localDateValue(text);
    if (iso) return iso;
    const numeric = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
    if (numeric) {
      const first = Number(numeric[1]), second = Number(numeric[2]);
      if (first > 12) return new Date(Number(numeric[3]), second - 1, first);
      if (second > 12) return new Date(Number(numeric[3]), first - 1, second);
    }
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  function isStatusRow(row) { return [...row.cells].some(cell => cell.colSpan > 1); }
  function tableFor(target) {
    if (target instanceof HTMLTableElement) return target;
    if (target instanceof HTMLElement) return target.closest('table');
    const body = document.getElementById(String(target || '').replace(/^#/, ''));
    return body?.closest('table') || document.querySelector(target);
  }
  function setupDataTable(target, options = {}) {
    const table = tableFor(target);
    if (!table) return null;
    const previous = states.get(table);
    if (previous && !options.rebuild) return previous;
    if (previous) {
      previous.observer.disconnect(); previous.tools.remove(); previous.empty.remove();
      table.tHead.querySelector('.data-table-filter-row')?.remove();
      [...table.tHead.rows[0].cells].forEach(cell => {
        const label = cell.querySelector('.data-table-sort > span:first-child');
        if (label) cell.textContent = label.textContent;
        cell.removeAttribute('aria-sort');
      });
      states.delete(table);
    }
    const body = table.tBodies[0], head = table.tHead?.rows[0];
    if (!body || !head) return null;
    const state = { table, body, options, sortColumn: null, sortDirection: 1, today: false, filters: [], queued: false };
    states.set(table, state);
    const headingCells = [...head.cells];
    state.headings = headingCells.map(cell => cell.textContent.trim());
    state.ignored = new Set(options.ignoreColumns || []);
    state.headings.forEach((heading, index) => {
      if (/acci[oó]n|foto|imagen/i.test(heading)) state.ignored.add(index);
    });

    let tools = document.createElement('div');
    tools.className = 'data-table-toolbar';
    tools.setAttribute('role', 'group');
    tools.setAttribute('aria-label', `Herramientas de ${options.label || table.getAttribute('aria-label') || 'tabla'}`);
    const container = options.toolsContainerId ? document.getElementById(options.toolsContainerId) : null;
    if (container) {
      container.classList.add('data-table-tools-host');
      container.append(tools);
    } else {
      const tableContainer = table.closest('.history-table-container, .table-container') || table;
      tableContainer.parentNode.insertBefore(tools, tableContainer);
    }
    state.tools = tools;

    let search = options.searchInputId ? document.getElementById(options.searchInputId) : null;
    if (!search && options.searchInputId) search = null;
    if (!search) {
      const searchLabel = document.createElement('label');
      searchLabel.className = 'data-table-search';
      const input = document.createElement('input');
      input.type = 'search';
      input.className = 'data-table-input';
      input.autocomplete = 'off';
      input.placeholder = 'Buscar en la tabla';
      input.setAttribute('aria-label', `Buscar en ${options.label || 'la tabla'}`);
      searchLabel.append(input);
      tools.append(searchLabel);
      search = input;
      state.generatedSearch = true;
    }
    search.classList.add('data-table-input');
    if (!search.getAttribute('aria-label')) search.setAttribute('aria-label', `Buscar en ${options.label || 'la tabla'}`);
    state.search = search;

    const actions = document.createElement('div');
    actions.className = 'data-table-actions';
    const clear = document.createElement('button');
    clear.type = 'button'; clear.className = 'btn btn-secondary data-table-clear'; clear.textContent = 'Limpiar filtros';
    clear.addEventListener('click', () => {
      state.search.value = '';
      state.filters.forEach(input => { input.value = ''; });
      state.today = false;
      state.todayButton?.setAttribute('aria-pressed', 'false');
      state.search.dispatchEvent(new Event('input', { bubbles: true }));
      refreshDataTable(table);
      state.search.focus();
    });
    actions.append(clear);
    state.clearButton = clear;

    if (Number.isInteger(options.dateColumn)) {
      const today = document.createElement('button');
      today.type = 'button'; today.className = 'btn btn-secondary data-table-today'; today.textContent = 'Hoy';
      today.setAttribute('aria-pressed', 'false');
      today.addEventListener('click', () => {
        state.today = !state.today;
        today.setAttribute('aria-pressed', String(state.today));
        refreshDataTable(table);
      });
      actions.append(today); state.todayButton = today;
    }
    if (typeof window.XLSX !== 'undefined') {
      const exportButton = document.createElement('button');
      const exportLabel = options.exportLabel || (table.closest('.rep-subview') && options.label);
      exportButton.type = 'button'; exportButton.className = 'btn btn-secondary data-table-export btn-export-excel'; exportButton.textContent = exportLabel ? `Exportar Excel de ${exportLabel}` : 'Exportar Excel';
      exportButton.addEventListener('click', () => exportTableToXlsx(table, { fileName: options.fileName || options.label || tableName(table) }));
      actions.append(exportButton); state.exportButton = exportButton;
    }
    tools.append(actions);

    state.filters = [];
    const filterRow = document.createElement('tr');
    filterRow.className = 'data-table-filter-row';
    filterRow.setAttribute('aria-label', 'Filtros por columna');
    headingCells.forEach((headingCell, index) => {
      const heading = state.headings[index], th = document.createElement('th');
      th.scope = 'col';
      if (state.ignored.has(index)) { th.setAttribute('aria-hidden', 'true'); filterRow.append(th); return; }
      const input = document.createElement('input');
      input.type = 'search'; input.className = 'data-table-column-filter'; input.autocomplete = 'off';
      input.placeholder = `Filtrar ${heading}`;
      input.setAttribute('aria-label', `Filtrar columna ${heading}`);
      input.addEventListener('input', () => refreshDataTable(table));
      state.filters[index] = input;
      th.append(input); filterRow.append(th);
    });
    table.tHead.append(filterRow);

    headingCells.forEach((th, index) => {
      const heading = state.headings[index];
      if (state.ignored.has(index)) return;
      const label = document.createElement('span'); label.textContent = heading;
      const indicator = document.createElement('span'); indicator.className = 'data-table-sort-indicator'; indicator.setAttribute('aria-hidden', 'true');
      const button = document.createElement('button'); button.type = 'button'; button.className = 'data-table-sort';
      button.append(label, indicator); th.replaceChildren(button);
      button.addEventListener('click', () => {
        if (state.sortColumn === index) state.sortDirection *= -1;
        else { state.sortColumn = index; state.sortDirection = 1; }
        headingCells.forEach(cell => {
          cell.removeAttribute('aria-sort');
          const icon = cell.querySelector('.data-table-sort-indicator'); if (icon) icon.textContent = '';
        });
        th.setAttribute('aria-sort', state.sortDirection > 0 ? 'ascending' : 'descending');
        indicator.textContent = state.sortDirection > 0 ? ' ↑' : ' ↓';
        refreshDataTable(table);
      });
    });
    search.addEventListener('input', () => refreshDataTable(table));
    const empty = document.createElement('tr');
    empty.className = 'data-table-no-results'; empty.hidden = true;
    const emptyCell = document.createElement('td'); emptyCell.colSpan = headingCells.length; emptyCell.textContent = 'No se encontraron registros con estos filtros.';
    emptyCell.className = 'text-center'; empty.append(emptyCell); state.empty = empty;
    state.observer = new MutationObserver(() => scheduleRefresh(state));
    state.observer.observe(body, { childList: true });
    refreshDataTable(table);
    return state;
  }
  function scheduleRefresh(state) {
    if (state.queued) return;
    state.queued = true;
    queueMicrotask(() => { state.queued = false; refreshDataTable(state.table); });
  }
  function rowDate(row, state) {
    if (row.dataset.tableDate) return parseDate(row.dataset.tableDate);
    const dateCell = row.cells[state.options.dateColumn];
    return parseDate(dateCell?.dataset.sortValue || dateCell?.textContent);
  }
  function rowMatches(row, state) {
    const query = normalize(state.search.value);
    if (query) {
      const text = [...row.cells].filter((_, index) => !state.ignored.has(index)).map(cell => cell.textContent).join(' ');
      if (!normalize(text).includes(query)) return false;
    }
    for (let index = 0; index < state.headings.length; index += 1) {
      const input = state.filters[index];
      if (!input?.value) continue;
      if (!normalize(row.cells[index]?.textContent).includes(normalize(input.value))) return false;
    }
    if (state.today && dateStamp(rowDate(row, state)) !== dateStamp(new Date())) return false;
    return true;
  }
  function sortableValue(row, index, state) {
    const cell = row.cells[index];
    const raw = cell?.dataset.sortValue || cell?.textContent || '';
    const heading = state.headings[index];
    if (dateHeader.test(heading)) {
      const date = (index === state.options.dateColumn && row.dataset.tableDate ? parseDate(row.dataset.tableDate) : parseDate(raw));
      return date ? date.getTime() : Number.NEGATIVE_INFINITY;
    }
    const clean = String(raw).trim().replace(/\s/g, '');
    const number = clean.replace(/[A-Za-z$C¢₡₲₱€£¥]/g, '').replace(/,/g, '');
    if (number && /^-?\d+(?:\.\d+)?$/.test(number)) return Number(number);
    return normalize(raw);
  }
  function refreshDataTable(target) {
    const table = tableFor(target), state = table && states.get(table);
    if (!state) return;
    const allRows = [...state.body.rows].filter(row => row !== state.empty && !isStatusRow(row));
    const statusRows = [...state.body.rows].filter(row => row !== state.empty && isStatusRow(row));
    const matching = allRows.filter(row => rowMatches(row, state));
    if (state.sortColumn !== null) {
      const index = state.sortColumn, direction = state.sortDirection;
      matching.sort((left, right) => {
        const a = sortableValue(left, index, state), b = sortableValue(right, index, state);
        const result = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
        return result * direction;
      });
    }
    for (const row of allRows) row.hidden = !matching.includes(row);
    for (const row of statusRows) row.hidden = allRows.length > 0;
    state.empty.hidden = allRows.length === 0 || matching.length > 0;
    const noMatches = allRows.length > 0 && matching.length === 0;
    if (noMatches && state.empty.parentNode !== state.body) state.body.append(state.empty);
    else if (!noMatches && state.empty.parentNode === state.body) state.empty.remove();
    if (state.sortColumn !== null) {
      const visible = matching, current = [...state.body.rows].filter(row => !isStatusRow(row));
      if (visible.some((row, index) => current[index] !== row)) {
        const fragment = document.createDocumentFragment();
        for (const row of matching) fragment.append(row);
        for (const row of allRows) if (!matching.includes(row)) fragment.append(row);
        for (const row of statusRows) fragment.append(row);
        fragment.append(state.empty);
        state.body.append(fragment);
      }
    }
  }
  function tableName(table) {
    const configuredLabel = states.get(table)?.options?.exportLabel || states.get(table)?.options?.label;
    if (configuredLabel) return configuredLabel;
    const container = table.closest('.history-table-container, .table-container');
    let preceding = container?.previousElementSibling;
    while (preceding?.matches('.data-table-toolbar')) preceding = preceding.previousElementSibling;
    const precedingHeading = preceding?.matches('h1, h2, h3') ? preceding.textContent.trim() : '';
    return precedingHeading
      || table.closest('.rep-subview')?.querySelector('h2')?.textContent.trim()
      || table.closest('section')?.querySelector('h1, h2')?.textContent.trim()
      || 'Datos';
  }
  function fileDate() { return dateStamp(new Date()); }
  function safeSheetName(value, index) {
    const cleaned = String(value || `Hoja ${index + 1}`).split('').map(character => '\\/*?:[]'.includes(character) ? ' ' : character).join('').trim().slice(0, 31);
    return cleaned || `Hoja ${index + 1}`;
  }
  function excelColumn(index) {
    let value = index + 1, result = '';
    while (value) { value -= 1; result = String.fromCharCode(65 + (value % 26)) + result; value = Math.floor(value / 26); }
    return result;
  }
  function parseNumber(text) {
    const normalized = String(text || '').replace(/[\u00a0\s]/g, '').replace(/C\$/gi, '').replace(/,/g, '').replace(/[^\d.-]/g, '');
    if (!normalized || normalized === '-' || normalized === '.') return null;
    const value = Number(normalized);
    return Number.isFinite(value) ? value : null;
  }
  function exportSheet(table, sheetName) {
    const state = states.get(table), headings = state?.headings || [...(table.tHead?.rows[0]?.cells || [])].map(cell => cell.textContent.trim());
    const ignored = state?.ignored || new Set(headings.map((heading, index) => /acci[oó]n|foto|imagen/i.test(heading) ? index : -1).filter(index => index >= 0));
    const columns = headings.map((heading, index) => ({ heading, index })).filter(column => !ignored.has(column.index));
    const rows = [...(table.tBodies[0]?.rows || [])].filter(row => !row.hidden && !isStatusRow(row) && row !== state?.empty);
    const aoa = [columns.map(column => column.heading)];
    const currencyCells = [];
    const configuredSums = state?.options?.sumColumns;
    const sumColumns = configuredSums === false ? [] : columns.map((column, index) => ({ ...column, exportIndex: index })).filter(column => sumHeader.test(column.heading) && (!Array.isArray(configuredSums) || configuredSums.includes(column.index)));
    const totals = new Map(sumColumns.map(column => [column.exportIndex, 0]));
    rows.forEach((row, rowIndex) => {
      const values = columns.map((column, columnIndex) => {
        const text = row.cells[column.index]?.textContent.trim().replace(/\s+/g, ' ') || '';
        if (moneyHeader.test(column.heading) && /C\$|[$€£]/i.test(text)) {
          const number = parseNumber(text);
          if (number !== null) {
            currencyCells.push({ row: rowIndex + 2, column: columnIndex });
            if (totals.has(columnIndex)) totals.set(columnIndex, totals.get(columnIndex) + number);
            return number;
          }
        }
        if (totals.has(columnIndex)) {
          const number = parseNumber(text);
          if (number !== null) totals.set(columnIndex, totals.get(columnIndex) + number);
        }
        if (countHeader.test(column.heading) && /^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
        return text;
      });
      aoa.push(values);
    });
    if (rows.length && sumColumns.length) {
      const totalRow = Array(columns.length).fill('');
      const labelIndex = columns.findIndex(column => !sumHeader.test(column.heading));
      totalRow[labelIndex >= 0 ? labelIndex : 0] = 'TOTAL';
      for (const column of sumColumns) {
        totalRow[column.exportIndex] = totals.get(column.exportIndex);
        currencyCells.push({ row: aoa.length + 1, column: column.exportIndex });
      }
      aoa.push(totalRow);
    }
    const worksheet = window.XLSX.utils.aoa_to_sheet(aoa);
    worksheet['!cols'] = columns.map((column, index) => {
      const width = Math.max(column.heading.length, ...aoa.slice(1).map(row => String(row[index] ?? '').length));
      return { wch: Math.min(44, Math.max(12, width + 2)) };
    });
    if (rows.length) worksheet['!autofilter'] = { ref: `A1:${excelColumn(columns.length - 1)}${rows.length + 1}` };
    for (const cell of currencyCells) {
      const address = `${excelColumn(cell.column)}${cell.row}`;
      if (worksheet[address]) worksheet[address].z = moneyFormat;
    }
    return { worksheet, name: safeSheetName(sheetName, 0), state };
  }
  function exportTablesToXlsx(tables, options = {}) {
    if (typeof window.XLSX === 'undefined') return false;
    const resolved = tables.map(tableFor).filter(Boolean);
    if (!resolved.length) return false;
    const workbook = window.XLSX.utils.book_new();
    const sheetNames = new Set();
    resolved.forEach((table, index) => {
      const config = exportSheet(table, tableName(table));
      const baseName = safeSheetName(tableName(table), index);
      let sheetName = baseName, suffix = 2;
      while (sheetNames.has(sheetName)) {
        const marker = ` ${suffix++}`;
        sheetName = `${baseName.slice(0, 31 - marker.length)}${marker}`;
      }
      sheetNames.add(sheetName);
      window.XLSX.utils.book_append_sheet(workbook, config.worksheet, sheetName);
    });
    const baseName = String(options.fileName || tableName(resolved[0])).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'datos';
    window.XLSX.writeFile(workbook, `${baseName}_${fileDate()}.xlsx`);
    return true;
  }
  function exportTableToXlsx(target, options = {}) { return exportTablesToXlsx([target], options); }
  function setDataTableExportEnabled(target, enabled) {
    const table = tableFor(target), state = table && states.get(table);
    if (!state?.exportButton) return false;
    state.exportButton.disabled = !enabled;
    state.exportButton.hidden = !enabled;
    state.exportButton.style.display = enabled ? '' : 'none';
    return true;
  }
  function exportDataToXlsx(rows, options = {}) {
    if (typeof window.XLSX === 'undefined' || !Array.isArray(rows) || !rows.length) return false;
    const workbook = window.XLSX.utils.book_new(), worksheet = window.XLSX.utils.aoa_to_sheet(rows);
    worksheet['!cols'] = rows[0].map((header, index) => ({ wch: Math.min(44, Math.max(12, ...rows.map(row => String(row[index] ?? '').length), 0) + 2) }));
    if (rows.length > 1) worksheet['!autofilter'] = { ref: `A1:${excelColumn(rows[0].length - 1)}${rows.length}` };
    rows.slice(1).forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
      if (moneyHeader.test(String(rows[0][columnIndex])) && typeof value === 'string' && /C\$/i.test(value)) {
        const address = `${excelColumn(columnIndex)}${rowIndex + 2}`, number = parseNumber(value);
        if (number !== null && worksheet[address]) { worksheet[address].v = number; worksheet[address].t = 'n'; worksheet[address].z = moneyFormat; }
      }
    }));
    window.XLSX.utils.book_append_sheet(workbook, worksheet, safeSheetName(options.sheetName || 'Resumen', 0));
    const fileName = String(options.fileName || 'datos').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9_-]+/g, '_');
    window.XLSX.writeFile(workbook, `${fileName}_${fileDate()}.xlsx`);
    return true;
  }
  function exportWorkbookToXlsx(sheets, options = {}) {
    if (typeof window.XLSX === 'undefined' || !Array.isArray(sheets) || !sheets.some(sheet => Array.isArray(sheet?.rows) && sheet.rows.length)) return false;
    const workbook = window.XLSX.utils.book_new();
    const names = new Set();
    sheets.filter(sheet => Array.isArray(sheet?.rows) && sheet.rows.length).forEach((sheet, index) => {
      const name = safeSheetName(sheet.name, index);
      let unique = name, suffix = 2;
      while (names.has(unique)) { const marker = ` ${suffix++}`; unique = `${name.slice(0, 31 - marker.length)}${marker}`; }
      names.add(unique);
      const rows = sheet.rows, worksheet = window.XLSX.utils.aoa_to_sheet(rows);
      const columnCount = Math.max(...rows.map(row => row.length));
      worksheet['!cols'] = Array.from({ length: columnCount }, (_, index) => {
        const width = Math.max(...rows.map(row => String(row[index] ?? '').length));
        return { wch: Math.min(44, Math.max(12, width + 2)) };
      });
      if (rows.length > 1) worksheet['!autofilter'] = { ref: `A1:${excelColumn(columnCount - 1)}${rows.length}` };
      rows.slice(1).forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
        const moneyHeading = sheet.name === 'Resumen' && columnCount === 2 ? String(row[0] || '') : String(rows[0][columnIndex] || '');
        const summaryMoney = sheet.name === 'Resumen' && /ventas del per[ií]odo|promedio|ganancia|gastos|compras del per[ií]odo|inventario a costo|cr[eé]dito pendiente|cuentas por pagar|abonos recibidos|efectivo/i.test(moneyHeading);
        if ((moneyHeader.test(moneyHeading) || summaryMoney) && typeof value === 'string' && /C\$/i.test(value)) {
          const address = `${excelColumn(columnIndex)}${rowIndex + 2}`, number = parseNumber(value);
          if (number !== null && worksheet[address]) { worksheet[address].v = number; worksheet[address].t = 'n'; worksheet[address].z = moneyFormat; }
        } else if (moneyHeader.test(moneyHeading) && typeof value === 'number' && worksheet[`${excelColumn(columnIndex)}${rowIndex + 2}`]) {
          worksheet[`${excelColumn(columnIndex)}${rowIndex + 2}`].z = moneyFormat;
        }
      }));
      window.XLSX.utils.book_append_sheet(workbook, worksheet, unique);
    });
    const fileName = String(options.fileName || 'dashboard').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'dashboard';
    window.XLSX.writeFile(workbook, `${fileName}_${fileDate()}.xlsx`);
    return true;
  }
  const tableConfigs = [
    ['repVentasHistorialBody', { label: 'Historial de ventas', fileName: 'ventas_conectadas', dateColumn: 0, sumColumns: false }],
    ['repCxCPagosBody', { label: 'Abonos a cuentas por cobrar', fileName: 'abonos_cuentas_por_cobrar', dateColumn: 0 }],
    ['repCajaMetodosBody', { label: 'Ventas de caja por medio de pago', fileName: 'caja_ventas_por_metodo' }],
    ['repCajaMovimientosBody', { label: 'Movimientos de caja', fileName: 'reporte_movimientos_caja', dateColumn: 0, sumColumns: false }],
    ['inventoryTableBody', { label: 'Inventario', fileName: 'inventario', searchInputId: 'inventorySearchInput', ignoreColumns: [0, 7] }],
    ['purchasesTableBody', { label: 'Compras locales', fileName: 'compras', dateColumn: 0, ignoreColumns: [6] }],
    ['payablesTableBody', { label: 'Cuentas por pagar locales', fileName: 'cuentas_por_pagar', ignoreColumns: [4] }],
    ['clientsTableBody', { label: 'Clientes', fileName: 'clientes', searchInputId: 'clientSearchInput', toolsContainerId: 'connectedClientsControls', ignoreColumns: [6] }],
    ['receivablesTableBody', { label: 'Cuentas por cobrar', fileName: 'cuentas_por_cobrar', dateColumn: 2, ignoreColumns: [8] }],
    ['suppliersTableBody', { label: 'Proveedores', fileName: 'proveedores', ignoreColumns: [5] }],
    ['historyTableBody', { label: 'Historial de ventas', fileName: 'historial_ventas', dateColumn: 1, ignoreColumns: [6] }],
    ['auditTableBody', { label: 'Auditoría', fileName: 'auditoria', dateColumn: 0 }],
    ['cajaVentasUsuarioBody', { label: 'Ventas por usuario', fileName: 'ventas_por_usuario' }],
    ['cajaOperacionesBody', { label: 'Operaciones de caja', fileName: 'operaciones_de_caja', dateColumn: 0, ignoreColumns: [6] }],
    ['cajaPendientesHistoricosBody', { label: 'Pendientes históricos', fileName: 'pendientes_historicos', dateColumn: 0, ignoreColumns: [6] }],
    ['cajaMovimientosBody', { label: 'Movimientos de caja', fileName: 'movimientos_de_caja', dateColumn: 0, ignoreColumns: [6] }],
    ['cajaHistorialBody', { label: 'Cierres de caja', fileName: 'cierres_de_caja', dateColumn: 1, ignoreColumns: [7] }],
    ['gastosTableBody', { label: 'Gastos', fileName: 'gastos', dateColumn: 0, ignoreColumns: [6] }],
    ['repVentasMetodoBody', { label: 'Ventas por método', fileName: 'ventas_por_metodo' }],
    ['repTopProductosBody', { label: 'Productos más vendidos', fileName: 'productos_mas_vendidos' }],
    ['repVendedoresBody', { label: 'Ventas por vendedor', fileName: 'ventas_por_vendedor' }],
    ['repComprasBody', { label: 'Compras del período', fileName: 'reporte_compras', dateColumn: 0 }],
    ['repInventarioBody', { label: 'Estado de inventario', fileName: 'reporte_inventario', sumColumns: [3] }],
    ['repCajaBody', { label: 'Cierres de caja por período', fileName: 'reporte_caja', dateColumn: 1 }],
    ['repGastosCategoriaBody', { label: 'Gastos por categoría', fileName: 'reporte_gastos' }],
    ['repCxCBody', { label: 'Cuentas por cobrar', fileName: 'reporte_cuentas_por_cobrar' }],
    ['repCxPBody', { label: 'Cuentas por pagar', fileName: 'reporte_cuentas_por_pagar' }]
  ];
  function setupAll() {
    const connected = new URLSearchParams(location.search).get('mode') === 'connected';
    for (const [bodyId, options] of tableConfigs) {
      const body = document.getElementById(bodyId);
      if (!body) continue;
      if (!connected && body.closest('.connected-report-only, .connected-dashboard-only')) continue;
      if (connected && body.closest('.local-dashboard-only')) continue;
      if (bodyId === 'clientsTableBody') document.getElementById('connectedClientsControls')?.classList.remove('hidden');
      setupDataTable(body, options);
    }
  }
  window.PosTables = Object.freeze({ setupDataTable, refreshDataTable, exportTableToXlsx, exportTablesToXlsx, exportDataToXlsx, exportWorkbookToXlsx, setDataTableExportEnabled, dateKey });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupAll, { once: true });
  else setupAll();
})();
