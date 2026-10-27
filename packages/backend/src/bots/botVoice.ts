/**
 * Боты в голосовом канале (#232, этап 4; ТЗ `bots-phase4/SPEC.md` §1.1, §2.4): методы Bot API `joinVoice` / `leaveVoice` /
 * `getVoiceChatMembers`, выкидывание из комнат `dropBotVoice`, перенос модератором `moveBotVoice` и страховочный обход
 * `sweepBotVoice` (раз в минуту из `startBotJobs`).
 *
 * Грузится ЛЕНИВО (`routes/botApi.ts` — закрытый перечень импортов; `routes/voice.ts`, `routes/bots.ts`, `botLifecycle.ts`,
 * `botChannel.ts`, `webhookDelivery.ts` — через `import()`), поэтому LiveKit-клиент поднимается только там, где боты нужны.
 *
 * Правила:
 * - личность в LiveKit — обычный id пользователя бота; бот людей НЕ слышит (`canSubscribe: false`, `livekit.ts`);
 * - на сервере у бота один голосовой канал: вход в другой канал того же сервера — переход (старая комната закрывается);
 * - кто где сидит — по срезу presence (`presence:ch:*`, тот же источник, что видит клиент) плюс отметки «заходит» (вебхук
 *   LiveKit до presence доходит с задержкой): `bot:vc:pend:ch:<канал>` / `bot:vc:pend:bot:<бот>` — множества с оценкой
 *   «годно до» (мс), живут `PENDING_S`;
 * - бот один в канале (людей нет) дольше `BOT_VOICE_ALONE_S` — выкидывается (решение владельца 27.10). Начало одиночества —
 *   `bot:vc:alone:<канал>` (unix с), ставит подписка presence (`botVoiceEvents.ts`) и обход (если подписка пропустила).
 */
import { has, Permission, roomForChannel, type VoiceParticipant } from '@gusvoice/shared';
import { eq, inArray } from 'drizzle-orm';
import { rateHit } from '../authGuard.js';
import { db } from '../db/index.js';
import { channels } from '../db/schema.js';
import { env } from '../env.js';
import { createBotVoiceToken, disconnectUser } from '../livekit.js';
import { getChannelPermissions } from '../permissions.js';
import { redisPub, voiceServerMuteKey } from '../realtime.js';
import { botOnServer, wireUsers } from './botChannel.js';
import {
  BOT_SERVER_RATE,
  BOT_VOICE_ALONE_S,
  BOT_VOICE_BITRATE,
  BOT_VOICE_JOIN_RATE,
  BOT_VOICE_TOKEN_TTL_S,
  BotApiError,
  type BotVoiceInput,
  botAloneExpired,
  botAloneSince,
  botVoiceDecision,
  botVoiceEnabled,
  unixSeconds,
} from './botRules.js';
import { type BotRow, liveBotsAmong, pushUpdates, readBotSettings, type UserRow } from './botStore.js';
import { getVoiceChatMembersParams, joinVoiceParams, leaveVoiceParams, voiceChat, type WireVoiceChatMember } from './botWire.js';

type ChannelRow = typeof channels.$inferSelect;
type Params = Record<string, unknown>;
export interface BotVoiceCtx {
  bot: BotRow;
  user: UserRow;
}

/** Отметка «заходит» живёт столько (с запасом на задержку вебхука presence). */
const PENDING_S = 30;
const pendCh = (channelId: string) => `bot:vc:pend:ch:${channelId}`;
const pendBot = (botId: string) => `bot:vc:pend:bot:${botId}`;
const aloneKey = (channelId: string) => `bot:vc:alone:${channelId}`;
/** Бота перенёс модератор: своё `left` с `move_to` уже записано маршрутом — второе (из presence) боту не писать. */
export const movedKey = (botId: string, channelId: string) => `bot:vc:moved:${botId}:${channelId}`;

// ─── Срез presence ───────────────────────────────────────────────────────────────────────────────────────────────────

function parseRoster(raw: unknown): VoiceParticipant[] {
  if (typeof raw !== 'string') return [];
  try {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? (list as VoiceParticipant[]).filter((p) => p && typeof p.userId === 'string') : [];
  } catch {
    return [];
  }
}

/** Кто в голосовом канале по presence. Ошибка чтения — пусто. */
export async function voiceRoster(channelId: string): Promise<VoiceParticipant[]> {
  try {
    return parseRoster(await redisPub.get(`presence:ch:${channelId}`));
  } catch {
    return [];
  }
}

