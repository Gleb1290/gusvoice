import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import { isKeyboardOpen, KEYBOARD_MIN_SHRINK } from './popover.js';

const source = readFileSync(new URL('./popover.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function fixture(raw = source) {
  // Явные размеры visualViewport, не фиктивная раскладка HappyDOM или CSS env().
  const vv = { width: 390, height: 800, scale: 1, addEventListener: listen('visual') };
  const attributes = new Map<string, string>();
  const listeners = new Map<string, (() => void)[]>();
  function listen(scope: string) { return (event: string, callback: () => void) => {
    const key = `${scope}:${event}`;
    listeners.set(key, [...(listeners.get(key) ?? []), callback]);
  }; }
  const root = { clientWidth: 390, clientHeight: 800, style: { setProperty() {} },
    setAttribute: (key: string, value: string) => attributes.set(key, value), removeAttribute: (key: string) => attributes.delete(key) };
  const document = { documentElement: root, activeElement: null as null | { tagName: string; isContentEditable?: boolean }, addEventListener: listen('document') };
  const window = { visualViewport: vv as typeof vv | undefined, innerHeight: 800, addEventListener: listen('window') };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, window, document, getComputedStyle: () => ({ zoom: '1' }) });
  return { rules: module.exports as typeof import('./popover'), vv, window, document, listeners,
    open: () => attributes.has('data-kb'), fire(scope: string, event: string) { for (const callback of listeners.get(`${scope}:${event}`) ?? []) callback(); } };
}

it('R116 клавиатура требует фокус и просадку ровно от 150px, 149px недостаточно', () => {
  assert.equal(KEYBOARD_MIN_SHRINK, 150);
  const check = (rule: typeof isKeyboardOpen) => {
    for (const focused of [false, true]) for (const [height, shrink] of [[801, -1], [800, 0], [651, 149], [650, 150], [649, 151], [0, 800]])
      assert.equal(rule(800, height, focused), focused && shrink >= 150, `фокус=${focused}, просадка=${shrink}`);
  };
  check(isKeyboardOpen);
  for (const [from, to] of [['>= KEYBOARD_MIN_SHRINK', '> KEYBOARD_MIN_SHRINK'], ['editableFocused && fullHeight', 'fullHeight']]) {
    const mutant = source.replace(from, to); assert.notEqual(mutant, source);
    assert.throws(() => check(fixture(mutant).rules.isKeyboardOpen), assert.AssertionError);
  }
});

it('R116 фокус и сжатие ставят data-kb, уход фокуса снимает, поворот сбрасывает максимум, pinch не клавиатура', () => {
  const check = (raw: string) => {
    const f = fixture(raw);
    f.rules.refreshKeyboardFlag(); assert.equal(f.open(), false);
    f.vv.height = 600; f.rules.refreshKeyboardFlag(); assert.equal(f.open(), false, 'сжатие без поля не клавиатура');
    for (const active of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'DIV', isContentEditable: true }]) {
      f.document.activeElement = active; f.rules.refreshKeyboardFlag(); assert.equal(f.open(), true, 'поле и минус 200 ставят data-kb');
      f.document.activeElement = null; f.rules.refreshKeyboardFlag(); assert.equal(f.open(), false, 'focusout снимает data-kb');
    }
    f.document.activeElement = { tagName: 'INPUT' };
    f.rules.refreshKeyboardFlag(); assert.equal(f.open(), true);
    f.vv.width = 800; f.vv.height = 390; f.window.innerHeight = 390;
    f.rules.refreshKeyboardFlag(); assert.equal(f.open(), false, 'новая ширина сбрасывает максимум портрета');
    f.vv.height = 190; f.rules.refreshKeyboardFlag(); assert.equal(f.open(), true);
    f.vv.scale = 1.01; f.rules.refreshKeyboardFlag(); assert.equal(f.open(), false, 'pinch не ставит атрибут');
    f.window.visualViewport = undefined;
    assert.doesNotThrow(() => f.rules.refreshKeyboardFlag());
  };
  check(source);
  for (const [from, to, message] of [
    ['kbFullHeight = 0;\n  }', '/* максимум оставлен */\n  }', /новая ширина/],
    ['const open = vv.scale <= 1 &&', 'const open =', /pinch не ставит/],
  ] as const) {
    const mutant = source.replace(from, to); assert.notEqual(mutant, source);
    assert.throws(() => check(mutant), message);
  }
});

it('R116 installViewportVars слушает focusin/focusout и visual resize ровно один раз', () => {
  const f = fixture(); f.rules.installViewportVars(); f.rules.installViewportVars();
  for (const key of ['document:focusin', 'document:focusout', 'visual:resize', 'window:resize'])
    assert.equal(f.listeners.get(key)?.length, 1, `${key} установлен идемпотентно`);
  f.document.activeElement = { tagName: 'TEXTAREA' }; f.fire('document', 'focusin'); assert.equal(f.open(), false);
  f.vv.height = 600; f.fire('visual', 'resize'); assert.equal(f.open(), true);
  f.document.activeElement = null; f.fire('document', 'focusout'); assert.equal(f.open(), false);
});
