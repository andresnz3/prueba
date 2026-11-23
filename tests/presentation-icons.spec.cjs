const { test, expect } = require('@playwright/test');

const pngIcons = [
  ['/assets/pwa/favicon-16.png', 16],
  ['/assets/pwa/favicon-32.png', 32],
  ['/assets/pwa/favicon-48.png', 48],
  ['/assets/pwa/pos-icon-192.png', 192],
  ['/assets/pwa/pos-icon-512.png', 512]
];

async function verifyPageIcons(page, path) {
  await page.goto(path);
  await expect(page).toHaveTitle('SoftVentaWeb');
  await expect(page.locator('link[rel="shortcut icon"]')).toHaveAttribute('href', '/assets/pwa/favicon-32.png');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/assets/pwa/pos-icon-192.png');
  for (const [url, size] of pngIcons) {
    const response = await page.request.get(new URL(url, page.url()).href);
    expect(response.ok(), `${url} should respond successfully`).toBeTruthy();
    expect(response.headers()['content-type']).toContain('image/png');
    const dimensions = await page.evaluate(async iconUrl => {
      const bitmap = await createImageBitmap(await (await fetch(iconUrl)).blob());
      const result = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return result;
    }, url);
    expect(dimensions).toEqual({ width: size, height: size });
  }
  const svg = await page.request.get(new URL('/assets/pwa/pos-icon.svg', page.url()).href);
  expect(svg.ok()).toBeTruthy();
  expect(svg.headers()['content-type']).toContain('image/svg+xml');
}

test('favicon, shortcut, apple-touch, manifest y títulos del POS y la página comercial', async ({ page }) => {
  await verifyPageIcons(page, '/');

  const manifestResponse = await page.request.get(new URL('/manifest.webmanifest', page.url()).href);
  expect(manifestResponse.ok()).toBeTruthy();
  expect(manifestResponse.headers()['content-type']).toContain('application/manifest+json');
  const manifest = await manifestResponse.json();
  expect(manifest.name).toBe('SoftVentaWeb');
  expect(manifest.short_name).toBe('SoftVenta');
  for (const size of ['192x192', '512x512']) {
    expect(manifest.icons).toContainEqual(expect.objectContaining({
      src: `/assets/pwa/pos-icon-${size.split('x')[0]}.png`,
      sizes: size,
      type: 'image/png'
    }));
  }

  await verifyPageIcons(page, '/inicio/');
});