/** Все непустые голосовые каналы по presence (тем же конвейером, что `voiceActivity.ts`). */
async function presenceSnapshot(): Promise<Map<string, VoiceParticipant[]>> {
  const out = new Map<string, VoiceParticipant[]>();
  const ids = await redisPub.smembers('presence:channels');
  if (ids.length === 0) return out;
  const pipe = redisPub.pipeline();
  for (const id of ids) pipe.get(`presence:ch:${id}`);
  const res = (await pipe.exec()) ?? [];
  res.forEach(([err, val], i) => {
    if (err) return;
    const list = parseRoster(val);
    if (list.length > 0) out.set(ids[i], list);
  });
  return out;
}

// ─── Отметки «заходит» ───────────────────────────────────────────────────────────────────────────────────────────────

async function livePending(key: string): Promise<string[]> {
  const now = Date.now();
  await redisPub.zremrangebyscore(key, '-inf', now);
  return redisPub.zrangebyscore(key, now, '+inf');
}

async function markPending(botId: string, channelId: string): Promise<void> {
  const until = Date.now() + PENDING_S * 1000;
  await redisPub
    .multi()
    .zadd(pendCh(channelId), until, botId)
    .expire(pendCh(channelId), PENDING_S)
    .zadd(pendBot(botId), until, channelId)
    .expire(pendBot(botId), PENDING_S)
    .exec();
}

async function clearPending(botId: string, channelId: string): Promise<void> {
  await redisPub.multi().zrem(pendCh(channelId), botId).zrem(pendBot(botId), channelId).exec();
}

/** Каналы, где бот сидит (presence) или куда заходит (отметка). */
async function botChannelIds(botId: string, snapshot?: Map<string, VoiceParticipant[]>): Promise<Set<string>> {
  const snap = snapshot ?? (await presenceSnapshot());
  const out = new Set<string>(await livePending(pendBot(botId)));
  for (const [channelId, list] of snap) if (list.some((p) => p.userId === botId)) out.add(channelId);
  return out;
}

async function serversOf(channelIds: readonly string[]): Promise<Map<string, string>> {
  if (channelIds.length === 0) return new Map();
  const rows = await db.select({ id: channels.id, serverId: channels.serverId }).from(channels).where(inArray(channels.id, [...channelIds]));
  return new Map(rows.map((r) => [r.id, r.serverId]));
}

/** Выйти из комнаты канала (нет в комнате / нет LiveKit — молча) и снять отметку. */
async function removeFromRoom(botId: string, channelId: string): Promise<void> {
  await disconnectUser(roomForChannel(channelId), botId).catch(() => undefined);
  await clearPending(botId, channelId).catch(() => undefined);
}

// ─── Разбор цели ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** `chat_id` → цель для `botVoiceDecision` (п.2–3): канал, который бот видит; id сервера; иначе «не найден». */
async function voiceTarget(botId: string, chatId: string): Promise<{ target: BotVoiceInput['target']; channel: ChannelRow | null; perms: bigint }> {
  const [channel] = await db.select().from(channels).where(eq(channels.id, chatId)).limit(1);
  if (!channel) return { target: (await botOnServer(botId, chatId)) ? 'server' : 'missing', channel: null, perms: 0n };
  if (!(await botOnServer(botId, channel.serverId))) return { target: 'missing', channel: null, perms: 0n };
  const perms = await getChannelPermissions(channel.id, botId);
  if (!perms || !has(perms.permissions, Permission.VIEW_CHANNEL)) return { target: 'missing', channel: null, perms: 0n };
  return { target: { type: channel.type }, channel, perms: perms.permissions };
}

function fail(e: BotApiError | null): void {
  if (e) throw e;
}

// ─── Методы Bot API ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `joinVoice` (ТЗ §1.1): проверки `botVoiceDecision` по порядку; вход в канал того же сервера — переход (старая комната
 * закрывается); отметка «заходит»; токен LiveKit на 10 минут (уже заглушённому модератором — без микрофона).
 */
