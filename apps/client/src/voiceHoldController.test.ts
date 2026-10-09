import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';
import ts from 'typescript';
import * as holdRules from './voiceHold.js';
import { createVoiceHoldController, type HoldRecording, type HoldTake, type VoiceHoldDeps } from './voiceHoldController.js';

type Take = HoldTake & { id: string };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

function harness(overrides: Partial<VoiceHoldDeps<Take>> = {}, factory = createVoiceHoldController<Take>) {
  let now = 0;
  let wallNow = 1_000;
  const calls = { cancelled: 0, stopped: 0, sent: [] as string[], released: [] as string[], toasts: [] as string[] };
  const take: Take = { id: 'take', durationMs: 800 };
  const recording: HoldRecording<Take> = {
    startedAt: 1_000,
    level: () => 0.75,
    stop: async () => { calls.stopped += 1; return take; },
    cancel: () => { calls.cancelled += 1; },
  };
  const deps: VoiceHoldDeps<Take> = {
    openMic: async () => recording,
    send: async (value) => { calls.sent.push(value.id); },
    previewUrl: (value) => `blob:${value.id}`,
    releasePreviewUrl: (url) => { calls.released.push(url); },
    toast: (_kind, title) => { calls.toasts.push(title); },
    toastError: (err) => { throw err; },
    now: () => now,
    wallNow: () => wallNow,
    maxMs: 120_000,
    onChange: () => {},
    ...overrides,
  };
  return {
    controller: factory(deps), recording, take, calls,
    setNow(value: number) { now = value; },
    setWallNow(value: number) { wallNow = value; },
  };
}

const point = (id = 1, x = 100, y = 100) => ({ id, x, y });

