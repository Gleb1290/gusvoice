/**
 * Как отправлять сообщение с клавиатуры (07.10, G36): «Отправка по Enter» (по умолчанию) или «Отправка по Ctrl+Enter» —
 * как в Telegram Desktop («Настройки чатов → Сообщения», `sendSubmitWay`). Настройка этого устройства (localStorage),
 * аккаунт не синкает: у Telegram она тоже локальная. Что делает каждая клавиша в каждом режиме — `enterSends`
 * (`messagePaneRules.ts`); переключатель — «Настройки → Вид → Отправка сообщений» (`UserSettingsModal.tsx`).
 */
export type SendMode = 'enter' | 'ctrl-enter';

const KEY = 'gv_send_mode';

export const SEND_MODE_DEFAULT: SendMode = 'enter';

export function getSendMode(): SendMode {
  try {
    return localStorage.getItem(KEY) === 'ctrl-enter' ? 'ctrl-enter' : SEND_MODE_DEFAULT;
  } catch {
    return SEND_MODE_DEFAULT;
  }
}

export function setSendMode(mode: SendMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* хранилище недоступно — остаётся режим по умолчанию */
  }
}

/**
 * Перенос строки в поле руками (Ctrl+Enter в режиме «Enter», `enterBreaksLine`): через `execCommand`, чтобы остались отмена
 * Ctrl+Z и событие `input` (React-поле обновится); нет `execCommand` — `setRangeText` и то же событие.
 */
export function insertLineBreak(el: HTMLTextAreaElement): void {
  if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, '\n')) return;
  el.setRangeText('\n', el.selectionStart, el.selectionEnd, 'end');
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
