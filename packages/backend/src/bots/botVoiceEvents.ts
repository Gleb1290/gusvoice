/**
 * События `voice_state` ботам (#232, этап 4; ТЗ §1.5): кто зашёл в голосовой канал / вышел — без правок presence.
 *
 * Presence при каждом изменении состава пишет `presence:ch:<канал>` и публикует `presence:update {channelId}`. Здесь — одна
 * подписка на процесс (своё соединение Redis, как будильник `listenBotWake`): `next = GET presence:ch:<id>` → `prev = SET
 * bot:vc:last:<id> <ids next> GET EX 86400` (атомарно: при нескольких процессах бэкенда разницу увидит только один) → чистая
 * `voiceStateDiff`. Событие пишется в журнал всем живым ботам сервера канала, которые его видят (`VIEW_CHANNEL`; решение
 * владельца 27.10, как Discord), включая самого бота — так он узнаёт, что его отключили. Серверы без ботов отсекаются кэшем
 * `server_bots` на 60 с. Заодно обновляется отметка «боты одни в канале» (`trackBotAlone`).
 *
 * Заводится `startBotVoiceEvents` из `routes/botApi.ts` (`onListen`, лениво) — тесты на `inject` её не заводят.
 */
import { has, Permission, type VoiceParticipant } from '@gusvoice/shared';
import { eq } from 'drizzle-orm';
import Redis from 'ioredis';
import { db } from '../db/index.js';
import { channels, serverBots } from '../db/schema.js';
import { env } from '../env.js';
import { getChannelPermissions } from '../permissions.js';
import { redisPub } from '../realtime.js';
import { botsFor, wireUsers } from './botChannel.js';
import { unixSeconds, voiceStateDiff } from './botRules.js';
import { pushUpdates, readBotSettings } from './botStore.js';
import { movedKey, trackBotAlone } from './botVoice.js';
import { voiceChat } from './botWire.js';
import { kickWebhook } from './webhookDelivery.js';

const UPDATE_CHANNEL = 'presence:update';
const lastKey = (channelId: string) => `bot:vc:last:${channelId}`;
const SERVER_BOTS_CACHE_MS = 60_000;
const hasBotsCache = new Map<string, { at: number; has: boolean }>();

let started = false;
/** Очередь на канал: события одного канала разбираются по порядку (иначе `left` мог бы обогнать `joined`). */
const chains = new Map<string, Promise<void>>();

/** Завести подписку (один раз на процесс). */
export function startBotVoiceEvents(): void {
  if (started) return;
  started = true;
  const sub = new Redis(env.redisUrl);
  sub.on('error', () => undefined);
  sub.on('message', (channel: string, raw: string) => {
    if (channel !== UPDATE_CHANNEL) return;
    let channelId: unknown;
    try {
      channelId = (JSON.parse(raw) as { channelId?: unknown }).channelId;
    } catch {
      return;
    }
    if (typeof channelId !== 'string' || !channelId) return;
    const id = channelId;
    const next = (chains.get(id) ?? Promise.resolve())
      .then(() => voiceStateChanged(id))
      .catch((err) => console.warn('[bots] voice_state:', err instanceof Error ? err.message : err));
    chains.set(id, next);
    void next.finally(() => {
      if (chains.get(id) === next) chains.delete(id);
    });
  });
  void sub.subscribe(UPDATE_CHANNEL).catch((err) => console.warn('[bots] voice_state: подписка:', err instanceof Error ? err.message : err));
}

async function serverHasBots(serverId: string): Promise<boolean> {
  const now = Date.now();
  const hit = hasBotsCache.get(serverId);
  if (hit && now - hit.at < SERVER_BOTS_CACHE_MS) return hit.has;
  const [row] = await db.select({ botId: serverBots.botId }).from(serverBots).where(eq(serverBots.serverId, serverId)).limit(1);
  const has = !!row;
  hasBotsCache.set(serverId, { at: now, has });
  return has;
}

function rosterOf(raw: string | null): VoiceParticipant[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? (list as VoiceParticipant[]).filter((p) => p && typeof p.userId === 'string') : [];
  } catch {
    return [];
  }
}

function idsOf(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

/** Разбор одного `presence:update`: разница составов → журнал ботов. */
export async function voiceStateChanged(channelId: string): Promise<void> {
  const roster = rosterOf(await redisPub.get(`presence:ch:${channelId}`));
  const ids = roster.map((p) => p.userId);
  const prev = idsOf(await redisPub.set(lastKey(channelId), JSON.stringify(ids), 'EX', 86400, 'GET'));
  const { joined, left } = voiceStateDiff(prev, ids);
  await trackBotAlone(channelId, roster);
  if (joined.length === 0 && left.length === 0) return;

  const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  if (!channel || channel.type !== 'voice') return;
  if (!(await serverHasBots(channel.serverId))) return;
  if (!(await readBotSettings()).enabled) return;
  const candidates = await botsFor(channel.serverId, null);
  if (candidates.length === 0) return;
  const targets: { botId: string; readAll: boolean }[] = [];
  for (const b of candidates) {
    const perms = await getChannelPermissions(channel.id, b.bot.userId);
    if (perms && has(perms.permissions, Permission.VIEW_CHANNEL)) targets.push({ botId: b.bot.userId, readAll: b.readAll });
  }
  if (targets.length === 0) return;

  const people = await wireUsers([...joined, ...left]);
  const chat = voiceChat(channel);
  const date = unixSeconds(Date.now());
  const changes = [...joined.map((id) => ({ id, action: 'joined' as const })), ...left.map((id) => ({ id, action: 'left' as const }))];
  const out: { botId: string; type: 'voice_state'; payload: Record<string, unknown>; readAll: boolean }[] = [];
  for (const c of changes) {
    const user = people.get(c.id);
    if (!user) continue;
    // Бота перенёс модератор: его `left` с `move_to` уже записал маршрут — второе ему самому не пишем (другим — пишем).
    const movedSelf = c.action === 'left' && targets.some((t) => t.botId === c.id) && (await redisPub.getdel(movedKey(c.id, channelId))) !== null;
    for (const t of targets) {
      if (movedSelf && t.botId === c.id) continue;
      out.push({ botId: t.botId, type: 'voice_state', payload: { chat, user, action: c.action, date }, readAll: t.readAll });
    }
  }
  if (out.length === 0) return;
  const touched = await pushUpdates(out);
  for (const botId of touched) kickWebhook(botId);
}
