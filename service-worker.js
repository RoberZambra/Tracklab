/* ════════════════════════════════════════════════════════
   TrackLab — service-worker.js
   Estratégia: Cache First para assets estáticos,
               Network First para CDN externos.
════════════════════════════════════════════════════════ */

const CACHE_NAME = 'tracklab-v1.0.0';

// Assets locais para cache imediato no install
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
];

// ── Install: pré-cacheia assets locais ──
self.addEventListener('install', event => {
  console.log('[SW] Instalando e pré-cacheando assets...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE_ASSETS);
    }).then(() => {
      console.log('[SW] Assets pré-cacheados com sucesso.');
      return self.skipWaiting(); // Ativa imediatamente
    })
  );
});

// ── Activate: limpa caches antigos ──
self.addEventListener('activate', event => {
  console.log('[SW] Ativando e limpando caches antigos...');
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] Removendo cache antigo:', key);
            return caches.delete(key);
          })
      );
    }).then(() => self.clients.claim()) // Assume controle de todos os clientes
  );
});

// ── Fetch: estratégia híbrida ──
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignora requests não-GET
  if (request.method !== 'GET') return;

  // Para assets de CDN externos (Chart.js, Tailwind, Fonts):
  // Network First → fallback para cache
  const isExternal = url.origin !== self.location.origin;
  if (isExternal) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Para assets locais: Cache First → fallback para network
  event.respondWith(cacheFirst(request));
});

/**
 * Cache First: usa cache se disponível, senão vai à rede e cacheia
 */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Offline e não há cache: retorna página offline genérica
    return new Response(offlinePage(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

/**
 * Network First: tenta rede, usa cache em caso de falha
 */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('', { status: 503 });
  }
}

/**
 * Página offline simples exibida quando sem cache e sem rede
 */
function offlinePage() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TrackLab — Offline</title>
  <style>
    body {
      background: #04080f; color: rgba(255,255,255,0.7);
      font-family: 'JetBrains Mono', monospace;
      display: flex; align-items: center; justify-content: center;
      height: 100vh; margin: 0; text-align: center;
    }
    h1 { color: #00ffe0; font-size: 1.5rem; margin-bottom: 0.5rem; }
    p  { color: rgba(255,255,255,0.35); font-size: 0.85rem; }
  </style>
</head>
<body>
  <div>
    <h1>TrackLab</h1>
    <p>Você está offline e esta página não está em cache.</p>
    <p style="margin-top:1rem; color: rgba(255,255,255,0.2)">Reconecte-se à internet e tente novamente.</p>
  </div>
</body>
</html>`;
}
