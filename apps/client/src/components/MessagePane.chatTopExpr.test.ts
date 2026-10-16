import assert from 'node:assert/strict';
import { it } from 'node:test';
import { act, createElement } from 'react';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { setupHarness, type Props } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url);
const watchdogSet = globalThis.setTimeout;
const watchdogClear = globalThis.clearTimeout;
async function bounded<T>(label: string, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = watchdogSet(() => reject(new Error(`R146: таймаут ${label}`)), 10000);
    })]);
  } finally { if (timer !== undefined) watchdogClear(timer); }
}
type Pane = typeof h.Pane;
type Runtime = typeof h.server;
async function fixture(phone: boolean, check: (pane: Pane, runtime: Runtime) => Promise<void>, change?: (s: string) => string) {
  const restore = h.pointerLayout(phone, phone ? 390 : 1000);
  const runtime = await bounded('создание Vite', () => h.paneServer(change, 'MessagePane', true));
  try {
    const { MessagePane } = await bounded('импорт MessagePane', () => runtime.ssrLoadModule('/src/components/MessagePane.tsx'));
    await bounded('сценарий', () => check(MessagePane, runtime));
  } finally {
    h.unmount();
    document.documentElement.removeAttribute('data-kb');
    restore();
    await bounded('закрытие Vite', () => runtime.close());
  }
}
function emoji() {
  const button = h.host.querySelector<HTMLButtonElement>('.att-btn.emoji');
  assert.ok(button, 'кнопка эмодзи существует');
  return button;
}
function field() {
  const input = h.host.querySelector<HTMLTextAreaElement>('textarea');
  assert.ok(input, 'поле ввода существует');
  return input;
}
async function open(pane: Pane, props: Partial<Props> = {}) {
  await h.mount(props, pane);
  await act(async () => { field().focus(); });
  await act(async () => { emoji().click(); });
}
function panel() { return h.host.querySelector('.expr-under'); }

it('телефон: шапка и капсула полос находятся в одном верхнем слое', async () => fixture(true, async pane => {
  await h.mount({ topBar: createElement('div', { className: 'stranger-fixture' }, 'Незнакомец') }, pane);
  const top = h.host.querySelector('.chat-top');
  assert.ok(top);
  assert.ok(top.querySelector(':scope > .channel-topbar'));
  assert.ok(top.querySelector(':scope > .top-capsule > .stranger-fixture'));
  assert.equal(!!h.host.querySelector('.messages')?.closest('.chat-top'), false);
}));

async function measure(pane: Pane, phone: boolean) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  const original = globalThis.ResizeObserver;
  let height = 86;
  const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
  class Observer {
    targets = new Set<Element>();
    constructor(public callback: ResizeObserverCallback) { observers.push(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() {
    return (this as HTMLElement).classList.contains('chat-top') ? height : descriptor?.get?.call(this) ?? 0;
  } });
  globalThis.ResizeObserver = Observer as unknown as typeof ResizeObserver;
  try {
    await h.mount({}, pane);
    const chat = h.host.querySelector<HTMLElement>('.chat')!;
    assert.equal(chat.style.getPropertyValue('--chat-top-h'), phone ? '86px' : '');
    if (!phone) return;
    const top = h.host.querySelector('.chat-top')!;
    const list = h.host.querySelector<HTMLElement>('.messages')!;
    list.scrollTop = 120;
    const fire = async () => act(async () => {
      for (const observer of observers) if (observer.targets.has(top)) observer.callback([], observer as unknown as ResizeObserver);
    });
    height = 116; await fire();
    assert.equal(list.scrollTop, 150, 'рост капсулы сохраняет позицию строк');
    await fire(); assert.equal(list.scrollTop, 150, 'повтор той же высоты не сдвигает строки');
    height = 70; await fire();
    assert.equal(list.scrollTop, 104, 'сжатие капсулы сдвигает строки обратно');
  } finally {
    h.unmount();
    globalThis.ResizeObserver = original;
    if (descriptor) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
  }
}
it('телефон: измеренная высота верха и обе дельты сохраняют прокрутку', async () => fixture(true, pane => measure(pane, true)));
it('ПК: высота верхнего слоя не попадает в переменную телефона', async () => fixture(false, pane => measure(pane, false)));

