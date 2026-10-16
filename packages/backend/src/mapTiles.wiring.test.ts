import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as threats from './linkThreatsRules.js';

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const featureRaw = read('./instanceFeatures.ts');
function features(path: string | undefined, yandex: string | undefined, source = featureRaw): string[] {
  const module = { exports: {} as { INSTANCE_FEATURES?: string[] } };
  const deps: Record<string, unknown> = { '@gusvoice/shared': shared, './linkThreatsRules.js': threats };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, process: { env: { MAP_PMTILES_PATH: path, YANDEX_MAPS_STATIC_KEY: yandex } },
      require(id: string) { assert.equal(Object.hasOwn(deps, id), true, `явный импорт features: ${id}`); return deps[id]; } });
  return module.exports.INSTANCE_FEATURES!;
}
it('R224 osmmap1 включается только непустым путём, yamap1 независим и не дублируется', () => {
  for (const path of [undefined, '', ' \t ', '/maps/test.pmtiles', ' /maps/test.pmtiles ']) for (const key of [undefined, '', ' ', 'fixture-key']) {
    const result = features(path, key); assert.equal(result.filter(x => x === 'osmmap1').length, path?.trim() ? 1 : 0);
    assert.equal(result.filter(x => x === 'yamap1').length, key?.trim() ? 1 : 0);
  }
});
it('R224 index подключает маршрут плиток только внутри env.mapPmtilesPath, env нормализует пробелы', () => {
  const index = ts.createSourceFile('index.ts', read('./index.ts'), ts.ScriptTarget.Latest, true);
  const calls: ts.CallExpression[] = [];
  function walk(n: ts.Node) { if (ts.isCallExpression(n) && n.expression.getText(index) === 'api.register' && n.arguments[0]?.getText(index) === 'mapsTilesRoutes') calls.push(n); ts.forEachChild(n, walk); }
  walk(index); assert.equal(calls.length, 1);
  let parent: ts.Node | undefined = calls[0];
  while (parent && !ts.isIfStatement(parent)) parent = parent.parent;
  assert.ok(parent && ts.isIfStatement(parent)); assert.equal(parent.expression.getText(index), 'env.mapPmtilesPath');
  const env = ts.createSourceFile('env.ts', read('./env.ts'), ts.ScriptTarget.Latest, true); const properties: ts.PropertyAssignment[] = [];
  function scan(n: ts.Node) { if (ts.isPropertyAssignment(n) && n.name.getText(env) === 'mapPmtilesPath') properties.push(n); ts.forEachChild(n, scan); }
  scan(env); assert.equal(properties.length, 1); assert.equal(properties[0]!.initializer.getText(env), "(process.env.MAP_PMTILES_PATH ?? '').trim()");
});
it('R224 Docker передаёт MAP_PMTILES_PATH именно backend и монтирует карты только для чтения', () => {
  const compose = read('../../../docker-compose.yml'), lines = compose.split('\n');
  const start = lines.findIndex(line => /^  backend:\s*$/.test(line)); assert.ok(start >= 0);
  let end = lines.findIndex((line, index) => index > start && /^  [\w-]+:\s*$/.test(line)); if (end < 0) end = lines.length;
  const backend = lines.slice(start, end), environment = backend.findIndex(line => /^    environment:/.test(line)), volumes = backend.findIndex(line => /^    volumes:/.test(line));
  assert.ok(environment >= 0 && volumes > environment);
  assert.equal(backend.slice(environment, volumes).filter(line => /^      MAP_PMTILES_PATH: \$\{MAP_PMTILES_PATH:-\}$/.test(line)).length, 1);
  assert.equal(backend.slice(volumes).filter(line => /^      - \$\{MAP_PMTILES_DIR:-\.\/maps\}:\/maps:ro$/.test(line)).length, 1);
});
it('R224 контрфакт: пробелы не объявляют работоспособную карту', () => {
  const check = (source: string) => assert.equal(features('   ', undefined, source).includes('osmmap1'), false, 'R224-feature-space: пустой путь не признак');
  check(featureRaw); const anchor = 'process.env.MAP_PMTILES_PATH?.trim()'; assert.equal(featureRaw.split(anchor).length - 1, 1);
  assert.throws(() => check(featureRaw.replace(anchor, 'process.env.MAP_PMTILES_PATH')), e => e instanceof assert.AssertionError
    && e.message.startsWith('R224-feature-space:') && e.operator === 'strictEqual' && e.actual === true && e.expected === false);
});
