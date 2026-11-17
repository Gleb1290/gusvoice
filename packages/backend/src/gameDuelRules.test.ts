import { counterfact as gatedCounterfact } from '../../shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as money from './gameMoneyRules.js';
import * as actual from './gameDuelRules.js';
import type { DuelRoundData, DuelRoll, DuelRefusal } from './gameDuelRules.js';
import type { StakeBlock } from './gameMoneyRules.js';

type Rules = typeof actual;
type Mutation = { from: string; to: string };
const source = readFileSync(new URL('./gameDuelRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function load(raw: string): Rules {
  const module = { exports: {} };
  // Весь настоящий модуль и его настоящие чистые зависимости; никаких базы, браузера или копий функций.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, Buffer,
    require(id: string) {
      if (id === 'node:crypto') return crypto;
      if (id === '@gusvoice/shared') return shared;
      if (id === './gameMoneyRules.js') return money;
      assert.fail(`R332 подготовка: неожиданный импорт gameDuelRules ${id}`);
    },
  }, { timeout: 2_000 });
  return module.exports as Rules;
}

function counterfact(check: (rules: Rules) => void, mutations: Mutation | Mutation[]): void {
  check(actual);
  check(load(source));
  for (const { from, to } of Array.isArray(mutations) ? mutations : [mutations]) {
    gatedCounterfact(() => {
assert.equal(source.split(from).length, 2, `R332 подготовка: единственный якорь ${from}`);
    const changed = source.replace(from, to);
    assert.notEqual(changed, source, 'R332 подготовка: мутант действительно меняет модуль');
    // VM/import/syntax error не считается убийством: принимается только адресный AssertionError хоста.
    assert.throws(() => check(load(changed)), (error: unknown) =>
      error instanceof assert.AssertionError && error.message.startsWith('R332 проверка:'),
    'мутант обязан краснеть на проверке поведения');
});
    check(load(source));
  }
}

const seed = '0123456789abcdef'.repeat(4); // Публичное синтетическое зерно, не секрет инстанса.
const now = new Date('2026-10-28T16:00:00.000Z');
const lockAt = new Date(now.getTime() + 30_000);
const settleAt = new Date(now.getTime() + 15_000);
const settledAt = new Date(now.getTime() + 16_500);
const draw: DuelRoll = [1, 6, 3, 4];
const aWin: DuelRoll = [6, 6, 1, 2];
const bWin: DuelRoll = [1, 2, 6, 6];
const data = (extra: Partial<DuelRoundData> = {}): DuelRoundData => ({ channelId: 'voice', challengerId: 'a', targetId: 'b',
  game: 'dice', amount: 7, feePercent: 10, commit: 'public-commit', seed, ...extra });
const playing = (extra: Partial<DuelRoundData> = {}) => data({ phase: 'playing', rolls: [draw, aWin], rollNo: 0,
  revealed: [{ challenger: false, target: false }], ...extra });
const row = (state: string, extra: Partial<DuelRoundData> = {}) => ({ id: 'round', serverId: 'server', state, lockAt,
  settleAt: settleAt as Date | null, settledAt: settledAt as Date | null,
  data: { ...playing(extra), privateFuture: 'do-not-publish' } as Record<string, unknown> });
const digest = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest();

function expectedRolls(id: string, value: string): DuelRoll[] {
  const rolls: DuelRoll[] = [];
  // Независимо собираем SHA256-вход, а готовые байты читает общий клиентский модуль с собственными тестами.
  for (let n = 0; n < 6; n++) {
    const roll = shared.diceFromHash(digest(`gv-duel-roll:${id}:${value}:${n}`));
    rolls.push(roll);
    if (roll[0] + roll[1] !== roll[2] + roll[3]) break;
  }
  return rolls;
}

