import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import { unpackTgs } from './tgs.js';

const LOTTIE = { v: '5.5.7', w: 512, h: 512, fr: 60, layers: [{ ty: 4 }] };
const buf = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

describe('распаковка .tgs', () => {
  it('сжатый gzip разворачивается в объект анимации', async () => {
    const out = await unpackTgs(buf(gzipSync(JSON.stringify(LOTTIE))));
    assert.deepEqual(out, LOTTIE);
  });

  it('несжатый JSON тоже принимается', async () => {
    // Попадается у файлов, прошедших через конвертеры; падать на них незачем.
    const out = await unpackTgs(buf(Buffer.from(JSON.stringify(LOTTIE))));
    assert.deepEqual(out, LOTTIE);
  });

  it('мусор вместо JSON отклоняется', async () => {
    await assert.rejects(() => unpackTgs(buf(gzipSync('не json'))));
  });

  it('JSON без слоёв отклоняется — иначе рендерер молча покажет пустоту', async () => {
    await assert.rejects(() => unpackTgs(buf(gzipSync(JSON.stringify({ v: '5.5.7' })))), /Lottie/);
  });

  it('пустые данные отклоняются', async () => {
    await assert.rejects(() => unpackTgs(new ArrayBuffer(0)));
  });
});
