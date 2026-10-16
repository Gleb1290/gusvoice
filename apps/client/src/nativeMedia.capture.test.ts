import assert from 'node:assert/strict';
import { Blob, File } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './attachRules';

const source = readFileSync(new URL('./nativeMedia.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function bridge(text = source, transportError?: Error) {
  const requests: { op: string; id: string; video?: boolean; max?: number; [key: string]: unknown }[] = [];
  const timers = new Map<number, () => void>();
  let seq = 0;
  const wire = { onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage(s: string) { if (transportError) throw transportError; requests.push(JSON.parse(s)); } };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, require(id: string) { assert.equal(id, './attachRules'); return rules; },
    window: { GusVoiceMedia: wire, setTimeout(fn: () => void) { timers.set(++seq, fn); return seq; }, clearTimeout(id: number) { timers.delete(id); } },
    ArrayBuffer, Blob, File, Error,
  });
  return { api: module.exports as typeof import('./nativeMedia'), requests,
    send(data: Record<string, unknown>, id = requests.at(-1)!.id) { wire.onmessage!({ data: JSON.stringify({ id, ...data }) }); },
    bytes(bytes: number[]) { wire.onmessage!({ data: new Uint8Array(bytes).buffer }); }, timers };
}
function mutate(from: string, to: string) {
  assert.equal(source.split(from).length - 1, 1);
  return source.replace(from, to);
}
async function permission(text: string) {
  const b = bridge(text);
  const info = b.api.nativeMediaInfo();
  b.send({ perm: 'partial', capture: true });
  assert.equal((await info).perm, 'granted');
  assert.equal(b.timers.size, 0);
  const check = b.api.galleryPermission('check');
  b.send({ perm: 'partial' });
  assert.equal(await check, 'granted');
}
async function captureProtocol(text: string) {
  const b = bridge(text); const p = b.api.captureNative({ video: true, maxBytes: 1234 });
  assert.equal(b.requests[0]!.op, 'capture'); assert.equal(b.requests[0]!.video, true); assert.equal(b.requests[0]!.max, 1234);
  b.send({ done: true, cancelled: true }); await p;
}
describe('R150 системная камера и совместимость разрешений', () => {
  it('фото и видео вызывают capture с пределом вызывающего, а без него с пределом канала', async () => {
    for (const [video, maxBytes] of [[false, 1234], [true, 1024 ** 3], [false, undefined]] as const) {
      const b = bridge(); const p = b.api.captureNative({ video, maxBytes });
      assert.equal(b.requests[0]!.op, 'capture'); assert.equal(b.requests[0]!.video, video);
      assert.equal(b.requests[0]!.max, maxBytes ?? rules.ATTACH_MAX_BYTES);
      b.send({ done: true, cancelled: true });
      const result = await p;
      assert.equal(result.cancelled, true); assert.equal(result.files.length, 0); assert.equal(result.skipped.length, 0);
      assert.deepEqual(Array.from(result.indexes), []);
      assert.equal(b.timers.size, 0, 'камера ждёт человека без тайм-аута');
    }
  });
  it('снимок приходит несколькими частями байт в байт с именем и MIME', async () => {
    const b = bridge(); const p = b.api.captureNative({ video: false });
    b.send({ file: 0, name: 'IMG.jpg', mime: 'image/jpeg', size: 5 });
    b.send({ bin: { file: 0 } }); b.bytes([1, 2]);
    b.send({ bin: { file: 0 } }); b.bytes([3, 4, 5]);
    b.send({ file: 0, end: true }); b.send({ done: true });
    const result = await p; assert.equal(result.cancelled, false); assert.equal(result.files.length, 1);
    assert.deepEqual(Array.from(result.indexes), [0]);
    assert.equal(result.files[0]!.name, 'IMG.jpg'); assert.equal(result.files[0]!.type, 'image/jpeg');
    assert.deepEqual([...new Uint8Array(await result.files[0]!.arrayBuffer())], [1, 2, 3, 4, 5]);
  });
  it('отказ камеры отклоняет обещание и сохраняет распознаваемый код', async () => {
    const b = bridge(); const p = b.api.captureNative({ video: true });
    b.send({ ok: false, error: 'camera-denied' });
    await assert.rejects(p, (e: unknown) => { assert.equal(b.api.captureErrorCode(e), 'camera-denied'); return true; });
  });
  it('известные ошибки отличаются от неизвестной, чужого префикса и не-Error', () => {
    const b = bridge();
    for (const code of ['camera-denied', 'no-camera', 'busy'] as const) assert.equal(b.api.captureErrorCode(new Error(`native media: capture ${code}`)), code);
    for (const value of [new Error('native media: capture unknown'), new Error('camera-denied'), 'native media: capture busy', null, { message: 'native media: capture busy' }]) assert.equal(b.api.captureErrorCode(value), 'failed');
  });
  it('partial старой оболочки считается доступом в info и проверке разрешения', async () => { await permission(source); });
  it('контрфакт partial→ask нарушает тот же сценарий после оригинала', async () => {
    await permission(source);
    await assert.rejects(() => permission(mutate("v === 'granted' || v === 'partial'", "v === 'granted'")), assert.AssertionError);
  });
  it('флаг системной камеры только true: старая оболочка сохраняет резервный путь', async () => {
    for (const capture of [undefined, false, 'true', true]) {
      const b = bridge(); const p = b.api.nativeMediaInfo(); b.send({ perm: 'granted', capture });
      assert.equal((await p).capture, capture === true);
    }
  });
  for (const [name, from, to] of [
    ['видео стало фото', 'video: opts.video, max:', 'video: false, max:'],
    ['предел вызывающего потерян', 'max: opts.maxBytes ?? ATTACH_MAX_BYTES }, 1);', 'max: ATTACH_MAX_BYTES }, 1);'],
  ] as const) it(`контрфакт ${name} нарушает протокол камеры после оригинала`, async () => {
    await captureProtocol(source); await assert.rejects(() => captureProtocol(mutate(from, to)), assert.AssertionError);
  });
  it('контрфакт всё в failed теряет код отказа камеры после оригинала', () => {
    const check = (text: string) => assert.equal(bridge(text).api.captureErrorCode(new Error('native media: capture camera-denied')), 'camera-denied');
    check(source);
    assert.throws(() => check(mutate("return code === 'camera-denied' || code === 'no-camera' || code === 'busy' ? code : 'failed';", "return 'failed';")), assert.AssertionError);
  });
});

