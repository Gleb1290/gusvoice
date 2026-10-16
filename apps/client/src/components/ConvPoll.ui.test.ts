import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import type { ConvPollMedia } from '@gusvoice/shared';
import * as popover from '../popover';
import * as bigReaction from '../bigReaction';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const raw = read('./ConvPoll.tsx'), paneRaw = read('./MessagePane.tsx'), chatRaw = read('./DmChatView.tsx'), cssRaw = read('../styles.css');
const unused = () => assert.fail('граница вне карточки или меню опроса');
const poll = (extra: Partial<ConvPollMedia> = {}): ConvPollMedia => ({ kind: 'poll', question: 'Выберите вариант',
  options: [{ id: 'a', text: 'Первый', votes: 3 }, { id: 'b', text: 'Второй', votes: 1 }],
  anonymous: true, multi: false, quiz: false, closed: false, voters: 4, my: [], revealed: false, ...extra });
function replaceOne(source: string, from: string, to: string) {
  assert.equal(source.split(from).length - 1, 1, 'у мутации один якорь в целом модуле'); return source.replace(from, to);
}
const failure = (prefix: string, actual: unknown, expected: unknown) => (error: unknown) => error instanceof assert.AssertionError
  && error.message.startsWith(prefix) && error.operator === 'strictEqual' && error.actual === actual && error.expected === expected;
