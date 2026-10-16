import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { bubbleTimeLabel, chipFaces, copyMediaLabel, doubleTapStep, editDecision, fieldEscape, insertAtCaret, menuFootLines, pressByTouch, quickReactOp, timeTooltip } from './messagePaneRules';
import { describe, it } from 'node:test';
import * as wheelRules from './messagePaneRules';

function viaCaptionContract(api: typeof wheelRules) {
  const via = { instance: 'opaque-id', confirmed: false };
  const names = { self: '  Дом  ', peer: '  Сосед  ' };
  assert.equal(api.viaCaption(via, true, names), 'через «Сосед», не подтверждено', 'свой обход назван инстансом собеседника');
  assert.equal(api.viaCaption(via, false, names), 'через «Дом», не подтверждено', 'чужой обход назван нашим инстансом');
  for (const mine of [false, true]) {
    assert.equal(api.viaCaption(undefined, mine, names), null);
    assert.equal(api.viaCaption({ ...via, confirmed: true }, mine, names), null, 'подтверждённое сообщение без подписи');
    for (const missing of [undefined, null, {}, { self: '  ', peer: '' }]) assert.equal(api.viaCaption(via, mine, missing), 'через «другой инстанс», не подтверждено');
  }
  assert.equal(api.bubbleTimeLabel('12:00', { createdAt: '2026-10-12T09:00:00Z' }, api.viaCaption(via, true, names)), '12:00 · через «Сосед», не подтверждено');
}
it('R200 viaCaption различает свой и чужой обход, исчезает после подтверждения и не печатает служебный id', () => viaCaptionContract(wheelRules));
for (const [name, anchor, replacement, target] of [
  ['перепутаны дома', 'mine ? names?.peer : names?.self', 'mine ? names?.self : names?.peer', 'свой обход назван'],
  ['подтверждение игнорируется', 'if (!via || via.confirmed) return null;', 'if (!via) return null;', 'подтверждённое сообщение без подписи'],
] as const) it(`R200 мутант подписи «${name}» ловится тем же whole-module контрактом`, () => {
  const source = readFileSync(new URL('./messagePaneRules.ts', import.meta.url), 'utf8');
  assert.equal(source.split(anchor).length - 1, 1, 'единственный якорь подписи обхода');
  viaCaptionContract(wheelRules); viaCaptionContract(mutatedPaneRules(anchor, anchor));
  assert.throws(() => viaCaptionContract(mutatedPaneRules(anchor, replacement)),
    e => e instanceof assert.AssertionError && e.message.includes(target));
});

it('канал показывает аватарки только при полной сумме до трёх, ЛС проверяет каждый чип отдельно', () => {
  // Порог относится ко всему сообщению: две группы по два человека не должны смешивать лица и числа.
  const make = (emoji: string, count: number) => ({ emoji, count, reactors: Array.from({ length: count }, (_, i) => ({ userId: `${emoji}${i}` })) });
  const check = (api: typeof wheelRules) => {
    assert.equal(api.messageChipFaces([make('a', 1), make('b', 2)], false).size, 2);
    assert.equal(api.messageChipFaces([make('a', 2), make('b', 2)], false).size, 0);
    assert.equal(api.messageChipFaces([make('a', 1), { emoji: 'b', count: 1 }], false).size, 0);
    assert.equal(api.messageChipFaces([make('a', 3), { emoji: 'b', count: 1 }], true).size, 1);
    assert.equal(api.messageChipFaces([make('a', 4)], true).size, 0);
    assert.equal(api.messageChipFaces([{ ...make('a', 1), count: 2 }], true).size, 0);
    assert.equal(api.messageChipFaces(null, false).size, 0);
  };
  check(wheelRules);
  assert.throws(() => check(mutatedPaneRules('sum > CHIP_FACES_MAX', 'sum > 4')), assert.AssertionError);
  assert.throws(() => check(mutatedPaneRules('sum += r.count;', 'sum = r.count;')), assert.AssertionError);
});
it('реакции сортируются по числу и первому времени, ничья стабильна и вход не меняется', () => {
  // События реакций не должны переставлять равные чипы или мутировать объект сообщения в кеше.
  const check = (api: typeof wheelRules) => {
    const a = { count: 1, reactors: [{ at: '2026-10-08T02:00:00Z' }] };
    const b = { count: 1, reactors: [{ at: '2026-10-08T01:00:00Z' }] };
    const c = { count: 2, reactors: [{ at: '2026-10-08T03:00:00Z' }] };
    const list = [a, b, c];
    assert.deepEqual(Array.from(api.sortReactionChips(list)), [c, b, a]);
    assert.deepEqual(list, [a, b, c]);
    assert.deepEqual(Array.from(api.sortReactionChips([a, { count: 1 }])), [a, { count: 1 }]);
    assert.deepEqual(Array.from(api.sortReactionChips([a, { ...a }])), [a, { ...a }]);
    assert.equal(api.sortReactionChips(undefined).length, 0);
  };
  check(wheelRules);
  assert.throws(() => check(mutatedPaneRules('b.r.count - a.r.count', 'a.r.count - b.r.count')), assert.AssertionError);
});

it('битая дата отправки не роняет меню, а корректные дополнительные даты остаются самостоятельными', () => {
  // Регрессия R12: sentAtLabel на invalid/пустом createdAt раньше бросал RangeError.
  for (const createdAt of ['', 'invalid']) {
    assert.deepEqual(menuFootLines({ createdAt }), []);
    assert.equal(timeTooltip({ createdAt }), '');
    assert.equal(menuFootLines({ createdAt, editedAt: '2026-10-07T12:00:00Z' }).length, 1);
  }
  assert.equal(menuFootLines({ createdAt: '2026-10-07T12:00:00Z' }).length, 1);
  assert.throws(() => mutatedPaneRules('validIso(m.createdAt) ? [sentAtLabel(m.createdAt, now)] : []', '[sentAtLabel(m.createdAt, now)]').menuFootLines({ createdAt: '' }), { name: 'RangeError' });
});

