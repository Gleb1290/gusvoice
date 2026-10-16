import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as rules from './recordBlob';

type Rules = typeof rules;
const source = readFileSync(new URL('./recordBlob.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const near = (actual: number, expected: number, reason: string, epsilon = 1e-9) =>
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= epsilon, `${reason}: ${actual} ≈ ${expected}`);
function mutated(anchor: string, replacement: string): Rules {
  assert.equal(source.split(anchor).length - 1, 1, 'один точный якорь целого модуля');
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source.replace(anchor, replacement), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, require: (id: string) => { throw new Error(`Неожиданная граница ${id}`); } });
  return module.exports as Rules;
}
function checkNew(module: Rules) {
  for (const [kind, n, min, max] of [['tiny', 11, 47, 56], ['big', 12, 50, 57.2]] as const) {
    for (const random of [0, 0.5, 1]) {
      const b = module.blobNew(kind, () => random);
      assert.equal(b.n, n); assert.equal(b.minR, min); near(b.maxR, max, 'верхняя граница радиуса');
      for (const values of [b.r, b.a, b.rNext, b.aNext, b.speed, b.p]) assert.equal(values.length, n);
      const expectedR = random === 0.5 ? min : max;
      const angleOffset = random === 0 ? -18 / n : random === 1 ? 18 / n : 0;
      for (let i = 0; i < n; i++) {
        for (const radius of [b.r[i], b.rNext[i]]) {
          assert.ok(radius >= min && radius <= max, 'радиус не выходит за обе включительные границы');
          near(radius, expectedR, 'симметричные отрицательный и положительный края дают одинаковый радиус');
        }
        near(b.a[i], 360 * i / n + angleOffset, 'угол равномерной точки с отклонением пять процентов');
        near(b.aNext[i], b.a[i], 'постоянный генератор одинаково определяет следующую цель');
        near(b.speed[i], random === 0.5 ? .017 : .020, 'скорость на границах случайного диапазона');
        assert.equal(b.p[i], 0);
      }
    }
  }
}
it('R176 малая и большая кляксы имеют 11 и 12 точек, симметричные радиусы и углы в пределах пяти процентов', () => {
  // Отрицательная половина random без abs дала бы радиус меньше минимального.
  checkNew(rules);
});
it('R176 генератор каждой точки независимо выбирает радиус, угол и скорость для текущей и следующей цели', () => {
  // Один random на всё связал бы форму со скоростью и перестал бы воспроизводить независимые колебания.
  const b = rules.blobNew('tiny', () => .5); let index = 0;
  const values = [.25, .75, 0];
  rules.blobPoint(b, 3, () => values[index++], 'cur');
  assert.equal(index, 3); near(b.r[3], 51.5, 'половина размаха радиуса');
  near(b.a[3], 360 * 3 / 11 + 9 / 11, 'положительное пол-отклонение угла'); near(b.speed[3], .020, 'модуль отрицательной скорости');
  assert.equal(b.rNext[3], 47, 'текущая генерация не трогает будущий радиус');
  rules.blobPoint(b, 3, () => 1, 'next');
  assert.equal(b.rNext[3], 56); near(b.r[3], 51.5, 'следующая цель не переписывает текущий радиус');
});
function checkFrames(module: Rules) {
  for (const kind of ['tiny', 'big'] as const) {
    const zero = module.blobNew(kind, () => .5), one = module.blobNew(kind, () => .5), two = module.blobNew(kind, () => .5);
    module.blobStep(zero, 0.5, 1.02, 0, () => .5);
    module.blobStep(one, .5, 1.02, 1, () => .5); module.blobStep(two, .5, 1.02, 2, () => .5);
    assert.equal(zero.p[0], 0);
    near(one.p[0], .017 * (.8 + .5 * 8.2 * 1.02), 'скорость зависит от амплитуды и масштаба');
    near(two.p[0], one.p[0] * 2, 'два кадровых интервала дают двойной ход');
    const quiet = module.blobNew(kind, () => .5); module.blobStep(quiet, 0, 1.02, 1, () => .5);
    near(quiet.p[0], .017 * .8, 'при тишине движение не пропадает');
  }
}
it('R176 ход точек масштабируется нулём, одним и двумя кадрами, громкость ускоряет живую форму', () => {
  // Игнорирование frames ускоряет анимацию на высокочастотном экране и тормозит после задержки.
  checkFrames(rules);
});
function checkGoals(module: Rules) {
  for (const p of [1 - 1e-6, 1, 1 + 1e-6]) {
    const b = module.blobNew('tiny', () => .5); b.p.fill(p); b.rNext.fill(55); b.aNext.fill(90);
    module.blobStep(b, 0, 1, 0, () => 0);
    if (p < 1) {
      assert.equal(b.p[0], p); assert.equal(b.r[0], 47); assert.equal(b.rNext[0], 55);
    } else for (let i = 0; i < b.n; i++) {
      assert.equal(b.p[i], 0, 'при достижении и превышении границы прогресс сбрасывается');
      assert.equal(b.r[i], 55); assert.equal(b.a[i], 90);
      assert.equal(b.rNext[i], 56); near(b.aNext[i], 360 * i / 11 - 18 / 11, 'выдана новая цель угла');
    }
  }
  const b = module.blobNew('big', () => .5); b.p.fill(.99); b.rNext.fill(57);
  module.blobStep(b, 1, 1.01, 1, () => .5);
  assert.equal(b.p[0], 0); assert.equal(b.r[0], 57); assert.equal(b.rNext[0], 50);
}
it('R176 ровно единица и перелёт принимают будущую цель и сбрасывают прогресс, недошедшая точка остаётся прежней', () => {
  // Без сброса цель пересоздаётся каждый кадр, а знак > вместо >= задерживает точку на границе.
  checkGoals(rules);
});
function checkPath(module: Rules) {
  for (const kind of ['tiny', 'big'] as const) {
    const b = module.blobNew(kind, () => .5), path = module.blobPath(b, 13, -7);
    assert.equal(path.length, b.n);
    for (let i = 0; i < b.n; i++) {
      const next = path[(i + 1) % b.n], segment = path[i];
      near(segment.x, next.x0, 'стык соседних кубических отрезков'); near(segment.y, next.y0, 'замкнутый вертикальный стык');
      near(Math.hypot(segment.x0 - 13, segment.y0 + 7), b.minR, 'равные радиусы лежат на окружности');
    }
  }
  const b: rules.Blob = { n: 4, minR: 10, maxR: 10, r: [10, 10, 10, 10], rNext: [10, 10, 10, 10],
    a: [0, 90, 180, 270], aNext: [0, 90, 180, 270], p: [0, 0, 0, 0], speed: [0, 0, 0, 0] };
  const path = module.blobPath(b, 3, 5), arm = 5.522847498307935;
  const points = [[3, -5], [13, 5], [3, 15], [-7, 5]];
  for (let i = 0; i < 4; i++) {
    near(path[i].x0, points[i][0], 'кардинальное положение X'); near(path[i].y0, points[i][1], 'кардинальное положение Y');
  }
  near(path[0].c1x, 3 + arm, 'первое плечо четверти окружности'); near(path[0].c1y, -5, 'касательная горизонтальна сверху');
  near(path[0].c2x, 13, 'касательная вертикальна справа'); near(path[0].c2y, 5 - arm, 'второе плечо четверти окружности');
}
it('R176 контур имеет N замкнутых кубических сегментов с правильными sin cos и плечом четверти окружности', () => {
  // Окружность может остаться замкнутой при зеркальном знаке или неверном tan, поэтому проверяем контрольные точки.
  checkPath(rules);
});
it('R176 контур интерполирует одновременно угол и радиус по прогрессу каждой точки', () => {
  // Проверка только неизменной окружности не ловит скачок между случайными целями.
  const b = rules.blobNew('big', () => .5); b.r[0] = 50; b.rNext[0] = 56; b.a[0] = 0; b.aNext[0] = 90;
  for (const p of [0, .5, 1]) {
    b.p[0] = p; const first = rules.blobPath(b, 0, 0)[0], r = 50 + 6 * p;
    near(first.x0, r * Math.sin(Math.PI / 2 * p), 'радиус и угол вместе определяют X');
    near(first.y0, -r * Math.cos(Math.PI / 2 * p), 'радиус и угол вместе определяют Y');
  }
});
function checkTimes(module: Rules) {
  for (const [kind, up, duration] of [['big', true, 205], ['big', false, 275], ['tiny', true, 320],
    ['tiny', false, 375], ['circle', true, 375], ['circle', false, 375]] as const) {
    near(module.ampRiseMs(kind, up), duration, 'точное время подъёма или спада');
    const s = module.ampNew(); s.value = up ? 0 : 1;
    module.ampSet(s, up ? 1 : 0, kind); module.ampTick(s, duration / 2);
    near(s.value, .5, 'линейная половина полного перехода');
    module.ampTick(s, duration / 2 - 1);
    near(s.value, up ? 1 - 1 / duration : 1 / duration, 'за миллисекунду до завершения цель ещё не достигнута');
    module.ampTick(s, 1); near(s.value, up ? 1 : 0, 'ровно в срок достигается цель');
    module.ampTick(s, duration * 10); near(s.value, up ? 1 : 0, 'после достижения значение не уходит от цели');
  }
}
it('R176 амплитуда идёт линейно за 205 275 320 и 375 миллисекунд в правильном направлении', () => {
  // Перепутанные up/down дают правильный итог, но неверную отзывчивость на начало и конец звука.
  checkTimes(rules);
});
function checkClamp(module: Rules) {
  for (const [target, expected] of [[-1, 0], [0, 0], [.5, .5], [1, 1], [1.001, 1],
    [NaN, 0], [Infinity, 0], [-Infinity, 0]] as const) {
    const s = module.ampNew(); module.ampSet(s, target, 'circle');
    assert.equal(s.target, expected); module.ampTick(s, 10000); near(s.value, expected, 'цель после зажима достижима без перелёта');
  }
  for (const [start, target] of [[.2, .8], [.8, .2]]) {
    const s = { value: start, target: start, diff: 0 }; module.ampSet(s, target, 'big'); module.ampTick(s, 10000);
    assert.equal(s.value, target, 'большой dt зажимается у цели в обе стороны');
  }
}
it('R176 цели амплитуды зажимаются по обе стороны 0 и 1, нечисловые значения безопасны и большой кадр не перелетает', () => {
  // Плохой уровень микрофона не должен раздуть круг или оставить отрицательный радиус.
  checkClamp(rules);
});
it('R176 новая цель берёт текущую амплитуду, нулевой кадр и одинаковая цель её не меняют', () => {
  // Смена цели в середине старого перехода не должна начинать анимацию снова от нуля.
  const s = rules.ampNew(); assert.deepEqual(s, { value: 0, target: 0, diff: 0 });
  rules.ampSet(s, 1, 'big'); rules.ampTick(s, 102.5); rules.ampSet(s, 0, 'big');
  near(s.diff, -.5 / 275, 'спад вычислен от текущей половины'); rules.ampTick(s, 0); near(s.value, .5, 'нулевой dt');
  rules.ampTick(s, 137.5); near(s.value, .25, 'новая цель линейна');
  const same = s.value; rules.ampSet(s, same, 'big'); assert.equal(s.diff, 0);
  rules.ampTick(s, 1000); assert.equal(s.value, same);
});
function checkAppear(module: Rules) {
  for (const [scale, expected] of [[-1, 0], [0, 0], [.25, .5], [.5, 1], [.625, .95], [.75, .9], [.875, .95], [1, 1], [2, 1]])
    near(module.circleAppearScale(scale), expected, 'рост, просадка и возврат масштаба');
}
it('R176 появление растёт до 1 на половине, проседает до 0.9 и возвращается к 1 с зажимом краёв', () => {
  // Простое линейное увеличение потеряло бы узнаваемую упругость круга записи.
  checkAppear(rules);
});
const frame = (module: Rules, exit: rules.BlobExit | null, t: number, extra = {}) =>
  module.circleFrame({ scale: 1, amp: 0, slide: 0, exit, t, ...extra });
