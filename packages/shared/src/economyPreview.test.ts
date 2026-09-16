import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parsePreviewList, previewAllows } from './economyPreview.js';

describe('закрытый показ экономики', () => {
  it('пустая переменная — списка нет, ограничения нет', () => {
    assert.deepEqual(parsePreviewList(undefined), []);
    assert.deepEqual(parsePreviewList(''), []);
    assert.equal(previewAllows([], 'кто-угодно'), true);
  });

  it('пробелы и пустые куски выкидываются — иначе запятая в конце запретила бы всё', () => {
    assert.deepEqual(parsePreviewList(' a , b ,, '), ['a', 'b']);
  });

  it('в списке — пускаем, вне списка — нет', () => {
    assert.equal(previewAllows(['a', 'b'], 'b'), true);
    assert.equal(previewAllows(['a', 'b'], 'c'), false);
  });

  it('неизвестный человек при непустом списке не проходит', () => {
    assert.equal(previewAllows(['a'], null), false);
    assert.equal(previewAllows(['a'], undefined), false);
  });

  it('но при пустом списке даже неизвестный проходит: ограничения просто нет', () => {
    assert.equal(previewAllows([], null), true);
  });
});
