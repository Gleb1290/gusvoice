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
import * as toast from '../toast';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n'), raw = read('./GeoPickDialog.tsx');
before(() => { GlobalRegistrator.register({ url: 'https://geo-pick.invalid' }); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
after(async () => { Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT'); await GlobalRegistrator.unregister(); });
type Options = { phone?: boolean; live?: boolean; reject?: boolean; delay?: boolean; unsupported?: boolean };
async function fixture(options: Options, work: (f: {
  buttons(selector: string): HTMLButtonElement[]; sent: shared.ConvMediaInput[]; closed(): number; watches: PositionOptions[]; cleared: number[];
  fix(lat?: number, lon?: number, accuracy?: number): Promise<void>; error(code: number): Promise<void>; click(selector: string, index?: number): Promise<void>; finish(): Promise<void>;
}) => Promise<void>, source = raw) {
  let success!: PositionCallback, failure!: PositionErrorCallback, closed = 0, finish!: () => void;
  const watches: PositionOptions[] = [], cleared: number[] = [], sent: shared.ConvMediaInput[] = [];
  const geolocation = options.unsupported ? undefined : {
    watchPosition(ok: PositionCallback, bad: PositionErrorCallback, opts: PositionOptions) { success = ok; failure = bad; watches.push(opts); return watches.length; },
    clearWatch(id: number) { cleared.push(id); },
  };
  const media = { matches: options.phone ?? true, media: '(max-width: 760px)', addEventListener() {}, removeEventListener() {} };
  const physicalWindow = new Proxy(window, { get(target, key) { if (key === 'matchMedia') return () => media; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
  function load<T>(source: string, deps: Record<string, unknown>): T {
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
      { module, exports: module.exports, window: physicalWindow, document, navigator: { geolocation }, location, HTMLElement, Element, Node, Event, Error, console, performance,
        require(id: string) { assert.equal(Object.hasOwn(deps, id), true, `целый GeoPickDialog: ${id}`); return deps[id]; } });
    return module.exports as T;
  }
  const common = { react: React, 'react/jsx-runtime': jsx, 'react-dom': ReactDOM }, icon = load(read('./Icon.tsx'), common);
  const phone = load(read('../phoneLayout.ts'), { react: React, './hotkeys': hotkeys });
  const back = load(read('../androidBack.ts'), { './hotkeys': hotkeys, './store': {} }), chrome = load(read('../dialogChrome.ts'), { react: React, './androidBack': back });
  const sheet = load(read('./BottomSheet.tsx'), { ...common, './Icon': icon });
  const component = load<typeof import('./GeoPickDialog')>(source, { ...common, '@gusvoice/shared': shared, '../dialogChrome': chrome, '../phoneLayout': phone, '../toast': toast, './BottomSheet': sheet, './Icon': icon });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); toast.useToasts.setState({ toasts: [] });
  const flush = async () => React.act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
  try {
    await React.act(async () => root.render(React.createElement(component.GeoPickDialog, { live: options.live ?? true, onClose: () => { closed++; }, async onSend(value) {
      sent.push(value); if (options.reject) throw new Error('fixture send failed'); if (options.delay) await new Promise<void>(resolve => { finish = resolve; });
    } })));
    await work({ buttons: selector => [...document.querySelectorAll<HTMLButtonElement>(selector)], sent, closed: () => closed, watches, cleared,
      async fix(lat = 55, lon = 37, accuracy = 12) { await React.act(async () => success({ coords: { latitude: lat, longitude: lon, accuracy } } as GeolocationPosition)); },
      async error(code) { await React.act(async () => failure({ code } as GeolocationPositionError)); },
      async click(selector, index = 0) { const button = document.querySelectorAll(selector)[index]; assert.ok(button, selector); await React.act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true }))); await flush(); },
      async finish() { finish(); await flush(); },
    });
  } finally { await React.act(async () => root.unmount()); host.remove(); }
  if (geolocation) assert.deepEqual(cleared, watches.map((_value, index) => index + 1), 'все watchPosition сняты при закрытии/повторе');
}
async function featurePhone(source = raw) {
  for (const phone of [false, true]) for (const live of [false, true]) await fixture({ phone, live }, async f => {
    assert.equal(f.buttons('.geo-pick-live').length, phone && live ? 1 : 0, 'R225-pick-gate: live строка только с разрешением и телефонной раскладкой');
    assert.equal(document.querySelectorAll(phone ? '.sheet' : '.geo-pick-modal').length, 1);
  }, source);
}
it('R225 строка трансляции требует одновременно live и телефон, ПК остаётся обычным местом', () => featurePhone());
it('R225 до первого fix обе отправки выключены, выбор срока ничего не шлёт и имеет три срока', async () => fixture({}, async f => {
  assert.equal(f.buttons('.geo-pick-live')[0]!.disabled, true); assert.equal(f.buttons('.geo-pick-send')[0]!.disabled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.watches)), [{ enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 }]);
  await f.fix(); await f.click('.geo-pick-live'); assert.equal(f.sent.length, 0); assert.equal(f.closed(), 0);
  assert.deepEqual(f.buttons('.geo-pick-period').map(button => button.textContent?.trim()), ['15 минут', '1 час', '8 часов']);
  await f.click('.geo-pick-back'); assert.equal(f.buttons('.geo-pick-live').length, 1); assert.equal(f.sent.length, 0);
}));
async function sendPeriod(period: 900 | 3600 | 28800, source = raw) { await fixture({}, async f => {
  await f.fix(55, 37, 20); await f.fix(56, 38, 10); await f.fix(10, 20, 99); await f.click('.geo-pick-live'); await f.click('.geo-pick-period', [900, 3600, 28800].indexOf(period));
  assert.equal(f.sent[0]?.kind, 'geolive', 'R225-pick-kind: выбор периода отправляет трансляцию, не статичную точку');
  assert.equal(JSON.stringify(f.sent), JSON.stringify([{ kind: 'geolive', lat: 56, lon: 38, accuracy: 10, period }])); assert.equal(f.closed(), 1);
}, source); }
for (const period of [900, 3600, 28800] as const) it(`R225 срок ${period} отправляет реальные geolive-данные лучшего fix и закрывает окно`, () => sendPeriod(period));
it('R225 обычная кнопка остаётся kind geo даже при включённой трансляции', async () => fixture({}, async f => {
  await f.fix(); await f.click('.geo-pick-send'); assert.equal(JSON.stringify(f.sent), JSON.stringify([{ kind: 'geo', lat: 55, lon: 37, accuracy: 12 }])); assert.equal(f.closed(), 1);
}));
it('R225 pending live отправка не закрывает окно раньше ответа и блокирует повтор', async () => fixture({ delay: true }, async f => {
  await f.fix(); await f.click('.geo-pick-live'); await f.click('.geo-pick-period'); assert.equal(f.closed(), 0); assert.equal(f.buttons('.geo-pick-period').every(button => button.disabled), true);
  await f.click('.geo-pick-period'); assert.equal(f.sent.length, 1); await f.finish(); assert.equal(f.closed(), 1);
}));
it('R225 ошибка отправки оставляет выбор срока, показывает тост и снимает busy для повтора', async () => fixture({ reject: true }, async f => {
  await f.fix(); await f.click('.geo-pick-live'); await f.click('.geo-pick-period'); assert.equal(f.closed(), 0); assert.equal(toast.useToasts.getState().toasts.length, 1);
  assert.equal(f.buttons('.geo-pick-period').every(button => !button.disabled), true); await f.click('.geo-pick-period', 1); assert.equal(f.sent.length, 2);
}));
it('R225 запрет геолокации даёт понятную ошибку и Повторить, поздняя ошибка не отнимает найденное место', async () => fixture({}, async f => {
  await f.error(1); assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /Нет доступа/); assert.equal(f.buttons('.geo-pick-live')[0]!.disabled, true);
  await f.click('.geo-pick-error button'); assert.equal(f.watches.length, 2); assert.equal(document.querySelector('[role="alert"]'), null);
  await f.fix(); await f.error(3); assert.equal(document.querySelector('[role="alert"]'), null); assert.equal(f.buttons('.geo-pick-live')[0]!.disabled, false);
}));
it('R225 без geolocation устройство получает ошибку без работающей кнопки трансляции', async () => fixture({ unsupported: true }, async f => {
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /не умеет определять место/); assert.equal(f.watches.length, 0); assert.equal(f.buttons('.geo-pick-live')[0]!.disabled, true);
}));
for (const m of [
  { label: 'оба гейта', from: '!!live && phone', to: '!!live || phone', check: featurePhone, prefix: 'R225-pick-gate:', actual: 1, expected: 0 },
  { label: 'вид отправки', from: "kind: 'geolive'", to: "kind: 'geo'", check: (source: string) => sendPeriod(900, source), prefix: 'R225-pick-kind:', actual: 'geo', expected: 'geolive' },
]) it(`R225 контрфакт выбора места: ${m.label}`, async () => {
  await m.check(raw); assert.equal(raw.split(m.from).length - 1, 1);
  await assert.rejects(() => m.check(raw.replace(m.from, m.to)), e => e instanceof assert.AssertionError && e.message.startsWith(m.prefix)
    && e.operator === 'strictEqual' && e.actual === m.actual && e.expected === m.expected);
});
const chat = read('./DmChatView.tsx'), expression = 'geoLiveFeature && !peerHome && !groupHostId && !viaOn';
function chatGate(source: string) {
  const file = ts.createSourceFile('DmChatView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), attributes: ts.JsxAttribute[] = [];
  function walk(n: ts.Node) { if (ts.isJsxAttribute(n) && n.name.getText(file) === 'geoLive') attributes.push(n); ts.forEachChild(n, walk); }
  walk(file); assert.equal(attributes.length, 1); const initializer = attributes[0]!.initializer;
  assert.ok(initializer && ts.isJsxExpression(initializer)); assert.equal(initializer.expression?.getText(file), expression, 'R225-chat-live-gate: чужой дом/хост/через не получают исходящую трансляцию');
}
it('R225 AST DmChatView передаёт geoLive только локальной беседе без чужого хоста и через', () => chatGate(chat));
for (const term of ['!peerHome', '!groupHostId', '!viaOn']) it(`R225 контрфакт AST гейта: отсутствует ${term}`, () => {
  chatGate(chat); assert.equal(chat.split(expression).length - 1, 1); const mutated = expression.replace(` && ${term}`, '');
  assert.throws(() => chatGate(chat.replace(expression, mutated)), e => e instanceof assert.AssertionError && e.message.startsWith('R225-chat-live-gate:')
    && e.operator === 'strictEqual' && e.actual === mutated && e.expected === expression);
});
