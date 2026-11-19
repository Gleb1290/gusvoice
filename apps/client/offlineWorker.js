/* global shell */
// Vite записывает manifest перед этим кодом. Один кэш содержит только одну полную сборку.
const origin = self.location.origin;
const cachePrefix = 'gusvoice-shell-';
const cacheName = cachePrefix + shell.version;
const indexUrl = origin + '/index.html';
const configUrl = origin + '/config.js';
const offlineConfigUrl = origin + '/.gusvoice-offline/' + shell.version + '/config.js';
const assets = new Map(shell.assets.map((asset) => [asset.path, asset]));
const destinations = {
  script: ['script'],
  style: ['style'],
  gate: ['audioworklet', 'script', ''],
  worklet: ['audioworklet', 'script', ''],
  wasm: [''],
};
const navigationTimeout = 3500;
const installTimeout = 30000;

function contentType(response) {
  return response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
}

function isScript(response) {
  return ['application/javascript', 'text/javascript', 'application/x-javascript'].includes(contentType(response));
}

function hasAssetType(response, kind) {
  if (kind === 'style') return contentType(response) === 'text/css';
  if (kind === 'wasm') return ['application/wasm', 'application/octet-stream'].includes(contentType(response));
  return isScript(response);
}

function unavailable(response) {
  return response.type === 'error' || [502, 503, 504].includes(response.status);
}

async function withDeadline(ms, run) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPublic(url, signal, integrity = '', cache = 'no-store') {
  const response = await fetch(url, { credentials: 'omit', redirect: 'error', cache, integrity, signal });
  if (response.status !== 200 || /\bprivate\b/i.test(response.headers.get('cache-control') ?? '')) {
    throw new Error('Offline shell resource unavailable: ' + url);
  }
  return response;
}

async function fetchConfig(signal) {
  const response = await fetchPublic(configUrl, signal);
  if (!isScript(response) || response.headers.get('X-GusVoice-Public-Config') !== '1') {
    throw new Error('Expected published GusVoice runtime config');
  }
  return response;
}

async function installShell() {
  const cache = await caches.open(cacheName);
  try {
    await withDeadline(installTimeout, async (signal) => {
      const index = await fetchPublic(indexUrl, signal, shell.html);
      const headers = new Headers(index.headers);
      if (contentType(index) !== 'text/html' || !headers.has('Content-Security-Policy')) {
        throw new Error('Expected the published HTML with its CSP');
      }
      const html = await index.text();
      const configTag = '<script src="/config.js"></script>';
      if (!html.includes(configTag)) throw new Error('Runtime config script missing from the shell');
      // Офлайн-документ использует конфиг своего снимка, даже если сеть вернулась между HTML и script.
      for (const header of ['Content-Encoding', 'Content-Length', 'ETag', 'Last-Modified']) headers.delete(header);
      const offlineHtml = html.replace(configTag, '<script src="' + new URL(offlineConfigUrl).pathname + '"></script>');

      await Promise.all([
        fetchConfig(signal).then((response) => cache.put(offlineConfigUrl, response)),
        ...shell.assets.map(async ({ path, integrity, kind }) => {
          const url = origin + path;
          const response = await fetchPublic(url, signal, integrity, kind === 'gate' ? 'no-store' : 'default');
          if (!hasAssetType(response, kind)) throw new Error('Unexpected content type for ' + path);
          await cache.put(url, response);
        }),
      ]);
      await cache.put(indexUrl, new Response(offlineHtml, { headers }));
    });
  } catch (error) {
    await caches.delete(cacheName);
    throw error;
  }
}

self.addEventListener('install', (event) => event.waitUntil(installShell()));

// Стандартное ожидание закрытия старых вкладок сохраняет их chunks до смены контроллера.
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith(cachePrefix) && key !== cacheName).map((key) => caches.delete(key)),
  )));
});

function match(url) {
  return caches.match(url, { cacheName }).catch(() => undefined);
}

self.addEventListener('message', (event) => {
  const port = event.ports[0];
  if (event.data !== 'gusvoice:offline-shell-status' || !port) return;

  // index.html появляется в кэше этой версии после записи конфига и всех ассетов.
  event.waitUntil(Promise.all([match(indexUrl), match(offlineConfigUrl)]).then(([html, config]) => {
    port.postMessage(Boolean(html?.ok && config?.ok));
  }));
});

async function fetchNavigation(request) {
  try {
    return await withDeadline(navigationTimeout, async (signal) => {
      const response = await fetch(request, { cache: 'no-store', signal });
      // Учитываем обрыв и зависание тела HTML после получения заголовков.
      const html = response.status === 200 && contentType(response) === 'text/html'
        ? await response.clone().arrayBuffer()
        : undefined;
      return { response, html };
    });
  } catch {
    return { response: Response.error() };
  }
}

async function loadGate(request) {
  // У URL из public нет хеша: онлайн нужен свежий код, даже пока предыдущий SW активен.
  const response = await withDeadline(navigationTimeout, async (signal) => {
    const current = await fetch(request, { cache: 'no-store', signal });
    if (current.ok && isScript(current)) await current.clone().arrayBuffer();
    return current;
  }).catch(() => Response.error());
  if (!unavailable(response) && !(response.ok && !isScript(response))) return response;
  return (await match(request.url)) ?? response;
}

async function loadAsset(request, asset) {
  const cached = await match(request.url);
  if (cached) return cached;
  if (asset.kind !== 'worklet' && asset.kind !== 'wasm') return fetch(request);

  // Если браузер потерял часть кэша, сбой RNNoise не должен задержать запуск VAD на сетевой таймаут.
  return withDeadline(navigationTimeout, async (signal) => {
    const response = await fetchPublic(request.url, signal, asset.integrity, 'default');
    if (!hasAssetType(response, asset.kind)) throw new Error('Unexpected RNNoise asset type');
    return response;
  }).catch(() => Response.error());
}

let configRefresh;
async function refreshConfig(html) {
  if (!html) return;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', html));
  if ('sha256-' + btoa(String.fromCharCode(...digest)) !== shell.html) return;

  // Конфиг может измениться при redeploy той же сборки. Новую сборку подготовит её собственный воркер.
  configRefresh ??= withDeadline(navigationTimeout, async (signal) => {
    const cache = await caches.open(cacheName);
    await cache.put(offlineConfigUrl, await fetchConfig(signal));
  }).catch(() => {}).finally(() => { configRefresh = undefined; });
  await configRefresh;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('Authorization') || request.headers.has('Range')) return;
  const url = new URL(request.url);
  if (url.origin !== origin || url.search) return;

  if (request.mode === 'navigate') {
    if (url.pathname !== '/' && url.pathname !== '/index.html') return;
    const network = fetchNavigation(request);
    event.respondWith(network.then(async ({ response }) => {
      if (!unavailable(response)) return response;
      const config = await match(offlineConfigUrl);
      return (config && await match(indexUrl)) || response;
    }));
    event.waitUntil(network.then(({ html }) => refreshConfig(html)).catch(() => {}));
  } else if (request.url === offlineConfigUrl && request.destination === 'script') {
    event.respondWith(match(offlineConfigUrl).then((response) => response ?? Response.error()));
  } else {
    const asset = assets.get(url.pathname);
    if (!asset || !destinations[asset.kind].includes(request.destination)) return;
    event.respondWith(asset.kind === 'gate' ? loadGate(request) : loadAsset(request, asset));
  }
});
