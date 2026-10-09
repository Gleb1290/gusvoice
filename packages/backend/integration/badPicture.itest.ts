import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t:TestDb;
let app:ReturnType<typeof Fastify>;
let tokenFor:(id:string)=>string;
const mark=()=>({kind:'badpic',at:1,sharer:{identity:'s#screen',userId:'s',native:true},channelId:null,viewer:{platform:'web',version:'1'},want:'auto',layer:'full',layers:[],win:null,now:{w:1280,h:720,fps:30,framesDecoded:60,keyFramesDecoded:1,framesDropped:0,qpSum:0,hasQp:false,bytes:1000,packetsReceived:10,packetsLost:0,nack:0,pli:0,fir:0,freezes:0,freezeS:0,pauses:0,pauseS:0,jitterMs:1,jbDelayS:0,jbEmitted:0,decodeS:0,decoder:'decoder',codec:'video/H264',rttMs:10,availInKbps:0}});
before(async()=>{
  t=await createTestDb();
  const {signToken}=await import('../src/auth.js');tokenFor=id=>signToken({sub:id,username:id,gen:0});
  app=Fastify();await app.register((await import('../src/routes/diag.js')).diagRoutes);
});
after(async()=>{await app.close();await t.close();});
beforeEach(async()=>{await truncateAll(t.raw);await t.raw.exec(`INSERT INTO users(id,username,display_name,password_hash) VALUES('v','viewer','Viewer','hash'),('s','sharer','Sharer','hash')`);});
const post=(payload:unknown)=>app.inject({method:'POST',url:'/diag/report',headers:{authorization:`Bearer ${tokenFor('v')}`},payload:payload as object});

test('отметка проходит реальную ручку, неправильная форма даёт 400 и не пишет отчёт',async()=>{
  // Нельзя принимать одно kind=badpic за пригодный отчёт либо потерять допустимый win=null.
  const denied=await post({kind:'badpic'});assert.equal(denied.statusCode,400);
  assert.equal((await t.raw.query(`SELECT * FROM diag_reports`)).rows.length,0);
  const accepted=await post({...mark(),comment:'не хранить'});assert.equal(accepted.statusCode,200);
  const rows=(await t.raw.query<{user_id:string;kind:string;payload:Record<string,unknown>}>(`SELECT user_id,kind,payload FROM diag_reports`)).rows;
  assert.equal(rows[0]?.user_id,'v');assert.equal(rows[0]?.kind,'badpic');assert.deepEqual(rows[0]?.payload,mark());
});

test('тридцатая отметка разрешена, тридцать первая за час даёт 429 без лишней записи',async()=>{
  // Чужие отметки, другая диагностика и давний badpic не должны съедать личный часовой предел.
  await t.raw.exec(`INSERT INTO diag_reports(id,user_id,kind,payload,created_at)
    SELECT 'rate-'||n,'v','badpic','{}',now() FROM generate_series(1,29)n;
    INSERT INTO diag_reports(id,user_id,kind,payload,created_at) VALUES
    ('old','v','badpic','{}',now()-interval '1 hour 1 second'),('other','s','badpic','{}',now()),('screen','v','screenshare','{}',now());`);
  assert.equal((await post(mark())).statusCode,200);
  const before=(await t.raw.query(`SELECT * FROM diag_reports`)).rows.length;
  assert.equal((await post(mark())).statusCode,429);
  assert.equal((await t.raw.query(`SELECT * FROM diag_reports`)).rows.length,before);
});

test('SQL плохой картинки связывает обе стороны по часам сервера и включительным границам окна',async()=>{
  // Часы человека намеренно неверны; окно скрипта обязано отобрать -60/0/+60, исключив +61.
  const at=Date.parse('2026-10-06T20:00:00Z');
  const nowMark={...mark(),at:at+86400000,win:{ms:2000,kbps:1400,fps:30,qp:null,lossPct:0,nack:0,pli:0,freezes:0,freezeMs:0,dropped:0,keyFrames:0,jbMs:1}};
  const samples=[0,60000,120000,121000].map((ms,i)=>({t:ms,sharing:1,enc:{fps:30,width:1280,height:720,qp:27,kbps:1000,enc_kbps:1200,target_bitrate:1500000,bwe_bps:3000000,bwe_min_bps:1200000,limitation:'none',pli:i,key_frames:i+1,nack:i*2,layers:[{rid:'f',active:1,qp:27,kbps:1000,target_kbps:1500}],cfg:{w:1280,h:720,fps:30,kbps:1500,mode:'detail',maxq:1,kf:10}}}));
  const flush=new Date(at+240000).toISOString();
  const durationMs=302000; // начало порции на 60 секунд раньше вычисленной отметки (created_at-2с).
  await t.raw.query(`INSERT INTO diag_reports(id,user_id,kind,payload,created_at) VALUES
    ('mark-main','v','badpic',$1::jsonb,$2),('sender','s','screenshare',$3::jsonb,$4),('receiver','v','screenshare',$5::jsonb,$4)`,
    [JSON.stringify(nowMark),new Date(at).toISOString(),JSON.stringify({context:{sessionId:'sender',durationMs},samples}),flush,JSON.stringify({context:{durationMs},samples:samples.map(x=>({t:x.t,sub:{streams:1,fps_min:30,h_min:720,qp:27}}))})]);
  const sql=(await readFile(new URL('../../../scripts/ops/bad-picture.sql',import.meta.url),'utf8')).split(/\r?\n/).filter(line=>!line.startsWith('\\')).join('\n').replace(/:win\b/g,'60').replace(/:n\b/g,'10');
  const results=await t.raw.exec(sql);
  assert.equal(results.length,3,'исполнены все три настоящие SQL сводки');
  const marks=results[0]!.rows as Record<string,unknown>[];
  assert.equal(marks[0]?.['зритель'],'viewer');assert.equal(marks[0]?.['показывал'],'sharer');
  assert.equal(marks[0]?.['QP'],null,'отсутствующий QP не становится нулём');
  for(const index of [1,2])assert.deepEqual((results[index]!.rows as Record<string,unknown>[]).map(x=>Number(x.t)),[-60,0,60]);
  const sender=results[1]!.rows as Record<string,unknown>[];
  assert.deepEqual(sender.map(x=>x['PLI']),[null,1,1]);assert.match(String(sender[1]?.['с чем запущен']),/макс опорный×10/);
  await t.raw.query(`INSERT INTO diag_reports(id,user_id,kind,payload,created_at) VALUES
    ('mark-no-window','v','badpic',$1::jsonb,$2),('old-sender','s','screenshare',$3::jsonb,$4)`,
    [JSON.stringify(mark()),new Date(at+45000).toISOString(),JSON.stringify({context:{sessionId:'old',durationMs:20000},samples:[{t:0,sharing:1,enc:{fps:30,width:640,height:360,pli:1,nack:0}}]}),new Date(at+10000).toISOString()]);
  const legacy=await t.raw.exec(sql);
  assert.equal(legacy[0]!.rows.length,2,'win=null допускается и использует двухсекундный запас');
  const old=(legacy[1]!.rows as Record<string,unknown>[]).filter(x=>x['кадр']==='640×360');
  assert.ok(old.length>0,'старый срез попал в реальные сводки');
  assert.ok(old.every(x=>x['с чем запущен']===null && x['QP']===null),'отсутствующие поля старого клиента остались неизвестными');
});
