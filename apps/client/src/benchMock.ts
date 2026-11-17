import { useSyncExternalStore } from 'react';
import { DEFAULT_GAME_TITLE_NAMES, GAME_TITLE_ABOUT, GAME_TITLE_KEYS, GAME_TITLE_UNIT, greedyHide } from '@gusvoice/shared';
import type { EconomyView, Leaderboard, UserEconomyCard } from './economy';

/**
 * Отладочный тумблер «макет чипа» из стенда эффектов (#120).
 *
 * 🔴 Почему отдельным модулем, а не полем в сторе: это состояние отладки, а не приложения. В сторе
 * оно жило бы рядом с настоящими данными и однажды попало бы туда, где его быть не должно.
 *
 * 🔴 И почему макет рисует САМ `CoinChip`, а не стенд поверх экрана. Первые две версии макета были
 * `position: fixed` — и оба раза врали: рисовались на мобильной раскладке, где сайдбар скрыт
 * целиком, и в личных сообщениях, где сайдбар вообще другой и чипа в нём нет. То есть показывали
 * полёт там, где в бою его не бывает. Единственный способ не врать — рисовать макет ровно в том
 * месте и по тем же условиям, что и настоящий чип, а значит тем же компонентом.
 */

let on = false;
const subs = new Set<() => void>();

export function setMockChip(v: boolean): void {
  if (on === v) return;
  on = v;
  for (const s of subs) s();
}

export function useMockChip(): boolean {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => on,
    () => false,
  );
}

/**
 * Макет ЭКОНОМИКИ для стенда.
 *
 * 🔴 Зачем. Экономика заперта флагом инстанса и отсутствием строки настроек — и это правильно, пока
 * фича под NDA. Но следствие: чип, кошелёк, витрина и пункт «Сильно ткнуть» не рисуются НИГДЕ, и
 * проверить их глазами нельзя вообще. Единственная альтернатива — включить экономику на бою, то
 * есть показать её людям раньше времени.
 *
 * Макет кладёт в стор синтетический снимок, и весь экономический интерфейс оживает у одного
 * человека, локально, ничего не трогая на сервере.
 *
 * 🔴 **Собирается по НАСТОЯЩЕМУ типу `EconomyView`.** Разойдись форма с сервером — упадёт сборка, а
 * не проверка. Макет, который врёт про форму, хуже отсутствующего: он показывает интерфейс,
 * которого в бою не будет.
 *
 * ⚠️ Живёт только в памяти вкладки и только пока включён тумблер. Ни в localStorage, ни на сервер
 * ничего не уходит: это отладка, а не состояние приложения.
 * ⚠️ Кнопки, которые ходят на сервер (купить, крутить ползунки), при макете честно получат отказ —
 * маршрутов экономики на инстансе нет. Макет проверяет ВИД и РАСКЛАДКУ, а не денежные пути; их
 * проверять на живой включённой экономике.
 */
let mockEconomy = false;
const econSubs = new Set<() => void>();

export function setMockEconomy(v: boolean): void {
  if (mockEconomy === v) return;
  mockEconomy = v;
  for (const s of econSubs) s();
}

export function useMockEconomy(): boolean {
  return useSyncExternalStore(
    (cb) => {
      econSubs.add(cb);
      return () => econSubs.delete(cb);
    },
    () => mockEconomy,
    () => false,
  );
}

export function isMockEconomy(): boolean {
  return mockEconomy;
}

/**
 * Карточка ЧУЖОЙ экономики для стенда: уровень и баланс в профиле участника.
 *
 * 🔴 Без неё блок в карточке профиля не проверить вовсе, пока экономика выключена: настоящий запрос
 * честно вернёт «показывать нечего», и стенд покажет пустоту — то есть будет выглядеть исправным.
 * Ровно та же ловушка, что уже поймалась на короне.
 *
 * ⚠️ Числа НЕ те же, что у себя: баланс и уровень должны отличаться от собственных, иначе
 * перепутанные местами «мой» и «чужой» источники прошли бы проверку незамеченными.
 */
