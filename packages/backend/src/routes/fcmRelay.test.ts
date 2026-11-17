import { counterfact } from '../../../shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify from 'fastify';
import { z } from 'zod';
import ts from 'typescript';

const pushSource = readFileSync(new URL('./push.ts', import.meta.url), 'utf8');
const routeSource = readFileSync(new URL('./fcmRelay.ts', import.meta.url), 'utf8');
const relaySource = readFileSync(new URL('../fcmRelay.ts', import.meta.url), 'utf8');
const rulesSource = readFileSync(new URL('../fcmRelayRules.ts', import.meta.url), 'utf8');
const pushRulesSource = readFileSync(new URL('../pushRules.ts', import.meta.url), 'utf8');
const convRulesSource = readFileSync(new URL('../convRules.ts', import.meta.url), 'utf8');
const token = 'r330:device_A-9';
// Синтетический аккаунт с одноразовым ключом, не чтение FCM_SERVICE_ACCOUNT_B64 из окружения.
const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const serviceAccountB64 = Buffer.from(JSON.stringify({
  project_id: 'r330-route-project', client_email: 'route@test.invalid', private_key: privateKey,
})).toString('base64');
const dormant = (name: string) => new Proxy({}, { get: (_target, key) => () => {
  throw new Error(`R330 неиспользуемая IO-граница ${name}.${String(key)}`);
} });

function compile<T>(text: string, deps: Record<string, unknown>, filename: string, globals: object = {}): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(text, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, Buffer, URL, URLSearchParams, AbortSignal,
    require: (id: string) => {
      assert.ok(Object.hasOwn(deps, id), `R330 закрытый импорт ${filename}: ${id}`);
      return deps[id];
    }, ...globals,
  }, { filename });
  return module.exports as T;
}
const convRules = compile(convRulesSource, { 'node:crypto': crypto }, 'convRules.ts');
const pushRules = compile(pushRulesSource, {
  '@gusvoice/shared': dormant('shared notification formatting'), './convRules.js': convRules,
}, 'pushRules.ts');
const rules = compile(rulesSource, { 'node:crypto': crypto, './pushRules.js': pushRules }, 'fcmRelayRules.ts');

interface Options { push?: string; route?: string; serviceAccount?: string; limit?: 'ip' | 'token'; fcmCode?: number }
async function fixture(options: Options = {}) {
  const rates: Array<{ key: string; max: number; window: number }> = [];
  const sent: Array<{ message: { token: string; data: { gv: string }; android: { priority: string; ttl: string } } }> = [];
  const incoming: Array<{ url: string; contentType: string | undefined }> = [];
  let authCalls = 0;
  let exchanges = 0;
  const authGuard = {
    clientIp: () => '192.0.2.33',
    retryMessage: (wait: number) => `повторить через ${wait}`,
    rateHit: async (key: string, max: number, window: number) => {
      rates.push({ key, max, window });
      return options.limit === 'ip' && key.startsWith('pushfcm:ip:') ? 17
        : options.limit === 'token' && key.startsWith('pushfcm:tok:') ? 23 : 0;
    },
  };
  const actualRelay = compile(relaySource, { './fcmRelayRules.js': rules }, 'fcmRelay.ts', {
    fetch: async (url: string, init: RequestInit) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        exchanges++;
        return new Response(JSON.stringify({ access_token: 'r330-fake-access', expires_in: 3600 }));
      }
      assert.equal(url, 'https://fcm.googleapis.com/v1/projects/r330-route-project/messages:send');
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({}), { status: options.fcmCode ?? 200,
        headers: options.fcmCode === 503 ? { 'Retry-After': '31' } : {} });
    },
  });
  const relayRoutes = compile(options.route ?? routeSource, {
    'node:crypto': crypto, '../authGuard.js': authGuard,
    '../env.js': { env: { fcm: { serviceAccountB64: options.serviceAccount ?? serviceAccountB64 } } },
    '../fcmRelay.js': actualRelay, '../fcmRelayRules.js': rules,
  }, 'routes/fcmRelay.ts');
  const push = compile<typeof import('./push.js')>(options.push ?? pushSource, {
    zod: { z }, '../authGuard.js': authGuard,
    '../auth.js': { requireAuth: async (req: { headers: { authorization?: string }; user?: { sub: string } }, reply: {
      code(status: number): { send(value: unknown): unknown };
    }) => {
      authCalls++;
      // Проверка криптографии JWT — отдельная граница; здесь важен вызов настоящей preHandler-проводки.
      if (req.headers.authorization !== 'Bearer r330-local-session') return reply.code(401).send({ error: 'no session' });
      req.user = { sub: 'r330-local-user' };
    } },
    '../conversations.js': dormant('conversations'), '../convRules.js': convRules,
    '../pushCrypto.js': dormant('pushCrypto'), './fcmRelay.js': relayRoutes,
    '../push.js': {
      ...dormant('push persistence'),
      listPushMutes: async () => [], listPushAlways: async () => [],
    },
  }, 'routes/push.ts');
  const app = Fastify();
  app.addHook('onRequest', async req => { incoming.push({ url: req.url, contentType: req.headers['content-type'] });
 });
  try {
    // Полная production-регистрация pushRoutes: поэтому перемещение FCM под requireAuth
    // действительно меняет ответ inject, а не только текст исходника.
    await app.register(push.pushRoutes, { prefix: '/api' });
    await app.ready();
  } catch (error) { await app.close(); throw error; }
  return { app, rates, sent, incoming, authCalls: () => authCalls, exchanges: () => exchanges };
}
function observed(actual: unknown, expected: unknown, message: string) {
  assert.equal(actual, expected, `R330 ${message}`);
}
function replaceOnce(text: string, from: string, to: string) {
  assert.equal(text.split(from).length - 1, 1, `единственный якорь: ${from}`);
  return text.replace(from, to);
}
const failureAt = (marker: string) => (error: unknown) => error instanceof assert.AssertionError
  && error.message.startsWith(`R330 ${marker}`);

