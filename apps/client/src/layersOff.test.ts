import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { layersOffPlan } from './layersOff.js';

/**
 * 🔴 Пара к Rust-тесту `причины_выключения_слоя_названы_ровно_так_же_как_их_ждёт_клиент`.
 * Вместе они и есть весь межъязыковой контракт: строки задаёт `LayersOff::as_str()`, смысл им
 * придаёт этот модуль. Разбор Codex показал, что без такой пары перестановка `crash` и
 * `crash-final` в Rust превращала временный отказ в постоянный, не покраснив ни одного теста.
 */
describe('решение по выключенному слою качества', () => {
  it('🔴 одно падение НЕ трогает настройку', () => {
    // Суть починки #109: причина временная (обычно наш же баг), а расплачивался за постоянное
    // выключение весь канал — без второго слоя один зритель с потерями пульсирует картинку всем.
    const p = layersOffPlan('crash');
    assert.equal(p.persistOff, false);
    assert.match(p.text, /Следующий снова пойдёт двумя/);
  });

  it('старая видеокарта — выключаем насовсем', () => {
    // Свойство железа, а не случайность: тут постоянство честное.
    assert.equal(layersOffPlan('old-gpu').persistOff, true);
  });

  it('три падения подряд — тоже насовсем', () => {
    assert.equal(layersOffPlan('crash-final').persistOff, true);
  });

  it('две постоянные причины не путаются объяснениями', () => {
    // Ловит перестановку веток с одинаковым persistOff: железо не должно называться тремя падениями.
    assert.match(layersOffPlan('old-gpu').text, /видеокарт/);
    assert.doesNotMatch(layersOffPlan('old-gpu').text, /три раза/);
    assert.match(layersOffPlan('crash-final').text, /три раза/);
    assert.doesNotMatch(layersOffPlan('crash-final').text, /видеокарт/);
  });

  it('🔴 незнакомая причина считается ПОСТОЯННОЙ', () => {
    // Новая причина из Rust, ставшая временной по умолчанию, тихо вернула бы слой туда, где его
    // осознанно отобрали. Ошибиться в эту сторону дешевле.
    assert.equal(layersOffPlan('что-то новое').persistOff, true);
    assert.equal(layersOffPlan('').persistOff, true);
  });

  it('у каждой причины есть, что сказать человеку', () => {
    for (const r of ['crash', 'old-gpu', 'crash-final', 'неизвестно']) {
      const p = layersOffPlan(r);
      assert.ok(p.title.length > 0 && p.text.length > 0, `причина «${r}» молчит`);
    }
  });
});

describe('🔴 незнакомой причине — честный текст', () => {
  it('новое значение не получает чужое объяснение', () => {
    // Раньше в ветку по умолчанию падал и `crash-final`, и любая будущая причина — вместе с его
    // текстом. То есть приложение сообщало человеку выдуманный факт «падение три раза подряд»
    // о причине, которой оно не знает (поймал Codex).
    const unknown = layersOffPlan('какая-то новая причина');
    assert.equal(unknown.persistOff, true, 'осторожность сохраняется');
    assert.doesNotMatch(unknown.text, /три раза подряд/, 'но чужой факт не сообщаем');
  });

  it('а `crash-final` своё объяснение сохранил', () => {
    assert.match(layersOffPlan('crash-final').text, /три раза подряд/);
  });
});
