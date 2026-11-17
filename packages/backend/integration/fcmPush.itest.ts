import assert from 'node:assert/strict';
import { counterfact } from '../../shared/test/counterfacts.js';
import { after, before, beforeEach, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import Fastify from 'fastify';
import ts from 'typescript';

type Push = typeof import('../src/push.js');
type PushUnderTest = Push & { endpointAuthForTest(endpoint: string): Record<string, string> };
type Schema = typeof import('../src/db/schema.js');
type Harness = typeof import('./harness.js');
type Receiver = ReturnType<typeof import('./pushDevice.harness.js').testPushDevice>;
const url = (name: string) => new URL(name, import.meta.url).href;
const pushUrl = url('../src/push.ts');
const routesUrl = url('../src/routes/push.ts');
const original = readFileSync(new URL(pushUrl), 'utf8');
const routeOriginal = readFileSync(new URL(routesUrl), 'utf8');
const relayBase = 'https://relay.example.test';
const ntfyBase = 'https://ntfy.example.test';
const relayEndpoint = `${relayBase}/api/push/fcm/device_1:token`;
const ntfyEndpoint = `${ntfyBase}/topic-r330`;
const uid = 'fcm-user';
const payload: Parameters<Push['sendPushToUsers']>[1] = {
  type: 'dm', title: 'Личное сообщение', body: 'Текст', dmId: 'conversation-r330', key: 42, mid: 'message-r330',
};

// Весь настоящий граф (включая harness, миграции и schema) без tsx/esbuild: алгоритмы приложения не копируются.
// Внешние заглушки стоят только на IO-границах. PGlite, SQL, шифрование и правила остаются настоящими.
function graph(overrides = new Map<string, unknown>(), sources = new Map<string, string>(), globals: object = {}) {
  const cache = new Map<string, { exports: unknown }>();
  function load<T>(href: string): T {
    if (overrides.has(href)) return overrides.get(href) as T;
    if (cache.has(href)) return cache.get(href)!.exports as T;
    const module = { exports: {} as unknown };
    cache.set(href, module);
    const requireExternal = createRequire(href);
    let text = sources.get(href) ?? readFileSync(new URL(href), 'utf8');
    // Только URL метаданных модуля: CommonJS иначе не может выполнить import.meta.url из db/index.ts.
    text = text.replaceAll('import.meta.url', JSON.stringify(href));
    const js = ts.transpileModule(text, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    }, fileName: fileURLToPath(href) }).outputText;
    runInNewContext(js, { module, exports: module.exports, Buffer, URL, Date, Uint8Array, Set, Map,
      console, setTimeout, clearTimeout, AbortSignal, process: { env: {} }, ...globals,
      require: (specifier: string) => {
        if (specifier === '@gusvoice/shared') return {
          ...load<object>(url('../../shared/src/notifyView.ts')),
          ...load<object>(url('../../shared/src/textFormat.ts')),
          ...load<object>(url('../../shared/src/mentions.ts')),
        };
        if (!specifier.startsWith('.')) return requireExternal(specifier);
        const target = new URL(specifier, href);
        target.pathname = target.pathname.replace(/\.js$/, '.ts');
        if (!/\.tsx?$/.test(target.pathname)) target.pathname += '.ts';
        return load(target.href);
      },
    }, { filename: fileURLToPath(href) });
    return module.exports as T;
  }
  return { load };
}
function replaceOnce(text: string, from: string, to: string) {
  assert.equal(text.split(from).length, 2, `единственный якорь мутанта: ${from}`);
  return text.replace(from, to);
}
const unexpected = (label: string) => new Proxy({}, { get: (_target, key) => () => {
  throw new Error(`неожиданная IO-граница ${label}.${String(key)}`);
} });
const bootstrap = graph(new Map([[url('../src/env.ts'), { env: { databaseUrl: 'postgres://test@127.0.0.1:1/not-used' } }]]));
const harness = bootstrap.load<Harness>(url('./harness.ts'));
const schema = bootstrap.load<Schema>(url('../src/db/schema.ts'));
const deviceHarness = bootstrap.load<typeof import('./pushDevice.harness.js')>(url('./pushDevice.harness.ts'));
let database: Awaited<ReturnType<Harness['createTestDb']>>;
before(async () => { database = await harness.createTestDb(); });
after(async () => {
  if (database) await database.close();
  await bootstrap.load<typeof import('../src/db/index.js')>(url('../src/db/index.ts')).pool.end();
});
beforeEach(async () => { await reset(); });
async function reset() {
  await harness.truncateAll(database.raw);
  await database.db.insert(schema.users).values({ id: uid, username: 'fcm_user', displayName: 'Получатель',
    passwordHash: 'fixture', notifyView: 'all', notifyRepeat: 0 });
}
interface Sent { endpoint: string; headers: Headers; body: Buffer; redirect: RequestInit['redirect'] }
function sender(options: { source?: string; route?: string; ntfy?: boolean; ntfyBase?: string; relay?: boolean; relayBase?: string; status?: number; opaque?: boolean } = {}) {
  const sent: Sent[] = [];
  const env = { ntfy: { baseUrl: options.ntfy === false ? '' : options.ntfyBase ?? ntfyBase, token: options.ntfy === false ? '' : 'r330-ntfy-fixture' },
    fcm: { relayBase: options.relay === false ? '' : options.relayBase ?? relayBase } };
  const overrides = new Map<string, unknown>([
    [url('../src/env.ts'), { env }], [url('../src/db/index.ts'), { db: database.db }],
    [url('../src/db/schema.ts'), schema], [url('../src/federation/instanceLabels.ts'), unexpected('instanceLabels')],
    [url('../src/permissions.ts'), unexpected('permissions')], [url('../src/pushDefer.ts'), unexpected('pushDefer')],
    [url('../src/auth.ts'), { requireAuth: async (req: { user?: { sub: string } }) => { req.user = { sub: uid }; } }],
    [url('../src/authGuard.ts'), { rateHit: async () => 0, retryMessage: () => 'fixture' }],
    [url('../src/conversations.ts'), unexpected('conversations')],
    [url('../src/routes/fcmRelay.ts'), { fcmRelayServiceAccount: () => null, fcmRelayRoutes: async () => {} }],
  ]);
  // Экспорт только в полной тестовой копии модуля: отдельно наблюдаем каждый защитный слой, не вырезая функцию.
  const pushSource = `${options.source ?? original}\nexport { endpointAuth as endpointAuthForTest };\n`;
  const loaded = graph(overrides, new Map([[pushUrl, pushSource], [routesUrl, options.route ?? routeOriginal]]), {
    fetch: async (endpoint: string, init: RequestInit) => {
      sent.push({ endpoint, headers: new Headers(init.headers), body: Buffer.from(init.body as Uint8Array), redirect: init.redirect });
      return { status: options.status ?? 201, type: options.opaque ? 'opaqueredirect' : 'basic' };
    },
  });
  return { push: loaded.load<PushUnderTest>(pushUrl), sent,
    routes: () => loaded.load<typeof import('../src/routes/push.js')>(routesUrl) };
}
async function register(s: ReturnType<typeof sender>, endpoint: string, id: string, receiver: Receiver) {
  await s.push.registerPushDevice(uid, id, endpoint, 'android', receiver.public, ['read1', 'reply1'], 'UTC');
}
async function deliver(s: ReturnType<typeof sender>, mode: 'message' | 'read', p = payload) {
  if (mode === 'read') await s.push.sendReadSyncPush(uid, p.dmId!, p.key!);
  else await s.push.sendPushToUsers([uid], p, undefined, { noDefer: true });
}
async function checkAuth(source = original, modes: Array<'message' | 'read'> = ['message', 'read'], sharedOrigin = false) {
  await reset();
  const ownNtfyBase = sharedOrigin ? relayBase : ntfyBase;
  const ownNtfyEndpoint = `${ownNtfyBase}/topic-r330`;
  const s = sender({ source, ntfyBase: ownNtfyBase });
  const receiver = deviceHarness.testPushDevice();
  await register(s, ownNtfyEndpoint, 'ntfy', receiver);
  await register(s, relayEndpoint, 'relay', receiver);
  for (const mode of modes) {
    const offset = s.sent.length;
    await deliver(s, mode);
    assert.equal(s.sent.length - offset, 2, 'оба настоящих устройства получили запрос');
    for (const wire of s.sent.slice(offset)) {
      assert.equal(wire.headers.get('authorization'), wire.endpoint === ownNtfyEndpoint ? 'Bearer r330-ntfy-fixture' : null,
        'секрет ntfy никогда не уходит в relay');
      assert.equal(wire.redirect, 'manual', 'переадресация не раскрывает внутреннюю сеть');
      assert.equal(receiver.decode(wire.body).type, mode === 'read' ? 'read' : 'dm');
    }
  }
  // Оба транспорта после общего SSRF-фильтра уже достаточны для исключения чужого origin.
  // Прямой вызов настоящего helper проверяет независимый origin-заслон: иначе его снятый мутант неотличим в отправке.
  const authorization = (endpoint: string) => new Headers(s.push.endpointAuthForTest(endpoint)).get('authorization');
  assert.equal(authorization(ownNtfyEndpoint), 'Bearer r330-ntfy-fixture', 'origin-заслон endpointAuth: своему ntfy нужен Bearer');
  assert.equal(authorization(relayEndpoint), null, 'секрет ntfy никогда не уходит в relay');
  const foreignEndpoint = 'https://foreign.example.test/topic-r330';
  assert.equal(s.push.pushEndpointAllowed(foreignEndpoint), false, 'общий SSRF-фильтр тоже не пропускает чужую сеть');
  assert.equal(authorization(foreignEndpoint), null, 'origin-заслон endpointAuth: чужой хост не получает Bearer');
}
it('R330 PGlite: Bearer ntfy получает только ntfy, в том числе при синхронизации прочтения', async () => {
  // Шлюз обслуживает чужие инстансы и не должен узнавать пароль их ntfy.
  await checkAuth();
});
for (const [name, from, to, address] of [
  ['снято исключение пути FCM', ' && !isFcmRelayEndpoint(endpoint)\n    ?', '\n    ?', 'секрет ntfy никогда не уходит в relay'],
  ['снята проверка origin ntfy', 'NTFY_TOKEN && endpointAllowed(endpoint, NTFY_BASE) && !isFcmRelayEndpoint(endpoint)',
    'NTFY_TOKEN && !isFcmRelayEndpoint(endpoint)', 'origin-заслон endpointAuth: чужой хост не получает Bearer'],
] as const) {
  it(`R331 контрфакт «${name}» ловится своим защитным слоем для обоих отправителей`, async () => {
    const mutated = () => replaceOnce(original, from, to);
    for (const sharedOrigin of [false, true]) for (const mode of ['message', 'read'] as const) {
      await checkAuth(original, [mode], sharedOrigin);
      // На разных origin первый мутант наблюдательно безопасен, но на общем обязан раскрыться настоящим POST.
      await counterfact(async () => {
      if (!sharedOrigin && name === 'снято исключение пути FCM') await checkAuth(mutated(), [mode], sharedOrigin);
      else await assert.rejects(checkAuth(mutated(), [mode], sharedOrigin), (err: unknown) =>
        err instanceof assert.AssertionError && err.message.startsWith(address));
      });
    }
  });
}
for (const [mode, label] of [['message', 'сообщение'], ['read', 'прочитано']] as const) {
  it(`R331 общий origin ntfy и relay: ${label} несёт Bearer только к ntfy; без патча краснеет`, async () => {
    // Один reverse proxy обслуживает оба пути: одного совпадения host недостаточно для передачи пароля.
    await checkAuth(original, [mode], true);
    await counterfact(async () => {
    const withoutFix = replaceOnce(original, ' && !isFcmRelayEndpoint(endpoint)\n    ?', '\n    ?');
    await assert.rejects(checkAuth(withoutFix, [mode], true), (err: unknown) =>
      err instanceof assert.AssertionError && err.message.startsWith('секрет ntfy никогда не уходит в relay'));
    });
  });
}

