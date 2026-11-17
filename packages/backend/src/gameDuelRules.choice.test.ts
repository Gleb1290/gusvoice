
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { describe, it } from 'node:test';
import * as actual from './gameDuelRules.js';
import type { DuelGreedyData, DuelRoundData, DuelSide } from './gameDuelRules.js';

type Rules = typeof actual;
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function checkActual(check: (rules: Rules) => void): void {
  check(actual);
}

const now = new Date('2026-10-28T12:00:00.000Z');
const roundId = 'choice-round';
const seed = '0123456789abcdef'.repeat(4); // Синтетические публичные данные, не зерно реальной партии.

it('21 не раздаёт кости до хода, раскрывает закреплённую пару и добирает по хешу номер 4', () => {
  const data = actual.duelStartData(roundId, base({ game: 'twentyone' }), now);
  const g = data.twentyOne!;
  assert.deepEqual(g.totals, { challenger: 0, target: 0 });
  assert.deepEqual(g.rolls, []);
  assert.equal(actual.twentyOneAct(roundId, data, 'stop', now), null);
  const a = actual.twentyOneAct(roundId, data, 'roll', now)!.data;
  const b = actual.twentyOneAct(roundId, a, 'roll', now)!.data;
  const initial = actual.duelRolls(roundId, seed)[0];
  for (const side of sides) assert.deepEqual(b.twentyOne!.rolls.filter(r => r.by === side).map(r => r.die),
    side === 'challenger' ? initial.slice(0, 2) : initial.slice(2));
  const c = actual.twentyOneAct(roundId, b, 'roll', now)!;
  assert.equal(c.record.kind, 'roll');
  assert.equal(c.data.twentyOne!.rolls.at(-1)!.die, expectedDie(roundId, seed, 4));
  assert.equal(c.data.twentyOne!.rolls.length, 5);
  assert.equal(c.data.twentyOne!.seq, 3);
});

it('таймаут до старта бросает пару, следующие просрочки останавливают по очереди; legacy сразу разрешает стоп', () => {
  let data = actual.duelStartData(roundId, base({ game: 'twentyone' }), now);
  const first = data.twentyOne!.turn;
  data = actual.twentyOneTimeout(roundId, data, now).data;
  assert.equal(data.twentyOne!.standing[first], false);
  assert.equal(data.twentyOne!.rolls.length, 2);
  assert.equal(data.twentyOne!.timeouts[first], 1);
  data = actual.twentyOneTimeout(roundId, data, now).data;
  assert.equal(data.twentyOne!.rolls.length, 4);
  data = actual.twentyOneTimeout(roundId, data, now).data;
  assert.equal(data.twentyOne!.finished, false);
  data = actual.twentyOneTimeout(roundId, data, now).data;
  assert.equal(data.twentyOne!.finished, true);
  const legacy = { ...data, phase: 'moving' as const, twentyOne: {
    ...data.twentyOne!, started: undefined, standing: { challenger: false, target: false }, finished: false,
  } };
  assert.ok(actual.twentyOneAct(roundId, legacy, 'stop', now));
});
const sides: DuelSide[] = ['challenger', 'target'];
const other = (side: DuelSide): DuelSide => side === 'challenger' ? 'target' : 'challenger';
const base = (extra: Partial<DuelRoundData> = {}): DuelRoundData => ({
  channelId: 'voice', challengerId: 'a', targetId: 'b', game: 'rps', amount: 100, feePercent: 10,
  commit: 'public-commit', seed, ...extra,
});
const rps = (extra: Partial<DuelRoundData> = {}): DuelRoundData => base({ phase: 'moving', moveFrom: now.toISOString(),
  rps: { rounds: [], ready: { challenger: false, target: false }, wins: { challenger: 0, target: 0 } }, ...extra });
const greedy = (side: DuelSide = 'challenger', extra: Partial<DuelGreedyData> = {}): DuelRoundData => base({
  game: 'greedy', phase: 'moving', moveFrom: now.toISOString(),
  greedy: { scores: { challenger: 3, target: 5 }, turn: side, turnPoints: 3, n: 4,
    lastRoll: { by: other(side), die: 3 }, burned: 7, winner: null,
    timeouts: { challenger: 2, target: 1 }, seq: 9, first: 'target', rolls: [2, 3, 4, 1], ...extra },
});
const afterMs = (ms: number) => new Date(now.getTime() + ms).toISOString();
const hash = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest();