it('тачпад отвечает только при явной горизонтали влево, колесо и Shift остаются браузеру', () => {
  // R23 заменяет прежний двусторонний жест: вправо браузер может выполнять «Назад».
  const check = (api: typeof wheelRules) => {
    for (const [x, y, result] of [[2, 2, 'wait'], [2, 40, 'other'], [25, 20, 'other'], [30, 10, 'swipe'], [-30, 10, 'other'], [3, 2, 'other'], [3, 1, 'swipe']] as const)
      assert.equal(api.wheelBurstIntent(x, y, 0, false), result);
    for (const mode of [1, 2]) assert.equal(api.wheelBurstIntent(30, 0, mode, false), 'other');
    assert.equal(api.wheelBurstIntent(30, 0, 0, true), 'other');
  };
  check(wheelRules);
  for (const [a, b] of [['dx > 0 && ', ''], ['ay * 1.5', 'ay'], ['deltaMode !== 0 || shift', 'false'], ['ax < 3 && ay < 3', 'ax < 10 && ay < 10']])
    assert.throws(() => check(mutatedPaneRules(a, b)), assert.AssertionError);
});

it('R190 пузырь сохраняет ЧЧ:ММ отправки и помечает позднюю доставку только при deliveredAt', () => {
  // Класс ошибки: время прихода подменяет время отправки или обычное сообщение получает ложную пометку опоздания.
  const createdAt = '2026-10-12T10:00:00.000Z';
  const deliveredAt = '2026-10-12T10:07:00.000Z';
  assert.equal(bubbleTimeLabel('13:00', { createdAt }), '13:00');
  assert.equal(bubbleTimeLabel('13:00', { createdAt, deliveredAt }), 'отправлено в 13:00, доставлено позже');
  assert.equal(bubbleTimeLabel('13:00', { createdAt, deliveredAt: 'invalid' }), '13:00');
  const tooltip = timeTooltip({ createdAt, deliveredAt });
  assert.equal(tooltip.split('\n').length, 2);
  assert.match(tooltip.split('\n')[1]!, /^Доставлено:/);
  assert.equal(timeTooltip({ createdAt }).split('\n').length, 1);
});

it('путь свайпа растёт только влево, возврат уменьшает до нуля и большой шаг обрезается', () => {
  // Событие вправо не взводит ответ, а возврат не может увести пузырь за исходное положение.
  const check = (api: typeof wheelRules) => {
    const tuple = (p: number, d: 0 | 1 | -1, x: number) => { const r = api.wheelSwipePull(p, d, x); return [r.pull, r.dir]; };
    assert.deepEqual(tuple(0, 0, -30), [0, 0]);
    assert.deepEqual(tuple(0, 0, 0), [0, 0]);
    assert.deepEqual(tuple(0, 0, 5), [5, 1]);
    assert.deepEqual(tuple(5, 1, 100), [53, 1]);
    assert.deepEqual(tuple(53, 1, -100), [5, 1]);
    assert.deepEqual(tuple(5, 1, -10), [0, 1]);
  };
  check(wheelRules);
  for (const [a, b] of [['dx > 0 ? 1 : 0', 'dx < 0 ? -1 : dx > 0 ? 1 : 0'], ['Math.max(0, pull + step)', 'pull + step'], ['const step = Math.max(-WHEEL_SWIPE_STEP_MAX, Math.min(WHEEL_SWIPE_STEP_MAX, dx));', 'const step = dx;']])
    assert.throws(() => check(mutatedPaneRules(a, b)), assert.AssertionError);
});

it('ответ отпускается после трёх затухающих событий лишь взведённым и с мелким хвостом', () => {
  // Инерцию нельзя принять за завершённый жест до достижения порога ответа.
  const check = (api: typeof wheelRules) => {
    assert.equal(api.wheelDecayRun(2, -30, 20), 3);
    assert.equal(api.wheelDecayRun(2, 20, -20), 0);
    assert.equal(api.wheelDecayRun(2, 20, 21), 0);
    assert.equal(api.wheelReleased(true, 3, 20), true);
    assert.equal(api.wheelReleased(true, 3, -20), true);
    assert.equal(api.wheelReleased(true, 2, 20), false);
    assert.equal(api.wheelReleased(false, 3, 20), false);
    assert.equal(api.wheelReleased(true, 3, 21), false);
    assert.equal(api.wheelReleased(true, 3, 25), false);
  };
  check(wheelRules);
  for (const [a, b] of [['decayRun >= WHEEL_SWIPE_DECAY_EVENTS', 'decayRun > WHEEL_SWIPE_DECAY_EVENTS'], ['armed && decayRun', 'decayRun'], ['Math.abs(dx) <= WHEEL_SWIPE_TAIL_PX', 'true']])
    assert.throws(() => check(mutatedPaneRules(a, b)), assert.AssertionError);
});

