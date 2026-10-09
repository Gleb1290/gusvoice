import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { before, beforeEach, after, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify from 'fastify';
import ts from 'typescript';
import { BIGFILE_PART_BYTES, DM_DAILY_UPLOAD_BYTES } from '../src/attachmentRules.js';
import { createUploadGate } from '../src/uploadGate.js';
import type { AttachmentStore } from '../src/attachments.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

process.env.PUBLIC_API_URL='https://api.example.test';
let t:TestDb;
let big:typeof import('../src/bigUploads.js');
let att:typeof import('../src/attachments.js');
let redis:typeof import('../src/realtime.js').redisPub;
let token:string;
const objects=new Map<string,number>();
const sizes=new Map<string,number>();
const removed:string[]=[];
let completeCalls=0;
let n=0;
let onComplete:()=>Promise<void>=async()=>{};
let onPart:()=>Promise<void>=async()=>{};
let fail=false;
let lost=false;
const store:AttachmentStore={ready:()=>true,configured:()=>true,ensureReady:async()=>true,
  put:async(k,b)=>{objects.set(k,b.length);},stat:async(k)=>objects.has(k)?{size:objects.get(k)!}:null,get:async()=>Readable.from([]),
  remove:async(k)=>{objects.delete(k);removed.push(k);},copy:async(_from,to)=>{objects.set(to,1);},
  multipart:{create:async()=>`s3-${++n}`,part:async(_k,id,_p,b)=>{await onPart();sizes.set(id,(sizes.get(id)??0)+b.length);return 'etag';},
    complete:async(k,id)=>{completeCalls++;await onComplete();if(fail){fail=false;throw new Error('storage boom');}objects.set(k,sizes.get(id)??0);if(lost){lost=false;throw new Error('lost response');}},abort:async()=>{},list:async()=>[]},
};
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
async function until(fn:()=>boolean){const limit=Date.now()+10000;while(!fn()){assert.ok(Date.now()<limit,'барьер достигнут без таймаута');await new Promise<void>(r=>setImmediate(r));}}
before(async()=>{t=await createTestDb();att=await import('../src/attachments.js');big=await import('../src/bigUploads.js');redis=(await import('../src/realtime.js')).redisPub;redis.incr=(async()=>1) as typeof redis.incr;redis.expire=(async()=>1) as typeof redis.expire;redis.publish=(async()=>1) as typeof redis.publish;token=(await import('../src/auth.js')).signToken({sub:'a',username:'a',gen:0});});
async function seed(){await truncateAll(t.raw);objects.clear();sizes.clear();removed.length=0;completeCalls=0;n=0;onComplete=async()=>{};onPart=async()=>{};fail=false;lost=false;att.setAttachmentStoreForTests(store);
  await t.raw.exec(`INSERT INTO users(id,username,display_name,password_hash) VALUES ('a','alpha','Alpha','hash'),('b','bravo','Bravo','hash'),('c','charlie','Charlie','hash');
    INSERT INTO conversations(id,kind,created_by) VALUES ('group','group','a');INSERT INTO conversation_members(conversation_id,user_id,role) VALUES ('group','a','owner'),('group','b','member'),('group','c','member')`);
}
beforeEach(seed);after(async()=>{att.setAttachmentStoreForTests(null);redis.disconnect();await t.close();});
async function full(owner='a',mod=big){const started=await mod.startUpload({ownerId:owner,conversationId:'group',name:'f',declaredType:'application/octet-stream',size:3});assert.ok('id' in started);const id=started.id;assert.ok(!('code' in await mod.uploadPart({ownerId:owner,conversationId:'group',uploadId:id,n:1,bytes:Buffer.from('abc')})));return id;}
const count=async(table:string,id:string)=>(await t.raw.query<{n:number}>(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`,[id])).rows[0].n;

async function verifyClaim(mod=big){const id=await full();const hold=deferred();onComplete=()=>hold.promise;const first=mod.completeUpload('a','group',id);await until(()=>completeCalls===1);
  try{const second=await mod.completeUpload('a','group',id);assert.ok('code' in second);assert.equal(second.code,202);assert.equal(second.assembling,true);assert.equal(await count('attachments',id),0);}finally{hold.resolve();}
  const result=await first;assert.ok('id' in result);assert.equal(result.id,id);assert.equal(completeCalls,1);assert.equal(await count('attachments',id),1);assert.equal(await count('attachment_uploads',id),0);
}
test('R131 T1 двойная сборка даёт один файл и 202, вложение появляется только после хранилища',async()=>{
  // Синхронизация на входе mp.complete делает перекрытие воспроизводимым без задержек часов.
  await verifyClaim();
});
test('R131 T2 до конца сборки отправка запрещена и кусок даёт 409; сбой снимает метку, повтор собирает',async()=>{
  // Ловит отправку незаконченного объекта и навсегда занятый забор после ошибки.
  const id=await full();const hold=deferred();onComplete=()=>hold.promise;fail=true;const result=big.completeUpload('a','group',id).then(v=>({value:v}),error=>({error}));await until(()=>completeCalls===1);
  try{assert.equal(await count('attachments',id),0);const access=await (await import('../src/conversations.js')).loadAccess('group','a');assert.ok(access);const send=await (await import('../src/conversations.js')).sendMessage('a',access,{content:'',attachments:[{id}],clientId:null,replyToId:null,withheld:false});assert.equal(send.kind,'bad-attachments');const part=await big.uploadPart({ownerId:'a',conversationId:'group',uploadId:id,n:1,bytes:Buffer.from('abc')});assert.ok('code' in part);assert.equal(part.code,409);}finally{hold.resolve();}
  assert.ok('error' in await result);assert.equal((await t.raw.query<{completing_at:Date|null}>(`SELECT completing_at FROM attachment_uploads WHERE id=$1`,[id])).rows[0].completing_at,null);onComplete=async()=>{};assert.ok('id' in await big.completeUpload('a','group',id));
});
test('R131 T2b потерянный ответ готового S3 доводит вложение, T2c после отправки повтор не трогает attached',async()=>{
  // Ловит удаление реально собранного объекта из-за ошибки ответа и повторную привязку отправленного.
  const id=await full();lost=true;const done=await big.completeUpload('a','group',id);assert.ok('id' in done);assert.equal(done.id,id);
  const conv=await import('../src/conversations.js');const access=await conv.loadAccess('group','a');assert.ok(access);
  const sent=await conv.sendMessage('a',access,{content:'',attachments:[{id}],clientId:null,replyToId:null,withheld:false});assert.equal(sent.kind,'created');assert.ok(sent.kind==='created');
  const saved=async()=>(await t.raw.query<{state:string;message_id:string}>(`SELECT state,message_id FROM attachments WHERE id=$1`,[id])).rows[0];
  assert.deepEqual(await saved(),{state:'attached',message_id:sent.row.id});
  const again=await big.completeUpload('a','group',id);assert.ok('code' in again);assert.equal(again.code,404);assert.deepEqual(await saved(),{state:'attached',message_id:sent.row.id});
});
async function verifyLeft(mod=big){const id=await full('b');await t.raw.exec(`UPDATE conversation_members SET left_at=now() WHERE user_id='b'`);const part=await mod.uploadPart({ownerId:'b',conversationId:'group',uploadId:id,n:1,bytes:Buffer.from('abc')});assert.ok('code' in part);assert.equal(part.code,404);assert.equal(await mod.uploadStatus('b','group',id),null);const complete=await mod.completeUpload('b','group',id);assert.ok('code' in complete);assert.equal(complete.code,404);}
test('R131 T3 вышедший не дописывает, не видит статус и не собирает сохранённую строку загрузки',async()=>{
  // FK не срабатывает на left_at: право должно проверяться каждым обращением.
  await verifyLeft();
});
async function verifyDrop(mod:typeof import('../src/convGroups.js')){const id=await full('c');const result=await mod.removeGroupMember('c','group','c');assert.equal(result.kind,'ok');assert.equal(await count('attachment_uploads',id),0);}
test('R131 T6 выход через removeGroupMember стирает загрузку, хотя строка членства остаётся',async()=>{
  // Ловит надежду на каскад FK там, где вместо DELETE записывается left_at.
  await verifyDrop(await import('../src/convGroups.js'));
});
test('R131 T5 двадцать одновременных стартов принимают двенадцать, остальные дают 429',async()=>{
  // Promise.all реально перекрывает операции, но PGlite сериализует транзакции одного соединения.
  const results=await Promise.all(Array.from({length:20},()=>big.startUpload({ownerId:'a',conversationId:'group',name:'f',declaredType:'application/octet-stream',size:512*1024*1024})));
  assert.equal(results.filter(r=>'id' in r).length,12);assert.equal(results.filter(r=>'code' in r&&r.code===429).length,8);assert.equal((await t.raw.query('SELECT * FROM attachment_uploads')).rows.length,12);
});
async function copySource(){await t.raw.exec(`INSERT INTO attachments(id,conversation_id,owner_id,storage_key,name,content_type,size,state,created_at) VALUES ('src','group','b','dm/src','f','application/octet-stream',1073741824,'attached',now()-interval '2 days')`);return (await t.db.select().from((await import('../src/db/schema.js')).attachments))[0];}
async function verifyForward(mod=att){const src=await copySource();const results=await Promise.allSettled(Array.from({length:10},()=>mod.copyForForward({ownerId:'a',conversationId:'group',sources:[src]})));assert.equal(results.filter(r=>r.status==='fulfilled').length,8);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.statusCode===429).length,2);}
test('R131 T7 десять параллельных пересылок по гигабайту дают восемь копий и два суточных отказа',async()=>{
  // Ловит обход объёмной квоты копированием вместо загрузки без выделения 10 ГиБ RAM.
  await verifyForward();
});
test('R131 T8 три одиночных по 20 МиБ при остатке 30 МиБ принимают ровно один файл',async()=>{
  // Проверяется новая атомарная квота createPending, а не внешнее чтение перед вставкой.
  await t.raw.query(`INSERT INTO attachments(id,conversation_id,owner_id,storage_key,name,content_type,size,state) VALUES ('filler','group','a','dm/filler','f','application/octet-stream',$1,'deleted')`,[DM_DAILY_UPLOAD_BYTES-30*1024*1024]);
  const bytes=Buffer.alloc(20*1024*1024);const results=await Promise.allSettled(Array.from({length:3},()=>att.createPending({ownerId:'a',conversationId:'group',name:'f',contentType:'application/octet-stream',bytes,daily:true})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.statusCode===429).length,2);
});
async function verifyActivity(mod=big){await t.raw.exec(`INSERT INTO attachment_uploads(id,conversation_id,owner_id,storage_key,s3_upload_id,name,declared_type,size,part_size,created_at,last_part_at,completing_at) VALUES
  ('active-part','group','a','dm/part','s-part','f','application/octet-stream',3,8388608,now()-interval '30 hours',now()-interval '1 hour',NULL),
  ('active-claim','group','a','dm/claim','s-claim','f','application/octet-stream',3,8388608,now()-interval '30 hours',NULL,now()-interval '1 hour'),
  ('dead','group','a','dm/dead','s-dead','f','application/octet-stream',3,8388608,now()-interval '30 hours',now()-interval '26 hours',NULL),
  ('dead-claim','group','a','dm/dead-claim','s-dead-claim','f','application/octet-stream',3,8388608,now()-interval '30 hours',now()-interval '29 hours',now()-interval '25 hours')`);
  assert.equal(await mod.purgeStaleUploads(),2);assert.deepEqual((await t.raw.query<{id:string}>(`SELECT id FROM attachment_uploads ORDER BY id`)).rows.map(r=>r.id),['active-claim','active-part']);assert.ok(removed.includes('dm/dead-claim'));
}
test('R131 T9 уборка учитывает последний кусок и текущую сборку, брошенный собранный объект удаляется',async()=>{
  // Создание вчера не означает неактивность сегодня; claim защищает сборку от уборки.
  await verifyActivity();
});

async function moduleOf<T>(relative:string,from?:string,to?:string,overrides:Record<string,unknown>={}):Promise<T>{const url=new URL(relative,import.meta.url);let source=readFileSync(url,'utf8').replace(/\r\n/g,'\n');if(from){assert.ok(source.includes(from),from);source=source.replace(from,to!);}const parsed=ts.createSourceFile(url.pathname,source,ts.ScriptTarget.Latest,true);const imports:Record<string,unknown>={};for(const decl of parsed.statements){if(!ts.isImportDeclaration(decl)||!ts.isStringLiteral(decl.moduleSpecifier)||decl.importClause?.isTypeOnly)continue;const spec=decl.moduleSpecifier.text;imports[spec]=overrides[spec]??await import(spec.startsWith('.')?new URL(spec,url).href:spec);}const module={exports:{}};runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,Date,Map,Set,WeakMap,Buffer,URL,Promise,console,setTimeout,clearTimeout,fetch:globalThis.fetch,require:(spec:string)=>{assert.ok(spec in imports);return imports[spec];}});return module.exports as T;}
test('R131 контрфакты JOIN, уборки, удаления загрузки и dropUploadsOfMember нарушают реальные строки',async()=>{
  // Каждый модуль исполняется целиком, SQL остаётся настоящим; фрагменты исходника не eval-ятся.
  const deletion='const gone = await tx.delete(attachmentUploads).where(eq(attachmentUploads.id, row.id)).returning({ id: attachmentUploads.id });';
  for(const [from,to,verify] of [
    ['isNull(conversationMembers.leftAt),','sql`true`,',verifyLeft],
    ['sql`greatest(${attachmentUploads.createdAt}, ${attachmentUploads.lastPartAt}, ${attachmentUploads.completingAt}) < ${cutoff.toISOString()}::timestamptz`','sql`${attachmentUploads.createdAt} < ${cutoff.toISOString()}::timestamptz`',verifyActivity],
    [deletion,'const gone = [{ id: row.id }];',async(mod:typeof big)=>{const id=await full();assert.ok('id' in await mod.completeUpload('a','group',id));assert.equal(await count('attachment_uploads',id),0);}]
  ] as const){await seed();await verify(big);await seed();const mutant=await moduleOf<typeof big>('../src/bigUploads.ts',from,to);await assert.rejects(()=>verify(mutant),assert.AssertionError,from);}
  await seed();const groups=await import('../src/convGroups.js');await verifyDrop(groups);await seed();const mutant=await moduleOf<typeof groups>('../src/convGroups.ts','await dropUploadsOfMember(tx, conversationId, targetId);','');await assert.rejects(()=>verifyDrop(mutant),assert.AssertionError);
});
test('R131 мутант без условного забора запускает вторую сборку и ловится барьером S3',async()=>{
  // Завершаем все обещания даже у мутанта, чтобы красная проверка не оставляла зависший тест.
  const from='or(isNull(attachmentUploads.completingAt), lt(attachmentUploads.completingAt, sql`now() - ${`${ASSEMBLY_CLAIM_STALE_MS} milliseconds`}::interval`))';
  const mutant=await moduleOf<typeof big>('../src/bigUploads.ts',from,'sql`true`');
  const id=await full();const hold=deferred();onComplete=()=>hold.promise;
  const first=mutant.completeUpload('a','group',id).catch(e=>e);await until(()=>completeCalls===1);const second=mutant.completeUpload('a','group',id).catch(e=>e);
  try{await until(()=>completeCalls===2);assert.throws(()=>assert.equal(completeCalls,1),assert.AssertionError);}finally{hold.resolve();await Promise.all([first,second]);}
});
test('R131 мутант вставки вложения до complete делает несобранный файл видимым и ловится до отпускания барьера',async()=>{
  // Контрфакт возвращает раннюю вставку старого порядка, ещё до вызова S3.
  const injected='await insertPendingRow({ id: row.id, storageKey: row.storageKey, ownerId, conversationId, name: row.name, contentType: row.declaredType, size: row.size });\n  const claimed = await db';
  const mutant=await moduleOf<typeof big>('../src/bigUploads.ts','const claimed = await db',injected);const id=await full();const hold=deferred();onComplete=()=>hold.promise;const pending=mutant.completeUpload('a','group',id).catch(e=>e);await until(()=>completeCalls===1);
  try{await assert.rejects(async()=>assert.equal(await count('attachments',id),0),assert.AssertionError);}finally{hold.resolve();await pending;}
});
test('R131 мутант пересылки без assertDailyRoom пропускает все десять копий вместо восьми',async()=>{
  // Проверяется квота именно копий, не только числа startUpload.
  const mutant=await moduleOf<typeof att>('../src/attachments.ts','await assertDailyRoom(input.ownerId, total, tx);','');mutant.setAttachmentStoreForTests(store);await assert.rejects(()=>verifyForward(mutant),assert.AssertionError);
});
test('R131 AST-страж держит суточную проверку внутри callback после advisory lock',()=>{
  // Односоединительный PGlite сериализует tx и не способен убить снятие advisory lock в runtime.
  function all<T extends ts.Node>(root:ts.Node,is:(node:ts.Node)=>node is T):T[]{const found:T[]=[];const visit=(node:ts.Node)=>{if(is(node))found.push(node);ts.forEachChild(node,visit);};visit(root);return found;}
  const source=readFileSync(new URL('../src/attachments.ts',import.meta.url),'utf8').replace(/\r\n/g,'\n');const verify=(code:string)=>{const sf=ts.createSourceFile('attachments.ts',code,ts.ScriptTarget.Latest,true);for(const name of ['insertPendingRow','copyForForward']){const fn=sf.statements.find((s):s is ts.FunctionDeclaration=>ts.isFunctionDeclaration(s)&&s.name?.text===name);assert.ok(fn?.body);
    const transactions=all(fn.body,ts.isCallExpression).filter(call=>ts.isPropertyAccessExpression(call.expression)&&call.expression.expression.getText(sf)==='db'&&call.expression.name.text==='transaction');assert.equal(transactions.length,1);
    const callback=transactions[0].arguments[0];assert.ok(callback&&ts.isArrowFunction(callback));
    const locks=all(callback.body,ts.isTaggedTemplateExpression).filter(node=>node.getText(sf).includes('pg_advisory_xact_lock'));assert.equal(locks.length,1,`${name}: замок в callback`);
    const quotas=all(callback.body,ts.isCallExpression).filter(call=>ts.isIdentifier(call.expression)&&call.expression.text==='assertDailyRoom');assert.equal(quotas.length,1,`${name}: суточная проверка в callback`);assert.ok(locks[0].pos<quotas[0].pos,`${name}: замок до проверки`);assert.equal(quotas[0].arguments[2]?.getText(sf),'tx');
  }};
  verify(source);const from='await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`att-pending:${input.ownerId}`}))`);';assert.ok(source.includes(from));assert.throws(()=>verify(source.replaceAll(from,'')),assert.AssertionError);
});

