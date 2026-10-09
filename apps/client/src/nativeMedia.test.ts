import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as attachRules from './attachRules';

type Wire = { onmessage: ((ev: { data: unknown }) => void) | null; postMessage(message: string | ArrayBuffer): void };
type NativeMedia = typeof import('./nativeMedia');

function fixture(onPost?: (message: string | ArrayBuffer, wire: Wire) => void, options: { userAgent?: string; bridge?: boolean } = {}, mutate?: (source: string) => string) {
  const posted: (string | ArrayBuffer)[] = [];
  const wire: Wire = {
    onmessage: null,
    postMessage(message) { posted.push(message); onPost?.(message, wire); },
  };
  const nativeWindow = { ...(options.bridge === false ? {} : { GusVoiceMedia: wire }), setTimeout, clearTimeout };
  const urls: { blob: Blob; url: string }[] = [];
  const module = { exports: {} as Record<string, unknown> };
  const source = readFileSync(new URL('./nativeMedia.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const code = ts.transpileModule(mutate ? mutate(source) : source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  runInNewContext(code, {
    module,
    exports: module.exports,
    require: (id: string) => {
      assert.ok(id === './attachRules', `unexpected nativeMedia import: ${id}`);
      return attachRules;
    },
    window: nativeWindow,
    navigator: { userAgent: options.userAgent ?? 'Android 10' },
    ArrayBuffer,
    Blob,
    File,
    Uint8Array,
    URL: { createObjectURL: (blob: Blob) => { const url = `blob:test-${urls.length}`; urls.push({ blob, url }); return url; } },
    fetch,
    setTimeout,
    clearTimeout,
    console,
  });
  const emit = (data: unknown) => wire.onmessage?.({ data });
  return { api: module.exports as unknown as NativeMedia, wire, posted, emit, urls };
}

const jsonMessages = (posted: readonly (string | ArrayBuffer)[]) => posted
  .filter((message): message is string => typeof message === 'string')
  .map((message) => JSON.parse(message) as Record<string, unknown>);

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(condition(), 'native bridge did not reach the expected protocol step');
}

