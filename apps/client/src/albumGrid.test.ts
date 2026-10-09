import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as imageSize from './imageSize';
import * as rules from './bubbleRules';

const source = readFileSync(new URL('./bubbleRules.ts', import.meta.url), 'utf8');
type Rules = typeof rules;
const atts = (n: number, width?: number | null, height?: number | null) => Array.from({ length: n }, (_, i) =>
  ({ url: `/frame-${i}`, name: `${i}.png`, contentType: 'image/png', size: 1, width, height }));
function look(r: Rules, n: number, w = 360, h = 300) {
  return r.bubbleLook({ content: '', attachments: atts(n), replyTo: null, poll: null, sticker: null } as Parameters<Rules['bubbleLook']>[0], w, h);
}
function tiled(r: Rules, ratios: number[], w = 360, h = 300) {
  const grid = r.albumGrid(ratios, w, h);
  assert.equal(grid.tiles.length, ratios.length);
  assert.ok(grid.width > 0 && grid.width <= w && grid.height > 0 && grid.height <= h, 'оба потолка соблюдены');
  let area = 0;
  grid.tiles.forEach((t, i) => {
    for (const v of [t.x, t.y, t.w, t.h]) assert.ok(Number.isInteger(v), 'стыки целочисленные');
    assert.ok(t.x >= 0 && t.y >= 0 && t.w > 0 && t.h > 0);
    assert.ok(t.x + t.w <= grid.width && t.y + t.h <= grid.height);
    const edges = (t.y === 0 ? r.ALBUM_EDGE.top : 0) | (t.x + t.w === grid.width ? r.ALBUM_EDGE.right : 0)
      | (t.y + t.h === grid.height ? r.ALBUM_EDGE.bottom : 0) | (t.x === 0 ? r.ALBUM_EDGE.left : 0);
    assert.equal(t.edges, edges, 'внешние биты совпадают с геометрией');
    if (i) {
      const previous = grid.tiles[i - 1];
      assert.ok(t.y > previous.y || (t.y === previous.y && t.x > previous.x), 'порядок плиток равен порядку кадров');
    }
    for (let j = 0; j < i; j++) {
      const a = grid.tiles[j];
      assert.ok(t.x >= a.x + a.w || a.x >= t.x + t.w || t.y >= a.y + a.h || a.y >= t.y + t.h, 'нет пересечений');
    }
    area += t.w * t.h;
  });
  assert.equal(area, grid.width * grid.height, 'весь прямоугольник покрыт без щелей');
  return grid;
}
function contract(r: Rules) {
  assert.equal(r.ALBUM_MAX, 10); assert.equal(r.ALBUM_TEMPLATE_MAX, 4);
  for (let n = 2; n <= 4; n++) {
    assert.equal(r.albumClass(n), `attachments album n${n}`);
    assert.equal(r.albumStyleOf(atts(n), 360, 300), undefined);
  }
  assert.equal(look(r, 10).album, 10); assert.equal(look(r, 11).kind, 'text');
  assert.equal(look(r, 3, 400, 300).mediaWidth, 375);
  const square9 = tiled(r, Array(9).fill(1)); assert.equal(square9.width, 300); assert.equal(square9.height, 300);
  const square10 = tiled(r, Array(10).fill(1)); assert.equal(square10.width, 327); assert.equal(square10.height, 300);
  assert.ok(square10.tiles.at(-1)!.w >= 100, 'последняя плитка оставляет место времени');
  const land5 = tiled(r, Array(5).fill(16 / 9)); assert.equal(land5.width, 267); assert.equal(land5.height, 300);
  tiled(r, [1.7, 0.8, 1.2, 2, 1, 0.9, 1.3], 181, 297);
}

