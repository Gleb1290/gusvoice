import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { CONTACTS_MAX, Permission } from '@gusvoice/shared';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

process.env.NTFY_BASE_URL = 'https://ntfy.example.test';
process.env.NTFY_TOKEN = 'integration-test-token';
process.env.PUBLIC_API_URL = 'https://api.example.test';

let t: TestDb;
let app: ReturnType<typeof Fastify>;
let tokenFor: (id: string) => string;
let redisPub: typeof import('../src/realtime.js').redisPub;
let setAttachmentStoreForTests: typeof import('../src/attachments.js').setAttachmentStoreForTests;
let setSuperAdminId: typeof import('../src/auth.js').setSuperAdminId;
const published: { channel: string; message: string }[] = [];
const pushed: string[] = [];
const originalFetch = globalThis.fetch;
let forceEditRateLimit = false;
const authHeader = (id: string) => ({ authorization: `Bearer ${tokenFor(id)}` });

function mutateExportedFunction<T>(sourceUrl: URL, functionName: string, edits: readonly [string, string][], globals: Record<string, unknown>): T {
  const source = readFileSync(sourceUrl, 'utf8').replace(/\r\n/g, '\n');
  const parsed = ts.createSourceFile(sourceUrl.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = parsed.statements.find((s): s is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(s) && s.name?.text === functionName,
  );
  assert.ok(declaration, `исходник содержит функцию ${functionName}`);
  let snippet = declaration.getText(parsed);
  for (const [needle, replacement] of edits) {
    const mutated = snippet.replace(needle, replacement);
    assert.notEqual(mutated, snippet, `якорь мутанта ${functionName} найден: ${needle}`);
    snippet = mutated;
  }
  const mutantModule = { exports: {} as Record<string, unknown> };
  const js = ts.transpileModule(snippet, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(js, {
    ...globals, module: mutantModule, exports: mutantModule.exports,
    Date, Map, Set, Promise, Buffer, fetch: globalThis.fetch,
  });
  const mutant = mutantModule.exports[functionName];
  assert.equal(typeof mutant, 'function', `контрфактическая версия ${functionName} экспортируется`);
  return mutant as T;
}

async function mutantModule<T>(sourceUrl: URL, from: string, to: string): Promise<T> {
  const source = readFileSync(sourceUrl, 'utf8').replace(/\r\n/g, '\n'); assert.ok(source.includes(from), 'якорь контрфакта существует');
  const parsed = ts.createSourceFile(sourceUrl.pathname, source, ts.ScriptTarget.Latest, true);
  const imports: Record<string, unknown> = {};
  for (const decl of parsed.statements) {
    if (!ts.isImportDeclaration(decl) || !ts.isStringLiteral(decl.moduleSpecifier) || decl.importClause?.isTypeOnly) continue;
    const spec = decl.moduleSpecifier.text;
    imports[spec] = await import(spec.startsWith('.') ? new URL(spec, sourceUrl).href : spec);
  }
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Date, Map, Set, Buffer, URL, Promise, console,
      require: (spec: string) => { assert.ok(spec in imports, `известная зависимость ${spec}`); return imports[spec]; }, fetch: globalThis.fetch });
  return module.exports as T;
}

async function seed(): Promise<void> {
  await t.raw.exec(`
    INSERT INTO users (id, username, display_name, password_hash) VALUES
      ('a','alpha','Alpha','hash'),('b','bravo','Bravo','hash'),('c','charlie','Charlie','hash'),
      ('d','delta','Delta','hash'),('e','echo','Echo','hash'),('f','foxtrot','Foxtrot','hash'),
      ('g','golf','Golf','hash'),('h','hotel','Hotel','hash');
    INSERT INTO conversations (id,kind,direct_key,created_by) VALUES
      ('dm','direct','a:b','a'),('pin2','direct','a:c','a'),('pin3','direct','a:d','a'),
      ('pin4','direct','a:e','a'),('pin5','direct','a:f','a'),('pin6','direct','a:g','a');
    INSERT INTO conversation_members (conversation_id,user_id) VALUES
      ('dm','a'),('dm','b'),('pin2','a'),('pin2','c'),('pin3','a'),('pin3','d'),
      ('pin4','a'),('pin4','e'),('pin5','a'),('pin5','f'),('pin6','a'),('pin6','g');
    INSERT INTO servers (id,name,owner_id) VALUES ('presence-server','Presence','a');
    INSERT INTO server_members (server_id,user_id) VALUES ('presence-server','a'),('presence-server','b');
  `);
}

async function insertMessage(id: string, author: string, sortKey: number, attachments: unknown[] = [], conversation = 'dm'): Promise<void> {
  const payload = JSON.stringify(attachments).replaceAll("'", "''");
  await t.raw.exec(`INSERT INTO conversation_messages (id,conversation_id,author_id,sort_key,content,attachments)
    VALUES ('${id}','${conversation}','${author}',${sortKey},'${id}','${payload}'::jsonb)`);
}

before(async () => {
  t = await createTestDb();
  const auth = await import('../src/auth.js');
  setSuperAdminId = auth.setSuperAdminId;
  const { convRoutes } = await import('../src/routes/conv.js');
  const { convGroupRoutes } = await import('../src/routes/convGroups.js');
  const { pushRoutes } = await import('../src/routes/push.js');
  const { serverRoutes } = await import('../src/routes/servers.js');
  const { adminRoutes } = await import('../src/routes/admin.js');
  const { dmFolderRoutes } = await import('../src/routes/dmFolders.js');
  const { messageRoutes } = await import('../src/routes/messages.js');
  const { stickerRoutes } = await import('../src/routes/stickers.js');
  const { userRoutes } = await import('../src/routes/users.js');
  const { callRoutes } = await import('../src/routes/calls.js');
  const { contactRoutes } = await import('../src/routes/contacts.js');
  ({ redisPub } = await import('../src/realtime.js'));
  ({ setAttachmentStoreForTests } = await import('../src/attachments.js'));
  tokenFor = (id) => auth.signToken({ sub: id, username: id, gen: 0 });
  redisPub.publish = (async (channel: string, message: string) => { published.push({ channel, message }); return 1; }) as typeof redisPub.publish;
  redisPub.incr = (async (key: string) => forceEditRateLimit && key.startsWith('rl:conv-edit:') ? 100 : 1) as typeof redisPub.incr;
  redisPub.expire = (async () => 1) as typeof redisPub.expire;
  redisPub.ttl = (async () => 10) as typeof redisPub.ttl;
  app = Fastify();
  app.setErrorHandler((err: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'validation', details: err.issues });
    return reply.send(err);
  });
  await app.register(convRoutes);
  await app.register(convGroupRoutes);
  await app.register(pushRoutes);
  await app.register(serverRoutes);
  await app.register(adminRoutes);
  await app.register(dmFolderRoutes);
  await app.register(messageRoutes);
  await app.register(stickerRoutes);
  await app.register(userRoutes);
  await app.register(callRoutes);
  await app.register(contactRoutes);
  await app.register((await import('../src/routes/channels.js')).channelRoutes);
  await app.ready();
});

beforeEach(async () => {
  await truncateAll(t.raw);
  (await import('../src/blocks.js')).resetBlockCacheForTests();
  published.length = 0;
  pushed.length = 0;
  forceEditRateLimit = false;
  setSuperAdminId('a');
  globalThis.fetch = (async (url: string | URL | Request) => { pushed.push(String(url)); return new Response(null, { status: 200 }); }) as typeof fetch;
  await seed();
});

after(async () => {
  setSuperAdminId(null);
  setAttachmentStoreForTests(null);
  globalThis.fetch = originalFetch;
  await app.close();
  redisPub.disconnect();
  await t.close();
});

test('R159 сводка 1:1 передаёт причину, длительность и видео последней записи звонка обоим участникам', async () => {
  // Запись в БД содержит запасной текст: именно service, а не текст, должен дать структурированное превью.
  const marks = [
    { reason: 'missed', duration: 0 },
    { reason: 'busy', duration: 0 },
    { reason: 'hangup', duration: 125, video: true },
    { reason: 'hangup', duration: 0, video: false },
  ];
  for (const [index, mark] of marks.entries()) {
    const id = `r159-call-${index}`;
    await insertMessage(id, 'a', 100 + index);
    await t.raw.query('UPDATE conversation_messages SET service=$1::jsonb WHERE id=$2',
      [JSON.stringify({ kind: 'call', callId: `call-${index}`, ...mark }), id]);
    for (const viewer of ['a', 'b']) {
      const res = await app.inject({ method: 'GET', url: '/conv', headers: authHeader(viewer) });
      assert.equal(res.statusCode, 200, res.body);
      const last = res.json().conversations.find((c: { id: string }) => c.id === 'dm')?.lastMessage;
      assert.ok(last, 'сводка содержит последнее сообщение');
      assert.equal(last.id, id); assert.equal(last.authorId, 'a'); assert.equal(last.text, id);
      assert.deepEqual(last.call, { reason: mark.reason, duration: mark.duration, ...(mark.video ? { video: true } : {}) },
        'сводка сохраняет причину и длительность, признак видео только при true');
      assert.equal(Object.hasOwn(last.call, 'callId'), false, 'идентификатор сессии не нужен превью');
    }
  }
});

async function seedR159GroupCall(): Promise<void> {
  await t.raw.exec(`INSERT INTO conversations(id,kind,created_by,title) VALUES ('r159-group','group','a','Группа');
    INSERT INTO conversation_members(conversation_id,user_id) VALUES ('r159-group','a'),('r159-group','b');`);
  await insertMessage('r159-group-call', 'b', 200, [], 'r159-group');
  await t.raw.query('UPDATE conversation_messages SET service=$1::jsonb WHERE id=$2',
    [JSON.stringify({ kind: 'call', callId: 'group-call', reason: 'hangup', duration: 65, video: true }), 'r159-group-call']);
}

async function checkR159GroupCall(api: typeof import('../src/conversations.js')): Promise<void> {
  const list = await api.listConversations('a', true);
  const last = list.conversations.find(c => c.id === 'r159-group')?.lastMessage;
  assert.ok(last, 'групповая сводка присутствует');
  assert.equal(last.id, 'r159-group-call'); assert.equal(last.service, true);
  assert.equal(Object.hasOwn(last, 'call'), false, 'группа не получает поле call для 1:1');
}

test('R159 групповая служебная запись не получает поле call даже с валидной меткой звонка', async () => {
  await seedR159GroupCall();
  await checkR159GroupCall(await import('../src/conversations.js'));
  const res = await app.inject({ method: 'GET', url: '/conv?groups=1', headers: authHeader('a') });
  assert.equal(res.statusCode, 200, res.body);
  const last = res.json().conversations.find((c: { id: string }) => c.id === 'r159-group')?.lastMessage;
  assert.ok(last); assert.equal(last.service, true);
  assert.equal(Object.hasOwn(last, 'call'), false, 'HTTP тоже не выдаёт поле звонка группе');
});

test('R159 текст и незнакомые или неполные service не получают поле call в сводке 1:1', async () => {
  for (const [index, service] of [null, { kind: 'future', reason: 'missed', callId: 'unknown' },
    { kind: 'call', reason: 'missed' }].entries()) {
    const id = `r159-no-call-${index}`;
    await insertMessage(id, 'b', 300 + index);
    await t.raw.query('UPDATE conversation_messages SET service=$1::jsonb WHERE id=$2',
      [service === null ? null : JSON.stringify(service), id]);
    const res = await app.inject({ method: 'GET', url: '/conv', headers: authHeader('a') });
    assert.equal(res.statusCode, 200, res.body);
    const last = res.json().conversations.find((c: { id: string }) => c.id === 'dm')?.lastMessage;
    assert.ok(last); assert.equal(last.id, id); assert.equal(last.text, id);
    assert.equal(Object.hasOwn(last, 'call'), false, 'обычный текст и чужая метка остаются без call');
  }
});

test('R159 контрфакт без ограничения 1:1 ошибочно добавляет поле call группе', async () => {
  await seedR159GroupCall();
  const api = await import('../src/conversations.js');
  await checkR159GroupCall(api);
  const from = '...(!isGroup ? lastCallOf(r.lm_svc) : {}),';
  const moduleSource = readFileSync(new URL('../src/conversations.ts', import.meta.url), 'utf8');
  assert.equal(moduleSource.split(from).length - 1, 1, 'контрфакт меняет единственное ограничение звонка группой');
  const wrong = await mutantModule<typeof api>(new URL('../src/conversations.ts', import.meta.url),
    from, '...lastCallOf(r.lm_svc),');
  await assert.rejects(checkR159GroupCall(wrong),
    (error: unknown) => error instanceof assert.AssertionError && error.message.includes('группа не получает поле call'));
});

test('R125 тридцать минут принимаются, лишняя миллисекунда отвергается в беседе и канале', async () => {
  // Ловит расхождение нового потолка между беседой и каналом.
  const { env } = await import('../src/env.js');
  const publicUrl=env.minio.publicUrl;
  env.minio.publicUrl='https://media.example.test';
  try {
  await t.raw.exec(`INSERT INTO channels(id,server_id,name,type) VALUES ('duration-channel','presence-server','Чат','text')`);
  for(const [i,path] of ['/conv/dm/messages','/channels/duration-channel/messages'].entries()) {
    const id=`91000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`;
    await t.raw.query(`INSERT INTO attachments(id,conversation_id,owner_id,storage_key,name,content_type,size,state) VALUES ($1,'dm','a',$2,'voice.webm','audio/webm',1,'pending')`,[id,`duration-${i}`]);
    const attachment=path.startsWith('/conv/') ? {id} : {url:`${env.minio.publicUrl.replace(/\/+$/,'')}/${env.minio.bucket}/duration.webm`,name:'voice.webm',contentType:'audio/webm',size:1};
    const send=(durationMs:number)=>app.inject({method:'POST',url:path,headers:authHeader('a'),payload:{content:'',attachments:[{...attachment,durationMs}],...(path.startsWith('/conv/')?{clientId:`92000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`}:{})}});
    const rejected=await send(1_800_001);assert.equal(rejected.statusCode,400,rejected.body);assert.equal(rejected.json().error,'validation');
    const accepted=await send(1_800_000);assert.equal(accepted.statusCode,201,accepted.body);
    assert.equal(accepted.json().attachments[0].durationMs,1_800_000);
  }
  } finally { env.minio.publicUrl=publicUrl; }
});

test('без превью сохраняется при повторе и в истории, но не наследуется пересылкой', async () => {
  // Ловит изменение уже отправленного сообщения повтором и перенос локального выбора на новую пересылку.
  const payload = { clientId: '90000000-0000-4000-8000-000000000001', content: 'https://outside.test/', attachments: [], noPreview: true };
  const sent = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'), payload });
  assert.equal(sent.statusCode, 201, sent.body);
  const id = sent.json().id;
  assert.equal(sent.json().noPreview, true);
  const repeat = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'), payload: { ...payload, noPreview: false } });
  assert.equal(repeat.statusCode, 200, repeat.body); assert.equal(repeat.json().id, id); assert.equal(repeat.json().noPreview, true);
  const history = await app.inject({ method: 'GET', url: '/conv/dm/messages', headers: authHeader('b') });
  assert.equal(history.json().messages.find((m: { id: string }) => m.id === id).noPreview, true);
  const normal = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'), payload: { ...payload, clientId: '90000000-0000-4000-8000-000000000002', noPreview: false } });
  assert.equal(normal.statusCode, 201, normal.body); assert.equal(Object.hasOwn(normal.json(), 'noPreview'), false);
  const forward = await app.inject({ method: 'POST', url: '/conv/pin2/forward', headers: authHeader('a'), payload: { clientId: '90000000-0000-4000-8000-000000000003', fromConversationId: 'dm', messageIds: [id] } });
  assert.equal(forward.statusCode, 201, forward.body); assert.equal(Object.hasOwn(forward.json().messages[0], 'noPreview'), false);
});

test('избранные вытесняют шестой стикер, копия по url находится, события только автору', async () => {
  // Ловит переполнение личного списка, потерю каталожной копии и рассылку приватных предпочтений собеседнику.
  await t.raw.exec(`INSERT INTO sticker_packs (id,server_id,name,title,created_by) VALUES ('fav-pack',NULL,'FavBirds','Птицы','a');
    INSERT INTO stickers (id,pack_id,emoji,url,format,position) SELECT 'fav-'||n,'fav-pack','🪶','https://media.test/'||n,'webp',n FROM generate_series(1,6) n`);
  for (let n = 1; n <= 6; n++) {
    const res = await app.inject({ method: 'PUT', url: `/stickers/faved/fav-${n}`, headers: authHeader('a') });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().faved.length, Math.min(n, 5));
    assert.equal(res.json().faved[0].id, `fav-${n}`);
    await t.raw.exec(`UPDATE user_faved_stickers SET added_at='2026-01-0${n}' WHERE sticker_id='fav-${n}'`);
  }
  const lists = await app.inject({ method: 'GET', url: '/stickers/lists', headers: authHeader('a') });
  assert.deepEqual(lists.json().faved.map((s: { id: string }) => s.id), ['fav-6','fav-5','fav-4','fav-3','fav-2']);
  const copy = await app.inject({ method: 'PUT', url: '/stickers/faved/server-copy?url=https%3A%2F%2Fmedia.test%2F3', headers: authHeader('a') });
  assert.equal(copy.statusCode, 200, copy.body); assert.equal(copy.json().faved[0].id, 'fav-3');
  const miss = await app.inject({ method: 'PUT', url: '/stickers/faved/missing', headers: authHeader('a') }); assert.equal(miss.statusCode, 404);
  const removed = await app.inject({ method: 'DELETE', url: '/stickers/faved/fav-3', headers: authHeader('a') }); assert.equal(removed.statusCode, 200);
  assert.ok(!removed.json().faved.some((s: { id: string }) => s.id === 'fav-3'));
  const events = published.filter((p) => JSON.parse(p.message).m.t === 'stickers.update');
  assert.ok(events.length >= 8); assert.ok(events.every((p) => p.channel === 'gw:user:a'));
  assert.equal((await app.inject({ method: 'GET', url: '/stickers/lists', headers: authHeader('b') })).json().faved.length, 0);
  const api=await import('../src/stickerLists.js');
  const wrong=await mutantModule<typeof api>(new URL('../src/stickerLists.ts',import.meta.url),'publishToUser(userId,',"publishToUser('b',");
  published.length=0;
  await assert.rejects(async()=>{
    await wrong.publishStickerLists('a',lists.json());
    assert.ok(published.length>0 && published.every(p=>p.channel==='gw:user:a'));
  },assert.AssertionError);
});

test('недавние ограничены двадцатью, повтор поднимается, очистка и событие личные', async () => {
  // Ловит накопление хвоста и недавние другого человека в ответе.
  await t.raw.exec(`INSERT INTO sticker_packs (id,server_id,name,title,created_by) VALUES ('recent-pack',NULL,'RecentBirds','Птицы','a');
    INSERT INTO stickers (id,pack_id,emoji,url,format,position) SELECT 'recent-'||n,'recent-pack','🪶','https://recent.test/'||n,'webp',n FROM generate_series(1,21) n`);
  for (let n = 1; n <= 21; n++) {
    const res = await app.inject({ method: 'POST', url: '/stickers/recent', headers: authHeader('a'), payload: { id: `recent-${n}` } });
    assert.equal(res.statusCode, 200, res.body); assert.equal(res.json().recent.length, Math.min(n, 20));
    await t.raw.exec(`UPDATE user_recent_stickers SET used_at='2026-01-${String(n).padStart(2,'0')}' WHERE sticker_id='recent-${n}'`);
  }
  const repeat = await app.inject({ method: 'POST', url: '/stickers/recent', headers: authHeader('a'), payload: { id: 'recent-2' } });
  assert.equal(repeat.json().recent[0].id, 'recent-2'); assert.equal(repeat.json().recent.length, 20);
  assert.equal((await t.raw.query(`SELECT * FROM user_recent_stickers`)).rows.length, 20);
  const clear = await app.inject({ method: 'DELETE', url: '/stickers/recent', headers: authHeader('a') });
  assert.equal(clear.statusCode, 200, clear.body); assert.deepEqual(clear.json().recent, []);
  assert.ok(published.filter((p) => JSON.parse(p.message).m.t === 'stickers.update').every((p) => p.channel === 'gw:user:a'));
});

