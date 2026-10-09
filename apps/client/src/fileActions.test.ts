import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';

const att = { id: 'private-id', url: '/download/private-id', name: 'report.pdf', contentType: 'application/pdf; charset=binary', size: 4 };
type NativeErrorCode = 'missing' | 'no-app' | 'denied';
class NativeFileError extends Error {
  constructor(readonly code: NativeErrorCode) { super(code); }
}

function fixture(mutate?: (source: string) => string) {
  const module = { exports: {} as Record<string, unknown> };
  const source = readFileSync(new URL('./fileActions.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const code = ts.transpileModule(mutate ? mutate(source) : source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const fetchCalls: { url: string; credentials?: string; signal?: AbortSignal }[] = [];
  const openCalls: unknown[][] = [];
  const reopenCalls: unknown[][] = [];
  const saveCalls: unknown[][] = [];
  const mediaCalls: unknown[][] = [];
  const shareCalls: unknown[][] = [];
  const toasts: unknown[][] = [];
  let pending = false;
  let saveAvailable = true;
  let httpStatus = 200;
  let chunks: Uint8Array[] | null = null;
  let openError: NativeErrorCode | null = null;
  let reopenError: NativeErrorCode | null = null;
  const fetchStub = (url: string, init: { credentials?: string; signal?: AbortSignal }) => {
    fetchCalls.push({ url, credentials: init.credentials, signal: init.signal });
    if (pending) return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const error = new Error('cancelled'); error.name = 'AbortError'; reject(error);
      }, { once: true });
    });
    const body = chunks ? {
      getReader: () => {
        let index = 0;
        return { read: async () => index < chunks!.length
          ? { done: false, value: chunks![index++] }
          : { done: true, value: undefined } };
      },
    } : null;
    return Promise.resolve({
      ok: httpStatus >= 200 && httpStatus < 300,
      status: httpStatus,
      headers: { get: (name: string) => name === 'content-length' ? '4' : 'application/pdf' },
      body,
      blob: async () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'application/pdf' }),
    });
  };
  runInNewContext(code, {
    module,
    exports: module.exports,
    Blob,
    AbortController,
    // Фиксированный clock не позволяет медленному CI случайно добавить лишнее обновление окна 100 мс.
    Date: { now: () => 1000 },
    fetch: fetchStub,
    require: (id: string) => {
      if (id === './api') return { api: { attachmentDownloadUrl: (a: typeof att) => `/api${a.url}` } };
      if (id === './nativeMedia') return {
        canOpenFileNative: () => true,
        canSaveFileNative: () => saveAvailable,
        NativeFileError,
        openFileNative: async (...args: unknown[]) => {
          openCalls.push(args);
          if (openError) throw new NativeFileError(openError);
          return { token: 'cache-token' };
        },
        reopenFileNative: async (...args: unknown[]) => {
          reopenCalls.push(args);
          if (reopenError) throw new NativeFileError(reopenError);
        },
        saveFileNative: async (...args: unknown[]) => { saveCalls.push(args); },
        saveMediaNative: async (...args: unknown[]) => { mediaCalls.push(args); },
        shareFileNative: async (...args: unknown[]) => { shareCalls.push(args); },
      };
      if (id === './toast') return { toast: (...args: unknown[]) => toasts.push(args) };
      throw new Error(`unexpected import ${id}`);
    },
  });
  return {
    api: module.exports as unknown as typeof import('./fileActions'),
    fetchCalls, openCalls, reopenCalls, saveCalls, mediaCalls, shareCalls, toasts,
    setPending(value: boolean) { pending = value; },
    setSaveAvailable(value: boolean) { saveAvailable = value; },
    setHttpStatus(value: number) { httpStatus = value; },
    setChunks(value: Uint8Array[] | null) { chunks = value; },
    setOpenError(value: NativeErrorCode | null) { openError = value; },
    setReopenError(value: NativeErrorCode | null) { reopenError = value; },
  };
}

async function until(check: () => boolean, reason: string): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(check(), reason);
}

it('прогресс не делит на ноль, не выходит за 0…1 и показывает тип, ключ и способ сохранения', () => {
  // Нулевой Content-Length и повторяющиеся ссылки у закрытых файлов иначе ломают кольцо и отмену не того вложения.
  const { api } = fixture();
  assert.equal(api.progressText(0, 0), '0 KB');
  assert.equal(api.progressText(2048, 4096), '2 KB / 4 KB');
  assert.equal(api.progressText(8192, 4096), '4 KB / 4 KB', 'текст не показывает загрузку сверх общего размера');
  assert.equal(api.progressRatio(0, 0), 0);
  assert.equal(api.progressRatio(1, 0), 0);
  assert.equal(api.progressRatio(-1, 10), 0);
  assert.equal(api.progressRatio(11, 10), 1);
  assert.equal(api.attachmentMime(att), 'application/pdf');
  assert.equal(api.attachmentMime({ contentType: '' }), 'application/octet-stream');
  assert.equal(api.attachmentKey(att), 'private-id', 'id важнее обновляемой приватной ссылки');
  assert.equal(api.attachmentKey({ id: '', url: '/legacy' }), '/legacy');
  assert.equal(api.saveKind(), 'save');
  const f = fixture();
  f.setSaveAvailable(false);
  assert.equal(f.api.saveKind(), 'open', 'без разрешённого нативного сохранения стрелка открывает файл');
});

