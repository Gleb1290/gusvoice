import { canPublishCamera, canPublishScreen, has, Permission } from '@gusvoice/shared';
import { TrackSource } from 'livekit-server-sdk';

/**
 * Чистые правила публикации в LiveKit — БЕЗ env и `RoomServiceClient`.
 *
 * Вынесено из `livekit.ts` по просьбе Codex (2026-07-27): тот модуль на импорте читает env и
 * поднимает `RoomServiceClient`, поэтому права публикации нельзя было проверить тестом. Здесь
 * решается, кому дать микрофон, камеру и экран — ошибка выдаёт лишний источник в чужом канале.
 */

/**
 * The publish sources a member is allowed, derived from their resolved permissions.
 * When `serverMuted`, the microphone is dropped so the SFU rejects any (re)publish of it.
 */
export function publishSources(permissions: bigint, serverMuted = false): TrackSource[] {
  const sources: TrackSource[] = [];
  if (!serverMuted && has(permissions, Permission.SPEAK)) sources.push(TrackSource.MICROPHONE);
  if (canPublishCamera(permissions)) sources.push(TrackSource.CAMERA);
  if (canPublishScreen(permissions)) sources.push(TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
  return sources;
}

/**
 * Готовый publish-грант: список источников И согласованный с ним `canPublish`.
 *
 * 🔴 Эти два поля обязаны выставляться ВМЕСТЕ. Пустой `canPublishSources` LiveKit трактует как
 * «ограничений нет», то есть человек без единого права получил бы право публиковать ВСЁ; спасает
 * только парный `canPublish: false`. Раньше пара собиралась в двух местах (`serverMute` и
 * `createVoiceToken`) — а такую связку достаточно забыть в одном, чтобы дыра появилась молча.
 */
export function publishGrant(
  permissions: bigint,
  serverMuted = false,
): { canPublish: boolean; canPublishData: boolean; canPublishSources: TrackSource[] } {
  const sources = publishSources(permissions, serverMuted);
  return {
    canPublish: sources.length > 0,
    canPublishData: has(permissions, Permission.SEND_MESSAGES),
    canPublishSources: sources,
  };
}

/**
 * Метаданные голосового токена — уезжают в LiveKit-вебхуки: аватар забирает presence, `priority`
 * влияет на порядок говорящих.
 */
export function voiceTokenMetadata(permissions: bigint, avatarUrl?: string | null, opts?: { bot?: boolean }): string {
  // Бот (#232): метка `bot: true` — по ней presence ставит `VoiceParticipant.bot`; приоритет говорящего боту не положен.
  if (opts?.bot) return JSON.stringify({ avatarUrl: avatarUrl ?? null, priority: false, bot: true });
  return JSON.stringify({
    avatarUrl: avatarUrl ?? null,
    priority: has(permissions, Permission.PRIORITY_SPEAKER),
  });
}

/**
 * Publish-грант БОТА в голосе (#232, этап 4, ТЗ §1.2): только микрофон (бот шлёт музыку дорожкой MICROPHONE — тогда у слушателя
 * работает его громкость, `localUserAudio`). Камеры и экрана нет ни при каких правах (`STREAM` не в счёт). Пара `canPublish` +
 * `canPublishSources` неразрывна по той же причине, что у `publishGrant`: пустой список без `canPublish: false` = «можно всё».
 */
export function botPublishGrant(permissions: bigint, serverMuted = false): { canPublish: boolean; canPublishSources: TrackSource[] } {
  if (!serverMuted && has(permissions, Permission.SPEAK)) return { canPublish: true, canPublishSources: [TrackSource.MICROPHONE] };
  return { canPublish: false, canPublishSources: [] };
}
