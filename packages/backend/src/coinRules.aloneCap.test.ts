import { counterfact } from '../../shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './coinRules.js';
import type { AccrualSample, AccrualState, EconomySettings, ReplaySample } from './coinRules.js';

type Rules = Pick<typeof rules, 'accrue' | 'rollPeriods' | 'replay'>;
const settings = (patch: Partial<EconomySettings> = {}): EconomySettings => ({
  ratePer5min: 10, alonePercent: 25, companyPercent: 150, dailyCap: 0, aloneCap: 90,
  decayAfterMinutes: 150, decayPercent: 50, mutedPercent: 100, deafenedPercent: 25,
  awayPercent: 25, payoutMinutes: 10, compensateOnRaise: false, ...patch,
});
const state = (patch: Partial<AccrualState> = {}): AccrualState => ({
  pendingMilli: 0, pendingSeconds: 0, baseMilli: 0, deltaPresenceMilli: 0,
  deltaCompanyMilli: 0, deltaDecayMilli: 0, secondsToday: 0, earnedToday: 0,
  aloneEarnedMilli: 0, ...patch,
});
const sample = (patch: Partial<AccrualSample> = {}): AccrualSample => ({
  seconds: 60, peers: 0, muted: false, deafened: false, away: false, ...patch,
});

// Все срезы синтетические и минутные, как у сборщика, а не один многочасовой срез:
// пороги проверяются ДО среза, поэтому укрупнение меняло бы проверяемое поведение.
function minutes(alone: number, company: number): ReplaySample[] {
  const start = Date.parse('2026-10-27T21:00:00Z');
  return Array.from({ length: alone + company }, (_, i) => ({
    ...sample({ peers: i < alone ? 0 : 2 }), userId: 'synthetic-user', at: new Date(start + i * 60_000),
  }));
}

function midnightHistory(): ReplaySample[] {
  const start = Date.parse('2026-10-28T17:59:00Z');
  // 180 минут выбирают ровно 90 монет, 20:59 UTC уже бесплатно; 21:00 UTC — новые сутки МСК.
  return Array.from({ length: 191 }, (_, i) => ({
    ...sample(), userId: 'synthetic-user', at: new Date(start + i * 60_000),
  }));
}

function mixed(api: Rules): AccrualState {
  const s = settings({ aloneCap: 1, payoutMinutes: 60, mutedPercent: 50 });
  let next = state({ secondsToday: 9_000 });
  // 500 тысячных обычного ожидания + 4 × 125 в away выбирают допустимый целый порог 1.
  // После него деафен и новый срез одному бесплатны, но обе компании продолжают копить ценность.
  for (const input of [
    sample(), ...Array.from({ length: 4 }, () => sample({ away: true })), sample({ deafened: true }),
    sample({ peers: 2 }), sample({ peers: 1, muted: true }), sample(),
  ]) {
    const result = api.accrue(input, next, s);
    assert.equal(result.coins, 0, 'R317 смесь ещё не достигла шага выплаты');
    next = result.next;
  }
  return next;
}

describe('R317: ожидание одному не тратит затухание компании', () => {
  it('один и отрицательный peers не двигают время затухания даже далеко за его порогом', () => {
    for (const peers of [0, -1]) {
      const r = rules.accrue(sample({ peers }), state({ secondsToday: 18_000 }), settings());
      assert.equal(r.next.secondsToday, 18_000);
      assert.equal(r.next.deltaDecayMilli, 0);
      assert.equal(r.next.pendingMilli, 500);
      assert.equal(r.next.aloneEarnedMilli, 500);
      assert.equal(r.next.pendingSeconds, 60);
    }
  });

  it('собеседник по-прежнему двигает затухание и получает уменьшенную ставку', () => {
    const r = rules.accrue(sample({ peers: 1 }), state({ secondsToday: 18_000 }), settings());
    assert.equal(r.next.secondsToday, 18_060);
    assert.equal(r.next.pendingMilli, 500);
    assert.equal(r.next.deltaDecayMilli, -1_500);
    assert.equal(r.next.aloneEarnedMilli, 0);
  });

  it('один с «не слышу», включая «отошёл» и мьют, не меняет уже накопленные деньги и секунды', () => {
    const before = state({ pendingMilli: 500, pendingSeconds: 60, baseMilli: 2_000,
      deltaCompanyMilli: -1_500, aloneEarnedMilli: 500, secondsToday: 18_000 });
    for (const away of [false, true]) {
      const r = rules.accrue(sample({ seconds: 600, muted: true, deafened: true, away }), before, settings());
      assert.equal(r.coins, 0);
      assert.equal(r.breakdown, undefined);
      assert.deepEqual(r.next, before);
    }
  });

  it('«не слышу» в компании и «отошёл» без деафена одному остаются оплачиваемыми', () => {
    assert.equal(rules.accrue(sample({ seconds: 600, peers: 1, deafened: true }), state(), settings()).coins, 5);
    const r = rules.accrue(sample({ away: true }), state(), settings());
    assert.equal(r.next.pendingMilli, 125);
    assert.equal(r.next.aloneEarnedMilli, 125);
    assert.equal(r.next.pendingSeconds, 60);
  });
});

