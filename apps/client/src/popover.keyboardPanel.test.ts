import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('./popover.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function fixture(raw = source, timers = true) {
  let now = 0;
  let next = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const stored = new Map<string, string>();
  const writes: [string, string][] = [];
  const attributes = new Set<string>();
  const vv = { width: 390, height: 800, scale: 1 };
  const window = { innerWidth: 390, innerHeight: 800, visualViewport: vv,
    coarse: true, matchMedia: () => ({ matches: window.coarse }) };
  const document = { activeElement: null as null | { tagName: string }, documentElement: {
    setAttribute: (key: string) => attributes.add(key), removeAttribute: (key: string) => attributes.delete(key),
  } };
  const storage = { fail: false, getItem(key: string) { if (storage.fail) throw new Error('storage denied'); return stored.get(key) ?? null; },
    setItem(key: string, value: string) { if (storage.fail) throw new Error('storage denied'); stored.set(key, value); writes.push([key, value]); } };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, window, document, localStorage: storage,
      ...(timers ? { setTimeout: (callback: () => void, delay: number) => { const id = ++next; pending.set(id, { at: now + delay, callback }); return id; },
        clearTimeout: (id: number) => pending.delete(id) } : {}) });
  return { rules: module.exports as typeof import('./popover'), vv, window, document, stored, storage, writes, attributes,
    advance(ms: number) { now += ms; for (const [id, timer] of pending) if (timer.at <= now) { pending.delete(id); timer.callback(); } },
    open(height = 336.4) { document.activeElement = { tagName: 'TEXTAREA' }; vv.height = 800 - height; this.rules.refreshKeyboardFlag(); } };
}
function counterfacts(check: (raw: string) => void, changes: [string, string][]) {
  check(source);
  for (const [from, to] of changes) {
    assert.equal(source.split(from).length - 1, 1, `мутация должна попасть ровно в одно место: ${from}`);
    assert.throws(() => check(source.replace(from, to)), assert.AssertionError);
  }
}

it('R146 панель по умолчанию 200, лишь высота больше 50 принимается и округляется', () => {
  counterfacts(raw => {
    const { keyboardPanelHeight: height } = fixture(raw).rules;
    for (const value of [null, undefined, NaN, Infinity, -Infinity, -1, 0, 50]) assert.equal(height(value), 200);
    assert.equal(height(51), 51);
    assert.equal(height(336.4), 336);
    assert.equal(height(336.6), 337);
  }, [['stored > KEYBOARD_PANEL_MIN_SAVE', 'stored >= KEYBOARD_PANEL_MIN_SAVE'],
    ['export const KEYBOARD_PANEL_MIN_SAVE = 50;', 'export const KEYBOARD_PANEL_MIN_SAVE = 0;']]);
});

it('R146 высоты портрета и ландшафта читаются отдельно, отказ хранилища даёт 200', () => {
  counterfacts(raw => {
    const f = fixture(raw);
    assert.equal(f.rules.rememberedKeyboardHeight(), 200);
    f.stored.set('gv_kbd_height', '336.4'); f.stored.set('gv_kbd_height_land', '180');
    assert.equal(f.rules.rememberedKeyboardHeight(), 336);
    f.window.innerWidth = 800; f.window.innerHeight = 390;
    assert.equal(f.rules.rememberedKeyboardHeight(), 180);
    f.stored.set('gv_kbd_height_land', 'NaN'); assert.equal(f.rules.rememberedKeyboardHeight(), 200);
    f.storage.fail = true; assert.equal(f.rules.rememberedKeyboardHeight(), 200);
  }, [["const KBD_KEY = 'gv_kbd_height';", "const KBD_KEY = 'gv_kbd_height_land';"],
    ["const KBD_KEY_LAND = 'gv_kbd_height_land';", "const KBD_KEY_LAND = 'gv_kbd_height';"]]);
});

it('R146 замер пишется через 300 мс устойчивости, изменение высоты начинает отсчёт заново', () => {
  counterfacts(raw => {
    const f = fixture(raw); f.open();
    assert.deepEqual(f.writes, []);
    f.advance(299); assert.deepEqual(f.writes, []);
    f.open(350.6); f.advance(1); assert.deepEqual(f.writes, []);
    f.advance(298); assert.deepEqual(f.writes, []);
    f.advance(1); assert.deepEqual(f.writes, [['gv_kbd_height', '351']]);
    f.window.innerWidth = 800; f.window.innerHeight = 390; f.vv.width = 800; f.vv.height = 390;
    f.rules.refreshKeyboardFlag(); f.vv.height = 190; f.rules.refreshKeyboardFlag(); f.advance(300);
    assert.deepEqual(f.writes, [['gv_kbd_height', '351'], ['gv_kbd_height_land', '200']]);
  }, [['  clearTimeout(kbSaveTimer);\n  kbSaveTimer = setTimeout', '  kbSaveTimer = setTimeout'], ['  }, 300);', '  }, 0);']]);
});

it('R146 немедленное закрытие или уход фокуса отменяет сохранение промежуточной высоты', () => {
  counterfacts(raw => {
    for (const closeByFocus of [false, true]) {
      const f = fixture(raw); f.open(); f.advance(299);
      if (closeByFocus) f.document.activeElement = null; else f.vv.height = 800;
      f.rules.refreshKeyboardFlag(); f.advance(300); assert.deepEqual(f.writes, []);
    }
  }, [['if (kbSaveTimer !== undefined) clearTimeout(kbSaveTimer);', 'if (kbSaveTimer !== undefined) { /* забыли отменить */ }']]);
});

it('R146 место клавиатуры без фокуса отмечается с 150 px только на coarse, щипок не считается', () => {
  counterfacts(raw => {
    const f = fixture(raw); f.rules.refreshKeyboardFlag();
    f.vv.height = 651; f.rules.refreshKeyboardFlag(); assert.equal(f.attributes.has('data-kbspace'), false);
    f.vv.height = 650; f.rules.refreshKeyboardFlag(); assert.equal(f.attributes.has('data-kbspace'), true);
    assert.equal(f.attributes.has('data-kb'), false); assert.deepEqual(f.writes, []);
    f.window.coarse = false; f.rules.refreshKeyboardFlag(); assert.equal(f.attributes.has('data-kbspace'), false);
    f.window.coarse = true; f.vv.scale = 1.01; f.rules.refreshKeyboardFlag(); assert.equal(f.attributes.has('data-kbspace'), false);
    f.vv.scale = 1; f.vv.height = 800; f.rules.refreshKeyboardFlag(); assert.equal(f.attributes.has('data-kbspace'), false);
  }, [[" && window.matchMedia?.('(pointer: coarse)').matches === true", ''],
    ['const space = vv.scale <= 1 &&', 'const space =']]);
});

it('R146 отсутствие таймеров и отказ записи не мешают признакам клавиатуры', () => {
  counterfacts(raw => {
    const f = fixture(raw, false);
    assert.doesNotThrow(() => f.open()); assert.equal(f.attributes.has('data-kb'), true);
    f.vv.height = 800; assert.doesNotThrow(() => f.rules.refreshKeyboardFlag());
    assert.deepEqual(f.writes, []);
    const denied = fixture(raw); denied.storage.fail = true; denied.open();
    assert.doesNotThrow(() => denied.advance(300)); assert.deepEqual(denied.writes, []);
    assert.equal(denied.rules.rememberedKeyboardHeight(), 200);
  }, [["  if (typeof setTimeout !== 'function') return;", '  /* защита песочницы удалена */']]);
});
