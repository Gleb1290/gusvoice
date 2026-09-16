/**
 * Ядро сессии нативной трансляции — БЕЗ импорта стора, Tauri и звуков.
 *
 * Вынесено по просьбе Codex (2026-08-01). До этого состояние жило прямо в `nativeShareSession.ts`,
 * а тот тянет `useStore` и Tauri-обёртки — то есть в Node не грузился, и ни один инвариант проверить
 * было нельзя. Здесь всё, что можно посчитать: владение teardown'ом системного звука и порядок
 * гашения. Настоящие зависимости подставляет `nativeShareSession.ts`, подписку на события и тосты он
 * же оставляет себе.
 *
 * ⚠️ Само владение состоянием ВНЕ React — это #96: `VoiceControls` живёт в сайдбаре, который при
 * переходе в личные сообщения подменяется целиком, и локальные `useState`/`useRef` умирали вместе с
 * ним, обрывая трансляцию у всех зрителей.
 */

export interface NativeShareDeps {
  /** Остановить нативный захват (в приложении — Tauri-команда). */
  stopCapture: () => Promise<void>;
  /** Идёт ли трансляция (в приложении — флаг в сторе). */
  getSharing: () => boolean;
  setSharing: (v: boolean) => void;
}

export interface NativeShareSession {
  /** Запомнить teardown системного звука (или `null`, если звук не поднялся). */
  setAudioStop(fn: (() => Promise<void>) | null): void;
  hasAudio(): boolean;
  stopAudio(): Promise<void>;
  markSharing(): void;
  isSharing(): boolean;
  stop(): Promise<void>;
  stopIfActive(): Promise<void>;
}

export function createNativeShareSession(deps: NativeShareDeps): NativeShareSession {
  /** Остановка нативного WASAPI-захвата системного звука, если он запущен. */
  let audioStop: (() => Promise<void>) | null = null;

  const setAudioStop = (fn: (() => Promise<void>) | null): void => {
    audioStop = fn;
  };

  /**
   * Погасить захват системного звука.
   *
   * ⚠️ Ссылка обнуляется ДО `await` — на этом держится идемпотентность. Переставь строки местами, и
   * два параллельных вызова (кнопка + сторож источника) дёрнут teardown дважды.
   */
  const stopAudio = async (): Promise<void> => {
    const fn = audioStop;
    audioStop = null;
    if (fn) await fn().catch(() => {});
  };

  return {
    setAudioStop,
    hasAudio: () => audioStop !== null,
    stopAudio,
    markSharing: () => deps.setSharing(true),
    isSharing: () => deps.getSharing(),

    /**
     * Погасить нативную трансляцию целиком.
     *
     * ⚠️ Флаг снимаем ПЕРВЫМ, до любого `await`: teardown на стороне Rust — fire-and-forget, и если
     * ждать его перед сменой флага, кнопка «Завершить стрим» выглядит подвисшей.
     */
    stop: async (): Promise<void> => {
      deps.setSharing(false);
      await deps.stopCapture().catch(() => {});
      await stopAudio();
    },

    /**
     * То же, но молча и только если трансляция реально идёт — для teardown при уходе из канала.
     *
     * ⚠️ Системный звук гасится ДАЖЕ когда нативной трансляции нет. Это не небрежность: на десктопе
     * живёт отдельная комбинация «видео браузерным путём + звук нативным», и её teardown терялся
     * вместе с компонентом ровно так же — стрим-звук продолжал вещать после остановки показа.
     */
    stopIfActive: async (): Promise<void> => {
      if (!deps.getSharing()) {
        await stopAudio();
        return;
      }
      deps.setSharing(false);
      await deps.stopCapture().catch(() => {});
      await stopAudio();
    },
  };
}