async function checkRelayOnly(source = original) {
  await reset();
  const s = sender({ source, ntfy: false });
  const receiver = deviceHarness.testPushDevice();
  await register(s, relayEndpoint, 'relay-only', receiver);
  for (const mode of ['message', 'read'] as const) await deliver(s, mode);
  assert.equal(s.sent.length, 2, 'relay работает без настройки ntfy');
  assert.deepEqual(s.sent.map(w => receiver.decode(w.body).type), ['dm', 'read']);
  const off = sender({ ntfy: false, relay: false });
  for (const mode of ['message', 'read'] as const) await deliver(off, mode);
  assert.equal(off.sent.length, 0, 'без обоих транспортов отправки нет');
}
it('R330 PGlite: relay включает оба вида пуша без ntfy, отсутствие обоих транспортов оставляет тишину', async () => {
  await checkRelayOnly();
});
it('R330 PGlite: контрфакт PUSH_ON только по ntfy не теряет уведомления молча', async () => {
  await checkRelayOnly();
  await counterfact(async () => {
  const mutated = replaceOnce(original, '(!!NTFY_BASE && !!NTFY_TOKEN) || !!FCM_RELAY_BASE', '(!!NTFY_BASE && !!NTFY_TOKEN)');
  await assert.rejects(checkRelayOnly(mutated), (err: unknown) => err instanceof assert.AssertionError && /relay работает/.test(err.message));
  });
});

