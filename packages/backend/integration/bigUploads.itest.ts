import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { before, beforeEach, after, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify, { type FastifyError, type FastifyRequest, type FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import ts from 'typescript';
import { ZodError } from 'zod';
import { BIGFILE_PART_BYTES, DM_DAILY_UPLOAD_BYTES, SINGLE_UPLOAD_MAX_BYTES } from '../src/attachmentRules.js';
import type { AttachmentStore } from '../src/attachments.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

process.env.PUBLIC_API_URL='https://api.example.test';
let t:TestDb;
let app:ReturnType<typeof Fastify>;
let redis:typeof import('../src/realtime.js').redisPub;
let setStore:typeof import('../src/attachments.js').setAttachmentStoreForTests;
let tokenFor:(id:string)=>string;
const objects=new Map<string,Buffer>();
const sessions=new Map<string,{key:string;initiated:Date;parts:Map<number,Buffer>}>();
const aborted:string[]=[];
const assembled:string[]=[];
let next=0;
const store:AttachmentStore={
  ready:()=>true,ensureReady:async()=>true,configured:()=>true,
  put:async(key,bytes)=>{objects.set(key,Buffer.from(bytes));},stat:async(key)=>objects.has(key)?{size:objects.get(key)!.length}:null,
  get:async(key)=>Readable.from([objects.get(key)??Buffer.alloc(0)]),remove:async(key)=>{objects.delete(key);},copy:async(from,to)=>{objects.set(to,objects.get(from)!);},
  multipart:{
    create:async(key)=>{const id=`multipart-${++next}`;sessions.set(id,{key,initiated:new Date(),parts:new Map()});return id;},
    part:async(_key,id,n,bytes)=>{assert.ok(sessions.has(id));sessions.get(id)!.parts.set(n,Buffer.from(bytes));return `etag-${n}-${bytes.length}`;},
    complete:async(key,id,parts)=>{const session=sessions.get(id)!;objects.set(key,Buffer.concat(parts.map(p=>session.parts.get(p.part)??Buffer.alloc(0))));assembled.push(id);sessions.delete(id);},
    abort:async(_key,id)=>{aborted.push(id);sessions.delete(id);},
    list:async(prefix)=>[...sessions].filter(([,s])=>s.key.startsWith(prefix)).map(([uploadId,s])=>({key:s.key,uploadId,initiated:s.initiated})),
  },
};
const headers=(user='a')=>({authorization:`Bearer ${tokenFor(user)}`});
const start=(size=3,user='a',cid='dm',target=app)=>target.inject({method:'POST',url:`/conv/${cid}/uploads`,headers:headers(user),payload:{name:'file.bin',type:'application/octet-stream',size}});
const part=(id:string,n:number,bytes:Buffer,user='a',cid='dm',target=app)=>target.inject({method:'PUT',url:`/conv/${cid}/uploads/${id}/parts/${n}`,headers:{...headers(user),'content-type':'application/octet-stream'},payload:bytes});
const complete=(id:string,user='a',cid='dm',target=app)=>target.inject({method:'POST',url:`/conv/${cid}/uploads/${id}/complete`,headers:headers(user)});
const uploadPath=(id:string)=>`/conv/dm/uploads/${id}`;
function errorHandler(target:ReturnType<typeof Fastify>){target.setErrorHandler((error:FastifyError,_req:FastifyRequest,reply:FastifyReply)=>error instanceof ZodError?reply.code(400).send({error:'validation'}):reply.send(error));}
before(async()=>{
  t=await createTestDb();
  const auth=await import('../src/auth.js');tokenFor=id=>auth.signToken({sub:id,username:id,gen:0});
  redis=(await import('../src/realtime.js')).redisPub;
  redis.incr=(async()=>1) as typeof redis.incr;redis.expire=(async()=>1) as typeof redis.expire;redis.publish=(async()=>1) as typeof redis.publish;
  setStore=(await import('../src/attachments.js')).setAttachmentStoreForTests;
  app=Fastify();errorHandler(app);await app.register(multipart,{limits:{fileSize:SINGLE_UPLOAD_MAX_BYTES,files:1},throwFileSizeLimit:false});
  await app.register((await import('../src/routes/uploads.js')).uploadRoutes);
  await app.register((await import('../src/routes/conv.js')).convRoutes);
  await app.ready();
});
beforeEach(async()=>{
  await truncateAll(t.raw);objects.clear();sessions.clear();aborted.length=0;assembled.length=0;next=0;setStore(store);
  await t.raw.exec(`INSERT INTO users(id,username,display_name,password_hash) VALUES ('a','alpha','Alpha','hash'),('b','bravo','Bravo','hash'),('c','charlie','Charlie','hash');
    INSERT INTO conversations(id,kind,direct_key,created_by) VALUES ('dm','direct','a:b','a'),('other','direct','b:c','b');
    INSERT INTO conversation_members(conversation_id,user_id) VALUES ('dm','a'),('dm','b'),('other','b'),('other','c');
    INSERT INTO servers(id,name,owner_id) VALUES ('server','Server','a');INSERT INTO server_members(server_id,user_id) VALUES ('server','a');
    INSERT INTO channels(id,server_id,name,type) VALUES ('channel','server','Чат','text')`);
});
after(async()=>{await app.close();setStore(null);redis.disconnect();await t.close();});

test('R127 старт, две части, сборка и отправка дают получателю тот же файл, повтор сборки идемпотентен',async()=>{
  // Ловит разрыв между временной загрузкой, pending-вложением и настоящей доставкой.
  const bytes=Buffer.concat([Buffer.alloc(BIGFILE_PART_BYTES,1),Buffer.from('end')]);
  const response=await start(bytes.length);assert.equal(response.statusCode,201,response.body);const id=response.json().uploadId;
  assert.equal(response.json().parts,2);assert.equal(response.json().partSize,BIGFILE_PART_BYTES);
  assert.equal((await part(id,2,bytes.subarray(BIGFILE_PART_BYTES))).statusCode,200);
  const status=await app.inject({method:'GET',url:uploadPath(id),headers:headers()});assert.deepEqual(status.json().done,[2]);
  const missing=await complete(id);assert.equal(missing.statusCode,409);assert.deepEqual(missing.json().missing,[1]);
  assert.equal((await part(id,1,bytes.subarray(0,BIGFILE_PART_BYTES))).statusCode,200);
  const built=await complete(id);assert.equal(built.statusCode,200,built.body);assert.equal(built.json().id,id);assert.equal(built.json().size,bytes.length);
  assert.deepEqual((await complete(id)).json(),built.json());assert.equal(assembled.length,1);
  assert.equal((await t.raw.query('SELECT * FROM attachment_upload_parts')).rows.length,0);
  const sent=await app.inject({method:'POST',url:'/conv/dm/messages',headers:headers(),payload:{clientId:'93000000-0000-4000-8000-000000000001',attachments:[{id}],content:''}});
  assert.equal(sent.statusCode,201,sent.body);
  const history=await app.inject({method:'GET',url:'/conv/dm/messages',headers:headers('b')});assert.equal(history.statusCode,200,history.body);
  const received=history.json().messages.find((m:{id:string})=>m.id===sent.json().id).attachments[0];
  assert.equal(received.id,id);assert.equal(received.size,bytes.length);assert.notEqual(received.url,built.json().url,'получатель получает собственную подпись');
  const file=(await t.raw.query<{storage_key:string}>(`SELECT storage_key FROM attachments WHERE id=$1`,[id])).rows[0];
  assert.deepEqual(objects.get(file.storage_key),bytes);
});
test('R127 чужой, неучастник и другая беседа не читают и не дописывают загрузку',async()=>{
  // Ловит доступ по одному знанию UUID без владельца и области беседы.
  assert.equal((await start(3,'c')).statusCode,404);const id=(await start()).json().uploadId;
  for(const [user,cid] of [['b','dm'],['c','dm'],['a','other']]){
    assert.equal((await part(id,1,Buffer.from('abc'),user,cid)).statusCode,404);
    assert.equal((await complete(id,user,cid)).statusCode,404);
    assert.equal((await app.inject({method:'GET',url:`/conv/${cid}/uploads/${id}`,headers:headers(user)})).statusCode,404);
  }
  assert.equal(sessions.values().next().value!.parts.size,0);
});
test('R127 неправильный размер и номер отвергаются до хранилища, правильный повтор перезаписывает часть',async()=>{
  // Ловит незаметно обрезанные части и дубли строк при повторе сети.
  const id=(await start()).json().uploadId;
  assert.equal((await part(id,1,Buffer.from('ab'))).statusCode,400);assert.equal((await part(id,2,Buffer.from('abc'))).statusCode,400);
  assert.equal(sessions.values().next().value!.parts.size,0);
  assert.equal((await part(id,1,Buffer.from('abc'))).statusCode,200);assert.equal((await part(id,1,Buffer.from('xyz'))).statusCode,200);
  assert.equal((await t.raw.query('SELECT * FROM attachment_upload_parts')).rows.length,1);
  assert.equal((await complete(id)).statusCode,200);assert.equal(objects.values().next().value!.toString(),'xyz');
});
const form=(bytes:Buffer,mime='application/octet-stream')=>({headers:{'content-type':'multipart/form-data; boundary=gv-test'},payload:Buffer.concat([Buffer.from(`--gv-test\r\nContent-Disposition: form-data; name="file"; filename="file.bin"\r\nContent-Type: ${mime}\r\n\r\n`),bytes,Buffer.from('\r\n--gv-test--\r\n')])});
test('R127 суточный предел одинаков для кусков и одиночной загрузки, ровная граница принимается',async()=>{
  // Ловит обход квоты переключением ручки и ошибку на единицу в сумме.
  await t.raw.query(`INSERT INTO attachments(id,conversation_id,owner_id,storage_key,name,content_type,size,state) VALUES ('daily','dm','a','dm/daily','f','application/octet-stream',$1,'deleted')`,[DM_DAILY_UPLOAD_BYTES-3]);
  const accepted=await start(3);assert.equal(accepted.statusCode,201,accepted.body);
  assert.equal((await start(1)).statusCode,429);
  const denied=await app.inject({method:'POST',url:'/conv/dm/attachments',headers:{...headers(),...form(Buffer.from('x')).headers},payload:form(Buffer.from('x')).payload});
  assert.equal(denied.statusCode,429,denied.body);assert.equal(objects.size,0);
  await app.inject({method:'DELETE',url:uploadPath(accepted.json().uploadId),headers:headers()});
  const single=await app.inject({method:'POST',url:'/conv/dm/attachments',headers:{...headers(),...form(Buffer.from('abc')).headers},payload:form(Buffer.from('abc')).payload});
  assert.equal(single.statusCode,200,single.body);
});
test('R127 уборка бросает старые строки и сироты, свежие и известные не трогает',async()=>{
  // Ловит незавершённый S3 после каскада и преждевременную уборку живой загрузки.
  const old=(await start()).json().uploadId;const fresh=(await start()).json().uploadId;
  const now=new Date(Date.now()+25*3600_000);const oldS3=(await t.raw.query<{s3_upload_id:string}>(`SELECT s3_upload_id FROM attachment_uploads WHERE id=$1`,[old])).rows[0].s3_upload_id;
  const freshS3=(await t.raw.query<{s3_upload_id:string}>(`SELECT s3_upload_id FROM attachment_uploads WHERE id=$1`,[fresh])).rows[0].s3_upload_id;
  await t.raw.query(`UPDATE attachment_uploads SET created_at=$1 WHERE id=$2`,[now.toISOString(),fresh]);
  // S3-отметка этой известной загрузки уже старая: от удаления защищает строка базы, не фильтр возраста списка.
  sessions.set('orphan-old',{key:'dm/orphan',initiated:new Date(),parts:new Map()});sessions.set('orphan-fresh',{key:'dm/fresh',initiated:now,parts:new Map()});
  assert.equal(await (await import('../src/bigUploads.js')).purgeStaleUploads(now),2);
  assert.deepEqual(aborted.sort(),[oldS3,'orphan-old'].sort());assert.ok(sessions.has(freshS3));assert.ok(sessions.has('orphan-fresh'));
  assert.deepEqual((await t.raw.query<{id:string}>('SELECT id FROM attachment_uploads')).rows.map(r=>r.id),[fresh]);
});
test('R127 удаление членства стирает загрузку и её части каскадом, сирота подбирается уборкой',async()=>{
  // Ловит потерю FK и навсегда оставленные куски после выхода.
  const id=(await start()).json().uploadId;await part(id,1,Buffer.from('abc'));
  await t.raw.exec(`DELETE FROM conversation_members WHERE conversation_id='dm' AND user_id='a'`);
  assert.equal((await t.raw.query('SELECT * FROM attachment_uploads')).rows.length,0);assert.equal((await t.raw.query('SELECT * FROM attachment_upload_parts')).rows.length,0);
  assert.equal(await (await import('../src/bigUploads.js')).purgeStaleUploads(new Date(Date.now()+25*3600_000)),1);assert.equal(sessions.size,0);
});
test('R127 без multipart возвращается 503, без входа большой кусок даёт 401 раньше разбора тела',async()=>{
  // Ловит ложный старт без поддержки S3 и чтение мегабайт до авторизации.
  setStore({...store,multipart:undefined});assert.equal((await start()).statusCode,503);
  const denied=await app.inject({method:'PUT',url:'/conv/dm/uploads/93000000-0000-4000-8000-000000000001/parts/1',headers:{'content-type':'application/octet-stream'},payload:Buffer.alloc(BIGFILE_PART_BYTES+1025)});
  assert.equal(denied.statusCode,401,denied.body);
});
test('R127 одиночный файл ровно 25 МиБ принимается, 25 МиБ плюс байт не сохраняется обрезанным',async()=>{
  // Ловит успешное сохранение только начала файла при throwFileSizeLimit:false.
  const send=(n:number)=>{const f=form(Buffer.alloc(n));return app.inject({method:'POST',url:'/conv/dm/attachments',headers:{...headers(),...f.headers},payload:f.payload});};
  const good=await send(SINGLE_UPLOAD_MAX_BYTES);assert.equal(good.statusCode,200,good.body);assert.equal(good.json().size,SINGLE_UPLOAD_MAX_BYTES);
  const bad=await send(SINGLE_UPLOAD_MAX_BYTES+1);assert.equal(bad.statusCode,413,bad.body);assert.equal(objects.size,1);
});

// Контрфакты загружают целые модули; фрагменты исходника не исполняются.
async function sourceModule<T>(relative:string,from?:string,to?:string,overrides:Record<string,unknown>={}):Promise<T>{
  const url=new URL(relative,import.meta.url);let source=readFileSync(url,'utf8').replace(/\r\n/g,'\n');
  if(from){assert.ok(source.includes(from),`якорь ${from}`);source=source.replace(from,to!);}
  const parsed=ts.createSourceFile(url.pathname,source,ts.ScriptTarget.Latest,true);const imports:Record<string,unknown>={};
  for(const decl of parsed.statements){if(!ts.isImportDeclaration(decl)||!ts.isStringLiteral(decl.moduleSpecifier)||decl.importClause?.isTypeOnly)continue;const spec=decl.moduleSpecifier.text;imports[spec]=overrides[spec]??await import(spec.startsWith('.')?new URL(spec,url).href:spec);}
  const module={exports:{}};runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,Buffer,URL,Date,Map,Set,Promise,console,fetch:globalThis.fetch,require:(spec:string)=>{assert.ok(spec in imports);return imports[spec];}});return module.exports as T;
}
test('R127 контрфакты размера, отсутствующих частей и повторной сборки ловятся на настоящих строках',async()=>{
  // Ловит независимую потерю трёх гарантий целостности.
  type Big=typeof import('../src/bigUploads.js');
  const actual=await import('../src/bigUploads.js');
  for(const [from,to,verify] of [
    ["if (input.bytes.length !== want)","if (false)",async(mod:Big,id:string)=>{const result=await mod.uploadPart({ownerId:'a',conversationId:'dm',uploadId:id,n:1,bytes:Buffer.from('ab')});assert.ok('code' in result);assert.equal(result.code,400);}],
    ['if (missing.length > 0)','if (false)',async(mod:Big,id:string)=>{const result=await mod.completeUpload('a','dm',id);assert.ok('code' in result);assert.equal(result.code,409);}],
    ['if (!row) return (await assembled(ownerId, conversationId, uploadId)) ?? notFound;','if (!row) return notFound;',async(mod:Big,id:string)=>{await actual.uploadPart({ownerId:'a',conversationId:'dm',uploadId:id,n:1,bytes:Buffer.from('abc')});await actual.completeUpload('a','dm',id);const result=await mod.completeUpload('a','dm',id);assert.ok(!('code' in result));assert.equal(result.id,id);}]
  ] as const){
    const a=(await start()).json().uploadId;await verify(actual,a);
    const mutant=await sourceModule<Big>('../src/bigUploads.ts',from,to);const b=(await start()).json().uploadId;
    await assert.rejects(()=>verify(mutant,b),assert.AssertionError,from);
  }
});
test('R127 канал и аватар отвергают обрезку, снятая проверка меняет ответ',async()=>{
  // В малом лимите multipart воспроизводим тот же truncated, не создавая мегабайт для каждого мутанта.
  const storage=await import('../src/storage.js');
  for(const relative of ['../src/routes/messages.ts','../src/routes/users.ts']){
    const routeName=relative.endsWith('messages.ts')?'messageRoutes':'userRoutes';const path=routeName==='messageRoutes'?'/channels/channel/attachments':'/users/me/avatar';
    const anchor="if (file.file.truncated) return reply.code(413).send({ error: 'request file too large' });";
    for(const mutated of [false,true]){
      const mod=await sourceModule<Record<string,(app:ReturnType<typeof Fastify>)=>Promise<void>>>(relative,mutated?anchor:undefined,'',{ '../storage.js':{...storage,storageConfigured:()=>true,putAttachment:async()=> 'https://media.example.test/file'}});
      const target=Fastify();errorHandler(target);await target.register(multipart,{limits:{fileSize:2,files:1},throwFileSizeLimit:false});await target.register(mod[routeName]);await target.ready();
      const f=form(Buffer.from('abc'),'image/png');const verify=async()=>assert.equal((await target.inject({method:'POST',url:path,headers:{...headers(),...f.headers},payload:f.payload})).statusCode,413);
      try{if(mutated)await assert.rejects(verify,assert.AssertionError);else await verify();}finally{await target.close();}
    }
  }
});
test('R127 снятая проверка truncated в acceptDmUpload сохраняет обрезанный файл и ловится реальным multipart',async()=>{
  // Сам parser не бросает исключение: гарантию 413 должна дать ручка, а не конфигурация раннера.
  type Att=typeof import('../src/routes/att.js');
  const auth=await import('../src/auth.js');const anchor="if (file.file.truncated) return reply.code(413).send({ error: 'request file too large' });";
  for(const mutated of [false,true]){
    const mod=await sourceModule<Att>('../src/routes/att.ts',mutated?anchor:undefined,'');
    const target=Fastify();errorHandler(target);target.addHook('onRequest',auth.requireAuth);
    await target.register(multipart,{limits:{fileSize:SINGLE_UPLOAD_MAX_BYTES,files:1},throwFileSizeLimit:false});
    target.post('/single',(req,reply)=>mod.acceptDmUpload(req,reply,'dm',req.user!.sub));
    const verify=async()=>{const f=form(Buffer.alloc(SINGLE_UPLOAD_MAX_BYTES+1));assert.equal((await target.inject({method:'POST',url:'/single',headers:{...headers(),...f.headers},payload:f.payload})).statusCode,413);};
    try{if(mutated)await assert.rejects(verify,assert.AssertionError);else await verify();}finally{await target.close();}
  }
});
