import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mapGlyphsUrlTemplate, mapTilesUrlTemplate, parseMapInfo } from './mapTiles.js';

const info = { minzoom: 0, maxzoom: 30, bounds: [-180, -90, 180, 90], center: [37, 55] };
it('R224 описание карты принимает обе границы zoom и копирует массивы провода', () => {
  const parsed = parseMapInfo(info); assert.deepEqual(parsed, info); assert.notEqual(parsed!.bounds, info.bounds); assert.notEqual(parsed!.center, info.center);
  assert.deepEqual(parseMapInfo({ ...info, minzoom: 30 }), { ...info, minzoom: 30 });
});
it('R224 неполные данные, строки вместо чисел и нечисловые координаты не становятся картой', () => {
  for (const value of [null, undefined, [], 'map', {}, ...Object.keys(info).map(key => { const copy: Record<string, unknown> = { ...info }; delete copy[key]; return copy; }),
    { ...info, minzoom: '0' }, { ...info, maxzoom: '30' }, { ...info, maxzoom: NaN }, { ...info, bounds: [0, 1, Infinity, 3] },
    { ...info, center: ['37', 55] }, { ...info, bounds: '0,1,2,3' }]) assert.equal(parseMapInfo(value), null);
});
it('R224 minzoom больше maxzoom, отрицательный минимум, zoom 31 и неправильные длины массивов отвергаются', () => {
  for (const value of [{ ...info, minzoom: -1 }, { ...info, minzoom: 31 }, { ...info, maxzoom: 31 },
    ...[[], [1, 2, 3], [1, 2, 3, 4, 5]].map(bounds => ({ ...info, bounds })),
    ...[[], [1], [1, 2, 3]].map(center => ({ ...info, center }))]) assert.equal(parseMapInfo(value), null);
});
it('R224 шаблоны карты используют только заданный API и сохраняют подстановки MapLibre', () => {
  assert.equal(mapTilesUrlTemplate('https://api.invalid'), 'https://api.invalid/api/maps/tiles/{z}/{x}/{y}.mvt');
  assert.equal(mapGlyphsUrlTemplate(''), '/api/maps/glyphs/{fontstack}/{range}.pbf');
});