describe('R317: порог одному считается по ценности в тысячных ДО среза', () => {
  it('за тысячную до 90 срез целиком оплачивается и допустимый перебор меньше одного среза сохраняется', () => {
    const r = rules.accrue(sample(), state({ aloneEarnedMilli: 89_999 }), settings());
    assert.equal(r.next.pendingMilli, 500);
    assert.equal(r.next.aloneEarnedMilli, 90_499);
    assert.equal(r.next.pendingSeconds, 60);
    assert.equal(r.next.secondsToday, 0);
  });

  it('ровно 90 и выше 90 не копят одному ни деньги, ни время, даже с замороженным остатком', () => {
    for (const aloneEarnedMilli of [90_000, 90_001]) {
      const before = state({ aloneEarnedMilli, pendingMilli: 500, pendingSeconds: 60,
        baseMilli: 2_000, deltaCompanyMilli: -1_500, secondsToday: 18_000 });
      const r = rules.accrue(sample({ seconds: 600 }), before, settings());
      assert.equal(r.coins, 0);
      assert.equal(r.breakdown, undefined);
      assert.deepEqual(r.next, before);
    }
  });

  it('до выплаты счётчик уже содержит дробную ценность, а не только выплаченные целые монеты', () => {
    let next = state();
    for (let i = 0; i < 2; i++) {
      const r = rules.accrue(sample({ seconds: 1 }), next, settings());
      assert.equal(r.coins, 0);
      next = r.next;
    }
    // 1 секунда: round(10000/300) = 33 тысячных, floor(33 × 25%) = 8.
    assert.equal(next.aloneEarnedMilli, 16);
    assert.equal(next.pendingMilli, 16);
    assert.equal(next.pendingSeconds, 2);
  });

  it('нулевой порог безлимитен, но не меняет одиночный множитель', () => {
    const r = rules.accrue(sample({ seconds: 600 }), state({ aloneEarnedMilli: 900_000 }), settings({ aloneCap: 0 }));
    assert.equal(r.coins, 5);
    assert.equal(r.next.aloneEarnedMilli, 905_000);
    assert.equal(r.next.secondsToday, 0);
  });

  it('после выбранного порога компания платит полностью и не увеличивает одиночный счётчик', () => {
    for (const [peers, coins] of [[1, 20], [2, 30]]) {
      const r = rules.accrue(sample({ seconds: 600, peers }), state({ aloneEarnedMilli: 90_000 }), settings());
      assert.equal(r.coins, coins);
      assert.equal(r.next.secondsToday, 600);
      assert.equal(r.next.aloneEarnedMilli, 90_000);
    }
  });

  it('суточный потолок по-прежнему последним режет одиночную выплату и выбрасывает остаток', () => {
    const r = rules.accrue(sample({ seconds: 600 }), state({ earnedToday: 4 }), settings({ dailyCap: 5 }));
    assert.equal(r.coins, 1);
    assert.equal(r.next.earnedToday, 5);
    assert.equal(r.next.aloneEarnedMilli, 5_000);
    assert.equal(r.next.pendingMilli, 0);
    assert.equal(r.breakdown?.cappedByDaily, true);
  });
});

