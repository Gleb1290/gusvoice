import { counterfact as runCounterfact } from '../test/counterfacts.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as actual from './wheel.js';
import type { WheelPick } from './wheel.js';

type Wheel = typeof actual;
type Mutation = { from: string; to: string };
const source = readFileSync(new URL('./wheel.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));

// Фикстура утверждённого wheel.json: sectors[].value, отсортированные по index; внешних путей в тесте нет.
const ART = {
  values: [5, 1, 20, 1, 3, 1, 3, 1, 10, 1, 3, 1, 5, 1, 3, 1, 5, 1, 10, 1, 3, 1, 5, 1, 3],
  counts: { 1: 12, 3: 6, 5: 4, 10: 2, 20: 1 },
  localCenters: [0, 14.4, 28.8, 43.2, 57.6, 72, 86.4, 100.8, 115.2, 129.6,
    144, 158.4, 172.8, 187.2, 201.6, 216, 230.4, 244.8, 259.2, 273.6, 288, 302.4, 316.8, 331.2, 345.6],
  bakedPhase: 7.2,
} as const;
const PICKS: WheelPick[] = [1, 3, 5, 10, 20];

function load(raw: string): Wheel {
  const module = { exports: {} };
  // Исполняется целый настоящий модуль, а не заново написанная в тесте копия его алгоритма.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports,
    require(name: string) { assert.fail(`R327 подготовка: wheel не должен тянуть зависимость ${name}`); },
  }, { timeout: 2_000 });
  return module.exports as Wheel;
}

function counterfact(check: (wheel: Wheel) => void, mutations: Mutation | Mutation[]): void {
  check(actual);
  check(load(source));
  for (const { from, to } of Array.isArray(mutations) ? mutations : [mutations]) {

    runCounterfact(() => {
      assert.equal(source.split(from).length, 2, `R327 подготовка: единственный якорь ${from}`);
      const changed = source.replace(from, to);
      assert.notEqual(changed, source, 'R327 подготовка: мутант действительно меняет модуль');
      assertKilled(check, changed);
    });
    check(load(source)); // Независимый обратный откат в памяти; приложение на диске не переписывается.
  }
}

function assertKilled(check: (wheel: Wheel) => void, changed: string): void {
  assert.throws(() => check(load(changed)), (error: unknown) =>
    error instanceof assert.AssertionError && error.message.startsWith('R327 проверка:'),
  'контрфакт обязан краснеть на адресной проверке, не на импорте/синтаксисе');
}

function words(...values: number[]): Uint8Array {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => bytes.writeUInt32BE(value, i * 4));
  return bytes;
}

let hashes: Uint8Array[] | undefined;
function corpus(): Uint8Array[] {
  // Фиксированные входы вместо Math.random: тот же корпус на каждом CI-прогоне.
  return hashes ??= Array.from({ length: 50_000 }, (_, i) => createHash('sha256').update(String(i), 'utf8').digest());
}

