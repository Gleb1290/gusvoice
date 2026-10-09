import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as jump from './stickToBottom';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

it('«Вниз» сначала ведёт к черте на нижней границе, окно не у хвоста сохраняет черту всегда', () => {
  // Равная нижней кромке черта иначе теряется при первом нажатии «Вниз».
  assert.equal(jump.jumpDownTarget(null, 100), 'end');
  assert.equal(jump.jumpDownTarget(99, 100), 'end');
  assert.equal(jump.jumpDownTarget(100, 100), 'unread');
  assert.equal(jump.jumpDownTarget(101, 100), 'unread');
  assert.equal(jump.unreadDividerNeeded(100, 100, true), false);
  assert.equal(jump.unreadDividerNeeded(101, 100, true), true);
  assert.equal(jump.unreadDividerNeeded(0, 100, false), true);
  const source = readFileSync(new URL('./stickToBottom.ts', import.meta.url), 'utf8');
  for (const [from, to, check] of [
    ['firstUnreadTop >= viewBottom', 'firstUnreadTop > viewBottom', (api: typeof jump) => assert.equal(api.jumpDownTarget(100, 100), 'unread')],
    ['!atTail || dividerToEnd > viewHeight', 'dividerToEnd > viewHeight', (api: typeof jump) => assert.equal(api.unreadDividerNeeded(0, 100, false), true)],
  ] as const) {
    assert.ok(source.includes(from), 'мутируется действующее правило');
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports });
    assert.throws(() => check(module.exports as typeof jump), assert.AssertionError);
  }
});
import {
  HISTORY_TRIGGER_PX,
  NEAR_BOTTOM_PX,
  addedBelow,
  isNearBottom,
  jumpDownLabel,
  keepPositionAfterPrepend,
  shouldAutoScroll,
  shouldLoadOlder,
  shouldShowJumpDown,
} from './stickToBottom.js';

describe('прилипание ленты к низу', () => {
  it('ровно граница допуска считается низом, а пикселем выше уже нет', () => {
    // Ловит дёргание ленты из-за ошибки на границе субпиксельного допуска.
    assert.equal(isNearBottom({ scrollTop: 936, clientHeight: 1000, scrollHeight: 2000 }), true);
    assert.equal(isNearBottom({ scrollTop: 935, clientHeight: 1000, scrollHeight: 2000 }), false);
    assert.equal(NEAR_BOTTOM_PX, 64);
  });

  it('чужое сообщение не срывает чтение истории, но своё и смена ленты прокручивают', () => {
    // Ловит возврат прежнего бага, где любое сообщение выбрасывало человека в конец.
    assert.equal(shouldAutoScroll({ wasNearBottom: false, ownMessage: false, switchedFeed: false }), false);
    assert.equal(shouldAutoScroll({ wasNearBottom: false, ownMessage: true, switchedFeed: false }), true);
    assert.equal(shouldAutoScroll({ wasNearBottom: false, ownMessage: false, switchedFeed: true }), true);
  });

  it('кнопка перехода появляется только при накопившемся новом тексте ниже', () => {
    // Ловит бесполезную кнопку у нижней кромки и её отсутствие при непрочитанном снизу.
    assert.equal(shouldShowJumpDown({ nearBottom: false, unseenBelow: 1 }), true);
    assert.equal(shouldShowJumpDown({ nearBottom: false, unseenBelow: 0 }), false);
    assert.equal(shouldShowJumpDown({ nearBottom: true, unseenBelow: 5 }), false);
  });

  it('история грузится на границе 600 пикселей, но не во время запроса и не после конца', () => {
    // Ловит лишние параллельные запросы и ошибку на границе ранней подгрузки.
    assert.equal(shouldLoadOlder({ scrollTop: HISTORY_TRIGGER_PX, loading: false, hasMore: true }), true);
    assert.equal(shouldLoadOlder({ scrollTop: HISTORY_TRIGGER_PX + 1, loading: false, hasMore: true }), false);
    assert.equal(shouldLoadOlder({ scrollTop: 0, loading: true, hasMore: true }), false);
    assert.equal(shouldLoadOlder({ scrollTop: 0, loading: false, hasMore: false }), false);
  });

  it('добавление истории сверху сохраняет тот же фрагмент перед глазами', () => {
    // Ловит прыжок в прошлое после увеличения высоты ленты сверху.
    assert.equal(keepPositionAfterPrepend({ scrollTop: 250, scrollHeight: 1000 }, 1600), 850);
  });

  it('новыми считаются только элементы после прежнего последнего сообщения', () => {
    // Ловит засчитывание подгруженной сверху истории как новых сообщений.
    assert.equal(addedBelow(['old-1', 'old-2', 'last', 'new-1', 'new-2'], 'last'), 2);
    assert.equal(addedBelow(['old-1', 'old-2'], undefined), 0);
    assert.equal(addedBelow(['other-feed'], 'last'), 0);
  });

  it('при повторе id используется его последнее вхождение', () => {
    // Ловит завышенный счётчик при временном дубле сообщения во время слияния страниц.
    assert.equal(addedBelow(['same', 'middle', 'same', 'new'], 'same'), 1);
  });

  it('подпись различает одно сообщение и ограничивает большие числа', () => {
    // Ловит неверное склонение и разъезжающуюся кнопку при трёхзначном счётчике.
    assert.equal(jumpDownLabel(0), '0 новых');
    assert.equal(jumpDownLabel(1), '1 новое');
    assert.equal(jumpDownLabel(99), '99 новых');
    assert.equal(jumpDownLabel(100), '99+ новых');
  });
});

