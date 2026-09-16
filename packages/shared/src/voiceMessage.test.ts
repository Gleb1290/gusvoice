import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatDuration, isVoiceMessage, peaksFrom, WAVEFORM_BUCKETS } from './voiceMessage.js';

describe('огибающая', () => {
  it('длина всегда равна числу корзин', () => {
    assert.equal(peaksFrom(new Float32Array(1000)).length, WAVEFORM_BUCKETS);
    assert.equal(peaksFrom(new Float32Array(7), 4).length, 4);
  });

  it('тишина даёт нули, а не мусор', () => {
    assert.deepEqual(peaksFrom(new Float32Array(100), 4), [0, 0, 0, 0]);
  });

  it('пустой вход не роняет и даёт нули', () => {
    assert.deepEqual(peaksFrom(new Float32Array(0), 3), [0, 0, 0]);
  });

  it('нормируется на собственный максимум — тихая запись видна', () => {
    // Все отсчёты в сто раз тише, но рисунок обязан остаться тем же.
    const loud = peaksFrom(Float32Array.from([1, 0.5, 0.25, 0]), 4);
    const quiet = peaksFrom(Float32Array.from([0.01, 0.005, 0.0025, 0]), 4);
    assert.deepEqual(quiet, loud);
    assert.equal(loud[0], 100);
  });

  it('берёт максимум корзины, а не среднее', () => {
    // Речь с паузами: одиночный всплеск в корзине обязан её поднять.
    const out = peaksFrom(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 0]), 2);
    assert.equal(out[0], 100);
    assert.equal(out[1], 0);
  });

  it('отрицательные отсчёты считаются по модулю', () => {
    assert.deepEqual(peaksFrom(Float32Array.from([-1, 0]), 1), [100]);
  });

  it('корзин больше, чем отсчётов — всё равно не падает', () => {
    const out = peaksFrom(Float32Array.from([1, 0]), 8);
    assert.equal(out.length, 8);
    assert.equal(Math.max(...out), 100);
  });

  it('ноль корзин даёт пустой список', () => {
    assert.deepEqual(peaksFrom(Float32Array.from([1]), 0), []);
  });

  it('значения всегда целые в пределах 0..100', () => {
    const out = peaksFrom(Float32Array.from([0.3, -0.9, 0.15, 0.62, 0.01]), 5);
    for (const v of out) {
      assert.equal(Number.isInteger(v), true);
      assert.equal(v >= 0 && v <= 100, true);
    }
  });
});

describe('длительность', () => {
  it('секунды дополняются нулём', () => {
    assert.equal(formatDuration(7000), '0:07');
  });

  it('минуты и секунды', () => {
    assert.equal(formatDuration(83_000), '1:23');
  });

  it('ноль и отрицательное дают 0:00', () => {
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(-5), '0:00');
  });

  it('округляется к ближайшей секунде', () => {
    assert.equal(formatDuration(1600), '0:02');
  });

  it('граница округления в полсекунды проверена с обеих сторон', () => {
    assert.equal(formatDuration(1499), '0:01');
    assert.equal(formatDuration(1500), '0:02');
  });
});

describe('признак голосового', () => {
  it('аудио с огибающей — голосовое', () => {
    assert.equal(isVoiceMessage({ waveform: [1, 2], contentType: 'audio/webm' }), true);
  });

  it('аудио с нулевой огибающей остаётся голосовым — тишина тоже запись', () => {
    assert.equal(isVoiceMessage({ waveform: [0, 0], contentType: 'audio/webm' }), true);
  });

  it('аудио БЕЗ огибающей — обычный прикреплённый файл', () => {
    // Скинутый mp3 остаётся файлом: полоски у него нет, и плеера он не заслуживает.
    assert.equal(isVoiceMessage({ contentType: 'audio/mpeg' }), false);
    assert.equal(isVoiceMessage({ waveform: [], contentType: 'audio/mpeg' }), false);
    assert.equal(isVoiceMessage({ waveform: null, contentType: 'audio/mpeg' }), false);
  });

  it('картинка с подделанной огибающей голосовым не считается', () => {
    assert.equal(isVoiceMessage({ waveform: [1, 2], contentType: 'image/png' }), false);
  });
});