function expectedDie(id: string, value: string, n: number): number {
  // Независимое чтение первого допустимого big-endian окна; не вызываем production greedyDie/diceFromHash.
  const bytes = hash(`gv-duel-roll:${id}:${value}:${n}`);
  for (let i = 0; i < bytes.length; i += 4) {
    const word = bytes.readUInt32BE(i);
    if (word < 4_294_967_292) return word % 6 + 1;
  }
  return bytes.readUInt32BE(bytes.length - 4) % 6 + 1;
}

function seeded(data: DuelRoundData, die: number): DuelRoundData {
  // Подбираем только публичную фикстуру независимым SHA256; генератор приложения не подменяем.
  for (let i = 0; i < 1_000; i++) {
    const value = i.toString(16).padStart(64, '0');
    if (expectedDie(roundId, value, data.greedy!.n) === die) return { ...data, seed: value };
  }
  assert.fail('R333 подготовка: не найдено синтетическое зерно для нужной грани');
}

describe('R333 принятие выборной игры и проверяемые броски', () => {
  it('КНБ начинается с пустой истории, нулевого счёта и закрытых рук, без кубиков', () => {
    checkActual(r => {
      const data = base(), saved = normal(data);
      const start = r.duelStartData(roundId, data, now);
      assert.deepEqual(normal(start), { ...saved, phase: 'moving', moveFrom: now.toISOString(),
        rps: { rounds: [], ready: { challenger: false, target: false }, wins: { challenger: 0, target: 0 } } },
      'R333 проверка: выборная игра начинает скрытый первый раунд');
      assert.deepEqual(data, saved, 'R333 проверка: принятие не меняет исходную запись');
    });
  });

  it('первый ход гуся вычисляется из id и зерна, а не выдаётся вызывающему по умолчанию', () => {
    checkActual(r => {
      const seen = new Set<string>();
      for (let i = 0; i < 64; i++) {
        const id = `first-${i}`, first = hash(`gv-duel-first:${id}:${seed}`)[0] % 2 ? 'challenger' : 'target';
        seen.add(first);
        const start = r.duelStartData(id, base({ game: 'greedy' }), now);
        assert.equal(start.phase, 'moving', 'R333 проверка: гусь начинает ход, не анимацию кубиков');
        assert.equal(start.moveFrom, now.toISOString(), 'R333 проверка: начало первого хода записано');
        assert.deepEqual(normal(start.greedy), { scores: { challenger: 0, target: 0 }, turn: first,
          turnPoints: 0, n: 0, lastRoll: null, burned: 0, winner: null, timeouts: { challenger: 0, target: 0 },
          seq: 0, first, rolls: [] }, 'R333 проверка: честный первый игрок и пустые копилки');
      }
      assert.equal(seen.size, 2, 'R333 проверка: реальные хеши фикстуры дают обе стороны');
    });
  });

  it('на выборный ход даётся 20 секунд, на кубики и старые записи без game — 15', () => {
    checkActual(r => {
      for (const game of ['rps', 'greedy'] as const) assert.equal(r.duelTurnMs(game), 20_000, 'R333 проверка: срок выбора');
      for (const game of ['dice', undefined] as const) assert.equal(r.duelTurnMs(game), 15_000, 'R333 проверка: срок старых кубиков');
    });
  });

  it('каждый сквозной бросок гуся — первая кость своего SHA256, id, зерно и n участвуют', () => {
    checkActual(r => {
      for (const id of [roundId, 'other-round']) for (const value of [seed, 'ab'.repeat(32)]) for (let n = 0; n < 24; n++) {
        assert.equal(r.greedyDie(id, value, n), expectedDie(id, value, n), 'R333 проверка: независимые байты броска n');
      }
    });
  });
});

