import assert from 'node:assert/strict';
import { it } from 'node:test';
import { isBadPictureBody, parseBadPicture, BAD_PICTURE_PER_HOUR } from './diagBadPicture.js';

const snap = () => ({w:1280,h:720,fps:30,framesDecoded:60,keyFramesDecoded:1,framesDropped:0,qpSum:0,hasQp:false,bytes:1000,packetsReceived:10,packetsLost:0,nack:0,pli:0,fir:0,freezes:0,freezeS:0,pauses:0,pauseS:0,jitterMs:1,jbDelayS:0,jbEmitted:0,decodeS:0,decoder:'decoder',codec:'video/H264',rttMs:10,availInKbps:0});
const mark = () => ({kind:'badpic',at:1,sharer:{identity:'sharer#screen',userId:'sharer',native:true},channelId:null,viewer:{platform:'web',version:'1'},want:'auto',layer:'full',layers:[{w:1280,h:720}],win:null,now:snap()});

it('отметка принимает отсутствие окна и QP, но вырезает личные неизвестные поля',()=>{
  // Один неизвестный комментарий не должен оказаться в числовой диагностике.
  const original={...mark(),comment:'private',now:{...snap(),secret:'private'},sharer:{...mark().sharer,displayName:'private'}};
  const parsed=parseBadPicture(original);assert.ok(parsed,'валидная отметка принята');
  assert.deepEqual(parsed,mark());assert.equal(isBadPictureBody(original),true);assert.equal(BAD_PICTURE_PER_HOUR,30);
  for(const body of [null,undefined,'badpic',{}, {kind:'screenshare'}])assert.equal(isBadPictureBody(body),false);
});

it('четыре слоя и конечные метрики проходят, пятый слой и нечисловые значения отклоняются',()=>{
  // Лимит нужен до записи в JSONB, а NaN/Infinity нельзя сравнивать как измерение.
  const valid={...mark(),layers:Array.from({length:4},()=>({w:640,h:360}))};assert.ok(parseBadPicture(valid),'ровно четыре слоя разрешены');
  assert.equal(parseBadPicture({...valid,layers:[...valid.layers,{w:1,h:1}]}),null);
  for(const value of [NaN,Infinity,-Infinity,'30',null])assert.equal(parseBadPicture({...mark(),now:{...snap(),fps:value}}),null);
  assert.equal(parseBadPicture({...mark(),viewer:{platform:'unknown',version:'1'}}),null);
  assert.equal(parseBadPicture({...mark(),kind:'screenshare'}),null);
});

it('строки отметки обрезаются без отказа, окно допускает null QP',()=>{
  // Слишком длинное имя декодера не должно терять весь отчёт.
  const window={ms:2000,kbps:4000,fps:30,qp:null,lossPct:0,nack:0,pli:0,freezes:0,freezeMs:0,dropped:0,keyFrames:0,jbMs:0};
  const parsed=parseBadPicture({...mark(),win:window,sharer:{identity:'i'.repeat(129),userId:'u'.repeat(65),native:true},now:{...snap(),decoder:'d'.repeat(49),codec:'c'.repeat(33)}});
  assert.ok(parsed,'длинные подписи не отбивают числа');assert.equal(parsed.sharer.identity.length,128);assert.equal(parsed.sharer.userId.length,64);assert.equal(parsed.now.decoder.length,48);assert.equal(parsed.now.codec.length,32);assert.equal(parsed.win?.qp,null);
  assert.equal(parseBadPicture({...mark(),win:{...window,qp:Infinity}}),null);
});
