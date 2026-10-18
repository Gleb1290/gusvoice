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

const videoPipSource = readFileSync(new URL('./videoPip.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** Изолируем весь модуль, включая общий host и callback, а не переписываем его ветки в тесте. */
function streamPipHarness(source = videoPipSource, options: { requestError?: Error; playError?: Error } = {}) {
  const nodes: FakeVideo[] = [];
  const played: { stream: MediaStream | null; muted: boolean; src: string | null }[] = [];
  const calls: string[] = [];
  let requests = 0;
  let exits = 0;
  class FakeVideo extends EventTarget {
    isConnected = true;
    style = { cssText: '' };
    readyState = 1;
    currentTime = 0;
    playbackRate = 1;
    loop = false;
    muted = false;
    srcObject: MediaStream | null = null;
    paused = 0;
    loaded = 0;
    attrs = new Map<string, string>();
    setAttribute(key: string, value: string) { this.attrs.set(key, value); }
    getAttribute(key: string) { return this.attrs.get(key) ?? null; }
    removeAttribute(key: string) { this.attrs.delete(key); }
    pause() { this.paused++; }
    load() { this.loaded++; }
    play() {
      calls.push('play');
      played.push({ stream: this.srcObject, muted: this.muted, src: this.getAttribute('src') });
      return options.playError ? Promise.reject(options.playError) : Promise.resolve();
    }
    async requestPictureInPicture() {
      calls.push('request');
      requests++;
      if (options.requestError) throw options.requestError;
      doc.pictureInPictureElement = this;
    }
  }
  const doc = {
    pictureInPictureEnabled: true,
    pictureInPictureElement: null as FakeVideo | null,
    createElement: () => new FakeVideo(),
    body: { appendChild: (video: FakeVideo) => { nodes.push(video); } },
    async exitPictureInPicture() {
      exits++;
      const video = doc.pictureInPictureElement;
      doc.pictureInPictureElement = null;
      video?.dispatchEvent(new Event('leavepictureinpicture'));
    },
  };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, document: doc, HTMLVideoElement: FakeVideo, Event });
  return {
    api: module.exports as typeof import('./videoPip'), doc, nodes, played, calls, FakeVideo,
    get requests() { return requests; },
    get exits() { return exits; },
  };
}

function fakeStream(id: string): MediaStream {
  // Здесь важна идентичность объекта: дорожками владеет комната, а не PiP.
  return { id } as MediaStream;
}

async function checkStreamStarts(source = videoPipSource) {
  const h = streamPipHarness(source);
  const stream = fakeStream('показ');
  let leaves = 0;
  await h.api.openStreamVideoPip(stream, () => { leaves++; });
  assert.equal(h.nodes.length, 1);
  assert.equal(h.nodes[0].srcObject, stream, 'PiP обязан показывать переданный поток');
  assert.equal(h.nodes[0].muted, true, 'звук показа уже играет через комнату');
  assert.deepEqual(h.played, [{ stream, muted: true, src: null }], 'источник и мьют задаются до play');
  assert.equal(h.nodes[0].loop, false);
  assert.equal(h.nodes[0].playbackRate, 1);
  assert.equal(h.requests, 1);
  assert.deepEqual(h.calls, ['play', 'request']);
  assert.equal(h.doc.pictureInPictureElement, h.nodes[0]);
  assert.equal(leaves, 0);
}

async function checkStreamLeaves(source = videoPipSource) {
  const h = streamPipHarness(source);
  let leaves = 0;
  let streamAtCallback: MediaStream | null | undefined;
  await h.api.openStreamVideoPip(fakeStream('показ'), () => {
    leaves++;
    streamAtCallback = h.nodes[0].srcObject;
  });
  h.doc.pictureInPictureElement = null;
  h.nodes[0].dispatchEvent(new Event('leavepictureinpicture'));
  assert.equal(leaves, 1, 'закрытие обязано сообщить владельцу показа');
  assert.equal(streamAtCallback, null, 'callback уже видит освобождённый поток');
  assert.equal(h.nodes[0].srcObject, null);
  assert.equal(h.nodes[0].getAttribute('src'), null);
  assert.equal(h.nodes[0].paused, 1);
  assert.equal(h.nodes[0].loaded, 1);
  h.nodes[0].dispatchEvent(new Event('leavepictureinpicture'));
  h.api.closeStreamVideoPip();
  assert.equal(leaves, 1, 'старый обработчик не вызывается повторно');
  assert.equal(h.exits, 0);
}

