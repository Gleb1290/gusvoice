import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkStreamPreview, STREAM_PREVIEW_MAX_CHARS } from './streamPreview.js';

/**
 * Правило годности превью показа (#115).
 *
 * Проверяем обе стороны, потому что цена ошибки разная, но ненулевая в обе: пропустим лишнее —
 * зритель получит в `<img>` то, что прислал чужой клиент; отобьём годное — превью просто не будет,
 * и это молча (клиент ошибку глушит).
 */

const png = (body = 'AAAA') => `data:image/png;base64,${body}`;
const jpeg = (body = 'AAAA') => `data:image/jpeg;base64,${body}`;

describe('годное превью', () => {
  it('PNG принимается', () => {
    assert.equal(checkStreamPreview(png()).ok, true);
  });

  it('JPEG тоже — веб-путь снимает кадр именно им', () => {
    assert.equal(checkStreamPreview(jpeg()).ok, true);
  });

  it('ровно предельная длина ещё проходит', () => {
    const prefix = 'data:image/png;base64,';
    assert.equal(checkStreamPreview(prefix + 'A'.repeat(STREAM_PREVIEW_MAX_CHARS - prefix.length)).ok, true);
  });
});

describe('негодное превью', () => {
  it('SVG отклоняется — это исполняемый документ, а не картинка', () => {
    assert.equal(checkStreamPreview('data:image/svg+xml;base64,AAAA').ok, false);
  });

  it('обычная ссылка отклоняется — иначе `<img>` пошёл бы за картинкой на чужой хост', () => {
    assert.equal(checkStreamPreview('https://example.com/shot.png').ok, false);
  });

  it('пустая строка отклоняется', () => {
    assert.equal(checkStreamPreview('').ok, false);
  });

  it('верная шапка с пустым телом отклоняется', () => {
    // Ловит проверку «начинается с нужного префикса» без взгляда на то, есть ли за ним что-нибудь:
    // такой data-URL показал бы сломанную картинку вместо честного «превью нет».
    assert.equal(checkStreamPreview('data:image/png;base64,').ok, false);
  });

  it('на один символ длиннее предела уже отклоняется', () => {
    assert.equal(checkStreamPreview(png('A'.repeat(STREAM_PREVIEW_MAX_CHARS))).ok, false);
  });

  it('слишком большое отбивается ЦЕЛИКОМ, а не режется', () => {
    // Обрезанная картинка — битый файл: зритель увидел бы половину кадра и решил, что сломались мы.
    const r = checkStreamPreview(png('A'.repeat(STREAM_PREVIEW_MAX_CHARS)));
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.error, /большое/);
  });
});
