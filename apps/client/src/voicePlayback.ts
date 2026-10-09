/**
 * Воспроизведение голосовых в ленте (07.10, #211, G12): скорость с памятью, «не прослушано», автопереход.
 *
 * Правила — чистые функции (тестируются без DOM); скорость — один на все плееры, живёт в памяти устройства
 * (`localStorage`), а не на сервере: у телефона и компьютера привычки разные, как у Telegram (отдельная запомненная
 * скорость голосовых на каждом устройстве).
 */

/** Скорости, как у Telegram на телефоне: тап по кнопке идёт по кругу 1× → 1,5× → 2× → 1× (Android `FragmentContextView`). */
export const VOICE_SPEEDS = [1, 1.5, 2] as const;
/** Любая скорость из диапазона `VOICE_SPEED_MIN`…`VOICE_SPEED_MAX` с шагом 0,1 (на компьютере её ставит ползунок). */
export type VoiceSpeed = number;

/** Диапазон ползунка скорости Telegram Desktop (`media/media_common.h`: `kSpeedMin` 0,5, `kSpeedMax` 2,5). */
export const VOICE_SPEED_MIN = 0.5;
export const VOICE_SPEED_MAX = 2.5;
/** Ускорение по умолчанию для щелчка по кнопке на компьютере (`kSpedUpDefault`). */
export const VOICE_SPED_UP_DEFAULT = 1.7;

/**
 * Меню скорости на компьютере — пункты Telegram Desktop (`media/player/media_player_dropdown.cpp`, `FillSpeedMenu`:
 * 0,5 · 1 · 1,2 · 1,5 · 1,7 · 2 с подписями `lng_voice_speed_*`).
 */
export const VOICE_SPEED_MENU: readonly { speed: number; label: string }[] = [
  { speed: 0.5, label: 'Медленно' },
  { speed: 1, label: 'Обычно' },
  { speed: 1.2, label: 'Средне' },
  { speed: 1.5, label: 'Быстро' },
  { speed: 1.7, label: 'Очень быстро' },
  { speed: 2, label: 'Сверхбыстро' },
];

const KEY = 'gv.voiceSpeed';
const KEY_UP = 'gv.voiceSpeedUp';

/** Привести к шагу ползунка (0,1, `SliderValueToSpeed`) и диапазону; не число — `null`. */
export function clampVoiceSpeed(n: number): VoiceSpeed | null {
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n * 10) / 10;
  return Math.min(VOICE_SPEED_MAX, Math.max(VOICE_SPEED_MIN, r));
}

/** Следующая скорость по кругу телефона: ближайшая из `VOICE_SPEEDS` выше текущей, после 2× — снова 1×. */
export function nextVoiceSpeed(cur: number): VoiceSpeed {
  return VOICE_SPEEDS.find((s) => s > cur + 1e-9) ?? 1;
}

/** Щелчок по кнопке на компьютере (Telegram Desktop `SpeedController::toggleDefault`): 1× ↔ последнее ускорение. */
export function toggleVoiceSpeed(cur: number, spedUp: number): VoiceSpeed {
  return Math.abs(cur - 1) < 1e-9 ? spedUp : 1;
}

/** Запомненное значение → допустимая скорость; пусто и мусор — 1×, вне диапазона — к его краю. */
export function parseVoiceSpeed(raw: string | null | undefined): VoiceSpeed {
  if (raw === null || raw === undefined || raw.trim() === '') return 1;
  return clampVoiceSpeed(Number(raw)) ?? 1;
}

/** Подпись на кнопке: `1×`, `1,5×`, `2×` (запятая, как в русских подписях Telegram). */
export function voiceSpeedLabel(s: number): string {
  return `${String(s).replace('.', ',')}×`;
}

/**
 * Номер следующего голосового после `cur` среди `count` голосовых ленты (сверху вниз). Текущего нет (`cur` < 0) или оно
 * последнее — `null`: автопереход заканчивается, а не прыгает в начало.
 */
export function nextVoiceIndex(count: number, cur: number): number | null {
  return cur >= 0 && cur + 1 < count ? cur + 1 : null;
}

/**
 * Синяя точка «не прослушано»: сервер прислал признак (`voiceListened`, `voice1`) и он `false`, а я в этом сеансе ещё не
 * запускал это голосовое. У чужого — «я не слушал», у своего — «собеседник не слушал». Нет признака — точек нет вовсе.
 */
export function voiceUnheard(listened: boolean | undefined, heardNow: boolean): boolean {
  return listened === false && !heardNow;
}

/** Сказать серверу «прослушал»: только чужое голосовое с признаком `false` и только один раз за показ. */
export function shouldReportListened(mine: boolean, listened: boolean | undefined, heardNow: boolean): boolean {
  return !mine && voiceUnheard(listened, heardNow);
}