function checkSend(module: Rules) {
  for (const amp of [0, 1]) {
    const base = 41 + 30 * amp;
    near(frame(module, 'send', 0, { amp }).radius, base, 'старт отправки');
    const peak = frame(module, 'send', .6, { amp }); near(peak.radius, base + 16, 'пик ровно в шесть десятых');
    assert.equal(peak.alpha, 1); assert.equal(peak.waves, 0);
    const final = frame(module, 'send', 1, { amp }); assert.equal(final.radius, 0); assert.equal(final.alpha, 0); assert.equal(final.waves, 0);
    for (const t of [.3, .59, .600001, .8, .999]) {
      const f = frame(module, 'send', t, { amp }); assert.ok(f.radius >= 0 && f.radius <= base + 16);
      assert.ok(f.alpha >= 0 && f.alpha <= 1); assert.ok(f.waves >= 0 && f.waves <= 1);
    }
    near(frame(module, 'send', -1, { amp }).radius, base, 'отрицательное время зажато на старте');
    assert.equal(frame(module, 'send', 2, { amp }).radius, 0, 'время после конца зажато');
  }
  const fading = frame(module, 'send', .8); near(fading.alpha, .5, 'альфа второй фазы линейна', 1e-8);
}
it('R176 отправка набухает ровно на 16 при t0.6 и сжимается в ноль вместе с волнами и альфой', () => {
  // Неправильный разделитель фаз меняет пик и оставляет круг после завершения отправки.
  checkSend(rules);
});
function checkCancel(module: Rules) {
  for (const t of [0, .5, .7, .9, .999999]) {
    const f = frame(module, 'cancel', t); assert.ok(f.radius >= 19, 'до завершения отмены радиус не меньше 19');
    assert.equal(f.waves, 0); assert.ok(f.alpha >= 0 && f.alpha <= 1);
  }
  assert.equal(frame(module, 'cancel', .5).alpha, 1, 'альфа держится до продвижения 0.7');
  // Для EASE_BOTH параметр u=.6 даёт (x=.58752,y=.648), u=.7 — (x=.67816,y=.784).
  // Это независимые контрольные точки кривой: порог относится к eased progress, не сырому времени.
  assert.equal(frame(module, 'cancel', .58752).alpha, 1, 'до eased progress .7 альфа неизменна');
  near(frame(module, 'cancel', .67816).alpha, .72, 'после eased progress .7 начинается линейное угасание', 1e-6);
  const later = frame(module, 'cancel', .9); assert.ok(later.alpha > 0 && later.alpha < 1, 'после продвижения 0.7 альфа гаснет');
  const final = frame(module, 'cancel', 1); assert.equal(final.radius, 0); near(final.alpha, 0, 'финальная альфа отмены');
  assert.equal(frame(module, 'cancel', 2).radius, 0);
  const invisible = frame(module, 'cancel', .9, { scale: 0 }); assert.equal(invisible.radius, 19);
}
it('R176 отмена держит минимум 19 до последнего кадра и гасит альфу только после продвижения 0.7', () => {
  // Раннее исчезновение круга скрывает обратную связь жеста, а минимум в финале оставляет мёртвую плашку.
  checkCancel(rules);
});
function checkLock(module: Rules) {
  near(frame(module, 'lock', 0, { fromR: 60 }).radius, 60, 'замок начинает от сохранённого радиуса');
  near(frame(module, 'lock', .5, { fromR: 60 }).radius, 41, 'середина интерполяции замка', 1e-5);
  for (const t of [1, 2]) { const final = frame(module, 'lock', t, { fromR: 60 }); assert.equal(final.radius, 22); assert.equal(final.waves, 0); }
  assert.equal(frame(module, 'lock', 1).alpha, 1, 'замок стекает в кнопку, не растворяется');
}
it('R176 замок сохраняет исходный радиус и стекает в кнопку 22 без финальных волн', () => {
  // Пересчёт fromR от свежей громкости дёргал бы круг после перехода к записи без удержания.
  checkLock(rules);
});
it('R176 обычный круг меняется с громкостью 41–71, сдвиг отмены уменьшает его и убирает волны', () => {
  // Отмену нужно видеть ещё до отпускания пальца, а уровень микрофона ограничен рабочим диапазоном.
  for (const [amp, radius] of [[-1, 41], [0, 41], [1, 71], [2, 71]]) near(frame(rules, null, 0, { amp }).radius, radius, 'амплитудный радиус');
  near(frame(rules, null, 0, { slide: 1 }).radius, 28.7, 'полный сдвиг оставляет семь десятых');
  assert.equal(frame(rules, null, 0, { slide: 1 }).waves, 0);
  near(frame(rules, null, 0, { slide: -1 }).radius, 41, 'сдвиг ниже нуля зажат');
  near(frame(rules, null, 0, { slide: 2 }).radius, 28.7, 'сдвиг выше единицы зажат');
  assert.equal(frame(rules, null, 0, { scale: 0 }).radius, 0); assert.equal(frame(rules, null, 0, { scale: 0 }).waves, 0);
});
function checkModes(module: Rules) {
  assert.equal(module.exitKindOf({ recording: true, recBusy: true }), 'lock');
  assert.equal(module.exitKindOf({ recording: true, recBusy: false }), 'lock');
  assert.equal(module.exitKindOf({ recording: false, recBusy: true }), 'send');
  assert.equal(module.exitKindOf({ recording: false, recBusy: false }), 'cancel');
  for (const [reducedMotion, lite, expected] of [[true, true, 'static'], [true, false, 'static'], [false, true, 'lite'], [false, false, 'blob']] as const)
    assert.equal(module.blobMode({ reducedMotion, lite }), expected);
  assert.equal(module.exitMs('send'), 360); assert.equal(module.exitMs('cancel'), 200); assert.equal(module.exitMs('lock'), 200);
  assert.equal(module.REC_BLOB.appearMs, 300);
}
it('R176 продолжающаяся запись выбирает замок раньше отправки, reduced motion важнее lite и уход имеет штатный срок', () => {
  // Приоритеты смешанных флагов важны в кадре перехода: движение нельзя включить поверх запрета анимации.
  checkModes(rules);
});
function checkDpr(module: Rules) {
  for (const [dpr, expected] of [[undefined, 1], [NaN, 1], [Infinity, 1], [-Infinity, 1], [-1, 1], [0, 1],
    [.5, .5], [1, 1], [2, 2], [3, 3], [3.0001, 3], [4, 3]] as const) assert.equal(module.canvasDpr(dpr), expected);
}
it('R176 холст принимает валидную плотность до 3 включительно, ограничивает превышение и заменяет мусор единицей', () => {
  // DPR4 не должен бесконтрольно увеличивать площадь canvas, а NaN не даёт допустимого размера буфера.
  checkDpr(rules);
});
it('R176 масштаб обеих волн сохраняет разные минимумы, общий множитель и рост 1.4 от громкости', () => {
  // Две одинаковые волны не воспроизводят независимые малую и большую кляксы.
  for (const [kind, minimum] of [['tiny', .926], ['big', .878]] as const) {
    near(rules.waveScale(kind, 0, 1), minimum, 'минимум масштаба волны');
    near(rules.waveScale(kind, 1, 1), minimum + 1.4, 'рост от громкости');
    near(rules.waveScale(kind, .5, .5), (minimum + .7) / 2, 'общий множитель');
    assert.equal(rules.waveScale(kind, 1, 0), 0);
  }
});

