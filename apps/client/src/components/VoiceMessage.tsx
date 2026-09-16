import { type Attachment, formatDuration } from '@gusvoice/shared';
import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

/**
 * Плеер голосового сообщения (#20).
 *
 * Огибающая приходит с вложением — считать её здесь значило бы качать и декодировать каждую
 * запись в истории только ради полосок (см. `shared/voiceMessage.ts`).
 */

/** Играющее сейчас. Второе голосовое глушит первое — иначе получается каша из двух голосов. */
let playing: HTMLAudioElement | null = null;

export function VoiceMessage({ a }: { a: Attachment }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setPlaying] = useState(false);
  const [at, setAt] = useState(0);

  const bars = a.waveform ?? [];
  // Длительность из вложения — надёжнее, чем `audio.duration`: у WebM из MediaRecorder её в
  // заголовке нет, и браузер до конца воспроизведения честно отдаёт Infinity.
  const total = a.durationMs ?? 0;
  const progress = total > 0 ? Math.min(1, at / total) : 0;

  useEffect(() => {
    const el = audioRef.current;
    return () => {
      if (playing === el) playing = null;
    };
  }, []);

  function toggle() {
    const el = audioRef.current;
    if (!el) return;
    if (isPlaying) {
      el.pause();
      return;
    }
    if (playing && playing !== el) playing.pause();
    playing = el;
    void el.play().catch(() => setPlaying(false));
  }

  /** Перемотка кликом по полоске: доля от ширины — это доля записи. */
  function seek(e: React.MouseEvent<HTMLDivElement>) {
    const el = audioRef.current;
    if (!el || total <= 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const target = (total / 1000) * ratio;
    // Проверяем на конечность: до загрузки метаданных `duration` бывает Infinity, и запись
    // такого значения в currentTime — исключение.
    if (Number.isFinite(target)) {
      el.currentTime = target;
      setAt(target * 1000);
    }
  }

  return (
    <div className="voice-msg">
      <button type="button" className="voice-play" title={isPlaying ? 'Пауза' : 'Слушать'} onClick={toggle}>
        <Icon name={isPlaying ? 'pause' : 'play'} size={16} />
      </button>

      <div className="voice-wave" onClick={seek} role="presentation">
        {bars.map((v, i) => (
          <span
            key={i}
            className={`voice-bar${i / bars.length < progress ? ' on' : ''}`}
            // Минимум 8% — иначе на паузах в речи полоска рвётся на пустые места.
            style={{ height: `${Math.max(8, v)}%` }}
          />
        ))}
      </div>

      <span className="voice-time">{formatDuration(isPlaying || at > 0 ? at : total)}</span>

      <audio
        ref={audioRef}
        src={a.url}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime * 1000)}
        onEnded={() => {
          setPlaying(false);
          setAt(0);
        }}
      />
    </div>
  );
}
