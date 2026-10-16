import assert from 'node:assert/strict';
import { it } from 'node:test';
import { act } from 'react';
import { setupHarness, type Props } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url);
type Pane = typeof h.Pane;
type ResizeWatch = { targets: Set<Element>; callback: ResizeObserverCallback };
type MutationWatch = { target: Node | null; callback: MutationCallback };

function replaceOne(source: string, from: string, to: string) {
  assert.equal(source.split(from).length - 1, 1, 'контрфакт меняет одно место полного MessagePane');
  return source.replace(from, to);
}

/** Геометрия задаётся ДО эффектов: HappyDOM не рассчитывает layout и не ограничивает scrollTop браузерным краем. */
async function surface(component: Pane, work: (s: {
  list: HTMLElement; height: number; content: number; top: number;
  scroll(): Promise<void>; viewport(): void; resize(): Promise<void>; grow(): Promise<void>;
  insert(): Promise<void>; props: Partial<Props>;
}) => Promise<void>, props: Partial<Props> = {}) {
  const restoreLayout = h.pointerLayout(true, 390);
  const saved: Array<{ target: object; key: string; descriptor: PropertyDescriptor | undefined }> = [];
  const patch = (target: object, key: string, descriptor: PropertyDescriptor) => {
    saved.push({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) });
    Object.defineProperty(target, key, { configurable: true, ...descriptor });
  };
  let height = 600, content = 2000, top = 1400, now = 1000;
  const watches: ResizeWatch[] = [];
  const mutations: MutationWatch[] = [];
  class ResizeWatch {
    targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) { watches.push(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }
  class MutationWatch {
    target: Node | null = null;
    constructor(readonly callback: MutationCallback) { mutations.push(this); }
    observe(target: Node) { this.target = target; }
    disconnect() { this.target = null; }
    takeRecords() { return []; }
  }
  for (const [key, get] of [
    ['clientHeight', () => height], ['scrollHeight', () => content], ['scrollTop', () => top],
  ] as const) {
    const old = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key);
    patch(HTMLElement.prototype, key, {
      get() { return (this as HTMLElement).classList.contains('messages') ? get() : old?.get?.call(this) ?? 0; },
      ...(key === 'scrollTop' ? { set(value: number) {
        if ((this as HTMLElement).classList.contains('messages')) top = Math.max(0, Math.min(value, content - height));
        else old?.set?.call(this, value);
      } } : {}),
    });
  }
  patch(globalThis, 'ResizeObserver', { value: ResizeWatch });
  patch(window, 'ResizeObserver', { value: ResizeWatch });
  patch(globalThis, 'MutationObserver', { value: MutationWatch });
  patch(window, 'MutationObserver', { value: MutationWatch });
  patch(performance, 'now', { value: () => now });
  const messages = [h.msg('bottom-old', 'peer', 0, 1)];
  const mounted = { messages, ...props };
  try {
    await h.mount(mounted, component);
    const list = h.host.querySelector<HTMLElement>('.messages');
    assert.ok(list, 'настоящая лента смонтирована с заданной геометрией');
    const fire = async (target: Element) => act(async () => {
      const matching = watches.filter(watch => watch.targets.has(target));
      if (target === list) assert.ok(matching.length > 0, 'сама лента действительно наблюдается');
      for (const watch of matching) watch.callback([], watch as unknown as ResizeObserver);
    });
    const rowChild = (id: string) => {
      let element = list.querySelector<HTMLElement>(`[data-mid="${id}"]`);
      assert.ok(element, 'новая строка существует в настоящей ленте');
      while (element.parentElement !== list) {
        element = element.parentElement;
        assert.ok(element, 'строка вложена в прямого ребёнка ленты');
      }
      return element;
    };
    let contentTarget = rowChild('bottom-old');
    const s = {
      list, props: mounted,
      get height() { return height; }, set height(value: number) { height = value; },
      get content() { return content; }, set content(value: number) { content = value; },
      get top() { return top; }, set top(value: number) { list.scrollTop = value; },
      async scroll() { await act(async () => { list.dispatchEvent(new Event('scroll')); }); },
      viewport() { now += 10; window.dispatchEvent(new Event('resize')); },
      resize: () => fire(list),
      grow: () => fire(contentTarget),
      async insert() {
        const before = new Set(list.children);
        mounted.messages = [...messages, h.msg('bottom-new', 'peer', 0, 2)];
        await h.rerender(mounted, component);
        const added = [...list.children].filter(child => !before.has(child));
        assert.ok(added.length > 0, 'React действительно добавил новые дети ленты');
        const records = [{ addedNodes: added, removedNodes: [] }] as unknown as MutationRecord[];
        const matching = mutations.filter(watch => watch.target === list);
        assert.equal(matching.length, 1, 'добавленные строки наблюдает ровно один MutationObserver ленты');
        await act(async () => {
          for (const watch of matching) watch.callback(records, watch as unknown as MutationObserver);
        });
        contentTarget = rowChild('bottom-new');
      },
    };
    await s.scroll(); // Снимаем первоначальный stickWant; это уже настоящее известное положение человека.
    await work(s);
  } finally {
    h.unmount();
    for (const { target, key, descriptor } of saved.reverse()) {
      if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key);
    }
    restoreLayout();
  }
}