test('группа принимает пятого, отвергает шестого и исключение не владельцем без изменения состава', async () => {
  // Ловит обход серверного предела и права исключения обычным участником.
  await t.raw.exec(`UPDATE users SET approved_at=now(), verified=true`);
  const create = await app.inject({ method: 'POST', url: '/conv/group', headers: authHeader('a'), payload: { title: 'Компания', userIds: ['b','c','d','e'] } });
  assert.equal(create.statusCode, 201, create.body); const id = create.json().id;
  assert.equal(create.json().group.members.length, 5);
  const tooMany = await app.inject({ method: 'POST', url: `/conv/${id}/members`, headers: authHeader('a'), payload: { userIds: ['f'] } });
  assert.equal(tooMany.statusCode, 409, tooMany.body); assert.equal(tooMany.json().error, 'group_too_many');
  const remove = await app.inject({ method: 'DELETE', url: `/conv/${id}/members/c`, headers: authHeader('b') });
  assert.equal(remove.statusCode, 403, remove.body);
  const members = await t.raw.query(`SELECT user_id FROM conversation_members WHERE conversation_id='${id}' AND left_at IS NULL`);
  assert.equal(members.rows.length, 5);
  const six = await app.inject({ method: 'POST', url: '/conv/group', headers: authHeader('a'), payload: { title: 'Шесть', userIds: ['b','c','d','e','f'] } });
  assert.equal(six.statusCode, 409, six.body);
});

test('notifyGroups глушит только групповую рассылку, а notifyDm оставляет независимым', async () => {
  // Ловит перепутанные тумблеры: личка должна дойти при выключенных группах, группа — при выключенных личных.
  await t.raw.exec(`
    UPDATE users SET approved_at=now(), verified=true;
    UPDATE users SET notify_groups=false, notify_dm=true WHERE id='b';
    UPDATE users SET notify_groups=true, notify_dm=false WHERE id='c';
    INSERT INTO push_devices (id,user_id,device_id,endpoint,platform) VALUES
      ('push-b','b','phone-b','https://ntfy.example.test/b','android'),
      ('push-c','c','phone-c','https://ntfy.example.test/c','android');
  `);
  const send = (conversationId: string, suffix: string) => app.inject({
    method: 'POST', url: `/conv/${conversationId}/messages`, headers: authHeader('a'),
    payload: { content: suffix, attachments: [], clientId: `80000000-0000-4000-8000-${suffix.padStart(12, '0')}` },
  });
  const direct = await send('dm', '1');
  assert.equal(direct.statusCode, 201, direct.body);
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(pushed, ['https://ntfy.example.test/b']);

  pushed.length = 0;
  const group = await app.inject({ method: 'POST', url: '/conv/group', headers: authHeader('a'), payload: { title: 'Птичник', userIds: ['b', 'c'] } });
  assert.equal(group.statusCode, 201, group.body);
  // Создание группы отдельно шлёт pushAdded; сбрасываем его, чтобы проверять только обычную рассылку сообщения.
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  pushed.length = 0;
  const groupMessage = await send(group.json().id, '2');
  assert.equal(groupMessage.statusCode, 201, groupMessage.body);
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(pushed, ['https://ntfy.example.test/c']);
});

test('уход передаёт владение раннему участнику, старый клиент не получает группы и их события', async () => {
  // Ловит утечку неизвестного DTO старому клиенту и сохранение доступа вышедшему.
  await t.raw.exec(`UPDATE users SET approved_at=now(), verified=true`);
  const create = await app.inject({ method: 'POST', url: '/conv/group', headers: authHeader('a'), payload: { title: 'Компания', userIds: ['b','c'] } });
  assert.equal(create.statusCode, 201, create.body); const id = create.json().id;
  const conv = await import('../src/conversations.js');
  const checkCaps = () => {
    const events = published.filter((p) => JSON.parse(p.message).m.t === 'conv.change');
    assert.ok(events.length > 0); assert.ok(events.every((p) => JSON.parse(p.message).cap === 'groups1'));
  }; checkCaps();
  const services = (await t.raw.query<{ id: string }>(`SELECT id FROM conversation_messages WHERE conversation_id='${id}'`)).rows;
  assert.equal(services.length, 1);
  // Повтор 0099 добавляет только поля беседы: service из 0097 не исчезает и не пересоздаётся.
  const beforeService=(await t.raw.query(`SELECT id,service FROM conversation_messages WHERE conversation_id='${id}'`)).rows;
  const {migrationsDir}=await import('../src/db/index.js');
  await t.raw.exec(await readFile(join(migrationsDir,'0099_conv_groups.sql'),'utf8'));
  assert.deepEqual((await t.raw.query(`SELECT id,service FROM conversation_messages WHERE conversation_id='${id}'`)).rows,beforeService);
  const edit = await app.inject({ method: 'PATCH', url: `/conv/${id}/messages/${services[0].id}`, headers: authHeader('a'), payload: { content: 'переписано' } });
  assert.equal(edit.statusCode, 403, edit.body);
  const reply = await app.inject({ method: 'POST', url: `/conv/${id}/messages`, headers: authHeader('a'), payload: { clientId: '90000000-0000-4000-8000-000000000010', content: 'ответ', attachments: [], replyToId: services[0].id } });
  assert.equal(reply.statusCode, 400, reply.body);
  for (const query of ['', '/sync?pts=0']) {
    const res = await app.inject({ method: 'GET', url: '/conv' + query, headers: authHeader('b') });
    assert.ok(!res.json().conversations.some((c: { id: string }) => c.id === id));
    assert.ok(!(res.json().messages ?? []).some((m: { conversationId: string }) => m.conversationId === id));
  }
  assert.ok((await app.inject({ method: 'GET', url: '/conv?groups=1', headers: authHeader('b') })).json().conversations.some((c: { id: string }) => c.id === id));
  const groupMutant = await mutantModule<typeof conv>(new URL('../src/conversations.ts', import.meta.url), "const cap = conv?.kind === 'group' ? FEATURE_GROUPS1 : CAP_CONV1;", 'const cap = CAP_CONV1;');
  published.length = 0;
  const made = await (await import('../src/convGroups.js')).updateGroupInfo('b', id, { title: 'Новое' }); assert.equal(made.kind, 'ok');
  if (made.kind !== 'ok') return;
  await assert.rejects(async () => { await groupMutant.deliver(made.delivery); checkCaps(); }, assert.AssertionError);
  await t.raw.exec(`UPDATE conversation_members SET joined_at=CASE user_id WHEN 'b' THEN '2026-01-01'::timestamptz ELSE '2026-01-02'::timestamptz END WHERE conversation_id='${id}'`);
  const left = await app.inject({ method: 'POST', url: `/conv/${id}/leave`, headers: authHeader('a') }); assert.equal(left.statusCode, 200, left.body);
  const owner = await t.raw.query<{ user_id: string }>(`SELECT user_id FROM conversation_members WHERE conversation_id='${id}' AND role='owner' AND left_at IS NULL`);
  assert.deepEqual(owner.rows.map((r) => r.user_id), ['b']);
  assert.equal((await app.inject({ method: 'GET', url: `/conv/${id}/messages`, headers: authHeader('a') })).statusCode, 404);
});

test('бывшая группа показывает состав на момент личного выхода каждого участника', async () => {
  // Два участника вышли в разное время вокруг добавления нового; нельзя задним числом раскрыть его старым участникам.
  await t.raw.exec(`UPDATE users SET approved_at=now(), verified=true`);
  const created = await app.inject({ method: 'POST', url: '/conv/group', headers: authHeader('a'), payload: { title: 'Состав по времени', userIds: ['b','c'] } });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id as string;
  await t.raw.exec(`UPDATE conversation_members SET joined_at='2026-01-01T00:00:00Z' WHERE conversation_id='${id}'`);
  const leaveC = await app.inject({ method: 'POST', url: `/conv/${id}/leave`, headers: authHeader('c') });
  assert.equal(leaveC.statusCode, 200, leaveC.body);
  await t.raw.exec(`UPDATE conversation_members SET left_at='2026-01-03T00:00:00Z' WHERE conversation_id='${id}' AND user_id='c'`);
  const addD = await app.inject({ method: 'POST', url: `/conv/${id}/members`, headers: authHeader('a'), payload: { userIds: ['d'] } });
  assert.equal(addD.statusCode, 200, addD.body);
  await t.raw.exec(`UPDATE conversation_members SET joined_at='2026-01-04T00:00:00Z' WHERE conversation_id='${id}' AND user_id='d'`);
  const leaveB = await app.inject({ method: 'POST', url: `/conv/${id}/leave`, headers: authHeader('b') });
  assert.equal(leaveB.statusCode, 200, leaveB.body);
  await t.raw.exec(`UPDATE conversation_members SET left_at='2026-01-05T00:00:00Z' WHERE conversation_id='${id}' AND user_id='b'`);

  const formerFor = async (userId: string) => {
    const response = await app.inject({ method: 'GET', url: '/conv?groups=1&former=1', headers: authHeader(userId) });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.ok(Array.isArray(body.former));
    const entry = body.former.find((item: { id: string }) => item.id === id);
    assert.ok(entry, `бывшая группа остаётся в списке ${userId}`);
    assert.ok(entry.group);
    return entry.group.members.map((member: { id: string }) => member.id).join(',');
  };
  assert.equal(await formerFor('c'), 'a,b');
  assert.equal(await formerFor('b'), 'a,d');

  const conv = await import('../src/conversations.js');
  const mutant = await mutantModule<typeof conv>(new URL('../src/conversations.ts', import.meta.url),
    'or(isNull(conversationMembers.leftAt), gt(conversationMembers.leftAt, at))', 'isNull(conversationMembers.leftAt)');
  await assert.rejects(async () => {
    const former = await mutant.listConversations('c', true, true);
    assert.ok(former.former);
    const entry = former.former.find((item: { id: string }) => item.id === id);
    assert.ok(entry);
    assert.ok(entry.group);
    assert.equal(entry.group.members.map((member: { id: string }) => member.id).join(','), 'a,b');
  }, assert.AssertionError);
});

test('две чужие реакции на сообщение дают одну непрочитанную, своя и удалённая не считаются', async () => {
  // Ловит счёт реакций вместо сообщений и уведомление автора о его собственной реакции.
  await insertMessage('react-one', 'a', 10); await insertMessage('react-two', 'a', 20);
  const react = (user: string, id: string, emoji: string, op = 'add') => app.inject({ method: 'POST', url: `/conv/dm/messages/${id}/reactions`, headers: authHeader(user), payload: { emoji, op } });
  const count = async (user: string) => (await app.inject({ method: 'GET', url: '/conv', headers: authHeader(user) })).json().conversations.find((c: { id: string }) => c.id === 'dm').unreadReactions ?? 0;
  assert.equal((await react('a','react-one','🔥')).statusCode, 204); assert.equal(await count('a'), 0);
  assert.equal((await react('b','react-one','🔥')).statusCode, 204); assert.equal(await count('a'), 1); assert.equal(await count('b'), 0);
  await react('b','react-one','❤'); assert.equal(await count('a'), 1);
  await react('b','react-two','🔥'); assert.equal(await count('a'), 2);
  await react('b','react-two','🔥','remove'); assert.equal(await count('a'), 1);
  const big = (user: string, id: string, op: 'add' | 'remove' = 'add', value: boolean | undefined = true) => app.inject({
    method: 'POST', url: `/conv/dm/messages/${id}/reactions`, headers: authHeader(user), payload: { emoji: '🚀', op, big: value },
  });
  published.length = 0;
  const firstBig = await big('b', 'react-two'); assert.equal(firstBig.statusCode, 204);
  const bigEffects = () => published.filter((e) => JSON.parse(e.message).m?.t === 'reaction.big');
  assert.deepEqual(bigEffects().map((e) => e.channel), ['gw:user:a'], 'эффект уходит только собеседнику, не автору реакции');
  assert.equal(JSON.parse(bigEffects()[0]!.message).cap, 'bigreact1', 'старые соединения не получают неподдерживаемый эффект');
  const journalRows = async () => Number((await t.raw.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM user_changes WHERE message_id='react-two'",
  )).rows[0]?.n ?? 0);
  const afterFirstBig = await journalRows();
  published.length = 0;
  assert.equal((await big('b', 'react-two')).statusCode, 204, 'повтор удержания играет эффект повторно');
  assert.deepEqual(bigEffects().map((e) => e.channel), ['gw:user:a']);
  assert.equal(await journalRows(), afterFirstBig, 'повтор эффекта не добавляет журнал или строку реакции');
  published.length = 0;
  assert.equal((await big('b', 'react-two', 'remove')).statusCode, 204);
  assert.deepEqual(bigEffects(), [], 'снятие не играет большой эффект');
  assert.equal((await big('b', 'react-two', 'add', false)).statusCode, 204, 'без big добавляется обычная реакция');
  assert.deepEqual(bigEffects(), [], 'обычная реакция не играет эффект');
  assert.equal((await big('b', 'react-two', 'remove', false)).statusCode, 204, 'обычную реакцию можно снять без эффекта');
  assert.deepEqual(bigEffects(), [], 'снятие обычной реакции тоже не играет эффект');

  await insertMessage('big-withheld','b',25);
  await t.raw.exec("UPDATE conversation_messages SET withheld=true WHERE id='big-withheld'");
  published.length = 0;
  assert.equal((await big('b', 'big-withheld')).statusCode, 204);
  assert.deepEqual(bigEffects(), [], 'придержанное видит только сам реагирующий и не получает эффекта самому себе');
  await t.raw.exec("INSERT INTO user_blocks(blocker_id,blocked_id) VALUES ('a','b')");
  (await import('../src/blocks.js')).resetBlockCacheForTests();
  published.length = 0;
  assert.equal((await big('b', 'react-two')).statusCode, 204);
  assert.deepEqual(bigEffects(), [], 'заблокировавшему реагирующего эффект не приходит');
  assert.equal((await big('b', 'react-two', 'remove')).statusCode, 204, 'убираем реакцию, добавленную в блокированном состоянии');
  await t.raw.exec("DELETE FROM user_blocks WHERE blocker_id='a' AND blocked_id='b'");
  (await import('../src/blocks.js')).resetBlockCacheForTests();
  await t.raw.exec(`UPDATE conversation_messages SET deleted_at=now() WHERE id='react-one'`); assert.equal(await count('a'), 0);
});

test('чтение реакций по ids и целиком личное, повтор не пишет событие, чужой получает 404', async () => {
  // Ловит повторное списание счётчика, чтение чужим и избыточные события на повторе.
  await insertMessage('read-react-one','a',10); await insertMessage('read-react-two','a',20);
  for (const id of ['read-react-one','read-react-two']) await app.inject({ method: 'POST', url: `/conv/dm/messages/${id}/reactions`, headers: authHeader('b'), payload: { emoji: '🔥', op: 'add' } });
  const read = (user: string, payload: object) => app.inject({ method: 'POST', url: '/conv/dm/reactions-read', headers: authHeader(user), payload });
  published.length = 0;
  const one = await read('a', { messageIds: ['read-react-one'] }); assert.equal(one.statusCode, 200, one.body); assert.equal(one.json().read, 1);
  const events = published.length;
  const repeat = await read('a', { messageIds: ['read-react-one'] }); assert.equal(repeat.json().read, 0); assert.equal(published.length, events);
  const all = await read('a', {}); assert.equal(all.json().read, 1);
  assert.equal((await read('c', {})).statusCode, 404);
});

test('поиск из списка фильтрует невидимое, курсор не повторяет строки, дата включает начало и исключает конец', async () => {
  // Ловит раскрытие чужой копии, дубли страниц и день, захвативший следующую полночь.
  for (const [id, author, key] of [['old-search','a',10], ['keep-search','a',20], ['end-search','b',30], ['hidden-search','a',40], ['deleted-search','a',50], ['withheld-search','b',60], ['service-search','a',70]] as const) await insertMessage(id, author, key);
  await t.raw.exec(`UPDATE conversation_messages SET content='Иголка',created_at='2026-01-01T00:00:00Z';
    UPDATE conversation_messages SET created_at='2026-01-02T00:00:00Z' WHERE id='end-search';
    UPDATE conversation_messages SET hidden_for=ARRAY['a'] WHERE id='hidden-search';
    UPDATE conversation_messages SET deleted_at=now() WHERE id='deleted-search';
    UPDATE conversation_messages SET withheld=true WHERE id='withheld-search';
    UPDATE conversation_messages SET service='{"kind":"pin","messageId":"keep-search"}' WHERE id='service-search';
    UPDATE conversation_members SET hidden_key=10 WHERE conversation_id='dm' AND user_id='a';
    INSERT INTO conversations (id,kind,direct_key,created_by) VALUES ('foreign-search','direct','c:d','c');
    INSERT INTO conversation_members(conversation_id,user_id) VALUES ('foreign-search','c'),('foreign-search','d')`);
  await insertMessage('foreign-search-message','c',80,[],'foreign-search');
  await t.raw.exec(`UPDATE conversation_messages SET content='Иголка' WHERE id='foreign-search-message'`);
  const get = (query: string) => app.inject({ method: 'GET', url: '/conv/search'+query, headers: authHeader('a') });
  assert.equal((await get('')).statusCode, 400);
  const first = await get('?q=иголка&limit=1'); assert.equal(first.statusCode,200,first.body);
  assert.deepEqual(first.json().hits.map((h: {id:string})=>h.id), ['end-search']); assert.ok(first.json().next);
  const next = await get('?q=иголка&limit=1&before='+encodeURIComponent(first.json().next));
  assert.deepEqual(next.json().hits.map((h:{id:string})=>h.id), ['keep-search']); assert.equal(next.json().next,null);
  const period = await get('?conversationId=dm&since=2026-01-01T00%3A00%3A00Z&until=2026-01-02T00%3A00%3A00Z');
  assert.deepEqual(period.json().hits.map((h:{id:string})=>h.id), ['keep-search']);
  const conv = await import('../src/conversations.js');
  const query = { pattern: null, conversationId:'dm', since:new Date('2026-01-01T00:00:00Z'), until:new Date('2026-01-02T00:00:00Z'), limit:30 };
  const check = async (api: typeof conv) => assert.equal((await api.searchAllConversations('a',query)).hits.map(h=>h.id).join(','),'keep-search');
  await check(conv);
  for (const [from,to] of [['x.created_at < ${qy.until.toISOString()}', 'x.created_at <= ${qy.until.toISOString()}'], ['sql`(m.hidden_key IS NULL OR x.sort_key > m.hidden_key)`,','sql`true`,']] as const)
    await assert.rejects(async()=>check(await mutantModule<typeof conv>(new URL('../src/conversations.ts',import.meta.url),from,to)),assert.AssertionError);
  await conv.hideConversation('a', (await conv.loadAccess('dm','a'))!, false);
  assert.deepEqual((await get('?q=иголка')).json().hits,[]);
});

test('счёт непрочитанных реакций отсекает увиденное, чужого автора и заблокированного: три SQL-мутанта', async () => {
  // Ловит ложную кнопку сердца и обход приватности реакций.
  for (const [id,author,key] of [['r-live','a',10],['r-seen','a',20],['r-other','b',30],['r-block','a',40]] as const) await insertMessage(id,author,key);
  await t.raw.exec(`INSERT INTO conversation_message_reactions (message_id,user_id,emoji,seen_at) VALUES
    ('r-live','b','🔥',NULL),('r-seen','b','🔥',now()),('r-other','b','🔥',NULL),('r-block','c','🔥',NULL);
    INSERT INTO user_blocks(blocker_id,blocked_id) VALUES ('a','c')`);
  const conv = await import('../src/conversations.js');
  const check = async (api: typeof conv) => assert.equal((await api.listConversations('a')).conversations.find(c=>c.id==='dm')!.unreadReactions,1);
  await check(conv);
  for (const [from,to] of [['r.seen_at IS NULL AND x.conversation_id = c.id','true AND x.conversation_id = c.id'],['AND x.author_id = ${me} AND r.user_id <> ${me}','AND r.user_id <> ${me}'],['AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id = ${me} AND b.blocked_id = r.user_id)','']] as const)
    await assert.rejects(async()=>check(await mutantModule<typeof conv>(new URL('../src/conversations.ts',import.meta.url),from,to)),assert.AssertionError);
});

