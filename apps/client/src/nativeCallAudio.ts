import { isAndroid } from './hotkeys';

/**
 * Вывод звука звонка 1:1 на Android — кнопка «Динамик» экрана звонка (13.10, #218). Мост — `window.GusVoiceNative.callAudio*`
 * (`MainActivity.kt` → `CallAudio.kt`). Telegram Android: `VoIPFragment.setSpeakerPhoneAction` / `updateSpeakerPhoneIcon`,
 * `VoIPService.toggleSpeakerphoneOrShowRouteSheet`.
 *
 * Только в приложении Android: на вебе и на ПК объекта нет (у Telegram Desktop такой кнопки тоже нет — звук идёт на
 * выбранное в настройках устройство), и у старого APK без этих методов — тоже: нет моста = нет кнопки.
 */

/** Вид вывода: у уха, громкий, проводные наушники, Bluetooth. Имена общие с `CallAudio.kt`. */
export type CallRoute = 'earpiece' | 'speaker' | 'wired' | 'bluetooth';

export interface CallAudioDevice {
  kind: CallRoute;
  /** Имя гарнитуры (Bluetooth) — если система его отдала. */
  name?: string;
}

export interface CallAudioState {
  /** Куда звук идёт сейчас. */
  route: CallRoute;
  /** Что можно выбрать (в порядке показа). */
  devices: CallAudioDevice[];
}

interface CallAudioBridge {
  callAudioStart(video: boolean): void;
  callAudioStop(): void;
  callAudioSelect(kind: string): void;
  callAudioState(): string;
  /** Нет в APK до 14.10: звать только после проверки `typeof`. */
  callAudioSetCommMode?(on: boolean): void;
}

const KINDS: readonly CallRoute[] = ['earpiece', 'speaker', 'wired', 'bluetooth'];

function isKind(v: unknown): v is CallRoute {
  return typeof v === 'string' && (KINDS as readonly string[]).includes(v);
}

function bridge(): CallAudioBridge | null {
  if (!isAndroid()) return null;
  const b = (window as unknown as { GusVoiceNative?: Partial<CallAudioBridge> }).GusVoiceNative;
  if (!b || typeof b.callAudioStart !== 'function' || typeof b.callAudioState !== 'function' || typeof b.callAudioSelect !== 'function') return null;
  return b as CallAudioBridge;
}

/** Мост вывода звука есть (приложение Android достаточно нового выпуска). */
export function callAudioSupported(): boolean {
  return bridge() !== null;
}

/** Разбор ответа `callAudioState()`; мусор, пустая строка, неизвестные виды — `null` / отбрасываются. */
export function parseCallAudioState(json: string): CallAudioState | null {
  try {
    const o = JSON.parse(json) as { route?: unknown; devices?: unknown };
    if (!isKind(o.route) || !Array.isArray(o.devices)) return null;
    const devices: CallAudioDevice[] = [];
    for (const d of o.devices as { kind?: unknown; name?: unknown }[]) {
      if (!d || !isKind(d.kind) || devices.some((x) => x.kind === d.kind)) continue;
      devices.push(typeof d.name === 'string' && d.name ? { kind: d.kind, name: d.name } : { kind: d.kind });
    }
    return { route: o.route, devices };
  } catch {
    return null;
  }
}

/**
 * Что делает нажатие на кнопку (Telegram `toggleSpeakerphoneOrShowRouteSheet`): есть Bluetooth и разговорный динамик —
 * лист выбора («Динамик / Телефон / Bluetooth»); иначе переключатель «громкий ↔ остальное». Мало устройств — `null` (кнопка скрыта).
 */
export function speakerPress(s: CallAudioState): { sheet: true } | { to: CallRoute } | null {
  const kinds = s.devices.map((d) => d.kind);
  const has = (k: CallRoute) => kinds.includes(k);
  if (has('bluetooth') && has('earpiece')) return { sheet: true };
  if (kinds.length < 2) return null;
  if (s.route === 'speaker') {
    const other = has('wired') ? 'wired' : has('earpiece') ? 'earpiece' : has('bluetooth') ? 'bluetooth' : null;
    return other ? { to: other } : null;
  }
  return has('speaker') ? { to: 'speaker' } : null;
}

export function readCallAudio(): CallAudioState | null {
  const b = bridge();
  if (!b) return null;
  try {
    return parseCallAudioState(b.callAudioState());
  } catch (e) {
    console.warn('[call-audio] callAudioState failed:', e);
    return null;
  }
}

/**
 * Разговорный режим звука (`MODE_IN_COMMUNICATION`) на время звонка — для проверки на устройстве без пересборки:
 * `localStorage['gv.callAudio.commMode'] = '1'` (в консоли WebView), снять — `removeItem`. По умолчанию выключен (риск Samsung, см. `CallAudio.kt`).
 */
export function commModeWanted(): boolean {
  try {
    return localStorage.getItem('gv.callAudio.commMode') === '1';
  } catch {
    return false;
  }
}

/** Разговор начался: взять вывод звука. [video] — видеозвонок → громкий, голосовой → у уха (Telegram `VoIPService`). */
export function startCallAudio(video: boolean): void {
  try {
    const b = bridge();
    if (b && typeof b.callAudioSetCommMode === 'function') b.callAudioSetCommMode(commModeWanted());
    b?.callAudioStart(video);
  } catch (e) {
    console.warn('[call-audio] callAudioStart failed:', e);
  }
}

/** Разговор кончился: вернуть прежний режим звука. */
export function stopCallAudio(): void {
  try {
    bridge()?.callAudioStop();
  } catch (e) {
    console.warn('[call-audio] callAudioStop failed:', e);
  }
}

export function selectCallRoute(kind: CallRoute): void {
  try {
    bridge()?.callAudioSelect(kind);
  } catch (e) {
    console.warn('[call-audio] callAudioSelect failed:', e);
  }
}

const listeners = new Set<() => void>();

/** Подписка на «вывод изменился» (нативная сторона зовёт `window.__gvCallAudioChanged`). Возвращает отписку. */
export function onCallAudioChanged(cb: () => void): () => void {
  const w = window as unknown as { __gvCallAudioChanged?: () => void };
  listeners.add(cb);
  w.__gvCallAudioChanged = () => {
    for (const l of [...listeners]) l();
  };
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) delete w.__gvCallAudioChanged;
  };
}
