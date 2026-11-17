import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as actual from './duel.js';

type Rules = typeof actual;
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));

// Весь прежний кластер строковых подмен удалён; все проверки реального модуля сохранены.
function checkRules(check: (rules: Rules) => void): void { check(actual); }

function words(...values: number[]): Uint8Array {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => bytes.writeUInt32BE(value, i * 4));
  return bytes;
}
const limit = 4_294_967_292;
const draw: [number, number, number, number] = [1, 6, 3, 4];
const challenger: [number, number, number, number] = [6, 5, 1, 2];
const target: [number, number, number, number] = [1, 2, 6, 5];

describe('R332 честные кости из готовых байтов', () => {
  it('последнее допустимое окно limit−1 ещё даёт шестёрку, без сдвига к следующему окну', () => {
    // Ошибка на единицу смещает распределение: это парный положительный случай к отбрасыванию limit.
    checkRules(r => assert.deepEqual(normal(r.diceFromHash(words(limit - 1, 0, 1, 2, 3))), [6, 1, 2, 3],
      'R332 проверка: limit−1 принимается'));
  });

  it('окно ровно limit отбрасывается и не занимает место первой кости', () => {
    checkRules(r => assert.deepEqual(normal(r.diceFromHash(words(limit, 0, 1, 2, 3))), [1, 2, 3, 4],
      'R332 проверка: limit уже отклоняется'));
  });

  it('окно limit+1 тоже отбрасывается, последующие четыре кости не теряются', () => {
    checkRules(r => assert.deepEqual(normal(r.diceFromHash(words(limit + 1, 2, 3, 4, 5))), [3, 4, 5, 6],
      'R332 проверка: limit+1 отклоняется'));
  });

  it('после отбракованного окна чтение идёт по четырём байтам, а не с перекрытием', () => {
    checkRules(r => assert.deepEqual(normal(r.diceFromHash(words(0xffffffff, 1, 2, 3, 4))), [2, 3, 4, 5],
      'R332 проверка: следующий полный блок после отбрасывания'));
  });

  it('четырёхбайтовое окно имеет порядок big-endian, не little-endian', () => {
    checkRules(r => assert.deepEqual(normal(r.diceFromHash(words(0x01020304, 0, 1, 2))), [5, 1, 2, 3],
      'R332 проверка: big-endian различает порядок байтов'));
  });

  it('старший бит не превращает окно в отрицательное число и кость ниже единицы', () => {
    checkRules(r => assert.deepEqual(normal(r.diceFromHash(words(0x80000001, 0, 1, 2))), [4, 1, 2, 3],
      'R332 проверка: окно беззнаковое'));
  });

  it('все шесть граней доступны всем четырём костям и пятое окно уже не влияет', () => {
    checkRules(r => {
      for (let face = 1; face <= 6; face++) {
        assert.deepEqual(normal(r.diceFromHash(words(face - 1, face - 1, face - 1, face - 1))), Array(4).fill(face),
          'R332 проверка: каждая грань у каждой кости');
      }
      assert.deepEqual(normal(r.diceFromHash(words(0, 1, 2, 3, 5))), [1, 2, 3, 4],
        'R332 проверка: ровно четыре независимых кости');
    });
  });

  it('при исчерпании хеша недостающие кости берутся из последнего окна, включая отвергнутое', () => {
    // Редчайший путь тоже определён контрактом: повторяем последний остаток, не генерируем новые байты.
    checkRules(r => {
      assert.deepEqual(normal(r.diceFromHash(words(0, limit + 1))), [1, 2, 2, 2],
        'R332 проверка: fallback последнего отвергнутого окна');
      assert.deepEqual(normal(r.diceFromHash(words(5))), [6, 6, 6, 6], 'R332 проверка: fallback принятого окна');
      assert.deepEqual(normal(r.diceFromHash(words(0xffffffff, 0xfffffffe))), [3, 3, 3, 3],
        'R332 проверка: все окна отвергнуты');
    });
  });

  it('пустой хеш и неполные хвосты не читаются как новые четырёхбайтовые окна', () => {
    checkRules(r => {
      assert.deepEqual(normal(r.diceFromHash(new Uint8Array())), [1, 1, 1, 1], 'R332 проверка: пустой fallback');
      assert.deepEqual(normal(r.diceFromHash(new Uint8Array([1, 2, 3]))), [1, 1, 1, 1],
        'R332 проверка: неполное окно не прочитано');
      assert.deepEqual(normal(r.diceFromHash(new Uint8Array([...words(5), 1, 2, 3]))), [6, 6, 6, 6],
        'R332 проверка: хвост не заменяет последнее полное окно');
    });
  });
});

