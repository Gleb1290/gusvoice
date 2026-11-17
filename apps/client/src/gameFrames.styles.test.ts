import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const windows = [
  ['Activities', 'ActivitiesCard', 'modal eco-welcome act-card game-frame'],
  ['WheelScene', 'WheelScene', 'modal eco-welcome game-frame wheel-scene'],
  ['Duel', 'DuelNewCard', 'modal eco-welcome act-card game-frame duel-new-card'],
  ['DuelScene', 'DuelScene', 'modal eco-welcome game-frame duel-scene'],
  ['Predictions', 'PredictionsScene', 'modal eco-welcome act-card game-frame pr-card'],
  ['GameBoard', 'GameBoardScene', 'modal eco-welcome act-card game-frame gb-card'],
] as const;
const P = 'R358/frame/check/';
const compact = (value: string) => value.replace(/\s+/g, '');

function frame(raw: string, name: string) {
  const ast = ts.createSourceFile(name + '.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.equal((ast as ts.SourceFile & { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length, 0, 'R358/frame/setup/TSX');
  const fn = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(fn?.body, 'R358/frame/setup/настоящий компонент');
  const found: ts.StringLiteral[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'className' && node.initializer && ts.isStringLiteral(node.initializer)) {
      const classes = node.initializer.text.split(/\s+/);
      if (classes.includes('modal') && classes.includes('eco-welcome')) found.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  assert.equal(found.length, 1, P + name + '/одна-рамка');
  return { literal: found[0], ast };
}

for (const [file, name] of windows) {
  it(`R358 ${name}: окно ПК подключено к общей game-frame, не к частному размеру`, () => {
    // Потеря класса у одного окна незаметна в общем CSS-страже: проверяем JSX именно его функции.
    const raw = readFileSync(new URL(`./components/${file}.tsx`, import.meta.url), 'utf8');
    const check = (text: string) => assert.ok(frame(text, name).literal.text.split(/\s+/).includes('game-frame'), P + name + '/общая-рамка');
    check(raw);
    counterfact(() => {
      const { literal, ast } = frame(raw, name);
      const changed = raw.slice(0, literal.getStart(ast)) + JSON.stringify(literal.text.replace(/\bgame-frame\b/, 'removed-frame')) + raw.slice(literal.end);
      assert.throws(() => check(changed), e => e instanceof assert.AssertionError && e.message.startsWith(P + name + '/'));
    });
    check(raw);
  });
}

type Rule = { selector: string; props: Map<string, string>; order: number };
// Только глобальные правила ПК: media/keyframes/font-face пропускаются целыми сбалансированными блоками.
// Это проверка CSS-контракта, не попытка получить раскладку или env() из happy-dom.
function rules(raw: string): Rule[] {
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const result: Rule[] = [];
  let start = 0, depth = 0, quote = '', header = '', bodyStart = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') {
      if (depth === 0) { header = text.slice(start, i).trim(); bodyStart = i + 1; }
      depth++;
    } else if (ch === '}') {
      depth--; assert.ok(depth >= 0, 'R358/frame/setup/CSS-скобки');
      if (depth !== 0) continue;
      if (!header.startsWith('@')) {
        const props = new Map<string, string>();
        // В интересующих правилах значения calc/var, без вложенных деклараций или строк с точкой с запятой.
        for (const part of text.slice(bodyStart, i).split(';')) {
          const colon = part.indexOf(':');
          if (colon >= 0) props.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
        }
        for (const selector of header.split(',')) result.push({ selector: selector.trim(), props, order: result.length });
      }
      start = i + 1;
    } else if (ch === ';' && depth === 0) start = i + 1;
  }
  assert.equal(depth, 0, 'R358/frame/setup/CSS-закрыт');
  return result;
}
function exact(all: Rule[], selector: string, property: string) {
  const found = all.filter(rule => rule.selector === selector && rule.props.has(property));
  return found.at(-1)?.props.get(property);
}
function effective(all: Rule[], classes: string, property: string) {
  const set = new Set(classes.split(/\s+/));
  const candidates = all.filter(rule => /^(?:\.[\w-]+)+$/.test(rule.selector)
    && [...rule.selector.matchAll(/\.([\w-]+)/g)].every(match => set.has(match[1])) && rule.props.has(property));
  // Для корневой карточки — одноэлементные class-селекторы: специфичность, затем порядок, а не первое совпадение.
  const rank = (rule: Rule) => (rule.props.get(property)!.includes('!important') ? 1000 : 0) + (rule.selector.match(/\./g)?.length ?? 0);
  candidates.sort((a, b) => rank(a) - rank(b) || a.order - b.order);
  return candidates.at(-1)?.props.get(property)?.replace(/\s*!important\s*$/, '');
}
function counter(check: (raw: string) => void, mutants: Array<() => string>) {
  check(css);
  for (const makeMutant of mutants) {
    counterfact(() => {
      const mutant = makeMutant();
      assert.notEqual(mutant, css, 'R358/frame/setup/изменение существует');
      assert.throws(() => check(mutant), e => e instanceof assert.AssertionError && e.message.startsWith(P));
    });
    check(css);
  }
}

