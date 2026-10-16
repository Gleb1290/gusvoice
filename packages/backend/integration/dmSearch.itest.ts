import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, beforeEach, test } from 'node:test';
import ts from 'typescript';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;
let app: ReturnType<typeof Fastify>;
let tokenFor: (id: string) => string;
let setSuperAdminId: typeof import('../src/auth.js').setSuperAdminId;
let redisPub: typeof import('../src/realtime.js').redisPub;
let resetBlockCache: typeof import('../src/blocks.js').resetBlockCacheForTests;
const published: { channel: string; message: string }[] = [];
const counts = new Map<string, number>();
const auth = (id: string) => ({ authorization: `Bearer ${tokenFor(id)}` });

type SearchModule = typeof import('../src/conversations.js');
const convSearchSource = readFileSync(new URL('../src/conversations.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const serializerSource = readFileSync(new URL('../src/serialize.ts', import.meta.url), 'utf8');
function outside(name: string) {
  return new Proxy({}, { get: (_target, key) => key === '__esModule' ? true : () => {
    throw new Error(`неожиданная граница поиска ${name}.${String(key)}`);
  } });
}
function whole<T>(source: string, deps: Record<string, unknown>): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports, Date, Map, Set, Promise,
    require: (id: string) => { assert.equal(Object.hasOwn(deps, id), true, `явная граница ${id}`); return deps[id]; } });
  return module.exports as T;
}
async function searchModule(raw = convSearchSource, race = false): Promise<SearchModule> {
  const shared = await import('@gusvoice/shared'); const schema = await import('../src/db/schema.js');
  const serialize = whole<typeof import('../src/serialize.js')>(serializerSource, {
    '@gusvoice/shared': shared, './auth.js': outside('auth'), './superAdminRules.js': outside('superAdminRules'),
    './env.js': { env: {} }, './federation/instanceLabels.js': outside('instanceLabels'),
    './statusRules.js': outside('statusRules'), './shopRules.js': outside('shopRules'),
    './callRules.js': outside('callRules'), './lastSeenRules.js': outside('lastSeenRules'),
    './linkThreats.js': { dangerousLinksOf: () => [] },
  });
  let raced = false;
  const db = race ? new Proxy(t.db, { get(target, key) {
    if (key !== 'select') { const v = Reflect.get(target, key); return typeof v === 'function' ? v.bind(target) : v; }
    return (...args: unknown[]) => {
      const select = (target.select as (...a: unknown[]) => any)(...args);
      return new Proxy(select, { get(builder, prop) {
        if (prop !== 'from') { const v = Reflect.get(builder, prop); return typeof v === 'function' ? v.bind(builder) : v; }
        return (table: unknown) => {
          const from = builder.from(table);
          if (table !== schema.conversationMessages || args.length !== 0 || raced) return from;
          return new Proxy(from, { get(query, member) {
            if (member !== 'where') { const v = Reflect.get(query, member); return typeof v === 'function' ? v.bind(query) : v; }
            return async (condition: unknown) => {
              raced = true;
              // Реальная смена видимости между SQL-хитом и чтением detail, не подделка DTO.
              await t.raw.exec("UPDATE conversation_messages SET hidden_for=ARRAY['a']::text[] WHERE id='race-file'");
              return await query.where(condition);
            };
          } });
        };
      } });
    };
  } }) : t.db;
  return whole<SearchModule>(raw, {
    '@gusvoice/shared': shared, 'drizzle-orm': await import('drizzle-orm'), './convRules.js': await import('../src/convRules.js'),
    './db/index.js': { db }, './db/schema.js': schema, './dmWriteBarrier.js': outside('dmWriteBarrier'),
    './attachments.js': { attachmentLink: (id: string, viewer: string, gen: number) => `https://files.invalid/${viewer}/${gen}/${id}` },
    './env.js': { env: {} }, './serialize.js': serialize, './util.js': outside('util'),
  });
}
function searchChanged(anchor: string, replacement: string) {
  assert.equal(convSearchSource.split(anchor).length - 1, 1, 'единственный якорь поиска');
  return convSearchSource.replace(anchor, replacement);
}
async function searchFixture() {
  await t.raw.exec(`INSERT INTO conversations(id,kind,direct_key,created_by) VALUES ('kind-main','direct','a:b','a');
    INSERT INTO conversation_members(conversation_id,user_id) VALUES ('kind-main','a'),('kind-main','b');
    UPDATE users SET token_generation=CASE WHEN id='a' THEN 7 ELSE 9 END WHERE id IN ('a','b');`);
}
async function searchMessage(id: string, key: number, patch: {
  conv?: string; author?: string; content?: string; mime?: string; name?: string; deleted?: boolean; hidden?: boolean; withheld?: boolean;
} = {}) {
  const attachment = { id: `attachment-${id}`, name: patch.name ?? 'отчёт.pdf', contentType: patch.mime ?? 'application/pdf', size: 1 };
  await t.raw.query(`INSERT INTO conversation_messages(id,conversation_id,author_id,sort_key,content,attachments,deleted_at,hidden_for,withheld)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz,$8::text[],$9)`,
  [id, patch.conv ?? 'kind-main', patch.author ?? 'b', key, patch.content ?? 'не совпадает', JSON.stringify([attachment]),
    patch.deleted ? '2026-10-12T00:00:00Z' : null, patch.hidden ? '{a}' : '{}', patch.withheld ?? false]);
}

