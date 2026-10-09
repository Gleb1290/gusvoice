import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type * as rules from './dmListView';

function load(source = readFileSync(new URL('./dmListView.ts', import.meta.url), 'utf8'), store = new Map<string, string>()): typeof rules {
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
      require: (id: string) => { assert.equal(id, 'react'); return { useSyncExternalStore: (_sub: unknown, snap: () => unknown) => snap() }; } });
  return module.exports as typeof rules;
}

it('ширина списка проходит обе стороны порога узкого режима и сохраняет ширину канала', () => {
  const api = load();
  assert.equal(api.snapListWidth(129, true, 180, 480), 72);
  assert.equal(api.snapListWidth(130, true, 180, 480), 180);
  assert.equal(api.snapListWidth(400, true, 180, 480), 400);
  assert.equal(api.snapListWidth(999, true, 180, 480), 480);
  assert.equal(api.snapListWidth(72, false, 180, 480), 180);
  assert.equal(api.effectiveListWidth(72, true, 240), 72);
  assert.equal(api.effectiveListWidth(72, false, 240), 240);
  assert.equal(api.effectiveListWidth(300, false, 240), 300);
  const source = readFileSync(new URL('./dmListView.ts', import.meta.url), 'utf8');
  const atInclusive = load(source.replace('raw < LIST_NARROW_BELOW', 'raw <= LIST_NARROW_BELOW'));
  assert.throws(() => assert.equal(atInclusive.snapListWidth(130, true, 180, 480), 180), assert.AssertionError,
    'мутант сворачивает список уже на самом пороге 130');
  const channelNarrow = load(source.replace('allowNarrow && raw <', 'raw <'));
  assert.throws(() => assert.equal(channelNarrow.snapListWidth(129, false, 180, 480), 180), assert.AssertionError,
    'мутант включает режим аватаров у канала, где его нет');
});

it('настройка двух/трёх строк читает и пишет локальное значение с заводским fallback', () => {
  const store = new Map<string, string>(); const api = load(undefined, store);
  assert.equal(api.DM_ROW_AVA, 46, 'аватар строки на ПК остаётся 46 px');
  assert.equal(api.getListLines(), 'two');
  api.setListLines('three'); assert.equal(api.getListLines(), 'three');
  api.setListLines('garbage' as never); assert.equal(api.getListLines(), 'two');
  assert.equal(api.LIST_LINES_DEFAULT, 'two');
});
