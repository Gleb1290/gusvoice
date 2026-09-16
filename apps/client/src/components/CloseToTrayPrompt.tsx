import { useEffect, useState } from 'react';
import { getCloseBehavior, hideToTray, onCloseRequested, quitApp, setCloseBehavior } from '../desktopWindow';
import { Icon } from './Icon';

/**
 * Desktop-only: handles the window's X. The Tauri shell prevents the default close and emits
 * `gv-close-requested`; here we act on the saved preference (свернуть в трей / выйти) or, when it's
 * unset ('ask'), show a one-time choice with «Запомнить выбор». Renders nothing on web.
 */
export function CloseToTrayPrompt() {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<'tray' | 'quit'>('tray');
  const [remember, setRemember] = useState(true);

  useEffect(() => {
    return onCloseRequested(() => {
      const b = getCloseBehavior();
      if (b === 'tray') hideToTray();
      else if (b === 'quit') quitApp();
      else {
        setChoice('tray');
        setRemember(true);
        setOpen(true);
      }
    });
  }, []);

  function confirm() {
    if (remember) setCloseBehavior(choice);
    setOpen(false);
    if (choice === 'tray') hideToTray();
    else quitApp();
  }

  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="modal close-choice" onClick={(e) => e.stopPropagation()}>
        <div className="admin-head">
          <h2>Закрыть GusVoice?</h2>
          <button type="button" className="icon-close" title="Отмена" onClick={() => setOpen(false)}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="close-cards">
          <button type="button" className={`close-card ${choice === 'tray' ? 'on' : ''}`} onClick={() => setChoice('tray')}>
            <Icon name="chevron-down" size={22} />
            <span className="close-card-title">Свернуть в трей</span>
            <span className="close-card-sub">Останется в трее — голос не прервётся</span>
          </button>
          <button type="button" className={`close-card ${choice === 'quit' ? 'on' : ''}`} onClick={() => setChoice('quit')}>
            <Icon name="leave" size={22} />
            <span className="close-card-title">Выйти полностью</span>
            <span className="close-card-sub">Закрыть приложение</span>
          </button>
        </div>
        <label className="close-remember">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Запомнить выбор
        </label>
        <div className="modal-actions">
          <button type="button" className="link" onClick={() => setOpen(false)}>
            Отмена
          </button>
          <button type="button" onClick={confirm}>{choice === 'tray' ? 'Свернуть' : 'Выйти'}</button>
        </div>
      </div>
    </div>
  );
}