export function mockUserCard(): UserEconomyCard {
  return { balance: 412, level: { level: 6, title: 'Свой в стае', points: 3240, nextAt: 4410, progress: 0.61 } };
}

/**
 * Синтетический снимок экономики.
 *
 * Числа выбраны так, чтобы разом было видно и обычное состояние, и края: баланс НЕ круглый (иначе
 * не заметишь выравнивание цифр), его хватает на одну награду и не хватает на другую — то есть
 * серое состояние пункта меню видно сразу, без подгонки.
 */
export function mockEconomyView(currencyName = 'ГусКоины', crownUserId?: string): EconomyView {
  return {
    enabled: true,
    currencyName,
    iconUrl: null,
    canManage: true,
    awayPercent: 25,
    settings: {
      enabled: true,
      currencyName,
      iconUrl: null,
      ratePer5min: 10,
      alonePercent: 25,
      companyPercent: 150,
      dailyCap: 400,
      aloneCap: 90,
      decayAfterMinutes: 120,
      decayPercent: 50,
      mutedPercent: 100,
      deafenedPercent: 25,
      awayPercent: 25,
      payoutMinutes: 10,
      compensateOnRaise: false,
      tipAmount: 5,
      tipTaxPercent: 20,
      tipDailyOut: 100,
      tipDailyIn: 100,
      tipDailyPair: 25,
      seasonLength: 'quarter',
      gooseBonus: 5,
      gooseMinutes: 20,
      gooseDeafenedBonus: 2,
      streakBonus: 3,
      retroGrantedAt: null,
      // Игры включены в макете, чтобы стенд рисовал и раздел панели, и блок кошелька (ГусКоины 2).
      gamesEnabled: true,
      gamesBetMax: 300,
      gamesDailyLossMax: 3000,
      gamesFeePercent: 10,
      gamesPairDailyMax: 1000,
    },
    gamesEnabled: true,
    gamesDailyLossMax: 3000,
    // Баланс подобран так, чтобы в макете жили ОБЕ ветки витрины: щипка и саундборда хватает,
    // на аватар — заведомо нет. Иначе состояние «не хватает» не отрисовывается вовсе.
    wallet: { balance: 620, earnedTotal: 3480, seasonEarned: 1730, optedOut: false, tipsOptOut: false, aloneEarnedToday: 30,
      // Предел ниже потолка и отложенное повышение — видны обе строки подсказки.
      games: { optOut: false, lossLimit: 1000, lossLimitRaise: { value: 2000, from: '2026-07-02T21:00:00.000Z' }, lossToday: 240, effectiveLimit: 1000 } },
    season: { id: 'summer-2026', name: 'Лето 2026' },
    // Середина ступени: видно и полоску прогресса, и звание, и оба числа рядом.
    level: { level: 9, title: 'Свой в стае', points: 3076, nextAt: 3600, progress: 0.42 },
    // Та же лестница, что отдаёт сервер (`levelStages`): три ступени пройдены, «Матёрый гусь» — следующая.
    levelStages: [
      { title: 'Птенец', at: 0 },
      { title: 'Гусёнок', at: 360 },
      { title: 'Свой в стае', at: 1440 },
      { title: 'Матёрый гусь', at: 4000 },
      { title: 'Вожак', at: 9000 },
      { title: 'Старейшина', at: 16_000 },
      { title: 'Легенда стаи', at: 27_040 },
      { title: 'Тот самый Гусь', at: 43_560 },
    ],
    // Серия: четвёртый день подряд, сегодня уже засчитан — видно и залитые точки, и «сегодня +N».
    streak: { enabled: true, today: '2026-09-03', days: 4, todayCounted: true, todayReward: 12, nextReward: 15, bonus: 3, maxDays: 7 },
    /**
     * Корона на СЕБЕ: чужого победителя в макете взять неоткуда, а посмотреть регалии надо.
     *
     * 🔴 Идёт НАСТОЯЩИМ идентификатором, а не строкой-заглушкой: корону рисуют сравнением с
     * `userId` человека в списке, и любое выдуманное значение не совпадёт НИ С КЕМ. Стенд показывал
     * бы пустоту и выглядел бы исправным — худший вид поломки для проверочного инструмента.
     */
    crown: crownUserId ? { userId: crownUserId, seasonId: 'spring-2026', earned: 4120 } : null,
    shop: [
      {
        item: 'mega-poke',
        label: 'Щипок',
        hint: 'Перья, звук и тряска окна тому, кого выбрал. Весь канал увидит, от кого прилетело.',
        priceMinutes: 200,
        // 200 минут при ставке 10 за 5 минут = 400 монет: на балансе 620 это по карману.
        priceCoins: 400,
        enabled: true,
        target: 'user',
      },
      /**
       * Саундборд — вторая позиция витрины, и в макете она обязана быть: кнопка в доке голоса
       * появляется ИМЕННО по ней, а не по общему тумблеру экономики. Без этой строки стенд не
       * показывал бы саундборд вовсе, и это выглядело бы как «фича не приехала».
       */
      {
        item: 'soundboard',
        label: 'Выстрел саундборда',
        hint: 'Проиграть короткий звук всем, кто сидит с тобой в голосовом канале.',
        priceMinutes: 8,
        // 8 минут при ставке 10 за 5 минут = 16 монет: дёшево, как и задумано.
        priceCoins: 16,
        enabled: true,
        target: 'channel',
      },
      /**
       * Безадресная награда — ЕДИНСТВЕННАЯ, у которой в витрине есть кнопка «Купить». Без неё в
       * макете эта ветка отрисовки не проверяется вовсе, а она отличается от остальных двух.
       */
      {
        item: 'animated-avatar',
        label: 'Анимированный аватар',
        hint: 'Разрешает загрузить движущийся аватар на 30 дней. Работает на ВСЕХ серверах. Продлевается покупкой: купишь заранее — дни прибавятся к остатку.',
        priceMinutes: 1500,
        // 1500 минут при ставке 10 за 5 минут = 3000 монет: на балансе 620 заведомо не хватает,
        // и это намеренно — так в макете видно и состояние «не хватает».
        priceCoins: 3000,
        enabled: true,
        target: 'none',
        floor: { minutes: 1500, coins: 3000 },
        serverMinutes: null,
        rentalMaxDays: 60,
      },
    ],
  };
}

