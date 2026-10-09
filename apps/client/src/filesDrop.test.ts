import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type * as rules from './filesDrop';

function load(source = readFileSync(new URL('./filesDrop.ts', import.meta.url), 'utf8')): typeof rules {
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => { assert.equal(id, 'react'); return { useSyncExternalStore: () => 0 }; } });
  return module.exports as typeof rules;
}

it('бросок есть только при Files, и заказ можно забрать своей ленте один раз', () => {
  const api = load(); const a = { name: 'a' } as File;
  assert.equal(api.hasFilesDrag(['Files']), true);
  assert.equal(api.hasFilesDrag(['text/plain']), false); assert.equal(api.hasFilesDrag([]), false); assert.equal(api.hasFilesDrag(null), false);
  api.requestFilesDrop('dm:a', [a], 100);
  assert.equal(api.takeFilesDrop('dm:b', 100), null);
  assert.equal(api.takeFilesDrop(undefined, 100), null);
  assert.equal(api.takeFilesDrop('dm:a', 100)?.[0], a);
  assert.equal(api.takeFilesDrop('dm:a', 100), null);
});

it('заказ живёт ровно 8 секунд, пустой drop не создаёт заказ, движение проверяется по обеим осям', () => {
  const api = load(); const old = { name: 'old' } as File;
  api.requestFilesDrop('dm:x', [], 10); assert.equal(api.takeFilesDrop('dm:x', 10), null);
  api.requestFilesDrop('dm:x', [old], 10);
  assert.deepEqual(api.takeFilesDrop('dm:x', 10 + api.FILES_DROP_TTL_MS), [old]);
  api.requestFilesDrop('dm:x', [old], 10);
  assert.equal(api.takeFilesDrop('dm:x', 10 + api.FILES_DROP_TTL_MS + 1), null);
  assert.equal(api.dragMoved(null, 0, 0), true);
  assert.equal(api.dragMoved({ x: 10, y: 10 }, 14, 14), false);
  assert.equal(api.dragMoved({ x: 10, y: 10 }, 15, 10), true);
  assert.equal(api.dragMoved({ x: 10, y: 10 }, 10, 15), true);
  const source = readFileSync(new URL('./filesDrop.ts', import.meta.url), 'utf8');
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source.replace('now - at > FILES_DROP_TTL_MS', 'now - at >= FILES_DROP_TTL_MS'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: () => ({ useSyncExternalStore: () => 0 }) });
  const mutant = module.exports as typeof rules;
  mutant.requestFilesDrop('dm:boundary', [old], 0);
  assert.throws(() => assert.notEqual(mutant.takeFilesDrop('dm:boundary', api.FILES_DROP_TTL_MS), null), assert.AssertionError,
    'мутант протухает заказ ровно на границе допустимых восьми секунд');
  const noClear = load(source.replace('  pending = null;\n  return now - at > FILES_DROP_TTL_MS', '  return now - at > FILES_DROP_TTL_MS'));
  noClear.requestFilesDrop('dm:once', [old], 0);
  assert.throws(() => assert.equal(noClear.takeFilesDrop('dm:once', 0), null), assert.AssertionError,
    'мутант оставляет один и тот же бросок доступным для второго открытия окна');
  const oneAxisOnly = load(source.replace('Math.abs(x - prev.x) > DRAG_STILL_PX || Math.abs(y - prev.y) > DRAG_STILL_PX',
    'Math.abs(x - prev.x) > DRAG_STILL_PX && Math.abs(y - prev.y) > DRAG_STILL_PX'));
  assert.throws(() => assert.equal(oneAxisOnly.dragMoved({ x: 10, y: 10 }, 10, 15), true), assert.AssertionError,
    'мутант не замечает вертикальное движение мыши без горизонтального');
});
