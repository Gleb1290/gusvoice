import { useEffect } from 'react';
import { getAudioSettings } from '../audioSettings';
import { formatCombo, getHotkeys } from '../hotkeys';
import { Icon } from './Icon';

/** Split a normalized combo into display capsules; empty (unbound) → a single dim dash. */
function capsules(combo: string): string[] {
  if (!combo) return ['—'];
  return formatCombo(combo).split(' + ');
}

function Row({ label, combo }: { label: string; combo: string }) {
  return (
    <div className="cheat-row">
      <span className="cheat-label">{label}</span>
      <span className="cheat-keys">
        {capsules(combo).map((k, i) => (
          <kbd key={i} className={`cheat-key ${k === '—' ? 'unset' : ''}`}>
            {k}
          </kbd>
        ))}
      </span>
    </div>
  );
}

/**
 * Keyboard-shortcut cheat sheet (round-7 P8), opened with `?`. Voice bindings come from the
 * user's own hotkey config (so they read "Не задано" until set); navigation shortcuts are the
 * ones MainLayout actually handles. Only truthful, working shortcuts are listed.
 */
export function HotkeyCheatSheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const hk = getHotkeys();
  const audio = getAudioSettings();

  const voice = [
    { label: 'Выключить микрофон', combo: hk.mute },
    { label: 'Заглушить звук (деафен)', combo: hk.deafen },
    { label: 'Демонстрация экрана', combo: hk.screenShare },
    { label: 'Рация (Push-to-Talk)', combo: audio.pushToTalk ? audio.pttKey : '' },
  ];
  const nav = [
    { label: 'Поиск сообщений', combo: 'Ctrl+KeyF' },
    { label: 'Следующий канал', combo: 'Alt+ArrowDown' },
    { label: 'Предыдущий канал', combo: 'Alt+ArrowUp' },
    { label: 'Эта шпаргалка', combo: 'Shift+Slash' },
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal cheatsheet" onClick={(e) => e.stopPropagation()}>
        <div className="cheat-head">
          <Icon name="keyboard" size={20} className="cheat-head-icon" />
          <span className="cheat-title">Горячие клавиши</span>
          <div style={{ flex: 1 }} />
          <span className="cheat-hint">нажмите ? в любой момент</span>
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="cheat-grid">
          <div className="cheat-col">
            <div className="cheat-col-title">Голос</div>
            {voice.map((k) => (
              <Row key={k.label} label={k.label} combo={k.combo} />
            ))}
          </div>
          <div className="cheat-col">
            <div className="cheat-col-title">Навигация</div>
            {nav.map((k) => (
              <Row key={k.label} label={k.label} combo={k.combo} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
