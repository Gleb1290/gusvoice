import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as crypto from 'node:crypto';
import ts from 'typescript';
import * as chunks from './attachmentRules.js';
import * as storageRules from './storageRules.js';
import { FORWARD_BYTES_MAX } from './convRules.js';
import {
  attLink, attPartsWellFormed, attSig, attSigValid, attachmentHeaders, deriveAttKey, isAttId,
  isAttPath, parseRange, pendingEvictions, policyGrantsPublic, redactLogUrl,
  resolveAttachmentMime, sanitizeFilename, servedContentType,
} from './attachmentRules.js';

const id = '12345678-1234-1234-1234-123456789abc';
const otherId = '12345678-1234-1234-1234-123456789abd';
const key = deriveAttKey('тестовый секрет, не настоящий ключ');
const sig = attSig(key, id, 'viewer', 2);

describe('R131 сроки копирования и перехвата сборки', () => {
  it('копия получает минуту плюс секунду за каждые начатые четыре МиБ, файл 1 ГиБ — 316 секунд', () => {
    // Деление на размер восьмимегабайтного куска сокращало бы срок большой пересылки вдвое и обрывало её раньше времени.
    const check = (rules: typeof chunks) => {
      assert.equal(rules.copyTimeoutMs(0), 60000);
      assert.equal(rules.copyTimeoutMs(4 * 1024 * 1024), 61000);
      assert.equal(rules.copyTimeoutMs(512 * 1024 * 1024), 188000);
      assert.equal(rules.copyTimeoutMs(1024 * 1024 * 1024), 316000);
    };
    check(chunks);
    const source = readFileSync(new URL('./attachmentRules.ts', import.meta.url), 'utf8');
    const target = 'Math.max(0, size) / (4 * 1024 * 1024)';
    assert.ok(source.includes(target));
    const changed = source.replace(target, 'Math.max(0, size) / (8 * 1024 * 1024)');
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(changed, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { module, exports: module.exports, require: (name: string) => {
        if (name === 'node:crypto') return crypto;
        if (name === './storageRules.js') return storageRules;
        throw new Error(`неожиданная зависимость ${name}`);
      } });
    assert.throws(() => check(module.exports as typeof chunks), assert.AssertionError);
  });

  it('лишний байт после границы четыре МиБ увеличивает срок, пустой и отрицательный размер получают базовую минуту', () => {
    // Округление вниз срезало бы бюджет последней неполной порции, отрицательный размер — базовую минуту.
    const MiB = 1024 * 1024;
    for (const [size, expected] of [[-1, 60000], [0, 60000], [1, 61000], [4 * MiB - 1, 61000],
      [4 * MiB, 61000], [4 * MiB + 1, 62000], [8 * MiB, 62000], [8 * MiB + 1, 63000]]) {
      assert.equal(chunks.copyTimeoutMs(size), expected);
    }
  });

  it('устаревшая метка сборки перехватывается позже тайм-аута самой сборки, остальные операции имеют положительный срок', () => {
    // Второй сборщик не должен захватить ещё живую операцию первого на той же или более ранней границе.
    assert.ok(chunks.ASSEMBLY_CLAIM_STALE_MS > chunks.ASSEMBLY_TIMEOUT_MS);
    assert.ok(chunks.ASSEMBLY_TIMEOUT_MS > 0);
    assert.ok(chunks.PART_STORE_TIMEOUT_MS > 0);
    assert.ok(chunks.MULTIPART_OP_TIMEOUT_MS > 0);
  });
});

