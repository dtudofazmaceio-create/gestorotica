/* ==========================================================================
   Ótica VisionPlus — Service Worker (offline-first)
   - Faz cache do "app shell" (HTML + ícones + manifest)
   - Faz cache das bibliotecas externas (Font Awesome, JsBarcode, Chart.js)
   - Estratégias:
       * Navegação (abrir o app)  -> network-first, cai p/ cache se offline
       * Demais arquivos/assets   -> cache-first, atualiza em segundo plano
   Os DADOS do sistema continuam no IndexedDB (não passam por aqui).
   ========================================================================== */

const CACHE_VERSION = 'v1.0.0';
const CACHE_NAME = `otica-visionplus-${CACHE_VERSION}`;

// Arquivos locais essenciais (precisam estar no cache para o app abrir offline)
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

// Bibliotecas externas (CDN) usadas pelo app — precisam ficar offline também
const EXTERNAL_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js'
];

// -------- INSTALAÇÃO: pré-cache do shell + assets externos --------
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // Shell local é obrigatório
    await cache.addAll(APP_SHELL);

    // Assets externos: best-effort (um CDN fora do ar não pode quebrar a instalação)
    await Promise.allSettled(
      EXTERNAL_ASSETS.map(async (url) => {
        try {
          const resp = await fetch(url, { cache: 'reload' });
          if (resp && (resp.ok || resp.type === 'opaque')) {
            await cache.put(url, resp.clone());
          }
        } catch (e) {
          // ignora; será buscado/cacheado em tempo de execução no primeiro uso online
        }
      })
    );

    // Ativa a nova versão imediatamente
    self.skipWaiting();
  })());
});

// -------- ATIVAÇÃO: limpa caches antigos --------
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// Permite a página pedir atualização imediata (botão "Atualizar")
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// -------- FETCH: estratégias de cache --------
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Só tratamos GET (POST/PUT etc. não devem ser cacheados)
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Não interferir em esquemas não-http (ex: chrome-extension)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 1) Requisições de navegação (carregar/recarregar o app):
  //    network-first -> se offline, devolve o index.html do cache.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        cache.put('./index.html', fresh.clone()).catch(() => {});
        return fresh;
      } catch (e) {
        const cache = await caches.open(CACHE_NAME);
        const cached =
          (await cache.match('./index.html')) ||
          (await cache.match('./')) ||
          (await cache.match(req));
        return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })());
    return;
  }

  // 2) Demais GET (assets locais, CDN, fontes do Font Awesome, imagens):
  //    cache-first com atualização em segundo plano (stale-while-revalidate).
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);

    const network = fetch(req)
      .then((resp) => {
        // Cacheia respostas válidas (inclui 'opaque' de CDNs sem CORS)
        if (resp && (resp.ok || resp.type === 'opaque')) {
          cache.put(req, resp.clone()).catch(() => {});
        }
        return resp;
      })
      .catch(() => null);

    // Devolve o cache imediatamente se existir; senão espera a rede.
    return cached || (await network) ||
      new Response('', { status: 504, statusText: 'Offline' });
  })());
});