async function cameraPermission(text: string) {
  for (const [reply, expected] of [
    [{ camera: true }, 'granted'], [{ camera: false }, 'denied'], [{ camera: 'true' }, 'denied'],
    [{}, 'denied'], [{ ok: false, error: 'unknown-op' }, null],
    [{ ok: false, error: 'busy', camera: true }, 'denied'],
  ] as const) {
    const b = bridge(text); const p = b.api.cameraPermissionNative();
    assert.equal(b.requests[0]!.op, 'camPerm'); assert.equal(b.timers.size, 0);
    b.send(reply); assert.equal(await p, expected);
  }
}
async function indexedFiles(text: string) {
  const b = bridge(text);
  const p = b.api.galleryFiles([item, { ...item, id: '43' }, { ...item, id: '44' }], { compress: true, maxBytes: 99 });
  assert.equal(b.requests[0]!.max, 99);
  // Завершение не по порядку запроса: индекс должен идти рядом с файлом, а не быть счётчиком успехов.
  for (const [index, bytes] of [[2, [3, 4, 5]], [0, [1, 2]]] as const) {
    b.send({ file: index, name: `${index}.jpg`, mime: 'image/jpeg' });
    b.send({ bin: { file: index } }); b.bytes([bytes[0]]);
    b.send({ bin: { file: index } }); b.bytes(Array.from(bytes.slice(1)));
    b.send({ file: index, end: true });
  }
  b.send({ file: 1, name: '1.jpg', skip: 'too-big' }); b.send({ done: true });
  const r = await p;
  assert.deepEqual(Array.from(r.indexes), [2, 0]);
  assert.deepEqual(Array.from(r.files, f => f.name), ['2.jpg', '0.jpg']);
  assert.deepEqual([...new Uint8Array(await r.files[0]!.arrayBuffer())], [3, 4, 5]);
  assert.deepEqual([...new Uint8Array(await r.files[1]!.arrayBuffer())], [1, 2]);
  assert.equal(r.skipped.length, 1); assert.equal(r.skipped[0]!.reason, 'too-big');
  assert.equal(r.skipped[0]!.name, '1.jpg');
}
async function originalProgress(text: string) {
  const b = bridge(text); const progress: number[] = [];
  const r = b.api.galleryOriginal({ ...item, kind: 'video', mime: 'video/mp4' }, 1024 ** 3, n => progress.push(n));
  assert.equal(b.requests[0]!.max, 1024 ** 3); assert.equal(b.requests[0]!.view, true);
  assert.equal(b.requests[0]!.compress, false);
  b.send({ file: 0, name: 'big.mp4', mime: 'video/mp4', size: 5 });
  assert.deepEqual(progress, []);
  b.send({ bin: { file: 0 } }); b.bytes([1, 2]);
  assert.deepEqual(progress, [2]);
  b.send({ bin: { file: 0 } }); b.bytes([3, 4, 5]);
  assert.deepEqual(progress, [2, 5]);
  b.send({ file: 0, end: true }); b.send({ done: true });
  const file = await r.done; assert.ok(file); assert.equal(file.size, 5);
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3, 4, 5]);
  assert.deepEqual(progress, [2, 5]);
}
describe('R154 разрешение камеры, номера файлов и байтовый прогресс просмотра', () => {
  it('только camera true даёт доступ, unknown-op даёт null, остальные отказы denied', async () => cameraPermission(source));
  it('сбой транспорта отклоняет запрос камеры с исходной ошибкой', async () => {
    const error = new Error('transport failed');
    await assert.rejects(bridge(source, error).api.cameraPermissionNative(), e => e === error);
  });
  for (const [name, from, to] of [
    ['unknown-op потерян', "m.error === 'unknown-op' ? null : 'denied'", "'denied'"],
    ['строка стала доступом', "return m.camera === true ? 'granted' : 'denied';", "return m.camera ? 'granted' : 'denied';"],
  ] as const) it(`контрфакт ${name} нарушает три исхода разрешения`, async () => {
    await cameraPermission(source); await assert.rejects(() => cameraPermission(mutate(from, to)), assert.AssertionError);
  });
  it('indexes сохраняют номера запроса и порядок файлов, пропуск не получает индекс, части не теряются', async () => indexedFiles(source));
  it('контрфакт номера успехов вместо номеров запроса ломает смешанный выбор', async () => {
    await indexedFiles(source); await assert.rejects(() => indexedFiles(mutate('indexes.push(i);', 'indexes.push(files.length - 1);')), assert.AssertionError);
  });
  it('galleryOriginal передаёт предел беседы и сообщает накопленные байты каждой части', async () => originalProgress(source));
  it('контрфакт без onBytes оставляет просмотр без процентов', async () => {
    await originalProgress(source); await assert.rejects(() => originalProgress(mutate('onBytes?.(bytes);', '')), assert.AssertionError);
  });
  it('контрфакт стандартного предела вместо предела беседы портит крупное видео', async () => {
    await originalProgress(source); await assert.rejects(() => originalProgress(mutate('max: maxBytes, view: true', 'max: ATTACH_MAX_BYTES, view: true')), assert.AssertionError);
  });
});

