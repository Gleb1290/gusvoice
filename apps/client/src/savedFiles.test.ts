import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as viewerRules from './mediaViewerRules';

type List = typeof import('./downloadList');
type Pc = typeof import('./pcDownloads');
type Actions = typeof import('./fileActions');
type Downloads = typeof import('./downloads');
type Mutation = { module: string; from: string; to: string };
const source = (name: string) => readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const unused = () => assert.fail('незадействованная IO-граница сохранённых файлов');

function fixture(options: { shell?: boolean; native?: boolean; reject?: boolean; mutation?: Mutation } = {}) {
  const notices: unknown[][] = [], invokes: Array<{ command: string; args: unknown }> = [], mirrored: (string | null)[] = [];
  const load = <T>(name: string, deps: Record<string, unknown>): T => {
    let raw = source(name);
    if (options.mutation?.module === name) {
      const { from, to } = options.mutation;
      assert.equal(raw.split(from).length - 1, 1, 'мутант меняет одно место полного модуля');
      raw = raw.replace(from, to);
    }
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(raw, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText, { module, exports: module.exports, Map, Set, Date, Error, AbortController, Blob,
      URL: { revokeObjectURL: () => {} }, window: nativeWindow, document: { createElement: unused },
      localStorage: { getItem: (key: string) => { assert.equal(key, 'gv_download_dir'); return null; }, setItem: unused, removeItem: unused },
      require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `объявленный импорт ${name}: ${id}`); return deps[id]; },
    });
    return module.exports as T;
  };
  const core = { invoke(this: unknown, command: string, args: unknown) {
    assert.equal(this, core, 'мост вызывается с настоящим receiver');
    invokes.push({ command, args });
    return options.reject ? Promise.reject(new Error('missing-file')) : Promise.resolve();
  } };
  const nativeWindow = { __TAURI__: options.shell === false ? undefined : { core } };
  const toast = { toast: (...args: unknown[]) => notices.push(args), toastError: unused };
  const list = load<List>('downloadList', {});
  // Только физические возможности платформы/байтовое IO заменены: filesViaNative и savedToText настоящие.
  const actions = load<Actions>('fileActions', {
    './api': { api: { attachmentDownloadUrl: unused } }, './toast': toast,
    './nativeMedia': { canOpenFileNative: () => !!options.native, canSaveFileNative: () => false,
      NativeFileError: class extends Error {}, openFileNative: unused, reopenFileNative: unused,
      saveFileNative: unused, saveMediaNative: unused, shareFileNative: unused },
  });
  const pc = load<Pc>('pcDownloads', { './api': { api: { attachmentDownloadUrl: unused } },
    './downloadList': list, './fileActions': actions, './toast': toast });
  type Handlers = Parameters<typeof import('./desktopWindow').onDownloadEvents>[0];
  let events: Handlers | undefined;
  const downloads = load<Downloads>('downloads', {
    './desktopWindow': { onDownloadEvents: (handlers: Handlers) => { events = handlers; }, pickFolder: unused,
      setNativeDownloadDir: (dir: string | null) => mirrored.push(dir) },
    './downloadList': list, './pcDownloads': pc, './toast': toast,
  });
  const add = (key: string, state: import('./downloadList').DownloadState = 'done', href?: string, path?: string, name = 'file.txt') => {
    const id = list.addDownload({ key, url: `/${key}`, name, type: 'text/plain', total: 1 });
    list.patchDownload(id, { state, href, path }); return id;
  };
  return { list, actions, pc, downloads, notices, invokes, mirrored, add, events: () => { assert.ok(events); return events; } };
}
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const path = 'C:/Saved/file.txt';

