import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, describe, it } from 'node:test';
import {
  assertPeerTarget,
  BlockedTargetError,
  chooseLookupResult,
  isBlockedAddress,
  PEER_MAX_BYTES,
  resolveRedirect,
  safeFetchPage,
  safePeerRequest,
} from './safeFetch.js';

/**
 * Тесты фильтра SSRF. Гоняются `pnpm --filter @gusvoice/backend test`.
 *
 * Это не формальность: оба серьёзных прокола в этом файле нашлись ИМЕННО прогоном, а чтением кода
 * не видны совсем.
 *  1. IP-литерал в URL (`http://127.0.0.1`) шёл мимо проверки: `net.connect` видит готовый адрес
 *     и не зовёт резолвер, в котором вся защита и сидела. По имени блокировалось, по адресу — нет.
 *  2. `new URL()` ПЕРЕПИСЫВАЕТ запись адреса: `[::ffff:192.168.1.44]` → `[::ffff:c0a8:12c]`.
 *     Проверка по образцу «::ffff:1.2.3.4» такой адрес пропускала.
 * Отсюда правило: добавляя форму записи или диапазон — сначала кейс сюда, потом код.
 */

describe('классификация адресов', () => {
  const блок: [string, string][] = [
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'весь 127/8'],
    ['0.0.0.0', 'этот хост'],
    ['10.0.0.1', 'приватная 10/8'],
    ['172.16.0.1', 'начало 172.16/12'],
    ['172.31.255.255', 'конец 172.16/12'],
    ['192.168.1.100', 'гипервизор в домашней сети'],
    ['192.168.1.44', 'S3 в домашней сети'],
    ['169.254.169.254', 'метаданные облака'],
    ['100.64.0.1', 'CGNAT'],
    ['100.64.0.0', 'начало CGNAT'],
    ['100.127.255.255', 'конец CGNAT'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['198.18.0.1', 'benchmark'],
    ['::1', 'loopback v6'],
    ['::', 'unspecified v6'],
    ['::ffff:192.168.1.100', 'v4-mapped через точки'],
    ['::ffff:c0a8:164', 'v4-mapped в hex — форма после new URL()'],
    ['::ffff:7f00:1', 'v4-mapped loopback в hex'],
    ['::192.168.1.100', 'v4-compatible'],
    ['fc00::1', 'unique-local'],
    ['fd12:3456:789a::1', 'unique-local'],
    ['fe80::1', 'link-local'],
    ['fe80::1%eth0', 'link-local с zone id'],
    ['ff02::1', 'multicast v6'],
    ['2002:c0a8:0164::', '6to4 с приватным v4'],
    ['64:ff9b::c0a8:164', 'NAT64 с приватным v4'],
    ['мусор', 'не адрес'],
    ['', 'пусто'],
  ];
  for (const [ip, что] of блок) {
    it(`блокирует ${ip} (${что})`, () => assert.equal(isBlockedAddress(ip), true));
  }

  const пропуск: [string, string][] = [
    ['8.8.8.8', 'публичный'],
    ['1.1.1.1', 'публичный'],
    ['172.15.0.1', 'вплотную ПЕРЕД 172.16/12'],
    ['172.32.0.1', 'вплотную ПОСЛЕ 172.16/12'],
    ['9.255.255.255', 'вплотную до 10/8'],
    ['11.0.0.1', 'вплотную после 10/8'],
    ['126.255.255.255', 'до 127/8'],
    ['128.0.0.1', 'после 127/8'],
    ['169.253.255.255', 'до link-local'],
    ['169.255.0.1', 'после link-local'],
    ['100.63.255.255', 'вплотную до CGNAT'],
    ['100.128.0.0', 'вплотную после CGNAT'],
    ['192.167.255.255', 'до 192.168/16'],
    ['192.169.0.1', 'после 192.168/16'],
    ['2606:4700::1111', 'публичный v6'],
    ['2a00:1450::1', 'публичный v6'],
  ];
  for (const [ip, что] of пропуск) {
    it(`пропускает ${ip} (${что})`, () => assert.equal(isBlockedAddress(ip), false));
  }
});

