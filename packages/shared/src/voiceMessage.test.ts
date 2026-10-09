import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attachmentWords, formatDuration, isVoiceMessage, peaksFrom, VOICE_MAX_MS, WAVEFORM_BUCKETS } from './voiceMessage.js';

it('R125 предел голосового равен тридцати минутам, а не прежним пяти', () => {
  // Общий предел согласует таймер рекордера и приём вложения без потери длинной записи.
  assert.equal(VOICE_MAX_MS, 30 * 60 * 1000);
});

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

it('слова вложения не добавляют длительность или префикс файла, кружок отличается от видео', () => {
  // Один общий словарь не даёт цитате и списку бесед расходиться после смены формата превью.
  const cases: [Parameters<typeof attachmentWords>[0], string][] = [
    [{ kind: 'voice' }, 'Голосовое сообщение'],
    [{ kind: 'file', video: true }, 'Видео'],
    [{ kind: 'file', video: true, round: true }, 'Видеосообщение'],
    [{ kind: 'file', name: 'report.pdf' }, 'report.pdf'],
    [{ kind: 'file', name: '  мой\n\t файл.pdf  ' }, 'мой файл.pdf'],
    [{ kind: 'file', name: '' }, 'Файл'],
    [{ kind: 'file', name: ' \n ' }, 'Файл'],
    [{ kind: 'file', name: null }, 'Файл'],
    [{ kind: 'file' }, 'Файл'],
    [{ kind: 'file', round: true, name: 'audio.ogg' }, 'audio.ogg'],
  ];
  const check = (words: typeof attachmentWords) => {
    for (const [input, expected] of cases) assert.equal(words(input), expected);
  };
  check(attachmentWords);
  const source = attachmentWords.toString().replace(/\\u([0-9a-f]{4})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  // nosemgrep: gv-no-eval — тест исполняет свой attachmentWords.toString(), нормализованный регуляркой, и фиксированные мутанты; чужого ввода нет.
  const load = (s: string): typeof attachmentWords => new Function(`return (${s})`)(); // nosemgrep: gv-no-eval
  check(load(source));
  for (const [from, to] of [
    ['Голосовое сообщение', 'Голосовое сообщение · 0:42'],
    ['f.round?', 'false?'],
    ['?flat:', '?"Файл: "+flat:'],
  ]) {
    assert.ok(source.includes(from), 'якорь словарного мутанта найден');
    assert.throws(() => check(load(source.replace(from, to))), assert.AssertionError);
  }
});

it('имя файла ровно в 200 знаков сохраняется, длиннее обрезается целыми кодовыми точками', () => {
  // Ловит лишнее многоточие на границе и половину эмодзи в конце короткого превью.
  const check = (words: typeof attachmentWords) => {
    assert.equal(words({ kind: 'file', name: 'я'.repeat(200) }), 'я'.repeat(200));
    assert.equal(words({ kind: 'file', name: 'я'.repeat(201) }), 'я'.repeat(199) + '…');
    assert.equal(words({ kind: 'file', name: 'x'.repeat(300) }), 'x'.repeat(199) + '…');
    assert.equal(words({ kind: 'file', name: '🪿'.repeat(201) }), '🪿'.repeat(199) + '…');
  };
  check(attachmentWords);
  const source = attachmentWords.toString();
  // nosemgrep: gv-no-eval — тест исполняет свой attachmentWords.toString() с фиксированными граничными мутантами; чужого ввода нет.
  const load = (s: string): typeof attachmentWords => new Function(`return (${s})`)(); // nosemgrep: gv-no-eval
  check(load(source));
  for (const [from, to] of [['chars.length<=200', 'chars.length<200'], ['[...flat]', 'flat.split("")']]) {
    assert.ok(source.includes(from), 'якорь граничного мутанта найден');
    assert.throws(() => check(load(source.replace(from, to))), assert.AssertionError);
  }
});
