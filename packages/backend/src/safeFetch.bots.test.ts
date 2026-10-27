import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { hookAddressBlocked, hookUrlErrorEn, isNeverTargetAddress, parseHookUrl } from './safeFetch.js';

const source = readFileSync(new URL('./safeFetch.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Api = typeof import('./safeFetch.js');
type Scenario = { addresses?: string[]; status?: number; chunks?: Buffer[]; hang?: boolean; partial?: boolean; dnsError?: Error };

// Весь safeFetch, включая hookLookup/once. Никаких настоящих HTTP/DNS, скопированных правил или testLookup,
// который намеренно заменил бы проверяющий resolver целиком.
function transport(raw = source, scenario: Scenario = {}) {
  const requests: Array<{ options: Record<string, unknown>; body?: unknown; address?: string }> = [];
  const lookups: Array<{ hostname: string; all: boolean }> = [];
  const timers = new Map<number, { ms: number; callback: () => void }>();
  const unexpected: string[] = [];
  let timerId = 0, destroyed = 0;
  const request = (options: Record<string, unknown>) => {
    const entry: typeof requests[number] = { options };
    requests.push(entry);
    const req = new EventEmitter() as EventEmitter & { end(body?: unknown): void; destroy(error: Error): void };
    let response: EventEmitter | undefined;
    req.destroy = error => {
      destroyed++;
      // Закрытие частичного ответа может прийти раньше ошибки запроса: finish не должен вернуть обрывок с 200.
      if (scenario.partial) response?.emit('close');
      req.emit('error', error);
    };
    req.end = body => {
      entry.body = body;
      const ready = (error: Error | null, address?: string) => {
        if (error) { req.emit('error', error); return; }
        entry.address = address;
        if (scenario.hang) return;
        const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; destroy(): void };
        response = res;
        res.statusCode = requests.length === 1 ? scenario.status ?? 200 : 200;
        res.headers = { 'content-type': 'text/plain', location: 'https://next.example.invalid/target' };
        let closed = false;
        res.destroy = () => { closed = true; res.emit('close'); };
        req.emit('response', res);
        for (const chunk of scenario.chunks ?? [Buffer.from('ok')]) {
          if (closed) break;
          res.emit('data', chunk);
        }
        if (!closed && !scenario.partial) res.emit('end');
      };
      const hostname = String(options.hostname).replace(/^\[|\]$/g, '');
      if (isIP(hostname)) ready(null, hostname);
      else (options.lookup as (host: string, opts: { all: boolean }, cb: typeof ready) => void)(hostname, { all: false }, ready);
    };
    return req;
  };
  const deps: Record<string, unknown> = {
    'node:dns': { lookup: (hostname: string, options: { all: boolean }, callback: (error: Error | null, addresses?: Array<{ address: string; family: number }>) => void) => {
      lookups.push({ hostname, all: options.all });
      callback(scenario.dnsError ?? null, (scenario.addresses ?? ['8.8.8.8']).map(address => ({ address, family: isIP(address) })));
    } },
    'node:http': { request }, 'node:https': { request }, 'node:net': { isIP },
    './federation/devPeers.js': { isDevPeerHost: () => false },
  };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, URL, Buffer, Error,
    require: (id: string) => { if (!Object.hasOwn(deps, id)) unexpected.push(id); assert.ok(Object.hasOwn(deps, id), `явная граница ${id}`); return deps[id]; },
    setTimeout: (callback: () => void, ms: number) => { const id = ++timerId; timers.set(id, { ms, callback }); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
  });
  return { api: module.exports as Api, requests, lookups, timers, destroyed: () => destroyed,
    checkIO: () => assert.deepEqual(unexpected, [], 'нет скрытого выхода за границы HTTP/DNS-харнесса') };
}

const url = 'https://delivery.example.invalid/hook?kind=bot';
const opts = { allowInternal: false, maxBytes: 4096, deadlineMs: 10_000 };
const payload = Buffer.from('{"text":"Перо"}', 'utf8');
function change(from: string, to: string, raw = source) {
  assert.equal(raw.split(from).length - 1, 1, 'адресный якорь целого safeFetch уникален');
  return raw.replace(from, to);
}
function guardFailure(error: unknown, label: string, actual: unknown, expected: unknown) {
  return error instanceof assert.AssertionError && error.code === 'ERR_ASSERTION'
    && error.message.split(/\r?\n/, 1)[0] === label && error.operator === 'strictEqual'
    && error.actual === actual && error.expected === expected;
}