test('asFile ограничен изображениями/видео, а round требует квадрат и предел длительности и копируется при пересылке', async () => {
  // Ловит и принудительный round у прямоугольного/длинного ролика, и потерю признанного кружка в копии.
  const { Readable } = await import('node:stream');
  setAttachmentStoreForTests({ ready:()=>true,ensureReady:async()=>true,configured:()=>true,
    put:async()=>{},stat:async()=>({size:1}),get:async()=>Readable.from([Buffer.from('x')]),remove:async()=>{},copy:async()=>{} });
  try {
    await t.raw.exec(`INSERT INTO attachments(id,conversation_id,owner_id,storage_key,name,content_type,size,state) VALUES
      ('90000000-0000-4000-8000-000000000101','dm','a','dm/flag-photo','x.png','image/png',1,'pending'),
      ('90000000-0000-4000-8000-000000000102','dm','a','dm/flag-video','x.mp4','video/mp4',1,'pending'),
      ('90000000-0000-4000-8000-000000000103','dm','a','dm/flag-doc','x.pdf','application/pdf',1,'pending'),
      ('90000000-0000-4000-8000-000000000104','dm','a','dm/round-ok','round.mp4','video/mp4',1,'pending'),
      ('90000000-0000-4000-8000-000000000105','dm','a','dm/round-rect','rect.mp4','video/mp4',1,'pending'),
      ('90000000-0000-4000-8000-000000000106','dm','a','dm/round-long','long.mp4','video/mp4',1,'pending')`);
    const sent = await app.inject({method:'POST',url:'/conv/dm/messages',headers:authHeader('a'),payload:{clientId:'90000000-0000-4000-8000-000000000020',content:'',attachments:[
      {id:'90000000-0000-4000-8000-000000000101',asFile:true},
      {id:'90000000-0000-4000-8000-000000000102',asFile:true},
      {id:'90000000-0000-4000-8000-000000000103',asFile:true},
      {id:'90000000-0000-4000-8000-000000000104',width:384,height:384,durationMs:61_000,round:true},
      {id:'90000000-0000-4000-8000-000000000105',width:384,height:383,durationMs:10_000,round:true},
      {id:'90000000-0000-4000-8000-000000000106',width:384,height:384,durationMs:61_001,round:true},
    ]}});
    assert.equal(sent.statusCode,201,sent.body);
    assert.deepEqual(sent.json().attachments.map((a:{asFile?:true})=>a.asFile),[true,true,undefined,undefined,undefined,undefined]);
    assert.deepEqual(sent.json().attachments.map((a:{round?:true})=>a.round),[undefined,undefined,undefined,true,undefined,undefined]);
    const stored = await t.raw.query<{attachments:{asFile?:true;round?:true}[]}>(`SELECT attachments FROM conversation_messages WHERE id='${sent.json().id}'`);
    assert.deepEqual(stored.rows[0].attachments.map(a=>a.asFile),[true,true,undefined,undefined,undefined,undefined]);
    assert.deepEqual(stored.rows[0].attachments.map(a=>a.round),[undefined,undefined,undefined,true,undefined,undefined]);
    const forward=await app.inject({method:'POST',url:'/conv/pin2/forward',headers:authHeader('a'),payload:{clientId:'90000000-0000-4000-8000-000000000021',fromConversationId:'dm',messageIds:[sent.json().id]}});
    assert.equal(forward.statusCode,201,forward.body);
    assert.deepEqual(forward.json().messages[0].attachments.map((a:{asFile?:true})=>a.asFile),[true,true,undefined,undefined,undefined,undefined]);
    assert.deepEqual(forward.json().messages[0].attachments.map((a:{round?:true})=>a.round),[undefined,undefined,undefined,true,undefined,undefined]);
  } finally { setAttachmentStoreForTests(null); }
});

test('общие медиа считают SQL-вложения, скрывают недоступное, листаются курсором и режутся по выходу', async () => {
  // Ловит расхождение SQL с видом файла и утечку удалённого/спрятанного сообщения или истории после выхода.
  const payloads = [
    ['media-one', 'b', 10, [{ id: 'image-one', name: 'one.png', contentType: 'image/png', size: 1 }]],
    ['file-one', 'b', 20, [{ id: 'image-file', name: 'file.png', contentType: 'image/png', size: 1, asFile: true }]],
    ['gif-one', 'b', 30, [{ id: 'video-gif', name: 'loop.mp4', contentType: 'video/mp4', size: 1, gif: true }]],
    ['voice-one', 'b', 40, [{ id: 'voice', name: 'voice.ogg', contentType: 'audio/ogg', size: 1, waveform: [1] }]],
    ['link-one', 'b', 50, []],
    ['media-two', 'b', 60, [{ id: 'video', name: 'clip.mp4', contentType: 'video/mp4', size: 1 }]],
    ['hidden-media', 'b', 70, [{ id: 'hidden', name: 'hidden.png', contentType: 'image/png', size: 1 }]],
    ['deleted-media', 'b', 80, [{ id: 'deleted', name: 'deleted.png', contentType: 'image/png', size: 1 }]],
    ['withheld-media', 'b', 90, [{ id: 'withheld', name: 'withheld.png', contentType: 'image/png', size: 1 }]],
    ['service-media', 'b', 100, [{ id: 'service', name: 'service.png', contentType: 'image/png', size: 1 }]],
    ['once-image', 'b', 110, [{ id: 'once-image', name: 'once.png', contentType: 'image/png', size: 1, once: true }]],
    ['once-round', 'b', 120, [{ id: 'once-round', name: 'once.mp4', contentType: 'video/mp4', size: 1, round: true, once: true }]],
    ['round-voice', 'b', 130, [{ id: 'round-voice', name: 'round.mp4', contentType: 'video/mp4', size: 1, round: true }]],
    ['once-voice', 'b', 140, [{ id: 'once-voice', name: 'once.ogg', contentType: 'audio/ogg', size: 1, waveform: [1], once: true }]],
  ] as const;
  for (const [id, author, key, attachments] of payloads) await insertMessage(id, author, key, [...attachments]);
  await t.raw.exec(`
    UPDATE conversation_messages SET content='ссылка https://example.test/page' WHERE id='link-one';
    UPDATE conversation_messages SET hidden_for=ARRAY['a'] WHERE id='hidden-media';
    UPDATE conversation_messages SET deleted_at=now() WHERE id='deleted-media';
    UPDATE conversation_messages SET withheld=true WHERE id='withheld-media';
    UPDATE conversation_messages SET service='{"kind":"pin","messageId":"media-one"}' WHERE id='service-media';
  `);
  const get = (url: string, user = 'a') => app.inject({ method: 'GET', url, headers: authHeader(user) });
  const counts = await get('/conv/dm/media/counts');
  assert.equal(counts.statusCode, 200, counts.body);
  assert.deepEqual(counts.json(), { media: 2, file: 1, link: 1, gif: 1, voice: 3 });
  const first = await get('/conv/dm/media?kind=media&limit=1');
  assert.deepEqual(first.json().messages.map((m: { id: string }) => m.id), ['media-two']);
  assert.ok(first.json().next);
  const second = await get(`/conv/dm/media?kind=media&limit=1&before=${encodeURIComponent(first.json().next)}`);
  assert.deepEqual(second.json().messages.map((m: { id: string }) => m.id), ['media-one']);
  assert.equal(second.json().next, null);
  for (const kind of ['file', 'gif', 'voice', 'link']) {
    const page = await get(`/conv/dm/media?kind=${kind}`);
    assert.equal(page.statusCode, 200, page.body);
    assert.equal(page.json().messages.length, kind === 'voice' ? 3 : 1, `SQL-категория ${kind} выбрала ровно своё сообщение`);
    if (kind === 'voice') {
      const ids = page.json().messages.map((m: { id: string }) => m.id);
      assert.ok(ids.includes('round-voice') && ids.includes('once-voice'));
      assert.ok(!ids.includes('once-round'), 'одноразовый кружок не попадает в список голосовых, обычное one-shot voice остаётся');
    }
  }
  const conv = await import('../src/conversations.js');
  const search = await conv.searchAllConversations('a', { pattern: null, conversationId: 'dm', kind: 'media', limit: 50 });
  assert.deepEqual(search.hits.map((m) => m.id), ['media-two', 'media-one']);
  const withOnceMedia = await mutantModule<typeof conv>(new URL('../src/conversations.ts', import.meta.url),
    "AND NOT (${t}.attachments @> '[{\"once\": true}]'::jsonb)", '');
  await assert.rejects(async () => {
    const result = await withOnceMedia.searchAllConversations('a', { pattern: null, conversationId: 'dm', kind: 'media', limit: 50 });
    assert.deepEqual(result.hits.map((m) => m.id), ['media-two', 'media-one']);
  }, assert.AssertionError, 'поиск тоже не выдаёт одноразовое вложение');
  const onceRoundVisible = await mutantModule<typeof conv>(new URL('../src/conversations.ts', import.meta.url),
    "AND NOT (${t}.attachments @> '[{\"once\": true, \"round\": true}]'::jsonb)", '');
  await assert.rejects(async () => {
    const result = await onceRoundVisible.searchAllConversations('a', { pattern: null, conversationId: 'dm', kind: 'voice', limit: 50 });
    assert.ok(!result.hits.some((m) => m.id === 'once-round'));
  }, assert.AssertionError, 'снятие предиката должно раскрыть кружок-мутант');
  const source = new URL('../src/conversations.ts', import.meta.url);
  const withoutVisibility = await mutantModule<typeof conv>(source,
    'const base = and(visibleTo(me, conversationId), isNull(conversationMessages.service))!;',
    'const base = and(eq(conversationMessages.conversationId, conversationId), isNull(conversationMessages.service))!;');
  await assert.rejects(async () => {
    assert.deepEqual(await withoutVisibility.sharedMediaCounts('a', 'dm', false), { media: 2, file: 1, link: 1, gif: 1, voice: 3 });
  }, assert.AssertionError, 'снятие visibleTo включает скрытое, удалённое и придержанное');
  assert.equal((await get('/conv/dm/media?kind=unknown')).statusCode, 400);
  assert.equal((await get('/conv/dm/media?kind=media&limit=51')).statusCode, 400);
  assert.equal((await get('/conv/dm/media?kind=media', 'h')).statusCode, 404);

  const leftAt = new Date(Date.now() - 5_000);
  const beforeLeave = new Date(leftAt.getTime() - 1_000);
  await t.raw.exec(`
    INSERT INTO conversations(id,kind,created_by) VALUES ('former-media','group','a');
    INSERT INTO conversation_members(conversation_id,user_id) VALUES ('former-media','a'),('former-media','b');
    INSERT INTO conversation_members(conversation_id,user_id,left_at) VALUES ('former-media','c','${leftAt.toISOString()}');
    INSERT INTO conversation_messages(id,conversation_id,author_id,sort_key,content,attachments,created_at)
      VALUES ('old-photo','former-media','b',10,'old','[{"id":"old","contentType":"image/png","name":"old.png","size":1}]', '${beforeLeave.toISOString()}'),
             ('new-photo','former-media','b',20,'new','[{"id":"new","contentType":"image/png","name":"new.png","size":1}]', '${new Date(leftAt.getTime()+1_000).toISOString()}');
  `);
  assert.equal((await get('/conv/former-media/media?kind=media', 'c')).statusCode, 404, 'бывшая история без former не открывается');
  const former = await get('/conv/former-media/media?kind=media&former=1', 'c');
  assert.deepEqual(former.json().messages.map((m: { id: string }) => m.id), ['old-photo']);
  assert.deepEqual((await get('/conv/former-media/media/counts?former=1', 'c')).json(), { media: 1, file: 0, link: 0, gif: 0, voice: 0 });
  assert.equal((await get('/conv/former-media/media?kind=media&former=1', 'h')).statusCode, 404);
  const withoutLeftBoundary = await mutantModule<typeof conv>(source,
    'return leftAt ? (and(base, lte(conversationMessages.createdAt, leftAt)) as SQL) : base;',
    'return leftAt ? base : base;');
  await assert.rejects(async () => {
    const result = await withoutLeftBoundary.sharedMedia('c', 'former-media', 'media', undefined, 50, true);
    assert.deepEqual(result?.messages.map((m) => m.id), ['old-photo']);
  }, assert.AssertionError, 'без created_at <= left_at бывшему открывается фото после выхода');
});

test('жалоба незнакомца собирает только его видимые улики, склеивается за сутки и закрывается только админом', async () => {
  // Улики — копия только доступной истории собеседника; нельзя переслать в модерацию мои, удалённые или скрытые сообщения.
  for (let i = 1; i <= 7; i++) await insertMessage(`report-peer-${i}`, 'b', i * 10);
  await insertMessage('report-mine', 'a', 75);
  await insertMessage('report-deleted', 'b', 80);
  await insertMessage('report-hidden', 'b', 85);
  await insertMessage('report-withheld', 'b', 90);
  await t.raw.exec(`
    UPDATE conversation_messages SET deleted_at=now() WHERE id='report-deleted';
    UPDATE conversation_messages SET hidden_for=ARRAY['a'] WHERE id='report-hidden';
    UPDATE conversation_messages SET withheld=true WHERE id='report-withheld';
    INSERT INTO conversations(id,kind,created_by) VALUES ('report-group','group','a');
    INSERT INTO conversation_members(conversation_id,user_id) VALUES ('report-group','a'),('report-group','b');
  `);
  const hide = () => app.inject({ method: 'POST', url: '/conv/dm/stranger/hide', headers: authHeader('a'), payload: {} });
  assert.equal((await hide()).statusCode, 200);
  const eventsAfterHide = published.length;
  assert.equal((await hide()).statusCode, 200);
  assert.equal(published.length, eventsAfterHide, 'повторное скрытие плашки не пишет второе событие');

  const report = (body: unknown) => app.inject({ method: 'POST', url: '/conv/dm/report', headers: authHeader('a'), payload: body });
  assert.equal((await report({ reason: 'made-up' })).statusCode, 400);
  const first = await report({ reason: 'spam', comment: `  ${'c'.repeat(600)}  ` });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().merged, false);
  const rows = await t.raw.query<{ id: string; comment: string | null; evidence: { messageId: string; text: string }[] }>(
    'SELECT id, comment, evidence FROM dm_reports',
  );
  assert.equal(rows.rows.length, 1);
  const reportId = rows.rows[0].id;
  assert.equal(rows.rows[0].comment?.length, 512);
  assert.deepEqual(rows.rows[0].evidence.map((e) => e.messageId), ['report-peer-3', 'report-peer-4', 'report-peer-5', 'report-peer-6', 'report-peer-7']);
  assert.equal((await t.raw.query<{ stranger_hidden_at: Date | null }>(
    "SELECT stranger_hidden_at FROM conversation_members WHERE conversation_id='dm' AND user_id='a'",
  )).rows[0].stranger_hidden_at instanceof Date, true);

  await insertMessage('report-peer-new', 'b', 100);
  const repeat = await report({ reason: 'scam', comment: 'обновлено' });
  assert.equal(repeat.statusCode, 200, repeat.body);
  assert.equal(repeat.json().merged, true);
  const updated = (await t.raw.query<{ id: string; reason: string; comment: string | null; evidence: { messageId: string }[] }>(
    'SELECT id, reason, comment, evidence FROM dm_reports',
  )).rows[0];
  assert.equal(updated.id, reportId);
  assert.equal(updated.reason, 'scam');
  assert.equal(updated.comment, 'обновлено');
  assert.equal(updated.evidence.at(-1)?.messageId, 'report-peer-new');
  assert.equal((await app.inject({ method: 'POST', url: '/conv/report-group/report', headers: authHeader('a'), payload: { reason: 'spam' } })).statusCode, 400);

  setSuperAdminId('h');
  assert.equal((await app.inject({ method: 'GET', url: '/admin/dm-reports', headers: authHeader('a') })).statusCode, 403);
  const listed = await app.inject({ method: 'GET', url: '/admin/dm-reports', headers: authHeader('h') });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().reports[0].id, reportId);
  const close = (id: string) => app.inject({ method: 'POST', url: `/admin/dm-reports/${id}/close`, headers: authHeader('h'), payload: {} });
  assert.equal((await close(reportId)).statusCode, 200);
  assert.equal((await close(reportId)).statusCode, 404, 'повторное закрытие уже не является изменением');
  const reports = await import('../src/dmReports.js');
  const reopenMutant = await mutantModule<typeof reports>(new URL('../src/dmReports.ts', import.meta.url),
    ".where(and(eq(dmReports.id, id), eq(dmReports.status, 'new')))" , '.where(eq(dmReports.id, id))');
  await assert.rejects(async () => assert.equal(await reopenMutant.closeDmReport(reportId), false), assert.AssertionError,
    'мутант без условия new повторно затрагивает уже закрытую запись');
});

test('плашка незнакомца видна только до ответа, общего сервера, блока или явного скрытия', async () => {
  // Иначе незнакомцем станет пустая/уже отвеченная беседа или человек, которого я знаю по серверу.
  await insertMessage('stranger-peer', 'c', 10, [], 'pin2');
  await insertMessage('stranger-deleted', 'e', 10, [], 'pin4');
  await t.raw.exec("UPDATE conversation_messages SET deleted_at=now() WHERE id='stranger-deleted'");
  const conv = await import('../src/conversations.js');
  const summary = async (id: string, api: typeof conv = conv) => (await api.listConversations('a')).conversations.find((c) => c.id === id);
  assert.equal((await summary('pin2'))?.stranger, true, 'собеседник c написал, общей площадки и моего ответа нет');
  assert.equal((await summary('pin4'))?.stranger, undefined, 'пустая беседа с удалённым сообщением не зажигает плашку');

  const source = new URL('../src/conversations.ts', import.meta.url);
  const ownReply = await mutantModule<typeof conv>(source,
    'AND NOT EXISTS (SELECT 1 FROM conversation_messages sx WHERE sx.conversation_id = c.id AND sx.author_id = ${me}\n        AND sx.deleted_at IS NULL AND sx.service IS NULL)', '');
  await insertMessage('stranger-own-reply', 'a', 20, [], 'pin2');
  assert.equal((await summary('pin2'))?.stranger, undefined);
  await assert.rejects(async () => assert.equal((await summary('pin2', ownReply))?.stranger, undefined), assert.AssertionError,
    'без NOT EXISTS по моим сообщениям плашка остаётся после ответа');

  await insertMessage('known-peer-message', 'd', 10, [], 'pin3');
  await t.raw.exec("INSERT INTO server_members(server_id,user_id) VALUES ('presence-server','d')");
  assert.equal((await summary('pin3'))?.stranger, undefined, 'общий активный сервер означает знакомого');
  const withoutCommonServer = await mutantModule<typeof conv>(source,
    'AND NOT EXISTS (SELECT 1 FROM server_members sa JOIN server_members sb ON sb.server_id = sa.server_id AND sb.state = \'active\'\n        WHERE sa.user_id = ${me} AND sa.state = \'active\' AND sb.user_id = ${peer})', '');
  await assert.rejects(async () => assert.equal((await summary('pin3', withoutCommonServer))?.stranger, undefined), assert.AssertionError,
    'без проверки общего сервера знакомый ошибочно считается незнакомцем');

  const hide = await app.inject({ method: 'POST', url: '/conv/pin2/stranger/hide', headers: authHeader('a'), payload: {} });
  assert.equal(hide.statusCode, 200, hide.body);
  assert.equal((await app.inject({ method: 'GET', url: '/conv', headers: authHeader('a') })).json().conversations.find((c: { id: string }) => c.id === 'pin2')?.stranger, undefined);
});

