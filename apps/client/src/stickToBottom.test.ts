import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