it('R300 все причины отказа адреса имеют английскую пару для setWebhook', () => {
  for (const [ru, en] of [
    ['адрес не разобран', 'invalid URL'], ['нужен адрес https://', 'an HTTPS URL is required'],
    ['нужен адрес https:// или http://', 'an HTTPS or HTTP URL is required'],
    ['логин и пароль в адресе не принимаются', 'credentials in the URL are not allowed'],
    ['в адресе нет хоста', 'the URL has no host'],
    ['адрес внутренний — доставка туда запрещена', 'internal addresses are not allowed'],
    ['имя хоста не резолвится', 'failed to resolve host'],
  ]) {
    assert.equal(hookUrlErrorEn(ru), en); assert.doesNotMatch(hookUrlErrorEn(ru), /[А-Яа-яЁё]/);
  }
  assert.equal(hookUrlErrorEn('already English'), 'already English');
});

it('R300 реальные parse/DNS отказы переводятся, допустимый адрес остаётся без ошибки', async () => {
  for (const [target, en] of [
    ['not a URL', 'invalid URL'], ['http://delivery.example.invalid', 'an HTTPS URL is required'],
    ['https://user:pass@delivery.example.invalid', 'credentials in the URL are not allowed'],
    ['https://127.0.0.1', 'internal addresses are not allowed'],
  ]) {
    const result = parseHookUrl(target, false); assert.equal(result.ok, false);
    if (result.ok) assert.fail('ожидался отказ адреса');
    assert.equal(hookUrlErrorEn(result.error), en);
  }
  const blocked = transport(source, { addresses: ['8.8.8.8', '127.0.0.1'] });
  assert.equal(hookUrlErrorEn((await blocked.api.checkHookTarget(url, false))!), 'internal addresses are not allowed');
  const failed = transport(source, { dnsError: new Error('synthetic DNS failure') });
  assert.equal(hookUrlErrorEn((await failed.api.checkHookTarget(url, false))!), 'failed to resolve host');
  const accepted = transport(); assert.equal(await accepted.api.checkHookTarget(url, false), null);
  blocked.checkIO(); failed.checkIO(); accepted.checkIO();
});

it('R297 метаданные, unspecified и multicast запрещены даже при разрешённых внутренних адресах', () => {
  for (const ip of ['169.254.169.254', '::ffff:a9fe:a9fe', '0.0.0.0', '224.0.0.1', 'fd00:ec2::254', '::', 'fe80::1', 'ff02::1']) {
    assert.equal(isNeverTargetAddress(ip), true, ip);
    for (const allow of [false, true]) assert.equal(hookAddressBlocked(ip, allow), true, `${ip}, allow=${allow}`);
  }
  for (const ip of ['8.8.8.8', '2606:4700::1111', '192.168.2.1']) assert.equal(isNeverTargetAddress(ip), false, ip);
});

it('R303 loopback запрещён всегда, локальная сеть требует тумблера, публичный адрес проходит в обоих режимах', () => {
  for (const ip of ['127.0.0.0', '127.0.0.1', '127.255.255.255', '::1', '::ffff:127.0.0.1', '::ffff:7fff:ffff', '::127.0.0.1', '::7f00:1']) {
    assert.equal(isNeverTargetAddress(ip), true, ip);
    for (const allow of [false, true]) assert.equal(hookAddressBlocked(ip, allow), true, ip);
  }
  for (const ip of ['192.168.2.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', 'fc00::1', 'fdff::1']) {
    assert.equal(hookAddressBlocked(ip, false), true, ip);
    assert.equal(hookAddressBlocked(ip, true), false, ip);
  }
  for (const allow of [false, true]) assert.equal(hookAddressBlocked('8.8.8.8', allow), false);
});

it('R297 URL допускает HTTPS и HTTP только с тумблером, userinfo и чужие схемы отсекаются', () => {
  assert.equal(parseHookUrl(url, false).ok, true);
  assert.equal(parseHookUrl('http://delivery.example.invalid/', false).ok, false);
  assert.equal(parseHookUrl('http://delivery.example.invalid/', true).ok, true);
  for (const allow of [false, true]) {
    for (const target of ['https://user:pass@delivery.example.invalid/', 'https://user@delivery.example.invalid/', 'ftp://delivery.example.invalid/', 'not a url']) {
      assert.equal(parseHookUrl(target, allow).ok, false, target);
    }
  }
});

