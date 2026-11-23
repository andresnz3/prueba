const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function verifyLoginLayout(page, viewport, maxLogoWidth, maxLogoHeight, screenshotName) {
  await page.setViewportSize(viewport);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const layout = await page.evaluate(() => {
    const card = document.querySelector('.login-card').getBoundingClientRect();
    const logo = document.querySelector('#loginScreen h1 img').getBoundingClientRect();
    const subtitle = document.querySelector('#loginScreen .login-subtitle').getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom, width: card.width, height: card.height },
      logo: { left: logo.left, right: logo.right, top: logo.top, bottom: logo.bottom, width: logo.width, height: logo.height },
      gapToSubtitle: subtitle.top - logo.bottom
    };
  });
  expect(layout.logo.width).toBeGreaterThan(0);
  expect(layout.logo.width).toBeLessThanOrEqual(maxLogoWidth);
  expect(layout.logo.height).toBeLessThanOrEqual(maxLogoHeight);
  expect(layout.logo.left).toBeGreaterThanOrEqual(layout.card.left);
  expect(layout.logo.right).toBeLessThanOrEqual(layout.card.right);
  expect(layout.logo.top).toBeGreaterThanOrEqual(layout.card.top);
  expect(layout.logo.bottom).toBeLessThanOrEqual(layout.card.bottom);
  expect(layout.card.left).toBeGreaterThanOrEqual(0);
  expect(layout.card.right).toBeLessThanOrEqual(layout.viewport.width);
  expect(layout.card.top).toBeGreaterThanOrEqual(0);
  expect(layout.card.bottom).toBeLessThanOrEqual(layout.viewport.height);
  expect(Math.abs((layout.logo.left + layout.logo.right) / 2 - (layout.card.left + layout.card.right) / 2)).toBeLessThanOrEqual(1);
  expect(layout.gapToSubtitle).toBeGreaterThanOrEqual(0);
  expect(layout.gapToSubtitle).toBeLessThanOrEqual(20);
  expect(layout.document.width).toBeLessThanOrEqual(layout.viewport.width);
  await page.screenshot({ path: path.join(os.tmpdir(), screenshotName), fullPage: true });
  return layout;
}

