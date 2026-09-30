import { RemoteTrack } from 'livekit-client';

/**
 * Правки поведения livekit-client, которые нельзя задать настройкой. Ставятся ОДИН раз при старте,
 * до первого подключения к комнате (`main.tsx`).
 *
 * 🔴 **Цикл «синхронизации времени» на каждой чужой дорожке (трейс 27.09, #207).** `RemoteTrack`
 * в 2.20.0 на каждую подписанную дорожку — и голос тоже — запускает вечный `requestAnimationFrame`
 * (`registerTimeSyncUpdate`), который каждый кадр читает `getSynchronizationSources()` ради события
 * `TimeSyncUpdate`. Его слушают только хуки расшифровки речи в components-react, у нас их нет.
 * Цена: сам вызов копеечный, но вечный rAF держит страницу в режиме НЕПРЕРЫВНОЙ отрисовки с частотой
 * монитора — пять человек в канале дают ~700 вызовов в секунду и 160 кадров в секунду у страницы, на
 * которой ничего не меняется. Классы `gv-covered`/`gv-game-fg` его не останавливают: под игрой
 * интерфейс продолжал рисоваться. Замер на машине владельца: главный поток страницы 64 → 22 мс в
 * секунду только от этой правки.
 *
 * ⚠️ Метод публичный, но помечен как внутренний: если в новой версии его переименуют, правка молча
 * перестанет действовать — поэтому проверяем, что метод есть, и после обновления livekit-client смотрим
 * трейс или `FireAnimationFrame` в отладке.
 */
export function installLivekitTweaks(): void {
  const proto = RemoteTrack.prototype as unknown as { registerTimeSyncUpdate?: () => void };
  if (typeof proto.registerTimeSyncUpdate === 'function') {
    proto.registerTimeSyncUpdate = function registerTimeSyncUpdateDisabled() {
      /* см. шапку: цикл отрисовки ради неиспользуемого события */
    };
  }
}