it('R358 все шесть окон получают одну ширину и высоту с потолком окна и вычетом titlebar', () => {
  // Старый act-card width:460px допустим лишь пока общий более поздний селектор действительно его перекрывает.
  const check = (raw: string) => {
    const all = rules(raw), selector = '.modal.eco-welcome.game-frame';
    const width = exact(all, selector, 'width');
    assert.match(width ?? '', /^\d+(?:\.\d+)?px$/, P + 'общая-ширина');
    assert.ok(Number.parseFloat(width!) > 0, P + 'положительная-ширина');
    const height = 'min(720px, calc(var(--vh-px, 100dvh) - 32px - var(--gv-titlebar-h, 0px)))';
    const maxHeight = 'calc(var(--vh-px, 100dvh) - 32px - var(--gv-titlebar-h, 0px))';
    assert.equal(compact(exact(all, selector, 'height') ?? ''), compact(height), P + 'общая-высота');
    for (const [, name, classes] of windows) {
      assert.equal(effective(all, classes, 'width'), width, P + name + '/ширина');
      assert.equal(compact(effective(all, classes, 'height') ?? ''), compact(height), P + name + '/высота');
      assert.equal(compact(effective(all, classes, 'max-height') ?? ''), compact(maxHeight), P + name + '/потолок');
      assert.equal(effective(all, classes, 'overflow-y'), 'auto', P + name + '/прокрутка');
    }
  };
  counter(check, [
    () => css + '\n.modal.eco-welcome.game-frame.duel-scene { width: 460px; }',
    () => css + '\n.modal.eco-welcome.game-frame { height: min(720px, 100dvh); }',
    () => css + '\n.modal.eco-welcome.game-frame { max-height: 100dvh; }',
    () => css + '\n.modal.eco-welcome.game-frame { overflow-y: hidden; }',
  ]);
  // Телефонное исключение не отменяет общий размер ПК; комментарий и чужой селектор ничего не меняют.
  check(css + '\n/* height: 100vh */\n@media(max-width:620px){.modal.eco-welcome.game-frame{height:auto}}\n.other {width:12px}');
});

it('R358 ряд действий прижат вниз, а табло дуэли не забирает свободное место', () => {
  // При flex:1 на таймере или margin-top:0 кнопки прыгают между фазами, даже если общий размер карточки верный.
  const check = (raw: string) => {
    const all = rules(raw);
    assert.equal(exact(all, '.game-actions', 'display'), 'flex', P + 'действия-flex');
    assert.equal(exact(all, '.game-actions', 'margin-top'), 'auto', P + 'действия-вниз');
    assert.ok(Number.parseFloat(exact(all, '.game-actions', 'min-height') ?? '') >= 44, P + 'действия-высота');
    assert.equal(exact(all, '.dc-body > .wh-timer', 'flex'), 'none', P + 'таймер-не-растёт');
  };
  counter(check, [() => css + '\n.game-actions {margin-top:0}', () => css + '\n.dc-body > .wh-timer {flex:1}']);
  check(css + '\n.game-actions {transition:opacity 100ms}');
});