const item: import('./nativeMedia').GalleryItem = { id: '42', kind: 'image', mime: 'image/jpeg', size: 5, width: 10, height: 10, durationMs: 0, added: 50, name: 'photo.jpg', rot: 90 };
async function filters(text: string) {
  for (const album of [null, { id: '', only: null }, { id: '', only: 'video' }, { id: '12', only: null }, { id: '12', only: 'video' }] as const) {
    const b = bridge(text);
    const p = b.api.galleryPage(item, 30, album ? { ...album, name: 'album', count: 4, cover: null } : null);
    const req = b.requests[0]!;
    assert.equal(req.op, 'page'); assert.equal(req.limit, 30); assert.deepEqual(req.before, { added: 50, id: '42' });
    assert.equal(Object.hasOwn(req, 'bucket'), Boolean(album?.id));
    assert.equal(Object.hasOwn(req, 'only'), Boolean(album?.only));
    if (album?.id) assert.equal(req.bucket, album.id);
    if (album?.only) assert.equal(req.only, 'video');
    b.send({ items: [], end: true }); await p;
  }
}
async function original(text: string) {
  for (const [kind, mime] of [['image', 'image/jpeg'], ['image', 'image/gif'], ['video', 'video/mp4']] as const) {
    const b = bridge(text); const r = b.api.galleryOriginal({ ...item, kind, mime }, 1024 ** 3);
    assert.equal(b.requests[0]!.op, 'open'); assert.equal(b.requests[0]!.view, true);
    assert.equal(b.requests[0]!.compress, kind === 'image'); assert.equal(b.requests[0]!.max, 1024 ** 3);
    assert.deepEqual(b.requests[0]!.items, [{ id: '42', kind, mime, name: 'photo.jpg' }]);
    b.send({ file: 0, name: 'original', mime }); b.send({ bin: { file: 0 } }); b.bytes([9, 8, 7]);
    b.send({ file: 0, end: true }); b.send({ done: true });
    const file = await r.done; assert.ok(file); assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [9, 8, 7]);
    const before = b.requests.length; r.cancel(); assert.equal(b.requests.length, before, 'завершённый поток не отменяется');
  }
}
async function cancelledOriginal(text: string) {
  const b = bridge(text); const r = b.api.galleryOriginal(item); const id = b.requests[0]!.id;
  r.cancel(); assert.equal(b.requests[1]!.op, 'cancel'); assert.equal(b.requests[1]!.target, id);
  b.send({ file: 0, name: 'late.jpg', mime: 'image/jpeg' }, id); b.send({ bin: { file: 0 } }, id); b.bytes([1]);
  b.send({ file: 0, end: true }, id); b.send({ done: true }, id); assert.equal(await r.done, null);
}
describe('R153 альбомы и оригиналы через настоящий модуль моста', () => {
  it('альбомы разбирают id, числа, вид/поворот обложки и безопасные значения отсутствующих полей', async () => {
    const b = bridge(); const p = b.api.galleryAlbums(); assert.equal(b.requests[0]!.op, 'albums');
    b.send({ albums: [{ id: 12, name: 'Camera', count: '3', only: 'video', cover: { id: 42, kind: 'video', rot: '90' } }, {}, { cover: { id: '' }, only: 'image', count: 'bad' }] });
    const albums = await p; assert.ok(albums); assert.equal(albums.length, 3);
    assert.equal(albums[0]!.id, '12'); assert.equal(albums[0]!.name, 'Camera'); assert.equal(albums[0]!.count, 3);
    assert.equal(albums[0]!.only, 'video'); assert.equal(albums[0]!.cover!.id, '42'); assert.equal(albums[0]!.cover!.kind, 'video'); assert.equal(albums[0]!.cover!.rot, 90);
    for (const a of albums.slice(1)) { assert.equal(a.id, ''); assert.equal(a.count, 0); assert.equal(a.only, null); assert.equal(a.cover, null); }
  });
  it('unknown-op, ok:false, неверный список и исключение тайм-аута дают null; пустой список принимается', async () => {
    for (const reply of [{ ok: false, error: 'unknown-op' }, { ok: false, albums: [] }, { albums: {} }, { albums: [] }]) {
      const b = bridge(); const p = b.api.galleryAlbums(); b.send(reply); assert.equal((await p)?.length ?? null, Array.isArray(reply.albums) && reply.ok !== false ? 0 : null);
    }
    const b = bridge(); const p = b.api.galleryAlbums(); for (const fn of b.timers.values()) fn(); assert.equal(await p, null);
  });
  it('bucket и only отправляются только по фильтру альбома, курсор и limit сохраняются', async () => filters(source));
  for (const [name, from, to] of [
    ['bucket всегда', 'if (album?.id) filter.bucket = album.id;', "filter.bucket = album?.id ?? '';"],
    ['only потерян', 'if (album?.only) filter.only = album.only;', ''],
  ] as const) it(`контрфакт ${name} нарушает фильтры после оригинала`, async () => {
    await filters(source); await assert.rejects(() => filters(mutate(from, to)), assert.AssertionError);
  });
  it('оригинал идёт open/view, фото сжимается, видео нет, GIF сохраняет фото-путь для решения на нативе', async () => original(source));
  for (const [name, from, to] of [
    ['сжатие видео', "compress: item.kind === 'image'", 'compress: true'],
    ['без view', 'max: maxBytes, view: true', 'max: maxBytes, view: false'],
  ] as const) it(`контрфакт ${name} нарушает получение оригинала после исходника`, async () => {
    await original(source); await assert.rejects(() => original(mutate(from, to)), assert.AssertionError);
  });
  it('cancel адресует текущий поток и даже пришедший после отмены файл становится null', async () => {
    await cancelledOriginal(source);
  });
  it('контрфакт без stop после отмены отдаёт поздний файл и нарушает сценарий', async () => {
    await cancelledOriginal(source);
    await assert.rejects(() => cancelledOriginal(mutate('(r) => (stop ? null : (r.files[0] ?? null))', '(r) => (r.files[0] ?? null)')), assert.AssertionError);
  });
  it('пустой или ошибочный поток оригинала возвращает null без необработанного reject', async () => {
    for (const reply of [{ done: true }, { ok: false, error: 'unreadable' }]) {
      const b = bridge(); const r = b.api.galleryOriginal(item); b.send(reply); assert.equal(await r.done, null);
    }
  });
});
