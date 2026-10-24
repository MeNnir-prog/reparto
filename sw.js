// sw.js — Permite abrir la app sin conexión. No guarda datos personales: solo archivos de la app y del motor OCR.
const VERSION = 'reparto-v1.5.0';
const SHELL = ['./', './index.html', './styles.css', './app.js', './db.js', './logic.js', './ocr.js', './map.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];
// Librerías de versión fija (OCR y mapa): caché permanente. Las búsquedas de direcciones, rutas y mapas no se guardan acá.
const OCR_HOSTS = ['cdn.jsdelivr.net', 'tessdata.projectnaptha.com', 'cdnjs.cloudflare.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== 'ocr-engine').map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Motor OCR (CDN o carpeta vendor): caché permanente, versión fija
  if (OCR_HOSTS.includes(url.hostname) || url.pathname.includes('/vendor/tesseract/')) {
    e.respondWith(caches.open('ocr-engine').then(async c => {
      const hit = await c.match(req); if (hit) return hit;
      const res = await fetch(req); if (res.ok) c.put(req, res.clone()); return res;
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;
  // App: red primero (para recibir actualizaciones), caché si no hay conexión
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
});
