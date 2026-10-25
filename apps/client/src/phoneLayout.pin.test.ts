import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('./phoneLayout.ts', import.meta.url), 'utf8');
type Phone = typeof import('./phoneLayout');

function harness(width = 400, mobile = false, tauri = false) {
  const listeners = new Set<() => void>();
  let updates = 0;
  const states: boolean[] = [], effects = new Map<number, (() => void) | undefined>();
  let stateCursor = 0, effectCursor = 0;
  const mq = {
    get matches() { return width <= 760; },
    addEventListener: (type: string, on: () => void) => { assert.equal(type, 'change'); listeners.add(on); },
    removeEventListener: (type: string, on: () => void) => { assert.equal(type, 'change'); listeners.delete(on); },
  };
  // Минимальный контракт хуков: состояние сохраняется между render, эффект [] устанавливается один раз.
  const react = {
    useState: (initial: () => boolean) => {
      const slot = stateCursor++;
      if (!(slot in states)) states[slot] = initial();
      return [states[slot], (value: boolean) => { updates++; states[slot] = value; }];
    },
    useEffect: (effect: () => (() => void) | undefined) => {
      const slot = effectCursor++;
      if (!effects.has(slot)) effects.set(slot, effect());
    },
  };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, window: { matchMedia: (query: string) => {
    assert.equal(query, '(max-width: 760px)'); return mq;
  } }, require: (id: string) => {
    if (id === 'react') return react;
    if (id === './hotkeys') return { isMobile: () => mobile, isTauri: () => tauri };
    throw new Error(`Неописанная граница ${id}`);
  } });
  const api = module.exports as Phone;
  return {
    api, listeners,
    render: () => {
      stateCursor = 0; effectCursor = 0;
      return { layout: api.usePhoneLayout(), ui: api.usePhoneUi() };
    },
    width: (value: number) => { width = value; for (const listener of Array.from(listeners)) listener(); },
    updates: () => updates,
    unmount: () => { for (const cleanup of effects.values()) cleanup?.(); },
  };
}

it('R276 ширина 760 ещё телефонная, 761 уже компьютерная; закреп удерживает обе подписки и синхронный вид', () => {
  const h = harness(760);
  assert.deepEqual(h.render(), { layout: true, ui: true });
  h.width(761);
  assert.deepEqual(h.render(), { layout: false, ui: false });
  assert.equal(h.api.isPhoneUiNow(), false);
  h.api.setPhoneLayoutPin(true);
  assert.deepEqual(h.render(), { layout: true, ui: true });
  assert.equal(h.api.isPhoneUiNow(), true);
  h.width(1000);
  assert.deepEqual(h.render(), { layout: true, ui: true }, 'поворот не перестраивает дерево под просмотром');
  h.api.setPhoneLayoutPin(false);
  assert.deepEqual(h.render(), { layout: false, ui: false });
  assert.equal(h.api.isPhoneUiNow(), false);
  h.unmount();
});

it('R276 закреп до первого render учитывается начальным состоянием хуков и снимается обратно по ширине', () => {
  const h = harness(1000);
  h.api.setPhoneLayoutPin(true);
  assert.deepEqual(h.render(), { layout: true, ui: true });
  h.api.setPhoneLayoutPin(false);
  assert.deepEqual(h.render(), { layout: false, ui: false });
  h.width(760);
  assert.deepEqual(h.render(), { layout: true, ui: true });
  h.unmount();
});

it('R276 повторная установка того же закрепа не рассылает лишние обновления хуков', () => {
  const h = harness(1000); h.render();
  const initial = h.updates();
  h.api.setPhoneLayoutPin(false);
  assert.equal(h.updates(), initial);
  h.api.setPhoneLayoutPin(true);
  assert.equal(h.updates(), initial + 2);
  h.api.setPhoneLayoutPin(true);
  assert.equal(h.updates(), initial + 2);
  h.api.setPhoneLayoutPin(false);
  assert.equal(h.updates(), initial + 4);
  h.unmount();
});

it('R276 размонтирование удаляет подписки ширины и закрепа, последующие события не обновляют ушедшие хуки', () => {
  const h = harness(); h.render();
  assert.equal(h.listeners.size, 2);
  h.render(); assert.equal(h.listeners.size, 2, 'повторный render не добавляет слушатели');
  h.unmount(); assert.equal(h.listeners.size, 0);
  const before = h.updates();
  h.api.setPhoneLayoutPin(true); h.width(1000); h.api.setPhoneLayoutPin(false);
  assert.equal(h.updates(), before);
});

it('R276 закреп не превращает настольный Tauri в телефонный интерфейс, мобильное приложение остаётся телефонным без него', () => {
  for (const [mobile, tauri, expected] of [[false, true, false], [true, true, true], [false, false, true]] as const) {
    const h = harness(1000, mobile, tauri);
    h.api.setPhoneLayoutPin(true);
    assert.deepEqual(h.render(), { layout: true, ui: expected });
    assert.equal(h.api.isPhoneUiNow(), expected);
    h.api.setPhoneLayoutPin(false);
    assert.deepEqual(h.render(), { layout: false, ui: mobile });
    assert.equal(h.api.isPhoneUiNow(), mobile);
    h.unmount();
  }
});