export async function voiceJoin(ctx: BotVoiceCtx, p: Params) {
  const q = joinVoiceParams.parse(p);
  const botId = ctx.bot.userId;
  const enabled = botVoiceEnabled(await readBotSettings());
  const { target, channel, perms } = await voiceTarget(botId, q.chat_id);
  // П.1–5 — до частоты: отказ по правам не тратит попытки входа.
  fail(botVoiceDecision({ enabled, target, perms }));
  const ch = channel!;
  const rateWait = await rateHit(`botvc:${botId}`, BOT_VOICE_JOIN_RATE.max, BOT_VOICE_JOIN_RATE.windowS);

  const snapshot = await presenceSnapshot();
  const roster = snapshot.get(ch.id) ?? [];
  const others = new Set<string>(roster.filter((x) => x.bot === true && x.userId !== botId).map((x) => x.userId));
  for (const id of await livePending(pendCh(ch.id))) if (id !== botId) others.add(id);

  const mine = await botChannelIds(botId, snapshot);
  mine.delete(ch.id);
  const servers = await serversOf([...mine]);
  const sameServer = [...mine].filter((id) => servers.get(id) === ch.serverId);
  const otherRooms = [...mine].filter((id) => servers.has(id) && servers.get(id) !== ch.serverId).length;
  fail(botVoiceDecision({ enabled, target, perms, rateWait, botsInChannel: others.size, otherRooms }));

  // Один голосовой канал на сервер (как Discord): прежний канал этого сервера закрывается.
  for (const id of sameServer) await removeFromRoom(botId, id);
  await markPending(botId, ch.id);
  const serverMuted = (await redisPub.sismember(voiceServerMuteKey(ch.id), botId)) === 1;
  const room = roomForChannel(ch.id);
  const token = await createBotVoiceToken({
    botId,
    name: ctx.user.displayName,
    room,
    permissions: perms,
    avatarUrl: ctx.user.avatarUrl,
    serverMuted,
  });
  return {
    url: env.livekit.urlExternal,
    token,
    room,
    chat: voiceChat(ch),
    server_muted: serverMuted,
    expires_in: BOT_VOICE_TOKEN_TTL_S,
    audio: { sample_rate: 48000, channels: 2, bitrate: q.bitrate ?? BOT_VOICE_BITRATE.def },
  };
}

/** `leaveVoice`: с `chat_id` — из этого канала, без — из всех. Идемпотентно: бота там нет — всё равно `true`. */
export async function voiceLeave(ctx: BotVoiceCtx, p: Params) {
  const q = leaveVoiceParams.parse(p);
  if (q.chat_id) await removeFromRoom(ctx.bot.userId, q.chat_id);
  else await dropBotVoice(ctx.bot.userId);
  return true;
}

/** `getVoiceChatMembers`: кто в канале — по срезу presence (как видит клиент). Проверки — п.2–3 `joinVoice`. */
export async function voiceMembers(ctx: BotVoiceCtx, p: Params): Promise<WireVoiceChatMember[]> {
  const q = getVoiceChatMembersParams.parse(p);
  const botId = ctx.bot.userId;
  const { target, channel } = await voiceTarget(botId, q.chat_id);
  // П.1 (выключатель голоса) здесь не действует: смотреть, кто в канале, можно и без права заходить.
  fail(botVoiceDecision({ enabled: true, target, perms: Permission.CONNECT | Permission.SPEAK }));
  const ch = channel!;
  const wait = await rateHit(`botvcm:${botId}:${ch.serverId}`, BOT_SERVER_RATE.max, BOT_SERVER_RATE.windowS);
  if (wait) throw new BotApiError(429, `Too Many Requests: retry after ${wait}`, wait);
  const roster = await voiceRoster(ch.id);
  const people = await wireUsers(roster.map((x) => x.userId));
  const out: WireVoiceChatMember[] = [];
  for (const x of roster) {
    const user = people.get(x.userId);
    if (!user) continue;
    out.push({ user, muted: x.muted, deafened: x.deafened, server_muted: x.serverMuted, is_bot: x.bot === true || user.bot });
  }
  return out;
}

// ─── Выкинуть ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Выкинуть бота из голосовых комнат (ТЗ §2.4): все, или только комнаты сервера `serverId`. Зовётся рядом с КАЖДЫМ
 * `closeBotSockets` (выключение бота / ботов / голоса ботов, перевыпуск токена, удаление) и из `memberBotUpdates` (бот ушёл с
 * сервера). Не бросает: сбой LiveKit не должен ломать вызывающего; добьёт страховочный обход.
 */