async function namesScenario(mod: SearchModule) {
  const query = { pattern: '%отчёт%', kind: 'file' as const, names: true, limit: 30 };
  const found = await mod.searchAllConversations('a', query);
  assert.deepEqual(Array.from(found.hits, h => h.id), ['named-file'], 'имя файла не обходит AND вида');
  assert.equal((await mod.searchAllConversations('a', { ...query, names: false })).hits.length, 0, 'без names ищется только текст');
  assert.equal((await mod.searchAllConversations('a', { ...query, kind: undefined })).hits.length, 0, 'names без kind не меняет текстовый поиск');
}
test('R183 имя файла находится только при names и виде file, имя фотографии не обходит фильтр вида', async () => {
  // Класс ошибки: OR по имени превращает файл-поиск в выдачу любых вложений.
  await searchFixture(); await searchMessage('named-file', 1); await searchMessage('named-photo', 2, { mime: 'image/png' });
  await namesScenario(await searchModule());
});
test('R183 full даёт настоящее сообщение со ссылками смотрящего, без full поля message нет', async () => {
  // Класс ошибки: чужая подпись файла или новый обязательный DTO ломают приватность и старых клиентов.
  await searchFixture(); await searchMessage('full-file', 1);
  const mod = await searchModule(); const q = { pattern: '%отчёт%', names: true, kind: 'file' as const, limit: 30 };
  const plain = await mod.searchAllConversations('a', q);
  assert.equal(Object.hasOwn(plain.hits[0], 'message'), false);
  for (const [viewer, gen] of [['a', 7], ['b', 9]] as const) {
    const hit = (await mod.searchAllConversations(viewer, { ...q, full: true })).hits[0];
    assert.equal(hit.id, 'full-file'); assert.equal(hit.message?.id, 'full-file');
    assert.equal(hit.message?.conversationId, 'kind-main'); assert.equal(hit.message?.author.id, 'b');
    assert.equal(hit.message?.content, 'не совпадает');
    assert.equal(hit.message?.attachments[0]?.url, `https://files.invalid/${viewer}/${gen}/attachment-full-file`);
  }
});
test('R183 HTTP поиск передаёт names и full как необязательные флаги и отвергает другие значения', async () => {
  // Класс ошибки: схема ручки принимает флаги, но забывает передать их SQL-поиску либо меняет старый ответ.
  await searchFixture(); await searchMessage('named-file', 1); await searchMessage('plain-text', 2, { content: 'needle' });
  // HTTP-харнесс подписывает gen=0; поколения 7/9 нужны только отдельной VM-проверке ссылок смотрящего.
  await t.raw.exec("UPDATE users SET token_generation=0 WHERE id IN ('a','b')");
  await t.raw.exec("UPDATE conversation_messages SET attachments='[]'::jsonb WHERE id='plain-text'");
  const path = `/conv/search?q=${encodeURIComponent('отчёт')}&kind=file`;
  const named = await app.inject({ method: 'GET', url: path + '&names=1', headers: auth('a') });
  assert.equal(named.statusCode, 200, named.body); assert.deepEqual(named.json().hits.map((h: { id: string }) => h.id), ['named-file']);
  for (const url of [path, `/conv/search?q=${encodeURIComponent('отчёт')}&names=1`]) {
    const res = await app.inject({ method: 'GET', url, headers: auth('a') });
    assert.equal(res.statusCode, 200, res.body); assert.equal(res.json().hits.length, 0);
  }
  for (const full of ['', '&full=1']) {
    const res = await app.inject({ method: 'GET', url: '/conv/search?q=needle' + full, headers: auth('a') });
    assert.equal(res.statusCode, 200, res.body); assert.equal(res.json().hits[0].id, 'plain-text');
    assert.equal(Object.hasOwn(res.json().hits[0], 'message'), !!full);
  }
  for (const flag of ['names=0', 'full=true'])
    assert.equal((await app.inject({ method: 'GET', url: '/conv/search?q=needle&' + flag, headers: auth('a') })).statusCode, 400);
});

for (const mode of ['deleted', 'hidden', 'withheld', 'exited', 'unknown'] as const) test(`R183 ${mode === 'deleted' ? 'удалённое' : mode === 'hidden' ? 'спрятанное у смотрящего' : mode === 'withheld' ? 'чужое придержанное' : mode === 'exited' ? 'сообщение покинутой группы' : 'сообщение неизвестной беседы'} не раскрывается при names/full, своё придержанное видно`, async () => {
  // Класс ошибки: расширение поискового DTO не должно расширять аудиторию сообщения.
  await searchFixture();
  if (mode === 'exited' || mode === 'unknown') {
    await t.raw.exec(`INSERT INTO conversations(id,kind,created_by,title) VALUES ('kind-other','group','b','Другая группа');
      INSERT INTO conversation_members(conversation_id,user_id,left_at) VALUES ('kind-other','b',NULL)`);
    if (mode === 'exited') await t.raw.exec("INSERT INTO conversation_members(conversation_id,user_id,left_at) VALUES ('kind-other','a',now())");
  }
  await searchMessage('invisible', 2, { conv: mode === 'exited' || mode === 'unknown' ? 'kind-other' : undefined,
    content: 'отчёт в тексте', deleted: mode === 'deleted', hidden: mode === 'hidden', withheld: mode === 'withheld' });
  await searchMessage('own-withheld', 1, { author: 'a', withheld: true, content: 'отчёт в тексте' });
  const mod = await searchModule();
  for (const names of [false, true]) for (const full of [false, true]) {
    const res = await mod.searchAllConversations('a', { pattern: '%отчёт%', kind: 'file', names, full, limit: 30 });
    assert.deepEqual(Array.from(res.hits, h => h.id), ['own-withheld'], 'видимость ограничивает оба варианта ответа');
    assert.equal(Object.hasOwn(res.hits[0], 'message'), full);
  }
});

