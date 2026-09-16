import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EFFECT_MS, featherCount } from './effects';
import {
  FADE_MS,
  SIZE_MAX,
  SIZE_MIN,
  degradeStep,
  featherFade,
  gridCoverage,
  makeFeathers,
  stepFeather,
} from './featherFall';

/** Раскладки, на которых эффект обязан выглядеть одинаково. */
const VIEWPORTS = [
  { name: 'ноутбук 1366×768', w: 1366, h: 768 },
  { name: 'обычный 1920×1080', w: 1920, h: 1080 },
  { name: 'широкий 3440×1440', w: 3440, h: 1440 },
  { name: 'вертикальный 1440×2560', w: 1440, h: 2560 },
  { name: 'узкое окно 500×900', w: 500, h: 900 },
];

/** Детерминированный источник: тест обязан падать одинаково, а не «иногда». */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Прогнать эффект целиком с шагом 60 Гц и вернуть, где каждая частица оказалась. */
function simulate(w: number, h: number, seed = 42) {
  const feathers = makeFeathers(w, h, featherCount(w, h), seeded(seed));
  const dt = 1 / 60;
  // Считаем до НАЧАЛА затухания: перо, доехавшее до низа уже прозрачным, человек не увидит.
  const until = EFFECT_MS.feathers - FADE_MS;
  for (let ms = 0; ms <= until; ms += dt * 1000) {
    for (const f of feathers) stepFeather(f, ms, dt);
  }
  return feathers;
}

describe('падение перьев долетает до низа на любой раскладке', () => {
  for (const v of VIEWPORTS) {
    it(`🔴 ${v.name}: каждое перо уходит за нижний край`, () => {
      // Ровно тот баг, что уехал в прод: скорость была в пикселях в секунду, и на широком мониторе
      // перья таяли на середине экрана. Теперь скорость выводится из высоты окна.
      const feathers = simulate(v.w, v.h);
      const stuck = feathers.filter((f) => f.y < v.h);
      assert.equal(
        stuck.length,
        0,
        `${stuck.length} из ${feathers.length} не долетели; самое высокое на y=${Math.round(
          Math.min(...stuck.map((f) => f.y)),
        )} при высоте окна ${v.h}`,
      );
    });
  }

  it('и не улетают абсурдно далеко за край — скорость выведена, а не задрана', () => {
    // Обратная проверка: «долетело» не должно достигаться тем, что перья проносятся за кадр за
    // полсекунды. Иначе осыпания не видно вовсе.
    const h = 1080;
    const feathers = simulate(1920, h);
    const tooFar = feathers.filter((f) => f.y > h * 3);
    assert.equal(tooFar.length, 0, `${tooFar.length} частиц пролетели больше трёх высот окна`);
  });

  it('шаг кадра не влияет на результат: 30 Гц и 144 Гц дают ту же картину', () => {
    // dt берётся из разницы кадров; ошибка здесь означала бы, что на слабой машине эффект короче.
    const h = 1080;
    const run = (fps: number) => {
      const feathers = makeFeathers(1920, h, 60, seeded(7));
      const dt = 1 / fps;
      for (let ms = 0; ms <= EFFECT_MS.feathers - FADE_MS; ms += dt * 1000) {
        for (const f of feathers) stepFeather(f, ms, dt);
      }
      return feathers.map((f) => f.y);
    };
    const slow = run(30);
    const fast = run(144);
    for (let i = 0; i < slow.length; i++) {
      // Численное интегрирование даёт небольшое расхождение — важно, что оно проценты, а не разы.
      const diff = Math.abs(slow[i] - fast[i]) / Math.max(1, fast[i]);
      assert.ok(diff < 0.12, `частица ${i}: расхождение ${Math.round(diff * 100)}%`);
    }
  });
});