it('непустой малый файл не показывается нулевым, прогресс использует ту же шкалу размера', () => {
  // 46-байтный файл раньше выглядел пустым: округление веса и текущей загрузки должно совпадать.
  const { api } = fixture();
  for (const [bytes, label] of [[0, '0 KB'], [1, '1 KB'], [46, '1 KB'], [1023, '1 KB'], [1024, '1 KB'], [1536, '2 KB'], [1048576, '1.0 MB']] as const) {
    assert.equal(api.sizeText(bytes), label);
  }
  assert.equal(api.progressText(300, 4096), '1 KB / 4 KB');
  const source = readFileSync(new URL('./components/AttachmentView.tsx', import.meta.url), 'utf8');
  assert.match(source, /export const kb = sizeText;/, 'карточка не заводит собственное расходящееся округление');
});

it('повторное нажатие отменяет открытую загрузку без системного тоста', async () => {
  // Пользовательский повторный тап означает отмену, а поздний ответ сети не должен внезапно открыть файл.
  const f = fixture();
  f.setPending(true);
  let notices = 0;
  const unsubscribe = f.api.subscribeFileJobs(() => { notices++; });
  f.api.openAttachmentFile(att);
  await until(() => f.fetchCalls.length === 1, 'запрос файла не начался');
  assert.equal(f.api.fileJobOf('private-id')?.kind, 'open', 'карточка показывает состояние загрузки');
  assert.ok(notices > 0, 'подписчик узнаёт о начале загрузки');
  const noticesBeforeUnsubscribe = notices;
  unsubscribe();
  f.api.openAttachmentFile(att);
  await until(() => f.api.fileJobOf('private-id') === null, 'отменённая загрузка осталась в списке');
  assert.equal(f.fetchCalls[0]?.signal?.aborted, true, 'повторный тап прерывает сетевой запрос');
  assert.deepEqual(f.toasts, [], 'штатная отмена не выглядит ошибкой');
  assert.deepEqual(f.openCalls, [], 'отмена до ответа не открывает частичный файл');
  assert.equal(notices, noticesBeforeUnsubscribe, 'отписанный компонент больше не получает обновления состояния');
});

it('второе открытие использует закешированную нативную копию без повторного fetch', async () => {
  // Повторная загрузка одного и того же файла тратит трафик и плодит копии в кеше Android без пользы.
  const f = fixture();
  f.api.openAttachmentFile(att);
  await until(() => f.openCalls.length === 1 && f.api.fileJobOf('private-id') === null, 'первая загрузка не завершилась');
  f.api.openAttachmentFile(att);
  await until(() => f.reopenCalls.length === 1, 'сохранённая копия не переоткрылась');
  assert.equal(f.fetchCalls.length, 1, 'переоткрытие не обращается к серверу');
  assert.deepEqual(f.reopenCalls[0], ['cache-token', 'application/pdf']);
});

it('удалённая нативная копия скачивается заново вместо вечной ошибки reopen', async () => {
  // Кеш приложения может быть очищен системой между нажатиями; в этом случае ключ в памяти уже устарел.
  const f = fixture();
  f.api.openAttachmentFile(att);
  await until(() => f.openCalls.length === 1 && f.api.fileJobOf('private-id') === null, 'первая загрузка не завершилась');
  f.setReopenError('missing');
  f.api.openAttachmentFile(att);
  await until(() => f.fetchCalls.length === 2 && f.api.fileJobOf('private-id') === null, 'после missing не скачана новая копия');
  assert.equal(f.reopenCalls.length, 1);
  assert.equal(f.openCalls.length, 2, 'после потери кеша файл загружен и открыт заново');
  assert.deepEqual(f.toasts, [], 'потерянный временный кеш не показывается пользователю как отказ');
});

it('отсутствие приложения для типа файла даёт понятный тост и предлагает «Загрузки»', async () => {
  // Отказ ACTION_VIEW не должен выглядеть успешным открытием: у пользователя остаётся рабочий путь через сохранение.
  const f = fixture();
  f.setOpenError('no-app');
  f.api.openAttachmentFile(att);
  await until(() => f.openCalls.length === 1 && f.api.fileJobOf('private-id') === null, 'попытка открытия не завершилась');
  assert.deepEqual(f.toasts, [[
    'info', 'Нет приложения, чтобы открыть этот файл', 'Его можно сохранить в «Загрузки»: стрелка справа на карточке',
  ]]);
});

