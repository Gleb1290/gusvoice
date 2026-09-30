import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attachmentBox, IMAGE_DIM_MAX, measureImageFile } from './imageSize.js';

describe('место под картинку до загрузки', () => {
  it('маленькая картинка не увеличивается', () => {
    // Ловит размытие небольшого вложения из-за растягивания до контейнера.
    assert.deepEqual(attachmentBox(100, 50, 360, 300), { width: 100, height: 50 });
  });

  it('большая картинка вписывается по более тесной стороне с сохранением пропорций', () => {
    // Ловит выход ультраширокого вложения за ленту и скачок высоты после загрузки.
    assert.deepEqual(attachmentBox(4000, 1000, 360, 300), { width: 360, height: 90 });
    assert.deepEqual(attachmentBox(1000, 4000, 360, 300), { width: 75, height: 300 });
  });

  it('нулевые, дробные, чрезмерные и отсутствующие размеры отвергаются', async () => {
    // Ловит недостоверный aspect-ratio от клиента и попытку измерять не-картинку.
    for (const pair of [[0, 10], [10.5, 20], [IMAGE_DIM_MAX + 1, 20], [null, 20]] as const) {
      assert.equal(attachmentBox(pair[0], pair[1], 360, 300), null);
    }
    assert.equal(await measureImageFile(new Blob(['text'], { type: 'text/plain' })), null);
  });
});