/**
 * Синтетическая таблица лидеров для стенда.
 *
 * ⚠️ Числа подобраны так, чтобы разом были видны все состояния: корона у одного, разрыв между
 * первым и последним, разные уровни и звания, и я сам где-то в середине — иначе «моя строка
 * выделена» проверить нечем.
 */
export function mockLeaderboard(meId: string, meName: string): Leaderboard {
  const person = (place: number, userId: string, displayName: string, earned: number, level: number, title: string) => ({
    place,
    userId,
    displayName,
    avatarUrl: null,
    earned,
    level: { level, title, points: level * level * 90 + 40, nextAt: (level + 1) * (level + 1) * 90, progress: 0.35 },
  });
  return {
    season: { id: 'summer-2026', name: 'Лето 2026' },
    crown: { userId: 'crown-1', seasonId: 'spring-2026', earned: 4120 },
    people: [
      person(1, 'crown-1', 'Первое место', 3180, 14, 'Матёрый гусь'),
      person(2, 'second', 'Второе место', 2740, 12, 'Матёрый гусь'),
      person(3, meId, meName, 1960, 9, 'Свой в стае'),
      person(4, 'fourth', 'Четвёртое место', 1210, 7, 'Свой в стае'),
      person(5, 'fifth', 'Пятое место', 240, 2, 'Птенец'),
    ],
  };
}

/**
 * Колесо гусей-пиратов для стенда (ГусКоины 2, этап 2): снимок раунда без сервера — вид сцены, таймер, вращение и
 * «Проверить честность» (зерно и замок здесь НЕ сходятся: проверка честно скажет «✗», это макет, а не раунд).
 * `open` — идёт окно ставок (8 с до блокировки), `locked` — колесо крутится до сектора 4 («3»), `result` — итог.
 */