describe('R332 обещание и кости проверяются реальными байтами SHA256', () => {
  it('обещание — полный нижний hex SHA256 своего домена в UTF-8', () => {
    // Нелатинский id отличает UTF-8 от latin1; roundId и зерно оба участвуют в обещании.
    counterfact(r => {
      for (const id of ['round', 'раунд-🪿', 'other']) for (const value of [seed, 'ab'.repeat(32)]) {
        assert.equal(r.duelCommit(id, value), digest(`gv-duel-commit:${id}:${value}`).toString('hex'),
          'R332 проверка: точные байты обещания');
        assert.match(r.duelCommit(id, value), /^[0-9a-f]{64}$/, 'R332 проверка: полный нижний hex');
      }
    }, [
      { from: 'sha256(duelCommitInput(roundId, seedHex))', to: 'sha256(duelRollInput(roundId, seedHex, 0))' },
      { from: ".update(text, 'utf8')", to: ".update(text, 'latin1')" },
    ]);
  });

  it('каждый бросок из собственного домена и n, а не из hex-текста хеша или обещания', () => {
    counterfact(r => {
      for (const id of Array.from({ length: 64 }, (_, n) => `кости-${n}`)) {
        assert.deepEqual(normal(r.duelRolls(id, seed)), expectedRolls(id, seed), 'R332 проверка: кости из байтов своего SHA256');
      }
    }, [
      { from: 'const roll = diceFromHash(new Uint8Array(sha256(duelRollInput(roundId, seedHex, n))));',
        to: 'const roll = diceFromHash(new Uint8Array(sha256(duelCommitInput(roundId, seedHex))));' },
      { from: 'const roll = diceFromHash(new Uint8Array(sha256(duelRollInput(roundId, seedHex, n))));',
        to: "const roll = diceFromHash(new Uint8Array(Buffer.from(sha256(duelRollInput(roundId, seedHex, n)).toString('hex'), 'utf8')));" },
    ]);
  });

  it('реальная ничья приводит к n=1, первая не-ничья останавливает генерацию', () => {
    const ids = Array.from({ length: 512 }, (_, n) => `reroll-${n}`);
    const tied = ids.find(id => expectedRolls(id, seed).length >= 2);
    const decisive = ids.find(id => expectedRolls(id, seed).length === 1);
    assert.ok(tied && decisive, 'R332 подготовка: корпус содержит ничью и решающий первый бросок');
    counterfact(r => {
      for (const id of [tied, decisive]) assert.deepEqual(normal(r.duelRolls(id, seed)), expectedRolls(id, seed),
        'R332 проверка: переброс только до первой не-ничьей');
    }, [
      { from: 'const roll = diceFromHash(new Uint8Array(sha256(duelRollInput(roundId, seedHex, n))));',
        to: 'const roll = diceFromHash(new Uint8Array(sha256(duelRollInput(roundId, seedHex, 0))));' },
      { from: 'if (!duelRollIsDraw(roll)) break;', to: 'if (duelRollIsDraw(roll)) break;' },
    ]);
  });

  it('принятие прежнего приглашения без цели сохраняет одну победу и не изменяет приглашение', () => {
    const invite = data({ phase: 'done', rollNo: 5, rolls: [bWin], revealed: [{ challenger: true, target: true }] });
    const before = normal(invite);
    const result = actual.duelStartData('start', invite);
    assert.deepEqual(normal(result), { ...before, phase: 'playing', rolls: expectedRolls('start', seed), rollNo: 0,
      revealed: [{ challenger: false, target: false }] });
    assert.deepEqual(invite, before);
    assert.notEqual(result, invite);
  });
});