async function routeApp(mutant=false){const gate=createUploadGate();let readBytes=0;let beforeParse=0;const mod=await moduleOf<typeof import('../src/routes/uploads.js')>('../src/routes/uploads.ts',mutant?'onRequest: admitPart':undefined,'preValidation: admitPart',{'../uploadGate.js':{uploadGate:gate}});const target=Fastify();await target.register(async scope=>{await mod.uploadRoutes(scope);scope.addHook('preParsing',async(_req,_reply,payload)=>{beforeParse++;return payload;});scope.removeContentTypeParser('application/octet-stream');scope.addContentTypeParser('application/octet-stream',{parseAs:'buffer'},(_req,bytes,done)=>{readBytes+=(bytes as Buffer).length;done(null,bytes);});});await target.ready();return {target,gate,reads:()=>({readBytes,beforeParse})};}
const routeHeaders={'authorization':`Bearer placeholder`,'content-type':'application/octet-stream'};
async function verifyBeforeRead(mutant=false){const {target,reads}=await routeApp(mutant);const id=await full();try{const response=await target.inject({method:'PUT',url:`/conv/group/uploads/${id}/parts/1`,headers:{...routeHeaders,authorization:`Bearer ${token}`,'content-length':'2'},payload:Buffer.from('ab')});assert.equal(response.statusCode,400,response.body);assert.equal(reads().readBytes,0);assert.equal(reads().beforeParse,0);}finally{await target.close();}}
test('R131 PUT неправильного Content-Length отвергается до preParsing и чтения, preValidation-мутант читает тело',async()=>{
  // Счётчик настоящего content-type parser отличает ранний отказ от такого же HTTP-кода после буферизации.
  await verifyBeforeRead();await assert.rejects(()=>verifyBeforeRead(true),assert.AssertionError);
});
test('R131 PUT без длины даёт 411, неверный тип 415, случайный id 404 без прочитанных байт',async()=>{
  // Защищаем память и от отсутствующей длины, и от выдуманного UUID, а не только неверного размера.
  const {target,reads}=await routeApp();const id=await full();try{
    const base={...routeHeaders,authorization:`Bearer ${token}`};
    const noLength=await target.inject({method:'PUT',url:`/conv/group/uploads/${id}/parts/1`,headers:base,payload:Readable.from([Buffer.from('abc')])});assert.equal(noLength.statusCode,411,noLength.body);
    const type=await target.inject({method:'PUT',url:`/conv/group/uploads/${id}/parts/1`,headers:{...base,'content-type':'text/plain'},payload:'abc'});assert.equal(type.statusCode,415,type.body);
    const random=await target.inject({method:'PUT',url:'/conv/group/uploads/95000000-0000-4000-8000-000000000001/parts/1',headers:{...base,'content-length':'3'},payload:Buffer.from('abc')});assert.equal(random.statusCode,404,random.body);assert.equal(reads().readBytes,0);assert.equal(reads().beforeParse,0);
  }finally{await target.close();}
});
test('R131 пятый одновременный PUT получает 429 с Retry-After, четыре удерживаются записью и освобождаются',async()=>{
  // Перекрытие создаётся задержкой S3, не sleep; отказы не доходят до разборщика тела.
  const {target,gate,reads}=await routeApp();const ids=await Promise.all(Array.from({length:5},()=>full()));const hold=deferred();onPart=()=>hold.promise;let finished=0;
  const requests=ids.map(id=>target.inject({method:'PUT',url:`/conv/group/uploads/${id}/parts/1`,headers:{...routeHeaders,authorization:`Bearer ${token}`,'content-length':'3'},payload:Buffer.from('abc')}).then(response=>{finished++;return response;}));
  try{await until(()=>finished===1&&gate.usage('a').mine===4&&reads().readBytes===12);assert.equal(reads().readBytes,12);}finally{hold.resolve();}
  const results=await Promise.all(requests);assert.equal(results.filter(r=>r.statusCode===200).length,4);const denied=results.find(r=>r.statusCode===429);assert.ok(denied);assert.ok(Number(denied.headers['retry-after'])>0);await until(()=>gate.usage('a').mine===0);
});
test('R131 ручка complete во время сборки отвечает 202 assembling и Retry-After',async()=>{
  // Клиент должен отличать занятость от завершённого DTO и знать задержку опроса.
  const {target}=await routeApp();const id=await full();const hold=deferred();onComplete=()=>hold.promise;const first=big.completeUpload('a','group',id);await until(()=>completeCalls===1);
  try{const response=await target.inject({method:'POST',url:`/conv/group/uploads/${id}/complete`,headers:{authorization:`Bearer ${token}`}});assert.equal(response.statusCode,202,response.body);assert.equal(response.json().assembling,true);assert.ok(Number(response.headers['retry-after'])>0);}finally{hold.resolve();await first;await target.close();}
});
