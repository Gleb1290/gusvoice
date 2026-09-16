import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ANIMATED_AVATAR_MAX_BYTES,
  ANIMATED_AVATAR_MAX_FRAMES,
  checkAnimatedAvatar,
  frameCount,
  imageSize,
} from './animatedAvatar';

/**
 * Файлы собираются БАЙТАМИ, а не берутся готовыми.
 *
 * 🔴 Так проверка бьёт по разбору контейнера, а не по случайной картинке из репозитория: кадры
 * можно поставить ровно те, что нужны краю, — ноль, один, потолок и потолок плюс один. С готовым
 * файлом ни один из этих случаев не воспроизвести.
 */

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const u32le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
const u32be = (n: number) => [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

/** GIF с заданным числом кадров и размером; палитры нет, данные кадра пустые. */
function gif(frames: number, w = 64, h = 64): Uint8Array {
  const out = [...ascii('GIF89a'), ...u16le(w), ...u16le(h), 0x00, 0x00, 0x00];
  for (let i = 0; i < frames; i++) {
    // Блок расширения управления графикой — он ЕСТЬ, но кадром считается не он.
    out.push(0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00);
    // Описание изображения: 9 байт полей + упакованный байт без локальной палитры.
    out.push(0x2c, ...u16le(0), ...u16le(0), ...u16le(w), ...u16le(h), 0x00);
    out.push(0x02); // минимальный размер кода LZW
    out.push(0x00); // пустая цепочка под-блоков
  }
  out.push(0x3b);
  return new Uint8Array(out);
}

/** PNG/APNG: подпись, IHDR, при `frames !== null` — acTL, затем IDAT. */
function png(frames: number | null, w = 64, h = 64): Uint8Array {
  const out = [0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a];
  out.push(...u32be(13), ...ascii('IHDR'), ...u32be(w), ...u32be(h), 0, 0, 0, 0, 0, ...u32be(0));
  if (frames !== null) out.push(...u32be(8), ...ascii('acTL'), ...u32be(frames), ...u32be(0), ...u32be(0));
  out.push(...u32be(0), ...ascii('IDAT'), ...u32be(0));
  return new Uint8Array(out);
}

/** WebP: RIFF + VP8X (с флагом анимации) + ANIM + по одному ANMF на кадр. */
function webp(frames: number, w = 64, h = 64): Uint8Array {
  const body: number[] = [];
  body.push(...ascii('VP8X'), ...u32le(10), 0x02, 0, 0, 0, ...u24le(w - 1), ...u24le(h - 1));
  body.push(...ascii('ANIM'), ...u32le(6), 0, 0, 0, 0, 0, 0);
  for (let i = 0; i < frames; i++) body.push(...ascii('ANMF'), ...u32le(0));
  const out = [...ascii('RIFF'), ...u32le(body.length + 4), ...ascii('WEBP'), ...body];
  return new Uint8Array(out);
}

describe('размер из заголовка', () => {
  it('читается у всех трёх форматов', () => {
    assert.deepEqual(imageSize(gif(1, 120, 90), 'image/gif'), { w: 120, h: 90 });
    assert.deepEqual(imageSize(png(2, 120, 90), 'image/png'), { w: 120, h: 90 });
    assert.deepEqual(imageSize(webp(2, 120, 90), 'image/webp'), { w: 120, h: 90 });
  });

  it('обрубок не притворяется разобранным', () => {
    assert.equal(imageSize(new Uint8Array([0x47, 0x49, 0x46]), 'image/gif'), null);
    assert.equal(imageSize(new Uint8Array(0), 'image/png'), null);
  });
});

describe('счёт кадров', () => {
  it('GIF считается по описаниям изображения, а не по блокам расширения', () => {
    // ⚠️ В сборке на каждый кадр приходится И блок расширения, И описание изображения. Считай мы
    // блоки расширения, число совпало бы случайно; здесь оно совпадает по правильной причине.
    assert.equal(frameCount(gif(1), 'image/gif'), 1);
    assert.equal(frameCount(gif(7), 'image/gif'), 7);
  });

  it('APNG берёт число прямо из заголовка', () => {
    assert.equal(frameCount(png(12), 'image/png'), 12);
  });

  it('PNG без acTL — один кадр, а не «не разобрался»', () => {
    assert.equal(frameCount(png(null), 'image/png'), 1);
  });

  it('WebP считает кадровые чанки', () => {
    assert.equal(frameCount(webp(5), 'image/webp'), 5);
  });

  /**
   * 🔴 `null` — это НЕ «один кадр». Разница существенная: пропусти мы непонятный файл как
   * безобидный, и достаточно слегка испортить заголовок, чтобы обойти потолок кадров.
   */
  it('мусор даёт null, а не единицу', () => {
    assert.equal(frameCount(new Uint8Array([1, 2, 3, 4, 5]), 'image/gif'), null);
    assert.equal(frameCount(new Uint8Array([1, 2, 3, 4, 5]), 'image/webp'), null);
    assert.equal(frameCount(gif(1), 'image/jpeg'), null);
  });

  it('обрезанный GIF не досчитывается молча', () => {
    const full = gif(3);
    assert.equal(frameCount(full.slice(0, full.length - 12), 'image/gif'), null);
  });
});

describe('приём файла', () => {
  it('нормальная анимация проходит', () => {
    const r = checkAnimatedAvatar('image/gif', gif(24));
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.frames, 24);
  });

  it('неподходящий тип отвергается первым', () => {
    assert.equal(checkAnimatedAvatar('image/jpeg', gif(2)).ok, false);
  });

  /** ⚠️ Купивший НЕ должен молча получить обычную картинку и решить, что покупка не работает. */
  it('неанимированный файл отвергается с объяснением', () => {
    const r = checkAnimatedAvatar('image/png', png(null));
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.includes('не анимирована'));
  });

  it('слишком большой файл отвергается', () => {
    const big = new Uint8Array(ANIMATED_AVATAR_MAX_BYTES + 1);
    big.set(gif(1));
    assert.equal(checkAnimatedAvatar('image/gif', big).ok, false);
  });

  /** 🔴 Потолок кадров — защита от бомбы распаковки. Граница включительная. */
  it('потолок кадров проверяется по включительной границе', () => {
    assert.equal(checkAnimatedAvatar('image/gif', gif(ANIMATED_AVATAR_MAX_FRAMES)).ok, true);
    const over = checkAnimatedAvatar('image/gif', gif(ANIMATED_AVATAR_MAX_FRAMES + 1));
    assert.equal(over.ok, false);
    assert.ok(!over.ok && over.error.includes(String(ANIMATED_AVATAR_MAX_FRAMES)));
  });

  /**
   * ⚠️ Пропорции проверяются потому, что анимацию мы НЕ обрезаем: круглая рамка срезала бы края
   * широкой картинки, и человек получил бы не то, что выбирал.
   */
  it('широкая картинка отвергается, почти квадратная проходит', () => {
    assert.equal(checkAnimatedAvatar('image/gif', gif(4, 200, 100)).ok, false);
    assert.equal(checkAnimatedAvatar('image/gif', gif(4, 105, 100)).ok, true);
  });
});