it('R214 готовый файл связывается по href, а одинаковое имя не перехватывает чужую сетевую ссылку', () => {
  const f = fixture(); f.add('first', 'done', 'blob:first'); f.add('second', 'done', 'blob:second');
  f.list.noteSavedFile({ url: 'blob:first', path });
  assert.equal(f.list.savedPathOf('first'), path);
  assert.equal(f.list.savedPathOf('second'), undefined);
  f.list.noteSavedFile({ url: 'https://files.example.test/not-our-record', path: 'C:/Saved/file (2).txt' });
  assert.equal(f.list.savedPathOf('second'), undefined, 'R214-network-name: HTTP не приклеивается по одному совпавшему имени');
  assert.equal(f.list.savedPathOf('no-row', 'https://files.example.test/not-our-record'), 'C:/Saved/file (2).txt');
});
function names(f: ReturnType<typeof fixture>) {
  f.add('plain', 'done', 'blob:plain', undefined, 'report.pdf');
  f.list.noteSavedFile({ path: 'C:\\Saved\\report (12).pdf' });
  assert.equal(f.list.savedPathOf('plain'), 'C:\\Saved\\report (12).pdf', 'R214-suffix: номер совпадения на диске не меняет имя записи');
  f.add('empty', 'done', 'blob:empty', undefined, 'no-extension');
  f.list.noteSavedFile({ url: 'blob:no-row', path: '/saved/no-extension (1)' });
  assert.equal(f.list.savedPathOf('empty'), '/saved/no-extension (1)');
}
it('R214 blob и пустая ссылка находят имя с номером совпадения на Windows и POSIX', () => names(fixture()));
it('R214 имя с внутренними скобками или другим расширением не связывается как номер копии', () => {
  const f = fixture(); f.add('plain', 'done', undefined, undefined, 'report.pdf');
  for (const p of ['/saved/report (x).pdf', '/saved/report (1).txt', '/saved/report(1).pdf']) {
    f.list.noteSavedFile({ path: p }); assert.equal(f.list.savedPathOf('plain'), undefined);
  }
  f.list.noteSavedFile({ path: '/saved/report.pdf' }); assert.equal(f.list.savedPathOf('plain'), '/saved/report.pdf');
});
it('R214 поиск по имени выбирает свежую готовую запись без пути, не loading и не уже связанную', () => {
  const f = fixture(); f.add('ready'); f.add('already', 'done', undefined, '/old/file.txt'); f.add('loading', 'loading');
  f.list.noteSavedFile({ path });
  assert.equal(f.list.savedPathOf('ready'), path); assert.equal(f.list.savedPathOf('already'), '/old/file.txt');
  assert.equal(f.list.savedPathOf('loading'), undefined);
});
it('R214 повтор ссылки заменяет путь, а пустой путь не стирает уже сохранённую привязку', () => {
  const f = fixture(); const url = 'https://files.example.test/a';
  f.list.noteSavedFile({ url, path }); f.list.noteSavedFile({ url, path: '/new/file.txt' });
  assert.equal(f.list.savedPathOf('unknown', url), '/new/file.txt');
  f.list.noteSavedFile({ url, path: '' }); assert.equal(f.list.savedPathOf('unknown', url), '/new/file.txt');
});
function completed(f: ReturnType<typeof fixture>) {
  f.add('ready', 'done', undefined, path);
  for (const state of ['loading', 'failed', 'cancelled'] as const) {
    f.add(state, state, undefined, path);
    assert.equal(f.list.savedPathOf(state), undefined, 'R214-completed: незавершённый файл не получает путь из записи');
  }
  assert.equal(f.list.savedPathOf('ready'), path);
  f.list.noteSavedFile({ url: '/fallback', path: '/saved/fallback.txt' });
  assert.equal(f.list.savedPathOf('loading', '/fallback'), '/saved/fallback.txt');
  f.add('without-path'); assert.equal(f.list.savedPathOf('without-path'), undefined);
}
it('R214 savedPathOf требует done и путь, а независимая привязка по ссылке остаётся fallback', () => completed(fixture()));
function cap(f: ReturnType<typeof fixture>) {
  for (let i = 0; i < 200; i++) f.list.noteSavedFile({ url: `/u${i}`, path: `/saved/${i}.txt` });
  assert.equal(f.list.savedPathOf('missing', '/u0'), '/saved/0.txt', 'ровно 200 ссылок ещё сохранены');
  f.list.noteSavedFile({ url: '/u200', path: '/saved/200.txt' });
  assert.equal(f.list.savedPathOf('missing', '/u0'), undefined, 'R214-cap: 201-я ссылка вытесняет самую старую');
  assert.equal(f.list.savedPathOf('missing', '/u1'), '/saved/1.txt');
  assert.equal(f.list.savedPathOf('missing', '/u200'), '/saved/200.txt');
}
it('R214 таблица путей принимает 200 ссылок и при 201 вытесняет первую', () => cap(fixture()));
it('R214 повтор старой ссылки обновляет её свежесть, вытесняя следующую вместо неё', () => {
  const f = fixture(); for (let i = 0; i < 200; i++) f.list.noteSavedFile({ url: `/u${i}`, path: `/saved/${i}` });
  f.list.noteSavedFile({ url: '/u0', path: '/new/0' }); f.list.noteSavedFile({ url: '/u200', path: '/saved/200' });
  assert.equal(f.list.savedPathOf('missing', '/u0'), '/new/0'); assert.equal(f.list.savedPathOf('missing', '/u1'), undefined);
});

