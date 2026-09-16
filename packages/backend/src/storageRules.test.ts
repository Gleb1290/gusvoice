import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  attachmentBlocked,
  attachmentExt,
  audioExt,
  BUCKET_RETRY,
  bucketRetryDelayMs,
  contentDisposition,
  isSupportedAudio,
  isSupportedImage,
  mediaExt,
  resolveAudioMime,
  urlBelongsToBucket,
} from './storageRules.js';

describe('пауза между попытками подготовить бакет', () => {
  it('первые восемь отказов дают удвоение от 2 до 256 секунд', () => {
    // Ловит сбитый номер попытки и линейную паузу вместо экспоненциальной.
    assert.deepEqual(
      Array.from({ length: 8 }, (_, index) => bucketRetryDelayMs(index + 1)),
      [2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000],
    );
  });

  it('девятая попытка упирается в пять минут и дальше не растёт', () => {
    // Ловит снятый потолок: длительный сбой иначе растянет восстановление на часы или Infinity.
    assert.equal(bucketRetryDelayMs(8), 256_000);
    assert.equal(bucketRetryDelayMs(9), BUCKET_RETRY.maxDelayMs);
    assert.equal(bucketRetryDelayMs(10), BUCKET_RETRY.maxDelayMs);
    assert.equal(bucketRetryDelayMs(Number.MAX_VALUE), BUCKET_RETRY.maxDelayMs);
  });

  it('ноль, отрицательные и нечисловые значения считаются первым отказом', () => {
    // Ловит нулевую/NaN-паузу, превращающую недоступное хранилище в горячий цикл retry.
    for (const failures of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.equal(bucketRetryDelayMs(failures), BUCKET_RETRY.firstDelayMs, String(failures));
    }
  });

  it('дробное число отказов округляется вниз до законченных попыток', () => {
    // Ловит случайное округление вверх, которое удвоило бы паузу раньше реально прожитой попытки.
    assert.equal(bucketRetryDelayMs(1.999), 2_000);
    assert.equal(bucketRetryDelayMs(2.001), 4_000);
  });
});

describe('блокировка исполняемых вложений', () => {
  it('опасный MIME блокируется без учёта регистра и параметров', () => {
    // Ловит SVG/HTML с charset, который обходил бы сравнение полной строки MIME.
    assert.equal(attachmentBlocked('IMAGE/SVG+XML; charset=utf-8', 'safe.png'), true);
    assert.equal(attachmentBlocked('Text/Html ; charset=UTF-8', 'safe.txt'), true);
  });

  it('опасное расширение блокируется при безобидном MIME', () => {
    // Ловит маскировку HTML под application/octet-stream.
    assert.equal(attachmentBlocked('application/octet-stream', 'EVIL.HTM'), true);
    assert.equal(attachmentBlocked('image/png', 'page.xhtml'), true);
  });

  it('обычный PNG и файл без точки принимаются', () => {
    // Ловит чрезмерный deny-list, запрещающий безопасные вложения и голые имена.
    assert.equal(attachmentBlocked('image/png', 'photo.png'), false);
    assert.equal(attachmentBlocked('application/octet-stream', 'README'), false);
  });
});

