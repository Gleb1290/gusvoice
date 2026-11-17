import {
  GAME_TITLE_UNIT,
  type EconomyRecapPersonalDto,
  type EconomyRecapServerDto,
  type GameBoardRowDto,
  type GameTitleKey,
  type GameTitleUnit,
  type GamesRecapPersonalDto,
  type GamesRecapServerDto,
  type RecapDto,
  type RecapKind,
} from '@gusvoice/shared';
import { LEDGER_REASON } from './economy';
import { plural } from './plural';

/**
 * Лидерборд игр, звания месяца и «Итоги» (ГусКоины 2, этап 6) — чистые правила клиента: подписи чисел, строки таблицы,
 * монограмма звания (заглушка до иконок Codex), очередь авто-показа «Итогов» и сборка слайдов карусели из `RecapDto`.
 *
 * 🔴 Тексты — с юмором званий, но без унижения: отрицательный итог не красим и не стыдим («монеты ушли в оборот»), а
 * отказавшийся от игр или экономики приходит с `me: null` — у него нет ни личных слайдов, ни авто-показа.
 */

const MINUS = '−';

/** Число со знаком: `+120`, `−40`, `0` — длинный минус, как в журнале. */
export function signedCoins(n: number): string {
  if (n > 0) return `+${n}`;
  if (n < 0) return `${MINUS}${Math.abs(n)}`;
  return '0';
}

/** «с 14 октября» — пометка неполного первого месяца (игры включились посреди него). Кривой ISO — пустая строка. */
export function partialFromLabel(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  // Месяц игр — МСК: день считаем в Москве, а не в поясе устройства.
  return `с ${new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' })}`;
}

/** Повод звания в его единицах (`GAME_TITLE_UNIT`): «12 раз», «1 500 монет», «64 %», «1,4 с», «2 ч 05 мин», «18 очков». */
export function titleValueText(unit: GameTitleUnit, value: number, currency = 'монет'): string {
  const v = Math.round(value);
  switch (unit) {
    case 'count':
      return `${v} ${plural(v, 'раз', 'раза', 'раз')}`;
    case 'coins':
      return `${v.toLocaleString('ru-RU')} ${currency}`;
    case 'percent':
      return `${v} %`;
    case 'ms':
      return `${(value / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} с`;
    case 'minutes': {
      if (v < 60) return `${v} мин`;
      const h = Math.floor(v / 60);
      const m = v % 60;
      return m ? `${h} ч ${String(m).padStart(2, '0')} мин` : `${h} ч`;
    }
    case 'points':
      return `${v} ${plural(v, 'очко', 'очка', 'очков')}`;
  }
}

/**
 * Монограмма звания — заглушка значка, пока нет иконки `assets/titles/<key>.png` (её рисует Codex): первые буквы двух первых
 * слов названия. Название сервера, а не ключ: переименованное звание и выглядит по-новому.
 */
export function titleMonogram(name: string): string {
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  const letters = words.slice(0, 2).map((w) => w[0]!.toUpperCase());
  return letters.join('') || '?';
}

/** Разбивка строки таблицы игр — только ненулевое: «колесо +120 · дуэли −40 · джекпот ×2 · победы: кубики 3, КНБ 1». */
export function boardRowDetails(row: GameBoardRowDto): string[] {
  const out: string[] = [];
  if (row.wheel) out.push(`колесо ${signedCoins(row.wheel)}`);
  if (row.duel) out.push(`дуэли ${signedCoins(row.duel)}`);
  if (row.prediction) out.push(`прогнозы ${signedCoins(row.prediction)}`);
  if (row.jackpots > 0) out.push(`джекпот ×${row.jackpots}`);
  const wins = [
    row.duelWins.dice ? `кубики ${row.duelWins.dice}` : '',
    row.duelWins.rps ? `КНБ ${row.duelWins.rps}` : '',
    row.duelWins.greedy ? `гусь ${row.duelWins.greedy}` : '',
    row.duelWins.twentyone ? `21: ${row.duelWins.twentyone}` : '',
  ].filter(Boolean);
  if (wins.length) out.push(`победы: ${wins.join(', ')}`);
  return out;
}