async function raceScenario(raw = convSearchSource) {
  await t.raw.exec("UPDATE conversation_messages SET hidden_for='{}'::text[] WHERE id='race-file'");
  const res = await (await searchModule(raw, true)).searchAllConversations('a', {
    pattern: '%отчёт%', names: true, kind: 'file', full: true, limit: 30,
  });
  assert.deepEqual(Array.from(res.hits, h => h.id), ['race-file'], 'SQL-хит получен до смены видимости');
  assert.equal(Object.hasOwn(res.hits[0], 'message'), false, 'full не прикладывает ставший скрытым detail');
  const row = await t.raw.query<{ hidden: boolean }>("SELECT 'a'=ANY(hidden_for) AS hidden FROM conversation_messages WHERE id='race-file'");
  assert.equal(row.rows[0]?.hidden, true, 'гонка действительно изменила базу');
}
test('R183 скрытие сообщения между SQL-поиском и detail-чтением оставляет хит без полного сообщения', async () => {
  // Класс ошибки TOCTOU: найденный ранее id не разрешает отдавать содержимое после смены видимости.
  await searchFixture(); await searchMessage('race-file', 1); await raceScenario();
});
test('R183 мутант OR имени вместо AND вида обнаруживается фотографией с именем файла', async () => {
  // Whole-module original-first: настоящий SQL должен различать одинаковые имена разных видов.
  await searchFixture(); await searchMessage('named-file', 1); await searchMessage('named-photo', 2, { mime: 'image/png' });
  await namesScenario(await searchModule());
  const raw = searchChanged('if (qy.kind) msgConds.push(sharedMediaCondAlias(qy.kind, sql`x`));',
    "if (qy.kind) msgConds.push(or(sharedMediaCondAlias(qy.kind, sql`x`), sql`EXISTS (SELECT 1 FROM jsonb_array_elements(x.attachments) AS a WHERE a->>'name' ILIKE ${qy.pattern})`)!)");
  await assert.rejects(namesScenario(await searchModule(raw)), e => e instanceof assert.AssertionError && e.message.includes('имя файла не обходит'));
});
for (const [name, anchor, replacement] of [
  ['message у gone', "return v && !('gone' in v) ? { ...h, message: v } : h;", 'return v ? { ...h, message: v } : h;'],
  ['full игнорирует hidden_for', "const full = rows.filter((m) => messageView(m, viewerId) === 'full');", "const full = rows.filter((m) => messageView({ ...m, hiddenFor: [] }, viewerId) === 'full');"],
] as const) test(`R183 мутант «${name}» обнаруживается реальной сменой видимости до detail`, async () => {
  // Оригинал и мутант получают одинаковый SQL-хит и настоящий новый снимок PGlite, без поддельного gone DTO.
  await searchFixture(); await searchMessage('race-file', 1); await raceScenario();
  await assert.rejects(raceScenario(searchChanged(anchor, replacement)),
    e => e instanceof assert.AssertionError && e.message.includes('full не прикладывает'));
});

before(async () => {
  t = await createTestDb();
  const jwt = await import('../src/auth.js');
  setSuperAdminId = jwt.setSuperAdminId;
  tokenFor = (id) => jwt.signToken({ sub: id, username: id, gen: 0 });
  const { userRoutes } = await import('../src/routes/users.js');
  const { convRoutes } = await import('../src/routes/conv.js');
  const { adminRoutes } = await import('../src/routes/admin.js');
  const { messageRoutes } = await import('../src/routes/messages.js');
  ({ redisPub } = await import('../src/realtime.js'));
  ({ resetBlockCacheForTests: resetBlockCache } = await import('../src/blocks.js'));
  redisPub.publish = (async (channel: string, message: string) => { published.push({ channel, message }); return 1; }) as typeof redisPub.publish;
  redisPub.incr = (async (key: string) => { const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return n; }) as typeof redisPub.incr;
  redisPub.expire = (async () => 1) as typeof redisPub.expire;
  redisPub.ttl = (async () => 60) as typeof redisPub.ttl;
  // All Redis methods used by these tests are stubs; stop the client's initial connection attempt.
  redisPub.disconnect();
  app = Fastify();
  app.setErrorHandler((err: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'validation', details: err.issues });
    return reply.send(err);
  });
  await app.register(userRoutes);
  await app.register(convRoutes);
  await app.register(adminRoutes);
  await app.register(messageRoutes);
  await app.ready();
});

beforeEach(async () => {
  await truncateAll(t.raw);
  resetBlockCache();
  published.length = 0;
  counts.clear();
  setSuperAdminId('a');
  await t.raw.exec(`
    INSERT INTO users (id, username, display_name, password_hash, verified, approved_at) VALUES
      ('a', 'alpha', 'Alpha', 'hash', true, now()),
      ('b', 'literal_name', 'Literal', 'hash', true, now()),
      ('c', 'literalXname', 'Wildcard decoy', 'hash', true, now()),
      ('d', 'guestuser', 'Guest', 'hash', true, now());
    UPDATE users SET home_instance_id='home-instance', home_user_id='home-d' WHERE id='d';
  `);
});

