import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify from 'fastify';
import ts from 'typescript';
import { createTestDb, truncateAll, type TestDb } from './harness.js';
import { testPushDevice } from './pushDevice.harness.js';

process.env.NTFY_BASE_URL = 'https://ntfy.example.test';
process.env.NTFY_TOKEN = 'integration-token';
process.env.PUBLIC_API_URL = 'https://api.example.test';

let t: TestDb;
let contactNamesFor: typeof import('../src/contacts.js').contactNamesFor;
let app: ReturnType<typeof Fastify>;
let tokenFor: (id: string) => string;
let redisPub: typeof import('../src/realtime.js').redisPub;
const posted: { url: string; body: unknown }[] = [];
const originalFetch = globalThis.fetch;
let pushReceiver: ReturnType<typeof testPushDevice>;
const authHeader = (id: string) => ({ authorization: `Bearer ${tokenFor(id)}` });

type RecordedPush = Record<string, unknown>;

async function waitForPushes(endpoint: string, count: number, matches: (payload: RecordedPush) => boolean = () => true): Promise<void> {
  for (let attempt = 0; attempt < 100 && payloadsFor(endpoint).filter(matches).length < count; attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(payloadsFor(endpoint).filter(matches).length >= count, `получено не меньше ${count} подходящих push на ${endpoint}`);
}

function payloadsFor(endpoint: string): RecordedPush[] {
  return posted.filter((p) => p.url === endpoint).map((p) => p.body as Record<string, unknown>);
}

async function compileFanOut(mutant?: readonly [string, string][]): Promise<typeof import('../src/convSendFanout.js') & { groupPushOff(ids: readonly string[], conversationId: string): Promise<Set<string>> }> {
  let source = readFileSync(new URL('../src/convSendFanout.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  for (const [before, after] of mutant ?? []) {
    const changed = source.replace(before, after);
    assert.notEqual(changed, source, `найден якорь контрфакта: ${before}`);
    source = changed;
  }
  const deps: Record<string, unknown> = {
    'drizzle-orm': await import('drizzle-orm'),
    './authGuard.js': { pushBurst: async () => 'loud' },
    './conversations.js': { deliver: async () => {} },
    './db/index.js': await import('../src/db/index.js'),
    './contacts.js': await import('../src/contacts.js'),
    './contactRules.js': await import('../src/contactRules.js'),
    './db/schema.js': await import('../src/db/schema.js'),
    './groupRules.js': await import('../src/groupRules.js'),
    './push.js': await import('../src/push.js'),
  };
  const module = { exports: {} as Record<string, unknown> };
  // Только экспорт существующей функции в копии для теста; её тело и SQL остаются настоящими.
  const js = ts.transpileModule(source + '\nexport { groupPushOff };', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(js, { module, exports: module.exports, Date, Map, Set, Promise, Buffer,
    require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `неожиданная зависимость ${id}`); return deps[id]; },
  });
  return module.exports as unknown as typeof import('../src/convSendFanout.js') & { groupPushOff(ids: readonly string[], conversationId: string): Promise<Set<string>> };
}

async function registerCallRoutes(): Promise<void> {
  const source = readFileSync(new URL('../src/routes/calls.ts', import.meta.url), 'utf8');
  const calls = await import('../src/calls.js');
  const deps: Record<string, unknown> = {
    '@gusvoice/shared': await import('@gusvoice/shared'),
    'drizzle-orm': await import('drizzle-orm'),
    zod: await import('zod'),
    '../auth.js': await import('../src/auth.js'),
    '../authGuard.js': await import('../src/authGuard.js'),
    '../blocks.js': await import('../src/blocks.js'),
    '../callPrivacy.js': await import('../src/callPrivacy.js'),
    '../calls.js': { ...calls, callJoin: async (call: unknown) => ({ call, url: 'wss://call.example.test', token: 'integration-token', room: 'test-room' }) },
    '../conversations.js': await import('../src/conversations.js'),
    '../db/index.js': await import('../src/db/index.js'),
    '../db/schema.js': await import('../src/db/schema.js'),
    '../dmRules.js': await import('../src/dmRules.js'),
  };
  const module = { exports: {} as Record<string, unknown> };
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(js, { module, exports: module.exports, Date, Map, Set, Promise,
    require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `неожиданная зависимость ${id}`); return deps[id]; },
  });
  await app.register((module.exports.callRoutes as (instance: typeof app) => Promise<void>));
}

