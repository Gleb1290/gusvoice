import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attachmentBox, IMAGE_DIM_MAX, measureImageFile, videoHints } from './imageSize.js';
import { VOICE_MAX_MS } from '@gusvoice/shared';

it('подсказки видео включают длительность ровно до тридцати минут и пропускают превышение',()=>{
  // Лишняя миллисекунда в metadata иначе отвергнет всю отправку по голосовому серверному пределу.
  assert.deepEqual(videoHints(1920,1080,(VOICE_MAX_MS - 1) / 1000),{width:1920,height:1080,durationMs:VOICE_MAX_MS - 1});
  assert.deepEqual(videoHints(1920,1080,VOICE_MAX_MS / 1000),{width:1920,height:1080,durationMs:VOICE_MAX_MS});
  assert.deepEqual(videoHints(1920,1080,(VOICE_MAX_MS + 1) / 1000),{width:1920,height:1080});
});

it('неизвестная длительность видео не уничтожает пригодный размер кадра',()=>{
  // MediaRecorder нередко отдаёт Infinity: размер всё равно нужен для устойчивой ленты.
  for(const seconds of [Infinity,NaN,0,-1,0.0004])assert.deepEqual(videoHints(640,360,seconds),{width:640,height:360});
  assert.deepEqual(videoHints(640,360,0.0005),{width:640,height:360,durationMs:1});
});

it('размеры видео валидируются с обеих сторон предела и без округления дробных сторон',()=>{
  // Неограниченная ширина от отправителя может раздвинуть ленту до загрузки metadata.
  assert.deepEqual(videoHints(20000,20000,1),{width:20000,height:20000,durationMs:1000});
  for(const n of [0,-1,20001,Infinity,NaN,1.5]){assert.equal(videoHints(n,720,1),null);assert.equal(videoHints(1280,n,1),null);}
});

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
