import { useEffect } from 'react';
import { useStore } from '../store';
import { useCall } from '../callStore';
import { isDesktop } from '../hotkeys';
import { quitApp } from '../desktopWindow';
import { CLOSE_REQUEST_EVENT } from './CloseToTrayPrompt';
import { confirmAction } from '../confirm';
import { hasActiveUploads } from '../uploadProgress';
import { quitBlockers, windowKey } from '../desktopKeysRules';

/** Событие «Ctrl+\»: беседа слушает его и раскрывает своё меню «⋯» (`DmChatView`). Остальным окнам оно ни к чему. */
export const CHAT_MENU_EVENT = 'gv-chat-menu';

/**
 * Ctrl+W / Ctrl+F4 — как крестик окна: по настройке закрытия (спросить / в трей / выйти; `CloseToTrayPrompt`), Ctrl+Q — выйти, а если идёт звонок,
 * голос или загрузка — сперва спросить, Ctrl+\ — меню текущей беседы (08.10, G63/G65; Telegram `core/shortcuts.cpp`).
 * Только в десктопе: нужные команды `gv_window_hide` / `gv_app_quit` уже есть в оболочке, новых прав не надо.
 * ⚠️ Ctrl+M (свернуть) не сделан: сворачивание требует права `core:window:allow-minimize` либо новой команды в `lib.rs`.
 */
export function DesktopKeysHost() {
  useEffect(() => {
    if (!isDesktop()) return;
    const onKey = (e: KeyboardEvent) => {
      const key = windowKey(e);
      if (!key || e.repeat) return;
      if (key === 'chatMenu') {
        if (useStore.getState().view !== 'dm' || document.querySelector('[aria-modal="true"]')) return;
        e.preventDefault();
        window.dispatchEvent(new Event(CHAT_MENU_EVENT));
        return;
      }
      e.preventDefault();
      if (key === 'hide') {
        window.dispatchEvent(new Event(CLOSE_REQUEST_EVENT));
        return;
      }
      const s = useStore.getState();
      const why = quitBlockers({
        inCall: !!useCall.getState().call,
        inVoice: s.voiceState !== 'disconnected',
        uploading: hasActiveUploads(),
      });
      if (!why.length) return quitApp();
      void confirmAction({
        title: 'Выйти из GusVoice?',
        body: `Сейчас ${why.join(' и ')}. Если выйти, это прервётся.`,
        tone: 'danger',
        confirmLabel: 'Выйти',
      }).then((ok) => {
        if (ok) quitApp();
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return null;
}