after(async () => {
  setSuperAdminId(null);
  await app.close();
  redisPub.disconnect();
  await t.close();
});

test('поиск трактует подчёркивание в логине буквально и не подменяет его SQL-шаблоном', async () => {
  // Причина: в LIKE символ `_` совпадает с любым символом; поиск должен вернуть только буквальное имя.
  const res = await app.inject({ method: 'GET', url: '/users/search?q=literal_' , headers: auth('a') });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().users.map((u: { id: string }) => u.id), ['b']);
});

test('SQL-поиск отсекает недоступных и применяет точность, длину и побайтный порядок до лимита', async () => {
  // Чистая сортировка не доказывает ORDER BY/WHERE базы: LIMIT может раньше отрезать точное совпадение.
  await t.raw.exec(`INSERT INTO users (id,username,display_name,password_hash,verified,approved_at)
    SELECT 'hit-'||n, name, 'Peer', 'hash', true, now()
    FROM unnest(ARRAY['abc-long','abc_','abc.','abc-','abc0','abc1','abc2','abc3','abc4','abc5','ABC','zabc']) WITH ORDINALITY AS u(name,n);
    INSERT INTO users (id,username,display_name,password_hash,verified,approved_at,deleted_at,home_instance_id)
    VALUES ('no-mail','abc-unverified','Peer','hash',false,now(),NULL,NULL),
      ('no-approval','abc-pending','Peer','hash',true,NULL,NULL,NULL),
      ('deleted','abc-deleted','Peer','hash',true,now(),now(),NULL),
      ('foreign','abc-foreign','Peer','hash',true,now(),NULL,'other-home');`);
  const found = await app.inject({ method: 'GET', url: '/users/search?q=AbC', headers: auth('a') });
  assert.equal(found.statusCode, 200, found.body);
  assert.deepEqual(found.json().users.map((u: { username: string }) => u.username), ['ABC', 'abc-', 'abc.', 'abc0', 'abc1', 'abc2', 'abc3', 'abc4']);
});