async function keyboard(component: Pane) {
  await surface(component, async s => {
    assert.equal(s.top, 1400, 'A: перед клавиатурой лента прижата к низу 2000−600');
    s.viewport(); s.height = 400;
    await s.resize();
    assert.equal(s.top, 1600, 'A: открытие клавиатуры сохраняет низ 2000−400');
    s.viewport(); s.height = 700; s.top = 1300;
    // Браузер уже упёр scrollTop в новый низ, а RO ещё помнит высоту 400: scroll не должен заменить lastTop.
    await s.scroll();
    await s.resize();
    assert.equal(s.top, 1300, 'A: закрытие клавиатуры после раннего scroll сохраняет низ, не вычитает высоту второй раз');
  });
}

async function keyboardAfterArrival(component: Pane) {
  await surface(component, async s => {
    s.viewport(); s.height = 400;
    await s.resize();
    assert.equal(s.top, 1600, 'A-arrival: открытая клавиатура оставляет прежнюю ленту внизу');
    // В основном A поправка 1600−300 сама равна новому низу: мутант pinned там эквивалентен оригиналу.
    // Новое сообщение вызывает stickDown до scroll, поэтому lastTop ещё 1600, а настоящий низ уже 1800.
    s.content = 2200;
    await s.insert();
    assert.equal(s.top, 1800, 'A-arrival: новое чужое сообщение при клавиатуре действительно прижалось вниз');
    s.viewport(); s.height = 700; s.top = 1500;
    await s.scroll();
    await s.resize();
    assert.equal(s.top, 1500, 'A-arrival: прижатая лента после нового сообщения выбирает реальный низ, не старый lastTop−300');
  });
}

type Growth = 'pinned' | 'away' | 'menu' | 'pending' | 'newer' | 'program';
async function growth(component: Pane, mode: Growth) {
  const fw = {
    hasOlder: false, hasNewer: mode === 'newer', loadNewer: async () => false, jumpLatest: async () => {},
    jumpTo: async () => true, unreadBelow: 0, place: null, onPlace: () => {}, readKey: null,
  };
  const props: Partial<Props> = mode === 'pending' ? {
    scrollKey: 'pending-feed', feedWindow: { ...fw, place: { messageId: 'not-loaded-yet', offset: 0 } },
  } : mode === 'newer' ? { feedWindow: fw } : {};
  await surface(component, async s => {
    if (mode === 'pinned') {
      await s.insert();
      await s.scroll();
    }
    if (mode === 'away') { s.top = 1300; await s.scroll(); }
    if (mode === 'program') s.top = 1390; // Ни scroll, ни новая оценка pinned: чужой переход должен остаться в покое.
    if (mode === 'menu') {
      const row = s.list.querySelector<HTMLElement>('[data-mid="bottom-old"]');
      assert.ok(row, 'меню открывается на настоящей строке');
      await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
      assert.ok(document.querySelector('.ctx-menu'), 'перед ростом меню действительно открыто');
    }
    const before = s.top;
    s.content = 2150;
    await s.grow();
    assert.equal(s.top, mode === 'pinned' ? 1550 : before, `B-${mode}: рост строки двигает только прижатую ленту без чужого якоря`);
    if (mode === 'menu') {
      await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      assert.equal(!!document.querySelector('.ctx-menu'), false, 'меню действительно закрыто после отложенного роста');
      assert.equal(s.top, 1550, 'B-menu: после закрытия исполняется отложенное stickAfterMenu');
    }
  }, props);
}

