import { counterfact } from '../../shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { FcmRelayDeps } from './fcmRelay.js';

const source = readFileSync(new URL('./fcmRelay.ts', import.meta.url), 'utf8');
const rulesSource = readFileSync(new URL('./fcmRelayRules.ts', import.meta.url), 'utf8');
const pushRulesSource = readFileSync(new URL('./pushRules.ts', import.meta.url), 'utf8');
// Ключ существует только в памяти теста: никаких файлов аккаунта или окружения.
const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const account = { projectId: 'r330-test-project', clientEmail: 'relay@test.invalid', privateKey };
const oauthUrl = 'https://oauth2.googleapis.com/token';
const sendUrl = 'https://fcm.googleapis.com/v1/projects/r330-test-project/messages:send';

function compile<T>(text: string, deps: Record<string, unknown>, filename: string): T {
  const module = { exports: {} };
  // Исполняется целый production-модуль, а не скопированное тело метода.
  runInNewContext(ts.transpileModule(text, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, Buffer, URL, URLSearchParams, AbortSignal,
    require: (id: string) => {
      assert.ok(Object.hasOwn(deps, id), `R330 закрытый импорт ${filename}: ${id}`);
      return deps[id];
    },
  }, { filename });
  return module.exports as T;
}

const dormant = (name: string) => new Proxy({}, { get: (_target, key) => {
  throw new Error(`R330 неожиданная граница ${name}.${String(key)}`);
} });
// Из pushRules здесь используются настоящие константы шлюза; форматирование уведомлений
// и превью вложений — неиспользуемые границы, а не подмена правил FCM.
const pushRules = compile(pushRulesSource, {
  '@gusvoice/shared': dormant('shared'), './convRules.js': dormant('convRules'),
}, 'pushRules.ts');
const rules = compile(rulesSource, { 'node:crypto': crypto, './pushRules.js': pushRules }, 'fcmRelayRules.ts');
function relay(deps: FcmRelayDeps, text = source) {
  const { FcmRelay } = compile<typeof import('./fcmRelay.js')>(text, {
    './fcmRelayRules.js': rules,
  }, 'fcmRelay.ts');
  return new FcmRelay(account, deps);
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const success = () => json({ name: 'projects/r330/messages/one' });
const tokenResponse = (token: string, life = 3600) => json({ access_token: token, expires_in: life });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function observed(actual: unknown, expected: unknown, message: string) {
  assert.equal(actual, expected, `R330 ${message}`);
}
function replaceOnce(text: string, from: string, to: string) {
  assert.equal(text.split(from).length - 1, 1, `единственный якорь: ${from}`);
  return text.replace(from, to);
}
const failureAt = (marker: string) => (error: unknown) => error instanceof assert.AssertionError
  && error.message.startsWith(`R330 ${marker}`);

async function checkSingleFlight(text = source) {
  let exchanges = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const authorization: string[] = [];
  const r = relay({ fetch: async (url, init) => {
    if (url === oauthUrl) {
      exchanges++;
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'manual');
      const form = new URLSearchParams(String(init.body));
      assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      assert.equal(form.get('assertion')?.split('.').length, 3, 'в OAuth уходит настоящий подписанный JWT');
      await gate;
      return tokenResponse('shared-access');
    }
    assert.equal(url, sendUrl);
    authorization.push((init.headers as Record<string, string>).Authorization!);
    return success();
  } }, text);
  const pending = Array.from({ length: 8 }, (_, i) => r.send(`device:${i}`, Buffer.from([i]), {}));
  await tick();
  release();
  const outcomes = await Promise.all(pending);
  observed(exchanges, 1, 'single-flight: восемь отправок делают один обмен OAuth');
  assert.deepEqual(outcomes.map(out => out.code), Array(8).fill(201));
  assert.deepEqual(authorization, Array(8).fill('Bearer shared-access'));
}

async function checkCache(text = source) {
  let now = 1_000_000;
  let exchanges = 0;
  const authorization: string[] = [];
  const r = relay({ now: () => now, fetch: async (url, init) => {
    if (url === oauthUrl) return tokenResponse(`access-${++exchanges}`);
    authorization.push((init.headers as Record<string, string>).Authorization!);
    return success();
  } }, text);
  await r.send('device', Buffer.alloc(0), {});
  now += 3_300_000 - 1;
  await r.send('device', Buffer.alloc(0), {});
  observed(exchanges, 1, 'кеш: за миллисекунду до запаса 300 секунд обмена нет');
  now++;
  await r.send('device', Buffer.alloc(0), {});
  observed(exchanges, 2, 'кеш: ровно за 300 секунд до истечения нужен новый OAuth');
  assert.deepEqual(authorization, ['Bearer access-1', 'Bearer access-1', 'Bearer access-2']);
}

