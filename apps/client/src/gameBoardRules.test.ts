import assert from 'node:assert/strict';
import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as actual from './gameBoardRules';
import * as economy from './economy';
import * as plural from './plural';
import type { EconomyRecapPersonalDto, EconomyRecapServerDto, GameBoardRowDto, GamesRecapPersonalDto, GamesRecapServerDto, RecapDto } from '@gusvoice/shared';

type Rules = typeof actual;
type Edit = { from: string; to: string };
const source = readFileSync(new URL('./gameBoardRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const plain = (value: string) => value.replace(/[\u00a0\u202f]/g, ' ');
const NOW = Date.parse('2026-10-29T12:00:00Z');
const gameServer = (): GamesRecapServerDto => ({ partialFrom: null, people: 4, rounds: { wheel: 0, duel: 0, prediction: 0 },
  jackpots: 0, jackpotCoins: 0, fees: 17, biggestBet: null, biggestWin: null, topUserId: null, titles: [] });
const gameMe = (): GamesRecapPersonalDto => ({ wheel: 0, duel: 0, prediction: 0, jackpots: 0, jackpotCoins: 0,
  duels: 0, duelWins: { dice: 0, rps: 0, greedy: 0 }, net: -4, place: 2, favoriteNumber: null,
  biggestWin: 0, predictions: { hits: 0, misses: 0 }, titles: [] });
const ecoServer = (): EconomyRecapServerDto => ({ earned: 1000, spent: 200, spentPercent: 20, burned: 10, minted: 990,
  circulation: 900, people: 4, topUserId: null, voiceHours: 17, biggestBet: null, biggestWin: null });
const ecoMe = (): EconomyRecapPersonalDto => ({ earned: 120, spent: 20, tipsIn: 0, gamesNet: null, place: 2,
  voiceMinutes: 0, waitedMinutes: 0, favoritePurchase: null });
const recap = (kind: 'games' | 'economy' = 'games'): RecapDto => ({ kind, periodId: 'm2026-10', name: 'Октябрь',
  from: '2026-09-30T21:00:00Z', to: '2026-10-31T21:00:00Z', frozenAt: new Date(NOW - 1000).toISOString(), preview: false,
  server: kind === 'games' ? gameServer() : ecoServer(), me: kind === 'games' ? gameMe() : ecoMe() });

function load(raw: string): Rules {
  const module = { exports: {} as Rules };
  const deps: Record<string, unknown> = { '@gusvoice/shared': shared, './economy': economy, './plural': plural };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require(id: string) { assert.ok(Object.hasOwn(deps, id), `R340 setup: import ${id}`); return deps[id]; } });
  return module.exports;
}
function paired(title: string, check: (r: Rules) => void, edits: Edit | Edit[]) {
  it(`R340 ${title}`, () => {
    check(actual); check(load(source));
    for (const edit of Array.isArray(edits) ? edits : [edits]) {
      counterfact(() => {
      assert.equal(source.split(edit.from).length, 2, 'R340 setup: уникальный якорь полного модуля');
      assert.throws(() => check(load(source.replace(edit.from, edit.to))), e => e instanceof assert.AssertionError && e.message.startsWith('R340 правило:'));
      });
      check(load(source));
    }
  });
}

paired('плюс, длинный минус и ноль не смешиваются', r => {
  assert.deepEqual([-100, -1, -0, 0, 1, 100].map(r.signedCoins), ['−100', '−1', '0', '0', '+1', '+100'], 'R340 правило: точные знаки монет');
}, [{ from: "const MINUS = '−';", to: "const MINUS = '-';" }, { from: "return '0';", to: "return '+0';" }]);

for (const [unit, cases] of [
  ['count', [[1, '1 раз'], [2, '2 раза'], [5, '5 раз'], [11, '11 раз'], [21, '21 раз']]],
  ['coins', [[1500, '1 500 монет'], [1.4, '1 монет']]],
  ['percent', [[0, '0 %'], [64.6, '65 %']]],
  ['ms', [[1400, '1,4 с'], [1000, '1 с'], [1550, '1,6 с']]],
  ['minutes', [[59, '59 мин'], [60, '1 ч'], [125, '2 ч 05 мин']]],
  ['points', [[1, '1 очко'], [2, '2 очка'], [5, '5 очков'], [11, '11 очков'], [21, '21 очко']]],
] as const) paired(`повод в единицах ${unit} сохраняет округления и русские окончания`, r => {
  for (const [value, expected] of cases) {
    const text = r.titleValueText(unit, value);
    assert.equal(typeof text, 'string', 'R340 правило: единица имеет текст, не пропущена в switch');
    assert.equal(plain(text), expected, 'R340 правило: число в своих единицах');
  }
  if (unit === 'coins') assert.equal(plain(r.titleValueText(unit, 1500, 'перьев')), '1 500 перьев', 'R340 правило: валюта сервера сохранена');
}, { from: `case '${unit}':`, to: `case 'disabled-${unit}':` });