describe('принадлежность URL своему бакету', () => {
  const publicUrl = 'https://media.example.test';

  it('объект внутри точного бакета принимается', () => {
    // Ловит отказ URL, который только что вернул собственный putAttachment.
    assert.equal(urlBelongsToBucket(`${publicUrl}/gv/attachments/file.png`, publicUrl, 'gv'), true);
  });

  it('при выключенном storage валидных URL нет', () => {
    // Ловит принятие внешнего вложения, когда собственное хранилище не настроено.
    assert.equal(urlBelongsToBucket('/gv/file.png', '', 'gv'), false);
  });

  it('чужой host, чужой bucket и похожий префикс отклоняются', () => {
    // Ловит tracking URL и префиксную подмену имени бакета.
    assert.equal(urlBelongsToBucket('https://evil.test/gv/file.png', publicUrl, 'gv'), false);
    assert.equal(urlBelongsToBucket(`${publicUrl}/other/file.png`, publicUrl, 'gv'), false);
    assert.equal(urlBelongsToBucket(`${publicUrl}/gvsomething/file.png`, publicUrl, 'gv'), false);
  });

  it('обычные и percent-encoded dot-segments не выходят из бакета', () => {
    // Ловит регрессию #90: строковый префикс проходил, хотя браузер запрашивал уже /other.
    assert.equal(urlBelongsToBucket(`${publicUrl}/gv/../other/file.png`, publicUrl, 'gv'), false);
    assert.equal(urlBelongsToBucket(`${publicUrl}/gv/%2e%2e/other/file.png`, publicUrl, 'gv'), false);
  });

  it('publicUrl с путём принимает объект внутри своего вложенного бакета', () => {
    // Ловит чрезмерный фикс #90, запрещающий штатную конфигурацию CDN с path-prefix.
    assert.equal(
      urlBelongsToBucket(`${publicUrl}/minio/gv/attachments/file.png`, `${publicUrl}/minio/`, 'gv'),
      true,
    );
  });

  it('dot-segments не позволяют сбежать из path-prefix publicUrl', () => {
    // Ловит проверку только bucket-сегмента без учёта базового пути медиахоста.
    assert.equal(
      urlBelongsToBucket(`${publicUrl}/minio/gv/../../other/file.png`, `${publicUrl}/minio`, 'gv'),
      false,
    );
  });
});

describe('таблицы поддерживаемых медиаформатов', () => {
  it('пользовательские картинки принимают только четыре image MIME', () => {
    // Ловит случайное разрешение видео вместо аватара при расширении общей таблицы mediaExt.
    for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) assert.equal(isSupportedImage(mime), true);
    assert.equal(isSupportedImage('video/webm'), false);
    assert.equal(isSupportedImage('image/svg+xml'), false);
  });

  it('звуки принимают объявленные MIME и отклоняют посторонние', () => {
    // Ловит отказ WAV-варианта браузера или принятие произвольного бинарника как звука.
    for (const mime of ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/mp4']) {
      assert.equal(isSupportedAudio(mime), true);
    }
    assert.equal(isSupportedAudio('application/octet-stream'), false);
  });

  it('mediaExt знает серверные форматы и безопасно падает на bin', () => {
    // Ловит потерю расширения Telegram-стикера либо доверие неизвестному MIME.
    assert.equal(mediaExt('image/jpeg'), 'jpg');
    assert.equal(mediaExt('video/webm'), 'webm');
    assert.equal(mediaExt('application/gzip'), 'tgs');
    assert.equal(mediaExt('application/x-unknown'), 'bin');
  });

  it('audioExt сохраняет реальные расширения и неизвестному даёт bin', () => {
    // Ловит неверный ключ MinIO, после которого браузер не узнаёт формат звука.
    assert.equal(audioExt('audio/mpeg'), 'mp3');
    assert.equal(audioExt('audio/x-wav'), 'wav');
    assert.equal(audioExt('audio/mp4'), 'm4a');
    assert.equal(audioExt('audio/x-unknown'), 'bin');
  });
});

describe('расширение ключа вложения', () => {
  it('расширение имени приоритетнее MIME и очищается до десяти символов', () => {
    // Ловит внедрение служебных символов в ключ объекта и неожиданную замену имени MIME-таблицей.
    assert.equal(attachmentExt('archive.Very-Long_Extension!', 'image/png'), 'verylongex');
  });

  it('имя без точки целиком становится расширением — сохранённый legacy-контракт', () => {
    // Ловит случайное изменение адресов ранее привычных вложений без расширения.
    assert.equal(attachmentExt('README', 'application/octet-stream'), 'readme');
  });

  it('пустое расширение падает сначала на MIME, затем на bin', () => {
    // Ловит ключ с пустым суффиксом и различает известный и неизвестный формат.
    assert.equal(attachmentExt('', 'image/png'), 'png');
    assert.equal(attachmentExt('.', 'application/x-unknown'), 'bin');
  });
});