export function mockWheelSnapshot(
  serverId: string,
  kind: 'open' | 'locked' | 'result',
  meId?: string,
  nowMs = Date.now(),
): import('@gusvoice/shared').WheelSnapshotDto {
  const me = meId ?? 'me';
  const iso = (ms: number) => new Date(nowMs + ms).toISOString();
  const commit = '9f2c7a41d0b85e36c4a1f07e2d9b6c58a3e1f4d7b2c09a86e5d3f1b4c7a2e908';
  const bets = [
    { userId: 'bench-goose-1', pick: 1 as const, amount: 100 },
    { userId: me, pick: 5 as const, amount: 50 },
    { userId: 'bench-goose-2', pick: 20 as const, amount: 10 },
    { userId: me, pick: 1 as const, amount: 20 },
    { userId: 'bench-goose-1', pick: 3 as const, amount: 30 },
  ];
  const last = {
    id: 'bench-round-0',
    sector: 12,
    seed: '4c1d8e2fa7b03956e1d4c8f02a7b3e5916c0d4f8a2e7b1c3d5f9e0a4b6c8d2e1',
    commit,
    jackpotHit: false,
    jackpotPaid: 0,
    settledAt: iso(-4000),
    winners: [{ userId: me, pick: 5 as const, payout: 287 }],
  };
  const base = { serverId, serverNow: iso(0), enabled: true, betMax: 300, jackpot: 1240 };
  if (kind === 'result') return { ...base, round: null, last, cooldownUntil: iso(6000) };
  return {
    ...base,
    round: {
      id: 'bench-round-1',
      state: kind,
      lockAt: kind === 'open' ? iso(8000) : iso(-500),
      settleAt: kind === 'locked' ? iso(6000) : null,
      commit,
      sector: kind === 'locked' ? 4 : null,
      bets,
    },
    last: kind === 'open' ? last : null,
    cooldownUntil: null,
  };
}

/**
 * Гусиная дуэль для стенда (ГусКоины 2, этап 3): снимок партии без сервера. `invite` — вызов мне (карточка «Принять»),
 * `waiting` — я вызвал и жду, `playing` — первый бросок, соперник уже бросил, `draw` — ничья, идёт переброс, `settled` —
 * итог (я победил). Зерно и замок макета НЕ сходятся: «Проверить честность» честно скажет «✗».
 */
export function mockDuelSnapshot(
  serverId: string,
  channelId: string,
  kind: 'invite' | 'waiting' | 'playing' | 'draw' | 'settled',
  meId?: string,
  nowMs = Date.now(),
): import('@gusvoice/shared').DuelSnapshotDto {
  const me = meId ?? 'me';
  const peer = 'bench-goose-1';
  const iso = (ms: number) => new Date(nowMs + ms).toISOString();
  const base: import('@gusvoice/shared').DuelDto = {
    id: `bench-duel-${kind}`,
    serverId,
    channelId,
    game: 'dice',
    challengerId: kind === 'invite' ? peer : me,
    targetId: kind === 'invite' ? me : peer,
    amount: 100,
    feePercent: 10,
    state: 'invited',
    inviteUntil: iso(22_000),
    commit: '5b8e0d3a9c71f2e46d0a8b3c5e7f1924a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6',
    rollNo: 0,
    turnUntil: null,
    rolls: [],
    winnerId: null,
    payout: null,
    seed: null,
    reason: null,
    settledAt: null,
  };
  if (kind === 'invite') return { duel: null, myInvite: base, serverNow: iso(0) };
  if (kind === 'waiting') return { duel: base, myInvite: null, serverNow: iso(0) };
  const playing = { ...base, state: 'playing' as const, inviteUntil: null, turnUntil: iso(11_000) };
  if (kind === 'playing') return { duel: { ...playing, rolls: [{ challenger: null, target: [4, 2] }] }, myInvite: null, serverNow: iso(0) };
  if (kind === 'draw')
    return { duel: { ...playing, rollNo: 1, rolls: [{ challenger: [3, 4], target: [5, 2] }] }, myInvite: null, serverNow: iso(0) };
  return {
    duel: {
      ...playing,
      state: 'settled',
      turnUntil: null,
      rollNo: 1,
      rolls: [
        { challenger: [3, 4], target: [5, 2] },
        { challenger: [6, 5], target: [2, 3] },
      ],
      winnerId: me,
      payout: 180,
      seed: '7d2a9e4c1b0f8356a2e9d4c7b1f0e3a85c6d2b9f4e1a7c0d3b8e5f2a9c4d1e6b',
      settledAt: iso(-3000),
    },
    myInvite: null,
    serverNow: iso(0),
  };
}

