import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, beforeEach, afterEach, after, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify from 'fastify';
import ts from 'typescript';
import { ZodError } from 'zod';
import { INSTANCE_FEATURES } from '../src/instanceFeatures.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;
let app: ReturnType<typeof Fastify>;
let token: string;
let redis: typeof import('../src/realtime.js').redisPub;
let conv: typeof import('../src/conversations.js');
const counts = new Map<string, number>();
const expires = new Map<string, number>();
const get = (url = '/conv/frequent', target = app) => target.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
const hide = (items: unknown) => app.inject({ method: 'POST', url: '/conv/frequent/hide', headers: { authorization: `Bearer ${token}` }, payload: { items } });

before(async () => {
  t = await createTestDb();
  token = (await import('../src/auth.js')).signToken({ sub: 'a', username: 'a', gen: 0 });
  redis = (await import('../src/realtime.js')).redisPub;
  redis.incr = (async (key: string) => { const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return n; }) as typeof redis.incr;
  redis.expire = (async (key: string, seconds: number) => { expires.set(key, seconds); return 1; }) as typeof redis.expire;
  redis.ttl = (async () => 60) as typeof redis.ttl;
  conv = await import('../src/conversations.js');
  app = await routeApp((await import('../src/routes/conv.js')).convRoutes);
});
beforeEach(async () => {
  await truncateAll(t.raw);
  counts.clear(); expires.clear();
  // now() одинаков для наполнения и настоящего запроса: обе стороны границы 90 суток точны.
  await t.raw.exec(`BEGIN; INSERT INTO users(id,username,display_name,password_hash) VALUES ('a','alpha','Alpha','hash'),('b','bravo','Bravo','hash');`);
});
afterEach(async () => { await t.raw.exec('ROLLBACK'); });
after(async () => { await app.close(); redis.disconnect(); await t.close(); });

async function routeApp(routes: typeof import('../src/routes/conv.js').convRoutes) {
  const target = Fastify();
  target.setErrorHandler((error, _req, reply) => error instanceof ZodError ? reply.code(400).send({ error: 'validation' }) : reply.send(error));
  await target.register(routes); await target.ready(); return target;
}
async function conversation(id: string) {
  await t.raw.query(`INSERT INTO conversations(id,kind,created_by) VALUES ($1,'group','a')`, [id]);
  await t.raw.query(`INSERT INTO conversation_members(conversation_id,user_id) VALUES ($1,'a'),($1,'b')`, [id]);
}
async function message(id: string, cid: string, days = 0, author = 'a', key = 1) {
  await t.raw.query(`INSERT INTO conversation_messages(id,conversation_id,author_id,sort_key,content,created_at)
    VALUES ($1,$2,$3,$4,'hello',now()-$5::float8*interval '1 day')`, [id, cid, author, key, days]);
}

test('частота — сумма моих exp(-возраст/28), а не свежесть; lastAt не берётся у собеседника', async () => {
  await conversation('often'); await conversation('recent');
  await message('o1','often',28); await message('o2','often',28,'a',2); await message('o3','often',28,'a',3);
  await message('peer','often',0,'b',4); await message('r','recent');
  const items = (await conv.frequentConversations('a',30)).items;
  assert.deepEqual(items.map(x => x.conversationId), ['often','recent']);
  assert.equal(items[0].score, Math.round(3*Math.exp(-1)*1000)/1000);
  assert.equal(items[1].score, 1);
  const expected = (await t.raw.query<{ at: Date }>(`SELECT now()-interval '28 days' AS at`)).rows[0].at;
  assert.equal(items[0].lastAt, new Date(expected).toISOString());
  assert.deepEqual((await conv.frequentConversations('a',1)).items, items.slice(0,1));
});

test('ровно 90 суток входит, микросекунда старше уже нет; чужие сообщения не создают частую беседу', async () => {
  for (const id of ['edge','old','peer']) await conversation(id);
  await message('edge','edge',90); await message('old','old',90); await message('peer','peer',0,'b');
  await t.raw.exec(`UPDATE conversation_messages SET created_at=created_at-interval '1 microsecond' WHERE id='old'`);
  const items = (await conv.frequentConversations('a',30)).items;
  assert.deepEqual(items.map(x=>x.conversationId), ['edge']);
  assert.equal(items[0].score, Math.round(Math.exp(-90/28)*1000)/1000);
});

