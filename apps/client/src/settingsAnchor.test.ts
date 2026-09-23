import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ANCHOR_SLACK_PX, activeAnchor, atBottomOf } from './settingsAnchor.js';

describe('активный якорь настроек', () => {
  it('пустой список не выдумывает активную группу', () => {
    // Ловит обращение к несуществующей первой группе при пустом разделе.
    assert.equal(activeAnchor({ groups: [], atBottom: false }), null);
  });

  it('наверху активна первая группа', () => {
    // Ловит отсутствие подсветки до первого пересечения кромки.
    assert.equal(activeAnchor({ groups: [{ id: 'one', top: 100 }, { id: 'two', top: 300 }], atBottom: false }), 'one');
  });

  it('ровно в пределах допуска выбирается последняя достигнутая группа', () => {
    // Ловит дребезг подсветки около верхней кромки.
    assert.equal(activeAnchor({ groups: [{ id: 'one', top: -50 }, { id: 'two', top: ANCHOR_SLACK_PX }], atBottom: false }), 'two');
  });

  it('на дне всегда подсвечивается последняя группа', () => {
    // Ловит застревание подсветки на предпоследнем разделе короткого контейнера.
    assert.equal(activeAnchor({ groups: [{ id: 'one', top: -20 }, { id: 'last', top: 200 }], atBottom: true }), 'last');
  });

  it('два пикселя до дна уже считаются дном, три ещё нет', () => {
    // Ловит ошибку на границе субпиксельного остатка прокрутки.
    assert.equal(atBottomOf({ scrollTop: 498, clientHeight: 500, scrollHeight: 1000 }), true);
    assert.equal(atBottomOf({ scrollTop: 497, clientHeight: 500, scrollHeight: 1000 }), false);
  });
});
