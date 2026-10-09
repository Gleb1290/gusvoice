import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { FwdDraft } from './store';

function actionFromStore(change?: (source: string) => string): (set: (patch: unknown) => void) => (convId: string, draft: FwdDraft | null) => void {
  const full = readFileSync(new URL('./store.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const source = change ? change(full) : full;
  const parsed = ts.createSourceFile('store.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(parsed).replace(/['"]/g, '') === 'setFwdDraft') initializer = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.ok(initializer, 'в store.ts найдено настоящее действие setFwdDraft');
  const harness = `globalThis.makeAction = (set) => (${initializer.getText(parsed)});`;
  const code = ts.transpileModule(harness, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const context: Record<string, unknown> = {};
  runInNewContext(code, context);
  return context.makeAction as (set: (patch: unknown) => void) => (convId: string, draft: FwdDraft | null) => void;
}

function scenario(makeAction: ReturnType<typeof actionFromStore>) {
  const existing: FwdDraft = { from: 'origin', messages: [], hideSender: false, hideCaptions: false };
  let state: { fwdDrafts: Record<string, FwdDraft> } = { fwdDrafts: { c: existing } };
  const set = (update: unknown) => {
    const patch = typeof update === 'function' ? (update as (s: typeof state) => object)(state) : update as object;
    state = { ...state, ...patch };
  };
  const action = makeAction(set);
  const replacement: FwdDraft = { from: 'other-origin', messages: [], hideSender: true, hideCaptions: false };
  action('c', replacement);
  assert.equal(state.fwdDrafts.c, replacement, 'существующий черновик заменён');
  action('new', existing);
  assert.equal(state.fwdDrafts.new, existing, 'новый черновик установлен');
  action('c', null);
  assert.equal(Object.hasOwn(state.fwdDrafts, 'c'), false, 'null удаляет ключ, а не оставляет undefined');
  const before = state.fwdDrafts;
  action('missing', null);
  assert.equal(state.fwdDrafts, before, 'удаление отсутствующей беседы сохраняет ссылку на карту');
}

it('черновик пересылки ставится и заменяется, null удаляет без пустой записи и лишней копии', () => {
  // Пустой ключ с undefined расходится с отсутствием и мешает проверкам жизненного цикла черновика.
  scenario(actionFromStore());
  const from = 'delete next[convId];';
  const to = 'next[convId] = undefined;';
  const bad = actionFromStore((source) => {
    assert.ok(source.includes(from), 'найдена настоящая операция удаления из store.ts');
    const changed = source.replace(from, to);
    assert.notEqual(changed, source, 'мутант действительно изменил исходник');
    return changed;
  });
  assert.throws(() => scenario(bad), assert.AssertionError);
});