async function race(component: Pane) {
  await surface(component, async s => {
    s.top = 1350;
    await s.scroll(); // 50 px — nearBottom, но НЕ pinned: отсутствие stickWant нельзя замаскировать прежним pinned=true.
    await s.insert();
    assert.equal(s.top, 1400, 'C: новое чужое сообщение действительно вызывает stickDown до scroll');
    s.content = 2150;
    await s.grow();
    assert.equal(s.top, 1550, 'C: рост до scroll догоняет программный stickDown, несмотря на старый pinned=false');
    // Следующая строка подросла, пока браузер ещё доставляет scroll от прошлого прыжка на 1550.
    s.content = 2250;
    await s.scroll();
    await s.grow();
    assert.equal(s.top, 1650, 'C: задержанный scroll прежнего прыжка сохраняет pinned для следующего роста');
    s.content = 2300;
    await s.grow();
    assert.equal(s.top, 1700, 'C: после гонки дальнейший рост всё ещё держит низ');
  });
}

it('R210 A: закрытие клавиатуры не вычитает высоту повторно после браузерного раннего scroll', () => keyboard(h.Pane));
it('R210 A: новое сообщение до scroll не оставляет старый якорь после закрытия клавиатуры', () => keyboardAfterArrival(h.Pane));
for (const [mode, label] of [
  ['pinned', 'новая строка продолжает наблюдаться и удерживает точный низ'],
  ['away', '100 пикселей выше низа сохраняются после роста'],
  ['menu', 'открытое меню откладывает прилипание до закрытия'],
  ['pending', 'ожидаемое сохранённое место не перебивается ростом'],
  ['newer', 'окно с более новыми сообщениями не считается хвостом'],
  ['program', 'программный переход без scroll не перебивается ростом'],
] as const) it(`R210 B: ${label}`, () => growth(h.Pane, mode));
it('R210 C: stickDown до scroll и последующий рост сохраняют прилипание', () => race(h.Pane));

// Проверяем собственный AssertionError и его значения: ошибка импорта/realm/предусловия не является убийством мутанта.
function checked(scenario: (component: Pane) => Promise<void>, prefix: string, actual: unknown, expected: unknown) {
  return async (component: Pane) => {
    try { await scenario(component); }
    catch (error) {
      if (!process.env.GUSVOICE_PANE_MUTANT) throw error;
      assert.ok(error instanceof assert.AssertionError, 'мутант должен дойти до host AssertionError');
      assert.ok(error.message.startsWith(prefix), 'мутант должен упасть на заявленном поведении');
      assert.equal(error.operator, 'strictEqual', 'мутант должен упасть на строгом сравнении позиции');
      assert.deepEqual(error.actual, actual, 'у убийства мутанта проверено фактическое значение');
      assert.deepEqual(error.expected, expected, 'у убийства мутанта проверено ожидаемое значение');
      throw error;
    }
  };
}

for (const [label, from, to, scenario, prefix, actual, expected] of [
  ['ранний scroll переписывает lastTop при ещё неизвестной высоте',
    '      stickWant.current = null;\n      if (el.clientHeight !== h) return;\n      lastTop = el.scrollTop;',
    '      stickWant.current = null;\n      lastTop = el.scrollTop;', keyboard,
    'A: закрытие клавиатуры после раннего scroll', 1000, 1300],
  ['прижатая лента всё равно вычитает изменение высоты', 'el.scrollTop = pinned && stayed ?', 'el.scrollTop = false ?', keyboardAfterArrival,
    'A-arrival: прижатая лента после нового сообщения выбирает реальный низ', 1300, 1500],
  ['новые строки не подписываются на изменение высоты',
    'if (n instanceof Element) rows.observe(n);', 'if (n instanceof Element) { /* mutant: без наблюдения новых строк */ }',
    (component: Pane) => growth(component, 'pinned'), 'B-pinned: рост строки', 1400, 1550],
  ['рост тащит вниз человека выше низа',
    'if (!jumped && (!pinned || Math.abs(el.scrollTop - lastTop) > 1)) return;',
    'if (!jumped && (Math.abs(el.scrollTop - lastTop) > 1)) return;',
    (component: Pane) => growth(component, 'away'), 'B-away: рост строки', 1550, 1300],
  ['stickDown не запоминает ожидаемый scroll', '    stickWant.current = el.scrollTop;', '    /* mutant: stickWant не записан */', race,
    'C: рост до scroll догоняет программный stickDown', 1400, 1550],
  ['догоняющий рост не обновляет ожидаемый scroll', '      if (jumped) stickWant.current = el.scrollTop;',
    '      /* mutant: stickWant остаётся на прошлом низе */', race,
    'C: задержанный scroll прежнего прыжка сохраняет pinned', 1550, 1650],
] as const) h.mutantTest(`R210 контрфакт: ${label}`, () => h.rejectMutant(
  source => replaceOne(source, from, to), checked(scenario, prefix, actual, expected), prefix,
));