it('кнопка вниз появляется за 480 px и по каждому самостоятельному основанию', () => {
  // Ровно 480 px ещё скрывают кнопку, а неравные источники появления не должны затереть друг друга.
  const box = (distance: number) => ({ scrollTop: 1000 - distance, scrollHeight: 2000, clientHeight: 1000 });
  const check = (api: typeof jump) => {
    assert.equal(api.JUMP_DOWN_SHOWN_AFTER, 480);
    assert.equal(api.isFarFromBottom(box(480)), false);
    assert.equal(api.isFarFromBottom(box(481)), true);
    assert.equal(api.shouldShowCornerDown({ far: true, nearBottom: false, hasNewer: false, back: false, unread: 0 }), true);
    assert.equal(api.shouldShowCornerDown({ far: false, nearBottom: true, hasNewer: true, back: false, unread: 0 }), true);
    assert.equal(api.shouldShowCornerDown({ far: false, nearBottom: true, hasNewer: false, back: true, unread: 0 }), true);
    assert.equal(api.shouldShowCornerDown({ far: false, nearBottom: false, hasNewer: false, back: false, unread: 1 }), true);
    assert.equal(api.shouldShowCornerDown({ far: false, nearBottom: true, hasNewer: false, back: false, unread: 1 }), false);
    assert.equal(api.shouldShowCornerDown({ far: false, nearBottom: false, hasNewer: false, back: false, unread: 0 }), false);
  };
  check(jump);
  const source = readFileSync(new URL('./stickToBottom.ts', import.meta.url), 'utf8');
  const load = (code: string): typeof jump => {
    const module = { exports: {} as Record<string, unknown> };
    runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports });
    return module.exports as typeof jump;
  };
  check(load(source));
  const wrongThreshold = source.replace('box.scrollTop + after < box.scrollHeight - box.clientHeight', 'box.scrollTop + after > box.scrollHeight - box.clientHeight');
  assert.notEqual(wrongThreshold, source, 'пороговый мутант изменил условие');
  assert.throws(() => check(load(wrongThreshold)), assert.AssertionError,
    'мутант с > скрывает кнопку на расстоянии 481 px');
});
