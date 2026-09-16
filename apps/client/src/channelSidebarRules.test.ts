import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeReorder, dropHintForRow, rowClickOpensCard, type OrderableChannel } from './channelSidebarRules.js';

const row = (id: string, position: number, categoryId: string | null = 'source'): OrderableChannel => ({
  id,
  position,
  categoryId,
});

describe('цель броска по строке канала', () => {
  it('верхняя половина ставит канал перед выбранной строкой', () => {
    // Ловит инверсию половин строки, из-за которой канал оказывается после выбранного соседа.
    assert.deepEqual(dropHintForRow({
      draggedId: 'a',
      targetId: 'b',
      targetCat: 'cat',
      after: false,
      orderedIds: ['a', 'b', 'c'],
    }), { cat: 'cat', before: 'b' });
  });

  it('нижняя половина ставит канал перед следующим соседом', () => {
    // Ловит вставку перед самой строкой вместо позиции сразу после неё.
    assert.deepEqual(dropHintForRow({
      draggedId: 'a',
      targetId: 'b',
      targetCat: 'cat',
      after: true,
      orderedIds: ['a', 'b', 'c'],
    }), { cat: 'cat', before: 'c' });
  });

  it('бросок после соседа пропускает сам перетаскиваемый канал и остаётся no-op', () => {
    // Регрессия #94: beforeId, равный draggedId, исчезал из списка и уводил канал в конец.
    const all = [row('a', 0), row('b', 1), row('c', 2)];
    const hint = dropHintForRow({
      draggedId: 'b',
      targetId: 'a',
      targetCat: 'source',
      after: true,
      orderedIds: ['a', 'b', 'c'],
    });
    assert.deepEqual(hint, { cat: 'source', before: 'c' });
    assert.deepEqual(computeReorder(all, 'b', hint!.cat, hint!.before), []);
  });

  it('нижняя половина последней строки означает конец категории', () => {
    // Ловит выход за список или ошибочный возврат первого канала после последней строки.
    assert.deepEqual(dropHintForRow({
      draggedId: 'a',
      targetId: 'c',
      targetCat: 'cat',
      after: true,
      orderedIds: ['a', 'b', 'c'],
    }), { cat: 'cat', before: null });
  });

  it('собственная строка гасит прежнюю цель в обеих половинах', () => {
    // Регрессия #94: иначе отпускание над собой применяло подсказку, оставшуюся от чужой строки.
    for (const after of [false, true]) {
      assert.equal(dropHintForRow({
        draggedId: 'a',
        targetId: 'a',
        targetCat: 'cat',
        after,
        orderedIds: ['a', 'b', 'c'],
      }), null);
    }
  });

  it('целевая категория берётся из строки, а не выводится из порядка id', () => {
    // Ловит перенос в исходную категорию при броске на строку другой группы.
    assert.deepEqual(dropHintForRow({
      draggedId: 'source',
      targetId: 'target',
      targetCat: 'other',
      after: false,
      orderedIds: ['target'],
    }), { cat: 'other', before: 'target' });
  });

  it('исчезнувшая из порядка строка при броске после неё ведёт в конец', () => {
    // Ловит асимметричный stale-state, который раньше мог отправить канал в начало группы.
    assert.deepEqual(dropHintForRow({
      draggedId: 'a',
      targetId: 'missing',
      targetCat: null,
      after: true,
      orderedIds: ['a', 'b'],
    }), { cat: null, before: null });
  });
});

