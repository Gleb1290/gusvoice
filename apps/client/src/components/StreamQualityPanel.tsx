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
import { Select } from './Select';
import { isDesktop } from '../hotkeys';

/**
 * Screen-share quality controls. Reused both in the in-call quality popover (with a
 * "restart stream" affordance when already sharing) and in the user-settings tab as the
 * default for the next share. Writes straight to the gv_stream localStorage prefs.
 */
export function StreamQualityPanel({ live, onRestart }: { live?: boolean; onRestart?: () => void }) {
  const [s, setS] = useState<StreamSettings>(getStreamSettings());

  // Правка — поверх СВЕЖИХ настроек, а не своей копии: рядом в настройках живёт галочка курсора со
  // своим состоянием, и запись целой старой копии вернула бы ей прежнее значение.
  function update(patch: Partial<StreamSettings>) {
    const next = { ...getStreamSettings(), ...patch };
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
            onClick={() => update({ resolution: r.value })}
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
            onClick={() => update({ fps: f })}
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
          onClick={() => update({ mode: 'detail' })}
        >
          Чёткость
        </button>
        <button
          type="button"
          aria-pressed={s.mode === 'motion'}
          className={s.mode === 'motion' ? 'on' : ''}
          onClick={() => update({ mode: 'motion' })}
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
      <Select
        id="sq-codec"
        value={s.codec}
        onChange={(v) => update({ codec: v as StreamSettings['codec'] })}
        ariaLabel="Кодек"
        title="Кодек"
        options={CODEC_OPTIONS.map((c) => ({ value: c.value, label: c.label }))}
      />

      {/* В браузере показ ЭКРАНА идёт в H.264 (06.10, #207): SDK для VP9 ломает слои и режим экрана. */}
      {!isDesktop() && s.codec === 'vp9' && (
        <div className="muted stream-hint">В браузере показ экрана идёт в H.264: с VP9 у показа пропадают слои качества.</div>
      )}

      <div className="settings-row" style={{ marginTop: 10 }}>
        <span>Звук из вкладки / системы</span>
        <Toggle checked={s.audio} onChange={(v) => update({ audio: v })} label="Транслировать звук" />
      </div>

      {/* «Максимальное качество — не снижать» (06.10, #207) — только десктоп: в браузере нижнюю
          границу оценщика канала не поставить без правки SDP. */}
      {isDesktop() && (
        <>
          <div className="settings-row" style={{ marginTop: 10 }}>
            <span>Максимальное качество — не снижать</span>
            <Toggle
              checked={s.maxQuality === true}
              onChange={(v) => update({ maxQuality: v })}
              label="Максимальное качество — не снижать"
            />
          </div>
          <div className="muted stream-hint">
            Показу всегда отдаётся полный битрейт, одним потоком, без запасных слоёв. Если у зрителя слабый канал — у
            него будут подтормаживания вместо мыла.
          </div>
        </>
      )}

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
