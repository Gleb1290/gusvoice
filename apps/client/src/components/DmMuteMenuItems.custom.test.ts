import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { before, after, it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as sync from '../convSyncRules';
import * as list from '../dmListRules';
import type { DmMuteMenuItems } from './DmChatView';

const raw=readFileSync(new URL('./DmChatView.tsx',import.meta.url),'utf8').replace(/\r\n/g,'\n');
before(()=>{GlobalRegistrator.register();Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});});
after(()=>GlobalRegistrator.unregister());
function changed(from:string,to:string){assert.ok(raw.includes(from),`якорь ${from}`);return raw.replace(from,to);}
async function scene(mode:'custom'|'presets',source=raw){
  const calls:unknown[][]=[];const state={convActive:true,serverFeatures:['conv13']};
  const useStore=Object.assign((select:(s:typeof state)=>unknown)=>select(state),{
    getState:()=>({setPushMuted:(...args:unknown[])=>{calls.push(['mute',...args]);return Promise.resolve();}}),
  });
  const deps:Record<string,unknown>={react:React,'react/jsx-runtime':jsx,'../store':{useStore},'../convSyncRules':sync,'../dmListRules':list,
    '../muteRecent':{loadMuteRecent:()=>[],saveMuteRecent:(seconds:number)=>calls.push(['recent',seconds])},
    '../toast':{toastError:assert.fail},'./ContextMenu':{
      MenuDivider:()=>React.createElement('hr'),
      MenuItem:({label,onClick}:{label:string;onClick:()=>void})=>React.createElement('button',{onClick},label),
    }};
  const tree=ts.createSourceFile('DmChatView.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const imports=new Set(tree.statements.filter(ts.isImportDeclaration).map(n=>(n.moduleSpecifier as ts.StringLiteral).text));
  const module={exports:{}};
  // Целый DmChatView, а не вырезанная функция меню; лента не монтируется, внешние зависимости изолированы.
  runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,
    {module,exports:module.exports,window,document,CustomEvent,Date,setTimeout,clearTimeout,
      require:(id:string)=>{assert.ok(imports.has(id)||id==='react/jsx-runtime',id);return deps[id]??{};}});
  const menu=(module.exports as {DmMuteMenuItems:typeof DmMuteMenuItems}).DmMuteMenuItems;
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  const event=(e:Event)=>calls.push(['custom',(e as CustomEvent<unknown>).detail]);
  window.addEventListener(list.MUTE_CUSTOM_EVENT,event);
  try{
    await React.act(async()=>root.render(React.createElement(menu,{peerId:'peer-target',mute:null,now:Date.UTC(2026,9,9),onDone:()=>calls.push(['done'])})));
    const open=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='Выключить на время…');assert.ok(open);
    await React.act(async()=>open.click());
    const buttons=[...host.querySelectorAll<HTMLButtonElement>('button')];
    assert.equal(buttons.at(-1)!.textContent,'Свой срок…','свой срок последним в подменю времени');
    assert.deepEqual(buttons.slice(1,-1).map(b=>b.textContent),list.DM_MUTE_PRESETS.map(p=>p.label),'ровно пять пресетов без исторических сроков');
    assert.equal(buttons.length,7,'назад, пять сроков и свой срок');
    if(mode==='custom'){
      await React.act(async()=>buttons.at(-1)!.click());
      assert.deepEqual(calls,[['done'],['custom','peer-target']],'сначала закрыто меню, затем событие с id собеседника');
    }else{
      for(let i=0;i<5;i++){
        calls.length=0;await React.act(async()=>buttons[i+1]!.click());
        assert.deepEqual(calls,[['recent',list.DM_MUTE_PRESETS[i]!.seconds],['done'],['mute','dm_user','peer-target',true,list.DM_MUTE_PRESETS[i]!.seconds,undefined]],'пресет сохраняет срок и шлёт точные секунды');
      }
    }
  }finally{window.removeEventListener(list.MUTE_CUSTOM_EVENT,event);await React.act(async()=>root.unmount());host.remove();}
}
it('R130 свой срок последним после пяти пресетов закрывает меню и отправляет peerId событием',async()=>{
  // Открытие нового окна до закрытия меню оставляло бы два слоя и теряло бы нужного собеседника.
  await scene('custom');
});
it('R130 пять пресетов времени сохраняют срок и вызывают мьют в секундах',async()=>{
  // Новый собственный срок не заменяет и не сдвигает прежние пять быстрых действий.
  await scene('presets');
});
it('R130 мутанты незакрытого меню, чужого id и потерянного пресета отвергаются',async()=>{
  // Страж события проверяет и адресата, и порядок закрытия; количество не маскируется последним пунктом.
  await scene('custom');
  for(const[from,to,msg]of[
    ['            onDone();\n            window.dispatchEvent','            window.dispatchEvent','сначала закрыто меню'],
    ['new CustomEvent<string>(MUTE_CUSTOM_EVENT, { detail: peerId })',"new CustomEvent<string>(MUTE_CUSTOM_EVENT, { detail: 'other-peer' })",'сначала закрыто меню'],
    ['DM_MUTE_PRESETS.map((p)', 'DM_MUTE_PRESETS.slice(0, 4).map((p)','ровно пять пресетов'],
  ])await assert.rejects(scene('custom',changed(from!,to!)),(e:unknown)=>e instanceof assert.AssertionError&&e.message.includes(msg!));
});