// ——— «Итоги»: что уже показывали ————————————————————————————————————————————————————————————————————————————

/** Авто-показ «Итогов» старше этого после заморозки не всплывает (вернулся через полгода — не встречать прошлым). */
export const RECAP_AUTO_MAX_AGE_DAYS = 40;

export function recapSeenKey(serverId: string, kind: RecapKind): string {
  return `gv.recapSeen.${serverId}.${kind}`;
}

/** Какой период этого вида уже показывали на этом устройстве. Хранилище недоступно — `null` (покажем, это удобство). */
export function readRecapSeen(store: Pick<Storage, 'getItem'> | null | undefined, serverId: string, kind: RecapKind): string | null {
  try {
    return store?.getItem(recapSeenKey(serverId, kind)) ?? null;
  } catch {
    return null;
  }
}

export function writeRecapSeen(store: Pick<Storage, 'setItem'> | null | undefined, serverId: string, kind: RecapKind, periodId: string): void {
  try {
    store?.setItem(recapSeenKey(serverId, kind), periodId);
  } catch {
    /* приватный режим или квота — «Итоги» покажутся ещё раз, данные не страдают */
  }
}

/**
 * Показывать ли «Итоги» сами: замороженные (не черновик), с личной частью (`me` — участвовал и не отказался), этот период
 * здесь ещё не показывали и заморожены не дольше `RECAP_AUTO_MAX_AGE_DAYS` назад.
 */
export function recapAutoDue(recap: RecapDto | null | undefined, seenPeriod: string | null, nowMs: number): boolean {
  if (!recap || recap.preview || !recap.me) return false;
  if (seenPeriod === recap.periodId) return false;
  const frozen = recap.frozenAt ? Date.parse(recap.frozenAt) : NaN;
  if (!Number.isFinite(frozen)) return false;
  return nowMs - frozen <= RECAP_AUTO_MAX_AGE_DAYS * 86_400_000;
}

/** Очередь авто-показа: по одному, сначала экономика, потом игры (1-го числа могут закрыться оба). */
export function recapAutoQueue(
  cache: Partial<Record<RecapKind, RecapDto | null>> | undefined,
  seen: (kind: RecapKind) => string | null,
  nowMs: number,
): RecapKind[] {
  return (['economy', 'games'] as const).filter((k) => recapAutoDue(cache?.[k], seen(k), nowMs));
}

// ——— «Итоги»: слайды ————————————————————————————————————————————————————————————————————————————————————————

/** Сцена слайда: по ней `RecapScene` берёт картинку `assets/recap/<art>.png` (Codex) или рисует заглушку формами. */
export type RecapArt = 'cover' | 'number' | 'wheel' | 'duels' | 'predictions' | 'voice' | 'titles' | 'podium' | 'burned' | 'final';

export interface RecapStat {
  label: string;
  value: string;
}

export interface RecapPodiumPlace {
  label: string;
  userId: string | null;
  value: string;
}

export interface RecapSlide {
  key: string;
  art: RecapArt;
  title: string;
  text: string;
  /** Крупное число слайда и подпись под ним. */
  big?: string;
  bigNote?: string;
  stats?: RecapStat[];
  /** Звания: ключ, носители (пусто — «это ты»), повод. */
  titles?: { key: GameTitleKey; userIds: string[]; value: number }[];
  podium?: RecapPodiumPlace[];
  /** Доля 0–100 для шкалы (потрачено от заработанного). */
  share?: number;
  /** Любимое число колеса — подсветить сектор. */
  pick?: string;
}

export interface RecapSlideCtx {
  currency: string;
}

