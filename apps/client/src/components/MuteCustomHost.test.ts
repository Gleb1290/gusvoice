import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { before, after, it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as list from '../dmListRules';
import * as sched from '../schedRules';
import * as words from '../plural';
import type * as SchedModule from './SchedPick';
import type * as HostModule from './MuteCustomHost';

const read=(name:string)=>readFileSync(new URL(name,import.meta.url),'utf8').replace(/\r\n/g,'\n');
const raw=read('./MuteCustomHost.tsx'),schedRaw=read('./SchedPick.tsx'),chromeRaw=read('../dialogChrome.ts');
let createRoot:typeof import('react-dom/client')['createRoot'];
before(async()=>{GlobalRegistrator.register();Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  // React проверяет поддержку input при импорте: HappyDOM без этой стандартной DOM-возможности выбирает IE-полифил.
  Object.defineProperty(document,'oninput',{value:null,configurable:true});
  createRoot=(await import('react-dom/client')).createRoot;
});
after(()=>GlobalRegistrator.unregister());
function whole<T>(source:string,deps:Record<string,unknown>):T{
  const module={exports:{}};
  // Целые Host, SchedPick и dialogChrome: отмена, поля и замок остаются настоящими.
  runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,
    {module,exports:module.exports,window,document,CustomEvent,Date,setTimeout,clearTimeout,setInterval,clearInterval,
      require:(id:string)=>{assert.ok(id in deps,`зависимость ${id}`);return deps[id];}});
  return module.exports as T;
}
function changed(from:string,to:string){assert.ok(raw.includes(from),`якорь ${from}`);return raw.replaceAll(from,to);}
function propsOf<T>(el:Element):T{
  const key=Object.keys(el).find(k=>k.startsWith('__reactProps$'));assert.ok(key);
  return(el as unknown as Record<string,T>)[key]!;
}
type Case={phone?:boolean;error?:boolean;invalid?:boolean;mode?:'default'|'custom'|'zeros'|'empty'|'days99'|'cancel'|'escape'|'close'|'double'|'enter'|'compose'|'buttonEnter'};
async function scene(a:Case={},source=raw){
  const calls:unknown[]=[];const errors:unknown[]=[];let closed=0;
  const phone=!!a.phone;
  const react={...React,useState:(initial:unknown)=>{
    const[v,set]=React.useState(initial);
    return initial===null?[v,(next:unknown)=>{if(next===null)closed++;set(next);}]:[v,set];
  }};
  const chrome=whole<{useDialogChrome:typeof import('../dialogChrome')['useDialogChrome']}>(chromeRaw,
    {react:React,'./androidBack':{layerAbove:()=>false}});
  const shell={BottomSheet:({title,onClose,children}:{title:string;onClose:()=>void;children:React.ReactNode})=>
    React.createElement('section',{'aria-label':title},React.createElement('h2',null,title),React.createElement('button',{className:'icon-close',onClick:onClose},'Закрыть'),children)};
  const fields=whole<typeof SchedModule>(schedRaw,{react:React,'react/jsx-runtime':jsx,'../dialogChrome':chrome,
    '../phoneLayout':{usePhoneLayout:()=>phone},'../schedRules':sched,'./BottomSheet':shell,'./Icon':{Icon:()=>null}});
  const host=whole<typeof HostModule>(source,{react,'react/jsx-runtime':jsx,'../dmListRules':list,'../phoneLayout':{usePhoneLayout:()=>phone},
    '../plural':words,'../schedRules':sched,'./BottomSheet':shell,'./SchedPick':fields,'../toast':{toastError:(e:unknown)=>errors.push(e)},
    '../store':{useStore:{getState:()=>({setPushMuted:(...args:unknown[])=>{calls.push(args);return a.error?Promise.reject(new Error('отказ мьюта')):Promise.resolve();}})}}});
  const mount=document.createElement('div');document.body.append(mount);const root=createRoot(mount);
  const go=()=>[...mount.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='Выключить')!;
  const field=(label:string)=>mount.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const edit=async(label:string,value:string)=>{
    await React.act(async()=>propsOf<{onChange:(e:{target:{value:string}})=>void}>(field(label)).onChange({target:{value}}));
  };
  try{
    await React.act(async()=>root.render(React.createElement(host.MuteCustomHost)));
    assert.equal(mount.querySelector('input'),null,'без события окно закрыто');
    if(a.invalid){
      for(const detail of [undefined,null,'',0,{},['peer']])await React.act(async()=>window.dispatchEvent(new CustomEvent(list.MUTE_CUSTOM_EVENT,{detail})));
      assert.equal(mount.querySelector('input'),null,'нестроковый и пустой id не открывают окно');assert.deepEqual(calls,[]);return;
    }
    await React.act(async()=>window.dispatchEvent(new CustomEvent(list.MUTE_CUSTOM_EVENT,{detail:'peer'})));
    assert.deepEqual(['Дни','Часы','Минуты'].map(label=>field(label).value),['00','08','00'],'начальный срок 8 часов');
    assert.ok(mount.textContent?.includes('Выключить уведомления на…'));assert.equal(go().disabled,false);
    if(a.mode==='custom'){await edit('Дни','02');await edit('Часы','05');await edit('Минуты','00');}
    if(a.mode==='days99'){await edit('Дни','99');assert.equal(field('Дни').value,'31','поле дней зажимается до 31');return;}
    if(a.mode==='empty'){await edit('Часы','');}
    if(a.mode==='zeros'){for(const label of ['Дни','Часы','Минуты'])await edit(label,'00');}
    if(a.mode==='zeros'||a.mode==='empty'){
      assert.equal(go().disabled,true,'нулевой или неполный срок отключает кнопку');
      await React.act(async()=>{go().click();field('Часы').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));});
      assert.deepEqual(calls,[],'Enter не шлёт пустой срок');assert.equal(closed,0);return;
    }
    if(a.mode==='cancel'||a.mode==='escape'||a.mode==='close'){
      await React.act(async()=>{
        if(a.mode==='escape')window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
        else if(a.mode==='close')mount.querySelector<HTMLButtonElement>('.icon-close')!.click();
        else [...mount.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='Отмена')!.click();
      });
      assert.deepEqual(calls,[],'отмена не выключает уведомления');assert.equal(closed,1);assert.equal(mount.querySelector('input'),null);return;
    }
    if(a.mode==='compose'||a.mode==='buttonEnter'){
      await React.act(async()=>{
        const target=a.mode==='buttonEnter'?go():field('Часы');
        target.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:a.mode==='compose',bubbles:true,cancelable:true}));
      });assert.deepEqual(calls,[],'композиция и Enter на кнопке не отправляются обработчиком поля');return;
    }
    await React.act(async()=>{
      if(a.mode==='enter')field('Часы').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
      else{const button=go();button.click();if(a.mode==='double')button.click();}
    });
    assert.deepEqual(json(calls),[['dm_user','peer',true,a.mode==='custom'?190800:28800]],'в API уходят точные секунды ровно один раз');
    assert.equal(closed,1,'окно закрывается ровно раз');assert.equal(mount.querySelector('input'),null,'finally закрывает окно');
    assert.equal(errors.length,a.error?1:0,'отказ сообщён через toastError');
    if(a.error)assert.match(String(errors[0]),/отказ мьюта/);
  }finally{await React.act(async()=>root.unmount());mount.remove();}
}
const json=(value:unknown)=>JSON.parse(JSON.stringify(value));
it('R130 событие без строкового id не открывает свой срок',async()=>scene({invalid:true}));
it('R130 свой срок открывается 00/08/00 и передаёт 28800 секунд',async()=>scene());
it('R130 свой срок 02/05/00 передаёт 190800 секунд',async()=>scene({mode:'custom'}));
it('R130 поле дней зажимает 99 до 31',async()=>scene({mode:'days99'}));
it('R130 нули отключают кнопку и Enter не отправляет',async()=>scene({mode:'zeros'}));
it('R130 неполное поле отключает кнопку и Enter не отправляет',async()=>scene({mode:'empty'}));
it('R130 Enter в поле отправляет точный срок',async()=>scene({mode:'enter'}));
it('R130 Enter при композиции и на кнопке не дублирует отправку',async()=>{await scene({mode:'compose'});await scene({mode:'buttonEnter'});});
for(const mode of ['cancel','escape','close']as const)it(`R130 ${mode==='cancel'?'Отмена':mode==='escape'?'Esc':'крестик'} закрывает окно без вызова API`,async()=>scene({mode}));
it('R130 ошибка API показывает тост и finally закрывает окно',async()=>scene({error:true}));
it('R130 двойной клик заблокирован до размонтирования окна',async()=>scene({mode:'double'}));
it('R130 телефонный вид сохраняет 8 часов и те же секунды',async()=>scene({phone:true}));
it('R130 четыре мутанта замка, disabled, секунд и finally отвергаются поведением',async()=>{
  // Стражи UI ловят не только неверную арифметику: повтор, доступную пустую кнопку и застрявшее окно.
  await scene({mode:'double'});await scene({mode:'zeros'});await scene({mode:'custom'});await scene({error:true});
  for(const[a,from,to,msg]of[
    [{mode:'double'},'if (seconds === null || done.current) return;','if (seconds === null) return;','точные секунды ровно один раз'],
    [{mode:'zeros'},'disabled={seconds === null}','disabled={false}','отключает кнопку'],
    [{mode:'custom'},'onPick(seconds);','onPick(seconds / 60);','точные секунды'],
    [{error:true},'    } finally {\n      onClose();\n    }','    } finally {\n      // окно забыли закрыть\n    }','окно закрывается ровно раз'],
  ]as const)await assert.rejects(scene(a,changed(from,to)),(e:unknown)=>e instanceof assert.AssertionError&&e.message.includes(msg));
});
