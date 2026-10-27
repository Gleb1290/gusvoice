import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

export const sourceOf = (name: string) => readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
export function mutate(source: string, anchor: string, replacement: string): string {
  assert.equal(source.split(anchor).length - 1, 1, `единственный точный якорь: ${anchor}`);
  return source.replace(anchor, replacement);
}
/** Исполняется весь модуль, не вырезанная функция; новые runtime-границы требуют явного решения теста. */
export function load<T>(source: string, deps: Record<string, unknown> = {}, globals: Record<string, unknown> = {}): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, console, URL, setTimeout, clearTimeout,
    ...globals, require: (id: string) => {
      assert.ok(Object.hasOwn(deps, id), `Неописанная граница R304: ${id}`);
      return deps[id];
    } });
  return module.exports as T;
}