test('буквальный подчёркнутый префикс не теряется за восемью более короткими LIKE-двойниками', async () => {
  // Причина: замена starts_with на LIKE сочтёт `_` шаблоном и заполнит LIMIT более короткими чужими логинами.
  await t.raw.exec(`INSERT INTO users (id,username,display_name,password_hash,verified,approved_at) VALUES
    ('literal-target','a_cd-long','Target','hash',true,now()),
    ('like-0','a0cd','Decoy','hash',true,now()), ('like-1','a1cd','Decoy','hash',true,now()),
    ('like-2','a2cd','Decoy','hash',true,now()), ('like-3','a3cd','Decoy','hash',true,now()),
    ('like-4','a4cd','Decoy','hash',true,now()), ('like-5','a5cd','Decoy','hash',true,now()),
    ('like-6','a6cd','Decoy','hash',true,now()), ('like-7','a7cd','Decoy','hash',true,now()),
    ('like-8','a8cd','Decoy','hash',true,now());`);
  const found = await app.inject({ method: 'GET', url: '/users/search?q=a_cd', headers: auth('a') });
  assert.equal(found.statusCode, 200, found.body);
  assert.deepEqual(found.json().users.map((u: { id: string }) => u.id), ['literal-target']);

  // Исполняем неизменённый SQL-модуль и его изолированную мутацию: ошибочная LIKE-выборка заполнит LIMIT двойниками,
  // после чего rankUserHits отфильтрует их и потеряет единственный буквальный результат.
  const source = readFileSync(new URL('../src/db/userSearch.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const compile = async (text: string) => {
    const module = { exports: {} as Record<string, unknown> };
    const code = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const deps: Record<string, unknown> = {
      'drizzle-orm': await import('drizzle-orm'),
      '../userSearchRules.js': await import('../src/userSearchRules.js'),
      './index.js': { db: t.db },
      './schema.js': await import('../src/db/schema.js'),
    };
    runInNewContext(code, { module, exports: module.exports, require: (id: string) => {
      assert.ok(Object.hasOwn(deps, id), `unexpected userSearch dependency: ${id}`);
      return deps[id];
    } });
    return module.exports as unknown as { searchLocalUsers(me: string, q: string): Promise<{ id: string }[]> };
  };
  const original = await compile(source);
  const originalHits = await original.searchLocalUsers('a', 'a_cd');
  assert.deepEqual(originalHits.map((u) => u.id), ['literal-target']);
  const mutation = source.replace('sql`starts_with(${name}, ${q})`', 'sql`${name} LIKE ${q + \'%\'}`');
  assert.notEqual(mutation, source, 'fixture must mutate the actual SQL predicate');
  const mutantHits = await (await compile(mutation)).searchLocalUsers('a', 'a_cd');
  assert.deepEqual(mutantHits.map((u) => u.id), [], 'LIKE must be caught losing target behind its eight false-prefix rows');
});

test('поиск проверяет ввод и гостевой доступ до Redis, а реальный счётчик ограничивает 31-й запрос', async () => {
  // Причина: мусорный ввод не должен расходовать лимит, а гостевая учётка не является локальной.
  const invalid = await app.inject({ method: 'GET', url: '/users/search?q=ab', headers: auth('a') });
  assert.equal(invalid.statusCode, 400, invalid.body);
  assert.equal(counts.size, 0, '400 не должен считать попытку в Redis');
  const guest = await app.inject({ method: 'GET', url: '/users/search?q=alpha', headers: auth('d') });
  assert.equal(guest.statusCode, 403, guest.body);
  assert.equal(counts.size, 0, 'гость должен быть отсеян до лимитера');
  for (let i = 1; i <= 30; i++) {
    const ok = await app.inject({ method: 'GET', url: '/users/search?q=lit', headers: auth('a') });
    assert.equal(ok.statusCode, 200, `поиск ${i}: ${ok.body}`);
  }
  const limited = await app.inject({ method: 'GET', url: '/users/search?q=lit', headers: auth('a') });
  assert.equal(limited.statusCode, 429, limited.body);
  assert.equal(limited.headers['retry-after'], '60');
  assert.equal(counts.get('rl:usearch:a'), 31, 'лимит должен опираться на результат INCR, а не число вызовов в тесте');
});

test('пустая беседа скрыта в списке и sync до открытия получателем, а revealDirect показывает её', async () => {
  // Причина: при anyone нельзя раскрывать получателю пустой след чужого открытия; явное открытие обязано развернуть его.
  await t.raw.exec(`INSERT INTO instance_settings (key,value) VALUES ('dm_policy','{"policy":"anyone"}')`);
  const opened = await app.inject({ method: 'POST', url: '/conv/direct', headers: auth('a'), payload: { userId: 'b' } });
  assert.equal(opened.statusCode, 201, opened.body);
  const convId = opened.json().id as string;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(published.some((p) => p.channel === 'gw:user:b'), false, 'пустое открытие не должно отправлять получателю событие');
  const list = await app.inject({ method: 'GET', url: '/conv', headers: auth('b') });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().conversations.some((x: { id: string }) => x.id === convId), false, 'список не раскрывает pending');
  const sync = await app.inject({ method: 'GET', url: '/conv/sync?pts=0', headers: auth('b') });
  assert.equal(sync.statusCode, 200, sync.body);
  assert.equal(sync.json().conversations.some((x: { id: string }) => x.id === convId), false);
  await t.raw.exec(`INSERT INTO conversations (id,kind,direct_key,created_by) VALUES ('legacy-bc','direct','b:c','b');
    INSERT INTO conversation_members (conversation_id,user_id) VALUES ('legacy-bc','b'),('legacy-bc','c');`);
  const legacy = await app.inject({ method: 'GET', url: '/conv', headers: auth('b') });
  assert.equal(legacy.json().conversations.some((x: { id: string }) => x.id === 'legacy-bc'), true, 'NULL pending у старых строк остаётся видимым');
  const revealed = await app.inject({ method: 'POST', url: '/conv/direct', headers: auth('b'), payload: { userId: 'a' } });
  assert.equal(revealed.statusCode, 200, revealed.body);
  assert.equal(revealed.json().id, convId);
  const visible = await app.inject({ method: 'GET', url: '/conv', headers: auth('b') });
  assert.equal(visible.json().conversations.some((x: { id: string }) => x.id === convId), true);
  assert.equal((await t.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM user_changes WHERE user_id='b' AND conversation_id=$1`, [convId])).rows[0]?.n, 1, 'reveal должен журналироваться получателю');
});

test('первое сообщение раскрывает беседу получателю вместе с сообщением', async () => {
  // Причина: pending снимается не при создании, а первым реально доставленным сообщением.
  await t.raw.exec(`INSERT INTO instance_settings (key,value) VALUES ('dm_policy','{"policy":"anyone"}')`);
  const opened = await app.inject({ method: 'POST', url: '/conv/direct', headers: auth('a'), payload: { userId: 'b' } });
  const id = opened.json().id as string;
  const sent = await app.inject({ method: 'POST', url: `/conv/${id}/messages`, headers: auth('a'), payload: {
    clientId: '00000000-0000-4000-8000-000000000101', content: 'hello',
  } });
  assert.equal(sent.statusCode, 201, sent.body);
  const list = await app.inject({ method: 'GET', url: '/conv', headers: auth('b') });
  assert.equal(list.json().conversations.some((c: { id: string }) => c.id === id), true);
  const sync = await app.inject({ method: 'GET', url: '/conv/sync?pts=0', headers: auth('b') });
  assert.equal(sync.json().messages.some((m: { content?: string; text?: string }) => m.text === 'hello' || m.content === 'hello'), true);
});

test('придержанное сообщение и markRead автора не создают журнал или события для заблокировавшего собеседника', async () => {
  // Причина: блокировка не должна поднимать беседу, уведомлять блокирующего или раскрывать, что автор пишет.
  await t.raw.exec(`INSERT INTO instance_settings (key,value) VALUES ('dm_policy','{"policy":"anyone"}');
    INSERT INTO user_blocks (blocker_id,blocked_id) VALUES ('a','b');`);
  const opened = await app.inject({ method: 'POST', url: '/conv/direct', headers: auth('a'), payload: { userId: 'b' } });
  assert.equal(opened.statusCode, 201, opened.body);
  const id = opened.json().id as string;
  await new Promise((resolve) => setTimeout(resolve, 20));
  published.length = 0;
  const sent = await app.inject({ method: 'POST', url: `/conv/${id}/messages`, headers: auth('b'), payload: {
    clientId: '00000000-0000-4000-8000-000000000102', content: 'held',
  } });
  assert.equal(sent.statusCode, 201, sent.body);
  const msgId = sent.json().id as string;
  const row = await t.raw.query<{ withheld: boolean }>('SELECT withheld FROM conversation_messages WHERE id=$1', [msgId]);
  assert.equal(row.rows[0]?.withheld, true);
  assert.equal(published.some((p) => p.channel === 'gw:user:a'), false, `held message не должен публиковаться блокирующему: ${published.map((p) => `${p.channel}:${JSON.parse(p.message).m.t}`).join(',')}`);
  const access = await import('../src/conversations.js');
  const loaded = await access.loadAccess(id, 'a');
  assert.ok(loaded, 'создатель должен оставаться участником для проверки markRead');
  const key = sent.json().sortKey as number;
  assert.ok(key > 0, 'ответ отправки содержит ключ для markRead');
  const senderPtsAfterHeld = Number((await t.raw.query<{ pts: number }>(`SELECT pts FROM user_sync WHERE user_id='b'`)).rows[0]?.pts ?? 0);
  published.length = 0;
  const read = await app.inject({ method: 'POST', url: `/conv/${id}/read`, headers: auth('a'), payload: { key } });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal((await t.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM user_changes WHERE user_id='b' AND pts>$1`, [senderPtsAfterHeld])).rows[0]?.n, 0);
  assert.equal(published.some((p) => p.channel === 'gw:user:b'), false, 'markRead автора не должен уведомлять блокирующего');
});

