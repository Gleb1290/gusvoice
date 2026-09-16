import { useEffect, useRef, useState } from 'react';
import {
  activeInstanceId,
  type Instance,
  instances as readInstances,
  removeInstance,
  renameInstance,
  restartApp,
  serverHost,
  setActiveInstance,
} from '../config';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { AddInstanceModal } from './AddInstanceModal';

/**
 * Multi-instance switcher (#7), pinned to the bottom of the server rail (desktop only — gated by the
 * caller). Shows the active instance; the popover lists saved instances (click = switch → the app
 * restarts into that instance), plus "add instance" and a manage mode (rename / remove). Token-only:
 * switching never asks for a password unless the instance's 7-day token has expired.
 */
export function InstanceSwitcher() {
  const [list, setList] = useState<Instance[]>(() => readInstances());
  const [activeId, setActiveId] = useState<string | null>(() => activeInstanceId());
  const [open, setOpen] = useState(false);
  const [manage, setManage] = useState(false);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  function refresh() {
    setList(readInstances());
    setActiveId(activeInstanceId());
  }

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setManage(false);
        setRenaming(null);
      }
    }
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);

  const active = list.find((i) => i.id === activeId) || list[0] || null;

  async function switchTo(id: string) {
    if (id === activeId) {
      setOpen(false);
      return;
    }
    setActiveInstance(id);
    await restartApp();
  }

  function startRename(inst: Instance) {
    setRenaming(inst.id);
    setRenameVal(inst.name);
  }
  function commitRename(id: string) {
    renameInstance(id, renameVal);
    setRenaming(null);
    refresh();
  }
  function remove(id: string) {
    removeInstance(id);
    refresh();
  }

  return (
    <div className="inst-switch" ref={wrapRef}>
      <button
        className={`rail-icon inst-trigger ${open ? 'active' : ''}`}
        title={active ? `Инстанс: ${active.name}` : 'Инстансы'}
        onClick={() => setOpen((v) => !v)}
      >
        {active?.avatarUrl ? (
          <Avatar url={active.avatarUrl} name={active.name} size={32} />
        ) : (
          <span className="inst-initial">{(active?.name || '?')[0]?.toUpperCase()}</span>
        )}
      </button>

      {open && (
        <div className="inst-pop" onClick={(e) => e.stopPropagation()}>
          <div className="inst-pop-head">
            <span>Инстансы</span>
            <button
              type="button"
              className="inst-manage-btn"
              onClick={() => {
                setManage((v) => !v);
                setRenaming(null);
              }}
            >
              {manage ? 'Готово' : 'Управление'}
            </button>
          </div>

          <ul className="inst-list">
            {list.map((inst) => (
              <li key={inst.id} className={`inst-row ${inst.id === activeId ? 'active' : ''}`}>
                {renaming === inst.id ? (
                  <input
                    className="inst-rename"
                    value={renameVal}
                    autoFocus
                    onChange={(e) => setRenameVal(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(inst.id);
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                    onBlur={() => commitRename(inst.id)}
                  />
                ) : (
                  <button type="button" className="inst-row-main" onClick={() => void switchTo(inst.id)}>
                    <span className="inst-row-icon">
                      {inst.avatarUrl ? (
                        <Avatar url={inst.avatarUrl} name={inst.name} size={28} />
                      ) : (
                        <span className="inst-initial sm">{(inst.name || '?')[0]?.toUpperCase()}</span>
                      )}
                    </span>
                    <span className="inst-row-meta">
                      <span className="inst-row-name">{inst.name}</span>
                      {serverHost(inst.apiUrl) !== inst.name && (
                        <span className="inst-row-host">{serverHost(inst.apiUrl)}</span>
                      )}
                    </span>
                    {inst.id === activeId && (
                      <span className="inst-row-check">
                        <Icon name="check" size={16} />
                      </span>
                    )}
                  </button>
                )}

                {manage && renaming !== inst.id && (
                  <span className="inst-row-actions">
                    <button type="button" title="Переименовать" onClick={() => startRename(inst)}>
                      <Icon name="edit" size={15} />
                    </button>
                    <button
                      type="button"
                      title={inst.id === activeId ? 'Нельзя удалить активный инстанс' : 'Удалить'}
                      disabled={inst.id === activeId}
                      onClick={() => remove(inst.id)}
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>

          <button type="button" className="inst-add" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} />
            Добавить инстанс
          </button>
        </div>
      )}

      {adding && <AddInstanceModal onClose={() => setAdding(false)} />}
    </div>
  );
}
