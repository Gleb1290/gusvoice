import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';
import { installNativeSafeArea, parseSafeArea, safeAreaVars } from './nativeSafeArea.js';

const source = readFileSync(new URL('./nativeSafeArea.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const sides = ['top', 'right', 'bottom', 'left'] as const;
const vars = ['--gv-sat', '--gv-sar', '--gv-sab', '--gv-sal'] as const;
const ordinary = { top: 24, right: 3.5, bottom: 48, left: 2 };
type NativeWindow = { GusVoiceNative?: { safeArea?: unknown }; __gvSafeArea?: (raw: unknown) => void };

function withDom(check: (native: NativeWindow) => void): void {
  GlobalRegistrator.register();
  const native = window as unknown as NativeWindow;
  delete native.GusVoiceNative;
  delete native.__gvSafeArea;
  try { check(native); }
  finally {
    delete native.GusVoiceNative;
    delete native.__gvSafeArea;
    GlobalRegistrator.unregister();
  }
}

function cssValues(): string[] {
  return vars.map(key => document.documentElement.style.getPropertyValue(key));
}

function load(raw: string): typeof import('./nativeSafeArea.js') {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, window, document });
  return module.exports as typeof import('./nativeSafeArea.js');
}

function mutate(from: string, to: string): string {
  assert.equal(source.split(from).length - 1, 1, 'мутация меняет ровно один участок настоящего исходника');
  return source.replace(from, to);
}

