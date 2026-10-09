import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as rules from './textSelRules';

it('без Segmenter касание любой половины emoji выбирает целую суррогатную пару', () => {
  // Регрессия R14: запасной regex-путь начинал выделение с low surrogate и копировал сломанный знак.
  const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
  try {
    Object.defineProperty(Intl, 'Segmenter', { value: undefined, configurable: true });
    for (const at of [0, 1]) assert.deepEqual(rules.wordBounds('🙂', at), [0, 2]);
    for (const at of [1, 2]) assert.deepEqual(rules.wordBounds('a🙂b', at), [1, 3]);
    const old = mutant('return [start, snapOffset(text, i + 1)];', 'return [i, snapOffset(text, i + 1)];');
    assert.throws(() => assert.deepEqual(Array.from(old.wordBounds('🙂', 1)), [0, 2]), assert.AssertionError);
  } finally {
    if (descriptor) Object.defineProperty(Intl, 'Segmenter', descriptor);
    else Reflect.deleteProperty(Intl, 'Segmenter');
  }
});

function mutant(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./textSelRules.ts', import.meta.url), 'utf8');
  assert.ok(source.includes(from), 'заменяется существующая ветка');
  const module = { exports: {} };
  const code = ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { module, exports: module.exports, Intl });
  return module.exports as typeof rules;
}

it('слово под пальцем сохраняется целиком, пробел выбирает слева, ведущий пробел — справа', () => {
  // На пробеле нельзя случайно перескочить на следующее слово.
  const check = (api: typeof rules) => {
    assert.deepEqual(Array.from(api.wordBounds('раз два', 2)), [0, 3]);
    assert.deepEqual(Array.from(api.wordBounds('раз  два', 4)), [0, 3]);
    assert.deepEqual(Array.from(api.wordBounds('  два', 0)), [2, 5]);
    assert.deepEqual(Array.from(api.wordBounds('раз', -3)), [0, 3]);
    assert.deepEqual(Array.from(api.wordBounds('раз', 99)), [0, 3]);
  };
  check(rules);
  assert.throws(() => check(mutant('if (l > 0) i = l - 1;', 'if (l > 0) i = r;')), assert.AssertionError);
});

it('пунктуация и emoji выделяются отдельно, дефис не теряет соседние кириллические сегменты', () => {
  // Индексы — UTF-16: обе половины emoji должны остаться в одном выделении.
  assert.deepEqual(rules.wordBounds('да,🙂!', 2), [2, 3]);
  for (const i of [3, 4]) assert.deepEqual(rules.wordBounds('да,🙂!', i), [3, 5]);
  const text = 'по-русски';
  assert.deepEqual(rules.wordBounds(text, 1), [0, 2]);
  assert.deepEqual(rules.wordBounds(text, 2), [2, 3]);
  assert.deepEqual(rules.wordBounds(text, 5), [3, 9]);
  assert.deepEqual(rules.wordBounds(' \t\n', 1), [0, 3]);
  assert.deepEqual(rules.wordBounds('', 0), [0, 0]);
});

it('запасной путь без Segmenter сохраняет кириллицу с дефисом и emoji', () => {
  // Старый WebView без Segmenter не должен разрывать слово либо суррогатную пару.
  const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
  try {
    Object.defineProperty(Intl, 'Segmenter', { value: undefined, configurable: true });
    assert.deepEqual(rules.wordBounds('по-русски', 5), [0, 9]);
    assert.deepEqual(rules.wordBounds('🙂', 0), [0, 2]);
  } finally {
    if (descriptor) Object.defineProperty(Intl, 'Segmenter', descriptor);
    else Reflect.deleteProperty(Intl, 'Segmenter');
  }
});

it('перекрещённые и выходящие за текст маркеры прижимаются, равные не дают пустого выделения', () => {
  // Равные маркеры иначе скрывают текст, который панель обещает скопировать.
  const check = (api: typeof rules) => {
    assert.deepEqual(Array.from(api.orderedRange(5, 2, 8)), [2, 5]);
    assert.deepEqual(Array.from(api.orderedRange(-10, 99, 8)), [0, 8]);
    assert.deepEqual(Array.from(api.orderedRange(3, 3, 8)), [3, 4]);
    assert.deepEqual(Array.from(api.orderedRange(8, 8, 8)), [7, 8]);
    assert.deepEqual(Array.from(api.orderedRange(-3, -2, 8)), [0, 1]);
    assert.deepEqual(Array.from(api.orderedRange(0, 0, 0)), [0, 0]);
  };
  check(rules);
  assert.throws(() => check(mutant('if (e <= s)', 'if (e < s)')), assert.AssertionError);
});

it('полное выделение игнорирует только краевые пробелы, оставшаяся буква требует «Выделить всё»', () => {
  // Панель не должна предлагать бессмысленный повтор полного выделения.
  const check = (api: typeof rules) => {
    assert.equal(api.selectsAll(0, 3, 'раз'), true);
    assert.equal(api.selectsAll(2, 5, '  раз \n'), true);
    assert.equal(api.selectsAll(1, 3, 'раз'), false);
    assert.equal(api.selectsAll(0, 2, 'раз'), false);
    assert.equal(api.selectsAll(0, 0, ''), true);
  };
  check(rules);
  assert.throws(() => check(mutant("text.slice(0, start).trim()", "text.slice(0, start)")), assert.AssertionError);
});

it('смещение внутри суррогатной пары выбирает заданную сторону, обычные края не меняются', () => {
  // Обратное направление snap меняет символ при перетаскивании левого маркера.
  const check = (api: typeof rules) => {
    assert.equal(api.snapOffset('a🙂b', 2), 3);
    assert.equal(api.snapOffset('a🙂b', 2, false), 1);
    for (const p of [0, 1, 3, 4]) assert.equal(api.snapOffset('a🙂b', p), p);
    assert.equal(api.snapOffset('a🙂b', -1), 0);
    assert.equal(api.snapOffset('a🙂b', 99), 4);
    assert.equal(api.snapOffset('', 99), 0);
  };
  check(rules);
  assert.throws(() => check(mutant('forward ? o + 1 : o - 1', 'forward ? o - 1 : o + 1')), assert.AssertionError);
});
