import { realClientIp, type PresenceMap, type VoiceParticipant } from '@gusvoice/shared';
import { TrackSource } from 'livekit-server-sdk';

/**
 * Чистые правила presence — БЕЗ Redis, LiveKit-клиента и env.
 *
 * Вынесено из `index.ts` по просьбе Codex (2026-07-27): тот модуль на импорте поднимает три
 * Redis-соединения, `RoomServiceClient` и слушает порт, поэтому проверить расчёты можно было
 * только запуском всего сервиса. Цена ошибки тут выше средней: `visibleSnapshot` — граница
 * приватности голосовых каналов, а `buildParticipantList` рисует то, что человек видит в сайдбаре.
 *
 * ⚠️ `TrackSource` берётся из SDK намеренно. Свои константы пришлось бы держать равными
 * SDK-шным «на глаз» — ровно тот класс расхождения, который тут уже ловили.
 */

/** Суффикс publish-only участника нативного скриншера (десктоп). */
export const SCREEN_SUFFIX = '#screen';

/** Минимум полей `ParticipantInfo`, который читают правила (сам SDK-класс собрать в тесте нельзя). */
export interface PresenceTrack {
  source: TrackSource;
  muted: boolean;
}
export interface PresenceParticipant {
  identity: string;
  name?: string;
  metadata?: string;
  attributes?: Record<string, string>;
  tracks: PresenceTrack[];
}

/**
 * Пределы клиентского сокета presence (F0 федерации, #139).
 *
 * 🔴 До этого у сокета не было НИКАКИХ пределов: ни срока на `identify`, ни числа соединений с адреса,
 * ни размера кадра. Хуже того, каждое `identify` с живым токеном — это запрос к бэкенду
 * (`/api/me/voice-visibility`), то есть один сокет, повторяющий `identify` в цикле, превращал
 * presence в усилитель нагрузки на бэкенд. У шлюза бэкенда такие пределы есть с #2 — здесь те же
 * числа, чтобы оба сокета одного клиента жили по одним правилам.
 *
 * ⚠️ Честный клиент (`sockets.ts` `connectPresence`) шлёт ровно одно `identify` на сокет и дальше
 * только `ping` раз в 30 с — все пределы с большим запасом над ним.
 */
export const PRESENCE_WS_LIMITS = {
  /** Одновременных сокетов с одного адреса клиента (вкладки, устройства за одним NAT). */
  maxConnsPerIp: 30,
  /** Потолок на весь процесс. */
  maxTotalConns: 10_000,
  /** Не представился за это время — сокет закрывается. */
  authDeadlineMs: 10_000,
  /** Кадров до успешного `identify`. */
  maxPreauthFrames: 10,
  /** Любой кадр больше — злоупотребление: `identify` несёт только короткий JWT. */
  maxFrameBytes: 16 * 1024,
  /** Сколько раз за жизнь сокета можно прислать `identify` (каждое — запрос к бэкенду). */
  maxIdentifies: 3,
  /** После входа: не больше стольких кадров за окно (честный клиент — один `ping` в 30 с). */
  maxFramesPerWindow: 30,
  windowMs: 10_000,
} as const;

export type PresenceWsLimits = typeof PRESENCE_WS_LIMITS;

/** Пускать ли новый сокет. `fromIp` — сколько уже открыто с этого адреса. */
export function admitSocket(counts: { total: number; fromIp: number }, limits: PresenceWsLimits = PRESENCE_WS_LIMITS): boolean {
  return counts.total < limits.maxTotalConns && counts.fromIp < limits.maxConnsPerIp;
}

/**
 * Реальный адрес клиента — правило общее с бэкендом (`shared/clientIp.ts realClientIp`): заголовок читается справа
 * налево и только от прокси из внутренней сети. Первая запись `X-Forwarded-For` — от самого клиента, ей не верим.
 */
export function clientIpFrom(forwardedFor: string | string[] | undefined, peer: string): string {
  return realClientIp(forwardedFor, peer);
}

/** Счётчики одного сокета. Неизменяемые: `admitFrame` возвращает новые. */
export interface SocketBudget {
  identified: boolean;
  preAuthFrames: number;
  identifies: number;
  windowStartMs: number;
  windowFrames: number;
}

export function newSocketBudget(nowMs: number): SocketBudget {
  return { identified: false, preAuthFrames: 0, identifies: 0, windowStartMs: nowMs, windowFrames: 0 };
}

/**
 * Пропустить ли кадр. `ok: false` — сокет закрывается.
 *
 * ⚠️ `identified` здесь не выставляется: входом считается только ПРОВЕРЕННЫЙ токен, это делает
 * вызывающая сторона после `jwt.verify`. Попытка `identify` с мусором засчитывается как кадр до входа.
 */