describe('R327 раскладка совпадает с нарисованным колесом', () => {
  it('все 25 значений стоят на тех же индексах, а не только дают правильные количества', () => {
    // Перестановка двух разных секторов сохраняет шансы, но визуально показывает не тот выигрыш.
    counterfact(w => {
      assert.deepEqual(Array.from(w.WHEEL_SECTORS), [...ART.values], 'R327 проверка: порядок секторов арта');
    }, { from: '5, 1, 20, 1, 3, 1, 3, 1, 10', to: '20, 1, 5, 1, 3, 1, 3, 1, 10' });
  });

  it('количество секторов каждого числа равно 12/6/4/2/1, сумма — 25', () => {
    // Порядок и вес исходов — разные гарантии: лишняя тройка меняет вероятность выплаты.
    counterfact(w => {
      const counts = Object.fromEntries(PICKS.map(pick => [pick, Array.from(w.WHEEL_SECTORS).filter(value => value === pick).length]));
      assert.deepEqual(counts, ART.counts, 'R327 проверка: веса исходов');
      assert.equal(w.WHEEL_SECTORS.length, 25, 'R327 проверка: число секторов');
    }, { from: '5, 1, 20, 1, 3, 1, 3, 1, 10', to: '5, 3, 20, 1, 3, 1, 3, 1, 10' });
  });

  it('выбрать можно ровно пять чисел, без приведения строк и объектов к числу', () => {
    // Иначе JSON со строкой либо объект Number проходит не тот протокол, что проверяет сервер.
    counterfact(w => {
      assert.deepEqual(Array.from(w.WHEEL_PICKS), PICKS, 'R327 проверка: перечень чисел');
      for (const pick of PICKS) assert.equal(w.isWheelPick(pick), true, 'R327 проверка: разрешённое число');
      for (const value of ['1', '3', '20', 0, -1, 2, 4, 6, 9, 11, 19, 21, 1.5, NaN, Infinity, true, false, null, undefined, {}, [], new Number(1)]) {
        assert.equal(w.isWheelPick(value), false, 'R327 проверка: неподдерживаемый выбор');
      }
    }, { from: "typeof v === 'number' && (WHEEL_PICKS as readonly number[]).includes(v)",
      to: '(WHEEL_PICKS as readonly number[]).includes(Number(v))' });
  });
});

const payouts: Array<{ pick: WheelPick; hundredths: number; expected: number[] }> = [
  { pick: 1, hundredths: 190, expected: [1, 5, 13, 24] },
  { pick: 3, hundredths: 380, expected: [3, 11, 26, 49] },
  { pick: 5, hundredths: 575, expected: [5, 17, 40, 74] },
  { pick: 10, hundredths: 1150, expected: [11, 34, 80, 149] },
  { pick: 20, hundredths: 2300, expected: [23, 69, 161, 299] },
];
describe('R327 выплата включает ставку и округляется вниз', () => {
  for (const { pick, hundredths, expected } of payouts) it(`число ${pick}: ставки 1/3/7/13 выплачиваются по своему множителю`, () => {
    // Проверены ВСЕ вхождения числа и промахи, а не один удобный сектор.
    counterfact(w => {
      for (const [j, amount] of [1, 3, 7, 13].entries()) {
        for (let sector = 0; sector < ART.values.length; sector++) {
          assert.equal(w.wheelPayout(pick, amount, sector), ART.values[sector] === pick ? expected[j] : 0,
            'R327 проверка: выплата и промах');
        }
      }
      assert.equal(w.WHEEL_PAYOUT_X100[pick], hundredths, 'R327 проверка: множитель в сотых');
    }, { from: `${pick}: ${hundredths}`, to: `${pick}: ${hundredths + 100}` });
  });

  it('дробь выигрыша отбрасывается, но целая выплата не теряет монету', () => {
    // Нельзя округлять 1.9 вверх или ошибочно срезать уже целую выплату 23.
    counterfact(w => {
      assert.equal(w.wheelPayout(1, 1, 1), 1, 'R327 проверка: выигрыш вниз');
      assert.equal(w.wheelPayout(5, 3, 0), 17, 'R327 проверка: дробный множитель вниз');
      assert.equal(w.wheelPayout(20, 1, 2), 23, 'R327 проверка: целый выигрыш целиком');
    }, { from: 'Math.floor((amount * WHEEL_PAYOUT_X100[pick]) / 100)', to: 'Math.ceil((amount * WHEEL_PAYOUT_X100[pick]) / 100)' });
  });

  it('промах и несуществующий индекс не возвращают даже исходную ставку', () => {
    // Возврат ставки на каждом проигрыше создаёт бесконечные деньги при положительных выигрышах.
    counterfact(w => {
      assert.equal(w.wheelPayout(20, 13, 2), 299, 'R327 проверка: правильный сектор выигрывает');
      for (const index of [0, 1, 24, -1, 25]) assert.equal(w.wheelPayout(20, 13, index), 0, 'R327 проверка: промах не возврат');
    }, { from: 'WHEEL_SECTORS[sectorIndex] === pick ?', to: 'true ?' });
  });

  it('точный ожидаемый возврат по раскладке равен 91.2/91.2/92/92/92 процента', () => {
    // Ставка 100 устраняет потери округления: малую ставку нельзя выдавать за тот же точный RTP.
    counterfact(w => {
      const totals = PICKS.map(pick => ART.values.reduce((sum, _value, index) => sum + w.wheelPayout(pick, 100, index), 0));
      assert.deepEqual(totals, [2280, 2280, 2300, 2300, 2300], 'R327 проверка: сумма выплат по 25 исходам');
      assert.deepEqual(totals.map(sum => sum / 25), [91.2, 91.2, 92, 92, 92], 'R327 проверка: точный RTP');
    }, { from: '1: 190', to: '1: 200' });
  });
});

