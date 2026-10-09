import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { before, after, it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as shared from '@gusvoice/shared';
import * as sync from './convSyncRules';
import * as list from './dmListRules';
import * as view from './dmFolderView';
import * as swipe from './chatSwipe';
import type { useDmFolders as FoldersHook } from './dmFolders';
import type * as FolderBar from './components/DmFolderBar';
import type * as RowMenu from './components/DmRowMenu';
import type * as ListSwipe from './components/DmListSwipe';

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const folderRaw = source('./dmFolders.ts'), barRaw = source('./components/DmFolderBar.tsx');
const menuRaw = source('./components/DmRowMenu.tsx'), swipeRaw = source('./components/DmListSwipe.tsx');
before(() => { GlobalRegistrator.register(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
after(() => GlobalRegistrator.unregister());
function whole<T>(raw: string, deps: Record<string, unknown>): T {
  const module = { exports: {} }; const tree = ts.createSourceFile('module.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = new Set(tree.statements.filter(ts.isImportDeclaration).map(n => (n.moduleSpecifier as ts.StringLiteral).text));
  // Полный модуль с реальными состояниями и замыканиями; внешние подсистемы — зависимости харнесса.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module, exports: module.exports, window, document, localStorage, Date, CSS: { escape: (id: string) => id },
    require: (id: string) => { if (id === 'react/jsx-runtime') return jsx; assert.ok(imports.has(id), id); return deps[id] ?? {}; },
  });
  return module.exports as T;
}
function changed(raw: string, from: string, to: string) { assert.ok(raw.includes(from), `якорь ${from}`); return raw.replace(from, to); }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
const folder = (id = 'own', own = true, pinned: string[] = ['a', 'b']): shared.DmFolder => ({ id, title: id, flags: shared.DM_FOLDER_PERSONAL,
  emoticon: null, include: [], exclude: [], ...(own ? { pinnedOwn: true as const } : {}), pinned });
function folders(api: Record<string, unknown>, raw = folderRaw) {
  return whole<{ useDmFolders: typeof FoldersHook }>(raw, { zustand: { create }, '@gusvoice/shared': shared,
    './api': { api }, './config': { activeInstanceId: () => 'instance' } }).useDmFolders;
}
async function mounted<T>(hook: () => T, run: (get: () => T, host: HTMLElement) => Promise<void>) {
  let value!: T;
  function Harness() { value = hook(); return React.isValidElement(value) ? value : null; }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try { await React.act(async () => root.render(React.createElement(Harness))); await run(() => value, host); }
  finally { await React.act(async () => root.unmount()); host.remove(); }
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

it('R129 признак собственного набора включается только точным pinset1', () => {
  // Порядок pinorder2 не означает право использовать новые ручки собственного набора.
  for (const features of [null, undefined, [], ['folders1', 'pinorder2'], ['pinset10']]) assert.equal(sync.serverFolderPinSet(features), false);
  assert.equal(sync.serverFolderPinSet(['pinset1']), true); assert.equal(sync.serverFolderPinSet(['folders1', 'pinset1']), true);
});
async function pinCase(fail: boolean, raw = folderRaw) {
  const job = deferred<{ folders: shared.DmFolder[] }>(), calls: unknown[] = [];
  const useFolders = folders({ dmFolderPin: (id: string, cid: string, on: boolean) => { calls.push([id,cid,on]); return job.promise; } }, raw);
  const was = [folder(), folder('other')]; useFolders.getState().apply(was);
  const work = useFolders.getState().pinChat('own', 'new', true);
  assert.deepEqual(Array.from(useFolders.getState().folders![0]!.pinned!), ['new', 'a', 'b'], 'новый закреп виден до ответа');
  assert.equal(useFolders.getState().folders![1], was[1], 'другая папка не изменена');
  assert.deepEqual(calls, [['own','new',true]]);
  if (fail) { job.reject(new Error('отказ')); await assert.rejects(work,/отказ/); assert.equal(useFolders.getState().folders, was, 'отказ возвращает снимок'); }
  else { const accepted = [folder('own',true,['new','b']), was[1]!]; job.resolve({ folders: accepted }); await work;
    assert.equal(useFolders.getState().folders,accepted,'серверный ответ истина'); }
}
it('R129 pinChat закрепляет сразу только свою папку, принимает ответ и откатывает отказ', async () => {
  // Оптимизм без снимка оставлял бы неподтверждённый закреп на одном устройстве.
  await pinCase(false); await pinCase(true);
  await assert.rejects(pinCase(true, changed(folderRaw,
    'set({ folders: (await api.dmFolderPin(folderId, convId, pinned)).folders });\n    } catch (e) {\n      set({ folders: was });',
    'set({ folders: (await api.dmFolderPin(folderId, convId, pinned)).folders });\n    } catch (e) {')), /возвращает снимок/);
});
it('R129 откреп папки оптимистичен и не дублирует повторный закреп', async () => {
  // Общие закрепы и системная папка не получают ложный собственный набор на месте.
  for (const [own,on,cid,expected] of [[true,false,'a',['b']], [true,true,'a',['a','b']], [false,true,'new',['a','b']]] as const) {
    const job=deferred<{folders:shared.DmFolder[]}>(); const useFolders=folders({dmFolderPin:()=>job.promise});
    const was=[folder('own',own,['a','b'])]; useFolders.getState().apply(was);
    const work=useFolders.getState().pinChat('own',cid,on);
    assert.deepEqual(Array.from(useFolders.getState().folders![0]!.pinned!),[...expected]);
    job.resolve({folders:was}); await work;
  }
});
async function slotsCase(raw=folderRaw){
  const job=deferred<{folders:shared.DmFolder[]}>(); const calls:unknown[]=[];
  const useFolders=folders({dmFolderPinOrder:(id:string,ids:string[])=>{calls.push([id,[...ids]]);return job.promise;}},raw);
  const was=[folder('own',true,['a','x','b','y'])]; useFolders.getState().apply(was);
  const work=useFolders.getState().reorderPins('own',['b','a']);
  assert.deepEqual(Array.from(useFolders.getState().folders![0]!.pinned!),['b','x','a','y'],'частичный порядок сохраняет неназванные слоты');
  assert.deepEqual(calls,[['own',['b','a']]]);
  job.resolve({folders:[folder('own',true,['b','x','a','y','server'])]}); await work;
  assert.deepEqual(Array.from(useFolders.getState().folders![0]!.pinned!),['b','x','a','y','server']);
}
it('R129 reorderPins собственного набора меняет только слоты названных до ответа', async () => {
  // Частичный drag видимых чатов не должен стереть закреплённые вне текущего отфильтрованного списка.
  await slotsCase();
  await assert.rejects(slotsCase(changed(folderRaw,'return own ? dmFolderPinSlots(own, ids) : ids;','return ids;')),/сохраняет неназванные слоты/);
});
async function toggleCase(fail: boolean, raw=folderRaw) {
  const job=deferred<{folders:shared.DmFolder[]}>(); const calls:unknown[]=[];
  const useFolders=folders({dmFolderPin:(...args:unknown[])=>{calls.push(['pin',...args]);return job.promise;},
    dmFolderUpdate:async(id:string,input:shared.DmFolderInput)=>{calls.push(['update',id,input]);return {folders:[folder('own',true,[])]};}},raw);
  useFolders.getState().apply([{...folder('own',true,['a']),include:['a']}]);
  const work=useFolders.getState().toggleChat('own',{id:'a',group:false,muted:false,unread:false},false);
  assert.deepEqual(calls,[['pin','own','a',false]],'откреп до правки, не параллельно');
  if(fail){job.reject(new Error('отказ открепа'));await assert.rejects(work,/отказ открепа/);assert.equal(calls.length,1,'при отказе исключение не пишется');}
  else {job.resolve({folders:[{...folder('own',true,[]),include:['a']}]});await work;
    assert.equal(calls.length,2); const update=calls[1] as [string,string,shared.DmFolderInput];
    assert.equal(update[0],'update'); assert.equal(update[1],'own'); assert.deepEqual(Array.from(update[2].exclude),['a']); }
}
it('R129 убрать из папки сначала ждёт откреп и лишь затем обновляет правила',async()=>{
  // Правка исключения до снятия закрепа вернула бы чат при следующем ответе собственных закрепов.
  await toggleCase(false);await toggleCase(true);
  await assert.rejects(toggleCase(false,changed(folderRaw,'      await get().pinChat(folderId, chat.id, false);','      void get().pinChat(folderId, chat.id, false);')),/не параллельно/);
});
it('R129 добавить в папку не открепляет свой чат, отсутствующая и системная папки без запросов',async()=>{
  // Снятие закрепа принадлежит только действию «Убрать», не добавлению и не системной вкладке.
  const calls:unknown[]=[];const useFolders=folders({dmFolderPin:async()=>{calls.push('pin');return{folders:[]};},
    dmFolderUpdate:async()=>{calls.push('update');return{folders:[folder()]};}});
  useFolders.getState().apply([folder(),{...folder('system',false,[]),system:'dms'}]);
  for(const id of ['missing','system'])await useFolders.getState().toggleChat(id,{id:'a',group:false,unread:false,muted:false},false);
  assert.deepEqual(calls,[]);
  await useFolders.getState().toggleChat('own',{id:'a',group:false,unread:false,muted:false},true);
  assert.deepEqual(calls,['update']);
});
it('R129 новая папка получает pinnedOwn только при включённом pinSet, ответ pinOwn применяется',async()=>{
  // Старому серверу не навязывается режим, а перевод старых папок меняет авторитетный снимок.
  for(const pinSet of [false,true]){
    const requests:unknown[]=[];const accepted=[folder()];
    const useFolders=folders({dmFolderCreate:async(input:unknown)=>{requests.push(input);return{id:'new',folders:accepted};},
      dmFolderPinOwn:async(plan:unknown)=>{requests.push(plan);return{folders:accepted};}});
    useFolders.setState({pinSet});const input:shared.DmFolderInput={title:'Новая',flags:0,emoticon:null,include:[],exclude:[]};
    assert.equal(await useFolders.getState().create(input),'new');
    assert.deepEqual(json(requests[0]),pinSet?{...input,pinnedOwn:true}:input);assert.equal('pinnedOwn' in input,false);
    const plan=[{id:'own',ids:['a']}];await useFolders.getState().pinOwn(plan);
    assert.equal(requests[1],plan);assert.equal(useFolders.getState().folders,accepted);
  }
});

function menuModule(dms:shared.DmChannel[],calls:unknown[],raw=menuRaw,task?: (fid:string,cid:string,on:boolean)=>Promise<void>){
  const state={convActive:true,serverFeatures:['conv11','pinorder1','pinset1'],dms,conv:{summaries:{}},blockedUsers:[],pushMutedDmUsers:[],pushMuteUntil:{},pushAlwaysTargets:[],user:null};
  const command=(kind:string)=>(...args:unknown[])=>{calls.push([kind,...args]);return Promise.resolve();};
  const useStore=Object.assign((pick:(s:typeof state)=>unknown)=>pick(state),{getState:()=>state});
  return whole<typeof RowMenu>(raw,{react:React,'../store':{useStore},'../convSyncRules':sync,'../dmListRules':list,
    '../notifyExceptionsRules':{notifyAlwaysAction:()=>null},'./DmChatView':{toggleDmPinned:command('global')},'./Icon':{Icon:()=>null},
    './DmFolderBar':{useFoldersOn:()=>false,toggleFolderPinned:task??command('folder')},'./DmPinDrag':{reorderDmPins:command('order')},
    '../dmRowRules':{plural:(_n:number,_one:string,many:string)=>many},
    './ContextMenu':{ContextMenu:({children}:{children:React.ReactNode})=>React.createElement('div',null,children),MenuDivider:()=>null,
      MenuItem:({label,onClick}:{label:string;onClick?:()=>void})=>React.createElement('button',{onClick},label)}});
}
const dm=(id:string,pinned=false):shared.DmChannel=>({id,pinnedAt:pinned?'2026-10-09T00:00:00Z':null,createdAt:'2026-10-09T00:00:00Z',lastMessageAt:null,
  otherUser:{id:`peer-${id}`,username:id,displayName:id,avatarUrl:null}} as shared.DmChannel);
async function rowCase(raw=menuRaw){
  for(const globalPinned of [false,true])for(const ownPinned of [false,true]){
    const dms=[dm('a',globalPinned)];const calls:unknown[]=[];const mod=menuModule(dms,calls,raw);
    let menu!:ReturnType<typeof mod.useDmRowMenu>;
    await mounted(()=>{menu=mod.useDmRowMenu({current:{folderId:'own',ids:['a'],own:ownPinned?['a']:[]}});return menu.menu;},async(_get,host)=>{
      await React.act(async()=>menu.openDmMenu(dms[0]!,{x:0,y:0}));
      const button=[...host.querySelectorAll('button')].find(b=>b.textContent===(ownPinned?'Открепить':'Закрепить'));assert.ok(button,'ярлык по собственному набору');
      await React.act(async()=>button.click());assert.deepEqual(calls,[['folder','own','a',!ownPinned]],'меню меняет только собственный набор');
    });
  }
}
it('R129 меню строки использует own для ярлыка и toggleFolderPinned, общий закреп не влияет',async()=>{
  // Один чат может быть закреплён глобально, но не в этой папке, и наоборот.
  await rowCase();await assert.rejects(rowCase(changed(menuRaw,'const pinnedHere = own ? own.includes(dm.id) : !!live.pinnedAt;','const pinnedHere = !!live.pinnedAt;')),/ярлык по собственному набору|меню меняет только/);
  await assert.rejects(rowCase(changed(menuRaw,'own && pinFolder ? toggleFolderPinned','false ? toggleFolderPinned')),/меню меняет только/);
});
it('R129 массовый закреп pinIn добавляет только отсутствующих, при полном наборе снимает всех',async()=>{
  // Кнопка массового выбора сравнивает набор папки, не глобальные pinnedAt.
  for(const own of [[],['a'],['a','b']]){
    const dms=[dm('a',true),dm('b',true)],calls:unknown[]=[];const mod=menuModule(dms,calls);let closed=0;
    await mounted(()=>React.createElement(mod.DmPickHead,{ids:['a','b'],isMuted:()=>false,onClose:()=>{closed++;},pinIn:{folderId:'own',own}}),async(_get,host)=>{
      const all=own.length===2;const button=host.querySelector<HTMLButtonElement>(`[aria-label="${all?'Открепить':'Закрепить'}"]`);assert.ok(button);
      await React.act(async()=>{button.click();await Promise.resolve();await Promise.resolve();});
      assert.deepEqual(calls,(all?['a','b']:['a','b'].filter(id=>!own.includes(id))).map(id=>['folder','own',id,!all]));assert.equal(closed,1);
    });
  }
});
async function serialCase(raw=menuRaw){
  const jobs=[deferred<void>(),deferred<void>()],calls:string[]=[];const mod=menuModule([dm('a'),dm('b')],[],raw,async(_fid,cid)=>{
    const i=calls.length;calls.push(cid);await jobs[i]!.promise;
  });
  await mounted(()=>React.createElement(mod.DmPickHead,{ids:['a','b'],isMuted:()=>false,onClose:()=>{},pinIn:{folderId:'own',own:[]}}),async(_get,host)=>{
    await React.act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Закрепить"]')!.click());
    assert.deepEqual(calls,['a'],'второй закреп ждёт первого');
    await React.act(async()=>jobs[0]!.resolve());assert.deepEqual(calls,['a','b']);await React.act(async()=>jobs[1]!.resolve());
  });
}
it('R129 массовые закрепы папки отправляются последовательно, не затирают ответы друг друга',async()=>{
  // Каждый ответ заменяет весь список папок, поэтому параллельные pinChat теряли бы соседний закреп.
  await serialCase();
  await assert.rejects(serialCase(changed(menuRaw,'if (pinIn) void list.reduce<Promise<void>>((p, d) => p.then(() => toggleFolderPinned(pinIn.folderId, d.id, on)), Promise.resolve());',
    'if (pinIn) void Promise.all(list.map((d) => toggleFolderPinned(pinIn.folderId, d.id, on)));')),/ждёт первого/);
});
it('R129 свайп pinFolder закрепляет только папку, без неё работает общий путь',()=>{
  // Настройка свайпа не должна менять общий закреп, когда открыта папка со своим набором.
  const calls:unknown[]=[];const command=(kind:string)=>(...args:unknown[])=>{calls.push([kind,...args]);return Promise.resolve();};
  const mod=whole<typeof ListSwipe>(swipeRaw,{react:React,'../chatSwipe':swipe,'../dmFolderView':view,'../store':{useStore:{getState:()=>({})}},
    './DmChatView':{toggleDmPinned:command('global')},'./DmFolderBar':{toggleFolderPinned:command('folder')}});
  for(const pinned of [false,true]){
    mod.runSwipeAction(dm('a'),'pin',{pinned,unread:false,muted:false,archived:false,pinFolder:'own'});
    mod.runSwipeAction(dm('a'),'pin',{pinned,unread:false,muted:false,archived:false});
  }
  assert.deepEqual(calls,[['folder','own','a',true],['global','a',true],['folder','own','a',false],['global','a',false]]);
});

async function liveCase(phase:'cold'|'live',raw=barRaw,pinSet=true){
  const requests:unknown[]=[];const useFolders=folders({dmFolderPinOwn:async(plan:unknown)=>{requests.push(json(plan));return{folders:[folder('own',true,['a'])]};}});
  useFolders.setState({folders:[folder('own',false,[])],activeId:'own',load:async()=>{}});
  const state={convActive:true,serverFeatures:pinSet?['folders1','pinorder2','pinset1']:['folders1','pinorder2'],conv:{phase}};
  const useStore=Object.assign((select:(s:typeof state)=>unknown)=>select(state),{getState:()=>state});
  const mod=whole<typeof FolderBar>(raw,{react:React,'@gusvoice/shared':shared,'../dmFolders':{useDmFolders:useFolders,serverFolders:(f:string[])=>f.includes('folders1')},
    '../convSyncRules':sync,'../dmFolderView':view,'../dmListRules':list,'../store':{useStore},'./Icon':{Icon:()=>null}});
  await mounted(()=>mod.useDmFolderUi({dms:phase==='live'?[dm('a',true)]:[],unreadOf:()=>0,isMuted:()=>false,openId:null,phone:true}),async get=>{
    assert.equal(requests.length,phase==='live'&&pinSet?1:0,'перевод ждёт догнанный список бесед');
    assert.equal(useFolders.getState().pinSet,pinSet);
    if(phase==='live'&&pinSet){assert.deepEqual(requests,[[{id:'own',ids:['a']}]]);assert.deepEqual(Array.from(get().ownPins!),['a']);}
    if(!pinSet)assert.equal(get().ownPins,null,'старый сервер остаётся с общим закрепом');
  });
}
it('R129 перевод папок ждёт conv.phase live и переносит видимые закрепы вместо пустого cold',async()=>{
  // Пустой ещё не догнанный список не должен перевести папку в навсегда пустой набор.
  await liveCase('cold');await liveCase('live');
  await assert.rejects(liveCase('cold',changed(barRaw,'!enabled || !pinSetOn || !listLive || !folders','!enabled || !pinSetOn || !folders')),/ждёт догнанный список/);
});
it('R129 live без pinset1 не переводит папку и оставляет общий набор',async()=>{
  // Догнанный список сам по себе не должен отправлять неизвестную ручку старому серверу.
  await liveCase('live',barRaw,false);
});
it('R129 отказ закрепа папки показывает отдельный тост предела, остальные ошибки — общий',async()=>{
  // Переполненный набор должен сообщить доступный предел, а не выглядеть как молчаливый отказ кнопки.
  for(const limited of [false,true]){
    const calls:unknown[]=[];const err=limited?{reason:'folders.pin_limit',max:100}:new Error('нет сети');
    const mod=whole<typeof FolderBar>(barRaw,{react:React,'@gusvoice/shared':shared,'../dmFolderView':view,
      '../dmFolders':{useDmFolders:{getState:()=>({pinChat:async()=>{throw err;}})}},
      '../toast':{toast:(...args:unknown[])=>calls.push(['toast',...args]),toastError:(e:unknown)=>calls.push(['error',e])}});
    await mod.toggleFolderPinned('own','a',true);
    assert.deepEqual(calls,limited?[['toast','error',view.dmFolderPinLimitText(100)]]:[['error',err]]);
  }
});

it('R129 sidebar передаёт набор папки массовому выбору и свайпу, поиск остаётся общим',()=>{
  // Верные изолированные кнопки не спасут, если список не передал им область собственного набора.
  const raw=source('./components/DmSidebar.tsx');
  const check=(text:string)=>{
    const tree=ts.createSourceFile('DmSidebar.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    const vars=new Map<string,string>();let pinIn:string|undefined;const calls:string[]=[];
    const visit=(n:ts.Node)=>{
      if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.initializer)vars.set(n.name.text,n.initializer.getText(tree).replace(/\s/g,''));
      if(ts.isJsxAttribute(n)&&n.name.getText(tree)==='pinIn'&&n.initializer&&ts.isJsxExpression(n.initializer))pinIn=n.initializer.expression?.getText(tree).replace(/\s/g,'');
      if(ts.isCallExpression(n)&&n.expression.getText(tree)==='folderOwnPinRows')calls.push(n.getText(tree).replace(/\s/g,''));
      ts.forEachChild(n,visit);
    };visit(tree);
    assert.equal(vars.get('ownPinsHere'),'query.trim()||inArchive?null:folderUi.ownPins','поиск и архив не наследуют набор папки');
    assert.match(vars.get('rowOf')??'',/pinned:ownPinsHere\?ownPinsHere\.includes\(d\.id\):!!d\.pinnedAt/,'свайп получает состояние набора');
    assert.match(vars.get('rowOf')??'',/pinFolder:ownPinsHere\?folderUi\.pinFolder\?\.id:undefined/,'свайп получает id папки');
    assert.equal(pinIn,'ownPinsHere&&folderUi.pinFolder?{folderId:folderUi.pinFolder.id,own:ownPinsHere}:null','массовый выбор получает набор папки');
    assert.deepEqual(calls,['folderOwnPinRows(ordered.filter(folderUi.keep),folderUi.ownPins)'],'показ строк использует собственный набор');
  };
  check(raw);
  for(const[from,to,msg]of[
    ['query.trim() || inArchive ? null : folderUi.ownPins','folderUi.ownPins','поиск и архив не наследуют'],
    ['pinned: ownPinsHere ? ownPinsHere.includes(d.id) : !!d.pinnedAt','pinned: !!d.pinnedAt','свайп получает состояние'],
    ['pinFolder: ownPinsHere ? folderUi.pinFolder?.id : undefined','pinFolder: undefined','свайп получает id'],
    ['pinIn={ownPinsHere && folderUi.pinFolder ? { folderId: folderUi.pinFolder.id, own: ownPinsHere } : null}','pinIn={null}','массовый выбор получает'],
  ])assert.throws(()=>check(changed(raw,from!,to!)),new RegExp(msg!));
});

it('R131 Ctrl+9 из своей папки включает архив, который обнуляет ownPinsHere без смены вкладки',()=>{
  // Репро R129: архив открывается поверх активной папки, поэтому одного сброса на смену вкладки недостаточно.
  const raw=source('./components/DmSidebar.tsx');
  const check=(text:string)=>{
    const tree=ts.createSourceFile('DmSidebar.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    let condition:ts.ConditionalExpression|undefined,keyBody:string|undefined;
    const visit=(n:ts.Node)=>{
      if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.name.text==='ownPinsHere'&&n.initializer&&ts.isConditionalExpression(n.initializer))condition=n.initializer;
      if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.name.text==='onKey'&&n.initializer&&ts.isArrowFunction(n.initializer)&&n.initializer.body.getText(tree).includes("'Digit9'"))keyBody=n.initializer.body.getText(tree).replace(/\s/g,'');
      ts.forEachChild(n,visit);
    };visit(tree);
    assert.ok(keyBody);assert.match(keyBody,/e\.code!=='Digit9'/);assert.match(keyBody,/e\.ctrlKey\|\|e\.metaKey/);
    assert.match(keyBody,/setInArchive\(true\)/,'Ctrl+9 включает архив');
    assert.doesNotMatch(keyBody,/\.select\(|activeId|setActive/,'Ctrl+9 не выбирает другую вкладку');
    assert.ok(condition&&ts.isBinaryExpression(condition.condition));
    assert.equal(condition.condition.operatorToken.kind,ts.SyntaxKind.BarBarToken);
    assert.equal(condition.condition.right.getText(tree),'inArchive','архив входит в отсев собственного набора');
    assert.equal(condition.whenTrue.kind,ts.SyntaxKind.NullKeyword,'при архиве набор обнулён');
    assert.equal(condition.whenFalse.getText(tree),'folderUi.ownPins','в своей папке набор остаётся');
  };
  check(raw);
  assert.throws(()=>check(changed(raw,'query.trim() || inArchive ? null : folderUi.ownPins','query.trim() ? null : folderUi.ownPins')),assert.AssertionError);
});

it('R131 архив без ownPins использует общий закреп для массовой кнопки и свайпа',async()=>{
  // Проверяется потребитель после AST-проводки Ctrl+9: скрытая под архивом папка не должна получить pinChat.
  const calls:unknown[]=[];const dms=[{...dm('archived',true),archived:true}];const mod=menuModule(dms,calls);
  await mounted(()=>React.createElement(mod.DmPickHead,{ids:['archived'],isMuted:()=>false,onClose:()=>{},pinIn:null}),async(_get,host)=>{
    const button=host.querySelector<HTMLButtonElement>('[aria-label="Открепить"]');assert.ok(button,'ярлык архива по общему pinnedAt');
    await React.act(async()=>button.click());assert.deepEqual(calls,[['global','archived',false]],'массовая кнопка открепляет общий список');
  });
  calls.length=0;const command=(kind:string)=>(...args:unknown[])=>{calls.push([kind,...args]);return Promise.resolve();};
  const swipeMod=whole<typeof ListSwipe>(swipeRaw,{react:React,'../chatSwipe':swipe,'../dmFolderView':view,'../store':{useStore:{getState:()=>({})}},
    './DmChatView':{toggleDmPinned:command('global')},'./DmFolderBar':{toggleFolderPinned:command('folder')}});
  swipeMod.runSwipeAction(dms[0]!,'pin',{pinned:true,unread:false,muted:false,archived:true,pinFolder:undefined});
  assert.deepEqual(calls,[['global','archived',false]],'свайп архива открепляет общий список');
});
