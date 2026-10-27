/**
 * Команды бота беседы (#230, SPEC §2.4): `GET /conv/:id/bot` → кэш в памяти на беседу на `BOT_COMMANDS_TTL_MS`. Берётся при
 * открытии беседы с ботом и тихо перезапрашивается при вводе «/», если старше. Старый сервер (404) и сбой — команд нет,
 * подсказки по «/» и кнопки «Меню» тоже. Push-события о смене команд нет (решение SPEC §9.3) — хватает кэша.
 */
import { useEffect, useState } from 'react';
import type { BotCommandInfo, ChannelBotsInfo } from '@gusvoice/shared';
import { api } from './api';
import { BOT_COMMANDS_TTL_MS } from './botKeyboardRules';

const cache = new Map<string, { at: number; commands: BotCommandInfo[] }>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();
const NONE: BotCommandInfo[] = [];

/** Подтянуть команды беседы, если в кэше их нет или они старше `BOT_COMMANDS_TTL_MS` (`force` — не глядя на возраст). */
export function refreshBotCommands(convId: string, force = false): void {
  const hit = cache.get(convId);
  if (inflight.has(convId) || (!force && hit && Date.now() - hit.at < BOT_COMMANDS_TTL_MS)) return;
  inflight.add(convId);
  api
    .convBotInfo(convId)
    .then(
      (info) => {
        const commands = Array.isArray(info?.commands)
          ? info.commands.filter((c) => c && typeof c.command === 'string' && c.command !== '')
          : NONE;
        cache.set(convId, { at: Date.now(), commands });
      },
      // 404 (старый сервер, не бот) и сбой — без команд; повтор не раньше чем через TTL.
      () => cache.set(convId, { at: Date.now(), commands: hit?.commands ?? NONE }),
    )
    .finally(() => {
      inflight.delete(convId);
      for (const f of listeners) f();
    });
}

/** Команды беседы с ботом (`convId` — только когда собеседник бот; иначе `undefined` и запроса нет). */
export function useBotCommands(convId: string | null | undefined): BotCommandInfo[] | undefined {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!convId) return;
    const f = () => bump((n) => n + 1);
    listeners.add(f);
    refreshBotCommands(convId);
    return () => {
      listeners.delete(f);
    };
  }, [convId]);
  return convId ? cache.get(convId)?.commands : undefined;
}

// ─── Боты канала (#231, ТЗ этапа 3 §4.3) ───────────────────────────────────────────────────────────────────────────────
/**
 * `GET /channels/:id/bots` → боты канала с их командами, тот же кэш на `BOT_COMMANDS_TTL_MS` (отдельная карта: ключи бесед и
 * каналов не смешиваются). Старый сервер (404) и сбой — ботов нет, подсказка по «/» и «Меню» в канале не появляются.
 */
type ChannelBots = ChannelBotsInfo['bots'];
const channelCache = new Map<string, { at: number; bots: ChannelBots }>();
const NO_BOTS: ChannelBots = [];

export function refreshChannelBots(channelId: string, force = false): void {
  const key = `channel:${channelId}`;
  const hit = channelCache.get(channelId);
  if (inflight.has(key) || (!force && hit && Date.now() - hit.at < BOT_COMMANDS_TTL_MS)) return;
  inflight.add(key);
  api
    .channelBots(channelId)
    .then(
      (info) => channelCache.set(channelId, { at: Date.now(), bots: Array.isArray(info?.bots) ? info.bots : NO_BOTS }),
      () => channelCache.set(channelId, { at: Date.now(), bots: hit?.bots ?? NO_BOTS }),
    )
    .finally(() => {
      inflight.delete(key);
      for (const f of listeners) f();
    });
}

/** Боты канала (`channelId` — только в канале сервера; иначе `undefined` и запроса нет). */
export function useChannelBots(channelId: string | null | undefined): ChannelBots | undefined {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!channelId) return;
    const f = () => bump((n) => n + 1);
    listeners.add(f);
    refreshChannelBots(channelId);
    return () => {
      listeners.delete(f);
    };
  }, [channelId]);
  return channelId ? channelCache.get(channelId)?.bots : undefined;
}
