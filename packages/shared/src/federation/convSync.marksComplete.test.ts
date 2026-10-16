import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as fields from './fieldRules';
import * as wire from './convWire';

type Api = typeof import('./convSync');
const source = readFileSync(new URL('./convSync.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/v1/${name}.json`, import.meta.url), 'utf8'));
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
function load(raw = source): Api {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, require(id: string) {
      if (id === './fieldRules') return fields;
      assert.equal(id, './convWire'); return wire;
    },
  });
  return module.exports as Api;
}
it('R217 полная страница отметок Э7 проходит настоящий разбор и сборку побайтно по JSON', () => {
  // Признак полноты нельзя потерять: без него снятые во время разрыва отметки останутся навсегда.
  const api = load(), raw = fixture('conv-export-page-marks-e7'), page = api.parseConvExportPage(raw);
  assert.ok(page); assert.equal(page.marksComplete, true);
  assert.deepEqual(plain(api.serializeConvExportPage(page)), raw);
});
for (const invalid of ['yes', false, 1, null] as const) it(`R217 marks_complete=${JSON.stringify(invalid)} не обещает полную выгрузку`, () => {
  const api = load(), page = api.parseConvExportPage({ ...fixture('conv-export-page-marks-e7'), marks_complete: invalid });
  assert.ok(page); assert.equal(page.marksComplete, undefined);
  assert.equal(Object.hasOwn(api.serializeConvExportPage(page), 'marks_complete'), false);
});
function oldPage(raw = source) {
  const api = load(raw), old = fixture('conv-export-page'), page = api.parseConvExportPage(old);
  assert.ok(page); assert.equal(page.marksComplete, undefined);
  const serialized = api.serializeConvExportPage(page);
  assert.equal(Object.hasOwn(serialized, 'marks_complete'), false, 'R217-old-export: старый провод не получает обещание полноты');
  assert.deepEqual(plain(serialized), old);
}
it('R217 отсутствие нового признака сохраняет старую страницу экспорта без добавленного поля', () => oldPage());
it('R217 контрфакт сериализатор всегда обещает полную выгрузку даже старой странице', () => {
  oldPage(source);
  const from = '...(p.marksComplete ? { marks_complete: true } : {}),';
  assert.equal(source.split(from).length - 1, 1);
  assert.throws(() => oldPage(source.replace(from, 'marks_complete: true,')), e => e instanceof assert.AssertionError
    && e.message.startsWith('R217-old-export:') && e.operator === 'strictEqual' && e.actual === true && e.expected === false);
});