describe('совместимость кубиков без цели: решает первая победа', () => {
  it('равные суммы — ничья даже при разных гранях, неравные — не ничья в обе стороны', () => {
    checkRules(r => {
      assert.equal(r.duelRollIsDraw(draw), true, 'R332 проверка: разные грани с равными суммами');
      assert.equal(r.duelRollIsDraw(challenger), false, 'R332 проверка: преимущество вызвавшего');
      assert.equal(r.duelRollIsDraw(target), false, 'R332 проверка: преимущество цели');
    });
  });

  it('первая победа вызвавшего завершает партию, поздняя победа цели не переигрывает её', () => {
    checkRules(r => assert.equal(r.duelOutcome([draw, challenger, target]).winner, 'challenger',
      'R332 проверка: первая не-ничья вызвавшего'));
  });

  it('первая победа цели после ничьей не отдаёт банк вызвавшему', () => {
    checkRules(r => assert.equal(r.duelOutcome([draw, target, challenger]).winner, 'target',
      'R332 проверка: первая не-ничья цели'));
  });

  it('пустой список и только ничьи не придумывают победителя', () => {
    checkRules(r => {
      assert.equal(r.duelOutcome([]).winner, null, 'R332 проверка: пустой исход');
      assert.equal(r.duelOutcome([draw, draw]).winner, null, 'R332 проверка: все броски вничью');
    });
  });

  it('шестой бросок ещё решает исход, седьмой после шести ничьих уже игнорируется', () => {
    checkRules(r => {
      assert.equal(r.duelOutcome([...Array(5).fill(draw), target]).winner, 'target',
        'R332 проверка: пятый переброс включён');
      assert.equal(r.duelOutcome([...Array(6).fill(draw), challenger]).winner, null,
        'R332 проверка: шестой переброс запрещён');
      assert.equal(r.DUEL_MAX_REROLLS, 5, 'R332 проверка: пять перебросов');
    });
  });
});

describe('R332 открытый протокол обещания и броска', () => {
  it('обещание и бросок имеют разные точные домены и сохраняют roundId и зерно', () => {
    checkRules(r => {
      for (const id of ['round', 'раунд-🪿']) for (const seed of ['0'.repeat(64), 'ab'.repeat(32)]) {
        assert.equal(r.duelCommitInput(id, seed), `gv-duel-commit:${id}:${seed}`, 'R332 проверка: домен обещания');
        assert.equal(r.duelRollInput(id, seed, 0), `gv-duel-roll:${id}:${seed}:0`, 'R332 проверка: отдельный домен броска');
        assert.notEqual(r.duelCommitInput(id, seed), r.duelRollInput(id, seed, 0), 'R332 проверка: домены не совпадают');
      }
    });
  });

  it('каждый номер броска с нуля по пятый меняет проверяемую строку', () => {
    checkRules(r => {
      for (let n = 0; n <= 5; n++) assert.equal(r.duelRollInput('id', 'ab'.repeat(32), n),
        `gv-duel-roll:id:${'ab'.repeat(32)}:${n}`, 'R332 проверка: точный номер броска');
    });
  });

  it('новый выбор содержит 21, начатый гусь совместим, неизвестная игра отклоняется', () => {
    for (const r of [actual]) {
      for (const game of ['dice', 'rps', 'greedy', 'twentyone']) {
        assert.equal(r.isDuelGame(game), true, 'R332 проверка: игра из закрытого перечня принята');
      }
      for (const value of ['wheel', 'Dice', '', null, undefined, 0, ['dice'], { game: 'dice' }]) {
        assert.equal(r.isDuelGame(value), false, 'R332 проверка: чужая игра отклонена');
      }
      assert.deepEqual(normal(r.DUEL_GAMES), ['dice', 'rps', 'twentyone'], 'новый выбор без старого гуся');
    }
  });

  it('приглашение, нажатие, анимация и реванш имеют согласованные независимые сроки', () => {
    checkRules(r => assert.deepEqual([r.DUEL_INVITE_MS, r.DUEL_ROLL_TURN_MS, r.DUEL_ROLL_ANIM_MS, r.DUEL_REMATCH_PAUSE_MS],
      [30_000, 15_000, 1_500, 10_000], 'R332 проверка: согласованные сроки протокола'));
  });
});