describe('R332 DTO не раскрывает секретную половину партии', () => {
  for (const state of ['open', 'locked', 'cancelled']) it(`${state}: белый список полей скрывает seed, будущие кости и итог`, () => {
    counterfact(r => {
      const dto = r.duelDto(row(state, { winnerId: 'a', payout: 13,
        revealed: [{ challenger: true, target: false }] }));
      assert.deepEqual(normal(dto), { id: 'round', serverId: 'server', channelId: 'voice', game: 'dice', challengerId: 'a', targetId: 'b',
        amount: 7, feePercent: 10, state: state === 'open' ? 'invited' : state === 'locked' ? 'playing' : 'cancelled',
        inviteUntil: state === 'open' ? lockAt.toISOString() : null, commit: 'public-commit', rollNo: 0,
        turnUntil: state === 'locked' ? settleAt.toISOString() : null,
        rolls: [{ challenger: [1, 6], target: null }], winnerId: null, payout: null, seed: null, reason: null,
        settledAt: state === 'cancelled' ? settledAt.toISOString() : null, moveUntil: null }, 'R332 проверка: точный безопасный DTO до расчёта');
      assert.equal(JSON.stringify(dto).includes(seed), false, 'R332 проверка: зерно отсутствует во всём JSON');
    }, [
      { from: "seed: settled && typeof data.seed === 'string' ? data.seed : null,", to: "seed: typeof data.seed === 'string' ? data.seed : null," },
      { from: '    id: row.id,', to: '    id: row.id, data: row.data,' },
    ]);
  });

  it('нераскрытая сторона остаётся null, после её раскрытия видна только её пара', () => {
    counterfact(r => {
      const hidden = r.duelDto(row('locked'))!;
      const targetOnly = r.duelDto(row('locked', { revealed: [{ challenger: false, target: true }] }))!;
      assert.deepEqual(normal(hidden.rolls), [{ challenger: null, target: null }], 'R332 проверка: обе стороны скрыты');
      assert.deepEqual(normal(targetOnly.rolls), [{ challenger: null, target: [3, 4] }], 'R332 проверка: раскрытие только цели');
    }, [
      { from: 'challenger: seen.challenger ? [r[0], r[1]] : null,', to: 'challenger: [r[0], r[1]],' },
      { from: 'target: seen.target ? [r[2], r[3]] : null,', to: 'target: [r[2], r[3]],' },
    ]);
  });

  it('будущие броски скрыты даже с true-флагами в сохранённых данных; текущий переброс виден', () => {
    counterfact(r => {
      const flags = [{ challenger: true, target: true }, { challenger: true, target: false }];
      assert.deepEqual(normal(r.duelDto(row('locked', { revealed: flags }))!.rolls),
        [{ challenger: [1, 6], target: [3, 4] }], 'R332 проверка: будущее не раскрыто');
      assert.deepEqual(normal(r.duelDto(row('locked', { rollNo: 1, revealed: flags }))!.rolls),
        [{ challenger: [1, 6], target: [3, 4] }, { challenger: [6, 6], target: null }], 'R332 проверка: текущий переброс включён');
    }, { from: 'all ? rolls.length - 1 : Math.min(data.rollNo ?? 0, rolls.length - 1)', to: 'rolls.length - 1' });
  });

  it('после settled раскрываются все броски и зерно, но ни data, ни служебные флаги', () => {
    counterfact(r => assert.deepEqual(normal(r.duelDto(row('settled', { phase: 'done', winnerId: 'a', payout: 13 }))),
      { id: 'round', serverId: 'server', channelId: 'voice', game: 'dice', challengerId: 'a', targetId: 'b', amount: 7,
        feePercent: 10, state: 'settled', inviteUntil: null, commit: 'public-commit', rollNo: 0, turnUntil: null,
        rolls: [{ challenger: [1, 6], target: [3, 4] }, { challenger: [6, 6], target: [1, 2] }],
        winnerId: 'a', payout: 13, seed, reason: null, settledAt: settledAt.toISOString(), moveUntil: null }, 'R332 проверка: точный раскрытый итог'),
    [
      { from: "seed: settled && typeof data.seed === 'string' ? data.seed : null,", to: 'seed: null,' },
      { from: 'rolls: revealedRolls(data, settled),', to: 'rolls: revealedRolls(data, false),' },
      { from: '    id: row.id,', to: '    id: row.id, data: row.data,' },
    ]);
  });

  it('done до выплаты всё ещё playing, но дедлайна нажатия и открытого зерна уже нет', () => {
    counterfact(r => {
      const dto = r.duelDto(row('locked', { phase: 'done', revealed: [{ challenger: true, target: true }] }))!;
      assert.equal(dto.state, 'playing', 'R332 проверка: анимация ещё не settled');
      assert.equal(dto.turnUntil, null, 'R332 проверка: нажатия закончились');
      assert.equal(dto.seed, null, 'R332 проверка: анимация не открывает зерно');
      assert.equal(r.duelDto(row('locked'))!.turnUntil, settleAt.toISOString(), 'R332 проверка: дедлайн есть у playing');
    }, { from: "state === 'playing' && data.phase === 'playing'", to: "state === 'playing'" });
  });

  it('неизвестное состояние и отсутствующие идентификаторы отклоняются рядом с корректной строкой', () => {
    counterfact(r => {
      for (const state of ['unknown', '', 'invited']) assert.equal(r.duelDto(row(state)), null,
        'R332 проверка: неизвестное состояние отклонено');
      for (const key of ['channelId', 'challengerId', 'targetId']) {
        const invalid = row('open');
        delete invalid.data[key];
        assert.equal(r.duelDto(invalid), null, 'R332 проверка: обязательный идентификатор отсутствует');
      }
      assert.ok(r.duelDto(row('open')), 'R332 проверка: полноценное приглашение принято');
    }, [
      { from: "typeof data.channelId !== 'string'", to: 'false' },
      { from: "typeof data.challengerId !== 'string'", to: 'false' },
      { from: "typeof data.targetId !== 'string'", to: 'false' },
    ]);
  });

  it('старые данные без необязательных полей получают безопасные нули, null и пустые кости', () => {
    counterfact(r => {
      const minimal = { ...row('open'), lockAt: null as Date | null,
        data: { channelId: 'voice', challengerId: 'a', targetId: 'b', amount: '7', feePercent: '10', commit: 17 } };
      assert.deepEqual(normal(r.duelDto(minimal)), { id: 'round', serverId: 'server', channelId: 'voice', game: 'dice',
        challengerId: 'a', targetId: 'b', amount: 0, feePercent: 0, state: 'invited', inviteUntil: null, commit: '', rollNo: 0,
        turnUntil: null, rolls: [], winnerId: null, payout: null, seed: null, reason: null, settledAt: null, moveUntil: null },
      'R332 проверка: безопасный старый снимок');
    }, [
      { from: "amount: typeof data.amount === 'number' ? data.amount : 0,", to: 'amount: data.amount ?? 0,' },
      { from: "commit: typeof data.commit === 'string' ? data.commit : '',", to: "commit: data.commit ?? ''," },
    ]);
  });
});

