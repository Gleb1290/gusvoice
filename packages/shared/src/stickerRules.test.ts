import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkPackImport,
  parseStickerSetName,
  STICKER_PACKS_PER_SERVER,
  STICKERS_PER_PACK,
  stickerFormatFromPath,
} from './stickerRules.js';

/**
 * Правила импорта наборов.
 *
 * На каждое «принимается» здесь есть парное «отклоняется»: имя набора уходит в путь запроса к
 * api.telegram.org, и молча принятый мусор — это не косметика, а чужие обращения от нашего сервера.
 */
describe('имя набора', () => {
  it('голое имя проходит', () => {
    assert.deepEqual(parseStickerSetName('HotCherry'), { ok: true, name: 'HotCherry' });
  });

  it('полная ссылка разбирается', () => {
    assert.deepEqual(parseStickerSetName('https://t.me/addstickers/HotCherry'), {
      ok: true,
      name: 'HotCherry',
    });
  });

  it('ссылка без схемы тоже', () => {
    assert.deepEqual(parseStickerSetName('t.me/addstickers/HotCherry'), { ok: true, name: 'HotCherry' });
  });

  it('tg://-ссылка тоже', () => {
    assert.deepEqual(parseStickerSetName('tg://addstickers?set=HotCherry'), {
      ok: true,
      name: 'HotCherry',
    });
  });

  it('хвост запроса и якорь отбрасываются', () => {
    assert.deepEqual(parseStickerSetName('https://t.me/addstickers/HotCherry?single#x'), {
      ok: true,
      name: 'HotCherry',
    });
  });

  it('пробелы по краям срезаются', () => {
    assert.equal(parseStickerSetName('  HotCherry  ').ok, true);
  });

  it('имя бота в хвосте набора не мешает', () => {
    assert.deepEqual(parseStickerSetName('my_pack_by_SomeBot'), { ok: true, name: 'my_pack_by_SomeBot' });
  });

  it('пустая строка отклоняется', () => {
    assert.equal(parseStickerSetName('   ').ok, false);
  });

  it('обход пути отклоняется — ради этого правило и существует', () => {
    assert.equal(parseStickerSetName('../../bot123/getMe').ok, false);
    assert.equal(parseStickerSetName('HotCherry/../x').ok, false);
  });

  it('имя с точками и слэшами отклоняется', () => {
    assert.equal(parseStickerSetName('hot.cherry').ok, false);
    assert.equal(parseStickerSetName('hot/cherry').ok, false);
  });

  it('имя, начинающееся с цифры или подчёркивания, отклоняется', () => {
    assert.equal(parseStickerSetName('1pack').ok, false);
    assert.equal(parseStickerSetName('_pack').ok, false);
  });

  it('слишком длинное отклоняется', () => {
    assert.equal(parseStickerSetName(`A${'a'.repeat(64)}`).ok, false);
  });

  it('имя ровно в 64 символа ещё принимается', () => {
    assert.equal(parseStickerSetName(`A${'a'.repeat(63)}`).ok, true);
  });

  it('кириллица отклоняется', () => {
    assert.equal(parseStickerSetName('стикеры').ok, false);
  });

  it('чужая ссылка на канал отклоняется с понятной подсказкой', () => {
    const res = parseStickerSetName('https://t.me/some_channel');
    assert.equal(res.ok, false);
    assert.match(res.ok ? '' : res.error, /addstickers/);
  });
});

describe('формат по пути файла', () => {
  it('три формата Telegram распознаются', () => {
    assert.equal(stickerFormatFromPath('stickers/file_0.webp'), 'webp');
    assert.equal(stickerFormatFromPath('stickers/file_1.tgs'), 'tgs');
    assert.equal(stickerFormatFromPath('stickers/file_2.webm'), 'webm');
  });

  it('регистр расширения не важен', () => {
    assert.equal(stickerFormatFromPath('a/B.WEBP'), 'webp');
  });

  it('старые наборы в PNG считаются статикой', () => {
    assert.equal(stickerFormatFromPath('stickers/old.png'), 'webp');
  });

  it('незнакомое расширение даёт null — такой стикер пропускаем', () => {
    assert.equal(stickerFormatFromPath('stickers/file.mp4'), null);
    assert.equal(stickerFormatFromPath('stickers/file'), null);
  });
});

describe('размер набора', () => {
  it('обычный набор проходит', () => {
    assert.deepEqual(checkPackImport(30, 0), { ok: true });
  });

  it('ровно предельный набор ещё проходит', () => {
    assert.equal(checkPackImport(STICKERS_PER_PACK, 0).ok, true);
  });

  it('пустой набор отклоняется', () => {
    assert.equal(checkPackImport(0, 0).ok, false);
  });

  it('слишком большой набор отклоняется', () => {
    assert.equal(checkPackImport(STICKERS_PER_PACK + 1, 0).ok, false);
  });

  it('переполненный сервер отклоняется', () => {
    assert.equal(checkPackImport(10, STICKER_PACKS_PER_SERVER).ok, false);
  });

  it('на один меньше лимита ещё проходит', () => {
    assert.equal(checkPackImport(10, STICKER_PACKS_PER_SERVER - 1).ok, true);
  });
});