it('HTTP-ошибка загрузки не пытается открыть пустой файл и сообщает об отказе', async () => {
  // Ответ 403 нельзя принимать за нулевой успешный документ или передавать нативному ACTION_VIEW.
  const f = fixture();
  f.setHttpStatus(403);
  f.api.openAttachmentFile(att);
  await until(() => f.fetchCalls.length === 1 && f.api.fileJobOf('private-id') === null, 'ошибка HTTP не завершилась');
  assert.deepEqual(f.openCalls, [], 'пустое тело ошибки не уходит в нативный просмотр');
  assert.deepEqual(f.toasts, [['error', 'Не удалось открыть файл']]);
});

it('стрелка сохраняет файл в Загрузки, а на старом Android открывает его вместо недоступного сохранения',async()=>{
  // Проверяем провод saveKind, а не только вычисленный флаг: иначе стрелка обещает один путь, но зовёт другой.
  const f=fixture();f.api.saveAttachmentFile(att);
  await until(()=>f.saveCalls.length===1 && f.api.fileJobOf('private-id')===null,'сохранение не завершилось');
  assert.equal(f.openCalls.length,0);assert.deepEqual(f.saveCalls[0]?.slice(1),['report.pdf','application/pdf']);
  assert.deepEqual(f.toasts,[['success','Сохранено в «Загрузки»','report.pdf']]);
  const old=fixture();old.setSaveAvailable(false);old.api.saveAttachmentFile(att);
  await until(()=>old.openCalls.length===1 && old.api.fileJobOf('private-id')===null,'старый Android не открыл файл');
  assert.equal(old.saveCalls.length,0);assert.deepEqual(old.toasts,[],'открытие не выдаётся за успешное сохранение');
});

it('fetchWithProgress сообщает начало и итоговые байты потока с Content-Length', async () => {
  // Карточка и просмотр должны показывать реальные байты, а не только скачивание без изменения прогресса.
  const f = fixture();
  f.setChunks([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
  const progress: [number, number][] = [];
  const blob = await f.api.fetchWithProgress('/stream', (loaded, total) => progress.push([loaded, total]));
  assert.deepEqual(progress, [[0, 4], [2, 4], [4, 4]]);
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3, 4]);
  assert.equal(f.fetchCalls[0]?.credentials, 'omit', 'публичное хранилище не получает cookie страницы');
});

it('пункты меню запускают общий job по ключу файла и не создают вторую загрузку пока первая идёт', async () => {
  // Кольцо карточки должно оставаться тем же источником состояния и для «галерея/поделиться», а не плодить гонки загрузок.
  const videoAtt = { ...att, id: 'saved-video', name: 'clip.mp4', contentType: 'video/mp4' };
  const f = fixture();
  f.api.startFileJob(videoAtt, 'gallery');
  await until(() => f.mediaCalls.length === 1 && f.api.fileJobOf('saved-video') === null, 'видео не сохранилось в Movies/GusVoice');
  assert.deepEqual(f.mediaCalls[0]?.slice(1), ['clip.mp4', 'video/mp4'], 'тип от вложения имеет приоритет над Content-Type выдачи');
  const held = fixture(); held.setPending(true);
  const video = { ...att, id: 'video-id', name: 'clip.mp4', contentType: 'video/mp4' };
  held.api.startFileJob(video, 'share');
  await until(() => held.fetchCalls.length === 1, 'share job не начал загрузку');
  assert.equal(held.api.fileJobOf('video-id')?.kind, 'share');
  held.api.startFileJob(video, 'gallery');
  assert.equal(held.fetchCalls.length, 1, 'второй пункт меню не запускает параллельную загрузку');
  held.api.cancelFileJob('video-id');
  await until(() => held.api.fileJobOf('video-id') === null, 'отмена не сняла share job');
  assert.equal(held.shareCalls.length, 0, 'отменённый job не открывает Android share sheet');
});

it('контракт общего job отвергает мутант, запускающий два открытия одного вложения', async () => {
  // Один ключ означает одну карточку загрузки; двойное меню не должно качать те же байты параллельно.
  const source = readFileSync(new URL('./fileActions.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const mutate = (s: string) => {
    const changed = s.replace('if (jobs.has(attachmentKey(a))) return;', '');
    assert.notEqual(changed, s, 'найдена проверка уже идущего job');
    return changed;
  };
  const mutant = fixture(mutate);
  mutant.api.startFileJob(att, 'share'); mutant.api.startFileJob(att, 'gallery');
  await until(() => mutant.fetchCalls.length === 2 && mutant.api.fileJobOf('private-id') === null, 'два запуска мутанта не завершились');
  assert.throws(() => assert.equal(mutant.fetchCalls.length, 1, 'один ключ имеет один download'), assert.AssertionError,
    'мутант должен удвоить фактический запрос байтов');
});
