import type { CSSProperties } from 'react';
import { useState } from 'react';
import {
  getSoundSettings,
  playSound,
  setSoundSettings,
  SOUND_EVENT_LABELS,
  type SoundEvent,
  type SoundSettings,
} from '../sounds';
import { Icon } from './Icon';

const EVENTS = Object.keys(SOUND_EVENT_LABELS) as SoundEvent[];

/** Per-browser sound preferences: master toggle, volume, and per-event toggles with preview. */
export function SoundSettingsPanel() {
  const [s, setS] = useState<SoundSettings>(getSoundSettings());

  function update(next: SoundSettings) {
    setS(next);
    setSoundSettings(next);
  }

  return (
    <div className="sound-settings">
      <div className="sound-head">
        <label className="sound-master">
          <input type="checkbox" checked={s.enabled} onChange={(e) => update({ ...s, enabled: e.target.checked })} />
          Звуки уведомлений
        </label>
        <input
          className="sound-vol"
          aria-label="Громкость звуков"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={s.volume}
          style={{ ['--p']: s.volume } as CSSProperties}
          disabled={!s.enabled}
          title="Громкость"
          onChange={(e) => update({ ...s, volume: parseFloat(e.target.value) })}
        />
      </div>
      <div className={`sound-events ${s.enabled ? '' : 'disabled'}`}>
        {EVENTS.map((ev) => (
          <div className="sound-row" key={ev}>
            <label>
              <input
                type="checkbox"
                checked={s.events[ev]}
                disabled={!s.enabled}
                onChange={(e) => update({ ...s, events: { ...s.events, [ev]: e.target.checked } })}
              />
              {SOUND_EVENT_LABELS[ev]}
            </label>
            <button
              type="button"
              className="sound-play"
              title="Прослушать"
              disabled={!s.enabled || !s.events[ev]}
              onClick={() => playSound(ev)}
            >
              <Icon name="volume" size={15} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