test('identidad SoftVentaWeb, favicon y login adaptable conservan ambos modos', async ({ page }) => {
  const jsErrors = [];
  const consoleErrors = [];
  const failedResponses = [];
  const externalRequests = [];
  const origin = new URL(test.info().project.use.baseURL).origin;
  page.on('pageerror', error => jsErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', response => {
    if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status() });
  });
  await page.route('**/api/**', route => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ message: 'Sesión no iniciada' })
  }));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.protocol.startsWith('http') && url.origin !== origin) externalRequests.push(url.href);
  });
  await page.addInitScript(() => localStorage.setItem('posSystemConfig', JSON.stringify({ name: 'Comercio Ficticio', currency: 'C$' })));

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await expect(page).toHaveTitle('SoftVentaWeb');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', 'Controlá tus ventas, inventario y caja desde cualquier lugar');
  await expect(page.locator('meta[property="og:site_name"]')).toHaveAttribute('content', 'SoftVentaWeb');
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', 'https://softventaweb.com/');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://softventaweb.com/');
  await expect(page.locator('#loginScreen h1 img')).toHaveAttribute('alt', 'SoftVentaWeb');
  await expect(page.locator('#loginScreen')).not.toContainText('POS Distribuidora');
  await expect(page.locator('#loginScreen .login-subtitle').first()).toHaveText('Inicia sesión para continuar');
  await expect(page.locator('#authMode option[value="local"]')).toBeAttached();
  await expect(page.locator('#authMode option[value="connected"]')).toBeAttached();
  await expect(page.locator('#localLicenseGate')).toBeAttached();
  await expect(page.locator('#localOwnerSetupForm')).toBeAttached();
  await expect(page.locator('#loginForm')).toBeVisible();
  await expect(page.locator('#brandNameDisplay')).toHaveText('Comercio Ficticio');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('posSystemConfig')).name)).toBe('Comercio Ficticio');
  const shellResponse = await page.request.get(new URL('/index.html', origin).href);
  const shell = await shellResponse.text();
  expect(shell).toContain('<h2 id="brandNameDisplay">SoftVentaWeb</h2>');
  expect(shell).toContain('<dd id="migrationLocalBusinessName">SoftVentaWeb</dd>');
  expect(shell).not.toMatch(/POS DISTRIBUIDORA|POS Distribuidora/);

  const logo = page.locator('#loginScreen h1 img');
  const logoState = await logo.evaluate(image => ({
    complete: image.complete,
    width: image.naturalWidth,
    height: image.naturalHeight,
    renderedWidth: image.getBoundingClientRect().width
  }));
  expect(logoState).toEqual(expect.objectContaining({ complete: true, width: 1440, height: 366 }));
  await verifyLoginLayout(page, { width: 1440, height: 900 }, 260, 66, 'softventa-login-1440x900.png');
  await verifyLoginLayout(page, { width: 1280, height: 720 }, 260, 66, 'softventa-login-1280x720.png');

  const iconLinks = await page.locator('link[rel="icon"]').evaluateAll(links => links.map(link => ({
    href: link.getAttribute('href'), sizes: link.getAttribute('sizes'), type: link.getAttribute('type')
  })));
  for (const size of [16, 32, 48]) {
    const icon = iconLinks.find(link => link.sizes === `${size}x${size}`);
    expect(icon).toBeTruthy();
    const dimensions = await page.evaluate(async url => {
      const image = await createImageBitmap(await (await fetch(url)).blob());
      const result = { width: image.width, height: image.height };
      image.close();
      return result;
    }, icon.href);
    expect(dimensions).toEqual({ width: size, height: size });
  }
  const svgIconResponse = await page.request.get(new URL('/assets/pwa/pos-icon.svg', origin).href);
  expect(svgIconResponse.ok()).toBeTruthy();
  expect(svgIconResponse.headers()['content-type']).toContain('image/svg+xml');
  const svgIcon = await svgIconResponse.text();
  expect(svgIcon).toContain('viewBox="0 0 512 512"');
  expect(svgIcon).not.toMatch(/<script|(?:href|src)="https?:/i);
  const svgDimensions = await page.evaluate(url => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error('El favicon SVG no se pudo decodificar'));
    image.src = url;
  }), '/assets/pwa/pos-icon.svg');
  expect(svgDimensions).toEqual({ width: 512, height: 512 });

  const manifestResponse = await page.request.get(new URL('/manifest.webmanifest', origin).href);
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = await manifestResponse.json();
  expect(manifest.name).toBe('SoftVentaWeb');
  expect(manifest.short_name).toBe('SoftVenta');
  expect(manifest.description).toBe('Controlá tus ventas, inventario y caja desde cualquier lugar');
  const robotsResponse = await page.request.get(new URL('/robots.txt', origin).href);
  expect(robotsResponse.ok()).toBeTruthy();
  const robots = await robotsResponse.text();
  expect(robots).toContain('Disallow: /api/');
  expect(robots).toContain('Sitemap: https://softventaweb.com/sitemap.xml');
  const sitemapResponse = await page.request.get(new URL('/sitemap.xml', origin).href);
  expect(sitemapResponse.ok()).toBeTruthy();
  const sitemap = await sitemapResponse.text();
  expect(sitemap).toContain('<loc>https://softventaweb.com/inicio/</loc>');
  expect(sitemap).not.toMatch(/\/api\/|system-admin|businesses|users/i);
  const publicShellResponse = await page.request.get(new URL('/index.html', origin).href);
  const publicShell = await publicShellResponse.text();
  expect(publicShell).not.toMatch(/googletagmanager\.com|google-analytics\.com|\bgtag\s*\(|G-[A-Z0-9]{10}(?![A-Z0-9])/i);
  for (const size of ['192x192', '512x512']) {
    const icon = manifest.icons.find(item => item.sizes === size && item.type === 'image/png');
    expect(icon).toBeTruthy();
    const dimensions = await page.evaluate(async url => {
      const image = await createImageBitmap(await (await fetch(url)).blob());
      const result = { width: image.width, height: image.height };
      image.close();
      return result;
    }, icon.src);
    const expectedSize = Number(size.split('x')[0]);
    expect(dimensions).toEqual({ width: expectedSize, height: expectedSize });
  }
  const workerResponse = await page.request.get(new URL('/service-worker.js', origin).href);
  expect(workerResponse.ok()).toBeTruthy();
  expect(await workerResponse.text()).toContain('/assets/pwa/softventaweb-logo.webp');
  const offlineResponse = await page.request.get(new URL('/offline.html', origin).href);
  expect(offlineResponse.ok()).toBeTruthy();
  expect(await offlineResponse.text()).toContain('SoftVentaWeb | Sin conexi&oacute;n');

  await page.locator('#authMode').selectOption('connected');
  await expect(page.locator('#loginForm')).toBeVisible();
  await page.locator('#authMode').selectOption('local');
  await expect(page.locator('#loginForm')).toBeVisible();

  await verifyLoginLayout(page, { width: 375, height: 812 }, 220, 56, 'softventa-login-375x812.png');

  expect(externalRequests).toEqual([]);
  expect(jsErrors).toEqual([]);
  expect(failedResponses).toEqual([{ path: '/api/auth/me', status: 401 }]);
  expect(consoleErrors.filter(error => !/Failed to load resource: the server responded with a status of 401/.test(error))).toEqual([]);
});

test('el tamaño de reserva mantiene el logo dentro de la tarjeta con CSS antiguo', async ({ page }) => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  const withoutLogoRule = css.replace(/\.login-logo img\s*\{[^}]*\}/, '');
  expect(withoutLogoRule).not.toBe(css);
  await page.route('**/styles.css*', route => route.fulfill({
    status: 200,
    contentType: 'text/css',
    body: withoutLogoRule
  }));
  await page.route('**/api/**', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{"message":"No se inició sesión"}' }));
  await page.goto('/');
  for (const viewport of [
    { size: { width: 1440, height: 900 }, maxWidth: 220 },
    { size: { width: 375, height: 812 }, maxWidth: 220 }
  ]) {
    await page.setViewportSize(viewport.size);
    const result = await page.evaluate(() => {
      const card = document.querySelector('.login-card').getBoundingClientRect();
      const logo = document.querySelector('#loginScreen h1 img').getBoundingClientRect();
      return { cardLeft: card.left, cardRight: card.right, logoLeft: logo.left, logoRight: logo.right,
        logoWidth: logo.width, logoHeight: logo.height, pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
        cardCenter: (card.left + card.right) / 2, logoCenter: (logo.left + logo.right) / 2 };
    });
    expect(result.logoWidth).toBeLessThanOrEqual(viewport.maxWidth);
    expect(result.logoHeight).toBeLessThanOrEqual(56);
    expect(result.logoLeft).toBeGreaterThanOrEqual(result.cardLeft);
    expect(result.logoRight).toBeLessThanOrEqual(result.cardRight);
    expect(Math.abs(result.logoCenter - result.cardCenter)).toBeLessThanOrEqual(1);
    expect(result.pageWidth).toBeLessThanOrEqual(result.viewportWidth);
  }
});
