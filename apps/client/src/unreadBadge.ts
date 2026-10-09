/**
 * Десктоп: число непрочитанных ЛС на значке панели задач и в трее (07.10, #211, Р1, G39) + снятие тостов прочитанной
 * беседы (G17). Считает `unreadBadgeRules`, рисует Rust (`unread_badge.rs` `gv_set_unread_badge`, `notify_conv.rs`
 * `gv_notify_remove`). Чтение в этом окне, на другом устройстве и «Прочитать все» — один путь: счётчик беседы в сторе
 * упал до нуля. Всплески изменений стора схлопываются (150 мс). Веб и Android — ничего.
 */
import { newClientId } from './clientId';
import { isDesktop } from './hotkeys';
import { setConvNotifyActions } from './notifications';
import { useStore } from './store';
import { convsJustRead, unreadBadgeCount, unreadByConv } from './unreadBadgeRules';

type TauriCore = { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
function tauriCore(): TauriCore | null {
  return (window as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__?.core ?? null;
}

let started = false;

export function initUnreadBadge(): void {
  if (started) return;
  const core = tauriCore();
  if (!core || !isDesktop()) return;
  started = true;

  // Ответ из тоста беседы (Р1, G17, `notify_conv.rs`): та же очередь отправки, что у поля ввода (строка «в пути»,
  // автоповтор), затем беседа прочитана — как у Telegram после ответа из уведомления. Окно не поднимается.
  setConvNotifyActions({
    reply(convId, text) {
      const s = useStore.getState();
      s.outboxEnqueue(convId, { key: newClientId(), content: text, files: [], replyToId: null });
      void s.markConvRead(convId).catch(() => {});
    },
    read(convId) {
      void useStore.getState().markConvRead(convId).catch(() => {});
    },
  });

  let lastCount = -1;
  let lastDms: unknown = null;
  let prev: Record<string, number> = {};
  let timer: ReturnType<typeof setTimeout> | null = null;

  const run = () => {
    timer = null;
    const s = useStore.getState();
    if (s.dms === lastDms) return;
    lastDms = s.dms;
    const count = unreadBadgeCount(s.dms, Date.now());
    if (count !== lastCount) {
      lastCount = count;
      // Старая сборка без команды — молча.
      core.invoke('gv_set_unread_badge', { count }).catch(() => {});
    }
    const cur = unreadByConv(s.dms);
    for (const id of convsJustRead(prev, cur)) core.invoke('gv_notify_remove', { group: id }).catch(() => {});
    prev = cur;
  };

  useStore.subscribe(() => {
    if (timer === null) timer = setTimeout(run, 150);
  });
  run();
}