async function checkAuthScope(text = pushSource) {
  const f = await fixture({ push: text });
  try {
    for (const url of ['/api/push/mutes', '/api/push/always']) {
      assert.equal((await f.app.inject({ method: 'GET', url })).statusCode, 401, 'соседние устройства требуют вход');
    }
    for (const url of ['/api/push/register', '/api/push/unregister', '/api/push/mute']) {
      assert.equal((await f.app.inject({ method: 'POST', url, payload: {} })).statusCode, 401);
    }
    const callsBefore = f.authCalls();
    const reply = await f.app.inject({ method: 'POST', url: `/api/push/fcm/${token}`, payload: Buffer.from('binary') });
    observed(reply.statusCode, 201, 'область входа: шлюз принимает пуш БЕЗ сессии рядом с защищёнными устройствами');
    assert.equal(f.authCalls(), callsBefore, 'requireAuth шлюз не трогает');
    assert.equal(f.sent.length, 1, 'не просто 201: запрос действительно ушёл в FCM');
    assert.equal((await f.app.inject({ method: 'GET', url: '/api/push/mutes',
      headers: { authorization: 'Bearer r330-local-session' } })).statusCode, 200, 'валидная сессия проходит соседа');
  } finally { await f.app.close(); }
}

async function checkBodyBoundary(text = routeSource) {
  const f = await fixture({ route: text });
  try {
    const exact = Buffer.alloc(3069, 0xff);
    const accepted = await f.app.inject({ method: 'POST', url: `/api/push/fcm/${token}`, payload: exact });
    observed(accepted.statusCode, 201, 'предел: ровно 3069 байт ещё принимаются');
    assert.equal(f.sent.length, 1);
    assert.deepEqual(Buffer.from(f.sent[0]!.message.data.gv, 'base64'), exact);
    const rejected = await f.app.inject({ method: 'POST', url: `/api/push/fcm/${token}`, payload: Buffer.alloc(3070) });
    observed(rejected.statusCode, 413, 'предел: 3070 байт уже отвергаются до отправки FCM');
    assert.equal(f.sent.length, 1, 'слишком большое тело не дошло до FCM');
  } finally { await f.app.close(); }
}

