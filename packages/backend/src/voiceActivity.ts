import { previewAllows, type VoiceParticipant } from '@gusvoice/shared';
import { inArray } from 'drizzle-orm';
import { creditVoice, economyFor, type ServerEconomy } from './coins.js';
import {
  gooseTokenTtlMs,
  gooseCooldownKey,
  gooseCurrentKey,
  gooseEnabled,
  gooseOfferAllowed,
  gooseTokenKey,
} from './gooseRules.js';
import { closeSeasonIfNeeded } from './seasons.js';
import { db } from './db/index.js';
import { channels, users, voiceActivity } from './db/schema.js';
import { env } from './env.js';
import { publishToUser, redisPub } from './realtime.js';
import { id } from './util.js';
import { planSamples, SAMPLE_PERIOD_MS, type ActivitySample, type ChannelSnapshot } from './voiceActivityRules.js';

/**
 * Сбор сырой статистики присутствия в голосе — ШАГ 0 экономики GusCoins
 * (`docs/guscoins-plan.md`, «сухой прогон»).
 *
 * Здесь только Redis, база и расписание; весь расчёт — в `voiceActivityRules.ts`, где его можно
 * проверить тестом. Импорт этого модуля поднимает Pool и Redis, поэтому логике тут не место.
 *
 * ⚠️ Курсоры живут В ПАМЯТИ процесса, не в базе. Это не экономия таблицы, а осознанный выбор
 * стороны ошибки: после перезапуска бэкенда курсоров нет, первый срез каждому даёт ноль, и мы
 * теряем до минуты на человека. Курсор в базе, наоборот, пережил бы простой любой длины и записал
 * бы этот простой как присутствие — то есть тихо испортил бы ровно те данные, ради которых прогон
 * и делается. Терять минуту не жалко, придумывать час — нельзя.
 */

/** userId → момент, когда его видели в прошлый раз. */
let cursors = new Map<string, number>();

/** Собрать срез presence: активные каналы + кто в них + к какому серверу канал относится. */
async function readSnapshot(): Promise<ChannelSnapshot[]> {
  const channelIds = await redisPub.smembers('presence:channels');
  if (channelIds.length === 0) return [];

  const pipeline = redisPub.pipeline();
  for (const cid of channelIds) pipeline.get(`presence:ch:${cid}`);
  const res = await pipeline.exec();

  const live = new Map<string, VoiceParticipant[]>();
  res?.forEach(([err, val], i) => {
    if (err || typeof val !== 'string') return;
    try {
      const list = JSON.parse(val) as VoiceParticipant[];
      if (Array.isArray(list) && list.length > 0) live.set(channelIds[i], list);
    } catch {
      /* мусор в ключе — этот канал просто пропускаем */
    }
  });
  if (live.size === 0) return [];

  // Канал → сервер. Presence этого не знает вовсе (он оперирует только id канала), а кошелёк
  // посерверный, поэтому без базы не обойтись.
  const rows = await db
    .select({ id: channels.id, serverId: channels.serverId })
    .from(channels)
    .where(inArray(channels.id, [...live.keys()]));

  const out: ChannelSnapshot[] = [];
  for (const row of rows) {
    const participants = live.get(row.id);
    // Канал мог быть удалён между срезом presence и этим запросом — тогда строки просто нет, и
    // отнести время некуда. Пропускаем: сервер угадывать нельзя.
    if (participants) out.push({ channelId: row.id, serverId: row.serverId, participants });
  }
  return out;
}

/**
 * Предложить гуся, если пришло время (план, модель G).
 *
 * 🔴 Выдаётся ТОЛЬКО тем, кто прямо сейчас сидит в голосе, — тикер и обходит ровно их. Гусь за
 * «приложение открыто» доказывал бы не присутствие в разговоре, а наличие вкладки.
 *
 * 🔴 Интервал захватывается АТОМАРНО (`SET NX`) и он же решение: без этого две одновременные
 * итерации тикера выдали бы двух гусей подряд, и надбавка удвоилась бы ни за что.
 *
 * ⚠️ Провал не роняет начисление: гусь — украшение поверх экономики, и потерять из-за него уже
 * посчитанные монеты было бы худшим разменом.
 */
async function offerGoose(
  serverId: string,
  userId: string,
  economy: ServerEconomy,
  at: { peers: number },
): Promise<void> {
  if (!gooseEnabled(economy)) return;
  // Один в канале — гусь не выходит вовсе (см. `gooseOfferAllowed`).
  if (!gooseOfferAllowed(at)) return;
  try {
    // Откат от последней ПОИМКИ ещё идёт. Раньше здесь же он и ставился — теперь его ставит
    // обработчик поимки, а тик только читает.
    if ((await redisPub.exists(gooseCooldownKey(serverId, userId))) === 1) return;

    const offerId = id();
    /**
     * 🔴 Место под предложение занимаем АТОМАРНО (`NX`), и это заменило прежнюю защиту.
     *
     * Раньше от второго гуся защищал сам откат: он ставился здесь же через `SET NX`, и опоздавший
     * такт просто не получал «OK». Теперь откат ставится при поимке, а непойманного гуся больше
     * НЕКОМУ сменить — значит два такта подряд выпустили бы двух, и на экране оказалось бы
     * накопление, которого быть не должно. Ставка `cur` через `NX` — та же атомарность, только
     * теперь на самом предложении.
     */
    const took = await redisPub.set(gooseCurrentKey(serverId, userId), offerId, 'PX', gooseTokenTtlMs(), 'NX');
    if (took !== 'OK') return;
    await redisPub.set(gooseTokenKey(serverId, userId, offerId), '1', 'PX', gooseTokenTtlMs());
    await publishToUser(userId, { t: 'goose.offer', serverId, offerId });
  } catch (err) {
    console.error('[guscoins] гусь не выглянул:', (err as Error).message);
  }
}

