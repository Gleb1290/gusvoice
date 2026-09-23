import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { exprAutoFocus, getExprTab, setExprTab } from './ExprTabs.js';

let values = new Map<string, string>();
beforeEach(() => {
  values = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
  });
});

describe('память вкладки эмодзи и стикеров', () => {
  it('без сохранения открываются эмодзи, а сохранённые стикеры восстанавливаются', () => {
    // Ловит случайное открытие менее частой вкладки и потерю осознанного выбора человека.
    assert.equal(getExprTab(), 'emoji');
    setExprTab('stickers');
    assert.equal(getExprTab(), 'stickers');
  });

  it('любое неизвестное сохранённое значение безопасно возвращает эмодзи', () => {
    // Ловит пустой пикер после обновления формата localStorage.
    values.set('gv_expr_tab', 'future-tab');
    assert.equal(getExprTab(), 'emoji');
  });

  it('без нижних вкладок поиск получает автофокус даже на сенсорном экране', () => {
    // Ловит изменение прежнего поведения пикеров реакций и статуса.
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { matchMedia: () => ({ matches: true }) } });
    assert.equal(exprAutoFocus(undefined), true);
  });

  it('с вкладками сенсорный экран не поднимает клавиатуру, а мышь сохраняет автофокус', () => {
    // Ловит повторное перекрытие сетки экранной клавиатурой при смене вкладки.
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { matchMedia: () => ({ matches: true }) } });
    assert.equal(exprAutoFocus('tabs'), false);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { matchMedia: () => ({ matches: false }) } });
    assert.equal(exprAutoFocus('tabs'), true);
  });
});
