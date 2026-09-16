/**
 * Качество звука голосового канала — ОДИН источник правды для клиента и сервера (#101).
 *
 * Зачем понадобилось: битрейт задаёт ПУБЛИКУЮЩИЙ, а платит за него каждый слушатель — SFU просто
 * форвардит поток каждому, без перекодирования. Значит входящий трафик слушателя растёт линейно с
 * числом говорящих: при пяти в канале он качает четыре потока. На мобильном интернете это и есть
 * потолок, в который упирались «вчетвером уже не тянет».
 *
 * ⚠️ Раньше стоял единый потолок 128 кбит/с, и в комментарии к нему было написано «trivial bandwidth
 * for a self-hosted SFU». Для СЕРВЕРА это правда. Считали не тот конец: ломается входящий канал
 * слушателя, а он ни от какого self-hosted не зависит.
 */

/** Пресеты в кбит/с. Opus на речи прозрачен уже к 48–64; 128 оставлен как «как было». */
export const VOICE_BITRATES = [24, 48, 64, 96, 128] as const;

export type VoiceBitrate = (typeof VOICE_BITRATES)[number];

/**
 * Что получает канал, которому качество не выставляли.
 *
 * 🔴 **Понижен со 128 до 64** вместе с включением DTX. 64 кбит/с моно — всё ещё выше порога
 * прозрачности Opus для речи, а входящий трафик слушателя это делит вдвое ДО всякого DTX. Кому нужен
 * прежний звук — ставит «Высокое» на своём канале, настройка ровно для этого и заведена.
 */
export const DEFAULT_VOICE_BITRATE: VoiceBitrate = 64;

export function isVoiceBitrate(v: unknown): v is VoiceBitrate {
  return typeof v === 'number' && (VOICE_BITRATES as readonly number[]).includes(v);
}

/** Битрейт канала в кбит/с: своё значение либо умолчание. `null`/мусор → умолчание (fail-safe). */
export function voiceBitrateOf(channelBitrate: number | null | undefined): VoiceBitrate {
  return isVoiceBitrate(channelBitrate) ? channelBitrate : DEFAULT_VOICE_BITRATE;
}

/** То же, но в бит/с — в таком виде его ждёт LiveKit (`audioPreset.maxBitrate`). */
export function voiceMaxBitrate(channelBitrate: number | null | undefined): number {
  return voiceBitrateOf(channelBitrate) * 1000;
}

/**
 * Сколько СЛУШАТЕЛЬ качает при `talkers` одновременно говорящих, в кбит/с — прикидка для подписи в
 * настройках, чтобы решение принималось по числу, а не на ощупь.
 *
 * ⚠️ Учитывает RED (избыточность для устойчивости к потерям): он шлёт прошлые кадры вместе с
 * текущим и на проводе стоит примерно вдвое. Без этого множителя оценка врёт ровно в два раза —
 * то есть в самую опасную сторону.
 */
export const RED_OVERHEAD = 2;

export function listenerKbps(channelBitrate: number | null | undefined, talkers: number): number {
  return voiceBitrateOf(channelBitrate) * RED_OVERHEAD * Math.max(0, talkers);
}
