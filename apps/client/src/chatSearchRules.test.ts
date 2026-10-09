import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as sched from './schedRules';
import * as feed from './feedWindowRules';
import * as rules from './chatSearchRules';
const hit = (id: string, sortKey = 1) => ({ id, sortKey, createdAt: '2026-10-07T10:00:00Z' });
it('реальный обработчик F3 отвергает инверсию старее и новее', () => {
  // Контрфакт проверяет обработчик компонента, а не независимую модель направления.
  const raw = readFileSync(new URL('./components/ChatSearch.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('ChatSearch.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let arrow: ts.ArrowFunction | undefined;
  const visit = (n: ts.Node) => { if (ts.isVariableDeclaration(n) && n.name.getText(ast) === 'onKey' && n.initializer && ts.isArrowFunction(n.initializer)) arrow = n.initializer; ts.forEachChild(n, visit); };
  visit(ast); assert.ok(arrow);
  const source = arrow.getText(ast);
  const check = (s: string) => {
    const directions: string[] = [];
    const code = ts.transpileModule(`this.handler=${s};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const sandbox = { handler: (_e: unknown) => {}, document: { querySelector: () => null }, srcRef: { current: { open: true } },
      step: (dir: string) => directions.push(dir), close() {}, typingTarget: () => false };
    runInNewContext(code, sandbox);
    for (const shiftKey of [false, true]) sandbox.handler({ key: 'F3', shiftKey, preventDefault() {} });
    assert.deepEqual(directions, ['older', 'newer']);
  }; check(source);
  const changed = source.replace("e.shiftKey ? 'newer' : 'older'", "e.shiftKey ? 'older' : 'newer'");
  assert.notEqual(changed, source); assert.throws(() => check(changed), assert.AssertionError);
});
function mutant(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./chatSearchRules.ts', import.meta.url), 'utf8'); assert.ok(source.includes(from));
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => { if (id === './schedRules') return sched; assert.equal(id, './feedWindowRules'); return feed; } });
  return module.exports as typeof rules;
}
it('счётчик поиска различает отсутствие запроса и пустой ответ, номер первого результата равен одному', () => {
  // Ловит ложное «нет результатов» до запроса и нулевой номер самого нового сообщения.
  assert.equal(rules.counterLabel(null), null);
  assert.equal(rules.counterLabel({ index: 0, total: 0 }), 'Нет результатов');
  assert.equal(rules.counterLabel({ index: 0, total: 120 }), '1 из 120');
  assert.equal(rules.counterLabel({ index: 119, total: 120 }), '120 из 120');
});
it('шаги не пересекают края, порция запрашивается ровно за пять до конца и ждёт незагруженный результат', () => {
  // Ловит позднюю подгрузку, приводящую к неработающей стрелке у конца порции.
  const check = (api: typeof rules) => {
    const state = { query: 'x', hits: Array.from({ length: 10 }, (_, i) => hit(String(i))), total: 20, next: 'cursor', index: 3 };
    assert.deepEqual(api.stepPlan(state, 'older'), { index: 4, needMore: false });
    assert.deepEqual(api.stepPlan({ ...state, index: 4 }, 'older'), { index: 5, needMore: true });
    assert.deepEqual(api.stepPlan({ ...state, index: 9 }, 'older'), { index: null, needMore: true });
    assert.deepEqual(api.stepPlan({ ...state, index: 0 }, 'newer'), { index: null, needMore: false });
    assert.deepEqual(api.stepPlan({ ...state, index: 19 }, 'older'), { index: null, needMore: false });
    assert.deepEqual(api.stepPlan({ ...state, index: 4, next: null }, 'older'), { index: 5, needMore: false });
    assert.equal(api.canStep(null, 'older'), false);
    assert.equal(api.canStep({ ...state, total: 0 }, 'newer'), false);
  }; check(rules);
  assert.throws(() => check(mutant('<= SEARCH_PREFETCH', '< SEARCH_PREFETCH')), assert.AssertionError);
});
it('продолжение исключает уже известные id, сохраняет порядок и не меняет предыдущий снимок', () => {
  // Ловит повтор строки при пересечении страниц поиска.
  const state = { query: 'x', hits: [hit('a', 3), hit('b', 2)], total: 3, next: 'old', index: 1 };
  const next = rules.appendHits(state, [hit('b', 2), hit('c', 1)], null, 3);
  assert.deepEqual(next.hits.map(h => h.id), ['a', 'b', 'c']); assert.equal(next.next, null);
  assert.equal(next.index, 1); assert.equal(state.hits.length, 2); assert.equal(state.next, 'old');
});
it('подсветка ищет без регистра и перекрытий, пустой запрос ничего не выделяет', () => {
  // Ловит неверные координаты подсветки и бесконечный обход пустого образца.
  assert.deepEqual(rules.matchRanges('Аба АБА', ' аба '), [[0, 3], [4, 7]]);
  assert.deepEqual(rules.matchRanges('aaaa', 'aa'), [[0, 2], [2, 4]]);
  assert.deepEqual(rules.matchRanges('текст', ' '), []);
  assert.deepEqual(rules.matchRanges('İx', 'x'), []);
});
it('календарь включает сегодня, запрещает завтра и сохраняет шестую неделю длинного месяца', () => {
  // Ловит запрет перехода к сегодняшним сообщениям и исчезновение конца месяца.
  const check = (api: typeof rules) => {
    const now = new Date(2026, 10, 10, 19); const grid = api.jumpMonthGrid({ y: 2026, m: 10 }, new Date(2026, 10, 9), now);
    assert.equal(grid.length, 42); assert.equal(grid[0].date.getDay(), 1);
    assert.equal(grid.find(c => !c.out && c.n === 10)?.disabled, false);
    assert.equal(grid.find(c => !c.out && c.n === 11)?.disabled, true);
    assert.equal(grid.find(c => !c.out && c.n === 9)?.on, true);
    assert.equal(api.canGoNextMonth({ y: 2026, m: 10 }, now), false);
    assert.equal(api.canGoNextMonth({ y: 2026, m: 9 }, now), true);
  }; check(rules);
  assert.throws(() => check(mutant('date.getTime() > today', 'date.getTime() >= today')), assert.AssertionError);
});
