/**
 * Бот в голосовом канале (#232, этап 4 ботов, ТЗ `bots-phase4/SPEC.md` §6). Чистые правила — без React и стора.
 *
 * Бот — обычный участник LiveKit (identity = id пользователя), которого сервер помечает: в метаданных токена `"bot": true`, а в
 * presence — `VoiceParticipant.bot`. Старый сервер метки не шлёт — тогда бот выглядит как человек (допустимая деградация, §1.3).
 */

/** Метка бота в метаданных участника LiveKit (`voiceTokenMetadata(…, { bot: true })`). */
export function isBotMetadata(metadata?: string | null): boolean {
  if (!metadata) return false;
  try {
    return (JSON.parse(metadata) as { bot?: unknown } | null)?.bot === true;
  } catch {
    return false;
  }
}

/** Бот ли участник: метка в presence (она же и в сайдбаре) или в метаданных токена — достаточно любой. */
export function isVoiceBot(
  userId: string,
  presence: readonly { userId: string; bot?: boolean }[] | undefined,
  metadata?: string | null,
): boolean {
  if (presence?.some((p) => p.userId === userId && p.bot === true)) return true;
  return isBotMetadata(metadata);
}

/**
 * Боты после людей в ОБЩЕМ списке канала (решение владельца 27.10: не отдельная группа). Порядок внутри каждой части сохраняется;
 * presence порядка не меняет (§1.3), поэтому раскладывает клиент.
 */
export function botsAfterHumans<T>(list: readonly T[], isBot: (item: T) => boolean): T[] {
  const humans: T[] = [];
  const bots: T[] = [];
  for (const item of list) (isBot(item) ? bots : humans).push(item);
  return bots.length === 0 ? [...list] : [...humans, ...bots];
}

/**
 * Значок «микрофон выключен» у участника. У человека — его мьют или собственная тишина; у бота «muted» означает «сейчас ничего не
 * играет» (§1.3), это не повод для красного значка: только мьют модератором.
 */
export function showMicOff(isBot: boolean, muted: boolean, serverMuted: boolean): boolean {
  return isBot ? serverMuted : muted;
}

/** Значок «звук выключен» (деафен): у бота его нет и быть не может. */
export function showDeafened(isBot: boolean, deafened: boolean): boolean {
  return !isBot && deafened;
}

/** Тычок, чаевые, покупка («Ущипнуть»), звонок и «сделать генералом» — только людям: сервер ботам отвечает 400. */
export function botAcceptsSocial(isBot: boolean): boolean {
  return !isBot;
}
