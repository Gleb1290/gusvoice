import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isBlockedBrowserShortcut } from './browserShortcuts.js';

const combo = (o: Partial<Parameters<typeof isBlockedBrowserShortcut>[0]> = {}) => ({
  key: 'p',
  ctrlOrMeta: true,
  shift: false,
  alt: false,
  ...o,
});

describe('isBlockedBrowserShortcut', () => {
  it('гасит то, на чём поймали тестера: печать и загрузки', () => {
    assert.equal(isBlockedBrowserShortcut(combo({ key: 'p' })), true);
    assert.equal(isBlockedBrowserShortcut(combo({ key: 'j' })), true);
  });

  it('гасит остальные панели браузера — их не перечисляли, они закрыты правилом', () => {
    // сохранить, открыть, исходник, история, закладка, коллекции, избранное, адресная строка, выход
    for (const key of ['s', 'o', 'u', 'h', 'd', 'e', 'b', 'l', 'k', 'm', 'g', 'q']) {
      assert.equal(isBlockedBrowserShortcut(combo({ key })), true, key);
    }
  });

  it('гасит приватное окно (Ctrl+Shift+P) — Shift не делает сочетание безопасным', () => {
    assert.equal(isBlockedBrowserShortcut(combo({ key: 'P', shift: true })), true);
  });

  it('гасит «удалить данные о просмотре» — оно вынесет localStorage вместе с сессией', () => {
    assert.equal(isBlockedBrowserShortcut(combo({ key: 'Delete', shift: true })), true);
  });

  it('гасит F1 и F7 — справка браузера и caret browsing, обе жмут случайно', () => {
    assert.equal(isBlockedBrowserShortcut(combo({ key: 'F1', ctrlOrMeta: false })), true);
    assert.equal(isBlockedBrowserShortcut(combo({ key: 'F7', ctrlOrMeta: false })), true);
  });

  it('НЕ трогает буфер обмена и правку — иначе в десктопе не вставить мышью', () => {
    for (const key of ['c', 'v', 'x', 'a', 'z', 'y']) {
      assert.equal(isBlockedBrowserShortcut(combo({ key })), false, key);
    }
    assert.equal(isBlockedBrowserShortcut(combo({ key: 'v', shift: true })), false); // вставить без форматирования
  });

  it('НЕ трогает перезагрузку — ею оживляют подвисшее окно', () => {
    assert.equal(isBlockedBrowserShortcut(combo({ key: 'r' })), false);
    assert.equal(isBlockedBrowserShortcut(combo({ key: 'r', shift: true })), false);
  });

  it('НЕ трогает Ctrl+F — это наш поиск по сообщениям, а в ЛС браузерный', () => {
    assert.equal(isBlockedBrowserShortcut(combo({ key: 'f' })), false);
  });

  it('НЕ трогает devtools — тестеру нужна консоль', () => {
    for (const key of ['i', 'j', 'c']) {
      assert.equal(isBlockedBrowserShortcut(combo({ key, shift: true })), false, key);
    }
  });

  it('НЕ трогает вкладки, окна и зум — это оболочка браузера, а не наша страница', () => {
    for (const key of ['t', 'n', 'w', '1', '9', '0', '-', '=', '+']) {
      assert.equal(isBlockedBrowserShortcut(combo({ key })), false, key);
    }
  });

  it('НЕ трогает клавиши ввода и навигации — там живут наши сочетания', () => {
    for (const key of ['Enter', 'ArrowUp', 'Tab', ' ', 'Escape', 'Backspace']) {
      assert.equal(isBlockedBrowserShortcut(combo({ key })), false, key);
    }
  });

  it('без Ctrl/Cmd обычная буква остаётся буквой — её печатают в поле ввода', () => {
    assert.equal(isBlockedBrowserShortcut(combo({ key: 'p', ctrlOrMeta: false })), false);
  });

  it('Ctrl+Alt+… не наше — там системные и игровые раскладки', () => {
    assert.equal(isBlockedBrowserShortcut(combo({ key: 'p', alt: true })), false);
  });
});