async function exclusions(mod = conv) {
  for (const id of ['keep','left','removed','deleted','system','hidden','other-hidden','cleared']) {
    await conversation(id); await message(id,id);
  }
  await t.raw.exec(`UPDATE conversation_members SET left_at=now() WHERE conversation_id='left' AND user_id='a';
    UPDATE conversation_members SET hidden_key=1 WHERE conversation_id IN ('removed','cleared') AND user_id='a';
    UPDATE conversation_messages SET deleted_at=now() WHERE id='deleted';
    UPDATE conversation_messages SET service='{"kind":"pin","messageId":"keep"}' WHERE id='system';
    UPDATE conversation_messages SET hidden_for=ARRAY['a'] WHERE id='hidden';
    UPDATE conversation_messages SET hidden_for=ARRAY['b'] WHERE id='other-hidden';`);
  // Чужое новое сообщение возвращает чат, но не мои прежние строки до hidden_key.
  await message('cleared-peer','cleared',0,'b',2);
  const items = (await mod.frequentConversations('a',30)).items;
  assert.deepEqual(Array.from(items,x=>x.conversationId).sort(), ['keep','other-hidden']);
}
test('покинутые, убранные, удалённые, служебные и скрытые мной исключены; скрытое другим принимается', async () => { await exclusions(); });

test('GET по умолчанию отдаёт 20, принимает 30 и отвергает 31, ноль и дробь; freq1 объявлен', async () => {
  for (let i=0;i<31;i++) { const id=`c${i}`; await conversation(id); await message(id,id,i/100); }
  assert.equal((await get()).json().items.length,20);
  const max = await get('/conv/frequent?limit=30'); assert.equal(max.statusCode,200); assert.equal(max.json().items.length,30);
  assert.equal((await get('/conv/frequent?limit=1')).json().items.length,1);
  for (const limit of ['31','0','1.5','abc']) assert.equal((await get(`/conv/frequent?limit=${limit}`)).statusCode,400);
  assert.ok(INSTANCE_FEATURES.includes('freq1'));
});

async function independentBudget(target = app) {
  counts.clear(); expires.clear(); counts.set('rl:conv-search:a',1000);
  for (let i=0;i<20;i++) assert.equal((await get('/conv/frequent',target)).statusCode,200);
  assert.equal((await get('/conv/frequent',target)).statusCode,429);
  assert.equal(counts.get('rl:conv-search:a'),1000);
  assert.equal(expires.get('rl:conv-frequent:a'),60);
}
test('20 запросов за 60 секунд имеют свой бюджет: исчерпанный поиск не мешает, 21-й даёт 429', async () => { await independentBudget(); });

