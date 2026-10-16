import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('./stageViewPrefs.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const key = 'gv_stage_hide_novideo';
function load(initial?: string, broken = false, raw = source) {
  const values = new Map(initial === undefined ? [] : [[key, initial]]);
  const storage = {
    getItem: (k: string) => { if (broken) throw Error('storage unavailable'); return values.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (broken) throw Error('storage unavailable'); values.set(k, v); },
    removeItem: (k: string) => { if (broken) throw Error('storage unavailable'); values.delete(k); },
  };
  const module = { exports: {} as { getHideNoVideo(): boolean; setHideNoVideo(v: boolean): void;
    onHideNoVideo(fn: () => void): () => void; useHideNoVideo(): boolean } };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, localStorage: storage,
      require: (id: string) => { assert.equal(id, 'react'); return { useSyncExternalStore: (_subscribe: unknown, snapshot: () => boolean) => snapshot() }; } });
  return { ...module.exports, values };
}
it('R163 без сохранённого выбора показываются все участники', () => {
  const f = load(); assert.equal(f.getHideNoVideo(), false); assert.equal(f.useHideNoVideo(), false);
});
it('R163 только строка 1 скрывает участников; чужие и битые значения показывают всех', () => {
  for (const value of ['1', '0', 'true', '', '{bad', ' 1']) {
    const f = load(value); assert.equal(f.getHideNoVideo(), value === '1'); assert.equal(f.useHideNoVideo(), value === '1');
  }
});
function roundTrip(raw = source) {
  const f = load(undefined, false, raw); f.setHideNoVideo(true);
  assert.equal(f.values.get(key), '1'); assert.equal(f.getHideNoVideo(), true); assert.equal(f.useHideNoVideo(), true);
  f.setHideNoVideo(false); assert.equal(f.values.has(key), false); assert.equal(f.getHideNoVideo(), false); assert.equal(f.useHideNoVideo(), false);
}
it('R163 включение пишет 1, выключение удаляет ключ и обновляет снимок', () => roundTrip());
it('R163 недоступное хранилище не ломает локальный выбор до перезагрузки', () => {
  const f = load(undefined, true); assert.equal(f.getHideNoVideo(), false);
  f.setHideNoVideo(true); assert.equal(f.useHideNoVideo(), true); assert.equal(f.getHideNoVideo(), false);
  f.setHideNoVideo(false); assert.equal(f.useHideNoVideo(), false);
});
it('R163 исключение слушателя изолировано, отписанный слушатель больше не вызывается', () => {
  const f = load(); const events: boolean[] = [];
  const offBad = f.onHideNoVideo(() => { throw Error('bad listener'); });
  const offGood = f.onHideNoVideo(() => events.push(f.useHideNoVideo()));
  assert.doesNotThrow(() => f.setHideNoVideo(true)); assert.deepEqual(events, [true]);
  offGood(); f.setHideNoVideo(false); assert.deepEqual(events, [true]); offBad();
});
it('R163 мутант без удаления ключа обнаруживается поведением сохранённого выбора', () => {
  const anchor = 'else localStorage.removeItem(KEY);'; assert.equal(source.split(anchor).length - 1, 1);
  roundTrip(); assert.throws(() => roundTrip(source.replace(anchor, 'else {}')), assert.AssertionError);
});