function mutatedPaneRules(from: string, to: string) {
  let source = readFileSync(new URL('./messagePaneRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(source.includes(from), `реальный messagePaneRules содержит фрагмент мутации: ${from}`);
  source = source.replace(from, to);
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  runInNewContext(output, { module: mod, exports: mod.exports, require: (id: string) => {
    assert.equal(id, './emojiShortcodes', 'единственная runtime-зависимость чистого модуля');
    return { emojiForCode: () => null };
  } });
  return mod.exports as typeof import('./messagePaneRules');
}

function mutantMustFail(actual: unknown, expected: unknown, why: string) {
  assert.throws(() => assert.deepEqual(actual, expected, why), assert.AssertionError, why);
}

it('тип конкретного нажатия важнее устройства; отсутствие признаков не притворяется мышью', () => {
  // Ноутбук с сенсорным экраном и телефон со стилусом нельзя классифицировать одним медиазапросом.
  for (const pointerType of ['touch', 'pen']) assert.equal(pressByTouch({ pointerType, sourceCapabilities: { firesTouchEvents: false } }), true);
  for (const pointerType of ['mouse', 'unknown']) assert.equal(pressByTouch({ pointerType, sourceCapabilities: { firesTouchEvents: true } }), false);
  for (const pointerType of ['', undefined, null, 0]) for (const firesTouchEvents of [true, false]) assert.equal(pressByTouch({ pointerType, sourceCapabilities: { firesTouchEvents } }), firesTouchEvents);
  for (const sourceCapabilities of [undefined, null, {}, { firesTouchEvents: 'true' }, { firesTouchEvents: 0 }]) assert.equal(pressByTouch({ sourceCapabilities }), null);
});

it('правка отличает неизменённый текст, пустую подпись и пустое сообщение', () => {
  // PATCH без изменений не должен ставить «изм.», но пустую подпись у вложения разрешено сохранить.
  assert.equal(editDecision({ draft: ' текст  ', original: 'текст', hasAttachments: false }), 'close');
  assert.equal(editDecision({ draft: '', original: 'текст', hasAttachments: false }), 'ignore');
  assert.equal(editDecision({ draft: ' ', original: 'текст', hasAttachments: true }), 'save');
  assert.equal(editDecision({ draft: '', original: '', hasAttachments: true }), 'close');
  const noClose = mutatedPaneRules("  if (draft === p.original.trim()) return 'close';\n", '');
  mutantMustFail(noClose.editDecision({ draft: 'x', original: 'x', hasAttachments: false }), 'close', 'мутант без close нарушает контракт нетронутой правки');
  const ignoreAttachments = mutatedPaneRules("  if (!draft && !p.hasAttachments) return 'ignore';", "  if (!draft) return 'ignore';");
  mutantMustFail(ignoreAttachments.editDecision({ draft: '', original: 'текст', hasAttachments: true }), 'save', 'мутант без учёта вложений запрещает убрать подпись');
});

it('вставка заменяет выделение или вставляет в каретку с ограничением позиций', () => {
  // Эмодзи не должны дописываться в конец, когда человек поставил курсор в середину текста.
  assert.deepEqual(insertAtCaret('abcd', '🙂', 2, 2), { text: 'ab🙂cd', caret: 4 });
  assert.deepEqual(insertAtCaret('abcd', 'X', 1, 3), { text: 'aXd', caret: 2 });
  assert.deepEqual(insertAtCaret('abcd', '!', null, null), { text: 'abcd!', caret: 5 });
  assert.deepEqual(insertAtCaret('abcd', 'X', -10, 99), { text: 'X', caret: 1 });
  assert.deepEqual(insertAtCaret('abcd', 'X', 3, 1), { text: 'aXd', caret: 2 });
  const appendOnly = mutatedPaneRules('  const from = Math.min(a, b);\n  const to = Math.max(a, b);\n  return { text: text.slice(0, from) + piece + text.slice(to), caret: from + piece.length };', '  return { text: text + piece, caret: text.length + piece.length };');
  mutantMustFail(appendOnly.insertAtCaret('abcd', 'X', 1, 3), { text: 'aXd', caret: 2 }, 'мутант вставки только в конец ломает замену выделения');
});

it('Esc закрывает неизменённую правку, спрашивает про изменения и не теряет непустой ответ', () => {
  // Непустой текст ответа принадлежит пользователю; Esc не должен молча сбрасывать его вместе с режимом ответа.
  assert.equal(fieldEscape({ editing: true, replying: true, draft: ' x ', original: 'x' }), 'cancel-edit');
  assert.equal(fieldEscape({ editing: true, replying: false, draft: 'y', original: 'x' }), 'ask');
  assert.equal(fieldEscape({ editing: false, replying: true, draft: '  ', original: '' }), 'cancel-reply');
  assert.equal(fieldEscape({ editing: false, replying: true, draft: 'текст', original: '' }), 'none');
  assert.equal(fieldEscape({ editing: false, replying: false, draft: '', original: '' }), 'none');
  const cancelNonemptyReply = mutatedPaneRules("if (p.replying) return p.draft.trim() === '' ? 'cancel-reply' : 'none';", "if (p.replying) return 'cancel-reply';");
  mutantMustFail(cancelNonemptyReply.fieldEscape({ editing: false, replying: true, draft: 'текст', original: '' }), 'none', 'мутант снимает непустой ответ');
});

it('двойной тап учитывает id сообщения и точные края первого и общего временного окна', () => {
  // Слишком короткое окно теряет быстрый жест; отсутствие проверки id ставит реакцию на соседнее сообщение.
  const waiting = { id: 'm', at: 100, second: false };
  assert.equal(doubleTapStep(waiting, { kind: 'down', id: 'm', at: 400 }).act, 'none');
  const atEdge = doubleTapStep(waiting, { kind: 'down', id: 'm', at: 400 }).pending;
  assert.deepEqual(atEdge, { id: 'm', at: 100, second: true });
  assert.equal(doubleTapStep(atEdge, { kind: 'tap', id: 'm', at: 700 }).act, 'double');
  assert.deepEqual(doubleTapStep(waiting, { kind: 'down', id: 'other', at: 200 }), { pending: null, act: 'none' });
  assert.deepEqual(doubleTapStep(waiting, { kind: 'down', id: 'm', at: 401 }), { pending: null, act: 'none' });
  assert.equal(doubleTapStep({ ...waiting, second: true }, { kind: 'tap', id: 'm', at: 701 }).act, 'wait');
  const strictWindow = mutatedPaneRules('e.at - pending.at <= windowMs', 'e.at - pending.at < windowMs');
  mutantMustFail(strictWindow.doubleTapStep(waiting, { kind: 'down', id: 'm', at: 400 }).pending, { id: 'm', at: 100, second: true }, 'строгая граница теряет касание ровно на окне');
  const noIdGuard = mutatedPaneRules('pending.id === e.id && e.at - pending.at <= windowMs', 'e.at - pending.at <= windowMs');
  mutantMustFail(noIdGuard.doubleTapStep(waiting, { kind: 'down', id: 'other', at: 200 }).pending, null, 'мутант без id guard склеивает разные сообщения');
  const oneWindowOnly = mutatedPaneRules('e.at - pending.at <= 2 * windowMs', 'e.at - pending.at <= windowMs');
  mutantMustFail(oneWindowOnly.doubleTapStep({ ...waiting, second: true }, { kind: 'tap', id: 'm', at: 700 }).act, 'double', 'мутант без удвоенного окна теряет длинное второе касание');
});

it('двойной тап снимает только мою реакцию, а лица показываются лишь для полного списка до трёх', () => {
  // Чужая одинаковая реакция не переключается, а неполный список аватаров вводил бы в заблуждение о числе людей.
  assert.equal(quickReactOp([{ emoji: '👍', me: false }], '👍'), 'add');
  assert.equal(quickReactOp([{ emoji: '👍', me: true }], '👍'), 'remove');
  assert.equal(quickReactOp(undefined, '👍'), 'add');
  assert.deepEqual(chipFaces({ count: 2, reactors: [{ userId: 'a' }, { userId: 'b' }] }), ['a', 'b']);
  for (const value of [
    { count: 0, reactors: [] }, { count: 2, reactors: [{ userId: 'a' }] },
    { count: 1, reactors: null }, { count: 4, reactors: Array.from({ length: 4 }, (_, i) => ({ userId: String(i) })) },
  ]) assert.equal(chipFaces(value), null);
  const foreignToggles = mutatedPaneRules('r.emoji === emoji && r.me', 'r.emoji === emoji');
  mutantMustFail(foreignToggles.quickReactOp([{ emoji: '👍', me: false }], '👍'), 'add', 'чужую реакцию нельзя переключать');
  const countMismatch = mutatedPaneRules('list.length !== r.count || ', '');
  mutantMustFail(countMismatch.chipFaces({ count: 2, reactors: [{ userId: 'a' }] }), null, 'несовпадающий count скрывает аватарки');
  const tooManyFaces = mutatedPaneRules('list.length > CHIP_FACES_MAX', 'false');
  mutantMustFail(tooManyFaces.chipFaces({ count: 4, reactors: Array.from({ length: 4 }, (_, i) => ({ userId: String(i) })) }), null, 'список больше трёх не должен переполнять чип');
});
import {
  acTokenAt,
  applyAc,
  emojiSubstitution,
  enterSends,
  draftToSave,
  createDraftSaver,
  GROUP_WINDOW_MS,
  dayLabel,
  isFirstUnread,
  isGrouped,
  isNewDay,
  type ListMessage,
  sentAtLabel,
  pickedText,
  swipeIntent,
  swipeOffset,
  swipeProgress,
  swipeArmed,
  swipeFromEdge,
  SWIPE_REPLY_PX,
  SWIPE_MAX_PX,
  SWIPE_DISARM_PX,
  SWIPE_EDGE_PX,
} from './messagePaneRules.js';

describe('выделение и свайп ответа в ленте', () => {
  it('копирование пачки идёт в порядке ленты, а не в порядке выбора; одно сообщение копируется без заголовка', () => {
    // Порядок кликов не должен переставлять текст при вставке в жалобу или заметки.
    const feed = [
      { id: 'a', content: 'первое', author: 'Me', createdAt: 'a' },
      { id: 'b', content: 'второе', author: 'Peer', createdAt: 'b' },
      { id: 'empty', content: '  ', author: 'Other', createdAt: 'c' },
    ];
    assert.equal(pickedText(feed, new Set(['b', 'empty', 'a']), (iso) => iso === 'a' ? '20:01' : '20:02'),
      'Me, 20:01\nпервое\n\nPeer, 20:02\nвторое');
    assert.equal(pickedText(feed, new Set(['b']), () => '20:02'), 'второе');
    assert.equal(pickedText(feed, new Set(), () => '20:00'), '');
  });

  it('свайп ждёт до 15 px, требует перевеса 3:1 и принимает только влево', () => {
    // Ровная диагональ должна остаться нативной прокруткой — иначе палец попадает в «мёртвую» зону.
    assert.equal(swipeIntent(-14, 0), 'wait');
    assert.equal(swipeIntent(-15, 0), 'swipe');
    assert.equal(swipeIntent(-60, 19.9), 'swipe');
    assert.equal(swipeIntent(-60, 20), 'wait');
    assert.equal(swipeIntent(-60, 21.5), 'wait');
    assert.equal(swipeIntent(-20, 20), 'scroll');
    assert.equal(swipeIntent(20, 0), 'scroll');
    assert.equal(swipeIntent(0, 10), 'scroll');
  });

  it('порог ответа — 50 px без гистерезиса, палец упирается линейно в 80 px', () => {
    // Порог не должен съехать незаметно: это расстояние до выезда значка из-под пузыря.
    assert.equal(SWIPE_REPLY_PX, 50);
    assert.equal(SWIPE_MAX_PX, 80);
    assert.equal(SWIPE_DISARM_PX, 50);
    assert.equal(swipeOffset(0), 0);
    assert.equal(swipeOffset(SWIPE_REPLY_PX), SWIPE_REPLY_PX);
    assert.ok(swipeOffset(SWIPE_REPLY_PX + 1) > SWIPE_REPLY_PX, 'после порога палец всё ещё двигает пузырь');
    assert.equal(swipeOffset(120), SWIPE_MAX_PX, 'палец доходит до жёсткого упора');
    assert.equal(swipeOffset(50, wheelRules.SWIPE_WHEEL), 50);
    assert.ok(Math.abs(swipeOffset(75, wheelRules.SWIPE_WHEEL) - 70.0442075) < 0.0001, 'тачпад гасится логарифмом');
    assert.equal(swipeOffset(200, wheelRules.SWIPE_WHEEL), swipeOffset(75, wheelRules.SWIPE_WHEEL));
    assert.equal(swipeProgress(SWIPE_REPLY_PX / 2), 0.5);
    assert.equal(swipeProgress(-1), 0, 'отрицательное смещение не даёт отрицательную заливку значка');
    assert.equal(swipeProgress(10000), 1);
    assert.equal(swipeArmed(SWIPE_REPLY_PX - 1, false), false);
    assert.equal(swipeArmed(SWIPE_REPLY_PX, false), true);
    assert.equal(swipeArmed(SWIPE_DISARM_PX, true), true);
    assert.equal(swipeArmed(SWIPE_DISARM_PX - 1, true), false);
  });

  it('зона системного жеста справа включительна ровно на 32 px', () => {
    // Слишком широкая зона «назад» забирает обычный свайп; слишком узкая конфликтует с Android.
    assert.equal(swipeFromEdge(968, 1000), true);
    assert.equal(swipeFromEdge(967, 1000), false);
    assert.equal(swipeFromEdge(1000, 1000), true);
    assert.equal(swipeFromEdge(0, 1000), false);
    assert.equal(SWIPE_EDGE_PX, 32);
  });
});

describe('сохранение черновика при правке и уходе из ленты', () => {
  it('правка сохраняет прежний черновик, без него — пустой, обычный ввод — текущий', () => {
    // Ловит затирание набранного черновика текстом редактируемого сообщения.
    const p = { text: 'правка', replyToId: 'edited-reply', editing: true, beforeEdit: { text: 'черновик', replyToId: 'draft-reply' } };
    assert.deepEqual(draftToSave(p), p.beforeEdit);
    assert.deepEqual(draftToSave({ ...p, beforeEdit: null }), { text: '', replyToId: null });
    assert.deepEqual(draftToSave({ ...p, editing: false }), { text: 'правка', replyToId: 'edited-reply' });
  });

  function clock() {
    let now = 0;
    let id = 0;
    const tasks = new Map<number, { at: number; fn: () => void }>();
    return { tasks, setTimeout: (fn: () => void, ms: number) => { tasks.set(++id, { at: now + ms, fn }); return id; },
      clearTimeout: (timer: unknown) => { tasks.delete(timer as number); },
      advance: (ms: number) => { now += ms; for (const [key, t] of [...tasks]) if (t.at <= now) { tasks.delete(key); t.fn(); } } };
  }

  it('каждая буква переносит запись, ровно на границе задержки записывается последнее', () => {
    // Ловит запись промежуточного текста и преждевременную запись из старого таймера.
    const time = clock();
    const saved: string[] = [];
    const saver = createDraftSaver((text: string) => saved.push(text), 300, time);
    saver.change('а');
    time.advance(299);
    saver.change('аб');
    time.advance(299);
    assert.deepEqual(saved, []);
    time.advance(1);
    assert.deepEqual(saved, ['аб']);
    saver.flush();
    assert.deepEqual(saved, ['аб']);
  });

  it('размонтирование пишет последнее один раз и отменяет оставшийся таймер', () => {
    // Ловит потерю последних 300 мс набора при уходе в голос и повторное сохранение после ухода.
    const time = clock();
    const saved: string[] = [];
    const saver = createDraftSaver((text: string) => saved.push(text), 300, time);
    saver.change('первое');
    saver.change('последнее');
    saver.flush();
    saver.flush();
    assert.equal(time.tasks.size, 0);
    time.advance(1000);
    assert.deepEqual(saved, ['последнее']);
  });
});

describe('Enter в многострочном поле', () => {
  it('pending черновика взведён только до записи или flush', () => {
    let fire = () => {};
    const saver = createDraftSaver(() => {}, 300, { setTimeout: (fn: () => void) => { fire = fn; return 1; }, clearTimeout: () => {} });
    assert.equal(saver.pending(), false); saver.change('x'); assert.equal(saver.pending(), true);
    fire(); assert.equal(saver.pending(), false);
    saver.change('y'); saver.flush(); assert.equal(saver.pending(), false);
  });
  it('Shift, IME и сенсор оставляют перенос строки, а клавиатурный Enter отправляет', () => {
    // Ловит случайную отправку с телефона/IME и потерю привычного Shift+Enter на компьютере.
    assert.equal(enterSends({ shift: true, composing: false, touchOnly: false }), false);
    assert.equal(enterSends({ shift: false, composing: true, touchOnly: false }), false);
    assert.equal(enterSends({ shift: false, composing: false, touchOnly: true }), false);
    assert.equal(enterSends({ shift: false, composing: false, touchOnly: false }), true);
  });
});

const message = (at: number, authorId = 'other', hasReply = false): ListMessage => ({
  createdAt: new Date(at).toISOString(),
  authorId,
  hasReply,
});

describe('токен автодополнения под кареткой', () => {
  it('эмодзи-код из двух символов открывает подсказки', () => {
    // Ловит недоступность обещанного autocomplete после достижения минимальной длины.
    assert.deepEqual(acTokenAt(':fi', 3, true), { trigger: ':', query: 'fi', start: 0 });
  });

  it('один символ и ручной смайлик не открывают список эмодзи', () => {
    // Ловит всплывание подсказок на каждом коротком «:)» в обычном разговоре.
    assert.equal(acTokenAt(':f', 2, true), null);
    assert.equal(acTokenAt(':)', 2, true), null);
  });

  it('упоминания и каналы отключены вне серверного контекста', () => {
    // Ловит пустые серверные подсказки внутри личной переписки.
    assert.equal(acTokenAt('@ivan', 5, false), null);
    assert.equal(acTokenAt('#general', 8, false), null);
  });

  it('время и адрес почты не считаются токенами', () => {
    // Ловит навязчивый autocomplete при наборе времени и электронной почты.
    assert.equal(acTokenAt('10:30', 5, true), null);
    assert.equal(acTokenAt('a@b', 3, true), null);
  });

  it('отсутствующая каретка всегда даёт null', () => {
    // Ловит замену текста при неизвестной позиции selectionStart.
    assert.equal(acTokenAt(':fire', null, true), null);
  });

  it('токен в середине строки возвращает индекс своего триггера', () => {
    // Ловит удаление соседнего текста при замене токена не с начала строки.
    assert.deepEqual(acTokenAt('say @iv later', 7, true), { trigger: '@', query: 'iv', start: 4 });
  });

  it('пустое упоминание и имя канала принимаются на сервере', () => {
    // Ловит запрет законных подсказок сразу после @ и #.
    assert.deepEqual(acTokenAt('@', 1, true), { trigger: '@', query: '', start: 0 });
    assert.deepEqual(acTokenAt('#general', 8, true), { trigger: '#', query: 'general', start: 0 });
  });

  it('хэштег в ЛС включается только отдельным четвёртым флагом', () => {
    // Ловит регрессию G36: хэштеги ЛС не должны открывать серверный список каналов и наоборот.
    assert.deepEqual(acTokenAt('#гусь', 5, false, true), { trigger: '#', query: 'гусь', start: 0 });
    assert.equal(acTokenAt('#гусь', 5, false), null);
    assert.equal(acTokenAt('@гусь', 5, false, true), null);
    const withoutDmHashtags = mutatedPaneRules('serverScoped || hashtags', 'serverScoped');
    mutantMustFail(withoutDmHashtags.acTokenAt('#гусь', 5, false, true), { trigger: '#', query: 'гусь', start: 0 },
      'мутант игнорирует четвёртый аргумент и закрывает подсказки хэштегов в ЛС');
  });
});

describe('применение выбранной подсказки', () => {
  it('токен заменяется с пробелом, а каретка встаёт после него', () => {
    // Ловит приклеивание следующего слова к имени и неверную позицию дальнейшего ввода.
    assert.deepEqual(applyAc('say @ivnow', { trigger: '@', query: 'iv', start: 4 }, '@ivan'), {
      text: 'say @ivan now',
      caret: 10,
    });
  });
});

describe('автозамена шорткода эмодзи', () => {
  it('известный :fire: заменяется, а каретка учитывает UTF-16 длину эмодзи', () => {
    // Ловит каретку внутри суррогатной пары 🔥 после успешной замены.
    assert.deepEqual(emojiSubstitution('say :fire:', 10), { text: 'say 🔥', caret: 6 });
  });

  it('замена в середине строки сохраняет хвост после каретки', () => {
    // Ловит потерю уже набранной части сообщения справа от заменяемого кода.
    assert.deepEqual(emojiSubstitution('say :fire: later', 10), { text: 'say 🔥 later', caret: 6 });
  });

  it('время и URL с портом остаются обычным текстом', () => {
    // Ловит повреждение времени и адресов при вводе закрывающего двоеточия.
    assert.equal(emojiSubstitution('10:30:', 6), null);
    assert.equal(emojiSubstitution('http://host:8080:', 17), null);
  });

  it('неизвестный код не исчезает из сообщения', () => {
    // Ловит молчаливое удаление пользовательского текста, которого нет в таблице эмодзи.
    assert.equal(emojiSubstitution(':zzzznotacode:', 14), null);
  });

  it('без каретки замена не выполняется', () => {
    // Ловит изменение поля при неизвестной позиции курсора.
    assert.equal(emojiSubstitution(':fire:', null), null);
  });
});

describe('разделитель новых сообщений', () => {
  it('первое чужое сообщение после отметки рисует разделитель', () => {
    // Ловит полное исчезновение границы непрочитанного после возвращения в канал.
    assert.equal(isFirstUnread(message(2_000), undefined, 'me', 1_000), true);
  });

  it('второе новое сообщение подряд не рисует второй разделитель', () => {
    // Ловит повтор «Новые сообщения» над каждым сообщением после отметки.
    assert.equal(isFirstUnread(message(3_000), message(2_000), 'me', 1_000), false);
  });

  it('собственное сообщение не считается новым для автора', () => {
    // Ловит разделитель над сообщением, которое пользователь только что написал сам.
    assert.equal(isFirstUnread(message(2_000, 'me'), undefined, 'me', 1_000), false);
  });

  it('без отметки последнего визита разделитель не появляется', () => {
    // Ловит ложную границу непрочитанного в только что открытом или новом канале.
    assert.equal(isFirstUnread(message(2_000), undefined, 'me', null), false);
  });

  it('ровно отметка ещё прочитана, а миллисекунда после неё уже новая', () => {
    // Ловит ошибку строгой границы времени последнего визита.
    assert.equal(isFirstUnread(message(1_000), undefined, 'me', 1_000), false);
    assert.equal(isFirstUnread(message(1_001), undefined, 'me', 1_000), true);
  });
});

describe('группировка соседних сообщений', () => {
  it('без предыдущего сообщения группа не начинается', () => {
    // Ловит исчезновение шапки автора у первого сообщения списка.
    assert.equal(isGrouped(message(1_000), undefined), false);
  });

  it('сообщения одного автора через минуту объединяются', () => {
    // Ловит чрезмерное дробление обычной последовательной переписки.
    assert.equal(isGrouped(message(61_000), message(1_000)), true);
  });

  it('ровно пять минут ещё группа, а следующая миллисекунда уже новый блок', () => {
    // Ловит ошибку на границе окна группировки.
    assert.equal(isGrouped(message(1_000 + GROUP_WINDOW_MS), message(1_000)), true);
    assert.equal(isGrouped(message(1_001 + GROUP_WINDOW_MS), message(1_000)), false);
  });

  it('сообщение другого автора всегда начинает свой блок', () => {
    // Ловит визуальное приписывание чужого текста предыдущему человеку.
    assert.equal(isGrouped(message(2_000, 'second'), message(1_000, 'first')), false);
  });

  it('ответ с цитатой всегда начинает новый блок', () => {
    // Ловит чтение цитаты как продолжения предыдущей мысли без собственной шапки.
    assert.equal(isGrouped(message(2_000, 'same', true), message(1_000, 'same')), false);
  });
});

describe('границы календарных дней', () => {
  it('первое сообщение всегда открывает дневной блок', () => {
    // Ловит ленту без даты над самым верхним сообщением.
    assert.equal(isNewDay(message(Date.UTC(2026, 8, 20, 12)), undefined), true);
  });

  it('сообщения одного местного дня не создают второй разделитель', () => {
    // Ловит сравнение полных timestamp вместо календарной даты читателя.
    const noon = new Date(2026, 8, 20, 12).getTime();
    const evening = new Date(2026, 8, 20, 23).getTime();
    assert.equal(isNewDay(message(evening), message(noon)), false);
  });

  it('соседние сообщения по разные стороны местной полуночи разделяются', () => {
    // Ловит расчёт дня по UTC, когда у читающего уже наступили новые сутки.
    const before = new Date(2026, 8, 20, 23, 59, 59).getTime();
    const after = new Date(2026, 8, 21, 0, 0, 0).getTime();
    assert.equal(isNewDay(message(after), message(before)), true);
  });

  it('подписи сегодня и вчера считаются от переданного времени', () => {
    // Ловит зависимость теста и интерфейса от часов машины вместо выбранного «сейчас».
    const now = new Date(2026, 8, 22, 12);
    assert.equal(dayLabel(new Date(2026, 8, 22, 1).toISOString(), now), 'Сегодня');
    assert.equal(dayLabel(new Date(2026, 8, 21, 23).toISOString(), now), 'Вчера');
  });
});

describe('время в подвале меню сообщения', () => {
  it('сегодня и вчера меняются ровно на местной полуночи, а не через 24 часа', () => {
    // В сутки перевода часов календарная смена дня не равна 24 часам; timestamp сравнивать нельзя.
    const now = new Date(2026, 2, 9, 0, 5);
    const today = new Date(2026, 2, 9, 0, 1);
    const yesterday = new Date(2026, 2, 8, 23, 59);
    const time = (d: Date) => new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' }).format(d);
    assert.equal(sentAtLabel(today.toISOString(), now), `Сегодня в ${time(today)}`);
    assert.equal(sentAtLabel(yesterday.toISOString(), now), `Вчера в ${time(yesterday)}`);
  });

  it('прошлая дата содержит год только для предыдущих лет и время совпадает с Intl', () => {
    // Без года старые сообщения разных лет неразличимы; ручная сборка времени расходится с локалью пузыря.
    const now = new Date(2026, 9, 5, 12);
    const sameYear = new Date(2026, 0, 2, 9, 5);
    const priorYear = new Date(2025, 11, 31, 21, 7);
    const day = (d: Date) => new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long' }).format(d);
    const time = (d: Date) => new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' }).format(d);
    assert.equal(sentAtLabel(sameYear.toISOString(), now), `${day(sameYear)} в ${time(sameYear)}`);
    assert.equal(sentAtLabel(priorYear.toISOString(), now), `${day(priorYear)} 2025 в ${time(priorYear)}`);
    assert.doesNotMatch(sentAtLabel(priorYear.toISOString(), now), /г\./);
  });

  it('правка подписана строчной датой, а пересылка — датой оригинала; пустые дополнительные даты пропускаются', () => {
    // Получатель сверяет источник пересылки и момент правки, а «Invalid Date» не должен попадать в меню.
    const now = new Date(2026, 9, 7, 12, 0);
    const createdAt = new Date(2026, 9, 7, 11, 0).toISOString();
    const editedAt = new Date(2026, 9, 6, 10, 0).toISOString();
    const originalAt = new Date(2026, 9, 5, 9, 0).toISOString();
    const sent = sentAtLabel(createdAt, now);
    assert.deepEqual(menuFootLines({ createdAt }, now), [sent]);
    const lines = menuFootLines({ createdAt, editedAt, forwardedFrom: { at: originalAt } }, now);
    assert.equal(lines[0], sent);
    assert.match(lines[1] ?? '', /^Изменено: вчера в /);
    assert.match(lines[2] ?? '', /^Исходное: 5 октября в /);
    assert.deepEqual(menuFootLines({ createdAt, editedAt: 'invalid', forwardedFrom: { at: '' } }, now), [sent]);
    assert.equal(timeTooltip({ createdAt: 'invalid' }), '');
    const oldTimeForForward = mutatedPaneRules('after(m.forwardedFrom!.at)', 'after(m.createdAt)');
    mutantMustFail(oldTimeForForward.menuFootLines({ createdAt, forwardedFrom: { at: originalAt } }, now), [sent, `Исходное: ${sentAtLabel(originalAt, now).replace(/^(Сегодня|Вчера)/, (w) => w.toLowerCase())}`], 'пересланное должно сохранять исходную дату');
    const noValidation = mutatedPaneRules('if (validIso(m.forwardedFrom?.at)) lines.push(`Исходное: ${after(m.forwardedFrom!.at)}`);', 'lines.push(`Исходное: ${after(m.forwardedFrom?.at ?? "")}`);');
    assert.throws(() => assert.doesNotThrow(() => noValidation.menuFootLines({ createdAt, forwardedFrom: { at: '' } }, now)), assert.AssertionError,
      'мутант без validIso должен потерять обработку пустой даты');
  });

  it('подсказка времени не строит строку для невалидного createdAt', () => {
    // Наведение на испорченное время не должно бросать RangeError во время рендера меню.
    assert.equal(timeTooltip({ createdAt: '' }), '');
    assert.equal(timeTooltip({ createdAt: 'not-a-date' }), '');
    const noValidation = mutatedPaneRules('if (!validIso(m.createdAt)) return \'\';', 'if (false) return \'\';');
    assert.throws(() => assert.doesNotThrow(() => noValidation.timeTooltip({ createdAt: 'not-a-date' })), assert.AssertionError,
      'мутант без проверки даты должен провалить контракт отсутствия подсказки');
  });
});

describe('копирование нескольких сообщений', () => {
  const time = (iso: string) => `T:${iso}`;
  it('ПК копирует в порядке ленты с цитатой и подписью вложения, одиночное — чистым текстом', () => {
    // Порядок кликов не должен менять порядок сообщений; цитата и подпись должны оставаться читаемыми.
    const feed = [
      { id: 'a', author: 'Аня', content: ' текст ', createdAt: 'a' },
      { id: 'b', author: 'Борис', content: 'подпись', label: '[ Фотография ]', createdAt: 'b' },
      { id: 'c', author: 'Аня', content: 'ответ', createdAt: 'c', reply: { author: 'Гоша', text: '  первая\n   вторая  ' } },
      { id: 'empty', author: 'Лена', content: ' ', createdAt: 'd' },
    ];
    const result = pickedText(feed, new Set(['c', 'empty', 'b', 'a']), time, { style: 'desktop' });
    assert.equal(result, '[T:a] Аня:  текст \n[T:b] Борис:\n[ Фотография ]\n\nподпись\n[T:c] Аня в ответ Гоша:\n> первая вторая\nответ');
    assert.equal(pickedText(feed, new Set(['b']), time, { style: 'desktop' }), 'подпись', 'одна выбранная строка остаётся чистым текстом');
    assert.equal(pickedText([{ ...feed[0]!, id: 'only-file', content: '', label: '[ Видео ]' }], new Set(['only-file']), time, { style: 'desktop' }), '',
      'один файл без подписи не подменяется служебной меткой');
    assert.equal(pickedText([{ ...feed[0]!, id: 'empty', content: '', label: undefined }], new Set(['empty']), time, { style: 'desktop' }), '');
    const noQuotePrefix = mutatedPaneRules('? `> ${quote}` : \'\'', '? quote : \'\'');
    mutantMustFail(noQuotePrefix.pickedText(feed, new Set(['c', 'b']), time, { style: 'desktop' }),
      '[T:b] Борис:\n[ Фотография ]\n\nподпись\n[T:c] Аня в ответ Гоша:\n> первая вторая\nответ', 'цитата обязана отличаться префиксом >');
    const unordered = mutatedPaneRules('const chosen = feed.filter((m) => picked.has(m.id));', 'const chosen = [...picked].flatMap((id) => { const m = feed.find((x) => x.id === id); return m ? [m] : []; });');
    mutantMustFail(unordered.pickedText(feed, new Set(['c', 'a']), time, { style: 'desktop' }),
      '[T:a] Аня:  текст \n[T:c] Аня в ответ Гоша:\n> первая вторая\nответ', 'мутант порядка выбора нарушает порядок ленты');
  });

  it('телефон пишет автора только перед первым и при смене; старый вызов без стиля не меняется', () => {
    // Телефонная копия избегает лишних повторов имён и времени, но прежние вызовы сохраняют исторический формат.
    const feed = [
      { id: 'a', author: 'Аня', content: 'первое', createdAt: 'a' },
      { id: 'b', author: 'Аня', content: 'второе', createdAt: 'b' },
      { id: 'c', author: 'Борис', content: 'третье', createdAt: 'c' },
    ];
    assert.equal(pickedText(feed, new Set(['c', 'b', 'a']), time, { style: 'phone' }), 'Аня:\nпервое\n\nвторое\n\nБорис:\nтретье');
    assert.equal(pickedText(feed.slice(0, 2), new Set(['a', 'b']), time), 'Аня, T:a\nпервое\n\nАня, T:b\nвторое');
    const everyAuthor = mutatedPaneRules('const head = m.author !== prev ? `${m.author}:\\n` : \'\';', 'const head = `${m.author}:\\n`;');
    mutantMustFail(everyAuthor.pickedText(feed, new Set(['a', 'b', 'c']), time, { style: 'phone' }),
      'Аня:\nпервое\n\nвторое\n\nБорис:\nтретье', 'мутант повторного имени на каждой строке нарушает формат телефона');
  });
});

it('метка копирования выбирает стикер, альбом, голосовое, фото, видео и файл в строгом приоритете', () => {
  // Неверная метка меняет смысл вложения; пустой waveform не превращает видео или файл в голосовое.
  assert.equal(copyMediaLabel({}), '');
  assert.equal(copyMediaLabel({ sticker: {}, attachments: [{ contentType: 'image/png' }, { contentType: 'video/mp4' }] }), '[ Стикер ]');
  assert.equal(copyMediaLabel({ attachments: [{ contentType: 'image/png' }, { contentType: 'video/mp4' }] }), '[ Альбом ]');
  assert.equal(copyMediaLabel({ attachments: [{ contentType: 'audio/ogg', waveform: [1] }] }), '[ Голосовое сообщение ]');
  assert.equal(copyMediaLabel({ attachments: [{ contentType: 'audio/ogg', waveform: [] }] }), '[ Файл ]');
  assert.equal(copyMediaLabel({ attachments: [{ contentType: 'image/jpeg' }] }), '[ Фотография ]');
  assert.equal(copyMediaLabel({ attachments: [{ contentType: 'video/mp4' }] }), '[ Видео ]');
  assert.equal(copyMediaLabel({ attachments: [{ contentType: 'application/pdf' }] }), '[ Файл ]');
  const emptyWave = mutatedPaneRules('Array.isArray(a.waveform) && a.waveform.length > 0', 'Array.isArray(a.waveform)');
  mutantMustFail(emptyWave.copyMediaLabel({ attachments: [{ contentType: 'audio/ogg', waveform: [] }] }), '[ Файл ]', 'пустая форма сигнала не означает голосовое');
  const albumBeforeSticker = mutatedPaneRules('  if (m.sticker) return \'[ Стикер ]\';\n  const list = m.attachments ?? [];\n  if (list.length === 0) return \'\';\n  if (list.length > 1) return \'[ Альбом ]\';', '  const list = m.attachments ?? [];\n  if (list.length > 1) return \'[ Альбом ]\';\n  if (m.sticker) return \'[ Стикер ]\';\n  if (list.length === 0) return \'\';');
  mutantMustFail(albumBeforeSticker.copyMediaLabel({ sticker: {}, attachments: [{ contentType: 'image/png' }, { contentType: 'video/mp4' }] }), '[ Стикер ]', 'стикер имеет приоритет над альбомом');
});