it('R297 IP-литералы не обходят фильтр отсутствием DNS-вызова', () => {
  for (const allow of [false, true]) {
    for (const target of ['https://169.254.169.254/', 'https://[::ffff:a9fe:a9fe]/', 'https://[fd00:ec2::254]/']) {
      assert.equal(parseHookUrl(target, allow).ok, false, target);
    }
  }
  assert.equal(parseHookUrl('http://127.0.0.1/', true).ok, false);
  assert.equal(parseHookUrl('http://192.168.2.1/', true).ok, true);
  assert.equal(parseHookUrl('https://127.0.0.1/', false).ok, false);
  assert.equal(parseHookUrl('https://8.8.8.8/', false).ok, true);
});

it('R297 DNS проверяет все адреса, включая внутренний вторым, и не соединяется при проверке setWebhook', async () => {
  for (const addresses of [['8.8.8.8', '127.0.0.1'], ['127.0.0.1', '8.8.8.8']]) {
    const h = transport(source, { addresses });
    assert.notEqual(await h.api.checkHookTarget(url, false), null);
    assert.deepEqual(h.lookups, [{ hostname: 'delivery.example.invalid', all: true }]);
    assert.equal(h.requests.length, 0);
    h.checkIO();
  }
  for (const [addresses, allowInternal, accepted] of [
    [['8.8.8.8', '1.1.1.1'], false, true], [['8.8.8.8', '127.0.0.1'], true, false],
    [['8.8.8.8', '192.168.2.1'], true, true],
    [['8.8.8.8', '169.254.169.254'], true, false], [[], false, false],
  ] as const) {
    const h = transport(source, { addresses: [...addresses] });
    assert.equal((await h.api.checkHookTarget(url, allowInternal)) === null, accepted);
    h.checkIO();
  }
  const failed = transport(source, { dnsError: new Error('no DNS') });
  assert.equal(await failed.api.checkHookTarget(url, false), 'имя хоста не резолвится');
  failed.checkIO();
});

it('R297 POST соединяется с проверенным адресом и передаёт точные UTF-8 байты и Content-Length', async () => {
  const h = transport(source, { addresses: ['8.8.8.8', '1.1.1.1'] });
  const result = await h.api.safeHookPost(url, payload, { 'x-signature': 'test-signature' }, opts);
  assert.equal(result.status, 200);
  assert.equal(result.body, 'ok');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].address, '8.8.8.8');
  assert.equal(h.requests[0].options.method, 'POST');
  assert.equal(h.requests[0].options.path, '/hook?kind=bot');
  assert.equal((h.requests[0].options.headers as Record<string, string>)['content-length'], String(payload.length));
  assert.equal(h.requests[0].body, payload);
  assert.deepEqual(h.lookups, [{ hostname: 'delivery.example.invalid', all: true }]);
  assert.equal(h.timers.size, 0, 'успех снимает срок');
  h.checkIO();
  const blocked = transport(source, { addresses: ['8.8.8.8', '127.0.0.1'] });
  await assert.rejects(blocked.api.safeHookPost(url, payload, {}, opts),
    error => error instanceof blocked.api.BlockedTargetError);
  assert.equal(blocked.requests[0].address, undefined, 'доставка не подключается к имени с внутренним адресом');
  assert.equal(blocked.timers.size, 0);
  blocked.checkIO();
});

it('R297 3xx возвращается доставщику, но ни байты, ни подпись не уходят на Location', async () => {
  for (const status of [301, 302, 307, 308]) {
    const h = transport(source, { status });
    const result = await h.api.safeHookPost(url, payload, { 'x-signature': 'test-signature' }, opts);
    assert.equal(result.status, status);
    assert.equal(h.requests.length, 1, 'R297-hook-без-редиректа');
    h.checkIO();
  }
});