describe('цель редиректа', () => {
  const base = new URL('https://example.com/article');
  const отбить = [
    ['http://192.168.1.100:8006/', 'внутренний сервис'],
    ['http://127.0.0.1:9000/', 'loopback'],
    ['http://169.254.169.254/latest/meta-data/', 'метаданные облака'],
    ['http://[::1]:8006/', 'loopback v6'],
    ['http://[::ffff:192.168.1.44]/', 'v4-mapped приватный'],
    ['//192.168.1.100:8006/', 'без схемы — наследует протокол базы'],
    ['file:///etc/passwd', 'file'],
    ['gopher://127.0.0.1:11211/', 'gopher (атака на memcached)'],
    ['javascript:alert(1)', 'javascript'],
  ];
  for (const [loc, что] of отбить) {
    it(`отбивает ${что}`, () => assert.throws(() => resolveRedirect(loc, base), BlockedTargetError));
  }
  it('пропускает внешний хост', () =>
    assert.equal(resolveRedirect('https://other.example.org/p', base).host, 'other.example.org'));
  it('пропускает относительный путь', () =>
    assert.equal(resolveRedirect('/p', base).toString(), 'https://example.com/p'));
});

describe('живой запрос', () => {
  const srv = createServer((_q, s) => {
    s.writeHead(200, { 'content-type': 'text/html' });
    s.end('<html><head><title>внутренний сервис</title></head></html>');
  });
  after(() => srv.close());

  it('не достукивается до локального сервера ни в одной записи адреса', async () => {
    await new Promise<void>((r) => srv.listen(8975, '127.0.0.1', r));
    for (const url of ['http://127.0.0.1:8975/', 'http://localhost:8975/', 'http://[::1]:8975/']) {
      await assert.rejects(() => safeFetchPage(url), BlockedTargetError, `утекло через ${url}`);
    }
  });

  it('отбивает нерелевантные схемы', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://x/', 'ftp://x/']) {
      await assert.rejects(() => safeFetchPage(url), BlockedTargetError);
    }
  });

  it('отбивает строку, которая вообще не является URL', async () => {
    await assert.rejects(() => safeFetchPage('не URL'), BlockedTargetError);
  });
});

describe('форма ответа резолвера', () => {
  const list = [
    { address: '140.82.121.4', family: 4 },
    { address: '2606:50c0::1', family: 6 },
  ];

  it('при all: true отдаёт МАССИВ', () => {
    // Node 20+ включает Happy Eyeballs и зовёт lookup с all: true. Вернёшь строку — получишь
    // ERR_INVALID_IP_ADDRESS на КАЖДОМ запросе, то есть тихо мёртвый предпросмотр.
    const r = chooseLookupResult(list, true);
    assert.deepEqual(r, { all: list });
  });

  it('при all: false отдаёт адрес и семейство', () => {
    assert.deepEqual(chooseLookupResult(list, false), { address: '140.82.121.4', family: 4 });
  });

  it('пустой список — это отказ, а не пустой ответ', () => {
    assert.equal(chooseLookupResult([], true), null);
    assert.equal(chooseLookupResult([], false), null);
  });
});

describe('успешный путь', () => {
  // Ради этого блока и заведён подменный резолвер: любой адрес, который можно поднять в тесте, —
  // loopback, а его фильтр обязан блокировать. Без этого блока все проверки касались только
  // ОТКАЗОВ, и полная неработоспособность прошла мимо зелёного прогона.
  const permissive = ((host: string, options: unknown, cb: unknown) => {
    const opts = (typeof options === 'function' ? {} : ((options ?? {}) as { all?: boolean })) ?? {};
    const done = (typeof options === 'function' ? options : cb) as (
      e: unknown,
      a?: unknown,
      f?: number,
    ) => void;
    const one = { address: '127.0.0.1', family: 4 };
    return opts.all === true ? done(null, [one]) : done(null, one.address, one.family);
  }) as typeof import('node:dns').lookup;

  let port = 0;
  const srv = createServer((q, s) => {
    if (q.url === '/redirect') {
      s.writeHead(302, { location: `http://127.0.0.1:${port}/target` });
      return s.end();
    }
    if (q.url === '/huge') {
      s.writeHead(200, { 'content-type': 'text/html' });
      s.write('<html><head><title>начало</title></head>');
      return s.end('x'.repeat(400 * 1024)); // больше лимита в 256КБ
    }
    if (q.url === '/loop') {
      s.writeHead(302, { location: `http://127.0.0.1:${port}/loop` });
      return s.end();
    }
    s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    s.end('<html><head><title>привет</title></head><body>тело</body></html>');
  });
  after(() => srv.close());

  it('отдаёт тело и content-type', async () => {
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    port = (srv.address() as { port: number }).port;
    const res = await safeFetchPage(`http://127.0.0.1:${port}/`, permissive);
    assert.equal(res.status, 200);
    assert.match(res.contentType, /text\/html/);
    assert.match(res.body, /привет/);
  });

  it('идёт по редиректу', async () => {
    const res = await safeFetchPage(`http://127.0.0.1:${port}/redirect`, permissive);
    assert.match(res.body, /привет/);
    assert.match(res.url, /\/target$/);
  });

  it('обрезает большое тело, но начало страницы сохраняет', async () => {
    const res = await safeFetchPage(`http://127.0.0.1:${port}/huge`, permissive);
    assert.ok(res.body.length <= 256 * 1024 + 64 * 1024, `получено ${res.body.length}`);
    assert.match(res.body, /начало/);
  });

  it('четвёртый редирект отклоняется, а не превращается в бесконечный обход', async () => {
    await assert.rejects(
      () => safeFetchPage(`http://127.0.0.1:${port}/loop`, permissive),
      /слишком много редиректов/,
    );
  });
});