describe('перестановка каналов в сайдбаре', () => {
  it('канал переносится вверх с плотным сдвигом соседей', () => {
    // Ловит конфликт позиций после вставки перед первым каналом категории.
    assert.deepEqual(computeReorder([row('a', 0), row('b', 1), row('c', 2)], 'c', 'source', 'a'), [
      { id: 'c', categoryId: 'source', position: 0 },
      { id: 'a', categoryId: 'source', position: 1 },
      { id: 'b', categoryId: 'source', position: 2 },
    ]);
  });

  it('канал переносится вниз без лишнего обновления неизменившегося хвоста', () => {
    // Ловит отправку полного списка вместо только реально изменившихся строк.
    assert.deepEqual(computeReorder([row('a', 0), row('b', 1), row('c', 2)], 'a', 'source', 'c'), [
      { id: 'b', categoryId: 'source', position: 0 },
      { id: 'a', categoryId: 'source', position: 1 },
    ]);
  });

  it('beforeId null переносит канал в конец', () => {
    // Ловит трактовку null как начало категории вместо её хвоста.
    assert.deepEqual(computeReorder([row('a', 0), row('b', 1), row('c', 2)], 'a', 'source', null), [
      { id: 'b', categoryId: 'source', position: 0 },
      { id: 'c', categoryId: 'source', position: 1 },
      { id: 'a', categoryId: 'source', position: 2 },
    ]);
  });

  it('бросок перед прежним соседом остаётся no-op', () => {
    // Ловит двойной учёт dragged-канала, который сдвигал индекс вставки на единицу.
    assert.deepEqual(computeReorder([row('a', 0), row('b', 1), row('c', 2)], 'b', 'source', 'c'), []);
  });

  it('неизвестный dragId безопасно даёт пустой план', () => {
    // Ловит исключение или случайную перестановку при устаревшем id из drag-состояния.
    assert.deepEqual(computeReorder([row('a', 0)], 'missing', 'source', null), []);
  });

  it('между категориями обновляются цель и уплотнённый источник', () => {
    // Ловит дыры в исходной категории, из-за которых следующая вставка попадает не перед соседом.
    const all = [
      row('s1', 0),
      row('s2', 1),
      row('s3', 2),
      row('t1', 0, 'target'),
      row('t2', 1, 'target'),
    ];
    assert.deepEqual(computeReorder(all, 's2', 'target', 't2'), [
      { id: 's2', categoryId: 'target', position: 1 },
      { id: 't2', categoryId: 'target', position: 2 },
      { id: 's3', categoryId: 'source', position: 1 },
    ]);
  });

  it('канал можно перенести из категории в некатегоризованный корень', () => {
    // Ловит смешение null и undefined при выборе корневой группы каналов.
    assert.deepEqual(computeReorder([row('inside', 0), row('loose', 0, null)], 'inside', null, null), [
      { id: 'inside', categoryId: null, position: 1 },
    ]);
  });

  it('устаревший beforeId трактуется как вставка в конец', () => {
    // Ловит потерю drag-операции, если целевой сосед исчез между началом и отпусканием мыши.
    assert.deepEqual(computeReorder([row('a', 0), row('b', 1), row('c', 2)], 'a', 'source', 'missing'), [
      { id: 'b', categoryId: 'source', position: 0 },
      { id: 'c', categoryId: 'source', position: 1 },
      { id: 'a', categoryId: 'source', position: 2 },
    ]);
  });
});

describe('rowClickOpensCard', () => {
  it('обычный клик открывает карточку', () => {
    assert.equal(rowClickOpensCard({ altKey: false, afterDrag: false }), true);
  });

  it('Alt+клик НЕ открывает — этот жест занят «типнуть»', () => {
    assert.equal(rowClickOpensCard({ altKey: true, afterDrag: false }), false);
  });

  it('клик ПОСЛЕ перетаскивания НЕ открывает', () => {
    // Замерено: строка держит setPointerCapture, поэтому click прилетает ей и после протяжки.
    // Без этого условия карточка вылезала бы на каждый перенос участника модератором.
    assert.equal(rowClickOpensCard({ altKey: false, afterDrag: true }), false);
  });

  it('оба условия сразу тоже закрыты', () => {
    assert.equal(rowClickOpensCard({ altKey: true, afterDrag: true }), false);
  });
});