describe('R332 нажатие только раскрывает заранее решённые кости', () => {
  it('свою сторону находим точно, зритель не получает чужую сторону', () => {
    counterfact(r => {
      assert.equal(r.duelSideOf(data(), 'a'), 'challenger', 'R332 проверка: сторона вызвавшего');
      assert.equal(r.duelSideOf(data(), 'b'), 'target', 'R332 проверка: сторона цели');
      assert.equal(r.duelSideOf(data(), 'viewer'), null, 'R332 проверка: зритель не игрок');
    }, { from: "if (data.targetId === userId) return 'target';", to: "return 'target';" });
  });

  it('до начала, после done и без бросков раскрытие ничего не меняет', () => {
    counterfact(r => {
      for (const input of [data({ rolls: [aWin] }), playing({ phase: 'done' }), playing({ rolls: [] }), data()]) {
        const result = r.duelReveal(input, ['challenger', 'target'], now);
        assert.equal(result.changed, false, 'R332 проверка: вне готового playing нет нажатия');
        assert.equal(result.data, input, 'R332 проверка: нет нового состояния без раскрытия');
        assert.equal(result.settleAt, null, 'R332 проверка: дедлайн не трогается');
      }
      assert.equal(r.duelReveal(playing(), ['challenger'], now).changed, true, 'R332 проверка: готовый playing принят');
    }, { from: "data.phase !== 'playing' || ", to: '' });
  });

  for (const side of ['challenger', 'target'] as const) it(`одиночное нажатие ${side} не раскрывает соперника и не переносит дедлайн`, () => {
    counterfact(r => {
      const input = playing();
      const result = r.duelReveal(input, [side], now);
      assert.equal(result.changed, true, 'R332 проверка: первое нажатие меняет состояние');
      assert.equal(result.settleAt, null, 'R332 проверка: одной стороны недостаточно для нового срока');
      assert.equal(result.data.phase, 'playing', 'R332 проверка: не закончили раньше соперника');
      assert.equal(result.data.rollNo, 0, 'R332 проверка: номер броска не сдвинут');
      assert.deepEqual(normal(result.data.revealed), [{ challenger: side === 'challenger', target: side === 'target' }],
        'R332 проверка: только нажатая сторона');
    }, { from: 'cur[side] = true;', to: 'cur.challenger = true; cur.target = true;' });
  });

  it('повтор уже раскрытой стороны идемпотентен и возвращает исходный объект без нового срока', () => {
    counterfact(r => {
      const input = playing({ revealed: [{ challenger: true, target: false }] });
      const result = r.duelReveal(input, ['challenger', 'challenger'], now);
      assert.equal(result.changed, false, 'R332 проверка: повтор не меняет состояние');
      assert.equal(result.data, input, 'R332 проверка: повтор сохраняет объект');
      assert.equal(result.settleAt, null, 'R332 проверка: повтор не продлевает срок');
      assert.equal(r.duelReveal(input, ['target'], now).changed, true, 'R332 проверка: другая сторона ещё раскрывается');
    }, { from: 'if (!cur[side]) {', to: 'if (true) {' });
  });

  it('пустой список сторон ничего не делает, даже когда первая сторона уже раскрыта', () => {
    counterfact(r => {
      const input = playing({ revealed: [{ challenger: true, target: false }] });
      const result = r.duelReveal(input, [], now);
      assert.equal(result.data, input, 'R332 проверка: пустое нажатие сохраняет объект');
      assert.equal(result.changed, false, 'R332 проверка: пустое нажатие не меняет состояние');
      assert.equal(result.settleAt, null, 'R332 проверка: пустое нажатие не продлевает срок');
    }, { from: 'let changed = false;', to: 'let changed = true;' });
  });

  it('после обеих сторон ничья открывает ровно следующий скрытый бросок со сроком now+15000', () => {
    counterfact(r => {
      const input = playing({ revealed: [{ challenger: true, target: false }] });
      const result = r.duelReveal(input, ['target'], now);
      assert.equal(result.changed, true, 'R332 проверка: вторая сторона раскрыта');
      assert.equal(result.data.phase, 'playing', 'R332 проверка: ещё playing');
      assert.equal(result.data.rollNo, 1, 'R332 проверка: следующий номер');
      assert.deepEqual(normal(result.data.revealed), [{ challenger: true, target: true }, { challenger: false, target: false }],
        'R332 проверка: переброс начинается скрытым');
      assert.equal(result.settleAt?.getTime(), now.getTime() + 15_000, 'R332 проверка: точный срок следующего броска');
    }, [
      { from: 'rollNo: rollNo + 1, revealed', to: 'rollNo, revealed' },
      { from: 'new Date(now.getTime() + DUEL_ROLL_TURN_MS)', to: 'new Date(now.getTime() + DUEL_ROLL_ANIM_MS)' },
    ]);
  });

  it('сервер может раскрыть сразу обе стороны, повтор done не продлевает анимацию', () => {
    counterfact(r => {
      const input = playing({ rolls: [aWin] });
      const result = r.duelReveal(input, ['challenger', 'target'], now);
      assert.equal(result.data.phase, 'done', 'R332 проверка: последний бросок закончен');
      assert.equal(result.data.rollNo, 0, 'R332 проверка: последнего переброса не придумали');
      assert.deepEqual(normal(result.data.revealed), [{ challenger: true, target: true }], 'R332 проверка: обе стороны раскрыты');
      assert.equal(result.settleAt?.getTime(), now.getTime() + 1_500, 'R332 проверка: анимация ровно 1500 мс');
      const repeat = r.duelReveal(result.data, ['challenger', 'target'], new Date(now.getTime() + 1));
      assert.equal(repeat.changed, false, 'R332 проверка: done идемпотентен');
      assert.equal(repeat.settleAt, null, 'R332 проверка: повтор не сдвигает выплату');
    }, [
      { from: "phase: 'done' }, settleAt: new Date(now.getTime() + DUEL_ROLL_ANIM_MS)",
        to: "phase: 'playing' }, settleAt: new Date(now.getTime() + DUEL_ROLL_ANIM_MS)" },
      { from: 'new Date(now.getTime() + DUEL_ROLL_ANIM_MS)', to: 'new Date(now.getTime() + DUEL_ROLL_TURN_MS)' },
    ]);
  });

  it('последняя шестая ничья заканчивает раскрытие, а не заводит седьмой бросок', () => {
    counterfact(r => {
      const input = playing({ rolls: Array.from({ length: 6 }, () => [...draw] as DuelRoll), rollNo: 5,
        revealed: Array.from({ length: 6 }, () => ({ challenger: true, target: false })) });
      const result = r.duelReveal(input, ['target'], now);
      assert.equal(result.data.phase, 'done', 'R332 проверка: исчерпана последняя ничья');
      assert.equal(result.data.rollNo, 5, 'R332 проверка: шестой бросок остаётся последним');
      assert.equal(result.data.revealed?.length, 6, 'R332 проверка: нет седьмого раскрытия');
      assert.equal(result.settleAt?.getTime(), now.getTime() + 1_500, 'R332 проверка: анимация перед возвратом');
    }, { from: 'if (rollNo < data.rolls.length - 1)', to: 'if (rollNo <= data.rolls.length - 1)' });
  });

  it('раскрытие не меняет вложенные флаги исходного состояния и заранее решённые кости', () => {
    counterfact(r => {
      const input = playing();
      const before = normal(input);
      const result = r.duelReveal(input, ['challenger'], now);
      assert.deepEqual(input, before, 'R332 проверка: исходные вложенные флаги не мутируют');
      assert.notEqual(result.data, input, 'R332 проверка: новое состояние при раскрытии');
      assert.notEqual(result.data.revealed, input.revealed, 'R332 проверка: независимый список раскрытий');
      assert.notEqual(result.data.revealed?.[0], input.revealed?.[0], 'R332 проверка: независимый текущий флаг');
      assert.deepEqual(normal(result.data.rolls), before.rolls, 'R332 проверка: кости не переброшены нажатием');
    }, { from: '(data.revealed ?? []).map((r) => ({ ...r }))', to: '(data.revealed ?? []).slice()' });
  });

  it('отсутствующие флаги и номер восстанавливаются как скрытый первый бросок', () => {
    counterfact(r => {
      const input = playing({ revealed: undefined, rollNo: undefined });
      const result = r.duelReveal(input, ['target'], now);
      assert.equal(result.data.rollNo, 0, 'R332 проверка: номер по умолчанию нулевой');
      assert.deepEqual(normal(result.data.revealed), [{ challenger: false, target: true }], 'R332 проверка: пропущенные флаги восстановлены');
      assert.equal(result.settleAt, null, 'R332 проверка: скрытый соперник сохраняет прежний срок');
    }, { from: 'while (revealed.length <= rollNo) revealed.push({ challenger: false, target: false });',
      to: 'while (revealed.length <= rollNo) revealed.push({ challenger: true, target: false });' });
  });
});