describe('системные вставки Android', () => {
  it('обычные вставки принимаются и объектом, и JSON-строкой без потери дробей', () => {
    assert.deepEqual(parseSafeArea(ordinary), ordinary);
    assert.deepEqual(parseSafeArea(JSON.stringify(ordinary)), ordinary);
  });

  it('нулевые вставки принимаются на всех четырёх сторонах', () => {
    const zero = { top: 0, right: 0, bottom: 0, left: 0 };
    assert.deepEqual(parseSafeArea(zero), zero);
    assert.deepEqual(parseSafeArea(JSON.stringify(zero)), zero);
  });

  for (const [label, raw] of [
    ['пустая строка', ''], ['пробельная строка', '   '], ['битый JSON', '{"top":'],
  ] as const) {
    it(`${label} не меняет вставки`, () => { assert.equal(parseSafeArea(raw), null); });
  }

  it('null и необъекты, в том числе внутри JSON, отклоняются', () => {
    for (const raw of [null, undefined, true, false, 0, 24, [], 'null', 'false', '24', '[]', '"текст"']) {
      assert.equal(parseSafeArea(raw), null, `необъект ${String(raw)}`);
    }
  });

  for (const side of sides) {
    it(`отсутствующая сторона ${side} отклоняется, остальные три не компенсируют её`, () => {
      const missing: Partial<typeof ordinary> = { ...ordinary };
      delete missing[side];
      assert.equal(parseSafeArea(missing), null);
      assert.equal(parseSafeArea(JSON.stringify(missing)), null);
    });
  }

  it('объект без всех четырёх сторон отклоняется', () => {
    assert.equal(parseSafeArea({}), null);
    assert.equal(parseSafeArea('{}'), null);
  });

  for (const [label, value] of [
    ['числовая строка', '12'], ['NaN', NaN], ['Infinity', Infinity],
    ['минус Infinity', -Infinity], ['отрицательная дробь', -0.01],
  ] as const) {
    it(`${label} в любой стороне отклоняется целиком`, () => {
      for (const side of sides) assert.equal(parseSafeArea({ ...ordinary, [side]: value }), null, side);
    });
  }

  it('переменные идут в порядке верх, право, низ, лево и округляются до сотой пикселя', () => {
    assert.deepEqual(safeAreaVars({ top: 1.234, right: 1.235, bottom: 0.004, left: 0.005 }), [
      ['--gv-sat', '1.23px'], ['--gv-sar', '1.24px'], ['--gv-sab', '0px'], ['--gv-sal', '0.01px'],
    ]);
    assert.deepEqual(safeAreaVars(ordinary), [
      ['--gv-sat', '24px'], ['--gv-sar', '3.5px'], ['--gv-sab', '48px'], ['--gv-sal', '2px'],
    ]);
  });

  it('без нативного моста CSS и приёмник не появляются', () => withDom(native => {
    installNativeSafeArea();
    assert.deepEqual(cssValues(), ['', '', '', '']);
    assert.equal(Object.hasOwn(native, '__gvSafeArea'), false);
  }));

  it('мост без функции safeArea не ставит CSS и приёмник', () => withDom(native => {
    for (const bridge of [{}, { safeArea: 'не функция' }, { safeArea: null }]) {
      native.GusVoiceNative = bridge;
      installNativeSafeArea();
      assert.deepEqual(cssValues(), ['', '', '', '']);
      assert.equal(Object.hasOwn(native, '__gvSafeArea'), false);
    }
  }));

  it('мост ставит исходные CSS-вставки, приёмник обновляет их объектом и JSON', () => withDom(native => {
    let calls = 0;
    native.GusVoiceNative = { safeArea: () => { calls++; return JSON.stringify(ordinary); } };
    installNativeSafeArea();
    assert.equal(calls, 1);
    assert.deepEqual(cssValues(), ['24px', '3.5px', '48px', '2px']);
    assert.equal(typeof native.__gvSafeArea, 'function');
    native.__gvSafeArea!({ top: 0, right: 1.236, bottom: 2.004, left: 0.005 });
    assert.deepEqual(cssValues(), ['0px', '1.24px', '2px', '0.01px']);
    native.__gvSafeArea!('{"top":4,"right":5,"bottom":6,"left":7}');
    assert.deepEqual(cssValues(), ['4px', '5px', '6px', '7px']);
  }));

  it('битое обновление не стирает прежние вставки и не применяет часть сторон', () => withDom(native => {
    native.GusVoiceNative = { safeArea: () => JSON.stringify(ordinary) };
    installNativeSafeArea();
    const before = cssValues();
    for (const raw of ['', '{', null, {}, { top: 100, right: 200, bottom: -1, left: 300 }]) {
      native.__gvSafeArea!(raw);
      assert.deepEqual(cssValues(), before, `битая вставка ${JSON.stringify(raw)}`);
    }
  }));

  it('исключение моста не выходит наружу, установленный приёмник остаётся работоспособным', () => withDom(native => {
    native.GusVoiceNative = { safeArea: () => { throw new Error('старая оболочка'); } };
    assert.doesNotThrow(() => installNativeSafeArea());
    assert.deepEqual(cssValues(), ['', '', '', '']);
    assert.equal(typeof native.__gvSafeArea, 'function');
    native.__gvSafeArea!(ordinary);
    assert.deepEqual(cssValues(), ['24px', '3.5px', '48px', '2px']);
  }));

  it('отрицательную вставку ловит проверка настоящего модуля, а не копия алгоритма', () => {
    const check = (raw: string) => withDom(() => {
      const api = load(raw);
      assert.equal(api.parseSafeArea({ ...ordinary, left: -0.01 }), null, 'отрицательная вставка отклоняется');
    });
    check(source);
    assert.throws(() => check(mutate(' || n < 0', '')), {
      name: 'AssertionError', message: /отрицательная вставка отклоняется/,
    });
  });

  it('приёмник готов до синхронного вызова из моста; перестановка строк ловится поведением', () => {
    const check = (raw: string) => withDom(native => {
      let receiverReady = false;
      let received: string[] = [];
      native.GusVoiceNative = { safeArea: () => {
        // Мост может синхронно сообщить вставки при первом запросе: callback нельзя потерять.
        receiverReady = typeof native.__gvSafeArea === 'function';
        if (receiverReady) native.__gvSafeArea!(ordinary);
        received = cssValues();
        return JSON.stringify(ordinary);
      } };
      load(raw).installNativeSafeArea();
      // Проверяем вне моста: install намеренно ловит его ошибки, включая AssertionError.
      assert.equal(receiverReady, true, 'приёмник готов до запроса моста');
      assert.deepEqual(received, ['24px', '3.5px', '48px', '2px'], 'синхронное обновление уже применено');
    });
    check(source);
    const assignment = '  w.__gvSafeArea = apply;\n';
    const bridgeCall = '  try { apply(bridge.safeArea()); } catch { /* мост старой оболочки — остаётся env() */ }';
    assert.ok(source.includes(bridgeCall));
    const changed = mutate(assignment + bridgeCall, bridgeCall + '\n' + assignment.trimEnd());
    assert.throws(() => check(changed), {
      name: 'AssertionError', message: /приёмник готов до запроса моста/,
    });
  });
});