before(async () => {
  t = await createTestDb();
  await t.raw.exec(`CREATE SEQUENCE test_message_sort_key;
    ALTER SEQUENCE test_message_sort_key OWNED BY conversation_messages.sort_key;
    ALTER TABLE conversation_messages ALTER COLUMN sort_key SET DEFAULT nextval('test_message_sort_key');`);
  ({ contactNamesFor } = await import('../src/contacts.js'));
  const auth = await import('../src/auth.js');
  tokenFor = (id) => auth.signToken({ sub: id, username: id, gen: 0 });
  const { convRoutes } = await import('../src/routes/conv.js');
  const { convGroupRoutes } = await import('../src/routes/convGroups.js');
  ({ redisPub } = await import('../src/realtime.js'));
  redisPub.publish = (async () => 1) as typeof redisPub.publish;
  redisPub.incr = (async () => 1) as typeof redisPub.incr;
  redisPub.expire = (async () => 1) as typeof redisPub.expire;
  redisPub.ttl = (async () => 1) as typeof redisPub.ttl;
  redisPub.hset = (async () => 1) as typeof redisPub.hset;
  redisPub.hdel = (async () => 1) as typeof redisPub.hdel;
  app = Fastify();
  await app.register(convRoutes);
  await app.register(convGroupRoutes);
  await registerCallRoutes();
  await app.ready();
});

beforeEach(async () => {
  pushReceiver = testPushDevice();
  await truncateAll(t.raw);
  await t.raw.exec(`
    INSERT INTO users (id, username, display_name, password_hash) VALUES
      ('author','author','Исходное имя','hash'),
      ('recipient-a','recipient-a','Получатель А','hash'),
      ('recipient-b','recipient-b','Получатель Б','hash'),
      ('unrelated','unrelated','Посторонний','hash');
    INSERT INTO user_contacts (owner_id, contact_id, name) VALUES
      ('recipient-a','author','Моя подпись'),
      ('recipient-b','author','   '),
      ('author','author','Сам себе'),
      ('author','recipient-a','Имя получателя в списке автора'),
      ('unrelated','author','Не запрошенный владелец');
    INSERT INTO push_devices (id,user_id,device_id,endpoint,platform,caps) VALUES
      ('push-a','recipient-a','phone-a','https://ntfy.example.test/recipient-a','android','read1'),
      ('push-b','recipient-b','phone-b','https://ntfy.example.test/recipient-b','android','read1');
  `);
  // Проверки личных подписей относятся к устройству с шифрованием, не к keyless-заглушке.
  await t.raw.query('UPDATE push_devices SET p256dh=$1, auth=$2', [pushReceiver.public.p256dh, pushReceiver.public.auth]);
  posted.length = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    posted.push({ url: String(url), body: pushReceiver.decode(init?.body) });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
});

after(async () => { globalThis.fetch = originalFetch; await app.close(); redisPub.disconnect(); await t.close(); });

test('подписи контакта выбираются по владельцам-получателям, а пустые подписи пропускаются', async () => {
  let contactQueries = 0;
  const originalQuery = t.raw.query.bind(t.raw);
  t.raw.query = (async (...args: Parameters<typeof t.raw.query>) => {
    const query = args[0];
    const queryText = typeof query === 'string' ? query : String((query as { text?: unknown; query?: unknown } | null)?.text ?? (query as { query?: unknown } | null)?.query ?? query);
    if (/\buser_contacts\b/i.test(queryText)) contactQueries++;
    return originalQuery(...args);
  }) as typeof t.raw.query;
  let names: Map<string, string>;
  try {
    names = await contactNamesFor('author', ['recipient-a', 'recipient-b']);
  } finally {
    t.raw.query = originalQuery as typeof t.raw.query;
  }
  assert.equal(contactQueries, 1, 'одна выборка обслуживает всех получателей сообщения');
  assert.deepEqual([...names], [['recipient-a', 'Моя подпись']]);
  assert.equal(names.has('author'), false, 'имя автора из его собственного списка не становится подписью для получателя');
  assert.equal(names.has('unrelated'), false, 'подпись владельца вне выборки не утекает в рассылку');
});

