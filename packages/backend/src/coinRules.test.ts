import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MILLI,
  accrualStamp,
  accrue,
  beforeCutoff,
  companyPercent,
  dayKey,
  dayStart,
  decayPercent,
  economyTotals,
  freezeWindow,
  presencePercent,
  raiseCompensation,
  shouldCompensate,
  shouldSpendToggle,
  replay,
  retroCutoff,
  rollPeriods,
  seasonRange,
  seasonId,
  seasonName,
  wearsCrown,
  type AccrualSample,
  type AccrualState,
  type EconomySettings,
  seasonBump,
} from './coinRules.js';

const settings = (patch: Partial<EconomySettings> = {}): EconomySettings => ({
  ratePer5min: 10,
  alonePercent: 25,
  companyPercent: 75,
  dailyCap: 0,
  decayAfterMinutes: 0,
  decayPercent: 100,
  mutedPercent: 100,
  // ⚠️ Минута, а не боевые 10: эти тесты про АРИФМЕТИКУ множителей, и выплата на каждом срезе тут
  // удобнее. Шаг выплаты и заморозка проверяются отдельным блоком ниже, на своих настройках.
  payoutMinutes: 1,
  deafenedPercent: 25,
  awayPercent: 25,
  // К арифметике начисления отношения не имеет — это ручка на маршруте настроек.
  compensateOnRaise: false,
  ...patch,
});

const sample = (patch: Partial<AccrualSample> = {}): AccrualSample => ({
  seconds: 300,
  peers: 1,
  muted: false,
  deafened: false,
  away: false,
  ...patch,
});

const emptyState = (patch: Partial<AccrualState> = {}): AccrualState => ({
  pendingMilli: 0,
  pendingSeconds: 0,
  baseMilli: 0,
  deltaPresenceMilli: 0,
  deltaCompanyMilli: 0,
  deltaDecayMilli: 0,
  secondsToday: 0,
  earnedToday: 0,
  ...patch,
});

describe('множители присутствия', () => {
  it('обычное присутствие и выключенный микрофон без штрафа дают полную ставку', () => {
    // Ловит возврат старой политики, в которой вежливый мьют молча обнулял или резал начисление.
    const s = settings({ mutedPercent: 100 });
    assert.equal(presencePercent(sample(), s), 100);
    assert.equal(presencePercent(sample({ muted: true }), s), 100);
  });

  it('деафен перекрывает мьют, а не перемножается с ним', () => {
    // Клиент ставит оба флага при «не слышу»: 50% мьюта и 25% деафена должны остаться четвертью, не 12.5%.
    const s = settings({ mutedPercent: 50, deafenedPercent: 25 });
    assert.equal(presencePercent(sample({ muted: true, deafened: true }), s), 25);
  });

  it('один ждёт друзей с одиночным множителем, вдвоём получает 100%, втроём — множитель компании', () => {
    // Ловит сдвиг границы peers: число хранит только ДРУГИХ людей, поэтому один собеседник — это полная ставка.
    const s = settings({ alonePercent: 20, companyPercent: 60 });
    assert.equal(companyPercent(0, s), 20);
    assert.equal(companyPercent(1, s), 100);
    assert.equal(companyPercent(2, s), 60);
  });
});

describe('затухание и один срез', () => {
  it('затухание начинается ровно на следующем отрезке и дальше ступенчато уменьшается', () => {
    const s = settings({ decayAfterMinutes: 60, decayPercent: 50 });
    assert.equal(decayPercent(3_599, s), 100);
    assert.equal(decayPercent(3_600, s), 50);
    assert.equal(decayPercent(7_200, s), 25);
  });

  it('дробные монеты переносятся между срезами и за пять минут дают полную ставку', () => {
    // Ловит потерю 0.4 монеты на каждой минуте при обычной ставке 7 за пять минут.
    const s = settings({ ratePer5min: 7 });
    let state = emptyState();
    let coins = 0;
    for (let i = 0; i < 5; i++) {
      const result = accrue(sample({ seconds: 60 }), state, s);
      coins += result.coins;
      state = result.next;
    }
    assert.equal(coins, 7);
    assert.equal(state.pendingMilli, 0);
  });

  it('применяет мьют, компанию и затухание именно в документированном порядке', () => {
    // На маленьком срезе раннее округление меняет результат: перестановка двух множителей дала бы лишнюю тысячную.
    const result = accrue(
      sample({ seconds: 1, peers: 2, muted: true }),
      emptyState({ secondsToday: 60 }),
      settings({ ratePer5min: 2, mutedPercent: 50, companyPercent: 86, decayAfterMinutes: 1, decayPercent: 47 }),
    );
    assert.deepEqual(result, {
      coins: 0,
      next: {
        pendingMilli: 0,
        pendingSeconds: 1,
        // Вклад каждого множителя копится отдельно, чтобы журнал объяснил сумму (#121).
        baseMilli: 7,
        deltaPresenceMilli: -4,
        deltaCompanyMilli: -1,
        deltaDecayMilli: -2,
        secondsToday: 61,
        earnedToday: 0,
      },
    });
  });

  it('срез, начавшийся до порога затухания, целиком остаётся по старой ставке', () => {
    // Ловит списание минут, которые человек отсидел до порога, из-за проверки состояния в конце среза.
    const result = accrue(
      sample({ seconds: 60 }),
      emptyState({ secondsToday: 59 * 60 }),
      settings({ ratePer5min: 10, decayAfterMinutes: 60, decayPercent: 50 }),
    );
    assert.equal(result.coins, 2);
  });

  it('время растёт даже когда нулевая компания, мьют или потолок не дают монет', () => {
    // Иначе можно было бы пересидеть затухание без дохода и вернуться к полной ставке как будто только зашёл.
    const companyZero = accrue(sample({ seconds: 60, peers: 0 }), emptyState(), settings({ alonePercent: 0 }));
    const mutedZero = accrue(sample({ seconds: 60, muted: true }), emptyState(), settings({ mutedPercent: 0 }));
    const capped = accrue(sample({ seconds: 60 }), emptyState({ earnedToday: 1 }), settings({ dailyCap: 1 }));
    assert.equal(companyZero.next.secondsToday, 60);
    assert.equal(mutedZero.next.secondsToday, 60);
    assert.equal(capped.next.secondsToday, 60);
    assert.equal(companyZero.coins + mutedZero.coins + capped.coins, 0);
  });

  it('суточный потолок ограничивает итог и выбрасывает дробный остаток', () => {
    // Ловит «долг» из тысячных, который иначе перелетел бы через сброшенный в полночь потолок.
    const result = accrue(sample(), emptyState({ pendingMilli: 900, earnedToday: 4 }), settings({ ratePer5min: 100, dailyCap: 5 }));
    assert.equal(result.coins, 1);
    assert.deepEqual(result.next, {
      pendingMilli: 0,
      pendingSeconds: 0,
      baseMilli: 0,
      deltaPresenceMilli: 0,
      deltaCompanyMilli: 0,
      deltaDecayMilli: 0,
      secondsToday: 300,
      earnedToday: 5,
    });
    // Потолок обязан попасть в разбор: это самая непонятная для человека причина «получил меньше».
    assert.equal(result.breakdown?.cappedByDaily, true);
  });

  it('нулевой или дробный отрицательный срез не забирает время и деньги', () => {
    const state = emptyState({ pendingMilli: MILLI - 1, secondsToday: 42, earnedToday: 3 });
    assert.deepEqual(accrue(sample({ seconds: -0.5 }), state, settings()), {
      coins: 0,
      next: {
        pendingMilli: MILLI - 1,
        pendingSeconds: 0,
        baseMilli: 0,
        deltaPresenceMilli: 0,
        deltaCompanyMilli: 0,
        deltaDecayMilli: 0,
        secondsToday: 42,
        earnedToday: 3,
      },
    });
  });
});

