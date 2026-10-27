/**
 * Права бота в комнате по токену LiveKit. Чистый модуль — без `@livekit/rtc-node`.
 *
 * Мьют модератором сервер делает сменой прав (`updateParticipant`: `canPublish: false`, `canPublishSources: []`), а не мьютом
 * дорожки. `@livekit/rtc-node` 1.1.0 при этом НЕ присылает ни `LocalTrackUnpublished`, ни `TrackMuted`, и прав участника не
 * показывает; приходит только `TokenRefreshed` — LiveKit перевыпускает токен участника с новыми правами (`room.token`).
 * Поэтому «можно ли говорить» читаем из полезной нагрузки этого токена. Подпись НЕ проверяется: это наш же токен, выданный
 * сервером LiveKit, и решение только про то, публиковать ли звук (права всё равно держит SFU).
 */

/** Полезная нагрузка JWT (второй сегмент, base64url → JSON). `null` — не JWT или не разобрать. */
export function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload: unknown = JSON.parse(json);
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Можно ли публиковать микрофон по правам `video` из токена LiveKit:
 *  - `true` — можно; `false` — нельзя (`canPublish: false`, либо непустой `canPublishSources` без `microphone`);
 *  - `null` — неизвестно (нет токена, не JWT, нет `video`): решать по другим признакам.
 * Правила LiveKit: `canPublish` по умолчанию разрешён, пустой (или отсутствующий) `canPublishSources` — любые источники.
 */
export function canSpeakFromGrants(video: unknown): boolean | null {
  if (!video || typeof video !== 'object' || Array.isArray(video)) return null;
  const v = video as { canPublish?: unknown; canPublishSources?: unknown };
  if (v.canPublish === false) return false;
  const sources = v.canPublishSources;
  if (Array.isArray(sources) && sources.length > 0) {
    return sources.some((s) => typeof s === 'string' && s.toLowerCase() === 'microphone');
  }
  return true;
}

/** `canSpeakFromGrants` по целому токену LiveKit (`room.token`). */
export function canSpeakFromToken(token: string | null | undefined): boolean | null {
  const payload = decodeJwtPayload(token);
  return payload ? canSpeakFromGrants(payload.video) : null;
}