describe('🔴 момент, когда перья занимают всё пространство', () => {
  /**
 * Требование словами: «перьев должно быть столько, чтоб какой не был бы экран, был момент
   * на 0.5 секунды, когда перья занимают всё пространство».
   *
   * 🔴 Смысл теста — НЕ в красоте, а в том, что раньше плотность зависела от экрана: 30 % на
   * ноутбуке против 13.6 % на широком мониторе, потому что потолок числа частиц бил ровно по
   * большому экрану. Теперь требуем одинаковой плотности на любой раскладке.
   *
   * 🔴 **Меряем занятость по СЕТКЕ, а не сумму площадей (разбор Codex, и он прав).** Сумма
   * отвечала не на тот вопрос: она считает наложения по нескольку раз и ничего не знает о том, ГДЕ
   * частицы. Стопка перьев в центре давала ту же сумму, что и равномерный дождь, — то есть мутация
   * «все перья летят в одну точку» проходила бы этот тест зелёной, а экран был бы пуст по краям.
   * Ниже отдельная проверка, что новая мера такую подмену действительно ловит.
   */
  /**
   * Планка ИЗМЕРЕНА, а не назначена.
   *
   * ⚠️ Ровно 100 % клеток не бывает НИКОГДА, и это не дефект: в любой момент передние перья уже
   * ушли за нижний край, а задние ещё не вошли сверху. Требовать полной сетки значило бы требовать
   * эффекта втрое длиннее. Замер после починки полосы старта (зерно 5, все раскладки): пик 81–83 %,
   * а порог 70 % держится от 517 мс (вертикальный монитор, самый скромный) до 917 мс.
   * ⚠️ Расчёт детерминированный — зерно фиксировано, — поэтому мигать тест не может.
   */
  const FULL = 0.7;
  const HOLD_MS = 500;

  /** Занятость экрана по сетке — та же функция, что в коде, не самодельная копия в тесте. */
  const coverage = (fs: ReturnType<typeof makeFeathers>, w: number, h: number, elapsed: number) =>
    gridCoverage(fs, w, h, elapsed);

  for (const v of VIEWPORTS) {
    it(`${v.name}: покрытие держится выше ${FULL * 100}% не меньше ${HOLD_MS} мс`, () => {
      const fs = makeFeathers(v.w, v.h, featherCount(v.w, v.h), seeded(5));
      const dt = 1 / 60;
      let held = 0;
      let peak = 0;
      for (let ms = 0; ms <= EFFECT_MS.feathers; ms += dt * 1000) {
        const c = coverage(fs, v.w, v.h, ms);
        if (c > peak) peak = c;
        if (c >= FULL) held += dt * 1000;
        for (const f of fs) stepFeather(f, ms, dt);
      }
      assert.ok(
        held >= HOLD_MS,
        `держится ${Math.round(held)} мс при пике ${(peak * 100).toFixed(1)}% — нужно ${HOLD_MS} мс`,
      );
    });
  }

  /**
   * 🔴 Проверка САМОЙ МЕРЫ, а не эффекта. Мутация «все перья летят в одну точку» — ровно то, что
   * прежняя сумма площадей пропускала бы зелёной. Если однажды кто-то вернёт сумму, этот тест
   * упадёт первым и объяснит, почему так делать нельзя.
   */
  /**
   * Политика отступления — вынесена из слоя отрисовки по разбору Codex.
   *
   * 🔴 Пока она жила в цикле, проверить её было нечем: цикл требует канвы, картинок и настоящих
   * кадров. А вопрос она решает не косметический — выполняется ли обещание плотности на слабой
   * машине. Ответ, который тесты фиксируют: НЕ выполняется, и это осознанный размен.
   */
  describe('отступление на медленных кадрах', () => {
    const slow = { elapsed: 1000, frameMs: 30 };
    const fast = { elapsed: 1000, frameMs: 8 };

    it('быстрые кадры ничего не меняют', () => {
      const s = degradeStep({ active: 700, slowFrames: 3 }, fast.elapsed, fast.frameMs);
      assert.deepEqual(s, { active: 700, slowFrames: 3 });
    });

    /** ⚠️ Без отсечки разогрева эффект резал бы себя на КАЖДОМ запуске, включая мощные машины. */
    it('первые кадры не считаются — там разогрев и декодирование', () => {
      const s = degradeStep({ active: 700, slowFrames: 5 }, 100, 40);
      assert.deepEqual(s, { active: 700, slowFrames: 5 });
    });

    it('режет только на шестом медленном кадре подряд, а не на первом', () => {
      let s = { active: 700, slowFrames: 0 };
      for (let i = 0; i < 5; i++) s = degradeStep(s, slow.elapsed, slow.frameMs);
      assert.equal(s.active, 700, 'пять медленных кадров — ещё терпим');
      s = degradeStep(s, slow.elapsed, slow.frameMs);
      assert.equal(s.active, 525, 'шестой — режем на четверть');
      assert.equal(s.slowFrames, 0, 'счётчик обнуляется, иначе следующий кадр резал бы снова');
    });

    /**
     * 🔴 Честный ответ на вопрос Codex: сколько остаётся на совсем слабой машине. Двенадцать
     * медленных кадров — два отступления, дальше упор в дно.
     */
    it('на слабой машине оседает на дне, а не уходит в ноль', () => {
      let s = { active: 700, slowFrames: 0 };
      for (let i = 0; i < 12; i++) s = degradeStep(s, slow.elapsed, slow.frameMs);
      assert.equal(s.active, 394, 'после двух отступлений');
      for (let i = 0; i < 200; i++) s = degradeStep(s, slow.elapsed, slow.frameMs);
      assert.equal(s.active, 150, 'дно, ниже которого осыпание перестаёт читаться');
    });

    /** ⚠️ Обратно число НЕ растёт: пульсация плотности заметнее, чем ровно более редкий дождь. */
    it('число частиц не восстанавливается, когда кадры снова стали быстрыми', () => {
      let s = { active: 700, slowFrames: 0 };
      for (let i = 0; i < 6; i++) s = degradeStep(s, slow.elapsed, slow.frameMs);
      const cut = s.active;
      for (let i = 0; i < 50; i++) s = degradeStep(s, fast.elapsed, fast.frameMs);
      assert.equal(s.active, cut);
    });
  });

  it('🔴 куча в центре НЕ считается покрытием, в отличие от дождя', () => {
    const w = 1920;
    const h = 1080;
    const fs = makeFeathers(w, h, featherCount(w, h), seeded(5));
    /**
     * ⚠️ Берём ПИК за весь эффект, а не срез в наугад выбранный момент. Первая версия мерила на
     * двух секундах — до пика не дотянула и упала на 50 %, хотя сравнение было верным. Момент
     * пика зависит от раскладки, и подбирать его руками значит закладывать в тест ещё одно число,
     * которое однажды разъедется.
     */
    const dt = 1 / 60;
    let rain = 0;
    let piled = 0;
    for (let ms = 0; ms <= EFFECT_MS.feathers; ms += dt * 1000) {
      rain = Math.max(rain, gridCoverage(fs, w, h, ms));
      // Те же частицы, того же размера и числа — но собранные в одну точку экрана.
      piled = Math.max(piled, gridCoverage(fs.map((f) => ({ ...f, x: w / 2, y: h / 2 })), w, h, ms));
      for (const f of fs) stepFeather(f, ms, dt);
    }
    assert.ok(rain > 0.6, `дождь обязан занимать экран, а занимает ${(rain * 100).toFixed(0)}%`);
    assert.ok(piled < 0.15, `куча не должна считаться покрытием, а насчитала ${(piled * 100).toFixed(0)}%`);
  });

  it('и плотность на широком мониторе не хуже, чем на ноутбуке', () => {
    // Ровно та регрессия, что уехала в прод: потолок частиц срезал именно большой экран.
    const peakOf = (w: number, h: number) => {
      const fs = makeFeathers(w, h, featherCount(w, h), seeded(5));
      const dt = 1 / 60;
      let peak = 0;
      for (let ms = 0; ms <= EFFECT_MS.feathers; ms += dt * 1000) {
        peak = Math.max(peak, coverage(fs, w, h, ms));
        for (const f of fs) stepFeather(f, ms, dt);
      }
      return peak;
    };
    const small = peakOf(1366, 768);
    const wide = peakOf(3440, 1440);
    assert.ok(wide >= small * 0.85, `ноутбук ${(small * 100).toFixed(0)}%, широкий ${(wide * 100).toFixed(0)}%`);
  });
});