describe('nativeMedia: протокол нативного моста', () => {
  it('имя файла укладывается в 120 знаков, сохраняя расширение и очищая путь',()=>{
    // Android узнаёт тип по последнему расширению; обрезка его отрезать не должна.
    const {api}=fixture();
    for(const length of [119,120,121]){const name='x'.repeat(length-4)+'.pdf';assert.equal(api.nativeFileName(name).length,Math.min(length,120));assert.ok(api.nativeFileName(name).endsWith('.pdf'),'расширение сохранено');}
    assert.equal(api.nativeFileName('x'.repeat(150)), 'x'.repeat(120));
    assert.equal(api.nativeFileName(''), 'file');assert.equal(api.nativeFileName('  '),'file');
    assert.equal(api.nativeFileName('folder/name?.PDF'),'folder_name_.PDF');
  });

  it('файловый мост получает open и download с переданным MIME, не с типом Blob',async()=>{
    // Выдача может дать octet-stream: без явного MIME Android не найдёт приложение PDF.
    const f=fixture((message,wire)=>{if(typeof message!=='string')return;const req=JSON.parse(message);if(req.op==='putEnd')queueMicrotask(()=>wire.onmessage?.({data:JSON.stringify({id:req.id,ok:true,token:'copy-token',uri:'content://download'})}));});
    const blob=new Blob(['data'],{type:'application/octet-stream'});
    assert.equal((await f.api.openFileNative(blob,'report.pdf','application/pdf')).token,'copy-token');
    assert.equal((await f.api.saveFileNative(blob,'report.pdf','application/pdf')).uri,'content://download');
    assert.deepEqual(jsonMessages(f.posted).filter(x=>x.op==='put').map(x=>[x.then,x.mime,x.name]),[['open','application/pdf','report.pdf'],['download','application/pdf','report.pdf']]);
  });
  it('микрофон отсутствующий в старом ответе считается доступным, а mic=false остаётся явным запретом', async () => {
    // Старый APK не знает поле mic и должен сохранить запись; явный false запрещает захват аудио.
    let replies = 0;
    const f = fixture((message, wire) => {
      if (typeof message !== 'string') return;
      const req = JSON.parse(message) as { op: string; id: string };
      if (req.op !== 'info') return;
      const mic = replies++ === 0 ? { mic: false } : {};
      queueMicrotask(() => wire.onmessage?.({ data: JSON.stringify({ id: req.id, sdk: 35, perm: 'granted', ...mic }) }));
    });
    assert.equal((await f.api.nativeMediaInfo()).mic, false);
    assert.equal((await f.api.nativeMediaInfo()).mic, true);
  });

  it('показ действий зависит от моста и порога Android 10 для сохранения', () => {
    // Copy доступен на Android 9, сохранение в галерею — только с Android 10; без моста кнопки скрыты.
    const android9 = fixture(undefined, { userAgent: 'Mozilla/5.0 (Linux; Android 9; Mobile)', bridge: true });
    assert.equal(android9.api.canCopyImageNative(), true);
    assert.equal(android9.api.canSaveImageNative(), false);
    assert.equal(android9.api.canOpenFileNative(), true, 'открыть файл можно с Android 7+');
    assert.equal(android9.api.canSaveFileNative(), false, 'Download/GusVoice требует Android 10');
    const android10 = fixture(undefined, { userAgent: 'Mozilla/5.0 (Linux; Android 10; Mobile)', bridge: true });
    assert.equal(android10.api.canCopyImageNative(), true);
    assert.equal(android10.api.canSaveImageNative(), true);
    assert.equal(android10.api.canOpenFileNative(), true);
    assert.equal(android10.api.canSaveFileNative(), true);
    const desktop = fixture(undefined, { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', bridge: false });
    assert.equal(desktop.api.canCopyImageNative(), false);
    assert.equal(desktop.api.canSaveImageNative(), false);
    assert.equal(desktop.api.canOpenFileNative(), false);
    assert.equal(desktop.api.canSaveFileNative(), false);
  });

  it('share появляется только после capability-ответа, старый натив и отказ не обещают кнопку', async () => {
    // Старый APK не знает ACTION_SEND: преждевременная кнопка «Поделиться» неизбежно бы закончилась пустым действием.
    const modern = fixture((message, wire) => {
      if (typeof message !== 'string') return;
      const req = JSON.parse(message) as { op: string; id: string };
      if (req.op === 'info') queueMicrotask(() => wire.onmessage?.({ data: JSON.stringify({ id: req.id, sdk: 35, canShare: true }) }));
    });
    assert.equal(modern.api.canShareFileNative(), false, 'до info разрешение неизвестно — закрыто');
    await until(() => modern.api.canShareFileNative());
    assert.ok(modern.api.canShareFileNative(), 'ответ современного натива включил share');
    assert.equal(jsonMessages(modern.posted).filter(m => m.op === 'info').length, 1, 'capability запрашивается один раз');
    const old = fixture((message, wire) => {
      if (typeof message !== 'string') return;
      const req = JSON.parse(message) as { op: string; id: string };
      if (req.op === 'info') queueMicrotask(() => wire.onmessage?.({ data: JSON.stringify({ id: req.id, sdk: 29 }) }));
    });
    assert.equal(old.api.canShareFileNative(), false);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(old.api.canShareFileNative(), false, 'поле отсутствует у прежнего APK');
  });

  it('реальный Android 10-мутант ломает границу сохранения на Android 9', () => {
    // Сохранение в публичный Downloads без Android 10 заставило бы обещать недоступный системный путь.
    const source = readFileSync(new URL('./nativeMedia.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const mutate = (s: string) => {
      const changed = s.replaceAll('androidMajor() >= 10', 'androidMajor() >= 9');
      assert.notEqual(changed, s, 'найдена настоящая проверка API level 10');
      return changed;
    };
    const mutant = fixture(undefined, { userAgent: 'Mozilla/5.0 (Linux; Android 9; Mobile)' }, mutate);
    assert.equal(fixture(undefined, { userAgent: 'Android 9' }).api.canSaveFileNative(), false);
    assert.throws(() => assert.equal(mutant.api.canSaveFileNative(), false, 'Android 9 не поддерживает Download API'), assert.AssertionError,
      'мутант с порогом 9 должен нарушить проверку capability');
    assert.equal(source.includes('canSaveFileNative'), true, 'проверяется оригинальный модуль, не алгоритм из теста');
  });

  it('ответ миниатюры использует ArrayBuffer сразу после своего бинарного заголовка', async () => {
    // Пара «заголовок + байты» приходит одним потоком; если потерять привязку, превью повисает или получает чужие байты.
    const f = fixture((message, wire) => {
      if (typeof message !== 'string') return;
      const req = JSON.parse(message) as { op: string; id: string };
      if (req.op === 'thumb') {
        queueMicrotask(() => {
          wire.onmessage?.({ data: JSON.stringify({ id: req.id, bin: { kind: 'jpeg' } }) });
          wire.onmessage?.({ data: new Uint8Array([1, 2, 3]).buffer });
        });
      }
    });
    const url = await f.api.galleryThumb({ id: 'photo', kind: 'image', mime: 'image/jpeg', size: 3, width: 1, height: 1, durationMs: 0, added: 1, name: 'photo.jpg', rot: 0 }, 96);
    assert.equal(url, 'blob:test-0');
    assert.deepEqual([...new Uint8Array(await f.urls[0]!.blob.arrayBuffer())], [1, 2, 3]);
  });

  it('собирает File из нескольких частей и отдельно отмечает пропущенный документ', async () => {
    // Натив может пропустить один слишком большой файл и передать следующий; это не должно терять целые части первого.
    const f = fixture((message, wire) => {
      if (typeof message !== 'string') return;
      const req = JSON.parse(message) as { op: string; id: string };
      if (req.op !== 'docs') return;
      queueMicrotask(() => {
        const send = (value: Record<string, unknown>) => wire.onmessage?.({ data: JSON.stringify({ id: req.id, ...value }) });
        send({ file: 0, name: 'joined.txt', mime: 'text/plain' });
        send({ bin: { file: 0 } }); wire.onmessage?.({ data: new Uint8Array([65, 66]).buffer });
        send({ bin: { file: 0 } }); wire.onmessage?.({ data: new Uint8Array([67]).buffer });
        send({ file: 0, name: 'joined.txt', end: true });
        send({ file: 1, name: 'large.bin', skip: 'too-big' });
        send({ done: true, total: 2 });
      });
    });
    const result = await f.api.pickDocumentsNative();
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]!.name, 'joined.txt');
    assert.equal(result.files[0]!.type, 'text/plain');
    assert.deepEqual([...new Uint8Array(await result.files[0]!.arrayBuffer())], [65, 66, 67]);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0]?.name, 'large.bin');
    assert.equal(result.skipped[0]?.reason, 'too-big');
    assert.equal(result.cancelled, false);
    assert.equal(result.dropped, 0);
  });

  it('cancelNativeFiles отменяет файловый поток, но не запрос миниатюры', async () => {
    // Закрытие листа должно остановить чтение файлов, не отменяя параллельный запрос другого типа.
    const f = fixture();
    const files = f.api.galleryFiles([{ id: 'photo', kind: 'image', mime: 'image/jpeg', size: 10, width: 1, height: 1, durationMs: 0, added: 1, name: 'x.jpg', rot: 0 }], { compress: false });
    const thumb = f.api.galleryThumb({ id: 'photo', kind: 'image', mime: 'image/jpeg', size: 10, width: 1, height: 1, durationMs: 0, added: 1, name: 'x.jpg', rot: 0 }, 64);
    const requests = jsonMessages(f.posted);
    const fileId = String(requests.find((m) => m.op === 'open')?.id);
    const thumbId = String(requests.find((m) => m.op === 'thumb')?.id);
    f.api.cancelNativeFiles();
    const cancels = jsonMessages(f.posted).filter((m) => m.op === 'cancel');
    assert.deepEqual(cancels, [{ op: 'cancel', id: `${fileId}-c`, target: fileId }]);
    assert.notEqual(fileId, thumbId);
    f.emit(JSON.stringify({ id: fileId, done: true, cancelled: true }));
    f.emit(JSON.stringify({ id: thumbId, ok: false }));
    assert.equal((await files).cancelled, true);
    assert.equal(await thumb, null);
  });

  it('put сериализует большие blobs: заголовок, части, putEnd и только потом следующий файл', async () => {
    // Части не несут id: параллельный put смешал бы байты двух файлов, поэтому второй обязан ждать ответа первого.
    const f = fixture();
    const first = f.api.saveImageNative(new Blob([new Uint8Array(256 * 1024 + 3)], { type: 'application/octet-stream' }), 'folder/photo');
    const second = f.api.copyImageNative(new Blob([new Uint8Array([7, 8])], { type: 'video/webm' }), 'clip');
    await until(() => jsonMessages(f.posted).some((m) => m.op === 'putEnd'));
    const firstEnd = jsonMessages(f.posted).find((m) => m.op === 'putEnd')!;
    const firstId = String(firstEnd.id);
    const beforeAck = jsonMessages(f.posted).filter((m) => m.op === 'put');
    assert.equal(beforeAck.length, 1, 'второй put не должен начинаться до подтверждения первого');
    assert.deepEqual(jsonMessages(f.posted).filter((m) => m.op === 'putEnd').map((m) => m.id), [firstId]);
    f.emit(JSON.stringify({ id: firstId, ok: true, uri: 'content://saved' }));
    assert.equal((await first).uri, 'content://saved');
    await until(() => jsonMessages(f.posted).filter((m) => m.op === 'putEnd').length === 2);
    const puts = jsonMessages(f.posted).filter((m) => m.op === 'put');
    const ends = jsonMessages(f.posted).filter((m) => m.op === 'putEnd');
    assert.deepEqual(puts.map((m) => [m.name, m.mime]), [['folder_photo.jpg', 'image/jpeg'], ['clip.webm', 'video/webm']]);
    assert.deepEqual(ends.map((m) => m.id), puts.map((m) => m.id), 'каждый поток закрывается прежде следующего put');
    const stream = f.posted.map((message) => {
      if (message instanceof ArrayBuffer) return message.byteLength;
      const op = (JSON.parse(message) as { op: string }).op;
      return op === 'put' || op === 'putEnd' ? op : `unexpected:${op}`;
    });
    assert.deepEqual(stream, ['put', 256 * 1024, 3, 'putEnd', 'put', 2, 'putEnd']);
    f.emit(JSON.stringify({ id: ends[1]!.id, ok: true, systemNotice: true }));
    assert.equal((await second).systemNotice, true);
  });
});