async function checkStreamRequestRefusal(source = videoPipSource) {
  const refused = new Error('браузер отклонил жест после play');
  const options: { requestError?: Error } = { requestError: refused };
  const h = streamPipHarness(source, options);
  const first = fakeStream('отклонённый показ');
  let refusedLeaves = 0;
  await assert.rejects(
    () => h.api.openStreamVideoPip(first, () => { refusedLeaves++; }),
    error => error === refused,
    'отказ PiP передаёт исходный объект ошибки',
  );
  assert.deepEqual(h.calls, ['play', 'request'], 'отказ проверяется после запуска потока');
  assert.deepEqual(h.played, [{ stream: first, muted: true, src: null }]);
  assert.equal(h.nodes[0].srcObject, null, 'отказ PiP освобождает поток скрытого элемента');
  assert.equal(h.nodes[0].paused, 1, 'отказ PiP останавливает скрытый элемент');
  assert.equal(h.doc.pictureInPictureElement, null);
  assert.equal(refusedLeaves, 0, 'неоткрытое окно не сообщает о закрытии');
  h.api.closeStreamVideoPip();
  assert.equal(h.exits, 0);
  assert.equal(refusedLeaves, 0);

  // Отказ не отравляет общий host: следующий жест может быть разрешён браузером.
  delete options.requestError;
  const second = fakeStream('повторный показ');
  let secondLeaves = 0;
  await h.api.openStreamVideoPip(second, () => { secondLeaves++; });
  assert.equal(h.nodes.length, 1);
  assert.equal(h.requests, 2);
  assert.equal(h.nodes[0].srcObject, second);
  assert.equal(h.doc.pictureInPictureElement, h.nodes[0]);
  assert.equal(refusedLeaves, 0);
  assert.equal(secondLeaves, 0);
  h.api.closeStreamVideoPip();
  await Promise.resolve();
  assert.equal(h.nodes[0].srcObject, null);
  assert.equal(secondLeaves, 1);
  assert.equal(refusedLeaves, 0, 'повторное открытие не воскрешает callback отказавшего показа');
}

it('показ открывается немым и начинает играть перед запросом окошка', async () => {
  // Класс ошибки: двойной звук или пустой кадр из-за потерянного srcObject.
  await checkStreamStarts();
});

it('закрытие окошка отпускает поток и вызывает его владельца ровно один раз', async () => {
  // Класс ошибки: невидимый поток продолжает жить или закрытие применяется дважды.
  await checkStreamLeaves();
});

it('ролик после показа освобождает поток, возвращает звук и не наследует старый callback', async () => {
  // Класс ошибки: srcObject сильнее src, поэтому вместо ролика остаётся старый показ.
  const h = streamPipHarness();
  let leaves = 0;
  let streamAtCallback: MediaStream | null | undefined;
  await h.api.openStreamVideoPip(fakeStream('показ'), () => {
    leaves++;
    streamAtCallback = h.nodes[0].srcObject;
  });
  await h.api.openPip({ url: '/ролик.mp4', at: 9, rate: 1.5, loop: true });
  assert.equal(leaves, 1);
  assert.equal(streamAtCallback, null);
  assert.equal(h.nodes.length, 1);
  assert.equal(h.nodes[0].srcObject, null);
  assert.equal(h.nodes[0].getAttribute('src'), '/ролик.mp4');
  assert.equal(h.nodes[0].muted, false);
  assert.equal(h.nodes[0].currentTime, 9);
  assert.equal(h.nodes[0].playbackRate, 1.5);
  assert.equal(h.nodes[0].loop, true);
  assert.deepEqual(h.played[1], { stream: null, muted: false, src: '/ролик.mp4' });
  assert.equal(h.requests, 1);
  h.api.closeStreamVideoPip();
  assert.equal(h.exits, 0, 'закрытие показа не должно закрыть занявший окошко ролик');
  assert.equal(h.nodes[0].getAttribute('src'), '/ролик.mp4');
  h.nodes[0].dispatchEvent(new Event('leavepictureinpicture'));
  assert.equal(leaves, 1);
  assert.equal(h.nodes[0].getAttribute('src'), null);
});