// Загружаем ЦЕЛЫЙ настоящий модуль: никакой извлечённой функции или копии запроса.
async function sourceModule<T>(relative: string, from?: string, to?: string): Promise<T> {
  const url = new URL(relative, import.meta.url);
  let source = readFileSync(url,'utf8').replace(/\r\n/g,'\n');
  if (from !== undefined) {
    // Одинаковое условие встречается в истории: мутируем именно frequent, исполняя модуль целиком.
    const start=relative.endsWith('conversations.ts') ? source.indexOf('export async function frequentConversations(') : 0;
    const end=relative.endsWith('conversations.ts') ? source.indexOf('\nexport async function searchAllConversations(',start) : source.length;
    const region=source.slice(start,end);
    assert.ok(region.includes(from),`якорь ${from}`);
    source=source.slice(0,start)+region.replace(from,to!)+source.slice(end);
  }
  const parsed = ts.createSourceFile(url.pathname,source,ts.ScriptTarget.Latest,true);
  const imports: Record<string,unknown> = {};
  for (const decl of parsed.statements) {
    if (!ts.isImportDeclaration(decl) || !ts.isStringLiteral(decl.moduleSpecifier) || decl.importClause?.isTypeOnly) continue;
    const spec=decl.moduleSpecifier.text;
    imports[spec]=await import(spec.startsWith('.') ? new URL(spec,url).href : spec);
  }
  const module={exports:{}};
  runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {module,exports:module.exports,Date,Map,Set,Buffer,URL,Promise,console,fetch:globalThis.fetch,require:(spec:string)=>{assert.ok(spec in imports);return imports[spec];}});
  return module.exports as T;
}
test('реальные SQL-мутанты author, left, deleted и hidden_for отвергаются той же проверкой Postgres', async () => {
  const verify=async (mod: typeof conv) => { await t.raw.exec('ROLLBACK'); await truncateAll(t.raw); await t.raw.exec(`BEGIN; INSERT INTO users(id,username,display_name,password_hash) VALUES ('a','alpha','Alpha','hash'),('b','bravo','Bravo','hash')`); await exclusions(mod); };
  await verify(await sourceModule<typeof conv>('../src/conversations.ts'));
  for (const clause of ['AND x.author_id = ${me}','AND m.left_at IS NULL','AND x.deleted_at IS NULL','AND NOT (${me} = ANY(x.hidden_for))']) {
    const mutant=await sourceModule<typeof conv>('../src/conversations.ts',clause,'AND TRUE');
    await assert.rejects(()=>verify(mutant),assert.AssertionError,clause);
  }
});
test('мутант conv-search вместо отдельного ключа ловится реальным GET после зелёного оригинала', async () => {
  type Routes=typeof import('../src/routes/conv.js');
  for (const mutant of [false,true]) {
    const mod=await sourceModule<Routes>('../src/routes/conv.ts', mutant ? '`conv-frequent:${me}`' : undefined,'`conv-search:${me}`');
    const target=await routeApp(mod.convRoutes);
    try { if (mutant) await assert.rejects(()=>independentBudget(target),assert.AssertionError); else await independentBudget(target); }
    finally { await target.close(); }
  }
});
test('мутант сортировки по свежести проигрывает частоте на тех же настоящих строках', async () => {
  await conversation('often'); await conversation('recent');
  for (let i=0;i<3;i++) await message(`old${i}`,'often',28,'a',i+1);
  await message('new','recent');
  const verify=async (mod: typeof conv) => assert.deepEqual(Array.from((await mod.frequentConversations('a',30)).items,x=>x.conversationId),['often','recent']);
  await verify(await sourceModule<typeof conv>('../src/conversations.ts'));
  await assert.rejects(()=>sourceModule<typeof conv>('../src/conversations.ts','ORDER BY score DESC, last_at DESC','ORDER BY last_at DESC, score DESC').then(verify),assert.AssertionError);
});

test('R126 отметка убирает частую беседу до нового моего сообщения, чужой ответ её не возвращает', async () => {
  // Ловит скрытие только на устройстве и возвращение по чужому lastAt.
  await conversation('hide'); await message('old','hide',1);
  assert.equal((await get()).json().items.length,1);
  const response=await hide([{conversationId:'hide'}]);
  assert.equal(response.statusCode,200,response.body); assert.deepEqual(response.json(),{hidden:1});
  assert.deepEqual((await get()).json().items,[]);
  await message('peer','hide',0,'b',2);
  assert.deepEqual((await get()).json().items,[]);
  await message('equal','hide',0,'a',3);
  assert.deepEqual((await get()).json().items,[],'равно отметке ещё скрыто');
  await t.raw.exec(`UPDATE conversation_messages SET created_at=now()+interval '1 microsecond' WHERE id='equal'`);
  assert.equal((await get()).json().items[0].conversationId,'hide');
  assert.ok(INSTANCE_FEATURES.includes('freq2'));
});