for (const options of [{ shell: false }, { native: true }]) it(`R214 ${options.shell === false ? 'веб без Tauri' : 'Android с нативными файлами'} не предлагает папку даже при известном пути`, () => {
  const f = fixture(options); f.add('known', 'done', undefined, path);
  assert.equal(f.pc.showInFolderAvailable(), false); assert.equal(f.pc.savedFilePath('known'), undefined);
  f.pc.showInFolder(path); assert.deepEqual(f.invokes, []);
});
it('R214 оболочка с известным путём предлагает папку, неизвестный файл пункта не получает', () => {
  const f = fixture(); f.add('known', 'done', undefined, path);
  assert.equal(f.pc.showInFolderAvailable(), true); assert.equal(f.pc.savedFilePath('known'), path);
  assert.equal(f.pc.savedFilePath('missing'), undefined);
  f.list.noteSavedFile({ url: '/photo', path }); assert.equal(f.pc.savedFilePath('photo', '/photo'), path);
});
it('R214 показать папку передаёт полный путь в gv_show_in_folder, а пустой ничего не вызывает', async () => {
  const f = fixture(); f.pc.showInFolder(''); assert.equal(f.invokes.length, 0);
  f.pc.showInFolder(path); await settle();
  assert.deepEqual(plain(f.invokes), [{ command: 'gv_show_in_folder', args: { path } }]); assert.deepEqual(f.notices, []);
});
it('R214 отказ оболочки показать удалённый файл становится одним тостом, не необработанным rejection', async () => {
  const f = fixture({ reject: true }); f.pc.showInFolder(path); await settle();
  assert.deepEqual(f.notices, [['error', 'Не удалось показать файл в папке', 'Файл или папка уже недоступны']]);
});
it('R214 done сохраняет url и path в настоящем списке, действие тоста вызывает настоящий мост', async () => {
  const f = fixture(); f.downloads.initDownloads(); f.downloads.initDownloads(); assert.deepEqual(f.mirrored, [null]);
  f.events().done!({ name: 'file.txt', dir: 'C:/Saved', path, url: '/photo' });
  assert.equal(f.list.savedPathOf('photo', '/photo'), path, 'R214-event-path: событие привязало ссылку к пути');
  const notice = f.notices.at(-1)!;
  assert.deepEqual(notice.slice(0, 3), ['success', 'Файл скачан', 'file.txt → C:/Saved']);
  const action = (notice[3] as { action: { label: string; onClick(): void } }).action;
  assert.equal(action.label, 'Показать в папке'); action.onClick(); await settle();
  assert.deepEqual(plain(f.invokes), [{ command: 'gv_show_in_folder', args: { path } }]);
});
it('R214 done без пути сохраняет прежний тост без действия и без выдуманной привязки', () => {
  const f = fixture(); f.downloads.initDownloads(); f.events().done!({ name: 'file.txt', dir: '', path: '', url: '/photo' });
  assert.deepEqual(f.notices, [['success', 'Файл скачан', 'file.txt', undefined]]);
  assert.equal(f.list.savedPathOf('photo', '/photo'), undefined); assert.equal(f.invokes.length, 0);
});
it('R214 failed не сообщает сохранение и не создаёт пункт показа папки', () => {
  const f = fixture(); f.downloads.initDownloads(); f.events().failed!({ name: 'file.txt', dir: 'C:/Saved', path, url: '/photo' });
  assert.deepEqual(f.notices, [['error', 'Не удалось скачать файл', 'file.txt — загрузка прервана']]);
  assert.equal(f.list.savedPathOf('photo', '/photo'), undefined);
});
it('R214 подпись сохранённого файла различает фильмы, музыку и загрузки', () => {
  const f = fixture();
  for (const [mime, expected] of [['video/mp4', 'Фильмы'], ['audio/ogg', 'Музыку'], ['image/png', 'Загрузки'], ['application/pdf', 'Загрузки'], ['', 'Загрузки']])
    assert.equal(f.actions.savedToText(mime), `Сохранено в «${expected}»`);
});
it('R214 папка в просмотрщике стоит между сохранением и удалением без изменения исходного списка', () => {
  const items = [{ id: 'delete' }, { id: 'folder' }, { id: 'save' }] as const;
  assert.deepEqual(viewerRules.orderViewerMenu(items), [items[2], items[1], items[0]]);
  assert.deepEqual(items.map(i => i.id), ['delete', 'folder', 'save']);
});

for (const [name, from, to, scenario, prefix, actual, expected] of [
  ['HTTP ошибочно связывается по имени', "(!url || url.startsWith('blob:'))", 'true', (f: ReturnType<typeof fixture>) => {
    f.add('file'); f.list.noteSavedFile({ url: 'https://files.example.test/other', path });
    assert.equal(f.list.savedPathOf('file'), undefined, 'R214-network-name: HTTP не ищется по имени');
  }, 'R214-network-name:', path, undefined],
  ['номер копии не снимается', "onDisk.replace(/ \\(\\d+\\)(?=(\\.[^.]*)?$)/, '')", 'onDisk', names,
    'R214-suffix:', undefined, 'C:\\Saved\\report (12).pdf'],
  ['не готовая запись выдаёт путь', "e.key === key && e.state === 'done' && e.path", 'e.key === key && e.path', completed,
    'R214-completed:', path, undefined],
  ['201-я ссылка остаётся навсегда', 'savedByUrl.size > SAVED_BY_URL_MAX', 'false', cap,
    'R214-cap:', '/saved/0.txt', undefined],
] as const) it(`R214 контрфакт сохранённых путей: ${name}`, () => {
  scenario(fixture());
  const mutant = fixture({ mutation: { module: 'downloadList', from, to } });
  assert.throws(() => scenario(mutant), (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith(prefix)
    && e.operator === 'strictEqual' && Object.is(e.actual, actual) && Object.is(e.expected, expected));
});
