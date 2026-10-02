// Service worker: guarda a "casca" do app para abrir rápido e funcionar offline.
// Ao publicar uma nova versão dos arquivos, aumente o número abaixo.
const CACHE = 'notas-v7';
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './config.js',
  './css/app.css', './js/main.js', './js/auth.js', './js/db.js', './js/util.js', './js/formatar.js',
  './js/preview.js', './js/conversa.js', './js/store.js', './js/sync.js', './js/busca.js', './js/nota.js', './js/vendor/supabase.js', './js/vendor/tiptap.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Supabase, Google etc. vão direto para a rede
  if (url.origin !== self.location.origin) return;

  // Páginas: rede primeiro (pega a versão nova), cache se estiver offline
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => {
      const copia = r.clone(); caches.open(CACHE).then(c => c.put('./index.html', copia)); return r;
    }).catch(() => caches.match('./index.html')));
    return;
  }

  // Arquivos do app: rede primeiro com cache de reserva (evita ficar preso numa versão velha)
  e.respondWith(fetch(req).then(r => {
    if (r.ok) { const copia = r.clone(); caches.open(CACHE).then(c => c.put(req, copia)); }
    return r;
  }).catch(() => caches.match(req)));
});
