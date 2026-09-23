import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createVoiceHoldController, type HoldRecording, type HoldTake, type VoiceHoldDeps } from './voiceHoldController.js';

type Take = HoldTake & { id: string };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

function harness(overrides: Partial<VoiceHoldDeps<Take>> = {}) {
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
    controller: createVoiceHoldController(deps), recording, take, calls,
    setNow(value: number) { now = value; },
    setWallNow(value: number) { wallNow = value; },
  };
}

const point = (id = 1, x = 100, y = 100) => ({ id, x, y });

describe('жизненный цикл удержания голосового сообщения', () => {
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
