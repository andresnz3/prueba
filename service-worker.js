/* Build template. scripts/build-static.cjs inserts the closed static asset list and revision. */
'use strict';

const CACHE_NAME = '__POS_CACHE_NAME__';
const CACHE_PREFIX = 'pos-pwa-shell-';
// eslint-disable-next-line no-undef -- build-time list generated from the public static files.
const PRECACHE_URLS = __POS_PRECACHE_URLS__;
const OFFLINE_PAGE = '/offline.html';
const APP_PAGE = '/index.html';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
  })());
});

async function networkNavigation(request) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      try {
        return await networkNavigation(request);
      } catch {
        return (await cache.match(APP_PAGE)) || (await cache.match(OFFLINE_PAGE)) || Response.error();
      }
    })());
    return;
  }

  if (!PRECACHE_URLS.includes(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    try {
      return await fetch(request);
    } catch {
      return new Response('', { status: 503, statusText: 'Offline' });
    }
  })());
});
