import assert from 'node:assert/strict';
import { it } from 'node:test';
import { act } from 'react';
import { setupHarness } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url);
type Pane = typeof h.Pane;

function replaceOne(source: string, from: string, to: string) {
  assert.equal(source.split(from).length - 1, 1, 'контрфакт меняет одно место полного компонента');
  return source.replace(from, to);
}

type ReplyCase = 'closed' | 'unfocused' | 'keyboard' | 'panel' | 'desktop';
async function reply(component: Pane, scenario: ReplyCase) {
  const restoreLayout = h.pointerLayout(scenario !== 'desktop', scenario === 'desktop' ? 1200 : 390);
  const oldHit = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
  const calls: string[] = [];
  try {
    localStorage.setItem('gv_dbl_action', 'reply');
    await h.mount({ messages: [h.msg('reply-target', 'peer')] }, component);
    const field = h.host.querySelector<HTMLTextAreaElement>('.composer-input');
    const row = h.host.querySelector<HTMLElement>('[data-mid="reply-target"] .message-main');
    assert.ok(field, 'настоящий composer имеет поле');
    assert.ok(row, 'сообщение имеет поверхность двойного клика');
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => row });
    if (scenario === 'panel') {
      const emoji = h.host.querySelector<HTMLButtonElement>('.att-btn.emoji');
      assert.ok(emoji, 'кнопка панели существует');
      await act(async () => { emoji.click(); });
      assert.equal(!!h.host.querySelector('.expr-under'), true, 'открыта настоящая телефонная панель');
    }
    if (scenario === 'keyboard') document.documentElement.setAttribute('data-kbspace', '');
    await act(async () => { if (scenario === 'unfocused') field.blur(); else field.focus(); });
    assert.equal(document.activeElement === field, scenario !== 'unfocused', 'предусловие фокуса проверено до ответа');
    const focus = field.focus.bind(field);
    const blur = field.blur.bind(field);
    field.focus = (...args) => { calls.push('focus'); focus(...args); };
    field.blur = () => { calls.push('blur'); blur(); };
    await act(async () => {
      for (const type of ['mousedown', 'dblclick']) row.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, detail: 2, clientX: 100, clientY: 100,
      }));
    });
    assert.equal(!!h.host.querySelector('.reply-strip'), true, 'действие действительно начинает ответ');
    assert.equal(calls.join(','), scenario === 'closed' ? 'blur,focus' : 'focus', 'B8: только закрытая клавиатура телефона требует blur перед focus');
    assert.equal(document.activeElement === field, true, 'ответ оставляет поле в фокусе');
  } finally {
    h.unmount();
    document.documentElement.removeAttribute('data-kbspace');
    localStorage.removeItem('gv_dbl_action');
    if (oldHit) Object.defineProperty(document, 'elementFromPoint', oldHit); else Reflect.deleteProperty(document, 'elementFromPoint');
    restoreLayout();
  }
}

for (const [scenario, label] of [
  ['closed', 'телефон с фокусом и убранной клавиатурой снимает и возвращает фокус'],
  ['unfocused', 'неактивное поле получает фокус без лишнего blur'],
  ['keyboard', 'видимая клавиатура не мигает при ответе'],
  ['panel', 'открытая панель эмодзи не требует blur поля при ответе'],
  ['desktop', 'компьютер сохраняет обычный focus без blur'],
] as const) it(`B8: ${label}`, () => reply(h.Pane, scenario));

for (const [name, from, to, scenario] of [
  ['теряет повторное открытие клавиатуры', '      field.blur();\n    field?.focus();', '      /* mutant: нет blur */\n    field?.focus();', 'closed'],
  ['снимает фокус и у неактивного поля', '      document.activeElement === field &&\n', '', 'unfocused'],
  ['снимает фокус при видимой клавиатуре', "      !document.documentElement.hasAttribute('data-kbspace')", '      true', 'keyboard'],
  ['снимает фокус под панелью эмодзи', '      !exprUnderRef.current &&\n', '', 'panel'],
  ['снимает фокус на компьютере', '      field &&\n      phoneTaps() &&', '      field &&', 'desktop'],
] as const) h.mutantTest(`B8-контрфакт ${name}`, () => h.rejectMutant(
  source => replaceOne(source, from, to), component => reply(component, scenario),
  'B8: только закрытая клавиатура телефона требует blur перед focus',
));