describe('R127 чистые правила загрузки кусками', () => {
  it('пустой файл имеет один пустой кусок, кратный размер не добавляет пустой хвост', () => {
    // Ловит потерянный нулевой файл и лишний кусок при точном делении.
    for (const [size, count] of [[0, 1], [1, 1], [8, 1], [9, 2], [16, 2], [17, 3]])
      assert.equal(chunks.partCount(size, 8), count);
    assert.equal(chunks.partCount(chunks.BIGFILE_MAX_BYTES), 128);
  });
  it('последний кусок несёт остаток, неверные номера не получают размер', () => {
    // Кусок всегда partSize потерял бы последний байт или потребовал бы лишних байтов клиента.
    assert.equal(chunks.expectedPartSize(0, 1, 8), 0);
    assert.equal(chunks.expectedPartSize(16, 2, 8), 8);
    assert.equal(chunks.expectedPartSize(17, 2, 8), 8); assert.equal(chunks.expectedPartSize(17, 3, 8), 1);
    for (const n of [-1, 0, 1.5, 4, NaN, Infinity]) assert.equal(chunks.expectedPartSize(17, n, 8), null);
  });
  it('сборка требует все номера с точными размерами, порядок записи не важен', () => {
    // Чужой размер не превращает недостающий кусок в готовый; посторонние номера не заменяют нужный.
    assert.deepEqual(chunks.missingParts(17, [{ part: 3, size: 1 }, { part: 1, size: 8 }, { part: 2, size: 8 }], 8), []);
    assert.deepEqual(chunks.missingParts(17, [{ part: 1, size: 7 }, { part: 3, size: 8 }, { part: 99, size: 8 }], 8), [1, 2, 3]);
    assert.deepEqual(chunks.missingParts(0, [], 8), [1]);
    assert.deepEqual(chunks.missingParts(0, [{ part: 1, size: 0 }], 8), []);
  });
  it('файл ровно1ГиБ допускается, лишний байт получает413 раньше других пределов', () => {
    assert.equal(chunks.BIGFILE_MAX_BYTES, 1024 * 1024 * 1024);
    assert.equal(chunks.uploadStartBlock(chunks.BIGFILE_MAX_BYTES, 0, 0), null);
    assert.equal(chunks.uploadStartBlock(chunks.BIGFILE_MAX_BYTES + 1, chunks.DM_DAILY_UPLOAD_BYTES, 12)?.code, 413);
  });
  it('R142 предел 1 ГиБ и общий запас 8 ГиБ не откатываются и не расходятся с пересылкой', () => {
    // Числа проверяются независимо от констант: согласованный откат не должен сделать тест зелёным.
    const verify = (rules: typeof chunks) => {
      const GiB = 1024 * 1024 * 1024;
      assert.equal(rules.BIGFILE_MAX_BYTES, GiB);
      assert.equal(rules.uploadStartBlock(GiB, 0, 0), null);
      assert.equal(rules.uploadStartBlock(GiB + 1, 0, 0)?.code, 413);
      assert.equal(rules.partCount(GiB), 128);
      assert.equal(rules.PENDING_MAX_BYTES, 8 * GiB);
      assert.equal(rules.PENDING_MAX_BYTES_BIGFILE, FORWARD_BYTES_MAX);
      assert.equal(rules.PENDING_MAX_BYTES, FORWARD_BYTES_MAX);
    };
    verify(chunks);
    const source = readFileSync(new URL('./attachmentRules.ts', import.meta.url), 'utf8');
    for (const [from, to] of [
      ['BIGFILE_MAX_BYTES = 1024 * 1024 * 1024', 'BIGFILE_MAX_BYTES = 512 * 1024 * 1024'],
      ['PENDING_MAX_BYTES = 8 * 1024 * 1024 * 1024', 'PENDING_MAX_BYTES = 9 * 1024 * 1024 * 1024'],
      ['PENDING_MAX_BYTES_BIGFILE = 8 * 1024 * 1024 * 1024', 'PENDING_MAX_BYTES_BIGFILE = 9 * 1024 * 1024 * 1024'],
    ]) {
      assert.ok(source.includes(from), `якорь ${from}`);
      const module = { exports: {} };
      runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
        { module, exports: module.exports, Buffer, URL, require: (name: string) => {
          if (name === 'node:crypto') return crypto;
          if (name === './storageRules.js') return storageRules;
          throw new Error(`неожиданная зависимость ${name}`);
        } });
      assert.throws(() => verify(module.exports as typeof chunks), assert.AssertionError);
    }
  });
  it('одиннадцать открытых допускают ещё загрузку, двенадцать уже получают429', () => {
    assert.equal(chunks.UPLOADS_OPEN_MAX, 12);
    assert.equal(chunks.uploadStartBlock(1, 0, 11), null);
    assert.equal(chunks.uploadStartBlock(1, 0, 12)?.code, 429);
    assert.equal(chunks.uploadStartBlock(1, 0, 13)?.code, 429);
  });
  it('суточные8ГиБ допускают ровно сумму, набайт больше возвращает429', () => {
    const daily = 8 * 1024 * 1024 * 1024;
    assert.equal(chunks.DM_DAILY_UPLOAD_BYTES, daily);
    assert.equal(chunks.uploadStartBlock(8, daily - 8, 0), null);
    assert.equal(chunks.uploadStartBlock(8, daily - 7, 0)?.code, 429);
  });
  it('контрфакты строгих пределов и полного размера последнего куска обнаруживаются поведением', () => {
    const source = readFileSync(new URL('./attachmentRules.ts', import.meta.url), 'utf8');
    const verify = (r: typeof chunks) => {
      assert.equal(r.expectedPartSize(17, 3, 8), 1);
      assert.equal(r.expectedPartSize(0, 1, 8), 0);
      assert.equal(r.uploadStartBlock(512, 0, 0, 512, 1024), null);
      assert.equal(r.uploadStartBlock(512, 512, 0, 512, 1024), null);
    };
    verify(chunks);
    for (const [from, to] of [['size > max', 'size >= max'], ['usedToday + size > daily', 'usedToday + size >= daily'],
      ['size - (count - 1) * partSize', 'partSize']]) {
      assert.ok(source.includes(from));
      const module = { exports: {} }; const deps: Record<string, unknown> = { 'node:crypto': crypto, './storageRules.js': storageRules };
      runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
        { module, exports: module.exports, Buffer, URL, require: (id: string) => { assert.ok(id in deps); return deps[id]; } });
      assert.throws(() => verify(module.exports as typeof chunks), assert.AssertionError);
    }
  });
});

