import { counterfact } from '../../shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

type PushRules = typeof import('./pushRules.js');
type RelayRules = typeof import('./fcmRelayRules.js');
const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

// Компилируется ВЕСЬ настоящий модуль, а не копия функции: тот же harness работает в CI Node20 и без esbuild в Node24.
function wholeModule<T>(code: string, dependencies: Record<string, unknown>): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(code, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, Buffer, URL, require: (id: string) => {
    assert.ok(Object.hasOwn(dependencies, id), `закрытый импорт ${id}`);
    return dependencies[id];
  } });
  return module.exports as T;
}
const shared = {
  ...wholeModule<object>(source('../../shared/src/notifyView.ts'), {}),
  ...wholeModule<object>(source('../../shared/src/textFormat.ts'), {}),
};
const conv = wholeModule<object>(source('./convRules.ts'), { 'node:crypto': crypto });
const pushSource = source('./pushRules.ts');
const pushDeps = { '@gusvoice/shared': shared, './convRules.js': conv };
const loadPush = (code = pushSource) => wholeModule<PushRules>(code, pushDeps);
const push = loadPush();
const relaySource = source('./fcmRelayRules.ts');
const loadRelay = (code = relaySource) => wholeModule<RelayRules>(code, { 'node:crypto': crypto, './pushRules.js': push });
const relay = loadRelay();
const jsonEqual = (actual: unknown, expected: unknown) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
function changed(code: string, from: string, to: string): string {
  assert.equal(code.split(from).length, 2, `единственный якорь мутанта ${from}`);
  return code.replace(from, to);
}
const cipherBytes = (p: unknown) => Buffer.byteLength(JSON.stringify(p), 'utf8') + 103;
const target = { uid: 'reply-user', dmId: 'dm-1', key: 9001, mid: 'message-1', type: 'dm' };