describe('границы календаря', () => {
  it('ключ суток меняется в местную московскую полночь, а не в UTC-полночь', () => {
    assert.equal(dayKey(new Date('2026-08-29T20:59:59.999Z')), '2026-08-29');
    assert.equal(dayKey(new Date('2026-08-29T21:00:00.000Z')), '2026-08-30');
  });

  it('декабрь относится к зиме следующего года, а название зимы показывает обе половины', () => {
    assert.equal(seasonId(new Date('2026-12-01T00:00:00Z')), 'winter-2027');
    assert.equal(seasonName('winter-2027'), 'Зима 2026/27');
    assert.equal(seasonName('summer-2026'), 'Лето 2026');
  });

  it('смена суток сбрасывает дневные счётчики, а смена сезона — только сезонный', () => {
    // 🔴 `pendingMilli`/`pendingSeconds` полночь НЕ трогает: это накопленная ценность недосиженного
    // отрезка, и обнулить её значит отнять у человека до десяти минут за то, что он сидел на
    // границе суток. Сбрасываются только суточные счётчики — потолок и затухание.
    const state = {
      day: '2026-08-29',
      seasonId: 'summer-2026',
      secondsToday: 4_200,
      earnedToday: 9,
      pendingMilli: 500,
      pendingSeconds: 240,
      seasonEarned: 50,
      balance: 123,
      earnedTotal: 456,
    };
    const next = rollPeriods(state, new Date('2026-09-01T00:00:00Z'));
    assert.deepEqual(next, {
      ...state,
      day: '2026-09-01',
      seasonId: 'autumn-2026',
      secondsToday: 0,
      earnedToday: 0,
      seasonEarned: 0,
    });
  });
});

describe('пересчёт истории', () => {
  it('переносит дроби между срезами и сортирует итог по монетам, затем по имени', () => {
    // Ловит расхождение ретроначисления с живой формулой и нестабильный порядок лидеров при равенстве.
    const at = new Date('2026-08-29T12:00:00Z');
    const result = replay(
      [
        { userId: 'zoe', at, seconds: 60, peers: 1, muted: false, deafened: false, away: false },
        { userId: 'amy', at, seconds: 300, peers: 1, muted: false, deafened: false, away: false },
        { userId: 'zoe', at: new Date(at.getTime() + 60_000), seconds: 60, peers: 1, muted: false, deafened: false, away: false },
        { userId: 'zoe', at: new Date(at.getTime() + 120_000), seconds: 60, peers: 1, muted: false, deafened: false, away: false },
        { userId: 'zoe', at: new Date(at.getTime() + 180_000), seconds: 60, peers: 1, muted: false, deafened: false, away: false },
        { userId: 'zoe', at: new Date(at.getTime() + 240_000), seconds: 60, peers: 1, muted: false, deafened: false, away: false },
      ],
      settings({ ratePer5min: 7 }),
    );
    assert.deepEqual(result, [
      { userId: 'amy', coins: 7, seconds: 300 },
      { userId: 'zoe', coins: 7, seconds: 300 },
    ]);
  });

  it('местная полночь даёт новый потолок и не переносит дроби прошлого дня', () => {
    // Ловит ретроначисление, которое склеивает вечер и следующий календарный день в один дневной лимит.
    const result = replay(
      [
        { userId: 'alice', at: new Date('2026-08-29T20:59:00Z'), seconds: 300, peers: 1, muted: false, deafened: false, away: false },
        { userId: 'alice', at: new Date('2026-08-29T21:00:00Z'), seconds: 300, peers: 1, muted: false, deafened: false, away: false },
      ],
      settings({ ratePer5min: 5, dailyCap: 5 }),
    );
    assert.deepEqual(result, [{ userId: 'alice', coins: 10, seconds: 600 }]);
  });
});

