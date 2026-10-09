/**
 * Клавиши окна десктопа как в Telegram Desktop (08.10, #211, G63; `core/shortcuts.cpp`: `close_telegram` Ctrl+W / Ctrl+F4,
 * `quit_telegram` Ctrl+Q, `minimize_telegram` Ctrl+M, `show_chat_menu` Ctrl+\). Только в десктопе (`isDesktop()`): в браузере
 * Ctrl+W / Ctrl+Q принадлежат вкладке. Чистые правила; сами вызовы — `components/DesktopKeys.tsx`.
 */

type KeyEv = { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean };

export type WindowKey = 'hide' | 'quit' | 'chatMenu';

/** Ctrl+W / Ctrl+F4 (`hide`) — закрыть окно как крестиком (по настройке: спросить / в трей / выйти), Ctrl+Q — выйти, Ctrl+\ — меню беседы. Shift/Alt/⌘ — не наши. */
export function windowKey(e: KeyEv): WindowKey | null {
  if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return null;
  if (e.code === 'KeyW' || e.code === 'F4') return 'hide';
  if (e.code === 'KeyQ') return 'quit';
  if (e.code === 'Backslash') return 'chatMenu';
  return null;
}

/** Что прервёт выход: пусто — выходим без вопроса. */
export function quitBlockers(s: { inCall: boolean; inVoice: boolean; uploading: boolean }): string[] {
  const out: string[] = [];
  if (s.inCall) out.push('идёт звонок');
  if (s.inVoice) out.push('вы в голосовом канале');
  if (s.uploading) out.push('идёт загрузка файла');
  return out;
}
