import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { attachmentWords, formatDuration, isMusicFile, isVoiceMessage, musicSubtitle, musicTitle, peaksFrom, VOICE_MAX_MS, WAVEFORM_BUCKETS } from './voiceMessage.js';

const musicRulesSource = readFileSync(new URL('./voiceMessage.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function musicRules(raw: string): typeof import('./voiceMessage.js') {
  const module = { exports: {} };
  // Правило без зависимостей исполняется целиком, а не вырезанной копией функции.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports });
  return module.exports as typeof import('./voiceMessage.js');
}
function musicChange(anchor: string, replacement: string): string {
  assert.equal(musicRulesSource.split(anchor).length - 1, 1, 'R230 единственный якорь музыкального правила');
  return musicRulesSource.replace(anchor, replacement);
}
type MusicCheck = typeof isMusicFile;
function noVoiceAsMusic(check: MusicCheck) {
  assert.equal(check({ contentType: 'audio/wav', name: 'Голос.wav', waveform: [1, 30] }), false,
    'R230 голосовое: огибающая оставляет собственный плеер');
  assert.equal(check({ contentType: 'audio/wav', name: 'Музыка.wav', waveform: [] }), true);
}
function noUnsupportedMusic(check: MusicCheck) {
  for (const contentType of ['audio/amr', 'audio/x-ms-wma', 'audio/aiff', 'audio/midi', 'audio/unknown'])
    assert.equal(check({ contentType, name: 'Песня.mp3' }), false, 'R230 формат: расширение не отменяет известный неподдерживаемый MIME');
  assert.equal(check({ contentType: 'audio/mpeg', name: 'Песня.mp3' }), true);
}
function musicByExtension(check: MusicCheck) {
  for (const contentType of ['', 'application/octet-stream', 'binary/octet-stream', 'application/x-unknown'])
    for (const extension of ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav', 'weba'])
      assert.equal(check({ contentType, name: `Трек.${extension.toUpperCase()}` }), true,
        'R230 расширение: неизвестный MIME не прячет воспроизводимый файл');
}

it('R230 все воспроизводимые MIME принимаются с параметрами, пробелами и верхним регистром', () => {
  // Класс ошибки: допустимый MIME-синоним или параметры кодека оставляют звук обычной скрепкой.
  for (const type of ['audio/mpeg', 'audio/mp3', 'audio/mpeg3', 'audio/x-mpeg-3', 'audio/mp4', 'audio/m4a', 'audio/x-m4a',
    'audio/aac', 'audio/x-aac', 'audio/aacp', 'audio/ogg', 'application/ogg', 'audio/opus', 'audio/flac', 'audio/x-flac',
    'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'audio/x-pn-wav', 'audio/webm']) {
    for (const contentType of [type, ` ${type.toUpperCase()} ; codecs=opus`])
      assert.equal(isMusicFile({ contentType, name: 'Без расширения' }), true, contentType);
  }
});
it('R230 неизвестный MIME принимает все расширения воспроизводимого звука, а не только mp3', () => {
  // Класс ошибки: хранилище выдаёт octet-stream, и исправный музыкальный файл исчезает из плеера.
  musicByExtension(isMusicFile);
  assert.equal(isMusicFile({ contentType: ' APPLICATION/OCTET-STREAM ; charset=binary', name: 'Трек.WAV' }), true);
});
it('R230 неподдерживаемые аудиоформаты остаются файлами даже с обманчивым расширением', () => {
  // Класс ошибки: проверка любого audio/* предлагает кнопку запуска заведомо неиграющего формата.
  noUnsupportedMusic(isMusicFile);
  for (const name of ['Музыка.amr', 'Музыка.wma', 'Музыка', 'Музыка.', '.mp3', '...'])
    assert.equal(isMusicFile({ contentType: 'application/octet-stream', name }), false, name);
});
it('R230 голосовое с огибающей и видеокружок не становятся музыкой, пустая огибающая не мешает файлу', () => {
  // Класс ошибки: музыкальный тип перехватывает флаги прослушано/один раз у другого вида вложения.
  noVoiceAsMusic(isMusicFile);
  assert.equal(isMusicFile({ contentType: 'audio/wav', name: 'Трек.wav', waveform: null }), true);
  assert.equal(isMusicFile({ contentType: 'video/mp4', name: 'Кружок.wav', round: true }), false);
  assert.equal(isMusicFile({ contentType: 'image/png', name: 'Обложка.mp3' }), false);
});
it('R230 название музыки убирает только последнее расширение и сохраняет непустое имя из точек', () => {
  // Класс ошибки: точка в названии либо скрытое имя даёт пустой заголовок системного плеера.
  for (const [name, expected] of [['Ночной гусь.wav', 'Ночной гусь'], ['Концерт.live.FLAC', 'Концерт.live'],
    ['  Без расширения  ', 'Без расширения'], ['.mp3', '.mp3'], ['...', '..'], ['.', '.'], ['  .mp3', '  .mp3'], ['', '']])
    assert.equal(musicTitle(name), expected);
});
it('R230 подпись до старта показывает размер либо известную длительность, но не фиктивное 0:00', () => {
  // Класс ошибки: неизвестные метаданные выглядят как файл нулевой длины или портят подпись NaN.
  for (const durationMs of [0, -1, NaN, Infinity])
    assert.equal(musicSubtitle({ atMs: 0, durationMs, started: false, sizeLabel: 'размер' }), 'размер');
  assert.equal(musicSubtitle({ atMs: 0, durationMs: 225_000, started: false, sizeLabel: 'размер' }), '3:45 · размер');
});
it('R230 запущенная и приостановленная музыка показывает позицию вместо размера, даже без длительности', () => {
  // Класс ошибки: позиция теряется на паузе или неизвестная длительность делает дробь с нулевым знаменателем.
  assert.equal(musicSubtitle({ atMs: 12_000, durationMs: 225_000, started: true, sizeLabel: 'размер' }), '0:12 / 3:45');
  assert.equal(musicSubtitle({ atMs: 12_000, durationMs: 0, started: true, sizeLabel: 'размер' }), '0:12');
  assert.equal(musicSubtitle({ atMs: 0, durationMs: 225_000, started: true, sizeLabel: 'размер' }), '0:00 / 3:45');
});
for (const [title, check, anchor, replacement, prefix, actual, expected] of [
  ['потеря защиты голосового', noVoiceAsMusic, 'if (isVoiceMessage(a) || isRoundVideo(a)) return false;', 'if (isRoundVideo(a)) return false;', 'R230 голосовое:', true, false],
  ['приём любого audio', noUnsupportedMusic, 'if (PLAYABLE_TYPES.has(type)) return true;', "if (type.startsWith('audio/')) return true;", 'R230 формат:', true, false],
  ['потеря расширений', musicByExtension, 'if (UNKNOWN_TYPES.has(type)) return PLAYABLE_EXT.has(extOf(a.name));', '', 'R230 расширение:', false, true],
] as const) it(`R230 контрфакт ${title} обнаруживается настоящим модулем правил`, () => {
  // Класс ошибки: зелёный положительный пример не доказывает отсутствие ложной классификации.
  check(isMusicFile); check(musicRules(musicRulesSource).isMusicFile);
  assert.throws(() => check(musicRules(musicChange(anchor, replacement)).isMusicFile), (e: unknown) =>
    e instanceof assert.AssertionError && e.message.startsWith(prefix) && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected);
});

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