describe('шаг выплаты и заморозка недосиженного', () => {
  const paid = settings({ ratePer5min: 10, payoutMinutes: 10 });
  const minute = (state: AccrualState, patch: Partial<AccrualSample> = {}) =>
    accrue(sample({ seconds: 60, peers: 1, ...patch }), state, paid);

  it('до десятой минуты не платит ничего, а копит', () => {
    let state = emptyState();
    let coins = 0;
    for (let i = 0; i < 9; i++) {
      const r = minute(state);
      coins += r.coins;
      state = r.next;
    }
    assert.equal(coins, 0, 'девять минут — ещё не выплата');
    assert.equal(state.pendingSeconds, 540);
    assert.equal(state.pendingMilli, 18_000);
  });

  it('на десятой минуте выплачивает всё накопленное и начинает отсчёт заново', () => {
    let state = emptyState();
    let coins = 0;
    for (let i = 0; i < 10; i++) {
      const r = minute(state);
      coins += r.coins;
      state = r.next;
    }
    assert.equal(coins, 20, 'десять минут по ставке 10 за пять минут');
    assert.equal(state.pendingSeconds, 0);
    assert.equal(state.pendingMilli, 0);
  });

  it('🔴 недосиженное ЗАМЕРЗАЕТ на разрыве и продолжается с того же места', () => {
    // Ушёл на седьмой минуте. Никакого «человек отключился» в правилах нет вовсе: состояние просто
    // перестаёт меняться, и в этом вся заморозка — ломаться нечему ни при перезапуске, ни при сбое.
    let state = emptyState();
    for (let i = 0; i < 7; i++) state = minute(state).next;
    const frozen = { ...state };
    assert.equal(frozen.pendingSeconds, 420);
    assert.equal(frozen.pendingMilli, 14_000);

    // Вернулся через неделю — те же 420 секунд, и выплата приходит на третьей минуте после возврата.
    let coins = 0;
    let resumed: AccrualState = frozen;
    for (let i = 0; i < 3; i++) {
      const r = minute(resumed);
      coins += r.coins;
      resumed = r.next;
    }
    assert.equal(coins, 20, 'семь замороженных минут плюс три новых = полная выплата');
    assert.equal(resumed.pendingSeconds, 0);
  });

  it('🔴 копится ЦЕННОСТЬ, а не секунды: девять минут в одиночку не оплачиваются по ставке компании', () => {
    // Схема фарма, которую это закрывает: отсидеть отрезок одному (четверть ставки) и добрать
    // последнюю минуту в полном канале, чтобы всё оплатилось по множителю компании.
    const s = settings({ ratePer5min: 10, payoutMinutes: 10, alonePercent: 25, companyPercent: 150 });
    let state = emptyState();
    let coins = 0;
    for (let i = 0; i < 9; i++) {
      const r = accrue(sample({ seconds: 60, peers: 0 }), state, s);
      coins += r.coins;
      state = r.next;
    }
    const last = accrue(sample({ seconds: 60, peers: 2 }), state, s);
    coins += last.coins;
    // 9 минут по 500 тысячных + 1 минута по 3000 = 7500 => 7 монет.
    // Если бы копили секунды и множили в конце, вышло бы 30 — вчетверо больше.
    assert.equal(coins, 7);
  });

  it('🔴 местная полночь не съедает недосиженный отрезок', () => {
    // Сутки сбрасывают потолок и затухание, но не заработанную ценность: иначе человек, сидевший
    // на границе суток, терял бы до десяти минут просто за то, что часы перевалили за полночь.
    const result = replay(
      [
        { userId: 'alice', at: new Date('2026-08-29T20:59:00Z'), seconds: 300, peers: 1, muted: false, deafened: false, away: false },
        { userId: 'alice', at: new Date('2026-08-29T21:00:00Z'), seconds: 300, peers: 1, muted: false, deafened: false, away: false },
      ],
      settings({ ratePer5min: 10, payoutMinutes: 10 }),
    );
    assert.deepEqual(result, [{ userId: 'alice', coins: 20, seconds: 600 }]);
  });

  it('потолок останавливает накопление, а не копит впрок до полуночи', () => {
    // Иначе всё, что накопилось за ночь поверх потолка, вывалилось бы одной кучей ровно в полночь.
    const s = settings({ ratePer5min: 10, payoutMinutes: 10, dailyCap: 3 });
    const r = accrue(sample({ seconds: 60, peers: 1 }), emptyState({ earnedToday: 3 }), s);
    assert.equal(r.coins, 0);
    assert.equal(r.next.pendingMilli, 0);
    assert.equal(r.next.pendingSeconds, 0);
    assert.equal(r.next.secondsToday, 60, 'время всё равно идёт — затухание меряет присутствие');
  });

  it('нулевой и отрицательный срез не двигают ни время, ни накопленную ценность', () => {
    // Ловит повтор регрессии с нулевыми срезами: мусорный тайминг не должен приблизить выплату или
    // дать затуханию лишнюю минуту, даже когда в кошельке уже есть недосиженный отрезок.
    const state = emptyState({ pendingMilli: 750, pendingSeconds: 240, baseMilli: 1_000, deltaCompanyMilli: -250, secondsToday: 600 });
    const s = settings({ payoutMinutes: 10 });

    for (const seconds of [0, -1, -0.5]) {
      const r = accrue(sample({ seconds }), state, s);
      assert.equal(r.coins, 0);
      assert.equal(r.breakdown, undefined);
      assert.deepEqual(r.next, state);
    }
  });
});

