import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as real from './mapStatic';

type Api = typeof real;
const source = readFileSync(new URL('./mapStatic.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const q = { lat: 12.3456789, lon: -78.9012345, w: 320, h: 180, theme: 'dark' as const };
function load(raw = source): Api {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => assert.fail(`чистая карта не требует ${id}`) });
  return module.exports as Api;
}
for (const [field, limit] of [['lat', 90], ['lon', 180]] as const) {
  it(`R220 ${field} на обеих точных границах ±${limit} принимается числами и строками`, () => {
    for (const value of [-limit, limit, `${-limit}`, `${limit}`]) assert.notEqual(real.parseMapStaticQuery({ ...q, [field]: value }), null);
  });
  it(`R220 ${field} за обеими границами ±${limit} отвергается до округления`, () => {
    for (const value of [-limit - 0.0000001, limit + 0.0000001]) assert.equal(real.parseMapStaticQuery({ ...q, [field]: value }), null);
  });
}
for (const [field, max] of [['w', 650], ['h', 450]] as const) {
  it(`R220 ${field} ровно 80 и ${max} принимается строкой и числом`, () => {
    for (const value of [80, max, '80', `${max}`]) assert.notEqual(real.parseMapStaticQuery({ ...q, [field]: value }), null);
  });
  it(`R220 ${field} 79 и ${max + 1} отвергается`, () => {
    for (const value of [79, max + 1, '79', `${max + 1}`]) assert.equal(real.parseMapStaticQuery({ ...q, [field]: value }), null);
  });
}
it('R220 координаты округляются до шести знаков, размер не превращает дробь в целое', () => {
  assert.deepEqual(real.parseMapStaticQuery(q), { lat: 12.345679, lon: -78.901234, w: 320, h: 180, theme: 'dark' });
  for (const value of [80.5, '80.5', '8e1', '+80', ' 80 ', '']) assert.equal(real.parseMapStaticQuery({ ...q, w: value }), null);
});
it('R220 NaN, бесконечность, нечисловой тип и нестандартная строка не проходят разбор координат', () => {
  for (const value of [NaN, Infinity, -Infinity, null, undefined, true, {}, '', '12abc', '1e1', '+12', ' 12 ', '.5']) {
    assert.equal(real.parseMapStaticQuery({ ...q, lat: value }), null);
  }
  for (const raw of [null, undefined, '', 12, [], {}]) assert.equal(real.parseMapStaticQuery(raw), null);
});
it('R220 явная light сохраняется, неизвестная или отсутствующая тема становится dark', () => {
  assert.equal(real.parseMapStaticQuery({ ...q, theme: 'light' })?.theme, 'light');
  for (const theme of [undefined, null, 'LIGHT', 'other', true]) assert.equal(real.parseMapStaticQuery({ ...q, theme })?.theme, 'dark');
});
for (const [w, h, expected] of [[320, 180, { w: 640, h: 360 }], [1000, 500, { w: 650, h: 325 }], [1000, 1000, { w: 450, h: 450 }], [650, 450, { w: 650, h: 450 }]] as const) {
  it(`R220 размер ${w}×${h} сохраняет пропорцию и помещается в 650×450`, () => {
    const result = real.mapStaticSize(w, h); assert.deepEqual(result, expected);
    assert.ok(result.w <= 650 && result.h <= 450); assert.ok(Math.abs(result.w / result.h - w / h) < 0.002);
  });
}
it('R220 размер маленькой или нулевой карточки не падает ниже минимальных 80 пикселей', () => {
  assert.deepEqual(real.mapStaticSize(0, 0), { w: 80, h: 80 }); assert.deepEqual(real.mapStaticSize(20, 20), { w: 80, h: 80 });
});
function minimumOverRatio(api = real) {
  assert.equal(api.mapStaticSize(1000, 20).h, 80, 'R221-map-floor: минимум высоты API важнее пропорции узкого пузыря');
  assert.deepEqual(JSON.parse(JSON.stringify(api.mapStaticSize(1000, 20))), { w: 650, h: 80 });
  assert.deepEqual(JSON.parse(JSON.stringify(api.mapStaticSize(20, 1000))), { w: 80, h: 450 });
}
it('R221 очень узкая карта сохраняет обязательные 80 пикселей, даже если пропорция меняется', () => minimumOverRatio());
it('R221 контрфакт ради пропорции отправляет высоту карты ниже минимума API', () => {
  minimumOverRatio(load(source));
  const from = 'Math.max(MAP_STATIC_MIN_SIDE, Math.round(cssH * k))';
  assert.equal(source.split(from).length - 1, 1);
  assert.throws(() => minimumOverRatio(load(source.replace(from, 'Math.round(cssH * k)'))), e => e instanceof assert.AssertionError
    && e.message.startsWith('R221-map-floor:') && e.operator === 'strictEqual' && e.actual === 13 && e.expected === 80);
});
function path(api = real) {
  const url = new URL(api.mapStaticPath({ ...q, w: 999, h: 1 }), 'https://self.invalid/api');
  assert.equal(url.searchParams.get('w'), '650', 'R220-path-clamp: клиент не просит ширину сверх предела API');
  assert.equal(url.searchParams.get('h'), '80'); assert.equal(url.searchParams.get('lat'), '12.345679'); assert.equal(url.searchParams.get('lon'), '-78.901234');
  const second = new URL(api.mapStaticPath({ ...q, w: 1, h: 999 }), 'https://self.invalid');
  assert.equal(second.searchParams.get('w'), '80'); assert.equal(second.searchParams.get('h'), '450');
}
it('R220 путь клиентского запроса клампит обе стороны размера и округляет координаты', () => path());
function yandex(api = real) {
  const url = new URL(api.yandexMapsUrl(12.3456789, -78.9012345));
  assert.equal(url.hostname, 'yandex.ru'); assert.equal(url.pathname, '/maps/');
  assert.equal(url.searchParams.get('pt'), '-78.901234,12.345679', 'R220-yandex-point: долгота идёт перед широтой');
  assert.equal(url.searchParams.get('z'), '16'); assert.equal(url.searchParams.get('l'), 'map');
}
it('R220 внешняя карта Яндекса получает pt=долгота,широта и единый масштаб 16', () => yandex());
for (const [name, from, to, check, prefix, actual, expected] of [
  ['долгота и широта поменялись местами', '${round6(lon)},${round6(lat)}', '${round6(lat)},${round6(lon)}', yandex, 'R220-yandex-point:', '12.345679,-78.901234', '-78.901234,12.345679'],
  ['ширина пути больше не клампится', 'Math.min(MAP_STATIC_MAX_W, Math.max(MAP_STATIC_MIN_SIDE, Math.round(q.w)))', 'Math.round(q.w)', path, 'R220-path-clamp:', '999', '650'],
  ['высота пути больше не клампится', 'Math.min(MAP_STATIC_MAX_H, Math.max(MAP_STATIC_MIN_SIDE, Math.round(q.h)))', 'Math.round(q.h)',
    (api: Api) => assert.equal(new URL(api.mapStaticPath({ ...q, h: 1 }), 'https://self.invalid').searchParams.get('h'), '80', 'R220-path-height: клиент не просит высоту ниже минимума'),
    'R220-path-height:', '1', '80'],
  ['масштаб игнорирует предел ширины и искажает пропорцию', 'MAP_STATIC_MAX_W / Math.max(1, cssW), ', '',
    (api: Api) => assert.equal(JSON.stringify(api.mapStaticSize(1000, 500)), '{"w":650,"h":325}', 'R220-size-ratio: широкий пузырь уменьшает обе стороны пропорционально'),
    'R220-size-ratio:', '{"w":650,"h":450}', '{"w":650,"h":325}'],
  ['предел ширины стал 651', 'export const MAP_STATIC_MAX_W = 650;', 'export const MAP_STATIC_MAX_W = 651;',
    (api: Api) => assert.equal(api.parseMapStaticQuery({ ...q, w: 651 }) === null, true, 'R220-max-width: 651 запрещён API'), 'R220-max-width:', false, true],
  ['предел высоты стал 451', 'export const MAP_STATIC_MAX_H = 450;', 'export const MAP_STATIC_MAX_H = 451;',
    (api: Api) => assert.equal(api.parseMapStaticQuery({ ...q, h: 451 }) === null, true, 'R220-max-height: 451 запрещён API'), 'R220-max-height:', false, true],
] as const) it(`R220 контрфакт правил карты: ${name}`, () => {
  check(load(source)); assert.equal(source.split(from).length - 1, 1);
  assert.throws(() => check(load(source.replace(from, to))), e => e instanceof assert.AssertionError && e.message.startsWith(prefix)
    && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected);
});
