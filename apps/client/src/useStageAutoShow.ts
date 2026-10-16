import { useLayoutEffect, useRef } from 'react';
import { ConnectionState, RoomEvent, type Room } from 'livekit-client';
import { setHideNoVideo } from './stageViewPrefs';
import { canAutoShowStage, nextStageVideoSeen, STAGE_AUTO_SHOW_DELAY_MS, type StageVideoSeen } from './stageAutoShowRules';

/** Возврат людей после 3 с без видео — только если видео в канале было и закончилось. Сетевой разрыв отменяет отсчёт непосредственно событием комнаты. */
export function useStageAutoShow(input: {
  room: Room; channelId: string | null; hideNoVideo: boolean; hasVideo: boolean;
}): void {
  const { room, channelId, hideNoVideo, hasVideo } = input;
  const seen = useRef<StageVideoSeen>({ key: null, saw: false });
  useLayoutEffect(() => {
    seen.current = nextStageVideoSeen(seen.current, { hideNoVideo, channelId, hasVideo });
    const sawVideo = seen.current.saw;
    let timer: number | null = null;
    const cancel = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const reconcile = () => {
      cancel();
      if (!canAutoShowStage({ channelId, hideNoVideo, hasVideo, sawVideo, connected: room.state === ConnectionState.Connected })) return;
      const scheduled = window.setTimeout(() => {
        // Отменённый callback ничего не делает, даже если уже попал в очередь событий.
        if (timer !== scheduled) return;
        timer = null;
        if (room.state === ConnectionState.Connected) setHideNoVideo(false);
      }, STAGE_AUTO_SHOW_DELAY_MS);
      timer = scheduled;
    };
    // Layout effect снимает таймер синхронно с commit нового видео/настройки/канала, до следующего таймера.
    room.on(RoomEvent.ConnectionStateChanged, reconcile);
    reconcile();
    return () => {
      cancel();
      room.off(RoomEvent.ConnectionStateChanged, reconcile);
    };
  }, [room, channelId, hideNoVideo, hasVideo]);
}