describe('разбор выплаты для журнала', () => {
  it('🔴 инвариант: база плюс все дельты равны накопленному', () => {
    // Если он разойдётся, объяснение в журнале начнёт врать про ту же сумму, которую само же и
    // описывает. Проверяем на срезах с РАЗНОЙ обстановкой — ради этого разбор и копится.
    const s = settings({ ratePer5min: 9, payoutMinutes: 10, alonePercent: 25, companyPercent: 150, decayAfterMinutes: 3, decayPercent: 50 });
    let st = emptyState();
    const mixed: Partial<AccrualSample>[] = [
      { peers: 0 }, { peers: 1 }, { peers: 4 }, { peers: 1, muted: true }, { peers: 2 },
      { peers: 0, deafened: true }, { peers: 3 }, { peers: 1 }, { peers: 2 },
    ];
    for (const m of mixed) {
      st = accrue(sample({ seconds: 60, ...m }), st, s).next;
      assert.equal(
        st.baseMilli + st.deltaPresenceMilli + st.deltaCompanyMilli + st.deltaDecayMilli,
        st.pendingMilli,
      );
    }
  });

  /**
   * 🔴 Регрессия на находку Codex: период прошёл, а целой монеты не набралось.
   *
   * При ставке 1 за 5 минут и шаге выплаты в минуту ворота периода открыты КАЖДЫЙ раз, а монета
   * появляется только на пятый заход. Раньше первые четыре захода стирали накопленный разбор,
   * оставляя жить одни дроби, и журнал объяснял целую монету двумя десятыми работы.
   *
   * ⚠️ Проверяем и то, что разбор объясняет ВСЮ монету (300 секунд, 1000 милли), и то, что до неё
   * разбора нет вовсе. Одной проверки мало: вернуть разбор на каждом заходе — тоже поломка, просто
   * с другой стороны.
   */
  it('🔴 период без целой монеты не стирает накопленное объяснение', () => {
    const s = settings({ ratePer5min: 1, payoutMinutes: 1 });
    let st = emptyState();
    for (let i = 0; i < 4; i++) {
      const r = accrue(sample({ seconds: 60, peers: 1 }), st, s);
      assert.equal(r.coins, 0);
      assert.equal(r.breakdown, undefined, `заход ${i + 1}: разбора быть не должно, монет нет`);
      st = r.next;
    }
    const paid = accrue(sample({ seconds: 60, peers: 1 }), st, s);
    assert.equal(paid.coins, 1);
    assert.equal(paid.breakdown?.seconds, 300);
    assert.equal(paid.breakdown?.baseMilli, 1000);
  });

  /**
   * Обратная сторона того же правила: у потолка суток дроби выбрасываются НАМЕРЕННО, и копить их
   * дальше значило бы возвращать выброшенное следующим днём.
   *
   * ⚠️ Потолок берётся НЕДОвыбранным (осталось место на 2 монеты из 3): при выбранном сработал бы
   * ранний выход выше по коду, и до этой ветки дело бы не дошло вовсе. Первая версия теста как раз
   * на этом и споткнулась — сценарий выглядел правдоподобно, а состояние оказалось недостижимым.
   */
  it('упор в суточный потолок обнуляет накопленное, в отличие от недобора', () => {
    const s = settings({ ratePer5min: 10, payoutMinutes: 5, dailyCap: 3 });
    const r = accrue(sample({ seconds: 300, peers: 1 }), emptyState({ earnedToday: 1 }), s);
    assert.equal(r.coins, 2, 'выдано ровно оставшееся место, а не всё заработанное');
    assert.equal(r.breakdown?.cappedByDaily, true);
    // Дроби и накопленное объяснение выброшены — в отличие от недобора, где они переживают заход.
    assert.equal(r.next.pendingMilli, 0);
    assert.equal(r.next.baseMilli, 0);
  });

  it('разбор приходит ТОЛЬКО с выплатой, а не на каждом срезе', () => {
    // Объяснять нечего, пока монеты не начислены: строка «плюс ноль, потому что…» бессмысленна.
    const s = settings({ ratePer5min: 10, payoutMinutes: 10 });
    let st = emptyState();
    for (let i = 0; i < 9; i++) {
      const r = accrue(sample({ seconds: 60, peers: 1 }), st, s);
      assert.equal(r.breakdown, undefined);
      st = r.next;
    }
    const last = accrue(sample({ seconds: 60, peers: 1 }), st, s);
    assert.ok(last.breakdown);
    assert.equal(last.breakdown?.seconds, 600);
    assert.equal(last.breakdown?.baseMilli, 20_000);
  });

  it('множитель компании приходит НАДБАВКОЙ со знаком плюс, а не потерей', () => {
    // Дельты знаковые: втроём человек получает больше базы, и объяснение должно это показывать.
    const s = settings({ ratePer5min: 10, payoutMinutes: 1, companyPercent: 150 });
    const r = accrue(sample({ seconds: 60, peers: 3 }), emptyState(), s);
    assert.ok(r.breakdown!.companyMilli > 0, 'компания втроём — это надбавка');
    assert.equal(r.breakdown?.presenceMilli, 0);
  });

  it('одиночество и мьют приходят потерями со знаком минус', () => {
    /**
     * ⚠️ Ставка ВЫСОКАЯ намеренно. Прежние 10 за 5 минут при этих множителях давали 250 милли за
     * срез — то есть ноль монет, и тест держался на разборе, приходившем без выплаты. Это и было
     * нарушение контракта, найденное Codex: объяснять нечего, пока платить нечего. Здесь монеты
     * реально начисляются, и знаки дельт проверяются на настоящей выплате.
     */
    const s = settings({ ratePer5min: 100, payoutMinutes: 1, alonePercent: 25, mutedPercent: 50 });
    const r = accrue(sample({ seconds: 60, peers: 0, muted: true }), emptyState(), s);
    assert.ok(r.coins > 0, 'сценарий обязан доходить до выплаты, иначе разбора не будет вовсе');
    assert.ok(r.breakdown!.presenceMilli < 0);
    assert.ok(r.breakdown!.companyMilli < 0);
  });

  it('при выплате разбор равен выданным монетам вместе с сохранённой дробью', () => {
    // Ловит расхождение ровно на границе выплаты: журнал хранит полный расчёт, а кошелёк — только
    // целые монеты и переносимую тысячную долю до следующей выплаты.
    const r = accrue(sample({ seconds: 60, peers: 2 }), emptyState(), settings({ ratePer5min: 7, payoutMinutes: 1, companyPercent: 150 }));
    const b = r.breakdown!;

    assert.equal(r.coins, 2);
    assert.equal(r.next.pendingMilli, 100);
    assert.equal(b.baseMilli + b.presenceMilli + b.companyMilli + b.decayMilli, r.coins * 1_000 + r.next.pendingMilli);
  });
});

