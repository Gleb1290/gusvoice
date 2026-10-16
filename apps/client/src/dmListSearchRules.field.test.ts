import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as row from './dmRowRules';
import * as media from './sharedMediaRules';
import * as rules from './dmListSearchRules';

const source = readFileSync(new URL('./dmListSearchRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load(raw: string): typeof rules {
  const module = { exports: {} as typeof rules };
  const deps: Record<string, unknown> = { '@gusvoice/shared': shared, './dmRowRules': row, './sharedMediaRules': media };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => {
      if (!Object.hasOwn(deps, id)) throw Error(`Неописанный импорт ${id}`); return deps[id];
    } });
  return module.exports;
}
function replaceOnce(anchor: string, replacement: string): string {
  assert.equal(source.split(anchor).length - 1, 1, 'якорь мутации уникален'); return source.replace(anchor, replacement);
}
function alpha(api = rules) {
  for (const [scrollTop, expected] of [[-48, 1], [-0.01, 1], [0, 1], [24, 0.5], [47.999, 1 - 47.999 / 48], [48, 0], [48.001, 0], [10000, 0]])
    assert.equal(api.searchFieldAlpha({ scrollTop, searching: false, selecting: false }), expected);
}
function priorities(api = rules) {
  for (const scrollTop of [-10, 0, 24, 48, 100]) {
    assert.equal(api.searchFieldAlpha({ scrollTop, searching: true, selecting: false }), 1);
    for (const searching of [true, false]) assert.equal(api.searchFieldAlpha({ scrollTop, searching, selecting: true }), 0);
  }
}
// Класс ошибки: уход прозрачности за диапазон 0…1 или неверная высота поля.
it('R170 поле гаснет от нуля до 48, отрицательная и сверхпороговая прокрутка зажимаются', () => alpha());
// Класс ошибки: поиск отменяет более приоритетное скрытие режима выбора.
it('R170 поиск удерживает поле видимым, выбор скрывает его даже при поиске', () => priorities());
// Класс ошибки: значок поиска появляется при выборе или ещё видимом поле.
it('R170 значок показан только после погасания и запрещён при поиске или выборе', () => {
  for (const [scrollTop, expected] of [[0, false], [24, false], [47.519, false], [47.521, true], [48, true], [200, true]] as const)
    assert.equal(rules.searchButtonShown({ scrollTop, searching: false, selecting: false }), expected);
  for (const scrollTop of [0, 48, 100]) for (const [searching, selecting] of [[true, false], [false, true], [true, true]])
    assert.equal(rules.searchButtonShown({ scrollTop, searching, selecting }), false);
});
// Класс ошибки: дрейф согласованного размера поля или порога кнопки.
it('R170 константы высоты поля 48 и погасания 0.01 закреплены отдельно', () => {
  assert.equal(rules.SEARCH_FIELD_H, 48); assert.equal(rules.SEARCH_FIELD_GONE_ALPHA, 0.01);
});
function inclusive(raw: string) {
  const ast = ts.createSourceFile('dmListSearchRules.ts', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const fn = ast.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === 'searchButtonShown');
  assert.equal(fn.length, 1);
  const returns = fn[0].body!.statements.filter(ts.isReturnStatement);
  assert.equal(returns.length, 1); const expression = returns[0].expression!;
  assert.equal(ts.isBinaryExpression(expression), true);
  if (!ts.isBinaryExpression(expression)) return;
  assert.equal(expression.operatorToken.kind, ts.SyntaxKind.LessThanEqualsToken);
  assert.equal(expression.right.getText(ast), 'SEARCH_FIELD_GONE_ALPHA');
  assert.equal(ts.isCallExpression(expression.left), true);
  if (ts.isCallExpression(expression.left)) assert.equal(expression.left.expression.getText(ast), 'searchFieldAlpha');
}
// Класс ошибки: исключённая граница <= заменена на <.
it('R170 точная граница погасания включительна в адресном AST функции кнопки', () => {
  // 1 - scrollTop/48 не может представить ровно JS-число 0.01: проверка соседей выше поведенческая,
  // а именно включительность закрепляется на реальном операторе функции, без искусственного alpha.
  inclusive(source);
  assert.throws(() => inclusive(replaceOnce('<= SEARCH_FIELD_GONE_ALPHA', '< SEARCH_FIELD_GONE_ALPHA')), assert.AssertionError);
});
// Класс ошибки: удалён clamp прозрачности.
it('R170 мутант без зажима обнаруживается реальной функцией на обеих сторонах диапазона', () => {
  alpha(); assert.throws(() => alpha(load(replaceOnce('Math.min(1, Math.max(0, scrollTop / SEARCH_FIELD_H))', 'scrollTop / SEARCH_FIELD_H'))), assert.AssertionError);
});
// Класс ошибки: перепутан приоритет поиска и выбора.
it('R170 мутант приоритета поиска обнаруживается при одновременно открытом выборе', () => {
  priorities(); assert.throws(() => priorities(load(replaceOnce('if (selecting) return 0;\n  if (searching) return 1;', 'if (searching) return 1;\n  if (selecting) return 0;'))), assert.AssertionError);
});
// Класс ошибки: высота 56 вместо 48 замедляет исчезновение поля.
it('R170 мутант высоты 56 обнаруживается прозрачностью на 24 и 48', () => {
  alpha(); assert.throws(() => alpha(load(replaceOnce('export const SEARCH_FIELD_H = 48;', 'export const SEARCH_FIELD_H = 56;'))), assert.AssertionError);
});
