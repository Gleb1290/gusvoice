import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import ts from 'typescript';
import { ZodError } from 'zod';
import { DM_FOLDER_PINNED_MAX } from '@gusvoice/shared';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t:TestDb;
let app:ReturnType<typeof Fastify>;
let redis:typeof import('../src/realtime.js').redisPub;
let tokenFor:(id:string)=>string;
let routeDb:TestDb['db'];
const published:{channel:string;message:string}[]=[];
const headers=(user='a')=>({authorization:`Bearer ${tokenFor(user)}`});
function errors(target:ReturnType<typeof Fastify>){target.setErrorHandler((error:FastifyError,_req:FastifyRequest,reply:FastifyReply)=>error instanceof ZodError?reply.code(400).send({error:'validation'}):reply.send(error));}
const transfer=(folders:unknown,target=app)=>target.inject({method:'POST',url:'/dm-folders/pinned-own',headers:headers(),payload:{folders}});
const pin=(id:string,convId:string,pinned=true,target=app)=>target.inject({method:'PUT',url:`/dm-folders/${id}/pinned/${convId}`,headers:headers(),payload:{pinned}});
const order=(ids:string[],target=app)=>target.inject({method:'PUT',url:'/dm-folders/own/pinned-order',headers:headers(),payload:{ids}});
type FolderRow={id:string;pinned_own:boolean;pinned_ids:string[];include_ids:string[];exclude_ids:string[];updated_at:Date};
const row=async(id='own')=>(await t.raw.query<FolderRow>(`SELECT id,pinned_own,pinned_ids,include_ids,exclude_ids,updated_at FROM dm_folders WHERE id=$1`,[id])).rows[0];
const series=(n:number)=>Array.from({length:n},(_,i)=>`p${i+1}`);
function verifyEvent(response:{json():{folders:unknown[]}}){
  const events=published.filter(e=>JSON.parse(e.message).m?.t==='dmFolders.update');assert.equal(events.length,1);assert.equal(events[0].channel,'gw:user:a');assert.deepEqual(JSON.parse(events[0].message).m.folders,response.json().folders);
}
before(async()=>{
  t=await createTestDb();const auth=await import('../src/auth.js');tokenFor=id=>auth.signToken({sub:id,username:id,gen:0});
  /* PGlite имеет одно соединение: внешний db.select из ownChats внутри callback transaction иначе ждёт себя.
     Только в этом файле select направляется в текущий tx. Членство в сценариях неизменно во время запроса;
     поведение пула и настоящую конкурентность этим адаптером НЕ проверяем. Общий harness и приложение не меняются. */
  let active:TestDb['db']|null=null;
  routeDb=new Proxy(t.db,{get(target,key){
    if(key==='transaction')return async(callback:(tx:unknown)=>Promise<unknown>)=>target.transaction(async tx=>{active=tx as unknown as TestDb['db'];try{return await callback(tx);}finally{active=null;}});
    const selected=key==='select'&&active?active:target;const value=Reflect.get(selected,key);return typeof value==='function'?value.bind(selected):value;
  }});
  redis=(await import('../src/realtime.js')).redisPub;redis.incr=(async()=>1) as typeof redis.incr;redis.expire=(async()=>1) as typeof redis.expire;
  redis.publish=(async(channel:string,message:string)=>{published.push({channel,message});return 1;}) as typeof redis.publish;
  app=Fastify();errors(app);await app.register((await sourceModule<typeof import('../src/routes/dmFolders.js')>('../src/routes/dmFolders.ts')).dmFolderRoutes);await app.register((await import('../src/routes/conv.js')).convRoutes);await app.ready();
});
async function seed(){
  await truncateAll(t.raw);published.length=0;
  await t.raw.exec(`INSERT INTO users(id,username,display_name,password_hash) VALUES ('a','alpha','Alpha','hash'),('b','bravo','Bravo','hash'),('c','charlie','Charlie','hash');
    INSERT INTO conversations(id,kind,created_by) SELECT id,'group','a' FROM unnest(ARRAY['one','two','three','loose','left','foreign'])id;
    INSERT INTO conversation_members(conversation_id,user_id,pinned_at) SELECT id,'a',CASE WHEN id IN ('one','two','three','left') THEN now() ELSE NULL END FROM unnest(ARRAY['one','two','three','loose','left'])id;
    INSERT INTO conversation_members(conversation_id,user_id,pinned_at) VALUES ('foreign','b',now()),('foreign','c',NULL);
    UPDATE conversation_members SET left_at=now() WHERE conversation_id='left';
    INSERT INTO conversations(id,kind,created_by) SELECT 'p'||n,'group','a' FROM generate_series(1,101)n;
    INSERT INTO conversation_members(conversation_id,user_id) SELECT 'p'||n,'a' FROM generate_series(1,101)n;
    INSERT INTO dm_folders(id,user_id,title,flags,pinned_ids,pinned_own) VALUES
      ('legacy','a','Старая',1,ARRAY['two','one'],false),('legacy-two','a','Старая 2',1,ARRAY['one','loose'],false),
      ('own','a','Своя',1,ARRAY['one','two','three'],true),('own-two','a','Своя 2',1,ARRAY['one'],true),
      ('foreign-folder','b','Чужая',1,ARRAY['one'],false),('system','a','',1,ARRAY[]::text[],false);
    UPDATE dm_folders SET system='dms' WHERE id='system'`);
}
beforeEach(seed);
after(async()=>{await app.close();redis.disconnect();await t.close();});