function placeNote(place: number | null, people: number): string | undefined {
  if (!place) return undefined;
  return people > 0 ? `${place}-е место из ${people}` : `${place}-е место`;
}

function coins(n: number, currency: string): string {
  return `${n.toLocaleString('ru-RU')} ${currency}`;
}

function hoursText(minutes: number): string {
  return titleValueText('minutes', minutes);
}

function podiumOf(
  top: string | null,
  bet: { userId: string | null; amount: number } | null,
  win: { userId: string | null; amount: number } | null,
  currency: string,
  topLabel: string,
  topValue: string,
): RecapPodiumPlace[] {
  const out: RecapPodiumPlace[] = [];
  if (top) out.push({ label: topLabel, userId: top, value: topValue });
  if (win && win.amount > 0) out.push({ label: 'Самый крупный выигрыш', userId: win.userId, value: coins(win.amount, currency) });
  if (bet && bet.amount > 0) out.push({ label: 'Самая смелая ставка', userId: bet.userId, value: coins(bet.amount, currency) });
  return out;
}

function gamesSlides(recap: RecapDto, server: GamesRecapServerDto, me: GamesRecapPersonalDto | null, ctx: RecapSlideCtx): RecapSlide[] {
  const c = ctx.currency;
  const partial = partialFromLabel(server.partialFrom);
  const slides: RecapSlide[] = [
    {
      key: 'cover',
      art: 'cover',
      title: `Итоги месяца игр · ${recap.name}`,
      text:
        `Нас было ${server.people}. Колесо крутилось ${server.rounds.wheel} ${plural(server.rounds.wheel, 'раз', 'раза', 'раз')}, ` +
        `дуэлей сыграно ${server.rounds.duel}, событий со ставками — ${server.rounds.prediction}.` +
        (partial ? ` Игры включились ${partial} — месяц неполный, но звания честные.` : ''),
    },
  ];
  if (me) {
    slides.push({
      key: 'net',
      art: 'number',
      title: 'Твой итог в играх',
      big: `${signedCoins(me.net)} ${c}`,
      bigNote: placeNote(me.place, server.people),
      text:
        me.net > 0
          ? 'Колесо и соперники остались тебе должны — в хорошем смысле. Выигрыш игровой: в сезон он не идёт.'
          : me.net < 0
            ? 'Монеты ушли в оборот и согрели стаю. Новый месяц — чистый лист, а колесо помнит только хорошее.'
            : 'Ровно в ноль — редкий талант: сыграл и ничего не потерял.',
    });
    const wheelStats: RecapStat[] = [];
    if (me.favoriteNumber) wheelStats.push({ label: 'Любимое число', value: `«${me.favoriteNumber.pick}» · ${me.favoriteNumber.count} ${plural(me.favoriteNumber.count, 'раз', 'раза', 'раз')}` });
    if (me.jackpots > 0) wheelStats.push({ label: 'Сорвал джекпот', value: `${me.jackpots} ${plural(me.jackpots, 'раз', 'раза', 'раз')} · ${coins(me.jackpotCoins, c)}` });
    if (me.biggestWin > 0) wheelStats.push({ label: 'Крупнейший выигрыш', value: coins(me.biggestWin, c) });
    if (me.wheel !== 0 || wheelStats.length) {
      slides.push({
        key: 'wheel',
        art: 'wheel',
        title: 'Твой месяц у колеса',
        big: `${signedCoins(me.wheel)} ${c}`,
        pick: me.favoriteNumber?.pick,
        stats: wheelStats,
        text: me.favoriteNumber ? `Стрелка знает тебя в лицо: на «${me.favoriteNumber.pick}» ты ставил чаще всего.` : 'Капитан запомнил твои ставки.',
      });
    }
    if (me.duels > 0) {
      const wins = me.duelWins.dice + me.duelWins.rps + me.duelWins.greedy + (me.duelWins.twentyone ?? 0);
      slides.push({
        key: 'duels',
        art: 'duels',
        title: 'Дуэли',
        big: `${wins} из ${me.duels}`,
        bigNote: 'побед',
        stats: [
          { label: 'Кубики', value: String(me.duelWins.dice) },
          { label: 'Камень-ножницы-бумага', value: String(me.duelWins.rps) },
          { label: 'Жадный гусь', value: String(me.duelWins.greedy) },
          ...(me.duelWins.twentyone ? [{ label: '21', value: String(me.duelWins.twentyone) }] : []),
          { label: 'Итог дуэлей', value: `${signedCoins(me.duel)} ${c}` },
        ],
        text: wins * 2 >= me.duels ? 'Вызывать тебя — смелое решение.' : 'Главное в дуэли — выйти на неё. Остальное — статистика.',
      });
    }
    const guessed = me.predictions.hits + me.predictions.misses;
    if (guessed > 0) {
      slides.push({
        key: 'predictions',
        art: 'predictions',
        title: 'Прогнозы',
        big: `${Math.round((me.predictions.hits / guessed) * 100)} %`,
        bigNote: 'угадано',
        stats: [
          { label: 'Угадал', value: String(me.predictions.hits) },
          { label: 'Мимо', value: String(me.predictions.misses) },
          { label: 'Итог прогнозов', value: `${signedCoins(me.prediction)} ${c}` },
        ],
        text: me.predictions.hits > me.predictions.misses ? 'Попугай-ведущий начинает нервничать.' : 'Будущее туманно — зато весело.',
      });
    }
    if (me.titles.length > 0) {
      slides.push({
        key: 'my-titles',
        art: 'titles',
        title: me.titles.length === 1 ? 'Твоё звание месяца' : 'Твои звания месяца',
        titles: me.titles.map((key) => ({ key, userIds: [], value: server.titles.find((t) => t.key === key)?.value ?? 0 })),
        text: 'Звание висит у твоего имени в таблице весь следующий месяц. Носи с гордостью — или с юмором.',
      });
    }
  }
  if (server.titles.length > 0) {
    slides.push({
      key: 'titles',
      art: 'titles',
      title: 'Звания месяца',
      titles: server.titles,
      text: 'Кто чем запомнился. Звание — повод для шутки, а не для обиды.',
    });
  }
  const podium = podiumOf(server.topUserId, server.biggestBet, server.biggestWin, c, 'Первое место таблицы', 'лучший итог');
  if (podium.length) slides.push({ key: 'podium', art: 'podium', title: 'Рекорды сервера', podium, text: 'Эти числа месяц будут вспоминать в голосе.' });
  slides.push({
    key: 'burned',
    art: 'burned',
    title: 'Сгорело',
    big: coins(server.fees, c),
    stats: server.jackpots > 0 ? [{ label: 'Джекпотов сорвано', value: `${server.jackpots} · ${coins(server.jackpotCoins, c)}` }] : undefined,
    text: 'Комиссия дуэлей и прогнозов и преимущество колеса: эти монеты ушли из оборота, чтобы остальные чего-то стоили.',
  });
  slides.push({ key: 'final', art: 'final', title: 'До следующего месяца', text: 'Таблица уже обнулилась, новые звания ждут хозяев. Колесо скучает.' });
  return slides;
}