/** Макеты игр с выбором (этап 4) для стенда — подписи кнопок `EffectsBench`. */
export const MOCK_CHOICE_DUELS = {
  'rps-move': 'КНБ: мой ход',
  'rps-wait': 'КНБ: сходил, жду',
  'rps-settled': 'КНБ: итог',
  'greedy-turn': 'гусь: мой ход',
  'greedy-burn': 'гусь: сгорело',
  'greedy-settled': 'гусь: итог',
} as const;
export type MockChoiceDuel = keyof typeof MOCK_CHOICE_DUELS;

/**
 * Снимок партии «Камень-ножницы-бумага» / «Жадный гусь» без сервера (этап 4). `rps-move` — раунд 3, соперник готов, я
 * выбираю; `rps-wait` — я сходил (`myHand`); `rps-settled` — 2:1 мне; `greedy-turn` — мой ход, копилка 9;
 * `greedy-burn` — у соперника сгорело (сумма скрыта), ход мой; `greedy-settled` — я набрал 20 (счёт соперника раскрыт). Зерно и замок не сходятся (✗).
 */
export function mockChoiceDuelSnapshot(
  serverId: string,
  channelId: string,
  kind: MockChoiceDuel,
  meId?: string,
  nowMs = Date.now(),
): import('@gusvoice/shared').DuelSnapshotDto {
  const me = meId ?? 'me';
  const peer = 'bench-goose-1';
  const iso = (ms: number) => new Date(nowMs + ms).toISOString();
  const settled = kind.endsWith('settled');
  const base: import('@gusvoice/shared').DuelDto = {
    id: `bench-duel-${kind}`,
    serverId,
    channelId,
    game: kind.startsWith('rps') ? 'rps' : 'greedy',
    challengerId: me,
    targetId: peer,
    amount: 100,
    feePercent: 10,
    state: settled ? 'settled' : 'playing',
    inviteUntil: null,
    commit: '5b8e0d3a9c71f2e46d0a8b3c5e7f1924a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6',
    rollNo: 0,
    turnUntil: null,
    rolls: [],
    winnerId: settled ? me : null,
    payout: settled ? 180 : null,
    seed: settled ? '7d2a9e4c1b0f8356a2e9d4c7b1f0e3a85c6d2b9f4e1a7c0d3b8e5f2a9c4d1e6b' : null,
    reason: null,
    settledAt: settled ? iso(-3000) : null,
    moveUntil: settled ? null : iso(14_000),
  };
  if (base.game === 'rps') {
    const rounds: NonNullable<import('@gusvoice/shared').DuelDto['rps']>['rounds'] = [
      { challenger: 'rock', target: 'paper', winner: 'target' },
      { challenger: 'scissors', target: 'scissors', winner: null },
      { challenger: 'paper', target: 'rock', winner: 'challenger' },
    ];
    if (settled) rounds.push({ challenger: 'rock', target: 'scissors', winner: 'challenger' });
    const wins = { challenger: settled ? 2 : 1, target: 1 };
    const ready = { challenger: kind === 'rps-wait', target: true };
    return {
      duel: { ...base, rps: { rounds, ready: settled ? { challenger: false, target: false } : ready, wins, seq: rounds.length } },
      myInvite: null,
      serverNow: iso(0),
      ...(kind === 'rps-wait' ? { myHand: 'scissors' as const } : {}),
    };
  }
  const greedy: NonNullable<import('@gusvoice/shared').DuelDto['greedy']> =
    kind === 'greedy-turn'
      ? { scores: { challenger: 6, target: 11 }, turn: 'challenger', turnPoints: 9, lastRoll: { by: 'challenger', die: 5 }, burned: 0, timeouts: { challenger: 0, target: 1 }, seq: 9, first: 'target', rolls: [4, 3, 4, 1, 6, 5, 4, 5] }
      : kind === 'greedy-burn'
        ? { scores: { challenger: 6, target: 11 }, turn: 'challenger', turnPoints: 0, lastRoll: { by: 'target', die: 1 }, burned: 11, timeouts: { challenger: 0, target: 0 }, seq: 9, first: 'target', rolls: [4, 3, 4, 6, 1, 6, 5, 1] }
        : { scores: { challenger: 21, target: 15 }, turn: 'challenger', turnPoints: 0, lastRoll: { by: 'challenger', die: 6 }, burned: 0, timeouts: { challenger: 0, target: 0 }, seq: 14, first: 'target', rolls: [4, 3, 4, 6, 1, 6, 5, 4, 3, 2, 6, 5, 6] };
  // Как у сервера с 29.10: пока идут ходы, счёт, копилка и броски соперника скрыты маской (`greedyHide`), на итоге — всё.
  return { duel: { ...base, greedy: settled ? greedy : greedyHide(greedy, 'challenger') }, myInvite: null, serverNow: iso(0) };
}