async function checkDrop(source = original, statuses = [201, 302, 307, 404, 410, 413, 429, 500, 502, 503], modes: Array<'message' | 'read'> = ['message', 'read']) {
  for (const mode of modes) for (const endpoint of [ntfyEndpoint, relayEndpoint]) for (const status of statuses) {
    await reset();
    const receiver = deviceHarness.testPushDevice();
    const s = sender({ source, status });
    await register(s, endpoint, 'phone', receiver);
    await deliver(s, mode);
    assert.equal(s.sent.length, 1, 'ответ получен на настоящую отправку, а не пропущен');
    const rows = await database.db.select().from(schema.pushDevices);
    const dropped = status >= 300 && status < 400 || status === 404 || status === 410 || status === 413 && endpoint === ntfyEndpoint;
    assert.equal(rows.length, dropped ? 0 : 1, `жизнь устройства: ${mode} ${endpoint === ntfyEndpoint ? 'ntfy' : 'relay'} ${status}`);
  }
}
it('R330 PGlite: оба отправителя удаляют 3xx/404/410, но 413 сохраняет relay и удаляет только ntfy', async () => {
  // Ошибка размера/настройки relay не должна заставлять человека заново включать пуши.
  await checkDrop();
});
it('R330 PGlite: opaque redirect тоже удаляет регистрацию в обоих отправителях', async () => {
  for (const mode of ['message', 'read'] as const) {
    await reset();
    const s = sender({ opaque: true, status: 0 });
    await register(s, relayEndpoint, 'opaque', deviceHarness.testPushDevice());
    await deliver(s, mode);
    assert.equal(s.sent.length, 1);
    assert.equal((await database.db.select().from(schema.pushDevices)).length, 0);
  }
});
it('R330 PGlite: контрфакты потерянного 410 и общего удаления на 413 краснеют в базе', async () => {
  for (const [from, to, statuses] of [
    [' || res.status === 410', '', [410]],
    ['res.status === 413 && !isFcmRelayEndpoint(endpoint)', 'res.status === 413', [413]],
  ] as const) {
    const mutated = () => replaceOnce(original, from, to);
    for (const mode of ['message', 'read'] as const) {
      await checkDrop(original, [...statuses], [mode]);
      await counterfact(() => assert.rejects(checkDrop(mutated(), [...statuses], [mode]), (err: unknown) => err instanceof assert.AssertionError && /жизнь устройства/.test(err.message)));
    }
  }
});