function load<T>(source: string, deps: Record<string, unknown>): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, { module, exports: module.exports, window, document,
    HTMLElement, Element, Node, Event, DOMRect, getComputedStyle, require: (id: string) => {
      assert.ok(Object.hasOwn(deps, id), `объявленный импорт целого опросного UI: ${id}`); return deps[id];
    } }); return module.exports as T;
}
async function fixture(work: (f: {
  host: HTMLElement; card(p: ConvPollMedia): Promise<void>; menu(p: ConvPollMedia, mine: boolean): Promise<void>;
  labels(): string; vote: unknown[][]; closed: unknown[][]; patched: unknown[][]; confirmations: unknown[]; done(): number; confirm(on: boolean): void;
}) => Promise<void>, source = raw) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const priorAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const vote: unknown[][] = [], closed: unknown[][] = [], patched: unknown[][] = [], confirmations: unknown[] = [];
  let confirmed = false, done = 0;
  const common = { react: React, 'react/jsx-runtime': jsx, 'react-dom': ReactDOM };
  const icon = load<typeof import('./Icon')>(read('./Icon.tsx'), common);
  const status = load<typeof import('./StatusDot')>(read('./StatusDot.tsx'), common);
  const menu = load<typeof import('./ContextMenu')>(read('./ContextMenu.tsx'), { ...common, '../bigReaction': bigReaction,
    '../imageViewer': { useImageViewerOpen: () => false }, '../popover': popover, './Icon': icon, './StatusDot': status });
  const deps = { ...common, '@gusvoice/shared': shared, '../api': { api: {
    convPollVote: async (...args: unknown[]) => { vote.push(args); return { id: 'poll-message' }; },
    convPollClose: async (...args: unknown[]) => { closed.push(args); return { id: 'poll-message' }; },
    convPollVoters: unused,
  } }, '../confirm': { confirmAction: async (spec: unknown) => { confirmations.push(spec); return confirmed; } },
    '../store': { useStore: { getState: () => ({ convAfterEdit: (...args: unknown[]) => patched.push(args) }) } },
    '../toast': { toastError: unused }, '../dialogChrome': { useDialogChrome: unused }, '../phoneLayout': { usePhoneLayout: unused },
    './Avatar': { Avatar: unused }, './BottomSheet': { BottomSheet: unused }, './ContextMenu': menu, './Icon': icon, './Toggle': { Toggle: unused } };
  try {
    const component = load<typeof import('./ConvPoll')>(source, deps);
    await work({ host, vote, closed, patched, confirmations, done: () => done, confirm: on => { confirmed = on; },
      async card(p) { await React.act(async () => { root.render(React.createElement(component.ConvPollCard, { poll: p, conversationId: 'conversation', messageId: 'poll-message' })); }); },
      async menu(p, mine) { await React.act(async () => { root.render(React.createElement(component.ConvPollMenuItems,
        { poll: p, conversationId: 'conversation', messageId: 'poll-message', mine, onDone: () => { done++; } })); }); },
      labels: () => JSON.stringify([...host.querySelectorAll('.ctx-label-main')].map(node => node.textContent)),
    });
  } finally {
    await React.act(async () => root.unmount()); host.remove(); await GlobalRegistrator.unregister();
    if (priorAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', priorAct); else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
}
async function hidden(source = raw) {
  await fixture(async f => {
    // Ненулевые счётчики намеренны: UI должен проверять revealed, а не надеяться на обнулённую фикстуру.
    await f.card(poll());
    assert.equal(f.host.querySelectorAll('.poll-pct').length, 0, 'R219-percent: до revealed проценты не появляются даже при ненулевых votes');
    assert.equal(f.host.querySelectorAll('.poll-bar').length, 0, 'R219-bar: до revealed не показывается и фоновая шкала');
    await f.card(poll({ revealed: true, my: ['a'] }));
    assert.equal(JSON.stringify([...f.host.querySelectorAll('.poll-pct')].map(node => node.textContent)), '["75%","25%"]', 'revealed открывает настоящие проценты');
    assert.equal(JSON.stringify([...f.host.querySelectorAll<HTMLElement>('.poll-bar')].map(node => node.style.width)), '["100%","33%"]', 'полосы сравниваются с лидером, не с суммой');
    await f.card(poll()); assert.equal(f.host.querySelectorAll('.poll-pct').length, 0, 'отмена/обновление вида снова прячет проценты');
  }, source);
}
it('R219 карточка показывает проценты и шкалы только при revealed и скрывает их обратно', () => hidden());
it('R219 викторина выделяет правильный и неверный свой ответ только после revealed', async () => {
  await fixture(async f => {
    const p = poll({ quiz: true, correct: 'a', solution: 'Пояснение', my: ['b'] });
    await f.card(p); assert.equal(f.host.querySelectorAll('.right,.wrong,.conv-poll-solution').length, 0);
    await f.card({ ...p, revealed: true });
    assert.equal(f.host.querySelectorAll('.poll-opt.right').length, 1); assert.equal(f.host.querySelectorAll('.poll-opt.wrong').length, 1);
    assert.equal(f.host.querySelector('.conv-poll-solution span')?.textContent, 'Пояснение');
  });
});
const menus = [
  { label: 'чужой без своего голоса не получает действий', p: poll(), mine: false, expected: '[]' },
  { label: 'свой голос в обычном открытом опросе можно отменить', p: poll({ my: ['a'] }), mine: false, expected: '["Отменить голос"]' },
  { label: 'свой голос в викторине нельзя отменить', p: poll({ quiz: true, my: ['a'] }), mine: false, expected: '[]' },
  { label: 'автору викторины доступна только остановка', p: poll({ quiz: true, my: ['a'] }), mine: true, expected: '["Остановить викторину"]' },
  { label: 'закрытый опрос не получает ни отмену, ни остановку', p: poll({ closed: true, my: ['a'] }), mine: true, expected: '[]' },
  { label: 'автор открытого обычного опроса получает отмену и остановку', p: poll({ my: ['a'] }), mine: true, expected: '["Отменить голос","Остановить опрос"]' },
];
async function menuCase(index: number, source = raw) {
  const c = menus[index]; await fixture(async f => { await f.menu(c.p, c.mine); assert.equal(f.labels(), c.expected, `R219-menu-${index}: ${c.label}`); }, source);
}
for (let index = 0; index < menus.length; index++) it(`R219 меню: ${menus[index].label}`, () => menuCase(index));
it('R219 Отменить голос зовёт реальную ручку с пустым ids и обновляет сообщение', async () => {
  await fixture(async f => {
    await f.menu(poll({ my: ['a'] }), false);
    await React.act(async () => { f.host.querySelector<HTMLButtonElement>('button')!.click(); });
    assert.equal(JSON.stringify(f.vote), '[["conversation","poll-message",[]]]');
    assert.equal(JSON.stringify(f.patched), '[["conversation",{"id":"poll-message"}]]'); assert.equal(f.done(), 1);
  });
});
it('R219 остановка автора ждёт подтверждения: отмена не закрывает опрос, согласие закрывает', async () => {
  await fixture(async f => {
    await f.menu(poll(), true);
    await React.act(async () => { f.host.querySelector<HTMLButtonElement>('button')!.click(); });
    assert.equal(f.confirmations.length, 1); assert.equal(JSON.stringify(f.closed), '[]');
    f.confirm(true);
    await React.act(async () => { f.host.querySelector<HTMLButtonElement>('button')!.click(); });
    assert.equal(JSON.stringify(f.closed), '[["conversation","poll-message"]]'); assert.equal(f.patched.length, 1);
  });
});
for (const [label, from, to, scenario, prefix, actual, expected] of [
  ['проценты рисуются без revealed', '{poll.revealed && <span className="poll-pct">', '{true && <span className="poll-pct">', hidden, 'R219-percent:', 2, 0],
  ['шкала рисуется без revealed', '{poll.revealed && <span className="poll-bar"', '{true && <span className="poll-bar"', hidden, 'R219-bar:', 2, 0],
  ['отмена разрешена в викторине', 'const retract = poll.my.length > 0 && !poll.quiz;', 'const retract = poll.my.length > 0;', (s: string) => menuCase(2, s),
    'R219-menu-2:', '["Отменить голос"]', '[]'],
  ['у закрытого опроса остаются действия', '  if (poll.closed) return null;', '', (s: string) => menuCase(4, s), 'R219-menu-4:', '["Отменить голос","Остановить опрос"]', '[]'],
  ['остановка разрешена не автору', '{mine && (', '{true && (', (s: string) => menuCase(1, s), 'R219-menu-1:', '["Отменить голос","Остановить опрос"]', '["Отменить голос"]'],
] as const) it(`R219 DOM контрфакт: ${label}`, async () => {
  await scenario(raw); await assert.rejects(scenario(replaceOne(raw, from, to)), failure(prefix, actual, expected));
});

function all<T extends ts.Node>(node: ts.Node, guard: (n: ts.Node) => n is T): T[] {
  const list: T[] = []; const visit = (n: ts.Node) => { if (guard(n)) list.push(n); ts.forEachChild(n, visit); }; visit(node); return list;
}
const compact = (n: ts.Node | undefined, sf: ts.SourceFile) => n?.getText(sf).replace(/\s/g, '') ?? '';
const unparen = (n: ts.Expression): ts.Expression => ts.isParenthesizedExpression(n) ? unparen(n.expression) : n;
function actions(source = paneRaw) {
  const sf = ts.createSourceFile('MessagePane.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = all(sf, ts.isVariableDeclaration).filter(n => ts.isIdentifier(n.name) && n.name.text === 'mediaActions');
  assert.equal(declarations.length, 1, 'одна настоящая декларация mediaActions');
  const value = declarations[0].initializer;
  assert.equal(!!value && ts.isConditionalExpression(value) ? compact(value.condition, sf) : '', 'onSendMedia', 'R219-actions-outer: без отправки media действий нет');
  // Комментарий или строка с key: 'poll' не заменяют настоящий элемент массива действий.
  const spreads = value && ts.isConditionalExpression(value) && ts.isArrayLiteralExpression(value.whenTrue)
    ? value.whenTrue.elements.filter(ts.isSpreadElement).filter(n => {
      const expression = unparen(n.expression);
      return ts.isConditionalExpression(expression) && ts.isArrayLiteralExpression(expression.whenTrue)
        && expression.whenTrue.elements.some(item => ts.isObjectLiteralExpression(item) && item.properties.some(p =>
          ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === 'key'
          && ts.isStringLiteral(p.initializer) && p.initializer.text === 'poll'));
    }) : [];
  assert.equal(spreads.length, 1, 'одна ветка массива с настоящим key poll');
  const conditional = unparen(spreads[0].expression);
  assert.equal(conditional && ts.isConditionalExpression(conditional) ? compact(conditional.condition, sf) : '', 'convPoll', 'R219-actions: пункт Опрос зависит только от разрешённого convPoll');
  assert.equal(conditional && ts.isConditionalExpression(conditional) ? compact(conditional.whenFalse, sf) : '', '[]', 'выключенный признак не даёт ни одного пункта Опрос');
}
const pollGateSource = 'convPollFeature && (!peerHome || fedPollOk) && !groupHostId && !viaOn';
const pollGateContract = pollGateSource.replace(/\s/g, '');
function pollGateNodes(source: string) {
  const sf = ts.createSourceFile('DmChatView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const panes = all(sf, (n): n is ts.JsxOpeningElement | ts.JsxSelfClosingElement => ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n))
    .filter(n => ts.isIdentifier(n.tagName) && n.tagName.text === 'MessagePane');
  assert.equal(panes.length, 1, 'единственный настоящий MessagePane в DmChatView');
  const props = panes[0].attributes.properties.filter(ts.isJsxAttribute).filter(n => ts.isIdentifier(n.name) && n.name.text === 'convPoll');
  assert.equal(props.length, 1, 'один convPoll именно у MessagePane');
  const prop = props[0].initializer;
  assert.ok(prop && ts.isJsxExpression(prop) && prop.expression, 'настоящее выражение convPoll у MessagePane');
  return { sf, gate: prop.expression };
}
function featureGate(source = chatRaw) {
  const { sf, gate } = pollGateNodes(source);
  assert.equal(compact(gate, sf), pollGateContract,
    'R219-fed-gate: свой инстанс и разрешённый сосед доступны, чужой хост и через запрещены');
}
function fedPollNodes(source: string) {
  const { sf, gate } = pollGateNodes(source);
  const declarations = all(sf, ts.isVariableDeclaration).filter(n => ts.isIdentifier(n.name) && n.name.text === 'fedPollOk');
  assert.equal(declarations.length, 1, 'одна настоящая декларация fedPollOk');
  const init = declarations[0].initializer;
  assert.ok(init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'useStore',
    'fedPollOk читает подписку настоящего useStore');
  assert.equal(init.arguments.length, 1, 'один selector useStore');
  const selector = init.arguments[0];
  assert.ok(ts.isArrowFunction(selector) && !ts.isBlock(selector.body), 'selector — стрелочное выражение');
  assert.equal(selector.parameters.length, 1);
  const state = selector.parameters[0].name;
  assert.ok(ts.isIdentifier(state), 'параметр состояния selector');
  return { sf, gate, init, body: selector.body, state: state.text };
}
function fedPollContract(source = chatRaw) {
  const { sf, init } = fedPollNodes(source);
  assert.equal(compact(init, sf), 'useStore((s)=>s.conv.summaries[dm.id]?.fedPoll===true)',
    'R222-fed-selector: разрешение берётся строго из активной сводки и только для boolean true');
}
// Это узкий интерпретатор AST действующей проводки, не eval извлечённого текста и не копия бизнес-гейта.
// Неизвестный синтаксис явно останавливает тест: новый код не должен молча исполняться по старой модели.
function evaluatePollAst(node: ts.Expression, env: Record<string, unknown>): unknown {
  const n = unparen(node);
  if (ts.isIdentifier(n)) { assert.ok(Object.hasOwn(env, n.text), `известное имя AST ${n.text}`); return env[n.text]; }
  if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (n.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isStringLiteral(n)) return n.text;
  if (ts.isPropertyAccessExpression(n)) {
    const object = evaluatePollAst(n.expression, env);
    if (object == null && n.questionDotToken) return undefined;
    assert.ok(object != null, 'обычный property access имеет владельца');
    return (object as Record<string, unknown>)[n.name.text];
  }
  if (ts.isElementAccessExpression(n)) {
    const object = evaluatePollAst(n.expression, env);
    assert.ok(object != null && n.argumentExpression, 'индексируемая сводка существует');
    const key = evaluatePollAst(n.argumentExpression, env);
    assert.equal(typeof key, 'string', 'id сводки — строка');
    return (object as Record<string, unknown>)[key as string];
  }
  if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken) return !evaluatePollAst(n.operand, env);
  if (ts.isBinaryExpression(n)) {
    const left = evaluatePollAst(n.left, env);
    if (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return left && evaluatePollAst(n.right, env);
    if (n.operatorToken.kind === ts.SyntaxKind.BarBarToken) return left || evaluatePollAst(n.right, env);
    if (n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return left === evaluatePollAst(n.right, env);
    if (n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) return left !== evaluatePollAst(n.right, env);
  }
  assert.fail(`неподдерживаемое выражение опросной проводки: ${ts.SyntaxKind[n.kind]}`);
}
const fedPollCases: { label: string; summary?: { fedPoll: unknown }; peerHome: string | null; expected: boolean }[] = [
  { label: 'сосед без сводки не получает кнопку', peerHome: 'peer', expected: false },
  { label: 'сосед с fedPoll false не получает кнопку', summary: { fedPoll: false }, peerHome: 'peer', expected: false },
  { label: 'сосед с fedPoll true получает кнопку', summary: { fedPoll: true }, peerHome: 'peer', expected: true },
  { label: 'местная беседа без fedPoll по-прежнему получает кнопку', peerHome: null, expected: true },
  { label: 'сосед со строкой true вместо boolean true не получает кнопку', summary: { fedPoll: 'true' }, peerHome: 'peer', expected: false },
  { label: 'сосед с единицей вместо boolean true не получает кнопку', summary: { fedPoll: 1 }, peerHome: 'peer', expected: false },
];
function fedPollCase(index: number, source = chatRaw) {
  const { body, state, gate } = fedPollNodes(source), c = fedPollCases[index];
  // Другая беседа заведомо разрешена: чтение неактивной сводки не должно открыть кнопку текущей.
  const summaries: Record<string, unknown> = { other: { fedPoll: true } };
  if (c.summary) summaries.active = c.summary;
  const env: Record<string, unknown> = { [state]: { conv: { summaries } }, dm: { id: 'active' },
    convPollFeature: true, peerHome: c.peerHome, groupHostId: null, viaOn: false };
  env.fedPollOk = evaluatePollAst(body, env);
  assert.equal(evaluatePollAst(gate, env), c.expected, `R222-fed-case-${index}: ${c.label}`);
  // Успешное разрешение соседа не отменяет существующие запреты чужого хоста, via и выключенной фичи.
  for (const blocked of [{ groupHostId: 'remote-host' }, { viaOn: true }, { convPollFeature: false }]) {
    assert.equal(evaluatePollAst(gate, { ...env, ...blocked }), false, 'R222-fed-blockers: запреты действуют даже при fedPoll true');
  }
}
it('R219 AST mediaActions даёт Опрос только с onSendMedia и convPoll', () => actions());
it('R219 AST DmChatView допускает разрешённого соседа, но сохраняет запреты чужого хоста и через', () => featureGate());
// Строка или комментарий с правильным selector не заменяют действующую подписку активной беседы.
it('R222 AST разрешение опроса соседа подписано на fedPoll активной беседы со строгим true', () => fedPollContract());
// Парные отказы и разрешения защищают от открытия всем соседям и от исчезновения корректной кнопки.
for (let index = 0; index < fedPollCases.length; index++) it(`R222 проводка опроса: ${fedPollCases[index].label}`, () => fedPollCase(index));
// Каждый контрфакт сначала проходит на оригинальном AST и падает именно по результату разрешения кнопки.
for (const [label, to, index, actual, expected] of [
  ['постоянное true открывает опрос без сводки', 'true', 0, true, false],
  ['постоянное false скрывает разрешённый опрос соседа', 'false', 2, false, true],
  ['сводка другой беседы открывает текущую', "s.conv.summaries['other']?.fedPoll === true", 0, true, false],
  ['truthy строка ошибочно принимается за согласованный признак', '!!s.conv.summaries[dm.id]?.fedPoll', 4, true, false],
  ['проверка не false открывает опрос при отсутствующей сводке', 's.conv.summaries[dm.id]?.fedPoll !== false', 0, true, false],
] as const) it(`R222 контрфакт разрешения опроса: ${label}`, () => {
  fedPollCase(index);
  const changed = replaceOne(chatRaw, 's.conv.summaries[dm.id]?.fedPoll === true', to);
  assert.throws(() => fedPollCase(index, changed), failure(`R222-fed-case-${index}:`, actual, expected));
});
it('R219 AST контрфакт пункта Опрос без признака ловится полным MessagePane', () => {
  actions(); assert.throws(() => actions(replaceOne(paneRaw, '...(convPoll ? [{', '...(true ? [{')), failure('R219-actions:', 'true', 'convPoll'));
});
for (const field of ['peerHome', 'groupHostId', 'viaOn']) it(`R219 AST контрфакт снятого ${field} ловится проводкой DmChatView`, () => {
  featureGate();
  const removed = field === 'peerHome' ? ' && (!peerHome || fedPollOk)' : ` && !${field}`;
  const changed = replaceOne(chatRaw, pollGateSource, pollGateSource.replace(removed, ''));
  const actual = pollGateSource.replace(removed, '').replace(/\s/g, '');
  assert.throws(() => featureGate(changed), failure('R219-fed-gate:', actual, pollGateContract));
});
function declaration(css: string, selector: string, property: string) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const matches = [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(match => match[1].split(',').map(s => s.trim()).includes(selector));
  for (const match of matches.reverse()) {
    const values = [...match[2].matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].filter(m => m[1] === property);
    if (values.length) return values.at(-1)![2].trim();
  }
  return '';
}
function styles(css = cssRaw) {
  for (const [selector, property, value] of [
    ['.poll-opt', 'display', 'grid'], ['.poll-opt', 'grid-template-columns', '18px 1fr auto'], ['.poll-opt', 'overflow', 'hidden'],
    ['.poll-bar', 'position', 'absolute'], ['.poll-bar', 'pointer-events', 'none'], ['.poll-bar', 'background', 'var(--accent-soft)'],
    ['.poll-text', 'position', 'relative'], ['.poll-pct', 'font-variant-numeric', 'tabular-nums'],
    ['.conv-poll-kind', 'font-size', '12px'], ['.conv-poll-dot', 'width', '16px'], ['.conv-poll-dot', 'height', '16px'],
    ['.conv-poll-dot.square', 'border-radius', 'var(--r-1)'], ['.conv-poll-dot.on', 'background', 'var(--accent)'],
    ['.poll-opt.right', 'border-color', 'var(--green)'], ['.poll-opt.wrong', 'border-color', 'var(--danger)'],
    ['.poll-opt.wrong .poll-bar', 'background', 'var(--danger-soft)'], ['.conv-poll-solution', 'gap', 'var(--sp-2)'],
  ]) assert.equal(declaration(css, selector, property), value, `R219-css:${selector}:${property}: шкалы, слой и семантические цвета сохраняются`);
}
it('R219 CSS страж шкал опроса сохраняет слой, числовые колонки и цвета викторины', () => styles());
for (const [label, from, to, prefix, actual, expected] of [
  ['полоса перехватывает нажатия', 'transition: width var(--t-slow) ease;\n  pointer-events: none;', 'transition: width var(--t-slow) ease;\n  pointer-events: auto;',
    'R219-css:.poll-bar:pointer-events:', 'auto', 'none'],
  ['ошибка викторины рисует цвет успеха', '.poll-opt.wrong .poll-bar {\n  background: var(--danger-soft);', '.poll-opt.wrong .poll-bar {\n  background: var(--green);',
    'R219-css:.poll-opt.wrong .poll-bar:background:', 'var(--green)', 'var(--danger-soft)'],
] as const) it(`R219 CSS контрфакт: ${label}`, () => { styles(); assert.throws(() => styles(replaceOne(cssRaw, from, to)), failure(prefix, actual, expected)); });