test('POST /conv/direct отдаёт машинную причину 403, реальный INCR даёт 429 на 11-й новой беседе', async () => {
  // Причина: клиенты ветвятся по reason, а Redis, а не локальный счётчик теста, задаёт границу десяти новых ЛС.
  const forbidden = await app.inject({ method: 'POST', url: '/conv/direct', headers: auth('b'), payload: { userId: 'c' } });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
  assert.equal(forbidden.json().reason, 'dm.no_shared_server');
  await t.raw.exec(`INSERT INTO instance_settings (key,value) VALUES ('dm_policy','{"policy":"anyone"}');
    INSERT INTO users (id,username,display_name,password_hash,verified,approved_at)
    SELECT 'stranger-'||n, 'stranger'||n, 'Stranger', 'hash', true, now() FROM generate_series(1,11) n;`);
  for (let i = 1; i <= 10; i++) {
    const res = await app.inject({ method: 'POST', url: '/conv/direct', headers: auth('b'), payload: { userId: `stranger-${i}` } });
    assert.equal(res.statusCode, 201, `новая беседа ${i}: ${res.body}`);
  }
  const limited = await app.inject({ method: 'POST', url: '/conv/direct', headers: auth('b'), payload: { userId: 'stranger-11' } });
  assert.equal(limited.statusCode, 429, limited.body);
  assert.equal(limited.json().reason, 'dm.new_limit');
  assert.equal(limited.headers['retry-after'], '60');
  assert.equal(counts.get('rl:dm-new:b'), 11, '11-я попытка должна быть проверена INCR-ом');
});

test('создатель, которого блокируют, не раскрывает пустую беседу придержанным сообщением или своим чтением', async () => {
  // Важна именно эта сторона пары: создатель скрытой беседы не должен уведомлять заблокировавшего получателя.
  await t.raw.exec(`INSERT INTO instance_settings (key,value) VALUES ('dm_policy','{"policy":"anyone"}');
    INSERT INTO user_blocks (blocker_id,blocked_id) VALUES ('a','b');`);
  const opened = await app.inject({ method: 'POST', url: '/conv/direct', headers: auth('b'), payload: { userId: 'a' } });
  assert.equal(opened.statusCode, 201, opened.body);
  const id = opened.json().id as string;
  published.length = 0;
  const sent = await app.inject({ method: 'POST', url: `/conv/${id}/messages`, headers: auth('b'), payload: {
    clientId: '00000000-0000-4000-8000-000000000103', content: 'held from creator',
  } });
  assert.equal(sent.statusCode, 201, sent.body);
  const read = await app.inject({ method: 'POST', url: `/conv/${id}/read`, headers: auth('b'), payload: { key: sent.json().sortKey } });
  assert.equal(read.statusCode, 200, read.body);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(published.some(p => p.channel === 'gw:user:a'), false, 'ни сообщение, ни чтение создателя не публикуются блокирующему');
  const visible = await app.inject({ method: 'GET', url: '/conv', headers: auth('a') });
  assert.equal(visible.json().conversations.some((c: { id: string }) => c.id === id), false, 'получатель продолжает не видеть pending');
  const sync = await app.inject({ method: 'GET', url: '/conv/sync?pts=0', headers: auth('a') });
  assert.equal(sync.json().conversations.some((c: { id: string }) => c.id === id), false, 'догонка не раскрывает скрытую беседу');
});

test('админ GET/PUT сохраняет dmPolicy и не принимает неизвестную политику', async () => {
  // Причина: политика должна быть доступна управляющему интерфейсу и валидация не должна молча открыть личку.
  const initial = await app.inject({ method: 'GET', url: '/admin/instance', headers: auth('a') });
  assert.equal(initial.statusCode, 200, initial.body);
  assert.equal(initial.json().dmPolicy, 'shared');
  const put = await app.inject({ method: 'PUT', url: '/admin/instance', headers: auth('a'), payload: { dmPolicy: 'anyone' } });
  assert.equal(put.statusCode, 200, put.body);
  const after = await app.inject({ method: 'GET', url: '/admin/instance', headers: auth('a') });
  assert.equal(after.json().dmPolicy, 'anyone');
  const bad = await app.inject({ method: 'PUT', url: '/admin/instance', headers: auth('a'), payload: { dmPolicy: 'open' } });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.equal((await app.inject({ method: 'GET', url: '/admin/instance', headers: auth('a') })).json().dmPolicy, 'anyone');
});

