/**
 * Подсказка «Удерживайте кнопку отправки, чтобы отправить позже или без звука» (07.10, #211, G46). Источник — Telegram Android
 * `ChatActivity.showScheduledOrNoSoundHint` / `showScheduledOrNoSoundRunnable` и `SharedConfig.scheduledOrNoSoundHintShows`:
 * показывается у кнопки отправки, когда в поле уже есть хотя бы 5 знаков; не больше 3 раз за всё время и не чаще раза в
 * сутки (`86400000` мс от прошлого показа). Телефон: на ПК у кнопки правый щелчок, подсказка не нужна. Счётчик живёт на
 * устройстве (localStorage), как `SharedConfig` у Telegram: аккаунт не синкает.
 */
export const SEND_HINT_MAX = 3;
export const SEND_HINT_GAP_MS = 86_400_000;
/** Сколько знаков в поле должно быть, чтобы подсказка имела смысл (`getEditField().getText().length() < 5` — не показывать). */
export const SEND_HINT_MIN_CHARS = 5;
/** Сколько подсказка висит над кнопкой, мс. */
export const SEND_HINT_MS = 5000;
export const SEND_HINT_TEXT = 'Удерживайте кнопку отправки, чтобы отправить позже или без звука';

const KEY = 'gv.hint.sendHold';

export interface SendHintState {
  /** Сколько раз уже показывали. */
  shows: number;
  /** Когда показывали в последний раз (мс), 0 — никогда. */
  at: number;
}

/** Пора ли показать: меньше трёх показов, с прошлого прошли сутки, в поле достаточно знаков. */
export function sendHintDue(s: SendHintState, now: number, chars: number): boolean {
  return chars >= SEND_HINT_MIN_CHARS && s.shows < SEND_HINT_MAX && now - s.at >= SEND_HINT_GAP_MS;
}

export function readSendHint(): SendHintState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<SendHintState> | null;
    const shows = Number(raw?.shows);
    const at = Number(raw?.at);
    return { shows: Number.isFinite(shows) && shows > 0 ? Math.floor(shows) : 0, at: Number.isFinite(at) && at > 0 ? at : 0 };
  } catch {
    return { shows: 0, at: 0 };
  }
}

/** Записать показ (`increaseScheduledOrNoSoundHintShowed`). */
export function noteSendHintShown(now: number): void {
  try {
    const s = readSendHint();
    localStorage.setItem(KEY, JSON.stringify({ shows: s.shows + 1, at: now }));
  } catch {
    /* хранилище недоступно — подсказки просто не будет считаться */
  }
}
