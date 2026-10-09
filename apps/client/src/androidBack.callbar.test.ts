import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';

const source = readFileSync(new URL('./androidBack.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load(raw = source, now = () => 0) {
  const module = { exports: {} as { isBackRepeat(ms: number): boolean; BACK_REPEAT_MS: number; installAndroidBack(): void; stepBack(): boolean; pushBackHandler(fn: () => boolean): () => void } };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    module, exports: module.exports, window, document, KeyboardEvent, performance: { now },
    require: (id: string) => id === './hotkeys' ? { isAndroid: () => true } : { useStore: { getState: () => ({}) } },
  });
  return module.exports;
}
function mutate(from: string, to: string) { assert.ok(source.includes(from)); const next = source.replace(from, to); assert.notEqual(next, source); return next; }

it('повтор назад подавляется только в полуинтервале от нуля до 250 мс', () => {
  GlobalRegistrator.register();
  try {
    const check = (raw: string) => {
      const api = load(raw); assert.equal(api.BACK_REPEAT_MS, 250);
      for (const [ms, expected] of [[0,true],[249,true],[250,false],[1000,false],[-1,false]] as const) assert.equal(api.isBackRepeat(ms), expected, `интервал ${ms}`);
    };
    check(source);
    assert.throws(() => check(mutate('ms < BACK_REPEAT_MS', 'ms <= BACK_REPEAT_MS')), /интервал 250/);
    assert.throws(() => check(mutate('ms >= 0 && ', '')), /интервал -1/);
  } finally { GlobalRegistrator.unregister(); }
});

it('Android доставляет один шаг на два одновременных назад и следующий через 300 мс', () => {
  GlobalRegistrator.register();
  try {
    const check = (raw: string) => {
      let now = 1000; let steps = 0;
      const api = load(raw, () => now); api.pushBackHandler(() => { steps++; return true; }); api.installAndroidBack();
      const back = (window as unknown as { __gvBack(): void }).__gvBack;
      back(); back(); assert.equal(steps, 1, 'повтор не делает второй шаг');
      now += 300; back(); assert.equal(steps, 2, 'новый жест делает следующий шаг');
    };
    check(source);
    assert.throws(() => check(mutate('    last = now;', '')), /повтор не делает второй шаг/);
  } finally { GlobalRegistrator.unregister(); }
});

it('слой получает единственный Esc на document, всплывающий единожды до window', () => {
  GlobalRegistrator.register();
  try {
    const sheet = document.createElement('div'); sheet.className = 'sheet'; document.body.append(sheet);
    const check = (raw: string) => {
      let docs = 0; let wins = 0;
      const onDoc = (e: KeyboardEvent) => { if (e.key === 'Escape') docs++; };
      const onWin = (e: KeyboardEvent) => { if (e.key === 'Escape') wins++; };
      document.addEventListener('keydown', onDoc); window.addEventListener('keydown', onWin);
      try { assert.equal(load(raw).stepBack(), true); assert.equal(docs, 1); assert.equal(wins, 1, 'window получает один Esc'); }
      finally { document.removeEventListener('keydown', onDoc); window.removeEventListener('keydown', onWin); }
    };
    check(source);
    assert.throws(() => check(mutate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));", "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));")), /window получает один Esc/);
  } finally { GlobalRegistrator.unregister(); }
});