type ResizeCase = {
  phone?: boolean; event?: 'window' | 'visual' | 'none'; age?: number; perturb?: boolean; pinned?: boolean;
};
async function resize(component: Pane, options: ResizeCase = {}) {
  const { phone = true, event = 'window', age = 399, perturb = false, pinned = false } = options;
  const restoreLayout = h.pointerLayout(phone, phone ? 390 : 1200);
  const saved: { target: object; key: string; descriptor: PropertyDescriptor | undefined }[] = [];
  const patch = (target: object, key: string, descriptor: PropertyDescriptor) => {
    saved.push({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) });
    Object.defineProperty(target, key, { configurable: true, ...descriptor });
  };
  let height = 600;
  let clock = 1000;
  const visual = new EventTarget();
  const observers: Observer[] = [];
  class Observer {
    targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) { observers.push(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }
  const oldHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  patch(HTMLElement.prototype, 'clientHeight', { get() {
    return (this as HTMLElement).classList.contains('messages') ? height : oldHeight?.get?.call(this) ?? 0;
  } });
  patch(globalThis, 'ResizeObserver', { value: Observer });
  patch(window, 'ResizeObserver', { value: Observer });
  patch(window, 'visualViewport', { value: visual });
  patch(performance, 'now', { value: () => clock });
  try {
    await h.mount({ messages: [h.msg('viewport-target', 'peer')] }, component);
    const list = h.host.querySelector<HTMLElement>('.messages');
    assert.ok(list, 'реальная лента смонтирована');
    assert.equal(observers.some(observer => observer.targets.has(list)), true, 'эффект наблюдает саму ленту');
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 2000 });
    list.scrollTop = pinned ? 1400 : 1030;
    await act(async () => { list.dispatchEvent(new Event('scroll')); });
    const originalTop = list.scrollTop;
    assert.equal(originalTop, pinned ? 1400 : 1030, 'до изменения высоты сохранена исходная прокрутка');
    const distance = 2000 - originalTop - height;
    if (event === 'window') window.dispatchEvent(new Event('resize'));
    if (event === 'visual') visual.dispatchEvent(new Event('resize'));
    clock += age;
    // Имитируем уже ограниченный браузером scrollTop БЕЗ события scroll:
    // эффект обязан брать сохранённый lastTop, а не это промежуточное значение.
    if (perturb) list.scrollTop = 500;
    const fire = async () => act(async () => {
      for (const observer of observers) if (observer.targets.has(list)) observer.callback([], observer as unknown as ResizeObserver);
    });
    const anchored = phone && event !== 'none' && age < 400;
    height = 400;
    await fire();
    const expectedShrink = anchored || pinned ? originalTop + 200 : originalTop;
    assert.equal(list.scrollTop, expectedShrink, 'B9: сжатие использует сохранённый якорь только в разрешённом окне');
    if (anchored) assert.equal(2000 - list.scrollTop - height, distance, 'расстояние D выше низа сохранилось при сжатии');
    await fire();
    assert.equal(list.scrollTop, expectedShrink, 'повтор наблюдения без изменения высоты не сдвигает ленту');
    height = 700;
    await fire();
    assert.equal(list.scrollTop, anchored ? originalTop - 100 : expectedShrink, 'B9: обратный рост возвращает якорь только на телефоне в окне');
    if (anchored) assert.equal(2000 - list.scrollTop - height, distance, 'расстояние D выше низа сохранилось при росте');
  } finally {
    h.unmount();
    for (const { target, key, descriptor } of saved.reverse()) {
      if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key);
    }
    restoreLayout();
  }
}

for (const [label, options] of [
  ['resize окна сохраняет D выше низа в обе стороны', {}],
  ['resize visualViewport сохраняет тот же якорь', { event: 'visual' }],
  ['промежуточный scrollTop не заменяет lastTop', { perturb: true }],
  ['ровно 400 мс уже вне окна привязки', { age: 400 }],
  ['401 мс не привязывает ленту выше низа', { age: 401 }],
  ['изменение без resize оставляет прокрутку выше низа', { event: 'none' }],
  ['ПК после resize сохраняет старое поведение выше низа', { phone: false }],
  ['ПК прижатый к низу компенсирует только сжатие', { phone: false, pinned: true }],
  ['телефон без resize прижатый к низу сохраняет старое поведение', { event: 'none', pinned: true }],
] as const) it(`B9: ${label}`, () => resize(h.Pane, options));

for (const [name, from, to, options] of [
  ['убирает окно 400 мс', 'performance.now() - vpAt < VIEWPORT_ANCHOR_MS && phoneTaps()', 'phoneTaps()', { age: 400 }],
  ['включает границу 400 мс', 'performance.now() - vpAt < VIEWPORT_ANCHOR_MS && phoneTaps()', 'performance.now() - vpAt <= VIEWPORT_ANCHOR_MS && phoneTaps()', { age: 400 }],
  ['берёт текущую прокрутку вместо lastTop', '      const top = lastTop;', '      const top = el.scrollTop;', { perturb: true }],
  ['привязывает компьютер как телефон', 'performance.now() - vpAt < VIEWPORT_ANCHOR_MS && phoneTaps()', 'performance.now() - vpAt < VIEWPORT_ANCHOR_MS', { phone: false }],
  ['теряет resize visualViewport', "    window.visualViewport?.addEventListener('resize', onViewport);\n    return () => {\n      ro.disconnect();\n      el.removeEventListener('scroll', onScroll);", "    /* mutant: нет подписки visualViewport */\n    return () => {\n      ro.disconnect();\n      el.removeEventListener('scroll', onScroll);", { event: 'visual' }],
] as const) h.mutantTest(`B9-контрфакт ${name}`, () => h.rejectMutant(
  source => replaceOne(source, from, to), component => resize(component, options),
  'B9: сжатие использует сохранённый якорь только в разрешённом окне',
));