async function phonePanel(pane: Pane) {
  await open(pane);
  assert.ok(panel(), 'телефон открывает панель под полем');
  assert.equal(!!h.host.querySelector('.emoji-backdrop'), false);
  assert.equal(document.activeElement === field(), false, 'открытие панели убирает фокус клавиатуры');
  assert.equal(emoji().title, 'Клавиатура');
}
async function pcPanel(pane: Pane) {
  await open(pane);
  assert.equal(!!panel(), false, 'ПК не получает телефонную панель');
  assert.ok(document.querySelector('.emoji-backdrop'), 'ПК открывает прежнее окно');
  assert.notEqual(emoji().title, 'Клавиатура');
}
it('телефон: смайлик становится клавиатурой, панель без оконной подложки', async () => fixture(true, phonePanel));
it('ПК: смайлик сохраняет прежнее всплывающее окно', async () => fixture(false, pcPanel));

async function focusDelay(pane: Pane, byButton = false) {
  await open(pane);
  assert.ok(panel());
  const originalSet = window.setTimeout;
  const originalClear = globalThis.clearTimeout;
  let fallback: (() => void) | undefined;
  const id = 123456789;
  window.setTimeout = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (ms === 600) { assert.equal(typeof callback, 'function'); fallback = () => (callback as Function)(...args); return id; }
    return (originalSet as Function).call(window, callback, ms, ...args);
  }) as typeof window.setTimeout;
  globalThis.clearTimeout = ((timer: unknown) => { if (timer !== id) originalClear(timer as never); }) as typeof clearTimeout;
  try {
    await act(async () => { if (byButton) emoji().click(); else field().focus(); });
    assert.ok(panel(), 'фокус не закрывает панель немедленно');
    assert.equal(document.activeElement === field(), true);
    assert.ok(fallback, 'ожидание клавиатуры ограничено 600 мс');
    await act(async () => { fallback!(); });
    assert.equal(!!panel(), false, '600 мс без клавиатуры закрывают панель');
    assert.notEqual(emoji().title, 'Клавиатура');
  } finally { window.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
}
it('фокус поля ждёт клавиатуру и закрывает панель запасным таймером 600 мс', async () => fixture(true, pane => focusDelay(pane)));
it('кнопка клавиатуры фокусирует поле, но не закрывает панель раньше времени', async () => fixture(true, pane => focusDelay(pane, true)));
it('признак data-kb закрывает панель после фокуса, не дожидаясь запаса', async () => fixture(true, async pane => {
  await open(pane);
  await act(async () => { field().focus(); });
  assert.ok(panel());
  await act(async () => { document.documentElement.setAttribute('data-kb', ''); await h.delay(); });
  assert.equal(!!panel(), false);
}));

async function escapePanel(pane: Pane) {
  let closed = 0;
  await open(pane, { onEscapeClose: () => { closed++; } });
  // Глобальный shortcut проходит window capture → document → window bubble,
  // но не React input-polyfill на textarea, уже размонтируемой обработчиком Esc.
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  assert.equal(!!panel(), false);
  assert.equal(closed, 0, 'Esc панели не закрывает беседу');
}
it('Esc закрывает только панель и не доходит до выхода из беседы', async () => fixture(true, escapePanel));
async function reopenedPanel(pane: Pane) {
  await open(pane);
  assert.equal(document.documentElement.hasAttribute('data-kb'), false, 'проверяем запасной таймер без экранной клавиатуры');
  const savedSet = window.setTimeout;
  const savedClear = globalThis.clearTimeout;
  const savedWindowClear = window.clearTimeout;
  let now = 0;
  let next = -147000;
  let scheduled = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  window.setTimeout = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (ms !== 600) return (savedSet as Function).call(window, callback, ms, ...args);
    assert.equal(typeof callback, 'function');
    const id = next--; scheduled++;
    timers.set(id, { at: now + 600, run: () => (callback as Function)(...args) });
    return id;
  }) as typeof window.setTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    if (typeof id === 'number' && id <= -147000) { timers.delete(id); return; }
    savedClear(id as never);
  }) as typeof clearTimeout;
  window.clearTimeout = ((id: unknown) => {
    if (typeof id === 'number' && id <= -147000) { timers.delete(id); return; }
    savedWindowClear.call(window, id as never);
  }) as typeof window.clearTimeout;
  const advance = async (ms: number) => {
    now += ms;
    await act(async () => {
      for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.run();
    });
  };
  try {
    await act(async () => { field().focus(); });
    assert.equal(scheduled, 1, 'фокус действительно запустил ожидание 600 мс');
    assert.equal(!!panel(), true, 'ожидание клавиатуры не закрывает панель сразу');
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(!!panel(), false, 'Esc закрыл первую панель');
    await act(async () => { emoji().click(); });
    assert.equal(!!panel(), true, 'до истечения старого таймера открыта новая панель');
    await advance(599);
    assert.equal(!!panel(), true, 'новая панель остаётся открытой до старого срока');
    await advance(1);
    assert.equal(!!panel(), true, 'старый таймер не закрывает заново открытую панель');
  } finally {
    h.unmount();
    window.setTimeout = savedSet;
    globalThis.clearTimeout = savedClear;
    window.clearTimeout = savedWindowClear;
  }
}
it('R147 Esc отменяет ожидание клавиатуры: новая панель переживает старые 600 мс', async () => fixture(true, reopenedPanel));
it('назад зарегистрирована для панели и снимается после её закрытия', async () => fixture(true, async (pane, runtime) => {
  await open(pane);
  const back = await runtime.ssrLoadModule('/src/androidBack.ts') as typeof import('../androidBack');
  const store = await runtime.ssrLoadModule('/src/store.ts') as typeof import('../store');
  const previous = store.useStore.getState().mobilePane;
  store.useStore.setState({ mobilePane: 'content' });
  try {
    assert.equal(back.backLeavesPane(), false);
    await act(async () => { assert.equal(back.stepBack(), true); });
    assert.equal(!!panel(), false);
    assert.equal(store.useStore.getState().mobilePane, 'content');
    assert.equal(back.backLeavesPane(), true, 'закрытая панель больше не удерживает назад');
  } finally { store.useStore.setState({ mobilePane: previous }); }
}));

