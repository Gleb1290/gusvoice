import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as motion from './bubbleMotion';

function mutant(from: string, to: string): typeof motion {
  const source = readFileSync(new URL('./bubbleMotion.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(source.includes(from), 'точка мутации найдена');
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports });
  return module.exports as typeof motion;
}

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

it('первый показ, смена окна и более трёх новых строк не притворяются анимацией прихода', () => {
  // Ловит длинную очередь появления при открытии истории или смене беседы.
  const check = (api: typeof motion) => {
    assert.deepEqual(plain(api.freshTail(null, [{ id: 'a' }])), []);
    assert.deepEqual(plain(api.freshTail([{ id: 'old' }], [{ id: 'new' }])), []);
    assert.deepEqual(plain(api.freshTail([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }])), ['b', 'c', 'd']);
    const tooMany = Array.from({ length: 4 }, (_, i) => ({ id: `n${i}` }));
    assert.deepEqual(plain(api.freshTail([{ id: 'a' }], [{ id: 'a' }, ...tooMany])), []);
  };
  check(motion);
  check(mutant('export function freshTail(', 'export function freshTail('));
  const noCap = mutant('added.length > MOTION_MAX', 'false');
  assert.throws(() => check(noCap), assert.AssertionError,
    'мутант анимирует порцию истории как четыре новых сообщения');
});

it('удалённые у края окна и большие очистки не схлопываются внутри оставшейся ленты', () => {
  // Иначе при прокрутке вверх исчезает верхняя кромка окна и строки всплывают в неверном месте.
  const prev = [{ id: 'top' }, { id: 'drop-1' }, { id: 'drop-2' }, { id: 'bottom' }];
  const next = [{ id: 'top' }, { id: 'bottom' }];
  const check = (api: typeof motion) => {
    assert.deepEqual(plain(api.removedInPlace([{ id: 'gone' }, { id: 'kept' }], [{ id: 'kept' }])), []);
    assert.deepEqual(plain(api.removedInPlace(prev, next)), [{ row: prev[1], afterId: 'top' }, { row: prev[2], afterId: 'top' }]);
    assert.deepEqual(plain(api.removedInPlace([{ id: 'a' }, ...Array.from({ length: 4 }, (_, i) => ({ id: `g${i}` }))], [{ id: 'a' }])), []);
  };
  check(motion);
  check(mutant('export function removedInPlace<T extends Row>(', 'export function removedInPlace<T extends Row>('));
  const wrongNeighbor = mutant('while (k >= 0 && !have.has(prev[k].id)) k--;', '');
  assert.throws(() => check(wrongNeighbor), assert.AssertionError,
    'мутант привязывает подряд удалённые сообщения к уже исчезнувшему соседу');
});