export function admitFrame(
  budget: SocketBudget,
  frame: { bytes: number; isIdentify: boolean },
  nowMs: number,
  limits: PresenceWsLimits = PRESENCE_WS_LIMITS,
): { ok: boolean; budget: SocketBudget } {
  if (frame.bytes > limits.maxFrameBytes) return { ok: false, budget };
  const next: SocketBudget = { ...budget };
  if (frame.isIdentify) {
    next.identifies += 1;
    if (next.identifies > limits.maxIdentifies) return { ok: false, budget: next };
  }
  if (!next.identified) {
    next.preAuthFrames += 1;
    return { ok: next.preAuthFrames <= limits.maxPreauthFrames, budget: next };
  }
  if (nowMs - next.windowStartMs >= limits.windowMs) {
    next.windowStartMs = nowMs;
    next.windowFrames = 0;
  }
  next.windowFrames += 1;
  return { ok: next.windowFrames <= limits.maxFramesPerWindow, budget: next };
}

/** Restrict a presence map to the channels a client may see. */
export function visibleSnapshot(map: PresenceMap, visible: Set<string>): PresenceMap {
  const out: PresenceMap = {};
  for (const [id, parts] of Object.entries(map)) if (visible.has(id)) out[id] = parts;
  return out;
}

export function mapParticipant(p: PresenceParticipant, serverMutedIds: Set<string>): VoiceParticipant {
  let avatarUrl: string | null = null;
  if (p.metadata) {
    try {
      avatarUrl = (JSON.parse(p.metadata) as { avatarUrl?: string | null }).avatarUrl ?? null;
    } catch {
      /* ignore non-JSON metadata */
    }
  }
  const mic = p.tracks.find((t) => t.source === TrackSource.MICROPHONE);
  return {
    userId: p.identity,
    displayName: p.name || p.identity,
    avatarUrl,
    // A push-to-talk user's mic track is muted between key-presses — that's idle, NOT "muted".
    // Don't flag it (mirrors the client's ptt-attribute handling in VoiceConnection/VoiceParticipants),
    // otherwise PTT users show a mic-off badge on every presence-driven surface (channel list, overlay,
    // members panel) and appear to "unmute" each time they press to talk.
    muted: p.attributes?.ptt === '1' ? false : mic ? mic.muted : true,
    serverMuted: serverMutedIds.has(p.identity),
    deafened: p.attributes?.deafened === '1',
    speaking: false,
    screensharing: p.tracks.some((t) => t.source === TrackSource.SCREEN_SHARE),
    camera: p.tracks.some((t) => t.source === TrackSource.CAMERA),
  };
}

/**
 * Собрать итоговый список участников канала из сырого ответа LiveKit.
 *
 * `staleMutedIds` — те, кто числится в server-mute, но в комнате его уже нет; вызывающая сторона
 * должна вычистить их из Redis (выйти и зайти = снять мут). Возвращается, а не удаляется здесь,
 * чтобы правила остались без побочных эффектов; входной Set не мутируется.
 */
export function buildParticipantList(
  parts: PresenceParticipant[],
  serverMutedIds: Set<string>,
): { list: VoiceParticipant[]; staleMutedIds: string[] } {
  // Native screen-share companions ("<id>#screen") are publish-only ghosts: credit their screen
  // to the owner, then drop them from the roster so they don't show as a second member.
  const screenOwners = new Set(
    parts
      .filter((p) => p.identity.endsWith(SCREEN_SUFFIX) && p.tracks.some((t) => t.source === TrackSource.SCREEN_SHARE))
      .map((p) => p.identity.slice(0, -SCREEN_SUFFIX.length)),
  );
  const real = parts.filter((p) => !p.identity.endsWith(SCREEN_SUFFIX));
  // Drop server-mute entries for anyone no longer in the room (they leave/rejoin un-muted).
  const present = new Set(real.map((p) => p.identity));
  const staleMutedIds = [...serverMutedIds].filter((id) => !present.has(id));
  const effectiveMuted = new Set([...serverMutedIds].filter((id) => present.has(id)));

  const list = real.map((p) => {
    const vp = mapParticipant(p, effectiveMuted);
    if (screenOwners.has(p.identity)) vp.screensharing = true;
    return vp;
  });
  // Stable, deterministic order so the sidebar never reshuffles — listParticipants order isn't
  // guaranteed, and the periodic reconcile would otherwise reorder the list on every tick.
  list.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId));
  return { list, staleMutedIds };
}