describe('R333 КНБ: готовность, раскрытие, пороги и просрочки', () => {
  for (const side of sides) it(`${side} готов: история ещё не раскрывается и в данные не добавляется рука`, () => {
    checkActual(r => {
      const before = rps(), saved = normal(before);
      const marked = r.rpsMarkReady(before, side);
      assert.deepEqual(normal(marked), { ...saved, rps: { ...saved.rps!, ready: { challenger: false, target: false, [side]: true } } },
        'R333 проверка: только флаг готовности нужной стороны');
      assert.deepEqual(normal(r.rpsMarkReady(marked, side)), normal(marked), 'R333 проверка: повторная готовность идемпотентна');
      assert.deepEqual(before, saved, 'R333 проверка: исходные флаги не изменены');
    });
  });

  it('обе разные руки раскрываются одной записью, готовность сбрасывается и начинается новый срок', () => {
    checkActual(r => {
      const before = rps({ rps: { rounds: [], ready: { challenger: true, target: true }, wins: { challenger: 0, target: 0 } } });
      const saved = normal(before);
      const resolved = r.rpsResolve(before, { challenger: 'paper', target: 'rock' }, now);
      assert.deepEqual(normal(resolved.data.rps), { rounds: [{ challenger: 'paper', target: 'rock', winner: 'challenger' }],
        ready: { challenger: false, target: false }, wins: { challenger: 1, target: 0 } }, 'R333 проверка: обе руки разом и ровно одно очко');
      assert.equal(resolved.data.phase, 'moving', 'R333 проверка: одного очка недостаточно');
      assert.equal(resolved.settleAt.toISOString(), afterMs(20_000), 'R333 проверка: новый полный срок');
      assert.equal(resolved.data.moveFrom, now.toISOString(), 'R333 проверка: начало нового срока');
      assert.deepEqual(before, saved, 'R333 проверка: раскрытие не переписывает предыдущий снимок');
    });
  });

  for (const side of sides) for (const previous of [0, 1]) it(`${side} получает ${previous + 1}-ю победу: ${previous ? 'партия решена' : 'игра продолжается'}`, () => {
    const hands = side === 'challenger' ? { challenger: 'rock', target: 'scissors' } as const
      : { challenger: 'scissors', target: 'rock' } as const;
    checkActual(r => {
      const rounds = previous ? [{ ...hands, winner: side }] : [];
      const before = rps({ rps: { rounds, ready: { challenger: true, target: true },
        wins: { challenger: 0, target: 0, [side]: previous } } });
      const resolved = r.rpsResolve(before, hands, now);
      assert.equal(resolved.data.rps!.wins[side], previous + 1, 'R333 проверка: очко получает победитель');
      assert.equal(resolved.data.rps!.wins[other(side)], 0, 'R333 проверка: сопернику очко не начислено');
      assert.equal(resolved.data.phase, previous ? 'done' : 'moving', 'R333 проверка: партия ровно до двух побед');
      assert.equal(resolved.data.outcome ?? null, previous ? side : null, 'R333 проверка: исход только после второй победы');
      assert.equal(resolved.settleAt.toISOString(), afterMs(previous ? 1_500 : 20_000), 'R333 проверка: анимация итога либо новый ход');
    });
  });

  for (const total of [6, 7]) it(`${total} ничейных раундов: ${total === 7 ? 'возврат по пределу' : 'последний раунд ещё разрешён'}`, () => {
    checkActual(r => {
      const rounds = Array.from({ length: total - 1 }, () => ({ challenger: 'paper', target: 'paper', winner: null } as const));
      const resolved = r.rpsResolve(rps({ rps: { rounds, ready: { challenger: true, target: true },
        wins: { challenger: 0, target: 0 } } }), { challenger: 'paper', target: 'paper' }, now);
      assert.equal(resolved.data.rps!.rounds.length, total, 'R333 проверка: ничьи тоже расходуют лимит раундов');
      assert.deepEqual(normal(resolved.data.rps!.wins), { challenger: 0, target: 0 }, 'R333 проверка: ничья не приносит очков');
      assert.equal(resolved.data.phase, total === 7 ? 'done' : 'moving', 'R333 проверка: граница 6/7');
      assert.equal(resolved.data.reason ?? null, total === 7 ? 'draw-limit' : null, 'R333 проверка: причина возврата');
      assert.equal(resolved.data.outcome ?? null, null, 'R333 проверка: у ничейного предела нет победителя');
      assert.equal(resolved.settleAt.toISOString(), afterMs(total === 7 ? 1_500 : 20_000), 'R333 проверка: срок последнего перехода');
    });
  });

  for (const side of sides) it(`вторая победа ${side} на седьмом раунде важнее ничейного предохранителя`, () => {
    checkActual(r => {
      const hands = side === 'challenger' ? { challenger: 'rock', target: 'scissors' } as const : { challenger: 'scissors', target: 'rock' } as const;
      // Счёт 1:0 обязан следовать из истории: одна победа и пять ничьих, не шесть ничьих.
      const rounds = [{ ...hands, winner: side }, ...Array.from({ length: 5 },
        () => ({ challenger: 'paper', target: 'paper', winner: null } as const))];
      const before = rps({ rps: { rounds, ready: { challenger: true, target: true }, wins: { challenger: 0, target: 0, [side]: 1 } } });
      const resolved = r.rpsResolve(before, hands, now);
      assert.equal(resolved.data.outcome, side, 'R333 проверка: решённая партия не превращается в возврат');
      assert.equal(resolved.data.reason, undefined, 'R333 проверка: победа не получает draw-limit');
    });
  });

  for (const ready of [
    { challenger: true, target: false }, { challenger: false, target: true },
    { challenger: false, target: false }, { challenger: true, target: true },
  ]) it(`просрочка при готовности ${Number(ready.challenger)}:${Number(ready.target)}: ${ready.challenger !== ready.target ? 'молчавший проиграл' : 'возврат'}`, () => {
    const winner = ready.challenger !== ready.target ? (ready.challenger ? 'challenger' : 'target') : null;
    checkActual(r => {
      const before = rps({ rps: { rounds: [], ready, wins: { challenger: 0, target: 0 } } });
      const timed = r.rpsTimeout(before, now);
      assert.equal(timed.data.phase, 'done', 'R333 проверка: просрочка завершает всю партию');
      assert.equal(timed.data.outcome, winner, 'R333 проверка: ровно одна готовность выигрывает, обе/ни одной — возврат');
      assert.equal(timed.data.reason, 'timeout', 'R333 проверка: причина просрочки');
      assert.equal(timed.settleAt.toISOString(), now.toISOString(), 'R333 проверка: просрочка не ждёт анимации');
      assert.deepEqual(normal(timed.data.rps), normal(before.rps), 'R333 проверка: при просрочке руки не дорисовываются');
      assert.equal(timed.data.auto, undefined, 'R333 проверка: просрочка КНБ не считается автоматическим ходом');
    });
  });

  for (const winner of ['challenger', 'target', null] as const) it(`расчёт выборной партии берёт outcome ${winner ?? 'возврат'}, не фиктивные кубики`, () => {
    checkActual(r => {
      for (const game of ['rps', 'greedy'] as const) {
        const plan = r.duelSettlePlan(base({ game, outcome: winner,
          rolls: winner === 'challenger' ? [[1, 1, 6, 6]] : [[6, 6, 1, 1]] }));
        assert.deepEqual(normal(plan), { winnerId: winner ? (winner === 'challenger' ? 'a' : 'b') : null,
          loserId: winner ? (winner === 'challenger' ? 'b' : 'a') : null, payout: winner ? 180 : null,
          pool: 200, fee: winner ? 20 : 0 }, 'R333 проверка: исход выборной игры и замороженная комиссия');
      }
    });
  });
});

