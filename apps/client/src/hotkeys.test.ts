import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  comboFromEvent,
  comboFromMouse,
  comboToKeyPacked,
  formatCombo,
  isMouseCombo,
  matchCombo,
  matchMouseCombo,
  mouseButtonOf,
  pttKeyVk,
} from './hotkeys.js';

const key = (code: string, modifiers: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers }) as KeyboardEvent;
const mouse = (button: number): MouseEvent => ({ button }) as MouseEvent;

describe('нормализация горячих клавиш', () => {
  it('нажатие голого модификатора не завершает захват сочетания', () => {
    // Ловит сохранение бесполезной привязки до того, как пользователь нажал основную клавишу.
    for (const code of ['ControlLeft', 'ControlRight', 'ShiftLeft', 'AltRight', 'MetaLeft']) {
      assert.equal(comboFromEvent(key(code)), null);
    }
  });

  it('модификаторы записываются в стабильном порядке вместе с физическим code', () => {
    // Ловит разные строки для одного сочетания и зависимость бинда от раскладки клавиатуры.
    assert.equal(
      comboFromEvent(key('KeyM', { ctrlKey: true, altKey: true, shiftKey: true, metaKey: true })),
      'Ctrl+Alt+Shift+Meta+KeyM',
    );
  });

  it('совпадение требует ту же клавишу и ровно тот же набор модификаторов', () => {
    // Ловит срабатывание Ctrl+M от обычного M или от Ctrl+Shift+M.
    assert.equal(matchCombo(key('KeyM', { ctrlKey: true }), 'Ctrl+KeyM'), true);
    assert.equal(matchCombo(key('KeyM'), 'Ctrl+KeyM'), false);
    assert.equal(matchCombo(key('KeyM', { ctrlKey: true, shiftKey: true }), 'Ctrl+KeyM'), false);
    assert.equal(matchCombo(key('KeyM'), ''), false);
  });

  it('левая кнопка мыши не захватывается, а остальные получают свой номер', () => {
    // Ловит блокировку обычного клика интерфейса при назначении push-to-talk.
    assert.equal(comboFromMouse(mouse(0)), null);
    assert.equal(comboFromMouse(mouse(1)), 'Mouse1');
    assert.equal(comboFromMouse(mouse(4)), 'Mouse4');
  });

  it('мышиное сочетание совпадает только с той же кнопкой', () => {
    // Ловит открытие микрофона другой боковой кнопкой или пустой привязкой.
    assert.equal(matchMouseCombo(mouse(3), 'Mouse3'), true);
    assert.equal(matchMouseCombo(mouse(4), 'Mouse3'), false);
    assert.equal(matchMouseCombo(mouse(3), ''), false);
  });

  it('тип и номер кнопки извлекаются из последней части сочетания', () => {
    // Ловит расхождение между определением mouse-комбо и номером для нативного PTT-хука.
    assert.equal(isMouseCombo('Mouse2'), true);
    assert.equal(isMouseCombo('Ctrl+KeyM'), false);
    assert.equal(mouseButtonOf('Mouse4'), 4);
    assert.equal(mouseButtonOf('KeyM'), null);
    assert.equal(mouseButtonOf('MouseX'), null);
  });
});

describe('кодирование клавиш для нативного Windows-хука', () => {
  it('PTT переводит буквы, цифры, numpad, F-клавиши и именованные клавиши в VK', () => {
    // Ловит несовпадение кодов браузера и Rust-хука, при котором PTT работает лишь в фокусе окна.
    assert.deepEqual(
      ['KeyM', 'Digit5', 'Numpad0', 'Numpad9', 'F1', 'F24', 'Space', 'NumpadAdd'].map(pttKeyVk),
      [0x4d, 0x35, 0x60, 0x69, 0x70, 0x87, 0x20, 0x6b],
    );
  });

  it('PTT отклоняет пустой, мышиный, составной и неизвестный бинд', () => {
    // Ловит передачу случайного VK в глобальный хук вместо безопасного отключения бинда.
    for (const combo of ['', 'Mouse3', 'Ctrl+KeyM', 'MediaPlayPause']) assert.equal(pttKeyVk(combo), null);
  });

  it('составное сочетание упаковывает все биты модификаторов и VK', () => {
    // Ловит перепутанные флаги Ctrl/Alt/Shift/Meta между TypeScript и Rust.
    assert.equal(comboToKeyPacked('Ctrl+Alt+Shift+Meta+KeyM'), (15 << 16) | 0x4d);
  });

  it('порядок модификаторов не меняет нативное значение', () => {
    // Ловит зависимость нативной регистрации от порядка частей сохранённой строки.
    assert.equal(comboToKeyPacked('Alt+Ctrl+KeyM'), comboToKeyPacked('Ctrl+Alt+KeyM'));
  });

  it('мышь, пустой и неизвестный code не регистрируются как клавиатурный хоткей', () => {
    // Ловит конфликт двух нативных путей и регистрацию нулевого либо неверного VK.
    assert.equal(comboToKeyPacked('Mouse3'), null);
    assert.equal(comboToKeyPacked(''), null);
    assert.equal(comboToKeyPacked('MediaPlayPause'), null);
  });
});

describe('подписи горячих клавиш', () => {
  it('пустые, клавиатурные, стрелочные и мышиные бинды читаемо подписываются', () => {
    // Ловит сохранённый рабочий бинд, который UI показывает не той клавишей.
    assert.equal(formatCombo(''), 'Не задано');
    assert.equal(formatCombo('Ctrl+KeyM'), 'Ctrl + M');
    assert.equal(formatCombo('ArrowUp'), '↑');
    assert.equal(formatCombo('Mouse3'), 'Боковая 1');
    assert.equal(formatCombo('Mouse8'), 'Мышь 8');
  });
});