async function checkUnauthorized(text = source) {
  let exchanges = 0;
  let sends = 0;
  const authorization: string[] = [];
  const r = relay({ now: () => 100_000, fetch: async (url, init) => {
    if (url === oauthUrl) return tokenResponse(`access-${++exchanges}`);
    authorization.push((init.headers as Record<string, string>).Authorization!);
    return ++sends === 1 ? json({ error: { status: 'UNAUTHENTICATED' } }, 401) : success();
  } }, text);
  observed((await r.send('device', Buffer.alloc(0), {})).code, 502, '401 не удаляет устройство');
  observed((await r.send('device', Buffer.alloc(0), {})).code, 201, 'после 401 следующая отправка проходит');
  observed(exchanges, 2, '401: следующий запрос получает новый OAuth вместо старого кеша');
  assert.deepEqual(authorization, ['Bearer access-1', 'Bearer access-2']);
}

async function checkWireBody(text = source) {
  const body = Buffer.from([0, 255, 128, 1, 13, 10, 240, 159, 166, 162]);
  const sent: unknown[] = [];
  const r = relay({ fetch: async (url, init) => {
    if (url === oauthUrl) return tokenResponse('wire-access');
    assert.equal(url, sendUrl);
    assert.deepEqual(JSON.parse(JSON.stringify(init.headers)), { 'Content-Type': 'application/json', Authorization: 'Bearer wire-access' });
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    sent.push(JSON.parse(String(init.body)));
    return success();
  } }, text);
  for (const headers of [{ ttl: '0', urgency: 'high' }, { ttl: '25', priority: 'urgent' }, {}]) {
    assert.equal((await r.send('device:A_-9', body, headers)).code, 201);
  }
  assert.deepEqual(sent, [
    { message: { token: 'device:A_-9', data: { gv: body.toString('base64') }, android: { priority: 'HIGH', ttl: '0s' } } },
    { message: { token: 'device:A_-9', data: { gv: body.toString('base64') }, android: { priority: 'HIGH', ttl: '25s' } } },
    { message: { token: 'device:A_-9', data: { gv: body.toString('base64') }, android: { priority: 'NORMAL', ttl: '86400s' } } },
  ], 'R330 тело: бинарный web-push, TTL и приоритет доходят до HTTP v1 без лишних полей');
}

it('R330 восемь одновременных отправок ждут один обмен OAuth, а не расходуют квоту восемь раз', async () => {
  await checkSingleFlight();
});
it('R330 токен кешируется до границы срока минус 300 секунд, на границе обновляется', async () => {
  await checkCache();
});
it('R330 ответ FCM 401 не удаляет устройство и сбрасывает кеш для следующей отправки', async () => {
  await checkUnauthorized();
});
it('R330 тело HTTP v1 сохраняет все байты в data.gv и передаёт HIGH/NORMAL и TTL, включая ноль', async () => {
  await checkWireBody();
});
it('R330 сбой сети при OAuth или отправке возвращает 502, а не исключение или удаление устройства', async () => {
  for (const failAt of ['oauth', 'fcm']) {
    const r = relay({ fetch: async url => {
      if (url === oauthUrl && failAt !== 'oauth') return tokenResponse('network-access');
      throw new Error('синтетический обрыв сети');
    } });
    assert.equal((await r.send('device', Buffer.alloc(1), {})).code, 502, failAt);
  }
});
it('R330 отказ OAuth освобождает общий ожидающий запрос: последующая отправка снова пробует обмен', async () => {
  let exchanges = 0;
  const r = relay({ fetch: async url => {
    if (url === oauthUrl) return ++exchanges === 1 ? json({ error: 'temporary' }, 503) : tokenResponse('recovered');
    return success();
  } });
  assert.equal((await r.send('device', Buffer.alloc(1), {})).code, 502);
  assert.equal((await r.send('device', Buffer.alloc(1), {})).code, 201);
  assert.equal(exchanges, 2);
});
it('R330 контрфакт: отдельный OAuth для каждого параллельного запроса нарушает single-flight', async () => {
  await checkSingleFlight();
  await counterfact(async () => {
    await assert.rejects(() => checkSingleFlight(replaceOnce(source,
      'if (!this.pending) {', 'if (true) {')), failureAt('single-flight:'));
  });
});
it('R330 контрфакт: кеш до полного срока вместо запаса 300 секунд ловится точно на границе', async () => {
  await checkCache();
  await counterfact(async () => {
    await assert.rejects(() => checkCache(replaceOnce(source,
      'accessTokenValidUntil(this.now(), Number(j.expires_in))', 'this.now() + Number(j.expires_in) * 1000')),
    failureAt('кеш: ровно'));
  });
});
it('R330 контрфакт: сохранённый после FCM 401 кеш не проходит следующую отправку новым токеном', async () => {
  await checkUnauthorized();
  await counterfact(async () => {
    await assert.rejects(() => checkUnauthorized(replaceOnce(source,
      'if (res.status === 401) this.cached = null;', 'if (false) this.cached = null;')), failureAt('401:'));
  });
});
it('R330 контрфакт: потеря заголовков при сборке сообщения меняет наблюдаемый HTTP v1', async () => {
  await checkWireBody();
  await counterfact(async () => {
    await assert.rejects(() => checkWireBody(replaceOnce(source,
      'buildFcmMessage(token, body, headers)', 'buildFcmMessage(token, body, {})')), failureAt('тело:'));
  });
});
