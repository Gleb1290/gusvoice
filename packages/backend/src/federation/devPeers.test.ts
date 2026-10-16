import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { isBlockedAddress } from '../safeFetch.js';
import { devPeersProblem, parseDevPeers } from './devPeers.js';

type Dev = typeof import('./devPeers.js');
type Safe = typeof import('../safeFetch.js');
const source = readFileSync(new URL('./devPeers.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const safeSource = readFileSync(new URL('../safeFetch.ts', import.meta.url), 'utf8');
const base = { hosts: ['localhost:4300'], nodeEnv: 'test', publicApiUrl: 'http://localhost:4200',
  isIp: (value: string) => isIP(value) !== 0, isLocalIp: isBlockedAddress };

function load<T>(raw: string, deps: Record<string, unknown> = {}): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText, { module, exports: module.exports, URL, Buffer, setTimeout, clearTimeout,
    console: { warn() {} }, require: (id: string) => {
      assert.equal(Object.hasOwn(deps, id), true, `явная граница ${id}`); return deps[id];
    } });
  return module.exports as T;
}

it('R187 пустой список режима стенда не добавляет предохранителей обычному запуску', () => {
  // Класс ошибки: новая опция мешает обычному прод-запуску, хотя режим стенда не включён.
  assert.deepEqual(parseDevPeers(undefined), []); assert.deepEqual(parseDevPeers(' , , '), []);
  assert.equal(devPeersProblem({ ...base, hosts: [], nodeEnv: 'production', publicApiUrl: 'https://public.example' }), null);
});

it('R187 список стенда нормализует URL и регистр, убирает дубли и сохраняет порт', () => {
  // Класс ошибки: одни и те же адреса из конфигурации расходятся с URL фактического запроса.
  assert.deepEqual(parseDevPeers(' LOCALHOST:4300, http://localhost:4300/api, https://[::1]:4400/path, , localhost:4301 '),
    ['localhost:4300', '[::1]:4400', 'localhost:4301']);
});

it('R187 непубличный режим принимает localhost, местные IP и IPv6 с местным API', () => {
  // Класс ошибки: чрезмерный отказ делает стенд из двух локальных бэкендов невозможным.
  for (const host of ['localhost:4300', '127.0.0.1:4300', '[::1]:4300', '192.168.0.10:4300']) {
    assert.equal(devPeersProblem({ ...base, hosts: [host], publicApiUrl: `http://${host}/api` }), null);
  }
  assert.equal(devPeersProblem({ ...base, nodeEnv: undefined, publicApiUrl: '' }), null);
});

function productionGuard(fn: Dev['devPeersProblem']) {
  assert.equal(fn(base), null, 'непроизводственный стенд принимается');
  assert.match(fn({ ...base, nodeEnv: 'production' }) ?? '', /NODE_ENV=production/, 'прод не включает режим стенда');
}
it('R187 production отвергает непустой режим стенда, даже если все адреса местные', () => {
  // Класс ошибки: локальное исключение фильтра адресов случайно активируется в образе прода.
  productionGuard(devPeersProblem);
});

it('R187 публичный или битый PUBLIC_API_URL отвергается, местный API принимается', () => {
  // Класс ошибки: доступный из интернета инстанс ошибочно получает послабление стенда.
  assert.equal(devPeersProblem(base), null);
  for (const publicApiUrl of ['https://public.example/api', 'http://8.8.8.8:4200', 'not a URL']) {
    assert.match(devPeersProblem({ ...base, publicApiUrl }) ?? '', /PUBLIC_API_URL/);
  }
});

it('R187 неместный хост в списке отвергается даже рядом с корректным localhost', () => {
  // Класс ошибки: один разрешённый сосед легализует весь список либо произвольное DNS-имя.
  assert.equal(devPeersProblem(base), null);
  for (const host of ['peer.example:4300', '8.8.8.8:4300', 'not a host']) {
    assert.match(devPeersProblem({ ...base, hosts: [...base.hosts, host] }) ?? '', /не местный адрес/);
  }
});

it('R187 исключение привязано к точному хосту с портом и исчезает после выключения', () => {
  // Класс ошибки: послабление распространяется на другой порт либо остаётся после смены настройки.
  const dev = load<Dev>(source);
  assert.equal(dev.isDevPeerHost('localhost:4300'), false); assert.equal(dev.peerScheme('localhost:4300'), 'https');
  dev.configureDevPeers(['LOCALHOST:4300']);
  assert.equal(dev.isDevPeerHost('localhost:4300'), true); assert.equal(dev.peerScheme('LOCALHOST:4300'), 'http');
  for (const host of ['localhost', 'localhost:4301', 'other.localhost:4300', '127.0.0.1:4300']) {
    assert.equal(dev.isDevPeerHost(host), false); assert.equal(dev.peerScheme(host), 'https');
  }
  dev.configureDevPeers([]);
  assert.equal(dev.isDevPeerHost('localhost:4300'), false); assert.equal(dev.peerScheme('localhost:4300'), 'https');
});