describe('R327 выбор сектора из байтов SHA256', () => {
  const LIMIT = 4_294_967_275; // 2^32 −21: последние21 значения uint32 нельзя делить простым остатком.

  it('limit−1 принимается, limit и limit+1 отбрасываются в пользу следующего окна', () => {
    // Статистика почти никогда не достигает этой границы и не ловит наивный %25.
    counterfact(w => {
      assert.equal(w.sectorFromHash(words(LIMIT-1, 42)), 24, 'R327 проверка: последнее разрешённое значение');
      for (const first of [LIMIT, LIMIT+1]) assert.equal(w.sectorFromHash(words(first, 42)), 17, 'R327 проверка: отбрасывание границы');
    }, [
      { from: 'if (v < limit) return v % 25;', to: 'return v % 25;' },
      { from: 'if (v < limit)', to: 'if (v <= limit)' },
    ]);
  });

  it('после отброшенного слова читается следующее полное четырёхбайтовое окно', () => {
    // Пропуск четырёх байт либо сдвиг на один байт меняет воспроизводимый результат раунда.
    counterfact(w => {
      assert.equal(w.sectorFromHash(words(LIMIT, 51, 0, 0, 0, 0, 0, 0)), 1, 'R327 проверка: второе окно');
      assert.equal(w.sectorFromHash(words(LIMIT, LIMIT+1, 73, 0, 0, 0, 0, 0)), 23, 'R327 проверка: третье окно');
    }, [
      { from: 'i += 4', to: 'i += 8' },
      { from: 'i += 4', to: 'i += 1' },
    ]);
  });

  it('если все восемь окон отброшены, используется остаток последнего слова', () => {
    // У редкого fallback тоже должен быть одинаковый результат у сервера и клиента.
    counterfact(w => {
      assert.equal(w.sectorFromHash(words(LIMIT, LIMIT+1, LIMIT+2, LIMIT+3, LIMIT+4, LIMIT+5, LIMIT+6, 0xffffffff)), 20,
        'R327 проверка: последнее окно после восьми отказов');
    }, [
      { from: '  }\n  return v % 25;\n}', to: '  }\n  return 0;\n}' },
      { from: 'i + 4 <= hash.length', to: 'i + 4 < hash.length' },
    ]);
  });

  it('первое слово читается big-endian, а не little-endian', () => {
    // Специальный вектор различает порядок байт; 01:02:03:04 случайно не различает его по модулю25.
    counterfact(w => {
      assert.equal(w.sectorFromHash(words(1)), 1, 'R327 проверка: big-endian единица');
      assert.equal(w.sectorFromHash(words(0)), 0, 'R327 проверка: нулевое слово');
    }, { from: '((hash[i] << 24) | (hash[i + 1] << 16) | (hash[i + 2] << 8) | hash[i + 3]) >>> 0',
      to: '(hash[i] | (hash[i + 1] << 8) | (hash[i + 2] << 16) | (hash[i + 3] << 24)) >>> 0' });
  });

  it('старший бит не превращает uint32 в отрицательный номер сектора', () => {
    // Битовые операции JavaScript знаковые, без >>>0 половина хешей даёт отрицательный остаток.
    counterfact(w => {
      assert.equal(w.sectorFromHash(words(0x80000000)), 23, 'R327 проверка: беззнаковое слово');
      assert.equal(w.sectorFromHash(words(0x7fffffff)), 22, 'R327 проверка: соседняя знаковая граница');
    }, { from: '| hash[i + 3]) >>> 0', to: '| hash[i + 3]) >> 0' });
  });

  it('50000 детерминированных SHA256 не дают перекоса между 25 секторами', () => {
    // Это широкий smoke-тест распределения, а не доказательство корректности редкой rejection-ветки.
    counterfact(w => {
      const counts = Array<number>(25).fill(0);
      for (const hash of corpus()) {
        const sector = w.sectorFromHash(hash);
        assert.ok(Number.isInteger(sector) && sector >= 0 && sector < 25, 'R327 проверка: сектор в диапазоне');
        counts[sector]++;
      }
      const expected = 50_000 / 25;
      const chiSquare = counts.reduce((sum, seen) => sum + (seen-expected)**2/expected, 0);
      assert.ok(chiSquare < 80, `R327 проверка: хи-квадрат ${chiSquare} <80 при24 степенях свободы`);
    }, { from: 'if (v < limit) return v % 25;', to: 'if (v < limit) return v % 24;' });
  });
});

