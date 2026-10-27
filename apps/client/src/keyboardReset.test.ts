import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { resetKeyboardShift } from './keyboardReset.js';

type Reset = typeof resetKeyboardShift;
type Focus = 'self' | 'other' | 'none' | 'no-document';

// Нужны только атрибуты и идентичность activeElement: браузер и его клавиатуру здесь не эмулируем.
function fixture(previous: string | null, focus: Focus = 'self', touch = true) {
  const attributes = new Map<string, string>([['placeholder', 'Сообщение'], ['data-probe', 'keep']]);
  if (previous !== null) attributes.set('autocapitalize', previous);
  const writes: unknown[][] = [];
  const frames: (() => void)[] = [];
  const focusCalls: string[] = [];
  const doc: { activeElement: unknown } = { activeElement: focus === 'other' ? {} : null };
  const field = {
    ownerDocument: focus === 'no-document' ? null : doc as unknown as Document,
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => {
      writes.push(['set', name, value]);
      attributes.set(name, value);
    },
    removeAttribute: (name: string) => {
      writes.push(['remove', name]);
      attributes.delete(name);
    },
    blur: () => { focusCalls.push('blur'); },
    focus: () => { focusCalls.push('focus'); },
  };
  if (focus === 'self') doc.activeElement = field;
  const activeBefore = doc.activeElement;
  const documentBefore = field.ownerDocument;
  return {
    field, attributes, writes, frames,
    env: { touch, nextFrame: (fn: () => void) => { frames.push(fn); } },
    assertUnrelatedUnchanged() {
      assert.equal(attributes.get('placeholder'), 'Сообщение');
      assert.equal(attributes.get('data-probe'), 'keep');
      assert.equal(attributes.size - Number(attributes.has('autocapitalize')), 2);
      assert.equal(field.ownerDocument, documentBefore);
      assert.equal(doc.activeElement, activeBefore, 'фокус не перемещается');
      assert.deepEqual(focusCalls, [], 'blur/focus не закрывают экранную клавиатуру');
    },
  };
}

const NO_FOCUS = 'несфокусированное поле сохраняет autocapitalize';
const RESTORED = 'после кадра восстановлен исходный autocapitalize';

function checkNoFocus(reset: Reset, focus: Exclude<Focus, 'self'>) {
  const f = fixture('sentences', focus);
  reset(f.field, f.env);
  assert.equal(f.field.getAttribute('autocapitalize'), 'sentences', NO_FOCUS);
  assert.deepEqual(f.writes, [], 'без фокуса атрибуты вообще не записываются');
  assert.equal(f.frames.length, 0, 'без фокуса кадр не планируется');
  f.assertUnrelatedUnchanged();
}

function checkFocused(reset: Reset, previous: string | null) {
  const f = fixture(previous);
  const temporary = previous === 'off' ? 'sentences' : 'off';
  reset(f.field, f.env);
  assert.equal(f.field.getAttribute('autocapitalize'), temporary, 'флаг меняется сразу, до кадра');
  assert.notEqual(f.field.getAttribute('autocapitalize'), previous);
  assert.deepEqual(f.writes, [['set', 'autocapitalize', temporary]]);
  assert.equal(f.frames.length, 1, 'запланирован ровно один кадр');
  f.assertUnrelatedUnchanged();

  // Явная очередь доказывает порядок, без таймеров, настоящего rAF и гонок.
  f.frames.shift()!();
  assert.equal(f.field.getAttribute('autocapitalize'), previous, RESTORED);
  assert.equal(f.attributes.has('autocapitalize'), previous !== null, 'отсутствующий атрибут удалён, не строка null');
  assert.deepEqual(f.writes, [
    ['set', 'autocapitalize', temporary],
    previous === null ? ['remove', 'autocapitalize'] : ['set', 'autocapitalize', previous],
  ]);
  assert.equal(f.frames.length, 0, 'восстановление не запускает следующий кадр');
  f.assertUnrelatedUnchanged();
}

const source = readFileSync(new URL('./keyboardReset.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function mutant(from: string, to: string): Reset {
  assert.equal(source.split(from).length - 1, 1, 'якорь мутации встречается ровно один раз');
  const module = { exports: {} as { resetKeyboardShift: Reset } };
  const compiled = ts.transpileModule(source.replace(from, to), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: 'keyboardReset.ts',
  });
  // Полный настоящий модуль; VM нужна только контрфакту, обычные тесты вызывают прямой импорт.
  runInNewContext(compiled.outputText, { module, exports: module.exports }, { filename: 'keyboardReset.mutant.cjs' });
  assert.equal(typeof module.exports.resetKeyboardShift, 'function');
  return module.exports.resetKeyboardShift;
}

function exactFailure(message: string) {
  return (error: unknown) => error instanceof assert.AssertionError
    // Node добавляет diff к message: сравниваем первую строку, не произвольный throw.
    && error.code === 'ERR_ASSERTION' && error.message.split(/\r?\n/, 1)[0] === message
    && error.operator === 'strictEqual'
    && error.actual === 'off'
    && error.expected === 'sentences';
}

describe('R292: сброс Shift без потери фокуса экранной клавиатуры', () => {
  for (const missing of [null, undefined]) {
    it(`${String(missing)} вместо поля ничего не меняет и не планирует кадр`, () => {
      const f = fixture('sentences');
      resetKeyboardShift(missing, f.env);
      assert.equal(f.field.getAttribute('autocapitalize'), 'sentences');
      assert.deepEqual(f.writes, []);
      assert.equal(f.frames.length, 0);
      f.assertUnrelatedUnchanged();
    });
  }

  it('без сенсорного ввода даже сфокусированное поле остаётся нетронутым', () => {
    const f = fixture('sentences', 'self', false);
    resetKeyboardShift(f.field, f.env);
    assert.equal(f.field.getAttribute('autocapitalize'), 'sentences');
    assert.deepEqual(f.writes, []);
    assert.equal(f.frames.length, 0);
    f.assertUnrelatedUnchanged();
  });

  for (const [focus, label] of [
    ['other', 'другое поле в фокусе'], ['none', 'activeElement отсутствует'], ['no-document', 'ownerDocument равен null'],
  ] as const) {
    it(`${label}: сенсорность не разрешает менять поле или планировать кадр`, () => {
      checkNoFocus(resetKeyboardShift, focus);
    });
  }

  for (const previous of [null, 'sentences', 'off']) {
    it(`сенсорное поле в фокусе: ${previous === null ? 'без атрибута' : previous} меняется сразу и восстанавливается за один кадр`, () => {
      checkFocused(resetKeyboardShift, previous);
    });
  }

  it('контрфакт: снятие проверки фокуса ломает именно сохранение исходного атрибута', () => {
    checkNoFocus(resetKeyboardShift, 'other');
    const changed = mutant('  if (el.ownerDocument?.activeElement !== (el as unknown)) return;\n', '');
    assert.throws(() => checkNoFocus(changed, 'other'), exactFailure(NO_FOCUS));
  });

  it('контрфакт: невосстановленное прежнее значение ломает именно результат после кадра', () => {
    checkFocused(resetKeyboardShift, 'sentences');
    const changed = mutant(
      "    if (prev === null) el.removeAttribute('autocapitalize');\n    else el.setAttribute('autocapitalize', prev);",
      '    void prev;',
    );
    assert.throws(() => checkFocused(changed, 'sentences'), exactFailure(RESTORED));
  });
});
