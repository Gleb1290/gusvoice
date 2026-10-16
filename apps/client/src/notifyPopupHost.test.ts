import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './notifyPopupRules';
import type { PopupSink } from './notifications';

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const hostSource = readFileSync(new URL('./notifyPopupHost.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function popupId(args: unknown): string {
  assert.ok(args && typeof args === 'object' && 'payload' in args);
  const payload = args.payload;
  assert.ok(payload && typeof payload === 'object' && 'kind' in payload && payload.kind === 'show' && 'notice' in payload);
  const notice = payload.notice;
  assert.ok(notice && typeof notice === 'object' && 'id' in notice && typeof notice.id === 'string');
  return notice.id;
}
function fixture(options: { desktop?: boolean; core?: boolean; native?: boolean } = {}, hostRaw = hostSource) {
  let sink: PopupSink | undefined;
  const storage = new Map<string, string>(); if (options.native) storage.set('gv_notify_popup', '{"native":true}');
  const calls: { cmd: string; args?: unknown }[] = [];
  // JSON-копия для прежних проверок стирает kind: undefined — отдельно сохраняем настоящий объект границы IPC.
  const rawCalls: { cmd: string; args?: unknown }[] = [];
  let result: unknown = ['Первый', 1, 'Второй', null], fail = false;
  const core = { invoke(cmd: string, args?: unknown) { rawCalls.push({ cmd, args }); calls.push({ cmd, args: plain(args ?? null) }); return fail ? Promise.reject(new Error('fixture IPC failure')) : Promise.resolve(result); } };
  function execute(name: string, dependencies: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const module = { exports: {} };
    const source = name === 'notifyPopupHost' ? hostRaw : readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8');
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
      module, exports: module.exports, ...extra,
      require(id: string) { assert.ok(Object.hasOwn(dependencies, id), `неожиданная зависимость ${id}`); return dependencies[id]; },
    });
    return module.exports;
  }
  const prefs = execute('notifyPopupPrefs', { './notifyPopupRules': rules }, { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value),
  } }) as typeof import('./notifyPopupPrefs');
  const api = execute('notifyPopupHost', {
    './hotkeys': { isDesktop: () => options.desktop !== false }, './notifications': { setNotifyPopupSink(value: PopupSink) { sink = value; } }, './notifyPopupPrefs': prefs,
  }, { window: options.core === false ? {} : { __TAURI__: { core } } }) as typeof import('./notifyPopupHost');
  let fallbacks = 0;
  const data: Parameters<PopupSink['show']>[0] = { tag: 'tag-7', title: 'Группа', author: 'Имя1', body: 'Привет', avatar: '/avatar.png', conv: 'conv-7', group: 'group-7', fallback() { fallbacks++; } };
  return { api, prefs, calls, rawCalls, data, get sink() { return sink; }, get fallbacks() { return fallbacks; }, fail() { fail = true; }, result(value: unknown) { result = value; } };
}
it('R223 свои окна получают все поля карточки и настройки через push, повторная инициализация не дублирует подписку', () => {
  const f = fixture(); f.api.initNotifyPopups(); f.api.initNotifyPopups(); assert.ok(f.sink);
  f.prefs.setNotifyPopupPrefs({ corner: 'tl', count: 5, monitor: 'Второй' });
  assert.deepEqual(f.calls, [{ cmd: 'gv_notify_popup_push', args: { payload: { kind: 'prefs', corner: 'tl', max: 5, monitor: 'Второй', native: false } } }]);
  f.calls.length = 0; assert.equal(f.sink.show(f.data), true); assert.equal(f.calls.length, 1);
  const id = popupId(f.calls[0]!.args); assert.match(id, /^p1-\d+$/);
  assert.deepEqual(f.calls, [{ cmd: 'gv_notify_popup_push', args: { payload: { kind: 'show', notice: { id, tag: 'tag-7', title: 'Группа', author: 'Имя1', body: 'Привет', avatar: '/avatar.png', conv: 'conv-7', group: 'group-7' }, corner: 'tl', max: 5, monitor: 'Второй' } } }]);
  f.sink.clear('group-7'); assert.deepEqual(f.calls.at(-1), { cmd: 'gv_notify_popup_push', args: { payload: { kind: 'clear', group: 'group-7' } } });
});
it('R223 системный режим отказывается от своих карточек, выключение режима немедленно возвращает их', () => {
  const f = fixture({ native: true }); f.api.initNotifyPopups(); assert.ok(f.sink);
  assert.equal(f.sink.show(f.data), false); f.sink.clear('group-7'); assert.equal(f.calls.length, 0);
  f.prefs.setNotifyPopupPrefs({ native: false }); assert.equal(f.sink.show(f.data), true); assert.equal(f.calls.length, 2);
  f.prefs.setNotifyPopupPrefs({ native: true });
  assert.deepEqual(f.calls.at(-1), { cmd: 'gv_notify_popup_push', args: { payload: { kind: 'prefs', corner: 'br', max: 3, monitor: '', native: true } } });
});
it('R223 отказ команды показа вызывает системный fallback ровно один раз, успешный push его не вызывает', async () => {
  const f = fixture(); f.api.initNotifyPopups(); assert.ok(f.sink);
  assert.equal(f.sink.show(f.data), true); await Promise.resolve(); assert.equal(f.fallbacks, 0);
  f.fail(); assert.equal(f.sink.show(f.data), true); await Promise.resolve(); assert.equal(f.fallbacks, 1);
  f.sink.clear('group-7'); f.prefs.setNotifyPopupPrefs({ count: 2 }); await Promise.resolve(); assert.equal(f.fallbacks, 1, 'ошибки служебных сообщений не порождают тост');
});
it('R223 веб, Android и сборка без core не устанавливают приёмник и не отправляют настройки', async () => {
  for (const options of [{ desktop: false }, { core: false }]) {
    const f = fixture(options); f.api.initNotifyPopups(); assert.equal(f.sink, undefined);
    f.prefs.setNotifyPopupPrefs({ count: 1 }); assert.equal(f.calls.length, 0); assert.deepEqual(Array.from(await f.api.notifyPopupMonitors()), []);
  }
});
it('R223 список мониторов берётся только из desktop IPC, отбрасывает нестроковые записи и переживает отказ', async () => {
  const f = fixture(); assert.deepEqual(Array.from(await f.api.notifyPopupMonitors()), ['Первый', 'Второй']);
  assert.equal(f.calls[0]!.cmd, 'gv_notify_popup_monitors');
  f.result({ bad: 'shape' }); assert.deepEqual(Array.from(await f.api.notifyPopupMonitors()), []);
  f.fail(); assert.deepEqual(Array.from(await f.api.notifyPopupMonitors()), []);
});

