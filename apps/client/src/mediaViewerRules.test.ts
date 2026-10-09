import assert from 'node:assert/strict';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as rules from './mediaViewerRules';
it('видео уважает модификаторы, кадры только на паузе, третий край и неизвестную длительность',()=>{
  // Ловит перехват системной клавиши и неожиданный seek вместо кадра.
  for(const mods of [{ctrl:true},{alt:true},{meta:true}]) assert.equal(rules.videoKeyAction('KeyK',mods,true),null);
  assert.deepEqual(rules.videoKeyAction('KeyJ',{},false),{kind:'seek',by:-10});
  assert.deepEqual(rules.videoKeyAction('Comma',{},true),{kind:'frame',dir:-1}); assert.equal(rules.videoKeyAction('Comma',{},false),null);
  assert.equal(rules.videoTapSide(99.99,300),-1); assert.equal(rules.videoTapSide(100,300),0); assert.equal(rules.videoTapSide(200,300),1);
  assert.equal(rules.videoTapSide(1,0),0);
  for(const duration of [Infinity,NaN]) assert.equal(rules.seekClamp(20,10,duration),30);
  assert.equal(rules.seekClamp(20,-30,60),0); assert.equal(rules.seekClamp(20,50,60),60);
});
it('поворот не нормализует угол, вписывание не увеличивает, инерция ограничивает скорость и мусор',()=>{
  // Ловит вращение в обратную сторону через 360 и огромный выброс фото при отпускании.
  assert.equal(rules.rotateStep(-360),-450); assert.equal(rules.rotateStep(0),-90);
  assert.equal(rules.rotateFit(10,20,100,100,90),1); assert.equal(rules.rotateFit(100,200,100,100,90),0.5);
  assert.deepEqual(rules.rubberPan({x:20,y:-20},{x:10,y:-10},1),{x:20,y:-20});
  assert.deepEqual(rules.inertiaTarget({x:0,y:0},{x:5000,y:-5000}),{x:1000,y:-1000});
  assert.deepEqual(rules.inertiaTarget({x:2,y:3},{x:NaN,y:Infinity}),{x:2,y:3});
  const source=rules.rotateFit.toString(); assert.ok(source.includes('Math.min(1,'));
  const bad=runInNewContext(`(${source.replace('Math.min(1,','Math.min(')})`,{quarterTurned:rules.quarterTurned}) as typeof rules.rotateFit;
  assert.throws(()=>assert.equal(bad(10,20,100,100,90),1),assert.AssertionError);
});
it('дата просмотрщика различает сегодня, вчера и другой год, меню удаляет дубли без изменения входа',()=>{
  // Ловит устаревшую подпись дня и повторную опасную команду в меню.
  const now=new Date(2026,9,7,20);
  assert.match(rules.viewerDate(new Date(2026,9,7,12).toISOString(),now),/^сегодня в /);
  assert.match(rules.viewerDate(new Date(2026,9,6,12).toISOString(),now),/^вчера в /);
  assert.match(rules.viewerDate(new Date(2025,0,5).toISOString(),now),/2025/); assert.equal(rules.viewerDate('bad',now),'');
  const items=[{id:'delete' as const,n:1},{id:'copy' as const,n:2},{id:'copy' as const,n:3},{id:'goto' as const,n:4}];
  assert.deepEqual(rules.orderViewerMenu(items),[items[3],items[1],items[0]]); assert.equal(items.length,4);
});