describe('запросы к соседнему инстансу (F0, #139)', () => {
  const allow = new Set(['voice.friend.example']);

  it('хост не из списка связок отбивается до сети', () => {
    // Ловит список, который не проверяется: документ соседа направил бы наш бэкенд куда угодно.
    assert.throws(() => assertPeerTarget('https://evil.example/fed', allow), BlockedTargetError);
    assert.ok(assertPeerTarget('https://VOICE.friend.example/fed', allow) instanceof URL);
  });

  it('регистр хоста в списке связок не влияет на допуск', () => {
    // Ловит одностороннюю нормализацию: сохранённый владельцем VOICE.EXAMPLE иначе не совпал бы с URL.
    assert.equal(
      assertPeerTarget('https://voice.friend.example/fed', new Set(['VOICE.FRIEND.EXAMPLE'])).host,
      'voice.friend.example',
    );
  });

  it('порт — часть хоста: тот же домен на другом порту не разрешён', () => {
    // Ловит сравнение по имени без порта — обход через сервис на соседнем порту того же хоста.
    assert.throws(() => assertPeerTarget('https://voice.friend.example:8443/fed', allow), BlockedTargetError);
  });

  it('без https и с учётными данными в URL — отказ', () => {
    // Ловит открытый текст для токенов гостей и URL с чужими логином и паролем.
    assert.throws(() => assertPeerTarget('http://voice.friend.example/fed', allow), BlockedTargetError);
    assert.throws(() => assertPeerTarget('https://u:p@voice.friend.example/fed', allow), BlockedTargetError);
  });

  it('приватный адрес отбивается, даже если он в списке', async () => {
    // Ловит «в списке — значит можно»: список не отменяет защиту от походов во внутреннюю сеть.
    await assert.rejects(
      () => safePeerRequest({ method: 'GET', url: 'https://127.0.0.1/fed', allowHosts: new Set(['127.0.0.1']) }),
      BlockedTargetError,
    );
  });

  it('IPv6 loopback и IPv4-mapped loopback отбиваются, даже если они в списке', async () => {
    // Ловит обход literal-проверки альтернативной записью localhost без DNS.
    for (const [urlHost, allowedHost] of [
      ['[::1]', '[::1]'],
      ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]'], // `URL` канонизирует dotted-хвост в hex.
    ]) {
      await assert.rejects(
        () => safePeerRequest({ method: 'GET', url: `https://${urlHost}/fed`, allowHosts: new Set([allowedHost]) }),
        BlockedTargetError,
        `утекло через ${urlHost}`,
      );
    }
  });

  describe('живой запрос', () => {
    const permissive = ((host: string, options: unknown, cb: unknown) => {
      const opts = (typeof options === 'function' ? {} : ((options ?? {}) as { all?: boolean })) ?? {};
      const done = (typeof options === 'function' ? options : cb) as (e: unknown, a?: unknown, f?: number) => void;
      const one = { address: '127.0.0.1', family: 4 };
      return opts.all === true ? done(null, [one]) : done(null, one.address, one.family);
    }) as typeof import('node:dns').lookup;

    let port = 0;
    let hits: string[] = [];
    const srv = createServer((q, s) => {
      hits.push(`${q.method} ${q.url}`);
      if (q.url === '/moved') {
        s.writeHead(307, { location: `http://127.0.0.1:${port}/stolen` });
        return s.end();
      }
      if (q.url === '/huge') {
        s.writeHead(200, { 'content-type': 'application/json' });
        return s.end(JSON.stringify({ x: 'y'.repeat(PEER_MAX_BYTES + 10) }));
      }
      let body = '';
      q.on('data', (c) => (body += c));
      q.on('end', () => {
        s.writeHead(200, { 'content-type': 'application/json' });
        s.end(JSON.stringify({
          method: q.method,
          body,
          contentType: q.headers['content-type'] ?? null,
          host: q.headers.host ?? null,
          contentLength: q.headers['content-length'] ?? null,
          transferEncoding: q.headers['transfer-encoding'] ?? null,
          signature: q.headers['x-signature'] ?? null,
        }));
      });
    });
    after(() => srv.close());
    const hosts = () => new Set([`127.0.0.1:${port}`]);

    it('POST доносит метод, тело и тип', async () => {
      // Ловит «safeFetch только GET»: безопасного POST к соседу не было вовсе.
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      port = (srv.address() as { port: number }).port;
      const res = await safePeerRequest(
        { method: 'POST', url: `http://127.0.0.1:${port}/fed/v1/events`, body: '{"a":1}', allowHosts: hosts() },
        permissive,
      );
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body), {
        method: 'POST',
        body: '{"a":1}',
        contentType: 'application/json',
        host: `127.0.0.1:${port}`,
        contentLength: '7',
        transferEncoding: null,
        signature: null,
      });
    });

    it('служебные заголовки caller отбрасываются, а прикладной сохраняется', async () => {
      // Ловит подмену Host/framing соседом через headers и потерю будущей подписи федерации.
      const res = await safePeerRequest(
        {
          method: 'POST',
          url: `http://127.0.0.1:${port}/headers`,
          body: '{}',
          allowHosts: hosts(),
          headers: {
            Host: 'evil.example',
            'Content-Length': '999',
            'Transfer-Encoding': 'chunked',
            'X-Signature': 'signed',
          },
        },
        permissive,
      );
      const received = JSON.parse(res.body);
      assert.equal(received.host, `127.0.0.1:${port}`);
      assert.equal(received.contentLength, '2');
      assert.equal(received.transferEncoding, null);
      assert.equal(received.signature, 'signed');
    });

    it('POST больше предела отклоняется до первого сетевого запроса', async () => {
      // Ловит проверку размера после отправки, когда гигантское тело уже достигло соседа.
      hits = [];
      await assert.rejects(
        () => safePeerRequest(
          {
            method: 'POST',
            url: `http://127.0.0.1:${port}/oversize`,
            body: 'x'.repeat(PEER_MAX_BYTES + 1),
            allowHosts: hosts(),
          },
          permissive,
        ),
        /тело запроса больше предела/,
      );
      assert.deepEqual(hits, []);
    });

    it('GET отправляется без тела и без Content-Type', async () => {
      // Ловит превращение GET в JSON-запрос с телом, которое прокси могут трактовать неоднозначно.
      const res = await safePeerRequest(
        { method: 'GET', url: `http://127.0.0.1:${port}/read`, body: '{"ignored":true}', allowHosts: hosts() },
        permissive,
      );
      const received = JSON.parse(res.body);
      assert.equal(received.method, 'GET');
      assert.equal(received.body, '');
      assert.equal(received.contentType, null);
      assert.equal(received.contentLength, null);
    });

    it('редирект не ведётся: 307 возвращается как есть, тело не уходит по новому адресу', async () => {
      // Ловит повтор POST с токенами на адрес, куда связка не вела.
      hits = [];
      const res = await safePeerRequest(
        { method: 'POST', url: `http://127.0.0.1:${port}/moved`, body: '{"token":"t"}', allowHosts: hosts() },
        permissive,
      );
      assert.equal(res.status, 307);
      assert.deepEqual(hits, ['POST /moved']);
    });

    it('ответ больше предела — ошибка, а не обрезанный JSON', async () => {
      // Ловит молча обрезанный документ соседа, который потом разбирается как валидный.
      await assert.rejects(
        () => safePeerRequest({ method: 'GET', url: `http://127.0.0.1:${port}/huge`, allowHosts: hosts() }, permissive),
        /больше предела/,
      );
    });
  });
});
