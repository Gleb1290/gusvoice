/**
 * «Скрыть закреплённые» (G28; Telegram Desktop `HidePinnedBar` → `settings().setHiddenPinnedMessageId`): полоса закрепа
 * скрывается только у меня, на этом устройстве, и до нового закреплённого. Запоминается набор id закреплённых на момент
 * скрытия (`pinBarRules.pinBarHidden`); хранилище — `localStorage`, ключ на беседу, значение — JSON-список id.
 */
const KEY = 'gv.pinsHidden.';

export function readPinHidden(convId: string): string[] | null {
  try {
    const raw = localStorage.getItem(KEY + convId);
    const list: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(list) && list.every((x) => typeof x === 'string') ? (list as string[]) : null;
  } catch {
    return null;
  }
}

export function writePinHidden(convId: string, ids: readonly string[] | null): void {
  try {
    if (ids && ids.length > 0) localStorage.setItem(KEY + convId, JSON.stringify(ids));
    else localStorage.removeItem(KEY + convId);
  } catch {
    /* хранилище недоступно — полоса просто не скроется */
  }
}