describe('закрытая ссылка на вложение', () => {
  it('подпись привязана к вложению, зрителю, поколению токенов и ключу', () => {
    // Ловит повторное использование утёкшей ссылки после отзыва токенов или другим человеком.
    assert.equal(sig.length, 32);
    assert.equal(attSigValid(key, id, 'viewer', 2, sig), true);
    for (const [a, v, g, s] of [[otherId, 'viewer', 2, sig], [id, 'other', 2, sig], [id, 'viewer', 3, sig], [id, 'viewer', 2, sig.slice(1)]] as const) {
      assert.equal(attSigValid(key, a, v, g, s), false);
    }
    assert.equal(attSigValid(deriveAttKey('другой секрет'), id, 'viewer', 2, sig), false);
  });

  it('путь принимает точные части и отвергает мусор до базы', () => {
    // Ловит подмену сегментов пути и обход предварительной проверки UUID.
    assert.equal(isAttId(id), true);
    assert.equal(isAttId(id.toUpperCase()), false);
    assert.equal(attPartsWellFormed(id, 'viewer-1', sig), true);
    assert.equal(attPartsWellFormed(id, 'viewer/1', sig), false);
    assert.equal(attPartsWellFormed(id, 'viewer', `${sig}!`), false);
  });

});

describe('тип и выдача закрытого файла', () => {
  it('байты картинки важнее имени, а неизвестный файл не становится исполняемым HTML', () => {
    // Ловит доверие клиентскому MIME и исполнение подложного документа на домене API.
    assert.equal(resolveAttachmentMime('text/html', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), 'image/png');
    assert.equal(resolveAttachmentMime('text/html', new TextEncoder().encode('<script>alert(1)</script>')), 'application/octet-stream');
    assert.equal(servedContentType('text/html'), 'application/octet-stream');
    assert.equal(servedContentType('image/png'), 'image/png');
  });

  it('AVIF распознаётся по марке контейнера, MP4 без подсказки остаётся файлом', () => {
    // Ловит смешение изображения AVIF, видео и неизвестного контейнера.
    const box = Uint8Array.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
    assert.equal(resolveAttachmentMime('', box), 'image/avif');
    box[8] = 0x69; box[9] = 0x73; box[10] = 0x6f; box[11] = 0x6d;
    assert.equal(resolveAttachmentMime('', box), 'application/octet-stream');
    assert.equal(resolveAttachmentMime('video/mp4', box), 'video/mp4');
  });

  it('JPEG, GIF, WebP, BMP и PDF определяются содержимым, пустой файл остаётся байтами', () => {
    // Ловит доверие расширению вместо сигнатуры на разных форматах вложений.
    const bytes = (s: string) => new TextEncoder().encode(s);
    assert.equal(resolveAttachmentMime('text/html', Uint8Array.from([0xff, 0xd8, 0xff, ...new Array(9).fill(0)])), 'image/jpeg');
    assert.equal(resolveAttachmentMime('', bytes('GIF89a123456')), 'image/gif');
    assert.equal(resolveAttachmentMime('', bytes('RIFF1234WEBP')), 'image/webp');
    assert.equal(resolveAttachmentMime('', Uint8Array.from([0x42, 0x4d, ...new Array(25).fill(0)])), 'image/bmp');
    assert.equal(resolveAttachmentMime('', bytes('%PDF-1.7')), 'application/pdf');
    assert.equal(resolveAttachmentMime('image/png', bytes('<html>hello</html>')), 'application/octet-stream');
    assert.equal(resolveAttachmentMime('image/png', new Uint8Array()), 'application/octet-stream');
  });

  it('WebM и MP4 берут только заявленный звук или видео, без него не становятся медиа', () => {
    // Ловит показ неизвестного контейнера как видео и потерю голосового при верном объявлении.
    const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]);
    const mp4 = Uint8Array.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70]);
    for (const [data, video, audio] of [[webm, 'video/webm', 'audio/webm'], [mp4, 'video/mp4', 'audio/mp4']] as const) {
      assert.equal(resolveAttachmentMime('', data), 'application/octet-stream');
      assert.equal(resolveAttachmentMime(video, data), video);
      assert.equal(resolveAttachmentMime(audio, data), audio === 'audio/mp4' ? 'audio/mp4' : 'audio/webm');
    }
  });

  it('сигнатуры MP3, Ogg и WAV принимаются без объявления, а UTF-16 текст не маскируется под MP3', () => {
    // Ловит ложное распознавание текстового файла по FF FE как сырого кадра MP3.
    assert.equal(resolveAttachmentMime('', new TextEncoder().encode('ID3hello')), 'audio/mpeg');
    assert.equal(resolveAttachmentMime('', new TextEncoder().encode('OggShello')), 'audio/ogg');
    assert.equal(resolveAttachmentMime('', new TextEncoder().encode('RIFF1234WAVE')), 'audio/wav');
    assert.equal(resolveAttachmentMime('application/octet-stream', Uint8Array.from([0xff, 0xfe, 0, 0])), 'application/octet-stream');
    assert.equal(resolveAttachmentMime('text/plain', Uint8Array.from([0xff, 0xfb, 0, 0])), 'application/octet-stream');
  });

  it('опасные символы имени заменяются без разрыва суррогатной пары', () => {
    // Ловит поломку encodeURIComponent на одиноком суррогате и подмену видимого расширения.
    assert.equal(sanitizeFilename('a\u202E"\\\n.txt'), 'a____.txt');
    assert.equal(sanitizeFilename('😀x', 1), '😀');
    assert.equal(sanitizeFilename('\uD83D', 1), '_');
    assert.equal(sanitizeFilename('', 0), 'file');
  });

  it('заголовки заставляют скачивать и запрещают исполнение даже для картинки', () => {
    // Ловит уход окна десктопа на файл и выполнение HTML с API-домена.
    const h = attachmentHeaders('image/png', 'photo.png', id);
    assert.match(h['Content-Disposition'], /^attachment;/);
    assert.equal(h['Content-Security-Policy'], "default-src 'none'; sandbox");
    assert.equal(h['Cache-Control'], 'private, no-cache');
    assert.equal(h.ETag, `"${id}"`);
    assert.equal(h['Accept-Ranges'], 'bytes');
  });

  it('диапазоны включают края, а пустой файл и выход за конец отклоняются', () => {
    // Ловит ошибки перемотки аудио на первом и последнем байте.
    assert.deepEqual(parseRange('bytes=0-0', 10), { start: 0, end: 0 });
    assert.deepEqual(parseRange('bytes=9-', 10), { start: 9, end: 9 });
    assert.deepEqual(parseRange('bytes=-20', 10), { start: 0, end: 9 });
    assert.equal(parseRange('bytes=10-', 10), 'unsatisfiable');
    assert.equal(parseRange('bytes=0-', 0), 'unsatisfiable');
    assert.equal(parseRange('bytes=0-1,3-4', 10), null);
  });
});