describe('R332 чужие ограничения обезличиваются, общие ошибки остаются понятными', () => {
  it('чужие деньги, личные пределы, отказ от игр и бот дают только target_unavailable; свои причины точные', () => {
    counterfact(r => {
      const privateBlocks: StakeBlock[] = ['poor', 'loss-limit', 'opted-out', 'games-opted-out', 'bot', 'bad-pick'];
      for (const block of privateBlocks) {
        assert.equal(r.duelRefusalOf(block, false), 'target_unavailable', 'R332 проверка: чужая причина скрыта');
        assert.equal(r.duelRefusalOf(block, true), block, 'R332 проверка: своя причина объяснена');
      }
    }, [
      { from: "return mine ? block : 'target_unavailable';", to: 'return block;' },
      { from: "return mine ? block : 'target_unavailable';", to: "return 'target_unavailable';" },
    ]);
  });

  it('общие bad-amount, over-bet-max и games-off не маскируются под чужую личную причину', () => {
    // Эти исключения предусмотрены контрактом правил: они описывают ставку/сервер, не чужой кошелёк.
    counterfact(r => {
      for (const block of ['bad-amount', 'over-bet-max', 'games-off'] as const) for (const mine of [false, true]) {
        assert.equal(r.duelRefusalOf(block, mine), block, 'R332 проверка: общая причина остаётся общей');
      }
    }, { from: "if (block === 'over-bet-max' || block === 'bad-amount' || block === 'games-off') return block;", to: '' });
  });

  it('duplicate и round-closed у любой стороны становятся expired, а не сообщением о кошельке', () => {
    counterfact(r => {
      for (const block of ['duplicate', 'round-closed'] as const) for (const mine of [false, true]) {
        assert.equal(r.duelRefusalOf(block, mine), 'expired', 'R332 проверка: повтор и закрытие — истёкший вызов');
      }
    }, { from: "if (block === 'round-closed' || block === 'duplicate') return 'expired';", to: '' });
  });

  it('HTTP отличает неверный ввод, запрет, отсутствие, состояние и частоту', () => {
    counterfact(r => {
      const groups: [number, DuelRefusal[]][] = [
        [400, ['bad-amount', 'bad-pick', 'self', 'not_voice_channel']],
        [403, ['games-off', 'not_in_voice', 'bot', 'opted-out', 'games-opted-out', 'not_player']],
        [404, ['not_found']], [429, ['busy', 'cooldown']],
        [409, ['target_unavailable', 'in_duel', 'channel_busy', 'expired', 'not_playing', 'poor', 'loss-limit', 'over-bet-max', 'round-closed', 'duplicate']],
      ];
      for (const [status, codes] of groups) for (const code of codes) {
        assert.equal(r.duelRefusalStatus(code), status, 'R332 проверка: HTTP-класс отказа');
        assert.equal(typeof r.DUEL_REFUSAL_TEXT[code], 'string', 'R332 проверка: есть запасной текст для старого клиента');
      }
    }, { from: "if (code === 'not_found') return 404;", to: "if (code === 'not_found') return 409;" });
  });
});