async function verifyHideClock(mod = conv) {
  await conversation('clock'); await message('clock-old','clock',2);
  const now = new Date((await t.raw.query<{at:Date}>('SELECT now() AS at')).rows[0].at);
  const future=new Date(now.getTime()+86400000);
  assert.equal(await mod.hideFrequentConversations('a',[{conversationId:'clock',at:future}]),1);
  const stored=async()=>new Date((await t.raw.query<{at:Date}>(`SELECT frequent_hidden_at AS at FROM conversation_members WHERE conversation_id='clock' AND user_id='a'`)).rows[0].at).getTime();
  assert.equal(await stored(),now.getTime(),'будущее обрезано серверными часами');
  await mod.hideFrequentConversations('a',[{conversationId:'clock',at:new Date(now.getTime()-86400000)}]);
  assert.equal(await stored(),now.getTime(),'ранняя отметка не отменяет позднюю');
}
test('R126 будущий at режется до now, прежняя поздняя отметка переживает старый перенос', async()=>{
  // Ловит бесконечное скрытие из-за неверных часов и откат отметки старым устройством.
  await verifyHideClock();
});
test('R126 повтор id учитывается один раз, сейчас сильнее даты в обоих порядках',async()=>{
  // Ловит зависимость отметки от порядка дублей миграционного пакета.
  const now=new Date((await t.raw.query<{at:Date}>('SELECT now() AS at')).rows[0].at);
  const old=new Date(now.getTime()-86400000).toISOString();
  for(const id of ['first','last']) await conversation(id);
  const result=await hide([{conversationId:'first'},{conversationId:'first',at:old},{conversationId:'last',at:old},{conversationId:'last'}]);
  assert.equal(result.statusCode,200);assert.equal(result.json().hidden,2);
  const rows=(await t.raw.query<{at:Date}>(`SELECT frequent_hidden_at AS at FROM conversation_members WHERE user_id='a'`)).rows;
  assert.ok(rows.every(row=>new Date(row.at).getTime()===now.getTime()));
});
test('R126 чужая, покинутая и неизвестная беседы дают hidden ноль без записи чужой отметки',async()=>{
  // Ловит запись скрытия вне действующего членства.
  await conversation('left');await conversation('foreign');
  await t.raw.exec(`UPDATE conversation_members SET left_at=now() WHERE conversation_id='left' AND user_id='a'; DELETE FROM conversation_members WHERE conversation_id='foreign' AND user_id='a'`);
  const result=await hide([{conversationId:'left'},{conversationId:'foreign'},{conversationId:'missing'}]);
  assert.equal(result.statusCode,200);assert.deepEqual(result.json(),{hidden:0});
  assert.ok((await t.raw.query<{at:Date|null}>(`SELECT frequent_hidden_at AS at FROM conversation_members`)).rows.every(row=>row.at===null));
});
test('R126 пустой items и неверный at дают 400, ISO с часовым смещением принимается',async()=>{
  // Ловит тихий успех пустой миграции и отказ корректному ISO не в UTC.
  await conversation('valid');
  for(const items of [[],[{conversationId:'valid',at:'not-a-date'}],[{conversationId:'valid',at:'2026-01-01'}]]) assert.equal((await hide(items)).statusCode,400);
  assert.equal((await hide([{conversationId:'valid',at:'2026-01-01T12:00:00+03:00'}])).statusCode,200);
});
test('R126 SQL-мутанты HAVING, LEAST, GREATEST и left_at отвергаются настоящей базой',async()=>{
  // Ловит удаление каждого независимого ограничения, а не копию SQL в тесте.
  const reset=async()=>{await t.raw.exec('ROLLBACK');await truncateAll(t.raw);await t.raw.exec(`BEGIN; INSERT INTO users(id,username,display_name,password_hash) VALUES ('a','alpha','Alpha','hash'),('b','bravo','Bravo','hash')`);};
  for(const [from,to,verify] of [
    ['HAVING m.frequent_hidden_at IS NULL OR MAX(x.created_at) > m.frequent_hidden_at','HAVING TRUE',async(mod:typeof conv)=>{await conversation('h');await message('h','h',1);await mod.hideFrequentConversations('a',[{conversationId:'h'}]);assert.equal((await mod.frequentConversations('a',30)).items.length,0);}],
    ['LEAST(COALESCE(v.at, now()), now())','COALESCE(v.at, now())',verifyHideClock],
    ['GREATEST(m.frequent_hidden_at, LEAST(COALESCE(v.at, now()), now()))','LEAST(COALESCE(v.at, now()), now())',verifyHideClock],
    ['WHERE m.conversation_id = v.id AND m.user_id = ${me} AND m.left_at IS NULL','WHERE m.conversation_id = v.id AND m.user_id = ${me}',async(mod:typeof conv)=>{await conversation('l');await t.raw.exec(`UPDATE conversation_members SET left_at=now() WHERE conversation_id='l' AND user_id='a'`);assert.equal(await mod.hideFrequentConversations('a',[{conversationId:'l'}]),0);}]
  ] as const){
    await reset();await verify(await sourceModule<typeof conv>('../src/conversations.ts'));
    await reset();const mutant=await sourceModule<typeof conv>('../src/conversations.ts',from,to);
    await assert.rejects(()=>verify(mutant),assert.AssertionError,from);
  }
});