describe('граница ретро и живого начисления (#124, Д1)', () => {
  const T = (iso: string) => new Date(iso);

  it('без отметки включения ретро берёт всё до текущего мгновения', () => {
    const now = T('2026-09-05T20:00:00Z');
    assert.equal(retroCutoff(null, now).getTime(), now.getTime());
  });

  it('с отметкой граница — момент включения, а не «сейчас»', () => {
    const on = T('2026-09-05T18:00:00Z');
    assert.equal(retroCutoff(on, T('2026-09-07T12:00:00Z')).getTime(), on.getTime());
  });

  it('🔴 срез ПОСЛЕ включения в ретро не попадает', () => {
    // Ровно тот сценарий из аудита: включили в пятницу, ретро нажали в воскресенье. Пятничные и
    // субботние вечера уже оплачены тикером — второй раз за них платить нельзя.
    const on = T('2026-09-04T20:00:00Z');
    const rows = [
      { userId: 'a', at: T('2026-09-03T21:00:00Z'), seconds: 60, peers: 2, muted: false, deafened: false, away: false },
      { userId: 'a', at: T('2026-09-04T19:59:59Z'), seconds: 60, peers: 2, muted: false, deafened: false, away: false },
      { userId: 'a', at: T('2026-09-05T21:00:00Z'), seconds: 60, peers: 2, muted: false, deafened: false, away: false },
      { userId: 'b', at: T('2026-09-06T21:00:00Z'), seconds: 60, peers: 2, muted: false, deafened: false, away: false },
    ];
    const kept = beforeCutoff(rows, retroCutoff(on, T('2026-09-07T12:00:00Z')));
    assert.deepEqual(kept.map((r) => r.at.toISOString()), ['2026-09-03T21:00:00.000Z', '2026-09-04T19:59:59.000Z']);
  });

  it('срез РОВНО в момент включения относится к живому начислению', () => {
    // Строго `<`: ошибаться надо в сторону «не заплатить дважды».
    const on = T('2026-09-04T20:00:00Z');
    const rows = [{ userId: 'a', at: on, seconds: 60, peers: 0, muted: false, deafened: false, away: false }];
    assert.equal(beforeCutoff(rows, on).length, 0);
  });

  it('и заплатить за отсечённые вечера нечем: replay по ним даёт ноль', () => {
    // Проверяем не фильтр, а ПОСЛЕДСТВИЕ: после отсечения монет за эти срезы не появляется.
    const on = T('2026-09-04T20:00:00Z');
    const after = [{ userId: 'a', at: T('2026-09-05T21:00:00Z'), seconds: 600, peers: 3, muted: false, deafened: false, away: false }];
    assert.deepEqual(replay(beforeCutoff(after, on), settings({ ratePer5min: 10, payoutMinutes: 1 })), []);
    // Тот же срез без отсечения — оплачивается, то есть дыра была настоящей.
    assert.ok(replay(after, settings({ ratePer5min: 10, payoutMinutes: 1 }))[0].coins > 0);
  });

  it('отметка включения ставится один раз и больше не двигается', () => {
    const first = T('2026-09-04T20:00:00Z');
    const later = T('2026-09-10T20:00:00Z');
    // Первое включение — ставим.
    assert.equal(accrualStamp(null, true, first)?.getTime(), first.getTime());
    // Повторный PATCH с `enabled: true` (двойной клик, второй клиент) — не трогаем.
    assert.equal(accrualStamp(first, true, later), null);
    // Выключили и включили снова — граница остаётся на первом включении.
    assert.equal(accrualStamp(first, false, later), null);
    // Правка любого другого ползунка до включения отметку не ставит.
    assert.equal(accrualStamp(null, undefined, later), null);
    assert.equal(accrualStamp(null, false, later), null);
  });
});

describe('доначисление при повышении ставки (#124, Д5)', () => {
  it('понижение НЕ отнимает — из кошельков ничего не испаряется', () => {
    assert.equal(raiseCompensation(500, 20, 10), 0);
    assert.equal(raiseCompensation(500, 10, 10), 0, 'ставка не менялась — компенсировать нечего');
  });

  it('повышение вдвое доначисляет столько же, сколько было', () => {
    assert.equal(raiseCompensation(500, 10, 20), 500);
  });

  it('округляет ВНИЗ — монеты из воздуха на копеечных балансах не берутся', () => {
    // 1 монета при повышении 10→13 дала бы 0.3; вверх это создало бы монету из ничего.
    assert.equal(raiseCompensation(1, 10, 13), 0);
    assert.equal(raiseCompensation(7, 10, 13), 2);
  });

  it('пустому кошельку и отсутствующей прежней ставке доначислять нечего', () => {
    assert.equal(raiseCompensation(0, 10, 50), 0);
    assert.equal(raiseCompensation(500, undefined, 50), 0, 'строки настроек ещё не было');
    assert.equal(raiseCompensation(500, 0, 50), 0, 'ставка была нулевой — множить не на что');
  });

  it('🔴 качели вверх-вниз-вверх без сброса тумблера раскручивали бы балансы', () => {
    // Ровно тот эффект, ради которого тумблер теперь гасится после срабатывания: вниз он не
    // отыгрывает, поэтому каждая калибровка «туда-обратно» оставляет чистый плюс.
    let balance = 100;
    balance += raiseCompensation(balance, 10, 20); // 200
    balance += raiseCompensation(balance, 20, 10); // вниз — ноль, баланс остаётся 200
    balance += raiseCompensation(balance, 10, 20); // 400
    assert.equal(balance, 400, 'два круга калибровки — учетверение на ровном месте');
  });
});

/**
 * Разбор Codex: прежний тест «качели ставки» доказывал лишь, что повторный вызов чистой
 * `raiseCompensation` даёт то же число, — то есть арифметику. Само ПРАВИЛО одноразовости жило в
 * маршруте и не проверялось ничем. Теперь оно вынесено и проверяется здесь.
 */
describe('план смены ставки (вынос по разбору Codex)', () => {
  it('без взведённого тумблера не компенсируем ничего', () => {
    assert.equal(shouldCompensate(false, 10, 20), false);
  });

  it('компенсируем только РОСТ ставки', () => {
    assert.equal(shouldCompensate(true, 10, 20), true);
    assert.equal(shouldCompensate(true, 20, 10), false);
    assert.equal(shouldCompensate(true, 10, 10), false);
  });

  /**
   * ⚠️ Прежней ставки не было вовсе (первая настройка) — компенсировать не от чего: до неё монет
   * не начисляли, и «обесценивания» не случилось.
   */
  it('без прежней ставки компенсировать нечего', () => {
    assert.equal(shouldCompensate(true, undefined, 20), false);
    assert.equal(shouldCompensate(true, 0, 20), false);
  });

  /**
   * 🔴 Одноразовость. Тумблер гаснет ТОЛЬКО когда что-то реально доначислилось: ставку подняли, а
   * кошельки пусты — повышения фактически не было, и тумблер обязан дожить до настоящего.
   * Забытый включённым, он превращает калибровку в станок: на каждом «вверх» доначисляет, на «вниз»
   * не отыгрывает, и балансы едут вверх на качелях.
   */
  it('🔴 тумблер тратится только при состоявшемся доначислении', () => {
    assert.equal(shouldSpendToggle(0), false);
    assert.equal(shouldSpendToggle(1), true);
    assert.equal(shouldSpendToggle(4200), true);
  });
});

