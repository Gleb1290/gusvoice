import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as hotkeys from '../hotkeys';
import type { GeoPickMapProps, GeoSystemHooks } from './GeoPickDialog';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const raw = read('./GeoPickDialog.tsx');
const TIMER_CLEANUP_MESSAGE = 'R231-geo-restart-cleanup: таймеры опроса, подсказки и повтора сняты при закрытии';
before(() => { GlobalRegistrator.register({ url: 'https://geopick2.invalid' }); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
after(async () => { Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT'); await GlobalRegistrator.unregister(); });
type Options = { map?: boolean; off?: boolean; system?: boolean; accepted?: boolean; phone?: boolean };
type Fixture = {
  query(selector: string): Element | null; button(selector: string): HTMLButtonElement;
  watches: PositionOptions[]; cleared: number[]; sent: shared.ConvMediaInput[];
  systemOff(value: boolean): void; asks(): number; opens(): number; map(): GeoPickMapProps;
  click(selector: string): Promise<void>; fix(): Promise<void>; error(code: number): Promise<void>;
  advance(ms: number): Promise<void>; choose(): Promise<void>; failMap(): Promise<void>;
};
async function fixture(options: Options, check: (f: Fixture) => Promise<void>, source = raw) {
  let now = 0, nextTimer = 0, off = options.off ?? false, asks = 0, opens = 0;
  const timers = new Map<number, { due: number; repeat: number; run: () => void }>();
  const set = (run: () => void, delay = 0, repeat = false) => { const id = ++nextTimer; timers.set(id, { due: now + delay, repeat: repeat ? delay : 0, run }); return id; };
  const media = { matches: options.phone ?? true, addEventListener() {}, removeEventListener() {} };
  const physicalWindow = new Proxy(window, { get(target, key) {
    if (key === 'matchMedia') return () => media;
    if (key === 'setTimeout') return (run: () => void, ms?: number) => set(run, ms);
    if (key === 'setInterval') return (run: () => void, ms?: number) => set(run, ms, true);
    if (key === 'clearTimeout' || key === 'clearInterval') return (id: number) => timers.delete(id);
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  let success!: PositionCallback, failure!: PositionErrorCallback, mapProps!: GeoPickMapProps;
  const watches: PositionOptions[] = [], cleared: number[] = [], sent: shared.ConvMediaInput[] = [];
  const geolocation = {
    watchPosition(ok: PositionCallback, bad: PositionErrorCallback, opts: PositionOptions) { success = ok; failure = bad; watches.push(opts); return watches.length; },
    clearWatch(id: number) { cleared.push(id); },
  };
  function load<T>(text: string, deps: Record<string, unknown>): T {
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
      { module, exports: module.exports, window: physicalWindow, document, navigator: { geolocation }, HTMLElement, Element, Node, Event, console, performance,
        require(id: string) { assert.ok(Object.hasOwn(deps, id), `GeoPickDialog целиком: ${id}`); return deps[id]; } });
    return module.exports as T;
  }
  // Оболочки настоящие; аппаратная геолокация, часы, карта и системный мост — внешние границы.
  const common = { react: React, 'react/jsx-runtime': jsx, 'react-dom': ReactDOM };
  const icon = load(read('./Icon.tsx'), common);
  const phone = load(read('../phoneLayout.ts'), { react: React, './hotkeys': hotkeys });
  const back = load(read('../androidBack.ts'), { './hotkeys': hotkeys, './store': {} });
  const chrome = load(read('../dialogChrome.ts'), { react: React, './androidBack': back });
  const sheet = load(read('./BottomSheet.tsx'), { ...common, './Icon': icon });
  const { GeoPickDialog } = load<typeof import('./GeoPickDialog')>(source, { ...common, '@gusvoice/shared': shared,
    '../dialogChrome': chrome, '../phoneLayout': phone, '../toast': { toastError() { assert.fail('отправка не должна падать'); } }, './BottomSheet': sheet, './Icon': icon });
  const system: GeoSystemHooks = { off: () => off, canOpen: () => true, open: () => { opens++; }, ask: async () => { asks++; return options.accepted ?? false; } };
  const MapSlot = (props: GeoPickMapProps) => { mapProps = props; return React.createElement('div', { 'data-map-stub': true }); };
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const act = async (run: () => void) => { await React.act(async () => { run(); for (let i = 0; i < 10; i++) await Promise.resolve(); }); };
  const query = (selector: string) => document.querySelector(selector);
  const button = (selector: string) => { const node = query(selector); assert.ok(node instanceof HTMLButtonElement, selector); return node; };
  try {
    await act(() => root.render(React.createElement(GeoPickDialog, { live: true, system: options.system ? system : undefined, map: options.map ? MapSlot : undefined,
      onClose() {}, async onSend(value) { sent.push(value); } })));
    await check({ query, button, watches, cleared, sent, systemOff: value => { off = value; }, asks: () => asks, opens: () => opens, map: () => mapProps,
      click: selector => act(() => button(selector).click()),
      fix: () => act(() => success({ coords: { latitude: 55, longitude: 37, accuracy: 8 } } as GeolocationPosition)),
      error: code => act(() => failure({ code } as GeolocationPositionError)),
      choose: () => act(() => mapProps.onUserMove({ lat: 59, lon: 30 })), failMap: () => act(() => mapProps.onFail()),
      async advance(ms) {
        const end = now + ms;
        // Таймеры исполняются только при достижении due, по одному с flush React между тиками.
        for (;;) {
          const entry = [...timers.entries()].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
          if (!entry) break;
          const [id, timer] = entry; now = timer.due;
          if (timer.repeat) timer.due += timer.repeat; else timers.delete(id);
          await act(timer.run);
        }
        now = end;
      },
    });
  } finally { await act(() => root.unmount()); host.remove(); }
  assert.deepEqual(cleared, watches.map((_watch, index) => index + 1), 'все реальные watch сняты при перезапуске/закрытии');
  assert.equal(timers.size, 0, TIMER_CLEANUP_MESSAGE);
}

async function systemCycle(source = raw) {
  await fixture({ system: true, off: true }, async f => {
    assert.equal(f.watches.length, 0); assert.equal(f.asks(), 1);
    assert.match(f.query('[role=alert]')?.textContent ?? '', /Геолокация выключена/);
    await f.click('.geo-pick-error button'); assert.equal(f.opens(), 1);
    await f.advance(3000); assert.equal(f.asks(), 1);
    f.systemOff(false); await f.advance(999); assert.equal(f.watches.length, 0);
    await f.advance(1); assert.equal(f.watches.length, 1, 'R230-geo-poll: включённая система запускает поиск по опросу');
    f.systemOff(true); await f.error(3); assert.equal(f.cleared.length, 1);
    assert.match(f.query('[role=alert]')?.textContent ?? '', /Геолокация выключена/);
    assert.equal(f.asks(), 1, 'R230-geo-asked: повторный off не повторяет системный вопрос');
    await f.advance(2000); assert.equal(f.watches.length, 1);
  }, source);
}
it('R230 выключенная система не запускает watch, спрашивает один раз и после включения начинает поиск', () => systemCycle());
it('R230 согласие в системном вопросе открывает настройки, а новое открытие спрашивает заново', async () => {
  // Флаг одноразового вопроса принадлежит открытию, не всему процессу приложения.
  for (let opening = 0; opening < 2; opening++) await fixture({ system: true, off: true, accepted: true }, async f => {
    assert.equal(f.asks(), 1); assert.equal(f.opens(), 1); assert.equal(f.watches.length, 0);
  });
});
async function timeout(source = raw) {
  await fixture({}, async f => {
    assert.equal(f.watches.length, 1); await f.error(3);
    assert.equal(f.query('[role=alert]') !== null, false, 'R231-geo-timeout: код 3 не становится ошибкой');
    await f.advance(60_000); assert.equal(f.watches.length, 1); assert.equal(f.button('.geo-pick-send').disabled, true);
    assert.ok(f.query('.geo-pick-slow'));
  }, source);
}
it('R231 таймаут без fix ждёт дальше без ошибки, нового watch и доступной отправки', () => timeout());
async function slow(source = raw) {
  await fixture({ map: true }, async f => {
    await f.advance(0); assert.equal(f.query('.geo-pick-slow') !== null, false, 'R231-geo-slow-early: подсказка не показывается сразу');
    await f.advance(14_999); assert.equal(f.query('.geo-pick-slow'), null);
    await f.advance(1); assert.ok(f.query('.geo-pick-slow')); assert.match(f.query('.geo-pick-slow')!.textContent!, /сдвинуть карту/);
    await f.fix(); assert.equal(f.query('.geo-pick-slow') !== null, false, 'R231-geo-slow-fix: найденное место убирает подсказку');
  }, source);
}
it('R231 подсказка появляется ровно через 15 секунд и исчезает после настоящей точки', () => slow());
it('R231 недоступное место повторяет watch через 5 секунд ровно один раз и снимает прежний', () => fixture({}, async f => {
  await f.error(2); await f.error(2); assert.equal(f.query('[role=alert]'), null); assert.ok(f.query('.geo-pick-slow'));
  await f.advance(4999); assert.equal(f.watches.length, 1); assert.deepEqual(f.cleared, []);
  await f.advance(1); assert.equal(f.watches.length, 2); assert.deepEqual(f.cleared, [1]);
  await f.advance(5000); assert.equal(f.watches.length, 2);
}));
async function pendingRestart(source = raw) {
  await fixture({}, async f => {
    await f.error(2); await f.advance(4999);
    assert.equal(f.watches.length, 1); assert.deepEqual(f.cleared, []);
    // Закрываем ДО due повтора: уже сработавший таймер не доказывает исправность clearTimeout в cleanup.
  }, source);
}
it('R231 закрытие за миллисекунду до повтора снимает ожидающий таймер и действующий watch', () => pendingRestart());
async function selected(source = raw) {
  // Разные координаты fix и центра выявляют случайную отправку прежнего устройства вместо выбора.
  for (const haveFix of [true, false]) await fixture({ map: true }, async f => {
    if (haveFix) await f.fix(); await f.choose();
    assert.equal(f.button('.geo-pick-send').disabled, false); assert.match(f.button('.geo-pick-send').textContent!, /Отправить выбранное место/);
    assert.equal(f.map().follow, false); await f.click('.geo-pick-send');
    assert.equal(JSON.stringify(f.sent), JSON.stringify([{ kind: 'geo', lat: 59, lon: 30, accuracy: null }]), 'R231-geo-selected: отправляется выбранный центр без точности');
  }, source);
}
it('R231 сдвинутая карта отправляет выбранный центр без точности как с fix, так и без него', () => selected());
it('R231 К моему месту сбрасывает выбор, увеличивает recenter и отправляет настоящую точку с точностью', () => fixture({ map: true }, async f => {
  await f.fix(); await f.choose(); const before = f.map().recenter;
  await f.click('.geo-pick-map-me'); assert.equal(f.map().recenter, before + 1); assert.equal(f.map().follow, true);
  assert.match(f.button('.geo-pick-send').textContent!, /Отправить моё местоположение/);
  await f.click('.geo-pick-send'); assert.equal(JSON.stringify(f.sent), JSON.stringify([{ kind: 'geo', lat: 55, lon: 37, accuracy: 8 }]));
}));
async function liveNoFix(source = raw) {
  await fixture({ map: true }, async f => {
    await f.choose(); assert.equal(f.button('.geo-pick-live').disabled, true, 'R231-geo-live-fix: выбранное место не заменяет fix для трансляции');
    assert.match(f.button('.geo-pick-live').textContent!, /Станет доступно/); await f.click('.geo-pick-live'); assert.equal(f.query('.geo-pick-period'), null);
  }, source);
}
it('R231 выбранная точка без GPS не разрешает трансляцию и объясняет почему', () => liveNoFix());
it('R231 отказ карты убирает карту и совет сдвинуть её, поиск и отправка своей точки остаются', () => fixture({ map: true }, async f => {
  await f.advance(15_000); assert.ok(f.query('.geo-pick-map')); assert.match(f.query('.geo-pick-slow')!.textContent!, /сдвинуть карту/);
  await f.failMap(); assert.equal(f.query('.geo-pick-map'), null); assert.doesNotMatch(f.query('.geo-pick-slow')!.textContent!, /сдвинуть карту/);
  await f.fix(); assert.equal(f.button('.geo-pick-send').disabled, false);
}));
for (const m of [
  { label: 'повторный системный вопрос', from: 'if (!offAsked.current)', to: 'if (true)', check: systemCycle, prefix: 'R230-geo-asked:', actual: 2, expected: 1, operator: 'strictEqual' },
  { label: 'нет опроса включения системы', from: 'if (!system.off()) setRound((r) => r + 1);', to: 'if (false) setRound((r) => r + 1);', check: systemCycle, prefix: 'R230-geo-poll:', actual: 0, expected: 1, operator: 'strictEqual' },
  { label: 'таймаут снова ошибка', from: 'else if (e.code === 1) setState', to: 'else if (e.code === 1 || e.code === 3) setState', check: timeout, prefix: 'R231-geo-timeout:', actual: true, expected: false, operator: 'strictEqual' },
  { label: 'подсказка сразу', from: 'const GEO_SLOW_MS = 15_000;', to: 'const GEO_SLOW_MS = 0;', check: slow, prefix: 'R231-geo-slow-early:', actual: true, expected: false, operator: 'strictEqual' },
  { label: 'подсказка после fix', from: '{waiting && slow && (', to: '{slow && (', check: slow, prefix: 'R231-geo-slow-fix:', actual: true, expected: false, operator: 'strictEqual' },
  { label: 'отправка fix вместо выбранного', from: "const place = chosen ? { lat: chosen.lat, lon: chosen.lon, accuracy: null } : state.kind === 'fix' ? state.fix : null;", to: "const place = state.kind === 'fix' ? state.fix : null;", check: selected, prefix: 'R231-geo-selected:', actual: '[{"kind":"geo","lat":55,"lon":37,"accuracy":8}]', expected: '[{"kind":"geo","lat":59,"lon":30,"accuracy":null}]', operator: 'strictEqual' },
  { label: 'трансляция выбранного места', from: 'className="geo-pick-send geo-pick-live" disabled={!fix || busy}', to: 'className="geo-pick-send geo-pick-live" disabled={(!fix && !chosen) || busy}', check: liveNoFix, prefix: 'R231-geo-live-fix:', actual: false, expected: true, operator: 'strictEqual' },
  { label: 'ожидающий повтор не снят при закрытии', from: 'window.clearTimeout(restart);', to: '', check: pendingRestart, prefix: 'R231-geo-restart-cleanup:', actual: 1, expected: 0, operator: 'strictEqual', exactMessage: new assert.AssertionError({ message: TIMER_CLEANUP_MESSAGE, actual: 1, expected: 0, operator: 'strictEqual' }).message },
]) it(`R230–231 контрфакт геопозиции: ${m.label}`, async () => {
  await m.check(raw); assert.equal(raw.split(m.from).length - 1, 1, 'единственный якорь мутации');
  await assert.rejects(() => m.check(raw.replace(m.from, m.to)), e => e instanceof assert.AssertionError && e.message.startsWith(m.prefix)
    && e.operator === m.operator && e.actual === m.actual && e.expected === m.expected && (!('exactMessage' in m) || e.message === m.exactMessage));
});
