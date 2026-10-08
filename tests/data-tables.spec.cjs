const fs = require('node:fs/promises');
const { test, expect } = require('@playwright/test');

async function prepareTable(page, { withXlsx = false } = {}) {
  await page.route('https://**/*', route => route.abort());
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => typeof window.PosTables?.setupDataTable)).toBe('function');
  await page.evaluate(({ withXlsx }) => {
    if (withXlsx) {
      const columnName = index => { let value = index + 1, result = ''; while (value) { value -= 1; result = String.fromCharCode(65 + (value % 26)) + result; value = Math.floor(value / 26); } return result; };
      window.XLSX = {
        utils: {
          aoa_to_sheet(rows) { const sheet = { '!data': rows }; rows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => { sheet[`${columnName(columnIndex)}${rowIndex + 1}`] = { v: value, t: typeof value === 'number' ? 'n' : 's' }; })); return sheet; },
          book_new() { return { SheetNames: [], Sheets: {} }; },
          book_append_sheet(book, sheet, name) { book.SheetNames.push(name); book.Sheets[name] = sheet; }
        },
        writeFile(book, filename) {
          window.__tableExportCapture = { book, filename };
          const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify(book)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
          link.download = filename; document.body.append(link); link.click(); link.remove();
        }
      };
    }
    const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const today = new Date(), yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
    const host = document.createElement('section'); host.id = 'table-fixture';
    host.innerHTML = '<div class="history-table-container"><table id="fixture-table" class="history-table"><thead><tr><th>Producto</th><th>Categoría</th><th>Cantidad</th><th>Fecha</th><th>Monto</th><th>Acciones</th></tr></thead><tbody id="fixture-body"><tr data-table-date="' + dateKey(today) + '"><td>Alfa</td><td>Manzana</td><td>10</td><td>' + dateKey(today) + '</td><td>C$15.50</td><td><button>Editar</button></td></tr><tr data-table-date="' + dateKey(yesterday) + '"><td>Beta</td><td>Pera</td><td>2</td><td>' + dateKey(yesterday) + '</td><td>C$4.25</td><td><button>Editar</button></td></tr><tr data-table-date="' + dateKey(today) + '"><td>Gamma</td><td>Manzana</td><td>30</td><td>' + dateKey(today) + '</td><td>C$125.00</td><td><button>Editar</button></td></tr></tbody></table></div>';
    document.body.append(host);
    window.PosTables.setupDataTable(document.getElementById('fixture-body'), { label: 'Pruebas', fileName: 'Tabla_prueba', dateColumn: 3, ignoreColumns: [5] });
  }, { withXlsx });
}

async function visibleValues(page, column) {
  return page.locator('#fixture-body tr:visible:not(.data-table-no-results)').evaluateAll((rows, index) => rows.map(row => row.cells[index].textContent.trim()), column);
}

test('filtra por columna, combina con búsqueda general y limpia filtros', async ({ page }) => {
  await prepareTable(page);
  const category = page.locator('#fixture-table .data-table-column-filter').nth(1);
  await category.fill('manzana');
  await expect(page.locator('#fixture-body tr:visible:not(.data-table-no-results)')).toHaveCount(2);
  await page.locator('#table-fixture .data-table-input').fill('alfa');
  await expect(page.locator('#fixture-body tr:visible:not(.data-table-no-results)')).toHaveCount(1);
  await expect(page.locator('#fixture-body tr:visible')).toContainText('Alfa');
  await page.locator('#table-fixture .data-table-clear').click();
  await expect(category).toHaveValue('');
  await expect(page.locator('#table-fixture .data-table-input')).toHaveValue('');
  await expect(page.locator('#fixture-body tr:visible:not(.data-table-no-results)')).toHaveCount(3);
});

test('ordena texto, números y fechas; alterna ascendente y descendente', async ({ page }) => {
  await prepareTable(page);
  const headers = page.locator('#fixture-table thead tr:first-child th');
  await headers.nth(0).locator('button').click();
  expect(await visibleValues(page, 0)).toEqual(['Alfa', 'Beta', 'Gamma']);
  await headers.nth(0).locator('button').click();
  expect(await visibleValues(page, 0)).toEqual(['Gamma', 'Beta', 'Alfa']);
  await headers.nth(2).locator('button').click();
  expect(await visibleValues(page, 2)).toEqual(['2', '10', '30']);
  await headers.nth(3).locator('button').click();
  const ascendingDates = await visibleValues(page, 3);
  expect(Date.parse(ascendingDates[0])).toBeLessThan(Date.parse(ascendingDates[1]));
  await headers.nth(3).locator('button').click();
  const descendingDates = await visibleValues(page, 3);
  expect(Date.parse(descendingDates[0])).toBeGreaterThan(Date.parse(descendingDates[descendingDates.length - 1]));
  await expect(headers.nth(3)).toHaveAttribute('aria-sort', 'descending');
});