describe('начало суток для запросов к журналу (#124, В2)', () => {
  it('совпадает с границей `dayKey` — местной полуночью, а не UTC', () => {
    // 21:00 UTC = полночь по МСК: сутки уже НОВЫЕ, и начало у них своё.
    const evening = new Date('2026-09-04T20:59:59Z');
    const justAfter = new Date('2026-09-04T21:00:00Z');

    assert.equal(dayKey(evening), '2026-09-04');
    assert.equal(dayKey(justAfter), '2026-09-05');
    assert.equal(dayStart(evening).toISOString(), '2026-09-03T21:00:00.000Z');
    assert.equal(dayStart(justAfter).toISOString(), '2026-09-04T21:00:00.000Z');
  });

  it('момент ровно на границе принадлежит НОВЫМ суткам и равен их началу', () => {
    const boundary = new Date('2026-09-04T21:00:00Z');
    assert.equal(dayStart(boundary).getTime(), boundary.getTime());
  });

  it('любой момент суток даёт одно и то же начало', () => {
    const a = dayStart(new Date('2026-09-04T21:00:01Z'));
    const b = dayStart(new Date('2026-09-05T20:59:59Z'));
    assert.equal(a.getTime(), b.getTime(), 'иначе окно потолка пары «съезжало» бы в течение вечера');
    assert.equal(dayKey(new Date('2026-09-04T21:00:01Z')), dayKey(new Date('2026-09-05T20:59:59Z')));
  });
});

describe('сводка движения монет (#124, К4)', () => {
  it('сгоревшее выводится из самих сумм, а не из подписи рядом с ними', () => {
    // Двадцать типов по 5: списано 100, дошло 80 — значит сгорело 20. Число следует из денег,
    // поэтому «потерять» его невозможно.
    const t = economyTotals([
      { reason: 'tip.out', total: -100, count: 20 },
      { reason: 'tip.in', total: 80, count: 20 },
    ]);
    assert.equal(t.tipped, 80);
    assert.equal(t.tips, 20);
    assert.equal(t.burned, 20);
    // 🔴 Перевод монет не создаёт — он их УНИЧТОЖАЕТ на величину налога.
    assert.equal(t.minted, -20);
  });

  it('при нулевом налоге не сгорает ничего', () => {
    const t = economyTotals([
      { reason: 'tip.out', total: -50, count: 10 },
      { reason: 'tip.in', total: 50, count: 10 },
    ]);
    assert.equal(t.burned, 0);
    assert.equal(t.minted, 0);
  });

  it('разводит источники по своим полям и складывает чистую эмиссию', () => {
    const t = economyTotals([
      { reason: 'voice', total: 640, count: 96 },
      { reason: 'retro', total: 3000, count: 9 },
      { reason: 'rescale', total: 120, count: 4 },
      { reason: 'grant', total: 50, count: 1 },
      { reason: 'tip.out', total: -25, count: 5 },
      { reason: 'tip.in', total: 20, count: 5 },
    ]);
    assert.equal(t.accrued, 640);
    assert.equal(t.retro, 3000);
    assert.equal(t.rescale, 120);
    assert.equal(t.granted, 50);
    assert.equal(t.burned, 5);
    assert.equal(t.minted, 640 + 3000 + 120 + 50 - 5);
  });

  it('пустой день — все нули, а не пропуски', () => {
    // Сводка открывается и утром, когда ещё ничего не происходило: она обязана показать нули, а не
    // рассыпаться на `undefined`.
    const t = economyTotals([]);
    assert.deepEqual(t, { accrued: 0, tipped: 0, tips: 0, burned: 0, retro: 0, rescale: 0, granted: 0, minted: 0 });
  });

  it('незнакомая причина не теряется из чистой эмиссии', () => {
    // Появится новый источник (покупка, штраф) — своей строки у него ещё нет, но в «сколько монет
    // в мире стало больше» он попасть обязан, иначе сводка тихо разойдётся с балансами.
    const t = economyTotals([{ reason: 'shop.buy', total: -300, count: 3 }]);
    assert.equal(t.minted, -300);
  });
});

describe('сезон живёт в том же поясе, что и сутки (#124, С6)', () => {
  it('🔴 первые часы 1 декабря — уже зима, а не осень', () => {
    // Было: сезон считался по UTC, а сутки по UTC+3, и три часа первого декабря числились осенью.
    // Полуночник в новогоднюю ночь видел бы подпись прошлого сезона.
    assert.equal(seasonId(new Date('2026-11-30T20:59:59Z')), 'autumn-2026', 'ещё 30 ноября по МСК');
    assert.equal(seasonId(new Date('2026-11-30T21:00:00Z')), 'winter-2027', 'уже 1 декабря по МСК');
  });

  it('граница сезона совпадает с границей суток', () => {
    // Один и тот же момент не может быть «уже новый день, но ещё прошлый сезон».
    const before = new Date('2027-02-28T20:59:59Z');
    const after = new Date('2027-02-28T21:00:00Z');
    assert.equal(dayKey(before), '2027-02-28');
    assert.equal(dayKey(after), '2027-03-01');
    assert.equal(seasonId(before), 'winter-2027');
    assert.equal(seasonId(after), 'spring-2027');
  });

  it('декабрь по-прежнему относится к зиме СЛЕДУЮЩЕГО года', () => {
    assert.equal(seasonId(new Date('2026-12-15T12:00:00Z')), 'winter-2027');
    assert.equal(seasonName('winter-2027'), 'Зима 2026/27');
  });
});