describe('R333 Жадный гусь: записи ходов, автоматические действия и предохранитель', () => {
  for (const side of sides) {
    it(`единица ${side} пишет сгоревшую копилку, сквозной n и передаёт ход без потери сохранённых очков`, () => {
      checkActual(r => {
        const before = seeded(greedy(side, { turnPoints: 8 }), 1), saved = normal(before);
        const result = r.greedyAct(roundId, before, 'roll', now);
        assert.ok(result, 'R333 проверка: ручной бросок разрешён');
        assert.deepEqual(normal(result.record), { kind: 'roll', n: 4, die: 1, burned: 8 }, 'R333 проверка: запись ровно сгоревшего хода');
        assert.deepEqual(normal(result.data.greedy), { ...saved.greedy!, turn: other(side), turnPoints: 0, n: 5,
          lastRoll: { by: side, die: 1 }, burned: 8, seq: 10, rolls: [2, 3, 4, 1, 1],
          timeouts: { ...saved.greedy!.timeouts, [side]: 0 } }, 'R333 проверка: сквозные номера и передача хода');
        assert.equal(result.data.phase, 'moving', 'R333 проверка: сгорание не решает партию');
        assert.equal(result.settleAt.toISOString(), afterMs(20_000), 'R333 проверка: новому игроку полный срок');
        assert.deepEqual(before, saved, 'R333 проверка: старое состояние сгорания неизменно');
      });
    });

    it(`ручной бросок ${side} обнуляет его серию просрочек, сохраняет чужую и добавляет одну кость`, () => {
      checkActual(r => {
        const before = seeded(greedy(side), 2), saved = normal(before);
        const result = r.greedyAct(roundId, before, 'roll', now);
        assert.ok(result, 'R333 проверка: ручной бросок принят');
        assert.deepEqual(normal(result.record), { kind: 'roll', n: 4, die: 2 }, 'R333 проверка: у ручного броска нет auto/ложного сгорания');
        assert.deepEqual(normal(result.data.greedy), { ...saved.greedy!, turnPoints: 5, n: 5, lastRoll: { by: side, die: 2 },
          burned: 0, seq: 10, rolls: [2, 3, 4, 1, 2], timeouts: { ...saved.greedy!.timeouts, [side]: 0 } },
        'R333 проверка: серия просрочек сброшена только у нажавшего');
        assert.equal(result.data.auto, undefined, 'R333 проверка: ручной ход не пополняет статистику автоходов');
        assert.deepEqual(before, saved, 'R333 проверка: старые массивы и счётчики не изменены');
      });
    });

    it(`ручной «Стоп» ${side} с одним очком сохраняет копилку, но не бросает и не двигает n`, () => {
      checkActual(r => {
        const before = greedy(side, { turnPoints: 1 }), saved = normal(before);
        const result = r.greedyAct(roundId, before, 'stop', now);
        assert.ok(result, 'R333 проверка: положительная копилка останавливается');
        assert.deepEqual(normal(result.record), { kind: 'stop', bank: 1 }, 'R333 проверка: запись банка, без auto');
        assert.deepEqual(normal(result.data.greedy), { ...saved.greedy!, scores: { ...saved.greedy!.scores, [side]: saved.greedy!.scores[side] + 1 },
          turn: other(side), turnPoints: 0, burned: 0, seq: 10, timeouts: { ...saved.greedy!.timeouts, [side]: 0 } },
        'R333 проверка: стоп меняет seq, но не n, rolls и lastRoll');
        assert.deepEqual(before, saved, 'R333 проверка: стоп сохраняет входной снимок');
      });
    });

    it(`ровно 20 очков ${side} на 400-м действии — победа, а не возврат по предохранителю`, () => {
      checkActual(r => {
        const before = seeded(greedy(side, { scores: { challenger: 0, target: 0, [side]: 11 }, turnPoints: 3, seq: 399 }), 6);
        const result = r.greedyAct(roundId, before, 'roll', now);
        assert.ok(result, 'R333 проверка: победный бросок принят');
        assert.equal(result.data.greedy!.scores[side], 20, 'R333 проверка: победа автоматически сохраняет всю копилку');
        assert.equal(result.data.greedy!.turnPoints, 0, 'R333 проверка: копилка уже в счёте');
        assert.equal(result.data.phase, 'done', 'R333 проверка: автопобеда завершает партию');
        assert.equal(result.data.outcome, side, 'R333 проверка: победа раньше проверки лимита действий');
        assert.equal(result.data.reason, undefined, 'R333 проверка: победа не получает draw-limit');
        assert.equal(result.settleAt.toISOString(), afterMs(1_500), 'R333 проверка: победа даёт доиграть анимацию');
      });
    });

    it(`вторая просрочка ${side} с одним очком — автостоп, очки и статистика записаны один раз`, () => {
      checkActual(r => {
        const before = { ...greedy(side, { turnPoints: 1, timeouts: { challenger: 0, target: 0, [side]: 1 } }),
          auto: { challenger: 3, target: 4 } };
        const saved = normal(before), timed = r.greedyTimeout(roundId, before, now);
        assert.equal(timed.side, side, 'R333 проверка: записывается прежний владелец хода');
        assert.deepEqual(normal(timed.record), { kind: 'stop', bank: 1, auto: true }, 'R333 проверка: автостоп при минимальной положительной копилке');
        assert.equal(timed.data.greedy!.turn, other(side), 'R333 проверка: автостоп передаёт ход');
        assert.equal(timed.data.greedy!.scores[side], before.greedy!.scores[side] + 1, 'R333 проверка: автостоп сохраняет очко');
        assert.equal(timed.data.greedy!.timeouts[side], 2, 'R333 проверка: вторая просрочка ещё не поражение');
        assert.deepEqual(normal(timed.data.auto), { ...before.auto, [side]: before.auto[side] + 1 }, 'R333 проверка: автоход учитывается только за действовавшего');
        assert.equal(timed.data.phase, 'moving', 'R333 проверка: после второй просрочки игра продолжается');
        assert.equal(timed.settleAt.toISOString(), afterMs(20_000), 'R333 проверка: после автостопа новый срок');
        assert.deepEqual(before, saved, 'R333 проверка: автоматический стоп не меняет прежний снимок');
      });
    });

    it(`первая просрочка ${side} с нулём — автобросок, не запрещённый «Стоп»`, () => {
      checkActual(r => {
        const before = seeded(greedy(side, { turnPoints: 0, timeouts: { challenger: 0, target: 0 } }), 2);
        const timed = r.greedyTimeout(roundId, before, now);
        assert.equal(timed.side, side, 'R333 проверка: автобросок за молчащего');
        assert.deepEqual(normal(timed.record), { kind: 'roll', n: 4, die: 2, auto: true }, 'R333 проверка: пустая копилка запускает бросок');
        assert.equal(timed.data.greedy!.turnPoints, 2, 'R333 проверка: автобросок действительно добавляет выпавшие очки');
        assert.equal(timed.data.greedy!.turn, side, 'R333 проверка: без единицы ход остаётся у игрока');
        assert.equal(timed.data.greedy!.timeouts[side], 1, 'R333 проверка: первая просрочка учтена');
        assert.deepEqual(normal(timed.data.auto), { challenger: 0, target: 0, [side]: 1 }, 'R333 проверка: статистика автоходов создана');
        assert.equal(timed.data.phase, 'moving', 'R333 проверка: первая просрочка не проигрыш');
      });
    });

    it(`третья подряд просрочка ${side} проигрывает партию до любого автохода`, () => {
      checkActual(r => {
        const before = greedy(side, { turnPoints: 1, timeouts: { challenger: 0, target: 0, [side]: 2 } });
        const saved = normal(before), timed = r.greedyTimeout(roundId, before, now);
        assert.equal(timed.side, side, 'R333 проверка: проигравшая сторона известна');
        assert.equal(timed.record, null, 'R333 проверка: на третьей просрочке нет фиктивной записи хода');
        assert.equal(timed.data.phase, 'done', 'R333 проверка: три просрочки завершают партию');
        assert.equal(timed.data.outcome, other(side), 'R333 проверка: выигрывает немолчавший');
        assert.equal(timed.data.reason, 'timeout', 'R333 проверка: причина проигрыша');
        assert.equal(timed.settleAt.toISOString(), now.toISOString(), 'R333 проверка: без анимации несуществующего хода');
        assert.deepEqual(normal(timed.data.greedy), { ...saved.greedy!, timeouts: { ...saved.greedy!.timeouts, [side]: 3 } },
          'R333 проверка: меняется только серия просрочек, не seq/n/банк');
        assert.equal(timed.data.auto, undefined, 'R333 проверка: поражение не считается автоходом');
        assert.deepEqual(before, saved, 'R333 проверка: исходная запись не изменена');
      });
    });
  }

  for (const seq of [398, 399, 400]) it(`действие ${seq + 1}: ${seq < 399 ? 'ещё можно играть' : 'возврат по пределу 400'}`, () => {
    checkActual(r => {
      assert.equal(r.GREEDY_MAX_MOVES, 400, 'R333 проверка: опубликованный предохранитель 400');
      const result = r.greedyAct(roundId, greedy('challenger', { seq, turnPoints: 1 }), 'stop', now);
      assert.ok(result, 'R333 проверка: действие до проверки предохранителя записано');
      assert.equal(result.data.greedy!.seq, seq + 1, 'R333 проверка: действия считаются, включая стоп');
      assert.equal(result.data.phase, seq < 399 ? 'moving' : 'done', 'R333 проверка: обе стороны порога 400');
      assert.equal(result.data.reason ?? null, seq < 399 ? null : 'draw-limit', 'R333 проверка: страховка завершает возвратом');
      assert.equal(result.data.outcome ?? null, null, 'R333 проверка: страховка не назначает победителя');
    });
  });

  it('после решения гусь не принимает новое действие, даже если состояние копилки ещё есть', () => {
    checkActual(r => assert.equal(r.greedyAct(roundId, { ...greedy(), phase: 'done' }, 'stop', now), null,
      'R333 проверка: действие после итога запрещено'));
  });
});

