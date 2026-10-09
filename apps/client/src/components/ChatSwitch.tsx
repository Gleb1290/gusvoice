import { useCallback, useEffect, useRef, useState } from 'react';
import { dmPeerLabel, usePeerName } from '../peerName';
import { useStore } from '../store';
import { isDesktop } from '../hotkeys';
import {
  chatSwitchAction,
  chatSwitchLayout,
  chatSwitchList,
  isChatSwitchStart,
  moveSelection,
  pushRecent,
  removeTile,
  stepNext,
  stepPrev,
} from '../chatSwitchRules';
import { Avatar } from './Avatar';
import { SavedAvatar } from './SavedAvatar';

/**
 * Окно недавних бесед по Ctrl+Tab (08.10, #211, G65; Telegram Desktop `window_chat_switch_process.cpp`). Только в десктопе
 * (`isDesktop()`): в браузере Ctrl+Tab принадлежит вкладкам. Правила — `chatSwitchRules.ts`. Хост висит в `MainLayout`.
 *
 * Пока Ctrl зажат, окно живёт; отпустили — открывается выбранная беседа (как Enter). Потеря фокуса окном закрывает его
 * без перехода: Ctrl, отпущенный вне окна, мы не увидим.
 */

/** Недавно открытые беседы, свежая первой. В памяти, как у Telegram (`RecentPeers::_opens`). */
let recent: string[] = [];

export function ChatSwitchHost() {
  const [tiles, setTiles] = useState<string[] | null>(null);
  const [selected, setSelected] = useState(-1);
  // Живые копии для слушателей клавиш: они ставятся один раз и не должны отставать от состояния.
  const live = useRef({ tiles: null as string[] | null, selected: -1 });
  live.current = { tiles, selected };

  const apply = useCallback((ids: string[] | null, sel: number) => {
    live.current = { tiles: ids, selected: sel };
    setTiles(ids);
    setSelected(sel);
  }, []);

  // Что открывали: любая смена текущей беседы ЛС ложится наверх списка недавних.
  useEffect(() => {
    if (!isDesktop()) return;
    const note = (id: string | null) => {
      if (id) recent = pushRecent(recent, id);
    };
    note(useStore.getState().currentDmId);
    return useStore.subscribe((s, prev) => {
      if (s.currentDmId !== prev.currentDmId) note(s.currentDmId);
    });
  }, []);

  const choose = useCallback(
    (index: number) => {
      const id = live.current.tiles?.[index];
      apply(null, -1);
      if (id && id !== useStore.getState().currentDmId) void useStore.getState().selectDm(id);
    },
    [apply],
  );

  // Начало: Ctrl+Tab / Ctrl+Shift+Tab в ЛС. Окно поверх (настройки, подтверждение, лист) — не наше.
  useEffect(() => {
    if (!isDesktop()) return;
    const onKey = (e: KeyboardEvent) => {
      if (live.current.tiles || !isChatSwitchStart(e)) return;
      const s = useStore.getState();
      if (s.view !== 'dm' || document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      e.stopPropagation();
      const ids = chatSwitchList(recent, s.dms.map((d) => d.id), s.currentDmId);
      if (ids.length < 2) return;
      // Текущая беседа — плитка 0, первое Tab уходит на 1 (Shift+Tab — на последнюю), как у Telegram.
      apply(ids, e.shiftKey ? stepPrev(0, ids.length) : stepNext(0, ids.length));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [apply]);

  // Пока открыто: клавиши окна, отпускание Ctrl, уход фокуса.
  const open = tiles !== null;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const { tiles: ids, selected: sel } = live.current;
      if (!ids) return;
      if (e.code === 'ControlLeft' || e.code === 'ControlRight') return;
      e.preventDefault();
      e.stopPropagation();
      const action = chatSwitchAction(e);
      if (!action) return;
      if (action === 'close') return apply(null, -1);
      if (action === 'choose') return choose(sel);
      if (action === 'remove') {
        if (sel < 0) return;
        recent = recent.filter((x) => x !== ids[sel]);
        const r = removeTile(ids, sel);
        return r.ids.length < 2 ? apply(null, -1) : apply(r.ids, r.selected);
      }
      const to = moveSelection(action, sel, ids.length);
      if (to !== null) apply(ids, to);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === 'ControlLeft' || e.code === 'ControlRight') {
        const { selected: sel } = live.current;
        if (sel >= 0) choose(sel);
        else apply(null, -1);
      }
    };
    const onBlur = () => apply(null, -1);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [open, apply, choose]);

  const dms = useStore((s) => s.dms);
  const nameOf = usePeerName(); // подпись контакта вместо имени (`peerName.ts`)
  if (!tiles) return null;
  const { perRow } = chatSwitchLayout(tiles.length);
  return (
    <div className="modal-overlay chatswitch-overlay" onMouseDown={() => apply(null, -1)}>
      <div
        className="chatswitch"
        role="dialog"
        aria-modal="true"
        aria-label="Недавние беседы"
        style={{ gridTemplateColumns: `repeat(${perRow}, var(--chatswitch-w))` }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {tiles.map((id, i) => {
          const dm = dms.find((d) => d.id === id);
          if (!dm) return null;
          return (
            <button
              key={id}
              type="button"
              className={`chatswitch-tile ${i === selected ? 'selected' : ''}`}
              onMouseEnter={() => apply(tiles, i)}
              onClick={() => choose(i)}
            >
              {dm.saved ? <SavedAvatar size={56} /> : <Avatar name={dmPeerLabel(dm, nameOf)} url={dm.otherUser.avatarUrl} size={56} />}
              <span className="chatswitch-name">{dm.saved ? 'Избранное' : dmPeerLabel(dm, nameOf)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