describe('R327 сундук джекпота', () => {
  it('джекпот определяется первым big-endian словом: 0/500/1000 да, соседи нет', () => {
    // Секторное окно и период джекпота нельзя перепутать; последующие слова не влияют.
    counterfact(w => {
      assert.equal(w.WHEEL_JACKPOT_ODDS, 500, 'R327 проверка: период джекпота');
      for (const value of [0, 500, 1000]) assert.equal(w.jackpotFromHash(words(value, 1)), true, 'R327 проверка: кратное500');
      for (const value of [1, 100, 199, 200, 400, 499, 501, 999, 1001]) {
        assert.equal(w.jackpotFromHash(words(value, 0)), false, 'R327 проверка: не кратное500');
      }
    }, [
      { from: 'uint32At(hash, 0) % WHEEL_JACKPOT_ODDS === 0', to: 'uint32At(hash, 4) % WHEEL_JACKPOT_ODDS === 0' },
      { from: '((hash[i] << 24) | (hash[i + 1] << 16) | (hash[i + 2] << 8) | hash[i + 3]) >>> 0',
        to: '(hash[i] | (hash[i + 1] << 8) | (hash[i + 2] << 16) | (hash[i + 3] << 24)) >>> 0' },
    ]);
  });

  it('частота джекпота на фиксированном корпусе близка к одному на500', () => {
    // Допуск около6σ не ослаблен: для 50000/500 ожидается100, σ≈10. Старый период200 тоже ловится.
    counterfact(w => {
      const hits = corpus().reduce((sum, hash) => sum + Number(w.jackpotFromHash(hash)), 0);
      assert.ok(hits >= 40 && hits <= 160, `R327 проверка: ${hits} попаданий из50000 близки к100`);
    }, [
      { from: 'WHEEL_JACKPOT_ODDS = 500', to: 'WHEEL_JACKPOT_ODDS = 200' },
      { from: 'WHEEL_JACKPOT_ODDS = 500', to: 'WHEEL_JACKPOT_ODDS = 100' },
    ]);
  });

  it('взнос1/7/100 равен1/10/150 сотым, по соседям дробь всегда вниз', () => {
    // Взнос в сотых, не целых монетах: потеря делителя или ceil тихо раздувает сундук.
    counterfact(w => {
      assert.equal(w.WHEEL_JACKPOT_SHARE_BP, 150, 'R327 проверка: доля сундука');
      for (const [amount, cents] of [[0, 0], [1, 1], [7, 10], [99, 148], [100, 150], [101, 151]]) {
        assert.equal(w.jackpotCentsOf(amount), cents, 'R327 проверка: взнос в сотых вниз');
      }
    }, { from: 'Math.floor((amount * WHEEL_JACKPOT_SHARE_BP) / 100)', to: 'Math.ceil((amount * WHEEL_JACKPOT_SHARE_BP) / 100)' });
  });

  it('доли сундука пропорциональны сумме ставок, а не числу людей', () => {
    // Все участники имеют право на долю, но равный раздел игнорирует размер их вклада.
    counterfact(w => {
      assert.deepEqual(normal(w.splitJackpot(1200, [{ userId: 'a', total: 1 }, { userId: 'b', total: 3 }])),
        { shares: [{ userId: 'a', coins: 3 }, { userId: 'b', coins: 9 }], leftCents: 0 }, 'R327 проверка: пропорция1:3');
    }, { from: '(poolCents * x.total) / sum / 100', to: 'poolCents / stakes.length / 100' });
  });

  it('каждая дробная доля округляется вниз, остаток остаётся в сотых', () => {
    // Остаток101 сотая допустим: у двух людей может потеряться по почти целой монете.
    counterfact(w => {
      assert.deepEqual(normal(w.splitJackpot(1001, [{ userId: 'a', total: 1 }, { userId: 'b', total: 2 }])),
        { shares: [{ userId: 'a', coins: 3 }, { userId: 'b', coins: 6 }], leftCents: 101 }, 'R327 проверка: дробные доли вниз');
    }, { from: 'Math.floor((poolCents * x.total) / sum / 100)', to: 'Math.ceil((poolCents * x.total) / sum / 100)' });
  });

  it('сумма целых выплат в сотых плюс остаток точно равна исходному пулу', () => {
    // Нельзя прибавлять целые coins к cents либо раздать больше сундука из-за округления.
    counterfact(w => {
      for (const pool of [1, 99, 100, 101, 1050, 12001]) {
        const result = w.splitJackpot(pool, [{ userId: 'a', total: 1 }, { userId: 'b', total: 2 }, { userId: 'c', total: 3 }]);
        const paid = result.shares.reduce((sum, x) => sum + x.coins * 100, 0);
        assert.equal(paid + result.leftCents, pool, 'R327 проверка: монеты не создаются и не пропадают');
        assert.ok(result.leftCents >= 0 && Number.isInteger(result.leftCents), 'R327 проверка: целый неотрицательный остаток');
        for (const share of result.shares) assert.ok(Number.isInteger(share.coins) && share.coins > 0, 'R327 проверка: целые положительные доли');
      }
    }, { from: 's + x.coins * 100', to: 's + x.coins' });
  });

  it('пустой список и нулевые ставки не получают выплат и сохраняют весь пул', () => {
    // При отсутствии положительного вклада сундук не должен исчезать или делиться на ноль.
    counterfact(w => {
      for (const stakes of [[], [{ userId: 'zero', total: 0 }], [{ userId: 'a', total: 0 }, { userId: 'b', total: 0 }]]) {
        assert.deepEqual(normal(w.splitJackpot(1201, stakes)), { shares: [], leftCents: 1201 }, 'R327 проверка: нет ставок, весь пул остаётся');
      }
    }, { from: 'return { shares: [], leftCents: Math.max(0, poolCents) };', to: 'return { shares: [], leftCents: 0 };' });
  });

  it('нулевой или отрицательный пул никому не платит и не оставляет долг сундука', () => {
    // Пустой сундук нельзя превратить в минимальную положительную выплату или отрицательный остаток.
    counterfact(w => {
      for (const pool of [0, -1]) assert.deepEqual(normal(w.splitJackpot(pool, [{ userId: 'a', total: 1 }])),
        { shares: [], leftCents: 0 }, 'R327 проверка: пустой сундук без долга');
    }, { from: 'Math.max(0, poolCents)', to: 'Math.max(100, poolCents)' });
  });

  it('нулевые и отрицательные ставки не уменьшают долю положительного участника', () => {
    // Защитная нормализация не позволяет неверной строке создать чужому участнику сверхвыплату.
    counterfact(w => {
      assert.deepEqual(normal(w.splitJackpot(1000, [{ userId: 'a', total: 1 }, { userId: 'zero', total: 0 }, { userId: 'bad', total: -1 }])),
        { shares: [{ userId: 'a', coins: 10 }], leftCents: 0 }, 'R327 проверка: учитывается только положительный вес');
    }, { from: 's + Math.max(0, x.total)', to: 's + x.total' });
  });

  it('пул меньше монеты целиком сохраняется, нулевые выплаты не объявляются выигрышами', () => {
    // Строка выплаты0 выглядит выигрышем в UI и не должна попадать в список получателей.
    counterfact(w => {
      assert.deepEqual(normal(w.splitJackpot(99, [{ userId: 'a', total: 1 }, { userId: 'b', total: 1 }])),
        { shares: [], leftCents: 99 }, 'R327 проверка: субмонетные доли не выплачиваются');
      assert.deepEqual(normal(w.splitJackpot(100, [{ userId: 'a', total: 1 }])),
        { shares: [{ userId: 'a', coins: 1 }], leftCents: 0 }, 'R327 проверка: ровно монета выплачивается');
    }, { from: 'shares.filter((x) => x.coins > 0)', to: 'shares.filter((x) => x.coins >= 0)' });
  });
});