test('Hoy conserva solo las filas de hoy y se combina con filtros', async ({ page }) => {
  await prepareTable(page);
  await page.locator('#table-fixture .data-table-today').click();
  await expect(page.locator('#fixture-body tr:visible:not(.data-table-no-results)')).toHaveCount(2);
  expect(await visibleValues(page, 0)).toEqual(['Alfa', 'Gamma']);
  await page.locator('#fixture-table .data-table-column-filter').nth(1).evaluate(input => { input.value = 'pera'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(page.locator('#fixture-body tr:visible:not(.data-table-no-results)')).toHaveCount(0);
  await expect(page.locator('#fixture-body .data-table-no-results')).toContainText('No se encontraron');
});

test('reinicializa tablas de encabezado dinámico sin duplicar filtros', async ({ page }) => {
  await prepareTable(page);
  await page.evaluate(() => {
    const table = document.getElementById('fixture-table'), body = document.getElementById('fixture-body');
    table.tHead.innerHTML = '<tr><th>Fecha</th><th>Movimiento</th><th>Cantidad</th></tr>';
    body.innerHTML = '<tr data-table-date="' + window.PosTables.dateKey(new Date()) + '"><td>' + window.PosTables.dateKey(new Date()) + '</td><td>Ajuste</td><td>2</td></tr>';
    window.PosTables.setupDataTable(body, { label: 'Kardex', fileName: 'kardex', dateColumn: 0, rebuild: true });
  });
  await expect(page.locator('#table-fixture .data-table-toolbar')).toHaveCount(1);
  await expect(page.locator('#fixture-table .data-table-column-filter')).toHaveCount(3);
  await expect(page.locator('#fixture-table thead tr:first-child th').first()).not.toHaveAttribute('aria-sort');
  await page.locator('#table-fixture .data-table-today').click();
  await expect(page.locator('#fixture-body tr:visible:not(.data-table-no-results)')).toHaveCount(1);
});

test('prepara la exportación XLSX con encabezados, autofiltro, anchos y moneda numérica', async ({ page }) => {
  await prepareTable(page, { withXlsx: true });
  await page.locator('#table-fixture .data-table-today').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#table-fixture .data-table-export').click()]);
  expect(download.suggestedFilename()).toMatch(/^tabla_prueba_\d{4}-\d{2}-\d{2}\.xlsx$/);
  const exportedFile = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
  expect(exportedFile.SheetNames).toHaveLength(1);
  const sheet = Object.values(exportedFile.Sheets)[0];
  expect(sheet['!data'][0]).toEqual(['Producto', 'Categoría', 'Cantidad', 'Fecha', 'Monto']);
  expect(sheet['!data'].map(row => row[0])).toEqual(['Producto', 'Alfa', 'Gamma', 'TOTAL']);
  expect(sheet['!autofilter']).toEqual({ ref: 'A1:E3' });
  expect(sheet['!cols'].length).toBe(5);
  expect(sheet.E2).toMatchObject({ v: 15.5, z: '"C$" #,##0.00;[Red]("C$" #,##0.00)' });
  expect(sheet.E4).toMatchObject({ v: 140.5, z: '"C$" #,##0.00;[Red]("C$" #,##0.00)' });
  expect(await page.evaluate(() => window.__tableExportCapture.filename)).toBe(download.suggestedFilename());
});

test('los botones muestran Exportar Excel y usan estilo verde consistente', async ({ page }) => {
  await prepareTable(page, { withXlsx: true });
  const tableButton = page.locator('#table-fixture .data-table-export');
  await expect(tableButton).toHaveText('Exportar Excel');
  await expect(tableButton).toHaveClass(/btn-export-excel/);
  const tableStyle = await tableButton.evaluate(button => ({ background: getComputedStyle(button).backgroundColor, color: getComputedStyle(button).color }));
  expect(tableStyle).toEqual({ background: 'rgb(22, 101, 52)', color: 'rgb(255, 255, 255)' });

  const exportButtons = page.locator('button.report-export-button, #dashboardView button.btn-export-excel');
  await expect(exportButtons).toHaveText(['Exportar Excel de Ventas', 'Exportar Excel de Vendedores', 'Exportar Excel']);
  await expect(exportButtons).toHaveClass([/btn-export-excel/, /btn-export-excel/, /btn-export-excel/]);
  const exportStyles = await exportButtons.evaluateAll(buttons => buttons.map(button => ({ background: getComputedStyle(button).backgroundColor, color: getComputedStyle(button).color })));
  expect(exportStyles).toEqual(Array(3).fill({ background: 'rgb(22, 101, 52)', color: 'rgb(255, 255, 255)' }));
  const labels = await page.locator('button.data-table-export, button.report-export-button, #dashboardView button.btn-export-excel').allTextContents();
  expect(labels.every(label => !label.toLowerCase().includes('xlsx'))).toBe(true);
});

test('los controles caben en móvil y la tabla mantiene desplazamiento horizontal', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareTable(page);
  const layout = await page.evaluate(() => {
    const host = document.querySelector('#table-fixture'), toolbar = host.querySelector('.data-table-toolbar');
    const box = toolbar.getBoundingClientRect();
    return { left: box.left, right: box.right, viewport: document.documentElement.clientWidth, buttons: [...toolbar.querySelectorAll('button')].every(button => { const rect = button.getBoundingClientRect(); return rect.left >= 0 && rect.right <= document.documentElement.clientWidth; }), tableWidth: host.querySelector('table').scrollWidth, containerWidth: host.querySelector('.history-table-container').clientWidth };
  });
  expect(layout.left).toBeGreaterThanOrEqual(0);
  expect(layout.right).toBeLessThanOrEqual(layout.viewport);
  expect(layout.buttons).toBe(true);
  expect(layout.tableWidth).toBeGreaterThan(layout.containerWidth);
});