function replaceOnce(source: string, from: string, to: string) {
  assert.equal(source.split(from).length - 1, 1, 'мутация имеет одну точную цель');
  return source.replace(from, to);
}
const source = readFileSync(new URL('./MessagePane.tsx', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
function syntaxContract(text: string) {
  const file = ts.createSourceFile('MessagePane.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const nodes: ts.Node[] = [];
  function visit(node: ts.Node) { nodes.push(node); ts.forEachChild(node, visit); }
  visit(file);
  const top = nodes.find((node): node is ts.JsxElement => ts.isJsxElement(node) && node.openingElement.attributes.properties.some(attr =>
    ts.isJsxAttribute(attr) && attr.name.getText(file) === 'className' && attr.initializer?.getText(file) === '"chat-top"'));
  assert.ok(top, 'верхний слой присутствует');
  const headers: ts.Node[] = [];
  function inTop(node: ts.Node) { headers.push(node); ts.forEachChild(node, inTop); }
  top.children.forEach(inTop);
  for (const name of ['"channel-topbar sel-head"', '"channel-topbar"']) assert.ok(headers.some(node =>
    ts.isJsxAttribute(node) && node.name.getText(file) === 'className' && node.initializer?.getText(file) === name), `${name} внутри верхнего слоя`);
  assert.ok(headers.some(node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === 'ChatSearchHead'), 'поисковая шапка внутри верхнего слоя');
  const capsule = nodes.find((node): node is ts.JsxElement => ts.isJsxElement(node) && node.openingElement.attributes.properties.some(attr =>
    ts.isJsxAttribute(attr) && attr.name.getText(file) === 'className' && attr.initializer?.getText(file) === '"top-capsule"'));
  assert.ok(capsule, 'капсула присутствует');
  const children = capsule.children;
  assert.ok(children.some(node => ts.isJsxExpression(node) && node.expression?.getText(file) === 'topBar'), 'полоса незнакомца внутри капсулы');
  const nested: ts.Node[] = [];
  function inside(node: ts.Node) { nested.push(node); ts.forEachChild(node, inside); }
  children.forEach(inside);
  for (const tag of ['VoiceTopBar', 'PinnedBar']) assert.ok(nested.some(node =>
    (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(file) === tag), `${tag} внутри капсулы`);
  const scroll = nodes.find(node => ts.isExpressionStatement(node) && node.getText(file) === 'list.scrollTop += d;');
  assert.ok(scroll, 'компенсация высоты существует');
  assert.ok(ts.isIfStatement(scroll.parent), 'компенсация под условием');
  assert.ok(scroll.parent.expression.getText(file).includes('!pendingScroll.current'), 'pendingScroll исключён из компенсации');
  assert.ok(nodes.some(node => ts.isJsxAttribute(node) && node.name.getText(file) === 'name' &&
    node.initializer?.getText(file) === "{exprUnder ? 'keyboard' : 'reaction'}"), 'иконка меняется между клавиатурой и смайликом');
  const height = nodes.find((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && node.name.getText(file) === 'exprUnderH');
  assert.ok(height?.initializer?.getText(file).includes('Math.round(rememberedKeyboardHeight() / rootZoom())'), 'высота панели учитывает запомненную клавиатуру и zoom');
}
it('AST дополнение: все три полосы внутри капсулы, pendingScroll исключён; четыре контрфакта отвергнуты', () => {
  syntaxContract(source);
  const changes = [
    [' && !pendingScroll.current', '', 'pendingScroll исключён'],
    ['      {topBar}', '', 'полоса незнакомца внутри'],
    ['<VoiceTopBar feedId={feedId}', '<div feedId={feedId}', 'VoiceTopBar внутри'],
  ];
  for (const [from, to, expected] of changes) assert.throws(() => syntaxContract(replaceOnce(source, from, to)),
    error => error instanceof assert.AssertionError && error.message.includes(expected));
  const withoutPinned = replaceOnce(replaceOnce(source, '<PinnedBar\n', '<div\n'), '</PinnedBar>', '</div>');
  assert.throws(() => syntaxContract(withoutPinned), error => error instanceof assert.AssertionError && error.message.includes('PinnedBar внутри'));
});
it('AST дополнение: иконка и высота панели не теряют переключение и масштаб', () => {
  syntaxContract(source);
  for (const [from, to, expected] of [
    ["name={exprUnder ? 'keyboard' : 'reaction'}", "name={'reaction'}", 'иконка меняется'],
    ['rememberedKeyboardHeight() / rootZoom()', 'rememberedKeyboardHeight()', 'высота панели учитывает'],
  ]) assert.throws(() => syntaxContract(replaceOnce(source, from, to)),
    error => error instanceof assert.AssertionError && error.message.includes(expected));
});
const mutants = [
  { name: 'без stopPropagation Esc панели закрывает также беседу', phone: true, from: "if (e.key !== 'Escape' || document.querySelector(TOP_LAYERS)) return;\n      e.stopPropagation();\n      close();", to: "if (e.key !== 'Escape' || document.querySelector(TOP_LAYERS)) return;\n      close();", check: escapePanel },
  { name: 'немедленное закрытие панели на фокусе ловится до клавиатуры', phone: true, from: 'if (root.hasAttribute(\'data-kb\')) done();\n  }', to: 'done();\n  }', check: (pane: Pane) => focusDelay(pane) },
  { name: 'панель без проверки телефона ломает прежнее окно ПК', phone: false, from: "const exprUnder = dockPhone && picker?.kind === 'composer';", to: "const exprUnder = picker?.kind === 'composer';", check: pcPanel },
  { name: 'без сдвига прокрутки изменение высоты капсулы двигает строки', phone: true, from: 'list.scrollTop += d;', to: 'list.scrollTop += 0;', check: (pane: Pane) => measure(pane, true) },
  { name: 'R147 без отмены ожидания при закрытии старый таймер закрывает новую панель', phone: true,
    from: "// Панель закрылась (чем угодно) — ожидание её закрытия больше не нужно.\n      kbFromPanelRef.current?.cancel();",
    to: '// mutant: не отменяем ожидание первой панели', check: reopenedPanel },
];
for (const mutant of mutants) h.mutantTest(mutant.name, async () => {
  const active = process.env.GUSVOICE_PANE_MUTANT === mutant.name;
  const run = () => fixture(mutant.phone, pane => mutant.check(pane), active ? source => replaceOnce(source, mutant.from, mutant.to) : undefined);
  const expected = mutant.check === escapePanel ? 'Esc панели не закрывает беседу'
    : mutant.check === pcPanel ? 'ПК не получает телефонную панель'
    : mutant.check === reopenedPanel ? 'старый таймер не закрывает заново открытую панель'
    : mutant.name.includes('немедленное') ? 'фокус не закрывает панель немедленно'
    : 'рост капсулы сохраняет позицию строк';
  if (active) await assert.rejects(run, error => error instanceof assert.AssertionError && error.message.includes(expected));
  else await run();
});
