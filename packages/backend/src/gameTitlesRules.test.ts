import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { counterfact } from '../../shared/test/counterfacts.js';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as coinRules from './coinRules.js';
import type { GameMonthInput, TitleDuel, TitleMove, TitleStake } from './gameTitlesRules.js';

type Rules = typeof import('./gameTitlesRules.js');
type Edit = { from: string; to: string };
const source = readFileSync(new URL('./gameTitlesRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function load(edit?: Edit): Rules {
  let code = source;
  if (edit) { assert.equal(code.split(edit.from).length, 2, 'R339 setup: единственный якорь целого gameTitlesRules.ts'); code = code.replace(edit.from, edit.to); }
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, require(id: string) { if (id === '@gusvoice/shared') return shared; if (id === './coinRules.js') return coinRules; throw new Error(`R339 setup: импорт ${id}`); },
  }); return module.exports as Rules;
}
function proof(prefix: string, run: (r: Rules) => void, edits: () => Edit[], count = 1) {
  run(load());
  let mutations: Edit[] | undefined;
  for (let index = 0; index < count; index++) {
    counterfact(() => {
      const edit = (mutations ??= edits())[index];
      assert.throws(() => run(load(edit)), e => e instanceof assert.AssertionError && e.message.startsWith(prefix));
    });
    run(load());
  }
}
const empty = (): GameMonthInput => ({ excluded: new Set(['opponent']), stakes: [], duels: [], moves: [], ledger: [], jackpots: [], events: [], voice: [], entries: [], lossDays: [], played: new Set() });
const date = (ms = 0) => new Date(Date.parse('2026-10-15T12:00:00Z') + ms);
const stake = (userId: string, id: string, extra: Partial<TitleStake> = {}): TitleStake => ({ userId, roundId: id, kind: 'wheel', pick: '20', amount: 10, payout: 20, createdAt: date(1000), roundCreatedAt: date(), roundCreatedBy: 'opponent', lockAt: date(30000), ...extra });
const duel = (userId: string, id: string, extra: Partial<TitleDuel> = {}): TitleDuel => ({ id, createdAt: date(), settledAt: date(60000), settled: true, challengerId: userId, targetId: 'opponent', game: 'dice', amount: 10, winnerId: userId, payout: 20, auto: null, rpsWins: null, ...extra });
const move = (userId: string, id: string, extra: Partial<TitleMove> = {}): TitleMove => ({ roundId: id, userId, game: 'rps', thinkMs: 2000, auto: false, kind: null, die: null, burned: null, ...extra });
function candidate(key: shared.GameTitleKey, n: number, u = 'a'): GameMonthInput {
  const i = empty();
  const ids = Array.from({ length: n }, (_, x) => `${u}-${key}-${x}`);
  switch (key) {
    case 'fortune': i.jackpots = [{ userId: u, count: n, coins: 100 }]; break;
    case 'regular': case 'twenty': case 'pensioner': case 'jet': case 'last-second': case 'night-owl':
      i.stakes = ids.map(id => stake(u, id, { pick: key === 'pensioner' ? '1' : '20', ...(key === 'last-second' ? { createdAt: date(27000) } : {}), ...(key === 'night-owl' ? { createdAt: new Date('2026-10-15T00:00:00Z') } : {}) })); break;
    case 'credit': i.ledger = [{ userId: u, family: 'wheel', net: -n }]; break;
    case 'empty-hold': i.lossDays = [{ userId: u, day: '2026-10-15', wallet: 500, loss: 400, voiceAfterSec: n }]; break;
    case 'slowpoke': i.moves = ids.map(id => move(u, id)); break;
    case 'high-roller': i.stakes = ids.map(id => stake(u, id, { amount: 100 })); break;
    case 'follower': i.stakes = ids.flatMap(id => [stake('opponent', id, { createdAt: date() }), stake(u, id)]); break;
    case 'straight-to-business': i.entries = ids.map((_, x) => ({ userId: u, entryAt: date(x * 300000), firstUnmutedAt: null })); i.stakes = ids.map((id, x) => stake(u, id, { createdAt: date(x * 300000 + 1000) })); break;
    case 'truth-streak': i.duels = ids.map((id, x) => duel(u, id, { settledAt: date(x * 60000) })); break;
    case 'king-of-hill': i.duels = ids.map((id, x) => duel(u, id, { targetId: `opponent-${x}` })); break;
    case 'fiasco': i.duels = ids.map(id => duel(u, id, { winnerId: 'opponent' })); break;
    case 'revenge': i.duels = ids.flatMap((id, x) => [duel(u, `${id}-loss`, { createdAt: date(x * 600000), settledAt: date(x * 600000 + 60000), winnerId: 'opponent' }), duel(u, id, { createdAt: date(x * 600000 + 61000), settled: false, settledAt: null, winnerId: null })]); break;
    case 'sleight-of-hand': i.duels = ids.map(id => duel(u, id, { game: 'rps', rpsWins: { challenger: 2, target: 0 } })); break;
    case 'english-exit': i.duels = ids.map(id => duel(u, id, { auto: { challenger: 1, target: 0 } })); break;
    case 'greed': i.moves = [move(u, `${u}-burn`, { game: 'greedy', kind: 'roll', die: 1, burned: n })]; break;
    case 'careful': i.duels = ids.map(id => duel(u, id, { game: 'greedy' })); i.moves = ids.map(id => move(u, id, { game: 'greedy', kind: 'stop' })); break;
    case 'vanga': i.stakes = ids.map(id => stake(u, id, { kind: 'prediction', pick: 'o1' })); break;
    case 'against-tide': case 'couch-analyst': i.stakes = ids.flatMap(id => [stake(u, id, { kind: 'prediction', pick: 'o1', amount: 10, payout: key === 'against-tide' ? 30 : 0 }), stake('opponent', id, { kind: 'prediction', pick: 'o2', amount: 90, payout: 0 })]); break;
    case 'bookmaker': i.events = ids.map(id => ({ id, createdBy: u, participants: ['opponent'] })); break;
    case 'hachiko': i.voice = [{ userId: u, seconds: n, waitedSeconds: n }]; break;
    case 'holy-goose': i.voice = [{ userId: u, seconds: n, waitedSeconds: 0 }]; break;
  }
  return i;
}
function combine(...inputs: GameMonthInput[]): GameMonthInput {
  const out = empty();
  for (const i of inputs) {
    for (const key of ['stakes', 'duels', 'moves', 'ledger', 'jackpots', 'events', 'voice', 'entries', 'lossDays'] as const) (out[key] as unknown[]).push(...i[key]);
    out.excluded = new Set([...out.excluded, ...i.excluded]); out.played = new Set([...out.played, ...i.played]);
  } return out;
}
const holders = (r: Rules, input: GameMonthInput, key: shared.GameTitleKey) => normal(r.awardTitles(input).find(a => a.key === key)?.userIds ?? []);
// high-roller не имеет числового порога плана: 0/1/2 — количество рассчитанных ставок.
const cases: [shared.GameTitleKey, number, string | null][] = [
  ['fortune', 1, 'fortune'], ['regular', 20, 'regularRounds'], ['twenty', 20, 'shareStakes'], ['pensioner', 20, 'shareStakes'], ['credit', 1000, 'credit'], ['empty-hold', 1800, 'emptyHoldVoiceSec'], ['slowpoke', 10, 'slowpokeMoves'], ['high-roller', 1, null], ['jet', 10, 'jetRounds'], ['last-second', 5, 'lastSecond'], ['follower', 5, 'follower'], ['night-owl', 10, 'nightOwl'], ['straight-to-business', 3, 'straightToBusiness'], ['truth-streak', 3, 'truthStreak'], ['king-of-hill', 3, 'kingOfHill'], ['fiasco', 10, 'fiascoDuels'], ['revenge', 3, 'revenge'], ['sleight-of-hand', 2, 'sleightOfHand'], ['english-exit', 2, 'englishExit'], ['greed', 10, 'greed'], ['careful', 5, 'carefulGames'], ['vanga', 10, 'vangaStakes'], ['against-tide', 1, 'againstTide'], ['couch-analyst', 3, 'couchAnalyst'], ['bookmaker', 2, 'bookmaker'], ['hachiko', 3600, 'hachikoSec'], ['holy-goose', 36000, 'holyGooseSec'],
];
function thresholdEdit(field: string | null, min: number): Edit {
  if (!field) return { from: 'const settledStakes = stakes.filter((s) => s.payout !== null);', to: 'const settledStakes = stakes.filter((s) => false);' };
  const line = source.split('\n').find(l => l.trimStart().startsWith(`${field}: `)); assert.ok(line, 'R339 setup: строка порога');
  return { from: line, to: `  ${field}: ${min + 1},` };
}
for (const [key, min, field] of cases) {
  test(`${key}: ниже порога нет звания, ровно порог и выше принимаются`, () => proof(`R339 порог ${key}:`, r => {
    for (const n of [min - 1, min, min + 1]) assert.equal(holders(r, candidate(key, n), key).includes('a'), n >= min, `R339 порог ${key}: ${n}`);
  }, () => [thresholdEdit(field, min)]));
  test(`${key}: полное равенство получают все подходящие, порядок стабилен`, () => proof(`R339 ничья ${key}:`, r => {
    assert.deepEqual(holders(r, combine(candidate(key, min, 'b'), candidate(key, min, 'a')), key), ['a', 'b'], `R339 ничья ${key}: всем, а не первому`);
  }, () => [key === 'holy-goose' ? { from: 'userIds: saints.map((v) => v.userId).sort(),', to: 'userIds: saints.map((v) => v.userId).sort().slice(0, 1),' }
    : key === 'high-roller' ? { from: 'userIds: [...new Set(pickFrom.map((s) => s.userId))].sort()', to: 'userIds: [...new Set(pickFrom.map((s) => s.userId))].sort().slice(0, 1)' }
      : { from: 'let tied = cands.filter((c) => c.primary === top);', to: 'let tied = cands.filter((c) => c.primary === top).slice(0, 1);' }]));
}
test('доли «20» и «1»: 49/50/51 % и 79/80/81 %, порог включён', () => proof('R339 доли:', r => {
  for (const [key, pick, threshold] of [['twenty', '20', 50], ['pensioner', '1', 80]] as const) for (const n of [threshold - 1, threshold, threshold + 1]) {
    const i = candidate(key, 100); i.stakes.forEach((s, x) => { s.pick = x < n ? pick : '5'; });
    assert.equal(holders(r, i, key).includes('a'), n >= threshold, 'R339 доли: точная доля допускается');
  }
}, () => [{ from: 'c.primary >= minShare', to: 'c.primary > minShare' }]));
test('Пустой трюм: кошелёк ≥500, доля ≥80 %, голос после ≥1800 секунд, все края', () => proof('R339 трюм:', r => {
  for (const wallet of [499, 500, 501]) { const i = candidate('empty-hold', 1800); Object.assign(i.lossDays[0], { wallet, loss: wallet }); assert.equal(holders(r, i, 'empty-hold').includes('a'), wallet >= 500, 'R339 трюм: нижний размер кошелька'); }
  for (const loss of [799, 800, 801]) { const i = candidate('empty-hold', 1800); Object.assign(i.lossDays[0], { wallet: 1000, loss }); assert.equal(holders(r, i, 'empty-hold').includes('a'), loss >= 800, 'R339 трюм: доля проигрыша на границе 80 %'); }
}, () => [{ from: 'd.wallet < TITLE_MIN.emptyHoldWallet', to: 'd.wallet <= TITLE_MIN.emptyHoldWallet' }, { from: 'share < TITLE_MIN.emptyHoldShare', to: 'share <= TITLE_MIN.emptyHoldShare' }], 2));
for (const key of ['fortune', 'regular', 'twenty', 'pensioner', 'truth-streak', 'fiasco', 'careful', 'vanga', 'against-tide', 'couch-analyst', 'bookmaker'] as const) test(`${key}: равный основной результат решает второй ключ «больше», затем всем`, () => proof(`R339 второй ${key}:`, r => {
  const min = cases.find(c => c[0] === key)![1];
  const a = candidate(key, min, 'a'); const b = candidate(key, min, 'b');
  if (key === 'fortune') b.jackpots[0].coins += 1;
  if (key === 'regular') b.stakes[0].amount += 1;
  if (key === 'twenty' || key === 'pensioner' || key === 'vanga') b.stakes.push(...b.stakes.map(s => ({ ...s, roundId: `${s.roundId}-extra` })));
  if (key === 'truth-streak') b.duels[0].payout! += 1;
  if (key === 'fiasco') b.duels.push(duel('b', 'extra-loss', { winnerId: 'opponent' }));
  if (key === 'careful') a.duels[0].winnerId = 'opponent';
  if (key === 'against-tide') b.stakes[0].payout! += 1;
  if (key === 'couch-analyst') b.stakes[0].amount += 1;
  if (key === 'bookmaker') b.events[0].participants.push('extra-participant');
  assert.deepEqual(holders(r, combine(a, b), key), ['b'], `R339 второй ${key}: больший второй ключ побеждает`);
}, () => [{ from: 'const best = Math.max(...tied.map((c) => c.secondary as number));', to: 'const best = Math.min(...tied.map((c) => c.secondary as number));' }]));
test('Крупная ставка: при равной сумме выигравшая важнее проигравшей; обе проиграли→всем', () => proof('R339 крупная:', r => {
  const a = candidate('high-roller', 1, 'a'); const b = candidate('high-roller', 1, 'b'); a.stakes[0].payout = 0;
  assert.deepEqual(holders(r, combine(a, b), 'high-roller'), ['b'], 'R339 крупная: выигрыш разрешает ничью');
  b.stakes[0].payout = 0; assert.deepEqual(holders(r, combine(a, b), 'high-roller'), ['a', 'b']);
  b.stakes[0].payout = null; assert.deepEqual(holders(r, combine(a, b), 'high-roller'), ['a']);
}, () => [{ from: 'won.length > 0 && won.length < top.length ? won : top', to: 'top' }]));
for (const key of ['jet', 'fiasco', 'careful'] as const) test(`${key}: меньшая медиана/доля выигрывает, не большая`, () => proof(`R339 минимум ${key}:`, r => {
  const min = cases.find(c => c[0] === key)![1]; const a = candidate(key, min, 'a'); const b = candidate(key, min, 'b');
  if (key === 'jet') b.stakes.forEach(s => { s.createdAt = date(2000); });
  if (key === 'fiasco') b.duels[0].winnerId = 'b';
  if (key === 'careful') Object.assign(b.moves[0], { kind: 'roll', die: 1, burned: 5 });
  assert.deepEqual(holders(r, combine(a, b), key), ['a'], `R339 минимум ${key}: направление сравнения`);
}, () => [{ from: key === 'jet' ? "give('jet', jet, 'min');" : key === 'careful' ? "give('careful', careful, 'min');" : "value: pct(c.share) })), 'min');", to: key === 'jet' ? "give('jet', jet, 'max');" : key === 'careful' ? "give('careful', careful, 'max');" : "value: pct(c.share) })), 'max');" }]));
test('Реактивный гусь: первая ставка создателя не участвует; медиана только первых ставок в разных раундах', () => proof('R339 создатель:', r => {
  const a = candidate('jet', 10, 'a'); const b = candidate('jet', 10, 'b'); b.stakes.forEach(s => { s.roundCreatedBy = 'b'; s.createdAt = date(); });
  a.stakes.push({ ...a.stakes[0], pick: '1', createdAt: date(29000) });
  assert.deepEqual(holders(r, combine(a, b), 'jet'), ['a'], 'R339 создатель: нулевое время не выигрывает');
}, () => [{ from: 'if (s.roundCreatedBy === userId) continue;', to: '' }]));
test('смелый прогноз: доля 19 % проходит, ровно 20 % и 21 % не проходят; исключённые деньги остаются', () => proof('R339 bold:', r => {
  for (const amount of [19, 20, 21]) { const i = candidate('against-tide', 1); i.stakes[0].amount = amount; i.stakes[1].amount = 100 - amount; assert.equal(holders(r, i, 'against-tide').includes('a'), amount < 20, 'R339 bold: строго меньше 20 %'); }
}, () => [{ from: ') < BOLD_SHARE);', to: ') <= BOLD_SHARE);' }, { from: 'const shares = optionShares(input.stakes);', to: 'const shares = optionShares(stakes);' }], 2));
test('боты, отказ от экономики и игр исключены из всех 27 званий; чужие ставки остаются для follower', () => proof('R339 исключение:', r => {
  for (const [key, min] of cases) for (const userId of ['bot', 'economy-out', 'games-out']) {
    const i = candidate(key, min, userId); i.excluded = new Set([...i.excluded, userId]);
    assert.deepEqual(holders(r, i, key), [], 'R339 исключение: ни одно звание не обходит ok');
  }
  assert.deepEqual(holders(r, candidate('follower', 5), 'follower'), ['a']);
}, () => [{ from: 'const ok = (userId: string) => !input.excluded.has(userId);', to: 'const ok = (userId: string) => true;' }]));
test('Святой гусь: даже отменённая игра из played лишает звания, неигравший получает', () => proof('R339 святой:', r => {
  const i = combine(candidate('holy-goose', 36000, 'a'), candidate('holy-goose', 36001, 'b')); i.played = new Set(['a']);
  assert.deepEqual(holders(r, i, 'holy-goose'), ['b'], 'R339 святой: проверяется сам факт участия');
  i.played = new Set(); assert.deepEqual(holders(r, i, 'holy-goose'), ['a', 'b']);
}, () => [{ from: '!input.played.has(v.userId) && ', to: '' }]));
test('окна последних секунд, follower, тихого входа и реванша: ±1 мс', () => proof('R339 окна:', r => {
  for (const dt of [2999, 3000, 3001]) {
    const last = candidate('last-second', 5); last.stakes.forEach(s => { s.createdAt = date(30000 - dt); }); assert.equal(holders(r, last, 'last-second').includes('a'), dt <= 3000, 'R339 окна: край последних секунд');
    const follow = candidate('follower', 5); follow.stakes.filter(s => s.userId === 'a').forEach(s => { s.createdAt = date(dt); }); assert.equal(holders(r, follow, 'follower').includes('a'), dt <= 3000);
  }
  for (const dt of [119999, 120000, 120001]) {
    const quiet = candidate('straight-to-business', 3); quiet.stakes.forEach((s, x) => { s.createdAt = date(x * 300000 + dt); }); assert.equal(holders(r, quiet, 'straight-to-business').includes('a'), dt <= 120000);
    const revenge = candidate('revenge', 3); revenge.duels.filter(d => !d.settled).forEach((d, x) => { d.createdAt = date(x * 600000 + 60000 + dt); }); assert.equal(holders(r, revenge, 'revenge').includes('a'), dt <= 120000);
  }
}, () => [{ from: '<= TITLE_WINDOW_MS.lastSecond', to: '< TITLE_WINDOW_MS.lastSecond' }]));
test('ночь 03:00..06:00 МСК; автоход не делает Тугодума, включённый микрофон не тихий вход', () => proof('R339 смысл:', r => {
  for (const iso of ['2026-10-14T23:59:59.999Z', '2026-10-15T00:00:00Z', '2026-10-15T02:59:59.999Z', '2026-10-15T03:00:00Z']) { const i = candidate('night-owl', 10); i.stakes.forEach(s => { s.createdAt = new Date(iso); }); assert.equal(holders(r, i, 'night-owl').includes('a'), iso >= '2026-10-15T00:00:00Z' && iso < '2026-10-15T03:00:00Z', 'R339 смысл: ночь без шестого часа'); }
  const slow = candidate('slowpoke', 10); slow.moves[0].auto = true; assert.deepEqual(holders(r, slow, 'slowpoke'), []);
  const quiet = candidate('straight-to-business', 3); quiet.entries[0].firstUnmutedAt = quiet.stakes[0].createdAt; assert.deepEqual(holders(r, quiet, 'straight-to-business'), []);
}, () => [{ from: 'h < NIGHT_HOURS.to', to: 'h <= NIGHT_HOURS.to' }]));
test('частичный месяц помечается только при первом раунде строго внутри окна; пороги не снижаются', () => proof('R339 частичный:', r => {
  const range = { from: date(), to: date(10000) };
  assert.equal(r.partialFrom(date(1), range)?.getTime(), date(1).getTime(), 'R339 частичный: дата первого раунда сохранена');
  for (const first of [null, date(-1), date(), date(10000), date(10001)]) assert.equal(r.partialFrom(first, range), null);
  assert.deepEqual(holders(r, candidate('regular', 19), 'regular'), []);
}, () => [{ from: 't > range.from.getTime() && t < range.to.getTime()', to: 't > range.from.getTime() && t > range.to.getTime()' }]));
