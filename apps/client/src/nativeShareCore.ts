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

/** Что сейчас показывается нативным показом: окно (HWND) или экран. */
export interface NativeSource {
  sourceId: string;
  isWindow: boolean;
}

/** Один и тот же источник? Сравнение по ПАРЕ: id окна и id экрана — разные пространства и могут совпасть. */
export function sameNativeSource(a: NativeSource | null | undefined, b: NativeSource | null | undefined): boolean {
  return !!a && !!b && a.sourceId === b.sourceId && a.isWindow === b.isWindow;
}

/** Что стало со звуком показа после смены источника. */
export type SwitchAudioResult = 'none' | 'retargeted' | 'started' | 'stopped' | 'failed';

/** Что делать со звуком при смене: хочет ли человек звук (настройка «Транслировать звук» в окне смены) и как его поднять, если не шёл. */
export interface NativeSwitchAudio {
  wantAudio: boolean;
  startAudio?: (() => Promise<void>) | null;
}

export interface NativeSwitchResult {
  outcome: string;
  audio: SwitchAudioResult;
  /** Текст ошибки звука (для тоста), если `audio === 'failed'`. */
  audioError?: string;
}

export interface NativeShareSession {
  /**
   * Запомнить teardown системного звука (или `null`, если звук не поднялся) и, если есть, ручку
   * `retarget` — перевод того же захвата на другую цель (#237).
   */
  setAudioStop(fn: (() => Promise<void>) | null, retarget?: ((next?: { sourceId: string }) => Promise<void>) | null): void;
  hasAudio(): boolean;
  stopAudio(): Promise<void>;
  markSharing(source?: NativeSource | null): void;
  isSharing(): boolean;
  /** Текущий источник нативного показа; `null` — не идёт или не знаем. */
  getSource(): NativeSource | null;
  /**
   * Сменить источник на лету (#237). Порядок и есть контракт:
   *  1. СНАЧАЛА видео. Отказ видео — бросаем дальше, текущий источник и звук НЕ трогаются;
   *  2. текущий источник обновляется только после успеха видео;
   *  3. звук — только после видео: шёл и нужен → `retarget`; нужен, но не шёл → `startAudio` (звук включён
   *     в настройках, но на старте не поднялся); шёл, но больше не нужен → гасим; не шёл и не нужен → не трогаем;
   *  4. отказ `retarget` → звук гасим (Rust не гасит прошлый захват при отказе, и играло бы СТАРОЕ приложение).
   * Источник тот же (`same`) → ни звука, ни обновлений.
   */
  switchTo(
    next: NativeSource,
    switchVideo: (next: NativeSource) => Promise<string>,
    audio?: NativeSwitchAudio,
  ): Promise<NativeSwitchResult>;
  stop(): Promise<void>;
  stopIfActive(): Promise<void>;
}

export function createNativeShareSession(deps: NativeShareDeps): NativeShareSession {
  /** Остановка нативного WASAPI-захвата системного звука, если он запущен. */
  let audioStop: (() => Promise<void>) | null = null;
  /** Перевод идущего звука на другую цель (#237); живёт ровно столько же, сколько `audioStop`. */
  let audioRetarget: ((next?: { sourceId: string }) => Promise<void>) | null = null;
  let source: NativeSource | null = null;

  const setAudioStop = (
    fn: (() => Promise<void>) | null,
    retarget?: ((next?: { sourceId: string }) => Promise<void>) | null,
  ): void => {
    audioStop = fn;
    audioRetarget = fn ? (retarget ?? null) : null;
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
    audioRetarget = null;
    if (fn) await fn().catch(() => {});
  };

  return {
    setAudioStop,
    hasAudio: () => audioStop !== null,
    stopAudio,
    markSharing: (src) => {
      source = src ?? null;
      deps.setSharing(true);
    },
    isSharing: () => deps.getSharing(),
    getSource: () => source,

    switchTo: async (next, switchVideo, audio) => {
      if (!deps.getSharing()) throw new Error('показ не идёт');
      const outcome = await switchVideo(next); // отказ — наружу; source/звук не тронуты
      if (outcome === 'same') {
        source = next;
        return { outcome, audio: 'none' };
      }
      source = next;
      if (audio && !audio.wantAudio) {
        if (audioStop === null) return { outcome, audio: 'none' };
        await stopAudio();
        return { outcome, audio: 'stopped' };
      }
      const retarget = audioRetarget;
      if (retarget) {
        try {
          await retarget(next.isWindow ? { sourceId: next.sourceId } : undefined);
          return { outcome, audio: 'retargeted' };
        } catch (e) {
          await stopAudio();
          return { outcome, audio: 'failed', audioError: String((e as Error)?.message ?? e) };
        }
      }
      if (audio?.startAudio && audioStop === null) {
        try {
          await audio.startAudio();
          return { outcome, audio: 'started' };
        } catch (e) {
          return { outcome, audio: 'failed', audioError: String((e as Error)?.message ?? e) };
        }
      }
      return { outcome, audio: 'none' };
    },

    /**
     * Погасить нативную трансляцию целиком.
     *
     * ⚠️ Флаг снимаем ПЕРВЫМ, до любого `await`: teardown на стороне Rust — fire-and-forget, и если
     * ждать его перед сменой флага, кнопка «Завершить стрим» выглядит подвисшей.
     */
    stop: async (): Promise<void> => {
      source = null;
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
      source = null;
      deps.setSharing(false);
      await deps.stopCapture().catch(() => {});
      await stopAudio();
    },
  };
}