describe('R327 геометрия и строки проверяемой честности', () => {
  it('каждый из25 секторов останавливается именно центром под неподвижным указателем0°', () => {
    // Без запечённой фазы7.2° указатель окажется на границе; перепутанный знак выберет другой сектор.
    counterfact(w => {
      for (let i = 0; i < ART.localCenters.length; i++) {
        const rotation = w.wheelRestAngle(i);
        assert.ok(Number.isFinite(rotation) && rotation >= 0 && rotation < 360, 'R327 проверка: угол в [0,360)');
        const landed = ((ART.localCenters[i] + ART.bakedPhase + rotation) % 360 + 360) % 360;
        assert.ok(Math.min(landed, 360-landed) < 1e-9, 'R327 проверка: центр под указателем');
      }
    }, [
      { from: 'sectorIndex * SECTOR_DEG + SECTOR_DEG / 2', to: 'sectorIndex * SECTOR_DEG' },
      { from: 'return (((360 - (sectorIndex * SECTOR_DEG + SECTOR_DEG / 2)) % 360) + 360) % 360;',
        to: 'return -(sectorIndex * SECTOR_DEG + SECTOR_DEG / 2);' },
    ]);
  });

  it('commit, сектор и джекпот хешируют разные точные строки с roundId и seed', () => {
    // Без domain separation раскрытый секторный хеш может совпасть с обещанием либо джекпотом.
    counterfact(w => {
      const round = 'round-test';
      const seed = '0123456789abcdef'.repeat(4); // Синтетический открытый пример, не зерно настоящего раунда.
      const values = [w.wheelCommitInput(round, seed), w.wheelSectorInput(round, seed), w.wheelJackpotInput(round, seed)];
      assert.deepEqual(values, [`gv-wheel-commit:${round}:${seed}`, `gv-wheel-sector:${round}:${seed}`, `gv-wheel-jackpot:${round}:${seed}`],
        'R327 проверка: точные строки трёх доменов');
      assert.equal(new Set(values).size, 3, 'R327 проверка: домены различаются');
      for (const input of [w.wheelCommitInput, w.wheelSectorInput, w.wheelJackpotInput]) {
        assert.notEqual(input('round-other', seed), input(round, seed), 'R327 проверка: roundId входит в хеш');
        assert.notEqual(input(round, 'abcdef0123456789'.repeat(4)), input(round, seed), 'R327 проверка: seed входит в хеш');
      }
    }, [
      { from: '`gv-wheel-commit:${roundId}:${seedHex}`', to: '`gv-wheel-sector:${roundId}:${seedHex}`' },
      { from: '`gv-wheel-sector:${roundId}:${seedHex}`', to: '`gv-wheel-sector:${seedHex}`' },
      { from: '`gv-wheel-jackpot:${roundId}:${seedHex}`', to: '`gv-wheel-jackpot:${roundId}`' },
    ]);
  });
});
