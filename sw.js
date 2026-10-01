/* Lumière Beauty — service worker do app (PWA)
   Coloque este arquivo na MESMA pasta do HTML publicado (https).
   Guarda o sistema em cache para abrir rápido e funcionar com internet instável.
   Os dados continuam indo para o Supabase normalmente. */
const CACHE = 'lumiere-app-v1';

self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Nunca guardar em cache chamadas do Supabase (dados, login, integrações)
  if (url.hostname.endsWith('supabase.co')) return;
  // Página do sistema: rede primeiro, cache como reserva
  if (req.mode === 'navigate' || url.pathname.endsWith('.html')) {
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return r; }).catch(() => caches.match(req).then(r => r || caches.match('./'))));
    return;
  }
  // Fontes, ícones e bibliotecas: cache primeiro
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok && (url.origin === location.origin || /fonts\.(googleapis|gstatic)\.com|cdn/.test(url.hostname))) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; })));
});
