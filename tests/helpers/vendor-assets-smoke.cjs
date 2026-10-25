'use strict';

const { expect } = require('@playwright/test');

async function verifyVendoredAssets(page, baseURL) {
  const localOrigin = new URL(baseURL).origin;
  const externalRequests = [];
  await page.route('**/*', route => {
    const requestUrl = new URL(route.request().url());
    if (['http:', 'https:'].includes(requestUrl.protocol) && requestUrl.origin !== localOrigin) {
      externalRequests.push(requestUrl.href);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });

  await page.goto('/');
  const loaded = await page.evaluate(async () => {
    await document.fonts.load('400 16px Inter');
    const databaseName = `pos-vendor-smoke-${crypto.randomUUID()}`;
    const database = new window.Dexie(databaseName);
    database.version(1).stores({ rows: '++id,value' });
    await database.rows.add({ value: 'Dexie local' });
    const dexieValue = (await database.rows.toArray())[0]?.value;
    await database.delete();

    const workbook = window.XLSX.utils.book_new();
    const sheet = window.XLSX.utils.aoa_to_sheet([['value'], ['XLSX local']]);
    window.XLSX.utils.book_append_sheet(workbook, sheet, 'Smoke');
    const serialized = window.XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
    const parsed = window.XLSX.read(serialized, { type: 'array' });
    const xlsxValue = parsed.Sheets.Smoke.A2.v;

    const printable = document.createElement('div');
    printable.textContent = 'PDF local';
    printable.style.cssText = 'position:fixed;left:0;top:0;width:240px;height:80px;background:#fff;color:#111;font:16px Arial';
    document.body.append(printable);
    const pdfBlob = await window.html2pdf().set({ html2canvas: { scale: 1 } }).from(printable).toPdf().outputPdf('blob');
    printable.remove();

    return {
      dexieValue,
      xlsxValue,
      xlsxVersion: window.XLSX.version,
      qrAvailable: typeof window.Html5Qrcode === 'function',
      pdfAvailable: typeof window.html2pdf === 'function' && pdfBlob instanceof Blob && pdfBlob.size > 0,
      interLoaded: document.fonts.check('400 16px Inter'),
      interFamily: getComputedStyle(document.body).fontFamily
    };
  });

  expect(loaded.dexieValue).toBe('Dexie local');
  expect(loaded.xlsxValue).toBe('XLSX local');
  expect(loaded.xlsxVersion).toBe('0.20.3');
  expect(loaded.qrAvailable).toBe(true);
  expect(loaded.pdfAvailable).toBe(true);
  expect(loaded.interLoaded).toBe(true);
  expect(loaded.interFamily).toMatch(/Inter/);
  expect(externalRequests).toEqual([]);
}

module.exports = { verifyVendoredAssets };