function kindPresence(raw = hostSource) {
  const f = fixture({}, raw); f.api.initNotifyPopups(); assert.ok(f.sink);
  for (const kind of [undefined, '', 'Фото']) {
    assert.equal(f.sink.show({ ...f.data, kind }), true);
    const call = f.rawCalls.at(-1)!;
    assert.equal(call.cmd, 'gv_notify_popup_push');
    const payload = (call.args as { payload: { kind: string; notice: Record<string, unknown> } }).payload;
    assert.equal(payload.kind, 'show');
    assert.equal(Object.prototype.hasOwnProperty.call(payload.notice, 'kind'), Boolean(kind), 'R233-host-kind-presence: отсутствующий вид не передаётся даже ключом undefined');
    assert.equal(payload.notice.kind, kind || undefined);
    assert.equal(payload.notice.body, 'Привет');
  }
  assert.equal(f.rawCalls.length, 3); assert.equal(f.fallbacks, 0);
}
it('R233 IPC передаёт kind только при непустом виде и сохраняет подпись отдельно', () => kindPresence());
it('R233 контрфакт IPC: отсутствующий вид всё равно передан ключом undefined', () => {
  kindPresence(hostSource);
  const from = '...(d.kind ? { kind: d.kind } : {}),';
  assert.equal(hostSource.split(from).length - 1, 1);
  assert.throws(() => kindPresence(hostSource.replace(from, 'kind: d.kind,')), e => e instanceof assert.AssertionError
    && e.message.startsWith('R233-host-kind-presence:') && e.operator === 'strictEqual' && e.actual === true && e.expected === false);
});