test('R129 перевод берёт мои общие закрепы, удаляет дубли, чужие, незакреплённые и покинутые',async()=>{
  // Ловит создание новых закрепов при переносе и сохранение чужого членства.
  const response=await transfer([{id:'legacy',ids:['two','one','two','loose','left','foreign','missing']}]);assert.equal(response.statusCode,200,response.body);
  assert.equal((await row('legacy')).pinned_own,true);assert.deepEqual((await row('legacy')).pinned_ids,['two','one']);verifyEvent(response);
  const dto=response.json().folders.find((f:{id:string})=>f.id==='legacy');assert.equal(dto.pinnedOwn,true);assert.deepEqual(dto.pinned,['two','one']);
});
test('R129 повтор перевода не перетирает свой набор; системная, чужая и неизвестная папки пропускаются',async()=>{
  // Ловит запоздавший перенос со второго устройства поверх нового собственного набора.
  const ids=['system','foreign-folder','own','missing'];const before=await Promise.all(ids.slice(0,3).map(id=>row(id)));
  const first=await transfer([{id:'legacy',ids:['one']},...ids.map(id=>({id,ids:['two']}))]);assert.equal(first.statusCode,200,first.body);
  const after=await row('legacy');const repeat=await transfer([{id:'legacy',ids:['three']}]);assert.equal(repeat.statusCode,200);assert.deepEqual(await row('legacy'),after);
  assert.deepEqual(await Promise.all(ids.slice(0,3).map(id=>row(id))),before);
});
test('R129 перевод принимает сто id, сто один отвергает целиком без изменения набора',async()=>{
  // Ловит несовпадение валидатора переноса с пределом набора.
  assert.equal(DM_FOLDER_PINNED_MAX,100);
  await t.raw.exec(`UPDATE conversation_members SET pinned_at=now() WHERE conversation_id LIKE 'p%'`);
  const over=await transfer([{id:'legacy',ids:series(101)}]);assert.equal(over.statusCode,400);assert.equal((await row('legacy')).pinned_own,false);
  const accepted=await transfer([{id:'legacy',ids:series(100)}]);assert.equal(accepted.statusCode,200,accepted.body);assert.deepEqual((await row('legacy')).pinned_ids,series(100));
});
test('R129 pin возвращает mode 409, system 400 и 404 для чужой папки, беседы и покинутого',async()=>{
  // Ловит ошибку области закрепа и незаметное изменение чужой папки.
  const original=await row();
  const mode=await pin('legacy','one');assert.equal(mode.statusCode,409);assert.equal(mode.json().reason,'folders.pin_mode');
  const system=await pin('system','one');assert.equal(system.statusCode,400);assert.equal(system.json().reason,'folders.system');
  for(const [folder,chat] of [['foreign-folder','one'],['missing','one'],['own','foreign'],['own','left'],['own','missing']])assert.equal((await pin(folder,chat)).statusCode,404);
  assert.deepEqual(await row(),original);assert.equal(published.length,0);
});
test('R129 новый закреп сверху снимает исключение, чистит мёртвые id, повтор не дублирует и общий закреп не меняется',async()=>{
  // Ловит невидимый закреп из-за exclude и расходование мест покинутыми беседами.
  await t.raw.exec(`UPDATE dm_folders SET pinned_ids=ARRAY['one','left','foreign'],exclude_ids=ARRAY['loose','two'] WHERE id='own'`);
  const stamps=(await t.raw.query(`SELECT conversation_id,pinned_at FROM conversation_members WHERE user_id='a' ORDER BY conversation_id`)).rows;
  const accepted=await pin('own','loose');assert.equal(accepted.statusCode,200,accepted.body);assert.deepEqual((await row()).pinned_ids,['loose','one']);assert.deepEqual((await row()).exclude_ids,['two']);verifyEvent(accepted);
  const saved=await row();await pin('own','loose');assert.deepEqual(await row(),saved,'повтор не пишет даже updated_at');
  const removed=await pin('own','loose',false);assert.equal(removed.statusCode,200);assert.deepEqual((await row()).pinned_ids,['one']);
  assert.deepEqual((await t.raw.query(`SELECT conversation_id,pinned_at FROM conversation_members WHERE user_id='a' ORDER BY conversation_id`)).rows,stamps);
});
async function verifyPinLimit(target=app){
  await t.raw.query(`UPDATE dm_folders SET pinned_ids=$1::text[] WHERE id='own'`,[series(99)]);
  const last=await pin('own','p100',true,target);assert.equal(last.statusCode,200,last.body);assert.equal((await row()).pinned_ids.length,100);
  const atLimit=await pin('own','p100',true,target);assert.equal(atLimit.statusCode,200,atLimit.body);
  const original=await row();const over=await pin('own','p101',true,target);assert.equal(over.statusCode,409,over.body);assert.equal(over.json().reason,'folders.pin_limit');assert.equal(over.json().max,100);assert.deepEqual(await row(),original);
}
test('R129 сотый закреп проходит, повтор сотого проходит, сто первый даёт pin_limit и max без записи',async()=>{
  // Ловит ошибку на единицу и отказ идемпотентному закрепу на полном наборе.
  await verifyPinLimit();
});
test('R129 полный порядок переставляет набор, частичный меняет только названные слоты, мусор не добавляется',async()=>{
  // Ловит исчезновение неназванных закрепов при старом клиенте и добавление чужих в набор.
  const partial=await order(['three','one','three','loose','foreign']);assert.equal(partial.statusCode,200,partial.body);assert.deepEqual((await row()).pinned_ids,['three','two','one']);verifyEvent(partial);
  const full=await order(['two','one','three']);assert.equal(full.statusCode,200);assert.deepEqual((await row()).pinned_ids,['two','one','three']);
  await order([]);assert.deepEqual((await row()).pinned_ids,['two','one','three']);
});
test('R129 правка своей папки снимает исключённые и убранные include, старая папка сохраняет pinned_ids',async()=>{
  // Ловит потерю старого pinorder2 и оставшийся закреп после «Убрать из папки».
  await t.raw.exec(`UPDATE dm_folders SET include_ids=ARRAY['one','two'],pinned_ids=ARRAY['one','two','three'] WHERE id IN ('own','legacy')`);
  for(const id of ['own','legacy']){const result=await app.inject({method:'PUT',url:`/dm-folders/${id}`,headers:headers(),payload:{title:'Правка',flags:1,include:['two'],exclude:['three']}});assert.equal(result.statusCode,200,result.body);}
  assert.deepEqual((await row()).pinned_ids,['two']);assert.deepEqual((await row('legacy')).pinned_ids,['one','two','three']);assert.equal((await row()).pinned_own,true);
});
test('R129 новая папка с pinnedOwn имеет пустой свой набор, прежнее тело создаёт прежний режим',async()=>{
  // Ловит потерю режима на создании и принудительный перевод старого клиента.
  for(const own of [true,false]){published.length=0;const result=await app.inject({method:'POST',url:'/dm-folders',headers:headers(),payload:{title:'Новая',flags:1,include:[],exclude:[],...(own?{pinnedOwn:true}:{})}});assert.equal(result.statusCode,200,result.body);const saved=await row(result.json().id);assert.equal(saved.pinned_own,own);assert.deepEqual(saved.pinned_ids,[]);const dto=result.json().folders.find((f:{id:string})=>f.id===saved.id);assert.equal(dto.pinnedOwn,own?true:undefined);assert.equal(Object.hasOwn(dto,'pinned'),false);verifyEvent(result);}
});
test('R129 общий откреп и повторный закреп сохраняют own-наборы, но очищают legacy всех моих папок',async()=>{
  // Ловит обратное влияние общего закрепа на независимый набор папки.
  for(const pinned of [false,true]){
    await t.raw.exec(`UPDATE dm_folders SET pinned_ids=ARRAY['one','two'] WHERE user_id='a' AND system IS NULL`);published.length=0;
    const result=await app.inject({method:'PUT',url:'/conv/one/pinned',headers:headers(),payload:{pinned}});assert.equal(result.statusCode,200,result.body);
    for(const id of ['own','own-two'])assert.deepEqual((await row(id)).pinned_ids,['one','two']);
    for(const id of ['legacy','legacy-two'])assert.deepEqual((await row(id)).pinned_ids,['two']);
    assert.deepEqual((await row('foreign-folder')).pinned_ids,['one']);assert.equal(published.filter(e=>JSON.parse(e.message).m?.t==='dmFolders.update').length,1);
  }
});

