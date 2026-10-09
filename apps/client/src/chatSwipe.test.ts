import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './chatSwipe';
it('реальная диспетчеризация свайпа вызывает нужную команду с инверсией состояния',async()=>{
  // Ловит верный ярлык с неверной мутацией — например mute вместо unmute.
  const raw=readFileSync(new URL('./components/DmListSwipe.tsx',import.meta.url),'utf8');
  const ast=ts.createSourceFile('DmListSwipe.tsx',raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const fn=ast.statements.find((n):n is ts.FunctionDeclaration=>ts.isFunctionDeclaration(n)&&n.name?.text==='runSwipeAction'); assert.ok(fn);
  const calls:unknown[][]=[]; const command=(name:string)=>(...args:unknown[])=>{calls.push([name,...args]);return Promise.resolve();};
  const module={exports:{}};
  runInNewContext(ts.transpileModule(fn.getText(ast),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {module,exports:module.exports,useStore:{getState:()=>({markConvRead:command('read'),setConvUnreadMark:command('mark'),setPushMuted:command('mute')})},
      toggleDmPinned:command('pin'),archiveDms:command('archive'),deleteChat:command('delete'),toastError:assert.fail});
  const run=(module.exports as {runSwipeAction:typeof import('./components/DmListSwipe').runSwipeAction}).runSwipeAction;
  const dm={id:'d',otherUser:{id:'u'}} as Parameters<typeof run>[0];
  for(const on of [false,true]) {
    const state={pinned:on,unread:on,muted:on,archived:on};
    for(const action of ['pin','read','archive','mute','delete','folders'] as const)run(dm,action,state);
  }
  await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['pin','d',true],['mark','d',true],['archive',['d'],true],['mute','dm_user','u',true],['delete',dm],
    ['pin','d',false],['read','d'],['archive',['d'],false],['mute','dm_user','u',false],['delete',dm]]);
});
it('действие подбирается по возможностям, недоступное заменяется архивом или мьютом, пустой сервер не свайпается',()=>{
  // Ловит обещанное действие, ручки которого сервер не поддерживает.
  const all={folders:true,archive:true,pin:true,read:true,mute:true,del:true};
  assert.equal(rules.effectiveSwipe('auto',all),'folders');
  assert.equal(rules.effectiveSwipe('auto',{...all,folders:false}),'archive');
  assert.equal(rules.effectiveSwipe('folders',{...all,folders:false}),'archive');
  assert.equal(rules.effectiveSwipe('auto',{...all,folders:false,archive:false}),'mute');
  const none={folders:false,archive:false,pin:false,read:false,mute:false,del:false};
  assert.equal(rules.effectiveSwipe('pin',none),null); assert.deepEqual(rules.swipeChoices(none),[]);
  assert.deepEqual(rules.swipeChoices(all),['pin','read','archive','mute','delete','folders']);
});
it('свайп срабатывает на 45 процентах и броске, вправо никогда, смещение прижато к ширине',()=>{
  // Ловит ошибку границы и случайный правый свайп удаления.
  assert.equal(rules.swipeCommits(-44.99,0,100),false); assert.equal(rules.swipeCommits(-45,0,100),true);
  assert.equal(rules.swipeCommits(-25,-3500,100),true); assert.equal(rules.swipeCommits(-24,-3500,100),false);
  assert.equal(rules.swipeCommits(45,-5000,100),false);
  const source=readFileSync(new URL('./chatSwipe.ts',import.meta.url),'utf8');
  const check=(api:typeof rules)=>{assert.equal(api.swipeCommits(-45,0,100),true);assert.equal(api.swipeCommits(45,-5000,100),false);assert.equal(api.swipeCommits(-24,-3500,100),false);};
  check(rules);
  for(const [from,to] of [['-dx >= width * SWIPE_ROW_COMMIT','-dx > width * SWIPE_ROW_COMMIT'],['if (dx >= 0) return false;','if (dx <= 0) return false;'],['-dx > 24','-dx >= 24']] as const){
    assert.ok(source.includes(from));const module={exports:{}};
    runInNewContext(ts.transpileModule(source.replace(from,to),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports});
    assert.throws(()=>check(module.exports as typeof rules),assert.AssertionError);
  }
  assert.equal(rules.swipeShift(-200,100),-100); assert.equal(rules.swipeShift(10,100),0);
  const off={pinned:false,unread:false,muted:false,archived:false}; const on={pinned:true,unread:true,muted:true,archived:true};
  assert.deepEqual(['pin','read','archive','mute','delete','folders'].map(a=>rules.swipeLabel(a as rules.SwipeAction,off)),['Закрепить','Непрочитано','В архив','Без звука','Удалить','Папки']);
  assert.deepEqual(['pin','read','archive','mute','delete','folders'].map(a=>rules.swipeLabel(a as rules.SwipeAction,on)),['Открепить','Прочитано','Вернуть','Вкл. звук','Удалить','Папки']);
});
it('настройка переживает запись, auto удаляет ключ, мусор и закрытое хранилище дают auto',()=>{
  // Ловит сохранённый неподдерживаемый режим и невозможность вернуться к умолчанию.
  const data=new Map<string,string>(); const module={exports:{}};
  const source=readFileSync(new URL('./chatSwipe.ts',import.meta.url),'utf8');
  runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {module,exports:module.exports,localStorage:{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v),removeItem:(k:string)=>data.delete(k)}});
  const api=module.exports as typeof rules; assert.equal(api.readSwipeSetting(),'auto');
  api.writeSwipeSetting('pin'); assert.equal(api.readSwipeSetting(),'pin'); api.writeSwipeSetting('auto'); assert.equal(data.size,0);
  data.set('gv.dm.chatSwipe','bad'); assert.equal(api.readSwipeSetting(),'auto');
  assert.equal(rules.readSwipeSetting(),'auto'); assert.doesNotThrow(()=>rules.writeSwipeSetting('auto'));
});