/**
 * Начислить монеты по срезам — только тем серверам, где экономика включена.
 *
 * ⚠️ Провал начисления НЕ должен уносить сбор статистики: срезы уже записаны, и потерять их из-за
 * ошибки в кошельке было бы обиднее всего — именно они и есть то, ради чего всё затевалось.
 */
async function creditSamples(samples: ActivitySample[], now: Date): Promise<void> {
  try {
    const economies = await economyFor([...new Set(samples.map((s) => s.serverId))]);
    // 🔴 Закрываем сезон ДО начисления. Начисление сбрасывает `season_earned` лениво, у каждого в
    // свой момент; заморозь мы итоги после — первый же тикнувший человек унёс бы своё место с собой.
    for (const [serverId, economy] of economies) {
      if (economy.enabled) await closeSeasonIfNeeded(serverId, now);
    }
    for (const s of samples) {
      const economy = economies.get(s.serverId);
      if (!economy?.enabled) continue;
      // 🔴 Закрытый показ (#117): тому, кого нет в списке допуска, монеты не капают вовсе. Молча
      // копить невидимый баланс нельзя — открыв фичу людям, мы выдали бы им кошелёк, набитый за
      // время обкатки, и первое же знакомство с экономикой началось бы с необъяснимого числа.
      // ⚠️ Сырые срезы при этом пишутся всем (шаг выше): по ним потом и назначаются числа.
      if (!previewAllows(env.economyPreviewUsers, s.userId)) continue;
      await creditVoice({
        serverId: s.serverId,
        userId: s.userId,
        sample: { seconds: s.seconds, peers: s.peers, muted: s.muted, deafened: s.deafened, away: s.away },
        economy,
        now,
      });
      await offerGoose(s.serverId, s.userId, economy, { peers: s.peers });
    }
  } catch (err) {
    console.error('[guscoins] начисление не прошло:', (err as Error).message);
  }
}

/**
 * Кто из этих людей сейчас «отошёл».
 *
 * 🔴 Статус живёт в `users`, а presence о нём не знает — он оперирует микрофоном и каналом. Читаем
 * одним запросом на тик и передаём в расчёт: без этого «выключил микрофон на железе и ушёл»
 * приносило полную ставку (запрос 04.09).
 * ⚠️ Ровно `away`: «не беспокоить» и «невидимка» — заявления о том, как с человеком общаться, а не
 * о том, что его нет. Резать за них ставку значило бы штрафовать за настройку.
 */
async function awaySet(userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await db
    .select({ id: users.id, status: users.presenceStatus })
    .from(users)
    .where(inArray(users.id, userIds));
  return new Set(rows.filter((r) => r.status === 'away').map((r) => r.id));
}

async function tick(): Promise<void> {
  const channelSnapshots = await readSnapshot();
  const now = Date.now();
  const inVoice = [...new Set(channelSnapshots.flatMap((c) => c.participants.map((p) => p.userId)))];
  const away = await awaySet(inVoice);
  const { samples, cursors: nextCursors, duplicates } = planSamples(channelSnapshots, cursors, now, away);
  cursors = nextCursors;
  if (samples.length > 0) {
    await db.insert(voiceActivity).values(samples.map((s) => ({ id: id(), ...s })));
    // Сырые срезы пишутся ВСЕГДА (это шаг 0), а монеты — только там, где владелец включил
    // экономику. Одно не заменяет другое: по срезам потом пересчитывают формулу, а начисление
    // отвечает на «сколько у меня сейчас».
    await creditSamples(samples, new Date(now));
  }
  // Случай «один человек сразу в двух каналах» до сих пор был только теоретическим. Если он
  // встречается в жизни — это надо знать до того, как за минуты начнут платить.
  if (duplicates > 0) {
    console.log(`[voice-activity] ${duplicates} человек(а) сразу в нескольких каналах — лишние сессии отброшены`);
  }
}

/**
 * Запустить сбор. Без `ECONOMY_STATS_ENABLED=true` не делает ничего вовсе.
 *
 * 🔴 Умолчание — выключено, по той же причине, что и у диагностики (#113): это данные о том, кто
 * сколько часов сидит в голосе, и владелец чужого инстанса не должен начать их собирать, просто
 * обновившись. Забытая переменная обязана означать «сбора нет».
 */
export function startVoiceActivityCollector(): void {
  if (!env.economyStatsEnabled) return;
  const run = () => {
    void tick().catch((err) => {
      // Ошибка среза не должна ронять расписание: пропущенный срез — минус одна строка статистики,
      // остановившийся сборщик — минус вся неделя.
      console.error('[voice-activity] срез не записан:', (err as Error).message);
    });
  };
  const timer = setInterval(run, SAMPLE_PERIOD_MS);
  timer.unref(); // не держим процесс при остановке
  console.log(`[voice-activity] сбор статистики присутствия включён (срез раз в ${SAMPLE_PERIOD_MS / 1000} с)`);
}