describe('R317: московская полночь и пересчёт', () => {
  it('до полуночи счётчик сохраняется, ровно в полночь сбрасывается без потери недосиженного', () => {
    const before = { ...state({ aloneEarnedMilli: 90_000, secondsToday: 5_000, earnedToday: 9,
      pendingMilli: 500, pendingSeconds: 60, baseMilli: 2_000, deltaCompanyMilli: -1_500 }),
      day: '2026-10-28', seasonId: 'autumn-2026', seasonEarned: 100 };
    assert.deepEqual(rules.rollPeriods(before, new Date('2026-10-28T20:59:59.999Z')), before);
    assert.deepEqual(rules.rollPeriods(before, new Date('2026-10-28T21:00:00Z')), {
      ...before, day: '2026-10-29', secondsToday: 0, earnedToday: 0, aloneEarnedMilli: 0,
    });
    assert.equal(before.aloneEarnedMilli, 90_000, 'исходный кошелёк не мутируется');
  });

  it('replay снова оплачивает одного после полуночи МСК, а не ждёт полуночи UTC', () => {
    const [r] = rules.replay(midnightHistory(), settings());
    assert.equal(r.coins, 95);
    assert.equal(r.seconds, 191 * 60);
  });

  it('шесть часов одному и затем три часа втроём дают 540, а не затухшую компанию после ожидания', () => {
    // В R317 написано «150 минут», но числа 540/450 соответствуют реальному default 120
    // (schema.ts). Нельзя молча менять старую формулу компании ради ошибочного числа в задании.
    const [r] = rules.replay(minutes(360, 180), settings({ decayAfterMinutes: 120 }));
    assert.equal(r.coins, 540);
    assert.equal(r.seconds, 540 * 60);
  });

  it('три часа втроём без предварительного ожидания дают 450', () => {
    assert.equal(rules.replay(minutes(0, 180), settings({ decayAfterMinutes: 120 }))[0].coins, 450);
  });

  it('при явно выбранных 150 минутах компания даёт 495, ожидание добавляет 90 и не штрафует её', () => {
    // 150 минут × 3 монеты + 30 минут × 1.5 = 495. Это отличает порог 150 от default 120.
    assert.equal(rules.replay(minutes(0, 180), settings())[0].coins, 495);
    assert.equal(rules.replay(minutes(360, 180), settings())[0].coins, 585);
  });

  it('двенадцать часов одному ограничиваются 90, а не затуханием и не безлимитным фармом', () => {
    assert.equal(rules.replay(minutes(720, 0), settings())[0].coins, 90);
  });

  it('смесь ожидания, штрафа, деафена, порога и компании сохраняет базу плюс дельты равными накопленному', () => {
    const r = mixed(rules);
    assert.equal(r.baseMilli + r.deltaPresenceMilli + r.deltaCompanyMilli + r.deltaDecayMilli, r.pendingMilli);
    assert.equal(r.pendingMilli, 3_000);
    assert.equal(r.baseMilli, 14_000);
    assert.equal(r.deltaPresenceMilli, -7_000);
    assert.equal(r.deltaCompanyMilli, -2_000);
    assert.equal(r.deltaDecayMilli, -2_000);
    assert.equal(r.aloneEarnedMilli, 1_000);
    assert.equal(r.pendingSeconds, 420);
    assert.equal(r.secondsToday, 9_120);
  });
});

// Исполняем настоящий модуль целиком, не вырезанную копию формулы. Ошибка загрузки, синтаксиса
// или случайное падение проверки не считается убийством мутанта: нужны свой marker и точные числа.
const source = readFileSync(new URL('./coinRules.ts', import.meta.url), 'utf8');
function load(input: string): Rules {
  const exports: Record<string, unknown> = {};
  const js = ts.transpileModule(input, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  }, fileName: 'coinRules.ts' }).outputText;
  runInNewContext(js, { exports }, { filename: 'coinRules.r317.vm.js', timeout: 2_000 });
  return exports as Rules;
}
function killed(anchor: string, replacement: string, check: (api: Rules) => void,
  marker: string, actual: number, expected: number): void {
  check(load(source));
  counterfact(() => {
    assert.equal(source.split(anchor).length - 1, 1, `уникальный якорь R317: ${anchor}`);
    assert.throws(() => check(load(source.replace(anchor, replacement))), (err: unknown) =>
      err instanceof assert.AssertionError && err.message.includes(marker)
      && err.actual === actual && err.expected === expected);
  });
}

