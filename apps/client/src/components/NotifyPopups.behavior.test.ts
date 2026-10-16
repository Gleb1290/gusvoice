import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import type { Root } from 'react-dom/client';
import ts from 'typescript';
import * as rules from '../notifyPopupRules';
import type { PopupMessage } from '../notifyPopupHost';

let createRoot: typeof import('react-dom/client').createRoot;
let avatar: typeof import('./Avatar');
const source = readFileSync(new URL('./NotifyPopups.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
async function flush(run?: () => void) {
  await React.act(async () => { run?.(); await new Promise<void>(resolve => setImmediate(resolve)); });
}
before(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  createRoot = (await import('react-dom/client')).createRoot;
  avatar = await import('./Avatar');
});
after(async () => {
  await GlobalRegistrator.unregister();
});

async function mount(raw = source) {
  const calls: { cmd: string; args: unknown }[] = [], intervals = new Map<number, () => void>();
  const unexpectedIO: string[] = [];
  let now = 1000, idle: number | null = 0, timerSeq = 0, off = 0;
  let listener: ((event: { payload: unknown }) => void) | undefined;
  const previousTauri = (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  (window as unknown as { __TAURI__: unknown }).__TAURI__ = {
    core: { invoke(cmd: string, args?: unknown) {
      const allowed = ['gv_notify_popup_layout', 'gv_notify_popup_action', 'gv_os_idle_ms'].includes(cmd);
      if (!allowed) unexpectedIO.push(cmd);
      assert.ok(allowed, `неожиданная IPC-команда ${cmd}`);
      calls.push({ cmd, args: plain(args ?? null) }); return Promise.resolve(cmd === 'gv_os_idle_ms' ? idle : null);
    } },
    event: { async listen(name: string, fn: (event: { payload: unknown }) => void) { assert.equal(name, 'gv-notify-popup'); listener = fn; return () => { off++; }; } },
  };
  class Clock extends Date { static now() { return now; } }
  const module = { exports: {} };
  const dependencies: Record<string, unknown> = { react: React, 'react/jsx-runtime': jsxRuntime, './Avatar': avatar, '../notifyPopupRules': rules };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, window, Date: Clock,
    setInterval(fn: () => void, delay: number) { assert.equal(delay, 300); intervals.set(++timerSeq, fn); return timerSeq; },
    clearInterval(id: number) { intervals.delete(id); },
    require(id: string) { assert.ok(Object.hasOwn(dependencies, id), `неожиданная зависимость ${id}`); return dependencies[id]; },
  });
  const component = (module.exports as typeof import('./NotifyPopups')).NotifyPopups;
  const host = document.createElement('div'); document.body.append(host); const root: Root = createRoot(host);
  await flush(() => root.render(React.createElement(component))); await flush();
  const cards = () => Array.from(host.querySelectorAll<HTMLElement>('.nfp-card'));
  return { host, calls, cards,
    async show(id: string, conv: string | undefined = `conv-${id}`, group = id, max = 3) {
      const message: PopupMessage = { kind: 'show', notice: { id, tag: `tag-${id}`, title: `Чат ${id}`, author: 'Имя1', body: `Текст ${id}`, conv, group }, corner: 'br', max, monitor: '' };
      await flush(() => { assert.ok(listener); listener({ payload: message }); }); await flush();
    },
    async message(message: PopupMessage) { await flush(() => { assert.ok(listener); listener({ payload: message }); }); await flush(); },
    async tick(at: number, systemIdle: number | null) { now = at; idle = systemIdle; await flush(() => { for (const fn of [...intervals.values()]) fn(); }); await flush(); },
    async close() {
      try { await flush(() => root.unmount()); }
      finally { host.remove(); (window as unknown as { __TAURI__?: unknown }).__TAURI__ = previousTauri; }
      assert.deepEqual(unexpectedIO, [], 'неожиданные IPC не должны скрываться за catch компонента');
      assert.equal(off, 1); assert.equal(intervals.size, 0);
    },
  };
}
it('R223 четыре показа дают три карточки и «Скрыть все», закрытие добирает очередь без действия open', async () => {
  const f = await mount();
  try {
    for (const id of ['1', '2', '3', '4']) await f.show(id);
    assert.equal(f.cards().length, 3); assert.equal(f.host.querySelector('.nfp-hide-all')?.textContent, 'Скрыть все');
    assert.equal(f.host.textContent!.includes('Текст 4'), false); assert.match(f.host.textContent!, /Имя1: Текст 1/);
    await flush(() => f.cards()[0]!.querySelector<HTMLButtonElement>('.nfp-close')!.click());
    assert.equal(f.cards().length, 3); assert.match(f.host.textContent!, /Текст 4/); assert.equal(f.host.textContent!.includes('Текст 1'), false);
    await flush(() => f.cards()[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    assert.equal(f.cards().length, 2); assert.equal(f.calls.filter(c => c.cmd === 'gv_notify_popup_action').length, 0);
    await flush(() => f.host.querySelector<HTMLButtonElement>('.nfp-hide-all')!.click()); assert.equal(f.cards().length, 0);
  } finally { await f.close(); }
});
it('R223 клик открывает адресованную беседу и снимает её карточки также из очереди', async () => {
  const f = await mount();
  try {
    await f.show('1', 'conv-A', 'A'); await f.show('2', 'conv-B', 'B'); await f.show('3', 'conv-A', 'A'); await f.show('4', 'conv-A', 'A');
    await flush(() => f.cards()[0]!.click());
    assert.deepEqual(f.calls.filter(c => c.cmd === 'gv_notify_popup_action'), [{ cmd: 'gv_notify_popup_action', args: { action: 'open', tag: 'tag-1', group: 'conv-A', text: null } }]);
    assert.equal(f.cards().length, 1); assert.match(f.host.textContent!, /Чат 2/); assert.equal(f.host.querySelector('.nfp-hide-all'), null);
  } finally { await f.close(); }
});
it('R223 «Ответить» не открывает беседу; Enter отправляет обрезанный текст, Shift+Enter и пустая строка не отправляют', async () => {
  const f = await mount();
  try {
    await f.show('1'); await flush(() => f.host.querySelector<HTMLButtonElement>('.nfp-reply-btn')!.click());
    assert.equal(f.calls.filter(c => c.cmd === 'gv_notify_popup_action').length, 0);
    const input = f.host.querySelector<HTMLTextAreaElement>('textarea')!; assert.ok(input);
    await flush(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    assert.equal(f.calls.filter(c => c.cmd === 'gv_notify_popup_action').length, 0);
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await flush(() => { setValue.call(input, '  Ответ  '); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await flush(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })));
    assert.equal(f.calls.filter(c => c.cmd === 'gv_notify_popup_action').length, 0);
    await flush(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    assert.deepEqual(f.calls.filter(c => c.cmd === 'gv_notify_popup_action'), [{ cmd: 'gv_notify_popup_action', args: { action: 'reply', tag: 'tag-1', group: 'conv-1', text: 'Ответ' } }]); assert.equal(f.cards().length, 0);
    await f.message({ kind: 'show', notice: { id: '2', tag: 'tag-2', title: 'Канал', body: 'Без ответа' }, corner: 'br', max: 3, monitor: '' });
    assert.equal(f.cards().length, 1); assert.equal(f.host.querySelector('.nfp-reply-btn'), null);
    await f.message({ kind: 'prefs', native: true, corner: 'br', max: 3, monitor: '' }); assert.equal(f.cards().length, 0);
  } finally { await f.close(); }
});
it('R223 clear удаляет беседу из очереди, prefs меняет порядок/вместимость и системный режим очищает всё', async () => {
  const f = await mount();
  try {
    for (const id of ['1', '2', '3', '4']) await f.show(id);
    await f.message({ kind: 'clear', group: '4' });
    await f.message({ kind: 'prefs', native: false, corner: 'tl', max: 2, monitor: 'Второй' });
    assert.deepEqual(f.cards().map(c => c.querySelector('.nfp-title')!.textContent), ['Чат 3', 'Чат 2']);
    await flush(() => f.cards()[0]!.querySelector<HTMLButtonElement>('.nfp-close')!.click());
    assert.deepEqual(f.cards().map(c => c.querySelector('.nfp-title')!.textContent), ['Чат 1', 'Чат 2']);
    await f.message({ kind: 'prefs', native: true, corner: 'tl', max: 2, monitor: '' }); assert.equal(f.cards().length, 0);
    assert.ok(f.calls.some(c => c.cmd === 'gv_notify_popup_layout'), 'проверяется только вызов layout, не геометрия happy-dom');
  } finally { await f.close(); }
});
async function idleCheck(raw = source) {
  const f = await mount(raw);
  try {
    await f.show('1');
    await f.tick(1300, 1000); await f.tick(5000, 4700);
    assert.equal(f.cards()[0]?.style.opacity, '1', 'R223-input-wait: без ввода после показа карточка не угасает');
    await f.tick(9000, 8700); assert.equal(f.cards().length, 1);
    await f.tick(10000, 0); await f.tick(12999, 0); assert.equal(f.cards()[0]?.style.opacity, '1');
    await f.tick(13000, 0); assert.equal(f.cards()[0]?.style.opacity, '0');
    await f.tick(16999, 0); assert.equal(f.cards().length, 1); await f.tick(17000, 0); assert.equal(f.cards().length, 0);
  } finally { await f.close(); }
}
it('R223 без человеческого ввода уведомление ждёт, после ввода живёт 3 секунды и угасает 4 секунды', () => idleCheck());
it('R223 контрфакт таймера без проверки человеческого ввода отвергается поведенческой проверкой', async () => {
  await idleCheck(source);
  const from = "p.kind === 'wait' && popupInputSeen(p.at, now, idle)"; assert.equal(source.split(from).length - 1, 1);
  await assert.rejects(idleCheck(source.replace(from, "p.kind === 'wait'")), e => e instanceof assert.AssertionError
    && e.message.startsWith('R223-input-wait:') && e.operator === 'strictEqual' && e.actual === '0' && e.expected === '1');
});

type Fixture = Awaited<ReturnType<typeof mount>>;
function measuredRect(f: Fixture, width: number, height = 93.25) {
  const root = f.host.querySelector<HTMLElement>('.nfp-root'); assert.ok(root);
  // happy-dom не считает CSS-layout/zoom: задаём именно результат экранного измерения, а не style.width.
  root.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({ width, height }) });
}
function layouts(f: Fixture) {
  return f.calls.filter(c => c.cmd === 'gv_notify_popup_layout').map(c => c.args as { w: number; h: number; corner: string; monitor: string | null });
}
async function widthCheck(width: number, raw = source) {
  const f = await mount(raw);
  try {
    measuredRect(f, width);
    await f.show('width');
    const sent = layouts(f).at(-1); assert.ok(sent);
    assert.equal(sent.w, width || 320, width ? 'R233-width-measured: окно получает экранную ширину, не константу карточки' : 'R233-width-fallback: нулевая ширина заменяется на 320');
    assert.deepEqual(sent, { w: width || 320, h: 94, corner: 'br', monitor: null });
    assert.equal(f.cards().length, 1);
  } finally { await f.close(); }
}
it('R233 измеренные 368 px уходят в layout.w как 368, высота округляется вверх', () => widthCheck(368));
it('R233 нулевое измерение показанной карточки даёт запасную ширину 320 px', () => widthCheck(0));

async function storageLayoutCheck(raw = source) {
  const f = await mount(raw);
  try {
    measuredRect(f, 368);
    await f.show('storage');
    assert.equal(layouts(f).at(-1)?.w, 368);
    const before = layouts(f).length;
    // Без новой карточки и ResizeObserver только storage заставит перечитать изменившийся zoom.
    measuredRect(f, 416, 108.25);
    await flush(() => window.dispatchEvent(new StorageEvent('storage', { key: 'gv_ui_scale', oldValue: '1.15', newValue: '1.3' })));
    await flush();
    assert.equal(layouts(f).length - before, 1, 'R233-storage-layout: изменение масштаба вызывает ровно один новый layout');
    assert.deepEqual(layouts(f).at(-1), { w: 416, h: 109, corner: 'br', monitor: null });
    assert.equal(f.cards().length, 1);
    assert.equal(f.calls.filter(c => c.cmd === 'gv_notify_popup_action').length, 0);
  } finally { await f.close(); }
}
it('R233 storage перемеряет уже показанную стопку без нового уведомления', () => storageLayoutCheck());

async function lineDomCheck(raw = source) {
  const f = await mount(raw);
  const notices: rules.PopupNotice[] = [
    { id: 'caption', tag: 'caption', title: 'Группа', author: 'Имя1', kind: 'Фото', body: 'Летний день', conv: 'conv-caption' },
    { id: 'location', tag: 'location', title: 'Канал', kind: 'Геопозиция в реальном времени', body: '' },
    { id: 'group-text', tag: 'group-text', title: 'Группа', author: 'Имя2', body: 'Обычный текст', conv: 'conv-text' },
    { id: 'direct-text', tag: 'direct-text', title: 'Личное', body: 'Без автора и вложения', conv: 'conv-direct' },
  ];
  try {
    for (const notice of notices) {
      await f.message({ kind: 'show', notice, corner: 'br', max: 3, monitor: '' });
      assert.equal(f.cards().length, 1);
      const card = f.cards()[0]!, body = card.querySelector<HTMLElement>('.nfp-body'); assert.ok(body);
      assert.equal(body.textContent, rules.popupLine(notice), 'R233-body-line: строка DOM совпадает с настоящим popupLine без потерь и лишних разделителей');
      const expectedFrom = notice.author ? `${notice.author}: ` : null;
      const expectedKind = notice.kind ? `${notice.kind}${notice.body ? ', ' : ''}` : null;
      assert.equal(body.querySelector('.nfp-from')?.textContent ?? null, expectedFrom, 'R233-body-from: автор выделен внутри строки превью');
      assert.equal(body.querySelector('.nfp-kind')?.textContent ?? null, expectedKind, 'R233-body-kind: вид вложения выделен внутри строки превью');
      const reply = card.querySelector<HTMLButtonElement>('.nfp-reply-btn');
      if (notice.conv) {
        assert.ok(reply);
        assert.equal(reply.closest('.nfp-actions') !== null, true, 'R233-reply-actions: кнопка ответа находится внутри слоя действий');
        assert.equal(card.querySelector('.nfp-actions')?.contains(reply), true);
        assert.equal(reply.textContent?.trim(), 'Ответить');
      } else {
        assert.equal(reply, null); assert.equal(card.querySelector('.nfp-actions'), null);
      }
      await f.message({ kind: 'prefs', native: true, corner: 'br', max: 3, monitor: '' });
    }
  } finally { await f.close(); }
}
it('R233 автор и вид вложения выделены в полном popupLine, ответ лежит в actions только у бесед', () => lineDomCheck());

const actionsLayer = source.match(/<div className="nfp-actions">[\s\S]*?<\/div>/)?.[0] ?? '';
for (const mutant of [
  { label: 'экранная ширина заменена константой', from: 'const w = r ? Math.ceil(r.width) || POPUP_WIDTH : POPUP_WIDTH;', to: 'const w = POPUP_WIDTH;', check: (raw: string) => widthCheck(368, raw), prefix: 'R233-width-measured:', actual: 320, expected: 368 },
  { label: 'убрана запасная ширина при нулевом измерении', from: 'Math.ceil(r.width) || POPUP_WIDTH', to: 'Math.ceil(r.width)', check: (raw: string) => widthCheck(0, raw), prefix: 'R233-width-fallback:', actual: 0, expected: 320 },
  { label: 'не подписывается на storage', from: "window.addEventListener('storage', bump);", to: 'void bump;', check: storageLayoutCheck, prefix: 'R233-storage-layout:', actual: 0, expected: 1 },
  { label: 'layout не зависит от restyle', from: '[stack.shown.length, corner, monitor, restyle]', to: '[stack.shown.length, corner, monitor]', check: storageLayoutCheck, prefix: 'R233-storage-layout:', actual: 0, expected: 1 },
  { label: 'ответ вне существующего слоя actions', from: actionsLayer, to: actionsLayer.replace('<div className="nfp-actions">', '<><div className="nfp-actions" />').replace('</div>', '</>'), check: lineDomCheck, prefix: 'R233-reply-actions:', actual: false, expected: true },
  { label: 'нет выделенного вида вложения', from: 'className="nfp-kind"', to: 'className="nfp-kind-missing"', check: lineDomCheck, prefix: 'R233-body-kind:', actual: null, expected: 'Фото, ' },
  { label: 'нет выделенного автора', from: 'className="nfp-from"', to: 'className="nfp-from-missing"', check: lineDomCheck, prefix: 'R233-body-from:', actual: null, expected: 'Имя1: ' },
  { label: 'подпись потеряна из строки превью', from: '{line.text}', to: "{''}", check: lineDomCheck, prefix: 'R233-body-line:', actual: 'Имя1: Фото, ', expected: 'Имя1: Фото, Летний день' },
]) it(`R233 контрфакт целого NotifyPopups: ${mutant.label}`, async () => {
  await mutant.check(source);
  assert.equal(source.split(mutant.from).length - 1, 1, `единственный якорь: ${mutant.label}`);
  await assert.rejects(() => mutant.check(source.replace(mutant.from, mutant.to)), e => e instanceof assert.AssertionError
    && e.message.startsWith(mutant.prefix) && e.operator === 'strictEqual' && e.actual === mutant.actual && e.expected === mutant.expected);
});