test('пустой список получателей не выполняет и не возвращает имена', async () => {
  assert.deepEqual([...await contactNamesFor('author', [])], []);
});

test('прямое сообщение подставляет подпись контакта в заголовок и автора уведомления', async () => {
  await t.raw.exec(`INSERT INTO conversations (id,kind,direct_key,created_by) VALUES ('direct','direct','author:recipient-a','author');
    INSERT INTO conversation_members (conversation_id,user_id) VALUES ('direct','author'),('direct','recipient-a');`);
  const sent = await app.inject({ method: 'POST', url: '/conv/direct/messages', headers: authHeader('author'), payload: {
    clientId: '10000000-0000-4000-8000-000000000001', content: 'Текст', attachments: [],
  } });
  assert.equal(sent.statusCode, 201, sent.body);
  await waitForPushes('https://ntfy.example.test/recipient-a', 1);
  assert.deepEqual(payloadsFor('https://ntfy.example.test/recipient-a').map((p) => [p.title, p.author]), [['Моя подпись', 'Моя подпись']]);
});

test('групповое сообщение подписывает автора отдельно для каждого получателя и для пустой подписи оставляет имя', async () => {
  await t.raw.exec(`INSERT INTO users (id,username,display_name,password_hash) VALUES ('group-author','group-author','Автор группы','hash');
    INSERT INTO user_contacts (owner_id,contact_id,name) VALUES ('recipient-a','group-author','Личный псевдоним'),('recipient-b','group-author','  ');
    INSERT INTO conversations (id,kind,title,created_by) VALUES ('group','group','Название группы','group-author');
    INSERT INTO conversation_members (conversation_id,user_id,role) VALUES ('group','group-author','owner'),('group','recipient-a','member'),('group','recipient-b','member');`);
  const res = await app.inject({ method: 'POST', url: '/conv/group/messages', headers: authHeader('group-author'), payload: {
    clientId: '10000000-0000-4000-8000-000000000002', content: 'Текст', attachments: [],
  } });
  assert.equal(res.statusCode, 201, res.body);
  await waitForPushes('https://ntfy.example.test/recipient-a', 1);
  await waitForPushes('https://ntfy.example.test/recipient-b', 1);
  assert.deepEqual(payloadsFor('https://ntfy.example.test/recipient-a').map((p) => [p.title, p.author]), [['Личный псевдоним в «Название группы»', 'Личный псевдоним']]);
  assert.deepEqual(payloadsFor('https://ntfy.example.test/recipient-b').map((p) => [p.title, p.author]), [['Автор группы в «Название группы»', 'Автор группы']]);
});

test('пересылка пачкой создаёт один push с подписью контакта', async () => {
  await t.raw.exec(`INSERT INTO conversations (id,kind,direct_key,created_by) VALUES
      ('source-conv','direct','author:unrelated','author'),('forward','direct','author:recipient-a','author');
    INSERT INTO conversation_members (conversation_id,user_id) VALUES
      ('source-conv','author'),('source-conv','unrelated'),('forward','author'),('forward','recipient-a');
    INSERT INTO conversation_messages (id,conversation_id,author_id,sort_key,content) VALUES
      ('source','source-conv','author',1,'Исходное'),('source-2','source-conv','author',2,'Ещё одно');`);
  const res = await app.inject({ method: 'POST', url: '/conv/forward/forward', headers: authHeader('author'), payload: {
    clientId: '10000000-0000-4000-8000-000000000003', fromConversationId: 'source-conv', messageIds: ['source', 'source-2'],
  } });
  assert.equal(res.statusCode, 201, res.body);
  await waitForPushes('https://ntfy.example.test/recipient-a', 1);
  assert.deepEqual(payloadsFor('https://ntfy.example.test/recipient-a').map((p) => [p.title, p.body]), [['Моя подпись', '↪ Пересланные сообщения: 2']]);
});

