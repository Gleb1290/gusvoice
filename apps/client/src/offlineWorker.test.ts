import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { ownRingSpeaking } from './micGateState.js';

const origin = 'https://voice.example.test';
const gatePath = '/gv-gate-worklet.js';
const csp = "default-src 'self'; script-src 'self'; worker-src 'self'";
const worker = readFileSync(new URL('../offlineWorker.js', import.meta.url), 'utf8');
const digest = (body: string | Uint8Array) => 'sha256-' + createHash('sha256').update(body).digest('base64');

function htmlResponse(body: BodyInit) {
  return new Response(body, { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': csp } });
}

function configResponse(body: string, published = true) {
  return new Response(body, { headers: {
    'Content-Type': 'application/javascript',
    'X-GusVoice-Public-Config': published ? '1' : '0',
    'Cache-Control': 'no-store',
  } });
}

function harness(storage = new Map<string, Map<string, Response>>()) {
  const files = new Map<string, () => Response>();
  const network: {
    navigate: (signal: AbortSignal) => Response | Promise<Response>;
    gate: () => Response;
  } = {
    navigate: () => { throw new Error('offline'); },
    gate: () => { throw new Error('offline'); },
  };
  const downloads: string[] = [];

  function load(source: string) {
    type Event = {
      request?: { url: string; method: string; mode: string; destination: string; headers: Headers };
      waitUntil: (work: Promise<unknown>) => void;
      respondWith: (response: Promise<Response>) => void;
    };
    const handlers = new Map<string, (event: Event) => void>();
    const context = {
      self: {
        location: { origin },
        addEventListener: (name: string, handler: (event: Event) => void) => handlers.set(name, handler),
      },
      caches: {
        open: async (name: string) => {
          if (!storage.has(name)) storage.set(name, new Map());
          const cache = storage.get(name)!;
          return { put: async (url: string, res: Response) => {
            // Cache.put читает поток целиком.
            const copy = new Response(await res.arrayBuffer(), { headers: res.headers });
            cache.set(url, copy);
          } };
        },
        match: async (url: string, { cacheName }: { cacheName: string }) => storage.get(cacheName)?.get(url)?.clone(),
        keys: async () => [...storage.keys()],
        delete: async (name: string) => storage.delete(name),
      },
      fetch: async (input: string | NonNullable<Event['request']>, init: RequestInit) => {
        if (typeof input !== 'string') {
          if (input.mode === 'navigate') return network.navigate(init.signal!);
          if (new URL(input.url).pathname === gatePath) return network.gate();
          return new Response(null, { status: 404 });
        }
        assert.equal(init.credentials, 'omit');
        assert.equal(init.redirect, 'error');
        const path = new URL(input).pathname;
        downloads.push(path);
        const response = files.get(path)?.() ?? new Response(null, { status: 404 });
        if (init.integrity && response.ok) {
          const bytes = new Uint8Array(await response.clone().arrayBuffer());
          if (digest(bytes) !== init.integrity) throw new TypeError('integrity mismatch');
        }
        return response;
      },
      AbortController, Response, Headers, URL, btoa, crypto: webcrypto,
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms === 3500 ? 15 : ms),
      clearTimeout,
    };
    runInNewContext(source, context);

    async function dispatch(event: string, request?: Event['request']) {
      let result: Promise<Response> | undefined;
      const work: Promise<unknown>[] = [];
      handlers.get(event)!({
        request,
        waitUntil: (promise) => work.push(promise),
        respondWith: (response) => { result = response; },
      });
      const [response] = await Promise.all([result, ...work]);
      return response as Response | undefined;
    }

    return {
      install: () => dispatch('install'),
      activate: () => dispatch('activate'),
      request: (path: string, { mode = 'navigate', destination = 'document', method = 'GET', headers = {} } = {}) =>
        dispatch('fetch', { url: new URL(path, origin).href, method, mode, destination, headers: new Headers(headers) }),
    };
  }

  return { storage, files, network, downloads, load };
}

function fixture(h: ReturnType<typeof harness>, version = 'v1') {
  const entry = '/assets/index-' + version + '.js';
  const css = '/assets/index-' + version + '.css';
  const html = '<script src="/config.js"></script><script type="module" src="' + entry + '"></script>';
  const script = 'export const version = ' + JSON.stringify(version);
  const stylesheet = 'body { margin: 0; }';
  h.files.set('/index.html', () => htmlResponse(html));
  h.files.set(entry, () => new Response(script, { headers: { 'Content-Type': 'application/javascript' } }));
  h.files.set(css, () => new Response(stylesheet, { headers: { 'Content-Type': 'text/css' } }));
  h.files.set('/config.js', () => configResponse(version));
  const shell = { version, html: digest(html), assets: [
    { path: entry, kind: 'script', integrity: digest(script) },
    { path: css, kind: 'style', integrity: digest(stylesheet) },
  ] };
  return {
    sw: h.load('const shell = ' + JSON.stringify(shell) + ';\n' + worker),
    html, entry, script, css, stylesheet, config: '/.gusvoice-offline/' + version + '/config.js',
  };
}

const script = { mode: 'cors', destination: 'script' };
const style = { mode: 'cors', destination: 'style' };

describe('Офлайн-запуск веба', () => {
  it('при обрыве сети возвращает HTML с CSP, конфиг и ассеты одной сборки', async () => {
    const h = harness();
    const v = fixture(h);
    await v.sw.install();
    const response = await v.sw.request('/');
    assert.equal(response?.headers.get('Content-Security-Policy'), csp);
    assert.match((await response?.text())!, /src="\/\.gusvoice-offline\/v1\/config\.js"/);
    assert.equal(await (await v.sw.request(v.config, script))?.text(), 'v1');
    assert.equal(await (await v.sw.request(v.entry, script))?.text(), v.script);
    assert.equal(await (await v.sw.request(v.css, style))?.text(), v.stylesheet);
    assert.deepEqual(h.downloads.sort(), [v.css, v.entry, '/config.js', '/index.html']);
  });

  it('подменяет 502 и зависший ответ, сохраняет 401, 404 и редирект', async () => {
    const h = harness();
    const { sw } = fixture(h);
    await sw.install();
    for (const status of [502, 503, 504, 401, 404]) {
      h.network.navigate = () => new Response(null, { status });
      assert.equal((await sw.request('/index.html'))?.status, status >= 500 ? 200 : status);
    }
    h.network.navigate = () => Response.redirect(origin + '/setup');
    assert.equal((await sw.request('/'))?.headers.get('Location'), origin + '/setup');
    h.network.navigate = (signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    assert.equal((await sw.request('/'))?.status, 200);
    h.network.navigate = (signal) => htmlResponse(new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    }));
    assert.equal((await sw.request('/'))?.status, 200);
  });

  it('оставляет приглашения, настройку, авторизацию, API и приватные файлы сети', async () => {
    const h = harness();
    const v = fixture(h);
    await v.sw.install();
    const requests = [
      v.sw.request('/join/example'), v.sw.request('/?invite=example'), v.sw.request('/setup'),
      v.sw.request('/auth/callback'), v.sw.request('/index.html?code=example'),
      v.sw.request('/api/auth/me', { mode: 'cors' }),
      v.sw.request('/config.js', script),
      v.sw.request('/config.json', { mode: 'cors' }),
      v.sw.request('/media/opaque?signature=x', { mode: 'cors', destination: 'image' }),
      v.sw.request('https://other.example.test/'), v.sw.request('/', { method: 'POST' }),
      v.sw.request('/', { headers: { Authorization: 'Bearer fixture' } }),
      v.sw.request('/assets/missing.js', script), v.sw.request(v.entry + '?private=1', script),
      v.sw.request(v.entry, { ...script, headers: { Range: 'bytes=0-50' } }),
      v.sw.request('/assets/unlisted.wasm', { mode: 'cors', destination: '' }),
      v.sw.request('/assets/unlisted.js', { mode: 'cors', destination: 'audioworklet' }),
      v.sw.request(v.entry, { mode: 'cors', destination: '' }),
    ];
    assert.ok((await Promise.all(requests)).every((response) => response === undefined));
  });

  it('показывает свежий HTML и обновляет сохранённый публичный конфиг той же сборки', async () => {
    const h = harness();
    const v = fixture(h);
    await v.sw.install();
    h.network.navigate = () => htmlResponse(v.html);
    h.files.set('/config.js', () => configResponse('new public config'));
    assert.equal(await (await v.sw.request('/'))?.text(), v.html);
    assert.equal(await (await v.sw.request(v.config, script))?.text(), 'new public config');

    h.files.set('/config.js', () => configResponse('unmarked response', false));
    await v.sw.request('/');
    assert.equal(await (await v.sw.request(v.config, script))?.text(), 'new public config');
    h.network.navigate = () => htmlResponse('another deploy');
    h.files.set('/config.js', () => configResponse('another deploy config'));
    assert.equal(await (await v.sw.request('/'))?.text(), 'another deploy');
    assert.equal(await (await v.sw.request(v.config, script))?.text(), 'new public config');
  });

  it('сохраняет старые chunks до активации новой полной сборки', async () => {
    const h = harness();
    const v1 = fixture(h);
    await v1.sw.install();
    const v2 = fixture(h, 'v2');
    await v2.sw.install();
    assert.equal(await (await v1.sw.request(v1.entry, script))?.text(), v1.script);
    assert.equal(await v1.sw.request(v2.entry, script), undefined);

    h.storage.set('unrelated-cache', new Map());
    await v2.sw.activate();
    assert.equal(await (await v2.sw.request(v2.entry, script))?.text(), v2.script);
    assert.equal(await v2.sw.request(v1.entry, script), undefined);
    assert.deepEqual([...h.storage.keys()], ['gusvoice-shell-v2', 'unrelated-cache']);
  });

  it('отклоняет частичную или устаревшую сборку, сохраняя предыдущий снимок', async () => {
    const h = harness();
    const v1 = fixture(h);
    await v1.sw.install();

    const v2 = fixture(h, 'v2');
    h.files.set(v2.entry, () => new Response('wrong bytes', { headers: { 'Content-Type': 'text/javascript' } }));
    await assert.rejects(v2.sw.install());
    assert.equal((await v1.sw.request('/'))?.status, 200);

    h.files.set('/index.html', () => htmlResponse(v1.html));
    await assert.rejects(v2.sw.install());
    assert.deepEqual([...h.storage.keys()], ['gusvoice-shell-v1']);
  });

  it('оставляет ошибку шлюза, пока отсутствует полный снимок', async () => {
    const h = harness();
    const { sw } = fixture(h);
    h.network.navigate = () => new Response('bad gateway', { status: 502 });
    assert.equal((await sw.request('/'))?.status, 502);
  });
});