paired('монограмма берёт две первые буквы слов, пустое имя получает вопрос', r => {
  for (const [name, expected] of [['', '?'], [' -- ', '?'], ['  смелый гусь третий ', 'СГ'], ['42 крыла', '4К'], ['утка', 'У']]) {
    assert.equal(r.titleMonogram(name), expected, 'R340 правило: читаемая монограмма или явная заглушка');
  }
}, [{ from: "return letters.join('') || '?';", to: "return letters.join('');" }, { from: 'words.slice(0, 2)', to: 'words.slice(0, 1)' }]);

paired('пометка неполного месяца использует день Москвы и молчит на битой дате', r => {
  for (const input of [null, undefined, '', 'bad']) assert.equal(r.partialFromLabel(input), '', 'R340 правило: битая пометка не отображается');
  assert.equal(r.partialFromLabel('2026-10-13T22:00:00Z'), 'с 14 октября', 'R340 правило: дата Москвы, а не UTC');
}, { from: "timeZone: 'Europe/Moscow'", to: "timeZone: 'UTC'" });

paired('разбивка таблицы не загромождена нулями, отрицательные итоги не теряются', r => {
  const row: GameBoardRowDto = { ...gameMe(), place: 1, userId: 'a', displayName: 'Участник', avatarUrl: null, titles: [] };
  assert.deepEqual(normal(r.boardRowDetails({ ...row, wheel: 0, duel: 0, prediction: 0 })), [], 'R340 правило: пустая разбивка действительно пуста');
  assert.deepEqual(normal(r.boardRowDetails({ ...row, wheel: 120, duel: -40, prediction: 2, jackpots: 2, duelWins: { dice: 3, rps: 1, greedy: 0 } })),
    ['колесо +120', 'дуэли −40', 'прогнозы +2', 'джекпот ×2', 'победы: кубики 3, КНБ 1'], 'R340 правило: ненулевые части и выигрыши в порядке');
}, [{ from: 'if (row.wheel)', to: 'if (row.wheel >= 0)' }, { from: 'if (row.duel)', to: 'if (row.duel > 0)' }]);

paired('автопоказ требует заморозку, личную часть, новый период и корректную дату', r => {
  const valid = recap();
  assert.equal(r.recapAutoDue(valid, null, NOW), true, 'R340 правило: свежие личные итоги показываются');
  for (const value of [null, undefined, { ...valid, preview: true }, { ...valid, me: null }, { ...valid, frozenAt: null }, { ...valid, frozenAt: 'broken' }]) {
    assert.equal(r.recapAutoDue(value, null, NOW), false, 'R340 правило: неподходящие итоги не всплывают');
  }
  assert.equal(r.recapAutoDue(valid, valid.periodId, NOW), false, 'R340 правило: показанный период не повторяется');
  assert.equal(r.recapAutoDue(valid, 'm2026-09', NOW), true, 'R340 правило: прошлый просмотр не скрывает новый период');
}, [{ from: '!recap || recap.preview || !recap.me', to: '!recap || !recap.me' }, { from: 'if (seenPeriod === recap.periodId) return false;', to: '' },
  { from: 'if (!Number.isFinite(frozen)) return false;', to: 'if (!Number.isFinite(frozen)) return true;' }]);

paired('40 дней включительно ещё показываются, на одну миллисекунду старше уже нет', r => {
  const age = 40 * 86_400_000;
  for (const offset of [-1, 0, 1]) assert.equal(r.recapAutoDue({ ...recap(), frozenAt: new Date(NOW - age - offset).toISOString() }, null, NOW), offset <= 0,
    'R340 правило: обе стороны максимального возраста');
}, { from: 'nowMs - frozen <= RECAP_AUTO_MAX_AGE_DAYS * 86_400_000', to: 'nowMs - frozen < RECAP_AUTO_MAX_AGE_DAYS * 86_400_000' });

paired('очередь по одному: экономика перед играми, уже просмотренное пропускается', r => {
  const cache = { economy: recap('economy'), games: recap('games') };
  assert.deepEqual(normal(r.recapAutoQueue(cache, () => null, NOW)), ['economy', 'games'], 'R340 правило: экономика всегда первая');
  assert.deepEqual(normal(r.recapAutoQueue(cache, kind => kind === 'economy' ? cache.economy.periodId : null, NOW)), ['games'], 'R340 правило: очередь фильтрует увиденное');
  assert.deepEqual(normal(r.recapAutoQueue(undefined, () => null, NOW)), [], 'R340 правило: пустой кеш не создаёт показ');
}, { from: "(['economy', 'games'] as const)", to: "(['games', 'economy'] as const)" });

