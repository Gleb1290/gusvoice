import { getAudioSettings, subscribeAudioSettings } from './audioSettings';
import { isAndroid } from './hotkeys';
import { micActionEffect, micStateOf, parseMicAction, sameMicState, type MicState } from './micActionRules';
import { useStore } from './store';
import { toggleSelfDeafen, toggleSelfMute } from './voiceSelf';

/**
 * Кнопки микрофона вне страницы на Android (#156): уведомление голосовой службы (`VoiceForegroundService.kt`) — «Микрофон»,
 * «Не слышу», «Выйти»; следующей порцией — пузырь поверх приложений с рацией. Решения — `micActionRules.ts`.
 *
 *   - натив → страница: `window.__gvMicAction('toggle-mute' | 'toggle-deafen' | 'leave' | 'ptt-down' | 'ptt-up')`
 *     (`VoiceActionReceiver.kt` через живой WebView `MainActivity`); неизвестное — игнор;
 *   - страница → натив: `GusVoiceNative.micState(json)` — `{inVoice, muted, deafened, ptt, speaking, channelName}` при смене
 *     любого поля, `{inVoice:false}` при выходе из голоса; у старого APK метода нет — тихо ничего;
 *   - пузырь поверх приложений (порция 2, `MicBubble.kt`): `micBubbleSet(enabled)` — настройка `micBubble` при каждой смене,
 *     `canDrawOverlays()` / `openOverlaySettings()` — разрешение «Показ поверх других приложений» для тумблера в настройках.
 *
 * Рация: эффект PTT в `VoiceConnection` регистрирует свои `start`/`end` через [onMicPtt] (как десктопный `onNativePtt`);
 * без зарегистрированного (не в голосе) нажатия рации теряются — держать нечего.
 */
interface MicBridge {
  micState?(json: string): void;
  micBubbleSet?(enabled: boolean): void;
  canDrawOverlays?(): boolean;
  openOverlaySettings?(): boolean;
}

function bridge(): MicBridge | null {
  if (!isAndroid()) return null;
  return (window as unknown as { GusVoiceNative?: MicBridge }).GusVoiceNative ?? null;
}

let ptt: { down: () => void; up: () => void } | null = null;

/** Эффект рации: принимать нажатия натива. Возвращает отписку (снимает только свою регистрацию). */
export function onMicPtt(down: () => void, up: () => void): () => void {
  const mine = { down, up };
  ptt = mine;
  return () => {
    if (ptt === mine) ptt = null;
  };
}

function handle(raw: unknown): void {
  const action = parseMicAction(raw);
  if (!action) return;
  const effect = micActionEffect(action, {
    inVoice: useStore.getState().voice != null,
    pushToTalk: getAudioSettings().pushToTalk,
  });
  switch (effect) {
    case 'toggle-mute':
      return toggleSelfMute();
    case 'toggle-deafen':
      return toggleSelfDeafen();
    case 'leave':
      // Тот же выход, что у кнопки «Отключиться» (`MobileCallChip`, `VoiceChannelView`).
      return useStore.getState().leaveVoice();
    case 'ptt-start':
      return ptt?.down();
    case 'ptt-end':
      return ptt?.up();
    case 'none':
      return;
  }
}

let last: MicState | null = null;

function currentState(): MicState {
  const s = useStore.getState();
  const v = s.voice;
  const selfId = v ? (v.selfId ?? s.user?.id ?? null) : null;
  return micStateOf({
    inVoice: v != null,
    muted: s.selfMuted,
    deafened: s.selfDeafened,
    ptt: getAudioSettings().pushToTalk,
    selfSpeaking: selfId != null && (s.liveVoice[selfId]?.speaking ?? false),
    channelName: v?.channelName ?? '',
    pttReleaseMs: getAudioSettings().pttReleaseMs,
  });
}

/** Отдать состояние нативу, если оно изменилось. Первое «вне голоса» на старте не шлём: служба ещё не поднималась. */
export function pushMicState(state: MicState): void {
  if (sameMicState(last, state)) return;
  if (last == null && !state.inVoice) {
    last = state;
    return;
  }
  last = state;
  const b = bridge();
  if (typeof b?.micState !== 'function') return;
  try {
    b.micState(JSON.stringify(state));
  } catch (e) {
    console.warn('[native-mic] micState failed:', e);
  }
}

/** Есть ли у APK пузырь микрофона (порция 2): старый APK без методов — строки настройки нет. */
export function micBubbleSupported(): boolean {
  const b = bridge();
  return (
    typeof b?.micBubbleSet === 'function' &&
    typeof b.canDrawOverlays === 'function' &&
    typeof b.openOverlaySettings === 'function'
  );
}

/** Выдано ли «Показ поверх других приложений». Нет моста или ошибка — false. */
export function canDrawOverlays(): boolean {
  const b = bridge();
  if (typeof b?.canDrawOverlays !== 'function') return false;
  try {
    return b.canDrawOverlays() === true;
  } catch {
    return false;
  }
}

/** Открыть экран Android «Показ поверх других приложений» для GusVoice. */
export function openOverlaySettings(): void {
  try {
    bridge()?.openOverlaySettings?.();
  } catch (e) {
    console.warn('[native-mic] openOverlaySettings failed:', e);
  }
}

let lastBubble: boolean | null = null;

/** Отдать нативу настройку пузыря, если она изменилась (включение заново возвращает спрятанный крестиком пузырь). */
function pushMicBubble(enabled: boolean): void {
  if (lastBubble === enabled) return;
  const b = bridge();
  if (typeof b?.micBubbleSet !== 'function') return;
  lastBubble = enabled;
  try {
    b.micBubbleSet(enabled);
  } catch (e) {
    console.warn('[native-mic] micBubbleSet failed:', e);
  }
}

let installed = false;

/** Один раз на старте (`main.tsx`); вне Android — ничего. */
export function installNativeMicActions(): void {
  if (installed || !isAndroid()) return;
  installed = true;
  (window as unknown as { __gvMicAction?: (a: unknown) => void }).__gvMicAction = (a) => {
    try {
      handle(a);
    } catch (e) {
      console.warn('[native-mic] action failed:', e);
    }
  };
  const sync = () => pushMicState(currentState());
  // Стор меняется часто (сообщения, присутствие) — `sameMicState` отсекает всё, что не меняет состояния микрофона.
  useStore.subscribe(sync);
  subscribeAudioSettings((s) => {
    sync();
    pushMicBubble(s.micBubble === true);
  });
  sync();
  pushMicBubble(getAudioSettings().micBubble === true);
}