describe('R332 расчёт банка использует замороженные условия', () => {
  it('победа любой стороны даёт ей весь банк минус splitPot с feePercent из партии', () => {
    counterfact(r => {
      for (const [roll, winnerId, loserId] of [[aWin, 'a', 'b'], [bWin, 'b', 'a']] as const) {
        for (const amount of [1, 7, 50, 51, 100]) for (const feePercent of [0, 1, 10, 25, 100]) {
          const input = data({ amount, feePercent, rolls: [roll] });
          const split = money.splitPot([{ key: winnerId, amount, winner: true }, { key: loserId, amount, winner: false }], feePercent);
          const plan = r.duelSettlePlan(input);
          assert.deepEqual(normal(plan), { winnerId, loserId, payout: split.payouts.get(winnerId), pool: amount * 2, fee: split.fee },
            'R332 проверка: замороженная комиссия и выплата общего splitPot');
          assert.equal(plan.payout! + plan.fee, amount * 2, 'R332 проверка: сохранение банка');
        }
      }
    }, [
      { from: '    data.feePercent,', to: '    10,' },
      { from: "const winnerId = winner === 'challenger' ? data.challengerId : data.targetId;",
        to: "const winnerId = winner === 'challenger' ? data.targetId : data.challengerId;" },
      { from: 'payout: split.payouts.get(winnerId) ?? 0', to: 'payout: data.amount * 2' },
    ]);
  });

  it('комиссия на соседях округляется вниз: банк 8 ещё без комиссии, 10 уже с монетой', () => {
    counterfact(r => {
      assert.deepEqual(normal(r.duelSettlePlan(data({ amount: 4, rolls: [aWin] }))),
        { winnerId: 'a', loserId: 'b', pool: 8, fee: 0, payout: 8 }, 'R332 проверка: ниже порога комиссии');
      assert.deepEqual(normal(r.duelSettlePlan(data({ amount: 5, rolls: [aWin] }))),
        { winnerId: 'a', loserId: 'b', pool: 10, fee: 1, payout: 9 }, 'R332 проверка: ровно порог комиссии');
      assert.deepEqual(normal(r.duelSettlePlan(data({ amount: 6, rolls: [aWin] }))),
        { winnerId: 'a', loserId: 'b', pool: 12, fee: 1, payout: 11 }, 'R332 проверка: выше порога комиссии');
    }, { from: '    data.feePercent,', to: '    data.feePercent + 10,' });
  });

  it('пустой исход и шесть ничьих возвращают обоим ставки без победителя и без комиссии', () => {
    counterfact(r => {
      for (const rolls of [undefined, [], Array.from({ length: 6 }, () => [...draw] as DuelRoll)]) {
        assert.deepEqual(normal(r.duelSettlePlan(data({ rolls, amount: 100, feePercent: 99 }))),
          { winnerId: null, loserId: null, payout: null, pool: 200, fee: 0 }, 'R332 проверка: возврат без сгорания');
      }
    }, { from: 'if (!winner) return { winnerId: null, loserId: null, payout: null, pool, fee: 0 };',
      to: 'if (!winner) return { winnerId: null, loserId: null, payout: null, pool, fee: 1 };' });
  });

  it('пауза пары изолирована сервером и направлением вызова; отказ и итог имеют разные сроки', () => {
    counterfact(r => {
      assert.equal(r.duelPairKey('s', 'a', 'b'), 'duel:pair:s:a:b', 'R332 проверка: точный ключ пары');
      assert.notEqual(r.duelPairKey('s', 'a', 'b'), r.duelPairKey('other', 'a', 'b'), 'R332 проверка: серверы не делят паузу');
      assert.notEqual(r.duelPairKey('s', 'a', 'b'), r.duelPairKey('s', 'b', 'a'), 'R332 проверка: направление вызова различается');
      assert.equal(r.DUEL_PAIR_COOLDOWN_MS, 60_000, 'R332 проверка: отказ или молчание на минуту');
      assert.equal(r.DUEL_RESULT_SHOW_MS, 30_000, 'R332 проверка: итог виден полминуты');
    }, { from: '`duel:pair:${serverId}:${challengerId}:${targetId}`', to: '`duel:pair:${challengerId}:${targetId}`' });
  });
});


