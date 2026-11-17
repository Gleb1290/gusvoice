import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createPttController, pttFeedbackOpen, pttMicTarget, pttButtonShouldToggle } from './pttController';

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture(apply?: (open: boolean) => Promise<unknown>) {
  const calls: boolean[] = [];
  const timers = new Map<number, { fn(): void; ms: number }>();
  const errors: unknown[] = [];
  let id = 0;
  let allowed = true;
  const ptt = createPttController({
    canOpen: () => allowed,
    apply: async (open) => { calls.push(open); await apply?.(open); },
    releaseMs: () => 150,
    setTimer: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    clearTimer: (timer) => { timers.delete(timer as number); },
    onError: (error) => { errors.push(error); },
  });
  return { ptt, calls, errors, timers, allow: (next: boolean) => { allowed = next; },
    tick() { const pending = [...timers.values()]; timers.clear(); for (const t of pending) t.fn(); },
  };
}

it('удержание открывает микрофон один раз, отпускание сохраняет хвост 150 мс', async () => {
  const f = fixture();
  f.ptt.press('ui'); f.ptt.press('ui'); await flush();
  assert.deepEqual(f.calls, [true]);
  f.ptt.release('ui');
  assert.equal([...f.timers.values()][0]?.ms, 150);
  assert.deepEqual(f.calls, [true]);
  f.tick(); await flush();
  assert.deepEqual(f.calls, [true, false]);
});

it('повторное удержание в хвосте отменяет прежнее закрытие', async () => {
  const f = fixture();
  f.ptt.press('ui'); await flush(); f.ptt.release('ui');
  f.ptt.press('ui'); await flush();
  assert.equal(f.timers.size, 0);
  f.tick(); await flush();
  assert.equal(f.calls.at(-1), true);
  f.ptt.release('ui'); f.tick(); await flush();
  assert.equal(f.calls.at(-1), false);
});

it('отмена UI не отпускает отдельно удерживаемую нативную рацию', async () => {
  const f = fixture();
  const ui = Symbol();
  f.ptt.press(ui); f.ptt.press('android'); await flush();
  f.ptt.release(ui, true); await flush();
  assert.equal(f.calls.at(-1), true);
  f.ptt.release('android', true); await flush();
  assert.equal(f.calls.at(-1), false);
  assert.equal(f.timers.size, 0);
});

it('отпускание нативной рации не перебивает удержание кнопки приложения', async () => {
  const f = fixture();
  f.ptt.press('android'); f.ptt.press('ui'); await flush();
  f.ptt.release('android', true); await flush();
  assert.equal(f.calls.at(-1), true);
  f.ptt.release('ui'); f.tick(); await flush();
  assert.equal(f.calls.at(-1), false);
});

it('аварийное отпускание закрывает сразу и отменяет уже запущенный хвост', async () => {
  const f = fixture();
  f.ptt.press('ui'); await flush(); f.ptt.release('ui');
  f.ptt.release('ui', true); await flush();
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.calls, [true, false]);
  f.ptt.release('ui', true); await flush();
  assert.deepEqual(f.calls, [true, false]);
});

it('размонтирование другой кнопки не обрывает чужой хвост', async () => {
  const f = fixture();
  f.ptt.press('ui'); await flush(); f.ptt.release('ui');
  f.ptt.release('other-ui', true);
  assert.equal(f.timers.size, 1);
  f.tick(); await flush(); assert.equal(f.calls.at(-1), false);
});

it('запрет mute, deafen или публикации не позволяет начать передачу', async () => {
  const f = fixture(); f.allow(false); f.ptt.press('ui'); await flush();
  assert.deepEqual(f.calls, []);
  f.allow(true); f.ptt.press('ui'); await flush();
  assert.deepEqual(f.calls, [true]);
  f.allow(false); f.ptt.reset(); await flush();
  assert.deepEqual(f.calls, [true, false]);
});

it('быстрое отпускание до завершения захвата закрывает запоздавший микрофон', async () => {
  let grant!: () => void;
  const acquiring = new Promise<void>((resolve) => { grant = resolve; });
  const f = fixture((open) => open ? acquiring : Promise.resolve());
  f.ptt.press('ui'); f.ptt.release('ui', true); await flush();
  assert.deepEqual(f.calls, [true]);
  grant(); await flush();
  assert.deepEqual(f.calls, [true, false]);
});