describe('разнобой — это и есть отличие перьев от конфетти', () => {
  const feathers = makeFeathers(1920, 1080, 200, seeded(3));

  it('размеры внутри назначенных границ и действительно разные', () => {
    const sizes = feathers.map((f) => f.size);
    assert.ok(Math.min(...sizes) >= SIZE_MIN);
    assert.ok(Math.max(...sizes) <= SIZE_MAX);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) > (SIZE_MAX - SIZE_MIN) * 0.6, 'разброс схлопнулся');
  });

  it('есть оба режима падения, и порхающих больше', () => {
    const flutter = feathers.filter((f) => f.mode === 'flutter').length;
    const tumble = feathers.length - flutter;
    assert.ok(tumble > 0 && flutter > 0, 'один режим на всех читается как бумажки');
    assert.ok(flutter > tumble, 'кувыркание толпой превращается в мельтешение');
  });

  it('сносит вбок, а не роняет отвесно', () => {
    // Вертикальное падение читается как дождь. Проверяем по итогу, а не по начальной скорости.
    const before = makeFeathers(1920, 1080, 40, seeded(11));
    const after = before.map((f) => ({ ...f }));
    const dt = 1 / 60;
    for (let ms = 0; ms <= 1500; ms += dt * 1000) for (const f of after) stepFeather(f, ms, dt);
    const moved = after.filter((f, i) => Math.abs(f.x - before[i].x) > 20).length;
    assert.ok(moved > after.length * 0.8, `вбок сдвинулись только ${moved} из ${after.length}`);
  });

  it('стартуют выше экрана и вразнобой по высоте', () => {
    const ys = feathers.map((f) => f.y);
    assert.ok(Math.max(...ys) < 0, 'частица, начавшаяся в кадре, выглядит возникшей из ниоткуда');
    assert.ok(Math.min(...ys) < -100, 'одинаковый старт даёт ровную строку перьев в первом кадре');
  });
});