/**
 * Ставки на события для стенда (ГусКоины 2, этап 5): лента без сервера. `open` — два события: моё живое (я веду, приём
 * ставок, таймер 4 мин) и чужое с моей ставкой на одном вопросе; `locked` — приём закрыт, ждём итога (я веду — «Подвести
 * итог»); `settled` — итог: угадал первый вопрос, второй не состоялся; `cancelled` — отменено создателем; `empty` — лента
 * пустая. Ставка на стенде ложится в макет локально (`Predictions.tsx` `mockBet`).
 */
export function mockPredictionsSnapshot(
  serverId: string,
  kind: 'open' | 'locked' | 'settled' | 'cancelled' | 'empty',
  meId?: string,
  canManage = true,
  nowMs = Date.now(),
): import('@gusvoice/shared').PredictionSnapshotDto {
  type Ev = import('@gusvoice/shared').PredictionEventDto;
  type Q = import('@gusvoice/shared').PredictionQuestionDto;
  const me = meId ?? 'me';
  const iso = (ms: number) => new Date(nowMs + ms).toISOString();
  const q = (id: string, pos: number, question: string, opts: [string, number, number][], bets: Q['bets'] = []): Q => ({
    id,
    pos,
    question,
    options: opts.map(([label, pool, bettors], i) => ({ id: `o${i + 1}`, label, pool, bettors })),
    pool: opts.reduce((s, [, p]) => s + p, 0),
    winnerOptionId: null,
    void: false,
    fee: null,
    bets,
    mine: null,
  });
  const base = (id: string, title: string, createdBy: string, questions: Q[], ago: number): Ev => ({
    id,
    serverId,
    title,
    createdBy,
    state: 'open',
    lockAt: iso(4 * 60_000 + 5_000),
    createdAt: iso(-ago),
    lockedAt: null,
    settledAt: null,
    cancelReason: null,
    autoCancelAt: null,
    feePercent: 10,
    questions,
  });
  const match = base(
    'bench-ev-1',
    'Финал вечернего турнира: «Гуси» против «Уток»',
    'bench-goose-1',
    [
      q('q1', 0, 'Кто победит?', [['Гуси', 640, 7], ['Утки', 260, 3], ['Ничья', 50, 1]], [
        { userId: me, optionId: 'o1', amount: 100, payout: null, refunded: false },
      ]),
      q('q2', 1, 'Будет ли овертайм?', [['Да', 120, 2], ['Нет', 300, 4]]),
    ],
    60_000,
  );
  const mine = base('bench-ev-2', 'Сколько смертей у капитана за катку?', me, [q('q3', 0, 'Смертей у капитана', [['0–3', 150, 2], ['4–7', 220, 3], ['8 и больше', 90, 1]])], 20_000);
  mine.lockAt = null;
  let events: Ev[];
  if (kind === 'empty') events = [];
  else if (kind === 'open') events = [mine, match];
  else if (kind === 'locked') events = [{ ...mine, state: 'locked', lockedAt: iso(-30_000), autoCancelAt: iso(7 * 86_400_000 - 30_000) }];
  else if (kind === 'cancelled') events = [{ ...match, state: 'cancelled', lockAt: null, settledAt: iso(-5_000), cancelReason: 'creator' }];
  else {
    const [q1, q2] = match.questions;
    events = [
      {
        ...match,
        state: 'settled',
        lockAt: null,
        lockedAt: iso(-120_000),
        settledAt: iso(-3_000),
        questions: [
          { ...q1, winnerOptionId: 'o1', fee: 31, bets: [{ userId: me, optionId: 'o1', amount: 100, payout: 143, refunded: false }] },
          { ...q2, void: true, fee: 0 },
        ],
      },
    ];
  }
  return { serverId, serverNow: iso(0), enabled: true, betMax: 300, canManage, events };
}