paired('отметки просмотра разделены сервером и видом и переживают отказ storage', r => {
  const map = new Map<string, string>();
  const store = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
  r.writeRecapSeen(store, 'a', 'games', 'oct'); r.writeRecapSeen(store, 'a', 'economy', 'autumn'); r.writeRecapSeen(store, 'b', 'games', 'sep');
  assert.deepEqual(['a:games', 'a:economy', 'b:games'].map(pair => { const [s, k] = pair.split(':'); return r.readRecapSeen(store, s, k as 'games' | 'economy'); }),
    ['oct', 'autumn', 'sep'], 'R340 правило: независимые отметки');
  const broken = { getItem() { throw new Error('synthetic storage'); }, setItem() { throw new Error('synthetic storage'); } };
  assert.equal(r.readRecapSeen(broken, 'a', 'games'), null, 'R340 правило: отказ чтения безопасен');
  assert.doesNotThrow(() => r.writeRecapSeen(broken, 'a', 'games', 'oct'), 'R340 правило: отказ записи не ломает экран');
  assert.equal(r.readRecapSeen(null, 'a', 'games'), null, 'R340 правило: storage может отсутствовать');
}, { from: '`gv.recapSeen.${serverId}.${kind}`', to: '`gv.recapSeen.${serverId}`' });

paired('без личной части в игровых итогах нет личных слайдов, пустые секции пропускаются', r => {
  const input = recap(); input.me = null;
  assert.deepEqual(normal(r.recapSlides(input, { currency: 'перьев' }).map(s => s.key)), ['cover', 'burned', 'final'], 'R340 правило: только общие обязательные слайды');
  const withMe = r.recapSlides(recap(), { currency: 'перьев' });
  assert.deepEqual(normal(withMe.map(s => s.key)), ['cover', 'net', 'burned', 'final'], 'R340 правило: нулевые wheel/duels/predictions/titles пропущены');
}, [{ from: 'gamesSlides(recap, recap.server as GamesRecapServerDto, recap.me as GamesRecapPersonalDto | null, ctx)',
  to: `gamesSlides(recap, recap.server as GamesRecapServerDto, (recap.me ?? ${JSON.stringify(gameMe())}) as GamesRecapPersonalDto, ctx)` },
  { from: 'if (me.duels > 0)', to: 'if (me.duels >= 0)' }]);

paired('полные игровые итоги показывают все выбранные секции и неполный месяц в обложке', r => {
  // Ключи берём из публичного перечня, не создаём несуществующее звание в DTO.
  const key = shared.GAME_TITLE_KEYS[0];
  const input = recap(); input.server = { ...gameServer(), partialFrom: '2026-10-13T22:00:00Z', topUserId: 'a',
    titles: [{ key, userIds: ['a'], value: 5 }] };
  input.me = { ...gameMe(), wheel: -2, duels: 2, duelWins: { dice: 0, rps: 1, greedy: 0 }, predictions: { hits: 1, misses: 1 }, titles: [key] };
  const saved = normal(input), slides = r.recapSlides(input, { currency: 'перьев' });
  assert.deepEqual(normal(slides.map(s => s.key)), ['cover', 'net', 'wheel', 'duels', 'predictions', 'my-titles', 'titles', 'podium', 'burned', 'final'], 'R340 правило: полный порядок секций');
  assert.ok(slides[0].text.includes('с 14 октября') && slides[0].text.includes('неполный'), 'R340 правило: неполный первый месяц явно подписан');
  assert.deepEqual(input, saved, 'R340 правило: сборка не меняет входной DTO');
}, [{ from: '(partial ? ` Игры включились ${partial} — месяц неполный, но звания честные.` : \'\')', to: "''" },
  { from: "key: 'my-titles',", to: "key: 'lost-titles'," }]);

paired('экономические итоги без me не рисуют личное, шкала ограничена от 0 до 100', r => {
  const input = recap('economy'); input.me = null;
  assert.deepEqual(normal(r.recapSlides(input, { currency: 'монет' }).map(s => s.key)), ['cover', 'server', 'final'], 'R340 правило: общая экономика без личных слайдов');
  for (const percent of [-1, 0, 100, 101]) {
    const slides = r.recapSlides({ ...input, server: { ...ecoServer(), spentPercent: percent } }, { currency: 'монет' });
    assert.equal(slides.find(s => s.key === 'server')!.share, Math.max(0, Math.min(100, percent)), 'R340 правило: шкала не уходит за границы');
  }
}, { from: 'share: Math.max(0, Math.min(100, server.spentPercent)),', to: 'share: server.spentPercent,' });

paired('экономические личные слайды сохраняют голос/ожидание, покупки и отдельный игровой net', r => {
  const input = recap('economy'); input.me = { ...ecoMe(), voiceMinutes: 125, waitedMinutes: 59, gamesNet: -5,
    favoritePurchase: { reason: 'unknown-purchase', count: 2 } };
  const slides = r.recapSlides(input, { currency: 'перьев' });
  assert.deepEqual(normal(slides.map(s => s.key)), ['cover', 'earned', 'voice', 'spent', 'server', 'final'], 'R340 правило: личная экономика и общий итог вместе');
  assert.equal(slides.find(s => s.key === 'voice')!.big, '2 ч 05 мин', 'R340 правило: минуты голоса переведены в часы');
  assert.ok(slides.find(s => s.key === 'spent')!.stats!.some(s => s.value === '−5 перьев'), 'R340 правило: игры отдельно от заработка');
}, { from: 'if (me.gamesNet !== null)', to: 'if (false)' });