it('R297 4096 байт ответа допустимы, следующий байт обрезает чтение, не превращая 2xx в ошибку', async () => {
  for (const size of [4095, 4096, 4097]) {
    const first = Math.min(size, 4096);
    const chunks = [Buffer.alloc(first, 'a'), ...(size > first ? [Buffer.from('z')] : [])];
    const h = transport(source, { chunks });
    const result = await h.api.safeHookPost(url, payload, {}, opts);
    assert.equal(result.status, 200);
    assert.equal(result.body, 'a'.repeat(first));
    assert.equal(h.timers.size, 0);
    h.checkIO();
  }
});

it('R297 общий срок рвёт зависший POST через 10000 мс и не выдаёт половинный успех', async () => {
  for (const scenario of [{ hang: true }, { partial: true, chunks: [Buffer.from('пол-ответа')] }]) {
    const h = transport(source, scenario);
    const pending = h.api.safeHookPost(url, payload, {}, opts);
    const denied = assert.rejects(pending, (error: unknown) => error instanceof Error && error.message === 'срок запроса истёк (10000 мс)');
    assert.equal(h.timers.size, 1);
    const timer = [...h.timers.values()][0];
    assert.equal(timer.ms, 10_000);
    timer.callback();
    await denied;
    assert.equal(h.destroyed(), 1);
    assert.equal(h.timers.size, 0);
    h.checkIO();
  }
});

it('R297 контрфакт только первого DNS-адреса пропускает внутренний второй', async () => {
  const scenario = async (raw: string) => {
    const h = transport(raw, { addresses: ['8.8.8.8', '127.0.0.1'] });
    const error = await h.api.checkHookTarget(url, false);
    h.checkIO();
    assert.equal(error !== null, true, 'R297-hook-все-DNS-адреса');
  };
  await scenario(source);
  const mutant = change('const bad = list.find((a) => hookAddressBlocked(a.address, allowInternal));',
    'const bad = list.slice(0, 1).find((a) => hookAddressBlocked(a.address, allowInternal));');
  await assert.rejects(scenario(mutant), error => guardFailure(error, 'R297-hook-все-DNS-адреса', false, true));
});

it('R297 контрфакт внутреннего тумблера без never-списка открывает адрес метаданных', () => {
  const scenario = (raw: string) => {
    const h = transport(raw);
    assert.equal(h.api.hookAddressBlocked('169.254.169.254', true), true, 'R297-hook-never-сильнее-тумблера');
    h.checkIO();
  };
  scenario(source);
  const mutant = change('return allowInternal ? isNeverTargetAddress(ip) : isBlockedAddress(ip);',
    'return allowInternal ? false : isBlockedAddress(ip);');
  assert.throws(() => scenario(mutant), error => guardFailure(error, 'R297-hook-never-сильнее-тумблера', false, true));
});

it('R303 контрфакт старого разрешения loopback при тумблере ловится отдельно от LAN', () => {
  const check = (raw: string) => {
    const h = transport(raw);
    assert.equal(h.api.hookAddressBlocked('127.1.2.3', true), true, 'R303 loopback закрыт при разрешённой LAN');
    assert.equal(h.api.hookAddressBlocked('192.168.1.2', true), false);
    h.checkIO();
  };
  check(source);
  const changed = change("const NEVER_V4 = ['0.0.0.0/8', '127.0.0.0/8',", "const NEVER_V4 = ['0.0.0.0/8',");
  assert.throws(() => check(changed), error => guardFailure(error, 'R303 loopback закрыт при разрешённой LAN', false, true));
});

it('R297 контрфакт следования Location ловится вторым POST, а не посторонней ошибкой транспорта', async () => {
  const scenario = async (raw: string) => {
    const h = transport(raw, { status: 307 });
    await h.api.safeHookPost(url, payload, {}, opts);
    h.checkIO();
    assert.equal(h.requests.length, 1, 'R297-hook-без-редиректа');
  };
  await scenario(source);
  const mutant = change('  return { status: res.status, body: res.body };\n}',
    `  if (res.status >= 300 && res.status < 400 && res.location) {
    const next = await once(new URL(res.location, parsed.url), headers, testLookup ?? hookLookup(opts.allowInternal), {
      method: 'POST', body, maxBytes: opts.maxBytes, deadlineMs: opts.deadlineMs,
    });
    return { status: next.status, body: next.body };
  }
  return { status: res.status, body: res.body };
}`);
  await assert.rejects(scenario(mutant), error => guardFailure(error, 'R297-hook-без-редиректа', 2, 1));
});