export async function dropBotVoice(botId: string, serverId?: string): Promise<void> {
  try {
    const ids = [...(await botChannelIds(botId))];
    if (ids.length === 0) return;
    const servers = serverId ? await serversOf(ids) : null;
    for (const id of ids) {
      if (servers && servers.get(id) !== serverId) continue;
      await removeFromRoom(botId, id);
    }
  } catch (err) {
    console.warn(`[bots] голос: выкинуть ${botId}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Выкинуть ВСЕХ ботов из всех комнат (выключили ботов или голос ботов на инстансе). Только тех, кто уже в presence: бот с
 * выданным, но ещё не использованным токеном (отметка «заходит») сюда не попадает — отозвать JWT LiveKit нельзя, а выкинуть из
 * комнаты, куда он ещё не вошёл, нечего. Его подберёт страховочный обход `sweepBotVoice` (раз в минуту, проверяет выключатель):
 * окно — не больше минуты (найдено Codex R306, решение 27.10: допустимо).
 */
export async function dropAllBotsVoice(): Promise<void> {
  try {
    for (const [channelId, list] of await presenceSnapshot()) {
      for (const x of list) if (x.bot === true) await removeFromRoom(x.userId, channelId);
    }
  } catch (err) {
    console.warn('[bots] голос: выкинуть всех:', err instanceof Error ? err.message : err);
  }
}

/**
 * Перенос бота модератором (`/channels/:id/voice/:userId/move`, ТЗ §1.5): права бота в целевом канале — `botVoiceDecision`
 * п.1–5. Есть — боту `voice_state { left, move_to }`, затем выход из старой комнаты (SDK сам заходит в `move_to`). `false` —
 * прав нет (маршрут отвечает 403).
 */
export async function moveBotVoice(botId: string, from: ChannelRow, to: ChannelRow): Promise<boolean> {
  const enabled = botVoiceEnabled(await readBotSettings());
  const { target, channel, perms } = await voiceTarget(botId, to.id);
  if (!channel || channel.serverId !== from.serverId || botVoiceDecision({ enabled, target, perms })) return false;
  // Бота в старом канале нет (уже вышел) — переносить нечего, событие не пишем.
  const present = (await voiceRoster(from.id)).some((x) => x.userId === botId) || (await livePending(pendCh(from.id))).includes(botId);
  if (!present) return true;
  const live = (await liveBotsAmong([botId])).get(botId);
  const people = await wireUsers([botId]);
  const user = people.get(botId);
  if (live && user) {
    await redisPub.set(movedKey(botId, from.id), '1', 'EX', 60);
    const payload = { chat: voiceChat(from), user, action: 'left', date: unixSeconds(Date.now()), move_to: voiceChat(channel) };
    const touched = await pushUpdates([{ botId, type: 'voice_state', payload }]);
    if (touched.length) {
      const { kickWebhook } = await import('./webhookDelivery.js');
      kickWebhook(botId);
    }
  }
  await removeFromRoom(botId, from.id);
  return true;
}

// ─── Один в канале ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Обновить отметку «боты одни в канале» по составу; вернуть её (unix с) или `null`. */
export async function trackBotAlone(channelId: string, roster: readonly VoiceParticipant[], nowS = unixSeconds(Date.now())): Promise<number | null> {
  const stored = await redisPub.get(aloneKey(channelId));
  const prev = stored && /^\d+$/.test(stored) ? Number(stored) : null;
  const next = botAloneSince(roster, prev, nowS);
  if (next === null) {
    if (prev !== null) await redisPub.del(aloneKey(channelId));
  } else if (prev === null) await redisPub.set(aloneKey(channelId), String(next), 'EX', 24 * 3600);
  return next;
}

// ─── Страховочный обход ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Раз в минуту (`startBotJobs`, ТЗ §2.4): каждый бот в голосе проходит `botVoiceDecision` п.1–5 (выключен, снят с сервера,
 * отняли `CONNECT`/`SPEAK`, голос ботов выключен) и проверку «жив»; не прошёл — выкидывается. Боты одни в канале дольше
 * `BOT_VOICE_ALONE_S` — тоже. Каналов без ботов обход не трогает (одно чтение presence).
 */
export async function sweepBotVoice(): Promise<void> {
  try {
    const snapshot = await presenceSnapshot();
    const withBots = [...snapshot].filter(([, list]) => list.some((x) => x.bot === true));
    if (withBots.length === 0) return;
    const enabled = botVoiceEnabled(await readBotSettings());
    const botIds = [...new Set(withBots.flatMap(([, list]) => list.filter((x) => x.bot === true).map((x) => x.userId)))];
    const live = await liveBotsAmong(botIds);
    const nowS = unixSeconds(Date.now());
    for (const [channelId, list] of withBots) {
      const alone = await trackBotAlone(channelId, list, nowS);
      const expired = botAloneExpired(alone, nowS, BOT_VOICE_ALONE_S);
      for (const x of list) {
        if (x.bot !== true) continue;
        let drop = expired || !live.has(x.userId) || !enabled;
        if (!drop) {
          const { target, perms } = await voiceTarget(x.userId, channelId);
          drop = botVoiceDecision({ enabled, target, perms }) !== null;
        }
        if (drop) await removeFromRoom(x.userId, channelId);
      }
      if (expired) await redisPub.del(aloneKey(channelId));
    }
  } catch (err) {
    console.warn('[bots] голос: обход:', err instanceof Error ? err.message : err);
  }
}
