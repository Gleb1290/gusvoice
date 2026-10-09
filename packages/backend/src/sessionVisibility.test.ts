import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createSessionVisibility, HIDDEN_OFFLINE_MS } from './sessionVisibility.js';

function load(from?: string, to?: string): typeof createSessionVisibility {
  let source = readFileSync(new URL('./sessionVisibility.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (from) { assert.equal(source.split(from).length, 2, 'якорь мутанта уникален'); const changed = source.replace(from, to!); assert.notEqual(changed, source); source = changed; }
  const module = { exports: {} as { createSessionVisibility: typeof createSessionVisibility } };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports });
  return module.exports.createSessionVisibility;
}
function check(make: typeof createSessionVisibility) {
  let now = 0; let id = 0; const timers = new Map<number, { at: number; fn: () => void }>(); const events: string[] = [];
  const visibility = make<{ name: string }>({ graceMs: HIDDEN_OFFLINE_MS,
    schedule: (fn, ms) => { timers.set(++id, { fn, at: now + ms }); return id; }, cancel: handle => { timers.delete(handle as number); },
    show: c => events.push(`show:${c.name}`), hide: c => events.push(`hide:${c.name}`) });
  const tick = (ms: number) => { now += ms; for (const [key, job] of timers) if (job.at <= now) { timers.delete(key); job.fn(); } };
  const a = { name: 'a' }; const hidden = { name: 'hidden' }; const unknown = { name: 'unknown' };
  visibility.set(unknown, true); visibility.set(unknown, false); assert.deepEqual(events, []);
  visibility.open(a, false); visibility.open(a, false); visibility.open(hidden, true);
  assert.deepEqual(events, ['show:a'], 'скрытый open не считается присутствием'); assert.equal(visibility.isHidden(hidden), true); assert.equal(visibility.isCounted(hidden), false);
  visibility.set(a, true); visibility.set(a, true); assert.equal(timers.size, 1, 'повторное скрытие не создаёт таймер');
  tick(1999); assert.equal(visibility.isCounted(a), true); assert.equal(visibility.isHidden(a), true);
  visibility.set(a, false); assert.equal(timers.size, 0, 'возврат отменяет таймер'); tick(1); assert.deepEqual(events, ['show:a']);
  visibility.set(a, true); tick(2000); assert.equal(visibility.isCounted(a), false); assert.deepEqual(events, ['show:a', 'hide:a']);
  visibility.close(a); assert.deepEqual(events, ['show:a', 'hide:a'], 'close уже скрытого не вызывает hide повторно');
  visibility.set(a, false); visibility.set(a, true); assert.equal(timers.size, 0); assert.deepEqual(events, ['show:a', 'hide:a']);
  visibility.set(hidden, false); assert.equal(visibility.isCounted(hidden), true); visibility.set(hidden, true); visibility.close(hidden);
  assert.equal(timers.size, 0, 'close отменяет незавершённый уход'); tick(2000); assert.deepEqual(events, ['show:a', 'hide:a', 'show:hidden', 'hide:hidden']);
}
it('видимость сессии: две секунды отсрочки, возврат, повторы и закрытие', () => { assert.equal(HIDDEN_OFFLINE_MS, 2000); check(createSessionVisibility); check(load()); });
for (const [name, from, to, failure] of [
  ['скрытый вход считается видимым', 'counted: !hidden', 'counted: true', 'скрытый open'],
  ['возврат не отменяет таймер', 'if (!hidden) {\n        stopTimer(st);', 'if (!hidden) {', 'возврат отменяет'],
  ['close повторяет hide', 'if (st.counted) {\n        st.counted = false;\n        deps.hide(conn);', '{\n        st.counted = false;\n        deps.hide(conn);', 'close уже скрытого'],
]) it(`видимость сессии: мутант «${name}» пойман`, () => { check(load()); assert.throws(() => check(load(from, to)), (error: unknown) => error instanceof assert.AssertionError && error.message.includes(failure!)); });