it('показ после ролика снимает файловый источник, скорость и повтор', async () => {
  // Класс ошибки: настройки файлового плеера протекают в живой поток.
  const h = streamPipHarness();
  await h.api.openPip({ url: '/ролик.mp4', rate: 2, loop: true });
  const stream = fakeStream('новый показ');
  await h.api.openStreamVideoPip(stream, () => {});
  assert.equal(h.nodes.length, 1);
  assert.equal(h.requests, 1);
  assert.equal(h.nodes[0].getAttribute('src'), null);
  assert.equal(h.nodes[0].srcObject, stream);
  assert.equal(h.nodes[0].muted, true);
  assert.equal(h.nodes[0].loop, false);
  assert.equal(h.nodes[0].playbackRate, 1);
  assert.deepEqual(h.played[1], { stream, muted: true, src: null });
});

it('новый показ в том же окошке завершает старого владельца, но оставляет нового до закрытия', async () => {
  // Класс ошибки: callback предыдущего показа теряется или закрывает следующий показ.
  const h = streamPipHarness();
  const leaves: string[] = [];
  await h.api.openStreamVideoPip(fakeStream('первый'), () => { leaves.push('первый'); });
  const second = fakeStream('второй');
  await h.api.openStreamVideoPip(second, () => { leaves.push('второй'); });
  assert.deepEqual(leaves, ['первый']);
  assert.equal(h.nodes.length, 1);
  assert.equal(h.requests, 1);
  assert.equal(h.nodes[0].srcObject, second);
  h.nodes[0].dispatchEvent(new Event('leavepictureinpicture'));
  h.nodes[0].dispatchEvent(new Event('leavepictureinpicture'));
  assert.deepEqual(leaves, ['первый', 'второй']);
  assert.equal(h.nodes[0].srcObject, null);
});

it('явное закрытие активного показа выходит через API, а повторное закрытие ничего не делает', async () => {
  // Класс ошибки: повторный exit либо закрытие чужого окна после завершения показа.
  const h = streamPipHarness();
  h.api.closeStreamVideoPip();
  assert.equal(h.nodes.length, 0);
  let leaves = 0;
  await h.api.openStreamVideoPip(fakeStream('показ'), () => { leaves++; });
  h.api.closeStreamVideoPip();
  await Promise.resolve();
  assert.equal(h.exits, 1);
  assert.equal(h.doc.pictureInPictureElement, null);
  assert.equal(h.nodes[0].srcObject, null);
  assert.equal(leaves, 1);
  h.api.closeStreamVideoPip();
  assert.equal(h.exits, 1);
  assert.equal(leaves, 1);
});

it('закрытие показа без активного браузерного окошка очищает элемент без exit API', async () => {
  // Класс ошибки: потеря браузерного окна оставляет поток и владельца висеть в host.
  const h = streamPipHarness();
  let leaves = 0;
  await h.api.openStreamVideoPip(fakeStream('показ'), () => { leaves++; });
  h.doc.pictureInPictureElement = null;
  h.api.closeStreamVideoPip();
  assert.equal(h.exits, 0);
  assert.equal(h.nodes[0].srcObject, null);
  assert.equal(h.nodes[0].paused, 1);
  assert.equal(h.nodes[0].loaded, 1);
  assert.equal(leaves, 1);
  h.api.closeStreamVideoPip();
  assert.equal(leaves, 1);
});

it('без разрешённого API показ отвергается до создания элемента и вызова владельца', async () => {
  // Класс ошибки: неподдерживаемая платформа создаёт невидимый играющий поток.
  const h = streamPipHarness();
  let leaves = 0;
  h.doc.pictureInPictureEnabled = false;
  await assert.rejects(() => h.api.openStreamVideoPip(fakeStream('показ'), () => { leaves++; }), /pip unsupported/);
  assert.equal(h.nodes.length, 0);
  assert.equal(h.played.length, 0);
  assert.equal(leaves, 0);
  h.doc.pictureInPictureEnabled = true;
  Object.defineProperty(h.FakeVideo.prototype, 'requestPictureInPicture', { value: undefined });
  await assert.rejects(() => h.api.openStreamVideoPip(fakeStream('показ'), () => { leaves++; }), /pip unsupported/);
  assert.equal(h.nodes.length, 0);
  assert.equal(leaves, 0);
});

