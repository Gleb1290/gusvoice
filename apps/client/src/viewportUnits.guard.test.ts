import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { css, declarations } from '../test-support/cssGuards.js';

const unit = /\b\d*\.?\d+(?:d|s|l)?v(?:h|w|min|max)\b/i;
// Document PiP имеет отдельный viewport; исключение относится только к max-height.
const exceptions = [{ selector: '.ctx-menu.stream-pip-menu:not(.sheet)', property: 'max-height' }];
const nonWindowProperties = new Set(['font-size', 'padding']);
function outsideFallback(value: string): string {
  // Удаляем целый var(), включая вложенные calc/var в fallback, но оставляем соседние голые единицы.
  const start = /\bvar\(\s*--v[hw]-px\s*,/g;
  let result = '', at = 0, match: RegExpExecArray | null;
  while ((match = start.exec(value))) {
    result += value.slice(at, match.index);
    let depth = 1, i = start.lastIndex, quote = '';
    for (; i < value.length && depth; i++) {
      const c = value[i]!;
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    assert.equal(depth, 0, 'R354/viewport/setup/balanced-fallback');
    at = i; start.lastIndex = i;
  }
  return result + value.slice(at);
}
const dimension = (name: string) => name.startsWith('--') || /^(?:(?:min-|max-)?(?:height|width)|flex-basis|inset(?:-.+)?|top|bottom)$/.test(name);
function cssIssues(raw: string) {
  return declarations(raw).flatMap(declaration => {
    if (nonWindowProperties.has(declaration.property) || !dimension(declaration.property) || !unit.test(outsideFallback(declaration.value))) return [];
    // Группа — не точное исключение: общий потолок уже действует и за пределами отдельного окна PiP.
    if (declaration.selectors.length === 1 && exceptions.some(rule => rule.selector === declaration.selectors[0]
      && rule.property === declaration.property)) return [];
    return declaration.selectors.map(selector => `${selector} ${declaration.property}: ${declaration.value}`);
  });
}

it('размеры всего CSS используют измеренный viewport вместо голых vh и vw', () => {
  assert.deepEqual(cssIssues(css), []);
});

it('проверка viewport различает fallback, типографику и отдельный документ PiP', () => {
  // Искусственные декларации проверяют сам анализатор, без мутаций исходного CSS.
  assert.deepEqual(cssIssues(`/* .ignored { height: 80vh; } */
    .text { font-size: clamp(12px, 4vw, 20px); }
    .panel { padding: max(4vw, 8px); }
    .window { height: var(--vh-px, calc(100dvh - 2px)); width: var(--vw-px, 100dvw); }
    .ctx-menu.stream-pip-menu:not(.sheet) { max-height: calc(100vh - 16px); }
  `), []);
  const pip = '.ctx-menu.stream-pip-menu:not(.sheet)';
  for (const raw of [`.window { height: calc(var(--vh-px, 100dvh) + 1vh); }`,
    `.window { height: var(--vh-px-other, 80vh); }`, `${pip} { width: 80vw; }`,
    `${pip}, .other { max-height: 80vh; }`, `.other, ${pip} { max-height: 80vh; }`])
    assert.ok(cssIssues(raw).length > 0, raw);
});

it('проверка viewport обнаруживает все семейства единиц в размерах и переменных', () => {
  for (const suffix of ['vh', 'vw', 'vmin', 'vmax', 'dvh', 'dvw', 'svh', 'svw', 'lvh', 'lvw'])
    for (const property of ['height', 'min-height', 'max-height', 'width', 'min-width', 'max-width', 'flex-basis', 'inset', 'top', 'bottom', '--round'])
      assert.equal(cssIssues(`.sample { ${property}: -.5${suffix}; }`).length, 1, `${property} ${suffix}`);
});


const inlineKeys = new Set(['height', 'width', 'maxHeight', 'maxWidth', 'minHeight', 'minWidth']);
function inlineIssues(raw: string, filename: string) {
  const file = ts.createSourceFile(filename, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const issues: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node)) {
      const key = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text
        : ts.isComputedPropertyName(node.name) && ts.isStringLiteral(node.name.expression) ? node.name.expression.text : '';
      if (inlineKeys.has(key)) {
        function strings(value: ts.Node) {
          if (ts.isStringLiteralLike(value) && unit.test(outsideFallback(value.text)))
            issues.push(`${filename}:${file.getLineAndCharacterOfPosition(value.getStart(file)).line + 1} ${key}: ${value.text}`);
          if (ts.isTemplateExpression(value)) {
            // Не вычисляем выражения: подстановка числового маркера также ловит `${size}vh`.
            const text = value.head.text + value.templateSpans.map(span => '0' + span.literal.text).join('');
            if (unit.test(outsideFallback(text))) issues.push(`${filename} ${key}: ${text}`);
          }
          ts.forEachChild(value, strings);
        }
        strings(node.initializer);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file); return issues;
}
function tsxFiles(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    return entry.isDirectory() ? tsxFiles(url) : /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) ? [url] : [];
  });
}

it('инлайн-размеры клиента также используют измеренный viewport', () => {
  // Общий обход AST сохранён; точных строк компонентов и закрытого списка файлов нет.
  const files = tsxFiles(new URL('./', import.meta.url));
  const found = files.flatMap(file => inlineIssues(readFileSync(file, 'utf8'), file.pathname));
  assert.deepEqual(found, []);
});
