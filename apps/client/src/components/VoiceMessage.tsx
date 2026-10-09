import { type Attachment, formatDuration } from '@gusvoice/shared';
import { useEffect, useRef } from 'react';
import { attachmentKey } from '../fileActions';
import { useStore } from '../store';
import { voiceHeardKey, voiceTrackKey, voiceUnheard, voiceWaveWidth } from '../voicePlayback';
import { VoiceSpeedButton } from './VoiceSpeedButton';
import { releaseLocalVoice, rememberVoice, seekVoice, toggleVoice, useVoiceBubble, type VoiceSource, type VoiceTrack } from '../voicePlayer';
import { Icon } from './Icon';
import { VOICE_TRIM_MIN_MS } from '../voiceTrim';

/**
 * Пузырь голосового сообщения (#20).
 *
 * Огибающая приходит с вложением — считать её здесь значило бы качать и декодировать каждую
 * запись в истории только ради полосок (см. `shared/voiceMessage.ts`).
 *
 * Звук играет НЕ здесь (07.10): один общий плеер `voicePlayer.ts` — он переживает уход пузыря из ленты и переход в
 * другую беседу (полоса `VoiceTopBar` под шапкой). Пузырь только показывает его состояние и управляет им.
 */

/** Из какого сообщения голосовое (07.10, G12): по нему плеер сообщает «прослушал», рисует точку и подписывает полосу. */
export type VoiceMeta = VoiceSource;

export function VoiceMessage({ a, meta }: { a: Attachment; meta?: VoiceMeta }) {
  return (
    <VoicePlayer url={a.url} waveform={a.waveform ?? []} durationMs={a.durationMs ?? 0} att={attachmentKey(a)} meta={meta} />
  );
}

/**
 * Сам плеер — без вложения: им же слушают только что записанное перед отправкой (#159), когда
 * вложения ещё нет, а есть файл в памяти и уже посчитанная огибающая.
 */