it('R330 полный pushRoutes оставляет FCM без входа, а соседние устройства — под requireAuth', async () => {
  await checkAuthScope();
});
it('R330 ровно 3069 сырых байт проходят, 3070 возвращают 413 и не уходят в FCM', async () => {
  await checkBodyBoundary();
});
it('R330 любой Content-Type и его отсутствие дают исходный Buffer, даже если байты не являются JSON или текстом', async () => {
  const f = await fixture();
  const body = Buffer.from([0xff, 0x80, 0, 13, 10, 123]);
  try {
    const types = [undefined, 'application/json', 'text/plain', 'application/octet-stream', 'application/x-r330-binary'];
    for (const contentType of types) {
      const reply = await f.app.inject({ method: 'POST', url: `/api/push/fcm/${token}`, payload: body,
        headers: { ...(contentType ? { 'content-type': contentType } : {}), ttl: '7', urgency: 'high' } });
      assert.equal(reply.statusCode, 201, String(contentType));
      assert.equal(f.incoming.at(-1)!.contentType, contentType, 'проверен и действительно отсутствующий заголовок');
      assert.deepEqual(f.sent.at(-1), { message: { token, data: { gv: body.toString('base64') },
        android: { priority: 'HIGH', ttl: '7s' } } });
    }
    assert.equal(f.exchanges(), 1, 'полный путь маршрута использует кеш настоящего FcmRelay');
  } finally { await f.app.close(); }
});
it('R330 wildcard принимает действительный токен длиной 4000, а неверные сегменты возвращают 404 до FCM', async () => {
  const f = await fixture();
  try {
    const longToken = 'A'.repeat(4000);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/push/fcm/${longToken}`, payload: Buffer.from('ok') })).statusCode, 201);
    assert.equal(f.sent[0]!.message.token, longToken, 'длинный токен не обрезается пределом :param роутера');
    for (const invalid of ['bad.token', 'bad/segment', 'bad%2Fsegment', 'A'.repeat(4097), '']) {
      const reply = await f.app.inject({ method: 'POST', url: `/api/push/fcm/${invalid}`, payload: Buffer.from('no') });
      assert.equal(reply.statusCode, 404, `неверный токен длиной ${invalid.length}`);
    }
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.rates[0], { key: 'pushfcm:ip:192.0.2.33', max: 600, window: 60 });
    assert.deepEqual(f.rates[1], { key: `pushfcm:tok:${crypto.createHash('sha256').update(longToken).digest('base64url').slice(0, 22)}`,
      max: 60, window: 60 });
  } finally { await f.app.close(); }
});
it('R330 лимит IP или токена отвечает 429 с Retry-After до чтения и пересылки тела', async () => {
  for (const limit of ['ip', 'token'] as const) {
    const f = await fixture({ limit });
    try {
      // Сверхлимитное тело и неверный JSON доказывают, что onRequest отказывает раньше parser.
      const reply = await f.app.inject({ method: 'POST', url: `/api/push/fcm/${token}`,
        headers: { 'content-type': 'application/json' }, payload: Buffer.alloc(3070, 0xff) });
      assert.equal(reply.statusCode, 429);
      assert.equal(reply.headers['retry-after'], limit === 'ip' ? '17' : '23');
      assert.deepEqual(reply.json(), { error: `повторить через ${limit === 'ip' ? 17 : 23}` });
      assert.equal(f.rates.length, limit === 'ip' ? 1 : 2);
      assert.equal(f.sent.length, 0);
      assert.equal(f.exchanges(), 0);
    } finally { await f.app.close(); }
  }
});
it('R330 пустой ключ сервисного аккаунта оставляет 404 без маршрута шлюза, но устройства по-прежнему зарегистрированы', async () => {
  const f = await fixture({ serviceAccount: ' \t ' });
  try {
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/push/fcm/${token}`, payload: Buffer.from('no') })).statusCode, 404);
    assert.equal((await f.app.inject({ method: 'GET', url: '/api/push/mutes' })).statusCode, 401);
    assert.equal(f.sent.length, 0);
    assert.equal(f.rates.length, 0, 'отсутствие маршрута — не условный отказ внутри обработчика');
    assert.equal(f.exchanges(), 0);
  } finally { await f.app.close(); }
});
it('R330 недоступность FCM возвращает 503 и переносит Retry-After, а успешная доставка отвечает пустым 201', async () => {
  for (const fcmCode of [200, 503]) {
    const f = await fixture({ fcmCode });
    try {
      const reply = await f.app.inject({ method: 'POST', url: `/api/push/fcm/${token}`, payload: Buffer.from('test') });
      assert.equal(reply.statusCode, fcmCode === 200 ? 201 : 503);
      assert.equal(reply.headers['retry-after'], fcmCode === 503 ? '31' : undefined);
      assert.equal(reply.body, fcmCode === 200 ? '' : JSON.stringify({ error: 'fcm unavailable' }));
    } finally { await f.app.close(); }
  }
});
it('R330 контрфакт: перенос регистрации FCM внутрь области requireAuth ломает тот же запрос без сессии', async () => {
  await checkAuthScope();
  await counterfact(async () => {
const registration = '  const fcmServiceAccount = fcmRelayServiceAccount((msg) => app.log.error(msg));\n'
    + '  if (fcmServiceAccount) await app.register(fcmRelayRoutes, { serviceAccount: fcmServiceAccount });\n';
  const moved = replaceOnce(replaceOnce(pushSource, registration, ''),
    "  app.addHook('preHandler', requireAuth);", "  app.addHook('preHandler', requireAuth);\n" + registration);
  await assert.rejects(() => checkAuthScope(moved), failureAt('область входа:'));
});
});
it('R330 контрфакт: предел на байт больше пропускает 3070 и ловится ответом inject, а не стражем исходника', async () => {
  await checkBodyBoundary();
  await counterfact(async () => {
const bigger = replaceOnce(replaceOnce(routeSource,
    'bodyLimit: FCM_RELAY_BODY_MAX', 'bodyLimit: FCM_RELAY_BODY_MAX + 1'),
  'body.length > FCM_RELAY_BODY_MAX', 'body.length > FCM_RELAY_BODY_MAX + 1');
  await assert.rejects(() => checkBodyBoundary(bigger), failureAt('предел: 3070'));
});
});
it('R330 контрфакт: запрет самого предела 3069 вместо превышения ломает парный допустимый запрос', async () => {
  await checkBodyBoundary();
  await counterfact(async () => {
await assert.rejects(() => checkBodyBoundary(replaceOnce(routeSource,
    'body.length > FCM_RELAY_BODY_MAX', 'body.length >= FCM_RELAY_BODY_MAX')), failureAt('предел: ровно'));
});
});