// Опционально прогоняем тот же сценарий на реально выпущенных Vite файлах.
const dist = process.env.GV_CHECK_OFFLINE_DIST;
it('собранный Vite worker загружает выпущенные HTML, JS и CSS при потере origin', { skip: !dist }, async () => {
  const h = harness();
  const dir = dist!;
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  h.files.set('/index.html', () => htmlResponse(html));
  h.files.set('/config.js', () => configResponse('window.__GUSVOICE_CONFIG__ = { apiUrl: "https://api.example.test" };'));
  const assets = readdirSync(join(dir, 'assets')).filter((name) => /\.(js|css)$/.test(name));
  for (const name of assets) {
    const bytes = readFileSync(join(dir, 'assets', name));
    const type = name.endsWith('.js') ? 'application/javascript' : 'text/css';
    h.files.set('/assets/' + name, () => new Response(bytes, { headers: { 'Content-Type': type } }));
  }
  const emittedUrl = async (name: string): Promise<string> => {
    const url = pathToFileURL(resolve(dir, 'assets', name));
    return (await import(url.href)).default;
  };
  const wasmChunks = assets.filter((name) => /^rnnoise(?:_simd)?-[\w-]+\.js$/.test(name));
  assert.equal(wasmChunks.length, 2);
  const wasmUrls = new Set(await Promise.all(wasmChunks.map(emittedUrl)));
  for (const url of wasmUrls) {
    assert.match(url, /^\/assets\/rnnoise(?:_simd)?-[\w-]+\.wasm$/);
    const bytes = readFileSync(join(dir, url));
    h.files.set(url, () => new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } }));
  }
  const workletChunk = assets.find((name) =>
    /^workletProcessor-[\w-]+\.js$/.test(name) && readFileSync(join(dir, 'assets', name)).length < 1024);
  assert.ok(workletChunk);
  const workletUrl = await emittedUrl(workletChunk);
  assert.match(workletUrl, /^\/assets\/workletProcessor-[\w-]+\.js$/);
  const gateBytes = readFileSync(join(dir, gatePath));
  h.files.set(gatePath, () => new Response(gateBytes, { headers: { 'Content-Type': 'application/javascript' } }));
  const sw = h.load(readFileSync(join(dir, 'sw.js'), 'utf8'));
  await sw.install();
  assert.equal(h.downloads.length, assets.length + wasmUrls.size + 3);
  h.files.clear();
  const response = await sw.request('/');
  assert.equal(response?.headers.get('Content-Security-Policy'), csp);
  const offlineHtml = (await response?.text())!;
  const bootUrls = [...offlineHtml.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(js|css))"/g)];
  assert.ok(bootUrls.some((match) => match[2] === 'js'));
  assert.ok(bootUrls.some((match) => match[2] === 'css'));
  for (const name of assets) {
    const response = await sw.request('/assets/' + name, name.endsWith('.js') ? script : style);
    const expected = readFileSync(join(dir, 'assets', name));
    assert.deepEqual(Buffer.from(await response!.arrayBuffer()), expected);
  }
  const config = offlineHtml.match(/src="(\/\.gusvoice-offline\/[^"]+\/config\.js)"/)?.[1];
  assert.ok(config);
  assert.match((await (await sw.request(config, script))?.text())!, /api\.example\.test/);

  const worklet = { mode: 'cors', destination: 'audioworklet' };
  const programmatic = { ...worklet, destination: '' };
  for (const url of wasmUrls) {
    const bytes = await (await sw.request(url, programmatic))!.arrayBuffer();
    assert.ok(bytes.byteLength > 64 * 1024);
    assert.ok(WebAssembly.validate(bytes));
  }
  for (const options of [worklet, programmatic]) {
    const bytes = await (await sw.request(workletUrl, options))!.arrayBuffer();
    assert.ok(bytes.byteLength > 8 * 1024);
    assert.deepEqual(Buffer.from(bytes), readFileSync(join(dir, workletUrl)));
  }
  assert.equal(await sw.request(gatePath + '?other=1', worklet), undefined);

  // Без DNS-доступа к сайту гейт берётся из Cache Storage даже при потере фильтра RNNoise.
  const installedCache = [...h.storage.values()][0];
  for (const url of wasmUrls) {
    installedCache.delete(origin + url);
    assert.equal((await sw.request(url, programmatic))?.type, 'error');
  }

  h.network.gate = () => new Response('new gate', { headers: { 'Content-Type': 'text/javascript' } });
  assert.equal(await (await sw.request(gatePath, worklet))?.text(), 'new gate');
  h.network.gate = () => new Response(null, { status: 502 });
  const offlineGate = await (await sw.request(gatePath, worklet))!.text();
  assert.ok(offlineGate.length > 1024);
  assert.deepEqual(Buffer.from(offlineGate), gateBytes);
  assert.equal(await (await sw.request(gatePath, programmatic))?.text(), offlineGate);

  type Gate = {
    port: { onmessage: (message: { data: { threshold: number } }) => void };
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  };
  let Processor: (new () => Gate) | undefined;
  const signals: boolean[] = [];
  runInNewContext(offlineGate, {
    AudioWorkletProcessor: class {
      port = { postMessage: (event: { open: boolean }) => signals.push(event.open) };
    },
    sampleRate: 48_000,
    registerProcessor: (name: string, ctor: new () => Gate) => {
      assert.equal(name, 'gv-gate');
      Processor = ctor;
    },
  }, { timeout: 1000 });
  assert.ok(Processor);
  const gate = new Processor();
  const input = new Float32Array(128).fill(0.1);
  const output = new Float32Array(128);
  gate.port.onmessage({ data: { threshold: 0.5 } });
  gate.process([[input]], [[output]]);
  assert.deepEqual(output, new Float32Array(128));
  assert.equal(ownRingSpeaking(true, signals.at(-1)!), false);

  // PTT управляет публикацией отдельно. Порог 0 оставляет звук и индикацию открытыми для VAD.
  gate.port.onmessage({ data: { threshold: 0 } });
  gate.process([[input]], [[output]]);
  assert.deepEqual(output, input);
  assert.deepEqual(signals, [false, true]);
  assert.equal(ownRingSpeaking(true, signals.at(-1)!), true);
});