test('входящий ring использует подпись вызывающего, известную получателю', async () => {
  await t.raw.exec(`INSERT INTO conversations (id,kind,direct_key,created_by) VALUES ('call','direct','author:recipient-a','author');
    INSERT INTO conversation_members (conversation_id,user_id) VALUES ('call','author'),('call','recipient-a');`);
  const result = await app.inject({ method: 'POST', url: '/conv/call/call', headers: authHeader('author'), payload: { device: 'test-device' } });
  assert.equal(result.statusCode, 201, result.body);
  const calls = await import('../src/calls.js');
  try {
    await waitForPushes('https://ntfy.example.test/recipient-a', 1, (p) => p.type === 'call' && p.dmId === 'call');
    const ring = payloadsFor('https://ntfy.example.test/recipient-a').find((p) => p.type === 'call' && p.dmId === 'call');
    assert.ok(ring);
    assert.equal(ring.title, 'Моя подпись');
    assert.equal(ring.body, 'Входящий звонок');
  } finally {
    // Таймер звонка не должен дописывать сообщения после очистки базы следующим тестом.
    const live = calls.callOf('author');
    if (live) await calls.act('author', live.id, 'hangup');
  }
});

test('контрфакт: подпись из контактов автора вместо контактов получателя не проходит', async () => {
  await t.raw.exec(`INSERT INTO conversations (id,kind,direct_key,created_by) VALUES ('mut-direct','direct','author:recipient-a','author');
    INSERT INTO conversation_members (conversation_id,user_id) VALUES ('mut-direct','author'),('mut-direct','recipient-a');`);
  const endpoint = 'https://ntfy.example.test/recipient-a';
  const sent = { me: 'author', peerId: 'recipient-a', conversationId: 'mut-direct', row: { id: 'm1', createdAt: new Date(1), sortKey: 1 },
    delivery: { conversationId: 'mut-direct', messageId: 'm1', pts: new Map() }, notifyRecipient: true, content: 'x', attachments: 0, silent: false } as const;
  const control = await compileFanOut();
  await control.fanOutSend(sent);
  const isThisMessage = (p: RecordedPush) => p.type === 'dm' && p.dmId === 'mut-direct' && p.mid === 'm1';
  await waitForPushes(endpoint, 1, isThisMessage);
  assert.deepEqual(payloadsFor(endpoint).filter(isThisMessage).map((p) => p.title), ['Моя подпись']);
  posted.length = 0;
  const mutant = await compileFanOut([['contactNamesFor(s.me, [peerId])', 'contactNamesFor(peerId, [s.me])']]);
  await mutant.fanOutSend(sent);
  await waitForPushes(endpoint, 1, isThisMessage);
  const title = payloadsFor(endpoint).find(isThisMessage)?.title;
  await assert.rejects(async () => assert.equal(title, 'Моя подпись'), assert.AssertionError);
});

test('контрфакт: один общий alias группы для всех адресатов не проходит', async () => {
  await t.raw.exec(`INSERT INTO users (id,username,display_name,password_hash) VALUES ('group-author','group-author','Автор группы','hash');
    INSERT INTO user_contacts (owner_id,contact_id,name) VALUES ('recipient-a','group-author','Личный псевдоним'),('recipient-b','group-author','Второй псевдоним');
    INSERT INTO conversations (id,kind,title,created_by) VALUES ('mut-group','group','Название группы','group-author');
    INSERT INTO conversation_members (conversation_id,user_id,role) VALUES ('mut-group','group-author','owner'),('mut-group','recipient-a','member'),('mut-group','recipient-b','member');`);
  const endpointA = 'https://ntfy.example.test/recipient-a';
  const endpointB = 'https://ntfy.example.test/recipient-b';
  const sent = { me: 'group-author', peerId: null, groupMemberIds: ['group-author', 'recipient-a', 'recipient-b'], conversationId: 'mut-group',
    row: { id: 'm2', createdAt: new Date(2), sortKey: 2 }, delivery: { conversationId: 'mut-group', messageId: 'm2', pts: new Map() }, notifyRecipient: true, content: 'x', attachments: 0, silent: false } as const;
  const control = await compileFanOut();
  await control.fanOutSend(sent);
  await waitForPushes(endpointA, 1);
  await waitForPushes(endpointB, 1);
  const expectedTitles = ['Личный псевдоним в «Название группы»', 'Второй псевдоним в «Название группы»'];
  const controlTitles = [payloadsFor(endpointA)[0]?.title, payloadsFor(endpointB)[0]?.title];
  assert.deepEqual(controlTitles, expectedTitles, 'исходная версия действительно доставила адресные подписи');
  posted.length = 0;
  const mutant = await compileFanOut([['pushNameFor(names, id, who.author)', 'pushNameFor(names, me, who.author)']]);
  await mutant.fanOutSend(sent);
  await waitForPushes(endpointA, 1);
  await waitForPushes(endpointB, 1);
  const mutantTitles = [
    payloadsFor(endpointA)[0]?.title,
    payloadsFor(endpointB)[0]?.title,
  ];
  assert.ok(mutantTitles.every((title) => typeof title === 'string'), 'мутант тоже отправил payload обоим адресатам');
  await assert.rejects(async () => assert.deepEqual(mutantTitles, expectedTitles), assert.AssertionError);
});