/**
 * Таблица игр, звания и «Итоги» для стенда (ГусКоины 2, этап 6): синтетика без сервера, рисуется теми же компонентами.
 * Числа подобраны так, чтобы были видны все состояния: я в середине, двое в минусе в хвосте, джекпоты, победы дуэлей по
 * видам, звания у строк, неполный первый месяц («с 14 октября»).
 */
export function mockGameLeaderboard(meId: string, meName: string, period: 'month' | 'season' = 'month'): import('@gusvoice/shared').GameLeaderboardDto {
  type Row = import('@gusvoice/shared').GameBoardRowDto;
  const row = (place: number, userId: string, displayName: string, wheel: number, duel: number, prediction: number, extra: Partial<Row> = {}): Row => ({
    place,
    userId,
    displayName,
    avatarUrl: null,
    wheel,
    duel,
    prediction,
    net: wheel + duel + prediction,
    jackpots: 0,
    jackpotCoins: 0,
    duels: 0,
    duelWins: { dice: 0, rps: 0, greedy: 0 },
    titles: [],
    ...extra,
  });
  return {
    enabled: true,
    period:
      period === 'month'
        ? { kind: 'month', id: 'm2026-10', name: 'Октябрь 2026', from: '2026-09-30T21:00:00.000Z', to: '2026-10-31T21:00:00.000Z' }
        : { kind: 'season', id: 'autumn-2026', name: 'Осень 2026', from: '2026-08-31T21:00:00.000Z', to: '2026-11-30T21:00:00.000Z' },
    frozen: false,
    people: [
      row(1, 'bench-goose-1', 'Боцман Гоша', 1840, 320, 150, { jackpots: 2, jackpotCoins: 1210, duels: 9, duelWins: { dice: 4, rps: 2, greedy: 1 }, titles: ['fortune', 'truth-streak'] }),
      row(2, meId, meName, 410, 120, 85, { duels: 5, duelWins: { dice: 1, rps: 2, greedy: 0 }, titles: ['jet'] }),
      row(3, 'bench-goose-2', 'Юнга', 60, 0, 40, { titles: ['vanga'] }),
      row(4, 'bench-goose-3', 'Кок', -230, 40, 0, { duels: 3, duelWins: { dice: 1, rps: 0, greedy: 0 } }),
      row(5, 'bench-goose-4', 'Штурман', -1260, -150, 0, { duels: 4, titles: ['credit'] }),
    ],
    titleNames: { ...DEFAULT_GAME_TITLE_NAMES, regular: 'Завсегдатай палубы' },
  };
}

