import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCorsOrigins, peerOriginOf, staticOriginsFor } from './corsOriginsCore.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('источники CORS федерации', () => {
  it('рабочая, приостановленная, заблокированная и потерявшая доверие связки дают источник, а заявки — нет', () => {
    // Ловит как безликий CORS-отказ законному соседу, так и преждевременное доверие заявке.
    for (const state of ['active', 'paused', 'blocked', 'trust-lost']) {
      assert.equal(peerOriginOf({ origin: 'HTTPS://Peer.Example/path', state }), 'https://peer.example', state);
    }
    for (const state of ['requested', 'pending', 'unknown']) {
      assert.equal(peerOriginOf({ origin: 'https://peer.example', state }), null, state);
    }
  });

  it('пустой, null и любой не-HTTP источник связки никогда не разрешаются', () => {
    // Ловит превращение opaque-origin браузера в доверенный источник через URL.origin === "null".
    for (const origin of ['', '  ', 'null', 'data:text/html,x', 'file:///tmp/x', 'tauri://localhost']) {
      assert.equal(peerOriginOf({ origin, state: 'active' }), null, origin);
    }
  });

  it('источники dev добавляются только когда собственный клиент действительно локальный', () => {
    // Ловит выдачу продового CORS-доступа любой программе на локальном порту пользователя.
    const prod = staticOriginsFor({ clientOrigin: 'https://voice.example', extraOrigins: [] });
    assert.equal(prod.includes('http://localhost:5173'), false);
    const local = staticOriginsFor({ clientOrigin: 'http://localhost:4173', extraOrigins: [] });
    assert.equal(local.includes('http://localhost:5173'), true);
    assert.equal(local.includes('http://127.0.0.1:5173'), true);
  });

  it('просроченный кеш запускает фоновое чтение, не задерживая текущую проверку', async () => {
    // Ловит синхронное ожидание базы на пути каждого CORS-запроса после истечения TTL.
    let reads = 0;
    let now = 100;
    const cors = createCorsOrigins({
      now: () => now, ttlMs: 10, staticOrigins: [],
      readOrigins: async () => { reads += 1; return [{ origin: 'https://peer.example', state: 'active' }]; },
    });
    assert.equal(cors.originAllowed('https://peer.example'), false);
    await tick();
    assert.equal(reads, 1);
    assert.equal(cors.originAllowed('https://peer.example/path'), true);
    now += 11;
    assert.equal(cors.originAllowed('https://other.example'), false);
    await tick();
    assert.equal(reads, 2);
  });

  it('обычные обновления присоединяются к одному чтению, а несколько force ставят ровно одно следом', async () => {
    // Ловит и чтение базы на каждый запрос, и потерю изменения связки за уже начатым старым чтением.
    let reads = 0;
    const releases: Array<(rows: Array<{ origin: string; state: string }>) => void> = [];
    const cors = createCorsOrigins({
      now: () => 100, staticOrigins: [],
      readOrigins: () => {
        reads += 1;
        return new Promise((resolve) => releases.push(resolve));
      },
    });
    const first = cors.refreshPeerOrigins();
    const joined = cors.refreshPeerOrigins();
    const forced = cors.refreshPeerOrigins({ force: true });
    const forcedAgain = cors.refreshPeerOrigins({ force: true });
    assert.strictEqual(joined, first);
    assert.strictEqual(forcedAgain, forced);
    await tick();
    assert.equal(reads, 1);
    releases[0]([]);
    await first;
    await tick();
    assert.equal(reads, 2);
    releases[1]([]);
    await Promise.all([forced, forcedAgain]);
    assert.equal(reads, 2);
  });

  it('ошибка перечитывания сохраняет последний успешно разрешённый список', async () => {
    // Ловит внезапный CORS-отказ всем соседям из-за краткой недоступности базы.
    let fail = false;
    const cors = createCorsOrigins({
      now: () => 100, staticOrigins: [],
      readOrigins: async () => {
        if (fail) throw new Error('db down');
        return [{ origin: 'https://peer.example', state: 'active' }];
      },
    });
    await cors.refreshPeerOrigins();
    assert.equal(cors.originAllowed('https://peer.example'), true);
    fail = true;
    await cors.refreshPeerOrigins({ force: true });
    assert.equal(cors.originAllowed('https://peer.example'), true);
  });

  it('обработчик пропускает запрос без Origin, принимает статический Tauri и отвергает opaque null', () => {
    // Ловит превращение CORS в проверку подлинности для серверных клиентов и потерю desktop-оболочки.
    const cors = createCorsOrigins({ now: () => 0, readOrigins: async () => [], staticOrigins: ['tauri://localhost'] });
    const checks: Array<[string | undefined, boolean]> = [[undefined, true], ['tauri://localhost', true], ['null', false]];
    for (const [origin, expected] of checks) {
      let actual: boolean | undefined;
      cors.corsOriginCheck(origin, (error, allow) => { assert.equal(error, null); actual = allow; });
      assert.equal(actual, expected, String(origin));
    }
  });
});