test('групповое исключение group:id перекрывает notifyGroups=false только своей группы и не отменяет полную заглушку', async () => {
  await t.raw.exec(`INSERT INTO conversations(id,kind,title,created_by) VALUES('always-group','group','Наша группа','author');
    INSERT INTO conversation_members(conversation_id,user_id,role) VALUES
      ('always-group','author','owner'),('always-group','recipient-a','member');`);
  const endpoint = 'https://ntfy.example.test/recipient-a';
  const sent = { me: 'author', peerId: null, groupMemberIds: ['author', 'recipient-a'], conversationId: 'always-group',
    row: { id: 'group-always-message', createdAt: new Date(10), sortKey: 10 }, delivery: { conversationId: 'always-group', messageId: 'group-always-message', pts: new Map() },
    notifyRecipient: true, content: 'Исключение группы', attachments: 0, silent: false } as const;
  const check = async (fan: Awaited<ReturnType<typeof compileFanOut>>) => {
    for (const [notifyGroups, owner, target, muted, expected] of [
      [true, null, null, false, true], [false, null, null, false, false],
      [false, 'recipient-a', 'group:always-group', false, true],
      [false, 'recipient-a', 'group:other', false, false],
      [false, 'recipient-b', 'group:always-group', false, false],
      [false, 'recipient-a', 'author', false, false],
      [false, 'recipient-a', 'group:always-group', true, false],
    ] as const) {
      await t.raw.exec('DELETE FROM push_always; DELETE FROM push_mutes');
      await t.raw.query("UPDATE users SET notify_groups=$1 WHERE id='recipient-a'", [notifyGroups]);
      if (owner && target) await t.raw.query("INSERT INTO push_always(user_id,scope,target_id) VALUES($1,'dm_user',$2)", [owner, target]);
      if (muted) await t.raw.exec("INSERT INTO push_mutes(user_id,scope,target_id) VALUES('recipient-a','dm_user','group:always-group')");
      const off = await fan.groupPushOff(['author', 'recipient-a'], 'always-group');
      assert.equal(off.has('recipient-a'), !notifyGroups && !(owner === 'recipient-a' && target === 'group:always-group'), `фильтр группы ${owner}/${target}`);
      posted.length = 0;
      await fan.fanOutSend(sent);
      if (expected) await waitForPushes(endpoint, 1);
      else for (let n = 0; n < 20; n++) await new Promise<void>(resolve => setTimeout(resolve, 0));
      assert.equal(payloadsFor(endpoint).length, expected ? 1 : 0, `notifyGroups=${notifyGroups}, исключение ${owner}/${target}, mute=${muted}`);
      if (expected) assert.equal(payloadsFor(endpoint)[0].title, 'Моя подпись в «Наша группа»');
    }
  };
  await check(await compileFanOut());
  await assert.rejects(check(await compileFanOut([['.filter((id) => !always.has(id))', '']])), /фильтр группы recipient-a\/group:always-group/);
});