describe('R330 чистые правила шлюза FCM', () => {
  const base = 'https://relay.example.test';
  const endpoint = (token = 'Abc_012:-xyz') => `${base}/api/push/fcm/${token}`;

  it('разрешает свой HTTPS origin, допустимые знаки и токены на обеих границах 1–4096', () => {
    // Излишне узкий SSRF-гард молча отключил бы настоящие устройства с длинным токеном.
    for (const token of ['a', 'Abc_012:-xyz', 'a'.repeat(4095), 'a'.repeat(4096)]) {
      assert.equal(push.fcmRelayEndpointAllowed(endpoint(token), base), true);
      assert.equal(push.validFcmToken(token), true);
    }
    assert.equal(push.fcmRelayEndpointAllowed('https://relay.example.test:443/api/push/fcm/a', `${base}/`), true);
    assert.equal(push.FCM_RELAY_BODY_MAX, 3069);
    assert.equal(push.WEB_PUSH_OVERHEAD, 103);
  });

  it('запрещает чужую сеть, user-info, лишние части URL и повреждённые токены до отправки', () => {
    // Каждый вариант — отдельный способ превратить адрес устройства в SSRF или другой маршрут.
    for (const ep of [endpoint().replace('https:', 'http:'), endpoint().replace('relay.example.test', 'evil.test'),
      endpoint().replace('relay.example.test', 'relay.example.test:8443'), `${endpoint()}?q=1`, `${endpoint()}#hash`,
      `${endpoint()}/second`, endpoint('a%2Fb'), endpoint('..'), endpoint(''), endpoint('a'.repeat(4097)),
      endpoint('кириллица'), endpoint('a.b'), endpoint('a b'), 'not a URL',
      endpoint().replace('https://', 'https://user:pass@')]) {
      assert.equal(push.fcmRelayEndpointAllowed(ep, base), false, ep.slice(0, 120));
    }
    for (const badBase of ['', `${base}/nested`, 'http://relay.example.test', 'broken'])
      assert.equal(push.fcmRelayEndpointAllowed(endpoint(), badBase), false);
    assert.equal(push.validFcmToken(''), false);
    assert.equal(push.validFcmToken('a'.repeat(4097)), false);
  });

  it('ловит снятый username-гард и сравнение origin через startsWith на настоящем модуле', () => {
    const check = (r: PushRules) => {
      assert.equal(r.fcmRelayEndpointAllowed(endpoint(), base), true);
      assert.equal(r.fcmRelayEndpointAllowed(endpoint().replace('https://', 'https://user@'), base), false);
      assert.equal(r.fcmRelayEndpointAllowed(endpoint().replace('relay.example.test', 'relay.example.test.evil.test'), base), false);
    };
    check(push);
    counterfact(() => {
      for (const [from, to] of [['ep.username || ep.password', 'ep.password'],
        ['ep.origin !== base.origin', '!ep.origin.startsWith(base.origin)']]) {
        assert.throws(() => check(loadPush(changed(pushSource, from, to))), assert.AssertionError);
      }
    });
  });

  it('приоритет HIGH дают только high и 5/max/urgent, с пробелами и первым значением заголовка', () => {
    // NORMAL для звонка задержит его; HIGH для обычного сообщения расходует квоту FCM.
    for (const urgency of ['high', ' HIGH ', [' high ', 'normal']]) assert.equal(relay.fcmAndroidPriority(urgency, undefined), 'HIGH');
    for (const priority of ['5', 'max', 'urgent', ' MAX ', ['urgent', '1']]) assert.equal(relay.fcmAndroidPriority(undefined, priority), 'HIGH');
    for (const [urgency, priority] of [[undefined, undefined], ['normal', '4'], ['highest', '6'], ['low', 'maximum'], [[], []], [['normal', 'high'], ['1', '5']]])
      assert.equal(relay.fcmAndroidPriority(urgency, priority), 'NORMAL');
  });

  it('TTL сохраняет ноль и потолок 28 суток, зажимает превышение и заменяет мусор сутками', () => {
    // Отрицательный TTL не превращается в немедленное истечение или бесконечную доставку.
    for (const [input, expected] of [['0', 0], ['1', 1], ['2419199', 2419199], ['2419200', 2419200],
      ['2419201', 2419200], ['999999999999', 2419200], [' 42 ', 42], [['7', '8'], 7]] as const)
      assert.equal(relay.fcmTtlSeconds(Array.isArray(input) ? [...input] : input as string), expected);
    for (const input of [undefined, '', '-1', 'NaN', '1.5', '1e3', 'abc', '1234567890123', []])
      assert.equal(relay.fcmTtlSeconds(input), 86400);
  });

  it('Retry-After понимает секунды и HTTP-дату, округляет вверх и не возвращает отрицательное время', () => {
    const now = Date.parse('2026-10-28T12:00:00.250Z');
    for (const [value, expected] of [['0', 0], [' 17 ', 17], ['Wed, 28 Oct 2026 12:00:02 GMT', 2],
      ['Wed, 28 Oct 2026 11:59:59 GMT', 0], ['', undefined], [null, undefined], [undefined, undefined], ['not-a-date', undefined]] as const)
      assert.equal(relay.parseRetryAfter(value, now), expected);
  });

  it('ответы FCM отличают умершее устройство от перегрузки и ошибок настройки', () => {
    // Только мёртвый токен имеет право удалить устройство; ошибка проекта/ключа обязана оставить регистрацию.
    for (const status of [200, 201, 204, 299]) jsonEqual(relay.fcmOutcome(status, null), { code: 201 });
    const error = (error: unknown) => ({ error });
    for (const [status, body] of [[404, null], [400, error({ details: [{ errorCode: 'UNREGISTERED' }] })],
      [400, error({ status: 'NOT_FOUND' })], [400, error({ status: 'INVALID_ARGUMENT', message: 'Invalid registration token' })],
      [400, error({ status: 'INVALID_ARGUMENT', details: [{ fieldViolations: [{ field: 'message.token' }] }] })],
      [400, error({ details: [{ errorCode: 'INVALID_ARGUMENT', fieldViolations: [{ field: 'message.token' }] }] })]])
      jsonEqual(relay.fcmOutcome(status as number, body), { code: 410 });
    for (const [status, body] of [[429, null], [503, null], [400, error({ details: [{ errorCode: 'QUOTA_EXCEEDED' }] })],
      [500, error({ details: [{ errorCode: 'UNAVAILABLE' }] })]])
      jsonEqual(relay.fcmOutcome(status as number, body, 0), { code: 503, retryAfter: 0 });
    for (const [status, body] of [[199, null], [300, null], [401, null], [403, error({ status: 'PERMISSION_DENIED' })],
      [400, error({ status: 'INVALID_ARGUMENT', details: [{ fieldViolations: [{ field: 'message.data' }] }] })],
      [500, 'invalid JSON'], [500, { error: { details: 'invalid' } }]])
      jsonEqual(relay.fcmOutcome(status as number, body, 12), { code: 502, retryAfter: 12 });
  });

  it('403 никогда не становится 410: контрфакт не должен стирать устройства при поломке ключа', () => {
    const check = (r: RelayRules) => assert.equal(r.fcmOutcome(403, { error: { status: 'PERMISSION_DENIED' } }).code, 502);
    check(relay);
    counterfact(() => {
      assert.throws(() => check(loadRelay(changed(relaySource, "status === 404 || err.status", "status === 404 || status === 403 || err.status"))), assert.AssertionError);
    });
  });

  it('сервисный аккаунт разбирается из base64 JSON, отсутствие каждого обязательного поля выключает шлюз', () => {
    // Это полностью вымышленные данные, настоящий ключ создаётся только в следующем тесте и не печатается.
    const data = { project_id: 'project-247', client_email: 'relay@example.test', private_key: 'TEST PRIVATE KEY ONLY' };
    const encoded = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');
    jsonEqual(relay.parseServiceAccount(` ${encoded(data)} `), { projectId: data.project_id, clientEmail: data.client_email, privateKey: data.private_key });
    for (const field of Object.keys(data)) {
      const incomplete: Record<string, unknown> = { ...data }; delete incomplete[field];
      assert.equal(relay.parseServiceAccount(encoded(incomplete)), null);
      assert.equal(relay.parseServiceAccount(encoded({ ...data, [field]: 17 })), null);
    }
    for (const raw of ['', '  ', 'not-base64', Buffer.from('{').toString('base64'), encoded(null), encoded([]),
      encoded({ ...data, project_id: 'a/b' }), encoded({ ...data, project_id: 'a'.repeat(65) }), encoded({ ...data, private_key: 'not a key' })])
      assert.equal(relay.parseServiceAccount(raw), null);
    assert.ok(relay.parseServiceAccount(encoded({ ...data, project_id: 'a'.repeat(64) })));
  });

  it('JWT действительно подписан RS256 эфемерным ключом и содержит точные OAuth-клеймы', () => {
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const now = 1_798_000_000;
    const jwt = relay.serviceAccountJwt({ projectId: 'test-project', clientEmail: 'relay@example.test', privateKey }, now);
    const parts = jwt.split('.'); assert.equal(parts.length, 3);
    assert.deepEqual(JSON.parse(Buffer.from(parts[0], 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
    assert.deepEqual(JSON.parse(Buffer.from(parts[1], 'base64url').toString()), {
      iss: 'relay@example.test', scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    });
    assert.equal(crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), keys.publicKey, Buffer.from(parts[2], 'base64url')), true);
    assert.equal(crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}x`), keys.publicKey, Buffer.from(parts[2], 'base64url')), false);
  });

  it('кеш OAuth заканчивается за 300 секунд, короткий и некорректный срок не уходит раньше now', () => {
    const now = 123_000;
    for (const [seconds, expected] of [[3600, now + 3300000], [301, now + 1000], [300, now], [299, now],
      [0, now], [-1, now], [NaN, now], [Infinity, now]]) assert.equal(relay.accessTokenValidUntil(now, seconds), expected);
  });
});

describe('R330 подгонка пуша под шифротекст 3069 байт', () => {
  const payload = { ...target, title: 'Автор', body: 'Сообщение', author: 'Автор', group: 'Группа', avatar: 'https://example.test/a' };
  const fit = push.fitPushPayload;

  it('влезающий и ровно граничный пуш сохраняют идентичность, лишний байт требует урезания', () => {
    const check = (r: PushRules) => {
      assert.equal(r.fitPushPayload(payload, 3069), payload);
      const full = { ...payload, body: 'x'.repeat(3069 - cipherBytes({ ...payload, body: '' })) };
      assert.equal(cipherBytes(full), 3069);
      assert.equal(r.fitPushPayload(full, 3069), full);
      const over = { ...full, body: full.body + 'x' };
      assert.equal(cipherBytes(over), 3070);
      assert.notEqual(r.fitPushPayload(over, 3069), over);
      assert.ok(cipherBytes(r.fitPushPayload(over, 3069)) <= 3069);
    };
    check(push);
    counterfact(() => {
      assert.throws(() => check(loadPush(changed(pushSource, 'if (size(p) <= maxCipher)', 'if (size(p) < maxCipher)'))), assert.AssertionError);
    });
  });

  it('UTF-8 кириллицы, CJK, эмодзи и JSON-escape считаются вместе с 103 байтами шифра, длина максимальна', () => {
    const check = (r: PushRules) => {
      for (const symbol of ['Ж', '漢', '🪿', '\u0001']) for (const budget of [3069, 3068, 3067, 3066, 3065]) {
        const input = { ...payload, body: symbol.repeat(4000) };
        const result = r.fitPushPayload(input, budget);
        assert.ok(cipherBytes(result) <= budget, `лимит UTF-8 ${JSON.stringify(symbol)}`);
        assert.ok(result.body.endsWith('…'));
        const kept = Array.from(result.body).slice(0, -1);
        assert.ok(kept.length >= 20);
        assert.equal(result.body, symbol.repeat(kept.length) + '…', 'целые кодовые точки');
        assert.ok(cipherBytes({ ...result, body: symbol.repeat(kept.length + 1) + '…' }) > budget, 'ещё знак не помещается');
        for (const key of Object.keys(target) as Array<keyof typeof target>) assert.equal(result[key], target[key]);
        assert.equal(input.body, symbol.repeat(4000), 'исходный объект не мутирует');
      }
      // Короткое поле не даёт UTF-16-мутанту компенсировать полпары увеличением двоичного поиска до удвоенной длины.
      const short = { ...payload, body: '🪿'.repeat(40) };
      const exact = { ...short, body: '🪿'.repeat(30) + '…' };
      assert.equal(r.fitPushPayload(short, cipherBytes(exact)).body, exact.body, '30 целых эмодзи помещаются без потери полезного текста');
      assert.equal(Buffer.byteLength(JSON.stringify('\u0001')), 8, 'управляющий знак — шесть байт плюс кавычки');
    };
    check(push);
    counterfact(() => {
      assert.throws(() => check(loadPush(changed(pushSource, 'const chars = Array.from(s);', "const chars = s.split('');"))), assert.AssertionError);
      assert.throws(() => check(loadPush(changed(pushSource, "Buffer.byteLength(JSON.stringify(x), 'utf8') + WEB_PUSH_OVERHEAD", "Buffer.byteLength(JSON.stringify(x), 'utf8')"))), assert.AssertionError);
      assert.throws(() => check(loadPush(changed(pushSource, 'if (size(at(mid)) <= maxCipher)', 'if (size(at(mid)) < maxCipher)'))), assert.AssertionError);
    });
  });

  it('урезает body затем group title author, оставляя минимум 20 точек и многоточие', () => {
    // Позднее поле нельзя резать раньше предыдущего: иначе теряется имя при ещё длинном тексте.
    const fields = ['body', 'group', 'title', 'author'] as const;
    for (let index = 0; index < fields.length; index++) {
      const input = { ...payload };
      for (let i = 0; i <= index; i++) input[fields[i]] = '漢'.repeat(2000);
      const result = fit(input, 3069);
      assert.ok(cipherBytes(result) <= 3069);
      for (let i = 0; i < index; i++) assert.equal(result[fields[i]], '漢'.repeat(20) + '…');
      const field = fields[index];
      const kept = Array.from(result[field]!).length - 1;
      assert.ok(kept >= 20 && kept < 2000);
      assert.equal(result[field], '漢'.repeat(kept) + '…');
      assert.ok(cipherBytes({ ...result, [field]: '漢'.repeat(kept + 1) + '…' }) > 3069);
      for (let i = index + 1; i < fields.length; i++) assert.equal(result[fields[i]], input[fields[i]]);
      assert.equal(result.avatar, input.avatar);
    }
  });

  it('после минимумов удаляет только avatar, сохраняя адрес перехода и исходный объект', () => {
    const input = { ...target, title: 'T'.repeat(500), body: 'B'.repeat(500), group: 'G'.repeat(500), author: 'A'.repeat(500), avatar: 'x'.repeat(4000) };
    const snapshot = JSON.stringify(input);
    const result = fit(input, 3069);
    assert.ok(cipherBytes(result) <= 3069);
    assert.equal(Object.hasOwn(result, 'avatar'), false);
    for (const [field, symbol] of [['body', 'B'], ['group', 'G'], ['title', 'T'], ['author', 'A']] as const)
      assert.equal(result[field], symbol.repeat(20) + '…');
    for (const key of Object.keys(target) as Array<keyof typeof target>) assert.equal(result[key], target[key]);
    assert.equal(JSON.stringify(input), snapshot);
  });

  it('запасная маска убирает личные поля, но не uid/dmId/key/mid/type; без неё контрфакт краснеет', () => {
    const check = (r: PushRules) => {
      const input = { ...payload, authorId: 'a'.repeat(4000) };
      const result = r.fitPushPayload(input, 3069);
      assert.ok(cipherBytes(result) <= 3069);
      assert.equal(result.title, 'GusVoice'); assert.equal(result.body, 'Новое сообщение');
      for (const field of ['author', 'authorId', 'avatar', 'group']) assert.equal(Object.hasOwn(result, field), false);
      for (const key of Object.keys(target) as Array<keyof typeof target>) assert.equal(result[key], target[key]);
      assert.equal(input.authorId.length, 4000);
    };
    check(push);
    counterfact(() => {
      assert.throws(() => check(loadPush(changed(pushSource, "return maskPushPayload(cur, 'nothing');", 'return cur;'))), assert.AssertionError);
    });
  });
});

describe('R330 журнал не раскрывает токен шлюза', () => {
  it('скрывает весь FCM-токен, сохраняет query/hash и прежнюю редакцию bearer-ссылки вложения', () => {
    // Токен устройства нельзя сохранять в access log даже при отклонённом запросе с лишним сегментом.
    const storage = wholeModule<object>(source('./storageRules.ts'), {});
    const rules = wholeModule<typeof import('./attachmentRules.js')>(source('./attachmentRules.ts'), {
      'node:crypto': crypto, './storageRules.js': storage,
    });
    assert.equal(rules.redactLogUrl('/api/push/fcm/device:secret_123-ABC'), '/api/push/fcm/…');
    assert.equal(rules.redactLogUrl('/api/push/fcm/device/extra?q=1#frag'), '/api/push/fcm/…?q=1#frag');
    assert.equal(rules.redactLogUrl('/api/att/attachment-id/viewer/signature?q=1#frag'), '/api/att/attachment-id/…?q=1#frag');
    assert.equal(rules.redactLogUrl('/api/health?q=1'), '/api/health?q=1');
    assert.equal(relay.redactFcmRelayUrl('/api/push/fcm/device:secret_123-ABC'), '/api/push/fcm/…');
    assert.equal(relay.redactFcmRelayUrl('/api/health'), '/api/health');
  });
});