describe('кубики до двух побед с одной ставкой', () => {
  it('первая победа и ничья не решают партию, счёт 1:1 требует третьего очка', () => {
    for (const [rolls, winner] of [
      [[aWin], null], [[draw, aWin, draw, bWin], null],
      [[aWin, draw, bWin, bWin], 'target'], [[bWin, aWin, aWin], 'challenger'],
      [[aWin, aWin, bWin, bWin], 'challenger'],
    ] as const) assert.equal(shared.duelOutcome(rolls, 2).winner, winner);
    assert.deepEqual(shared.duelOutcome([aWin, draw, bWin], 2).wins, { challenger: 1, target: 1 });
    assert.deepEqual(shared.duelOutcome([aWin], 1).wins, { challenger: 1, target: 0 });
    assert.deepEqual(shared.duelOutcome([aWin, bWin, bWin]), { winner: 'challenger' });
  });

  it('вторая победа на восьмом броске засчитывается, девятый бросок уже вне бюджета', () => {
    const ties = Array.from({ length: 6 }, () => draw);
    assert.equal(shared.duelOutcome([...ties, aWin], 2).winner, null);
    assert.equal(shared.duelOutcome([...ties, aWin, aWin], 2).winner, 'challenger');
    assert.equal(shared.duelOutcome([...ties, draw, aWin, aWin], 2).winner, null);
    assert.equal(shared.duelOutcome([draw, draw, draw, draw, draw, aWin]).winner, 'challenger');
  });

  it('все новые броски воспроизводятся из зерна, генерация кончается на второй победе или восьмом броске', () => {
    for (let i = 0; i < 40; i++) {
      const id = `dice-two-${i}`;
      const d = actual.duelStartData(id, data({ diceTarget: 2 }));
      const rolls = d.rolls!;
      assert.equal(d.diceTarget, 2);
      assert.ok(rolls.length >= 2 && rolls.length <= 8);
      const wins = { challenger: 0, target: 0 };
      rolls.forEach((roll, n) => {
        assert.deepEqual(roll, shared.diceFromHash(digest(`gv-duel-roll:${id}:${seed}:${n}`)));
        assert.ok(wins.challenger < 2 && wins.target < 2);
        const a = roll[0] + roll[1], b = roll[2] + roll[3];
        if (a !== b) wins[a > b ? 'challenger' : 'target']++;
      });
      assert.ok(wins.challenger === 2 || wins.target === 2 || rolls.length === 8);
    }
  });

  it('первое очко открывает скрытый бросок, повтор своей стороны не меняет его, ничья не заканчивает партию', () => {
    let d = playing({ diceTarget: 2, rolls: [aWin, draw, bWin, bWin] });
    for (let i = 0; i < 4; i++) {
      const first = actual.duelReveal(d, ['challenger'], now);
      assert.equal(first.data.rollNo, i);
      const replay = actual.duelReveal(first.data, ['challenger'], now);
      assert.equal(replay.changed, false);
      assert.equal(replay.data, first.data);
      const next = actual.duelReveal(first.data, ['target'], now);
      assert.equal(next.data.phase, i === 3 ? 'done' : 'playing');
      assert.equal(next.settleAt!.getTime() - now.getTime(), i === 3 ? 1500 : 15000);
      if (i < 3) assert.deepEqual(next.data.revealed!.at(-1), { challenger: false, target: false });
      d = next.data;
    }
    assert.equal(actual.duelSettlePlan(d).winnerId, 'b');
  });

  it('комиссия и банк считаются за целую партию, первая победа соперника не определяет выплату', () => {
    const full = data({ diceTarget: 2, rolls: [aWin, bWin, bWin], amount: 100 });
    assert.deepEqual(actual.duelSettlePlan(full), { winnerId: 'b', loserId: 'a', payout: 180, pool: 200, fee: 20 });
    assert.equal(actual.duelSettlePlan({ ...full, diceTarget: undefined }).winnerId, 'a');
    assert.deepEqual(actual.duelSettlePlan({ ...full, rolls: Array.from({ length: 8 }, () => draw) }),
      { winnerId: null, loserId: null, payout: null, pool: 200, fee: 0 });
  });

  it('DTO передаёт цель добавлением, не раскрывая будущие броски, зерно или неполную пару', () => {
    const dto = actual.duelDto(row('locked', { diceTarget: 2, rolls: [aWin, bWin, bWin],
      revealed: [{ challenger: true, target: false }] }))!;
    assert.equal(Reflect.get(dto, 'diceTarget'), 2);
    assert.deepEqual(dto.rolls, [{ challenger: [6, 6], target: null }]);
    assert.equal(dto.seed, null);
    assert.equal(dto.winnerId, null);
    assert.equal(Reflect.get(actual.duelDto(row('locked'))!, 'diceTarget'), undefined);
  });
});
