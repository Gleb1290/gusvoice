import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import buffer from '@turf/buffer';
import simplify from '@turf/simplify';

type Point = [number, number];
type Ring = Point[];
type Polygon = Ring[];
type Feature = { type: 'Feature'; properties: Record<string, string>; geometry: { type: 'Polygon'; coordinates: Polygon } | { type: 'MultiPolygon'; coordinates: Polygon[] } };
const script = readFileSync(new URL('../../../scripts/maps-regions.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const regionDir = new URL('../../../deploy/maps/regions/', import.meta.url);
const compiled = new Map<string, string>();
const rectangle = (x: number, y: number, w = 1, h = 1): Polygon => [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]];
function country(iso3: string, parts: Polygon[]): Feature {
  return { type: 'Feature', properties: { ISO_A3_EH: iso3, ADM0_A3: iso3, ISO_A2_EH: iso3.slice(0, 2), NAME_EN: `Country ${iso3}`, NAME_RU: `Страна ${iso3}` },
    geometry: parts.length === 1 ? { type: 'Polygon', coordinates: parts[0]! } : { type: 'MultiPolygon', coordinates: parts } };
}

// Исполняется ВЕСЬ настоящий CLI, а не извлечённая функция. Подменяются только файловый ввод/вывод и argv;
// вычисления buffer/simplify остаются настоящими Turf. Песочница не видит ни сеть, ни env, ни диск проекта.
function generate(features: Feature[], bufferKm = 0, raw = script) {
  const input = '/synthetic/countries.geojson', output = '/synthetic/regions';
  const files = new Map<string, string>([[input, JSON.stringify({ type: 'FeatureCollection', features })],
    [`${output}/OLD.geojson`, 'obsolete'], [`${output}/OLD.main.geojson`, 'obsolete'], [`${output}/index.tsv`, 'obsolete'], [`${output}/README.txt`, 'keep']]);
  const withinOutput = (path: string) => assert.equal(posix.dirname(path), output, `запись/удаление только в виртуальный каталог: ${path}`);
  const fs = {
    readFileSync(path: string, encoding: string) { assert.equal(path, input); assert.equal(encoding, 'utf8'); return files.get(path)!; },
    mkdirSync(path: string, options: { recursive: boolean }) { assert.equal(path, output); assert.equal(options.recursive, true); },
    readdirSync(path: string) { assert.equal(path, output); return [...files.keys()].filter(key => posix.dirname(key) === output).map(key => posix.basename(key)); },
    rmSync(path: string) { withinOutput(path); assert.equal(files.delete(path), true); },
    writeFileSync(path: string, value: string) { withinOutput(path); assert.equal(typeof value, 'string'); files.set(path, value); },
    statSync(path: string) { withinOutput(path); assert.equal(files.has(path), true); return { size: Buffer.byteLength(files.get(path)!) }; },
  };
  const deps: Record<string, unknown> = { 'node:fs': fs, 'node:path': { join: posix.join },
    '@turf/buffer': { __esModule: true, default: buffer }, '@turf/simplify': { __esModule: true, default: simplify } };
  let source = compiled.get(raw);
  if (!source) {
    source = ts.transpileModule(raw, { fileName: 'maps-regions.ts', compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, allowJs: true,
    } }).outputText;
    compiled.set(raw, source);
  }
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports,
    process: { argv: ['node', 'maps-regions.mjs', input, output, String(bufferKm)], exit(code: number) { throw new Error(`CLI exit ${code}`); } },
    console: { log() {}, error() {} }, require(id: string) { assert.equal(Object.hasOwn(deps, id), true, `закрытый импорт генератора: ${id}`); return deps[id]; },
  }, { filename: 'maps-regions.mjs', timeout: 15_000 });
  return new Map([...files].filter(([path]) => posix.dirname(path) === output).map(([path, value]) => [posix.basename(path), value]));
}
function feature(files: Map<string, string>, name: string): Feature {
  assert.equal(files.has(name), true, `генератор должен записать ${name}`);
  return JSON.parse(files.get(name)!);
}
const polygons = (f: Feature): Polygon[] => f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
const points = (f: Feature): Point[] => polygons(f).flat(2);
function bounds(f: Feature) {
  const pts = points(f);
  return [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
}
function validContours(f: Feature, name: string) {
  assert.equal(f.type, 'Feature', name); assert.ok(polygons(f).length > 0, name);
  for (const polygon of polygons(f)) {
    assert.ok(polygon.length > 0, name);
    for (const ring of polygon) {
      assert.ok(ring.length >= 4, name); assert.deepEqual(ring[0], ring.at(-1), `замкнутое кольцо ${name}`);
      for (const [lon, lat] of ring) {
        assert.ok(Number.isFinite(lon) && lon >= -180 && lon <= 180, `долгота ${name}`);
        assert.ok(Number.isFinite(lat) && lat >= -85 && lat <= 85, `широта ${name}`);
      }
    }
  }
}
function replaceOnce(from: string, to: string) {
  assert.equal(script.split(from).length - 1, 1, `единственный якорь: ${from}`);
  return script.replace(from, to);
}
function strictCounterfact(verify: (raw: string) => void, raw: string, prefix: string, actual: number, expected: number) {
  verify(script);
  assert.throws(() => verify(raw), error => error instanceof assert.AssertionError && error.message.startsWith(prefix)
    && error.operator === 'strictEqual' && error.actual === actual && error.expected === expected);
}
const edgeFixture = () => [country('EDG', [rectangle(0, 0, 20, 2), rectangle(21, 0), rectangle(70, 0)])];
const chainFixture = (bridgeSize: number) => [country('CHN', [rectangle(0, 0), rectangle(6, 0, bridgeSize, bridgeSize), rectangle(11.6, 0, .3, .3), rectangle(50, 0, .3, .3)])];
const remoteFixture = (km2: number) => [country('REM', [rectangle(0, 0), rectangle(50, 0, km2 / (111.2 ** 2 * Math.cos(.05 * Math.PI / 180) * .1), .1)])];
// Нулевой x избегает потери точности при вычитании почти равных долгот: эти фикстуры дают ровно 100/500 км².
const exactRemoteFixture = (km2: number) => [country('REM', [rectangle(-50, 0), rectangle(0, 0, km2 / (111.2 ** 2 * Math.cos(.25 * Math.PI / 180) * .5), .5)])];
const exactChainFixture = (km2: number) => [country('CHN', [rectangle(-6, 0), rectangle(0, 0, km2 / (111.2 ** 2 * Math.cos(.5 * Math.PI / 180)), 1), rectangle(5.6, 0, .3, .3), rectangle(50, 0, .3, .3)])];

it('R229 ближайшая береговая часть остаётся, далёкая исключается и самый большой материк сохраняется', () => {
  // Центр вытянутого материка далеко от острова, хотя берега разделены лишь одним градусом.
  const files = generate(edgeFixture());
  assert.equal(polygons(feature(files, 'EDG.geojson')).length, 3);
  assert.equal(polygons(feature(files, 'EDG.main.geojson')).length, 2);
  assert.deepEqual(bounds(feature(files, 'EDG.main.geojson')), [0, 0, 22, 2]);
});
it('R229 остров напротив середины длинного берега остаётся даже без близких исходных вершин', () => {
  // Без уплотнения берега редкие вершины Natural Earth превращают узкий пролив в дальний океан.
  const files = generate([country('STR', [rectangle(0, 0, 20, 2), rectangle(9, -4), rectangle(70, 0)])]);
  assert.equal(polygons(feature(files, 'STR.main.geojson')).length, 2);
  assert.deepEqual(bounds(feature(files, 'STR.main.geojson')), [0, -4, 20, 2]);
});
it('R229 цепочка через крупный остров удерживает следующий, но не удалённую землю', () => {
  // Второй остров слишком далеко от материка: включить его можно лишь продолжив цепь через первый.
  const files = generate(chainFixture(.3));
  assert.equal(polygons(feature(files, 'CHN.main.geojson')).length, 3);
  assert.deepEqual(bounds(feature(files, 'CHN.main.geojson')), [0, 0, 11.9, 1]);
});
it('R229 малый остров остаётся рядом с материком, но не притягивает следующий крупный остров', () => {
  // Регрессия Медвежий остров → Шпицберген: близость малой земли не должна расширять очередь.
  const files = generate(chainFixture(.1));
  assert.equal(polygons(feature(files, 'CHN.main.geojson')).length, 2);
  assert.deepEqual(bounds(feature(files, 'CHN.main.geojson')), [0, 0, 6.1, 1]);
});
it('R229 удалённые 99 км² не дают лишнего вопроса, а 101 км² создают основную часть', () => {
  // Порог относится к суммарной исключённой суше, а не к существованию хоть одного далёкого острова.
  const below = generate(remoteFixture(99)), above = generate(remoteFixture(101));
  assert.equal(below.has('REM.main.geojson'), false); assert.equal(polygons(feature(below, 'REM.geojson')).length, 2);
  assert.equal(above.has('REM.main.geojson'), true); assert.equal(polygons(feature(above, 'REM.main.geojson')).length, 1);
});
it('R229 удалённые мелкие острова суммируются до порога основной части', () => {
  // Каждый остров сам меньше 100 км², но вместе они уже оправдывают выбор территории.
  const width = 60 / (111.2 ** 2 * Math.cos(.05 * Math.PI / 180) * .1);
  assert.equal(generate([country('SUM', [rectangle(0, 0), rectangle(50, 0, width, .1), rectangle(80, 0, width, .1)])]).has('SUM.main.geojson'), true);
});
it('R229 ровно 100 км² удалённой суши уже создают основную часть, 99 км² ещё нет', () => {
  // Ошибка >= → > скрывает законный выбор именно на границе, хотя 99/101 по-прежнему проходят.
  assert.equal(generate(exactRemoteFixture(99)).has('REM.main.geojson'), false);
  assert.equal(generate(exactRemoteFixture(100)).has('REM.main.geojson'), true);
  assert.equal(generate(exactRemoteFixture(101)).has('REM.main.geojson'), true);
});
it('R229 ровно 500 км² продолжают цепочку островов, 499 км² не продолжают', () => {
  // Граничная площадь моста влияет на следующий остров, а не на включение самого моста.
  for (const [km2, count] of [[499, 2], [500, 3], [501, 3]]) assert.equal(polygons(feature(generate(exactChainFixture(km2!)), 'CHN.main.geojson')).length, count);
});
it('R229 шестая колонка синтетического индекса точно соответствует существованию файла основной части', () => {
  // Установщик доверяет индексу; ложная единица приведёт к запросу отсутствующего файла.
  const files = generate([...edgeFixture(), ...remoteFixture(99), country('ONE', [rectangle(0, 0)])]);
  const rows = files.get('index.tsv')!.trimEnd().split('\n').map(row => row.split('\t'));
  assert.equal(rows.length, 3);
  for (const row of rows) { assert.equal(row.length, 6); assert.equal(row[5], files.has(`${row[1]}.main.geojson`) ? '1' : '0'); }
});
it('R227 генератор повторяется побайтово, сортирует индекс и убирает только прежние контуры', () => {
  // Несортированный источник и остатки предыдущего запуска не должны портить воспроизводимый каталог.
  const source = [country('ZZZ', [rectangle(10, 20)]), ...edgeFixture(), country('AAA', [rectangle(-20, 10)])];
  const first = generate(source, 8), second = generate(source, 8);
  assert.deepEqual([...first], [...second]);
  assert.deepEqual(first.get('index.tsv')!.trimEnd().split('\n').map(row => row.split('\t')[1]), ['AAA', 'EDG', 'ZZZ']);
  assert.equal(first.has('OLD.geojson'), false); assert.equal(first.has('OLD.main.geojson'), false); assert.equal(first.get('README.txt'), 'keep');
});
it('R227 нулевой буфер сохраняет границы, настоящий буфер 8 км расширяет все четыре стороны', () => {
  // Заглушка Turf или случайное игнорирование argv выглядели бы зелёными на проверке одних файлов.
  const source = [country('BUF', [rectangle(0, 0)])];
  assert.deepEqual(bounds(feature(generate(source, 0), 'BUF.geojson')), [0, 0, 1, 1]);
  const f = feature(generate(source, 8), 'BUF.geojson'), b = bounds(f);
  assert.ok(b[0]! < -.065 && b[0]! > -.08); assert.ok(b[1]! < -.065 && b[1]! > -.08);
  assert.ok(b[2]! > 1.065 && b[2]! < 1.08); assert.ok(b[3]! > 1.065 && b[3]! < 1.08);
  validContours(f, 'BUF');
});
it('R227 широкий контур буферизуется короткими полосами без растягивания проекции на всю страну', () => {
  // Одна азимутальная проекция на Сибирь раздувала прибрежные полосы и размер скачивания.
  const f = feature(generate([country('WID', [rectangle(-30, 60, 60, 1)])], 8), 'WID.geojson'), b = bounds(f);
  assert.ok(polygons(f).length >= 7);
  for (const polygon of polygons(f)) {
    const xs = polygon[0]!.map(p => p[0]); assert.ok(Math.max(...xs) - Math.min(...xs) < 9.2);
  }
  assert.ok(b[0]! < -30.1 && b[0]! > -30.2); assert.ok(b[2]! > 30.1 && b[2]! < 30.2);
  assert.ok(b[1]! > 59.90 && b[1]! < 59.94); assert.ok(b[3]! > 61.06 && b[3]! < 61.1);
  validContours(f, 'WID');
});
it('R227 крайние части у обоих антимеридианов не превращаются в полосу вокруг мира', () => {
  // Turf может завернуть буфер через ±180; крайние 0,6° должны остаться без расширения.
  const f = feature(generate([country('DAT', [rectangle(179.6, 65, .4, 1), rectangle(-180, 65, .4, 1)])], 8), 'DAT.geojson');
  assert.equal(polygons(f).length, 2); assert.deepEqual(bounds(f), [-180, 65, 180, 66]);
  for (const polygon of polygons(f)) {
    const xs = polygon[0]!.map(p => p[0]); assert.ok(Math.max(...xs) - Math.min(...xs) < .5);
  }
  validContours(f, 'DAT');
});
it('R229 контрфакт расстояние между центрами теряет близкий остров вытянутого материка', () => {
  // Полный модуль получает ошибочную геометрию расстояний, но всё ещё выполняет настоящий pipeline.
  const mutant = replaceOnce('function unitPoints(ring) {\n  const pts = [];', `function unitPoints(ring) {
  const cx = (Math.min(...ring.map(p => p[0])) + Math.max(...ring.map(p => p[0]))) / 2;
  const cy = (Math.min(...ring.map(p => p[1])) + Math.max(...ring.map(p => p[1]))) / 2;
  ring = [[cx, cy], [cx, cy]];
  const pts = [];`);
  strictCounterfact(raw => assert.equal(polygons(feature(generate(edgeFixture(), 0, raw), 'EDG.main.geojson')).length, 2,
    'R229-centers: ближайший берег удерживает остров'), mutant, 'R229-centers:', 1, 2);
});
it('R229 контрфакт без уплотнения длинного берега теряет близкий остров между вершинами', () => {
  // Проверяется не наличие DENSIFY_KM в тексте, а результат вырезки реального генератора.
  const source = [country('STR', [rectangle(0, 0, 20, 2), rectangle(9, -4), rectangle(70, 0)])];
  strictCounterfact(raw => assert.equal(polygons(feature(generate(source, 0, raw), 'STR.main.geojson')).length, 2,
    'R229-densify: середина берега не дальше его концов'), replaceOnce('const k = Math.max(1, Math.ceil(km / DENSIFY_KM));', 'const k = 1;'), 'R229-densify:', 1, 2);
});
it('R229 контрфакт без порога площади создаёт бессмысленный выбор из-за 99 км² суши', () => {
  // Результат наблюдается через реально записанные файлы, а не через копию mainParts.
  strictCounterfact(raw => assert.equal(Number(generate(remoteFixture(99), 0, raw).has('REM.main.geojson')), 0,
    'R229-remote-area: мелкая удалённая суша не требует вопроса'), replaceOnce('return remote >= MAIN_MIN_REMOTE_KM2 ? inMain : null;', 'return remote > 0 ? inMain : null;'), 'R229-remote-area:', 1, 0);
});
it('R229 контрфакт цепочка через любую мелкую часть втягивает дальний остров', () => {
  // Мутант воспроизводит разрастание основной Норвегии через остров меньше 500 км².
  strictCounterfact(raw => assert.equal(polygons(feature(generate(chainFixture(.1), 0, raw), 'CHN.main.geojson')).length, 2,
    'R229-chain-area: мелкий мост не расширяет основную часть'), replaceOnce('if (q.km2 >= MAIN_CHAIN_MIN_KM2) queue.push(j);', 'queue.push(j);'), 'R229-chain-area:', 3, 2);
});
it('R229 контрфакт строгий порог удалённой площади отвергает ровно 100 км²', () => {
  // Парная граничная приёмка исключает невидимое выпадение территории ровно на лимите.
  strictCounterfact(raw => assert.equal(Number(generate(exactRemoteFixture(100), 0, raw).has('REM.main.geojson')), 1,
    'R229-remote-boundary: сто километров уже достаточно'), replaceOnce('return remote >= MAIN_MIN_REMOTE_KM2 ? inMain : null;', 'return remote > MAIN_MIN_REMOTE_KM2 ? inMain : null;'), 'R229-remote-boundary:', 0, 1);
});
it('R229 контрфакт строгий порог моста обрывает цепочку ровно при 500 км²', () => {
  // Контрфакт обязан потерять следующий остров, а не упасть на импорте или файловом доступе.
  strictCounterfact(raw => assert.equal(polygons(feature(generate(exactChainFixture(500), 0, raw), 'CHN.main.geojson')).length, 3,
    'R229-chain-boundary: пятьсот километров продолжают цепочку'), replaceOnce('if (q.km2 >= MAIN_CHAIN_MIN_KM2) queue.push(j);', 'if (q.km2 > MAIN_CHAIN_MIN_KM2) queue.push(j);'), 'R229-chain-boundary:', 2, 3);
});

function actual(name: string): Feature { return JSON.parse(readFileSync(new URL(name, regionDir), 'utf8')); }
const actualRows = () => readFileSync(new URL('index.tsv', regionDir), 'utf8').trimEnd().split('\n').map(row => row.split('\t'));
it('R229 настоящие регионы сохраняют целые RUS DEU JPN MYS IDN и имеют основную FRA USA NLD NOR ESP', () => {
  // Ошибочное отделение Борнео, японского архипелага или Калининграда меняет смысл страны в установщике.
  const files = new Set(readdirSync(regionDir));
  for (const code of ['RUS', 'DEU', 'JPN', 'MYS', 'IDN']) { assert.equal(files.has(`${code}.geojson`), true); assert.equal(files.has(`${code}.main.geojson`), false); }
  for (const code of ['FRA', 'USA', 'NLD', 'NOR', 'ESP']) { assert.equal(files.has(`${code}.geojson`), true); assert.equal(files.has(`${code}.main.geojson`), true); }
});
it('R229 основная США лежит без Аляски и Гавайев, основная Франция без заморских территорий', () => {
  // Одной проверки существования файла недостаточно: в него могла попасть та же полная страна.
  for (const [name, west, south, east, north] of [['USA', -125, 24, -66, 50], ['FRA', -5, 41, 10, 52]] as const) {
    const b = bounds(actual(`${name}.main.geojson`));
    assert.ok(b[0]! >= west && b[2]! <= east && b[1]! >= south && b[3]! <= north, `${name} основная в заданном bbox`);
    assert.ok(b[2]! - b[0]! > (name === 'USA' ? 50 : 10), `${name} не пустая малая часть`);
  }
});
it('R227 все настоящие контуры имеют допустимые координаты и замкнутые непустые кольца', () => {
  // Невалидное кольцо ломает pmtiles extract уже у администратора, после выбора и оценки объёма.
  const files = readdirSync(regionDir).filter(name => name.endsWith('.geojson')); assert.ok(files.length > 200);
  for (const name of files) validContours(actual(name), name);
});
it('R227 Россия сохраняет отдельную сушу у −180 и +180 без кольца через весь мир', () => {
  // Россия не должна потерять Чукотку с одной стороны разреза или получить всемирный прямоугольник.
  const f = actual('RUS.geojson'), pts = points(f);
  assert.equal(pts.some(p => p[0] === -180), true); assert.equal(pts.some(p => p[0] === 180), true);
  for (const polygon of polygons(f)) {
    for (const ring of polygon) for (let i = 1; i < ring.length; i++) assert.ok(Math.abs(ring[i]![0] - ring[i - 1]![0]) <= 180, 'Россия: нет перескока через мир');
  }
});
it('R227 настоящий индекс покрывает каждый файл страны и точно объявляет основные части, каталог не больше 3 МБ', () => {
  // Размер и связность артефактов — часть установщика, который скачивает каталог без генератора.
  const names = readdirSync(regionDir), files = new Set(names), rows = actualRows(); assert.ok(rows.length > 200);
  assert.equal(new Set(rows.map(row => row[1])).size, rows.length);
  for (const row of rows) {
    assert.equal(row.length, 6); assert.match(row[1]!, /^[A-Z]{3}$/); assert.equal(files.has(`${row[1]}.geojson`), true);
    assert.equal(row[5], files.has(`${row[1]}.main.geojson`) ? '1' : '0');
  }
  const indexed = new Set(rows.map(row => `${row[1]}.geojson`));
  for (const name of names.filter(name => name.endsWith('.geojson') && !name.endsWith('.main.geojson'))) assert.equal(indexed.has(name), true);
  assert.ok(names.reduce((sum, name) => sum + statSync(new URL(name, regionDir)).size, 0) <= 3 * 1024 ** 2);
});