async function checkEncryptedFit(source = original) {
  await reset();
  const s = sender({ source });
  const receiver = deviceHarness.testPushDevice();
  await register(s, relayEndpoint, 'relay', receiver);
  await register(s, ntfyEndpoint, 'ntfy', receiver);
  // Между пределами FCM и прежним WebPush; ntfy обязан получить старый текст целиком.
  const p = { ...payload, body: '界😀\u0001'.repeat(240), author: 'Автор', group: 'Группа' };
  const expected = { ...p, uid };
  assert.ok(Buffer.byteLength(JSON.stringify(expected)) > 2966);
  assert.ok(Buffer.byteLength(JSON.stringify(expected)) < 3993);
  await deliver(s, 'message', p);
  assert.equal(s.sent.length, 2);
  const relay = s.sent.find(w => w.endpoint === relayEndpoint)!;
  const ntfy = s.sent.find(w => w.endpoint === ntfyEndpoint)!;
  const decoded = receiver.decode(relay.body);
  assert.ok(relay.body.length <= 3069, 'шифротекст relay вмещается в FCM');
  assert.ok(receiver.decodeBytes(relay.body).length <= 2966, 'открытое тело учитывает 103 байта шифра');
  for (const field of ['uid', 'dmId', 'key', 'mid', 'type'] as const) assert.equal(decoded[field], expected[field]);
  assert.notEqual(decoded.body, p.body, 'для relay длинное тело действительно сокращено');
  assert.deepEqual(receiver.decodeBytes(ntfy.body), Buffer.from(JSON.stringify(expected)),
    'ntfy получает побайтно прежний JSON, а не укороченный relay-вариант');
  assert.equal(ntfy.body.length, Buffer.byteLength(JSON.stringify(expected)) + 103);
  for (const wire of [relay, ntfy]) {
    assert.equal(wire.headers.get('content-encoding'), 'aes128gcm');
    assert.equal(wire.headers.get('x-unifiedpush'), '1');
  }
}
it('R330 PGlite: зашифрованный relay подгоняет Unicode и JSON escape, не урезая ntfy и reply1 uid', async () => {
  await checkEncryptedFit();
});
it('R330 PGlite: контрфакты обхода fit и общей подгонки ntfy ломают адресную проверку', async () => {
  await checkEncryptedFit();
  await counterfact(async () => {
  for (const [from, to] of [
    ["return Buffer.from(JSON.stringify(fitPushPayload<PushPayload>(withUid ?? v.payload, FCM_RELAY_BODY_MAX)), 'utf8');", 'return plain;'],
    [' || !isFcmRelayEndpoint(d.endpoint)', ''],
  ]) {
    const mutated = replaceOnce(original, from, to);
    await assert.rejects(checkEncryptedFit(mutated), (err: unknown) => err instanceof assert.AssertionError &&
      /шифротекст relay|ntfy получает/.test(err.message));
  }
  });
});

