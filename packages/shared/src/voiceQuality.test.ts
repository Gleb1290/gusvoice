import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_VOICE_BITRATE,
  RED_OVERHEAD,
  VOICE_BITRATES,
  isVoiceBitrate,
  listenerKbps,
  voiceBitrateOf,
  voiceMaxBitrate,
} from './voiceQuality.js';

describe('допустимое качество голосового канала', () => {
  it('таблица пресетов, безопасное умолчание и RED-множитель остаются согласованными с UI', () => {
    // Ловит тихий возврат тяжёлого 128 кбит/с или неверную подпись трафика после смены констант.
    assert.deepEqual(VOICE_BITRATES, [24, 48, 64, 96, 128]);
    assert.equal(DEFAULT_VOICE_BITRATE, 64);
    assert.equal(RED_OVERHEAD, 2);
  });

  it('каждый объявленный пресет принимается серверным валидатором', () => {
    // Парный успешный путь не даёт UI предложить качество, которое сервер затем отвергнет.
    for (const bitrate of VOICE_BITRATES) assert.equal(isVoiceBitrate(bitrate), true);
  });

  it('числа вне списка и значения другого типа отклоняются', () => {
    // Ловит произвольный тяжёлый битрейт и мусор, который сломал бы LiveKit audioPreset.
    for (const value of [0, 23, 25, 127, 129, Number.NaN, Number.POSITIVE_INFINITY, '64', null, undefined]) {
      assert.equal(isVoiceBitrate(value), false);
    }
  });
});

describe('выбор битрейта канала', () => {
  it('каждый допустимый пресет возвращается без подмены', () => {
    // Ловит функцию, которая всегда навязывает default и игнорирует выбор владельца канала.
    for (const bitrate of VOICE_BITRATES) assert.equal(voiceBitrateOf(bitrate), bitrate);
  });

  it('null, ноль, NaN, строка и число вне списка безопасно падают на 64', () => {
    // Ловит передачу повреждённого значения в публикацию, из-за которой ломается голос всему каналу.
    const invalid: unknown[] = [null, undefined, 0, Number.NaN, '96', 510];
    for (const value of invalid) {
      assert.equal(voiceBitrateOf(value as number | null | undefined), DEFAULT_VOICE_BITRATE);
    }
  });

  it('LiveKit получает десятичные биты в секунду, включая fallback', () => {
    // Ловит соблазн умножить на 1024 и незаметно разойтись с числом, показанным пользователю.
    assert.equal(voiceMaxBitrate(96), 96_000);
    assert.equal(voiceMaxBitrate(null), 64_000);
  });
});

describe('оценка входящего трафика слушателя', () => {
  it('число говорящих умножается и на битрейт, и на двойную избыточность RED', () => {
    // Ловит опасное занижение подсказки ровно вдвое при расчёте без RED_OVERHEAD.
    assert.equal(listenerKbps(64, 3), 384);
  });

  it('ноль и отрицательное число говорящих дают нулевой трафик', () => {
    // Ловит отрицательную оценку в UI для единственного участника, где подставляется N−1.
    assert.equal(listenerKbps(128, 0), 0);
    assert.equal(listenerKbps(128, -1), 0);
  });

  it('мусорный битрейт использует безопасное умолчание и в оценке', () => {
    // Ловит расхождение между реально применённым fallback и подсказкой в настройках канала.
    assert.equal(listenerKbps(null, 2), DEFAULT_VOICE_BITRATE * RED_OVERHEAD * 2);
  });
});