describe('R317: original-first контрфакты настоящей арифметики', () => {
  it('возврат одиночных секунд в затухание обнаруживается по времени, не по загрузке', () => {
    killed('secondsToday: state.secondsToday + (alone ? 0 : seconds),',
      'secondsToday: state.secondsToday + seconds,', (api) => {
        assert.equal(api.accrue(sample(), state({ secondsToday: 18_000 }), settings()).next.secondsToday,
          18_000, 'R317 одиночное время');
      }, 'R317 одиночное время', 18_060, 18_000);
  });

  it('возврат затухания одному обнаруживается по его ненулевой дельте', () => {
    killed('const withDecay = alone ? withCompany : Math.floor((withCompany * decayPercent(state.secondsToday, s)) / 100);',
      'const withDecay = Math.floor((withCompany * decayPercent(state.secondsToday, s)) / 100);', (api) => {
        assert.equal(api.accrue(sample(), state({ secondsToday: 18_000 }), settings()).next.deltaDecayMilli,
          0, 'R317 дельта одному');
      }, 'R317 дельта одному', -375, 0);
  });

  it('пропуск запрета один+деафен обнаруживается по размороженным секундам с «отошёл»', () => {
    killed('if (alone && sample.deafened) return { coins: 0, next };',
      'if (false) return { coins: 0, next };', (api) => {
        assert.equal(api.accrue(sample({ deafened: true, away: true }), state(), settings()).next.pendingSeconds,
          0, 'R317 деафен не приближает выплату');
      }, 'R317 деафен не приближает выплату', 60, 0);
  });

  it('строгое > вместо >= ошибочно оплачивает срез ровно на 90', () => {
    killed('state.aloneEarnedMilli >= s.aloneCap * MILLI', 'state.aloneEarnedMilli > s.aloneCap * MILLI', (api) => {
      assert.equal(api.accrue(sample(), state({ aloneEarnedMilli: 90_000 }), settings()).next.pendingMilli,
        0, 'R317 точная граница');
    }, 'R317 точная граница', 500, 0);
  });

  it('сравнение тысячных с монетами ошибочно режет срез за тысячную до 90', () => {
    killed('state.aloneEarnedMilli >= s.aloneCap * MILLI', 'state.aloneEarnedMilli >= s.aloneCap', (api) => {
      assert.equal(api.accrue(sample(), state({ aloneEarnedMilli: 89_999 }), settings()).next.pendingMilli,
        500, 'R317 единицы порога');
    }, 'R317 единицы порога', 0, 500);
  });

  it('накопление монет вместо тысячных обнаруживается до любой выплаты', () => {
    killed('state.aloneEarnedMilli + withCompany;', 'state.aloneEarnedMilli + withCompany / MILLI;', (api) => {
      assert.equal(api.accrue(sample(), state(), settings()).next.aloneEarnedMilli,
        500, 'R317 единицы накопления');
    }, 'R317 единицы накопления', 0.5, 500);
  });

  it('потеря проверки положительного порога превращает безлимитный ноль в запрет', () => {
    killed('alone && s.aloneCap > 0 && state.aloneEarnedMilli >= s.aloneCap * MILLI',
      'alone && state.aloneEarnedMilli >= s.aloneCap * MILLI', (api) => {
        assert.equal(api.accrue(sample(), state(), settings({ aloneCap: 0 })).next.pendingMilli,
          500, 'R317 ноль безлимитен');
      }, 'R317 ноль безлимитен', 0, 500);
  });

  it('применение одиночного порога к компании обнаруживается по потерянной полной выплате', () => {
    killed('alone && s.aloneCap > 0 && state.aloneEarnedMilli >= s.aloneCap * MILLI',
      's.aloneCap > 0 && state.aloneEarnedMilli >= s.aloneCap * MILLI', (api) => {
        assert.equal(api.accrue(sample({ seconds: 600, peers: 2 }), state({ aloneEarnedMilli: 90_000 }), settings()).coins,
          30, 'R317 компания после порога');
      }, 'R317 компания после порога', 0, 30);
  });

  it('пропуск сброса в rollPeriods оставляет вчерашние 90 на новых сутках', () => {
    killed('next.aloneEarnedMilli = 0;', 'next.aloneEarnedMilli = state.aloneEarnedMilli;', (api) => {
      const wallet = { ...state({ aloneEarnedMilli: 90_000 }), day: '2026-10-28',
        seasonId: 'autumn-2026', seasonEarned: 12 };
      assert.equal(api.rollPeriods(wallet, new Date('2026-10-28T21:00:00Z')).aloneEarnedMilli,
        0, 'R317 сброс кошелька');
    }, 'R317 сброс кошелька', 90_000, 0);
  });

  it('пропуск сброса в replay обнаруживается по недоплате после московской полуночи', () => {
    killed('acc.aloneEarnedMilli = 0;', 'acc.aloneEarnedMilli = acc.aloneEarnedMilli;', (api) => {
      assert.equal(api.replay(midnightHistory(), settings())[0].coins, 95, 'R317 сброс пересчёта');
    }, 'R317 сброс пересчёта', 90, 95);
  });

  it('потеря переноса одиночного счётчика replay открывает фарм на 12 часов', () => {
    killed('acc.aloneEarnedMilli = next.aloneEarnedMilli;', 'acc.aloneEarnedMilli = 0;', (api) => {
      assert.equal(api.replay(minutes(720, 0), settings())[0].coins, 90, 'R317 replay хранит порог');
    }, 'R317 replay хранит порог', 360, 90);
  });

  it('потеря дельты компании разрушает объяснение смешанного накопления', () => {
    killed('state.deltaCompanyMilli + (withCompany - withPresence);', 'state.deltaCompanyMilli;', (api) => {
      const r = mixed(api);
      assert.equal(r.baseMilli + r.deltaPresenceMilli + r.deltaCompanyMilli + r.deltaDecayMilli,
        r.pendingMilli, 'R317 сумма пояснения');
    }, 'R317 сумма пояснения', 5_000, 3_000);
  });
});
