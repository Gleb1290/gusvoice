import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { refreshViewportVars } from './popover';

const source = readFileSync(new URL('./popover.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function fixture(raw = source) {
  const values = new Map<string, string>();
  const root = { clientWidth: 800, clientHeight: 600, style: { setProperty: (key: string, value: string) => { values.set(key, value); } } };
  let zoom = 1;
  const module = { exports: {} as { refreshViewportVars: typeof refreshViewportVars } };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText, { module, exports: module.exports, document: { documentElement: root }, window: { visualViewport: null },
    getComputedStyle: () => ({ zoom: String(zoom) }), require: (id: string) => assert.fail(`Неожиданный импорт ${id}`),
  }, { timeout: 1000 });
  return { root, values, refresh: () => module.exports.refreshViewportVars(), zoom: (z: number) => { zoom = z; } };
}
function preserves(raw: string) {
  const f = fixture(raw);
  f.refresh();
  const previous = [...f.values];
  for (const [w, h] of [[0, 0], [0, 600], [800, 0], [0.999, 600], [800, 0.999]]) {
    f.root.clientWidth = w!; f.root.clientHeight = h!; f.refresh();
    assert.deepEqual([...f.values], previous, 'R354/viewport/zero-preserves');
  }
}
it('R354 нулевой или меньше пикселя размер не стирает прошлые viewport-переменные', () => {
  // Свёрнутый WebView не должен навсегда опубликовать 0px и обнулить потолки всех окон.
  preserves(source);
  counterfact(() => {
    const needle = 'if (vw >= 1 && vh >= 1) {';
    assert.equal(source.split(needle).length, 2);
    assert.throws(() => preserves(source.replace(needle, 'if (true) {')), (error: unknown) =>
      error instanceof assert.AssertionError && error.message.split('\n')[0] === 'R354/viewport/zero-preserves');
  });
});
it('R354 первое нулевое окно не публикует переменные, граница один пиксель и восстановление принимаются', () => {
  // Проверяем обе стороны >=1 и обновление после нормализации окна, не только подавление нуля.
  const f = fixture();
  f.root.clientWidth = 0; f.root.clientHeight = 0; f.refresh(); assert.equal(f.values.size, 0);
  f.root.clientWidth = 1; f.root.clientHeight = 1; f.refresh();
  assert.deepEqual(Object.fromEntries(f.values), { '--vw-px': '1px', '--vh-px': '1px' });
  f.root.clientWidth = 800; f.root.clientHeight = 600; f.zoom(2); f.refresh();
  assert.deepEqual(Object.fromEntries(f.values), { '--vw-px': '400px', '--vh-px': '300px' });
});
