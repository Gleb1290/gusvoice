/**
 * Overlay "выбранные приложения" picker: lists the user's currently-open apps (from the native
 * gv_list_apps enumeration — icon + name + exe) and lets them multi-select which apps the overlay
 * shows over. Selection is a set of lowercased exe basenames saved into overlaySettings.apps.
 */
import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { listOverlayApps, type AppInfo } from '../overlay';

export function AppPickerModal({
  selected,
  onClose,
  onSave,
}: {
  selected: string[];
  onClose: () => void;
  onSave: (exes: string[]) => void;
}) {
  const [apps, setApps] = useState<AppInfo[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set(selected.map((s) => s.toLowerCase())));

  const load = useCallback(() => {
    setApps(null);
    let alive = true;
    void listOverlayApps().then((a) => {
      if (alive) setApps(a);
    });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => load(), [load]);

  const toggle = (exe: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(exe)) next.delete(exe);
      else next.add(exe);
      return next;
    });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal create-channel" onClick={(e) => e.stopPropagation()}>
        <div className="admin-head">
          <h2>Выбрать приложения</h2>
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
          Оверлей будет показываться, когда в фокусе одно из выбранных приложений. Ниже — сейчас
          открытые окна; если игры нет в списке, открой её и нажми «Обновить».
        </div>
        <div className="app-picker-list">
          {apps === null ? (
            <div className="muted" style={{ padding: '12px 4px' }}>
              Ищу запущенные приложения…
            </div>
          ) : apps.length === 0 ? (
            <div className="muted" style={{ padding: '12px 4px' }}>
              Не нашёл открытых окон.
            </div>
          ) : (
            apps.map((a) => (
              <button
                key={a.exe}
                type="button"
                className={`app-row ${picked.has(a.exe) ? 'on' : ''}`}
                onClick={() => toggle(a.exe)}
              >
                {a.icon ? (
                  <img className="app-ico" src={a.icon} alt="" />
                ) : (
                  <span className="app-ico app-ico-fallback">{a.name[0]?.toUpperCase() ?? '?'}</span>
                )}
                <span className="app-name">
                  {a.name}
                  <span className="app-exe">{a.exe}</span>
                </span>
                {picked.has(a.exe) && <Icon name="check" size={16} />}
              </button>
            ))
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="link" onClick={load}>
            Обновить
          </button>
          <button
            type="button"
            onClick={() => {
              onSave([...picked]);
              onClose();
            }}
          >
            Сохранить ({picked.size})
          </button>
        </div>
      </div>
    </div>
  );
}
