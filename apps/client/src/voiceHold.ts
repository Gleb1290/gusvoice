/**
 * Жест кнопки записи голосового (#159, сверено с исходниками Telegram 07.10, #211 G13).
 *
 * Пока поле ввода пустое, на месте «отправить» стоит микрофон:
 * - **держишь** — пишет, **отпустил** — ушло;
 * - **смахнул вверх** — запись фиксируется и идёт без рук, до кнопки «отправить» или корзины;
 * - **смахнул влево** — запись выброшена;
 * - **коснулся и сразу отпустил** — это не сообщение, а промах: запись выбрасываем и подсказываем жест.
 *
 * Пороги — из исходников Telegram, а не на глаз (каждый порог — решение о чужом сообщении: слишком чуткая фиксация
 * не даёт отпустить и отправить, слишком чуткая отмена выбрасывает сказанное):
 * - телефон — Telegram Android `ui/Components/ChatActivityEnterView.java`: замок — 57 dp вверх (`setLockTranslation`),
 *   путь отмены `distCanMove` = min(35 % ширины, 140 dp): дошёл до конца — отмена сразу, отпустил дальше 0,55 пути
 *   (`alpha < 0.45` на ACTION_UP) — тоже отмена; отправляется только запись длиннее 700 мс
 *   (`messenger/MediaController.java`, `stopRecordingInternal`: `duration > 700`);
 * - компьютер — Telegram Desktop `history/view/controls/history_view_voice_record_bar.cpp`: запись стартует, если кнопку
 *   держат дольше `st::universalDuration` (120 мс, `_startTimer`); отпустил вне полосы записи — отмена (`stop(_inField)`);
 *   запись короче секунды не отправляется (`media/audio/media_audio_capture.cpp`: `fullSamples < kCaptureFrequency`).
 *
 * Вся возня с указателем и захватом живёт в `MessagePane`; сюда приходит уже готовое смещение пальца.
 */

export const VOICE_HOLD = {
  /** На сколько пикселей поднять палец, чтобы запись пошла без рук (Android: 57 dp). */
  lockDy: 57,
  /** Полный путь отмены влево (Android `distCanMove`: не больше 140 dp): дошёл — выброшено сразу. */
  cancelDx: 140,
  /** Доля пути отмены, дальше которой отпускание тоже выбрасывает запись (Android: `alpha < 0.45`). */
  cancelShare: 0.55,
  /** Короче — промах, а не сообщение. Android отправляет только `duration > 700`: 700 мс ровно — ещё промах. */
  minHoldMs: 701,
  /**
   * С кружками запись начинается после этого удержания; короче — переключатель «микрофон ↔ камера»
   * (Android `ChatActivityEnterView`: `ACTION_DOWN` → `postDelayed(recordAudioVideoRunnable, 150)`, пока `hasRecordVideo`).
   */
  startDelayMs: 150,
} as const;

/** Компьютер (Telegram Desktop). */
export const VOICE_DESKTOP = {
  /** Столько держать кнопку, чтобы пошла запись удержанием; короче — клик, запись без рук (`st::universalDuration`). */
  holdDelayMs: 120,
  /** Короче секунды запись не отправляется (`media_audio_capture.cpp`). */
  minTakeMs: 1000,
} as const;

/** Путь отмены для экрана шириной `width` (Android: 35 % ширины, но не больше 140 dp). */
export function voiceCancelPath(width?: number): number {
  if (!width || !Number.isFinite(width) || width <= 0) return VOICE_HOLD.cancelDx;
  return Math.min(VOICE_HOLD.cancelDx, Math.round(width * 0.35));
}

export type VoiceHoldStep =
  /** Держит — продолжаем писать. */
  | 'hold'
  /** Поднял палец достаточно высоко — запись идёт без рук. */
  | 'lock'
  /** Увёл влево — выбросить. */
  | 'cancel';

/**
 * Что значит очередное смещение пальца от точки касания. `dx < 0` — влево, `dy < 0` — вверх
 * (экранные координаты). Движение вправо и вниз не значит ничего. `path` — путь отмены (`voiceCancelPath`).
 *
 * ⚠️ Если за одно событие пройдены ОБА порога (быстрый рывок по диагонали), побеждает фиксация: она
 * ничего не теряет — из неё можно выбросить корзиной, а выброшенное уже не вернуть.
 */
export function voiceHoldStep(dx: number, dy: number, path: number = VOICE_HOLD.cancelDx): VoiceHoldStep {
  if (-dy >= VOICE_HOLD.lockDy) return 'lock';
  if (-dx >= path) return 'cancel';
  return 'hold';
}

/** Насколько палец продвинулся к фиксации и к отмене, 0..1 — для подсказок, которые едут за пальцем. */
export function voiceHoldProgress(
  dx: number,
  dy: number,
  path: number = VOICE_HOLD.cancelDx,
): { lock: number; cancel: number } {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  return { lock: clamp(-dy / VOICE_HOLD.lockDy), cancel: clamp(-dx / path) };
}

/**
 * Палец отпущен без фиксации: отправить, промах или отмена. Отмена — если палец увели влево дальше 0,55 пути
 * (Android выбрасывает и тогда, когда до конца пути не дошли).
 */
export function voiceHoldRelease(
  heldMs: number,
  dx = 0,
  path: number = VOICE_HOLD.cancelDx,
): 'send' | 'short' | 'cancel' {
  if (-dx >= path * VOICE_HOLD.cancelShare) return 'cancel';
  return heldMs < VOICE_HOLD.minHoldMs ? 'short' : 'send';
}