it('размонтирование во время захвата закрывает микрофон и не принимает новых нажатий', async () => {
  let grant!: () => void;
  const acquiring = new Promise<void>((resolve) => { grant = resolve; });
  const f = fixture((open) => open ? acquiring : Promise.resolve());
  f.ptt.press('ui'); f.ptt.dispose(); f.ptt.press('ui');
  grant(); await flush();
  assert.deepEqual(f.calls, [true, false]);
  assert.equal(f.timers.size, 0);
});

it('отказ захвата очищает удержание: новое нажатие может повторить попытку', async () => {
  let denied = true;
  const f = fixture(async (open) => { if (open && denied) throw new Error('denied'); });
  f.ptt.press('ui'); await flush();
  assert.deepEqual(f.calls, [true, false]); assert.equal(f.errors.length, 1);
  denied = false; f.ptt.press('ui'); await flush();
  assert.equal(f.calls.at(-1), true);
});

it('смена режима или прав отменяет удержания и таймер до следующего нажатия', async () => {
  const f = fixture(); f.ptt.press('ui'); await flush(); f.ptt.release('ui');
  f.ptt.reset(); await flush(); assert.equal(f.timers.size, 0);
  f.tick(); await flush(); assert.deepEqual(f.calls, [true, false]);
  f.ptt.press('ui'); await flush(); assert.equal(f.calls.at(-1), true);
});

it('зелёное состояние требует реальный открытый микрофон с правами, громкость не участвует', () => {
  const open = { ptt: true, connected: true, muted: false, deafened: false,
    canPublish: true, micEnabled: true, trackLive: true };
  assert.equal(pttFeedbackOpen(open), true);
  for (const field of ['ptt', 'connected', 'canPublish', 'micEnabled', 'trackLive'] as const) {
    assert.equal(pttFeedbackOpen({ ...open, [field]: false }), false, field);
  }
  assert.equal(pttFeedbackOpen({ ...open, muted: true }), false);
  assert.equal(pttFeedbackOpen({ ...open, deafened: true }), false);
});

it('контроллер без собственного удержания не закрывает обычный open mic при reset и cleanup', async () => {
  const f = fixture();
  f.ptt.reset(); f.ptt.dispose(); await flush();
  assert.deepEqual(f.calls, []);
});

it('поздний захват после смены режима учитывает актуальный open mic, mute и deafen', async () => {
  for (const intent of [{ muted: false, deafened: false }, { muted: true, deafened: false },
    { muted: false, deafened: true }]) {
    let grant!: () => void;
    const capture = new Promise<void>((resolve) => { grant = resolve; });
    let pttMode = true;
    const calls: boolean[] = [];
    const f = fixture(async (requested) => {
      const enabled = pttMicTarget(requested, { disposed: false, ptt: pttMode, connected: true,
        ...(!pttMode ? intent : { muted: false, deafened: false }), canPublish: true });
      calls.push(enabled);
      if (calls.length === 1) await capture;
    });
    f.ptt.press('ui');
    pttMode = false; f.allow(false); f.ptt.reset();
    grant(); await flush();
    assert.deepEqual(calls, [true, !intent.muted && !intent.deafened]);
    f.ptt.dispose(); await flush();
    assert.equal(calls.length, 2); // Ownership was handed back to open mic, no late cleanup-close.
  }
});

it('клик заглушённой рации только размьючивает, отпускание передачи не мьютит', () => {
  const active = { active: true, blocked: true, unmuteGesture: true, suppressClick: true };
  assert.equal(pttButtonShouldToggle(active), true);
  assert.equal(pttButtonShouldToggle({ ...active, blocked: false }), false);
  assert.equal(pttButtonShouldToggle({ ...active, unmuteGesture: false }), false);
  assert.equal(pttButtonShouldToggle({ ...active, active: false, suppressClick: false }), true);
  assert.equal(pttButtonShouldToggle({ ...active, active: false }), false);
});
