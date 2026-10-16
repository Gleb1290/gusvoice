import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, after, it } from 'node:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';
import { viewportSafe } from './popover.js';

const source = readFileSync(new URL('./popover.ts', import.meta.url), 'utf8');
before(() => GlobalRegistrator.register({ url: 'http://localhost/' }));
after(() => GlobalRegistrator.unregister());

// Разбирается только AST присваивания, никакие фрагменты приложения не исполняются.
function probeCss(raw: string): string {
  const file = ts.createSourceFile('popover.ts', raw, ts.ScriptTarget.Latest, true);
  const fn = file.statements.find((s): s is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(s) && s.name?.text === 'viewportSafe');
  assert.ok(fn?.body);
  const assignments: ts.BinaryExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.left.getText(file) === 'probe.style.cssText') assignments.push(node);
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  assert.equal(assignments.length, 1, 'единственное присваивание CSS настоящей пробы');
  const literal = (node: ts.Expression): string => {
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return literal(node.left) + literal(node.right);
    assert.fail('CSS пробы должен быть явно задан строковыми литералами');
  };
  return literal(assignments[0].right);
}

function checkProbe(css: string) {
  for (const [side, native] of [['top', 'sat'], ['bottom', 'sab'], ['left', 'sal'], ['right', 'sar']]) {
    assert.match(css, new RegExp(`(?:^|;)\\s*padding-${side}\\s*:\\s*max\\(env\\(safe-area-inset-${side}\\),\\s*var\\(--gv-${native},\\s*0px\\)\\)\\s*(?:;|$)`),
      `${side}: проба измеряет максимум браузерной и native-вставки`);
  }
}

function measure(top: number, bottom: number, left: number, right: number, zoom = 1) {
  const restore: Array<() => void> = [];
  const patch = (target: object, key: string, descriptor: PropertyDescriptor) => {
    const old = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, ...descriptor });
    restore.push(() => { if (old) Object.defineProperty(target, key, old); else Reflect.deleteProperty(target, key); });
  };
  const written = new WeakMap<Element, string>();
  const create = document.createElement.bind(document);
  let probe: Element | undefined;
  let measurements = 0;
  const children = document.body.childElementCount;
  patch(document.documentElement, 'clientWidth', { value: 900 });
  patch(document.documentElement, 'clientHeight', { value: 600 });
  patch(window, 'visualViewport', { value: null });
  patch(document, 'createElement', { value: (tag: string) => {
    const element = create(tag);
    probe = element;
    // Перехватываем ДО парсера HappyDOM: paddingLeft из style здесь всегда был бы пустым.
    patch(element.style, 'cssText', { get: () => written.get(element) ?? '',
      set: (css: string) => { written.set(element, css); } });
    return element;
  } });
  patch(globalThis, 'getComputedStyle', { value: (element: Element) => {
    if (element === document.documentElement) return { zoom: String(zoom) };
    assert.ok(element === probe, 'измеряется созданная проба');
    assert.ok(document.body.contains(element), 'измерение только после подключения к DOM');
    checkProbe(written.get(element) ?? '');
    measurements++;
    return { paddingTop: `${top}px`, paddingBottom: `${bottom}px`, paddingLeft: `${left}px`, paddingRight: `${right}px` };
  } });
  try {
    const result = viewportSafe();
    assert.equal(measurements, 1);
    assert.equal(document.body.childElementCount, children, 'после замера проба удалена');
    assert.equal(probe?.isConnected, false);
    return result;
  } finally { for (const undo of restore.reverse()) undo(); }
}

it('R120 проба без вставок сохраняет прежний вьюпорт без лишних left/top', () => {
  assert.deepEqual(measure(0, 0, 0, 0), { vw: 900, vh: 600 });
});
it('R120 проба с левой навигацией сдвигает начало, но не правую кромку', () => {
  assert.deepEqual(measure(0, 0, 48, 0), { vw: 900, vh: 600, left: 48 });
});
it('R120 проба с правой навигацией сокращает правую кромку без левого сдвига', () => {
  assert.deepEqual(measure(0, 0, 0, 48), { vw: 852, vh: 600 });
});
it('R120 четыре разных вставки не путаются и измеряются в layout-единицах при zoom', () => {
  // Разные значения ловят перестановку сторон; CSS padding не надо повторно делить на zoom.
  assert.deepEqual(measure(32, 24, 48, 36, 1.5), { vw: 564, vh: 376, top: 32, left: 48 });
});
it('R120 страж пробы отвергает удаление каждой боковой декларации и native fallback', () => {
  checkProbe(probeCss(source));
  for (const [side, native] of [['left', 'sal'], ['right', 'sar']]) {
    const declaration = `padding-${side}:max(env(safe-area-inset-${side}), var(--gv-${native}, 0px))`;
    for (const replacement of ['', `padding-${side}:env(safe-area-inset-${side})`]) {
      const mutant = source.replace(declaration, replacement);
      assert.notEqual(mutant, source, 'контрфакт меняет настоящий исходник');
      assert.throws(() => checkProbe(probeCss(mutant)), assert.AssertionError);
    }
  }
});
