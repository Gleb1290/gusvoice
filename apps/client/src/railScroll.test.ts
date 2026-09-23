import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RAIL_EDGE_SLACK, railEdges, railScrollClass } from './railScroll.js';

describe('затухание прокручиваемого рейла', () => {
  it('короткий список не затухает даже при субпиксельном остатке', () => {
    // Ловит обрезание крайних иконок у большинства пользователей без реальной прокрутки.
    assert.deepEqual(railEdges({ scrollTop: 0, scrollHeight: 502, clientHeight: 500 }), { top: false, bottom: false });
  });

  it('в начале длинного списка затухает только низ', () => {
    // Ловит ложную тень над полностью видимой первой иконкой.
    assert.deepEqual(railEdges({ scrollTop: 0, scrollHeight: 800, clientHeight: 500 }), { top: false, bottom: true });
  });

  it('в середине затухают оба края, а на границе низа только верх', () => {
    // Ловит дребезг маски на двухпиксельном допуске нижней границы.
    assert.deepEqual(railEdges({ scrollTop: RAIL_EDGE_SLACK + 1, scrollHeight: 800, clientHeight: 500 }), { top: true, bottom: true });
    assert.deepEqual(railEdges({ scrollTop: 298, scrollHeight: 800, clientHeight: 500 }), { top: true, bottom: false });
  });

  it('класс содержит только признаки текущего состояния', () => {
    // Ловит залипание затухания или полосы после завершения прокрутки.
    assert.equal(railScrollClass({ top: true, bottom: false }, true), 'rail-scroll fade-top scrolling');
    assert.equal(railScrollClass({ top: false, bottom: false }, false), 'rail-scroll');
  });
});
