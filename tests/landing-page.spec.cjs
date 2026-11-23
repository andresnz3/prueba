const { test, expect } = require('@playwright/test');

test('landing pública conserva SEO, CSP, navegación y recursos locales en escritorio y móvil', async ({ page, request }) => {
  const origin = new URL(test.info().project.use.baseURL).origin;
  const externalRequests = [];
  const jsErrors = [];
  const cspViolations = [];
  page.on('request', requestEvent => {
    const url = new URL(requestEvent.url());
    if (url.origin !== origin) externalRequests.push(url.origin);
  });
  page.on('pageerror', error => jsErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && /content security policy|refused to (?:execute|load|apply)/i.test(message.text())) {
      cspViolations.push(message.text());
    }
  });
  await page.addInitScript(() => {
    window.__landingCspViolations = [];
    document.addEventListener('securitypolicyviolation', event => {
      window.__landingCspViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
    });
  });
  await page.route('**/api/**', route => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ message: 'Sesión no iniciada' })
  }));

  await page.setViewportSize({ width: 1440, height: 900 });
  const response = await page.goto('/inicio/');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/html');
  expect(response.headers()['content-security-policy']).toContain("script-src 'self'");
  await expect(page).toHaveTitle('SoftVentaWeb | Sistema POS para negocios');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', 'Controlá tus ventas, inventario y caja desde cualquier lugar');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index, follow');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://softventaweb.com/inicio/');
  await expect(page.locator('meta[property="og:site_name"]')).toHaveAttribute('content', 'SoftVentaWeb');
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', 'SoftVentaWeb | Sistema POS para negocios');
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute('content', 'Controlá tus ventas, inventario y caja desde cualquier lugar');
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', 'https://softventaweb.com/assets/pwa/pos-icon-512.png');
  await expect(page.getByRole('heading', { name: 'Tu negocio, más claro cada día.' })).toBeVisible();
  for (const feature of ['Ventas', 'Inventario', 'Compras', 'Caja', 'Reportes', 'Usuarios']) {
    await expect(page.getByRole('heading', { name: feature, exact: true })).toBeVisible();
  }
  const logo = page.locator('.brand img');
  await expect(logo).toHaveAttribute('alt', 'SoftVentaWeb');
  expect(await logo.evaluate(image => ({ complete: image.complete, width: image.naturalWidth, height: image.naturalHeight })))
    .toEqual({ complete: true, width: 1440, height: 366 });
  const loginLink = page.getByRole('link', { name: 'Iniciar sesión' }).first();
  await expect(loginLink).toHaveAttribute('href', '/');
  const whatsappLink = page.getByRole('link', { name: /Contactar a Ventas por WhatsApp/ });
  const expectedWhatsappUrl = 'https://wa.me/50578265886?text=Hola%2C%20estoy%20interesado%20en%20SoftVentaWeb%20y%20quisiera%20recibir%20m%C3%A1s%20informaci%C3%B3n.';
  await expect(whatsappLink).toHaveAttribute('href', expectedWhatsappUrl);
  await expect(whatsappLink).toHaveAttribute('target', '_blank');
  await expect(whatsappLink).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(whatsappLink.getByText('Contactar a Ventas')).toBeVisible();
  await expect(whatsappLink.getByText('Sergio Chévez — Asesor de Ventas')).toBeVisible();
  expect(await whatsappLink.locator('svg').count()).toBe(1);
  const desktopCtaBox = await whatsappLink.boundingBox();
  expect(desktopCtaBox.x).toBeGreaterThanOrEqual(0);
  expect(desktopCtaBox.x + desktopCtaBox.width).toBeLessThanOrEqual(1440);
  expect(desktopCtaBox.y + desktopCtaBox.height).toBeLessThanOrEqual(900);
  await whatsappLink.focus();
  await expect(whatsappLink).toBeFocused();
  expect(await whatsappLink.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
  await whatsappLink.evaluate(element => element.blur());
  await expect(page.locator('link[rel="stylesheet"]')).toHaveAttribute('href', '/inicio/styles.css');
  const cssResponse = await request.get('/inicio/styles.css');
  expect(cssResponse.status()).toBe(200);
  expect(cssResponse.headers()['content-type']).toContain('text/css');
  await expect(page.locator('script[src="/inicio/utm-cleanup.js"]')).toHaveCount(1);
  expect(await page.locator('script').count()).toBe(1);
  const inlineEventAttributes = await page.locator('*').evaluateAll(elements => elements.flatMap(element =>
    Array.from(element.attributes).filter(attribute => /^on[a-z]/i.test(attribute.name))
      .map(attribute => `${element.tagName.toLowerCase()}.${attribute.name.toLowerCase()}`)
  ));
  expect(inlineEventAttributes).toEqual([]);
  const attributeBoundaryFixture = await page.evaluate(() => {
    const meta = document.createElement('meta');
    meta.setAttribute('content', 'ordinary metadata');
    const button = document.createElement('button');
    button.setAttribute('onclick', 'noop()');
    const isHandler = element => Array.from(element.attributes).some(attribute => /^on[a-z]/i.test(attribute.name));
    return { contentAttribute: isHandler(meta), realEventAttribute: isHandler(button) };
  });
  expect(attributeBoundaryFixture).toEqual({ contentAttribute: false, realEventAttribute: true });
  const faviconUrls = await page.locator('link[rel="icon"]').evaluateAll(links => links.map(link => link.href));
  expect(faviconUrls.length).toBeGreaterThanOrEqual(4);
  for (const url of faviconUrls) expect((await request.get(url)).status()).toBe(200);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
  await page.screenshot({ path: require('node:path').join(require('node:os').tmpdir(), 'softventa-landing-1440x900.png'), fullPage: true });

  const directReload = await page.reload();
  expect(directReload.status()).toBe(200);
  await expect(page).toHaveTitle('SoftVentaWeb | Sistema POS para negocios');
  await expect(page.getByRole('link', { name: 'Iniciar sesión' }).first()).toHaveAttribute('href', '/');
  expect(await logo.evaluate(image => image.complete && image.naturalWidth === 1440)).toBe(true);

  const utmResponse = await page.goto('/inicio/?utm_source=chatgpt.com&keep=one%2Btwo&keep=required&%75tm_campaign=referral#funciones');
  expect(utmResponse.status()).toBe(200);
  await expect.poll(() => page.evaluate(() => `${location.pathname}${location.search}${location.hash}`))
    .toBe('/inicio/?keep=one%2Btwo&keep=required#funciones');
  await expect(page.locator('#funciones')).toBeInViewport();
  expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(1);
  await page.goto('/inicio/');

  await page.setViewportSize({ width: 375, height: 812 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await expect(page.getByRole('link', { name: 'Iniciar sesión' }).first()).toBeVisible();
  await expect(whatsappLink).toBeVisible();
  await expect(whatsappLink.getByText('Contactar a Ventas')).toBeVisible();
  await expect(whatsappLink.getByText('Sergio Chévez — Asesor de Ventas')).toBeHidden();
  const mobileCtaBox = await whatsappLink.boundingBox();
  expect(mobileCtaBox.x).toBeGreaterThanOrEqual(0);
  expect(mobileCtaBox.x + mobileCtaBox.width).toBeLessThanOrEqual(375);
  expect(375 - mobileCtaBox.x - mobileCtaBox.width).toBeGreaterThanOrEqual(16);
  expect(375 - mobileCtaBox.x - mobileCtaBox.width).toBeLessThanOrEqual(20);
  await expect(whatsappLink).toHaveCSS('position', 'static');
  const mobileFooterBox = await page.locator('.site-footer').boundingBox();
  expect(mobileCtaBox.y).toBeGreaterThanOrEqual(mobileFooterBox.y + mobileFooterBox.height);
  await page.screenshot({ path: require('node:path').join(require('node:os').tmpdir(), 'softventa-landing-375x812.png'), fullPage: true });

  const robotsResponse = await request.get('/robots.txt');
  expect(robotsResponse.status()).toBe(200);
  expect(robotsResponse.headers()['content-type']).toContain('text/plain');
  expect(await robotsResponse.text()).toContain('Sitemap: https://softventaweb.com/sitemap.xml');
  const sitemapResponse = await request.get('/sitemap.xml');
  expect(sitemapResponse.status()).toBe(200);
  expect(sitemapResponse.headers()['content-type']).toMatch(/^(?:application|text)\/xml(?:\s*;\s*charset\s*=\s*(?:"[a-z0-9._-]+"|[a-z0-9._-]+))?$/i);
  const sitemap = await sitemapResponse.text();
  expect(sitemap).toContain('<loc>https://softventaweb.com/inicio/</loc>');
  expect(sitemap).not.toMatch(/\/api\/|system-admin|businesses|users/i);

  const login = await request.get('/');
  expect(login.status()).toBe(200);
  expect(await login.text()).toContain('id="loginScreen"');
  expect(await login.text()).toContain('content="noindex, nofollow"');
  expect((await login.text()).match(/googletagmanager\.com|google-analytics\.com|gtag\s*\(/i)).toBeNull();
  expect(externalRequests).toEqual([]);
  expect(jsErrors).toEqual([]);
  expect(cspViolations).toEqual([]);
  expect(await page.evaluate(() => window.__landingCspViolations)).toEqual([]);
  await page.context().route('https://wa.me/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><title>WhatsApp test stub</title>'
  }));
  const whatsappPopupPromise = page.waitForEvent('popup');
  await whatsappLink.click();
  const whatsappPopup = await whatsappPopupPromise;
  expect(whatsappPopup.url()).toBe(expectedWhatsappUrl);
  await whatsappPopup.close();
  await loginLink.focus();
  await expect(loginLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#loginScreen')).toBeVisible();
});