for (const [name, anchor, replacement, check] of [
  ['радиус без abs', 'b.minR + Math.abs(sym(rnd)) * radDif', 'b.minR + sym(rnd) * radDif', checkNew],
  ['frames игнорируется', 'REC_BLOB.maxSpeed * speedScale) * frames', 'REC_BLOB.maxSpeed * speedScale)', checkFrames],
  ['нет сброса прогресса', 'b.p[i] = 0;', 'b.p[i] = 1;', checkGoals],
  ['граница только строго больше единицы', 'if (b.p[i] >= 1)', 'if (b.p[i] > 1)', checkGoals],
  ['зеркальный знак sin', 'x0: cx + r1 * s1,', 'x0: cx - r1 * s1,', checkPath],
  ['неверный знак cos', 'y0: cy - r1 * k1,', 'y0: cy + r1 * k1,', checkPath],
  ['удвоенное плечо tan', 'Math.tan(Math.PI / (2 * b.n))', 'Math.tan(Math.PI / b.n)', checkPath],
  ['направления сглаживания перепутаны', 'ampRiseMs(kind, t > s.value)', 'ampRiseMs(kind, t < s.value)', checkTimes],
  ['цель без зажима', 'Math.max(0, Math.min(1, Number.isFinite(target) ? target : 0))', 'target', checkClamp],
  ['перелёт не ограничивается целью', 'if ((s.diff > 0 && s.value > s.target) || (s.diff < 0 && s.value < s.target) || s.diff === 0) s.value = s.target;', '', checkClamp],
  ['появление без просадки', 'return 1 - ((s - 0.5) / 0.25) * 0.1;', 'return 1;', checkAppear],
  ['пик отправки не шестнадцать', 'radius + 16 * step1', 'radius + 15 * step1', checkSend],
  ['отмена без минимального радиуса', 'if (t < 1) radius = Math.max(radius, REC_BLOB.cancelMinR);', '', checkCancel],
  ['угасание отмены по времени вместо прогресса кривой', 'if (p > 0.7) alpha', 'if (t > 0.7) alpha', checkCancel],
  ['замок не стекает в кнопку', 'radius = from + (REC_BLOB.buttonR - from) * e;', 'radius = from;', checkLock],
  ['lite важнее reduced motion', "if (o.reducedMotion) return 'static';", "if (o.reducedMotion && !o.lite) return 'static';", checkModes],
  ['отправка раньше продолжающейся записи', "if (s.recording) return 'lock';", "if (s.recording && !s.recBusy) return 'lock';", checkModes],
  ['плотность без ограничения', 'return Math.min(3, dpr);', 'return dpr;', checkDpr],
] as const) it(`R176 контрфакт ${name} обнаруживается проверкой того же математического поведения`, () => {
  // Оригинал проверен до точной мутации целого модуля; принимаем только AssertionError от числового oracle.
  check(rules); const module = mutated(anchor, replacement); assert.throws(() => check(module), assert.AssertionError);
});
