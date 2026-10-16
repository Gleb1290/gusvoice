import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './mapTilesRules.js';

const raw = readFileSync(new URL('./mapTilesRules.ts', import.meta.url), 'utf8');
function load(source: string): typeof rules {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports });
  return module.exports as typeof rules;
}
it('R224 плитки принимают нулевой и максимальный zoom, раздельные x/y и последнюю координату перед 2^z', () => {
  assert.deepEqual(rules.parseMapTileParams('0', '0', '0.mvt'), { z: 0, x: 0, y: 0 });
  assert.deepEqual(rules.parseMapTileParams('2', '1', '3.mvt'), { z: 2, x: 1, y: 3 });
  assert.deepEqual(rules.parseMapTileParams('22', '4194303', '4194303.mvt'), { z: 22, x: 4194303, y: 4194303 });
  assert.equal(rules.parseMapTileParams('2', '4', '3.mvt'), null);
  assert.equal(rules.parseMapTileParams('2', '3', '4.mvt'), null);
});
it('R224 неканоничные координаты и отсутствие mvt отвергаются в каждом параметре', () => {
  for (const [z, x, y] of [['01', '0', '0.mvt'], ['-1', '0', '0.mvt'], ['1.5', '0', '0.mvt'], ['23', '0', '0.mvt'],
    ['2', '01', '0.mvt'], ['2', '-1', '0.mvt'], ['2', '1.5', '0.mvt'], ['2', '0', '01.mvt'], ['2', '0', '-1.mvt'],
    ['2', '0', '1.5.mvt'], ['2', '0', '1'], ['2', '0', '1.png'], [2, '0', '1.mvt'], ['2', 0, '1.mvt'], ['2', '0', null]]) {
    assert.equal(rules.parseMapTileParams(z, x, y), null, JSON.stringify([z, x, y]));
  }
});
it('R224 глифы принимают кириллицу и равные края, но не обратный диапазон, неверный суффикс и слишком длинные числа', () => {
  for (const range of ['0-255', '1024-1279', '5-5', '999999-999999']) assert.equal(rules.parseGlyphRange(`${range}.pbf`), range);
  for (const bad of ['256-255.pbf', '0-255', '0-255.mvt', '-1-255.pbf', '0-1000000.pbf', null, 1]) assert.equal(rules.parseGlyphRange(bad), null);
});
it('R224 путь из пробелов выключает карту, etag зависит от размера и целых миллисекунд', () => {
  for (const path of [undefined, '', ' \t\r\n ']) assert.equal(rules.mapTilesEnabled(path), false);
  for (const path of ['map.pmtiles', ' C:/maps/map.pmtiles ']) assert.equal(rules.mapTilesEnabled(path), true);
  assert.equal(rules.mapEtag(36, 72.9), 'W/"10-20"');
  assert.equal(rules.mapEtag(36, 72.1), rules.mapEtag(36, 72.9));
  assert.notEqual(rules.mapEtag(37, 72), rules.mapEtag(36, 72));
  assert.notEqual(rules.mapEtag(36, 73), rules.mapEtag(36, 72));
});
const checks = [
  { label: 'край x', from: 'xn < n && yn < n', to: 'xn <= n && yn < n', check: (r: typeof rules) => r.parseMapTileParams('2', '4', '1.mvt') === null, actual: false },
  { label: 'обязательный mvt', from: '\\d{0,7})\\.mvt$', to: '\\d{0,7})(?:\\.mvt)?$', check: (r: typeof rules) => r.parseMapTileParams('2', '0', '1') === null, actual: false },
  { label: 'порядок координат', from: '{ z: zn, x: xn, y: yn }', to: '{ z: zn, x: yn, y: xn }', check: (r: typeof rules) => r.parseMapTileParams('2', '1', '3.mvt')?.x === 1, actual: false },
];
for (const m of checks) it(`R224 контрфакт плиток: ${m.label}`, () => {
  const verify = (source: string) => assert.equal(m.check(load(source)), true, `R224-tile-${m.label}: правило не изменено`);
  verify(raw); assert.equal(raw.split(m.from).length - 1, 1);
  assert.throws(() => verify(raw.replace(m.from, m.to)), e => e instanceof assert.AssertionError && e.message.startsWith(`R224-tile-${m.label}:`)
    && e.operator === 'strictEqual' && e.actual === m.actual && e.expected === true);
});