describe('границы сезона как моменты времени', () => {
  it('🔴 зима переходит через Новый год', () => {
    // `winter-2027` — это декабрь 2026 плюс январь и февраль 2027. Ошибка здесь схлопнула бы две
    // разные зимы в одну подпись и в один набор итогов.
    const w = seasonRange('winter-2027');
    assert.equal(w.from.toISOString(), '2026-11-30T21:00:00.000Z', '1 декабря 2026, местная полночь');
    assert.equal(w.to.toISOString(), '2027-02-28T21:00:00.000Z', '1 марта 2027, местная полночь');
  });

  it('границы совпадают с тем, что говорит seasonId', () => {
    // Единственная проверка, которая ловит расхождение двух функций: момент из середины окна обязан
    // называться тем же сезоном, а момент за миллисекунду до начала — уже другим.
    for (const id of ['winter-2027', 'spring-2026', 'summer-2026', 'autumn-2026']) {
      const { from, to } = seasonRange(id);
      assert.equal(seasonId(from), id, `начало ${id}`);
      assert.equal(seasonId(new Date(to.getTime() - 1)), id, `конец ${id}`);
      assert.notEqual(seasonId(new Date(from.getTime() - 1)), id, `за миг до ${id}`);
      assert.notEqual(seasonId(to), id, `ровно в конце ${id} уже другой сезон`);
    }
  });

  it('окна идут встык, без дыр и нахлёстов', () => {
    const order = ['winter-2027', 'spring-2027', 'summer-2027', 'autumn-2027'];
    for (let i = 1; i < order.length; i++) {
      assert.equal(seasonRange(order[i]).from.getTime(), seasonRange(order[i - 1]).to.getTime(), order[i]);
    }
    // И зима следующего года встык к осени этого.
    assert.equal(seasonRange('winter-2028').from.getTime(), seasonRange('autumn-2027').to.getTime());
  });

  it('граница сезона совпадает с границей суток, а не с полуночью UTC', () => {
    const { from } = seasonRange('summer-2026');
    assert.equal(dayKey(from), '2026-06-01', 'первый день сезона — это первое число');
    assert.equal(dayKey(new Date(from.getTime() - 1)), '2026-05-31');
  });
});

describe('помесячная разбивка сезонов (запрос 03.09)', () => {
  it('идентификатор помесячного сезона отличим по формату', () => {
    // ⚠️ Префикс `m` не украшение: по нему `seasonRange` понимает, какой разбивкой сделан сезон, и
    // старые записи после смены ползунка продолжают читаться правильно.
    assert.equal(seasonId(new Date('2026-09-15T12:00:00Z'), 'month'), 'm2026-09');
    assert.equal(seasonId(new Date('2026-09-15T12:00:00Z'), 'quarter'), 'autumn-2026');
    assert.equal(seasonId(new Date('2026-09-15T12:00:00Z')), 'autumn-2026', 'по умолчанию — времена года');
  });

  it('месяц начинается по МЕСТНОЙ полуночи, как и сутки', () => {
    assert.equal(seasonId(new Date('2026-08-31T20:59:59Z'), 'month'), 'm2026-08');
    assert.equal(seasonId(new Date('2026-08-31T21:00:00Z'), 'month'), 'm2026-09');
  });

  it('границы месяца сходятся с идентификатором и идут встык', () => {
    for (const id of ['m2026-01', 'm2026-09', 'm2026-12']) {
      const { from, to } = seasonRange(id);
      assert.equal(seasonId(from, 'month'), id, `начало ${id}`);
      assert.equal(seasonId(new Date(to.getTime() - 1), 'month'), id, `конец ${id}`);
      assert.notEqual(seasonId(new Date(from.getTime() - 1), 'month'), id, `за миг до ${id}`);
    }
    assert.equal(seasonRange('m2026-10').from.getTime(), seasonRange('m2026-09').to.getTime());
  });

  it('🔴 декабрь переходит в январь следующего года', () => {
    // Классическое место ошибки: месяц 12 плюс один — это не тринадцатый месяц.
    const dec = seasonRange('m2026-12');
    assert.equal(seasonId(dec.from, 'month'), 'm2026-12');
    assert.equal(seasonId(dec.to, 'month'), 'm2027-01');
  });

  it('название месяца человеческое', () => {
    assert.equal(seasonName('m2026-09'), 'Сентябрь 2026');
    assert.equal(seasonName('m2026-01'), 'Январь 2026');
    assert.equal(seasonName('winter-2027'), 'Зима 2026/27', 'времена года не сломались');
  });

  it('перекат сезона слушается разбивки', () => {
    // Тот же момент времени: при помесячной разбивке сезон уже другой, при квартальной — тот же.
    const state = { day: '2026-09-01', seasonId: 'm2026-08', secondsToday: 5, earnedToday: 5, seasonEarned: 100 };
    const now = new Date('2026-09-15T12:00:00Z');
    assert.equal(rollPeriods({ ...state }, now, 'month').seasonEarned, 0, 'месяц сменился — счётчик обнулён');
    assert.equal(rollPeriods({ ...state, seasonId: 'autumn-2026' }, now, 'quarter').seasonEarned, 100, 'сезон тот же');
  });
});