function economySlides(recap: RecapDto, server: EconomyRecapServerDto, me: EconomyRecapPersonalDto | null, ctx: RecapSlideCtx): RecapSlide[] {
  const c = ctx.currency;
  const slides: RecapSlide[] = [
    {
      key: 'cover',
      art: 'cover',
      title: `Итоги сезона · ${recap.name}`,
      text: `Нас было ${server.people}. Вместе провели в голосе ${server.voiceHours.toLocaleString('ru-RU')} ${plural(server.voiceHours, 'час', 'часа', 'часов')}.`,
    },
  ];
  if (me) {
    slides.push({
      key: 'earned',
      art: 'number',
      title: 'Ты заработал за сезон',
      big: coins(me.earned, c),
      bigNote: placeNote(me.place, server.people),
      text: me.place === 1 ? 'Корона уже примеряется к твоей голове.' : 'Каждая монета — это минута с друзьями. Неплохо посидели.',
    });
    if (me.voiceMinutes > 0) {
      slides.push({
        key: 'voice',
        art: 'voice',
        title: 'Голос',
        big: hoursText(me.voiceMinutes),
        bigNote: 'в голосе',
        stats: me.waitedMinutes > 0 ? [{ label: 'Ждал компанию', value: hoursText(me.waitedMinutes) }] : undefined,
        text: me.waitedMinutes > 0 ? 'Ты приходил первым и ждал остальных — Хатико бы одобрил.' : 'Ты всегда приходил туда, где уже весело.',
      });
    }
    const spentStats: RecapStat[] = [{ label: 'Потрачено', value: coins(me.spent, c) }];
    if (me.tipsIn > 0) spentStats.push({ label: 'Получил типов', value: coins(me.tipsIn, c) });
    if (me.favoritePurchase) {
      const what = LEDGER_REASON[me.favoritePurchase.reason] ?? me.favoritePurchase.reason;
      spentStats.push({ label: 'Любимая покупка', value: `${what} · ${me.favoritePurchase.count} ${plural(me.favoritePurchase.count, 'раз', 'раза', 'раз')}` });
    }
    if (me.gamesNet !== null) spentStats.push({ label: 'Игры (отдельно от заработка)', value: `${signedCoins(me.gamesNet)} ${c}` });
    slides.push({
      key: 'spent',
      art: 'burned',
      title: 'Куда ушли монеты',
      stats: spentStats,
      text: me.spent > 0 ? 'Монеты для того и нужны, чтобы их тратить. Стая заметила.' : 'Копил весь сезон. Казна уважает, лавка — ждёт.',
    });
  }
  const podium = podiumOf(server.topUserId, server.biggestBet, server.biggestWin, c, 'Больше всех заработал', 'победитель сезона');
  if (podium.length) slides.push({ key: 'podium', art: 'podium', title: 'Рекорды сезона', podium, text: 'Победитель носит корону весь следующий сезон.' });
  slides.push({
    key: 'server',
    art: 'burned',
    title: 'Монеты сервера',
    big: `${server.spentPercent} %`,
    bigNote: 'заработанного потрачено',
    share: Math.max(0, Math.min(100, server.spentPercent)),
    stats: [
      { label: 'Заработано всеми', value: coins(server.earned, c) },
      { label: 'Потрачено', value: coins(server.spent, c) },
      { label: 'Сгорело налогом и комиссиями', value: coins(server.burned, c) },
      { label: 'На руках сейчас', value: coins(server.circulation, c) },
    ],
    text: 'Чем больше тратим, тем дороже каждая монета в кошельке.',
  });
  slides.push({ key: 'final', art: 'final', title: 'До следующего сезона', text: 'Таблица обнулилась, корона нашла хозяина. Встречаемся в голосе.' });
  return slides;
}

/** Слайды карусели «Итогов» по виду. Личные слайды — только при `me`; пустые разделы пропускаются. */
export function recapSlides(recap: RecapDto, ctx: RecapSlideCtx): RecapSlide[] {
  return recap.kind === 'games'
    ? gamesSlides(recap, recap.server as GamesRecapServerDto, recap.me as GamesRecapPersonalDto | null, ctx)
    : economySlides(recap, recap.server as EconomyRecapServerDto, recap.me as EconomyRecapPersonalDto | null, ctx);
}

/** Единица повода звания — для подписи в таблице и карусели. */
export function titleUnit(key: GameTitleKey): GameTitleUnit {
  return GAME_TITLE_UNIT[key];
}