describe('R333 наружный DTO содержит только разрешённое раскрытие', () => {
  for (const [dbState, phase] of [
    ['open', 'moving'], ['locked', 'moving'], ['locked', 'done'], ['cancelled', 'done'], ['settled', 'done'],
  ] as const) it(`КНБ ${dbState}/${phase}: текущая рука никогда не общая, зерно только после settled`, () => {
    const settled = dbState === 'settled', moving = dbState === 'locked' && phase === 'moving';
    checkActual(r => {
      const data = { ...rps(), phase, auto: { challenger: 3, target: 2 }, think: { challenger: [12], target: [34] },
        myHand: 'scissors', privateFuture: 'hidden-value', winnerId: 'a', payout: 180,
        rps: { rounds: [{ challenger: 'paper', target: 'rock', winner: 'challenger' }],
          ready: { challenger: true, target: false }, wins: { challenger: 1, target: 0 },
          current: { challenger: 'scissors', target: null }, privateFuture: 'hidden-value' } };
      const dto = r.duelDto({ id: roundId, serverId: 'server', state: dbState, lockAt: new Date(afterMs(30_000)),
        settleAt: new Date(afterMs(20_000)), settledAt: now, data });
      assert.ok(dto, 'R333 проверка: корректная строка преобразована');
      assert.equal(dto.seed, settled ? seed : null, 'R333 проверка: зерно доступно ровно после расчёта');
      assert.deepEqual(normal(dto.rps), { rounds: [{ challenger: 'paper', target: 'rock', winner: 'challenger' }],
        ready: { challenger: true, target: false }, wins: { challenger: 1, target: 0 }, seq: 1 },
      'R333 проверка: только раскрытая история и готовность, без текущей руки');
      assert.equal(JSON.stringify(dto).includes('scissors'), false, 'R333 проверка: текущая рука не просочилась в JSON');
      for (const field of ['myHand', 'privateFuture', 'auto', 'think']) assert.equal(Object.hasOwn(dto, field), false,
        'R333 проверка: приватные поля данных не становятся общим DTO');
      assert.equal(dto.moveUntil, moving ? afterMs(20_000) : null, 'R333 проверка: срок только живого хода');
      assert.equal(dto.turnUntil, null, 'R333 проверка: выборный ход не выдаётся за бросок кубиков');
      assert.equal(dto.winnerId, settled ? 'a' : null, 'R333 проверка: финансовый итог только после расчёта');
    });
  });

  it('открытые поля гуся копируются явно, внутренние n/winner и будущие поля не протекают и нет общих массивов', () => {
    checkActual(r => {
      const data = greedy('target'), saved = normal(data);
      const dto = r.duelDto({ id: roundId, serverId: 'server', state: 'locked', lockAt: null,
        settleAt: new Date(afterMs(20_000)), settledAt: null, data: { ...data,
          greedy: { ...data.greedy, privateFuture: 'hidden-value', lastRoll: { by: 'challenger', die: 3, hidden: 'no' } } } });
      assert.ok(dto?.greedy, 'R333 проверка: DTO гуся присутствует');
      assert.deepEqual(normal(dto.greedy), { scores: { challenger: 3, target: 5 }, turn: 'target', turnPoints: 3,
        lastRoll: { by: 'challenger', die: 3 }, burned: 7, timeouts: { challenger: 2, target: 1 }, seq: 9,
        first: 'target', rolls: [2, 3, 4, 1] }, 'R333 проверка: точные публичные поля гуся');
      dto.greedy.rolls.push(6);
      dto.greedy.scores.target = 99;
      dto.greedy.timeouts.target = 99;
      assert.deepEqual(data, saved, 'R333 проверка: DTO не даёт менять rolls/счёт/просрочки входной записи');
    });
  });
});