/** Звания прошлого месяца: часть выдана (я — «Реактивный гусь»), одно переименовано, часть не выдана никому. */
export function mockGameTitles(meId: string, canManage = true): import('@gusvoice/shared').GameTitlesDto {
  const holders: Partial<Record<import('@gusvoice/shared').GameTitleKey, [string, string, number][]>> = {
    fortune: [['bench-goose-1', 'Боцман Гоша', 2]],
    regular: [['bench-goose-1', 'Боцман Гоша', 64]],
    credit: [['bench-goose-4', 'Штурман', 1410]],
    jet: [[meId, 'Капитан', 1400]],
    'truth-streak': [['bench-goose-1', 'Боцман Гоша', 5]],
    vanga: [['bench-goose-2', 'Юнга', 72]],
    hachiko: [['bench-goose-3', 'Кок', 135]],
    'holy-goose': [['bench-goose-5', 'Лоцман', 2460], ['bench-goose-6', 'Плотник', 2100]],
  };
  return {
    month: { id: 'm2026-09', name: 'Сентябрь 2026', partialFrom: '2026-09-14T09:00:00.000Z' },
    canManage,
    titles: GAME_TITLE_KEYS.map((key) => {
      const renamed = key === 'regular';
      return {
        key,
        name: renamed ? 'Завсегдатай палубы' : DEFAULT_GAME_TITLE_NAMES[key],
        defaultName: DEFAULT_GAME_TITLE_NAMES[key],
        renamed,
        about: GAME_TITLE_ABOUT[key],
        unit: GAME_TITLE_UNIT[key],
        holders: (holders[key] ?? []).map(([userId, displayName, value]) => ({ userId, displayName, avatarUrl: null, value })),
      };
    }),
  };
}

/** «Итоги» месяца игр и сезона экономики; `preview` — черновик управляющего (без заморозки). */
export function mockRecap(kind: import('@gusvoice/shared').RecapKind, meId: string, preview: boolean): import('@gusvoice/shared').RecapDto {
  const base = {
    preview,
    frozenAt: preview ? null : new Date(Date.now() - 3_600_000).toISOString(),
  };
  if (kind === 'games') {
    return {
      ...base,
      kind,
      periodId: 'm2026-10',
      name: 'Октябрь 2026',
      from: '2026-09-30T21:00:00.000Z',
      to: '2026-10-31T21:00:00.000Z',
      server: {
        partialFrom: '2026-10-14T09:00:00.000Z',
        people: 9,
        rounds: { wheel: 214, duel: 37, prediction: 6 },
        jackpots: 3,
        jackpotCoins: 4120,
        fees: 2380,
        biggestBet: { userId: 'bench-goose-4', amount: 1500 },
        biggestWin: { userId: 'bench-goose-1', amount: 3450 },
        topUserId: 'bench-goose-1',
        titles: [
          { key: 'fortune', userIds: ['bench-goose-1'], value: 2 },
          { key: 'jet', userIds: [meId], value: 1400 },
          { key: 'credit', userIds: ['bench-goose-4'], value: 1410 },
          { key: 'vanga', userIds: ['bench-goose-2'], value: 72 },
          { key: 'holy-goose', userIds: ['bench-goose-5', 'bench-goose-6'], value: 2460 },
        ],
      },
      me: {
        wheel: 410,
        duel: 120,
        prediction: 85,
        net: 615,
        place: 2,
        jackpots: 1,
        jackpotCoins: 380,
        duels: 5,
        duelWins: { dice: 1, rps: 2, greedy: 0 },
        favoriteNumber: { pick: '5', count: 23 },
        biggestWin: 940,
        predictions: { hits: 4, misses: 2 },
        titles: ['jet'],
      },
    };
  }
  return {
    ...base,
    kind,
    periodId: 'autumn-2026',
    name: 'Осень 2026',
    from: '2026-08-31T21:00:00.000Z',
    to: '2026-11-30T21:00:00.000Z',
    server: {
      earned: 186_400,
      spent: 61_200,
      spentPercent: 33,
      burned: 9_840,
      minted: 176_560,
      circulation: 112_300,
      people: 17,
      topUserId: 'bench-goose-1',
      voiceHours: 1_284,
      biggestBet: { userId: 'bench-goose-4', amount: 1500 },
      biggestWin: { userId: null, amount: 3450 },
    },
    me: {
      earned: 12_840,
      spent: 3_900,
      tipsIn: 420,
      gamesNet: 615,
      place: 3,
      voiceMinutes: 7_260,
      waitedMinutes: 95,
      favoritePurchase: { reason: 'shop.mega-poke', count: 14 },
    },
  };
}
