import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  hasUnseen,
  markChangedSeen,
  markGroupSeen,
  seedSeenOnce,
  seenChangedPrints,
  seenGroups,
  unseenOf,
} from './settingsSeen.js';

let values = new Map<string, string>();
let writes = 0;
beforeEach(() => {
  values = new Map(); writes = 0;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { writes++; values.set(key, value); },
  } });
});

describe('просмотренные группы настроек', () => {
  it('первый запуск считает все существующие группы уже просмотренными', () => {
    // Ловит шум из кружков у всех старых настроек сразу после обновления.
    seedSeenOnce(['sound', 'look', 'sound']);
    assert.deepEqual([...seenGroups()].sort(), ['look', 'sound']);
    assert.equal(hasUnseen(['sound', 'look']), false);
  });

  it('повторный засев не проглатывает новую группу', () => {
    // Ловит исчезновение настоящей отметки «новое» при каждом запуске приложения.
    seedSeenOnce(['sound']);
    seedSeenOnce(['sound', 'future']);
    assert.equal(hasUnseen(['sound', 'future']), true);
  });

  it('просмотр гасит новую группу и не пишет повторно на горячем пути', () => {
    // Ловит лишние записи хранилища при каждом событии прокрутки.
    seedSeenOnce(['sound']);
    markGroupSeen('future');
    const afterFirst = writes;
    markGroupSeen('future');
    assert.equal(writes, afterFirst);
    assert.equal(hasUnseen(['sound', 'future']), false);
  });

  it('чистое правило сохраняет порядок и повторы входного списка', () => {
    // Ловит перестройку навигации ради вычисления отметок.
    assert.deepEqual(unseenOf(['a', 'b', 'a'], new Set(['b'])), ['a', 'a']);
  });

  it('битая запись безопасно считается незасеянной', () => {
    // Ловит падение настроек из-за повреждённого localStorage.
    values.set('gv_settings_seen', '{bad');
    assert.deepEqual([...seenGroups()], []);
    assert.equal(hasUnseen(['sound']), true);
  });

  it('просмотр изменённых групп сливается с прежними, а не затирает их', () => {
    // Ловит возвращение точки в одной группе после просмотра другой.
    markChangedSeen({ sound: 'a' });
    markChangedSeen({ look: 'b' });
    assert.deepEqual(seenChangedPrints(), { sound: 'a', look: 'b' });
  });

  it('битый или неоднородный набор увиденных отпечатков очищается безопасно', () => {
    // Ловит падение настроек и протекание нестрокового значения в сравнение точек.
    values.set('gv_settings_changed_seen', '{bad');
    assert.deepEqual(seenChangedPrints(), {});
    values.set('gv_settings_changed_seen', JSON.stringify({ sound: 'ok', look: 42 }));
    assert.deepEqual(seenChangedPrints(), { sound: 'ok' });
  });
});