export function VoicePlayer({
  url,
  waveform,
  durationMs,
  att,
  meta,
  trim,
}: {
  url: string;
  waveform: number[];
  durationMs: number;
  /** Ключ вложения (`attachmentKey`) — по нему меню сообщения узнаёт, по какому голосовому щёлкнули (07.10). У записи перед отправкой нет. */
  att?: string;
  /** Сообщение-источник (07.10): нет — запись перед отправкой, ни точки, ни автоперехода. */
  meta?: VoiceMeta;
  /**
   * Обрезка записи перед отправкой (08.10, G13; tdesktop `ListenWrap` — две ручки по огибающей): доли 0..1 и смена.
   * Нет — плеер без ручек (лента, запись короче двух секунд или файл, который не режется).
   */
  trim?: { from: number; to: number; onChange: (from: number, to: number) => void };
}) {
  const dragRef = useRef(false);

  const key = voiceTrackKey(meta?.messageId, att, url);
  const track: VoiceTrack = { key, url, durationMs, source: meta && att ? meta : undefined };
  const view = useVoiceBubble(key, meta ? voiceHeardKey(meta.conversationId, meta.messageId) : null);
  const isPlaying = view.playing;
  const at = view.at;
  const heard = view.heard;

  const bars = waveform;
  // Длительность из вложения — надёжнее, чем `audio.duration`: у WebM из MediaRecorder её в
  // заголовке нет, и браузер до конца воспроизведения честно отдаёт Infinity.
  const total = durationMs;
  const progress = total > 0 ? Math.min(1, at / total) : 0;

  // Пузырь ленты запоминается для автоперехода; запись перед отправкой, ушедшая с экрана, замолкает, как раньше.
  useEffect(() => {
    if (track.source) rememberVoice(track);
  }, [key]);
  useEffect(() => () => releaseLocalVoice(key), [key]);


  function toggle() {
    // Обрезка: играем только выбранное — с левой ручки, если стоим вне отрезка (tdesktop `playbackTrimmed`).
    if (trim && !isPlaying && total > 0 && (at < trim.from * total - 50 || at >= trim.to * total - 50)) {
      seekVoice(key, (trim.from * total) / 1000);
    }
    const s = useStore.getState();
    toggleVoice({ ...track, place: { view: s.view === 'dm' ? 'dm' : 'server', serverId: s.currentServerId } });
  }

  /** Перемотка по полоске (клик и протяжка): доля от ширины — это доля записи. */
  function seek(e: React.PointerEvent<HTMLDivElement>) {
    if (total <= 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const target = (total / 1000) * ratio;
    // Конечность проверяет плеер: до загрузки метаданных запись Infinity в currentTime — исключение.
    seekVoice(key, target);
  }

  const unheard = meta ? voiceUnheard(meta.listened, heard) : false;

  // Дошли до правой ручки — стоп и назад к левой (выбранное слушается целиком, хвост — нет).
  useEffect(() => {
    if (!trim || !isPlaying || total <= 0 || trim.to >= 0.999) return;
    if (at >= trim.to * total) {
      toggleVoice(track);
      seekVoice(key, (trim.from * total) / 1000);
    }
  }, [at, isPlaying, trim?.from, trim?.to]);

  /**
   * Ручка обрезки: доля по указателю, не ближе минимума к другой (`VOICE_TRIM_MIN_MS`). Жест слушается на окне, а не
   * захватом указателя: захват у ручки терялся на первом нажатии после записи (стенд 08.10), и левая ручка не ехала.
   */
  const trimRef = useRef(trim);
  trimRef.current = trim;
  function startTrimDrag(e: React.PointerEvent<HTMLElement>, which: 'from' | 'to') {
    const wave = e.currentTarget.closest('.voice-wave');
    if (!wave || !trimRef.current || total <= 0) return;
    e.stopPropagation();
    e.preventDefault();
    const apply = (clientX: number) => {
      const t = trimRef.current;
      if (!t) return;
      const r = wave.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      const gap = Math.min(1, VOICE_TRIM_MIN_MS / total);
      if (which === 'from') t.onChange(Math.max(0, Math.min(ratio, t.to - gap)), t.to);
      else t.onChange(t.from, Math.min(1, Math.max(ratio, t.from + gap)));
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId === e.pointerId) apply(ev.clientX);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }
  const trimHandle = (which: 'from' | 'to') => (
    <span
      className={`voice-trim-h ${which}`}
      role="slider"
      aria-label={which === 'from' ? 'Начало записи' : 'Конец записи'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round((trim ? trim[which] : 0) * 100)}
      onPointerDown={(e) => startTrimDrag(e, which)}
    />
  );
  const cut = trim && (trim.from > 0.001 || trim.to < 0.999);

  return (
    <div
      className="voice-msg"
      // Одноразовое (`voice3`, G54): без ключа вложения — меню файла («Сохранить как…») к нему не цепляется.
      data-att={meta?.once ? undefined : att}
      data-voice={track.source ? key : undefined}
      // Ширина огибающей от длительности (`voiceWaveWidth`): читают только стили пузыря ЛС, каналы и запись — как были.
      style={{ '--voice-w': `${voiceWaveWidth(total, false)}px`, '--voice-w-m': `${voiceWaveWidth(total, true)}px` } as React.CSSProperties}
    >
      <button type="button" className="voice-play" title={isPlaying ? 'Пауза' : 'Слушать'} onClick={toggle}>
        <Icon name={isPlaying ? 'pause' : 'play'} size={16} />
        {/* «Один раз» (Telegram: «1» на кнопке, `lng_ttl_voice_tooltip_in` / `VoiceOnceOutHint`). */}
        {meta?.once ? (
          <span
            className="voice-once-badge"
            title={meta.mine ? 'Сообщение исчезнет после того, как собеседник его прослушает' : 'Это голосовое сообщение можно прослушать только один раз'}
          >
            1
          </span>
        ) : null}
      </button>

      <div
        className="voice-wave"
        role="presentation"
        // Перемотка и протяжкой (AD-02): палец/мышь захвачены полоской, пока зажаты.
        onPointerDown={(e) => {
          /* D21 (приёмка S20+, 09.10): в режиме выбора тап по сообщению — только выбор (Telegram: `isInSelectMode` гасит действия
             элемента); перемотка по волне не начинается, нажатие уходит строке (`MessagePane` `onClickCapture` → `onPick`). */
          if (e.currentTarget.closest('.messages.sel-mode')) return;
          dragRef.current = true;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          seek(e);
        }}
        onPointerMove={(e) => {
          if (dragRef.current) seek(e);
        }}
        onPointerUp={() => {
          dragRef.current = false;
        }}
        onPointerCancel={() => {
          dragRef.current = false;
        }}
      >
        {bars.map((v, i) => (
          <span
            key={i}
            className={`voice-bar${i / bars.length < progress ? ' on' : ''}${
              trim && ((i + 1) / bars.length <= trim.from || i / bars.length >= trim.to) ? ' cut' : ''
            }`}
            // Минимум 8% — иначе на паузах в речи полоска рвётся на пустые места.
            style={{ height: `${Math.max(8, v)}%` }}
          />
        ))}
        {trim ? (
          <span className="voice-trim" style={{ left: `${trim.from * 100}%`, right: `${(1 - trim.to) * 100}%` }}>
            {trimHandle('from')}
            {trimHandle('to')}
          </span>
        ) : null}
      </div>

      <span className="voice-time">
        {formatDuration(isPlaying || at > 0 ? at : cut && trim ? (trim.to - trim.from) * total : total)}
      </span>

      {/* Скорость (G82): телефон — по кругу 1× → 1,5× → 2× (Telegram AA-03), компьютер — 1× ↔ ускорение и меню
          (`VoiceSpeedButton`). Появляется, когда запись пошла, — как у него. */}
      {meta && (isPlaying || at > 0) ? <VoiceSpeedButton /> : null}
      {unheard ? <span className="voice-dot" title={meta?.mine ? 'Собеседник ещё не прослушал' : 'Не прослушано'} /> : null}

    </div>
  );
}
