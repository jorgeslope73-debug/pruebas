const VERSION = 'V19.6';
const SHELL_CACHE = `galaxy-combat-shell-${VERSION}`;
const ASSET_CACHE = `galaxy-combat-assets-${VERSION}`;
const ACTIVE_CACHES = new Set([SHELL_CACHE, ASSET_CACHE]);

const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './menu-portada.css',
  './voz.css',
  './config.js',
  './i18n.js',
  './manual.js',
  './auth.js',
  './impactos.js',
  './voz.js',
  './local-cpu.js',
  './host-physics.js',
  './p2p-network.js',
  './game.js',
  './pwa.js',
  './manifest.webmanifest',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(key => {
        if (key.startsWith('galaxy-combat-') && !ACTIVE_CACHES.has(key)) return caches.delete(key);
        return Promise.resolve(false);
      })))
      .then(() => self.clients.claim())
  );
});

function isCodeRequest(request, url) {
  if (request.mode === 'navigate') return true;
  if (['script', 'style', 'document', 'manifest'].includes(request.destination)) return true;
  return /\.(?:js|css|html|webmanifest)$/i.test(url.pathname);
}

function isStaticAsset(request, url) {
  return url.pathname.includes('/assets/') || ['image', 'audio', 'font'].includes(request.destination);
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response && response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const fallback = await cache.match('./index.html');
      if (fallback) return fallback;
    }
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isCodeRequest(request, url)) {
    event.respondWith(networkFirst(request));
    return;
  }
  if (isStaticAsset(request, url)) {
    event.respondWith(cacheFirst(request));
  }
});