test('настройки уведомлений валидируются и сериализуются только в собственный профиль', async () => {
  // Ловит чтение чужой приватности клиентом сервера и настройку повторов, для которой нет поддерживаемого интервала.
  const response = await app.inject({
    method: 'PATCH', url: '/users/me', headers: auth('a'),
    payload: { notifyView: 'nothing', notifyGroups: false, notifyDm: false, notifyRepeat: 60 },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(
    Object.fromEntries(['notifyView', 'notifyGroups', 'notifyDm', 'notifyRepeat'].map((key) => [key, response.json()[key]])),
    { notifyView: 'nothing', notifyGroups: false, notifyDm: false, notifyRepeat: 60 },
  );
  assert.equal((await app.inject({ method: 'PATCH', url: '/users/me', headers: auth('a'), payload: { notifyRepeat: 7 } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: '/users/me', headers: auth('a'), payload: { notifyView: 'secret' } })).statusCode, 400);

  const { db } = await import('../src/db/index.js');
  const { users } = await import('../src/db/schema.js');
  const { serializeUser } = await import('../src/serialize.js');
  const own = (await db.select().from(users).where(eq(users.id, 'a')))[0]!;
  assert.equal(serializeUser(own).notifyView, 'nothing');
  assert.equal(Object.hasOwn(serializeUser(own, 'b'), 'notifyView'), false);
  assert.equal(Object.hasOwn(serializeUser(own, 'b'), 'notifyGroups'), false);
});

test('общий поиск серверов видит только каналы с обоими правами и курсор не теряет равные даты', async () => {
  // Ловит утечку закрытых каналов/серверов и пропуск соседа при одинаковой точности created_at.
  setSuperAdminId('c'); // иначе штатный fixture делает a супер-админом и намеренно обходит запреты каналов.
  const { Permission, FEATURE_SRVSEARCH1 } = await import('@gusvoice/shared');
  const both = (Permission.VIEW_CHANNEL | Permission.READ_HISTORY).toString();
  await t.raw.exec(`
    INSERT INTO servers (id,name,owner_id) VALUES ('search-s','Локальный сервер','b'),('search-other','Чужой сервер','c');
    INSERT INTO server_members (server_id,user_id,nickname) VALUES ('search-s','a',''),('search-s','b','Ник автора'),('search-other','c',NULL);
    INSERT INTO roles (id,server_id,name,permissions,is_everyone) VALUES
      ('search-everyone','search-s','everyone','${both}',true),
      ('search-other-everyone','search-other','everyone','${both}',true);
    INSERT INTO channels (id,server_id,name,type) VALUES
      ('search-open','search-s','Открытый','text'),('search-secret','search-s','Секретный','text'),
      ('search-nohist','search-s','Без истории','text'),('search-foreign','search-other','Чужой','text');
    INSERT INTO channel_overwrites (channel_id,target_id,target_type,deny) VALUES
      ('search-secret','search-everyone','role','${Permission.VIEW_CHANNEL}'),
      ('search-nohist','search-everyone','role','${Permission.READ_HISTORY}');
    INSERT INTO messages (id,channel_id,author_id,content,created_at) VALUES
      ('search-a','search-open','b','needle one','2026-10-08 10:00:00.123456+00'),
      ('search-b','search-open','b','needle two','2026-10-08 10:00:00.123456+00'),
      ('search-c','search-open','b','needle three','2026-10-08 10:00:00.123456+00'),
      ('search-secret-hit','search-secret','b','needle secret','2026-10-08 10:00:00.123456+00'),
      ('search-nohist-hit','search-nohist','b','needle nohistory','2026-10-08 10:00:00.123456+00'),
      ('search-foreign-hit','search-foreign','c','needle foreign','2026-10-08 10:00:00.123456+00');
  `);
  const features = await import('../src/instanceFeatures.js');
  assert.ok(features.INSTANCE_FEATURES.includes(FEATURE_SRVSEARCH1));
  const noAuth = await app.inject({ method: 'GET', url: '/search/servers?q=needle' });
  assert.equal(noAuth.statusCode, 401);

  const first = await app.inject({ method: 'GET', url: '/search/servers?q=needle&limit=2', headers: auth('a') });
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json().hits.map((h: { id: string }) => h.id), ['search-c', 'search-b']);
  assert.equal(first.json().hits[0].authorName, 'Ник автора');
  assert.ok(first.json().next);
  const second = await app.inject({
    method: 'GET', url: `/search/servers?q=needle&limit=2&before=${encodeURIComponent(first.json().next)}`, headers: auth('a'),
  });
  assert.equal(second.statusCode, 200, second.body);
  assert.deepEqual(second.json().hits.map((h: { id: string }) => h.id), ['search-a']);
  assert.equal(second.json().next, null);
  assert.equal((await app.inject({ method: 'GET', url: '/search/servers?q=needle&before=garbage', headers: auth('a') })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/search/servers?q=x', headers: auth('a') })).statusCode, 400);

  const beforeShort = counts.get('rl:srvsearch:a') ?? 0;
  const short = await app.inject({ method: 'GET', url: '/search/servers?q=ab', headers: auth('a') });
  assert.equal(short.statusCode, 200, short.body); assert.deepEqual(short.json(), { hits: [], next: null });
  assert.equal(counts.get('rl:srvsearch:a') ?? 0, beforeShort, 'два символа дают пустой результат без расхода лимита');
  assert.equal((await app.inject({ method: 'GET', url: '/search/servers?q=a', headers: auth('a') })).statusCode, 400);
  assert.equal(counts.get('rl:srvsearch:a') ?? 0, beforeShort, 'один символ не расходует лимит');
  while ((counts.get('rl:srvsearch:a') ?? 0) < 20) {
    const allowed = await app.inject({ method: 'GET', url: '/search/servers?q=needle', headers: auth('a') });
    assert.equal(allowed.statusCode, 200, allowed.body);
  }
  assert.equal((await app.inject({ method: 'GET', url: '/search/servers?q=needle', headers: auth('a') })).statusCode, 429);
  assert.equal(counts.get('rl:srvsearch:a'), 21, 'двадцать запросов разрешены, двадцать первый ограничен');

  for (const offset of ['+03', '+05:30']) {
    const at = `2026-10-08 05:49:11${offset}|search-a`;
    const accepted = await app.inject({ method: 'GET', url: `/search/servers?q=needle&before=${encodeURIComponent(at)}`, headers: auth('b') });
    assert.equal(accepted.statusCode, 200, `${offset} — допустимое смещение, ответ: ${accepted.body}`);
  }
  const validCursors = [
    '2026-10-08 05:49:11+15:59|search-a',
    '2026-10-08 05:49:11-15|search-a',
    '2026-10-08 05:49:11+05:30|search-a',
    '2026-10-08 05:49:11+0530|search-a',
    '2026-10-08 05:49:11Z|search-a',
    `${String((await t.raw.query<{ at: string }>("SELECT created_at::text AS at FROM messages WHERE id='search-a'")).rows[0]?.at)}|search-a`,
  ];
  for (const cursor of validCursors) {
    const accepted = await app.inject({ method: 'GET', url: `/search/servers?q=needle&before=${encodeURIComponent(cursor)}`, headers: auth('b') });
    assert.equal(accepted.statusCode, 200, `${cursor} — курсор PG должен приниматься, ответ: ${accepted.body}`);
  }
  for (const offset of ['+99', '+03:99', '+16', '+15:60', '+1600']) {
    const cursor = `2026-10-08 05:49:11${offset}|search-a`;
    const rejected = await app.inject({ method: 'GET', url: `/search/servers?q=needle&before=${encodeURIComponent(cursor)}`, headers: auth('b') });
    assert.equal(rejected.statusCode, 400, `${offset} должен отсеяться до timestamptz, не дать 500: ${rejected.body}`);
  }

  const cursorSource = readFileSync(new URL('../src/serverSearch.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const compileCursor = async (source: string) => {
    const module = { exports: {} as Record<string, unknown> };
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const deps: Record<string, unknown> = {
      'drizzle-orm': await import('drizzle-orm'),
      './db/index.js': { db: t.db },
      './db/schema.js': await import('../src/db/schema.js'),
      './permissions.js': await import('../src/permissions.js'),
    };
    runInNewContext(code, { module, exports: module.exports, Date, Map, Set, require: (id: string) => {
      assert.ok(Object.hasOwn(deps, id), `unexpected serverSearch dependency: ${id}`);
      return deps[id];
    } });
    return module.exports as unknown as { splitCursor(value: string): { at: string; id: string } | null };
  };
  const cursorControl = await compileCursor(cursorSource);
  assert.equal(cursorControl.splitCursor('2026-10-08 05:49:11+99|search-a'), null, 'неизменённый модуль отвергает недопустимый часовой пояс');
  const hourMutation = cursorSource.replace('tzh <= TZ_MAX_HOUR', 'true');
  assert.notEqual(hourMutation, cursorSource, 'мутант границы часов найден');
  assert.equal((await compileCursor(hourMutation)).splitCursor('2026-10-08 05:49:11+99|search-a') === null, false,
    'удалённая проверка часов пропускает +99');
  const minuteMutation = cursorSource.replace('tzm < 60', 'true');
  assert.notEqual(minuteMutation, cursorSource, 'мутант границы минут найден');
  assert.equal((await compileCursor(minuteMutation)).splitCursor('2026-10-08 05:49:11+03:99|search-a') === null, false,
    'удалённая проверка минут пропускает +03:99');
  for (const [limit, cursor, accepted] of [
    [16, '2026-10-08 05:49:11+16|search-a', true],
    [14, '2026-10-08 05:49:11+15:59|search-a', false],
  ] as const) {
    const changedLimit = cursorSource.replace('const TZ_MAX_HOUR = 15;', `const TZ_MAX_HOUR = ${limit};`);
    assert.notEqual(changedLimit, cursorSource, `мутант TZ_MAX_HOUR=${limit} найден`);
    assert.equal((await compileCursor(changedLimit)).splitCursor(cursor) === null, !accepted,
      `TZ_MAX_HOUR=${limit} ${accepted ? 'ошибочно принимает' : 'ошибочно отвергает'} граничный курсор`);
  }
  const { searchableChannelIds } = await import('../src/permissions.js');
  const searchables = searchableChannelIds(new Map([
    ['view-only', BigInt(Permission.VIEW_CHANNEL)],
    ['history-only', BigInt(Permission.READ_HISTORY)],
    ['both', BigInt(Permission.VIEW_CHANNEL | Permission.READ_HISTORY)],
  ]));
  assert.deepEqual(searchables, ['both']);
});
