import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './mapRules';

const raw = readFileSync(new URL('./mapRules.ts', import.meta.url), 'utf8');
function load(source: string): typeof rules {
  const module = { exports: {} }; runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports }); return module.exports as typeof rules;
}
function radius(r: typeof rules, lat: number) {
  const ring = r.accuracyRing(lat, 30, 1000);
  // Независимая метрическая проверка: расстояние по сфере, а не повтор формулы построения многоугольника.
  const distance = ([lon2, lat2]: [number, number]) => {
    const toRad = Math.PI / 180, a = Math.sin((lat2 - lat) * toRad / 2) ** 2 + Math.cos(lat * toRad) * Math.cos(lat2 * toRad) * Math.sin((lon2 - 30) * toRad / 2) ** 2;
    return 2 * 6371008.8 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };
  return ring.every(point => Math.abs(distance(point) - 1000) < 0.2);
}
it('R224 круг точности замкнут и сохраняет метрический радиус на экваторе и широте 60', () => {
  for (const lat of [0, 60]) { const ring = rules.accuracyRing(lat, 30, 1000); assert.equal(ring.length, 49); assert.deepEqual(ring.at(-1), ring[0]); assert.equal(radius(rules, lat), true); }
  assert.equal(rules.accuracyRing(0, 0, 20, 8).length, 9);
});
it('R224 ровно пять метров рисуются, ниже порога, null, NaN и плохие координаты пропускаются', () => {
  const result = rules.accuracyCollection([4.999, 5, 5.001, null, NaN, Infinity, -1].map(accuracy => ({ lat: 10, lon: 20, accuracy })));
  assert.equal(result.type, 'FeatureCollection'); assert.equal(result.features.length, 2);
  assert.deepEqual(result.features[0]!.properties, {}); assert.equal(result.features[0]!.geometry.type, 'Polygon');
  assert.equal(rules.accuracyCollection([{ lat: 91, lon: 0, accuracy: 10 }]).features.length, 0);
});
it('R224 широта ±90 и долгота ±180 допустимы, за границей и нечисловые точки нет', () => {
  for (const lat of [-90, 90]) for (const lon of [-180, 180]) assert.equal(rules.validMapPoint({ lat, lon }), true);
  for (const p of [null, undefined, { lat: 90.0001, lon: 0 }, { lat: -90.0001, lon: 0 }, { lat: 0, lon: 180.0001 },
    { lat: 0, lon: -180.0001 }, { lat: NaN, lon: 0 }, { lat: 0, lon: Infinity }]) assert.equal(rules.validMapPoint(p), false);
});
it('R224 камера выбирает центр файла, одиночную точку либо рамку валидных точек в порядке lon/lat', () => {
  assert.deepEqual(rules.initialCamera([], [30, 60]), { kind: 'center', center: [30, 60], zoom: 10 });
  assert.deepEqual(rules.initialCamera([{ lat: 91, lon: 0 }, { lat: 12, lon: 34 }], [0, 0]), { kind: 'center', center: [34, 12], zoom: 15 });
  assert.deepEqual(rules.initialCamera([{ lat: 10, lon: 40 }, { lat: 20, lon: -5 }, { lat: -10, lon: 25 }], [0, 0]), { kind: 'bounds', bounds: [[-5, -10], [40, 20]] });
});
it('R224 ключ привязан к id, тема только light, значковые слои удаляются без потери подписей', () => {
  assert.equal(rules.pointKey({ lat: 0, lon: 0, id: 'person' }, 3), 'id:person'); assert.equal(rules.pointKey({ lat: 0, lon: 0, id: '' }, 3), '#3');
  assert.equal(rules.mapIsLight('light'), true); for (const v of ['dark', '', null, undefined]) assert.equal(rules.mapIsLight(v), false);
  const a = { layout: { 'text-field': 'город' } }, b = {}, c = { layout: { 'icon-image': undefined } };
  assert.deepEqual(rules.dropSpriteLayers([a, b, c]), [a, b]);
});
for (const m of [
  { label: 'широтная поправка', from: 'Math.cos((lat * Math.PI) / 180)', to: '1', check: (r: typeof rules) => radius(r, 60) },
  { label: 'включённый порог', from: 'p.accuracy >= MAP_ACCURACY_MIN_M', to: 'p.accuracy > MAP_ACCURACY_MIN_M', check: (r: typeof rules) => r.accuracyCollection([{ lat: 0, lon: 0, accuracy: 5 }]).features.length === 1 },
  { label: 'замкнутое кольцо', from: 'out.push(out[0]);', to: '', check: (r: typeof rules) => { const ring = r.accuracyRing(0, 0, 10); return JSON.stringify(ring[0]) === JSON.stringify(ring.at(-1)); } },
]) it(`R224 контрфакт точности: ${m.label}`, () => {
  const verify = (source: string) => assert.equal(m.check(load(source)), true, `R224-accuracy-${m.label}: инвариант карты`);
  verify(raw); assert.equal(raw.split(m.from).length - 1, 1);
  assert.throws(() => verify(raw.replace(m.from, m.to)), e => e instanceof assert.AssertionError && e.message.startsWith(`R224-accuracy-${m.label}:`)
    && e.operator === 'strictEqual' && e.actual === false && e.expected === true);
});
