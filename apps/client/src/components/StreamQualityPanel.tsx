import { useState } from 'react';
import {
  bitrateLabel,
  CODEC_OPTIONS,
  FPS_OPTIONS,
  getStreamSettings,
  RES_OPTIONS,
  setStreamSettings,
  type StreamSettings,
} from '../streamSettings';
import { Toggle } from './Toggle';

/**
 * Screen-share quality controls. Reused both in the in-call quality popover (with a
 * "restart stream" affordance when already sharing) and in the user-settings tab as the
 * default for the next share. Writes straight to the gv_stream localStorage prefs.
 */
export function StreamQualityPanel({ live, onRestart }: { live?: boolean; onRestart?: () => void }) {
  const [s, setS] = useState<StreamSettings>(getStreamSettings());

  function update(next: StreamSettings) {
    setS(next);
    setStreamSettings(next);
  }

  return (
    <div className="stream-quality">
      <div className="settings-group-label" id="sq-res-label">
        Разрешение
      </div>
      <div className="seg seg-wrap" role="group" aria-labelledby="sq-res-label">
        {RES_OPTIONS.map((r) => (
          <button
            key={r.value}
            type="button"
            aria-pressed={s.resolution === r.value}
            className={s.resolution === r.value ? 'on' : ''}
            onClick={() => update({ ...s, resolution: r.value })}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="settings-group-label" id="sq-fps-label">
        Кадры (FPS)
      </div>
      <div className="seg" role="group" aria-labelledby="sq-fps-label">
        {FPS_OPTIONS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={s.fps === f}
            aria-label={`${f} кадров в секунду`}
            className={s.fps === f ? 'on' : ''}
            onClick={() => update({ ...s, fps: f })}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="settings-group-label" id="sq-mode-label">
        Приоритет
      </div>
      <div className="seg" role="group" aria-labelledby="sq-mode-label" aria-describedby="sq-mode-hint">
        <button
          type="button"
          aria-pressed={s.mode === 'detail'}
          className={s.mode === 'detail' ? 'on' : ''}
          onClick={() => update({ ...s, mode: 'detail' })}
        >
          Чёткость
        </button>
        <button
          type="button"
          aria-pressed={s.mode === 'motion'}
          className={s.mode === 'motion' ? 'on' : ''}
          onClick={() => update({ ...s, mode: 'motion' })}
        >
          Плавность
        </button>
      </div>
      <div className="muted stream-hint" id="sq-mode-hint">
        {s.mode === 'detail'
          ? 'Резкость текста и интерфейса важнее частоты кадров.'
          : 'Плавность движения важнее резкости — игры и видео.'}
      </div>

      <label className="settings-group-label" htmlFor="sq-codec">
        Кодек
      </label>
      <select
        id="sq-codec"
        className="settings-select"
        value={s.codec}
        onChange={(e) => update({ ...s, codec: e.target.value as StreamSettings['codec'] })}
      >
        {CODEC_OPTIONS.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>

      <div className="settings-row" style={{ marginTop: 10 }}>
        <span>Звук из вкладки / системы</span>
        <Toggle checked={s.audio} onChange={(v) => update({ ...s, audio: v })} label="Транслировать звук" />
      </div>

      <div className="stream-estimate">
        Битрейт: <strong>≈ {bitrateLabel(s)}</strong>
      </div>

      {live && onRestart ? (
        <button type="button" className="stream-restart" onClick={onRestart}>
          Перезапустить с новыми настройками
        </button>
      ) : (
        <div className="muted stream-hint">Применяется при следующем запуске показа экрана.</div>
      )}
    </div>
  );
}
