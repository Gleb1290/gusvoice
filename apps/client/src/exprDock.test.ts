import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './exprDock';

function replaceSource(source: string, from: string, to: string): string {
  assert.ok(source.includes(from), `найдена точка мутации: ${from}`);
  const changed = source.replace(from, to);
  assert.notEqual(changed, source, `мутант изменил исходник: ${from}`);
  return changed;
}

function load(source: string, storage: { values: Map<string, string>; writes: string[]; removals: string[]; failGet?: boolean; failSet?: boolean }): typeof rules {
  const module = { exports: {} as Record<string, unknown> };
  const localStorage = {
    getItem: (key: string) => { if (storage.failGet) throw new Error('storage unavailable'); return storage.values.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (storage.failSet) throw new Error('storage unavailable'); storage.values.set(key, value); storage.writes.push(`${key}=${value}`); },
    removeItem: (key: string) => { storage.values.delete(key); storage.removals.push(key); },
  };
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports, localStorage,
    require: () => ({ useCallback: (f: unknown) => f, useLayoutEffect: () => {}, useState: (v: unknown) => [v, () => {}] }),
  });
  return module.exports as typeof rules;
}

it('закреплённая колонка помещается ровно от 725 пикселей, а 724 ещё тесно', () => {
  // Ошибка на один пиксель либо перекрывает ленту, либо зря прячет доступную третью колонку.
  const check = (api: typeof rules) => {
    assert.equal(api.exprDockFits(724), false);
    assert.equal(api.exprDockFits(725), true);
  };
  check(rules);
  const source = readFileSync(new URL('./exprDock.ts', import.meta.url), 'utf8');
  check(load(source, { values: new Map(), writes: [], removals: [] }));
  const broken = load(replaceSource(source, 'chatWidth >= EXPR_DOCK_MIN_CHAT', 'chatWidth >= 380'), { values: new Map(), writes: [], removals: [] });
  assert.throws(() => check(broken), assert.AssertionError, 'мутант разрешает колонку, которая не вмещается');
});

it('настройка колонки по умолчанию выключена, включение хранится как 1', () => {
  // Неверный default раскрывает панель без выбора пользователя; устойчивое значение переживает перезапуск.
  const source = readFileSync(new URL('./exprDock.ts', import.meta.url), 'utf8');
  const storage = { values: new Map<string, string>(), writes: [] as string[], removals: [] as string[] };
  const api = load(source, storage);
  assert.equal(api.getExprDock(), false);
  api.setExprDock(true);
  assert.equal(api.getExprDock(), true);
  assert.deepEqual(storage.writes, ['gv_expr_dock=1']);
  assert.equal(load(source, storage).getExprDock(), true);
});

it('битое хранилище не включает колонку, а private mode не ломает чтение и запись', () => {
  // Старое/повреждённое значение не должно неожиданно закрепить панель; запрет браузерного storage не должен ломать чат.
  const source = readFileSync(new URL('./exprDock.ts', import.meta.url), 'utf8');
  for (const value of ['0', 'true', '']) {
    const stale = { values: new Map([['gv_expr_dock', value]]), writes: [] as string[], removals: [] as string[] };
    assert.equal(load(source, stale).getExprDock(), false, `неизвестное значение ${JSON.stringify(value)} не включает панель`);
  }
  const unreadable = { values: new Map<string, string>(), writes: [] as string[], removals: [] as string[], failGet: true };
  assert.equal(load(source, unreadable).getExprDock(), false);
  const unwritable = { values: new Map<string, string>(), writes: [] as string[], removals: [] as string[], failSet: true };
  assert.doesNotThrow(() => load(source, unwritable).setExprDock(true));
});

it('выключение удаляет ключ, а не сохраняет отдельное ложное значение', () => {
  // Удаление возвращает настройку к безопасному default и не копит две конкурирующие формы состояния.
  const source = readFileSync(new URL('./exprDock.ts', import.meta.url), 'utf8');
  const check = (api: typeof rules, storage: { values: Map<string, string>; writes: string[]; removals: string[] }) => {
    api.setExprDock(false);
    assert.equal(storage.values.has('gv_expr_dock'), false);
    assert.deepEqual(storage.removals, ['gv_expr_dock']);
  };
  const normalStore = { values: new Map<string, string>([['gv_expr_dock', '1']]), writes: [] as string[], removals: [] as string[] };
  check(load(source, normalStore), normalStore);
  const brokenStore = { values: new Map<string, string>([['gv_expr_dock', '1']]), writes: [] as string[], removals: [] as string[] };
  const broken = load(replaceSource(source, "else localStorage.removeItem(KEY);", "else localStorage.setItem(KEY, '0');"), brokenStore);
  assert.throws(() => check(broken, brokenStore), assert.AssertionError, 'мутант оставляет ложный ключ в хранилище');
});