// Исполняются целые модули с их настоящими зависимостями; извлечённые куски исходника не eval-ятся.
async function sourceModule<T>(relative:string,from?:string,to?:string):Promise<T>{
  const url=new URL(relative,import.meta.url);let source=readFileSync(url,'utf8').replace(/\r\n/g,'\n');if(from){assert.ok(source.includes(from),from);source=source.replace(from,to!);}
  const parsed=ts.createSourceFile(url.pathname,source,ts.ScriptTarget.Latest,true);const imports:Record<string,unknown>={};
  for(const decl of parsed.statements){if(!ts.isImportDeclaration(decl)||!ts.isStringLiteral(decl.moduleSpecifier)||decl.importClause?.isTypeOnly)continue;const spec=decl.moduleSpecifier.text;const dependency=await import(spec.startsWith('.')?new URL(spec,url).href:spec);imports[spec]=relative.endsWith('dmFolders.ts')&&spec==='../db/index.js'?{...dependency,db:routeDb}:dependency;}
  const module={exports:{}};runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,Date,Map,Set,Buffer,URL,Promise,console,fetch:globalThis.fetch,require:(spec:string)=>{assert.ok(spec in imports);return imports[spec];}});return module.exports as T;
}
test('R129 мутанты одноразового перевода, фильтра общих, предела и NOT pinned_own отвергаются реальной базой',async()=>{
  // Каждый контрфакт нарушает отдельный контракт; исключение ожидается только после зелёного оригинала.
  type Routes=typeof import('../src/routes/dmFolders.js');
  for(const [from,to,verify] of [
    [', eq(dmFolders.pinnedOwn, false)','',async(target:ReturnType<typeof Fastify>)=>{await transfer([{id:'legacy',ids:['one']}],target);const saved=await row('legacy');await transfer([{id:'legacy',ids:['two']}],target);assert.deepEqual(await row('legacy'),saved);}],
    ['const pinned = await pinnedChats(me, folders.flatMap((f) => f.ids));','const pinned = await ownChats(me, folders.flatMap((f) => f.ids));',async(target:ReturnType<typeof Fastify>)=>{const response=await transfer([{id:'legacy',ids:['loose','one']}],target);assert.equal(response.statusCode,200);assert.deepEqual((await row('legacy')).pinned_ids,['one']);}],
    ['set.length >= DM_FOLDER_PINNED_MAX','set.length > DM_FOLDER_PINNED_MAX',verifyPinLimit]
  ] as const){await seed();await verify(app);await seed();const target=Fastify();errors(target);const mutant=await sourceModule<Routes>('../src/routes/dmFolders.ts',from,to);await target.register(mutant.dmFolderRoutes);await target.ready();try{await assert.rejects(()=>verify(target),assert.AssertionError,from);}finally{await target.close();}}
  type Conv=typeof import('../src/conversations.js');const actual=await import('../src/conversations.js');
  const verify=async(mod:Conv)=>{await seed();const access=await actual.loadAccess('one','a');assert.ok(access);const result=await mod.setConversationPinned('a',access,false);assert.equal(result.kind,'ok');assert.deepEqual((await row()).pinned_ids,['one','two','three']);assert.deepEqual((await row('legacy')).pinned_ids,['two']);};
  await verify(actual);const mutant=await sourceModule<Conv>('../src/conversations.ts','AND NOT pinned_own AND','AND');await assert.rejects(()=>verify(mutant),assert.AssertionError);
});