async function checkRegistration(route = routeOriginal) {
  await reset();
  // Длинный, но корректный свой origin позволяет дойти до Zod-предела 4200 раньше лимита токена 4096.
  const longBase = `https://${'a'.repeat(60)}.${'b'.repeat(60)}.example.test`;
  const prefix = `${longBase}/api/push/fcm/`;
  const s = sender({ route, relayBase: longBase });
  const app = Fastify();
  // Боевой error handler отвечает 400 на ZodError; проверяем границу маршрута, не систему ошибок index.ts.
  app.setErrorHandler((err, _req, reply) => { reply.code((err as { name?: string }).name === 'ZodError' ? 400 : 500).send(); });
  try {
    await app.register(s.routes().pushRoutes, { prefix: '/api' });
    const receiver = deviceHarness.testPushDevice();
    const endpoint = `${prefix}${'A'.repeat(4000)}`;
    const accepted = await app.inject({ method: 'POST', url: '/api/push/register', payload: {
      endpoint, deviceId: 'registered-phone', platform: 'android', keys: receiver.public, caps: ['reply1', 'read1'], tz: 'UTC',
    } });
    assert.equal(accepted.statusCode, 204, 'длинный FCM endpoint принимается');
    const rows = await database.db.select().from(schema.pushDevices);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.endpoint, endpoint, 'SQL text хранит все 4000 знаков токена');
    assert.equal(rows[0]!.userId, uid);
    assert.equal(rows[0]!.p256dh, receiver.public.p256dh);
    assert.equal(rows[0]!.caps, 'reply1,read1');
    const exact = `${prefix}${'A'.repeat(4200 - prefix.length)}`;
    const endpointTooLong = `${exact}A`;
    assert.equal(exact.length, 4200);
    assert.equal(endpointTooLong.length, 4201);
    assert.equal(s.push.pushEndpointAllowed(endpointTooLong), true, 'URL 4201 годится для SSRF-правила, отказывает именно схема');
    assert.equal((await app.inject({ method: 'POST', url: '/api/push/register', payload: {
      endpoint: exact, deviceId: 'exact-limit', platform: 'android',
    } })).statusCode, 204, 'endpoint ровно 4200 ещё принимается');
    const rejected = await app.inject({ method: 'POST', url: '/api/push/register', payload: {
      endpoint: endpointTooLong, deviceId: 'too-long', platform: 'android',
    } });
    assert.equal(rejected.statusCode, 400, 'endpoint 4201 отвергается пределом схемы');
    assert.equal((await database.db.select().from(schema.pushDevices)).length, 2, 'отказ не пишет третье устройство');
  } finally { await app.close(); }
}
it('R330 PGlite: /push/register сохраняет токен 4000, endpoint длиннее 4200 отвергает без записи', async () => {
  await checkRegistration();
});
it('R330 PGlite: старый предел 2000 не должен отрезать регистрацию Play-устройства', async () => {
  await checkRegistration();
  await counterfact(() => assert.rejects(checkRegistration(replaceOnce(routeOriginal, '.url().max(4200)', '.url().max(2000)')),
    (err: unknown) => err instanceof assert.AssertionError && /длинный FCM endpoint принимается/.test(err.message)));
});
it('R330 PGlite: контрфакт сдвинутого предела 4201 не проходит через правильный SSRF origin', async () => {
  await checkRegistration();
  await counterfact(() => assert.rejects(checkRegistration(replaceOnce(routeOriginal, '.url().max(4200)', '.url().max(4201)')),
    (err: unknown) => err instanceof assert.AssertionError && /endpoint 4201/.test(err.message)));
});
