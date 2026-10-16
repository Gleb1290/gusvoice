/** Непрерывное отсутствие любого видео перед возвратом участников, мс (R167). */
export const STAGE_AUTO_SHOW_DELAY_MS = 3000;

/** Только нужная правилу часть TrackReference; без зависимости от LiveKit/DOM. */
export type StageVideoRef = { publication?: { isMuted?: boolean } };

/** Считаем публикации, а не плитки людей: показ спутника #screen тоже остаётся видео. */
export function stageHasVideo(screens: readonly StageVideoRef[], cameras: readonly StageVideoRef[]): boolean {
  return screens.some(track => !track.publication?.isMuted) || cameras.some(track => !track.publication?.isMuted);
}

/** Сброс имеет смысл только для включённой настройки в текущей подключённой комнате — и только когда видео
 *  ЗАКОНЧИЛОСЬ: `sawVideo` = с момента включения настройки в этом канале видео хоть раз было. Включил при пустом
 *  канале — настройка держится, пока кто-нибудь не покажет и не закончит (12.10, владелец). */
export function canAutoShowStage(input: {
  hideNoVideo: boolean; channelId: string | null; connected: boolean; hasVideo: boolean; sawVideo: boolean;
}): boolean {
  return input.hideNoVideo && !!input.channelId && input.connected && !input.hasVideo && input.sawVideo;
}

/** Память «видео было» для `canAutoShowStage`: сбрасывается при выключении настройки и смене канала. */
export type StageVideoSeen = { key: string | null; saw: boolean };
export function nextStageVideoSeen(
  prev: StageVideoSeen, input: { hideNoVideo: boolean; channelId: string | null; hasVideo: boolean },
): StageVideoSeen {
  const key = input.hideNoVideo ? input.channelId : null;
  const saw = prev.key === key ? prev.saw : false;
  return { key, saw: saw || (key !== null && input.hasVideo) };
}