describe('R333 чистый поток пары и размер нового выигрыша', () => {
  for (const [amount, percent, net] of [[100, 0, 100], [100, 10, 80], [7, 10, 6], [100, 100, -100], [0, 10, 0]]) {
    it(`ставка ${amount}, комиссия ${percent}%: чистый выигрыш ${net}, своя ставка не считается переводом`, () => {
      checkActual(r => assert.equal(r.duelWinNet(amount, percent), net, 'R333 проверка: выплата минус собственная ставка'));
    });
  }

  for (const flow of [40, -40]) for (const net of [60, 61]) it(`поток ${flow}, новый net ${net}: ${net === 60 ? 'ровно предел принимается' : 'предел+1 отклоняется'}`, () => {
    checkActual(r => assert.equal(r.pairBlocked(flow, net, 100), net > 60,
      'R333 проверка: обе стороны чистого потока, равенство ещё проходит'));
  });

  it('предел 0 отключает проверку даже для большого потока в любую сторону', () => {
    checkActual(r => {
      for (const flow of [-1_000_000, 1_000_000]) assert.equal(r.pairBlocked(flow, 80, 0), false,
        'R333 проверка: ноль — без предела, не нулевая квота');
    });
  });

  it('встречные выигрыши гасят поток: 80−40 позволяет net60, а непогашенные 80 уже не позволяют', () => {
    checkActual(r => {
      assert.equal(r.pairBlocked(80 - 40, 60, 100), false, 'R333 проверка: погашенный чистый поток проходит');
      assert.equal(r.pairBlocked(80, 60, 100), true, 'R333 проверка: непогашенный поток блокируется');
    });
  });

  it('отрицательный новый net не уменьшает уже накопленный перекос, а нулевой не прибавляет к нему', () => {
    checkActual(r => {
      for (const flow of [-100, 100]) {
        assert.equal(r.pairBlocked(flow, -1, 99), true, 'R333 проверка: будущий проигрыш не освобождает предел заранее');
        assert.equal(r.pairBlocked(flow, 0, 100), false, 'R333 проверка: нулевой net не съедает последний допуск');
      }
    });
  });
});

