/**
 * Звонки 1:1 в ЛС (08.10, #211, С5, `calls1`) — чистые правила клиента: что показать ЭТОМУ устройству по событию звонка
 * и как подписать фазу. Стор — `callStore.ts`, разметка и медиа — `components/CallLayer.tsx`.
 */
import { FEATURE_CALLS1, FEATURE_CALLS2, callDurationText, type DmCall } from '@gusvoice/shared';

/**
 * Вид звонка на этом устройстве: `incoming` — мне звонят (на всех моих устройствах, пока никто не ответил), `outgoing` —
 * я звоню с ЭТОГО устройства, `active` — разговор идёт на этом устройстве, `elsewhere` — звонок мой, но ведёт его другое
 * моё устройство (звоню с телефона, ответил на телефоне) — здесь не звонить и не показывать, `none` — звонок не мой или
 * кончился.
 */
export type CallView = 'incoming' | 'outgoing' | 'active' | 'elsewhere' | 'none';

export function callViewFor(call: DmCall | null, me: string | null | undefined, device: string): CallView {
  if (!call || !me || call.phase === 'ended') return 'none';
  const caller = call.callerId === me;
  const callee = call.calleeId === me;
  if (!caller && !callee) return 'none';
  if (caller) {
    if (call.callerDevice !== device) return 'elsewhere';
    return call.phase === 'ringing' ? 'outgoing' : 'active';
  }
  if (call.phase === 'ringing') return 'incoming';
  return call.calleeDevice === device ? 'active' : 'elsewhere';
}

/** Сервер умеет звонки (`calls1`) — только тогда кнопки «Позвонить». */
export function serverCalls(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_CALLS1);
}

/** «0:07», «12:45», «1:02:03» — счётчик идущего разговора (tdesktop `Ui::FormatDurationText`). */
/**
 * Объяснение запрета звонков (`presence4`, решение владельца 08.10 п.25): собеседник выбрал «Кто может звонить» так, что мне нельзя.
 * Telegram Desktop (`calls_instance.cpp`) на нажатие трубки показывает окно-справку `lng_call_error_not_available` с кнопкой «ОК»,
 * Android — `CallNotAvailable`; у нас то же окно (`alertDialog`). Пол собеседника неизвестен, поэтому «ограничил(а)».
 */
export function callPrivacyNotice(name: string): { title: string; body: string } {
  const who = name.trim() || 'Собеседник';
  return {
    title: 'Позвонить нельзя',
    body: `${who} ограничил(а) звонки в настройках приватности. Можно попросить изменить настройку или позвонить вам самому.`,
  };
}

export function callTimerText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * Подпись под именем на экране звонка (tdesktop `lng_call_status_*`): мне звонят — «звонит вам…», я звоню — «вызов…»,
 * медиа ещё подключается — «соединение…», идёт — счётчик, кончился — «звонок завершён» / «линия занята».
 */
export function callStatusText(view: CallView, opts: { connected: boolean; elapsedMs: number; ended?: DmCall | null }): string {
  if (opts.ended) return opts.ended.reason === 'busy' ? 'звонок отклонён' : 'звонок завершён';
  if (view === 'incoming') return 'звонит вам…';
  if (view === 'outgoing') return 'вызов…';
  if (view === 'active') return opts.connected ? callTimerText(opts.elapsedMs) : 'соединение…';
  return '';
}

/** Сервер умеет видео в звонке (`calls2`) — только тогда кнопки «Камера» и «Экран» (старый сервер не пустит публикацию). */
export function serverCallVideo(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_CALLS2);
}

/** Угол экрана звонка, к которому прилипает своё превью. */
export type PreviewCorner = 'tl' | 'tr' | 'bl' | 'br';

/**
 * Своё превью отпустили центром в точке (`cx`, `cy`) экрана `w`×`h` — к какому углу оно прилипнет: к ближайшему
 * (tdesktop `VideoBubble`, режим `SnapToCorners`; по умолчанию — правый нижний).
 */
export function previewCorner(cx: number, cy: number, w: number, h: number): PreviewCorner {
  return `${cy < h / 2 ? 't' : 'b'}${cx < w / 2 ? 'l' : 'r'}` as PreviewCorner;
}

/** Вторая строка пузыря записи о звонке: «14:05» или «14:05, 3 мин» (tdesktop `HistoryView::Call`: время, длительность). */
export function callRecordStatus(time: string, durationSec: number): string {
  return durationSec > 0 ? `${time}, ${callDurationText(durationSec)}` : time;
}