it('отказ браузера открыть окошко передаётся вызывающему без ложного callback закрытия', async () => {
  // Класс ошибки: запрет браузера маскируется успешным открытием или событием закрытия.
  const refused = new Error('браузер отклонил жест');
  const h = streamPipHarness(videoPipSource, { requestError: refused });
  let leaves = 0;
  await assert.rejects(() => h.api.openStreamVideoPip(fakeStream('показ'), () => { leaves++; }), (error) => error === refused);
  assert.equal(h.requests, 1);
  assert.equal(h.doc.pictureInPictureElement, null);
  assert.equal(leaves, 0);
});

it('отказ после play освобождает и останавливает поток, сохраняя возможность повторного открытия', async () => {
  // Класс ошибки: браузер отказал, но невидимый элемент продолжает удерживать живой поток.
  await checkStreamRequestRefusal();
});

it('отказ play не подменяет успешное открытие окошка и последующее освобождение показа', async () => {
  // Класс ошибки: запрет автозапуска не даёт даже попытаться открыть PiP по жесту.
  const h = streamPipHarness(videoPipSource, { playError: new Error('autoplay denied') });
  let leaves = 0;
  await h.api.openStreamVideoPip(fakeStream('показ'), () => { leaves++; });
  assert.equal(h.played.length, 1);
  assert.equal(h.requests, 1);
  h.api.closeStreamVideoPip();
  await Promise.resolve();
  assert.equal(h.nodes[0].srcObject, null);
  assert.equal(leaves, 1);
});

function changeOnce(needle: string, replacement: string): string {
  assert.equal(videoPipSource.split(needle).length - 1, 1, 'контрфакт обязан менять ровно одно место целого модуля');
  return videoPipSource.replace(needle, replacement);
}

it('контрфакт потерянного srcObject отвергается тем же сценарием после проверки оригинала', async () => {
  // Класс ошибки: тест проверяет только вызов API, но не реальный источник кадра.
  await checkStreamStarts();
  const mutant = changeOnce('v.srcObject = stream;', 'v.srcObject = null;');
  await assert.rejects(() => checkStreamStarts(mutant), error => error instanceof assert.AssertionError
    && error.message.startsWith('PiP обязан показывать переданный поток'));
});

it('контрфакт слышимого показа отвергается тем же сценарием после проверки оригинала', async () => {
  // Класс ошибки: второй звук показа проходит незамеченным при успешном PiP.
  await checkStreamStarts();
  const mutant = changeOnce('v.muted = true;', 'v.muted = false;');
  await assert.rejects(() => checkStreamStarts(mutant), error => error instanceof assert.AssertionError
    && error.message.startsWith('звук показа уже играет через комнату'));
});

it('контрфакт потерянного callback отвергается закрытием после проверки оригинала', async () => {
  // Класс ошибки: окно закрыто, но владелец продолжает считать показ открытым.
  await checkStreamLeaves();
  const mutant = changeOnce('onStreamLeave = onLeave;', 'onStreamLeave = null;');
  await assert.rejects(() => checkStreamLeaves(mutant), error => error instanceof assert.AssertionError
    && error.message.startsWith('закрытие обязано сообщить владельцу показа'));
});

it('контрфакт потери очистки при отказе PiP отвергается после проверки оригинала', async () => {
  // Класс ошибки: возврат ошибки R254 оставляет srcObject у уже запущенного скрытого видео.
  await checkStreamRequestRefusal();
  const mutant = changeOnce('    v.pause();\n    v.srcObject = null;\n    throw e;', '    v.pause();\n    throw e;');
  await assert.rejects(() => checkStreamRequestRefusal(mutant), error => error instanceof assert.AssertionError
    && error.message.startsWith('отказ PiP освобождает поток скрытого элемента'));
});

it('контрфакт потери pause при отказе PiP отвергается после проверки оригинала', async () => {
  // Класс ошибки: снятие источника без остановки скрытого плеера оставляет воспроизведение активным.
  await checkStreamRequestRefusal();
  const mutant = changeOnce('    v.pause();\n    v.srcObject = null;\n    throw e;', '    v.srcObject = null;\n    throw e;');
  await assert.rejects(() => checkStreamRequestRefusal(mutant), error => error instanceof assert.AssertionError
    && error.message.startsWith('отказ PiP останавливает скрытый элемент'));
});
