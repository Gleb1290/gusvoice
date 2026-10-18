/**
 * Кнопки микрофона вне страницы (#156): действия из уведомления голосовой службы Android (а следующей порцией — из пузыря
 * поверх приложений) и состояние, которое страница отдаёт нативу. Здесь только решения — без DOM, стора и моста; провода —
 * `nativeMicActions.ts` и эффект рации в `VoiceConnection.tsx`.
 *
 * Мьют сильнее рации, как в Discord: заглушённый (или «Не слышу») зажатием рации микрофон не открывает.
 */

/** Что натив может попросить у страницы (`window.__gvMicAction(action)`). */
export type MicAction = 'toggle-mute' | 'toggle-deafen' | 'leave' | 'ptt-down' | 'ptt-up';

const ACTIONS: readonly MicAction[] = ['toggle-mute', 'toggle-deafen', 'leave', 'ptt-down', 'ptt-up'];

/** Строка от натива → действие; неизвестное (новый APK со старой страницей и наоборот) — `null`, игнор. */
export function parseMicAction(raw: unknown): MicAction | null {
  return typeof raw === 'string' && (ACTIONS as readonly string[]).includes(raw) ? (raw as MicAction) : null;
}

/** Что сделать страницей: переключатели — `voiceSelf.ts`, выход — `leaveVoice`, рация — `start`/`end` эффекта PTT. */
export type MicEffect = 'toggle-mute' | 'toggle-deafen' | 'leave' | 'ptt-start' | 'ptt-end' | 'none';

export interface MicActionContext {
  /** Голос идёт (`voice` в сторе). */
  inVoice: boolean;
  /** Режим рации включён в настройках. */
  pushToTalk: boolean;
}

/**
 * Действие → эффект. Вне голоса — ничего: кнопку уведомления нажали после выхода (гонка со снятием службы), и молча
 * менять сохранённые мьют/«Не слышу» нельзя. Рация — только в режиме рации; «отпустить» без режима тоже ничего: держать
 * нечего (режим выключили — эффект PTT сам закрыл микрофон).
 */
export function micActionEffect(action: MicAction, ctx: MicActionContext): MicEffect {
  if (!ctx.inVoice) return 'none';
  switch (action) {
    case 'toggle-mute':
      return 'toggle-mute';
    case 'toggle-deafen':
      return 'toggle-deafen';
    case 'leave':
      return 'leave';
    case 'ptt-down':
      return ctx.pushToTalk ? 'ptt-start' : 'none';
    case 'ptt-up':
      return ctx.pushToTalk ? 'ptt-end' : 'none';
  }
}

/** Может ли зажатие рации открыть микрофон: не заглушён и не «Не слышу». */
export function pttCanOpen(muted: boolean, deafened: boolean): boolean {
  return !muted && !deafened;
}

/** Состояние для натива (`GusVoiceNative.micState(json)`): вне голоса — только `{inVoice:false}`. */
export type MicState =
  | { inVoice: false }
  | {
      inVoice: true;
      muted: boolean;
      deafened: boolean;
      ptt: boolean;
      speaking: boolean;
      channelName: string;
      /**
       * Задержка отпускания рации, мс (17.10). Её отсчитывает натив (`MicBubble`) и только потом шлёт `ptt-up`: у свёрнутого
       * приложения таймеры страницы стоят, и закрытие по `setTimeout` повисало до возврата в приложение — микрофон
       * оставался открытым после отпускания.
       */
      pttReleaseMs: number;
    };

export interface MicStateInput {
  inVoice: boolean;
  muted: boolean;
  deafened: boolean;
  ptt: boolean;
  /** СВОЙ `liveVoice[selfId].speaking` (чужие сюда не попадают). */
  selfSpeaking: boolean;
  channelName: string;
  pttReleaseMs: number;
}

/**
 * Сборка состояния. `speaking` — только при открытом микрофоне: заглушённый или «Не слышу» не «говорит», даже если
 * уровень дорожки ещё не успел упасть (кольцо в `VoiceConnection` гасится так же).
 */
export function micStateOf(i: MicStateInput): MicState {
  if (!i.inVoice) return { inVoice: false };
  return {
    inVoice: true,
    muted: i.muted,
    deafened: i.deafened,
    ptt: i.ptt,
    speaking: i.selfSpeaking && !i.muted && !i.deafened,
    channelName: i.channelName,
    pttReleaseMs: Math.max(0, Math.round(i.pttReleaseMs) || 0),
  };
}

/** Одинаковые ли состояния — слать нативу только изменения. */
export function sameMicState(a: MicState | null, b: MicState): boolean {
  return a != null && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Пузырь микрофона поверх приложений (#156, порция 2, `MicBubble.kt`): подсказка под тумблером рации на телефоне. Без
 * пузыря рацию на Android зажать нечем — человек в режиме рации немеет. Старый APK без пузыря (`supported: false`) —
 * подсказки нет: включить там нечего.
 */
export function needsMicBubbleHint(i: { supported: boolean; pushToTalk: boolean; micBubble: boolean }): boolean {
  return i.supported && i.pushToTalk && !i.micBubble;
}

/**
 * Что делает тумблер «Кнопка поверх приложений» при включении: `enable` — разрешение «Показ поверх других приложений»
 * уже есть; `ask` — сначала своё окно с объяснением и переход в настройки Android. Выключение — всегда `disable`.
 */
export function micBubbleToggle(on: boolean, canDraw: boolean): 'enable' | 'ask' | 'disable' {
  if (!on) return 'disable';
  return canDraw ? 'enable' : 'ask';
}
