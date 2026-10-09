import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
it('PiP отвергает отсутствие API, использует один общий элемент, закрытие окошка гасит звук и src',async()=>{
  // Ловит невидимый продолжающий играть звук и второй плеер при повторном открытии.
  const nodes: FakeVideo[]=[]; let requests=0; const attrs=new Map<FakeVideo,Map<string,string>>();
  class FakeVideo extends EventTarget {
    isConnected=true; style={cssText:''}; readyState=1; currentTime=0; playbackRate=1; loop=false; muted=false;
    paused=0; loaded=0;
    setAttribute(k:string,v:string){if(!attrs.has(this))attrs.set(this,new Map()); attrs.get(this)!.set(k,v);}
    getAttribute(k:string){return attrs.get(this)?.get(k)??null;}
    removeAttribute(k:string){attrs.get(this)?.delete(k);}
    pause(){this.paused++;} load(){this.loaded++;} play(){return Promise.resolve();}
    async requestPictureInPicture(){requests++; doc.pictureInPictureElement=this;}
  }
  const doc={pictureInPictureEnabled:true,pictureInPictureElement:null as FakeVideo|null,
    createElement:()=>new FakeVideo(),body:{appendChild:(v:FakeVideo)=>{nodes.push(v);}}};
  const source=readFileSync(new URL('./videoPip.ts',import.meta.url),'utf8'); const module={exports:{}};
  runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {module,exports:module.exports,document:doc,HTMLVideoElement:FakeVideo});
  const api=module.exports as typeof import('./videoPip');
  doc.pictureInPictureEnabled=false; await assert.rejects(()=>api.openPip({url:'/a'}),/unsupported/);
  doc.pictureInPictureEnabled=true; await api.openPip({url:'/a',at:7,rate:1.5,loop:true});
  await api.openPip({url:'/b',rate:2}); assert.equal(nodes.length,1); assert.equal(requests,1);
  assert.equal(nodes[0].playbackRate,2); assert.equal(nodes[0].getAttribute('src'),'/b');
  nodes[0].dispatchEvent(new Event('leavepictureinpicture'));
  assert.equal(nodes[0].paused,1); assert.equal(nodes[0].loaded,1); assert.equal(nodes[0].getAttribute('src'),null);
});
