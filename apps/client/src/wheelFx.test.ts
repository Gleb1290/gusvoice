import assert from 'node:assert/strict';
import { mutantTest } from '../../../packages/shared/test/counterfacts.js';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as fx from './wheelFx';

const near = (actual: number, expected: number, why: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${why}: ${actual} ≠ ${expected}`);

/** Настоящий цикл, но очередь кадров и время принадлежат проверке, не часам машины. */
function withRaf(run: (clock: { tick: (ms: number) => void; queue: Map<number, FrameRequestCallback>; cancelled: number[] }) => void) {
  const saved = ['requestAnimationFrame', 'cancelAnimationFrame'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const queue = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  let next = 0;
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (fn: FrameRequestCallback) => {
    const id = ++next;
    queue.set(id, fn);
    return id;
  } });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => {
    cancelled.push(id);
    queue.delete(id);
  } });
  try {
    run({ queue, cancelled, tick(ms) {
      const ready = [...queue.values()];
      queue.clear();
      for (const fn of ready) fn(ms);
    } });
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

function chestContract(module: Pick<typeof fx, 'chestPoseAt' | 'CHEST_BURST_MS' | 'CHEST_FX_MS'>) {
  assert.equal(module.CHEST_BURST_MS, 1690, 'R351 удар совпадает с первым кадром взрыва');
  assert.equal(module.chestPoseAt(module.CHEST_BURST_MS).frame, 4, 'R351 в момент выстрела показан кадр взрыва');
  assert.equal(module.chestPoseAt(module.CHEST_FX_MS).fly, 1, 'R351 возврат сундука завершается полностью');
}

test('R351 сундук меняет все пять кадров ровно на границах раскадровки', () => {
  // Обе стороны каждой границы ловят сдвинутый кадр и неравенство на единицу.
  for (const [ms, frame] of [[-1, 0], [0, 0], [799.999, 0], [800, 1], [1319.999, 1], [1320, 2],
    [1539.999, 2], [1540, 3], [1689.999, 3], [1690, 4], [2069.999, 4], [2070, 3], [3600, 3], [10000, 3]] as const) {
    assert.equal(fx.chestPoseAt(ms).frame, frame, `кадр в ${ms} мс`);
  }
  chestContract(fx);
});

test('R351 затемнение вырастает с нуля и гаснет только при полном возврате сундука', () => {
  assert.equal(fx.chestPoseAt(0).veil, 0);
  assert.ok(fx.chestPoseAt(110).veil > 0 && fx.chestPoseAt(110).veil < 1);
  assert.equal(fx.chestPoseAt(220).veil, 1);
  assert.equal(fx.chestPoseAt(3150).fly, 0);
  near(fx.chestPoseAt(3375).fly, 0.5, 'полпути домой');
  near(fx.chestPoseAt(3375).veil, 0.5, 'полузатухший фон');
  for (const ms of [3600, 3601, 100000]) {
    assert.equal(fx.chestPoseAt(ms).fly, 1, `полёт окончен в ${ms}`);
    assert.equal(fx.chestPoseAt(ms).veil, 0, `фон погас в ${ms}`);
  }
});

test('R351 радостный капитан чередует кадры через 300 мс и остаётся в dance1 после танца', () => {
  assert.equal(fx.CAPTAIN_BEAT_MS, 300);
  for (let beat = 0; beat < 10; beat++) {
    const frame = beat % 2 ? 'dance2' : 'dance1';
    assert.equal(fx.captainPoseAt('joy', beat * 300).frame, frame);
    assert.equal(fx.captainPoseAt('joy', beat * 300 + 299.999).frame, frame);
  }
  assert.equal(fx.CAPTAIN_DANCE_MS.joy, 3500);
  for (const ms of [3500, 3501, 10000]) {
    assert.deepEqual(fx.captainPoseAt('joy', ms), { frame: 'dance1', lift: 0, rot: 0, sx: 1, sy: 1, wheel: 0 });
  }
});

function directionContract(module: Pick<typeof fx, 'captainPoseAt'>) {
  near(module.captainPoseAt('joy', 150).wheel, 10.5, 'R351 первый шаг штурвала направлен вперёд');
  near(module.captainPoseAt('joy', 1650).wheel, 49.5, 'R351 вторая половина возвращает штурвал');
  near(module.captainPoseAt('jackpot', 150).wheel, 21, 'R351 джекпот начинает положительным шагом');
}

test('R351 штурвал идёт вперёд в первой половине танца и возвращается во второй', () => {
  directionContract(fx);
  near(fx.captainPoseAt('joy', 1500).wheel, 60, 'верхняя точка обычного танца');
  near(fx.captainPoseAt('joy', 3000).wheel, 0, 'штурвал вернулся до успокоения');
});

test('R351 пик джекпота добавляет полный положительный оборот и затем держит кадр peak', () => {
  assert.equal(fx.captainPoseAt('jackpot', 1499.999).frame, 'dance1');
  assert.equal(fx.captainPoseAt('jackpot', 1500).frame, 'peak');
  near(fx.captainPoseAt('jackpot', 1500).wheel, 120, 'начало пика');
  near(fx.captainPoseAt('jackpot', 1810).wheel, 300, 'половина оборота');
  near(fx.captainPoseAt('jackpot', 2120).wheel, 480, '120 + 360 в конце пика');
  assert.equal(fx.captainPoseAt('jackpot', 2319.999).frame, 'peak');
  assert.equal(fx.CAPTAIN_DANCE_MS.jackpot, 4320);
  assert.deepEqual(fx.captainPoseAt('jackpot', 4320), { frame: 'peak', lift: 0, rot: 0, sx: 1, sy: 1, wheel: 0 });
  assert.equal(fx.captainPoseAt('jackpot', 10000).frame, 'peak');
});

test('R351 до начала любого танца капитан неподвижен в idle', () => {
  for (const dance of ['joy', 'jackpot'] as const) {
    assert.deepEqual(fx.captainPoseAt(dance, -0.001), { frame: 'idle', lift: 0, rot: 0, sx: 1, sy: 1, wheel: 0 });
    assert.notEqual(fx.captainPoseAt(dance, 0).frame, 'idle');
  }
});

test('R351 неизвестная и короткая запись дают 9900 мс свечения, допустимая длина ограничена 20 секундами', () => {
  for (const ms of [null, -1, 0, 2999.999, NaN, Infinity, -Infinity]) assert.equal(fx.jackpotGlowMs(ms), 9900);
  assert.equal(fx.jackpotGlowMs(3000), 3000);
  assert.equal(fx.jackpotGlowMs(9901), 9901);
  assert.equal(fx.jackpotGlowMs(20000), 20000);
  assert.equal(fx.jackpotGlowMs(20000.001), 20000);
});

test('R351 свечение включается на ударе, держится до конца записи и гаснет ровно за 900 мс', () => {
  assert.equal(fx.JACKPOT_GLOW_FADE_MS, 900);
  assert.equal(fx.jackpotGlowAt(-0.001, 9900), 0);
  assert.equal(fx.jackpotGlowAt(0, 9900), 1);
  assert.equal(fx.jackpotGlowAt(9899.999, 9900), 1);
  assert.equal(fx.jackpotGlowAt(9900, 9900), 1);
  near(fx.jackpotGlowAt(10350, 9900), 0.5, 'половина затухания');
  assert.ok(fx.jackpotGlowAt(10799.999, 9900) > 0);
  assert.equal(fx.jackpotGlowAt(10800, 9900), 0);
  assert.equal(fx.jackpotGlowAt(10801, 9900), 0);
});

test('R351 пустой цикл не просит кадр, а несколько дорожек делят один запрос', () => withRaf(clock => {
  const loop = new fx.FxLoop();
  assert.equal(clock.queue.size, 0);
  loop.setPaused(false);
  assert.equal(clock.queue.size, 0);
  loop.add(() => false);
  loop.at(0, () => {});
  assert.equal(clock.queue.size, 1, 'один rAF для двух дорожек');
  clock.tick(100);
  assert.equal(clock.queue.size, 0, 'последняя дорожка завершена — пустого хвоста нет');
  loop.dispose();
}));

test('R351 пауза отменяет rAF, останавливает ожидание и не догоняет настенные часы после возврата', () => withRaf(clock => {
  const loop = new fx.FxLoop();
  const times: number[] = [];
  let fired = 0;
  loop.add(ms => { times.push(ms); });
  loop.at(40, () => { fired++; });
  clock.tick(100);
  loop.setPaused(true);
  assert.equal(clock.queue.size, 0);
  assert.equal(clock.cancelled.length, 1);
  clock.tick(10000);
  assert.equal(times.length, 1);
  assert.equal(fired, 0);
  loop.setPaused(false);
  assert.equal(clock.queue.size, 1);
  clock.tick(10000);
  near(times[1] - times[0], 1000 / 60, 'после паузы только первый шаг, не 9,9 секунды');
  assert.equal(fired, 0);
  clock.tick(10010);
  assert.equal(fired, 1, 'отложенный звук дождался времени самой сцены');
  loop.dispose();
}));

test('R351 dispose снимает текущий кадр и навсегда запрещает дорожки и отложенные действия', () => withRaf(clock => {
  const loop = new fx.FxLoop();
  let calls = 0;
  loop.add(() => { calls++; });
  loop.at(30, () => { calls += 100; });
  const stale = [...clock.queue.values()][0];
  loop.dispose();
  assert.equal(clock.queue.size, 0);
  stale(1000); // Даже уже полученный внешний callback не оживляет уничтоженную сцену.
  loop.add(() => { calls++; });
  loop.at(0, () => { calls++; });
  loop.setPaused(true);
  loop.setPaused(false);
  clock.tick(2000);
  assert.equal(calls, 0);
  assert.equal(clock.queue.size, 0);
}));

test('R351 clear из дорожки отменяет оставшиеся действия того же кадра и не возвращает старые дорожки', () => withRaf(clock => {
  const loop = new fx.FxLoop();
  const calls: string[] = [];
  loop.add(() => { calls.push('clear'); loop.clear(); });
  loop.add(() => { calls.push('старый хвост'); });
  loop.at(0, () => { calls.push('старый звук'); });
  clock.tick(100);
  assert.deepEqual(calls, ['clear']);
  assert.equal(clock.queue.size, 0);
  loop.at(0, () => { calls.push('новая сцена'); });
  clock.tick(200);
  assert.deepEqual(calls, ['clear', 'новая сцена']);
  assert.equal(clock.queue.size, 0);
  loop.dispose();
}));

test('R351 шаг физики не превышает 50 мс и не становится отрицательным при скачке часов', () => withRaf(clock => {
  const loop = new fx.FxLoop();
  const steps: number[] = [];
  loop.add((_ms, dt) => { steps.push(dt); });
  clock.tick(100);
  clock.tick(110);
  clock.tick(10000);
  clock.tick(9000);
  near(steps[0], 1 / 60, 'первый шаг');
  near(steps[1], 0.01, 'нормальный шаг');
  near(steps[2], 0.05, 'большой разрыв обрезан');
  assert.equal(steps[3], 0, 'время назад не отматывает монеты');
  loop.dispose();
}));

test('R351 исключение снимает только виновную дорожку, остальные и at продолжают работать', () => withRaf(clock => {
  const loop = new fx.FxLoop();
  let broken = 0;
  let healthy = 0;
  let once = 0;
  loop.add(() => { broken++; throw new Error('ошибка одной дорожки'); });
  loop.add(() => { healthy++; return healthy < 3; });
  loop.at(30, () => { once++; });
  clock.tick(100);
  clock.tick(120);
  clock.tick(140);
  assert.equal(broken, 1);
  assert.equal(healthy, 3);
  assert.equal(once, 1);
  assert.equal(clock.queue.size, 0);
  loop.dispose();
}));

type Coin = Parameters<typeof fx.stepCoin>[0];
const coin = (patch: Partial<Coin> = {}): Coin => ({
  x: 100, y: 90, vx: 20, vy: 200, size: 20, g: 0, floor: 100, fps: 24, phase: 0,
  life: 10, delay: 0, bounce: 0.5, wind: 0, age: 0, frame: 0, hits: 0, rest: false, wph: 0, ...patch,
});

test('R351 удар монеты об пол разворачивает скорость с bounce, но взлёт ещё не считается касанием', () => {
  const down = coin();
  assert.equal(fx.stepCoin(down, 0.1, 500), true);
  assert.equal(down.y, 90);
  assert.equal(down.vy, -100, 'vy умножена именно на -bounce');
  assert.equal(down.hits, 1);
  assert.equal(down.rest, false);
  near(down.vx, 11, 'трение на полу');
  const up = coin({ vy: -200 });
  fx.stepCoin(up, 0.1, 500);
  assert.equal(up.hits, 0);
  assert.equal(up.vy, -200);
});

test('R351 третье касание укладывает монету, а второе с сильным отскоком ещё оставляет её в полёте', () => {
  const second = coin({ hits: 1 });
  fx.stepCoin(second, 0.1, 500);
  assert.equal(second.hits, 2);
  assert.equal(second.rest, false);
  const third = coin({ hits: 2, frame: 13 });
  fx.stepCoin(third, 0.1, 500);
  assert.equal(third.hits, 3);
  assert.equal(third.rest, true);
  assert.equal(third.vy, 0);
  assert.equal(third.frame % fx.COIN_FRAMES, 0, 'покой совпадает с целым оборотом');
  const position = { x: third.x, y: third.y, frame: third.frame };
  fx.stepCoin(third, 0.1, 500);
  assert.deepEqual({ x: third.x, y: third.y, frame: third.frame }, position);
});

test('R351 монета полностью видима до life и затухает за 0,45 секунды после него', () => {
  assert.equal(fx.coinAlpha({ age: 0, life: 2 }), 1);
  assert.equal(fx.coinAlpha({ age: 2, life: 2 }), 1);
  near(fx.coinAlpha({ age: 2.225, life: 2 }), 0.5, 'половина затухания');
  assert.ok(fx.coinAlpha({ age: 2.449, life: 2 }) > 0);
  near(fx.coinAlpha({ age: 2.45, life: 2 }), 0, 'конец затухания');
  assert.equal(fx.coinAlpha({ age: 3, life: 2 }), 0);
  assert.equal(fx.stepCoin(coin({ age: 11, rest: true }), 0, 500), false);
});

test('R351 края холста имеют ровно 80 пикселей запаса, задержанная монета ещё не движется', () => {
  for (const [x, alive] of [[-80.001, false], [-80, false], [-79.999, true], [579.999, true], [580, false], [580.001, false]] as const) {
    assert.equal(fx.stepCoin(coin({ x, rest: true }), 0, 500), alive, `край x=${x}`);
  }
  const delayed = coin({ age: -1 });
  assert.equal(fx.stepCoin(delayed, 0.1, 500), true);
  assert.equal(delayed.x, 100);
  assert.equal(delayed.y, 90);
  assert.equal(delayed.frame, 0);
});

// Контрфакты загружают ВЕСЬ самостоятельный модуль, а не исполняют вырезанные регуляркой функции.
const source = readFileSync(new URL('./wheelFx.ts', import.meta.url), 'utf8');
function changed(before: string, after: string): typeof fx {
  assert.equal(source.split(before).length - 1, 1, 'R351 якорь контрфакта единственный');
  const output = ts.transpileModule(source.replace(before, after), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  runInNewContext(output, { exports }, { filename: 'wheelFx.r351-counterfactual.cjs', timeout: 1000 });
  return exports as typeof fx;
}

mutantTest('R351 контрфакт: выстрел на миллисекунду раньше взрыва нарушает синхронизацию', () => {
  assert.throws(() => chestContract(changed('export const CHEST_BURST_MS = CHEST_STEPS.burst;', 'export const CHEST_BURST_MS = CHEST_STEPS.burst - 1;')),
    /R351 удар совпадает с первым кадром взрыва/);
});

mutantTest('R351 контрфакт: недолетающий сундук не проходит проверку полного возврата', () => {
  assert.throws(() => chestContract(changed('fly: easeInOut(k)', 'fly: easeInOut(k) * 0.99')),
    /R351 возврат сундука завершается полностью/);
});

mutantTest('R351 контрфакт: отрицательный первый шаг штурвала ловится направлением движения', () => {
  assert.throws(() => directionContract(changed('const step = 12;', 'const step = -12;')),
    /R351 первый шаг штурвала направлен вперёд/);
});
