import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as actual from './wheelFx.js';

type Fx = typeof actual;
const source = readFileSync(new URL('./wheelFx.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const near = (value: number, expected: number, address: string) =>
  assert.ok(Math.abs(value - expected) < 1e-8, `${address}: ${value} ≠ ${expected}`);

/** Отменённые callbacks сохраняются отдельно: можно доставить уже снятый таймер как запоздалый. */
class Clock {
  now = 1000;
  private id = 0;
  readonly pending = new Map<number, { at: number; fn: () => void }>();
  readonly cancelled: (() => void)[] = [];
  readonly setTimeout = (fn: () => void, ms = 0) => {
    const id = ++this.id;
    this.pending.set(id, { at: this.now + ms, fn });
    return id;
  };
  readonly clearTimeout = (id: number) => {
    const timer = this.pending.get(id);
    if (timer) this.cancelled.push(timer.fn);
    this.pending.delete(id);
  };
  advance(ms: number) {
    const target = this.now + ms;
    let turns = 0;
    while (true) {
      const first = [...this.pending].sort((a, b) => a[1].at - b[1].at)[0];
      if (!first || first[1].at > target) break;
      assert.ok(++turns < 100, 'R352/parrot/prepare таймер не должен зациклиться');
      this.pending.delete(first[0]);
      this.now = first[1].at;
      first[1].fn();
    }
    this.now = target;
  }
}

function withClock(run: (clock: Clock) => void) {
  const clock = new Clock();
  const saved = ['setTimeout', 'clearTimeout'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: clock.setTimeout });
  Object.defineProperty(globalThis, 'clearTimeout', { configurable: true, value: clock.clearTimeout });
  try { run(clock); } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

function changed(before: string, after: string, clock?: Clock): Fx {
  assert.equal(source.split(before).length - 1, 1, 'R352/parrot/prepare единственный якорь мутанта');
  const module = { exports: {} };
  // Мутант — весь самостоятельный модуль; таймеры и часы принадлежат проверке.
  const output = ts.transpileModule(source.replace(before, after), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  runInNewContext(output, { module, exports: module.exports,
    setTimeout: clock?.setTimeout, clearTimeout: clock?.clearTimeout,
  }, { timeout: 1000, filename: 'wheelFx.parrot.r352.cjs' });
  return module.exports as Fx;
}

test('R352 цикл казначея имеет период три и нормализует отрицательный номер шага', () => {
  // Обход через ноль не должен давать несуществующий кадр или отрицательную длительность.
  for (let i = -12; i <= 12; i++) {
    const k = ((i % 3) + 3) % 3;
    const step = actual.parrotIdleStep(i, 0.5);
    assert.equal(step.frame, ['sit1', 'sit2', 'sit3'][k]);
    assert.equal(step.ms, [3000, 400, 700][k]);
    const next = actual.parrotIdleStep(i + 3, 0.5);
    assert.deepEqual(next, step, `повтор через три шага от ${i}`);
  }
});

function durationContract(fx: Fx) {
  for (const [rnd, ms] of [[-Infinity, 2000], [-5, 2000], [0, 2000], [0.5, 3000], [1, 4000], [5, 4000], [Infinity, 4000]] as const) {
    assert.equal(fx.parrotIdleStep(0, rnd).ms, ms, 'R352/parrot/durations пауза с дублоном ограничена двумя–четырьмя секундами');
  }
  assert.equal(fx.parrotIdleStep(1, 0).ms, 400, 'R352/parrot/durations подброс не превращается в долгую паузу');
  assert.equal(fx.parrotIdleStep(2, 1).ms, 700, 'R352/parrot/durations ловля отличается от подброса');
}

test('R352 паузы ожидания зажаты по rnd, а подброс и ловля не равны — контрфакт метронома', () => {
  durationContract(actual);
  counterfact(() => {
    const mutant = changed('ms: P.toss, breath: 1', 'ms: P.catch, breath: 1');
    assert.throws(() => durationContract(mutant), error => error instanceof assert.AssertionError &&
      error.message.includes('R352/parrot/durations'));
  });
});

test('R352 вдох растягивает только sit1, остальные кадры возвращают нормальный масштаб', () => {
  assert.equal(actual.PARROT_BREATH, 1.015);
  for (let i = -3; i <= 5; i++) {
    const step = actual.parrotIdleStep(i, 0.25);
    assert.equal(step.breath, step.frame === 'sit1' ? actual.PARROT_BREATH : 1);
  }
});

test('R352 активирование сразу рисует sit1 и затем идёт по всем срокам parrotIdleStep', () => withClock(clock => {
  const seen: [actual.ParrotFrame, number, number][] = [];
  const idle = new actual.ParrotIdle((...args) => { seen.push(args); }, () => 0.5, () => clock.now);
  try {
    idle.setActive(true);
    assert.deepEqual(seen, [['sit1', 1.015, 3000]]);
    idle.setActive(true);
    assert.equal(seen.length, 1, 'повтор того же состояния не перезапускает кадр');
    clock.advance(2999);
    assert.equal(seen.length, 1);
    clock.advance(1);
    assert.deepEqual(seen[1], ['sit2', 1, 400]);
    clock.advance(399);
    assert.equal(seen.length, 2);
    clock.advance(1);
    assert.deepEqual(seen[2], ['sit3', 1, 700]);
    clock.advance(699);
    assert.equal(seen.length, 3);
    clock.advance(1);
    assert.deepEqual(seen[3], ['sit1', 1.015, 3000]);
    assert.equal(clock.pending.size, 1, 'одновременно живёт только один таймер');
  } finally { idle.dispose(); }
}));

function resumeContract(fx: Fx, clock: Clock) {
  const seen: actual.ParrotFrame[] = [];
  const idle = new fx.ParrotIdle(frame => { seen.push(frame); }, () => 0, () => clock.now);
  try {
    idle.setActive(true);
    clock.advance(700);
    idle.setPaused(true);
    assert.equal(clock.pending.size, 0, 'R352/parrot/resume пауза снимает таймер');
    clock.advance(10000);
    assert.deepEqual(seen, ['sit1'], 'R352/parrot/resume настенные часы на паузе не двигают кадры');
    idle.setPaused(false);
    assert.deepEqual(seen, ['sit1'], 'R352/parrot/resume возврат не повторяет apply текущего кадра');
    clock.advance(1299);
    assert.deepEqual(seen, ['sit1'], 'R352/parrot/resume сохранённый остаток ещё не кончился');
    clock.advance(1);
    assert.deepEqual(seen, ['sit1', 'sit2'], 'R352/parrot/resume кадр меняется ровно по остатку');
  } finally { idle.dispose(); }
}

test('R352 пауза хранит остаток без повторного apply — контрфакт перезапуска при возврате', () => {
  withClock(clock => resumeContract(actual, clock));
  counterfact(() => {
    const clock = new Clock();
    const mutant = changed('this.wait(this.left);\n      this.left = 0;', 'this.i = 0;\n      this.step();\n      this.left = 0;', clock);
    assert.throws(() => resumeContract(mutant, clock), error => error instanceof assert.AssertionError &&
      error.message.includes('R352/parrot/resume'));
  });
});

test('R352 несколько пауз съедают только время работы, а повтор setPaused не сбрасывает остаток', () => withClock(clock => {
  const seen: actual.ParrotFrame[] = [];
  const idle = new actual.ParrotIdle(frame => { seen.push(frame); }, () => 0, () => clock.now);
  try {
    idle.setActive(true);
    clock.advance(500);
    idle.setPaused(true);
    clock.advance(8000);
    idle.setPaused(true);
    idle.setPaused(false);
    clock.advance(200);
    idle.setPaused(true);
    clock.advance(8000);
    idle.setPaused(false);
    idle.setPaused(false);
    clock.advance(1299);
    assert.deepEqual(seen, ['sit1']);
    clock.advance(1);
    assert.deepEqual(seen, ['sit1', 'sit2']);
  } finally { idle.dispose(); }
}));

test('R352 выключение снимает таймер, игнорирует поздний callback и возвращается с sit1', () => withClock(clock => {
  const seen: actual.ParrotFrame[] = [];
  const idle = new actual.ParrotIdle(frame => { seen.push(frame); }, () => 0, () => clock.now);
  try {
    idle.setActive(true);
    clock.advance(2000);
    assert.deepEqual(seen, ['sit1', 'sit2']);
    idle.setActive(false);
    assert.equal(clock.pending.size, 0);
    for (const stale of clock.cancelled) stale();
    clock.advance(10000);
    assert.deepEqual(seen, ['sit1', 'sit2'], 'неактивная сцена не получает apply даже от снятого callback');
    idle.setActive(true);
    assert.deepEqual(seen, ['sit1', 'sit2', 'sit1']);
    clock.advance(1999);
    assert.equal(seen.length, 3);
    clock.advance(1);
    assert.deepEqual(seen, ['sit1', 'sit2', 'sit1', 'sit2']);
  } finally { idle.dispose(); }
}));

test('R352 dispose навсегда снимает таймер и не позволяет активировать умершую сцену', () => withClock(clock => {
  const seen: actual.ParrotFrame[] = [];
  const idle = new actual.ParrotIdle(frame => { seen.push(frame); }, () => 0, () => clock.now);
  idle.setActive(true);
  idle.dispose();
  idle.dispose();
  assert.equal(clock.pending.size, 0);
  for (const stale of clock.cancelled) stale();
  idle.setActive(false);
  idle.setActive(true);
  idle.setPaused(true);
  idle.setPaused(false);
  clock.advance(10000);
  assert.deepEqual(seen, ['sit1']);
  assert.equal(clock.pending.size, 0);
}));

test('R352 активация под паузой не рисует до возврата и не оживляет снятый цикл', () => withClock(clock => {
  const seen: actual.ParrotFrame[] = [];
  const idle = new actual.ParrotIdle(frame => { seen.push(frame); }, () => 0, () => clock.now);
  try {
    idle.setPaused(true);
    idle.setActive(true);
    assert.deepEqual(seen, []);
    assert.equal(clock.pending.size, 0);
    idle.setPaused(false);
    assert.deepEqual(seen, ['sit1']);
    clock.advance(500);
    idle.setPaused(true);
    idle.setActive(false);
    idle.setPaused(false);
    clock.advance(10000);
    assert.deepEqual(seen, ['sit1'], 'возврат неактивной сцены не планирует кадры');
    idle.setActive(true);
    assert.deepEqual(seen, ['sit1', 'sit1']);
    assert.equal(clock.pending.size, 1);
  } finally { idle.dispose(); }
}));

test('R352 попугай сидит watch до 400 мс, cheer до щели, затем летит jp1 и jp2', () => {
  for (const [ms, frame, ride] of [[-1, 'watch', true], [0, 'watch', true], [399.999, 'watch', true],
    [400, 'cheer', true], [799.999, 'cheer', true], [800, 'jp1', false], [1319.999, 'jp1', false],
    [1320, 'jp2', false], [1540, 'jp2', false], [3600, 'jp2', false]] as const) {
    const p = actual.parrotJackpotAt(ms, actual.chestPoseAt(ms));
    assert.equal(p.frame, frame, `кадр в ${ms}`);
    assert.equal(p.ride, ride, `опора в ${ms}`);
    if (ride) assert.equal(p.lift, 0);
  }
});

test('R352 верхний кадр входит снизу за 220 мс и после входа не опускается ниже опоры', () => {
  const half = actual.CHEST_STEPS.half;
  near(actual.parrotJackpotAt(half, actual.chestPoseAt(half)).lift, -60, 'вход jp2 начинается ниже верхней опоры');
  for (let ms = half + 220; ms <= actual.CHEST_STEPS.end; ms++) {
    assert.ok(actual.parrotJackpotAt(ms, actual.chestPoseAt(ms)).lift >= 0, `после входа подъём неотрицателен в ${ms}`);
  }
  for (const ms of [actual.CHEST_STEPS.end + 1, 100000]) {
    assert.ok(actual.parrotJackpotAt(ms, actual.chestPoseAt(ms)).lift >= 0, `покой после сцены сохраняет подъём в ${ms}`);
  }
});

test('R352 лапы казначея не ближе десяти пикселей к крышке на всей раскадровке полёта', () => {
  // Замер versioned PNG (429×560 поверх 429×384, y+176): alpha>=128; плотные оранжевые пиксели лап,
  // последние 15 px их высоты; минимум (верх крышки в том же столбце − y лапы).
  // jp1/crack=21, jp2/half=85, jp2/open=13, jp2/burst=7. Это данные рисунков, не копия формулы lift.
  const frameGap: Partial<Record<actual.ChestFrame, number>> = { 1: 21, 2: 85, 3: 13, 4: 7 };
  const times = new Set<number>();
  for (let ms = actual.CHEST_STEPS.crack; ms <= actual.CHEST_STEPS.end; ms++) times.add(ms);
  for (const ms of Object.values(actual.CHEST_STEPS)) for (const delta of [-0.001, 0, 0.001]) {
    if (ms + delta >= actual.CHEST_STEPS.crack) times.add(ms + delta);
  }
  for (const ms of times) {
    const chest = actual.chestPoseAt(ms);
    const p = actual.parrotJackpotAt(ms, chest);
    const gap = frameGap[chest.frame];
    assert.equal(typeof gap, 'number', `есть замер для кадра ${chest.frame}`);
    const clearance = gap! + p.lift - (chest.sy - 1) * 371;
    assert.ok(clearance >= 10, `R352/parrot/clearance лапы над крышкой: ${clearance} px в ${ms} мс`);
  }
});

function noEarlyBurst(fx: Fx) {
  const S = fx.CHEST_STEPS;
  for (const ms of [S.half, S.half + 100, S.windup - 1, S.windup, S.windup + 1, S.windup + 100, S.burst - 1, S.burst - 0.001]) {
    const chest = fx.chestPoseAt(ms);
    const k = Math.max(0, Math.min(1, (ms - S.half) / 220));
    const enter = -60 * Math.pow(1 - k, 3);
    const stretch = Math.max(0, chest.sy - 1) * 371;
    near(fx.parrotJackpotAt(ms, chest).lift, enter + stretch + fx.parrotBob(ms - S.half),
      'R352/parrot/no-early-burst до выстрела нет добавочного подъёма');
  }
  const ms = S.burst + 100;
  const chest = fx.chestPoseAt(ms);
  near(fx.parrotJackpotAt(ms, chest).lift - Math.max(0, chest.sy - 1) * 371 - fx.parrotBob(ms - S.half),
    22, 'R352/parrot/no-early-burst после выстрела добавлены полные 22 px');
}

test('R352 подъём на 22 пикселя начинается только на burst — контрфакт старта с windup', () => {
  noEarlyBurst(actual);
  counterfact(() => {
    const mutant = changed(
      'ms < S.burst ? 0 : ms < S.settle ? 22 * easeOut(clamp01((ms - S.burst) / 100))',
      'ms < S.windup ? 0 : ms < S.settle ? 22 * easeOut(clamp01((ms - S.windup) / 100))');
    assert.throws(() => noEarlyBurst(mutant), error => error instanceof assert.AssertionError &&
      error.message.includes('R352/parrot/no-early-burst'));
  });
});

test('R352 покачивание попугая всегда направлено вверх и ограничено шестью пикселями', () => {
  // Несколько полных периодов и отрицательное время ловят sin вместо неотрицательного 1−cos.
  for (let ms = -10000; ms <= 10000; ms += 7) {
    const bob = actual.parrotBob(ms);
    assert.ok(bob >= 0 && bob <= 6, `покачивание ${bob} в ${ms}`);
  }
  for (const period of [-3, -1, 0, 1, 3]) {
    near(actual.parrotBob(period * 2 * Math.PI * 140), 0, 'возврат в опору');
    near(actual.parrotBob((period * 2 + 1) * Math.PI * 140), 6, 'верхняя точка');
  }
});
