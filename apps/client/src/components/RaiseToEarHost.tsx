import { useEffect } from 'react';

import { raiseToEarWanted, raiseToEarSupported, setRaiseToEar, useRaiseToEarPref } from '../nativeRaiseToEar';
import { useStore } from '../store';
import { useVoicePlayer } from '../voicePlayer';

/**
 * «Поднести к уху» (G67): без разметки, живёт у корня `App`. Пока играет голосовое сообщение и настройка включена — просит
 * нативную сторону слушать датчик приближения (`RaiseToEar.kt`), иначе — отпускает датчик и возвращает звук на громкий.
 * Вне приложения Android (веб, ПК, старый APK, нет датчика) не делает ничего.
 */
export function RaiseToEarHost() {
  const enabled = useRaiseToEarPref();
  const player = useVoicePlayer();
  const inVoiceChannel = useStore((s) => s.voice !== null);
  const wanted = raiseToEarWanted({ enabled, playing: player.playing, hasTrack: player.track !== null, inVoiceChannel });
  useEffect(() => {
    if (!wanted || !raiseToEarSupported()) return;
    setRaiseToEar(true);
    return () => setRaiseToEar(false);
  }, [wanted]);
  return null;
}
