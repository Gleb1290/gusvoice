import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as wheel from './wheelRules';

const source = readFileSync(new URL('./duelRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Module = typeof import('./duelRules');
type Edit = readonly [string, string];
type LazyEdit = Edit | (() => Edit);
const normal = (v: unknown) => JSON.parse(JSON.stringify(v));
function load(raw = source): Module {
  const module = { exports: {} };
  const deps: Record<string, unknown> = { '@gusvoice/shared': shared, './wheelRules': wheel };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require(id: string) {
      assert.ok(Object.hasOwn(deps, id), `R334 setup: закрытый импорт ${id}`); return deps[id];
    } });
  return module.exports as Module;
}
function paired(title: string, check: (m: Module) => void | Promise<void>, ...edits: LazyEdit[]) {
  it(title, async () => {
    await check(load());
    for (const edit of edits) {
      await counterfact(async () => {
        const [from, to] = typeof edit === 'function' ? edit() : edit;
        assert.equal(source.split(from).length, 2, 'R334 setup: уникальный якорь целого duelRules');
        await assert.rejects(async () => check(load(source.replace(from, to))), e =>
          e instanceof assert.AssertionError && e.message.startsWith('duel rules:'), 'контрфакт ломает результат, не setup/import');
      });
      await check(load());
    }
  });
}
const now = Date.parse('2026-10-28T12:00:00Z');
paired('R334 банк удваивает ставку, комиссия округляется вниз и ограничена 0–100 %', m => {
  for (const [amount, pct, want] of [[100, 10, [200, 20, 180]], [7.9, 19.9, [14, 2, 12]],
    [-1, 10, [0, 0, 0]], [10, -5, [20, 0, 20]], [10, 101, [20, 20, 0]]] as const) {
    const v = m.duelPot(amount, pct);
    assert.deepEqual([v.pot, v.fee, v.payout], want, 'duel rules: банк и сгорание совпадают с деньгами сервера');
  }
}, ['Math.floor((pot * pct) / 100)', 'Math.ceil((pot * pct) / 100)'], ['Math.floor(amount)) * 2', 'Math.floor(amount))']);
paired('R334 срок учитывает знак поправки, ровно дедлайн даёт ноль, битая дата безопасна', m => {
  for (const [iso, skew, want] of [[new Date(now + 10_000).toISOString(), 3_000, 7_000],
    [new Date(now).toISOString(), -1, 1], [new Date(now).toISOString(), 0, 0],
    [new Date(now).toISOString(), 1, 0], ['broken', 0, 0], [null, 0, 0]] as const) {
    assert.equal(m.duelLeftMs(iso, skew, now), want, 'duel rules: время считается по часам сервера');
  }
}, ['t - (nowMs + skewMs)', 't - (nowMs - skewMs)']);
paired('R334 текущие кости яркие, предыдущие при перебросе тусклые, итог ищет последнее раскрытие своей стороны', m => {
  const rolls: shared.DuelDto['rolls'] = [{ challenger: [2, 3], target: [1, 4] }, { challenger: [6, 1], target: null }];
  for (const state of ['playing', 'settled', 'cancelled'] as const) {
    assert.deepEqual(normal(m.shownDice({ rolls, rollNo: 1, state }, 'challenger')), { dice: [6, 1], stale: false }, 'duel rules: новые кости не тускнеют');
    assert.deepEqual(normal(m.shownDice({ rolls, rollNo: 1, state }, 'target')), { dice: [1, 4], stale: state === 'playing' }, 'duel rules: старая сторона остаётся видна');
  }
  assert.deepEqual(normal(m.shownDice({ rolls, rollNo: 7, state: 'settled' }, 'target')), { dice: [1, 4], stale: false }, 'duel rules: итог просматривает всю историю');
  assert.deepEqual(normal(m.shownDice({ rolls: [], rollNo: 0, state: 'playing' }, 'target')), { dice: null, stale: false }, 'duel rules: нераскрытая кость не выдумана');
}, ['return { dice: prev, stale: !!prev };', 'return { dice: prev, stale: false };'], ['let i = duel.rolls.length - 1; i >= 0; i--', 'let i = duel.rolls.length - 1; i > 0; i--']);
paired('R334 реванш открывается ровно через паузу по часам сервера, но не в живой партии', m => {
  const settledAt = new Date(now).toISOString();
  for (const [offset, expected] of [[9_999, 1], [10_000, 0], [10_001, 0]]) {
    assert.equal(m.rematchLeftMs({ state: 'settled', settledAt }, 2_000, now + offset - 2_000, 10_000), expected, 'duel rules: граница паузы реванша');
  }
  assert.equal(m.rematchLeftMs({ state: 'playing', settledAt }, 0, now + 20_000, 10_000), 10_000, 'duel rules: живую партию нельзя переиграть');
}, ['t + pauseMs - (nowMs + skewMs)', 't + pauseMs - nowMs']);
paired('R334 живыми считаются вызов и игра, но не отсутствие и закрытые состояния', m => {
  for (const state of ['invited', 'playing', 'settled', 'cancelled'] as const)
    assert.equal(m.duelLive({ duel: { state } } as Parameters<Module['duelLive']>[0]), state === 'invited' || state === 'playing', 'duel rules: живость соответствует состоянию партии');
  assert.equal(m.duelLive(null), false, 'duel rules: null не включает полосу игры');
  assert.equal(m.duelLive(undefined), false, 'duel rules: до снимка партия не выдумана');
}, ["v.duel.state === 'invited' || v.duel.state === 'playing'", "v.duel.state === 'playing'"]);
paired('R334 сторона определяется моим id, зрителю и отсутствующему пользователю ход не дают', m => {
  const d = { challengerId: 'a', targetId: 'b' };
  for (const [id, want] of [['a', 'challenger'], ['b', 'target'], ['viewer', null], [null, null], [undefined, null]] as const)
    assert.equal(m.duelSideOf(d, id), want, 'duel rules: личность привязана к стороне, а не позиции на экране');
}, ["if (duel.challengerId === userId) return 'challenger';", "if (duel.challengerId === userId) return 'target';"]);
paired('R334 бросившей считается только сторона текущего броска, сумма пустой кости ноль', m => {
  const d = { rollNo: 1, rolls: [{ challenger: [6, 6] as [number, number], target: null }, { challenger: null, target: [2, 4] as [number, number] }] };
  assert.equal(m.hasRolled(d, 'challenger'), false, 'duel rules: прошлый бросок не закрывает кнопку переброса');
  assert.equal(m.hasRolled(d, 'target'), true, 'duel rules: раскрытая текущая сторона уже сходила');
  assert.equal(m.diceSum([2, 4]), 6, 'duel rules: сумма обеих костей');
  assert.equal(m.diceSum(null), 0, 'duel rules: до раскрытия сумма не выдумана');
}, ['return !!duel.rolls[duel.rollNo]?.[side];', 'return !!duel.rolls[0]?.[side];']);
paired('R337 клиент узнаёт три свои игры, будущую игру называет нейтральной дуэлью', m => {
  for (const [game, want] of [['dice', 'Кубики'], ['rps', 'Камень-ножницы-бумага'], ['greedy', 'Жадный гусь'], ['twentyone', '21']] as const) {
    assert.equal(m.duelGameKnown(game), true, 'duel rules: известная игра показывается');
    assert.equal(m.duelGameTitle(game), want, 'duel rules: подпись известной игры');
    assert.equal(m.duelGameWord(game), want.toLowerCase(), 'duel rules: подпись в середине фразы');
  }
  for (const game of ['future', null, undefined]) {
    assert.equal(m.duelGameKnown(game), false, 'duel rules: новая игра требует обновления');
    assert.equal(m.duelGameTitle(game), 'Дуэль', 'duel rules: неизвестная игра не названа кубиками');
  }
}, ["game === 'dice' || game === 'rps' || game === 'greedy'", "game === 'dice' || game === 'rps'"]);
paired('R337 последняя раскрытая пара рук берётся с конца, пустой раунд не выдуман', m => {
  const a = { challenger: 'rock', target: 'paper', winner: 'target' } as const;
  const b = { challenger: 'scissors', target: 'paper', winner: 'challenger' } as const;
  assert.equal(m.rpsLastRound({}), null, 'duel rules: без КНБ нет рук');
  assert.equal(m.rpsLastRound({ rps: { rounds: [] } as never }), null, 'duel rules: до раскрытия нет рук');
  assert.equal(m.rpsLastRound({ rps: { rounds: [a, b] } as never }), b, 'duel rules: показан последний, не первый раунд');
}, ['r[r.length - 1] : null', 'r[0] : null']);
paired('R337 моя тайная рука показывается только в идущем КНБ, а не в итоге', m => {
  const base = { myHand: 'paper', duel: { state: 'playing', rps: {} } } as Parameters<Module['shownMyHand']>[0];
  assert.equal(m.shownMyHand(base), 'paper', 'duel rules: сделанный ход не пропадает до раскрытия');
  for (const view of [null, undefined, { ...base, myHand: null }, { ...base, duel: { ...base!.duel, state: 'settled' } },
    { ...base, duel: { ...base!.duel, rps: undefined } }])
    assert.equal(m.shownMyHand(view as Parameters<Module['shownMyHand']>[0]), null, 'duel rules: вне текущего тайного хода руки нет');
}, ["view.duel.state !== 'playing' || !view.duel.rps", '!view.duel.rps']);
paired('R337 полоса гуся ограничена нулём и целью, ровно цель заполняет её целиком', m => {
  for (const [score, target, want] of [[-1, 20, 0], [0, 20, 0], [19, 20, .95], [20, 20, 1], [21, 20, 1], [1, 0, 0]])
    assert.equal(m.greedyProgress(score, target), want, 'duel rules: полоса не уходит за края и принимает границу');
});
const errors: Record<string, string> = {
  not_in_voice: 'Дуэль — только для сидящих в этом голосовом канале', not_voice_channel: 'Дуэли бывают только в голосовых каналах',
  target_unavailable: 'Этот гусь сейчас не может принять вызов', self: 'Себя на дуэль не вызывают',
  busy: 'Кто-то из вас уже в дуэли или ждёт ответа', in_duel: 'Кто-то из вас уже в дуэли или ждёт ответа',
  channel_busy: 'В этом канале уже идёт дуэль — дождись итога', cooldown: 'Слишком часто — подожди немного и вызови снова',
  expired: 'Время на ответ вышло', not_found: 'Этой дуэли уже нет', not_player: 'Ты не участвуешь в этой дуэли', not_playing: 'Партия уже не идёт',
  'bad-amount': 'Ставка — целое число монет, от одной', 'games-off': 'Игры на этом сервере выключены',
  'opted-out': 'Ты не участвуешь в экономике — включи её в настройках сервера', 'games-opted-out': 'Ты выключил себе игры — включить можно в кошельке',
  'over-bet-max': 'Больше максимальной ставки на этом сервере', poor: 'Не хватает монет в сундуке',
  'loss-limit': 'Сегодняшний предел проигрыша исчерпан — завтра снова в море', bot: 'Боты не играют',
  pair_limit: 'Вы двое на сегодня исчерпали предел выигрыша друг у друга в играх с выбором — сыграйте в кубики или завтра',
  'pair-limit': 'Вы двое на сегодня исчерпали предел выигрыша друг у друга в играх с выбором — сыграйте в кубики или завтра',
  not_your_turn: 'Сейчас ход соперника', stale_seq: 'Ход уже засчитан — партия обновилась', bad_move: 'Так сходить нельзя',
};
// Тексты денег — существующий публичный договор колеса, а не дубликат вычислений дуэли.
for (const [code, want] of Object.entries(errors)) {
  // expired/games-off есть и среди причин итога: меняем только ветку отказа, не обе функции сразу.
  paired(`${code.startsWith('pair') || ['not_your_turn', 'stale_seq', 'bad_move'].includes(code) ? 'R337' : 'R334'} отказ «${code}» объясняется человеку`, m => {
    assert.equal(m.duelErrorText(code, 'запасной'), want, 'duel rules: известный отказ переведён');
    assert.equal(m.duelErrorText('future-code', 'запасной'), 'запасной', 'duel rules: неизвестный отказ сохраняет запасной текст');
  }, () => {
    const anchor = code === 'expired' ? `case 'expired':\n      return 'Время на ответ вышло';`
      : code === 'games-off' ? `case 'games-off':\n    case 'opted-out':` : `case '${code}':`;
    return [anchor, anchor.replace(`case '${code}':`, `case 'unreachable-${code}':`)];
  });
}
paired('R337 отказ старого соперника у выборных игр предлагает кубики, у dice не маскирует общий отказ', m => {
  for (const game of ['rps', 'greedy'] as const) assert.equal(m.duelChallengeErrorText('target_unavailable', game),
    'Эта игра на его версии пока не открывается — позови его на кубики', 'duel rules: несовместимая игра названа честно');
  assert.equal(m.duelChallengeErrorText('target_unavailable', 'dice'), errors.target_unavailable, 'duel rules: кубики не требуют duel2');
}, ["code === 'target_unavailable' && game !== 'dice'", "code === 'target_unavailable'"]);
const reasons: Array<[shared.DuelDto['reason'], string, string]> = [
  ['declined', 'dice', 'Вызов отклонён'], ['expired', 'dice', 'Вызов остался без ответа'], ['withdrawn', 'dice', 'Вызов отозван'],
  ['player-deleted', 'dice', 'Игрок удалил аккаунт — ставки вернулись обоим'], ['games-off', 'dice', 'Игры на сервере выключили — ставки вернулись'],
  ['draw-limit', 'dice', 'Шесть ничьих подряд — ставки вернулись обоим'], ['draw-limit', 'rps', '7 раундов без победителя — ставки вернулись обоим'],
  ['draw-limit', 'greedy', 'Партия затянулась — ставки вернулись обоим'], ['timeout', 'rps', 'Оба не сходили вовремя — ставки вернулись обоим'],
];
for (const [reason, game, want] of reasons) {
  paired(`${game === 'dice' ? 'R334' : 'R337'} причина ${reason} у ${game} не теряет смысл возврата`, m => {
    assert.equal(m.duelReasonText(reason, game), want, 'duel rules: причина итога соответствует игре');
    assert.equal(m.duelReasonText(null), 'Дуэль отменена', 'duel rules: отсутствующая причина безопасна');
  }, () => {
    const anchor = reason === 'expired' || reason === 'games-off' ? `case '${reason}':\n      return '${want}';` : `case '${reason}':`;
    return [anchor, anchor.replace(`case '${reason}':`, `case 'unreachable-${reason}':`)];
  });
}
paired('R337 победа по времени подписывает проигравшего только при timeout с победителем', m => {
  for (const game of ['rps', 'greedy'] as const) {
    assert.equal(m.duelTimeoutNote({ game, reason: 'timeout', winnerId: 'a' }, 'Соперник'), game === 'greedy'
      ? 'Соперник пропустил ходы — победа по времени' : 'Соперник не сходил вовремя — победа по времени', 'duel rules: объяснена победа по времени');
    assert.equal(m.duelTimeoutNote({ game, reason: 'timeout', winnerId: null }, 'Соперник'), null, 'duel rules: ничья не названа победой');
    assert.equal(m.duelTimeoutNote({ game, reason: null, winnerId: 'a' }, 'Соперник'), null, 'duel rules: обычная победа не просрочка');
  }
}, ["duel.reason !== 'timeout' || !duel.winnerId", "duel.reason !== 'timeout'"]);

