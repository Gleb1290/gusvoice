import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ts from 'typescript';

type Api = typeof import('./nativeRaiseToEar');
type Options = { android?: boolean; bridge?: boolean; missing?: 'supported' | 'set'; supported?: unknown; throwSupported?: boolean; throwSet?: boolean;
  raw?: string | null; storage?: 'absent' | 'throws'; mutation?: readonly [string, string] };
const source = readFileSync(new URL('./nativeRaiseToEar.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function fixture(options: Options = {}) {
  let raw = source;
  if (options.mutation) {
    const [from, to] = options.mutation; assert.equal(raw.split(from).length - 1, 1, 'единственный якорь всего nativeRaiseToEar'); raw = raw.replace(from, to);
  }
  const calls: unknown[][] = [], warnings: unknown[][] = [], writes: [string, string][] = [];
  const values = new Map<string, string>(); if (options.raw != null) values.set('gv.raiseToEar', options.raw);
  let reads = 0;
  const bridge: Record<string, unknown> = {
    raiseToEarSupported() { assert.equal(this, bridge); calls.push(['supported']); if (options.throwSupported) throw new Error('sensor unavailable'); return Object.hasOwn(options, 'supported') ? options.supported : true; },
    raiseToEarSet(on: unknown) { assert.equal(this, bridge); calls.push(['set', on]); if (options.throwSet) throw new Error('native set unavailable'); },
  };
  if (options.missing) delete bridge[options.missing === 'supported' ? 'raiseToEarSupported' : 'raiseToEarSet'];
  const window: { GusVoiceNative?: Record<string, unknown> } = { GusVoiceNative: options.bridge === false ? undefined : bridge };
  const sandbox: Record<string, unknown> = {
    window, console: { warn: (...args: unknown[]) => warnings.push(args) },
    require(id: string) { if (id === 'react') return React; assert.equal(id, './hotkeys'); return { isAndroid: () => options.android !== false }; },
  };
  if (options.storage !== 'absent') sandbox.localStorage = {
    getItem(key: string) { reads++; assert.equal(key, 'gv.raiseToEar'); if (options.storage === 'throws') throw new Error('storage blocked'); return values.get(key) ?? null; },
    setItem(key: string, value: string) { assert.equal(key, 'gv.raiseToEar'); if (options.storage === 'throws') throw new Error('storage blocked'); writes.push([key, value]); values.set(key, value); },
  };
  const module = { exports: {} }; Object.assign(sandbox, { module, exports: module.exports });
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  return { api: module.exports as Api, bridge, window, calls, warnings, writes, reads: () => reads };
}
function killed(change: readonly [string, string], options: Options, scenario: (f: ReturnType<typeof fixture>) => void,
  prefix: string, actual: unknown, expected: unknown) {
  scenario(fixture(options));
  const mutant = fixture({ ...options, mutation: change });
  assert.throws(() => scenario(mutant), e => e instanceof assert.AssertionError && e.message.startsWith(prefix)
    && e.operator === 'strictEqual' && Object.is(e.actual, actual) && Object.is(e.expected, expected));
}
it('R216 отсутствие настройки, единица и мусор оставляют поднесение включённым, только строка ноль выключает', () => {
  const { api } = fixture();
  for (const raw of [null, undefined, '', '1', 'true', 'trash', '00', ' 0 ', 'false']) assert.equal(api.parseRaiseToEar(raw), true);
  assert.equal(api.parseRaiseToEar('0'), false);
});
const wantedInput = (mask: number) => ({ enabled: !!(mask & 1), playing: !!(mask & 2), hasTrack: !!(mask & 4), inVoiceChannel: !!(mask & 8) });
for (let mask = 0; mask < 16; mask++) it(`R216 поднесение для таблицы ${mask.toString(2).padStart(4, '0')} включается только при настройке, проигрывании, треке и вне голосового канала`, () => {
  assert.equal(fixture().api.raiseToEarWanted(wantedInput(mask)), mask === 7);
});
it('R216 поддержка требует Android, объект моста и каждый из двух методов, не вызывает половинчатый мост', () => {
  assert.equal(fixture().api.raiseToEarSupported(), true);
  for (const options of [{ android: false }, { bridge: false }, { missing: 'supported' }, { missing: 'set' }] as const) {
    const f = fixture(options); assert.equal(f.api.raiseToEarSupported(), false); assert.deepEqual(f.calls, []);
  }
  for (const method of ['raiseToEarSupported', 'raiseToEarSet']) {
    const f = fixture(); f.bridge[method] = 'old APK'; assert.equal(f.api.raiseToEarSupported(), false); assert.deepEqual(f.calls, []);
  }
});
it('R216 мост поддерживает датчик только при буквальном true, не при truthy или неизвестном ответе', () => {
  for (const supported of [false, undefined, null, 0, 1, '', 'true', {}, []]) assert.equal(fixture({ supported }).api.raiseToEarSupported(), false);
  assert.equal(fixture({ supported: true }).api.raiseToEarSupported(), true);
  const throwing = fixture({ throwSupported: true }); assert.equal(throwing.api.raiseToEarSupported(), false); assert.equal(throwing.warnings.length, 1);
});
it('R216 предпочтение читает тот же ключ, записывает единицу и ноль и немедленно отдаёт сохранённое значение', () => {
  const f = fixture({ raw: '0' }); assert.equal(f.api.getRaiseToEarPref(), false);
  f.api.setRaiseToEarPref(true); assert.equal(f.api.getRaiseToEarPref(), true);
  f.api.setRaiseToEarPref(false); assert.equal(f.api.getRaiseToEarPref(), false);
  assert.deepEqual(f.writes, [['gv.raiseToEar', '1'], ['gv.raiseToEar', '0']]);
  for (const raw of [null, '', '1', 'trash']) assert.equal(fixture({ raw }).api.getRaiseToEarPref(), true);
});
it('R216 отсутствующее или запрещённое localStorage не роняет чтение и запись, чтение возвращает безопасный default', () => {
  for (const storage of ['absent', 'throws'] as const) {
    const f = fixture({ storage }); assert.equal(f.api.getRaiseToEarPref(), true);
    assert.doesNotThrow(() => f.api.setRaiseToEarPref(false)); assert.doesNotThrow(() => f.api.setRaiseToEarPref(true)); assert.equal(f.api.getRaiseToEarPref(), true);
  }
});
it('R216 включение и выключение передаются мосту, ошибки проглатываются, вне Android и без полного моста вызовов нет', () => {
  const f = fixture(); f.api.setRaiseToEar(true); f.api.setRaiseToEar(false); assert.deepEqual(f.calls, [['set', true], ['set', false]]);
  const broken = fixture({ throwSet: true }); assert.doesNotThrow(() => broken.api.setRaiseToEar(true)); assert.equal(broken.warnings.length, 1);
  for (const options of [{ android: false }, { bridge: false }, { missing: 'set' }, { missing: 'supported' }] as const) {
    const absent = fixture(options); assert.doesNotThrow(() => absent.api.setRaiseToEar(true)); assert.deepEqual(absent.calls, []);
  }
});

before(() => { GlobalRegistrator.register({ url: 'https://raise.example.test' }); (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
after(async () => { delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; await GlobalRegistrator.unregister(); });
async function probe(api: Api) {
  const host = document.createElement('div'); document.body.appendChild(host); const root: Root = createRoot(host);
  function Preference() { return React.createElement('span', null, String(api.useRaiseToEarPref())); }
  await React.act(async () => { root.render(React.createElement(Preference)); });
  return { host, async off() { await React.act(async () => { root.unmount(); }); host.remove(); } };
}
it('R216 реальные React-подписчики получают смену настройки, первая и последняя отписки убирают только свои слушатели', async () => {
  const f = fixture(), first = await probe(f.api), second = await probe(f.api);
  try {
    assert.equal(first.host.textContent, 'true'); assert.equal(second.host.textContent, 'true');
    await React.act(async () => f.api.setRaiseToEarPref(false));
    assert.equal(first.host.textContent, 'false'); assert.equal(second.host.textContent, 'false');
    await first.off(); await React.act(async () => f.api.setRaiseToEarPref(true)); assert.equal(second.host.textContent, 'true');
    await second.off(); const reads = f.reads(); f.api.setRaiseToEarPref(false); assert.equal(f.reads(), reads, 'после последней отписки React больше не читает снимок');
  } finally { if (first.host.isConnected) await first.off(); if (second.host.isConnected) await second.off(); }
});
it('R216 реальная подписка не роняет UI при запрете записи storage и безопасно отписывается', async () => {
  for (const storage of ['absent', 'throws'] as const) {
    const f = fixture({ storage }), mounted = await probe(f.api);
    try { await React.act(async () => f.api.setRaiseToEarPref(false)); assert.equal(mounted.host.textContent, 'true'); }
    finally { await mounted.off(); }
  }
});

const wanted = 'o.enabled && o.playing && o.hasTrack && !o.inVoiceChannel';
for (const [name, replacement, mask, actual, expected] of [
  ['настройка', 'o.playing && o.hasTrack && !o.inVoiceChannel', 6, true, false],
  ['проигрывание', 'o.enabled && o.hasTrack && !o.inVoiceChannel', 5, true, false],
  ['трек', 'o.enabled && o.playing && !o.inVoiceChannel', 3, true, false],
  ['голосовой канал', 'o.enabled && o.playing && o.hasTrack', 15, true, false],
  ['инверсия голосового канала', 'o.enabled && o.playing && o.hasTrack && o.inVoiceChannel', 7, false, true],
] as const) it(`R216 контрфакт поднесения теряет условие: ${name}`, () => killed([wanted, replacement], {}, f => {
  assert.equal(f.api.raiseToEarWanted(wantedInput(mask)), expected, `R216-wanted-${mask}: поднесение соблюдает адресное условие`);
}, `R216-wanted-${mask}:`, actual, expected));
it('R216 контрфакт поддержки принимает неопределённый ответ как наличие датчика', () => killed(['b.raiseToEarSupported() === true', 'b.raiseToEarSupported() !== false'], { supported: undefined }, f => {
  assert.equal(f.api.raiseToEarSupported(), false, 'R216-supported: неизвестный ответ не разрешает датчик');
}, 'R216-supported:', true, false));