describe('смена разбивки сезонов (аудит 03.09)', () => {
  // Границы по МСК: `seasonRange` уже проверен выше, здесь опираемся на него.
  const from = (id: string) => seasonRange(id).from.getTime();
  const to = (id: string) => seasonRange(id).to.getTime();

  it('на естественной границе морозится всё окно сезона', () => {
    const q = freezeWindow('autumn-2026', 'winter-2027');
    assert.ok(q);
    assert.equal(q.from.getTime(), from('autumn-2026'));
    assert.equal(q.to.getTime(), to('autumn-2026'));
    const m = freezeWindow('m2026-09', 'm2026-10');
    assert.ok(m);
    assert.equal(m.from.getTime(), from('m2026-09'));
    assert.equal(m.to.getTime(), to('m2026-09'));
  });

  it('🔴 сезон, начавшийся в том же окне, не подводится: он продолжается под новым именем', () => {
    // Осень → месяцы третьего сентября: осень и сентябрь начались в один день.
    assert.equal(freezeWindow('autumn-2026', 'm2026-09'), null);
    // Месяцы → осень двадцатого сентября: сентябрь поглощён осенью.
    assert.equal(freezeWindow('m2026-09', 'autumn-2026'), null);
    // Месяцы → осень пятого ноября: ноябрь тоже внутри осени.
    assert.equal(freezeWindow('m2026-11', 'autumn-2026'), null);
  });

  it('при переключении посреди сезона старый морозится только ДО начала нового окна', () => {
    // Осень → месяцы 15 октября: осень подводится за сентябрь, октябрь целиком — сезону «Октябрь».
    const w = freezeWindow('autumn-2026', 'm2026-10');
    assert.ok(w);
    assert.equal(w.from.getTime(), from('autumn-2026'));
    assert.equal(w.to.getTime(), from('m2026-10'), 'окно режется по началу нового сезона');
    assert.equal(w.to.getTime(), to('m2026-09'), 'то есть ровно по концу сентября');
  });

  it('корона живёт в сезоне своей выдачи по ТЕКУЩЕЙ сетке и переживает переключение', () => {
    // Осень подведена досрочно 15 октября (переход на месяцы). Корона — на остаток октября.
    const frozen = new Date('2026-10-15T12:00:00Z');
    assert.equal(wearsCrown(frozen, new Date('2026-10-20T12:00:00Z'), 'month'), true, 'октябрь — носится');
    assert.equal(wearsCrown(frozen, new Date('2026-11-02T12:00:00Z'), 'month'), false, 'ноябрь — уже нет');
    // Прежнее правило сравнивало по КОНЦУ осени (1 декабря → «Декабрь») и здесь дало бы `false`
    // 20 октября и `true` в декабре — корона исчезала после переключения и всплывала через полтора
    // месяца. Проверяем именно эту точку.
    assert.equal(wearsCrown(frozen, new Date('2026-12-10T12:00:00Z'), 'month'), false, 'в декабре не всплывает');
  });

  it('корона на естественной границе — весь следующий сезон', () => {
    // Осень закрыта первым тиком 1 декабря по МСК.
    const frozen = new Date('2026-11-30T21:00:05Z');
    assert.equal(wearsCrown(frozen, new Date('2027-01-15T12:00:00Z'), 'quarter'), true, 'январь — ещё зима');
    assert.equal(wearsCrown(frozen, new Date('2027-03-01T12:00:00Z'), 'quarter'), false, 'март — весна');
  });

  it('возврат к временам года не роняет корону последнего закрытого месяца', () => {
    // Октябрь закрыт 1 ноября (месяцы), 25 ноября вернулись к временам года: корона до 1 декабря.
    const frozen = new Date('2026-10-31T21:00:05Z');
    assert.equal(wearsCrown(frozen, new Date('2026-11-25T12:00:00Z'), 'quarter'), true, 'ещё осень');
    assert.equal(wearsCrown(frozen, new Date('2026-12-02T12:00:00Z'), 'quarter'), false, 'зима — срок вышел');
  });
});

describe('seasonBump — метка сезона при движении монет (04.09)', () => {
  it('в своём сезоне счётчик растёт, метка остаётся', () => {
    assert.deepEqual(seasonBump('autumn-2026', 'autumn-2026', 500, 100), {
      seasonId: 'autumn-2026',
      seasonEarned: 600,
    });
  });

  it('ПУСТАЯ метка чинится, а не роняет счётчик в лидерборде', () => {
    // Ровно случай ретро 04.09: `season_earned` наполнен, `season_id` пуст — и таблица лидеров,
    // которая фильтрует по метке, не показывает человека вовсе.
    assert.deepEqual(seasonBump('', 'autumn-2026', 0, 2438), { seasonId: 'autumn-2026', seasonEarned: 2438 });
    assert.deepEqual(seasonBump(null, 'autumn-2026', 0, 100), { seasonId: 'autumn-2026', seasonEarned: 100 });
  });

  it('чужой сезон обнуляет счётчик — но только счётчик', () => {
    assert.deepEqual(seasonBump('summer-2026', 'autumn-2026', 9000, 50), {
      seasonId: 'autumn-2026',
      seasonEarned: 50,
    });
  });

  it('движение без заработка ставит метку и ничего не прибавляет', () => {
    // Тип и выдача модератора в сезон не идут, но пустую метку обязаны обезвредить.
    assert.deepEqual(seasonBump('', 'autumn-2026', 0, 0), { seasonId: 'autumn-2026', seasonEarned: 0 });
    assert.deepEqual(seasonBump('autumn-2026', 'autumn-2026', 700, 0), {
      seasonId: 'autumn-2026',
      seasonEarned: 700,
    });
  });
});

describe('presencePercent — «отошёл» (04.09)', () => {
  it('отошедшему платят четверть, а не полную ставку', () => {
    // Ради этого правило и заведено: мьют не штрафуется, поэтому «выключил микрофон на железе и
    // ушёл» приносило полную ставку до потолка — честному сидению это проигрывало.
    assert.equal(presencePercent(sample({ away: true }), settings()), 25);
    assert.equal(presencePercent(sample({ away: false }), settings()), 100);
  });

  it('«отошёл» СИЛЬНЕЕ мьюта и «не слышу», и множители не перемножаются', () => {
    const s = settings({ mutedPercent: 100, deafenedPercent: 50, awayPercent: 10 });
    assert.equal(presencePercent(sample({ away: true, muted: true }), s), 10);
    assert.equal(presencePercent(sample({ away: true, deafened: true }), s), 10);
    // Без «отошёл» порядок прежний: «не слышу» перекрывает мьют.
    assert.equal(presencePercent(sample({ deafened: true, muted: true }), s), 50);
  });

  it('ползунок владельца работает и здесь: сто процентов = без штрафа', () => {
    assert.equal(presencePercent(sample({ away: true }), settings({ awayPercent: 100 })), 100);
    assert.equal(presencePercent(sample({ away: true }), settings({ awayPercent: 0 })), 0);
  });
});