it('R126 шаблоны 2–4 остаются без inline-стиля, новые 5–10 получают tiled', () => {
  // Переход 4/5 не должен поменять одобренный макет маленьких альбомов.
  for (let n = 2; n <= 10; n++) {
    assert.equal(rules.albumClass(n), `attachments album n${n}${n > 4 ? ' tiled' : ''}`);
    assert.equal(rules.albumStyleOf(atts(n), 360, 300) === undefined, n <= 4);
  }
});
it('R126 альбом принимает 5 и ровно10, а11 оставляет обычным списком', () => {
  for (const n of [5, 10]) assert.equal(look(rules, n).album, n);
  assert.equal(look(rules, 11).kind, 'text');
});
it('R126 контрольные квадратные и широкие альбомы имеют утверждённые размеры', () => {
  contract(rules);
  assert.equal(rules.albumGridOf(atts(10), 360, 300).width, 327);
});
it('R126 для5–10 плитки заполняют потолок без пересечений и сохраняют порядок кадров', () => {
  // Смешанные пропорции ловят ошибки накопленного округления на стыках строк.
  for (let n = 5; n <= 10; n++) for (const pattern of [[1], [16 / 9], [0.1, 0.8, 2, 10, 1.3]])
    for (const [w, h] of [[360, 300], [181, 297], [500, 180]]) tiled(rules, Array.from({ length: n }, (_, i) => pattern[i % pattern.length]), w, h);
});
it('R126 отсутствующие, нулевые и некорректные размеры дают квадрат без прыжка раскладки', () => {
  for (const a of [{}, { width: null, height: null }, { width: 0, height: 9 }, { width: 9, height: 0 },
    { width: -1, height: 9 }, { width: Infinity, height: 1 }]) assert.equal(rules.albumRatio(a), 1);
  assert.equal(rules.albumRatio({ width: 1920, height: 1080 }), 16 / 9);
  assert.deepEqual(rules.albumGridOf(atts(10, null, 0), 360, 300), rules.albumGrid(Array(10).fill(1), 360, 300));
});
it('R126 одновременное уменьшение потолков сохраняет пропорции до одного пикселя округления', () => {
  // Здесь разбиение 3×3 неизменно; у смешанных кадров штраф времени может законно выбрать другую сетку.
  const ratios = Array(9).fill(1);
  const big = tiled(rules, ratios, 720, 600), small = tiled(rules, ratios, 360, 300);
  for (const key of ['width', 'height'] as const) assert.ok(Math.abs(big[key] / 2 - small[key]) <= 1);
  small.tiles.forEach((tile, i) => {
    for (const key of ['x', 'y', 'w', 'h'] as const) assert.ok(Math.abs(big.tiles[i][key] / 2 - tile[key]) <= 1);
  });
});
it('R126 ширина медиа-пузыря новых альбомов берётся из сетки с минимумом120', () => {
  for (let n = 5; n <= 10; n++) for (const [w, h] of [[360, 300], [100, 80]])
    assert.equal(look(rules, n, w, h).mediaWidth, Math.max(rules.MEDIA_MIN_W, rules.albumGridOf(atts(n), w, h).width));
});
it('R126 стиль плиток даёт зазор только внутренним краям, aspectRatio соответствует сетке', () => {
  const grid = tiled(rules, Array(10).fill(1)); const style = rules.albumStyle(grid);
  assert.equal(style.aspectRatio, `${grid.width} / ${grid.height}`);
  assert.equal(Object.keys(style).length, 11);
  grid.tiles.forEach((tile, i) => {
    const raw = style[`--t${i + 1}`]; const parts: string[] = [];
    let depth = 0, start = 0;
    for (let j = 0; j < raw.length; j++) {
      if (raw[j] === '(') depth++;
      else if (raw[j] === ')') depth--;
      else if (raw[j] === ' ' && depth === 0) { parts.push(raw.slice(start, j)); start = j + 1; }
    }
    parts.push(raw.slice(start));
    assert.equal(parts.length, 4);
    [rules.ALBUM_EDGE.top, rules.ALBUM_EDGE.right, rules.ALBUM_EDGE.bottom, rules.ALBUM_EDGE.left].forEach((edge, j) => {
      if (tile.edges & edge) assert.equal(parts[j], '0%');
      else assert.match(parts[j], /^calc\([\d.]+% \+ var\(--sp-1\) \/ 2\)$/);
    });
  });
});
it('R126 пустая сетка безопасна, слой стиля не выдаёт нечисловые проценты', () => {
  assert.deepEqual(rules.albumGrid([], 360, 300), { width: 0, height: 0, tiles: [] });
  assert.deepEqual(rules.albumStyle({ width: 0, height: 0, tiles: [] }), { aspectRatio: '0 / 0' });
});
it('R126 контрфакты лимитов, потолка, округления и выбора последней плитки нарушают контракт', () => {
  // Целый настоящий модуль: не исполняем вырезанные функции и не переносим алгоритм в тест.
  contract(rules);
  const replacements: Array<[string, string]> = [
    ['ALBUM_TEMPLATE_MAX = 4', 'ALBUM_TEMPLATE_MAX = 3'], ['ALBUM_TEMPLATE_MAX = 4', 'ALBUM_TEMPLATE_MAX = 5'],
    ['ALBUM_MAX = 10', 'ALBUM_MAX = 9'], ['ALBUM_MAX = 10', 'ALBUM_MAX = 11'],
    ['const k = Math.min(1, maxH / hs.reduce((s, h) => s + h, 0));', 'const k = 1;'],
    ['const width = Math.round(maxW * k);', 'const width = Math.round(maxH * k);'],
    ['const width = Math.round(maxW * k);', 'const width = maxW * k;'],
    ['3: 5 / 4', '3: 4 / 3'], ['atts.length > ALBUM_TEMPLATE_MAX', 'atts.length >= ALBUM_TEMPLATE_MAX'],
    ['ALBUM_ROW_MAX = 4', 'ALBUM_ROW_MAX = 3'],
    ['const timeFits = lastW * fit >= minTile ? 0 : 1000;', 'const timeFits = 0;'],
    ['? ALBUM_EDGE.right : 0', '? 0 : 0'], ['? ALBUM_EDGE.bottom : 0', '? 0 : 0'],
  ];
  for (const [from, to] of replacements) {
    assert.ok(source.includes(from), from);
    const module = { exports: {} }; const deps: Record<string, unknown> = { '@gusvoice/shared': shared, './imageSize': imageSize };
    runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { module, exports: module.exports, require: (id: string) => { assert.ok(id in deps); return deps[id]; } });
    assert.throws(() => contract(module.exports as Rules), assert.AssertionError, from);
  }
});