const commitBytes = Uint8Array.from({ length: 32 }, () => 0xab);
const rollBytes = (n: number) => Uint8Array.from([0, 0, 0, n, 0, 0, 0, n + 1, 0, 0, 0, n + 2, 0, 0, 0, n + 3]);
const proof = () => ({ id: 'round', seed: 'seed', commit: 'AB'.repeat(32), rolls: [0, 1, 2].map(n =>
  ({ challenger: [n + 1, n + 2] as [number, number], target: [n + 3, n + 4] as [number, number] })) });
const digest = (trace: string[] = []) => async (text: string) => {
  trace.push(text);
  if (text === 'gv-duel-commit:round:seed') return commitBytes;
  if (text === 'gv-duel-first:round:seed') return Uint8Array.of(1);
  const n = Number(text.split(':').at(-1));
  return text.startsWith('gv-duel-roll:round:seed:') && Number.isInteger(n) ? rollBytes(n) : null;
};
paired('R334 проверка честности пересчитывает все броски и находит подмену не только в первом', async m => {
  const d = proof(), trace: string[] = [];
  assert.deepEqual(normal(await m.verifyDuel(d, digest(trace))), { ok: true, rolls: [[1, 2, 3, 4], [2, 3, 4, 5], [3, 4, 5, 6]] }, 'duel rules: все раскрытия проверены');
  assert.deepEqual(trace, ['gv-duel-commit:round:seed', ...[0, 1, 2].map(n => `gv-duel-roll:round:seed:${n}`)], 'duel rules: хеши имеют разные номера');
  d.rolls[2].target = [1, 1];
  assert.deepEqual(normal(await m.verifyDuel(d, digest())), { ok: false, why: 'dice', at: 2, got: [3, 4, 5, 6] }, 'duel rules: подмена последнего броска отклонена');
  d.rolls[2].target = null as never;
  assert.equal((await m.verifyDuel(d, digest())).ok, true, 'duel rules: нераскрытая сторона не сравнивается с выдуманными костями');
}, ['n < duel.rolls.length', 'n < Math.min(1, duel.rolls.length)']);
paired('R334 неверное зерно и отсутствующий хеш не выдаются за честную дуэль', async m => {
  assert.deepEqual(normal(await m.verifyDuel({ ...proof(), seed: null }, digest())), { ok: false, why: 'no-seed' }, 'duel rules: без зерна нечего проверять');
  assert.deepEqual(normal(await m.verifyDuel({ ...proof(), commit: '00' }, digest())), { ok: false, why: 'commit' }, 'duel rules: замок обязан совпасть');
  for (const missing of ['gv-duel-commit:round:seed', 'gv-duel-roll:round:seed:2']) {
    assert.deepEqual(normal(await m.verifyDuel(proof(), async text => text === missing ? null : digest()(text))), { ok: false, why: 'unavailable' }, 'duel rules: недоступный digest не успех');
  }
}, ['if (hexOf(commit) !== duel.commit.toLowerCase()) return { ok: false, why: \'commit\' };\n  const out:',
  'if (false) return { ok: false, why: \'commit\' };\n  const out:']);