describe('безопасность хранения и журналов', () => {
  it('журнал не сохраняет подпись, но оставляет id для разбора жалобы', () => {
    // Ловит утечку bearer-ссылки через лог запросов.
    const raw = `/api/att/${id}/viewer/${sig}?x=1`;
    assert.equal(redactLogUrl(raw), `/api/att/${id}/…?x=1`);
    assert.equal(isAttPath(`/api/att/${id}`), true);
    assert.equal(isAttPath('/api/download/attachment'), false);
  });

  it('публичная политика и битый JSON запрещают считать бакет закрытым', () => {
    // Ловит публикацию закрытых файлов при недоказуемой приватности бакета.
    assert.equal(policyGrantsPublic(''), false);
    assert.equal(policyGrantsPublic('{'), true);
    assert.equal(policyGrantsPublic('{"Statement":{"Effect":"Allow","Principal":"*"}}'), true);
    assert.equal(policyGrantsPublic('{"Statement":[{"Effect":"Allow","Principal":{"AWS":["user","*"]}}]}'), true);
    assert.equal(policyGrantsPublic('{"Statement":{"Effect":"Deny","Principal":"*"}}'), false);
  });

  it('скалярная политика не роняет подготовку бакета, null рядом с публичным разрешением не скрывает его', () => {
    // Ловит TypeError на JSON null и пропуск открывающего Statement после пустого элемента.
    for (const raw of ['null', '1', '"x"']) assert.equal(policyGrantsPublic(raw), false);
    assert.equal(policyGrantsPublic('{"Statement":[null,{"Effect":"Allow","Principal":"*"}]}'), true);
  });

  it('лишние незавершённые загрузки вытесняются от старых к новым по обоим пределам', () => {
    // Ловит отказ текущей отправке вместо освобождения места от старых загрузок.
    const old = [{ id: 'a', size: 5 }, { id: 'b', size: 10 }];
    assert.deepEqual(pendingEvictions(old, 5, 3, 20), []);
    assert.deepEqual(pendingEvictions(old, 6, 3, 20), ['a']);
    assert.deepEqual(pendingEvictions(old, 1, 2, 100), ['a']);
    assert.deepEqual(pendingEvictions(old, 16, 3, 20), ['a', 'b']);
  });
});
