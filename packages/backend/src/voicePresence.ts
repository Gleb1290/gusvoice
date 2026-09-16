import type { VoiceParticipant } from '@gusvoice/shared';
import { redisPub } from './realtime.js';

/**
 * Сидит ли человек прямо сейчас в этом голосовом канале.
 *
 * ⚠️ Читаем presence, а не спрашиваем LiveKit: тот же самый источник, который видит клиент, поэтому
 * «вижу человека в канале, а ткнуть нельзя» невозможно. Ошибка чтения = «не в канале» (fail-closed).
 *
 * 🔴 Живёт отдельным модулем, а не внутри маршрутов голоса: «кто сейчас в канале» — это факт
 * предметной области, и его спрашивают и тык, и тип, и покупка награды. Импортировать помощника из
 * файла маршрутов ради этого пришлось бы всем подряд.
 */
export async function inVoiceChannel(channelId: string, userId: string): Promise<boolean> {
  return (await voiceParticipantIds(channelId)).includes(userId);
}

/**
 * Кто сейчас сидит в голосовом канале — списком.
 *
 * 🔴 Нужен как АУДИТОРИЯ для событий, которые касаются только сидящих в голосе. Обычная рассылка по
 * каналу уходит всем, кто имеет право его ВИДЕТЬ, — а это не то же самое: человек может читать
 * переписку канала, сидя голосом в другом. Выстрел саундборда такому уходить не должен ни звуком,
 * ни отметкой: он не участник происходящего.
 * ⚠️ Ошибка чтения = пустой список (fail-closed): лучше не разослать никому, чем разослать мимо.
 */
export async function voiceParticipantIds(channelId: string): Promise<string[]> {
  try {
    const raw = await redisPub.get(`presence:ch:${channelId}`);
    if (!raw) return [];
    const list = JSON.parse(raw) as VoiceParticipant[];
    return Array.isArray(list) ? list.map((p) => p.userId) : [];
  } catch {
    return [];
  }
}