const greedyProof = () => ({ ...proof(), greedy: { first: 'challenger', rolls: [1, 2, 3] } as shared.DuelDto['greedy'] });
it('проверка 21 согласна с отложенной парой любой стороны, пустым стартом и добором с индекса 4', async () => {
  const m = load();
  for (const first of ['challenger', 'target'] as const) {
    const hash = async (text: string) => text.includes('gv-duel-first:') ? Uint8Array.of(first === 'challenger' ? 1 : 0) : digest()(text);
    let s = shared.twentyOneStart(first);
    const check = () => m.verifyTwentyOne({ ...proof(), twentyOne: { ...s, seq: 0, timeouts: { challenger: 0, target: 0 } } }, hash);
    assert.equal((await check()).ok, true);
    for (let n = 0; n < 2; n++) {
      s = shared.twentyOneStep(s, 'roll', s.turn === 'challenger' ? [1, 2] : [3, 4])!;
      assert.equal((await check()).ok, true);
    }
    s = shared.twentyOneStep(s, 'roll', 5)!;
    assert.equal((await check()).ok, true);
    s.rolls[0].die = 6; assert.equal((await check()).ok, false);
  }
});
it('честность 21 проверяет стартовые кости, добор, первого игрока и замок', async () => {
  const m = load();
  const first = shared.greedyFirstSide(Uint8Array.of(1));
  const state = shared.twentyOneStep(shared.twentyOneStart(first, { challenger: [1, 2], target: [3, 4] }), 'roll', 5)!;
  const d = { ...proof(), twentyOne: { ...state, seq: 1, timeouts: { challenger: 0, target: 0 } } };
  assert.equal((await m.verifyTwentyOne(d, digest())).ok, true);
  d.twentyOne.rolls[4].die = 6;
  assert.deepEqual(normal(await m.verifyTwentyOne(d, digest())), { ok: false, why: 'die', at: 4, got: 5 });
  d.twentyOne.rolls[4].die = 5;
  d.twentyOne.rolls[0].die = 2;
  assert.equal((await m.verifyTwentyOne(d, digest())).ok, false);
  d.twentyOne.rolls[0].die = 1;
  assert.deepEqual(normal(await m.verifyTwentyOne({ ...d, commit: '00' }, digest())), { ok: false, why: 'commit' });
  assert.deepEqual(normal(await m.verifyTwentyOne({ ...d, seed: null }, digest())), { ok: false, why: 'no-seed' });
  d.twentyOne.first = first === 'challenger' ? 'target' : 'challenger';
  assert.deepEqual(normal(await m.verifyTwentyOne(d, digest())), { ok: false, why: 'first' });
});
paired('R337 честность гуся проверяет первого ходившего и каждый сквозной бросок', async m => {
  const d = greedyProof(), trace: string[] = [];
  assert.deepEqual(normal(await m.verifyGreedy(d, digest(trace))), { ok: true, first: 'challenger', rolls: [1, 2, 3] }, 'duel rules: честный гусь принимается');
  assert.deepEqual(trace, ['gv-duel-commit:round:seed', 'gv-duel-first:round:seed', ...[0, 1, 2].map(n => `gv-duel-roll:round:seed:${n}`)], 'duel rules: проверена полная цепочка гуся');
  d.greedy!.first = 'target';
  assert.deepEqual(normal(await m.verifyGreedy(d, digest())), { ok: false, why: 'first' }, 'duel rules: подмена первого игрока отклоняется');
  assert.equal((await m.verifyGreedy(d, async text => text === 'gv-duel-first:round:seed' ? Uint8Array.of(0) : digest()(text))).ok, true,
    'duel rules: настоящий первый ход цели принимается');
  d.greedy!.first = 'challenger'; d.greedy!.rolls[2] = 6;
  assert.deepEqual(normal(await m.verifyGreedy(d, digest())), { ok: false, why: 'die', at: 2, got: 3 }, 'duel rules: подмена позднего броска отклоняется');
});
paired('R337 у проверки гуся различаются отсутствие зерна, неправильный замок и недоступный digest', async m => {
  for (const d of [{ ...greedyProof(), seed: null }, { ...greedyProof(), greedy: undefined }])
    assert.deepEqual(normal(await m.verifyGreedy(d, digest())), { ok: false, why: 'no-seed' }, 'duel rules: нет открытого доказательства');
  assert.deepEqual(normal(await m.verifyGreedy({ ...greedyProof(), commit: '00' }, digest())), { ok: false, why: 'commit' }, 'duel rules: чужой замок отклонён');
  for (const missing of ['gv-duel-commit:round:seed', 'gv-duel-first:round:seed', 'gv-duel-roll:round:seed:2'])
    assert.deepEqual(normal(await m.verifyGreedy(greedyProof(), async text => text === missing ? null : digest()(text))), { ok: false, why: 'unavailable' }, 'duel rules: не умеющий считать хеш не выдаёт успех');
});
