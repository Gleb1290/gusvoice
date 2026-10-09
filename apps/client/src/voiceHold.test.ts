import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { VOICE_HOLD, VOICE_DESKTOP, voiceCancelPath, voiceHoldProgress, voiceHoldRelease, voiceHoldStep } from './voiceHold.js';

describe('жест удержания голосового сообщения', () => {
  it('D19 старт телефона с кружками ровно 150 мс, не прежние 120 мс ПК и не немедленный', () => {
    const raw = readFileSync(new URL('./voiceHold.ts', import.meta.url), 'utf8');
    const check = (source: string) => {
      const module = { exports: {} };
      runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
        { module, exports: module.exports });
      const rules = module.exports as typeof import('./voiceHold');
      assert.equal(rules.VOICE_HOLD.startDelayMs, 150, 'тап до 150 мс только меняет режим');
      assert.equal(rules.VOICE_DESKTOP.holdDelayMs, 120, 'задержка ПК не изменилась');
    };
    check(raw);
    for (const value of [0, 120]) {
      const changed = raw.replace('startDelayMs: 150', `startDelayMs: ${value}`);
      assert.notEqual(changed, raw);
      assert.throws(() => check(changed), assert.AssertionError);
    }
  });
  it('контрфакты строгости порогов и полной доли отмены отвергаются теми же границами', () => {
    // Ловит незаметное изменение включённости границы и возврат отмены только на полном пути.
    const raw = readFileSync(new URL('./voiceHold.ts', import.meta.url), 'utf8');
    const load = (from: string, to: string) => {
      const source = raw.replace(from, to); assert.notEqual(source, raw);
      const module = { exports: {} };
      runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports });
      return module.exports as typeof import('./voiceHold');
    };
    assert.throws(() => assert.equal(load('-dy >= VOICE_HOLD.lockDy', '-dy > VOICE_HOLD.lockDy').voiceHoldStep(0, -57), 'lock'), assert.AssertionError);
    assert.throws(() => assert.equal(load('heldMs < VOICE_HOLD.minHoldMs', 'heldMs <= VOICE_HOLD.minHoldMs').voiceHoldRelease(701), 'send'), assert.AssertionError);
    assert.throws(() => assert.equal(load('cancelShare: 0.55', 'cancelShare: 1').voiceHoldRelease(1000, -56, 100), 'cancel'), assert.AssertionError);
  });

  it('реальные обработчики ПК ждут 120 мс, короткий клик начинает без рук, отпускание снаружи отменяет', () => {
    // Ловит запуск удержания до таймера и неверную геометрию отпускания в склейке с компонентом.
    const raw = readFileSync(new URL('./components/MessagePane.tsx', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('MessagePane.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const names = ['onDeskMicDown', 'onDeskMicUp', 'onDeskMicAbort']; const bodies: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name && names.includes(n.name.text)) bodies.push(n.getText(ast));
      ts.forEachChild(n, visit);
    }; visit(ast); assert.equal(bodies.length, 3);
    let timer: (() => void) | undefined; let delay = 0; let cleared = 0; let starts = 0; let holds = 0;
    let inside = true; const releases: boolean[] = []; const aborts: number[] = [];
    const micPressRef = { current: null as { id: number; held: boolean; timer: number } | null };
    const context = { micPressRef, VOICE_DESKTOP, window: { setTimeout: (fn: () => void, ms: number) => { timer = fn; delay = ms; return 1; } },
      clearTimeout: () => { cleared++; timer = undefined; },
      document: { elementFromPoint: () => inside ? { closest: () => ({}) } : null },
      voice: { getState: () => ({ holdUi: null }), press: () => { holds++; return 'hold'; }, start: () => { starts++; },
        release: (p: { outside: boolean }) => releases.push(p.outside), abort: (p: { id: number }) => aborts.push(p.id) } };
    const code = ts.transpileModule(bodies.join('\n') + '\nthis.api={onDeskMicDown,onDeskMicUp,onDeskMicAbort};', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const sandbox = { ...context, api: {} as Record<string, (e: unknown) => void> }; runInNewContext(code, sandbox);
    const e = { pointerType: 'mouse', button: 0, pointerId: 1, clientX: 1, clientY: 1, preventDefault() {}, currentTarget: { setPointerCapture() {} } };
    sandbox.api.onDeskMicDown(e); assert.equal(delay, 120); assert.equal(holds, 0);
    sandbox.api.onDeskMicUp(e); assert.equal(starts, 1); assert.equal(cleared, 1); assert.equal(holds, 0);
    for (inside of [true, false]) {
      sandbox.api.onDeskMicDown(e); timer!(); sandbox.api.onDeskMicUp(e);
    }
    assert.equal(holds, 2); assert.deepEqual(releases, [false, true]);
    sandbox.api.onDeskMicDown(e); timer!(); sandbox.api.onDeskMicAbort(e); assert.deepEqual(aborts, [1]);
  });
  it('ровно порог подъёма фиксирует запись, а пикселем ниже ещё держит', () => {
    // Ловит ошибку на единицу, из-за которой жест фиксации ощущается случайным.
    assert.equal(voiceHoldStep(0, -VOICE_HOLD.lockDy), 'lock');
    assert.equal(voiceHoldStep(0, -VOICE_HOLD.lockDy + 1), 'hold');
  });

  it('ровно порог движения влево отменяет запись, а пикселем раньше ещё держит', () => {
    // Ловит слишком раннюю отмену и потерю уже записанного сообщения.
    assert.equal(voiceHoldStep(-VOICE_HOLD.cancelDx, 0), 'cancel');
    assert.equal(voiceHoldStep(-VOICE_HOLD.cancelDx + 1, 0), 'hold');
  });

  it('при одновременном прохождении обоих порогов фиксация побеждает отмену', () => {
    // Ловит потерю записи при быстром диагональном движении пальца.
    assert.equal(voiceHoldStep(-VOICE_HOLD.cancelDx, -VOICE_HOLD.lockDy), 'lock');
  });

  it('движение вправо и вниз ничего не запускает', () => {
    // Ловит перепутанный знак экранных координат.
    assert.equal(voiceHoldStep(500, 500), 'hold');
  });

  it('прогресс ограничен диапазоном от нуля до единицы', () => {
    // Ловит вылет подсказок за экран при движении не в ту сторону или далеко за порог.
    assert.deepEqual(voiceHoldProgress(50, 50), { lock: 0, cancel: 0 });
    assert.deepEqual(voiceHoldProgress(-VOICE_HOLD.cancelDx * 2, -VOICE_HOLD.lockDy * 2), {
      lock: 1,
      cancel: 1,
    });
  });

  it('701 мс уже отправляются, а 700 мс считаются промахом', () => {
    // Ловит рассогласование порога подсказки с фактической отправкой записи.
    assert.equal(voiceHoldRelease(VOICE_HOLD.minHoldMs - 1), 'short');
    assert.equal(voiceHoldRelease(VOICE_HOLD.minHoldMs), 'send');
  });

  it('путь отмены равен 35 процентам ширины, но не превышает 140', () => {
    // Ловит одинаковый длинный жест на узком телефоне и уход порога за максимальный путь.
    assert.equal(voiceCancelPath(200), 70);
    assert.equal(voiceCancelPath(399), 140);
    assert.equal(voiceCancelPath(400), 140);
    assert.equal(voiceCancelPath(1000), 140);
    for (const width of [undefined, 0, -1, NaN, Infinity]) assert.equal(voiceCancelPath(width), 140);
    assert.equal(VOICE_HOLD.lockDy, 57);
    assert.equal(VOICE_DESKTOP.holdDelayMs, 120);
    assert.equal(VOICE_DESKTOP.minTakeMs, 1000);
  });

  it('отпускание на 55 процентах пути отменяет, за долю пикселя до него отправляет', () => {
    // Ловит замену доли отмены полным путём: потерю намерения отменить до края жеста.
    const threshold = 100 * 0.55; // IEEE754: произведение чуть больше целого 55.
    assert.equal(voiceHoldRelease(1000, -threshold, 100), 'cancel');
    assert.equal(voiceHoldRelease(1000, -54.99, 100), 'send');
    assert.equal(voiceHoldRelease(700, -threshold, 100), 'cancel');
    assert.equal(voiceHoldStep(-69.99, -56.99, 70), 'hold');
    assert.equal(voiceHoldStep(-70, -56.99, 70), 'cancel');
    assert.equal(voiceHoldStep(-70, -57, 70), 'lock');
    assert.equal(voiceHoldRelease(700), 'short');
    assert.equal(voiceHoldRelease(701), 'send');
  });
});
