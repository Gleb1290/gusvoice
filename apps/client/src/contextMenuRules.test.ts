import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isEditableTag, keepNativeMenu } from './contextMenuRules.js';

const target = (o: Partial<Parameters<typeof keepNativeMenu>[0]> = {}) => ({
  editable: false,
  hasSelection: false,
  inLink: false,
  savableMedia: false,
  ...o,
});

/**
 * Правила родного меню (#75).
 *
 * Тут важнее обычного парность: «погасили везде» — ровно та ошибка, из-за которой в приложениях
 * пропадает «Вставить», и замечают её не сразу, а когда человек уже решил, что мышью вставить нельзя.
 */
describe('когда оставляем меню браузера', () => {
  it('в поле ввода — оставляем, иначе пропадёт «Вставить»', () => {
    assert.equal(keepNativeMenu(target({ editable: true })), true);
  });

  it('при выделенном тексте — оставляем ради «Копировать»', () => {
    assert.equal(keepNativeMenu(target({ hasSelection: true })), true);
  });

  it('внутри ссылки — оставляем ради «Копировать адрес»', () => {
    assert.equal(keepNativeMenu(target({ inLink: true })), true);
  });

  it('на медиа-контенте чата — оставляем ради «Сохранить»', () => {
    assert.equal(keepNativeMenu(target({ savableMedia: true })), true);
  });
});

describe('когда гасим', () => {
  it('обычный элемент интерфейса — гасим', () => {
    // Ради этого всё и затевалось: «Печать» и «Отправить вкладку» в приложении неуместны.
    assert.equal(keepNativeMenu(target()), false);
  });

  it('🔴 аватар — тоже <img>, но НЕ помечен контентом → гасим', () => {
    // Регрессия на репорт с живого: правый клик по аватару в рейле и по своему аватару внизу
    // открывал браузерное меню («Сохранить изображение», «Отправить вкладку на устройство»).
    // Тег `img` больше не решает — решает маркер `data-ctxsave`, которого у аватара нет.
    assert.equal(keepNativeMenu(target({ savableMedia: false })), false);
  });

  it('признак ставит вызывающий, а не тег: аватар гасим, вложение оставляем', () => {
    assert.equal(keepNativeMenu(target({ savableMedia: false })), false);
    assert.equal(keepNativeMenu(target({ savableMedia: true })), true);
  });
});

describe('распознавание полей ввода', () => {
  it('input и textarea — поля', () => {
    assert.equal(isEditableTag('INPUT'), true);
    assert.equal(isEditableTag('textarea'), true);
    assert.equal(isEditableTag('input', 'text'), true);
  });

  it('текстовые типы input — поля', () => {
    for (const type of ['text', 'search', 'url', 'tel', 'email', 'password', 'number']) {
      assert.equal(isEditableTag('input', type), true, type);
    }
  });

  it('🔴 ползунок и флажки — НЕ поля', () => {
    // Регрессия на репорт с живого: правый клик по ползунку громкости стрима открывал браузерное меню
    // («Печать», «Отправить вкладку на устройства»). `range` — это <input>, но печатать в него
    // нечего, и «Вставить» там бессмысленно.
    for (const type of ['range', 'checkbox', 'radio', 'button', 'submit', 'color', 'file']) {
      assert.equal(isEditableTag('input', type), false, type);
    }
  });

  it('остальное — нет', () => {
    assert.equal(isEditableTag('div'), false);
    assert.equal(isEditableTag('select'), false);
    // img больше не «поле» и сам по себе меню не спасает — это и есть суть фикса аватаров.
    assert.equal(isEditableTag('img'), false);
  });
});
