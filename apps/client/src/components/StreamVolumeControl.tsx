import { useEffect, useRef, useState } from 'react';
import { MAX_STREAM_VOLUME } from '../streamAudioRules';
import { Icon } from './Icon';

/**
 * Окно громкости стрима (10.10): ползунок больше не стоит в ряду постоянно, а всплывает по клику на
 * значок звука (как у Discord). Окно рисуется ВНУТРИ вьювера, а не порталом в `body`: при настоящем
 * полноэкранном режиме видно только содержимое вьювера. Закрывается кликом мимо и Esc.
 * Слушаем документ, в котором живёт сама кнопка: в окошке «картинка в картинке» (#222) это другой
 * документ, и клик мимо в нём главная страница не услышала бы.
 */
export function useStreamVolumePop() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const doc = ref.current?.ownerDocument ?? document;
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    doc.addEventListener('pointerdown', down, true);
    doc.addEventListener('keydown', key);
    return () => {
      doc.removeEventListener('pointerdown', down, true);
      doc.removeEventListener('keydown', key);
    };
  }, [open]);
  return { open, setOpen, ref };
}

export type StreamVolumePop = ReturnType<typeof useStreamVolumePop>;

/**
 * Значок звука показа и всплывающее окно громкости — одно и то же на сцене (`ScreenViewer`) и в окошке
 * «картинка в картинке» (`StreamPipView`). Состояние окна (`pop`) держит вызывающий: ряд кнопок не
 * должен гаснуть под открытым окном.
 */
export function StreamVolumeControl({
  pop,
  muted,
  volume,
  onToggleAudio,
  onVolume,
}: {
  pop: StreamVolumePop;
  muted: boolean;
  volume: number;
  onToggleAudio: () => void;
  onVolume: (v: number) => void;
}) {
  const volPct = Math.round((muted ? 0 : volume) * 100);
  // Ползунок в ноль — звука так же нет, как при «заглушить»: значок перечёркнут и тут (12.10, владелец).
  const silent = muted || volPct === 0;
  return (
    <span className="screen-audio" ref={pop.ref}>
      <button
        type="button"
        className={`ctl ${silent ? 'off' : ''}${pop.open ? ' open' : ''}`}
        title={muted ? 'Звук стрима выключен — громкость' : `Громкость стрима: ${volPct}%`}
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        onClick={() => pop.setOpen((v) => !v)}
      >
        <Icon name={muted ? 'headphones-off' : silent ? 'volume-off' : 'volume'} size={18} />
      </button>
      {pop.open && (
        <span className="stream-vol-pop" role="dialog" aria-label="Громкость стрима">
          {/* Шапка — та же, что у громкости человека в его меню (`.ctx-vol2-*`, UserContextMenu). */}
          <span className="ctx-vol2-head">
            <button
              type="button"
              className={`ctx-vol2-spk ${muted ? 'on' : ''}`}
              title={muted ? 'Включить звук стрима' : 'Заглушить звук стрима (только для вас)'}
              onClick={onToggleAudio}
            >
              <Icon name={silent ? 'volume-off' : 'volume'} size={16} />
            </button>
            <span className="ctx-vol2-label">Громкость</span>
            <span className={`ctx-vol2-pct ${muted ? 'muted' : volPct > 100 ? 'boost' : ''}`}>
              {muted ? 'выкл' : `${volPct}%`}
            </span>
          </span>
          {/* Ползунок доходит до 200 % (#130): у показывающего бывает тихий источник, и 100 % —
              это не наш выбор, а потолок громкости элемента воспроизведения. Выше единицы звук
              идёт через узел усиления Web Audio (`webAudioMix` у комнаты). Заливка помечается
              отдельным цветом от 100 % и выше: усиление слышно на плохом источнике, и человек
              должен видеть, что он уже НЕ на обычной громкости. */}
          <input
            type="range"
            className={`stream-vol${!muted && volume > 1 ? ' boost' : ''}`}
            min={0}
            max={MAX_STREAM_VOLUME}
            step={0.02}
            value={muted ? 0 : volume}
            // ⚠️ `--p` — ДОЛЯ хода ползунка, а не громкость: заливка рисуется градиентом по ней.
            // Забыть поделить на потолок значило бы, что заливка убегает вперёд ручки.
            style={{ ['--p']: (muted ? 0 : volume) / MAX_STREAM_VOLUME } as React.CSSProperties}
            title={volume > 1 && !muted ? `Громкость стрима: ${Math.round(volume * 100)}% — усиление` : `Громкость стрима: ${volPct}%`}
            onChange={(e) => {
              // Двинул ползунок у заглушённого — значит, хочет слышать (как у громкости человека).
              if (muted) onToggleAudio();
              onVolume(Number(e.target.value));
            }}
          />
        </span>
      )}
    </span>
  );
}