// ─── Скорость: одна на все плееры, с памятью устройства ───────────────────────────────
let speed: VoiceSpeed | null = null;
const listeners = new Set<(s: VoiceSpeed) => void>();

export function getVoiceSpeed(): VoiceSpeed {
  if (speed) return speed;
  try {
    speed = parseVoiceSpeed(localStorage.getItem(KEY));
  } catch {
    speed = 1;
  }
  return speed;
}

/** Последнее ускорение (не 1×) — его возвращает щелчок по кнопке на компьютере; по умолчанию 1,7×. */
export function getVoiceSpedUp(): VoiceSpeed {
  try {
    const raw = localStorage.getItem(KEY_UP);
    const v = raw ? parseVoiceSpeed(raw) : VOICE_SPED_UP_DEFAULT;
    return Math.abs(v - 1) < 1e-9 ? VOICE_SPED_UP_DEFAULT : v;
  } catch {
    return VOICE_SPED_UP_DEFAULT;
  }
}

/** Сменить скорость: все играющие и будущие плееры подхватывают её; значение переживает перезапуск. */
export function setVoiceSpeed(value: VoiceSpeed): void {
  const next = clampVoiceSpeed(value) ?? 1;
  speed = next;
  try {
    localStorage.setItem(KEY, String(next));
    if (Math.abs(next - 1) > 1e-9) localStorage.setItem(KEY_UP, String(next));
  } catch {
    /* хранилище закрыто — скорость живёт до перезагрузки */
  }
  for (const fn of listeners) fn(next);
}

export function subscribeVoiceSpeed(fn: (s: VoiceSpeed) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ─── Общий плеер (`voicePlayer.ts`): ключи и автопереход ──────────────────────────────
/**
 * Ключ дорожки общего плеера: голосовое ленты — `сообщение:вложение` (одно вложение может прийти в двух сообщениях —
 * пересылка), запись перед отправкой — `local:url`. Им же помечен пузырь (`data-voice`).
 */
export function voiceTrackKey(messageId: string | undefined, att: string | undefined, url: string): string {
  return messageId && att ? `${messageId}:${att}` : `local:${url}`;
}

/** Ключ «прослушал в этом сеансе»: беседа + сообщение. */
export function voiceHeardKey(conversationId: string, messageId: string): string {
  return `${conversationId}:${messageId}`;
}

/**
 * Автопереход (AD-03): следующее после `cur` в порядке ленты (сверху вниз). Текущего нет в порядке или оно последнее —
 * `null`: серия заканчивается, а не прыгает в начало.
 */
export function nextVoiceKey(order: readonly string[], cur: string): string | null {
  const i = nextVoiceIndex(order.length, order.indexOf(cur));
  return i === null ? null : order[i];
}

/**
 * Автопереход с фильтром (G84, Telegram Android `MediaController`: `voiceMessagesPlaylistUnread`): следующее после `cur`,
 * для которого `ok` — правда. Список строится от нажатого: нажато непрослушанное — играют только непрослушанные чужие.
 */
export function nextVoiceKeyWhere(order: readonly string[], cur: string, ok: (key: string) => boolean): string | null {
  const i = order.indexOf(cur);
  if (i < 0) return null;
  for (let j = i + 1; j < order.length; j++) if (ok(order[j])) return order[j];
  return null;
}

/** Предыдущее по порядку ленты (кнопка «предыдущее» полосы плеера, Telegram Desktop `Widget::_previousTrack`). */
export function prevVoiceKey(order: readonly string[], cur: string): string | null {
  const i = order.indexOf(cur);
  return i > 0 ? order[i - 1] : null;
}

/** Тайм-код для «Ответить с тайм-кодом» (Telegram Desktop `CurrentVoiceTimecode`): `м:сс`, с часами — `ч:мм:сс`. */
export function voiceTimecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * Ширина огибающей голосового в пузыре ЛС, px — от длительности, как у Telegram Web (tweb `components/audio.tsx`
 * `createWaveformBars`: `clamp(duration / 60 * maxW, minW, maxW)`): минута и длиннее — во всю ширину, короткое — уже.
 * Компьютер 190…256, телефон (`phone`) 152…190. Нет длительности — самое узкое.
 */
export const VOICE_WAVE_W = { min: 190, max: 256, phoneMin: 152, phoneMax: 190 } as const;
export function voiceWaveWidth(durationMs: number, phone: boolean): number {
  const min = phone ? VOICE_WAVE_W.phoneMin : VOICE_WAVE_W.min;
  const max = phone ? VOICE_WAVE_W.phoneMax : VOICE_WAVE_W.max;
  const sec = Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : 0;
  return Math.round(Math.min(max, Math.max(min, (sec / 60) * max)));
}