test('звонок проверяет право на ЛС, встречный вызов становится ответом, ping пишет видео и hangup журналирует итог', async () => {
  // Гость не должен звонить без токена; занятый вызов не создаёт вторую линию, а встречный отвечает на первую.
  assert.equal((await app.inject({ method: 'GET', url: '/calls/active' })).statusCode, 401);
  await t.raw.exec(`
    INSERT INTO conversations(id,kind,direct_key,created_by) VALUES
      ('calls-group','group',NULL,'a'),('calls-saved','direct','a:a','a');
    INSERT INTO conversation_members(conversation_id,user_id) VALUES
      ('calls-group','a'),('calls-group','b'),('calls-saved','a');
    INSERT INTO push_devices(id,user_id,device_id,endpoint) VALUES ('call-phone','b','android-call','https://ntfy.example.test/call-topic');
  `);
  const start = (conversationId: string, user = 'a', device = 'phone') => app.inject({
    method: 'POST', url: `/conv/${conversationId}/call`, headers: authHeader(user), payload: { device },
  });
  const exceptions = (user: string, always: string[], never: string[]) => app.inject({
    method: 'PUT', url: '/users/me/call-exceptions', headers: authHeader(user), payload: { always, never },
  });
  await t.raw.exec("UPDATE users SET call_privacy='peers' WHERE id='c'");
  const cCanCall = async () => (await app.inject({ method: 'GET', url: '/users/c/last-seen', headers: authHeader('a') })).json().canCall;
  assert.equal(await cCanCall(), false, 'пустая беседа не принимает незнакомца для звонка');
  assert.equal((await start('pin2')).statusCode, 403, 'для «Собеседников» незнакомцу отказано');
  const peerQueries = await import('../src/db/peerQueries.js');
  const { callAllowedFor } = await import('../src/callPrivacy.js');
  const dbModule = await import('../src/db/index.js');
  const schema = await import('../src/db/schema.js');
  const drizzle = await import('drizzle-orm');
  const callRules = await import('../src/callRules.js');
  const arePeersMutant = mutateExportedFunction<typeof callAllowedFor>(new URL('../src/callPrivacy.ts', import.meta.url), 'callAllowedFor',
    [['isAcceptedPeer(calleeId, callerId)', 'arePeers(calleeId, callerId)']], {
      db: dbModule.db, and: drizzle.and, eq: drizzle.eq, users: schema.users, privacyExceptions: schema.privacyExceptions,
      normalizeCallPrivacy: callRules.normalizeCallPrivacy, callAllowed: callRules.callAllowed, KEY: 'calls',
      arePeers: peerQueries.arePeers,
    });
  await insertMessage('accepted-owner-reply', 'c', 11, [], 'pin2');
  assert.equal(await cCanCall(), true, 'ответ владельца принимает незнакомца, и HTTP canCall совпадает');
  const acceptedCall = await start('pin2'); assert.equal(acceptedCall.statusCode, 201, acceptedCall.body);
  assert.equal((await app.inject({ method: 'POST', url: `/calls/${acceptedCall.json().call.id}/hangup`, headers: authHeader('a'), payload: {} })).statusCode, 200);
  await t.raw.exec("UPDATE conversation_messages SET deleted_at=now() WHERE id='accepted-owner-reply'");
  assert.equal(await cCanCall(), false, 'удалённый ответ перестаёт принимать незнакомца');
  assert.equal(await callAllowedFor('a','c'), false);
  assert.equal(await arePeersMutant('a','c'), true, 'мутант со старыми arePeers ошибочно считает любую direct-беседу принятием');
  assert.equal((await exceptions('c', ['a'], [])).statusCode, 200);
  assert.equal(await cCanCall(), true, 'исключение always сильнее peers');
  const exceptionCall = await start('pin2'); assert.equal(exceptionCall.statusCode, 201, exceptionCall.body);
  assert.equal((await app.inject({ method: 'POST', url: `/calls/${exceptionCall.json().call.id}/hangup`, headers: authHeader('a'), payload: {} })).statusCode, 200);
  await exceptions('c', [], ['a']);
  assert.equal(await cCanCall(), false, 'исключение never сильнее peers и прежнего ответа');
  assert.equal((await start('pin2')).statusCode, 403, 'HTTP call тоже уважает исключение never');
  await t.raw.exec("DELETE FROM privacy_exceptions WHERE owner_id='c' AND key='calls'; UPDATE users SET call_privacy='everyone' WHERE id='c'");

  await t.raw.exec("UPDATE users SET call_privacy='peers' WHERE id='b'");
  const bCanCall = async () => (await app.inject({ method: 'GET', url: '/users/b/last-seen', headers: authHeader('a') })).json().canCall;
  assert.equal(await bCanCall(), true, 'общий активный сервер принимает собеседника');
  const serverCall = await start('dm'); assert.equal(serverCall.statusCode, 201, serverCall.body);
  assert.equal((await app.inject({ method: 'POST', url: `/calls/${serverCall.json().call.id}/hangup`, headers: authHeader('a'), payload: {} })).statusCode, 200);
  await t.raw.exec("UPDATE users SET call_privacy='nobody' WHERE id='b'");
  assert.equal(await bCanCall(), false);
  const denied = await start('dm');
  assert.equal(denied.statusCode, 403); assert.match(denied.json().error, /call_privacy/);
  const conflict = await exceptions('b', ['a'], ['a']);
  assert.equal(conflict.statusCode, 200, conflict.body);
  assert.deepEqual(conflict.json().always, []); assert.deepEqual(conflict.json().never.map((u: { id: string }) => u.id), ['a']);
  assert.equal(await bCanCall(), false, 'never сильнее always в конфликтных списках');
  assert.equal((await start('dm')).statusCode, 403);
  assert.equal((await exceptions('b', ['a'], [])).statusCode, 200);
  assert.equal(await bCanCall(), true);
  const allowedByException = await start('dm', 'a', 'privacy-test');
  assert.equal(allowedByException.statusCode, 201, allowedByException.body);
  assert.equal((await app.inject({ method: 'POST', url: `/calls/${allowedByException.json().call.id}/hangup`, headers: authHeader('a'), payload: {} })).statusCode, 200);
  await t.raw.exec("DELETE FROM privacy_exceptions WHERE owner_id='b'; UPDATE users SET call_privacy='everyone' WHERE id='b'");
  await t.raw.exec("INSERT INTO user_blocks(blocker_id,blocked_id) VALUES ('a','b')");
  (await import('../src/blocks.js')).resetBlockCacheForTests();
  assert.equal((await start('dm')).statusCode, 403, 'заблокировавший не может начать звонок');
  await t.raw.exec("DELETE FROM user_blocks WHERE blocker_id='a' AND blocked_id='b'");
  (await import('../src/blocks.js')).resetBlockCacheForTests();
  await t.raw.exec("INSERT INTO user_blocks(blocker_id,blocked_id) VALUES ('b','a')");
  assert.equal((await start('dm')).statusCode, 403, 'заблокированный не может дозвониться в обратную сторону');
  await t.raw.exec("DELETE FROM user_blocks WHERE blocker_id='b' AND blocked_id='a'");
  (await import('../src/blocks.js')).resetBlockCacheForTests();
  assert.equal((await start('calls-group')).statusCode, 400, 'группа не является звонком 1:1');
  assert.equal((await start('calls-saved')).statusCode, 400, 'Избранное не является звонком');

  const ringing = await start('dm', 'a', 'desktop-a');
  assert.equal(ringing.statusCode, 201, ringing.body);
  const callId = ringing.json().call.id as string;
  assert.equal(ringing.json().call.phase, 'ringing');
  await t.raw.exec("UPDATE users SET call_privacy='nobody' WHERE id='b'");
  const busy = await start('pin2');
  assert.equal(busy.statusCode, 409, 'тот же участник не может занять вторую линию');
  const crossCall = await start('dm', 'b', 'android-b');
  assert.equal(crossCall.statusCode, 200, crossCall.body);
  assert.equal(crossCall.json().call.id, callId);
  assert.equal(crossCall.json().call.phase, 'active');
  assert.equal(crossCall.json().call.calleeDevice, 'android-b', 'встречный вызов отвечает с устройства собеседника');

  const ping = await app.inject({ method: 'POST', url: `/calls/${callId}/ping`, headers: authHeader('b'), payload: { video: true } });
  assert.equal(ping.statusCode, 200, ping.body);
  assert.equal(ping.json().call.video, true);
  const activeOnOtherDevice = await app.inject({ method: 'GET', url: '/calls/active', headers: authHeader('b') });
  assert.equal(activeOnOtherDevice.json().call.id, callId);
  assert.equal(activeOnOtherDevice.json().call.calleeDevice, 'android-b');
  assert.equal((await app.inject({ method: 'POST', url: `/calls/${callId}/answer`, headers: authHeader('a'), payload: { device: 'wrong' } })).statusCode, 409,
    'звонивший не может ответить на собственный звонок');
  assert.equal((await app.inject({ method: 'POST', url: `/calls/${callId}/hangup`, headers: authHeader('a'), payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/calls/active', headers: authHeader('b') })).json().call, null);
  const records = await t.raw.query<{ service: { kind: string; reason: string; video?: boolean }; silent: boolean }>(
    "SELECT service,silent FROM conversation_messages WHERE conversation_id='dm' AND service->>'kind'='call' ORDER BY sort_key",
  );
  assert.deepEqual(records.rows.map((r) => [r.service.reason, r.service.video]), [
    ['missed', undefined], ['missed', undefined], ['hangup', true],
  ], 'R96 добавляет отдельный успешный звонок через общий сервер до обычного answered/hangup');

  // После проверки штатного журнала запускаем контрфакт отдельно: старая семантика arePeers ошибочно принимает пустую ЛС.
  const callsRouteModule = await import('../src/routes/calls.js');
  const routeDbModule = await import('../src/db/index.js');
  const routeSchema = await import('../src/db/schema.js');
  const routeDrizzle = await import('drizzle-orm');
  const callState = await import('../src/calls.js');
  const callAuth = await import('../src/auth.js');
  const callGuard = await import('../src/authGuard.js');
  const callBlocks = await import('../src/blocks.js');
  const callConversations = await import('../src/conversations.js');
  const callDmRules = await import('../src/dmRules.js');
  const sharedCalls = await import('@gusvoice/shared');
  const { z } = await import('zod');
  const arePeersRoute = mutateExportedFunction<typeof callsRouteModule.callRoutes>(new URL('../src/routes/calls.ts', import.meta.url), 'callRoutes',
    [['if (!answering && !(await callAllowedFor(me, peerId)))', 'if (!answering && !(await arePeers(peerId, me)))']], {
      CALL_BUSY_ERROR: sharedCalls.CALL_BUSY_ERROR, CALL_PRIVACY_ERROR: sharedCalls.CALL_PRIVACY_ERROR,
      eq: routeDrizzle.eq, z, requireAuth: callAuth.requireAuth, rateHit: callGuard.rateHit, isBlockedBy: callBlocks.isBlockedBy,
      arePeers: peerQueries.arePeers, act: callState.act, callById: callState.callById, callJoin: callState.callJoin,
      callOf: callState.callOf, ping: callState.ping, startCall: callState.startCall, loadAccess: callConversations.loadAccess,
      db: routeDbModule.db, users: routeSchema.users, canWriteDm: callDmRules.canWriteDm,
      idParams: z.object({ id: z.string().min(1).max(64) }), deviceBody: z.object({ device: z.string().min(1).max(64) }),
      pingBody: z.object({ video: z.boolean().optional() }).passthrough().nullish(),
      CALL_START_MAX: 10, CALL_START_WINDOW_S: 60, CALL_UNAVAILABLE: 'Позвонить нельзя',
    });
  const mutantCallApp = Fastify();
  await mutantCallApp.register(arePeersRoute);
  await mutantCallApp.ready();
  const mutantHttp = await mutantCallApp.inject({ method: 'POST', url: '/conv/pin2/call', headers: authHeader('a'), payload: { device: 'mutant' } });
  assert.equal(mutantHttp.statusCode, 201, 'HTTP-контрфакт со старыми arePeers ошибочно разрешает звонок незнакомцу');
  assert.equal((await mutantCallApp.inject({ method: 'POST', url: `/calls/${mutantHttp.json().call.id}/hangup`, headers: authHeader('a'), payload: {} })).statusCode, 200);
  await mutantCallApp.close();
});

test('общий закреп создаёт одну служебную строку, личный и повтор не создают, строка не правится и не пересылается', async () => {
  // Ловит лишнее сообщение/непрочитанное и превращение служебного события в редактируемый пользовательский текст.
  await insertMessage('pin-source', 'a', 10);
  const conv = await import('../src/conversations.js'); const access = await conv.loadAccess('dm', 'a'); assert.ok(access);
  const shared = await conv.pinMessage('a', access, 'pin-source', 'both'); assert.equal(shared.kind, 'ok');
  const services = async () => (await t.raw.query<{ id: string; author_id: string; content: string; service: {kind:string;messageId:string} }>(`SELECT id,author_id,content,service FROM conversation_messages WHERE service IS NOT NULL`)).rows;
  const rows = await services(); assert.equal(rows.length,1); assert.equal(rows[0].author_id,'a'); assert.ok(rows[0].content);
  assert.deepEqual(rows[0].service,{kind:'pin',messageId:'pin-source'});
  const viewed = await conv.messageFor(rows[0].id,'b'); assert.ok(viewed && !('gone' in viewed)); assert.deepEqual(viewed.service,rows[0].service);
  const noField=await mutantModule<typeof conv>(new URL('../src/conversations.ts',import.meta.url),'...(m.service ? { service: m.service } : {}),','');
  const wrong=await noField.messageFor(rows[0].id,'b'); assert.ok(wrong&&!('gone' in wrong));
  assert.throws(()=>assert.deepEqual(wrong.service,rows[0].service),assert.AssertionError);
  assert.equal((await conv.listConversations('b')).conversations.find(s=>s.id==='dm')?.unread,2, 'служебная строка добавляет одно непрочитанное');
  await conv.pinMessage('a',access,'pin-source','both'); assert.equal((await services()).length,1);
  assert.equal((await conv.editMessage('a',access,rows[0].id,'изменено')).kind,'forbidden');
  const forwarded = await conv.forwardMessages('a',access,{clientId:'00000000-0000-4000-8000-000000000888',fromConversationId:'dm',messageIds:[rows[0].id],withheld:false,silent:false});
  assert.equal(forwarded.kind,'source-missing');
  await conv.deleteMessage('a',access,rows[0].id,'both'); assert.equal((await services()).length,0);
  await insertMessage('pin-mine','a',20); await conv.pinMessage('a',access,'pin-mine','me'); assert.equal((await services()).length,0);
  await insertMessage('pin-block','a',30); await t.raw.exec(`INSERT INTO user_blocks (blocker_id,blocked_id) VALUES ('b','a')`);
  await conv.pinMessage('a',access,'pin-block','both'); assert.equal((await services()).length,0);
  await insertMessage('pin-mine-mutant','a',40);
  const forMine=await mutantModule<typeof conv>(new URL('../src/conversations.ts',import.meta.url),'if (changed.some((id) => id !== me))','if (changed.length > 0)');
  await forMine.pinMessage('a',access,'pin-mine-mutant','me');
  const extra=(await services()).length;
  assert.throws(()=>assert.equal(extra,0),assert.AssertionError);
});

test('read_at ставится только чужим впервые накрытым сообщениям, повтор сохраняет дату, блок не выдаёт новое прочтение', async () => {
  // Ловит перезапись первого времени прочтения и утечку чтения придержанного сообщения.
  for (const [id, author, key] of [['r1','a',10], ['r2','b',20], ['r3','a',30]] as const) await insertMessage(id, author, key);
  const conv = await import('../src/conversations.js'); const last = await import('../src/lastSeen.js');
  const b = await conv.loadAccess('dm', 'b'); const a = await conv.loadAccess('dm', 'a'); assert.ok(a && b);
  await conv.markRead('b', b, 30);
  const dates = async () => (await t.raw.query<{ id: string; read_at: string | null }>(`SELECT id,read_at FROM conversation_messages WHERE conversation_id='dm' ORDER BY sort_key`)).rows;
  const first = await dates(); assert.ok(first[0].read_at); assert.equal(first[1].read_at, null); assert.ok(first[2].read_at);
  await conv.markRead('b', b, 30); assert.deepEqual(await dates(), first);
  assert.ok((await last.readAtFor('a', a, 'r1'))?.at);
  assert.equal(await last.readAtFor('b', b, 'r1'), null);
  await t.raw.exec(`INSERT INTO user_blocks (blocker_id,blocked_id) VALUES ('b','a')`);
  await insertMessage('r4', 'a', 40); await t.raw.exec(`UPDATE conversation_messages SET withheld=true WHERE id='r4'`);
  await conv.markRead('b', b, 40);
  const hidden = await last.readAtFor('a', a, 'r4'); assert.equal(hidden?.read, false); assert.equal(hidden?.at, null);
});

test('ручка last-seen уважает соседство, взаимность и invisible, serializeUser отдаёт настройки только себе', async () => {
  // Ловит точную дату чужому и настройки приватности в чужом профиле.
  await t.raw.exec(`UPDATE users SET last_seen_at='2026-10-06T12:00:00Z',last_seen_privacy='peers' WHERE id IN ('a','b','h')`);
  const get = (id: string) => app.inject({ method: 'GET', url: `/users/${id}/last-seen`, headers: authHeader('a') });
  const peer = (await get('b')).json(); assert.equal(peer.exact, true); assert.ok(peer.at);
  assert.equal((await get('h')).json().exact, false);
  await t.raw.exec(`UPDATE users SET last_seen_privacy='nobody' WHERE id='a'`);
  const mutual = (await get('b')).json(); assert.equal(mutual.at, null); assert.equal(mutual.byMe, true);
  await t.raw.exec(`UPDATE users SET last_seen_privacy='everyone' WHERE id='a'; UPDATE users SET presence_status='invisible' WHERE id='b'`);
  const hidden = (await get('b')).json(); assert.equal(hidden.exact, true); assert.ok(hidden.at, 'invisible влияет только на серверы, а в ЛС время видно по приватности');
  assert.equal((await get('absent')).statusCode, 404);
  const { db } = await import('../src/db/index.js'); const { users } = await import('../src/db/schema.js');
  const { serializeUser } = await import('../src/serialize.js'); const row = (await db.select().from(users).where(sql`${users.id}='a'`))[0];
  assert.equal(serializeUser(row).lastSeenPrivacy, 'everyone');
  for (const key of ['lastSeenPrivacy','hideReadTime']) assert.equal(Object.hasOwn(serializeUser(row, 'b'), key), false);
});

test('исключения времени захода дедуплицируются, никогда побеждает всегда, пачка ограничена и гостю закрыта', async () => {
  // Ловит утечку при пересечении списков, самоблок/висячие id, обход потолка и доступ гостя к локальным настройкам.
  const put = (user: string, always: string[], never: string[]) => app.inject({
    method: 'PUT', url: '/users/me/last-seen-exceptions', headers: authHeader(user), payload: { always, never },
  });
  const both = await put('a', ['b', 'b', 'a', 'missing'], ['b', 'b', 'a', 'missing']);
  assert.equal(both.statusCode, 200, both.body);
  assert.deepEqual(both.json(), { always: [], never: [{ id: 'b', username: 'bravo', displayName: 'Bravo', avatarUrl: null }] });

  await t.raw.exec("UPDATE users SET last_seen_privacy='nobody' WHERE id='b'");
  let batch = await app.inject({ method: 'POST', url: '/users/last-seen', headers: authHeader('a'), payload: { ids: ['b', 'b', 'missing'] } });
  assert.equal(batch.statusCode, 200, batch.body);
  assert.equal(batch.json().items.length, 1, 'дубликаты схлопнуты, неизвестный человек пропущен');
  assert.equal(batch.json().items[0].exact, false, 'never сильнее одновременного always');

  await put('a', [], []); // снимаем собственное «never»: для exact всегда нужна взаимность обеих сторон.
  const always = await put('b', ['a', 'a', 'b', 'missing'], []);
  assert.equal(always.statusCode, 200, always.body);
  assert.deepEqual(always.json().always.map((u: { id: string }) => u.id), ['a']);
  batch = await app.inject({ method: 'POST', url: '/users/last-seen', headers: authHeader('a'), payload: { ids: ['b'] } });
  assert.equal(batch.json().items[0].exact, true, 'subject explicitly shares with this viewer despite nobody');

  await t.raw.exec(`
    INSERT INTO users (id,username,display_name,password_hash)
      SELECT 'ls-'||n, 'lastseen'||n, 'LS', 'hash' FROM generate_series(1,201) n;
    UPDATE users SET home_instance_id='home', home_user_id='remote-h' WHERE id='h';
  `);
  const twoHundred = Array.from({ length: 200 }, (_, i) => `ls-${i + 1}`);
  assert.equal((await put('a', twoHundred, [])).statusCode, 200, 'ровно 200 исключений допускается');
  assert.equal((await app.inject({ method: 'GET', url: '/users/me/last-seen-exceptions', headers: authHeader('a') })).json().always.length, 200);
  assert.equal((await put('a', [...twoHundred, 'ls-201'], [])).statusCode, 400, '201-е отклоняется на границе API');
  assert.equal((await put('h', [], [])).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/users/me/last-seen-exceptions', headers: authHeader('h') })).statusCode, 403);
});

test('когда будет в сети отвергает скрытое время, при взаимно открытом принимает сообщение', async () => {
  // Ловит обход приватности через момент доставки отложенного сообщения.
  const request = (n: number) => app.inject({ method: 'POST', url: '/conv/dm/scheduled', headers: authHeader('a'), payload: {
    content: 'проверка', attachments: [], whenOnline: true, clientId: `00000000-0000-4000-8000-${String(n).padStart(12,'0')}` } });
  await t.raw.exec(`UPDATE users SET last_seen_privacy='nobody' WHERE id='b'`);
  const rejected = await request(901); assert.equal(rejected.statusCode, 409); assert.equal(rejected.json().error, 'schedule_status_private');
  await t.raw.exec(`UPDATE users SET last_seen_privacy='peers' WHERE id='b'`);
  assert.equal((await request(902)).statusCode, 201);
});

test('архив принадлежит участнику, повтор не пишет журнал, событие уходит только владельцу', async () => {
  // Ловит широковещательную личную настройку и бессмысленный прирост pts от повторного PUT.
  const put = (user: string, archived: boolean) => app.inject({ method: 'PUT', url: '/conv/dm/archived', headers: authHeader(user), payload: { archived } });
  assert.equal((await put('c', true)).statusCode, 404);
  assert.equal((await put('a', true)).statusCode, 200);
  const count = async () => (await t.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM user_changes`)).rows[0].n;
  const n = await count(); assert.ok(n > 0);
  assert.equal((await put('a', true)).statusCode, 200); assert.equal(await count(), n);
  const rows = (await t.raw.query<{ user_id: string; archived_at: string | null }>(`SELECT user_id,archived_at FROM conversation_members WHERE conversation_id='dm' ORDER BY user_id`)).rows;
  assert.ok(rows[0].archived_at); assert.equal(rows[1].archived_at, null);
  const events = published.filter(p => JSON.parse(p.message).m?.t === 'conv.change');
  assert.ok(events.length); assert.ok(events.every(p => p.channel === 'gw:user:a'));
  await t.raw.exec(`UPDATE conversation_members SET left_at=now() WHERE conversation_id='dm' AND user_id='a'`);
  assert.equal((await put('a', false)).statusCode, 404);
});

test('сообщение возвращает из архива автора и незаглушённого адресата, но не действующие мьюты', async () => {
  // Ловит перепутанную семантику soundOnly, истёкшего мьюта и личного исходящего сообщения.
  const conv = await import('../src/conversations.js');
  const db = (await import('../src/db/index.js')).db;
  const check = async (api = conv) => {
    for (const [until, sound, recipientArchived] of [[null, false, true], ['future', false, true], ['past', false, false], [null, true, false], ['none', false, false]] as const) {
      await t.raw.exec(`DELETE FROM push_mutes; UPDATE conversation_members SET archived_at=now() WHERE conversation_id='dm';`);
      if (until !== 'none') await t.raw.exec(`INSERT INTO push_mutes (user_id,scope,target_id,until,sound_only) VALUES ('b','dm_user','a',${until === null ? 'NULL' : until === 'future' ? "now()+interval '1 hour'" : "now()-interval '1 second'"},${sound})`);
      await db.transaction(tx => api.unarchiveOnMessage(tx, 'dm', 'a', ['a', 'b']));
      const rows = (await t.raw.query<{ user_id: string; archived: boolean }>(`SELECT user_id,archived_at IS NOT NULL AS archived FROM conversation_members WHERE conversation_id='dm' ORDER BY user_id`)).rows;
      assert.equal(rows[0].archived, false, 'своё сообщение всегда возвращает');
      assert.equal(rows[1].archived, recipientArchived, `${until}/${sound}`);
    }
    await t.raw.exec(`UPDATE conversation_members SET archived_at=now() WHERE conversation_id='dm'`);
    await db.transaction(tx => api.unarchiveOnMessage(tx, 'dm', 'a', ['a']));
    assert.equal((await t.raw.query<{ archived: boolean }>(`SELECT archived_at IS NOT NULL AS archived FROM conversation_members WHERE conversation_id='dm' AND user_id='b'`)).rows[0].archived, true, 'придержанный адресат отсутствует в аудитории');
  };
  await check();
  for (const [from, to] of [['AND NOT pm.sound_only', ''], ['AND NOT pm.sound_only AND (pm.until IS NULL OR pm.until > now())', 'AND NOT pm.sound_only'], ['m.user_id = ${authorId} OR NOT EXISTS', 'm.user_id <> ${authorId} AND NOT EXISTS']]) {
    const bad = await mutantModule<typeof conv>(new URL('../src/conversations.ts', import.meta.url), from, to);
    await assert.rejects(() => check(bad), assert.AssertionError);
  }
});

test('пересылка вызывает возврат из архива, придержанная копия не возвращает адресата', async () => {
  // Ловит забытый вызов правила архива в отдельной ветке forwardMessages.
  await insertMessage('archive-source', 'c', 10, [], 'pin2');
  const conv = await import('../src/conversations.js'); const access = await conv.loadAccess('dm', 'a'); assert.ok(access);
  let counter = 0;
  const check = async (api = conv) => {
    for (const withheld of [false, true]) {
      await t.raw.exec(`UPDATE conversation_members SET archived_at=now() WHERE conversation_id='dm'`);
      const res = await api.forwardMessages('a', access, { fromConversationId: 'pin2', messageIds: ['archive-source'],
        clientId: `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`, withheld, silent: false });
      assert.equal(res.kind, 'created');
      const rows = (await t.raw.query<{ user_id: string; archived: boolean }>(`SELECT user_id,archived_at IS NOT NULL AS archived FROM conversation_members WHERE conversation_id='dm' ORDER BY user_id`)).rows;
      assert.equal(rows[0].archived, false); assert.equal(rows[1].archived, withheld);
    }
  }; await check();
  const from = '      await unarchiveOnMessage(tx, conversationId, me, audience);\n      const entries = rows.flatMap';
  const bad = await mutantModule<typeof conv>(new URL('../src/conversations.ts', import.meta.url), from, '      const entries = rows.flatMap');
  await assert.rejects(() => check(bad), assert.AssertionError);
});

test('поиск фильтрует видимость, считает всё совпавшее, выдаёт новые первыми и продолжает по курсору', async () => {
  // Ловит утечку скрытого/удалённого текста и total, ошибочно равный размеру страницы.
  for (let i = 1; i <= 7; i++) await insertMessage(`s${i}`, i === 7 ? 'a' : 'b', i * 10);
  await t.raw.exec(`UPDATE conversation_messages SET content='Needle' WHERE conversation_id='dm';
    UPDATE conversation_messages SET hidden_for=ARRAY['a']::text[] WHERE id IN ('s1','s4');
    UPDATE conversation_messages SET deleted_at=now() WHERE id='s3';
    UPDATE conversation_messages SET withheld=true WHERE id IN ('s5','s7');`);
  const get = (user: string, query = 'nEeDlE', before?: string) => app.inject({ method: 'GET', url: `/conv/dm/search?q=${encodeURIComponent(query)}&limit=2${before ? `&before=${encodeURIComponent(before)}` : ''}`, headers: authHeader(user) });
  const first = await get('a'); assert.equal(first.statusCode, 200);
  const body = first.json(); assert.equal(body.total, 3); assert.deepEqual(body.hits.map((m: { id: string }) => m.id), ['s7', 's6']); assert.ok(body.next);
  const next = (await get('a', 'needle', body.next)).json(); assert.equal(next.total, 3); assert.deepEqual(next.hits.map((m: { id: string }) => m.id), ['s2']); assert.equal(next.next, null);
  assert.equal((await get('c')).statusCode, 404); assert.equal((await get('a', ' ')).statusCode, 400);
  const conv = await import('../src/conversations.js');
  const check = async (api: typeof conv) => {
    const found = await api.searchConversation('a', 'dm', '%needle%', undefined, 2);
    assert.equal(found?.total, 3); assert.deepEqual(found?.hits.map(m => m.id), ['s7', 's6']);
  };
  for (const [from, to] of [
    ['    isNull(conversationMessages.deletedAt),', ''],
    ['    sql`NOT (${me} = ANY(${conversationMessages.hiddenFor}))`,', ''],
    ['    or(eq(conversationMessages.withheld, false), eq(conversationMessages.authorId, me)),', ''],
    ['.orderBy(desc(key))\n      .limit(limit + 1)', '.orderBy(asc(key))\n      .limit(limit + 1)'],
    ['total: Number(n), hits, next:', 'total: hits.length, hits, next:'],
  ]) await assert.rejects(() => mutantModule<typeof conv>(new URL('../src/conversations.ts', import.meta.url), from, to).then(check), assert.AssertionError);
  const access = await conv.loadAccess('dm', 'a'); assert.ok(access);
  await t.raw.exec(`UPDATE conversations SET last_sort_key=70 WHERE id='dm'`);
  await conv.clearHistory('a', access, 'me');
  assert.equal((await get('a')).json().total, 0, 'реальная очистка истории скрывает текст от поиска');
  assert.ok((await get('b')).json().total > 0, 'очистка у меня не удаляет текст у собеседника');
});

test('переход к дате строит окно вокруг первого сообщения дня, за концом возвращает хвост', async () => {
  // Ловит перенос якоря на последнее сообщение дня и конфликт двух способов задания окна.
  for (let i = 1; i <= 7; i++) await insertMessage(`day${i}`, 'b', i * 10);
  await t.raw.exec(`UPDATE conversation_messages SET created_at='2026-10-01T00:00:00Z'::timestamptz + sort_key/10 * interval '1 day'`);
  const get = (q: string) => app.inject({ method: 'GET', url: `/conv/dm/messages?limit=4&${q}`, headers: authHeader('a') });
  const day = await get('date=2026-10-05T00%3A00%3A00Z'); assert.equal(day.statusCode, 200);
  assert.deepEqual(day.json().messages.map((m: { id: string }) => m.id), ['day2', 'day3', 'day4', 'day5']);
  const late = await get('date=2026-12-01T00%3A00%3A00Z'); assert.deepEqual(late.json().messages.map((m: { id: string }) => m.id), ['day4', 'day5', 'day6', 'day7']);
  assert.equal((await get('date=2026-10-05T00%3A00%3A00Z&around=day4')).statusCode, 400);
});

test('каталожная копия не дублируется при гонке и только её стикер отправляется в ЛС', async () => {
  // Два устройства импортируют одно имя: копия и файлы должны остаться одними, server-id не годится для ЛС.
  await t.raw.exec(`INSERT INTO sticker_packs (id,server_id,name,title,created_by) VALUES ('server-pack','presence-server','HappyBirds','Птицы','a');
    INSERT INTO stickers (id,pack_id,emoji,url,format,position) VALUES ('server-feather','server-pack','🪶','https://media.example.test/feather.webp','webp',0)`);
  const catalog = await import('../src/stickerCatalog.js');
  const data = [{ emoji: '🪶', url: 'https://media.example.test/feather.webp', format: 'webp' as const, position: 0 }];
  const copies = await Promise.all([catalog.ensureCatalogCopy({ name: 'HappyBirds', title: 'Птицы', createdBy: 'a' }, data), catalog.ensureCatalogCopy({ name: 'HappyBirds', title: 'Птицы', createdBy: 'a' }, data)]);
  assert.equal(copies[0].pack.id, copies[1].pack.id); assert.equal(copies.filter((p) => p.created).length, 1);
  const list = await t.raw.query<{ id: string; url: string }>(`SELECT id,url FROM stickers WHERE pack_id='${copies[0].pack.id}'`);
  assert.equal(list.rows.length, 1); assert.equal(list.rows[0].url, data[0].url);
  assert.equal((await catalog.catalogPackOfSticker('server-feather', null))?.id, copies[0].pack.id);
  const send = (stickerId: string, clientId: string) => app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'), payload: { content: '', attachments: [], stickerId, clientId } });
  assert.equal((await send('server-feather', '80000000-0000-4000-8000-000000000001')).statusCode, 400);
  const good = await send(list.rows[0].id, '80000000-0000-4000-8000-000000000002');
  assert.equal(good.statusCode, 201, good.body);
  const summaries = await app.inject({ method: 'GET', url: '/conv', headers: authHeader('a') });
  assert.equal(summaries.json().conversations.find((c: { id: string }) => c.id === 'dm').lastMessage.attachmentKind, 'sticker');
  const denied = await app.inject({ method: 'DELETE', url: `/stickers/packs/${copies[0].pack.id}`, headers: authHeader('b') });
  assert.equal(denied.statusCode, 403);
});

test('сорок загрузок запрещают новую, но повтор каталога не расходует квоту', async () => {
  // Проверяется порядок reused до квоты: заполненный лимит не должен запретить добавление чужого готового набора.
  await t.raw.exec(`INSERT INTO sticker_packs (id,server_id,name,title,created_by) SELECT 'quota-'||n,NULL,'QuotaBirds'||n,'Птицы','a' FROM generate_series(1,40) n`);
  const create = (name: string) => app.inject({ method: 'POST', url: '/stickers/packs', headers: authHeader('a'), payload: { name } });
  const over = await create('NewBirds'); assert.equal(over.statusCode, 400); assert.equal(over.json().reason, 'stickers.quota');
  const reused = await create('QuotaBirds1'); assert.equal(reused.statusCode, 200, reused.body); assert.equal(reused.json().reused, true);
  const mine = await t.raw.query(`SELECT pack_id FROM user_sticker_packs WHERE user_id='a'`); assert.equal(mine.rows.length, 1);
});

test('канал отдаёт малым реакциям список по времени, четырём — только число и me', async () => {
  // Проверяет порог и время в настоящем DTO, а не только клиентскую сортировку.
  await t.raw.exec(`INSERT INTO channels (id,server_id,name,type) VALUES ('react-channel','presence-server','Чат','text');
    INSERT INTO messages (id,channel_id,author_id,content) VALUES ('react-msg','react-channel','a','x');
    INSERT INTO message_reactions (message_id,user_id,emoji,created_at) VALUES
    ('react-msg','a','👍','2026-10-08T03:00:00Z'),('react-msg','b','👍','2026-10-08T01:00:00Z'),('react-msg','c','👍','2026-10-08T02:00:00Z')`);
  const get = () => app.inject({ method: 'GET', url: '/channels/react-channel/messages', headers: authHeader('a') });
  const first = await get(); assert.equal(first.statusCode, 200, first.body);
  const small = first.json()[0].reactions[0];
  assert.equal(small.count, 3); assert.equal(small.me, true);
  assert.deepEqual(small.reactors.map((r: { userId: string }) => r.userId), ['b', 'c', 'a']);
  await t.raw.exec(`INSERT INTO message_reactions (message_id,user_id,emoji) VALUES ('react-msg','d','👍')`);
  const large = (await get()).json()[0].reactions[0];
  assert.equal(large.count, 4); assert.equal(large.me, true); assert.equal(Object.hasOwn(large, 'reactors'), false);
});

test('папки создают одну системную, соблюдают предел 10 и не раскрывают чужие записи', async () => {
  // Проверяет реальные права/ограничения ручек, которые чистые правила не могут гарантировать.
  const first = await app.inject({ method: 'GET', url: '/dm-folders', headers: authHeader('a') });
  const second = await app.inject({ method: 'GET', url: '/dm-folders', headers: authHeader('a') });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(second.json(), first.json());
  const system = first.json().folders[0].id;
  const input = { title: 'Личные', flags: 1, include: ['dm', 'missing'], exclude: [] };
  for (const method of ['PUT', 'DELETE'] as const) {
    const res = await app.inject({ method, url: `/dm-folders/${system}`, headers: authHeader('a'), ...(method === 'PUT' ? { payload: input } : {}) });
    assert.equal(res.statusCode, 400); assert.equal(res.json().reason, 'folders.system');
  }
  let mine = '';
  for (let i = 0; i < 10; i++) {
    const res = await app.inject({ method: 'POST', url: '/dm-folders', headers: authHeader('a'), payload: input });
    assert.equal(res.statusCode, 200, res.body); mine = res.json().id;
    assert.deepEqual(res.json().folders.find((f: { id: string }) => f.id === mine).include, ['dm']);
  }
  const over = await app.inject({ method: 'POST', url: '/dm-folders', headers: authHeader('a'), payload: input });
  assert.equal(over.statusCode, 400); assert.equal(over.json().reason, 'folders.limit');
  for (const method of ['PUT', 'DELETE'] as const) assert.equal((await app.inject({ method, url: `/dm-folders/${mine}`, headers: authHeader('b'), ...(method === 'PUT' ? { payload: input } : {}) })).statusCode, 404);
  const folders = (await app.inject({ method: 'GET', url: '/dm-folders', headers: authHeader('a') })).json().folders;
  const incomplete = await app.inject({ method: 'PUT', url: '/dm-folders/order', headers: authHeader('a'), payload: { ids: folders.filter((f: { id: string }) => f.id !== system).map((f: { id: string }) => f.id) } });
  assert.equal(incomplete.statusCode, 409);
  const ids = folders.map((f: { id: string }) => f.id).reverse();
  const reordered = await app.inject({ method: 'PUT', url: '/dm-folders/order', headers: authHeader('a'), payload: { ids } });
  assert.equal(reordered.statusCode, 200); assert.deepEqual(reordered.json().folders.map((f: { id: string }) => f.id), ids);
  const events = published.filter((e) => JSON.parse(e.message).m?.t === 'dmFolders.update');
  assert.ok(events.length > 0); assert.ok(events.every((e) => e.channel === 'gw:user:a'));
});

async function shareChannelPermissionSeed(){
  setSuperAdminId(null);
  await t.raw.query(`INSERT INTO roles(id,server_id,name,permissions,is_everyone) VALUES ('share-everyone','presence-server','everyone',$1,true)`,[(Permission.VIEW_CHANNEL|Permission.READ_HISTORY|Permission.SEND_MESSAGES).toString()]);
  await t.raw.query(`INSERT INTO roles(id,server_id,name,permissions) VALUES ('share-admin','presence-server','Admin',$1)`,[Permission.ADMINISTRATOR.toString()]);
  await t.raw.exec(`INSERT INTO server_members(server_id,user_id) VALUES ('presence-server','c');INSERT INTO member_roles(server_id,user_id,role_id) VALUES ('presence-server','c','share-admin');
    INSERT INTO channels(id,server_id,name,type) VALUES ('share-open','presence-server','Обычный','text'),('share-readonly','presence-server','Чтение','text')`);
  await t.raw.query(`INSERT INTO channel_overwrites(channel_id,target_id,target_type,deny) VALUES ('share-readonly','share-everyone','role',$1)`,[Permission.SEND_MESSAGES.toString()]);
}
async function verifyShareCanSend(target=app){
  const response=await target.inject({method:'GET',url:'/servers/presence-server',headers:authHeader('b')});assert.equal(response.statusCode,200,response.body);
  const channels=response.json().channels;assert.equal(channels.find((c:{id:string})=>c.id==='share-open').canSend,true);assert.equal(channels.find((c:{id:string})=>c.id==='share-readonly').canSend,false);
}
test('R128 bootstrap участника учитывает deny SEND_MESSAGES канала, обычный канал остаётся доступным',async()=>{
  // Ловит подмену канального права серверным для целей «Поделиться».
  await shareChannelPermissionSeed();await verifyShareCanSend();
});
test('R128 владелец и администратор получают canSend true даже в канале с запретом everyone',async()=>{
  // Ловит применение рядового overwrite к обходу прав владельца и администратора.
  await shareChannelPermissionSeed();
  for(const user of ['a','c']){const response=await app.inject({method:'GET',url:'/servers/presence-server',headers:authHeader(user)});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().channels.length,2);assert.ok(response.json().channels.every((channel:{canSend:boolean})=>channel.canSend===true));}
});
test('R128 channel.update не несёт canSend: персональное право остаётся только в bootstrap',async()=>{
  // Ловит рассылку права администратора рядовым подписчикам канала.
  await shareChannelPermissionSeed();published.length=0;
  const response=await app.inject({method:'PATCH',url:'/channels/share-readonly',headers:authHeader('a'),payload:{name:'Переименован'}});assert.equal(response.statusCode,200,response.body);
  assert.equal(Object.hasOwn(response.json(),'canSend'),false);
  const events=published.map(e=>JSON.parse(e.message).m).filter((m:{t:string})=>m.t==='channel.update');assert.equal(events.length,1);assert.equal(events[0].channel.id,'share-readonly');assert.equal(Object.hasOwn(events[0].channel,'canSend'),false);
  await verifyShareCanSend();
});
test('R128 мутант серверного canSend вместо переопределённого канального права отвергается настоящим GET',async()=>{
  // Контрфакт сохраняет реальный bootstrap и базу, меняя только выбранный источник права.
  await shareChannelPermissionSeed();await verifyShareCanSend();
  type Routes=typeof import('../src/routes/servers.js');
  const mutant=await mutantModule<Routes>(new URL('../src/routes/servers.ts',import.meta.url),'canSend: has(chanPerms?.get(c.id) ?? 0n, Permission.SEND_MESSAGES)','canSend: has(ctx.serverPermissions, Permission.SEND_MESSAGES)');
  const target=Fastify();await target.register(mutant.serverRoutes);await target.ready();try{await assert.rejects(()=>verifyShareCanSend(target),assert.AssertionError);}finally{await target.close();}
});

async function folderPinsSeed() {
  await t.raw.exec(`INSERT INTO conversations(id,kind,created_by) VALUES ('folder-foreign','group','b');
    INSERT INTO conversation_members(conversation_id,user_id,pinned_at) VALUES ('folder-foreign','b',now()),('folder-foreign','c',now());
    UPDATE conversation_members SET pinned_at=now() WHERE user_id='a' AND conversation_id IN ('dm','pin2','pin3');
    UPDATE conversation_members SET left_at=now() WHERE user_id='a' AND conversation_id='pin3';
    INSERT INTO dm_folders(id,user_id,title,flags,pinned_ids) VALUES
      ('pins-a','a','Папка',1,ARRAY['pin2','dm']),('pins-second','a','Другая',1,ARRAY['dm','pin4']),('pins-b','b','Чужая',1,ARRAY['dm']),
      ('pins-system','a','',1,ARRAY['dm']);
    UPDATE dm_folders SET system='dms' WHERE id='pins-system'`);
  published.length=0;
}
const folderPinsPut=(ids:string[],target=app,id='pins-a',user='a')=>target.inject({method:'PUT',url:`/dm-folders/${id}/pinned-order`,headers:authHeader(user),payload:{ids}});
const folderPinRows=()=>t.raw.query<{id:string;pinned_ids:string[]}>(`SELECT id,pinned_ids FROM dm_folders ORDER BY id`);
test('R126 папка фильтрует чужие, незакреплённые, покинутые и повторные id, отвечает и шлёт тот же список',async()=>{
  // Ловит покупку собственного порядка для неподходящих бесед и рассинхрон второго устройства.
  await folderPinsSeed();
  const response=await folderPinsPut(['pin2','dm','dm','pin3','pin4','folder-foreign','missing']);
  assert.equal(response.statusCode,200,response.body);
  const folders=response.json().folders;
  assert.deepEqual(folders.find((f:{id:string})=>f.id==='pins-a').pinned,['pin2','dm']);
  assert.deepEqual((await folderPinRows()).rows.find(r=>r.id==='pins-a')?.pinned_ids,['pin2','dm']);
  const events=published.filter(e=>JSON.parse(e.message).m?.t==='dmFolders.update');
  assert.equal(events.length,1);assert.equal(events[0].channel,'gw:user:a');
  assert.deepEqual(JSON.parse(events[0].message).m.folders,folders);
  const foreign=await folderPinsPut(['dm'],app,'pins-b');assert.equal(foreign.statusCode,404);
  const system=await folderPinsPut(['pin2'],app,'pins-system');assert.equal(system.statusCode,400);assert.equal(system.json().reason,'folders.system');
});
test('R126 правка папки сохраняет pinned_ids, системная и пустая папки не отдают pinned',async()=>{
  // Ловит сброс порядка старым клиентом и новое поле в системном DTO.
  await folderPinsSeed();
  const input={title:'Новое',flags:1,include:['dm'],exclude:[]};
  const updated=await app.inject({method:'PUT',url:'/dm-folders/pins-a',headers:authHeader('a'),payload:input});
  assert.equal(updated.statusCode,200,updated.body);
  assert.deepEqual(updated.json().folders.find((f:{id:string})=>f.id==='pins-a').pinned,['pin2','dm']);
  assert.equal(Object.hasOwn(updated.json().folders.find((f:{id:string})=>f.id==='pins-system'),'pinned'),false);
  const empty=await folderPinsPut([]);assert.equal(empty.statusCode,200);
  assert.equal(Object.hasOwn(empty.json().folders.find((f:{id:string})=>f.id==='pins-a'),'pinned'),false);
});
test('R126 закреп и откреп вычёркивают id из всех моих папок, чужие не трогают и публикуют список',async()=>{
  // Ловит старый персональный порядок после повторного закрепа и запись в чужие папки.
  await folderPinsSeed();
  for(const pinned of [false,true]){
    await t.raw.exec(`UPDATE dm_folders SET pinned_ids=ARRAY['pin2','dm','dm'] WHERE user_id='a'`);
    published.length=0;
    const result=await app.inject({method:'PUT',url:'/conv/dm/pinned',headers:authHeader('a'),payload:{pinned}});
    assert.equal(result.statusCode,200,result.body);
    const rows=(await folderPinRows()).rows;
    assert.ok(rows.filter(r=>r.id!=='pins-b').every(r=>!r.pinned_ids.includes('dm')));
    assert.deepEqual(rows.find(r=>r.id==='pins-b')?.pinned_ids,['dm']);
    assert.equal(published.filter(e=>JSON.parse(e.message).m?.t==='dmFolders.update').length,1);
  }
});
test('R126 общий reorder меняет только pinned_at и не сбрасывает порядок папок',async()=>{
  // Ловит смешивание двух независимых областей перестановки.
  await folderPinsSeed();const before=(await folderPinRows()).rows;published.length=0;
  const result=await app.inject({method:'PUT',url:'/conv/pinned-order',headers:authHeader('a'),payload:{ids:['pin2','dm']}});
  assert.equal(result.statusCode,200,result.body);
  assert.deepEqual((await folderPinRows()).rows,before);
  assert.equal(published.filter(e=>JSON.parse(e.message).m?.t==='dmFolders.update').length,0);
});
test('R126 мутанты pinnedChats, new Set и разрешения системной папки отвергаются настоящей ручкой',async()=>{
  // Ловит отдельную потерю каждой проверки: присвоенная модель не заменяет исполнение маршрута.
  type Routes=typeof import('../src/routes/dmFolders.js');
  for(const [from,to,verify] of [
    ['isNotNull(conversationMembers.pinnedAt),','',async(target:ReturnType<typeof Fastify>)=>{const response=await folderPinsPut(['dm','pin4'],target);assert.equal(response.statusCode,200);assert.deepEqual(response.json().folders.find((f:{id:string})=>f.id==='pins-a').pinned,['dm']);}],
    ['[...new Set(ids)]','ids',async(target:ReturnType<typeof Fastify>)=>{const response=await folderPinsPut(['dm','dm'],target);assert.equal(response.statusCode,200);assert.deepEqual(response.json().folders.find((f:{id:string})=>f.id==='pins-a').pinned,['dm']);}],
    ["if (row.system) return reply.code(400).send({ error: 'у этой папки общий порядок', reason: 'folders.system' });","if (false) return reply.code(400).send({ error: 'у этой папки общий порядок', reason: 'folders.system' });",async(target:ReturnType<typeof Fastify>)=>assert.equal((await folderPinsPut(['dm'],target,'pins-system')).statusCode,400)]
  ] as const){
    await folderPinsSeed();await verify(app);
    // Полный модуль подменяется только для данного контрфакта, исходник на диске неизменен.
    const target=Fastify();const mod=await mutantModule<Routes>(new URL('../src/routes/dmFolders.ts',import.meta.url),from,to);
    await target.register(mod.dmFolderRoutes);await target.ready();
    try{await assert.rejects(()=>verify(target),assert.AssertionError,from);}finally{await target.close();}
    await t.raw.exec(`DELETE FROM dm_folders;DELETE FROM conversations WHERE id='folder-foreign'`);
  }
});
test('R126 мутант без array_remove оставляет старый порядок и ловится чтением Postgres',async()=>{
  // Проверяет саму транзакционную запись, а не наличие строки в исходнике.
  await folderPinsSeed();const actual=await import('../src/conversations.js');const access=await actual.loadAccess('dm','a');assert.ok(access);
  const verify=async(mod:typeof actual)=>{await t.raw.exec(`UPDATE conversation_members SET pinned_at=now() WHERE conversation_id='dm' AND user_id='a';UPDATE dm_folders SET pinned_ids=ARRAY['dm','pin2'] WHERE user_id='a'`);const result=await mod.setConversationPinned('a',access,false);assert.equal(result.kind,'ok');assert.ok((await folderPinRows()).rows.filter(r=>r.id!=='pins-b').every(r=>!r.pinned_ids.includes('dm')));};
  await verify(actual);
  const mutant=await mutantModule<typeof actual>(new URL('../src/conversations.ts',import.meta.url),'array_remove(pinned_ids, ${conversationId})','pinned_ids');
  await assert.rejects(()=>verify(mutant),assert.AssertionError);
});

test('пометка непрочитанного личная, повтор бесшумен, чтение прежнего ключа и read-all снимают точку', async () => {
  // Ключ уже прочитан: ранний выход не должен оставить ручную точку навсегда.
  await insertMessage('read-mark', 'b', 10);
  const mark = () => app.inject({ method: 'PUT', url: '/conv/dm/unread-mark', headers: authHeader('a'), payload: { marked: true } });
  assert.equal((await mark()).statusCode, 200);
  const eventRows = published.filter((e) => JSON.parse(e.message).m?.t === 'conv.change');
  assert.ok(eventRows.length > 0); assert.ok(eventRows.every((e) => e.channel === 'gw:user:a'));
  published.length = 0; await mark(); assert.equal(published.length, 0);
  await t.raw.exec(`UPDATE conversation_members SET last_read_key=10 WHERE user_id='a' AND conversation_id='dm'`);
  const read = await app.inject({ method: 'POST', url: '/conv/dm/read', headers: authHeader('a'), payload: { key: 10 } });
  assert.equal(read.statusCode, 200, read.body);
  const list = await app.inject({ method: 'GET', url: '/conv', headers: authHeader('a') });
  assert.notEqual(list.json().conversations.find((c: { id: string }) => c.id === 'dm').markedUnread, true);
  const actual = await import('../src/conversations.js'); const access = await actual.loadAccess('dm', 'a'); assert.ok(access);
  await mark();
  const mutant = await mutantModule<typeof actual>(new URL('../src/conversations.ts', import.meta.url), 'if (!before.marked) return', 'if (true) return');
  await assert.rejects(async () => {
    await mutant.markRead('a', access, 10);
    const row = await t.raw.query<{ marked: Date | null }>(`SELECT unread_marked_at AS marked FROM conversation_members WHERE conversation_id='dm' AND user_id='a'`);
    assert.equal(row.rows[0].marked, null, 'прежний ключ тоже обязан снять точку');
  }, assert.AssertionError);
  await actual.markRead('a', access, 10);
  await app.inject({ method: 'PUT', url: '/conv/pin2/unread-mark', headers: authHeader('a'), payload: { marked: true } });
  const all = await app.inject({ method: 'POST', url: '/conv/read-all', headers: authHeader('a') });
  assert.equal(all.statusCode, 200, all.body);
  const after = await app.inject({ method: 'GET', url: '/conv', headers: authHeader('a') });
  assert.ok(after.json().conversations.every((c: { markedUnread?: boolean }) => !c.markedUnread));
});

test('выключенный звук доставляет тихий push, смена срока возвращает полную заглушку', async () => {
  // Sound-only обязан сохранить уведомление, но не звук; следующий обычный mute не наследует старый режим.
  await t.raw.exec(`INSERT INTO push_devices (id,user_id,device_id,endpoint) VALUES ('sound-b','b','phone','https://ntfy.example.test/b')`);
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(null, { status: 200 }); }) as typeof fetch;
  const response = await app.inject({ method: 'POST', url: '/push/mute', headers: authHeader('b'), payload: { scope: 'dm_user', targetId: 'a', soundOnly: true } });
  assert.equal(response.statusCode, 204);
  const list = await app.inject({ method: 'GET', url: '/conv', headers: authHeader('b') });
  assert.equal(list.json().conversations.find((c: { id: string }) => c.id === 'dm').muted.soundOnly, true);
  const { sendPushToUsers } = await import('../src/push.js');
  await sendPushToUsers(['b'], { type: 'dm', title: 'x', body: 'y' }, { scope: 'dm_user', targetId: 'a' });
  assert.equal(bodies.length, 1); assert.equal((bodies[0] as { silent?: boolean }).silent, true);
  const actualPush = await import('../src/push.js');
  const mutantPush = await mutantModule<typeof actualPush>(new URL('../src/push.ts', import.meta.url), 'muted.filter((m) => !m.soundOnly)', 'muted');
  bodies.length = 0;
  await assert.rejects(async () => {
    await mutantPush.sendPushToUsers(['b'], { type: 'dm', title: 'x', body: 'y' }, { scope: 'dm_user', targetId: 'a' });
    assert.equal(bodies.length, 1, 'soundOnly не исключает получателя');
  }, assert.AssertionError);
  await app.inject({ method: 'POST', url: '/push/mute', headers: authHeader('b'), payload: { scope: 'dm_user', targetId: 'a', seconds: 60 } });
  bodies.length = 0;
  await sendPushToUsers(['b'], { type: 'dm', title: 'x', body: 'y' }, { scope: 'dm_user', targetId: 'a' });
  assert.equal(bodies.length, 0);
});

test('статус невидимого скрыт от соседа и администратора, но виден себе', async () => {
  // Причина: ростер и административный список используют разные правила приватности; статус нельзя раскрывать соседям.
  await t.raw.exec(`UPDATE users SET presence_status='invisible' WHERE id='b'`);
  const neighbor = await app.inject({ method: 'GET', url: '/servers/presence-server/members', headers: authHeader('a') });
  assert.equal(neighbor.statusCode, 200, neighbor.body);
  const neighborB = neighbor.json().find((row: { user: { id: string } }) => row.user.id === 'b');
  assert.equal(neighborB?.user.status, 'online', 'соседу невидимый представлен как online');

  const own = await app.inject({ method: 'GET', url: '/servers/presence-server/members', headers: authHeader('b') });
  assert.equal(own.statusCode, 200, own.body);
  const ownB = own.json().find((row: { user: { id: string } }) => row.user.id === 'b');
  assert.equal(ownB?.user.status, 'invisible', 'пользователь видит свой настоящий статус');

  const admin = await app.inject({ method: 'GET', url: '/admin/users', headers: authHeader('a') });
  assert.equal(admin.statusCode, 200, admin.body);
  const adminB = admin.json().find((row: { id: string }) => row.id === 'b');
  assert.equal(adminB?.status, 'online', 'супер-админу чужой invisible не раскрывается');
});

test('миграция каталога копирует самый ранний набор каждого имени с прежними URL и повторяется без дублей', async () => {
  // Старые серверные наборы должны сразу появиться в ЛС, без повторного скачивания и удвоения при рестарте мигратора.
  const { migrationsDir, migrationOrder } = await import('../src/db/index.js');
  const ordered = migrationOrder(await (await import('node:fs/promises')).readdir(migrationsDir));
  const at = ordered.indexOf('0092_sticker_catalog.sql'); assert.ok(at > 0);
  const raw = new PGlite();
  try {
    for (const file of ordered.slice(0, at)) await raw.exec(await readFile(join(migrationsDir, file), 'utf8'));
    await raw.exec(`INSERT INTO users (id,username,display_name,password_hash) VALUES ('owner','owner','Owner','hash');
      INSERT INTO servers (id,name,owner_id) VALUES ('one','One','owner'),('two','Two','owner');
      INSERT INTO sticker_packs (id,server_id,name,title,created_by,created_at) VALUES
      ('early','one','OldBirds','Ранние','owner','2026-01-01'),('late','two','OldBirds','Поздние','owner','2026-02-01');
      INSERT INTO stickers (id,pack_id,emoji,url,format,position) VALUES
      ('early-sticker','early','🪶','https://media.example.test/early.webp','webp',0),('late-sticker','late','🪶','https://media.example.test/late.webp','webp',0)`);
    const migration = await readFile(join(migrationsDir, ordered[at]), 'utf8'); await raw.exec(migration); await raw.exec(migration);
    const packs = await raw.query<{ id: string; title: string }>(`SELECT id,title FROM sticker_packs WHERE server_id IS NULL`);
    assert.equal(packs.rows.length, 1); assert.equal(packs.rows[0].title, 'Ранние');
    const copied = await raw.query<{ url: string }>(`SELECT url FROM stickers WHERE pack_id='${packs.rows[0].id}'`);
    assert.deepEqual(copied.rows, [{ url: 'https://media.example.test/early.webp' }]);
    assert.equal((await raw.query(`SELECT id FROM stickers WHERE pack_id IN ('early','late')`)).rows.length, 2);
  } finally { await raw.close(); }
});

test('миграция 0088 поверх 0087 сохраняет старые мьюты без срока и допускает повтор', async () => {
  // Старые строки push_mutes означают «навсегда», а добавочная миграция обязана быть повторяемой.
  const { migrationsDir, migrationOrder } = await import('../src/db/index.js');
  const ordered = migrationOrder(await (await import('node:fs/promises')).readdir(migrationsDir));
  const before = ordered.indexOf('0087_conv_scheduled_attachments.sql');
  assert.equal(ordered[before + 1], '0088_conv_pin_mute.sql', '0088 должна идти сразу после 0087');
  const raw = new PGlite();
  try {
    for (const file of ordered.slice(0, before + 1)) await raw.exec(await readFile(join(migrationsDir, file), 'utf8'));
    await raw.exec(`INSERT INTO users (id,username,display_name,password_hash) VALUES ('old','old','Old','hash');
      INSERT INTO push_mutes (user_id,scope,target_id) VALUES ('old','server','s');`);
    const migration = await readFile(join(migrationsDir, '0088_conv_pin_mute.sql'), 'utf8');
    await raw.exec(migration);
    await raw.exec(migration);
    const cols = await raw.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name='conversation_members' AND column_name='pinned_at'`);
    const old = await raw.query<{ until: Date | null }>(`SELECT until FROM push_mutes WHERE user_id='old'`);
    assert.equal(cols.rows.length, 1, 'pinned_at появляется ровно один раз');
    assert.equal(old.rows[0]?.until, null, 'старый мьют без until остаётся бессрочным');
  } finally {
    await raw.close();
  }
});

test('миграция 0090 досевает только старые голосовые не-авторам и повторяется без дублей', async () => {
  // Старые обычные аудио/текст не должны внезапно стать «не прослушанными» после включения voice1.
  const { migrationsDir, migrationOrder } = await import('../src/db/index.js');
  const ordered = migrationOrder(await (await import('node:fs/promises')).readdir(migrationsDir));
  const voiceAt = ordered.indexOf('0090_conv_voice_listened.sql');
  assert.equal(ordered[voiceAt - 1], '0089_conv_hide.sql', '0090 должна идти после 0089');
  const raw = new PGlite();
  try {
    for (const file of ordered.slice(0, voiceAt)) await raw.exec(await readFile(join(migrationsDir, file), 'utf8'));
    await raw.exec(`
      INSERT INTO users (id,username,display_name,password_hash) VALUES ('a','a','A','hash'),('b','b','B','hash'),('c','c','C','hash');
      INSERT INTO conversations (id,kind,direct_key,created_by) VALUES ('v','direct','a:b','a');
      INSERT INTO conversation_members (conversation_id,user_id) VALUES ('v','a'),('v','b'),('v','c');
      INSERT INTO conversation_messages (id,conversation_id,author_id,sort_key,attachments) VALUES
        ('voice','v','a',1,'[{"contentType":"audio/ogg","waveform":[0,50,100]}]'::jsonb),
        ('empty-wave','v','a',2,'[{"contentType":"audio/ogg","waveform":[]}]'::jsonb),
        ('plain-audio','v','a',3,'[{"contentType":"audio/ogg"}]'::jsonb),
        ('text','v','a',4,'[]'::jsonb);
    `);
    const migration = await readFile(join(migrationsDir, ordered[voiceAt]!), 'utf8');
    await raw.exec(migration);
    await raw.exec(migration);
    const rows = await raw.query<{ message_id: string; user_id: string }>(`SELECT message_id,user_id FROM conversation_voice_listens ORDER BY user_id`);
    assert.deepEqual(rows.rows, [{ message_id: 'voice', user_id: 'b' }, { message_id: 'voice', user_id: 'c' }], 'автор и не-голосовые не получают backfill');
    await raw.exec(`DELETE FROM conversation_messages WHERE id='voice'`);
    assert.equal((await raw.query(`SELECT 1 FROM conversation_voice_listens WHERE message_id='voice'`)).rows.length, 0, 'удаление сообщения каскадно удаляет отметки');
  } finally {
    await raw.close();
  }
});

test('закреп списка ограничен пятью, повтор бесшумен, порядок и private conv.change верны', async () => {
  // Ловит шестой закреп, шум от повторного PUT и утечку закрепа в устройства собеседника.
  const ids = ['dm', 'pin2', 'pin3', 'pin4', 'pin5', 'pin6'];
  for (const id of ids.slice(0, 5)) {
    const res = await app.inject({ method: 'PUT', url: `/conv/${id}/pinned`, headers: authHeader('a'), payload: { pinned: true } });
    assert.equal(res.statusCode, 200, res.body);
  }
  const pinEvents = [...published];
  const eventRows = pinEvents.filter((e) => JSON.parse(e.message).m?.t === 'conv.change');
  assert.equal(eventRows.some((e) => e.channel === 'gw:user:a'), true, `закреп синхронизируется моим устройствам: ${JSON.stringify(pinEvents)}`);
  assert.equal(eventRows.some((e) => e.channel === 'gw:user:b'), false, 'собеседнику не уходит conv.change о pinnedAt');
  published.length = 0;
  const repeated = await app.inject({ method: 'PUT', url: '/conv/dm/pinned', headers: authHeader('a'), payload: { pinned: true } });
  assert.equal(repeated.statusCode, 200);
  assert.equal(published.length, 0, 'повтор того же значения не журналируется');
  const sixth = await app.inject({ method: 'PUT', url: '/conv/pin6/pinned', headers: authHeader('a'), payload: { pinned: true } });
  assert.equal(sixth.statusCode, 409);
  assert.deepEqual(sixth.json(), { error: 'conv pin limit', reason: 'conv_pin_limit', max: 5 });
  const pinnedByPeer = await t.raw.query<{ pinned_at: Date | null }>(`SELECT pinned_at FROM conversation_members WHERE conversation_id='dm' AND user_id='b'`);
  assert.equal(pinnedByPeer.rows[0]?.pinned_at, null, 'закреп касается только строки закрепившего');

  await t.raw.exec(`UPDATE conversation_members SET pinned_at = CASE conversation_id
    WHEN 'dm' THEN '2026-10-01T00:00:00Z'::timestamptz
    WHEN 'pin2' THEN '2026-10-05T00:00:00Z'::timestamptz
    ELSE pinned_at END WHERE user_id='a'`);
  const list = await app.inject({ method: 'GET', url: '/conv', headers: authHeader('a') });
  assert.equal(list.statusCode, 200, list.body);
  const ordered = list.json().conversations.map((c: { id: string }) => c.id);
  assert.ok(ordered.indexOf('pin2') < ordered.indexOf('dm'), 'более свежий закреп выше более старого');
  assert.ok(ordered.indexOf('dm') < ordered.indexOf('pin6'), `закреплённые выше незакреплённых: ${ordered.join(',')}`);
  await t.raw.exec(`UPDATE conversation_members SET left_at=now() WHERE conversation_id='pin6' AND user_id='a'`);
  const left = await app.inject({ method: 'PUT', url: '/conv/pin6/pinned', headers: authHeader('a'), payload: { pinned: true } });
  assert.equal(left.statusCode, 404, 'вышедший участник не может закреплять');
  const outsider = await app.inject({ method: 'PUT', url: '/conv/pin6/pinned', headers: authHeader('h'), payload: { pinned: true } });
  assert.equal(outsider.statusCode, 404, 'неучастник не может закрепить беседу');
});

test('срочный мьют фильтрует только действующий push и исчезает из списка после срока', async () => {
  // Ловит вечный мьют вместо срока, утечку срочного мьюта в bootstrap и activeMute, забытый в фильтре push.
  const invalid = await app.inject({ method: 'POST', url: '/push/mute', headers: authHeader('b'), payload: { scope: 'server', targetId: 's', seconds: 59 } });
  assert.equal(invalid.statusCode, 400);
  const valid = await app.inject({ method: 'POST', url: '/push/mute', headers: authHeader('b'), payload: { scope: 'server', targetId: 's', seconds: 60 } });
  assert.equal(valid.statusCode, 204);
  const tooLong = await app.inject({ method: 'POST', url: '/push/mute', headers: authHeader('b'), payload: { scope: 'server', targetId: 's', seconds: 366 * 24 * 3600 + 1 } });
  assert.equal(tooLong.statusCode, 400);
  await t.raw.exec(`INSERT INTO push_devices (id,user_id,device_id,endpoint) VALUES
    ('dev-b','b','phone','https://ntfy.example.test/b'),('dev-c','c','phone','https://ntfy.example.test/c')`);
  const { sendPushToUsers } = await import('../src/push.js');
  await sendPushToUsers(['b', 'c'], { type: 'mention', title: 'x', body: 'y' }, { scope: 'server', targetId: 's' });
  assert.deepEqual(pushed, ['https://ntfy.example.test/c'], 'активный мьют исключает только адресата с этим источником');
  const listed = await app.inject({ method: 'GET', url: '/push/mutes', headers: authHeader('b') });
  assert.equal(listed.json()[0]?.targetId, 's');
  assert.ok(typeof listed.json()[0]?.until === 'string', 'срочный мьют возвращает until');
  await t.raw.exec(`UPDATE push_mutes SET until=now()-interval '1 second' WHERE user_id='b' AND target_id='s'`);
  const expired = await app.inject({ method: 'GET', url: '/push/mutes', headers: authHeader('b') });
  assert.deepEqual(expired.json(), [], 'истёкшая строка не показывается в настройках');
  pushed.length = 0;
  await sendPushToUsers(['b'], { type: 'mention', title: 'x', body: 'y' }, { scope: 'server', targetId: 's' });
  assert.deepEqual(pushed, ['https://ntfy.example.test/b'], 'истёкший срок снова пропускает push');
  const actualPush = await import('../src/push.js');
  const mutantPush = await mutantModule<typeof actualPush>(new URL('../src/push.ts', import.meta.url), 'activeMute(),', 'sql`TRUE`,');
  pushed.length = 0;
  await assert.rejects(async () => {
    await mutantPush.sendPushToUsers(['b'], { type: 'mention', title: 'x', body: 'y' }, { scope: 'server', targetId: 's' });
    assert.deepEqual(pushed, ['https://ntfy.example.test/b'], 'истёкший мьют не фильтрует push');
  }, assert.AssertionError);
  const timedBeforePermanent = await app.inject({ method: 'POST', url: '/push/mute', headers: authHeader('b'), payload: { scope: 'dm_user', targetId: 'a', seconds: 60 } });
  assert.equal(timedBeforePermanent.statusCode, 204);
  const permanent = await app.inject({ method: 'POST', url: '/push/mute', headers: authHeader('b'), payload: { scope: 'dm_user', targetId: 'a' } });
  assert.equal(permanent.statusCode, 204);
  const dmSummary = await app.inject({ method: 'GET', url: '/conv', headers: authHeader('b') });
  const permanentRow = await t.raw.query<{ until: Date | null }>(`SELECT until FROM push_mutes WHERE user_id='b' AND scope='dm_user' AND target_id='a'`);
  assert.equal(permanentRow.rows[0]?.until, null, 'старый запрос без seconds остаётся бессрочным');
  assert.deepEqual(dmSummary.json().conversations.find((c: { id: string }) => c.id === 'dm')?.muted, { until: null }, 'сводка различает вечный мьют');
  const permanentList = await app.inject({ method: 'GET', url: '/push/mutes', headers: authHeader('b') });
  const permanentDto = permanentList.json().find((m: { scope: string; targetId: string }) => m.scope === 'dm_user' && m.targetId === 'a');
  assert.equal(Object.hasOwn(permanentDto, 'until'), false, 'бессрочная заглушка сохраняет старую форму без until');
  const upper = await app.inject({ method: 'POST', url: '/push/mute', headers: authHeader('b'), payload: { scope: 'dm_user', targetId: 'c', seconds: 366 * 24 * 3600 } });
  assert.equal(upper.statusCode, 204, 'ровно 366 дней допустимы');
  await app.inject({ method: 'POST', url: '/push/mute', headers: authHeader('b'), payload: { scope: 'dm_user', targetId: 'a', seconds: 60 } });
  const timedSummary = await app.inject({ method: 'GET', url: '/conv', headers: authHeader('b') });
  const timed = timedSummary.json().conversations.find((c: { id: string }) => c.id === 'dm')?.muted;
  assert.ok(typeof timed?.until === 'string', 'сводка передаёт срок временного мьюта');
  await t.raw.exec(`UPDATE push_mutes SET until=now()-interval '1 second' WHERE user_id='b' AND scope='dm_user' AND target_id='a'`);
  const expiredSummary = await app.inject({ method: 'GET', url: '/conv', headers: authHeader('b') });
  assert.equal(expiredSummary.json().conversations.find((c: { id: string }) => c.id === 'dm')?.muted, null, 'просроченный мьют в сводке становится null');
});

test('прослушивание голосового пишет одну строку, строит DTO и соблюдает права/блокировку', async () => {
  // Ловит запись автора, повторные pts, утечку события заблокировавшему и неверный voiceListened у автора/слушателя.
  const voice = [{ contentType: 'audio/ogg', waveform: [0, 17, 100] }];
  await insertMessage('voice', 'a', 100, voice);
  await insertMessage('text', 'a', 200, []);
  await insertMessage('audio-empty-wave', 'a', 300, [{ contentType: 'audio/ogg', waveform: [] }]);
  await insertMessage('withheld', 'a', 400, voice);
  await insertMessage('hidden', 'a', 500, voice);
  await insertMessage('deleted', 'a', 600, voice);
  await t.raw.exec(`UPDATE conversation_messages SET withheld=true WHERE id='withheld'; UPDATE conversation_messages SET hidden_for=ARRAY['b'] WHERE id='hidden';
    UPDATE conversation_messages SET deleted_at=now() WHERE id='deleted';
    INSERT INTO user_blocks (blocker_id,blocked_id) VALUES ('a','b');`);
  const historyB = await app.inject({ method: 'GET', url: '/conv/dm/messages?limit=50', headers: authHeader('b') });
  assert.equal(historyB.statusCode, 200, historyB.body);
  const dto = historyB.json().messages.find((m: { id: string }) => m.id === 'voice');
  assert.equal(dto.voiceListened, false, 'получатель видит не прослушанное до своего действия');
  assert.equal(historyB.json().messages.find((m: { id: string }) => m.id === 'text')?.voiceListened, undefined, 'у текста поля нет');
  for (const id of ['text', 'audio-empty-wave', 'hidden', 'withheld', 'deleted']) {
    const denied = await app.inject({ method: 'POST', url: `/conv/dm/messages/${id}/listened`, headers: authHeader('b') });
    assert.equal(denied.statusCode, 404, `${id}: только видимое голосовое можно отметить прослушанным`);
  }
  const own = await app.inject({ method: 'POST', url: '/conv/dm/messages/voice/listened', headers: authHeader('a') });
  assert.equal(own.statusCode, 404, 'автор не может отметить своё голосовое слушателем');
  const conv = await import('../src/conversations.js'); const access = await conv.loadAccess('dm', 'a'); assert.ok(access);
  const mutantVoice = await mutantModule<typeof conv>(new URL('../src/conversations.ts', import.meta.url), ' || m.authorId === me', '');
  await assert.rejects(async () => {
    const result = await mutantVoice.listenVoice('a', access, 'voice', new Set());
    assert.equal(result.kind, 'not-found', 'автор не является собственным слушателем');
  }, assert.AssertionError);
  await t.raw.exec(`DELETE FROM conversation_voice_listens WHERE message_id='voice' AND user_id='a'`);
  published.length = 0;
  const listened = await app.inject({ method: 'POST', url: '/conv/dm/messages/voice/listened', headers: authHeader('b') });
  assert.equal(listened.statusCode, 204);
  assert.equal((await t.raw.query(`SELECT 1 FROM conversation_voice_listens WHERE message_id='voice' AND user_id='b'`)).rows.length, 1, 'строка пишется даже если автор заблокировал слушателя');
  assert.equal(published.some((e) => e.channel === 'gw:user:a' && JSON.parse(e.message).m?.t === 'conv.change'), false, 'заблокировавший автор не получает событие');
  assert.equal(published.some((e) => e.channel === 'gw:user:b' && JSON.parse(e.message).m?.t === 'conv.change'), true, 'устройство слушателя получает событие');
  const repeatCount = published.length;
  const repeat = await app.inject({ method: 'POST', url: '/conv/dm/messages/voice/listened', headers: authHeader('b') });
  assert.equal(repeat.statusCode, 204);
  assert.equal(published.length, repeatCount, 'повтор не создаёт журнал/событие');
  const afterB = await app.inject({ method: 'GET', url: '/conv/dm/messages?limit=50', headers: authHeader('b') });
  assert.equal(afterB.json().messages.find((m: { id: string }) => m.id === 'voice')?.voiceListened, true, 'слушатель видит собственную отметку');
  const afterA = await app.inject({ method: 'GET', url: '/conv/dm/messages?limit=50', headers: authHeader('a') });
  assert.equal(afterA.json().messages.find((m: { id: string }) => m.id === 'voice')?.voiceListened, false, 'автор не считает заблокированного им слушателя');
  await t.raw.exec(`DELETE FROM user_blocks WHERE blocker_id='a' AND blocked_id='b'`);
  (await import('../src/blocks.js')).resetBlockCacheForTests();
  await insertMessage('voice-unblocked', 'a', 700, voice);
  await t.raw.exec(`UPDATE conversations SET last_sort_key=700 WHERE id='dm'`);
  const regularListen = await app.inject({ method: 'POST', url: '/conv/dm/messages/voice-unblocked/listened', headers: authHeader('b') });
  assert.equal(regularListen.statusCode, 204);
  const authorAfterListen = await app.inject({ method: 'GET', url: '/conv/dm/messages?limit=50', headers: authHeader('a') });
  assert.equal(authorAfterListen.json().messages.find((m: { id: string }) => m.id === 'voice-unblocked')?.voiceListened, true, 'автор видит прослушивание не-автором');
  const nonMember = await app.inject({ method: 'POST', url: '/conv/dm/messages/voice/listened', headers: authHeader('h') });
  assert.equal(nonMember.statusCode, 404);
});

test('одноразовое голосовое тратится только получателем, исчезает у обоих и запрещает повторное использование', async () => {
  // Ловит утечку one-shot в групповые/сохранённые чаты, выдачу файла после закрытия и повторный показ прежнего текста.
  const { Readable } = await import('node:stream');
  const removed: string[] = [];
  setAttachmentStoreForTests({ ready: () => true, ensureReady: async () => true, configured: () => true,
    put: async () => {}, stat: async () => ({ size: 1 }), get: async () => Readable.from([Buffer.from('x')]),
    remove: async (key) => { removed.push(key); }, copy: async () => {} });
  try {
    await t.raw.exec(`
      INSERT INTO conversations(id,kind,direct_key,created_by) VALUES
        ('once-group','group',NULL,'a'), ('once-saved','direct','a:a','a');
      INSERT INTO conversation_members(conversation_id,user_id) VALUES
        ('once-group','a'),('once-group','c'),('once-saved','a');
      INSERT INTO attachments(id,conversation_id,owner_id,storage_key,name,content_type,size,state) VALUES
        ('90000000-0000-4000-8000-000000000101','dm','a','dm/once-direct','once.ogg','audio/ogg',1,'pending'),
        ('90000000-0000-4000-8000-000000000102','once-group','a','once-group/once','once.ogg','audio/ogg',1,'pending'),
        ('90000000-0000-4000-8000-000000000103','once-saved','a','once-saved/once','once.ogg','audio/ogg',1,'pending');
    `);
    const send = async (conversationId: string, clientId: string, fileId: string) => app.inject({
      method: 'POST', url: `/conv/${conversationId}/messages`, headers: authHeader('a'),
      payload: { clientId, content: '', attachments: [{ id: fileId, waveform: [1, 40], once: true }] },
    });
    const direct = await send('dm', '90000000-0000-4000-8000-000000000091', '90000000-0000-4000-8000-000000000101');
    assert.equal(direct.statusCode, 201, direct.body);
    const directId = direct.json().id as string;
    assert.equal(direct.json().attachments[0].once, true, 'в личке с другим человеком одноразовое голосовое сохраняет пометку');
    const group = await send('once-group', '90000000-0000-4000-8000-000000000092', '90000000-0000-4000-8000-000000000102');
    assert.equal(group.statusCode, 201, group.body);
    assert.equal(Object.hasOwn(group.json().attachments[0], 'once'), false, 'в группе one-shot снимается');
    await t.raw.exec(`INSERT INTO attachments(id,conversation_id,owner_id,storage_key,name,content_type,size,state)
      VALUES ('90000000-0000-4000-8000-000000000105','once-group','a','once-group/mutant','once.ogg','audio/ogg',1,'pending')`);
    const conv = await import('../src/conversations.js');
    const groupAccess = await conv.loadAccess('once-group', 'a'); assert.ok(groupAccess);
    const alwaysOnce = await mutantModule<typeof conv>(new URL('../src/conversations.ts', import.meta.url),
      'const onceOk = lock.kind === \'direct\' && !access.saved;', 'const onceOk = true;');
    await assert.rejects(async () => {
      const mutant = await alwaysOnce.sendMessage('a', groupAccess, {
        clientId: '90000000-0000-4000-8000-000000000095', content: '',
        attachments: [{ id: '90000000-0000-4000-8000-000000000105', waveform: [1, 40], once: true }],
        replyToId: null, withheld: false,
      });
      assert.equal(mutant.kind === 'created' && mutant.row.attachments[0]?.once, false,
        'контрфакт должен оставлять групповое сообщение не одноразовым');
    }, assert.AssertionError);
    const saved = await send('once-saved', '90000000-0000-4000-8000-000000000093', '90000000-0000-4000-8000-000000000103');
    assert.equal(saved.statusCode, 201, saved.body);
    assert.equal(Object.hasOwn(saved.json().attachments[0], 'once'), false, 'в «Избранном» one-shot снимается');

    await t.raw.exec(`INSERT INTO conversation_messages(id,conversation_id,author_id,sort_key,content,attachments)
      VALUES ('once-forward-source','dm','a',${direct.json().sortKey + 1},'voice',
        '[{"id":"90000000-0000-4000-8000-000000000104","contentType":"audio/ogg","waveform":[1],"once":true}]'::jsonb);
      INSERT INTO attachments(id,conversation_id,owner_id,message_id,storage_key,name,content_type,size,state)
      VALUES ('90000000-0000-4000-8000-000000000104','dm','a','once-forward-source','dm/once-forward','once.ogg','audio/ogg',1,'attached');`);
    const aAccess = await conv.loadAccess('dm', 'a'); assert.ok(aAccess);
    assert.equal((await conv.forwardMessages('a', aAccess, {
      clientId: '90000000-0000-4000-8000-000000000094', fromConversationId: 'dm', messageIds: ['once-forward-source'],
      withheld: false, silent: false,
    })).kind, 'source-missing', 'непотраченное одноразовое нельзя переслать');

    const own = await app.inject({ method: 'POST', url: `/conv/dm/messages/${directId}/once-spent`, headers: authHeader('a') });
    assert.equal(own.statusCode, 404, 'автор не может потратить собственное сообщение');
    await insertMessage('ordinary-voice-for-once', 'a', 900, [{ contentType: 'audio/ogg', waveform: [1] }]);
    const ordinarySpent = await app.inject({ method: 'POST', url: `/conv/dm/messages/ordinary-voice-for-once/once-spent`, headers: authHeader('b') });
    assert.equal(ordinarySpent.statusCode, 404, 'обычное голосовое нельзя потратить как одноразовое');
    const nonMember = await app.inject({ method: 'POST', url: `/conv/dm/messages/${directId}/once-spent`, headers: authHeader('h') });
    assert.equal(nonMember.statusCode, 404, 'посторонний не раскрывает существование сообщения');

    published.length = 0;
    const spent = await app.inject({ method: 'POST', url: `/conv/dm/messages/${directId}/once-spent`, headers: authHeader('b') });
    assert.equal(spent.statusCode, 204, spent.body);
    const rows = await t.raw.query<{ content: string; attachments: unknown[]; once_spent_at: Date | null }>(
      `SELECT content,attachments,once_spent_at FROM conversation_messages WHERE id=$1`, [directId]);
    assert.equal(rows.rows[0]?.content, 'Голосовое сообщение прослушано');
    assert.deepEqual(rows.rows[0]?.attachments, []);
    assert.ok(rows.rows[0]?.once_spent_at);
    assert.deepEqual(removed, ['dm/once-direct'], 'файл удаляется из хранилища после фиксации');
    assert.equal((await t.raw.query(`SELECT 1 FROM attachments WHERE id='90000000-0000-4000-8000-000000000101'`)).rows.length, 0,
      'после успешного удаления строки файла больше нет');
    for (const uid of ['a', 'b']) {
      const history = await app.inject({ method: 'GET', url: '/conv/dm/messages?limit=50', headers: authHeader(uid) });
      const visible = history.json().messages.find((m: { id: string }) => m.id === directId);
      assert.equal(visible.content, 'Голосовое сообщение прослушано');
      assert.deepEqual(visible.attachments, []);
      assert.equal(visible.voiceOnceSpent, true);
      assert.ok(published.some((e) => e.channel === `gw:user:${uid}` && JSON.parse(e.message).m?.t === 'conv.change'),
        `${uid}: событие удаления у обоих`);
    }
    const eventCount = published.length;
    const again = await app.inject({ method: 'POST', url: `/conv/dm/messages/${directId}/once-spent`, headers: authHeader('b') });
    assert.equal(again.statusCode, 204);
    assert.equal(published.length, eventCount, 'повтор не пишет журнал и не рассылает события');
    const edit = await conv.editMessage('a', aAccess, directId, 'не вернуть файл');
    assert.equal(edit.kind, 'forbidden', 'потраченное сообщение уже нельзя редактировать');
    const editableMutant = await mutantModule<typeof conv>(new URL('../src/conversations.ts', import.meta.url),
      'if (m.onceSpentAt) return { kind: \'forbidden\' };', '');
    await assert.rejects(async () => {
      const result = await editableMutant.editMessage('a', aAccess, directId, 'не вернуть файл');
      assert.equal(result.kind, 'forbidden');
    }, assert.AssertionError);
  } finally { setAttachmentStoreForTests(null); }
});

test('контакты валидируют цель, сохраняют подпись, соблюдают предел и выключают плашку незнакомца', async () => {
  // Ловит потерю подписи при повторе, гостевую/само-добавку, превышение лимита и stale stranger после удаления контакта.
  await insertMessage('contact-stranger', 'c', 10, [], 'pin2');
  const conv = await import('../src/conversations.js');
  const stranger = async () => (await conv.listConversations('a')).conversations.find((c) => c.id === 'pin2')?.stranger;
  assert.equal(await stranger(), true, 'до принятия контакта собеседник с сообщением — незнакомец');
  const getList = () => app.inject({ method: 'GET', url: '/contacts', headers: authHeader('a') });
  assert.equal((await app.inject({ method: 'POST', url: '/contacts', headers: authHeader('a'), payload: { userId: 'a' } })).json().reason,
    'contacts.self');
  assert.equal((await app.inject({ method: 'POST', url: '/contacts', headers: authHeader('a'), payload: { userId: 'missing' } })).statusCode, 404);
  await t.raw.exec("UPDATE users SET home_instance_id='remote' WHERE id='h'");
  const guest = await app.inject({ method: 'POST', url: '/contacts', headers: authHeader('a'), payload: { userId: 'h' } });
  assert.equal(guest.statusCode, 400); assert.equal(guest.json().reason, 'contacts.guest');
  assert.equal((await app.inject({ method: 'GET', url: '/contacts', headers: authHeader('h') })).statusCode, 403,
    'гость не управляет контактами локального инстанса');
  const add = await app.inject({ method: 'POST', url: '/contacts', headers: authHeader('a'), payload: { userId: 'c', name: '  Близкий  ' } });
  assert.equal(add.statusCode, 200, add.body); assert.equal(add.json().contacts[0].name, 'Близкий');
  assert.equal(await stranger(), undefined, 'добавленный контакт больше не показывает плашку незнакомца');
  assert.ok(published.some((e) => e.channel === 'gw:user:a' && JSON.parse(e.message).m?.t === 'contacts.update'));
  const repeat = await app.inject({ method: 'POST', url: '/contacts', headers: authHeader('a'), payload: { userId: 'c' } });
  assert.equal(repeat.json().contacts[0].name, 'Близкий', 'повтор без name не стирает личную подпись');
  const contactsModule = await import('../src/contacts.js');
  const contactDb = await import('../src/db/index.js');
  const contactSchema = await import('../src/db/schema.js');
  const drizzle = await import('drizzle-orm');
  const eraseOnOmittedName = mutateExportedFunction<typeof contactsModule.addContact>(new URL('../src/contacts.ts', import.meta.url), 'addContact',
    [['if (clean !== undefined) {', 'if (clean !== undefined || name === undefined) {'], ['.set({ name: clean })', '.set({ name: clean ?? null })']], {
      db: contactDb.db, and: drizzle.and, eq: drizzle.eq, count: drizzle.count, userContacts: contactSchema.userContacts,
      cleanContactName: (await import('../src/contactRules.js')).cleanContactName,
    });
  await assert.rejects(async () => {
    await eraseOnOmittedName('a', 'c', undefined, CONTACTS_MAX);
    assert.equal((await getList()).json().contacts[0].name, 'Близкий');
  }, assert.AssertionError, 'мутант затирает личную подпись при повторе без name');
  await contactsModule.renameContact('a', 'c', 'Близкий');
  const rename = await app.inject({ method: 'POST', url: '/contacts', headers: authHeader('a'), payload: { userId: 'c', name: 'Свой' } });
  assert.equal(rename.json().contacts[0].name, 'Свой');
  const noStrangerContact = await mutantModule<typeof conv>(new URL('../src/conversations.ts', import.meta.url),
    'AND NOT EXISTS (SELECT 1 FROM user_contacts uc WHERE uc.owner_id = ${me} AND uc.contact_id = ${peer})', '');
  assert.equal((await conv.listConversations('a')).conversations.find((c) => c.id === 'pin2')?.stranger, undefined,
    'контакт принят и сводка больше не помечает собеседника незнакомцем');
  assert.equal((await noStrangerContact.listConversations('a')).conversations.find((c) => c.id === 'pin2')?.stranger, true,
    'мутант забывает исключение контакта из плашки незнакомца');
  assert.equal((await app.inject({ method: 'PATCH', url: '/contacts/d', headers: authHeader('a'), payload: { name: 'нет' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: '/contacts/c', headers: authHeader('a') })).statusCode, 200);
  assert.equal(await stranger(), true, 'после удаления контакта плашка незнакомца снова видна');
  assert.equal((await app.inject({ method: 'DELETE', url: '/contacts/c', headers: authHeader('a') })).statusCode, 200,
    'повторное удаление идемпотентно для клиента');
  assert.deepEqual((await getList()).json().contacts, []);

  await t.raw.exec(`UPDATE users SET deleted_at=now() WHERE id='c';
    INSERT INTO user_contacts(owner_id,contact_id) VALUES ('a','c');`);
  assert.deepEqual((await getList()).json().contacts, [], 'контакт с удалённым аккаунтом не выдаётся в списке');
  // Делает SQL-условие удаления истинным для всех строк: контрфакт должен вернуть удалённую цель, рабочая версия — нет.
  const includeDeleted = mutateExportedFunction<typeof contactsModule.listContacts>(new URL('../src/contacts.ts', import.meta.url), 'listContacts',
    [['isNull(users.deletedAt)', 'drizzleSql`TRUE`']], {
      db: contactDb.db, and: drizzle.and, eq: drizzle.eq, isNull: drizzle.isNull, asc: drizzle.asc,
      users: contactSchema.users, userContacts: contactSchema.userContacts, drizzleSql: drizzle.sql,
    });
  assert.deepEqual(await contactsModule.listContacts('a'), [], 'рабочая версия списка исключает удалённые аккаунты');
  assert.equal((await includeDeleted('a')).some((entry) => entry.id === 'c'), true,
    'мутант списка выдаёт профиль удалённого аккаунта');
  assert.equal((await app.inject({ method: 'POST', url: '/contacts', headers: authHeader('a'), payload: { userId: 'c' } })).statusCode, 404,
    'удалённый пользователь больше не цель добавления');

  await t.raw.exec(`DELETE FROM user_contacts WHERE owner_id='a';
    INSERT INTO users(id,username,display_name,password_hash)
      SELECT 'contact-limit-'||n,'contactlimit'||n,'Contact '||n,'hash' FROM generate_series(1,${CONTACTS_MAX}) AS n;
    INSERT INTO user_contacts(owner_id,contact_id)
      SELECT 'a','contact-limit-'||n FROM generate_series(1,${CONTACTS_MAX - 1}) AS n;`);
  const atLimit = await app.inject({ method: 'POST', url: '/contacts', headers: authHeader('a'), payload: { userId: 'b' } });
  assert.equal(atLimit.statusCode, 200, 'добавление последнего контакта доходит ровно до предела');
  assert.equal((await getList()).json().contacts.length, CONTACTS_MAX);
  const over = await app.inject({ method: 'POST', url: '/contacts', headers: authHeader('a'), payload: { userId: 'd' } });
  assert.equal(over.statusCode, 400); assert.equal(over.json().reason, 'contacts.limit'); assert.equal(over.json().max, CONTACTS_MAX);

  const limitOffByOne = mutateExportedFunction<typeof contactsModule.addContact>(new URL('../src/contacts.ts', import.meta.url), 'addContact',
    [['Number(n) >= max', 'Number(n) > max']], {
      db: contactDb.db, and: drizzle.and, eq: drizzle.eq, count: drizzle.count, userContacts: contactSchema.userContacts,
      cleanContactName: (await import('../src/contactRules.js')).cleanContactName,
    });
  await assert.rejects(async () => {
    await limitOffByOne('a', 'd', undefined, CONTACTS_MAX);
    assert.equal((await getList()).json().contacts.length, CONTACTS_MAX);
  }, assert.AssertionError, 'мутант off-by-one принимает CONTACTS_MAX+1');

  const noGuestCheck = mutateExportedFunction<typeof contactsModule.contactTarget>(new URL('../src/contacts.ts', import.meta.url), 'contactTarget',
    [['if (row.home !== null) return \'guest\';', '']], {
      db: contactDb.db, and: drizzle.and, eq: drizzle.eq, isNull: drizzle.isNull, users: contactSchema.users,
    });
  assert.equal(await noGuestCheck('a', 'h'), null, 'контрфакт без guest-check принимает гостя');
});

test('очистка и удаление чата хоронят только допустимые сообщения и возвращают беседу после нового сообщения', async () => {
  // Ловит границы hidden_key, сохранность уже спрятанного/придержанного и ошибочное возвращение беседы старым сообщением.
  await insertMessage('mine', 'a', 100);
  await insertMessage('peer', 'b', 200);
  await insertMessage('peer-hidden', 'b', 300);
  await insertMessage('peer-withheld', 'b', 400);
  await t.raw.exec(`UPDATE conversation_messages SET hidden_for=ARRAY['a'] WHERE id='peer-hidden'; UPDATE conversation_messages SET withheld=true WHERE id='peer-withheld'`);
  await t.raw.exec(`UPDATE conversations SET last_sort_key=400 WHERE id='dm'`);
  const clear = await app.inject({ method: 'POST', url: '/conv/dm/clear', headers: authHeader('a'), payload: { for: 'both' } });
  assert.equal(clear.statusCode, 204, clear.body);
  const rows = await t.raw.query<{ id: string; deleted_at: Date | null; content: string; hidden_for: string[]; withheld: boolean }>(`SELECT id,deleted_at,content,hidden_for,withheld FROM conversation_messages ORDER BY sort_key`);
  const byId = new Map(rows.rows.map((r) => [r.id, r]));
  assert.ok(byId.get('mine')?.deleted_at, 'моё сообщение уходит в надгробие');
  assert.ok(byId.get('peer')?.deleted_at, 'видимое чужое сообщение очищается у обоих');
  assert.equal(byId.get('peer-hidden')?.deleted_at, null, 'уже спрятанное мной чужое сообщение у собеседника сохраняется');
  assert.equal(byId.get('peer-withheld')?.deleted_at, null, 'придержанное чужое сообщение сохраняется');
  assert.ok(published.some((e) => e.channel === 'gw:user:b' && JSON.parse(e.message).m?.t === 'conv.change' && JSON.parse(e.message).m?.message?.gone === true), 'собеседник получает надгробие через conv.change');
  assert.equal(published.some((e) => /^dm\.|^read\.dm$/.test(JSON.parse(e.message).m?.t ?? '')), false, 'очистка не публикует удалённые события старого пути');

  const invalid = await app.inject({ method: 'POST', url: '/conv/dm/clear', headers: authHeader('a'), payload: { for: 'peer' } });
  assert.equal(invalid.statusCode, 400);
  forceEditRateLimit = true;
  const limited = await app.inject({ method: 'POST', url: '/conv/dm/clear', headers: authHeader('a'), payload: { for: 'me' } });
  forceEditRateLimit = false;
  assert.equal(limited.statusCode, 429, 'очистка учитывает общий бюджет conv-edit');
  assert.equal((await t.raw.query<{ hidden_for: string[] }>(`SELECT hidden_for FROM conversation_messages WHERE id='mine'`)).rows[0]?.hidden_for.includes('a'), false, 'отказ по бюджету не меняет данные');
  const forbidden = await app.inject({ method: 'POST', url: '/conv/dm/hide', headers: authHeader('h'), payload: { for: 'me' } });
  assert.equal(forbidden.statusCode, 404);
  const hidden = await app.inject({ method: 'POST', url: '/conv/dm/hide', headers: authHeader('a'), payload: { for: 'me' } });
  assert.equal(hidden.statusCode, 204, hidden.body);
  assert.equal((await app.inject({ method: 'GET', url: '/conv', headers: authHeader('a') })).json().conversations.some((c: { id: string }) => c.id === 'dm'), false, 'убранная беседа не входит в список');
  assert.deepEqual((await (await import('../src/conversations.js')).myConversationIds('a')).includes('dm'), false);
  assert.equal(await (await import('../src/conversations.js')).conversationShownTo('dm', 'a'), false);
  const peerMarker = await t.raw.query<{ hidden_key: number | null }>(`SELECT hidden_key FROM conversation_members WHERE conversation_id='dm' AND user_id='b'`);
  assert.equal(peerMarker.rows[0]?.hidden_key, null, 'hide me не убирает строку собеседника');
  assert.ok(published.some((e) => e.channel === 'gw:user:a' && JSON.parse(e.message).m?.t === 'conv.change'), 'ConvLeft/сводка уходит моим устройствам');
  const opened = await (await import('../src/conversations.js')).revealDirect('a', 'dm');
  assert.ok(opened, 'явный reveal снимает метку');
  assert.equal((await (await import('../src/conversations.js')).myConversationIds('a')).includes('dm'), true);
});

test('очистка у себя скрывает лишь свою копию, а hide both ждёт ключ строго больше метки', async () => {
  // Ловит удаление чужой копии при `me`, >= вместо > и неверное восстановление одной стороны при hide both.
  await insertMessage('only-me-mine', 'a', 100);
  await insertMessage('only-me-peer', 'b', 200);
  await t.raw.exec(`UPDATE conversations SET last_sort_key=200 WHERE id='dm'`);
  const clearMe = await app.inject({ method: 'POST', url: '/conv/dm/clear', headers: authHeader('a'), payload: { for: 'me' } });
  assert.equal(clearMe.statusCode, 204, clearMe.body);
  const meCopy = await t.raw.query<{ deleted_at: Date | null; hidden_for: string[] }>(`SELECT deleted_at,hidden_for FROM conversation_messages WHERE id='only-me-peer'`);
  assert.equal(meCopy.rows[0]?.deleted_at, null, 'очистка у себя не создаёт надгробие собеседнику');
  assert.ok(meCopy.rows[0]?.hidden_for.includes('a'), 'чужое сообщение скрывается только от инициатора очистки');

  await t.raw.exec(`UPDATE conversation_members SET pinned_at=now() WHERE conversation_id='pin2'`);
  const hideBoth = await app.inject({ method: 'POST', url: '/conv/pin2/hide', headers: authHeader('a'), payload: { for: 'both' } });
  assert.equal(hideBoth.statusCode, 204, hideBoth.body);
  const hiddenMembers = await t.raw.query<{ user_id: string; hidden_key: number | null; pinned_at: Date | null }>(`SELECT user_id,hidden_key,pinned_at FROM conversation_members WHERE conversation_id='pin2' ORDER BY user_id`);
  assert.deepEqual(hiddenMembers.rows.map((m) => m.user_id), ['a', 'c']);
  assert.ok(hiddenMembers.rows.every((m) => m.hidden_key !== null), 'hide both ставит метку обоим участникам');
  assert.ok(hiddenMembers.rows.every((m) => m.pinned_at === null), 'удаление чата снимает закреп');
  const conv = await import('../src/conversations.js'); const access = await conv.loadAccess('pin2', 'a'); assert.ok(access);
  await t.raw.exec(`UPDATE conversation_members SET pinned_at=now() WHERE conversation_id='pin2'`);
  const pinMutant = await mutantModule<typeof conv>(new URL('../src/conversations.ts', import.meta.url), '.set({ hiddenKey: upToKey, pinnedAt: null })', '.set({ hiddenKey: upToKey })');
  await assert.rejects(async () => {
    await pinMutant.hideConversation('a', access, true);
    const rows = await t.raw.query<{ pinned_at: Date | null }>(`SELECT pinned_at FROM conversation_members WHERE conversation_id='pin2'`);
    assert.ok(rows.rows.every((r) => r.pinned_at === null), 'hide снимает закрепы обоим');
  }, assert.AssertionError);
  await t.raw.exec(`UPDATE conversation_members SET hidden_key=NULL,pinned_at=NULL WHERE conversation_id='pin2'`);
  const whoMutant = await mutantModule<typeof conv>(new URL('../src/conversations.ts', import.meta.url), 'const who = forBoth && othersDeletableForBoth(lock.kind) ? access.memberIds : [me];', 'const who = [me];');
  await assert.rejects(async () => {
    await whoMutant.hideConversation('a', access, true);
    const rows = await t.raw.query<{ hidden_key: number | null }>(`SELECT hidden_key FROM conversation_members WHERE conversation_id='pin2'`);
    assert.ok(rows.rows.every((r) => r.hidden_key !== null), 'both действует на обе копии');
  }, assert.AssertionError);
  await conv.hideConversation('a', access, true);
  for (const user of ['a', 'c']) {
    const list = await app.inject({ method: 'GET', url: '/conv', headers: authHeader(user) });
    assert.equal(list.json().conversations.some((c: { id: string }) => c.id === 'pin2'), false, `${user}: убранная беседа не в списке`);
    assert.equal((await (await import('../src/conversations.js')).myConversationIds(user)).includes('pin2'), false, `${user}: старый список тоже скрывает беседу`);
    assert.equal(await (await import('../src/conversations.js')).conversationShownTo('pin2', user), false, `${user}: typing не раскрывает убранную беседу`);
  }
  // hideConversation берёт свежий clock_timestamp; контрфакты выше уже перевыставили метку.
  const markerRow = await t.raw.query<{ hidden_key: number }>(`SELECT hidden_key FROM conversation_members WHERE conversation_id='pin2' AND user_id='a'`);
  const marker = markerRow.rows[0].hidden_key;
  await insertMessage('equal-marker', 'c', marker, [], 'pin2');
  assert.equal((await (await import('../src/conversations.js')).myConversationIds('a')).includes('pin2'), false, 'сообщение ровно на hidden_key не возвращает беседу');
  const boundaryMutant = await mutantModule<typeof conv>(new URL('../src/conversations.ts', import.meta.url), 'z.sort_key > ${hiddenKey}', 'z.sort_key >= ${hiddenKey}');
  await assert.rejects(async () => {
    assert.equal((await boundaryMutant.myConversationIds('a')).includes('pin2'), false, 'равенство метке не возвращает чат');
  }, assert.AssertionError);

  const sent = await app.inject({ method: 'POST', url: '/conv/pin2/messages', headers: authHeader('c'), payload: {
    clientId: '00000000-0000-4000-8000-000000000021', content: 'новое после скрытия', attachments: [],
  } });
  assert.equal(sent.statusCode, 201, sent.body);
  assert.equal((await (await import('../src/conversations.js')).myConversationIds('a')).includes('pin2'), true, 'доставленное сообщение строго позже метки возвращает беседу');
  assert.equal(await (await import('../src/conversations.js')).conversationShownTo('pin2', 'c'), true);
});
