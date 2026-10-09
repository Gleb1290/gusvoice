import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { usePhoneLayout } from '../phoneLayout';
import {
  getVoiceSpedUp,
  getVoiceSpeed,
  nextVoiceSpeed,
  setVoiceSpeed,
  subscribeVoiceSpeed,
  toggleVoiceSpeed,
  VOICE_SPEED_MAX,
  VOICE_SPEED_MENU,
  VOICE_SPEED_MIN,
  voiceSpeedLabel,
} from '../voicePlayback';

/** Через сколько показать и спрятать меню при наведении: курсор, проходящий мимо, меню не открывает. */
const HOVER_MS = 250;

/**
 * Кнопка скорости голосовых (G82) — у пузыря и у полосы плеера, одна настройка на все плееры.
 *
 * - Телефон — как Telegram Android (`FragmentContextView`): тап идёт по кругу 1× → 1,5× → 2× → 1×.
 * - Компьютер — как Telegram Desktop (`media/player/media_player_dropdown.cpp`, `SpeedController`): щелчок — 1× ↔ последнее
 *   ускорение (сначала 1,7×), наведение — меню с ползунком 0,5–2,5× и пунктами 0,5 · 1 · 1,2 · 1,5 · 1,7 · 2.
 *   Правый щелчок тоже открывает меню — для тех, у кого наведения нет (тачпад без курсора, экранный диктор).
 *
 * Видео в просмотрщике (G33, волна 6) берёт ту же кнопку со СВОЕЙ скоростью: `value` + `onChange` (и `spedUp` — к чему
 * переключает щелчок) — тогда общая скорость голосовых не трогается. Шкала та же, 0,5–2,5× (tdesktop
 * `media_view_playback_controls.cpp`, меню скорости плеера видео).
 */
export function VoiceSpeedButton({
  value,
  onChange,
  spedUp,
}: { value?: number; onChange?: (speed: number) => void; spedUp?: number } = {}) {
  const phone = usePhoneLayout();
  const [voiceRate, setRate] = useState(getVoiceSpeed);
  const own = !!onChange;
  const rate = own && value !== undefined ? value : voiceRate;
  const apply = (s: number) => (onChange ? onChange(s) : setVoiceSpeed(s));
  const [menu, setMenu] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const timer = useRef(0);
  useEffect(() => {
    setRate(getVoiceSpeed());
    return subscribeVoiceSpeed((s) => setRate(s));
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  function openMenu() {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    setMenu({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
  }
  function hoverIn() {
    if (phone) return;
    clearTimeout(timer.current);
    timer.current = window.setTimeout(openMenu, HOVER_MS);
  }
  function hoverOut() {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMenu(null), HOVER_MS);
  }

  const label = voiceSpeedLabel(rate);
  const frac = (rate - VOICE_SPEED_MIN) / (VOICE_SPEED_MAX - VOICE_SPEED_MIN);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="voice-speed"
        title={phone ? 'Скорость воспроизведения' : 'Скорость: щелчок — 1× или ускорение, наведите — выбор'}
        aria-label={`Скорость: ${label}`}
        aria-haspopup={phone ? undefined : 'menu'}
        onClick={(e) => {
          e.stopPropagation();
          apply(phone ? nextVoiceSpeed(rate) : toggleVoiceSpeed(rate, own ? (spedUp ?? 2) : getVoiceSpedUp()));
        }}
        onContextMenu={(e) => {
          if (phone) return;
          e.preventDefault();
          e.stopPropagation();
          openMenu();
        }}
        onMouseEnter={hoverIn}
        onMouseLeave={hoverOut}
      >
        {label}
      </button>
      {menu && !phone && (
        <div
          className="ctx-menu voice-speed-menu"
          role="menu"
          style={{ top: menu.top, right: menu.right }}
          onMouseEnter={() => clearTimeout(timer.current)}
          onMouseLeave={hoverOut}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="ctx-vol2">
            <div className="ctx-vol2-head">
              <span className="ctx-vol2-label">Скорость</span>
              <span className="ctx-vol2-pct">{label}</span>
            </div>
            <div className="ctx-vol2-track">
              <input
                className="ctx-vol-range"
                type="range"
                min={VOICE_SPEED_MIN}
                max={VOICE_SPEED_MAX}
                step={0.1}
                value={rate}
                aria-label="Скорость воспроизведения"
                onChange={(e) => apply(parseFloat(e.target.value))}
                style={{ ['--p']: frac } as CSSProperties}
              />
            </div>
          </div>
          {VOICE_SPEED_MENU.map((o) => (
            <button
              key={o.speed}
              type="button"
              role="menuitemradio"
              aria-checked={Math.abs(rate - o.speed) < 1e-9}
              className={`ctx-item${Math.abs(rate - o.speed) < 1e-9 ? ' active' : ''}`}
              onClick={() => {
                apply(o.speed);
                setMenu(null);
              }}
            >
              <span>{o.label}</span>
              <span className="voice-speed-menu-val">{voiceSpeedLabel(o.speed)}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
