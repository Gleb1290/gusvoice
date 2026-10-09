import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as trim from './voiceTrim';

const id = (n: number) => [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255].filter((_, i, a) => i >= a.findIndex(v => v !== 0));
const sized = (elementId: number[], body: number[]) => [...elementId, 0x80 | body.length, ...body];
const uint = (n: number) => n > 255 ? [n >>> 8, n & 255] : [n];
const timecode = (n: number) => sized([0xe7], uint(n));
const block = (relative: number) => sized([0xa3], [0x81, relative >>> 8 & 255, relative & 255, 0, 0x55]);

function webm(groups: Array<{ base: number; rels: number[] }>): Uint8Array {
  const header = [...id(0x1a45dfa3), 0x80];
  const tracks = sized(id(0x1654ae6b), [0]);
  const clusters = groups.flatMap(({ base, rels }) => [...id(0x1f43b675), 0xff, ...timecode(base), ...rels.flatMap(block)]);
  return Uint8Array.from([...header, ...id(0x18538067), 0xff, ...tracks, ...clusters]);
}

function mutant(from: string, to: string): typeof trim {
  const source = readFileSync(new URL('./voiceTrim.ts', import.meta.url), 'utf8');
  assert.ok(source.includes(from), 'точка мутации найдена');
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: () => ({ WAVEFORM_BUCKETS: 48 }) });
  return module.exports as typeof trim;
}

it('обрезка оставляет только [from,to), сдвигает первый блок в ноль и не съедает следующий кластер', () => {
  const input = webm([{ base: 0, rels: [1000, 1500, 2500] }, { base: 3000, rels: [0, 1000] }]);
  const output = trim.cutWebm(input, 1500, 4000);
  assert.ok(output);
  const parsed = trim.parseWebm(output);
  assert.deepEqual(parsed?.blocks.map(b => b.at), [0, 1000, 1500]);
  assert.equal(parsed?.blocks.some(b => b.at === 2500), false, 'блок на исходной правой границе исключён после сдвига');
  assert.ok(trim.parseWebm(input), 'неизвестный размер кластера обрывается ровно на следующем 4-байтном идентификаторе');
  const noClusterBoundary = mutant('if (sz.size < 0 && cid.len === 4) break;', '');
  assert.equal(noClusterBoundary.parseWebm(input), null, 'мутант заглатывает следующий кластер и ломает разбор записи');
  const mutantEnd = mutant('b.at < toMs', 'b.at <= toMs');
  assert.throws(() => assert.deepEqual(mutantEnd.parseWebm(mutantEnd.cutWebm(input, 1500, 4000)!)?.blocks.map(b => b.at), [0, 1000, 1500]), assert.AssertionError,
    'мутант протаскивает блок, который ровно попал на правую границу');
  const mutantClock = mutant('const rel = b.at - start - base;', 'const rel = b.at - base;');
  assert.throws(() => assert.equal(mutantClock.parseWebm(mutantClock.cutWebm(input, 1500, 4000)!)?.blocks[0]?.at, 0), assert.AssertionError,
    'мутант оставляет абсолютный timestamp вместо нуля');
});

it('кластер короче 30 секунд, а неподдерживаемые BlockGroup и не-WebM безопасно дают null', () => {
  const input = webm([{ base: 0, rels: [0, 29000, 30000, 31000] }]);
  const out = trim.cutWebm(input, 0, 40000);
  assert.ok(out);
  const parsed = trim.parseWebm(out)!;
  assert.deepEqual(parsed.blocks.map(b => b.at), [0, 29000, 30000, 31000]);
  const clusterId = id(0x1f43b675);
  const countClusters = (buf: Uint8Array) => Array.from({ length: buf.length - 3 }, (_, i) => clusterId.every((b, j) => buf[i + j] === b)).filter(Boolean).length;
  assert.equal(countClusters(out), 2, 'на отметке 30 с создаётся следующий кластер, а не блок со знаковым переполнением');
  const noSpanGuard = mutant('kept[i].at - start - base < CLUSTER_SPAN_MS', 'true');
  assert.throws(() => assert.equal(countClusters(noSpanGuard.cutWebm(input, 0, 40000)!), 2), assert.AssertionError,
    'мутант кладёт отрезок длиннее 30 секунд в один кластер');
  assert.equal(trim.parseWebm(Uint8Array.from([0, 1, 2])), null);
  assert.equal(trim.cutWebm(input, 35000, 39000), null);
  const group = Uint8Array.from([...id(0x1a45dfa3), 0x80, ...id(0x18538067), 0xff,
    ...sized(id(0x1654ae6b), [0]), ...id(0x1f43b675), 0xff, ...timecode(0), ...sized([0xa0], [0])]);
  assert.equal(trim.parseWebm(group), null);
  assert.ok(parsed.blocks.every((b, i, a) => i === 0 || b.at - a[i - 1]!.at <= 30000));
});

it('ручки держат минимум одну секунду, край справа значит до конца, огибающая выдаёт 48 столбиков', () => {
  assert.deepEqual(trim.voiceTrimFromRatios(0.25, 1, 10000), { fromMs: 2500, toMs: null });
  assert.deepEqual(trim.voiceTrimFromRatios(0.9999, 1, 5000), { fromMs: 4000, toMs: null });
  assert.deepEqual(trim.voiceTrimFromRatios(0.5, 0.51, 5000), { fromMs: 2500, toMs: 3500 });
  assert.equal(trim.voiceTrimIsFull(null), true);
  assert.equal(trim.voiceTrimIsFull({ fromMs: 0, toMs: null }), true);
  const wave = Array.from({ length: 100 }, (_, i) => i);
  const result = trim.trimWaveform(wave, 0.25, 0.75);
  assert.equal(result.length, 48);
  assert.ok(result.every(n => n >= 25 && n <= 74));
  assert.deepEqual(trim.trimWaveform([], 0, 1), []);
});