describe('затухание', () => {
  it('до хвоста полностью непрозрачно, в конце — ноль', () => {
    assert.equal(featherFade(0), 1);
    assert.equal(featherFade(EFFECT_MS.feathers - FADE_MS), 1);
    assert.equal(featherFade(EFFECT_MS.feathers), 0);
    assert.ok(featherFade(EFFECT_MS.feathers - FADE_MS / 2) > 0.4);
  });

  it('за пределом эффекта не уходит в минус', () => {
    assert.equal(featherFade(EFFECT_MS.feathers + 5000), 0);
  });
});

describe('плотность по площади окна', () => {
  it('широкий монитор получает больше частиц, чем ноутбук', () => {
    assert.ok(featherCount(3440, 1440) > featherCount(1366, 768));
  });

  it('но не больше потолка — выше него слой прореживает частицы сам', () => {
    // Потолок поднят с 300 до 900: старое значение не давало набрать плотность на широком мониторе.
    // Ниже него держит сам эффект, меряя время кадра, — целиться в картинку и отступать по факту
    // честнее, чем занижать заранее для всех.
    assert.ok(featherCount(7680, 4320) <= 900);
  });

  it('и не меньше базовых 150 на маленьком окне', () => {
    assert.equal(featherCount(500, 400), 150);
  });
});