describe('жизненный цикл удержания голосового сообщения', () => {
  it('dispose во время незавершённой паузы сразу гасит микрофон, поздний снимок не создаёт превью', async () => {
    // Регрессия R40: локальный рекордер между rec и pausedRec раньше терялся при уходе со страницы.
    const paused = deferred<Take>(); const h = harness(); let snapshots = 0;
    const f = harness({ openMic: async () => ({ ...h.recording, pause: () => paused.promise }), previewUrl: () => { snapshots++; return 'blob:late'; } });
    await f.controller.start(); const stopping = f.controller.stop(); f.controller.dispose();
    assert.ok(h.calls.cancelled >= 1, 'устройство закрыто до завершения асинхронного снимка');
    paused.resolve(h.take); await stopping;
    assert.equal(snapshots, 0); assert.equal(f.controller.getState().preview, null);
    assert.equal(f.controller.getState().paused, false); assert.deepEqual(f.calls.sent, []);
  });
  it('на ПК уход влево не отменяет, отпускание вне поля отменяет, 999 мс не отправляются', async () => {
    // Ловит применение мобильной отмены и мобильного порога длины к настольной записи.
    for (const outside of [false, true]) {
      const h = harness({ minTakeMs: () => 1000 }); h.take.durationMs = 1000;
      h.controller.press(point(), { desktop: true }); await tick();
      h.controller.move(point(1, -200, 100));
      assert.equal(h.calls.cancelled, 0);
      h.controller.release({ id: 1, outside }); await tick();
      assert.deepEqual(h.calls.sent, outside ? [] : ['take']);
      assert.equal(h.calls.cancelled, outside ? 1 : 0);
    }
    const short = harness({ minTakeMs: () => 1000 }); short.take.durationMs = 999;
    await short.controller.start(); await short.controller.finish();
    assert.deepEqual(short.calls.sent, []);
    const raw = readFileSync(new URL('./voiceHoldController.ts', import.meta.url), 'utf8');
    const altered = raw.replace('take.durationMs < minTake()', 'take.durationMs < minTake() - 1');
    assert.notEqual(raw, altered);
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(altered, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { module, exports: module.exports, require: (id: string) => { assert.equal(id, './voiceHold'); return holdRules; } });
    const bad = harness({ minTakeMs: () => 1000 }, (module.exports as typeof import('./voiceHoldController')).createVoiceHoldController<Take>);
    bad.take.durationMs = 999; await bad.controller.start(); await bad.controller.finish();
    assert.throws(() => assert.deepEqual(bad.calls.sent, []), assert.AssertionError);
  });

  it('пауза продолжает тот же рекордер, отправка берёт окончательный файл, а не снимок', async () => {
    // Ловит отправку старого снимка и повторное открытие микрофона при продолжении.
    let resumes = 0; const h = harness();
    h.recording.pause = async () => ({ id: 'snapshot', durationMs: 800 });
    h.recording.resume = () => { resumes++; };
    await h.controller.start(); await h.controller.stop();
    assert.equal(h.controller.getState().paused, true);
    assert.equal(h.calls.stopped, 0);
    h.controller.resume(); assert.equal(resumes, 1);
    assert.equal(h.controller.getState().recording, true);
    assert.deepEqual(h.calls.released, ['blob:snapshot']);
    await h.controller.stop(); await h.controller.sendPreview();
    assert.equal(h.calls.stopped, 1);
    assert.deepEqual(h.calls.sent, ['take']);
    assert.equal(h.controller.getState().paused, false);
  });

  it('корзина и dispose гасят рекордер на паузе и освобождают адрес ровно один раз', async () => {
    // Ловит оставшийся занятым микрофон после удаления прослушивания.
    for (const action of ['discardPreview', 'dispose'] as const) {
      const h = harness(); h.recording.pause = async () => h.take;
      await h.controller.start(); await h.controller.stop();
      h.controller[action](); h.controller[action]();
      assert.equal(h.calls.cancelled, 1);
      assert.deepEqual(h.calls.released, ['blob:take']);
      assert.deepEqual(h.calls.sent, []);
    }
  });

  it('tick использует записанное время без пауз, промах показывает hint вместо тоста', async () => {
    // Ловит бегущий на паузе таймер и две конкурирующие подсказки после промаха.
    let hints = 0; const h = harness({ hint: () => { hints++; } });
    h.recording.elapsed = () => 321;
    h.controller.press(point()); await tick(); h.setWallNow(99000); h.controller.tick();
    assert.equal(h.controller.getState().recMs, 321);
    h.setNow(700); h.controller.release({ id: 1 }); await tick();
    assert.equal(hints, 1); assert.deepEqual(h.calls.toasts, []);
    const fallback = harness(); fallback.controller.press(point()); await tick();
    fallback.setNow(700); fallback.controller.release({ id: 1 });
    assert.equal(fallback.calls.toasts.length, 1);
  });
  it('два keyboard-click до открытия микрофона запускают только одну запись', async () => {
    // Регрессия утечки: вторая запись затирала ссылку на первую, и первую уже нельзя было остановить.
    const opened = deferred<HoldRecording<Take>>();
    let opens = 0;
    const h = harness({ openMic: () => { opens += 1; return opened.promise; } });
    h.controller.keyboardClick();
    h.controller.keyboardClick();
    assert.equal(opens, 1);
    opened.resolve(h.recording);
    await tick();
    assert.equal(h.controller.getState().recording, true);
    h.controller.dispose();
    assert.equal(h.calls.cancelled, 1);
  });

  it('отпускание до медленного открытия микрофона отменяет запись сразу после открытия', async () => {
    // Ловит горящий микрофон без интерфейса после закрытия системного запроса разрешения.
    const opened = deferred<HoldRecording<Take>>();
    const h = harness({ openMic: () => opened.promise });
    h.controller.press(point());
    h.setNow(600);
    h.controller.release({ id: 1 });
    opened.resolve(h.recording);
    await tick();
    assert.equal(h.calls.cancelled, 1);
    assert.equal(h.controller.getState().recording, false);
  });

  it('смахивание вверх до открытия превращает будущую запись в режим без рук', async () => {
    // Ловит потерю фиксации жеста во время системного диалога микрофона.
    const opened = deferred<HoldRecording<Take>>();
    const h = harness({ openMic: () => opened.promise });
    h.controller.press(point());
    h.controller.move(point(1, 100, 30));
    assert.equal(h.controller.getState().holdUi, null);
    opened.resolve(h.recording);
    await tick();
    assert.equal(h.controller.getState().recording, true);
    assert.equal(h.controller.getState().holdUi, null);
  });

  it('системный abort отменяет сказанное и ничего не отправляет', async () => {
    // Ловит отправку обрывка после входящего звонка или потери захвата указателя.
    const h = harness();
    h.controller.press(point());
    await tick();
    h.controller.abort({ id: 1 });
    await tick();
    assert.equal(h.calls.cancelled, 1);
    assert.deepEqual(h.calls.sent, []);
  });

  it('повторное нажатие во время записи без рук становится send-press и отпускание отправляет', async () => {
    // Ловит запуск второй записи поверх зафиксированной вместо ожидаемой кнопки отправки.
    const h = harness();
    h.controller.press(point());
    h.controller.move(point(1, 100, 30));
    await tick();
    assert.equal(h.controller.press(point(2)), 'send-press');
    h.controller.release({ id: 2 });
    await tick();
    assert.deepEqual(h.calls.sent, ['take']);
    assert.equal(h.calls.stopped, 1);
  });

  it('удержание короче полсекунды отменяется и показывает подсказку жеста', async () => {
    // Ловит случайную отправку короткого касания и молчаливую непонятную отмену.
    const h = harness();
    h.controller.press(point());
    await tick();
    h.setNow(499);
    h.controller.release({ id: 1 });
    assert.equal(h.calls.cancelled, 1);
    assert.deepEqual(h.calls.toasts, ['Держи кнопку, пока говоришь']);
    assert.deepEqual(h.calls.sent, []);
  });

  it('stop создаёт preview, а sendPreview отправляет запись и освобождает URL', async () => {
    // Ловит утечку blob URL и отправку не той остановленной записи.
    const h = harness();
    await h.controller.start();
    await h.controller.stop();
    assert.equal(h.controller.getState().preview?.url, 'blob:take');
    await h.controller.sendPreview();
    assert.deepEqual(h.calls.sent, ['take']);
    assert.deepEqual(h.calls.released, ['blob:take']);
    assert.equal(h.controller.getState().preview, null);
  });

  it('discardPreview и dispose освобождают каждый адрес ровно один раз', async () => {
    // Ловит двойной revoke одного URL и накопление URL при уходе со страницы.
    const discarded = harness();
    await discarded.controller.start();
    await discarded.controller.stop();
    discarded.controller.discardPreview();
    discarded.controller.dispose();
    assert.deepEqual(discarded.calls.released, ['blob:take']);

    const disposed = harness();
    await disposed.controller.start();
    await disposed.controller.stop();
    disposed.controller.dispose();
    disposed.controller.dispose();
    assert.deepEqual(disposed.calls.released, ['blob:take']);
  });

  it('tick останавливает показ времени на maxMs, но сохраняет текущий уровень', async () => {
    // Ловит таймер, который визуально бежит дальше фактического потолка записи.
    const h = harness();
    await h.controller.start();
    h.setWallNow(999_999);
    h.controller.tick();
    assert.equal(h.controller.getState().recMs, 120_000);
    assert.equal(h.controller.getState().recLevel, 0.75);
  });
});
