import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SEARCH_FROM,
  filterOptions,
  groupOptions,
  hasValue,
  initialHighlight,
  matchOption,
  moveHighlight,
  shouldSearch,
  triggerTextOf,
  type SelectOption,
} from './selectRules.js';

const options: SelectOption[] = [
  { value: 'none', label: 'Без роли' },
  { value: 'one', label: 'Первый', group: 'Роли', disabled: true },
  { value: 'two', label: 'Ещё один', hint: 'Микрофон системы', group: 'Роли' },
];

describe('правила списка выбора', () => {
  it('поиск появляется ровно с восьми строк', () => {
    // Ловит ошибку на продуктовой границе длинного списка устройств.
    assert.equal(shouldSearch(SEARCH_FROM - 1), false);
    assert.equal(shouldSearch(SEARCH_FROM), true);
  });

  it('поиск нечувствителен к регистру, пробелам и различию е/ё', () => {
    // Ловит невидимый отказ найти «ещё», когда человек набрал обычную «е».
    assert.equal(matchOption(options[2]!, '  ЕЩЕ  '), true);
  });

  it('поиск смотрит и вторую строку, а пустой запрос сохраняет исходный массив', () => {
    // Ловит невозможность различить одинаковые названия устройств по подписи.
    assert.deepEqual(filterOptions(options, 'системы'), [options[2]]);
    assert.strictEqual(filterOptions(options, '  '), options);
  });

  it('соседние одинаковые группы объединяются, безымянная остаётся первой', () => {
    // Ловит перестановку строки «без категории» под именованный заголовок.
    assert.deepEqual(groupOptions(options), [
      { group: undefined, items: [options[0]] },
      { group: 'Роли', items: [options[1], options[2]] },
    ]);
  });

  it('клавиатура пропускает disabled и заворачивается по кругу', () => {
    // Ловит подсветку строки, которую всё равно нельзя выбрать.
    assert.equal(moveHighlight(options, 0, 1), 2);
    assert.equal(moveHighlight(options, 0, -1), 2);
  });

  it('если выбирать нечего, подсветка остаётся на прежнем месте', () => {
    // Ловит бесконечный цикл или индекс несуществующей строки в полностью закрытом списке.
    assert.equal(moveHighlight([{ value: 'x', label: 'X', disabled: true }], 0, 1), 0);
    assert.equal(moveHighlight([], 0, 1), -1);
  });

  it('стартовая подсветка не встаёт на disabled выбранное значение', () => {
    // Ловит обещание выбора недоступной строки при открытии списка.
    assert.equal(initialHighlight(options, 'one'), 0);
    assert.equal(initialHighlight(options, 'two'), 2);
  });

  it('триггер показывает метку значения либо placeholder', () => {
    // Ловит сырой value в кнопке и ложный признак выбранного значения.
    assert.equal(triggerTextOf(options, 'two', 'Выберите'), 'Ещё один');
    assert.equal(triggerTextOf(options, 'missing', 'Выберите'), 'Выберите');
    assert.equal(hasValue(options, 'two'), true);
    assert.equal(hasValue(options, 'missing'), false);
  });
});