describe('Content-Disposition вложения', () => {
  it('CRLF, кавычка и обратный слэш уничтожаются до URL-кодирования', () => {
    // Ловит инъекцию второго HTTP-заголовка через пользовательское имя файла.
    const result = contentDisposition('application/pdf', 'safe\r\nX-Evil: 1"\\.pdf');
    assert.equal(result, "attachment; filename*=UTF-8''safe__X-Evil%3A%201__.pdf");
    assert.doesNotMatch(result, /%0D|%0A|%22|%5C/i);
  });

  it('безопасные медиа открываются inline, а PDF и неизвестное скачиваются', () => {
    // Ловит исполнение активного/неизвестного документа при прямом открытии URL.
    assert.match(contentDisposition('image/png', 'a.png'), /^inline;/);
    assert.match(contentDisposition('video/mp4', 'a.mp4'), /^inline;/);
    assert.match(contentDisposition('application/pdf', 'a.pdf'), /^attachment;/);
    assert.match(contentDisposition('application/octet-stream', 'a.bin'), /^attachment;/);
  });

  it('Unicode-имя кодируется, а исходная длина ограничивается 200 символами', () => {
    // Ловит невалидный ASCII-заголовок и неограниченный размер пользовательского header value.
    const result = contentDisposition('application/pdf', `${'я'.repeat(205)}.pdf`);
    const encoded = result.split("''")[1];
    assert.equal(decodeURIComponent(encoded).length, 200);
    assert.doesNotMatch(result, /я/);
  });
});

describe('resolveAudioMime — тип звука решают БАЙТЫ', () => {
  const bytes = (...parts: (string | number[])[]): Uint8Array => {
    const out: number[] = [];
    for (const p of parts) {
      if (typeof p === 'string') for (const ch of p) out.push(ch.charCodeAt(0));
      else out.push(...p);
    }
    return new Uint8Array(out);
  };
    // Первые байты настоящего файла из Soundpad, на котором это и нашлось (репорт с живого, 05.09).
  const m4a = bytes([0, 0, 0, 0x18], 'ftypmp42', [0, 0, 0, 0], 'mp41isom');

  it('m4a принимается, как бы его ни назвала система отправителя', () => {
    // Ровно жалоба: Soundpad отдаёт m4a, Windows объявляет его по-разному, GusVoice отвергал.
    assert.equal(resolveAudioMime('audio/x-m4a', m4a), 'audio/mp4');
    assert.equal(resolveAudioMime('audio/mp4', m4a), 'audio/mp4');
    assert.equal(resolveAudioMime('application/octet-stream', m4a), 'audio/mp4');
    assert.equal(resolveAudioMime('', m4a), 'audio/mp4');
  });

  it('опознаёт остальные контейнеры по сигнатуре', () => {
    assert.equal(resolveAudioMime('', bytes('ID3', [4, 0, 0])), 'audio/mpeg');
    assert.equal(resolveAudioMime('', bytes([0xff, 0xfb, 0x90, 0])), 'audio/mpeg');
    assert.equal(resolveAudioMime('', bytes('OggS', [0, 2])), 'audio/ogg');
    assert.equal(resolveAudioMime('', bytes('RIFF', [0, 0, 0, 0], 'WAVE')), 'audio/wav');
    assert.equal(resolveAudioMime('', bytes([0x1a, 0x45, 0xdf, 0xa3])), 'audio/webm');
  });

  it('🔴 исполняемый файл с верной подписью НЕ проходит', () => {
    // Замерено на живом GPU-Z.exe: объявленный как audio/mpeg, он проходил насквозь — и лёг бы в
    // ПУБЛИЧНЫЙ бакет. Содержимое смотрели только когда подпись была незнакомой.
    assert.equal(resolveAudioMime('audio/mpeg', bytes('MZ', [0x90, 0])), null);
    assert.equal(resolveAudioMime('audio/mpeg', bytes([0x7f], 'ELF')), null);
  });

  it('неопознанное с чужой подписью — отказ', () => {
    assert.equal(resolveAudioMime('text/html', bytes('<html>')), null);
    assert.equal(resolveAudioMime('application/octet-stream', bytes([1, 2, 3, 4])), null);
  });

  it('свой контейнер без сигнатуры на месте спасает белый список', () => {
    // mp3 с мусором перед первым кадром: сигнатуры там, где смотрим, нет, но подпись наша.
    assert.equal(resolveAudioMime('audio/mpeg', bytes([0, 0, 0, 0, 0, 0])), 'audio/mpeg');
  });
});