interface RequestOptions { hostname: string; protocol: string; lookup: Lookup }
type Lookup = (host: string, options: { all: true }, callback: (error: Error | null, rows?: { address: string; family: number }[]) => void) => void;
function transport(hosts: string[]) {
  const dev = load<Dev>(source); dev.configureDevPeers(hosts);
  const calls: RequestOptions[] = [];
  // Явная граница DNS/сокета: адрес возвращается из фикстуры, сеть и слушающий порт не создаются.
  const lookup: Lookup = (_host, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]);
  const request = (options: RequestOptions) => {
    calls.push(options); const req = new EventEmitter();
    return Object.assign(req, {
      destroy(error?: Error) { if (error) req.emit('error', error); },
      end() {
        const respond = () => {
          const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-type': 'application/json' }, destroy() {} });
          req.emit('response', res); res.emit('data', Buffer.from('{}')); res.emit('end');
        };
        if (isIP(options.hostname.replace(/^\[|\]$/g, ''))) respond();
        else options.lookup(options.hostname, { all: true }, error => { if (error) req.emit('error', error); else respond(); });
      },
    });
  };
  const safe = load<Safe>(safeSource, { 'node:dns': { lookup }, 'node:http': { request }, 'node:https': { request },
    'node:net': { isIP }, './federation/devPeers.js': dev });
  const peer = (url: string) => safe.safePeerRequest({ method: 'GET', url, allowHosts: new Set([new URL(url).host]) });
  return { safe, peer, calls, lookup };
}

it('R187 настоящий safePeerRequest разрешает http и loopback только перечисленным соседям', async () => {
  // Класс ошибки: режим включён, но проводка в транспорт оставляет старый отказ http/локальному адресу.
  const t = transport(['localhost:4300', '127.0.0.1:4300', '[::1]:4300']);
  for (const host of ['localhost:4300', '127.0.0.1:4300', '[::1]:4300']) {
    assert.equal((await t.peer(`http://${host}/api/fed/v1/instance`)).status, 200);
    assert.equal(t.calls.at(-1)?.lookup, t.lookup, 'для перечисленного соседа используется явный DNS');
  }
  assert.equal(t.calls.length, 3);
});

it('R187 http неперечисленного порта отвергается до создания запроса', async () => {
  // Класс ошибки: разрешение для localhost:4300 случайно снимает проверку схемы для всех соседей.
  const t = transport(['localhost:4300']);
  await assert.rejects(t.peer('http://localhost:4301/api/fed/v1/instance'), t.safe.BlockedTargetError);
  assert.equal(t.calls.length, 0);
});

it('R187 https к неперечисленному loopback-литералу остаётся запрещён до транспорта', async () => {
  // Класс ошибки: режим стенда снимает проверку готового IP даже вне своего списка.
  const t = transport(['localhost:4300']);
  await assert.rejects(t.peer('https://127.0.0.1:4301/api/fed/v1/instance'), t.safe.BlockedTargetError);
  assert.equal(t.calls.length, 0);
});

it('R187 неперечисленное имя использует защищённый DNS и не принимает loopback-ответ', async () => {
  // Класс ошибки: исключение в резолвере распространяется на обычную связку и открывает локальную сеть.
  const t = transport(['localhost:4300']);
  await assert.rejects(t.peer('https://peer.example/api/fed/v1/instance'), t.safe.BlockedTargetError);
  assert.equal(t.calls.length, 1); assert.notEqual(t.calls[0].lookup, t.lookup, 'обычная связка остаётся на safeLookup');
});

it('R187 пользовательский предпросмотр ссылки не заимствует исключение федеративного стенда', async () => {
  // Класс ошибки: разрешённый сосед делает пользовательские ссылки на loopback доступными серверу.
  const t = transport(['127.0.0.1:4300']);
  await assert.rejects(t.safe.safeFetchPage('http://127.0.0.1:4300/private'), t.safe.BlockedTargetError);
  assert.equal(t.calls.length, 0);
});

it('R187 контрфакт игнорирования NODE_ENV обнаруживается предохранителем настоящего модуля', () => {
  // Класс ошибки: зелёный список местных адресов маскирует потерю обязательного отказа на production.
  productionGuard(load<Dev>(source).devPeersProblem);
  const anchor = "if (input.nodeEnv === 'production') return 'FEDERATION_DEV_PEERS задан при NODE_ENV=production — режим стенда на проде запрещён';";
  assert.equal(source.split(anchor).length - 1, 1, 'единственный предохранитель production');
  const mutant = load<Dev>(source.replace(anchor, 'if (false) return null;'));
  assert.throws(() => productionGuard(mutant.devPeersProblem), error => error instanceof assert.AssertionError && error.message.includes('прод не включает режим стенда'));
});
