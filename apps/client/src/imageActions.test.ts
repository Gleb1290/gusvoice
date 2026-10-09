import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';

const png = new Uint8Array([137,80,78,71,13,10,26,10,0,255]);
const att = {url:'/private/image',name:'photo.png',contentType:'image/png',size:10};
function fixture(mobile=false, native={ copy:false, save:false }) {
  const calls: unknown[][]=[];
  const tasks: (()=>void)[]=[];
  let response={ok:true,status:200,blob:async()=>new Blob([png],{type:'application/octet-stream'})};
  let copied: Record<string,Promise<Blob>> | undefined;
  let clicked=false;
  let nativeFails=false;
  const nativeCalls: unknown[][]=[];
  const anchor={href:'',download:'',rel:'',click:()=>{clicked=true;calls.push(['click']);},remove:()=>calls.push(['remove'])};
  const module={exports:{}};
  const raw=readFileSync(new URL('./imageActions.ts',import.meta.url),'utf8');
  const code=ts.transpileModule(raw,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  runInNewContext(code,{module,exports:module.exports,Blob,Uint8Array,
    ClipboardItem: class { constructor(data:Record<string,Promise<Blob>>){copied=data;} },
    navigator:{clipboard:{write:async()=>{await copied!['image/png'];}}},
    fetch:async(...args:unknown[])=>{calls.push(args);return response;},
    createImageBitmap:()=>{throw new Error('PNG не должен проходить через холст');},
    window:{setTimeout:(fn:()=>void)=>{tasks.push(fn);}},
    document:{createElement:(tag:string)=>{assert.equal(tag,'a');return anchor;},body:{appendChild:()=>calls.push(['append'])}},
    require:(id:string)=>id==='./api'?{api:{attachmentDownloadUrl:(a:typeof att)=>`/download${a.url}`}}:id==='./hotkeys'?{isMobile:()=>mobile}:id==='./nativeMedia'?{
      canCopyImageNative:()=>native.copy,canSaveImageNative:()=>native.save,
      copyImageNative:async(...args:unknown[])=>{nativeCalls.push(['copy',...args]);return {systemNotice:true};},
      saveImageNative:async(...args:unknown[])=>{nativeCalls.push(['save',...args]);if(nativeFails)throw new Error('denied');return {};},
    }:id==='./toast'?{toast:()=>{}}:(()=>{throw new Error(id);})(),
  });
  return {api:module.exports as typeof import('./imageActions'),calls,tasks,anchor,nativeCalls,failNative:()=>{nativeFails=true;},clicked:()=>clicked,copied:()=>copied!,response:(next:typeof response)=>{response=next;}};
}

it('ПК использует браузерные возможности, а телефон — две независимые нативные возможности',()=>{
  // Android 9 умеет копировать, но не сохранять: один общий флаг потерял бы рабочее действие.
  for(const mobile of [false,true]) for(const copy of [false,true]) for(const save of [false,true]) {
    const f=fixture(mobile,{copy,save});assert.equal(f.api.canCopyImage(),mobile?copy:true);assert.equal(f.api.canSaveImage(),mobile?save:true);
  }
});

it('телефон копирует и сохраняет через нативный адрес выдачи, возвращая системное подтверждение',async()=>{
  // Сборка PNG на телефоне здесь лишняя: натив уже получает исходные байты и подтверждает копирование.
  const f=fixture(true,{copy:true,save:true});
  assert.equal((await f.api.copyImage(att)).systemNotice,true);
  await f.api.saveImage(att);
  assert.deepEqual(f.nativeCalls,[['copy','/download/private/image','photo.png'],['save','/download/private/image','photo.png']]);
  assert.deepEqual(f.calls,[],'браузерный fetch не запускается в нативной ветке');
  assert.equal(f.tasks.length,0,'скачивание через браузерную ссылку на телефоне не запускается');
});

it('касание видео не подставляет соседнее единственное фото',()=>{
  // Видео-ячейка не имеет img: fallback к одному фото раньше обещал копирование чужого вложения.
  const {api}=fixture();const video={...att,url:'/video',contentType:'video/mp4'};
  const target={closest:()=>({querySelector:()=>null})} as unknown as Element;
  assert.equal(api.photoFromTouch([att,video],target),undefined);
});
it('касание ячейки выбирает вложение по src, неизвестная ссылка не подменяется соседней',()=>{
  // Второй элемент альбома нельзя молча заменить первым или единственным фото.
  const {api}=fixture();const other={...att,url:'/other',name:'other.png'};
  const target=(src:string)=>({closest:(selector:string)=>{assert.equal(selector,'.att-img-link');return{querySelector:()=>({getAttribute:()=>src})};}} as unknown as Element);
  assert.equal(api.photoFromTouch([att,other],target('/other')),other);
  assert.equal(api.photoFromTouch([att],target('/unknown')),undefined);
});

it('касание вне картинки выбирает только единственное доступное фото, а не неизвестный альбом',()=>{
  // Кеш без url не является доступным фото, а альбом требует явной цели ячейки.
  const {api}=fixture();const other={...att,url:'/other'};
  const outside={closest:()=>null} as unknown as Element;
  assert.equal(api.photoFromTouch([att],outside),att);
  assert.equal(api.photoFromTouch([att],null),att);
  assert.equal(api.photoFromTouch([att,other],null),undefined);
  assert.equal(api.photoFromTouch([{...att,url:''},att],null),att);
  assert.equal(api.photoFromTouch([{...att,url:''}],null),undefined);
  assert.equal(api.photoFromTouch(undefined,null),undefined);
});

it('PNG узнаётся по восьми байтам, короткий и повреждённый заголовок отвергаются',()=>{
  // MIME выдачи бывает octet-stream, но один совпавший байт не доказывает PNG.
  const {api}=fixture();assert.equal(api.isPngBytes(png),true);assert.equal(api.isPngBytes(png.slice(0,8)),true);
  for(let i=0;i<8;i++){const bad=png.slice();bad[i]^=1;assert.equal(api.isPngBytes(bad),false);assert.equal(api.isPngBytes(png.slice(0,i)),false);}
});

it('PNG запрашивается через выдачу без credentials и копируется без перегонки байтов',async()=>{
  // Перегонка готового PNG теряет качество, а credentials не должны уйти к хранилищу.
  const f=fixture();await f.api.copyImage(att);
  assert.equal(f.calls[0]![0],'/download/private/image');assert.equal((f.calls[0]![1] as RequestInit).credentials,'omit');
  const blob=await f.copied()['image/png'];assert.equal(blob.type,'image/png');assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),png);
});

it('отказ выдачи изображения не становится успешной записью в буфер',async()=>{
  // Тело HTTP ошибки нельзя выдать за картинку и показать ложный успех.
  const f=fixture();f.response({ok:false,status:403,blob:async()=>{throw new Error('не читать тело ошибки');}});
  await assert.rejects(f.api.copyImage(att),/HTTP 403/);
});

it('сохранение кликает ссылку только следующей задачей после закрытия меню',async()=>{
  // Синхронный клик поглощает перехват клика мимо меню у пузыря.
  const f=fixture();const pending=f.api.saveImage(att);
  assert.equal(f.clicked(),false);assert.equal(f.tasks.length,1);assert.equal(f.calls.length,0);
  f.tasks.shift()!();await pending;
  assert.equal(f.anchor.href,'/download/private/image');assert.equal(f.anchor.download,'photo.png');assert.equal(f.anchor.rel,'noopener');
  assert.deepEqual(f.calls,[['append'],['click'],['remove']]);
});