describe('R333 данные автоходов и времени обдумывания', () => {
  it('пустой список автоходов возвращает исходные данные без лишнего изменения', () => {
    checkActual(r => {
      const data = rps();
      assert.equal(r.withAuto(data, []), data, 'R333 проверка: отсутствие автоходов не создаёт новую запись');
    });
  });

  it('автоходы добавляются по сторонам к существующим счётчикам, а не заменяют их единицами', () => {
    checkActual(r => {
      const before = { ...rps(), auto: { challenger: 3, target: 5 } }, saved = normal(before);
      assert.deepEqual(normal(r.withAuto(before, ['challenger', 'target', 'target']).auto), { challenger: 4, target: 7 },
        'R333 проверка: каждый переданный автоход учтён у своей стороны');
      assert.deepEqual(normal(r.withAuto(rps(), ['target']).auto), { challenger: 0, target: 1 },
        'R333 проверка: отсутствующие счётчики начинают с нуля');
      assert.deepEqual(before, saved, 'R333 проверка: исходные счётчики автоходов неизменны');
    });
  });

  it('неизвестное время нажатия не добавляется как ноль и не создаёт новый снимок', () => {
    checkActual(r => {
      const data = rps();
      assert.equal(r.withThink(data, 'target', null), data, 'R333 проверка: null — нет замера, не мгновенное нажатие');
    });
  });

  for (const side of sides) it(`мгновенное нажатие ${side} сохраняет 0 мс, историю и независимость массивов`, () => {
    checkActual(r => {
      const before = { ...rps(), think: { challenger: [12], target: [34] } }, saved = normal(before);
      assert.deepEqual(normal(r.withThink(before, side, 0).think), { challenger: [12], target: [34], [side]: [...saved.think[side], 0] },
        'R333 проверка: ноль — настоящий замер своей стороны');
      assert.deepEqual(normal(r.withThink(rps(), side, 27).think), { challenger: [], target: [], [side]: [27] },
        'R333 проверка: история создаётся при первом замере');
      assert.deepEqual(before, saved, 'R333 проверка: добавление замера не меняет предыдущую историю');
    });
  });

  it('без начала хода или с битой датой время неизвестно, а не NaN или ложный ноль', () => {
    checkActual(r => {
      for (const moveFrom of [undefined, '', 'not-a-date']) assert.equal(r.thinkMsOf(base({ moveFrom }), now), null,
        'R333 проверка: отсутствующий/битый замер возвращает null');
    });
  });

  it('время обдумывания ограничено снизу нулём и сверху int32, с обеих сторон границ', () => {
    checkActual(r => {
      for (const [elapsed, expected] of [[-1, 0], [0, 0], [20_001, 20_001], [2_147_483_647, 2_147_483_647], [2_147_483_648, 2_147_483_647]]) {
        assert.equal(r.thinkMsOf(base({ moveFrom: new Date(now.getTime() - elapsed).toISOString() }), now), expected,
          'R333 проверка: 0/int32 и соседние значения без переполнения');
      }
    });
  });
});
